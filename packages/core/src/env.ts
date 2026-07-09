import { z } from 'zod';

/**
 * Environment parsing for the worker (web uses Next.js env handling).
 * Phase 0 only hard-requires what the foundation actually uses; keys for
 * later phases are optional here and get tightened when their feature lands.
 */

const postgresUrl = z
  .string()
  .min(1)
  .refine((v) => v.startsWith('postgresql://') || v.startsWith('postgres://'), {
    message: 'DATABASE_URL must be a postgres:// or postgresql:// connection string',
  })
  .refine((v) => !v.includes(':6543'), {
    message:
      'DATABASE_URL points at the Supavisor transaction pooler (port 6543) — pg-boss needs the session pooler on port 5432 or a direct connection',
  });

const hexKey32 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 32 bytes, hex-encoded (64 hex chars)');

export const workerEnvSchema = z.object({
  DATABASE_URL: postgresUrl,
  ENCRYPTION_KEY: hexKey32,
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Required from Phase 1 on (extraction + sink) — tighten when implemented.
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL_EXTRACT: z.string().default('claude-haiku-4-5'),
  ANTHROPIC_MODEL_ESCALATION: z.string().default('claude-sonnet-5'),
  HUBSPOT_TOKEN: z.string().optional(),
  HUBSPOT_PIPELINE_ID: z.string().optional(),
  HUBSPOT_STAGE_ID: z.string().optional(),
  ADMIN_ALERT_EMAIL: z.string().optional(),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** Parse process.env, failing fast with a readable list of problems (values are never logged). */
export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const result = workerEnvSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid worker environment:\n${problems}`);
  }
  return result.data;
}
