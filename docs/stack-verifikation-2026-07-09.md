# Stack-Verifikation gegen offizielle Doku (Stand: 2026-07-09)

Ergebnis einer Web-Recherche gegen die aktuellen offiziellen Docs (6 parallele Recherchen: Anthropic, HubSpot, Twilio, Vapi, Supabase, Node-Stack). Jede Aussage ist mit der tatsächlich gelesenen Quelle belegt. Dient als Referenz für die Implementierung — ersetzt NICHT die Doku-Prüfung vor jeder Integration (CLAUDE.md §16.2).

Legende: ✅ Annahme aus CLAUDE.md bestätigt · ⚠️ abweichend / Korrektur nötig

---

## Anthropic API

- ✅ **Structured Outputs**: `output_config.format` mit `{type: "json_schema", schema: {...}}` — GA, kein Beta-Header, explizit unterstützt auf Haiku 4.5 und Sonnet 4.6. Das ältere Top-Level-`output_format` ist deprecated. SDK-Weg: `client.messages.parse()`. Vor dem Parsen `stop_reason` prüfen (`refusal`/`max_tokens` können das Schema brechen).
  https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md
- ⚠️ **Schema-Restriktionen**: Jedes Objekt braucht `additionalProperties: false`; NICHT unterstützt (400): rekursive Schemas, `minimum`/`maximum`/`multipleOf`, `minLength`/`maxLength`, komplexe Regex. Längen-/Wertebereichs-Checks gehören in die Zod-Nachvalidierung. Schema-Bytes stabil halten (Grammar-Cache 24 h; Schema-Änderung invalidiert zudem den Prompt-Cache).
- ✅ **Modelle**: `claude-haiku-4-5` aktiv ($1/$5 pro MTok, 200k Kontext). `claude-sonnet-4-6` existiert, ist aber inzwischen **Legacy** ($3/$15). Aktuellstes Sonnet: `claude-sonnet-5` ($2/$10 bis 31.08.2026, danach $3/$15).
- ⚠️ **temperature**: `temperature: 0` ist auf Haiku 4.5 und Sonnet 4.6 ok, liefert aber auf `claude-sonnet-5` (und Opus 4.7+) einen **400-Fehler** (Nicht-Default-Sampling-Parameter entfernt). Der gemeinsame Request-Builder muss `temperature` modellabhängig strippen.
- ⚠️ **Prompt Caching auf Haiku 4.5**: Mindest-Präfixlänge **4.096 Tokens** — darunter wird still nicht gecacht (kein Fehler, `cache_creation_input_tokens` bleibt 0). Systemprompt + Few-Shots + Schema müssen zusammen darüber liegen, sonst bringt Caching nichts. `cache_control: {type: "ephemeral"}`, max. 4 Breakpoints, TTL 5 m (Default) / 1 h.
- ⚠️ **Doku-URL**: docs.claude.com leitet auf **platform.claude.com/docs/en/** um — Links in Runbooks entsprechend setzen.

## HubSpot

- ⚠️ **Scopes**: `crm.objects.tickets.read/write` **existiert nicht**. Tickets laufen über den Standalone-Scope **`tickets`**; Kontakte über `crm.objects.contacts.read/write`. **Notes brauchen keinen eigenen Scope** — sie sind über die Contacts-Scopes abgedeckt. Custom-Ticket-Properties anlegen: ebenfalls Scope `tickets` (`POST /crm/v3/properties/tickets`).
  https://developers.hubspot.com/docs/apps/legacy-apps/authentication/scopes
- ✅ **Note + Association in einem Call**: `POST /crm/v3/objects/notes` mit `associations`-Array. `hs_timestamp` ist **Pflicht**; `hs_note_body` max. 65.536 Zeichen (kürzen/splitten).
- ✅ **Associations v4 typeIds** (HUBSPOT_DEFINED): contact→ticket **15**, ticket→contact **16**, note→ticket **228**, ticket→note **227**. Können als Konstanten hinterlegt werden; Associations bevorzugt inline beim Create mitgeben.
- ⚠️ **Idempotenz besser ohne Search**: Search-API hat dokumentierten Indexing-Delay („a few moments") + hartes Limit **5 req/s pro Account** → Search-before-create ist racy. Stattdessen: Custom Property (z. B. `zendori_ref`) mit `hasUniqueValue: true` anlegen → Tickets per `idProperty` exakt lesen/updaten. Kontakte per `GET /crm/v3/objects/contacts/{email}?idProperty=email` bzw. Batch-Upsert mit `idProperty=email` — exakt, ohne Index-Delay. Search nur noch für Telefon-Matching (Achtung: HubSpot indiziert Vorwahl + Rufnummer **ohne Ländercode**).
- ⚠️ **429-Handling**: Es gibt **keinen dokumentierten `Retry-After`-Header**. Stattdessen `policyName` im Body (`TEN_SECONDLY_ROLLING` vs. `DAILY`) + proaktiv `X-HubSpot-RateLimit-Remaining` lesen; Search-Antworten tragen gar keine Rate-Limit-Header (fixer Fallback-Backoff). Limits: 100 req/10 s (Free/Starter) bzw. 190 req/10 s (Pro/Enterprise) pro App; 250k/625k/1M Calls pro Tag.
- Hinweis: HubSpot führt kalender-versionierte Endpoints ein (`/crm/objects/2026-03/…`); v3/v4 bleiben ohne Sunset dokumentiert → v1 auf v3/v4 bauen.

## Twilio (Phase 2)

- ✅ **DE-Nummer**: Regulatory Bundle nötig (Handelsregisterauszug/Gewerbeschein/Steuer-ID + deutsche Geschäftsadresse; bei Ortsnetznummer Adresse im Vorwahlbereich, kein Postfach). Prüfung i. d. R. 24–72 h — nicht der kritische Pfad.
- ⚠️ **WhatsApp-OTP-Sequenzierung**: Meta verifiziert per SMS- oder Sprach-OTP. Eine DE-**Mobilnummer** verifiziert automatisch per SMS. Eine Festnetz-/Ortsnetznummer ist voice-only → OTP-Anruf darf NICHT bei Vapi landen („computer-operated phone system"): WhatsApp-Registrierung **vor** dem Vapi-Import abschließen (oder Voice-URL temporär auf das Voicemail-Twimlet legen).
- ✅ **Eine Nummer für Voice + WhatsApp** funktioniert: Voice-Webhook gehört Vapi, der WhatsApp-Sender hat einen **eigenen** Webhook (`webhook.callback_url` am Sender-Objekt).
- ✅ **Meta Business-Verifizierung** ist Pflicht für Produktion und dauert „several weeks" → **kritischer Pfad**, so früh wie möglich starten (idealerweise vor Phase 2). Display-Name wird von Meta geprüft; Ablehnung deckelt auf 250 Business-initiierte Nachrichten/24 h.
- ✅ **24-h-Fenster**: Freiform-Antworten nur innerhalb 24 h nach letzter Inbound-Nachricht; außerhalb nur approved Templates (bei Bedarf im Onboarding einreichen).
- ⚠️ **Medien-Download**: HTTP Basic Auth ist inzwischen **erzwungen** (kein Console-Toggle mehr). Produktion: API Key + Secret als Credentials (Account SID + Auth Token nur lokal).
- ⚠️ **Signaturvalidierung hinter Traefik**: TLS-Terminierung upstream → Validierungs-URL NICHT aus dem Request ableiten, sondern aus konfigurierter `PUBLIC_BASE_URL` rekonstruieren (https, öffentlicher Host, exakter Pfad) und an `twilio.validateRequest()` geben. Raw-Body vor dem Parsen lesen.

## Vapi (Phase 2)

- ⚠️ **Nummern-Import**: `POST /phone-number` setzt per Default **auch den Twilio-Messaging-Webhook um** (`smsEnabled` default `true`) → zwingend **`smsEnabled: false`**, sonst ist der WhatsApp/SMS-Kanal tot.
  https://docs.vapi.ai/api-reference/phone-numbers/create
- ⚠️ **Webhook-Auth**: Ein Inline-Feld `server.secret` existiert **nicht mehr**. Auth läuft Credential-basiert: Webhook-Credential (z. B. Bearer mit Header-Name `X-Vapi-Secret`) anlegen und via `server.credentialId` referenzieren; alternativ statische `server.headers`.
- ⚠️ **Webhook-Retries sind NICHT automatisch**: `server.backoffPlan` default undefined = kein Retry. Explizit setzen (z. B. exponential, maxRetries 5) + Handler idempotent und < 20 s. Zusätzlich Reconciliation-Poll über `GET /call` als Backup gegen verlorene End-of-Call-Reports.
- ⚠️ **Structured Data**: `analysisPlan.structuredDataPlan` — **`enabled` default false**, explizit aktivieren; `schema` = Ticket-Schema; `timeoutSeconds` (default 5) ggf. erhöhen. Ergebnis in `analysis.structuredData` des End-of-Call-Reports (enthält auch `artifact.transcript` + `recordingUrl` — kein Extra-GET nötig).
- ✅ **Deutsch**: Transcriber `{provider: "deepgram", model: "nova-2", language: "de"}`; TTS `{provider: "11labs", model: "eleven_multilingual_v2" oder "eleven_turbo_v2_5" + language: "de"}` mit deutschfähiger voiceId.
- ✅ **Limits**: `maxDurationSeconds` (default 600). Silence-Handling nicht als einzelnes Feld, sondern über `hooks` mit `on: "customer.speech.timeout"` (Re-Prompt + endCall).
- ⚠️ **Recording-Storage**: Default = Vapis Cloudflare-R2-Bucket, **Retention undokumentiert** → für DSGVO Custom Storage auf Supabase-EU (S3-kompatibel) konfigurieren (`artifactPlan.recordingUseCustomStorageEnabled`). Datenschutz-Ansage als deterministische `firstMessage` (das eingebaute `recordingConsentPlan` ist offenbar Enterprise-gated).

## Supabase

- ✅ **Auth**: `@supabase/ssr` aktuell (createServerClient/createBrowserClient; `setAll` bekommt jetzt ein zweites Argument mit Cache-Headern — anwenden!). ⚠️ Auth-Check in Middleware/Handlern per **`supabase.auth.getClaims()`** (validiert JWT-Signatur); `getSession()` explizit NICHT vertrauen. Invite-only: Signup-Toggle aus + `auth.admin.inviteUserByEmail()` serverseitig.
- ⚠️ **Neue API-Keys**: `sb_secret_…` (Worker/Server, BYPASSRLS) und `sb_publishable_…` (Browser) statt legacy `service_role`/`anon` — für ein Neuprojekt die neuen Keys provisionieren; ENV-Namen entsprechend.
- ⚠️ **pg-boss-Verbindung (wichtig!)**: Direct Connection (`db.[ref].supabase.co:5432`) ist **IPv6-only**; Docker auf Hetzner hat per Default kein IPv6-Egress. Optionen: (a) **Supavisor Session-Mode** `…pooler.supabase.com:5432`, Username `postgres.[ref]` — IPv4, persistente Sessions, $0 (Empfehlung); (b) IPv4-Add-on ~$4/Monat für Direct; (c) IPv6 im Docker-Daemon aktivieren. **Niemals Transaction-Mode (Port 6543)** — keine Prepared Statements/Session-State, inkompatibel mit pg-boss.
- ✅ **Storage**: Private Buckets + `createSignedUrl(path, seconds)`. Free-Plan: globales Dateilimit **50 MB** (Anhang-Cutoff einplanen, falls Kunde auf Free bleibt).
- ✅ **Extensions**: `create extension if not exists pg_trgm with schema extensions;` (Funktionen ggf. mit `extensions.`-Präfix). `gen_random_uuid()` ist Core-Postgres.
- ✅ **EU-Regionen**: Frankfurt (eu-central-1) verfügbar — natürliche Wahl neben Hetzner.
- ✅ **RLS**: Service-Key bypasst RLS, ABER: Client mit User-Session gewinnt die User-Policy — Worker-Client strikt ohne Session initialisieren. Dashboard-Tabellen: `for select to authenticated using (true)`.

## Node-Stack

- ⚠️ **Next.js**: **16 ist aktuell** (16.2.10); Next 15 ist Maintenance-LTS, **Security-Support endet 21.10.2026** (~3 Monate nach v1-Launch). Empfehlung: direkt Next 16. Migrationsrelevant für uns: `await params`/`await headers()` (Promise-only), `proxy.ts` statt `middleware.ts` (nodejs-Runtime), Turbopack als Default, Node ≥ 20.9.
- ⚠️ **pg-boss v12** (12.25.1): **Named Export** (`import { PgBoss } from 'pg-boss'` — kein Default-Export mehr), Node **≥ 22.12**, Queues explizit per `createQueue()` beim Bootstrap, Worker-Handler bekommt ein **Jobs-Array** (`async (jobs) => {}` — auch bei batchSize 1 destrukturieren), keine Archiv-Tabellen mehr (`deleteAfterSeconds`, default 7 Tage), alle Zeitoptionen in Sekunden, eingebautes Cron-Scheduling (`schedule()`, tz-fähig), `singletonKey`/`sendDebounced` für den WhatsApp-Debounce, `useListenNotify` default false. Queue-Namen: nur Buchstaben/Zahlen/-/_/. erlaubt.
- ✅ **Mail-Stack**: imapflow 1.4.6 (IDLE bestätigt, aktiv gepflegt), mailparser 3.9.14, nodemailer **9.0.3** (Major 9 — imapflow pinnt exakt 9.0.3, Version angleichen).
- ✅ **Node 22**: Maintenance-LTS bis **30.04.2027** — für v1 ok; Basis-Image ≥ 22.12 wegen pg-boss. (Node 24 = aktuelles Active LTS, Wechsel vor 04/2027 einplanen.)

### Empfohlene Pins (Stand 2026-07-09)

`next@16.2.10` (Alternative: 15.5.20, EOL 10/2026) · `pg-boss@12.25.1` · `imapflow@1.4.6` · `mailparser@3.9.14` · `nodemailer@9.0.3` · Node-Image `22.x ≥ 22.12`

## Microsoft 365 / Exchange Online (ergänzt 2026-07-10 — Kundenpostfächer liegen auf M365!)

- ⚠️ **IMAP Basic Auth: endgültig tot.** Seit 2023 in allen Tenants deaktiviert, kein Re-Enable möglich (weder Kunde noch Microsoft-Support). OAuth2 (XOAUTH2) ist der einzige Weg.
  https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online
- ⚠️ **SMTP AUTH Basic: noch nicht ganz tot, aber praktisch nutzlos.** Bei Security Defaults bereits deaktiviert (→ unser 535 5.7.3); disabled-by-default ab Ende Dez 2026, Entfernung H2 2027. OAuth-XOAUTH2 über `smtp.office365.com:587` bleibt voll unterstützt.
- ✅ **Der richtige Weg (unattended): Client-Credentials-Flow gegen „Office 365 Exchange Online"** (NICHT Graph): App-Permissions `IMAP.AccessAsApp` + `SMTP.SendAsApp`, Admin-Consent, dann in Exchange PowerShell `New-ServicePrincipal` (⚠️ Object-ID der **Enterprise Application**, nicht der App-Registrierung!) + pro Postfach `Add-MailboxPermission … -AccessRights FullAccess` und fürs Senden `Add-RecipientPermission … SendAs`.
  https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth
- ✅ **Token:** `POST login.microsoftonline.com/{tenant}/oauth2/v2.0/token`, `grant_type=client_credentials`, Scope exakt `https://outlook.office365.com/.default` (ein Token für IMAP+SMTP). Laufzeit 60–90 min → cachen, kein Refresh-Token in diesem Flow.
- ✅ **Bibliotheken:** imapflow `auth: { user: <mailbox>, accessToken }` spricht nativ XOAUTH2 (Source-verifiziert); nodemailer ebenso (`auth: { type: 'OAuth2', user, accessToken }`).
- ⚠️ **Graph `sendMail` bewusst NICHT gewählt:** eigene Header nur mit `x-`-Präfix erlaubt — `Auto-Submitted`/`In-Reply-To` (Loop-Schutz!) gingen nur über umständlichen MIME-Upload. SMTP-XOAUTH2 erhält unseren Versandcode 1:1.
- Hinweis Least-Privilege: FullAccess/SendAs gelten nur für die explizit freigegebenen Postfächer — genau richtig für 2 Postfächer.
