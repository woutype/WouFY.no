const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Never bundle local test-tracks/ into release builds (.ipa / .apk)
const isProd = process.env.NODE_ENV === 'production' || Boolean(process.env.EAS_BUILD);
const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (isProd && moduleName.includes('test-tracks/')) {
    return { type: 'empty' };
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
