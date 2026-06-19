const fs = require('node:fs')
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

// `zile dev` resolves the workspace `dist/*` entrypoints to `src/*.ts` via
// symlinks, so Metro ends up in TypeScript source whose relative imports use
// `.js` specifiers (the ESM convention enforced repo-wide). Node examples run
// under `tsx`, which resolves `.js`→`.ts` automatically; Metro has no such
// behaviour, so map those specifiers back to their `.ts` originals here and
// watch the repo root so the symlinked source sits inside Metro's tree.
const config = getDefaultConfig(__dirname)
config.watchFolders = [path.resolve(__dirname, '../..')]
const resolve = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.endsWith('.js') && moduleName.startsWith('.')) {
    const ts = path.resolve(context.originModulePath, '..', moduleName.replace(/\.js$/, '.ts'))
    if (fs.existsSync(ts)) return { filePath: ts, type: 'sourceFile' }
  }
  return resolve
    ? resolve(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform)
}
module.exports = config
