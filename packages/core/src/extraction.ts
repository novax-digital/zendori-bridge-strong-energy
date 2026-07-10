import Anthropic from '@anthropic-ai/sdk';

import {
  buildCategorySection,
  buildExtractionUserPrompt,
  EXTRACTION_SYSTEM_PROMPT,
} from './prompts/extraction.js';
import {
  buildTicketJsonSchema,
  ticketExtractionSchema,
  type TicketExtraction,
} from './ticket-schema.js';

/**
 * Ticket extraction via Anthropic structured outputs (CLAUDE.md §7).
 * - output_config.format guarantees schema-conformant JSON (GA, no beta header)
 * - result is re-validated with Zod (defense in depth, incl. length limits)
 * - temperature 0 ONLY on Haiku — Sonnet 5 rejects non-default sampling params
 * - system prompt carries cache_control (note: Haiku 4.5 only caches prefixes
 *   >= 4096 tokens; below that the request is simply uncached, never wrong)
 * - low confidence escalates to the stronger model (both ENV-overridable)
 */

export interface ExtractionInput {
  channel: string;
  senderName: string | null;
  senderEmail: string | null;
  senderPhone: string | null;
  subject: string | null;
  bodyText: string;
  receivedAt: string;
  /** Optional operator note (paste inbox context field). */
  contextNote?: string | null;
}

export interface ExtractionSettings {
  categories: readonly string[];
  /** Below this confidence the escalation model is consulted. */
  escalationThreshold: number;
  modelExtract: string;
  modelEscalation: string;
}

export interface ExtractionRun {
  data: TicketExtraction;
  model: string;
  tokensIn: number;
  tokensOut: number;
  escalated: boolean;
}

/** Thrown when the response cannot be used; job retry/backoff handles it. */
export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ExtractionError';
  }
}

export async function extractTicket(
  client: Anthropic,
  input: ExtractionInput,
  settings: ExtractionSettings,
): Promise<ExtractionRun> {
  const primary = await runModel(client, settings.modelExtract, input, settings);

  if (primary.data.extraction.confidence >= settings.escalationThreshold) {
    return primary;
  }

  // Low confidence: consult the stronger model; if it fails, the primary
  // result is still better than blocking the pipeline.
  try {
    const escalated = await runModel(client, settings.modelEscalation, input, settings);
    return {
      ...escalated,
      tokensIn: primary.tokensIn + escalated.tokensIn,
      tokensOut: primary.tokensOut + escalated.tokensOut,
      escalated: true,
    };
  } catch {
    return primary;
  }
}

async function runModel(
  client: Anthropic,
  model: string,
  input: ExtractionInput,
  settings: ExtractionSettings,
): Promise<ExtractionRun> {
  const isHaiku = model.includes('haiku');

  // Cap the input defensively (e-mail bodies are not length-limited at
  // ingest); 30k chars keep prompts well inside the context window.
  const bodyText =
    input.bodyText.length > 30_000
      ? `${input.bodyText.slice(0, 30_000)}\n[… gekürzt]`
      : input.bodyText;

  const response = await client.messages.create({
    model,
    // Room for a full 20k-char description in the JSON output (schema limit).
    max_tokens: 16_000,
    // Sonnet 5 / Opus 4.7+ return 400 for non-default sampling params.
    ...(isHaiku ? { temperature: 0 } : {}),
    system: [
      {
        type: 'text',
        text: EXTRACTION_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
      { type: 'text', text: buildCategorySection(settings.categories) },
    ],
    messages: [{ role: 'user', content: buildExtractionUserPrompt({ ...input, bodyText }) }],
    output_config: {
      format: {
        type: 'json_schema',
        schema: buildTicketJsonSchema(settings.categories),
      },
    },
  });

  if (response.stop_reason !== 'end_turn') {
    // refusal / max_tokens etc. — the JSON may not conform to the schema.
    throw new ExtractionError(`extraction stopped with stop_reason=${response.stop_reason}`);
  }

  const text = response.content.find((block) => block.type === 'text')?.text;
  if (!text) {
    throw new ExtractionError('extraction response contained no text block');
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    throw new ExtractionError('extraction response was not valid JSON');
  }

  const validated = ticketExtractionSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new ExtractionError(
      'extraction response failed Zod validation',
      validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }

  return {
    data: validated.data,
    model,
    tokensIn: response.usage.input_tokens,
    tokensOut: response.usage.output_tokens,
    escalated: false,
  };
}
