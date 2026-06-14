import type { Hex } from 'ox'
import { describe, expectTypeOf, test } from 'vp/test'
import { MessageSig } from 'wata'

describe('MessageSig', () => {
  test('HttpMessage shape', () => {
    expectTypeOf<MessageSig.HttpMessage>().toEqualTypeOf<{
      headers: Record<string, string>
      method: string
      url: string
    }>()
  })

  test('sign(): typed HttpMessage + Hex.Hex privateKey -> { signature, signatureInput }', () => {
    expectTypeOf(MessageSig.sign).parameter(0).toMatchTypeOf<{
      components: readonly string[]
      label?: string | undefined
      message: MessageSig.HttpMessage
      parameters: MessageSig.Parameters
      privateKey: Hex.Hex
    }>()
    expectTypeOf(MessageSig.sign).returns.toEqualTypeOf<MessageSig.Headers>()
  })

  test('verify(): typed HttpMessage + Hex.Hex publicKey -> boolean', () => {
    expectTypeOf(MessageSig.verify).parameter(0).toMatchTypeOf<{
      label?: string | undefined
      message: MessageSig.HttpMessage
      publicKey: Hex.Hex
      requiredComponents?: readonly string[] | undefined
    }>()
    expectTypeOf(MessageSig.verify).returns.toBeBoolean()
  })

  test('contentDigest accepts string or Uint8Array, returns string', () => {
    expectTypeOf(MessageSig.contentDigest).parameter(0).toEqualTypeOf<string | Uint8Array>()
    expectTypeOf(MessageSig.contentDigest).returns.toBeString()
  })

  test('parseSignatureInput(): -> { label, components, parameters }', () => {
    expectTypeOf(
      MessageSig.parseSignatureInput,
    ).returns.toEqualTypeOf<MessageSig.ParsedSignatureInput>()
  })

  test('Parameters shape', () => {
    expectTypeOf<MessageSig.Parameters>().toEqualTypeOf<{
      alg?: string | undefined
      created?: number | undefined
      expires?: number | undefined
      keyid?: string | undefined
      nonce?: string | undefined
    }>()
  })

  test('Headers shape', () => {
    expectTypeOf<MessageSig.Headers>().toEqualTypeOf<{
      signature: string
      signatureInput: string
    }>()
  })
})
