// Which texting provider is in use (BulkVS or VoIP.ms) and its credentials.
// Values saved in Admin settings win over .env.

import { config } from './config.js';
import { getSetting } from './db.js';

export const PROVIDERS = { bulkvs: 'BulkVS', voipms: 'VoIP.ms' };

const ENV = {
  bulkvs: { username: config.bulkvs.username, password: config.bulkvs.password },
  voipms: { username: config.voipms.username, password: config.voipms.password },
};

export function providerCredentials(id = activeProvider()) {
  const saved = getSetting(`${id}.username`);
  const extra = id === 'bulkvs' ? { apiBase: config.bulkvs.apiBase } : {};
  if (saved) {
    // A username saved in the app with no saved password keeps using the .env one
    return { username: saved, password: getSetting(`${id}.password`) ?? ENV[id].password, source: 'admin', ...extra };
  }
  return { ...ENV[id], source: ENV[id].username ? 'env' : null, ...extra };
}

// Chosen in Admin settings; otherwise whichever one .env configures (BulkVS first)
export function activeProvider() {
  const chosen = getSetting('provider.active');
  if (PROVIDERS[chosen]) return chosen;
  if (!config.bulkvs.username && config.voipms.username) return 'voipms';
  return 'bulkvs';
}

export const providerName = () => PROVIDERS[activeProvider()];

export const bulkvsCredentials = () => providerCredentials('bulkvs');

// No credentials for the active provider: nothing is really sent, replies are simulated
export const isMockMode = () => !providerCredentials().username;
