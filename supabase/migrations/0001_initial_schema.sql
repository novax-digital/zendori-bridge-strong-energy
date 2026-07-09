-- ============================================================================
-- Zendori v1 — Migration 0001: initial schema (CLAUDE.md §6)
--
-- STATUS: DRAFT — awaiting review (CLAUDE.md rule: every migration is
-- presented as SQL before execution). Apply manually via Supabase SQL editor
-- or psql against the session-pooler/direct connection once approved.
--
-- Not covered here on purpose:
--   * pg-boss creates and migrates its own `pgboss` schema at worker startup.
--   * The Supabase Storage bucket for attachments ships with Phase 1.
--   * Supabase Auth users live in `auth.*` (invite-only via admin API).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Extensions (Supabase convention: shared `extensions` schema)
-- ---------------------------------------------------------------------------
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- Enums (mirrored in packages/core/src/types.ts — keep in sync)
-- ---------------------------------------------------------------------------
create type public.channel_type as enum ('form', 'email', 'phone', 'whatsapp', 'paste');

create type public.message_status as enum (
  'received',
  'extracted',
  'needs_info',
  'ticket_created',
  'attached_to_existing',
  'spam',
  'failed'
);

create type public.dedup_decision_type as enum ('new', 'duplicate', 'follow_up');

create type public.mailbox_auth_type as enum ('password', 'oauth2');

create type public.actor_type as enum ('user', 'system');

-- 'failed' = attempt failed, retry scheduled via run_after; 'dead' = retries exhausted
create type public.job_status as enum ('queued', 'processing', 'succeeded', 'failed', 'dead');

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Ticket references: ZV1-0001, ZV1-0002, ... — grows past 4 digits without
-- truncating (lpad alone would cut ZV1-12345 down to 4 chars).
create sequence public.ticket_ref_seq;

create function public.generate_ticket_ref()
returns text
language plpgsql
volatile
as $$
declare
  n bigint := nextval('public.ticket_ref_seq');
begin
  return 'ZV1-' || lpad(n::text, greatest(4, length(n::text)), '0');
end;
$$;

-- ---------------------------------------------------------------------------
-- inbound_messages — one row per normalized inbound message (§6)
-- ---------------------------------------------------------------------------
create table public.inbound_messages (
  id uuid primary key default gen_random_uuid(),
  channel public.channel_type not null,
  -- Channel-specific stable ID: mail Message-ID, Twilio SID, Vapi call ID, ...
  external_id text not null,
  sender_name text,
  sender_email text,
  sender_phone text,
  subject text,
  body_text text,
  body_html text,
  -- Array of attachment references (storage path, filename, content type, size)
  attachments jsonb not null default '[]'::jsonb,
  -- Raw channel payload, verbatim, for audit and reprocessing
  raw jsonb not null,
  received_at timestamptz not null,
  status public.message_status not null default 'received',
  error text,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  -- Idempotency: re-delivery of the same channel message is a no-op (§8 stage 1)
  constraint inbound_messages_channel_external_id_key unique (channel, external_id)
);

create index inbound_messages_status_idx on public.inbound_messages (status);
create index inbound_messages_created_at_idx on public.inbound_messages (created_at desc);
create index inbound_messages_sender_email_idx
  on public.inbound_messages (lower(sender_email))
  where sender_email is not null;
create index inbound_messages_sender_phone_idx
  on public.inbound_messages (sender_phone)
  where sender_phone is not null;

comment on table public.inbound_messages is
  'Normalized inbound messages from all channels; source of the processing pipeline.';

-- ---------------------------------------------------------------------------
-- extractions — AI extraction results per message (§6/§7)
-- ---------------------------------------------------------------------------
create table public.extractions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.inbound_messages (id) on delete cascade,
  model text not null,
  schema_version text not null,
  -- Ticket schema JSON (contact / ticket / meta) as returned by the model
  data jsonb not null,
  confidence numeric(4, 3) check (confidence >= 0 and confidence <= 1),
  missing_fields text[] not null default '{}',
  -- Max. 3 concrete follow-up questions generated for status `needs_info`
  questions jsonb not null default '[]'::jsonb,
  tokens_in integer,
  tokens_out integer,
  created_at timestamptz not null default now()
);

