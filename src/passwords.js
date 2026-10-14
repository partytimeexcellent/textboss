// Password rules, following NIST SP 800-63B: length and a block list of
// guessable passwords matter; forced symbols and expiry don't. Returns a
// readable reason when a password isn't acceptable, or null.

export const MIN_PASSWORD = 10;

// Common choices that are tried first in any attack, plus a few that fit this app
const COMMON = new Set(`
password password1 password12 password123 password1234 passw0rd p@ssw0rd p@ssword letmein letmein1 welcome welcome1
welcome123 qwerty qwerty123 qwertyuiop asdfghjkl zxcvbnm 1q2w3e4r 1q2w3e4r5t qazwsxedc iloveyou iloveyou1 sunshine
princess football baseball basketball superman batman dragon monkey master shadow michael jennifer jordan23 trustno1
abc123 abcd1234 abcdef123 admin admin123 administrator changeme changeme123 default secret secret123 login
textboss textboss1 textboss123 bulkvs voipms clinic clinic123 therapy therapy123 physical physicaltherapy
summer2024 summer2025 summer2026 winter2024 winter2025 winter2026 spring2025 spring2026 fall2025 fall2026
`.split(/\s+/).filter(Boolean));

const SEQUENCES = ['0123456789', '1234567890', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

export function passwordProblem(password, { username = '', displayName = '', email = '' } = {}) {
  const pw = String(password ?? '');
  if (pw.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters`;
  if (pw.length > 200) return 'Password is too long (200 characters max)';
  const lower = pw.toLowerCase();
  const bare = lower.replace(/[^a-z0-9]/g, '');
  if (COMMON.has(lower) || COMMON.has(bare) || COMMON.has(bare.replace(/\d+$/, ''))) return 'That password is too common. Choose something less guessable, like a few unrelated words.';
  if (new Set(pw).size < 5) return 'Use more variety: that password repeats the same few characters';
  for (const seq of SEQUENCES) {
    const rev = [...seq].reverse().join('');
    if (bare.length >= 4 && (seq.includes(bare) || rev.includes(bare))) return 'That password is a simple sequence. Choose something less guessable.';
  }
  const personal = [username, email.split('@')[0], ...String(displayName).split(/\s+/)]
    .map((s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter((s) => s.length >= 3);
  if (personal.some((s) => bare.includes(s))) return 'Don\'t use your username, name or email in your password';
  return null;
}
