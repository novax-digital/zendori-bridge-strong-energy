import { z } from 'zod';

/**
 * AI extraction ticket schema (CLAUDE.md §7) + extraction metadata (§6).
 * Two representations, deliberately kept side by side:
 *  - buildTicketJsonSchema(): the JSON Schema sent to the Anthropic API via
 *    output_config.format. API restrictions apply: additionalProperties:false
 *    everywhere, NO min/max/length constraints (they 400).
 *  - ticketExtractionSchema: the Zod schema for post-validation (defense in
 *    depth) — this is where length/range constraints live.
 * Keep both in sync when the schema evolves; bump SCHEMA_VERSION.
 */

export const SCHEMA_VERSION = '1';

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const ticketExtractionSchema = z.object({
  contact: z.object({
    name: z.string().max(200).nullable(),
    email: z.string().max(320).nullable(),
    phone: z.string().max(50).nullable(),
    company: z.string().max(200).nullable(),
  }),
  ticket: z.object({
    subject: z.string().min(1).max(80),
    description: z.string().min(1).max(20_000),
    category: z.string().min(1).max(100),
    priority: z.enum(TICKET_PRIORITIES),
    priority_reason: z.string().max(500),
    language: z.enum(['de', 'en', 'other']),
  }),
  meta: z.object({
    is_spam: z.boolean(),
    is_auto_reply: z.boolean(),
    summary: z.string().min(1).max(300),
  }),
  extraction: z.object({
    confidence: z.number().min(0).max(1),
    missing_fields: z.array(z.string().max(100)).max(10),
    questions: z.array(z.string().max(300)).max(3),
  }),
});

export type TicketExtraction = z.infer<typeof ticketExtractionSchema>;

/**
 * JSON Schema for the API. `categories` comes from app_settings at runtime;
 * keep the list stable between calls — every byte change recompiles the
 * server-side grammar (24h cache) and invalidates the prompt cache.
 */
export function buildTicketJsonSchema(categories: readonly string[]): Record<string, unknown> {
  const str = { type: 'string' };
  const nullableStr = { type: ['string', 'null'] };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['contact', 'ticket', 'meta', 'extraction'],
    properties: {
      contact: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'email', 'phone', 'company'],
        properties: {
          name: nullableStr,
          email: nullableStr,
          phone: nullableStr,
          company: nullableStr,
        },
      },
      ticket: {
        type: 'object',
        additionalProperties: false,
        required: ['subject', 'description', 'category', 'priority', 'priority_reason', 'language'],
        properties: {
          subject: str,
          description: str,
          category: { type: 'string', enum: [...categories] },
          priority: { type: 'string', enum: [...TICKET_PRIORITIES] },
          priority_reason: str,
          language: { type: 'string', enum: ['de', 'en', 'other'] },
        },
      },
      meta: {
        type: 'object',
        additionalProperties: false,
        required: ['is_spam', 'is_auto_reply', 'summary'],
        properties: {
          is_spam: { type: 'boolean' },
          is_auto_reply: { type: 'boolean' },
          summary: str,
        },
      },
      extraction: {
        type: 'object',
        additionalProperties: false,
        required: ['confidence', 'missing_fields', 'questions'],
        properties: {
          confidence: { type: 'number' },
          missing_fields: { type: 'array', items: str },
          questions: { type: 'array', items: str },
        },
      },
    },
  };
}

/** §7: at least one contact channel AND a describable request. */
export function hasRequiredTicketFields(extraction: TicketExtraction): boolean {
  const hasContactChannel = Boolean(extraction.contact.email) || Boolean(extraction.contact.phone);
  return hasContactChannel && extraction.ticket.description.trim().length > 0;
}
