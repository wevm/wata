/**
 * Method-registry schema used to type and validate the JSON-RPC traffic
 * carried by a `Handshake`.
 *
 * A schema is a map from method name → `{ params, result }` Zod schemas.
 * `Handshake.create({ schema })` flows these schemas through generics so
 * `send`, `notify`, `onRequest`, etc. all infer the right `params` and
 * `result` shape from a literal method name.
 *
 * The runtime path goes through {@link validate} so a future Standard Schema
 * swap is one mechanical change. The type-inference path goes through
 * {@link Inferred} so `z.input` / `z.output` choices stay in one place.
 *
 * v1 is Zod-only on purpose (see the plan's "Why Zod-only" rationale); the
 * indirection exists so we can swap the dialect without touching every
 * `Handshake` callsite.
 */

import { z } from 'zod'

import * as Errors from './Errors.js'

/**
 * Definition of a single method. `params` validates the request `params`
 * payload, `result` validates the response `result` payload.
 *
 * Construct with {@link method} so the generics are pinned correctly.
 */
export type Method<params extends z.ZodType = z.ZodType, result extends z.ZodType = z.ZodType> = {
  params: params
  result: result
}

/**
 * Define a single method's `params` / `result` schema pair.
 *
 * @example
 * ```ts
 * import { Schema } from 'handshakes'
 * import { z } from 'zod'
 *
 * const ping = Schema.method({
 *   params: z.tuple([]),
 *   result: z.object({ ok: z.literal(true) }),
 * })
 * ```
 */
export function method<const params extends z.ZodType, const result extends z.ZodType>(
  options: Method<params, result>,
): Method<params, result> {
  return options
}

/**
 * A method-registry schema. Keys are method names; values are {@link Method}
 * definitions.
 */
export type Schema<methods extends Record<string, Method> = Record<string, Method>> = {
  methods: methods
}

/**
 * Create a method-registry schema. The `const` generic on `methods`
 * preserves the literal method-name keys so consumers see the right
 * narrowed type when they call `handshake.send({ method: 'ping', ... })`.
 *
 * @example
 * ```ts
 * import { Schema } from 'handshakes'
 * import { z } from 'zod'
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
  options: Schema<methods>,
): Schema<methods> {
  return { methods: options.methods }
}

/**
 * Inferred runtime type of a Zod schema. Single indirection so we can swap
 * to Standard Schema (or another dialect) in one place when v1.x lifts the
 * Zod-only restriction.
 */
export type Inferred<schema extends z.ZodType> = z.output<schema>

/**
 * Method names defined on a {@link Schema}.
 *
 * @example
 * ```ts
 * type Method = Schema.MethodName<typeof schema>
 * //   ^? "ping" | "eth_sign"
 * ```
 */
export type MethodName<schema extends Schema> = Extract<keyof schema['methods'], string>

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
  schema['methods'][name]['params']
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
  schema['methods'][name]['result']
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
 * import { Schema } from 'handshakes'
 *
 * const params = Schema.validate(method.params, value)
 * ```
 */
export function validate<const schema extends z.ZodType>(
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
