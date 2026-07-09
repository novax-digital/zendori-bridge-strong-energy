import { pino, type Logger } from 'pino';

/**
 * Structured logging (CLAUDE.md §13): pino with a correlation ID per message
 * and PII masking (§12). Redaction is DEFENSE IN DEPTH, not a guarantee:
 * pino's `*` wildcard matches exactly one path segment, so the paths below
 * cover sensitive keys up to three levels deep. Handlers must still log
 * explicitly picked fields — never whole raw channel payloads or DB rows.
 */

const SENSITIVE_KEYS = [
  // secrets
  'password',
  'secret',
  'token',
  'authToken',
  'apiKey',
  // PII
  'email',
  'phone',
  'senderEmail',
  'senderPhone',
  'senderName',
];

const PII_AND_SECRET_PATHS = SENSITIVE_KEYS.flatMap((key) => [
  key,
  `*.${key}`,
  `*.*.${key}`,
  `*.*.*.${key}`,
]);

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
