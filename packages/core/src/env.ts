import { z } from 'zod';

/**
 * Server-side environment (Vercel Functions: job runner, cron sweeper, later
 * ingest + sink). Phase 0 only hard-requires what the foundation actually
 * uses; keys for later phases are optional and get tightened when their
 * feature lands. NEXT_PUBLIC_* values are handled by Next.js directly.
 */

const postgresUrl = z
  .string()
  .min(1)
  .refine((v) => v.startsWith('postgresql://') || v.startsWith('postgres://'), {
    message: 'DATABASE_URL must be a postgres:// or postgresql:// connection string',
  });

const hexKey32 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 32 bytes, hex-encoded (64 hex chars)');

export const serverEnvSchema = z.object({
  SUPABASE_URL: z
    .string()
    .min(1)
    .refine((v) => v.startsWith('https://'), { message: 'SUPABASE_URL must be an https URL' }),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ENCRYPTION_KEY: hexKey32,
  /** Shared secret Vercel sends as `Authorization: Bearer <CRON_SECRET>` on cron invocations. */
  CRON_SECRET: z.string().min(16, 'CRON_SECRET must be at least 16 characters'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /** Only used for migrations (psql), never at runtime. */
  DATABASE_URL: postgresUrl.optional(),

  // Required from Phase 1 on (extraction + sink) — tighten when implemented.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL_EXTRACT: z.string().default('claude-haiku-4-5'),
  ANTHROPIC_MODEL_ESCALATION: z.string().default('claude-sonnet-5'),
  HUBSPOT_TOKEN: z.string().optional(),
  HUBSPOT_PIPELINE_ID: z.string().optional(),
  HUBSPOT_STAGE_ID: z.string().optional(),
  ADMIN_ALERT_EMAIL: z.string().optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/** Parse process.env, failing fast with a readable list of problems (values are never logged). */
export function loadServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid server environment:\n${problems}`);
  }
  return result.data;
}
