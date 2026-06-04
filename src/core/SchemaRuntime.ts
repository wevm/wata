import * as Rpc from './Rpc.js'
import * as Schema from './Schema.js'

/**
 * Validate `params` against the schema definition for `method`, including
 * the fallback definition on open schemas.
 */
export function validateParamsForMethod(
  schema: Schema.Schema,
  method: string,
  params: Rpc.Params,
): void {
  const definition = Schema.definition(schema, method)
  if (!definition) return
  Schema.validate(definition.params, params)
}

/**
 * Validate a response `result` against the schema definition for `method`,
 * including the fallback definition on open schemas.
 */
export function validateResultForMethod(
  schema: Schema.Schema,
  method: string | undefined,
  result: unknown,
): unknown {
  if (!method) return result
  const definition = Schema.definition(schema, method)
  if (!definition) return result
  return Schema.validate(definition.result, result)
}
