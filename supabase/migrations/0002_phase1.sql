-- ============================================================================
-- Zendori v1 — Migration 0002: Phase-1 additions
--
-- STATUS: DRAFT — awaiting review, apply together with 0001 (in order).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- rate_limits — fixed-window per-key counters for ingest endpoints (§10.1).
-- Serverless-friendly (no Redis): one upsert per request via bump_rate_limit().
-- Keys look like "form:<ip>"; windows are aligned to window_seconds.
-- ---------------------------------------------------------------------------
create table public.rate_limits (
  key text primary key,
  window_start timestamptz not null,
  count integer not null default 0
);

create function public.bump_rate_limit(p_key text, p_window_seconds integer)
returns integer
language plpgsql
volatile
as $$
declare
  v_window_start timestamptz :=
    to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_count integer;
begin
  insert into public.rate_limits as rl (key, window_start, count)
  values (p_key, v_window_start, 1)
  on conflict (key) do update
    set count = case when rl.window_start = v_window_start then rl.count + 1 else 1 end,
        window_start = v_window_start
  returning count into v_count;
  return v_count;
end;
$$;

revoke execute on function public.bump_rate_limit(text, integer) from public, anon, authenticated;

alter table public.rate_limits enable row level security;
-- no policies: server-only (secret key bypasses RLS)

-- ---------------------------------------------------------------------------
-- mailboxes: IMAP UIDVALIDITY tracking — if the server resets it, all UIDs
-- are invalid and last_uid must restart (handled by the mail poller).
-- NOTE column grant: mailboxes has column-level SELECT grants (see 0001) —
-- new readable columns must be granted explicitly.
-- ---------------------------------------------------------------------------
alter table public.mailboxes add column imap_uidvalidity bigint;
grant select (imap_uidvalidity) on public.mailboxes to authenticated;

-- ---------------------------------------------------------------------------
-- Private storage bucket for e-mail attachments (§10.2). Served to the
-- dashboard via short-lived signed URLs only.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Phase-1 settings defaults
-- ---------------------------------------------------------------------------
insert into public.app_settings (key, value) values
  ('extraction_escalation_threshold', '0.7'::jsonb),
  ('attachment_max_mb', '10'::jsonb),
  ('form_rate_limit_per_minute', '30'::jsonb)
on conflict (key) do nothing;

commit;
