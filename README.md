# Solar-Dashboard (iPhone-Stil)

Ableger des neuen Designs mit einem Widget-Bildschirm wie auf dem iPhone. Läuft parallel auf Port **8082**
(8080 = bisheriges Dashboard, 8081 = neues Design) mit eigener Datenbank-Kopie und fragt den Solar-Log nur alle 15 s ab.

- **Feste Grössen:** S (1×1), M (2×1), L (2×2), XL (ganze Breite). Raster mit 2 Spalten auf dem Handy, 4 auf dem Tablet, 6 am Computer.
- **Home-Widgets:** Modus, Akku, Solar jetzt, Heute, Morgen, Monat, Netz, Bestes Zeitfenster und ein Stapel zum Durchwischen,
  der je nach Tageszeit das passende Widget zuerst zeigt. Jedes Widget kennt mehrere Grössen und zeigt grösser mehr.
- **Tippen** auf ein Widget öffnet die Detailansicht (z. B. Akku → Batterie-Diagramm im Tab Tag).
- **Bearbeiten:** ein Widget lange drücken (oder Menü → Widgets bearbeiten, Taste E). Die Widgets wackeln, lassen sich
  verschieben (Finger kurz halten, dann ziehen), mit − entfernen, in der Grösse und im Tab ändern. „+ Widget“ öffnet die Galerie.

Parameter in der Adresse:
- `?wetter=nieselregen|regen|starkregen|gewitter|schnee|nebel|wolken|klar` zeigt eine Wetter-Szene zum Ausprobieren
- `&tag` oder `&nacht` erzwingt die Tageszeit (auch allein, z. B. `?nacht` mit dem echten Wetter)
- `?rueckblick=2026-09` (Monat) oder `?rueckblick=2025` (Jahr) öffnet den Solar-Rückblick

Lokales Dashboard für eine Solaranlage mit Solar-Log. Liest die offene JSON-Schnittstelle
alle 5 s aus (neue Werte liefert er etwa alle 15 s), speichert den Verlauf in SQLite (`./data/solar.db`) und läuft auf Port 8080.
Keine Cloud, keine npm-Abhängigkeiten, Chart.js liegt lokal unter `public/vendor/`.

## Start
```bash
docker compose up -d --build
```
Dann im Browser: `http://<server-ip>:8080`

Auf dem iPhone in Safari über **Teilen → Zum Home-Bildschirm** als App ablegen: eigenes Icon, startet im
Vollbild ohne Browserleisten (Icons unter `public/icons/`, Manifest `public/manifest.webmanifest`).

## Kopfzeile
Oben rechts steht der Ladezustand der Batterie als kleines Symbol mit Prozent (Blitz beim Laden,
rot unter 15 %). Das ist die einzige Stelle mit dem Ladezustand in Prozent; ohne Batterie wird sie ausgeblendet.

## Widgets
Unten rechts sitzt ein dezenter Menü-Knopf, der sich nach 3 Sekunden ohne Mausbewegung
ausblendet. Darüber erreichst du **Dashboard anpassen** (Taste `E`) und **Einstellungen**.

Im Anpassen-Modus verschiebst du Widgets am Titel frei im Raster, ziehst an den Rändern für
Breite und Höhe und fügst über die Leiste unten neue Widgets hinzu. `Esc` oder **Fertig** beendet
den Modus. Widgets rücken automatisch nach oben nach, wenn darüber Platz frei wird.

Auf dem Handy sind die Widgets auf Tabs verteilt (Jetzt, Tag, Bilanz, Analyse), umschalten per
Tab-Leiste unten oder durch Wischen nach links/rechts. Jedes Widget hat einen Standard-Tab; im
Anpassen-Modus (am grösseren Bildschirm) lässt sich pro Widget über "Handy: …" ein anderer Tab
wählen oder das Widget auf dem Handy ausblenden. Neu hinzugefügte Widgets landen automatisch auf
ihrem Standard-Tab, leere Tabs werden nicht angezeigt.

