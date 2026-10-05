# CONTEXT.md – Hochzeits-Foto-Upload (Google Apps Script + Google Drive)

Dieses Dokument ist die einzige Quelle der Wahrheit für den umsetzenden Agenten. Lies es vollständig, bevor du Code schreibst. Halte dich an die Stop-Punkte in Abschnitt 10. Sprache der Benutzeroberfläche und der Menschen-Doku: Deutsch. Code, Bezeichner und Kommentare: Englisch.

---

## 1. Ziel und Kontext

Gäste einer Hochzeit (ca. 85 Personen, Außen-Empfang, gemischtes Publikum mit iPhone und Android, teils ältere Gäste) scannen einen QR-Code und laden Fotos und Videos hoch. Die Dateien landen in einem privaten Google-Drive-Ordner des Brautpaars.

Randbedingungen:

- Kosten: 0 €. Nur Google-Bordmittel (Google Apps Script, Google Drive, Drive API v3).
- Gäste brauchen weder Google-Konto noch App noch Registrierung.
- Gäste sehen die Uploads anderer nicht und können nichts löschen oder verändern.
- Die Lösung muss auf schlechtem Mobilfunk (Außenlocation) robust sein: Abbrüche dürfen keinen Neustart großer Videos erzwingen.
- Der Nutzer ist technisch versiert, deployt aber selbst. Der Agent liefert Code und eine Schritt-für-Schritt-Anleitung, keinen Zugriff auf Google-Konten.

Warum nicht einfach ein Drive-Ordnerlink: Uploads in einen Drive-Ordner gehen nur mit Google-Login, und „Bearbeiter“-Freigaben erlauben Löschen und Umbenennen fremder Dateien. Genau das umgeht diese Lösung.

## 2. Nicht-Ziele

- Keine Galerie, keine Anzeige hochgeladener Dateien für Gäste.
- Keine Moderation, keine Benutzerverwaltung, kein Login.
- Keine Bildbearbeitung, keine Thumbnails, keine Transkodierung. Dateien bleiben unverändert.
- Keine Analytics, kein Tracking, keine Cookies, keine externen Skripte oder Schriftarten (kein CDN).
- Keine Zahlungs- oder Abo-Dienste.

## 3. Anforderungen

### 3.1 Funktional

- F1: Eine einzige Seite (Mobile First). Ein großer Button „Fotos & Videos auswählen“ öffnet die Dateiauswahl (`accept="image/*,video/*"`, `multiple`).
- F2: Optionales Textfeld „Dein Name“. Der Name fließt (bereinigt) in den Dateinamen ein.
- F3: Pro Datei Fortschrittsbalken, Status (wartet / lädt / fertig / Fehler) und Button „Erneut versuchen“ bei Fehler. Gesamtanzeige „X von Y hochgeladen“.
- F4: Uploads sind wiederaufnehmbar (Resumable Upload). Nach Netzabbruch geht es an der letzten bestätigten Stelle weiter.
- F5: Erlaubt sind nur Bilder und Videos. Maximale Dateigröße ist konfigurierbar (Standard 2048 MB).
- F6: Zugriffscode: Die Seite funktioniert nur mit dem richtigen Parameter `?k=<ACCESS_CODE>`. Ohne oder mit falschem Code zeigt sie „Dieser Link ist nicht gültig“.
- F7: Kill-Switch: Setzt der Besitzer die Script-Eigenschaft `ENABLED` auf `false`, zeigt die Seite „Der Upload ist beendet. Danke!“ und das Backend lehnt jede Anfrage ab. Ohne neues Deployment.
- F8: Dateinamen im Drive-Ordner: `YYYYMMDD-HHmmss_<Gastname>_<Originalname>` (Zeitzone Europe/Berlin). Ohne Gastname: `YYYYMMDD-HHmmss_<Originalname>`.

### 3.2 Nicht-funktional

