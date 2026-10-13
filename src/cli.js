// Account recovery from the server's command line.
//
//   node src/cli.js list-users
//   node src/cli.js reset-password <username> [new-password]   (prints a random one if omitted)
//   node src/cli.js reset-2fa <username>                         (lost phone / security key)
//   node src/cli.js make-admin <username>
//
// With Docker:  docker compose exec app node src/cli.js list-users

import crypto from 'node:crypto';
import { db } from './db.js';
import { hashPassword } from './auth.js';
import { resetMfa, mfaStatus } from './mfa.js';

const [command, username, password] = process.argv.slice(2);

function findUser(name) {
  if (!name) {
    console.error('Give a username. Run "list-users" to see them.');
    process.exit(1);
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(name);
  if (!user) {
    console.error(`No user named "${name}". Run "list-users" to see them.`);
    process.exit(1);
  }
  return user;
}

switch (command) {
  case 'list-users': {
    const users = db.prepare('SELECT username, display_name, is_admin FROM users ORDER BY username').all();
    if (!users.length) console.log('No users yet. Open TextBoss in a browser to create the first admin.');
    for (const u of users) {
      const m = mfaStatus(db.prepare('SELECT id FROM users WHERE username = ?').get(u.username).id);
      const twoFactor = m.enabled ? [m.totp && 'app', m.passkeys && `${m.passkeys} passkey${m.passkeys > 1 ? 's' : ''}`].filter(Boolean).join(' + ') : 'no 2FA';
      console.log(`${u.username.padEnd(24)} ${u.is_admin ? 'admin' : 'user '}  ${twoFactor.padEnd(18)} ${u.display_name}`);
    }
    break;
  }
  case 'reset-password': {
    const user = findUser(username);
    const next = password || crypto.randomBytes(9).toString('base64url');
    if (next.length < 8) {
      console.error('Passwords must be at least 8 characters.');
      process.exit(1);
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id); // sign out everywhere
    console.log(`Password for "${user.username}" reset.`);
    if (!password) console.log(`Temporary password: ${next}\nSign in with it, then change it under ⋮ → Change password.`);
    break;
  }
  case 'reset-2fa': {
    const user = findUser(username);
    resetMfa(user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    console.log(`Two-factor sign-in removed for "${user.username}" (authenticator app, passkeys and backup codes).`);
    console.log('They can sign in with their password and set it up again under ⋮ → Security.');
    break;
  }
  case 'make-admin': {
    const user = findUser(username);
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
    console.log(`"${user.username}" is now an admin.`);
    break;
  }
  default:
    console.log(`Usage:
  node src/cli.js list-users
  node src/cli.js reset-password <username> [new-password]
  node src/cli.js reset-2fa <username>
  node src/cli.js make-admin <username>`);
    process.exit(command ? 1 : 0);
}
