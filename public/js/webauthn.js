// Passkeys / security keys in the browser: turns the server's JSON options into
// the binary form navigator.credentials needs, and the result back into JSON.

const toBytes = (b64url) => Uint8Array.from(atob(b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4)), (c) => c.charCodeAt(0));
const toB64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Passkeys need HTTPS (or localhost) and the address they were registered on
export const passkeysSupported = (origin) =>
  !!window.PublicKeyCredential && window.isSecureContext && (!origin || origin === location.origin);

const creds = (list = []) => list.map((c) => ({ ...c, id: toBytes(c.id) }));

function explain(err) {
  if (err?.name === 'NotAllowedError') return new Error('Cancelled, or the passkey request timed out.');
  if (err?.name === 'InvalidStateError') return new Error('This device already has a passkey for your account.');
  if (err?.name === 'SecurityError') return new Error('Passkeys only work at the address TextBoss was set up with (over HTTPS).');
  return err;
}

export async function createPasskey(options) {
  let cred;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        ...options,
        challenge: toBytes(options.challenge),
        user: { ...options.user, id: toBytes(options.user.id) },
        excludeCredentials: creds(options.excludeCredentials),
      },
    });
  } catch (err) {
    throw explain(err);
  }
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64url(cred.response.clientDataJSON),
      attestationObject: toB64url(cred.response.attestationObject),
      transports: cred.response.getTransports?.() ?? [],
    },
  };
}

export async function getPasskey(options) {
  let cred;
  try {
    cred = await navigator.credentials.get({
      publicKey: { ...options, challenge: toBytes(options.challenge), allowCredentials: creds(options.allowCredentials) },
    });
  } catch (err) {
    throw explain(err);
  }
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64url(cred.response.clientDataJSON),
      authenticatorData: toB64url(cred.response.authenticatorData),
      signature: toB64url(cred.response.signature),
      userHandle: cred.response.userHandle ? toB64url(cred.response.userHandle) : undefined,
    },
  };
}

// A friendly default name for a new passkey
export function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Passkey';
}