- N1: Funktioniert auf iOS Safari (ab iOS 15) und Android Chrome, jeweils aktuelle und eine ältere Version.
- N2: Reines HTML/CSS/Vanilla-JS in einer Datei (`index.html`), keine Bibliotheken.
- N3: Touch-Ziele mindestens 48 px hoch, Schrift mindestens 16 px, hoher Kontrast, Hell- und Dunkelmodus egal.
- N4: Der Browser darf keinen Token, keinen `ACCESS_CODE`-Klartext aus Script Properties (nur den vom Gast per URL gelieferten Code) und keine Ordner-ID zu sehen bekommen.
- N5: Keine Abhängigkeit von `localStorage` oder Cookies (HtmlService-Sandbox kann sie blockieren).
- N6: Fehlermeldungen auf Deutsch, ohne Technikjargon, mit klarer Handlungsempfehlung („Verbindung unterbrochen. Wir versuchen es gleich noch einmal.“).

## 4. Architektur

### 4.1 Komponenten

| Komponente | Rolle |
| --- | --- |
| Google Apps Script Web-App | Läuft als Besitzer („Ausführen als: Ich“), öffentlich erreichbar („Zugriff: Jeder“, anonym). Liefert die Seite aus und erzeugt Upload-Sessions. |
| `index.html` | Frontend: Dateiauswahl, Fortschritt, Upload-Logik im Browser. |
| `Code.gs` | Backend: `doGet`, `createUploadSession`, optional `uploadChunk`. |
| Drive API v3 | Resumable Upload (`uploadType=resumable`), aufgerufen per `UrlFetchApp` mit `ScriptApp.getOAuthToken()`. |
| Drive-Ordner | Zielordner, privat. Ordner-ID liegt in Script Properties. |

### 4.2 Datenfluss (Modus `direct`, bevorzugt)

```
Gast-Handy                    Apps Script (Besitzer)              Google Drive API
    | 1. GET /exec?k=CODE            |                                  |
    |------------------------------->| doGet: prüft ENABLED + Code      |
    |<-------------------------------| liefert index.html               |
    | 2. google.script.run                                              |
    |    createUploadSession(meta) ->| prüft Code/Typ/Größe/Rate        |
    |                                | 3. POST uploadType=resumable --->|
    |                                |<---- 200 + Location: sessionUrl -|
    |<-- {ok, sessionUrl} -----------|                                  |
    | 4. PUT Chunk (Content-Range) direkt zu sessionUrl --------------->|
    |<------------------------------------------ 308 / 200 / 201 -------|
    | (wiederholen bis fertig; bei Abbruch Status per bytes */TOTAL)    |
```

Der OAuth-Token verlässt den Server nie. Die Session-URL ist die einzige Fähigkeit, die der Browser erhält, und gilt nur für diese eine Datei.

### 4.3 Upload-Modi

Konfigurierbar über Script Property `UPLOAD_MODE`:

- `direct` (Standard): Browser lädt Chunks per `XMLHttpRequest` direkt zur Session-URL. Schnell, belastet das Script-Kontingent kaum. **Abhängig davon, dass CORS für die Session-URL funktioniert (siehe Abschnitt 12).**
- `proxy` (Notausgang): Browser schickt Chunks (3 MiB, base64) per `google.script.run.uploadChunk(...)` an den Server, der sie per `PUT` an die Session-URL weiterreicht. Langsamer, verbraucht pro Chunk einen `UrlFetchApp`-Aufruf. Niedrigere Standardgröße (`MAX_FILE_MB_PROXY`, Standard 500).

Beide Modi müssen implementiert und per Property umschaltbar sein. Das Frontend erfährt den aktiven Modus vom Server (über `createUploadSession`-Antwort), nicht aus einer Konstante.

### 4.4 Variante B (optional, nur auf Anforderung des Nutzers)

Frontend auf statischem Host (GitHub Pages oder Cloudflare Pages), Apps Script nur als API (`fetch` mit `POST` und `Content-Type: text/plain`, um CORS-Preflight zu vermeiden). Vorteile: kein Google-Hinweisbanner, feste Origin für die Session-Anfrage. **Nicht bauen, solange der Nutzer das nicht ausdrücklich verlangt.**

