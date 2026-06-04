/**
 * Method-registry schema used to type and validate the JSON-RPC traffic
 * carried by a `Wata`.
 *
 * A schema is a map from method name → `{ params, result }` Zod schemas.
 * `Wata.create({ schema })` flows these schemas through generics so
 * `send`, `notify`, `onRequest`, etc. all infer the right `params` and
 * `result` shape from a literal method name.
 *
 * The runtime path goes through {@link validate} so a future Standard Schema
 * swap is one mechanical change. The type-inference path goes through
 * {@link Inferred} so `z.input` / `z.output` choices stay in one place.
 *
 * v1 is Zod-only on purpose (see the plan's "Why Zod-only" rationale); the
 * indirection exists so we can swap the dialect without touching every
 * `Wata` callsite.
 */

import { z } from 'zod/mini'

import * as Errors from './Errors.js'
import * as Rpc from './Rpc.js'

/**
 * Definition of a single method. `params` validates the request `params`
 * payload, `result` validates the response `result` payload.
 *
 * Construct with {@link method} so the generics are pinned correctly.
 */
export type Method<
  params extends z.ZodMiniType = z.ZodMiniType,
  result extends z.ZodMiniType = z.ZodMiniType,
> = {
  params: params
  result: result
}

type FallbackOf<schema extends Schema> = schema extends { fallback: infer fallback extends Method }
  ? fallback
  : never

type Merge<base extends Record<string, Method>, extension extends Record<string, Method>> = Omit<
  base,
  keyof extension
> &
  extension

/**
 * Method definition a schema uses for `name`, including fallback resolution
 * for open schemas.
 */
export type DefinitionOf<schema extends Schema, name extends MethodName<schema>> =
  name extends keyof schema['methods'] ? schema['methods'][name] : FallbackOf<schema>

/** Zod schema accepted for a Wata-wide request context metadata bag. */
export type Context = z.ZodMiniType<Rpc.RequestContext>

/**
 * Inferred request context type for a Wata-wide context schema. Falls back
 * to the default account/chain metadata shape when no context schema is
 * configured.
 */
export type ContextOf<context extends Context | undefined> = context extends Context
  ? Inferred<context>
  : Rpc.RequestContext

/**
 * Define a single method's `params` / `result` schema pair.
 *
 * @example
 * ```ts
 * import { Schema } from 'wata'
 * import { z } from 'zod/mini'
 *
 * const ping = Schema.method({
 *   params: z.tuple([]),
 *   result: z.object({ ok: z.literal(true) }),
 * })
 * ```
 */
export function method<const params extends z.ZodMiniType, const result extends z.ZodMiniType>(
  options: Method<params, result>,
): Method<params, result> {
  return options
}

/**
 * A method-registry schema. Keys are method names; values are {@link Method}
 * definitions. Schemas with `fallback` accept arbitrary JSON-RPC method
 * names, using the fallback definition when a method has no precise entry.
 */
export type Schema<
  methods extends Record<string, Method> = Record<string, Method>,
  fallback extends Method | undefined = Method | undefined,
> = {
  methods: methods
} & ([fallback] extends [undefined]
  ? { fallback?: undefined }
  : [fallback] extends [Method]
    ? { fallback: fallback }
    : { fallback?: fallback | undefined })

/**
 * Create a method-registry schema. The `const` generic on `methods`
 * preserves the literal method-name keys so consumers see the right
 * narrowed type when they call `wata.send({ method: 'ping', ... })`.
 *
 * @example
 * ```ts
 * import { Schema } from 'wata'
 * import { z } from 'zod/mini'
 *
 * const schema = Schema.create({
 *   methods: {
 *     ping: Schema.method({
 *       params: z.tuple([]),
 *       result: z.object({ ok: z.literal(true) }),
 *     }),
 *   },
 * })
 * ```
 */
export function create<const methods extends Record<string, Method>>(
  options: create.Options<methods>,
): create.ReturnType<methods> {
  return { methods: options.methods }
}

export declare namespace create {
  /** Options for {@link create}. */
  type Options<methods extends Record<string, Method>> = {
    /** Closed method registry. */
    methods: methods
  }

  /** Result of {@link create}. */
  type ReturnType<methods extends Record<string, Method>> = Schema<methods, undefined>
}

const rpcFallback = method({
  params: Rpc.schema.params,
  result: z.unknown(),
})

/**
 * Create an open JSON-RPC schema. Unknown method names validate their
 * `params` against the generic JSON-RPC `params` slot and leave `result`
 * as `unknown`.
 *
 * @example
 * ```ts
 * import { Schema } from 'wata'
 *
 * const schema = Schema.rpc()
 * ```
 */
export function rpc(): rpc.ReturnType {
  return { fallback: rpcFallback, methods: {} }
}

