import { z } from 'zod/mini'

import * as Schema from '../../../src/core/Schema.js'

export const schema = Schema.create({
  methods: {
    ping: Schema.method({
      params: z.tuple([]),
      result: z.object({
        at: z.string(),
        ok: z.literal(true),
        transport: z.string(),
      }),
    }),
  },
})