## 5. Konfiguration (Script Properties)

Nie im Code hartcodieren. Der Besitzer setzt sie manuell in Projekteinstellungen → Skripteigenschaften.

| Name | Beispiel | Bedeutung |
| --- | --- | --- |
| `FOLDER_ID` | `1AbC…` | Drive-Ordner für alle Uploads. |
| `ACCESS_CODE` | `k7Qm2xPa9Zr4` | Zufälliger Code, wird im QR-Link als `?k=` mitgegeben. |
| `ENABLED` | `true` | Kill-Switch. Alles außer `true` schließt den Upload. |
| `UPLOAD_MODE` | `direct` | `direct` oder `proxy`. |
| `MAX_FILE_MB` | `2048` | Maximale Dateigröße im Modus `direct`. |
| `MAX_FILE_MB_PROXY` | `500` | Maximale Dateigröße im Modus `proxy`. |
| `RATE_LIMIT_PER_MIN` | `120` | Obergrenze für neue Sessions pro Minute (global). |

Texte, die der Nutzer ändern können soll, stehen als Konstanten am Anfang von `Code.gs`:

```js
const COUPLE_NAMES = '[Namen des Brautpaars]';
const CLOSING_DATE_TEXT = '[Datum, bis wann der Upload offen ist]';
```

## 6. Backend-Spezifikation (`src/Code.gs`)

### 6.1 `doGet(e)`

1. `ENABLED !== 'true'` → HTML „Upload beendet“ (HTTP 200, schlichte Seite, viewport-Meta).
2. `e.parameter.k !== ACCESS_CODE` → HTML „Dieser Link ist nicht gültig“.
3. Sonst: `HtmlService.createTemplateFromFile('index')`, Template-Variablen `coupleNames`, `closingDateText`, `code` (der vom Gast gelieferte Code, damit das Frontend ihn zurücksendet). `evaluate()`, dann `setTitle(...)` und `addMetaTag('viewport', 'width=device-width, initial-scale=1')`.

### 6.2 `createUploadSession(req)`

Eingabe (nur Primitive, `google.script.run` kann keine File-Objekte übergeben):

```js
{
  code: string,        // Zugriffscode aus der URL
  fileName: string,    // Originalname
  mimeType: string,    // kann leer sein
  size: number,        // Bytes
  guestName: string,   // optional, max. 40 Zeichen
  origin: string       // window.location.origin des Browsers
}
```

Ausgabe, **niemals werfen**, sondern Objekt zurückgeben (Fehler werfen verlieren bei `google.script.run` ihre Details):

```js
// Erfolg
{ ok: true, sessionUrl: string, storedName: string, mode: 'direct' | 'proxy', chunkSize: number }
// Fehler
{ ok: false, error: 'CLOSED' | 'BAD_CODE' | 'BAD_TYPE' | 'TOO_LARGE' | 'RATE_LIMIT' | 'DRIVE_ERROR', message: string }
```

Ablauf:

1. `ENABLED` prüfen, dann `code === ACCESS_CODE` (konstante Zeit ist hier nicht nötig).
2. MIME-Typ bestimmen: Wenn `mimeType` leer ist oder nicht mit `image/` oder `video/` beginnt, aus der Dateiendung ableiten. Erlaubte Endungen: `jpg, jpeg, png, gif, webp, heic, heif, mp4, mov, m4v, 3gp, webm`. Sonst `BAD_TYPE`.
3. Größe: `0 < size <= MAX` (je nach `UPLOAD_MODE`), sonst `TOO_LARGE`.
4. Rate-Limit: Zähler pro Minute in `CacheService.getScriptCache()` (Schlüssel mit Minutenstempel, TTL 120 s). Über `RATE_LIMIT_PER_MIN` → `RATE_LIMIT`. Ungenauigkeit ist akzeptabel.
5. Dateiname bauen (siehe F8). Bereinigung: Unicode-Buchstaben, Ziffern, Punkt, Bindestrich, Unterstrich, Leerzeichen erlaubt, alles andere → `_`; Länge insgesamt max. 150 Zeichen; keine Pfadtrenner.
6. Session bei Drive anlegen:
   - `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable`
   - Header: `Authorization: Bearer ` + `ScriptApp.getOAuthToken()`, `X-Upload-Content-Type: <mimeType>`, `X-Upload-Content-Length: <size>`, im Modus `direct` zusätzlich `Origin: <req.origin>` (nur akzeptieren, wenn es mit `https://` beginnt)
   - Body (JSON, `Content-Type: application/json; charset=UTF-8`): `{ "name": storedName, "parents": [FOLDER_ID] }`
   - `muteHttpExceptions: true`; Status 200 erwartet. Die Session-URL steht im Antwort-Header `Location` (Header-Namen case-insensitiv suchen).