create index extractions_message_id_idx on public.extractions (message_id);

comment on table public.extractions is
  'AI extraction runs (ticket schema, confidence, open questions) per inbound message.';

-- ---------------------------------------------------------------------------
-- tickets — local mirror of tickets created in the sink (§6). HubSpot leads;
-- this mirror exists for dedup candidate search and dashboard links only.
-- ---------------------------------------------------------------------------
create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_ref text not null unique default public.generate_ticket_ref(),
  hubspot_ticket_id text unique,
  hubspot_contact_id text,
  subject text not null,
  -- Cleaned description kept locally for pg_trgm similarity (§8 stage 2)
  description text,
  category text not null,
  priority text not null,
  source_channel public.channel_type not null,
  -- ON DELETE SET NULL: the retention job (§12) deletes raw messages after
  -- 90 days; ticket mirror rows outlive them, losing only this pointer.
  first_message_id uuid references public.inbound_messages (id) on delete set null,
  created_at timestamptz not null default now()
);

create index tickets_created_at_idx on public.tickets (created_at desc);
-- Supports the SET NULL enforcement scan when the retention job deletes messages
create index tickets_first_message_id_idx on public.tickets (first_message_id);
create index tickets_subject_trgm_idx
  on public.tickets using gin (subject extensions.gin_trgm_ops);
create index tickets_description_trgm_idx
  on public.tickets using gin (description extensions.gin_trgm_ops);

comment on table public.tickets is
  'Mirror metadata of sink tickets (HubSpot is the source of truth).';

-- ---------------------------------------------------------------------------
-- contacts_cache — email/phone -> HubSpot contact ID (§6/§9)
-- ---------------------------------------------------------------------------
create table public.contacts_cache (
  id uuid primary key default gen_random_uuid(),
  -- Stored lowercased (check below) so the plain unique constraint works AND
  -- can be targeted by PostgREST upserts (onConflict: 'email') — a partial
  -- expression index on lower(email) could not. Normalization happens app-side.
  email text unique,
  -- Normalized app-side (E.164) before writing.
  phone text unique,
  hubspot_contact_id text not null,
  name text,
  last_synced_at timestamptz not null default now(),
  constraint contacts_cache_needs_identifier check (email is not null or phone is not null),
  constraint contacts_cache_email_lowercase check (email = lower(email))
);

-- ---------------------------------------------------------------------------
-- dedup_decisions — audit trail of the three-stage dedup (§6/§8)
-- ---------------------------------------------------------------------------
create table public.dedup_decisions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.inbound_messages (id) on delete cascade,
  candidate_ticket_ids uuid[] not null default '{}',
  decision public.dedup_decision_type not null,
  confidence numeric(4, 3) check (confidence >= 0 and confidence <= 1),
  reason text,
  model text,
  created_at timestamptz not null default now()
);

create index dedup_decisions_message_id_idx on public.dedup_decisions (message_id);

