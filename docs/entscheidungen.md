# Entscheidungslog

Antworten auf die offenen Punkte (CLAUDE.md §17) und Stack-Entscheidungen. Quelle: Philipp, 2026-07-09.

## Beantwortet (2026-07-09)

| #   | Punkt          | Entscheidung                                                                                                                                                                                                                                                                                                                             |
| --- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | HubSpot        | Private-App-Token wird von Philipp organisiert. Tier unbekannt, aber „irgendwas Premium-mäßiges" (größerer Kunde) → Rate-Limit-Budget konservativ auf 100 req/10 s auslegen, bis Tier bekannt. Pipeline-/Stage-IDs: werden über die Settings-UI per API geladen und ausgewählt (kein Hardcoding). Custom-Property-Erlaubnis: noch offen. |
| 2   | Postfächer     | **2 Postfächer, klassisches Hosting** (IMAP-Host, SMTP-Host, E-Mail, Passwort) → Passwort-Auth, kein OAuth2 in v1 (Feld `auth_type` bleibt für später). Auto-Reply: **pro Postfach als Einstellung** (an/aus + Text) im Dashboard.                                                                                                       |
| 3   | Formulare      | Bestehende Next.js-Website (von Philipp selbst gebaut), 2 Formulare. Er bindet sie selbst per API an → wir liefern Endpoint + Beispiel-Snippet. Domains: noch offen → `allowed_origins` pro API-Key im Dashboard pflegbar.                                                                                                               |
| 4   | Kategorien     | Kundenspezifische Liste, wird noch definiert → Kategorien in `app_settings` editierbar, Default als Platzhalter.                                                                                                                                                                                                                         |
| 5   | Twilio         | Bestehender Novax-Account; **DE-Mobilnummer** für den Kunden wird dort angelegt (alles über Novax-Twilio). Philipp hat **vollen Zugriff aufs Meta Business Portfolio des Kunden**.                                                                                                                                                       |
| 6   | Call-Recording | Als **Einstellung** (aktivieren/deaktivieren) im Dashboard. Aufbewahrung + Ansagetext: offen (Phase 2).                                                                                                                                                                                                                                  |
| 7   | Domain         | **`strongenergy.zendori.ai`** (Endkunde: Strong Energy).                                                                                                                                                                                                                                                                                 |
| 8   | Ticket-Ref     | **`ZV1-####`** wie vorgeschlagen.                                                                                                                                                                                                                                                                                                        |

## Stack-Entscheidungen (Freigabe Philipp, 2026-07-09)

- **A — Next.js 16** statt 15 (Next 15 Security-EOL 2026-10-21). `proxy.ts` statt `middleware.ts`, `await params`/`await headers()`, Turbopack default.
- **B — Eskalationsmodell `claude-sonnet-5`** (statt `claude-sonnet-4-6`, per ENV überschreibbar). Konsequenz: `temperature` wird nur bei Haiku gesetzt; Request-Builder strippt sie bei Sonnet 5 (sonst 400).
- **C — Worker-DB via Supavisor Session-Mode-Pooler** — durch Entscheidung D obsolet; `DATABASE_URL` wird nur noch für Migrationen gebraucht.
- **D — Deployment vollständig auf Vercel** (Entscheidung Philipp 2026-07-09, gegen die Hybrid-Empfehlung — bewusst gewählt). Konsequenzen:
  - `apps/worker`, pg-boss, Dockerfiles und docker-compose entfallen. Queue = eigene Postgres-**Jobs-Tabelle** (`FOR UPDATE SKIP LOCKED`, Retry/Backoff/`dead`-Status in SQL) in Supabase — kein Redis, kein externer Queue-Dienst.
  - Verarbeitung in Vercel Functions: direkt nach Ingest angestoßen (`after()` aus `next/server`) + minütlicher Cron-Sweeper (`CRON_SECRET`-geschützt, GET, UTC). **Minuten-Crons erfordern Vercel Pro** (Hobby: nur täglich ±59 min — untauglich; Pro ohnehin nötig: kommerzielle Nutzung + DPA). Cron-Zustellung ist best-effort inkl. möglicher Duplikate → Claiming via `FOR UPDATE SKIP LOCKED` fängt das ab.
  - E-Mail-Ingest: IMAP-**Polling** per Cron statt IDLE → bis ~1 Min Latenz. SMTP-Versand aus Vercel Functions: offiziell erlaubt außer Port 25 → Auto-Reply über Postfach-SMTP (465/587) funktioniert; Versand vor Response-Ende bzw. in `after()`.
  - DSGVO: Vercel wird Subprozessor in der AVV-Kette; Function-Region fra1 (Frankfurt), CDN/Edge bleibt global.

## Noch offen (nicht blockierend für Phase 0)

- **HubSpot:** Token liefern; Tier klären (Rate-Limits); Erlaubnis für Custom Properties `zendori_source` + `zendori_ref` (mit `hasUniqueValue: true` als Dedup-Anker) bestätigen.
- **Auto-Reply-Versand:** Philipp erwähnte Resend als Option. Empfehlung: Auto-Replies über den **SMTP des jeweiligen Postfachs** (gleiche Absenderadresse, sauberes Threading, Credentials liegen ohnehin in der DB); Resend allenfalls für Admin-Alert-Mails. → Entscheidung bei Phase 1.
- **Kategorienliste** vom Kunden (bis dahin Default: Frage/Störung/Reklamation/Bestellung/Sonstiges).
- **Formular-Domains** für CORS (im Dashboard nachpflegbar).
- **Supabase-Tier** des Kunden (Free deckelt Datei-Uploads auf 50 MB → Anhang-Limit).
- **Phase 2:** Meta-Verifizierungsstatus des Kunden-Business prüfen (früh! dauert Wochen), WhatsApp-Anzeigename, Datenschutz-Ansage-Text, Recording-Aufbewahrung, ggf. WhatsApp-Templates für Out-of-Window-Nachrichten.

## Nachträge Phase 1 (2026-07-10)

- **PII-Redaction für KI-Aufrufe:** An Anthropic gehen keine Absender-Metadaten mehr; Body/Betreff/Kontext werden vor dem Aufruf maskiert (E-Mail-Adressen, telefonartige Nummern, bekannter Absendername → Platzhalter). Kontaktdaten fließen lokal: E-Mail aus Headern, Formulare deterministisch aus Feldnamen, Paste per Regex. Die KI erhält nur das Flag „Kontaktweg vorhanden: ja/nein". Ehrliche Grenze: Der Anliegen-Text selbst geht zur KI; fremde Namen im Fließtext können durchrutschen; die Telefon-Heuristik kann selten Bestellnummern in Telefonform treffen.
- **HubSpot-Transparenz:** Deliver-Step protokolliert die übermittelten Felder im Audit-Log; Detailansicht zeigt Übermittlungszeitpunkt, Felder und Deep-Link (Portal-ID/UI-Domain aus dem Verbindungstest).
- **Statistik (`/statistik`, Migration 0004):** Monatsauswertung Nachrichten pro Kanal/Status, Tickets, KI-Tokens pro Modell — Abrechnungsgrundlage für die transaktionale Kundenabrechnung.
- **Betriebsvorfall behoben (Migration 0003):** Enum-Cast-Fehler in `release_stuck_jobs` blockierte jede Job-Verarbeitung; zusätzlich loggt der Post-Response-Kick verschluckte Fehler jetzt sichtbar.