- Energiefluss jetzt
- Batterie (Ladezustand, Laden/Entladen, Tagesverlauf)
- Tagesverlauf als Bilanz wie bei Enerest: Produktion, eigenversorgter Verbrauch (Solar + Batterie), Netzbezug, Einspeisung, mit Tagessummen (oder pro Wechselrichter)
- Prognose für heute und morgen (Open-Meteo), dazu die erwartete Kurve im Tagesverlauf
- Kennzahlen heute
- Bilanz (Monat/Jahr/Gesamt, Produktion & Verbrauch, Aufteilung Solarstrom oder pro Wechselrichter, Soll-Linie)
- Soll und Ist (Monat und Jahr, kumulierter Verlauf)
- Wechselrichter (Live-Vergleich und Erträge pro Tag/Monat)
- Produktion nach Stunde (Heatmap 30–365 Tage)
- Autarkie und Eigenverbrauch (Verlauf)
- Jahresvergleich (monatlich oder kumuliert)
- Gesamtbilanz mit Wert in CHF

Layout, Widget-Optionen und Einstellungen werden auf dem Server gespeichert und gelten
für alle Geräte.

## Einstellungen (im Dashboard unter "Einstellungen")
Anlagenname, Tarife, Soll-Ertrag pro kWp, Monatsverteilung des Solls, Anzahl und Namen der
Wechselrichter. Die Variablen in `docker-compose.yml` sind nur Startwerte.

## Solar-Rückblick
Rückblick auf einen Monat oder ein Jahr als Karten zum Durchtippen (rechts tippen = weiter, links = zurück,
Pfeiltasten, Esc). Öffnen über **Rückblick** im Bilanz-Widget für den dort gewählten Monat oder das Jahr; in der
ersten Woche eines neuen Monats erscheint oben ein Hinweis auf den Vormonat (im Januar auch auf das Vorjahr).
Die Texte entstehen lokal aus Regeln: Pro Karte werden mögliche Aussagen berechnet und nach Auffälligkeit
gewichtet, nur die stärksten erscheinen. Vergleiche (E-Auto, CO₂) nutzen Faustwerte, die auf der Karte stehen.

## Ertragsprognose
In den Einstellungen unter **Ertragsprognose** Standort (Ortsname oder Koordinaten), Dachneigung und
Ausrichtung eintragen. Der Server holt dann alle 30 Minuten die Einstrahlungsprognose von
[Open-Meteo](https://open-meteo.com) (kostenlos, ohne Konto) und rechnet sie mit der Anlagenleistung in
einen Ertrag um. Ein Faktor aus dem Vergleich mit dem gemessenen Ertrag der letzten 14 Tage gleicht
Verschattung, Verluste und eine ungenaue Ausrichtung aus. Nach aussen gehen nur Standort, Neigung und
Ausrichtung; ohne Standort ist die Prognose aus und es gibt keine externen Anfragen.

## Historische Daten
Beim Start versucht das Dashboard, `days_hist.js` und `months.js` vom Solar-Log zu lesen und
übernimmt sie nur, wenn sie zu den Live-Werten passen (siehe Log: `docker logs solar-dashboard`).
Eigenverbrauch, Einspeisung und Netzbezug gibt es nur für Tage, an denen das Dashboard lief.

## API
`/api/state`, `/api/day?date=YYYY-MM-DD`, `/api/series?period=month|year|total&ref=…`,
`/api/days?n=30`, `/api/heatmap?days=90`, `/api/years`, `/api/forecast`, `/api/settings` (GET/PUT)
`/api/profile` (typischer Tag und Akku-Modell), `/api/daysrange?from=…&to=…`

## Umzug auf einen Ubuntu-Server
Die Datenbank (`data/solar.db`) ist nicht im Repository: Sie enthält alle Messwerte, das Layout und die Einstellungen
samt Standort. Sie wird einmal separat kopiert.

1. Auf dem Server Docker mit Compose-Plugin installieren (`docker compose version` muss laufen).
2. Repository klonen und in den Ordner wechseln.
3. Auf dem Mac den laufenden Container stoppen, damit die Datenbank in sich stimmig ist, und sie kopieren:
   ```bash
   docker stop solar-dashboard-iphone
   scp data/solar.db <user>@<server>:<pfad>/data/solar.db
   ```
4. Auf dem Server starten: `docker compose up -d --build`. Der Server muss den Solar-Log unter `SOLARLOG_URL`
   erreichen (gleiches Heimnetz). Port und Abfragetakt stehen in `docker-compose.yml`.
5. Auf dem Mac den alten Container nicht wieder starten, damit nur ein Dashboard den Solar-Log abfragt.

Lücken während des Umzugs füllt das Dashboard von selbst aus der Tageskurve des Solar-Logs (heute sofort,
vergangene Tage kurz nach Mitternacht).
