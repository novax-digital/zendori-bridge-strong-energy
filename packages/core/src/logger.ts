import { pino, type Logger } from 'pino';

/**
 * Structured logging (CLAUDE.md §13): pino with a correlation ID per message
 * and PII masking (§12) — sender addresses/phone numbers and any secret-ish
 * fields never reach the log sink in clear text.
 */

const PII_AND_SECRET_PATHS = [
  // secrets
  'password',
  'secret',
  'token',
  'authToken',
  'apiKey',
  '*.password',
  '*.secret',
  '*.token',
  '*.authToken',
  '*.apiKey',
  // PII
  'email',
  'phone',
  'senderEmail',
  'senderPhone',
  'senderName',
  '*.email',
  '*.phone',
  '*.senderEmail',
  '*.senderPhone',
  '*.senderName',
];

export interface CreateLoggerOptions {
  /** Service name, e.g. "worker" or "web". */
  name: string;
  level?: string;
}

export function createLogger({ name, level }: CreateLoggerOptions): Logger {
  return pino({
    name,
    level: level ?? process.env.LOG_LEVEL ?? 'info',
    redact: { paths: PII_AND_SECRET_PATHS, censor: '[redacted]' },
  });
}

/** Child logger carrying the message's correlation ID through every log line. */
export function withCorrelation(logger: Logger, correlationId: string): Logger {
  return logger.child({ correlationId });
}

export type { Logger };
