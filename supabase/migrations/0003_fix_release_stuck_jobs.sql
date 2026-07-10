-- ============================================================================
-- Zendori v1 — Migration 0003: hotfix release_stuck_jobs enum casts
--
-- The CASE expression unified its branches to text, so the assignment to
-- jobs.status (enum job_status) failed on every call — which blocked the
-- ENTIRE job runner (release runs first). Explicit casts fix it.
-- Applied to production on 2026-07-10.
-- ============================================================================

begin;

create or replace function public.release_stuck_jobs(lease_seconds integer default 300)
returns integer
language plpgsql
volatile
as $$
declare
  released integer;
begin
  with released_jobs as (
    update public.jobs
    set status = case
          when attempts >= max_attempts then 'dead'::public.job_status
          else 'failed'::public.job_status
        end,
        run_after = now() + public.job_retry_delay(attempts),
        last_error = coalesce(last_error, 'lease expired (function crash or timeout)'),
        claimed_at = null,
        updated_at = now()
    where status = 'processing'
      and claimed_at < now() - make_interval(secs => lease_seconds)
    returning id, message_id, step, status
  ),
  mark_messages_failed as (
    update public.inbound_messages m
    set status = 'failed'::public.message_status,
        error = 'job "' || r.step || '" dead after lease expiry'
    from released_jobs r
    where r.status = 'dead'::public.job_status
      and m.id = r.message_id
      -- never downgrade terminal successes (e.g. a dead confirm job after
      -- the ticket already exists)
      and m.status not in ('ticket_created', 'attached_to_existing', 'spam')
    returning m.id
  )
  select count(*) into released from released_jobs;
  return released;
end;
$$;

commit;
