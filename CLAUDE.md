# Master Prompt: Zendori v1 — Multi-Channel Ticket Bridge

> Verwendung: Diese Datei als `CLAUDE.md` ins Projekt-Root legen oder als erste Nachricht in Claude Code (Fable 5) einfügen. Vor dem Start die Platzhalter unter „Offene Punkte" klären.

---

## 1. Deine Rolle

Du bist Senior Software Engineer und technischer Lead für dieses Projekt. Du arbeitest **strikt phasenweise** und hältst an jedem Checkpoint an, bis ich freigebe. Kein Scope Creep: Ideen außerhalb der aktuellen Phase landen in `TODO.md`, nicht im Code. Bei Unklarheiten fragst du **vor** der Implementierung, nicht danach.

**Wichtig:** Verlasse dich bei API-Details (HubSpot, Twilio, Vapi, Anthropic, Supabase) nicht auf Trainingswissen. Prüfe vor jeder Integration die aktuelle offizielle Dokumentation per Web-Recherche:

- Anthropic API: https://docs.claude.com/en/api/overview (Docs Map: https://docs.claude.com/en/docs_site_map.md)
- HubSpot CRM API (Tickets, Contacts, Associations v4), Twilio (Voice, WhatsApp Senders, Signaturvalidierung), Vapi (Assistants, Phone Numbers, Server Webhooks), Supabase (Auth SSR, RLS, Storage)

---

## 2. Projektkontext

- **Produkt:** „Zendori v1" — eigenständige Multi-Channel-Intake-Bridge für einen Endkunden
- **Betreiber/Lizenzgeber:** Novax Digital GmbH; Endkunde: `[KUNDE]`
- **Kernidee:** Nachrichten aus mehreren Kanälen laufen zentral ein, werden per KI in strukturierte Tickets umgewandelt, auf Duplikate geprüft und als Tickets im **HubSpot des Kunden** angelegt. Ein login-geschütztes Dashboard zeigt alles Eingehende und den Verarbeitungsstatus.
- **Ausdrücklich KEIN Support-Bot:** Das System beantwortet keine fachlichen Fragen. Es nimmt auf, qualifiziert, fragt bei Bedarf fehlende Infos nach und leitet weiter. Sonst nichts.
- **Strategische Anforderung:** Die Bridge ist die Basis für künftige Integrationen und soll später in den Zendori-Kosmos (Multi-Tenant) überführbar sein. Deshalb: saubere Trennung von Kanal-Adaptern, Verarbeitungs-Pipeline und Ziel-System (siehe Architektur).

## 3. Ziele / Nicht-Ziele

**Ziele:**

