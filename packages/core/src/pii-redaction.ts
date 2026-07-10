/**
 * PII masking for AI calls (docs/entscheidungen.md): the extraction model
 * only ever sees the message body with contact data replaced by placeholders.
 * Contact data is merged locally from channel metadata instead.
 *
 * Honest limits: free-text names (other than the known sender) cannot be
 * reliably masked, and phone-like heuristics can occasionally hit other
 * long digit sequences (order numbers) — a deliberate privacy-over-detail
 * trade-off.
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Phone-like: leading + or 0, then 6-18 digits with common separators.
const PHONE_RE = /(?<![\w/])(?:\+|0)[\d\s\-/().]{5,20}\d/g;

const MIN_PHONE_DIGITS = 7;

export interface KnownPii {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

/** Mask e-mail addresses, phone-like numbers and known sender values. */
export function redactPiiForAi(text: string, known: KnownPii = {}): string {
  let result = text;

  // Known sender values first (exact, case-insensitive) — catches signatures.
  for (const [value, placeholder] of [
    [known.email, '[E-MAIL ENTFERNT]'],
    [known.phone, '[TELEFONNUMMER ENTFERNT]'],
    [known.name, '[NAME ENTFERNT]'],
  ] as const) {
    if (value && value.trim().length >= 3) {
      result = result.replaceAll(new RegExp(escapeRegExp(value.trim()), 'gi'), placeholder);
    }
  }

  result = result.replace(EMAIL_RE, '[E-MAIL ENTFERNT]');
  result = result.replace(PHONE_RE, (match) => {
    const digits = match.replace(/\D/g, '');
    return digits.length >= MIN_PHONE_DIGITS ? '[TELEFONNUMMER ENTFERNT]' : match;
  });

  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
