# Zendori v1 — Multi-Channel Ticket Bridge (Strong Energy)

Eigenständige Intake-Bridge: Anfragen aus Kontaktformular, E-Mail, Paste-Inbox (Phase 1) sowie Telefon und WhatsApp (Phase 2) laufen zentral ein, werden per KI in strukturierte Tickets umgewandelt, auf Duplikate geprüft und im HubSpot des Kunden angelegt. Betreiber: Novax Digital GmbH. Projektregeln und Architektur: [CLAUDE.md](CLAUDE.md), [docs/architektur.md](docs/architektur.md), Entscheidungen: [docs/entscheidungen.md](docs/entscheidungen.md).

> **Status: Phase 0 (Fundament).** Es sind noch keine Kanäle angebunden; die Migration `supabase/migrations/0001_initial_schema.sql` wartet auf Review und wurde noch nicht ausgeführt.

## Struktur

| Pfad                  | Inhalt                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `apps/web`            | Next.js 16 (App Router): Dashboard, Login (Supabase Auth), später alle Ingest-Webhooks             |
| `apps/worker`         | Node-22-Prozess: pg-boss-Pipeline, später IMAP-Ingest                                              |
| `packages/core`       | Geteilte Contracts: Types, `TicketSink`-Interface, Queue-Definitionen, Env-Parsing, Logger, Crypto |
| `supabase/migrations` | Versionierte SQL-Migrationen (werden vor Ausführung reviewt)                                       |
| `docs/`               | Architektur, Entscheidungslog, Stack-Verifikation                                                  |

## Setup (lokal)

Voraussetzungen: Node ≥ 22.12 und pnpm. pnpm ohne Installation nutzbar via `corepack pnpm …`; dauerhaft: `sudo corepack enable pnpm` oder `curl -fsSL https://get.pnpm.io/install.sh | sh -`.

```sh
pnpm install
cp .env.example .env        # Werte eintragen (siehe ENV-Referenz unten)
pnpm --filter @zendori/core build

# Web-Dashboard (http://localhost:3000)
pnpm --filter @zendori/web dev

# Worker (braucht DATABASE_URL + ENCRYPTION_KEY in .env)
pnpm --filter @zendori/worker dev
```

Qualität: `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm format:check`

## ENV-Referenz

Vollständig kommentiert in [.env.example](.env.example). Wichtigste Regeln:

- `DATABASE_URL`: **Supavisor Session-Pooler** (Port 5432, Username `postgres.<project-ref>`) oder Direct Connection. Niemals den Transaction-Pooler (Port 6543) — inkompatibel mit pg-boss; die Env-Validierung lehnt ihn ab.
- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`: für die Web-App (Publishable Key). `SUPABASE_SERVICE_ROLE_KEY` (Secret Key) wird **nur** vom Worker genutzt und niemals in der Web-App.
- `ENCRYPTION_KEY`: 32 Byte hex (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Verschlüsselt Postfach-Credentials at rest.
- Postfach-Zugänge stehen **nicht** in der ENV — sie werden verschlüsselt in der DB verwaltet (ab Phase 1 über die Settings-UI).

## Migrationen

Migrationen liegen in `supabase/migrations/` und werden erst nach Review ausgeführt — manuell über den Supabase-SQL-Editor oder `psql "$DATABASE_URL" -f supabase/migrations/0001_initial_schema.sql`. Das `pgboss`-Schema legt der Worker beim ersten Start selbst an und migriert es selbstständig.

## Deployment (Hetzner, Docker Compose hinter Traefik)

```sh
cp .env.example .env   # produktive Werte
docker compose build
docker compose up -d
```

- Web ist über Traefik unter `https://strongenergy.zendori.ai` erreichbar (`BRIDGE_HOST`, `TRAEFIK_NETWORK`, `TRAEFIK_CERTRESOLVER` in `.env` anpassbar; Default-Netzwerk `traefik` muss existieren).
- Der Worker hat keinen Ingress; Healthcheck läuft containerintern gegen `:8081/healthz`.
- Healthchecks: `GET /healthz` (web, öffentlich) und `GET :8081/healthz` (worker, intern — meldet pg-boss-Status und ab Phase 1 die letzte IMAP-Poll-Zeit pro Postfach).

## Backup & Datenschutz (Kurzfassung)

- Postgres-Backups übernimmt Supabase (Plan-abhängig); zusätzlich empfohlen: regelmäßiger `pg_dump` vom Hetzner-Host.
- Subprozessor-Kette für den AVV (Novax ↔ Strong Energy): Supabase (EU), Anthropic, ab Phase 2 Twilio, Vapi, ElevenLabs, Deepgram. Details folgen mit den jeweiligen Phasen.
- Löschfristen sind in `app_settings` konfiguriert (Default: Rohnachrichten 90 Tage, Recordings 30 Tage); der tägliche Lösch-Job kommt in Phase 1.5.

## Übergabe-Checkliste (wächst pro Phase)

- [ ] HubSpot-Token hinterlegt, Pipeline/Stage in den Einstellungen gewählt
- [ ] Postfächer angelegt und „Verbindung testen" grün
- [ ] Formular-API-Keys erzeugt und Website angebunden
- [ ] Auto-Reply-Texte geprüft
- [ ] (Phase 2) Twilio-Nummer, Vapi-Assistant, WhatsApp-Sender dokumentiert
