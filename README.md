# Hochzeits-Foto-Upload

Gäste scannen einen QR-Code und laden Fotos und Videos ohne Konto und ohne App in einen privaten Google-Drive-Ordner hoch. In einer geschützten Galerie können sich alle Gäste die Fotos und Videos ansehen (Abschnitt 10). Technik: Google Apps Script als Web-App, Drive API (Resumable Upload). Kosten: 0 €.

Stand: Upload live auf GitHub Pages und auf echten Handys getestet. Die Galerie mit Benutzername und Passwort ist lokal gegen eine simulierte Drive-API getestet (44 Tests) und im Browser durchgespielt; der Test auf echten Handys steht noch aus (Abschnitt 10).

## Inhalt

```
src/appsscript.json   Manifest (Web-App, Berechtigungen)
src/Code.gs           Backend
src/index.html        Upload-Seite
src/gallery.html      Galerie-Seite
tools/build-pages.js  Baut Upload-Seite und Galerie für GitHub Pages (Variante B)
tools/setup-github.sh Legt Repo, Secret und GitHub Pages an
.github/workflows/    Veröffentlicht die Seite bei jedem Push
test/run-tests.js     Lokale Tests (node test/run-tests.js)
CONTEXT.md            Anforderungen und Architektur
```

## 1. Einmalige Einrichtung

### 1.1 Google-Konto und Ordner

1. Ein Google-Konto nur für die Hochzeit anlegen, mit 2-Faktor-Authentifizierung und Recovery-Mail.
2. In Drive einen Ordner anlegen, z. B. „Hochzeit – Uploads“. Die Ordner-ID ist der Teil der URL nach `/folders/`.
3. Den Ordner mit dem Brautpaar als „Bearbeiter“ teilen. Der Ordner bleibt „Eingeschränkt“, ohne öffentlichen Link.

### 1.2 Apps-Script-Projekt

