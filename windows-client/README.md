# Amberwave Windows Client

Client für den Amberwave-Server (nicht zu verwechseln mit einem späteren Amberwave Windows Server): zeigt die Web-App des eigenen Servers in einem Fenster (Electron) und spielt über eine
eigene Audio-Engine ab – bitgenau über WASAPI exklusiv, lückenlos, Abtastrate folgt der Datei. Verwaltung, Bibliothek,
Konten und Presets bleiben auf dem Server.

## Aufbau

- `client/` – Electron-Hülle (`main.js`), Brücke zur Web-App (`preload.js`), Server-Suche im Heimnetz (`suche.js`),
  Einrichtungsseite (`einrichtung.html`).
- `engine/` – Audio-Engine in C: Download (WinHTTP), FLAC (dr_flac), Ring mit Titel-/Format-/Ende-Marken, Ausgabe über
  WASAPI (`ausgabe_wasapi.c`). Gesteuert über JSON-Zeilen auf stdin/stdout (Befehle und Meldungen siehe Kopf von `engine.c`).
  `ausgabe_test.c` und `netz_posix.c` sind ein Testgerät bzw. HTTP für Linux (automatische Tests).
- Klangkette in der Engine (`engine/klang.c`): Glow, Iron, Silk und EQ aus der gemeinsamen C-Bibliothek `dsp/`
  (exakte Portierung der Worklets), Reihenfolge frei, Umbau mit 60 ms Überblendung. Ohne wirksame Stufe läuft der
  Ganzzahlweg weiter (bitgenau). Lautheitsangleich je Titel (`gain` bei `laden`/`vormerken`) wechselt sample-genau an
  der Titelgrenze. Messpunkte (Eingang, vor/nach EQ, Messpunkt hinter Kette und Angleich) gehen als 16-Bit-PCM an die
  Web-App (`app/js/abgriff.js`), dort laufen Meter, Rack und Analyse unverändert.
- Space: die Web-App baut den Graphen wie im Browser gegen `app/js/raumnativ.js`, die Engine rechnet ihn mit
  `dsp/raumgraph.c` (Upmix, Faltung, Filter, Bassmanagement) hinter der Kette und vor dem Angleich. Das Gerät wird dafür mit
  den Kanälen des Layouts geöffnet (5.1/Quadro, Lautsprecher-Maske des Geräts); Stereo bleibt darauf bitgenau, sobald Space
  wieder aus ist. Impulsantworten gehen einmal als Daten an die Engine.
- ASIO (`engine/ausgabe_asio.c`, Schnittstelle in `engine/asio.h` – eigene Beschreibung des Treiber-ABI, ohne das
  Steinberg-SDK): Treiber aus der Registry stehen als „ASIO · …“ in der Geräteliste. Der Treiber läuft in einem eigenen
  Thread (COM als STA); die Engine schreibt im Format des Treibers (Int16/24/32, Float32/64, Int32 mit 16–24 Bit) in einen
  Ring (100 ms), der Rückruf verteilt auf die Kanäle – bitgenau, Abtastrate der Datei, Space mit 6 Kanälen. Reset-Wünsche des
  Treibers (Puffergröße/Rate im Treiberfenster geändert) öffnen das Gerät neu; das Treiberfenster öffnet der Befehl
  `asio_einstellungen` (Profil und Qualitätsmenü). Unter Linux prüft eine Treiber-Attrappe (`engine/asio_attrappe.c`).
- ASIO-Ratenwechsel: derselbe Treiber wird nur umgestellt (anhalten, Rate, Puffer neu, weiter) statt entladen und neu
  geladen – es bleibt nur die Umschaltzeit des Interfaces.
- Feste Ausgaberate (Profil → „Abtastrate am Gerät“): `engine/geraet.c` öffnet das Gerät in dieser Rate und rechnet die
  Quelle mit `dsp/umrechner.c` um (Polyphasen-FIR, Kaiser-Sinc, Durchlass bis 90,7 % der kleineren Nyquist-Frequenz,
  150 dB Sperrdämpfung, linearphasig; Messung `dsp/tests/umrechner_test.py`: Rest −146 … −154 dB, Spiegel/Alias ≤ −155 dB).
  Wechsel der Quellrate gehen nahtlos, das Gerät läuft durch; gleiche Rate bleibt bitgenau. Ausgabe mit TPDF-Dither
  bei 16/24 Bit.
- Titelleiste: die Kopfzeile der Web-App ist die Titelleiste (`titleBarOverlay`, Farbe aus `theme-color`), die
  Windows-Knöpfe bleiben nativ. Vollbild-Ansichten (große Player-Ansicht, Effektrack) machen ihre oberste Reihe zur
  Titelleiste, lassen rechts Platz für die Knöpfe und setzen die passende Titelfarbe (theme-color).
- Kennung am Server: `AmberwaveClient/<version> (<Computername>)` im User-Agent – die Verwaltung zeigt das Gerät als
  „<Computername> · Windows Client“.
- Die Web-App erkennt den Client an `window.amberwaveNativ` und ersetzt das `<audio>`-Element durch `NativAudio`
  (`app/js/nativ.js`). Lückenlos: der Player merkt den nächsten Titel vor, die Engine geht sample-genau über.

