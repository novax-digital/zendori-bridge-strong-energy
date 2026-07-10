# Formular-Einbindung — Zendori Bridge

Anleitung zur Anbindung eines Website-Kontaktformulars an die Zendori Bridge. Zielgruppe: Integration in eine eigene (Next.js- oder beliebige andere) Website.

## Endpoint

```
POST https://strongenergy.zendori.ai/api/ingest/form
Content-Type: application/json
x-zendori-key: <API-Schlüssel>
```

- **API-Schlüssel:** wird im Dashboard unter **Einstellungen → Formular-API-Keys** angelegt und dort **genau einmal** im Klartext angezeigt. Pro Website ein eigener Schlüssel (`site_label` = Name der Seite).
- **Erlaubte Domains (CORS):** ebenfalls am Schlüssel im Dashboard hinterlegt. Ist die Liste leer, sind alle Origins erlaubt; sonst akzeptiert der Endpoint Browser-Anfragen nur von den eingetragenen Origins (z. B. `https://www.strong-energy.de`).
- **Payload ist frei:** Es gibt **kein festes Feld-Schema.** Beliebige Formularfelder können unverändert als JSON-Objekt gesendet werden — die Zuordnung (Name, E-Mail, Anliegen …) übernimmt die KI-Extraktion. Bestehende Formulare brauchen also keine Feld-Umbenennung.

## Spezielle Felder

| Feld                  | Bedeutung                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `website`             | **Honeypot** — verstecktes Feld, muss leer bleiben. Füllt ein Bot es aus, wird die Anfrage scheinbar akzeptiert, aber verworfen.                                   |
| `request_id`          | Optional, per `crypto.randomUUID()` erzeugen. Macht Wiederholungsversuche (Retry nach Netzwerkfehler) idempotent — dieselbe `request_id` erzeugt nie zwei Tickets. |
| `subject` / `betreff` | Optional. Wird als Betreff der Nachricht übernommen; sonst „Kontaktformular: <Seitenname>".                                                                        |

## Antworten

| Status | Body                                           | Bedeutung                                                         |
| ------ | ---------------------------------------------- | ----------------------------------------------------------------- |
| `202`  | `{"status":"angenommen","correlation_id":"…"}` | Nachricht angenommen, Verarbeitung läuft.                         |
| `202`  | `{"status":"bereits_verarbeitet"}`             | Retry mit bekannter `request_id` — bereits angenommen, alles gut. |
| `400`  | `{"error":"…"}`                                | Body ist kein JSON-Objekt.                                        |
| `401`  | `{"error":"…"}`                                | API-Schlüssel fehlt, ist falsch oder deaktiviert.                 |
| `403`  | `{"error":"…"}`                                | Origin nicht in der erlaubten Liste.                              |
| `413`  | `{"error":"…"}`                                | Body größer als 50.000 Zeichen.                                   |
| `429`  | `{"error":"…"}`                                | Rate-Limit pro IP erreicht — kurz warten, erneut senden.          |

Alle Fehlermeldungen sind deutschsprachig und können dem Nutzer direkt angezeigt werden.

## Beispiel-Formular (HTML)

```html
<form id="kontakt-formular">
  <label>
    Name
    <input type="text" name="name" required />
  </label>
  <label>
    E-Mail
    <input type="email" name="email" required />
  </label>
  <label>
    Ihre Nachricht
    <textarea name="message" required></textarea>
  </label>

  <!-- Honeypot: für Menschen unsichtbar, muss leer bleiben -->
  <div style="position: absolute; left: -9999px" aria-hidden="true">
    <label>
      Website
      <input type="text" name="website" tabindex="-1" autocomplete="off" />
    </label>
  </div>

  <button type="submit">Absenden</button>
  <p id="kontakt-status" role="status"></p>
</form>
```

## Fetch-Snippet (Vanilla JS)

```html
<script>
  (function () {
    var ENDPOINT = 'https://strongenergy.zendori.ai/api/ingest/form';
    var API_KEY = 'zfk_…'; // Schlüssel aus dem Dashboard (Einstellungen → Formular-API-Keys)

    var form = document.getElementById('kontakt-formular');
    var status = document.getElementById('kontakt-status');

    // Eine request_id pro AUSFÜLLVORGANG (nicht pro Klick!): erst dadurch ist
    // der erneute Absende-Klick nach einem Fehler wirklich idempotent. Nach
    // erfolgreichem Versand wird sie für die nächste Nachricht erneuert.
    var requestId = crypto.randomUUID();

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      status.textContent = 'Wird gesendet …';

      // Alle Formularfelder 1:1 übernehmen — kein Feld-Mapping nötig.
      var payload = Object.fromEntries(new FormData(form));
      payload.request_id = requestId;

      try {
        var response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-zendori-key': API_KEY,
          },
          body: JSON.stringify(payload),
        });

        if (response.status === 202) {
          status.textContent = 'Vielen Dank! Ihre Nachricht wurde übermittelt.';
          form.reset();
          requestId = crypto.randomUUID(); // nächste Nachricht = neue ID
          return;
        }

        var data = await response.json().catch(function () {
          return {};
        });
        status.textContent =
          data.error || 'Leider ist ein Fehler aufgetreten. Bitte versuchen Sie es erneut.';
      } catch (err) {
        // Netzwerkfehler: derselbe Payload (inkl. request_id) kann gefahrlos
        // erneut gesendet werden.
        status.textContent =
          'Verbindung fehlgeschlagen. Bitte prüfen Sie Ihre Internetverbindung und versuchen Sie es erneut.';
      }
    });
  })();
</script>
```

Hinweis für Next.js-Seiten: Das Snippet funktioniert unverändert in einer Client-Komponente (`'use client'`); der `submit`-Handler wird dann als React-`onSubmit` registriert. Der API-Schlüssel ist bewusst für den Browser bestimmt (Schutz kommt aus Honeypot, Rate-Limit und CORS) — wer ihn dennoch nicht im Frontend haben möchte, kann den `fetch` alternativ über eine eigene Server-Route proxien.

## Checkliste

1. Im Dashboard unter **Einstellungen → Formular-API-Keys** einen Schlüssel anlegen, `site_label` und erlaubte Origins setzen, Klartext-Schlüssel kopieren.
2. Honeypot-Feld `website` (versteckt, leer) ins Formular aufnehmen.
3. Fetch-Snippet einbauen, `API_KEY` einsetzen, `request_id` via `crypto.randomUUID()` mitsenden.
4. Testabsendung: Antwort `202 {"status":"angenommen"}` und neue Nachricht im Dashboard-Posteingang (Kanal „Formular").