7. Antwort wie oben. `chunkSize`: `direct` → 8 MiB (8 × 1024 × 1024), `proxy` → 3 MiB. Beide sind Vielfache von 256 KiB, wie die Drive API es verlangt.
8. Keine Session-URLs und keine Tokens loggen. Logge nur Fehlercodes und Statuscodes.

### 6.3 `uploadChunk(req)` (nur Modus `proxy`)

Eingabe: `{ code, sessionUrl, base64, start, total, mimeType }`. Ausgabe: `{ ok: true, done: boolean, nextOffset: number }` oder `{ ok: false, error, message }`.

- Validierung: `ENABLED`, `code`, und `sessionUrl` muss mit `https://www.googleapis.com/upload/drive/v3/files?` beginnen (Schutz gegen SSRF).
- Chunk dekodieren (`Utilities.base64Decode`), `UrlFetchApp.fetch(sessionUrl, { method: 'put', payload: bytes, contentType: mimeType, headers: { 'Content-Range': 'bytes START-END/TOTAL' }, followRedirects: false, muteHttpExceptions: true })`. **`followRedirects: false` ist Pflicht**, weil `308` sonst als Redirect behandelt werden kann.
- Status `308` → `done: false`, `nextOffset` aus dem `Range`-Header (`bytes=0-N` → `N + 1`; fehlt der Header, ist `nextOffset = 0`). Status `200` oder `201` → `done: true`.

### 6.4 Hilfsfunktionen

- `getProp_(name)`, `isEnabled_()`, `sanitize_(str, maxLen)`, `guessMime_(fileName)`, `formatTs_(date)` (Europe/Berlin), `errorResult_(code, message)`.
- Eine Funktion `testAuth()` ohne Seiteneffekte, die `DriveApp`-unabhängig nur `ScriptApp.getOAuthToken()` und `UrlFetchApp` berührt, damit der Besitzer den Autorisierungsdialog einmal auslösen kann.

## 7. Frontend-Spezifikation (`src/index.html`)

### 7.1 Aufbau

- Kopfbereich: Titel „Teilt eure Fotos und Videos“ plus Untertitel mit `coupleNames`.
- Großer Button „Fotos & Videos auswählen“ (öffnet verstecktes `<input type="file" accept="image/*,video/*" multiple>`).
- Feld „Dein Name (optional)“.
- Dateiliste: pro Datei Name (gekürzt), Größe, Fortschrittsbalken, Statustext, bei Fehler Button „Erneut versuchen“.
- Gesamtzeile „3 von 5 fertig“ und, wenn alle fertig sind, eine freundliche Bestätigung („Danke! Eure Dateien sind angekommen. Noch mehr? Einfach wieder auswählen.“).
- Hinweis unter dem Button: „Bitte lasst diese Seite geöffnet, bis alles fertig ist. Kein Empfang? Ihr könnt auch später hochladen, der Link gilt bis `closingDateText`.“
- Datenschutzzeile: „Eure Dateien landen in einem privaten Ordner des Brautpaars. Niemand sonst sieht sie.“
- Fehlerfälle als Texte: `BAD_TYPE` → „Diese Datei ist kein Foto oder Video.“, `TOO_LARGE` → „Diese Datei ist zu groß.“, `RATE_LIMIT` → „Gerade ist viel los, wir versuchen es gleich noch einmal.“ (automatischer Retry), `CLOSED` → „Der Upload ist beendet.“

