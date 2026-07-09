# Architektur — Stand Phase 0

Kurzreferenz zur Umsetzung von CLAUDE.md §5. Diese Doku wächst pro Phase; hier steht, was das Fundament bereits festlegt.

## Überblick

```
Kanal-Adapter (apps/web Route Handlers, apps/worker IMAP)   Phase 1+
        │  normalisieren auf InboundMessage (packages/core)
        ▼
inbound_messages (Postgres, Supabase)  ── unique (channel, external_id) = Idempotenz
        │  enqueue pipeline.extract
        ▼
pg-boss v12 (Schema "pgboss", gleiche DB)
  pipeline.extract → pipeline.contact-upsert → pipeline.dedup-check
      → pipeline.deliver (create-ticket ODER attach-note) → pipeline.confirm
  · jede Queue: retryLimit 5, exponentieller Backoff, eigene Dead-Letter-Queue (*.dlq)
  · Payload nur { messageId, correlationId } — Zustand liegt in der DB, nie im Job
        ▼
TicketSink-Interface (packages/core/src/sink.ts)
  v1: HubSpotSink (Phase 1) · später: ZendoriSink — Pipeline bleibt unberührt
```

## Festgelegte Verträge (Phase 0)

- **`InboundMessage`** (`packages/core/src/types.ts`): das eine Normalform-Objekt, das jeder Adapter produziert. Enums sind 1:1 Spiegel der Postgres-Enums aus Migration 0001 — Änderungen immer an beiden Stellen.
- **`TicketSink`** (`packages/core/src/sink.ts`): `upsertContact`, `createTicket` (idempotent über `ticketRef`), `attachNote`, `findTicketByRef`, `healthCheck`. HubSpot-Details bleiben vollständig hinter diesem Interface.
- **Queue-Topologie** (`packages/core/src/queues.ts` + `apps/worker/src/queues.ts`): fünf Pipeline-Queues + je eine DLQ. DLQ-Handler loggen laut; ab Phase 1 setzen sie `status = failed` am Message-Row und lösen den Dashboard-Alarm aus („niemals stiller Verlust").
- **Correlation-ID**: entsteht bei der Normalisierung, liegt als Spalte auf `inbound_messages`, wandert in jedem Job-Payload mit und hängt via `withCorrelation()` an jeder Log-Zeile.
- **Secrets at rest**: AES-256-GCM (`packages/core/src/crypto.ts`), versioniertes Format `v1.<iv>.<tag>.<ct>`, Key aus `ENCRYPTION_KEY`. Postfach-Credentials landen ausschließlich verschlüsselt in `mailboxes.secret_encrypted`; die Spalte ist für Dashboard-Nutzer nicht lesbar (Column-Grant in Migration 0001).
- **PII in Logs**: pino-Redaction maskiert E-Mail/Telefon/Namen und alle secret-artigen Felder (`packages/core/src/logger.ts`).

## Sicherheits-/Zugriffsmodell

| Komponente                 | Supabase-Key         | RLS                                                                      |
| -------------------------- | -------------------- | ------------------------------------------------------------------------ |
| `apps/web` (Dashboard)     | Publishable/Anon-Key | greift — `authenticated` darf lesen, Schreib-Policies kommen pro Feature |
| `apps/worker`              | Secret/Service-Key   | bypass — alle Pipeline-Writes laufen hier                                |
| `anon` (unauthentifiziert) | —                    | keine Policies → kein Zugriff                                            |

Auth: Supabase Auth, invite-only (Self-Signup deaktiviert, Einladung über Admin-API). Session-Refresh + Auth-Gate in `apps/web/proxy.ts` über `supabase.auth.getClaims()` (validiert die JWT-Signatur; `getSession()` wird bewusst nicht verwendet).

## Infrastruktur

- **DB-Verbindung Worker:** Supavisor **Session**-Pooler (Port 5432) oder Direct Connection. Transaction-Pooler (6543) ist mit pg-boss inkompatibel und wird von der Env-Validierung abgelehnt.
- **Deployment:** zwei Container (`web`, `worker`) via Docker Compose hinter bestehendem Traefik; Healthchecks in beiden Images; Worker ohne Ingress.
- **pgboss-Schema:** wird vom Worker selbst angelegt/migriert — bewusst nicht Teil unserer versionierten Migrationen.

## Bewusste Phase-0-Grenzen

- Pipeline-Handler sind Stubs (loggen nur) — Implementierung in Phase 1.
- Kein Ingest-Endpoint, kein HubSpot-Client, keine KI-Calls — Phase 1.
- Dashboard zeigt einen leeren Posteingang-Platzhalter hinter Login.
- Migration 0001 ist geschrieben, aber **nicht ausgeführt** (Review-Gate).
