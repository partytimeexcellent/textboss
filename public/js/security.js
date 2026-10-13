// Personal security settings: authenticator app, passkeys / security keys,
// backup codes and signing out other devices. Also used as the required
// setup screen when an admin turns on "require two-factor sign-in".

import { h, fill, icon, api, toast, dialog, paneHead, relTime } from './core.js';
import { passkeysSupported, createPasskey, deviceName } from './webauthn.js';

const card = (title, description, ...body) =>
  h('section', { class: 'card' },
    h('header', { class: 'card-head' }, h('h2', {}, title), description && h('p', {}, description)),
    h('div', { class: 'card-body' }, ...body));
const pill = (text, kind = '') => h('span', { class: `pill ${kind}` }, text);

function askPassword(title, message, confirmLabel) {
  return new Promise((resolve) => {
    let value = null;
    const input = h('input', { type: 'password', name: 'password', required: true, autocomplete: 'current-password' });
    const dlg = dialog(title, [h('p', { class: 'dialog-text' }, message), h('label', {}, 'Your password', input)], confirmLabel, () => {
      value = input.value;
    }, { danger: true });
    dlg.addEventListener('close', () => resolve(value));
    input.focus();
  });
}

export function showBackupCodes(codes) {
  const text = codes.join('\n');
  dialog('Save your backup codes', [
    h('p', { class: 'dialog-text' }, 'Each code signs you in once if you don\'t have your phone or security key. Store them somewhere safe, like a password manager. They won\'t be shown again.'),
    h('div', { class: 'backup-codes' }, codes.map((c) => h('code', {}, c))),
    h('div', { class: 'card-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => navigator.clipboard.writeText(text).then(() => toast('Copied')) }, 'Copy'),
      h('a', { class: 'btn', download: 'textboss-backup-codes.txt', href: `data:text/plain;charset=utf-8,${encodeURIComponent(`TextBoss backup codes\n${location.host}\n\n${text}\n`)}` }, icon('download'), 'Download')),
  ], null, () => {});
}

// container: where to draw. forced: the admin requires 2FA and this person has none.
export async function renderSecurity(container, { forced = false, onEnabled } = {}) {
  let s;
  try {
    s = await api('/me/security');
  } catch (err) {
    fill(container, h('p', { class: 'bad' }, err.message));
    return;
  }
  const redraw = () => renderSecurity(container, { forced, onEnabled });
  const afterFirstMethod = (codes) => {
    if (codes) showBackupCodes(codes);
    if (forced && onEnabled) onEnabled();
    else redraw();
  };
  const canPasskey = s.passkeysAvailable && passkeysSupported(s.origin);

  // ----- Authenticator app -----
  const totpBody = h('div', { class: 'card-body-inner' });
  const drawTotp = () => fill(totpBody,
    s.totp
      ? [
          h('div', { class: 'status-row' }, pill('On', 'ok')),
          h('div', { class: 'card-actions' }, h('button', { class: 'btn danger', onclick: async () => {
            const password = await askPassword('Remove the authenticator app?', 'You won\'t be asked for its codes when signing in anymore.', 'Remove');
            if (password == null) return;
            try {
              await api('/me/totp/disable', { method: 'POST', body: { password } });
              toast('Authenticator app removed');
              redraw();
            } catch (err) {
              toast(err.message);
            }
          } }, 'Remove')),
        ]
      : h('div', { class: 'card-actions' }, h('button', { class: 'btn primary', onclick: startTotp }, 'Set up authenticator app')));

  async function startTotp() {
    const setup = await api('/me/totp/setup', { method: 'POST', body: {} });
    const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, placeholder: '123 456', class: 'code-input' });
    const error = h('div', { class: 'form-error' });
    fill(totpBody,
      h('ol', { class: 'steps' },
        h('li', {}, 'Open your authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…) and add an account.'),
        h('li', {}, 'Scan this code with it, or enter the key by hand:'),
      ),
      h('div', { class: 'totp-setup' },
        h('div', { class: 'qr', html: setup.qrSvg }),
        h('div', { class: 'totp-key' },
          h('div', { class: 'field-label' }, 'Setup key'),
          h('code', {}, setup.secret),
          h('a', { href: setup.uri, class: 'link-btn' }, 'Open in an authenticator app on this device'))),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Then enter the 6-digit code it shows'), code),
      error,
      h('div', { class: 'card-actions' },
        h('button', { class: 'btn primary', onclick: async (e) => {
          e.target.disabled = true;
          try {
            const r = await api('/me/totp/enable', { method: 'POST', body: { code: code.value } });
            toast('Authenticator app is on');
            s.totp = true;
            afterFirstMethod(r.backupCodes);
          } catch (err) {
            error.textContent = err.message;
            e.target.disabled = false;
          }
        } }, 'Turn on'),
        h('button', { class: 'btn', onclick: drawTotp }, 'Cancel')));
    code.focus();
  }
  drawTotp();

  // ----- Passkeys -----
  const addPasskey = async () => {
    const name = h('input', { type: 'text', name: 'name', value: deviceName(), required: true, maxlength: 60 });
    dialog('Add a passkey', [
      h('p', { class: 'dialog-text' }, 'Your device will ask you to confirm with Face ID, Touch ID, Windows Hello, your phone\'s screen lock, or a security key.'),
      h('label', {}, 'Name it so you can recognise it later', name),
    ], 'Continue', async () => {
      const options = await api('/me/passkeys/options', { method: 'POST', body: {} });
      const response = await createPasskey(options);
      const r = await api('/me/passkeys', { method: 'POST', body: { name: name.value, response } });
      toast('Passkey added');
      afterFirstMethod(r.backupCodes);
    });
  };

  const passkeyCard = card('Passkeys and security keys',
    'Sign in with Face ID, Touch ID, Windows Hello, your Android phone, or a USB/NFC key such as a YubiKey. The most secure option, and you can use one instead of your password.',
    s.passkeyList.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Added'), h('th', {}, 'Last used'), h('th', { class: 'right' }, ''))),
          h('tbody', {}, s.passkeyList.map((p) => h('tr', {},
            h('td', { class: 'strong' }, p.name),
            h('td', {}, relTime(p.createdAt)),
            h('td', {}, p.lastUsedAt ? relTime(p.lastUsedAt) : 'Never'),
            h('td', {}, h('div', { class: 'row-actions' }, h('button', { class: 'btn danger', onclick: async () => {
              const password = await askPassword(`Remove "${p.name}"?`, 'That device or key will no longer be able to sign in to TextBoss.', 'Remove');
              if (password == null) return;
              try {
                await api(`/me/passkeys/${p.id}/remove`, { method: 'POST', body: { password } });
                toast('Passkey removed');
                redraw();
              } catch (err) {
                toast(err.message);
              }
            } }, 'Remove'))))))))
      : null,
    canPasskey
      ? h('div', { class: 'card-actions' }, h('button', { class: s.passkeyList.length ? 'btn' : 'btn primary', onclick: addPasskey }, icon('plus'), 'Add a passkey'))
      : h('p', { class: 'hint' }, s.passkeysAvailable
        ? `Passkeys can only be added at ${s.origin}. Open TextBoss there to add one.`
        : 'Passkeys need TextBoss to be reached over HTTPS. They\'ll be available once it\'s behind your secure web address.'));

  // ----- Backup codes -----
  const backupCard = s.enabled && card('Backup codes',
    'One-time codes for when you don\'t have your phone or security key.',
    h('div', { class: 'status-row' }, pill(`${s.backupLeft} of 10 left`, s.backupLeft <= 2 ? 'warn' : '')),
    h('div', { class: 'card-actions' }, h('button', { class: 'btn', onclick: async () => {
      const password = await askPassword('Make new backup codes?', 'Your old backup codes will stop working.', 'Make new codes');
      if (password == null) return;
      try {
        showBackupCodes((await api('/me/backup-codes', { method: 'POST', body: { password } })).codes);
        redraw();
      } catch (err) {
        toast(err.message);
      }
    } }, 'Make new codes')));

  // ----- Sessions -----
  const sessionsCard = !forced && card('Signed-in devices',
    `You're signed in on ${s.sessions} device${s.sessions === 1 ? '' : 's'} or browser${s.sessions === 1 ? '' : 's'}.`,
    h('div', { class: 'card-actions' }, h('button', { class: 'btn', disabled: s.sessions <= 1, onclick: async () => {
      const r = await api('/me/sessions/revoke-others', { method: 'POST', body: {} });
      toast(`Signed out ${r.signedOut} other device${r.signedOut === 1 ? '' : 's'}`);
      redraw();
    } }, 'Sign out everywhere else')));

  const summary = h('div', { class: `callout ${s.enabled ? 'ok' : 'warn'}` }, icon(s.enabled ? 'shield' : 'warning'),
    h('div', {},
      h('strong', {}, s.enabled ? 'Two-factor sign-in is on. ' : forced ? 'Your administrator requires two-factor sign-in. ' : 'Two-factor sign-in is off. '),
      s.enabled
        ? 'Signing in needs your password plus a code or passkey.'
        : 'Add an authenticator app or a passkey below. You only need one, but adding both gives you a backup.'));

  fill(container,
    summary,
    card('Authenticator app', 'Six-digit codes from an app on your phone. Works on iPhone, Android and every computer.', totpBody),
    passkeyCard,
    backupCard,
    sessionsCard);
}

// #/security page
export function renderSecurityPage(main) {
  const body = h('div', { class: 'admin-page' });
  fill(main, paneHead('Security'), body);
  renderSecurity(body);
}
