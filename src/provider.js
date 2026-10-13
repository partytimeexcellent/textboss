// BulkVS credentials: values saved in Admin settings win over .env

import { config } from './config.js';
import { getSetting } from './db.js';

export function bulkvsCredentials() {
  const saved = getSetting('bulkvs.username');
  if (saved) {
    return {
      username: saved,
      // A username saved in the app with no saved token keeps using the .env token
      password: getSetting('bulkvs.password') ?? config.bulkvs.password,
      apiBase: config.bulkvs.apiBase,
      source: 'admin',
    };
  }
  return { ...config.bulkvs, source: config.bulkvs.username ? 'env' : null };
}

// No credentials anywhere: nothing is really sent, replies are simulated
export const isMockMode = () => !bulkvsCredentials().username;
