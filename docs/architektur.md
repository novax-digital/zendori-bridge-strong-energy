# Architektur — Stand Phase 0 (Vercel-Variante)

Kurzreferenz zur Umsetzung von CLAUDE.md §5 nach Entscheidung D (alles auf Vercel, siehe `docs/entscheidungen.md`). Diese Doku wächst pro Phase; hier steht, was das Fundament bereits festlegt.

## Überblick

```
Kanal-Adapter (Route Handlers in apps/web; Mail-Poll-Cron)      Phase 1+
        │  normalisieren auf InboundMessage (packages/core)
        ▼
inbound_messages (Postgres, Supabase)  ── unique (channel, external_id) = Idempotenz
        │  Job-Row anlegen (Step "extract") + sofortiger Kick via after()
        ▼
jobs-Tabelle (Postgres, Supabase) — Steps:
  extract → contact_upsert → dedup_check → deliver (Ticket ODER Note) → confirm
  · Claiming atomar via claim_due_jobs() (FOR UPDATE SKIP LOCKED)
  · Retry: exponentieller Backoff (15s·2^n), max. 5 → Status "dead" (sichtbar!)
  · Sweeper-Cron (minütlich, /api/cron/sweep): fällige Retries, abgelaufene
    Leases (release_stuck_jobs), ab Phase 1 auch IMAP-Poll pro Postfach
  · Payload nur { messageId, correlationId } — Zustand liegt in der DB
        ▼
TicketSink-Interface (packages/core/src/sink.ts)
  v1: HubSpotSink (Phase 1) · später: ZendoriSink — Pipeline bleibt unberührt
```

Warum kein pg-boss mehr: Vercel hat keinen dauerlaufenden Prozess, pg-boss braucht einen Poller mit persistenter Verbindung. Die Jobs-Tabelle liefert dieselben Garantien (Postgres-basiert, kein Redis, Retry/Backoff/DLQ-Semantik) in serverless-tauglicher Form. Vercel-Crons sind best-effort und können doppelt feuern — das atomare Claiming macht Doppel-Invocations harmlos.

## Festgelegte Verträge (Phase 0)

- **`InboundMessage`** (`packages/core/src/types.ts`): das eine Normalform-Objekt, das jeder Adapter produziert. Enums sind 1:1 Spiegel der Postgres-Enums aus Migration 0001 — Änderungen immer an beiden Stellen.
- **`TicketSink`** (`packages/core/src/sink.ts`): `upsertContact`, `createTicket` (idempotent über `ticketRef`), `attachNote`, `findTicketByRef`, `healthCheck`. HubSpot-Details bleiben vollständig hinter diesem Interface.
- **Job-Queue** (`packages/core/src/jobs.ts` + `apps/web/lib/jobs/runner.ts` + SQL-Funktionen in Migration 0001): fünf Pipeline-Steps, Konstanten (max. 5 Versuche, 15-s-Basis-Backoff, 300-s-Lease) in TS und SQL gespiegelt. `dead`-Jobs enden laut; ab Phase 1 setzen sie `status = failed` am Message-Row und lösen den Dashboard-Alarm aus („niemals stiller Verlust").
- **Correlation-ID**: entsteht bei der Normalisierung, liegt als Spalte auf `inbound_messages` und `jobs` und hängt via `withCorrelation()` an jeder Log-Zeile.
- **Secrets at rest**: AES-256-GCM (`packages/core/src/crypto.ts`), versioniertes Format `v1.<iv>.<tag>.<ct>`, Key aus `ENCRYPTION_KEY`. Postfach-Credentials landen ausschließlich verschlüsselt in `mailboxes.secret_encrypted`; die Spalte ist für Dashboard-Nutzer nicht lesbar (Column-Grant in Migration 0001). **Konsequenz:** Dashboard-Queries auf `mailboxes` müssen Spalten explizit aufzählen — `select('*')` schlägt mit 42501 fehl; jede spätere `ADD COLUMN`-Migration braucht einen aktualisierten Column-Grant.
- **PII in Logs**: pino-Redaction maskiert E-Mail/Telefon/Namen und alle secret-artigen Felder (`packages/core/src/logger.ts`).

## Sicherheits-/Zugriffsmodell

| Kontext                              | Supabase-Key            | RLS                                                                      |
| ------------------------------------ | ----------------------- | ------------------------------------------------------------------------ |
| Dashboard (Pages, Server Components) | Publishable/Anon-Key    | greift — `authenticated` darf lesen, Schreib-Policies kommen pro Feature |
| Job-Runner / Cron / Ingest (Server)  | Secret-Key (`admin.ts`) | bypass — alle Pipeline-Writes laufen hier                                |
| `anon` (unauthentifiziert)           | —                       | keine Policies → kein Zugriff                                            |

- Auth: Supabase Auth, invite-only (Self-Signup deaktiviert, Einladung über Admin-API). Session-Refresh + Auth-Gate in `apps/web/proxy.ts` über `supabase.auth.getClaims()` (validiert die JWT-Signatur; `getSession()` wird bewusst nicht verwendet).
- `/api/*` ist vom Session-Gate ausgenommen — jede API-Route authentifiziert selbst (Cron: `CRON_SECRET`-Bearer; Phase 1: Form-API-Keys, Twilio-/Vapi-Signaturen).
- Die SQL-Funktionen der Job-Queue sind für `anon`/`authenticated` nicht ausführbar (explizite Revokes).

## Infrastruktur (Vercel + Supabase)

- **Functions:** Region fra1 (Frankfurt, `apps/web/vercel.json`), Fluid Compute, Default 300 s; Sweeper-Route mit `maxDuration = 60`.
- **Cron:** `/api/cron/sweep`, minütlich (UTC, GET, Bearer `CRON_SECRET`). **Erfordert Vercel Pro.** Best-effort-Zustellung — Idempotenz über atomares Claiming.
- **Sofort-Verarbeitung (Phase 1):** Ingest-Route legt Message + Job an und stößt den Runner via `after()` aus `next/server` an; der Cron ist nur Nachzügler-/Retry-Netz.
- **E-Mail:** IMAP-Polling im Sweeper (imapflow, Verbindung pro Lauf), kein IDLE → bis ~1 Min Latenz. Auto-Reply via Postfach-SMTP (Port 465/587 — von Vercel erlaubt, nur 25 ist blockiert), Versand innerhalb der Function-Laufzeit bzw. `after()`.
- **DSGVO:** Compute + Daten in fra1/EU (Supabase eu-central-1). Global bleiben: CDN (statische Assets) und Routing-Middleware (`proxy.ts` läuft in allen Regionen). Vercel steht als Subprozessor in der AVV-Kette (DPA: vercel.com/legal/dpa).
- **Monorepo-Build:** Vercel Root Directory = `apps/web`; der Web-Build-Script baut `@zendori/core` selbst mit (Vercel kompiliert Workspace-Dependencies nicht automatisch).

## Bewusste Phase-0-Grenzen

- Pipeline-Handler sind Stubs (loggen nur, markieren Jobs als erledigt) — Implementierung in Phase 1.
- Kein Ingest-Endpoint, kein HubSpot-Client, keine KI-Calls — Phase 1.
- Dashboard zeigt einen leeren Posteingang-Platzhalter hinter Login.
- Migration 0001 ist geschrieben, aber **nicht ausgeführt** (Review-Gate).