### 7.2 Upload-Algorithmus pro Datei

1. `google.script.run.withSuccessHandler(...).withFailureHandler(...).createUploadSession({ code, fileName, mimeType: file.type, size: file.size, guestName, origin: window.location.origin })`.
2. Bei `ok: false`: Fehlertext aus der Tabelle oben anzeigen. `RATE_LIMIT` und Netzwerkfehler automatisch mit Backoff wiederholen, die übrigen Fehler als endgültig anzeigen.
3. Modus `direct`: Chunks mit `file.slice(start, end)` per `XMLHttpRequest` `PUT` an `sessionUrl` senden, Header `Content-Range: bytes start-(end-1)/size`. Fortschritt über `xhr.upload.onprogress` plus bestätigte Bytes. Antwort `308` → nächster Chunk, `200` oder `201` → fertig.
4. Modus `proxy`: Chunk als base64 (z. B. per `FileReader.readAsDataURL`, Präfix abtrennen) an `google.script.run.uploadChunk(...)`. Bei `done: true` fertig, sonst nächster Chunk ab `nextOffset`.
5. Wiederaufnahme (`direct`): Bei Netzfehler, Timeout oder 5xx wartet der Client 1, 2, 4, 8, 16 s (maximal 5 Versuche), fragt dann den Stand ab (`PUT` mit leerem Body und `Content-Range: bytes */size`) und macht ab der bestätigten Position weiter. `308` mit Header `Range: bytes=0-N` → weiter bei `N + 1`; `308` ohne `Range` → bei 0 beginnen; `200`/`201` → bereits fertig. Antwortet die Session mit `404`, ist sie abgelaufen: neue Session holen und von vorn beginnen. Ist der `Range`-Header im Browser nicht lesbar (CORS), muss der Client mit dem selbst geführten, zuletzt bestätigten Offset arbeiten.
6. Nebenläufigkeit: höchstens 2 Dateien gleichzeitig, Videos (`file.type` beginnt mit `video/`) einzeln. Größte Dateien zuletzt.
7. Während Uploads laufen: `beforeunload`-Warnung und, wenn verfügbar, `navigator.wakeLock.request('screen')` (Fehler ignorieren, im iframe nicht garantiert).
8. Bei langen iOS-Videos zeigt die Auswahl oft „Wird vorbereitet“: Statustext „Bereite Datei vor …“ anzeigen, solange die Auswahl noch nicht fertig ist.

## 8. Sicherheit

- Token (`ScriptApp.getOAuthToken()`) nie an den Browser geben.
- Ordner-ID und `ACCESS_CODE` nur in Script Properties, nicht im Code und nicht im Repository.
- Der Code im QR-Link schützt gegen zufällige Besucher und Bots, nicht gegen Gäste, die den Link weitergeben. Das ist akzeptiert.
- Serverseitig immer validieren (Code, Typ, Größe), auch wenn das Frontend es schon tut.
- `uploadChunk` darf nur Drive-Upload-Sessions ansprechen (Präfixprüfung der URL).
- Keine Session-URLs, keine Tokens, keine Gastnamen in Logs. Der Gastname wird nur im Dateinamen verwendet.
- OAuth-Scopes im Manifest nicht erweitern: nur `drive` und `script.external_request`. Begründung: Mit `drive.file` kann das Anlegen von Dateien in einem bestehenden, nicht von der App erstellten Ordner scheitern. Das Konto ist ein eigens angelegtes Hochzeitskonto, das nur den Upload-Ordner enthält.

## 9. Projektstruktur und Deployment

```
.
├── CONTEXT.md             (diese Datei)
├── README.md              (Anleitung für den Menschen, Deutsch)
├── package.json           (optional: clasp als devDependency, Skripte)
├── .clasp.json.example    (optional, scriptId als Platzhalter)
└── src/
    ├── appsscript.json
    ├── Code.gs
    └── index.html
```

`src/appsscript.json`:

```json
{
  "timeZone": "Europe/Berlin",
  "runtimeVersion": "V8",
  "exceptionLogging": "STACKDRIVER",
  "webapp": {
    "executeAs": "USER_DEPLOYING",
    "access": "ANYONE_ANONYMOUS"
  },
  "oauthScopes": [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/script.external_request"
  ]
}
```

Deployment-Regeln (in `README.md` ausführlich erklären):

- Es gibt genau eine produktive Bereitstellung. Änderungen gehen als neue Version derselben Bereitstellung live (Editor: „Bereitstellungen verwalten“ → Bereitstellung bearbeiten → „Neue Version“; mit clasp: `clasp deploy --deploymentId <ID>`). **Niemals eine neue Bereitstellung anlegen, wenn der QR-Code schon gedruckt ist, denn die URL ändert sich.**
- Die URL für den QR-Code endet auf `/exec` und trägt `?k=<ACCESS_CODE>`. Die `/dev`-URL ist nur für den Besitzer.
- Wenn clasp genutzt wird: Der Agent bereitet Dateien und Skripte vor, aber `clasp login` und das Anlegen des Projekts macht der Mensch.

## 10. Arbeitsplan für den Agenten (mit Stop-Punkten)

**Phase 0: Prototyp (Spike).** Baue die kleinste Version, die Abschnitt 12 beantwortet: `Code.gs` mit `doGet` und `createUploadSession`, `index.html` mit Dateifeld, Chunk-Upload im Modus `direct` und Konsolenausgabe von Statuscodes. Keine Oberfläche, kein Design.
**STOP 1:** Lege dem Menschen die Testanleitung (Abschnitt 11, Teil A) vor und warte auf die Ergebnisse. Baue nichts darüber hinaus, bis klar ist, ob `direct` funktioniert.

**Phase 1: Vollständige Implementierung.**
- Wenn `direct` funktioniert: Modus `direct` fertigstellen, `proxy` als Notausgang mitliefern (per Property umschaltbar, aber nicht der Standard).
- Wenn `direct` scheitert: `proxy` zum Standard machen und `direct` entfernen oder deaktivieren. Dokumentiere die Ursache (Statuscodes, Konsolenmeldungen) im README.
- Alle Funktionen und Texte aus Abschnitt 3, 6 und 7 umsetzen. `README.md` auf Deutsch mit Einrichtung, Deployment, QR-Code-Hinweisen und Kill-Switch.
**STOP 2:** Gib dem Menschen die Checkliste aus Abschnitt 11, Teil B und warte auf Rückmeldung zu Fehlern.

**Phase 2: Korrekturen und Härtung** auf Basis der Testergebnisse. Danach Code einfrieren.

**Phase 3 (nur auf Wunsch):** Variante B (Abschnitt 4.4).

Regeln für dich:

- Frage nach, wenn eine Anforderung widersprüchlich oder unklar ist, statt zu raten.
- Keine zusätzlichen Features, keine neuen Abhängigkeiten, keine externen Dienste.
- Jede Annahme, die du nicht prüfen kannst (Google-Verhalten, CORS, Header), als offene Annahme im README festhalten.

## 11. Abnahmekriterien und Tests

**Teil A: Prototyp (Mensch führt aus)**

- [ ] Die Session-Anfrage mit `Origin`-Header klappt aus `UrlFetchApp` heraus (Status 200, `Location`-Header vorhanden).
- [ ] Der `PUT` vom Browser zur Session-URL läuft ohne CORS-Fehler (Konsole beobachten, auch im Apps-Script-iframe).
- [ ] Ein Video von mindestens 500 MB lädt vollständig hoch, auf iPhone (Safari) und auf Android (Chrome).
- [ ] Der Statusabruf (`bytes */TOTAL`) liefert im Browser lesbare Ergebnisse (insbesondere der `Range`-Header).

**Teil B: Vollständige Tests (Mensch führt aus)**