-- ---------------------------------------------------------------------------
-- mailboxes — IMAP/SMTP accounts, credentials encrypted at rest (§6/§10.2)
-- ---------------------------------------------------------------------------
create table public.mailboxes (
  id uuid primary key default gen_random_uuid(),
  label text not null unique,
  imap_host text not null,
  imap_port integer not null default 993,
  smtp_host text not null,
  smtp_port integer not null default 465,
  username text not null,
  -- AES-256-GCM, format "v1.<iv>.<tag>.<ciphertext>" (packages/core/src/crypto.ts)
  secret_encrypted text not null,
  auth_type public.mailbox_auth_type not null default 'password',
  auto_reply_enabled boolean not null default false,
  -- Not in the §6 field list, added deliberately: pause a mailbox without deleting it
  active boolean not null default true,
  last_poll_at timestamptz,
  last_uid bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger mailboxes_set_updated_at
  before update on public.mailboxes
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- form_api_keys — per-site API keys for the form ingest endpoint (§6/§10.1)
-- ---------------------------------------------------------------------------
create table public.form_api_keys (
  id uuid primary key default gen_random_uuid(),
  -- SHA-256 hex of the API key; the clear-text key is shown once on creation
  key_hash text not null unique,
  site_label text not null,
  allowed_origins text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- app_settings — key/value configuration (§6)
-- ---------------------------------------------------------------------------
create table public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create trigger app_settings_set_updated_at
  before update on public.app_settings
  for each row execute function public.set_updated_at();

insert into public.app_settings (key, value) values
  -- Placeholder until the client delivers their category list (docs/entscheidungen.md)
  ('ticket_categories', '["Frage", "Störung", "Reklamation", "Bestellung", "Sonstiges"]'::jsonb),
  ('dedup_window_days', '14'::jsonb),
  ('dedup_confidence_threshold', '0.8'::jsonb),
  ('retention_raw_messages_days', '90'::jsonb),
  ('retention_call_recordings_days', '30'::jsonb),
  ('hubspot_pipeline_id', 'null'::jsonb),
  ('hubspot_stage_id', 'null'::jsonb),
  ('auto_reply_template', '{"subject": "Ihre Anfrage ist eingegangen [{{ticket_ref}}]", "body": "Guten Tag,\n\nvielen Dank für Ihre Nachricht. Ihr Anliegen wurde unter der Referenz {{ticket_ref}} aufgenommen. Wir melden uns schnellstmöglich bei Ihnen.\n\nBitte lassen Sie die Referenz im Betreff stehen, wenn Sie auf diese E-Mail antworten.\n\nFreundliche Grüße\nStrong Energy"}'::jsonb);

-- ---------------------------------------------------------------------------
-- audit_log — every writing action, user or system (§6/§12)
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_type public.actor_type not null,
  -- auth.users id for dashboard users, worker/job name for system actions
  actor_id text,
  action text not null,
  entity text not null,
  entity_id text,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_created_at_idx on public.audit_log (created_at desc);
create index audit_log_entity_idx on public.audit_log (entity, entity_id);

-- ---------------------------------------------------------------------------
-- jobs — Postgres job queue (§5, Vercel variant; docs/entscheidungen.md D).
-- Claimed atomically via claim_due_jobs() (FOR UPDATE SKIP LOCKED) from
-- Vercel Functions; a minutely cron sweeper retries due jobs and releases
-- stuck leases. Constants mirrored in packages/core/src/jobs.ts.
-- ---------------------------------------------------------------------------
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  -- Pipeline step: extract | contact_upsert | dedup_check | deliver | confirm
  step text not null,
  message_id uuid not null references public.inbound_messages (id) on delete cascade,
  correlation_id uuid not null,
  status public.job_status not null default 'queued',
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  run_after timestamptz not null default now(),
  claimed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index jobs_due_idx on public.jobs (run_after)
  where status in ('queued', 'failed');
create index jobs_message_id_idx on public.jobs (message_id);
create index jobs_status_idx on public.jobs (status);

create trigger jobs_set_updated_at
  before update on public.jobs
  for each row execute function public.set_updated_at();

comment on table public.jobs is
  'Pipeline job queue, processed by Vercel Functions (immediate kick + cron sweeper).';

-- Exponential backoff: 15s, 30s, 60s, 120s, ... after the n-th attempt
create function public.job_retry_delay(attempt_count integer)
returns interval
language sql
immutable
as $$
  select make_interval(secs => 15 * power(2, greatest(attempt_count - 1, 0)));
$$;

-- Atomically claim due jobs (queued/failed with run_after reached).
-- Increments attempts and marks them processing; concurrent sweepers never
-- claim the same job thanks to FOR UPDATE SKIP LOCKED.
create function public.claim_due_jobs(batch_size integer default 10)
returns setof public.jobs
language sql
volatile
as $$
  update public.jobs j
  set status = 'processing',
      claimed_at = now(),
      attempts = j.attempts + 1,
      updated_at = now()
  where j.id in (
    select id
    from public.jobs
    where status in ('queued', 'failed')
      and run_after <= now()
    order by run_after
    limit batch_size
    for update skip locked
  )
  returning j.*;
$$;

-- Release jobs whose function crashed or timed out (lease expired): schedule
-- a retry with backoff, or mark dead when retries are exhausted.
create function public.release_stuck_jobs(lease_seconds integer default 300)
returns integer
language plpgsql
volatile
as $$
declare
  released integer;
begin
  update public.jobs
  set status = case when attempts >= max_attempts then 'dead' else 'failed' end,
      run_after = now() + public.job_retry_delay(attempts),
      last_error = coalesce(last_error, 'lease expired (function crash or timeout)'),
      claimed_at = null,
      updated_at = now()
  where status = 'processing'
    and claimed_at < now() - make_interval(secs => lease_seconds);
  get diagnostics released = row_count;
  return released;
end;
$$;

-- Job mutation is reserved for the server (service key). Functions are
-- executable by PUBLIC by default — revoke explicitly.
revoke execute on function public.claim_due_jobs(integer) from public, anon, authenticated;
revoke execute on function public.release_stuck_jobs(integer) from public, anon, authenticated;
revoke execute on function public.job_retry_delay(integer) from public, anon, authenticated;
revoke execute on function public.generate_ticket_ref() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security (§6/§12)
--
-- Model: the dashboard (authenticated users) may READ operational data;
-- ALL writes go through the worker/server using the secret key, which
-- bypasses RLS. `anon` has no policies -> no access. Write policies for
-- dashboard actions (reprocess, merge, mark as spam) ship with their
-- features in later migrations.
-- ---------------------------------------------------------------------------
alter table public.inbound_messages enable row level security;
alter table public.extractions enable row level security;
alter table public.tickets enable row level security;
alter table public.contacts_cache enable row level security;
alter table public.dedup_decisions enable row level security;
alter table public.mailboxes enable row level security;
alter table public.form_api_keys enable row level security;
alter table public.app_settings enable row level security;
alter table public.audit_log enable row level security;
alter table public.jobs enable row level security;

create policy "authenticated read" on public.inbound_messages
  for select to authenticated using (true);
create policy "authenticated read" on public.extractions
  for select to authenticated using (true);
create policy "authenticated read" on public.tickets
  for select to authenticated using (true);
create policy "authenticated read" on public.contacts_cache
  for select to authenticated using (true);
create policy "authenticated read" on public.dedup_decisions
  for select to authenticated using (true);
create policy "authenticated read" on public.mailboxes
  for select to authenticated using (true);
create policy "authenticated read" on public.form_api_keys
  for select to authenticated using (true);
create policy "authenticated read" on public.app_settings
  for select to authenticated using (true);
create policy "authenticated read" on public.audit_log
  for select to authenticated using (true);
create policy "authenticated read" on public.jobs
  for select to authenticated using (true);

-- Column-level hardening: dashboard users may list mailboxes but never read
-- the encrypted credential column (defense in depth on top of app-side crypto).
-- CONSEQUENCES for app code and future migrations:
--   * Dashboard queries on mailboxes MUST enumerate columns — a select('*')
--     (the supabase-js default!) fails with 42501 "permission denied".
--   * Every future ALTER TABLE mailboxes ADD COLUMN needs an updated
--     GRANT SELECT (...) in the same migration, or the column is unreadable.
revoke select on public.mailboxes from authenticated;
grant select (
  id, label, imap_host, imap_port, smtp_host, smtp_port, username,
  auth_type, auto_reply_enabled, active, last_poll_at, last_uid,
  created_at, updated_at
) on public.mailboxes to authenticated;

commit;
