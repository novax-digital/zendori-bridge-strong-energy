-- ============================================================================
-- Zendori v1 — Migration 0004: statistics aggregate for the dashboard
-- (message volume per channel/status, tickets, AI token usage per model —
-- the basis for transactional customer billing).
-- Applied to production on 2026-07-10.
-- ============================================================================

begin;

create function public.get_statistics(from_ts timestamptz, to_ts timestamptz)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'messages_total', (
      select count(*) from public.inbound_messages
      where created_at >= from_ts and created_at < to_ts
    ),
    'by_channel', (
      select coalesce(
        jsonb_agg(jsonb_build_object('channel', channel, 'count', c) order by c desc), '[]'::jsonb
      )
      from (
        select channel, count(*) as c from public.inbound_messages
        where created_at >= from_ts and created_at < to_ts
        group by channel
      ) t
    ),
    'by_status', (
      select coalesce(
        jsonb_agg(jsonb_build_object('status', status, 'count', c) order by c desc), '[]'::jsonb
      )
      from (
        select status, count(*) as c from public.inbound_messages
        where created_at >= from_ts and created_at < to_ts
        group by status
      ) t
    ),
    'tickets_created', (
      select count(*) from public.tickets
      where created_at >= from_ts and created_at < to_ts
    ),
    'ai', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'model', model, 'calls', calls, 'tokens_in', ti, 'tokens_out', tou
          ) order by calls desc
        ), '[]'::jsonb
      )
      from (
        select model, count(*) as calls,
               coalesce(sum(tokens_in), 0) as ti,
               coalesce(sum(tokens_out), 0) as tou
        from public.extractions
        where created_at >= from_ts and created_at < to_ts
        group by model
      ) a
    )
  );
$$;

-- Invoker rights: authenticated dashboard users may aggregate what RLS lets
-- them read; anon gets nothing.
revoke execute on function public.get_statistics(timestamptz, timestamptz) from public, anon;

commit;