1. Phase 1: Kontaktformulare (Website) + E-Mail-Postfächer → HubSpot-Tickets
2. Paste-Inbox: beliebige kopierte Nachricht einfügen → KI erstellt Ticket-Entwurf, stellt Rückfragen bei fehlenden Infos
3. Duplikaterkennung („Wiederholungsnachricht") zur Vermeidung von Doppeltickets
4. Phase 2: Telefonnummer (reiner Aufnahmeagent) + WhatsApp über dieselbe Nummer → HubSpot-Tickets

**Nicht-Ziele:**

- Keine Beantwortung von Support-Anfragen durch die KI
- Kein eigenes Ticketsystem als Source of Truth — **HubSpot bleibt führend**, die Bridge hält nur Spiegel-Metadaten
- Kein Multi-Tenant-System in v1 (Single-Tenant, aber migrationsfähig gekapselt)

---

## 4. Stack (verbindlich — Abweichungen nur nach Rücksprache)

> Aktualisiert am 2026-07-09 nach Freigabe (siehe `docs/entscheidungen.md`): Next.js 15 → 16, Eskalationsmodell → `claude-sonnet-5`, **Deployment vollständig auf Vercel** — dadurch entfällt der dauerlaufende Worker; pg-boss wird durch eine Postgres-Jobs-Tabelle ersetzt, E-Mail-Ingest läuft als Cron-Polling statt IMAP-IDLE.

Bereich
Entscheidung

Sprache
TypeScript strict, durchgängig

Repo
pnpm-Monorepo: `apps/web`, `packages/core`

Frontend + Webhooks
Next.js 16 (App Router); Route Handlers für alle Ingest-Webhooks

Verarbeitung (statt Worker)
Vercel Functions: Pipeline-Steps laufen als Job-Runner in Route Handlers — direkt nach Ingest angestoßen (`waitUntil`), plus minütlicher Vercel-Cron als Sweeper (Retries, fällige Jobs, IMAP-Poll)

DB / Auth / Storage
Supabase Cloud (EU-Region): Postgres, Auth, RLS, Storage

Queue
Postgres-Jobs-Tabelle in Supabase (`FOR UPDATE SKIP LOCKED`-Claiming, Retry mit exponentiellem Backoff, max. 5, danach `dead` + Alarm) — bewusst kein Redis und kein externer Queue-Dienst

KI
Anthropic API. Standard: `claude-haiku-4-5` für Extraktion/Klassifikation/Dedup-Judge, Eskalation auf `claude-sonnet-5` nur bei niedriger Konfidenz (beide per ENV überschreibbar). **Native Structured Outputs** nutzen — `output_config.format` mit `type: "json_schema"` (GA, auch für Haiku 4.5) garantiert schemakonformes JSON; Ergebnis trotzdem per Zod parsen (Defense in Depth). **Prompt Caching für Systemprompts aktivieren** (Achtung: Haiku cached erst ab 4.096 Token Präfix). `temperature: 0` **nur bei Haiku** — Sonnet 5 lehnt Nicht-Default-Sampling-Parameter mit 400 ab; der Request-Builder strippt `temperature` modellabhängig.

Telefonie (Phase 2)
Twilio-Nummer, in Vapi importiert; Vapi-Assistant mit ElevenLabs-TTS (deutsche Stimme) + Deepgram-Transcriber (Deutsch)

WhatsApp (Phase 2)
Dieselbe Twilio-Nummer als WhatsApp-Sender (Twilio WhatsApp Business API)

UI
Tailwind + shadcn/ui, deutschsprachig, funktional-dicht, kein Overengineering

Deployment
Vercel (Function-Region Frankfurt/fra1, Domain `strongenergy.zendori.ai`); Vercel Cron für Sweeper + Mail-Polling. Achtung DSGVO: Vercel kommt als Subprozessor in die AVV-Kette

Codequalität
ESLint + Prettier (Agentur-Standard), Zod-Validierung an allen Systemgrenzen

## 5. Architektur

```
Kanal-Adapter                    Pipeline (pg-boss Jobs)              Sink
──────────────                   ─────────────────────────            ────────────
Form-Webhook      ─┐             1. persist (raw + normalisiert)      HubSpotSink
E-Mail (IMAP)     ─┤             2. extract (KI → Ticket-Schema)      (später:
Paste-Inbox       ─┼─► Inbound   3. contact-upsert (HubSpot)          ZendoriSink
Vapi-Webhook      ─┤   Message   4. dedup-check                       hinter dem-
WhatsApp-Webhook  ─┘             5. create-ticket ODER attach-note    selben
                                 6. confirm (kanalabhängig)           Interface)
                                 7. status → Dashboard
```

**Verbindliche Prinzipien:**

- Jeder Kanal ist ein Adapter, der auf ein einheitliches `InboundMessage` normalisiert. Neuer Kanal = neuer Adapter, Pipeline bleibt unberührt.
- Das Ziel-System steckt hinter einem `TicketSink`-Interface in `packages/core`. v1 implementiert `HubSpotSink`; später kommt `ZendoriSink` dazu, ohne dass Adapter oder Pipeline angefasst werden.
- Jeder Pipeline-Schritt ist **idempotent**, läuft als pg-boss-Job mit Retry (exponential Backoff, max. 5), danach Status `failed` + Dashboard-Alarm. **Niemals stiller Verlust einer Nachricht.**
- Eine Correlation-ID pro Nachricht zieht sich durch alle Logs und Jobs.

## 6. Datenmodell (Postgres, versionierte Migrationen)

**Jede Migration legst du mir vor der Ausführung als SQL zur Review vor.**

- `inbound_messages`: id (uuid), channel (enum: `form|email|phone|whatsapp|paste`), external_id (Message-ID / Twilio SID / Call-ID …), sender_name, sender_email, sender_phone, subject, body_text, body_html, attachments (jsonb), raw (jsonb), received_at, status (enum: `received|extracted|needs_info|ticket_created|attached_to_existing|spam|failed`), error, correlation_id, created_at. **Unique (channel, external_id)** für Idempotenz.
- `extractions`: message_id (fk), model, schema_version, data (jsonb, siehe Ticket-Schema), confidence (0–1), missing_fields (text[]), questions (jsonb), tokens_in, tokens_out, created_at
- `tickets`: id, ticket_ref (`ZV1-####`, fortlaufend), hubspot_ticket_id, hubspot_contact_id, subject, category, priority, source_channel, first_message_id, created_at
- `contacts_cache`: email/phone → hubspot_contact_id, name, last_synced_at
- `dedup_decisions`: message_id, candidate_ticket_ids (uuid[]), decision (`new|duplicate|follow_up`), confidence, reason, model, created_at
- `mailboxes`: label, imap_host/port, smtp_host/port, username, secret_encrypted, auth_type (`password|oauth2`), auto_reply_enabled, last_poll_at, last_uid
- `form_api_keys`: key_hash, site_label, allowed_origins, active
- `app_settings`: key/value (HubSpot Pipeline-/Stage-IDs, Kategorienliste, Auto-Reply-Vorlagen, Dedup-Zeitfenster, Löschfristen)
- `audit_log`: actor (user/system), action, entity, payload, created_at
- RLS auf allen Tabellen; Service-Role nur im Worker. Nutzerverwaltung über Supabase Auth (Einladung, kein Self-Signup).

## 7. KI-Extraktion (Ticket-Schema)

Umsetzung über **Structured Outputs** (`output_config.format`, `type: "json_schema"`) — kein Tool-Use-Workaround. Systemprompt + Few-Shot-Beispiele in `packages/core/prompts/`, Prompt Caching aktiv, Antwort zusätzlich per Zod validieren. Fällt die Anthropic API aus: Nachricht bleibt in `received`, Retry greift, notfalls Ticket mit Rohdaten + Flag `ai_skipped` — **niemals blockiert ein KI-Ausfall die Weiterleitung.**

```
{
  "contact": { "name": "string|null", "email": "string|null", "phone": "string|null", "company": "string|null" },
  "ticket": {
    "subject": "string (max 80 Zeichen, prägnant)",
    "description": "string (bereinigt: Zitate, Signaturen, Disclaimer entfernt)",
    "category": "Frage|Störung|Reklamation|Bestellung|Sonstiges  // Liste aus app_settings",
    "priority": "low|normal|high|urgent",
    "priority_reason": "string",
    "language": "de|en|other"
  },
  "meta": { "is_spam": "boolean", "is_auto_reply": "boolean  // Out-of-Office etc.", "summary": "string (1 Satz)" }
}
```

**Regeln:** Nichts erfinden. Pflichtfelder: mindestens ein Kontaktweg (E-Mail ODER Telefon) + beschreibbares Anliegen. Fehlt etwas → `missing_fields` befüllen und **max. 3 konkrete Rückfragen** generieren (Status `needs_info`). `is_spam`/`is_auto_reply` → kein Ticket, nur Dashboard-Eintrag.

## 8. Duplikaterkennung (dreistufig)

1. **Harte Treffer:** Gleiche (channel, external_id) → verwerfen (Idempotenz). E-Mail: `References`/`In-Reply-To` auf bekannte Message-IDs oder Ticket-Ref `[ZV1-####]` im Betreff → direkt als Notiz ans bestehende Ticket.
2. **Kandidatensuche:** Gleicher Kontakt (E-Mail/Telefon normalisiert) mit Tickets der letzten N Tage (app_settings, Default 14) aus lokaler Spiegel-Tabelle; zusätzlich `pg_trgm`-Ähnlichkeit auf subject/description. Top-3-Kandidaten.
3. **LLM-Judge:** Haiku vergleicht neue Nachricht mit den Kandidaten → `duplicate | follow_up | new` + Konfidenz. Bei `duplicate`/`follow_up`: **kein neues Ticket**, sondern Note-Engagement am bestehenden HubSpot-Ticket + Kennzeichnung „Wiederholung" im Dashboard.

**Fail-Safe:** Bei Konfidenz unter Schwellwert (Default 0.8) → neues Ticket erstellen, aber als „möglicherweise Duplikat" markieren. Lieber ein Ticket zu viel als eine verlorene Anfrage. Im Dashboard nachträglich zusammenführbar (Merge = Notiz ans Haupt-Ticket, Duplikat in HubSpot schließen).

pgvector-Embeddings nur nachrüsten, falls die Trefferqualität nachweislich nicht reicht — nicht präventiv einbauen.

## 9. HubSpot-Integration

- Private App des Kunden, Token per ENV. Scopes: `crm.objects.tickets.read/write`, `crm.objects.contacts.read/write`; beim Anlegen der App prüfen, ob Notes/Engagements einen eigenen Scope brauchen. Beim App-Start Token-Test (Account-Info + Pipeline-Abruf) mit klarer Fehlermeldung, falls Scopes fehlen.
- **Kontakt-Upsert:** Suche per E-Mail (Search API), Fallback Telefon; sonst anlegen. Ergebnis in `contacts_cache`.
- **Ticket:** `crm/v3/objects/tickets` mit `hs_pipeline` / `hs_pipeline_stage` aus app_settings; Properties: subject, content, `hs_ticket_priority`, Custom Property `zendori_source` (form|email|phone|whatsapp|paste) und `zendori_ref` (Ticket-Ref)
- **Association** Ticket↔Contact über Associations v4 (Default-Typ zur Laufzeit ermitteln)
- **Wiederholungen:** Note-Engagement am bestehenden Ticket (Volltext der neuen Nachricht + Quelle)
- **Idempotenz:** Vor Create per Search auf `zendori_ref` prüfen
- **Rate Limits:** Zentraler Client mit 429-Handling (Retry-After beachten), Backoff, strukturiertem Logging

## 10. Kanäle

### 10.1 Kontaktformulare (Phase 1)

- `POST /api/ingest/form` — Auth per Site-API-Key im Header, Zod-Validierung, Honeypot-Feld, Rate-Limit pro IP, CORS nur für hinterlegte Kundendomains
- Payload bewusst flexibel (beliebige Felder erlaubt) — das Mapping erledigt die KI-Extraktion. Dadurch funktioniert jedes bestehende Formular per fetch-Snippet ohne Feld-Mapping-Pflege.
- Liefere ein fertiges Embed-Snippet (Vanilla JS) + Beispiel-HTML für die Kundenwebsite.

### 10.2 E-Mail-Postfächer (Phase 1)

- Mail-Poll-Cron (minütlich, Vercel): pro Postfach IMAP-Verbindung öffnen (imapflow), neue Mails seit `last_uid` holen, Verbindung schließen. Kein IDLE (serverless) — max. ~1 Minute Ingest-Latenz. Verarbeitete Mails flaggen/verschieben.
- Parsing mit mailparser; Reply-/Signatur-Stripping vor der Extraktion; Anhänge → Supabase Storage (Größenlimit, Whitelist an Dateitypen), Links ins Ticket
- **Auto-Reply** (nodemailer/SMTP) mit Ticket-Ref im Betreff `[ZV1-####]` — Vorlage in app_settings, pro Postfach abschaltbar. **Loop-Schutz:** keine Auto-Reply auf Auto-Replies/Out-of-Office (`Auto-Submitted`, `X-Auto-Response-Suppress`, Precedence-Header beachten).
- **Auth-Verfahren klären, bevor du implementierst:** Klassisches IMAP-Passwort ODER OAuth2. Microsoft 365 hat Basic Auth für IMAP deaktiviert — liegen Kundenpostfächer auf M365, ist OAuth2 (Client Credentials Flow) Pflicht. Gmail: App-Passwort bei aktivierter 2FA. → Rückfrage an mich mit dem Provider-Ergebnis.
- Credentials verschlüsselt at rest (AES-256-GCM, Key aus ENV `ENCRYPTION_KEY`), niemals in Logs.

### 10.3 Paste-Inbox (Phase 1)

- Dashboard-Ansicht „Nachricht einfügen": großes Textfeld für beliebigen kopierten Text (E-Mail, Chatverlauf, Telefonnotiz) + optionales Kontextfeld
- Ablauf: Extraktion → Vorschau des Ticket-Entwurfs mit hervorgehobenen fehlenden Feldern → KI-Rückfragen (max. 3) als Inline-Formular, kein Chat-UI → Nutzer ergänzt → Dedup-Check → „Ticket erstellen"
- Findet der Dedup-Check ein offenes ähnliches Ticket: Hinweis „Ähnliches Ticket gefunden: … — anhängen statt neu erstellen?" mit beiden Optionen

### 10.4 Telefon — reiner Aufnahmeagent (Phase 2)

- Twilio-Nummer (DE), in Vapi importiert. Vapi-Assistant „Aufnahmeagent":

- Systemprompt: **nur Aufnahme, keine Beratung, keine Zusagen.** Erfragt: Name, Rückrufnummer (zur Bestätigung wiederholen), Firma (optional), Anliegen, Dringlichkeit. Fasst am Ende zusammen und bestätigt: „Ihr Anliegen wurde aufgenommen, Sie erhalten eine Rückmeldung."
- ElevenLabs deutsche Stimme, Deepgram-Transcriber (Deutsch), max. Gesprächsdauer definieren, Eskalationssatz bei Nichtverstehen
- Vapi Structured Data / Analysis nach dem Ticket-Schema; End-of-Call-Webhook → `POST /api/ingest/vapi` (Webhook-Secret validieren) → Pipeline. Transkript + Recording-Link ans Ticket.
- Recording/Aufbewahrung konfigurierbar; Datenschutz-Ansage zu Gesprächsbeginn (Text stimme ich frei)
- Anrufer-ID (falls übermittelt) als Telefonkontakt vorbefüllen

### 10.5 WhatsApp (Phase 2)

- Dieselbe Twilio-Nummer als **WhatsApp-Sender** registrieren. Die Meta-Business-Verifizierung dauert Tage bis Wochen → **Registrierung am ersten Tag von Phase 2 anstoßen**, parallel zum Voice-Setup.
- Inbound: `POST /api/ingest/whatsapp` mit Twilio-Signaturvalidierung; Medien herunterladen → Storage
- **Debounce:** Mehrere Nachrichten desselben Absenders innerhalb 10 Minuten zu einer Anfrage bündeln (Timer-Job), erst dann extrahieren
- Fehlende Pflichtinfos: max. 2 Rückfragen innerhalb des 24-h-Session-Fensters, danach Ticket mit dem, was vorliegt
- Bestätigung mit Ticket-Ref an den Absender; außerhalb des 24-h-Fensters keine Nachrichten initiieren

## 11. Dashboard (`apps/web`)

- Login: Supabase Auth (E-Mail + Passwort, Einladungs-Flow), serverseitiges Session-Handling
- **Posteingang:** alle `inbound_messages` mit Status- und Kanalfilter, Kanal-Icons, Live-Aktualisierung
- **Detailansicht:** Rohdaten, Extraktion, Dedup-Entscheidung, Link zum HubSpot-Ticket, „erneut verarbeiten"
- **Paste-Inbox** (siehe 10.3)
- **„Braucht Info"-Queue:** alle `needs_info`-Nachrichten mit den offenen Rückfragen
- **Duplikat-Review:** als „möglicherweise Duplikat" markierte Tickets mit Merge-Aktion
- **Einstellungen:** Postfächer (CRUD inkl. „Verbindung testen": IMAP-Login + INBOX-Zugriff, SMTP-Testversand), Kategorien, HubSpot-Verbindung (Token-Test, Pipelines/Stages per API laden und auswählen), Auto-Reply-Texte, Form-API-Keys, Löschfristen
- **Logs/Audit:** Verarbeitungshistorie pro Nachricht (Correlation-ID)
- Aktionen: Ticket-Entwurf vor Übergabe bearbeiten, an bestehendes Ticket anhängen, als Spam markieren

## 12. Sicherheit & DSGVO

- Hosting: Vercel (Function-Region Frankfurt; CDN/Edge global) + Supabase EU-Region. README dokumentiert die Subprozessor-Kette für den AVV (Novax ↔ Kunde; Subprozessoren: Vercel, Supabase, Anthropic, Twilio, Vapi, ElevenLabs, Deepgram).
- Secrets ausschließlich per ENV; Postfach-Credentials verschlüsselt at rest; **PII-Maskierung in Logs**
- Webhook-Härtung: Twilio-Signatur, Vapi-Secret, Form-API-Keys (gehasht gespeichert), Rate-Limits auf allen Ingest-Endpoints
- RLS überall; Worker nutzt Service-Role, Web-App nie
- Konfigurierbare Löschfristen + täglicher Lösch-Job (Default: Rohnachrichten 90 Tage, Call-Recordings 30 Tage; HubSpot-Tickets bleiben unberührt)
- Audit-Log für alle schreibenden Aktionen (Nutzer + System)

## 13. Qualität & Betrieb

- Tests (gezielt, nicht flächendeckend): Extraktions-Schema-Validierung, Dedup-Heuristik, E-Mail-Stripping, Webhook-Signaturprüfung, HubSpot-Client gegen Mock
- Strukturierte Logs (pino) mit Correlation-ID; Fehlerpfade enden sichtbar (Status `failed` + Dashboard-Alarm + optionale Admin-Mail)
- `GET /healthz` für web (meldet u. a. letzte IMAP-Poll-Zeit pro Postfach und Job-Rückstau, sobald Phase 1 steht)
- `vercel.json` mit Cron-Definitionen und Region; `.env.example` vollständig; Cron-Endpoints per `CRON_SECRET` abgesichert
- README als Runbook: Setup, ENV-Referenz, Deployment auf Hetzner, Backup-Hinweis, Übergabe-Checkliste für den Kunden

## 14. ENV-Referenz (Werte liefere ich)

`NEXT_PUBLIC_APP_URL`, `DATABASE_URL` (nur Migrationen), `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `ANTHROPIC_API_KEY`, `HUBSPOT_TOKEN`, `HUBSPOT_PIPELINE_ID`, `HUBSPOT_STAGE_ID`, `ENCRYPTION_KEY`, `CRON_SECRET`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `VAPI_API_KEY`, `VAPI_WEBHOOK_SECRET`, `ADMIN_ALERT_EMAIL` — Postfach-Zugänge werden in der DB verwaltet (verschlüsselt), nicht per ENV.

---

## 15. Phasenplan mit Checkpoints (STRIKT einhalten)

**Phase 0 — Fundament**
Monorepo-Scaffold, DB-Migrationen (zur Review!), Supabase Auth, Pipeline-Grundgerüst mit pg-boss, Docker-Compose-Skeleton, Healthchecks.
⛔ **CHECKPOINT 0:** Kurze Architektur-Doku + alle Fragen aus „Offene Punkte" an mich. Warte auf Freigabe.

**Phase 1 — MVP (Ziel: Freitag)**
Form-Ingest inkl. Embed-Snippet, E-Mail-Ingest (zunächst 1 Postfach), KI-Extraktion, HubSpot-Kontakt-Upsert + Ticket-Erstellung, Paste-Inbox (Basisversion), Dashboard-Posteingang + Detailansicht, Auto-Reply.
⛔ **CHECKPOINT 1:** End-to-End-Demo-Anleitung + Testplan (Testformular absenden, Test-Mail schicken → Ticket erscheint in HubSpot). Ich teste selbst, dann Freigabe.

**Phase 1.5 — Qualität**
Dedup-Engine (alle 3 Stufen), Rückfragen-Flow inkl. „Braucht Info"-Queue, Duplikat-Review + Merge, Spam-/Auto-Reply-Erkennung, Lösch-Jobs, Audit-Log.
⛔ **CHECKPOINT 1.5:** Demo mit konstruiertem Duplikat-Fall.

**Phase 2 — Voice & WhatsApp (Ziel: Monatsende)**
**Tag 1: WhatsApp-Sender-Registrierung anstoßen** (Meta-Verifizierung läuft parallel). Twilio-Nummer beschaffen, in Vapi importieren, Aufnahmeagent bauen + testen, Vapi-Webhook-Ingest, danach WhatsApp-Ingest mit Debounce + Rückfragen + Bestätigung.
⛔ **CHECKPOINT 2:** Testanruf + Test-WhatsApp dokumentiert, Übergabedoku für den Kunden.

## 16. Arbeitsregeln für dich

1. Stelle vor Phase 0 alle Fragen aus „Offene Punkte" — baue nichts auf Annahmen, die dort gelistet sind.
2. Aktuelle offizielle Doku vor jeder Integration prüfen (siehe Abschnitt 1) — keine API-Details aus dem Gedächtnis.
3. Kleine, thematische Commits (Conventional Commits). Nach jedem Feature: kurzer Status (fertig / offen / wie teste ich das).
4. Keine zusätzlichen Services, Frameworks oder Dependencies ohne Rücksprache.
5. SQL-Migrationen und sicherheits-/datenschutzrelevante Entscheidungen: Optionen + Empfehlung vorlegen, nicht eigenmächtig entscheiden.
6. Sprache: UI und Endnutzer-Kommunikation auf Deutsch; Code, Kommentare und Commits auf Englisch.

## 17. Offene Punkte (zuerst mit mir klären)

1. **HubSpot:** Private-App-Token vorhanden? Pipeline- und Stage-IDs für Tickets? Dürfen Custom Properties (`zendori_source`, `zendori_ref`) angelegt werden?
2. **Postfächer:** Welcher Provider (M365 / Gmail / klassisches Hosting)? → entscheidet Passwort vs. OAuth2. Wie viele Postfächer? Auto-Reply gewünscht, und mit welchem Text?
3. **Formulare:** Welche Domains? Bestehende Formulare andocken oder neues Snippet einbauen?
4. **Kategorien/Prioritäten:** Kundenspezifische Liste oder Default übernehmen?
5. **Twilio:** Bestehender Account oder neu? Deutsche Nummer — regulatorische Anforderungen (Address/Bundle) einplanen.
6. **Call-Recording:** Ja/nein? Aufbewahrungsdauer? Text der Datenschutz-Ansage?
7. **Domain der Bridge:** z. B. `bridge.[kunde].de` oder Subdomain unter zendori.ai?
8. **Ticket-Ref-Format:** `ZV1-####` okay oder Kundenwunsch?
