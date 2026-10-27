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
  voipms: {
    username: env.VOIPMS_USERNAME || '',
    password: env.VOIPMS_PASSWORD || '',
  },
  webhookSecret: env.WEBHOOK_SECRET || '',
  // A practice copy (npm run clone:start): nothing is texted, emailed or pushed
  clone: env.TEXTBOSS_CLONE === '1',
  // 'auto': Secure cookies when the request came over HTTPS (directly or via a
  // proxy's X-Forwarded-Proto), plain cookies over http:// on the local network
  secureCookies: env.INSECURE_COOKIES === '1' ? false : 'auto',
};
