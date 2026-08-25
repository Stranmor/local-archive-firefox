import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: '__MSG_extensionName__',
    description: '__MSG_extensionDescription__',
    default_locale: 'en',
    permissions: ['activeTab', 'scripting', 'storage', 'downloads'],
    optional_host_permissions: ['https://web.telegram.org/*'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    web_accessible_resources: [
      {
        resources: ['icon-48.png'],
        matches: ['https://web.telegram.org/*'],
      },
      {
        resources: ['telegram-page-bridge.js'],
        matches: ['https://web.telegram.org/*'],
      },
    ],
    browser_specific_settings: {
      gecko: {
        id: '{893462e9-4b44-4be5-97d6-f7178ef693b6}',
        strict_min_version: '142.0',
        data_collection_permissions: {
          required: ['none'],
        },
      },
    },
  },
  vite: () => ({
    define: {
      __TELEARCHIVE_EXTENSION_BUILD__: 'true',
    },
    build: {
      minify: false,
      sourcemap: false,
    },
  }),
  webExt: {
    disabled: true,
  },
  zip: {
    zipSources: false,
    excludeSources: ['artifacts/**', 'tmp/**'],
  },
});
