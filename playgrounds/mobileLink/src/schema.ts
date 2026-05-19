import { z } from 'zod/mini'

import * as Schema from '../../../src/core/Schema.js'

export const schema = Schema.create({
  methods: {
    authorizeAccountAccess: Schema.method({
      params: z.tuple([
        z.object({
          appName: z.string(),
          permissions: z.array(z.string()),
        }),
      ]),
      result: z.object({
        accountName: z.string(),
        approved: z.literal(true),
        at: z.string(),
        message: z.string(),
        permissions: z.array(z.string()),
      }),
    }),
  },
})
