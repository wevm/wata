const fs = require('node:fs')
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
const root = path.resolve(__dirname, '../..')
const resolve = config.resolver.resolveRequest

config.watchFolders = [root]
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.endsWith('.js') && moduleName.startsWith('.')) {
    const filePath = path.resolve(context.originModulePath, '..', moduleName.replace(/\.js$/, '.ts'))
    if (fs.existsSync(filePath)) return { filePath, type: 'sourceFile' }
  }

  return resolve
    ? resolve(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform)
}

module.exports = config
