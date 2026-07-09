# Zendori v1 — Multi-Channel Ticket Bridge (Strong Energy)

Eigenständige Intake-Bridge: Anfragen aus Kontaktformular, E-Mail, Paste-Inbox (Phase 1) sowie Telefon und WhatsApp (Phase 2) laufen zentral ein, werden per KI in strukturierte Tickets umgewandelt, auf Duplikate geprüft und im HubSpot des Kunden angelegt. Betreiber: Novax Digital GmbH. Projektregeln und Architektur: [CLAUDE.md](CLAUDE.md), [docs/architektur.md](docs/architektur.md), Entscheidungen: [docs/entscheidungen.md](docs/entscheidungen.md).

> **Status: Phase 0 (Fundament).** Es sind noch keine Kanäle angebunden; die Migration `supabase/migrations/0001_initial_schema.sql` wartet auf Review und wurde noch nicht ausgeführt.

## Struktur

| Pfad                  | Inhalt                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `apps/web`            | Next.js 16 (App Router): Dashboard, Login (Supabase Auth), Job-Runner, Cron-Sweeper, später Ingest-Webhooks |
| `packages/core`       | Geteilte Contracts: Types, `TicketSink`-Interface, Job-Queue-Definitionen, Env-Parsing, Logger, Crypto      |
| `supabase/migrations` | Versionierte SQL-Migrationen (werden vor Ausführung reviewt)                                                |
| `docs/`               | Architektur, Entscheidungslog, Stack-Verifikation                                                           |

## Setup (lokal)

Voraussetzungen: Node ≥ 22.12 und pnpm. pnpm ohne Installation nutzbar via `corepack pnpm …`; dauerhaft: `sudo corepack enable pnpm` oder `curl -fsSL https://get.pnpm.io/install.sh | sh -`.

```sh
pnpm install
cp .env.example .env        # Werte eintragen (siehe ENV-Referenz unten)

# Web-Dashboard (http://localhost:3000) — baut @zendori/core automatisch mit
pnpm --filter @zendori/web build
pnpm --filter @zendori/web dev
```

Qualität: `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm format:check`

## ENV-Referenz

Vollständig kommentiert in [.env.example](.env.example). Wichtigste Regeln:

- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`: Publishable Key für die Web-App. `SUPABASE_SERVICE_ROLE_KEY` (Secret Key) wird **nur** serverseitig genutzt (Job-Runner, Cron, später Ingest/Sink) und erreicht nie den Browser.
- `CRON_SECRET`: sichert die Cron-Endpoints ab — Vercel sendet ihn automatisch als `Authorization: Bearer …`.
- `ENCRYPTION_KEY`: 32 Byte hex (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Verschlüsselt Postfach-Credentials at rest.
- `DATABASE_URL`: nur für Migrationen via psql (Session-Pooler Port 5432 oder Direct Connection).
- Postfach-Zugänge stehen **nicht** in der ENV — sie werden verschlüsselt in der DB verwaltet (ab Phase 1 über die Settings-UI).

## Migrationen

Migrationen liegen in `supabase/migrations/` und werden erst nach Review ausgeführt — manuell über den Supabase-SQL-Editor oder `psql "$DATABASE_URL" -f supabase/migrations/0001_initial_schema.sql`.

## Deployment (Vercel)

1. Repo bei Vercel importieren, **Root Directory: `apps/web`** (Standard-Einstellung „Include source files outside of the Root Directory" muss aktiv bleiben, damit `packages/core` verfügbar ist).
2. **Vercel Pro** verwenden — der minütliche Sweeper-Cron läuft auf Hobby nicht (dort nur tägliche Crons), und die kommerzielle Nutzung/DPA setzt Pro ohnehin voraus.
3. Alle ENV-Variablen aus `.env.example` in den Projekt-Settings hinterlegen (insb. `CRON_SECRET`).
4. Domain `strongenergy.zendori.ai` per CNAME auf Vercel zeigen lassen und im Projekt hinterlegen.
5. Function-Region ist per `apps/web/vercel.json` auf Frankfurt (`fra1`) gepinnt; der Cron `/api/cron/sweep` (minütlich, UTC) ist dort ebenfalls definiert. Hinweis: Routing-Middleware (`proxy.ts`) und CDN laufen global — Compute/Daten liegen in fra1/EU.
6. Optional: Projekt-ENV `ENABLE_EXPERIMENTAL_COREPACK=1`, damit Vercel exakt die pnpm-Version aus `packageManager` nutzt (sonst wählt Vercel anhand der Lockfile-Version).

## Backup & Datenschutz (Kurzfassung)

- Postgres-Backups übernimmt Supabase (Plan-abhängig).
- Subprozessor-Kette für den AVV (Novax ↔ Strong Energy): **Vercel** (DPA: vercel.com/legal/dpa; Functions in fra1, CDN global), Supabase (EU), Anthropic; ab Phase 2 Twilio, Vapi, ElevenLabs, Deepgram.
- Löschfristen sind in `app_settings` konfiguriert (Default: Rohnachrichten 90 Tage, Recordings 30 Tage); der tägliche Lösch-Job kommt in Phase 1.5.

## Übergabe-Checkliste (wächst pro Phase)

- [ ] HubSpot-Token hinterlegt, Pipeline/Stage in den Einstellungen gewählt
- [ ] Postfächer angelegt und „Verbindung testen" grün
- [ ] Formular-API-Keys erzeugt und Website angebunden
- [ ] Auto-Reply-Texte geprüft
- [ ] (Phase 2) Twilio-Nummer, Vapi-Assistant, WhatsApp-Sender dokumentiert