export declare namespace rpc {
  /** Result of {@link rpc}. */
  type ReturnType = Schema<{}, typeof rpcFallback>
}

/**
 * Extend a base schema with precise method definitions. Extension methods
 * override base methods, and the base fallback is preserved unless the
 * extension supplies one.
 *
 * @example
 * ```ts
 * import { Schema } from 'wata'
 * import { z } from 'zod/mini'
 *
 * const schema = Schema.extend(Schema.rpc(), {
 *   methods: {
 *     ping: Schema.method({
 *       params: z.tuple([]),
 *       result: z.object({ ok: z.literal(true) }),
 *     }),
 *   },
 * })
 * ```
 */
export function extend<
  const base extends Schema,
  const methods extends Record<string, Method>,
  const fallback extends Method | undefined = undefined,
>(
  base: base,
  extension: extend.Options<methods, fallback>,
): extend.ReturnType<base, methods, fallback> {
  const fallback_value = extension.fallback ?? base.fallback
  return {
    methods: { ...base.methods, ...extension.methods },
    ...(fallback_value ? { fallback: fallback_value } : {}),
  } as extend.ReturnType<base, methods, fallback>
}

export declare namespace extend {
  /** Options for {@link extend}. */
  type Options<
    methods extends Record<string, Method>,
    fallback extends Method | undefined = undefined,
  > = {
    /** Optional replacement fallback definition. */
    fallback?: fallback | undefined
    /** Method definitions to overlay onto the base schema. */
    methods: methods
  }

  /** Result of {@link extend}. */
  type ReturnType<
    base extends Schema,
    methods extends Record<string, Method>,
    fallback extends Method | undefined = undefined,
  > = Schema<Merge<base['methods'], methods>, fallback extends Method ? fallback : FallbackOf<base>>
}

/**
 * Return the method definition for `name`, falling back to the schema's
 * generic RPC definition when one exists.
 *
 * @example
 * ```ts
 * const definition = Schema.definition(schema, 'wallet_connect')
 * ```
 */
export function definition<const schema extends Schema, const name extends MethodName<schema>>(
  schema: schema,
  name: name,
): DefinitionOf<schema, name>
export function definition(schema: Schema, name: string): Method | undefined
export function definition(schema: Schema, name: string): Method | undefined {
  return schema.methods[name] ?? schema.fallback
}

/**
 * Inferred runtime type of a Zod schema. Single indirection so we can swap
 * to Standard Schema (or another dialect) in one place when v1.x lifts the
 * Zod-only restriction.
 */
export type Inferred<schema extends z.ZodMiniType> = z.output<schema>

/**
 * Method names explicitly defined on a {@link Schema}.
 *
 * @example
 * ```ts
 * type Method = Schema.KnownMethodName<typeof schema>
 * //   ^? "ping" | "eth_sign"
 * ```
 */
export type KnownMethodName<schema extends Schema> = Extract<keyof schema['methods'], string>

/**
 * Method names accepted by a {@link Schema}. Open schemas accept arbitrary
 * strings through their fallback; closed schemas accept only known methods.
 *
 * @example
 * ```ts
 * type Method = Schema.MethodName<typeof schema>
 * //   ^? "ping" | "eth_sign"
 * ```
 */
export type MethodName<schema extends Schema> = schema extends { fallback: Method }
  ? KnownMethodName<schema> | string
  : KnownMethodName<schema>

/**
 * Inferred `params` type for a given method on a {@link Schema}.
 *
 * @example
 * ```ts
 * type PingParams = Schema.ParamsOf<typeof schema, 'ping'>
 * //   ^? readonly []
 * ```
 */
export type ParamsOf<schema extends Schema, name extends MethodName<schema>> = Inferred<
  DefinitionOf<schema, name>['params']
>

/**
 * Inferred `result` type for a given method on a {@link Schema}.
 *
 * @example
 * ```ts
 * type PingResult = Schema.ResultOf<typeof schema, 'ping'>
 * //   ^? { ok: true }
 * ```
 */
export type ResultOf<schema extends Schema, name extends MethodName<schema>> = Inferred<
  DefinitionOf<schema, name>['result']
>

/**
 * Validate `value` against a Zod schema. Returns the parsed (possibly
 * transformed) value on success; throws {@link ProtocolError} on validation
 * failure.
 *
 * Centralizes the Zod call so we can swap to Standard Schema later without
 * touching every callsite.
 *
 * @example
 * ```ts
 * import { Schema } from 'wata'
 *
 * const params = Schema.validate(method.params, value)
 * ```
 */
export function validate<const schema extends z.ZodMiniType>(
  schema: schema,
  value: unknown,
): Inferred<schema> {
  const result = schema.safeParse(value)
  if (!result.success)
    throw new Errors.ProtocolError('schema validation failed', {
      details: result.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; '),
    })
  return result.data
}