Im Hochzeitskonto unter [script.google.com](https://script.google.com) „Neues Projekt“ anlegen und „Hochzeit-Upload“ nennen. Dann entweder per Hand oder mit clasp.

**Per Hand (einfacher):**

1. Projekteinstellungen (Zahnrad) → „appsscript.json-Manifestdatei im Editor anzeigen“ aktivieren.
2. Inhalt von `src/appsscript.json` in `appsscript.json` einfügen. Der Block `dependencies` schaltet die Drive API ein, `oauthScopes` gibt dem Script die Drive-Rechte. Fehlt eines davon, meldet `testAuth` Status 403. Alternativ links bei „Dienste“ auf das Plus klicken und „Drive API“ (v3) hinzufügen.
3. Inhalt von `src/Code.gs` in `Code.gs` einfügen.
4. Neue HTML-Datei `index` anlegen (der Editor ergänzt `.html`) und `src/index.html` einfügen.
5. Optional, only for the gallery fallback address: create an HTML file `gallery` and paste `src/gallery.html` (see section 10).

**Mit clasp (optional):**

```
npm install
npx clasp login
cp .clasp.json.example .clasp.json    # scriptId aus den Projekteinstellungen eintragen
npx clasp push
```

### 1.3 Texte anpassen

Oben in `Code.gs`:

```js
const COUPLE_NAMES = 'Raphael & Olivia';
const CLOSING_DATE_TEXT = 'vier Wochen nach der Hochzeit';   // oder ein festes Datum, z. B. '10. Juli 2027'
```

### 1.4 Script Properties

Projekteinstellungen → Skripteigenschaften:

| Name | Wert | Hinweis |
| --- | --- | --- |
| `FOLDER_ID` | Ordner-ID aus 1.1 | Pflicht |
| `ACCESS_CODE` | zufällig, mind. 10 Zeichen, nur `A–Z a–z 0–9 - _` | Pflicht, steht im QR-Link |
| `ENABLED` | `true` | Kill-Switch, alles andere schließt den Upload |
| `UPLOAD_MODE` | `direct` | oder `proxy` (Notausgang, siehe 5) |
| `MAX_FILE_MB` | `2048` | Maximale Dateigröße im Modus `direct` |
| `MAX_FILE_MB_PROXY` | `500` | Maximale Dateigröße im Modus `proxy` |
| `PROXY_CHUNK_MB` | `8` | Stückgröße im Modus `proxy` (1–32). Größer = weniger Umwege, aber jeder Schritt dauert länger |
| `RATE_LIMIT_PER_MIN` | `120` | Neue Uploads pro Minute insgesamt |

Ein Zufallscode lässt sich z. B. im Terminal erzeugen: `openssl rand -base64 12 | tr -dc 'A-Za-z0-9' | head -c 14`.

### 1.5 Autorisieren und prüfen

Im Editor die Funktion `testAuth` auswählen und „Ausführen“. Beim ersten Mal erscheint „Google hat diese App nicht überprüft“: „Erweitert“ → „Zu Hochzeit-Upload (unsicher)“ → zulassen. Das ist bei einem eigenen Script normal.

Im Ausführungsprotokoll sollte „Ordner gefunden“ und „Alles in Ordnung.“ stehen. Sonst listet `testAuth` die Probleme auf. Die Funktion verändert nichts.

## 2. Live schalten

**Firebase oder ein anderer Hoster ist nicht nötig.** Apps Script hostet die Seite selbst: Mit der Bereitstellung als Web-App (Schritte unten) ist alles live. Die `/exec`-URL ist die öffentliche Adresse, Kosten 0 €. Firebase Hosting käme erst bei „Variante B“ ins Spiel (eigene Seite statt Google-Hinweisbanner), und die ist nur nötig, wenn der Test in Abschnitt 4 zeigt, dass es anders nicht geht.

Kurzfassung der Reihenfolge: 1.1 bis 1.5 erledigen, dann die Bereitstellung unten anlegen, dann Teil A der Tests mit `&debug=1`, dann den QR-Code erzeugen.

## 2a. Veröffentlichen

1. „Bereitstellen“ → „Neue Bereitstellung“ → Typ „Web-App“.
2. Ausführen als: **Ich**. Zugriff: **Jeder**. Beschreibung: `v1`.
3. Die URL kopieren, die auf `/exec` endet.
4. Der Gäste-Link lautet: `<exec-URL>?k=<ACCESS_CODE>`

**Wichtig:** Es gibt nur diese eine Bereitstellung. Änderungen gehen so live: „Bereitstellen“ → „Bereitstellungen verwalten“ → Stift-Symbol → Version „Neue Version“ → „Bereitstellen“. Mit clasp: `npx clasp push` und dann `DEPLOYMENT_ID=<ID> npm run deploy`. **Niemals eine neue Bereitstellung anlegen, sobald der QR-Code gedruckt ist, denn dann ändert sich die URL.**

Die `/dev`-URL funktioniert nur für euch selbst, nicht für Gäste.

## 3. Debug-Modus

Mit `&debug=1` am Link zeigt die Seite unten ein Protokoll: Upload-Modus, Statuscodes jedes Chunks, `Range`-Antworten, Fehler. Session-URLs und Codes werden darin nicht angezeigt. Ideal für die Tests am Handy ohne Entwicklertools. Für den QR-Code den Link **ohne** `debug` verwenden.

## 4. Tests

### Teil A: Funktioniert der direkte Upload? (zuerst, ca. 1 h)

Das ist die eine Annahme, die ich lokal nicht prüfen kann: ob der Browser aus der Apps-Script-Seite direkt zu Google hochladen darf (CORS). Testet mit `&debug=1`:

- [ ] Foto hochladen am Rechner (Chrome): Im Protokoll steht `session ok, mode=direct` und danach `PUT … → 200`. Datei liegt im Drive-Ordner.
- [ ] Gleiches am iPhone (Safari) und an einem Android-Handy (Chrome).
- [ ] Video mit mindestens 500 MB: im Protokoll eine Reihe von `→ 308 bytes=0-…` und am Ende `→ 200`.
- [ ] Steht bei den `308`-Zeilen ein `bytes=0-…` dabei? Wenn nein, kann der Browser den `Range`-Header nicht lesen. Das Programm kommt damit zurecht, aber gebt mir Bescheid.

**Was ich danach wissen muss:** die Protokollzeilen von einem fehlgeschlagenen Versuch (Screenshot reicht). Typische Fehlerbilder:

- `PUT … failed: network` direkt beim ersten Chunk → CORS blockiert. Dann `UPLOAD_MODE` auf `proxy` setzen und erneut testen (Videos dann max. 500 MB, langsamer). Alternativ eine eigene Seite außerhalb von Apps Script (Variante B in `CONTEXT.md`), dafür brauche ich euer Okay.
- `createUploadSession error: DRIVE_ERROR` → im Apps-Script-Editor unter „Ausführungen“ steht der Statuscode von Drive.

### Teil B: Vollständige Tests (ca. 1–2 h)

- [ ] iPhone (Safari): ein Foto, 20 Fotos auf einmal, ein Video über 500 MB
- [ ] Android (Chrome): dieselben drei Fälle
- [ ] Flugmodus während des Uploads an und wieder aus: Upload läuft weiter
- [ ] Mobilfunk statt WLAN; am Rechner zusätzlich mit gedrosseltem Netz (DevTools → Network → „Slow 4G“)
- [ ] Link ohne `k` oder mit falschem Code: „Dieser Link ist nicht gültig“
- [ ] `.zip` oder `.pdf` auswählen (am Rechner): „Diese Datei ist kein Foto oder Video.“
- [ ] `MAX_FILE_MB` kurz auf `1` setzen, Video wählen: „Diese Datei ist zu groß.“ (danach zurücksetzen)
- [ ] Name mit Umlauten und Emoji: Datei heißt im Drive z. B. `20270612-153045_Jürgen_IMG_1234.jpg`
- [ ] Mindestens 10 Handys gleichzeitig (Freunde einspannen)
- [ ] `ENABLED` auf `false`: Seite zeigt „Der Upload ist beendet“, laufende Uploads stoppen
- [ ] Dateien im Ordner vollständig und abspielbar, in Originalqualität
- [ ] „Ausführungen“ im Editor ohne unerwartete Fehler
- [ ] `UPLOAD_MODE=proxy` mit einem 100-MB-Video

### Lokale Tests

```
node test/run-tests.js
```

Prüft Validierung, Dateinamen, Galerie-Zugriffsschutz (falscher Code, gefälschte und abgelaufene Tokens, fremde Dateien), Video-Streaming in Stücken, Kill-Switch, Rate-Limit, SSRF-Schutz und den Upload-Ablauf gegen eine simulierte Drive-API, inklusive abgebrochener Verbindungen, verlorener Antworten, teilweise gespeicherter Chunks, abgelaufener Sessions, Offline-Phasen und Moduswechsel. Benötigt nur Node.js 18+.

## 5. Upload-Modi

| | `direct` (Standard) | `proxy` (Notausgang) |
| --- | --- | --- |
| Weg | Browser → Google direkt | Browser → Apps Script → Google |
| Tempo | voll | spürbar langsamer |
| Max. Datei | `MAX_FILE_MB` (2048) | `MAX_FILE_MB_PROXY` (500) |
| Apps-Script-Kontingent | 1 Aufruf pro Datei | 1 Aufruf pro `PROXY_CHUNK_MB` (Standard 8 MB) |

Umschalten über die Script Property `UPLOAD_MODE`, ohne neue Version. Laufende Uploads starten im neuen Modus neu.

Kontingent im Modus `proxy`: Ein 100-MB-Video braucht bei 8 MB pro Stück 13 Abrufe. Das Tageslimit für private Konten liegt laut Google bei ca. 20.000 `UrlFetchApp`-Aufrufen (bitte in der aktuellen [Quotenliste](https://developers.google.com/apps-script/guides/services/quotas) prüfen).

**Warum `proxy` langsam ist:** Jedes Stück geht vom Handy als Text (ein Drittel größer) an Googles Script-Server, startet dort eine Script-Ausführung und wird dann an Drive weitergereicht. Jeder dieser Schritte kostet einige Sekunden, unabhängig von eurer Leitung. Im Modus `direct` geht die Datei ohne Umweg zu Drive. Das Debug-Protokoll zeigt pro Stück Dauer und MB/s.

## 6. QR-Code

1. Gäste-Link aus Abschnitt 2 nehmen, ohne `debug`.
2. Mit einem statischen Generator erzeugen, z. B. [QRCode Monkey](https://www.qrcode-monkey.com), als SVG, Fehlerkorrektur „M“. Keine dynamischen Codes mit Testphase.
3. Der Link ist lang, das Muster wird dicht: auf Tischkarten mindestens 4 × 4 cm, besser 5 × 5 cm.
4. Vor dem Druck mit drei verschiedenen Handys aus 30 cm und 1 m scannen.
5. Auf dem Schild erwähnen, dass oben ein Google-Hinweis erscheinen kann („Die Seite ist von uns, der Hinweis ist normal“).

## 7. Am Tag und danach

- Am Morgen: `ENABLED=true`, ein Testupload, freien Drive-Speicher prüfen (15 GB kostenlos).
- Nach der Hochzeit: Ordner herunterladen und doppelt sichern. Nach dem Stichtag `ENABLED=false` setzen und die Bereitstellung archivieren.

## 8. Offene Annahmen

Diese Punkte konnte ich ohne echtes Google-Konto nicht prüfen. Teil A klärt die ersten vier.

1. **CORS:** Drive erlaubt den direkten Upload aus der Apps-Script-Seite, wenn bei der Session-Anfrage der `Origin`-Header der Seite mitgeschickt wird. Unklar, ob `UrlFetchApp` diesen Header durchreicht und ob Drive die wechselnde `*.googleusercontent.com`-Domain akzeptiert.
2. **`Range`-Header:** Unklar, ob der Browser ihn lesen darf. Ohne ihn zählt die Seite selbst mit. Geht in diesem Fall eine Antwort verloren, nachdem Drive den Chunk schon gespeichert hat, startet die Datei mit einer neuen Session von vorn, statt beschädigt zu werden. Bei großen Videos kostet das Zeit.
3. **Status 308:** Annahme, dass der Browser Drives 308 (ohne `Location`) nicht als Weiterleitung behandelt.
4. **Verbindungen aus dem iframe:** Annahme, dass die Apps-Script-Sandbox Verbindungen zu `www.googleapis.com` erlaubt.
5. **Abweichender Start-Offset:** Annahme, dass Drive einen Chunk mit falschem Startbyte ablehnt (statt ihn falsch einzufügen). In den lokalen Tests ist das so simuliert.
6. **Wake Lock:** Bildschirm-Sperre verhindern klappt im Apps-Script-iframe möglicherweise nicht. Deshalb der Hinweis „Seite geöffnet lassen“.
7. **Google-Hinweisbanner** bei privaten Konten ist nicht abschaltbar, nur mit Variante B vermeidbar.

## 9. Fehlersuche

| Beobachtung | Ursache und Lösung |
| --- | --- |
| „Datei kann derzeit nicht geöffnet werden“ im normalen Browserfenster, im privaten Fenster geht es | Der Browser ist in mehrere Google-Konten angemeldet. Lösung: Variante B (Abschnitt 11), die Gäste-Seite liegt dann auf GitHub Pages. |
| Debug-Protokoll zeigt `createUploadSession error: DRIVE_ERROR` | `testAuth` ausführen. Status 403: Drive API und `oauthScopes` im Manifest prüfen, Ordner und Script im selben Konto? Status 404: `FOLDER_ID` prüfen (nur der Teil nach `/folders/`). |
| Protokoll zeigt `PUT … failed: network` im Modus `direct` | Browser darf nicht direkt zu Google hochladen (CORS). `UPLOAD_MODE` auf `proxy` setzen. |
| Änderung wirkt nicht | Nach jeder Code-Änderung eine neue Version der bestehenden Bereitstellung anlegen („Bereitstellungen verwalten“, Stift, „Neue Version“). Änderungen an Script-Eigenschaften gelten sofort. |

## 10. Galerie (gallery)

Guests see every photo and video from the upload folder, newest first: photos open full size, videos play in the page, and every original can be saved. The gallery is independent of the upload: it can stay open while `ENABLED=false`.

- **Address for guests:** `https://hochzeitoliviaraphael-art.github.io/galerie/` (GitHub Pages, works with several Google accounts signed in).
- The Apps Script address `…/exec?view=galerie` serves the same page as a fallback, but fails on phones signed in to several Google accounts.

### Access protection

- **User name and password:** The gallery opens only with `GALLERY_USER` and `GALLERY_PASSWORD`. The user name ignores upper/lower case (phones like to capitalize the first letter); the password is case-sensitive. The upload code from the QR code does not open the gallery.
- **Where the login lives:** Only in the Apps Script Script Properties. It is *not* a GitHub secret on purpose: everything GitHub Actions puts into the page is readable by anyone who opens it, so a password baked into the page would protect nothing. The page sends the login to Apps Script, which checks it on the server. The public repo and the published page contain no login data (checked by the tests).
- **Time-limited access:** After a correct login the phone gets a signed token that expires after `GALLERY_SESSION_HOURS` (default 24 h). Changing the user name or the password logs out everyone immediately, including phones that are already signed in. Guests can also sign out with "Abmelden".
- **Guessing is slowed down:** After 30 wrong logins within 10 minutes the login is locked for everyone for a while, and each wrong attempt waits almost a second.
- **This folder only:** The server only returns photos and videos that sit directly in `FOLDER_ID` and are not in the trash. Other files in the Google account are unreachable, even with guessed IDs.
- **Nothing becomes public:** The folder stays "Restricted". Images and videos are streamed through the script; guests never see Drive links or file names.
- **Kill switch:** `GALLERY_ENABLED=false` closes the gallery immediately, also for signed-in guests.

### Setup

1. In Apps Script: replace `Code.gs` with the new version. Optional, only for the fallback address: create an HTML file `gallery` and paste `src/gallery.html`.
2. Add Script Properties ("Project settings" → "Script properties"):

| Name | Value | Note |
| --- | --- | --- |
| `GALLERY_ENABLED` | `true` | Gallery on or off, applies immediately |
| `GALLERY_USER` | at least 3 characters, e.g. `gaeste` | Case is ignored |
| `GALLERY_PASSWORD` | at least 10 characters | Case-sensitive. Must differ from `ACCESS_CODE`. |
| `GALLERY_SESSION_HOURS` | `24` | optional, how long a phone stays signed in |
| `GALLERY_MAX_FILE_MB` | `300` | optional, larger videos cannot be played or saved in the gallery |
| `GALLERY_RATE_LIMIT_PER_MIN` | `900` | optional, gallery calls per minute for all guests together |

   `GALLERY_CODE` from an earlier version is no longer used; delete it.
3. Run `testAuth`: it reports a missing or too short user name or password.
4. Create a new version of the existing deployment ("Manage deployments", pencil, "New version"). The address stays the same, so nothing changes on GitHub.
5. The gallery page itself is published by GitHub Actions on every push to `main` (built from `src/gallery.html` into `dist/galerie/`).

### Hiding photos

Move a file in Drive into a subfolder (e.g. "Ausgeblendet") or into the trash. It disappears from the gallery within 5 minutes.

### Limits

- **Speed:** Thumbnails come in batches and are cached for 6 hours. Videos are loaded through the script in 8 MB pieces; a 100 MB video needs roughly 30 seconds to 2 minutes before it plays, depending on the network.
- **Corporate networks:** Some company networks delay every Apps Script answer by about 20 seconds (seen during testing). On mobile data the same calls take 1–2 seconds.
- **Many guests at once:** Apps Script handles a limited number of simultaneous calls per account (about 30). The page sends at most two requests in parallel per guest and retries rejected calls automatically. With very many guests at the same time it can stall briefly.
- **Quota:** Every thumbnail batch and every video piece counts against the daily `UrlFetchApp` limit (section 5).
- **New uploads without a preview:** Drive needs a few minutes after an upload to create thumbnails, especially for videos and HEIC. Until then the tile shows "Vorschau folgt".
- **Saving on iPhone:** Depending on the iOS version, "Original speichern" opens the file; it is then saved via "Share" → "Save to Photos".
- **Video formats:** The browser plays the original file. iPhone videos (`.mov`, HEVC) may not play in some Android browsers; "Original speichern" still works.

### Testing (about 15 minutes)

- [ ] Open the gallery address: login form appears; a wrong password shows "Benutzername oder Passwort stimmt nicht."
- [ ] Correct login: grid with thumbnails, newest first
- [ ] Open a photo, swipe, "Original speichern" on iPhone and Android
- [ ] Play a video
- [ ] Reload: still signed in. "Abmelden": back to the login form
- [ ] Change `GALLERY_PASSWORD`: a signed-in phone lands on the login form on its next action
- [ ] `GALLERY_ENABLED=false`: the gallery is closed

## 11. Variante B: Upload-Seite auf GitHub Pages

**Warum:** Ist ein Handy in mehrere Google-Konten angemeldet, zeigt Google statt der Apps-Script-Seite „Datei kann derzeit nicht geöffnet werden“. Bei Variante B liegt die Upload-Seite auf GitHub Pages unter `https://hochzeitoliviaraphael-art.github.io/?k=<ACCESS_CODE>`. Sie spricht das Script ohne Google-Cookies an, deshalb ist egal, wie viele Konten angemeldet sind. Der Upload selbst geht weiter direkt zu Drive.

**Was gleich bleibt:** Script, Ordner, Script Properties und der `ACCESS_CODE`. Die alte Adresse `script.google.com/…/exec?k=…` funktioniert weiter, nur eben nicht bei mehreren Konten.

**Was öffentlich ist:** Das Repo ist öffentlich, denn GitHub Pages braucht das im kostenlosen Konto. Darin stehen nur Code und Texte. Die Script-Adresse liegt als Repository-Secret `APPS_SCRIPT_URL` bei GitHub und wird erst beim Veröffentlichen eingesetzt. Auf der fertigen Seite ist sie sichtbar, weil der Browser sie aufrufen muss. Das ist unkritisch, denn ohne gültigen Code lehnt das Script jede Anfrage ab. `ACCESS_CODE`, `FOLDER_ID`, `GALLERY_USER`, `GALLERY_PASSWORD` und der Drive-Zugriff bleiben in Apps Script. Mit dem Upload-Code können Gäste nur hochladen. Ansehen geht nur über die Galerie mit Benutzername und Passwort (Abschnitt 10).

**Schutz der Seite:** Eine Content-Security-Policy erlaubt nur Verbindungen zu Apps Script und zur Drive-Upload-Schnittstelle. `no-referrer` sorgt dafür, dass der Code aus der Adresse nicht an andere Seiten weitergegeben wird. Suchmaschinen sind ausgesperrt.

### Einrichten (ca. 15 Minuten)

1. **Apps Script aktualisieren:** Die neue `Code.gs` (mit `doPost`) und die neue `index.html` einfügen. Danach „Bereitstellen“ → „Bereitstellungen verwalten“ → Stift → „Neue Version“. Die Adresse bleibt gleich.
2. **GitHub CLI installieren** ([cli.github.com](https://cli.github.com)) und mit dem Hochzeitskonto anmelden: `gh auth login`.
3. Im entpackten Projektordner ausführen: `bash tools/setup-github.sh`. Das Script fragt nach der Apps-Script-Adresse (`https://script.google.com/macros/s/<ID>/exec`, ohne `/u/<Zahl>/` und ohne `?k=`). Dann legt es das Repo an, setzt das Secret, schaltet GitHub Pages ein, lädt den Code hoch und wartet auf die Veröffentlichung.
4. **Testen:** `https://hochzeitoliviaraphael-art.github.io/?k=<ACCESS_CODE>&debug=1` auf dem Handy im normalen Browser öffnen, in dem mehrere Google-Konten angemeldet sind. Ein Foto hochladen und prüfen, dass es im Ordner liegt. Das Protokoll sollte `checkAccess: ok` zeigen.
5. QR-Code und Poster auf die neue Adresse umstellen.

Ohne CLI, im Browser: Repo `hochzeitoliviaraphael-art.github.io` öffentlich anlegen, Projekt hochladen, unter Settings → Secrets and variables → Actions das Secret `APPS_SCRIPT_URL` anlegen und unter Settings → Pages bei „Source“ „GitHub Actions“ wählen.

### Änderungen später

Texte und Code ändert ihr in `src/`. Jeder Push auf `main` testet und veröffentlicht die Seite neu. Lokal bauen: `APPS_SCRIPT_URL=… node tools/build-pages.js`, das Ergebnis liegt dann in `dist/`.

### Fehlersuche Variante B

| Beobachtung | Ursache und Lösung |
| --- | --- |
| Seite zeigt „Dieser Link ist nicht gültig“ | `?k=` fehlt oder ist falsch. |
| Debug zeigt `checkAccess failed: Failed to fetch` | Die neue `Code.gs` mit `doPost` ist nicht bereitgestellt (neue Version anlegen), das Secret `APPS_SCRIPT_URL` ist falsch, oder die Bereitstellung ist nicht auf „Jeder“ gestellt. |
| GitHub Action schlägt bei „Seite bauen“ fehl | Secret fehlt oder hat das falsche Format. |
| 404 auf github.io | Settings → Pages → Source muss „GitHub Actions“ sein, danach die Action erneut starten. |