## VST3-Plug-ins (Stufe 1)

Eigene VST3-Effekte (Stereo, keine Instrumente) – „bring your own plugins“. `vsthost/vsthost.cpp` ist ein eigener Host-Prozess
(`amberwave-vsthost.exe`, ein Prozess je Plug-in, damit ein Absturz nur dieses Plug-in trifft); er nutzt nur die Schnittstellen
des VST3-SDK (MIT, `pluginterfaces`), Laden, Host-Objekte, Fenster und Audiolauf sind eigener Code. Aufrufe:
`--scan <datei>` (Klassen als JSON-Zeilen), `--probe <datei> <klasse> [sek]` (Rauschen durchschicken, Pegel/Latenz/Parameter/Rechenzeit),
`--editor <datei> <klasse>` (Oberfläche in eigenem Fenster). `client/vst.js` sucht in `%CommonProgramFiles%\VST3` und eigenen
Ordnern, jede Datei in einem eigenen Prozess mit Zeitgrenze, und merkt die Liste (`vst-plugins.json`, unveränderte Dateien werden
nicht neu geladen). Bedienung in der Web-App: `app/js/vstbrowser.js`.

Logs: `%APPDATA%\<Client>\log\` – `client.log` (Electron, Engine-Ausgaben und -Abstürze) und `vsthost.log` (jeder Schritt beim Laden:
LoadLibrary, createInstance, initialize, Busse, setupProcessing …; bei einem Absturz Ausnahmecode, Modul+Offset, Rückverfolgung
und der letzte Schritt). „Diagnosedatei erstellen“ packt Systemangaben und die letzten 1500 Zeilen beider Logs in eine Textdatei auf dem Desktop.
Bauen: `bauen.sh` (VST3-SDK-Pfad `VST3_SDK`, darin `pluginterfaces/` und `public.sdk/`).

### VST3-Plug-ins in der Klangkette (Stufe 2)

`amberwave-vsthost.exe --slot <datei> <klasse> <vstN> <zustandsdatei>` läuft je Plug-in als eigener Prozess (Windows-Programm ohne
Konsole). Audio: die Engine (`engine/vstanbindung.c`) schreibt je Block (128 Frames) in gemeinsamen Speicher (`vsthost/vstshm.h`), setzt ein
Ereignis, wartet höchstens 40 ms auf das zweite und liest das Ergebnis; achtmal hintereinander zu spät oder ein beendeter Host → das
Signal läuft an der Stelle unverändert weiter (`vstfehler` an die Web-App). Die Kette (`engine/klang.c`) kennt neben den vier
eingebauten Stufen die Slots `vst0` … `vst7`; in der 60-ms-Überblendung beim Umbauen läuft ein Plug-in nur in der neuen Kette.
Der Host stellt das Plug-in bei jeder Änderung der Abtastrate neu ein (Stereo, Float32, bis 4096 Frames), reicht Reglerbewegungen aus
der Oberfläche an den Prozessor weiter, gibt Ausgangsparameter an den Controller zurück und sichert den Zustand (Komponente +
Controller) 1,5 s nach der letzten Änderung und beim Beenden nach `%APPDATA%\<Client>\vst-zustand\<slot>-<klasse>.bin`; Presets liegen
als `.awv` in `vst-presets\<klasse>\`. Befehle an den Host (stdin): `editor_auf`, `editor_zu`, `zustand_speichern`, `zustand_laden`, `ende`;
Meldungen (stdout): `bereit`, `fehler`, `editor`, `zustand`, `latenz`. Pegel (`vstpegel`, 20 Hz) rechnet die Engine selbst. Die Slot-Liste
der Web-App liegt in localStorage (`app/js/vstrack.js`), `client/vst.js` (`VstSlots`) startet/beendet die Hosts und bindet sie an die Engine.

## Server finden

Beim ersten Start fragt der Client alle Adressen der eigenen Netze (je /24, ohne VPN/virtuelle Adapter) auf dem
Amberwave-Port (Standard 9950) nach `/api/v1/ping`. Gemerkt werden Heimnetz-Adresse und öffentliche Adresse (`APP_URL`).
Ändert sich die IP des Servers, wird er beim nächsten Start am Namen bzw. an der öffentlichen Adresse wiedererkannt.

## Bauen (unter Linux, für Windows)

`bauen.sh` – braucht llvm-mingw (Cross-Compiler) und das Electron-Paket für win32-x64 (siehe Variablen im Skript).
Ergebnis: `Amberwave-Windows-Client-<version>.zip` (ohne Installation lauffähig: entpacken, `Amberwave Client.exe` starten).

## Blenden und Geräteanlauf

- **Pause/Fortsetzen:** Die Engine blendet selbst aus (150 ms) und ein (200 ms), Sample für Sample (`pause`/`spielen` mit
  `w.fade`). Angehalten wird erst, wenn das Ausgeblendete wirklich gespielt ist; die Stille dahinter wird verworfen, beim
  Fortsetzen geht es genau an der Stelle weiter, an der die Blende endete. Play mitten im Ausblenden zieht von dort wieder
  hoch. Blenden zählen nicht als „nicht bitgenau“.
- **Anlauf nach Ratenwechsel (exklusiv/ASIO):** Nach dem Öffnen bzw. Umstellen mit neuer Rate schreibt die Engine Stille
  und misst, ob das Gerät gleichmäßig mit der neuen Rate abnimmt (Fenster aus mehreren Gerätepuffern, kein Stillstand,
  zweimal hintereinander). Erst dann kommt der einstellbare Aufschlag (`w.aufschlag`, Standard 250 ms, 0–2000) und danach
  die Musik ab dem ersten Sample. Nach 3 s ohne stabilen Takt geht es trotzdem los (`zeitueber`). Meldung
  `{"e":"anlauf","ms","aufschlag","zeitueber","stille"}`; die App zeigt sie in der Analyse und unter Profil → Ausgabe.
  ASIO wartet zusätzlich, bis der Treiber die neue Rate auch meldet (höchstens 2 s). Was hinter dem Treiber passiert
  (Wandler, die den Ausgang noch kurz stumm schalten), sieht keine Software – dafür ist der Aufschlag da.
  Test: `AW_ASIOANLAUF=ms` lässt die ASIO-Attrappe so lange erst gar nicht, dann mit halbem Takt laufen (Ausgang stumm).

## Gerät läuft durch (ASIO)

- **Titelwechsel und Spulen:** Der Treiber wird nicht angehalten. Die Engine blendet die nächsten 10 ms im Puffer vor dem
  Treiber aus, verwirft den Rest und schreibt die neue Stelle direkt dahinter (`ger_weich_neu`: die Zeitrechnung beginnt
  wieder bei 0, nur ohne Stopp). Die neue Stelle wird 5 ms eingeblendet, die Effekte (Glow, Iron, Silk, EQ) frisch
  angelegt, damit nichts vom Alten nachklingt.
- **Pause:** ausblenden, danach nichts mehr schreiben – der Treiber spielt Stille. Nach 5 Minuten Pause bzw. 10 s nach dem
  Ende der Warteschlange oder Stopp wird das Gerät freigegeben (Windows darf schlafen); bis dahin ist so viel Stille
  gelaufen, dass im Interface nichts Altes mehr steckt. Fortsetzen öffnet dann neu, an derselben Stelle.
- **Ratenwechsel:** der einzige Fall, in dem angehalten wird. Vorher Stille in Länge der vom Treiber gemeldeten
  Ausgabelatenz (`getLatencies`) plus zwei Treiberpuffer, mindestens drei Puffer, höchstens 500 ms. Die Latenz steht im
  Nerd-Panel.
- Treiberpuffer werden beim Anlegen, vor jedem Start und nach jedem Stopp mit Stille gefüllt.
- Puffer zwischen Engine und Treiber: drei Treiberpuffer, mindestens 50 ms (war 100 ms).
- WASAPI hält beim Titelwechsel weiterhin an (Geschriebenes liegt dort schon im Gerät und lässt sich nicht mehr ausblenden).
- Test: `AW_ASIOFIFO=frames` gibt der Attrappe einen internen Puffer hinter den ASIO-Hälften (wie USB-Interfaces), der beim
  Anhalten stehen bleibt; `AW_RUHE_PAUSE`/`AW_RUHE_ENDE` verkürzen die Ruhezeiten.

## WAV und AIFF

Die Engine liest WAV/AIFF mit ganzzahligem PCM selbst (dr_wav): der Server liefert sie mit `art=flac&wav=1` unverändert,
bitgenau und sofort spulbar. Alles andere (MP3, AAC, ALAC, Gleitkomma-WAV …) wandelt der Server weiter in FLAC; darin spult
die Engine dekodierend vor (diese Ströme haben keine Sprungtabelle).

## Paket

`bauen.sh` setzt Symbol und Versionsinfo in `Amberwave Client.exe` (`werkzeug/pe_symbol.py`, ohne Windows-Werkzeuge) und in
die Engine, entfernt WebGPU-Compiler und Software-Grafik und packt alles in `Amberwave-Windows-Client-<version>.exe`:
ein kleiner Entpacker (`sfx/`, xz-embedded) mit angehängtem xz-Strom (LZMA2 9e, x86-Filter). Er packt in den Ordner
„Amberwave Windows Client“ neben sich aus, ersetzt dabei eine ältere Version (Einstellungen liegen in `%APPDATA%`) und
bietet danach den Start an. Der Kern (`sfx_kern.c`) lässt sich unter Linux testen: `test_sfx paket.exe zielordner`.

## Offen für den nächsten Build

- Schnellere FFT für die Faltung (Space bei 192 kHz braucht sonst viel Rechenzeit).
- ASIO mit echter Hardware prüfen (bisher nur gegen die Attrappe getestet); Kanalwahl (welche Ausgänge) bei Interfaces
  mit vielen Ausgängen.
- Die ASIO-2.3-Abfrage der internen Puffergröße (zusätzlich zu `getLatencies`) ist noch nicht eingebaut.
