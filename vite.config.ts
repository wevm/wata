import path from 'node:path'
import { defineConfig } from 'vp'
import { playwright } from 'vp/test/browser-playwright'

export default defineConfig({
  resolve: {
    alias: {
      'wata/host': path.resolve(import.meta.dirname, 'src/host/index.ts'),
      'wata/server': path.resolve(import.meta.dirname, 'src/server/index.ts'),
      wata: path.resolve(import.meta.dirname, 'src'),
    },
    dedupe: ['vp'],
  },
  lint: {
    ignorePatterns: ['package.json'],
  },
  fmt: {
    semi: false,
    singleQuote: true,
    trailingComma: 'all',
    tabWidth: 2,
    printWidth: 100,
    ignorePatterns: ['package.json'],
    experimentalSortImports: {
      groups: [
        ['value-builtin', 'value-external', 'type-import', 'value-internal', 'type-internal'],
        [
          'value-parent',
          'value-sibling',
          'value-index',
          'type-parent',
          'type-sibling',
          'type-index',
        ],
        'unknown',
      ],
    },
    overrides: [
      {
        files: ['**/*.md', '**/*.mdx'],
        options: { embeddedLanguageFormatting: 'off' },
      },
    ],
  },
  test: {
    reporters: process.env.CI ? ['tree'] : [],
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: [
            './src/**/*.test.ts',
            './test/**/*.test.ts',
            '!./src/**/*.browser.test.ts',
            '!./test/**/*.browser.test.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['./src/**/*.browser.test.ts', './test/**/*.browser.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            instances: [{ browser: 'chromium' }],
            provider: playwright(),
            screenshotFailures: false,
          },
        },
      },
    ],
  },
})
