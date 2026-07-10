/**
 * Pure text utilities for the e-mail channel (CLAUDE.md §10.2, §8 stage 1):
 * conservative reply/signature stripping before AI extraction, auto-reply
 * detection for the auto-reply loop guard, and ticket-ref matching in subjects.
 */

const SIGNATURE_DELIMITER = /^--\s*$/m;
const UNDERSCORE_SEPARATOR = /^_{8,}\s*$/m;
const ORIGINAL_MESSAGE_SEPARATOR =
  /^-{5,}\s*(Original[- ]?Nachricht|Ursprüngliche Nachricht|Original Message|Weitergeleitete Nachricht|Forwarded message)/im;
// Apple Mail / Gmail style intro, e.g. 'Am 09.07.2026 um 14:22 schrieb Max Mustermann:'
// or 'On Wed, Jul 9, 2026 at 2:22 PM Max Mustermann wrote:'.
const REPLY_INTRO = /^(Am|On)\s.{4,100}(schrieb|wrote)\s*.*:?\s*$/m;
const OUTLOOK_FROM_LINE = /^(Von|From):\s/;
const OUTLOOK_DATE_LINE = /^(Gesendet|Sent|Datum|Date):\s/;
const QUOTED_LINE = /^>/;

// Safety net: never destroy short messages, never return empty for non-empty input.
const MIN_REMAINING_CHARS = 10;

// An Outlook-style quoted-header block is a 'Von:'/'From:' line followed within
// the next 3 lines by a 'Gesendet:'/'Sent:'/'Datum:'/'Date:' line. Returns the
// character offset of the 'Von:'/'From:' line, or -1 if no such block exists.
function findOutlookHeaderBlockIndex(text: string): number {
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (OUTLOOK_FROM_LINE.test(line)) {
      for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
        if (OUTLOOK_DATE_LINE.test(lines[j]!)) {
          return offset;
        }
      }
    }
    offset += line.length + 1;
  }
  return -1;
}

/**
 * Conservative reply/signature stripping before AI extraction: cut everything
 * from the first quote/signature/forward marker and drop '>'-quoted lines.
 * Falls back to the trimmed original when stripping would leave (almost) nothing.
 */
export function stripReplyText(text: string): string {
  const cutIndexes = [
    SIGNATURE_DELIMITER.exec(text)?.index,
    UNDERSCORE_SEPARATOR.exec(text)?.index,
    ORIGINAL_MESSAGE_SEPARATOR.exec(text)?.index,
    REPLY_INTRO.exec(text)?.index,
  ].filter((index): index is number => index !== undefined);
  const outlookIndex = findOutlookHeaderBlockIndex(text);
  if (outlookIndex >= 0) {
    cutIndexes.push(outlookIndex);
  }

  const cut = cutIndexes.length > 0 ? text.slice(0, Math.min(...cutIndexes)) : text;
  const stripped = cut
    .split('\n')
    .filter((line) => !QUOTED_LINE.test(line))
    .join('\n')
    .trim();

  if (stripped.replace(/\s/g, '').length < MIN_REMAINING_CHARS) {
    return text.trim();
  }
  return stripped;
}

export interface AutoSubmittedCheck {
  isAutoSubmitted: boolean;
  reason: string | null;
}

function toValueList(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/**
 * Loop guard for the auto-reply (CLAUDE.md §10.2): detects out-of-office and
 * other machine-generated mails via RFC 3834 and de-facto standard headers.
 * Header names are matched case-insensitively.
 */
export function detectAutoSubmitted(
  headers: Record<string, string | string[] | undefined>,
): AutoSubmittedCheck {
  for (const [name, rawValue] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    const values = toValueList(rawValue);

    if (lowerName === 'auto-submitted') {
      const matched = values.find((value) => value.trim().toLowerCase() !== 'no');
      if (matched !== undefined) {
        return { isAutoSubmitted: true, reason: `${name}: ${matched}` };
      }
    }

    if (
      (lowerName === 'x-auto-response-suppress' ||
        lowerName === 'x-autoreply' ||
        lowerName === 'x-autorespond') &&
      rawValue !== undefined
    ) {
      return { isAutoSubmitted: true, reason: `${name}: ${values.join(', ')}` };
    }

    if (lowerName === 'precedence') {
      const matched = values.find((value) => /bulk|junk|auto_reply|list/i.test(value));
      if (matched !== undefined) {
        return { isAutoSubmitted: true, reason: `${name}: ${matched}` };
      }
    }
  }
  return { isAutoSubmitted: false, reason: null };
}

const TICKET_REF = /\bZV1-\d{4,}\b/i;

/**
 * Finds a ticket ref like 'ZV1-0042' anywhere in the subject (with or without
 * brackets) and returns it uppercased, or null if absent.
 */
export function extractTicketRef(subject: string | null): string | null {
  if (subject === null) {
    return null;
  }
  const match = TICKET_REF.exec(subject);
  return match ? match[0].toUpperCase() : null;
}
