import { z } from 'zod/mini'

import * as Schema from '../../../src/core/Schema.js'

export const schema = Schema.create({
  methods: {
    ping: Schema.method({
      params: z.tuple([z.string()]),
      result: z.object({
        at: z.string(),
        message: z.string(),
        transport: z.string(),
      }),
    }),
  },
})