- [ ] iPhone (Safari): ein Foto, 20 Fotos auf einmal, ein Video über 500 MB
- [ ] Android (Chrome): dieselben drei Fälle
- [ ] Flugmodus während des Uploads an- und ausschalten: Upload setzt fort
- [ ] Mobilfunk statt WLAN, zusätzlich gedrosselt in den DevTools
- [ ] Fehlender oder falscher `k`-Parameter: Seite lehnt ab
- [ ] Nicht erlaubter Dateityp (`.zip`, `.exe`): wird abgelehnt
- [ ] Datei über `MAX_FILE_MB`: verständliche Fehlermeldung
- [ ] Dateinamen mit Umlauten, Leerzeichen, Emojis: Ergebnis im Drive sauber benannt
- [ ] Mindestens 10 Handys gleichzeitig
- [ ] Kill-Switch (`ENABLED=false`) schließt Seite und Backend
- [ ] Dateien im Ordner sind vollständig, abspielbar, in Originalqualität
- [ ] „Ausführungen“ im Apps-Script-Editor zeigen keine unerwarteten Fehler
- [ ] Umschalten `UPLOAD_MODE=proxy` funktioniert mit einem 100-MB-Video

**Definition of Done:** Alle Kästchen in Teil B sind abgehakt, README ist vollständig, und der Mensch hat den QR-Code mit drei verschiedenen Handys erfolgreich gescannt.

## 12. Bekannte Unsicherheiten (im Prototyp prüfen)

1. **CORS auf der Session-URL.** Ob der Browser direkt zur Drive-Session-URL hochladen darf, hängt nach meinem Kenntnisstand vom `Origin`-Header ab, der bei der Session-Anfrage gesetzt wurde. Offen: Erlaubt `UrlFetchApp` das Setzen von `Origin`? Akzeptiert Drive den Origin der Apps-Script-Sandbox (eine dynamische `*.googleusercontent.com`-Domain)? Wenn nicht: Modus `proxy` oder Variante B (feste Origin).
2. **`Range`-Header im Browser lesbar?** Wenn Drive ihn nicht per `Access-Control-Expose-Headers` freigibt, muss der Client den bestätigten Offset selbst mitführen.
3. **Status `308` in XHR.** Prüfen, dass der Browser die Antwort als normale Antwort liefert (und nicht als Redirect behandelt).
4. **Verbindungen vom iframe.** Prüfen, dass die HtmlService-Sandbox Verbindungen zu `googleapis.com` zulässt.
5. **Quoten.** `UrlFetchApp`-Aufrufe pro Tag (private Konten ca. 20.000, in der aktuellen Apps-Script-Quotenliste prüfen) und gleichzeitige Ausführungen (ca. 30). Im Modus `direct` unkritisch, im Modus `proxy` relevant.
6. **Google-Hinweisbanner.** Bei privaten Konten zeigt die Web-App einen Hinweis „Diese Anwendung wurde von einem anderen Nutzer erstellt“. Nicht änderbar; nur über Variante B vermeidbar.

## 13. Aufgaben für den Menschen (nicht für den Agenten)

- Google-Konto nur für die Hochzeit anlegen (2-Faktor, Recovery-Mail), Drive-Ordner anlegen, Ordner-ID notieren, Ordner mit dem Brautpaar als „Bearbeiter“ teilen.
- Apps-Script-Projekt anlegen, Dateien aus `src/` einfügen, Script Properties setzen, einmal `testAuth()` ausführen und autorisieren („Google hat diese App nicht überprüft“ → „Erweitert“ → „Zu … (unsicher)“).
- Bereitstellen (Web-App, Ausführen als: Ich, Zugriff: Jeder), `/exec`-URL notieren.
- Tests auf echten Handys durchführen und Ergebnisse an den Agenten zurückgeben.
- QR-Code mit einem statischen Generator erzeugen (z. B. QRCode Monkey, SVG, Fehlerkorrektur M), Schilder drucken, mit drei Handys testen.
- Vor der Hochzeit prüfen, wie viel Drive-Speicher frei ist (15 GB kostenlos).
- Nach der Hochzeit: Dateien sichern, `ENABLED=false` setzen, Bereitstellung archivieren.
