// Phone numbers are stored as 10-digit US/Canada (NANP) strings, which is how
// BulkVS returns its own numbers. Anything else is kept as bare digits.

export function normalizePhone(input) {
  const digits = String(input ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

export function isValidPhone(input) {
  const n = normalizePhone(input);
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(n) || /^\d{5,6}$/.test(n); // NANP or short code
}

// BulkVS examples use 11 digits for recipients and 10 for the sending number.
export function toBulkvsRecipient(phone) {
  const n = normalizePhone(phone);
  return n.length === 10 ? `1${n}` : n;
}

export function participantsKey(phones) {
  return [...new Set(phones.map(normalizePhone).filter(Boolean))].sort().join(',');
}
