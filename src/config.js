import path from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, ''),
  dataDir: path.resolve(env.DATA_DIR || './data'),
  importDir: path.resolve(env.IMPORT_DIR || path.join(env.DATA_DIR || './data', 'import')),
  bulkvs: {
    username: env.BULKVS_USERNAME || '',
    password: env.BULKVS_PASSWORD || env.BULKVS_TOKEN || '',
    apiBase: (env.BULKVS_API_BASE || 'https://portal.bulkvs.com/api/v1.0').replace(/\/+$/, ''),
  },
  webhookSecret: env.WEBHOOK_SECRET || '',
  secureCookies: env.INSECURE_COOKIES !== '1',
};
