import { randomUUID } from 'node:crypto';

import { createLogger } from '@zendori/core';

import { audit, getAppSettings, insertInboundMessage } from '@/lib/db';
import { enqueueJob, kickJobRunnerAfterResponse } from '@/lib/jobs/enqueue';
import { hashFormApiKey } from '@/lib/security/api-keys';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Form ingest endpoint (§10.1): authenticated via per-site API key
 * (header `x-zendori-key`), honeypot, per-IP rate limit, CORS restricted to
 * the origins stored on the key. The payload is deliberately free-form —
 * field mapping is done by the AI extraction step, so any existing form can
 * post here without mapping maintenance.
 */

const MAX_BODY_CHARS = 50_000;

const log = createLogger({ name: 'ingest.form' });

interface FormApiKeyRow {
  id: string;
  site_label: string;
  allowed_origins: string[];
}

function jsonError(
  status: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json({ error: message }, { status, headers });
}

/** Readable German-facing serialization of the free-form payload for extraction. */
function payloadToBodyText(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'website' || key === 'request_id') continue;
    const rendered =
      typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value);
    lines.push(`${key}: ${rendered}`);
  }
  return lines.join('\n');
}

export async function POST(request: Request): Promise<Response> {
  // Kept outside try so the catch-all 500 also carries the CORS header once
  // the origin check has passed (browser fetch could not read it otherwise).
  let corsHeaders: Record<string, string> = {};

  try {
    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_CHARS) {
      return jsonError(413, 'Anfrage zu groß (maximal 50000 Zeichen).');
    }

    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('not a plain object');
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      return jsonError(400, 'Ungültiger Anfrage-Body: JSON-Objekt erwartet.');
    }

    const requestId = payload['request_id'];
    if (requestId !== undefined && typeof requestId !== 'string') {
      return jsonError(400, 'Feld "request_id" muss eine Zeichenkette sein.');
    }

    // Honeypot (§10.1): bots fill the hidden 'website' field — silent drop,
    // indistinguishable from success so the bot learns nothing.
    const honeypot = payload['website'];
    if (typeof honeypot === 'string' && honeypot.length > 0) {
      return Response.json({ status: 'angenommen' }, { status: 202 });
    }

    const apiKey = request.headers.get('x-zendori-key');
    if (!apiKey) {
      return jsonError(401, 'Ungültiger oder fehlender API-Schlüssel.');
    }

    const supabase = createAdminClient();
    const { data: keyData, error: keyError } = await supabase
      .from('form_api_keys')
      .select('id, site_label, allowed_origins')
      .eq('key_hash', hashFormApiKey(apiKey))
      .eq('active', true)
      .maybeSingle();
    if (keyError) {
      throw new Error(`form_api_keys lookup failed: ${keyError.message}`);
    }
    if (!keyData) {
      return jsonError(401, 'Ungültiger oder fehlender API-Schlüssel.');
    }
    const keyRow = keyData as FormApiKeyRow;

    const origin = request.headers.get('origin');
    if (origin && keyRow.allowed_origins.length > 0 && !keyRow.allowed_origins.includes(origin)) {
      return jsonError(403, 'Origin nicht erlaubt.');
    }
    if (origin) {
      corsHeaders = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    }

    const settings = await getAppSettings(supabase);
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const { data: rateCount, error: rateError } = await supabase.rpc('bump_rate_limit', {
      p_key: `form:${ip}`,
      p_window_seconds: 60,
    });
    if (rateError) {
      throw new Error(`bump_rate_limit failed: ${rateError.message}`);
    }
    if ((rateCount as number) > settings.form_rate_limit_per_minute) {
      return jsonError(
        429,
        'Zu viele Anfragen. Bitte versuchen Sie es in einer Minute erneut.',
        corsHeaders,
      );
    }

    // request_id makes snippet retries idempotent via unique (channel, external_id);
    // prefixing the key id scopes it per site.
    const externalId = requestId ? `${keyRow.id}:${requestId}` : randomUUID();

    const subjectField = payload['subject'] ?? payload['betreff'];
    const subject =
      typeof subjectField === 'string' && subjectField.trim() !== ''
        ? subjectField
        : `Kontaktformular: ${keyRow.site_label}`;

    // Sender fields stay null — the extraction step fills contact data (§7).
    const result = await insertInboundMessage(
      {
        channel: 'form',
        externalId,
        subject,
        bodyText: payloadToBodyText(payload),
        raw: { payload, site_label: keyRow.site_label, origin },
        receivedAt: new Date().toISOString(),
      },
      supabase,
    );

    if (!result.inserted) {
      return Response.json(
        { status: 'bereits_verarbeitet' },
        { status: 202, headers: corsHeaders },
      );
    }

    const { message } = result;
    await enqueueJob('extract', message.id, message.correlation_id, supabase);
    kickJobRunnerAfterResponse();
    await audit(
      {
        actorType: 'system',
        action: 'form_received',
        entity: 'inbound_message',
        entityId: message.id,
        payload: { site: keyRow.site_label },
      },
      supabase,
    );

    log.info(
      { correlationId: message.correlation_id, site: keyRow.site_label },
      'form message accepted',
    );
    return Response.json(
      { status: 'angenommen', correlation_id: message.correlation_id },
      { status: 202, headers: corsHeaders },
    );
  } catch (error) {
    // Never log payload contents (PII) — only the technical error.
    const message = error instanceof Error ? error.message : String(error);
    log.error({ err: message }, 'form ingest failed');
    return jsonError(500, 'Interner Fehler. Bitte versuchen Sie es später erneut.', corsHeaders);
  }
}

/**
 * CORS preflight. The browser sends no custom headers here, so the key is
 * unknown — the origin is checked against ALL active keys instead. A key with
 * an empty allowed_origins list allows any origin (mirrors the POST check).
 */
export async function OPTIONS(request: Request): Promise<Response> {
  const origin = request.headers.get('origin');
  if (!origin) {
    return new Response(null, { status: 204 });
  }

  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from('form_api_keys')
      .select('allowed_origins')
      .eq('active', true);
    if (error) {
      throw new Error(`form_api_keys lookup failed: ${error.message}`);
    }

    const allowed = ((data ?? []) as Pick<FormApiKeyRow, 'allowed_origins'>[]).some(
      (row) => row.allowed_origins.length === 0 || row.allowed_origins.includes(origin),
    );
    if (!allowed) {
      return new Response(null, { status: 204 });
    }

    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type, x-zendori-key',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ err: message }, 'form preflight failed');
    return new Response(null, { status: 204 });
  }
}

export const dynamic = 'force-dynamic';
