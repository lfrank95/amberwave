# Amberwave – Konzept & Entscheidungen

Diese Datei hält alle Entscheidungen fest, damit die Arbeit in einem neuen Chat nahtlos weitergehen kann.

## Grundsätze
- Eigene App (nicht Teil des Bücher-Archivs), gleiche Designsprache (Liquid-Glass-Dark, Space Grotesk + Manrope), Akzent **Bernstein**.
- Name **Amberwave** (über `APP_NAME` änderbar). Vor einer kommerziellen Nutzung Markenrecherche (DPMA/EUIPO).
- Stack: PHP 8.3 + Apache + MariaDB in Docker auf Unraid, erreichbar über Cloudflare Tunnel.
- Musik auf dem Array (nur lesend eingebunden), Datenbank und Cache (Cover, Bilder, MusicBrainz-Antworten) auf der SSD.
- Alle Konfigurationswerte über die `.env`; Admin-Einstellungen in der Oberfläche haben Vorrang, Geheimes verschlüsselt.
- Eigene Accountverwaltung mit den Bausteinen des Bücher-Archivs (Freischaltung, 1–24 Monate, Verlängerung addiert, Sperren, Rate-Limits, 8-Zeichen-Passwörter ohne Pflicht-Sonderzeichen, kein 2FA, keine externen Dienste).

## Datenmodell (an MusicBrainz angelehnt)
- Album = Release Group, Edition = Release, Datenträger = Medium, Track, Aufnahme = Recording, Werk = Work.
- Künstler-Credits sind Listen echter Künstler-Objekte mit Verbindungswort („Bruno Mars & Lady Gaga“ hängt an beiden).
- Beziehungen: eine allgemeine Tabelle *Künstler –Rolle→ Album/Edition/Aufnahme/Werk/Künstler* mit Instrumenten und Attributen (Gast, Ko-, zusätzlich).
- MBIDs überall optional; Quelle pro Objekt (tags / musicbrainz / manuell) und gesperrte Felder gegen Überschreiben.
- Die Datenbank ist die Wahrheit; Tags werden (noch) nicht in Dateien zurückgeschrieben.

## Abläufe
- **Einlesen** ohne Rückfragen; Künstler werden nur aufgeteilt, wenn die Tags sie einzeln nennen (ARTISTS/Mehrfachwerte).
- **MusicBrainz-Abgleich** nur über „Metadaten bearbeiten / Abgleichen“: alle Editionen anzeigen (Suche + vollständiges Nachladen der besten Release Groups), Filter, zeilenweiser Vergleich, dann übernehmen. Höchstens 1 Anfrage/Sekunde, eigener User-Agent.
- **Angezeigte Edition** für die Familie: meiste Titel, bei Gleichstand neueste; Admin kann festlegen. Fehlen der angezeigten Edition Mitwirkende, werden die einer abgeglichenen Schwester-Edition gezeigt.
- **Bearbeiten** geht direkt aus der Bibliothek (Album, Titel, Künstler). Geänderte Titel-Felder werden automatisch gesperrt (`tracks.gesperrte_felder`), Scan und Abgleich lassen sie in Ruhe.
- **Anfragen** laufen künftig über Lidarr (v0.2), geringe Priorität.
- **Texte** (Bios, Albumbeschreibungen) möglichst Deutsch: deutsche Wikipedia, sonst englisch + KI-Übersetzung, gekennzeichnet (v0.2).
- **Künstlerbilder** von fanart.tv (kostenloser Projekt-Schlüssel), sonst Upload (v0.2).

## Wiedergabe
- Familie: nur Streaming (Downloads aus, `DOWNLOADS_ERLAUBT`), PWA, kein Subsonic.
- Original (FLAC, mit Range) oder live umgewandelt mit ffmpeg: Opus 256/160/128, AAC als Ausweich für Browser ohne Opus.
- Lückenlos (gapless) über Media Source Extensions: ein durchgehender Zeitstrahl im Browser; zuhause FLAC pro Titel sample-genau
  angesetzt (Länge aus STREAMINFO), unterwegs Opus-Ketten pro Album (ein Encoder-Durchlauf über die Titelgrenzen). Dateien bleiben unverändert.
- Single-Page-App, damit die Musik beim Navigieren weiterläuft; Tab-Leiste unten am Handy; Startseite: Weiterhören + Neuzugänge.

## Phase 2: Windows-Player (nativ, z. B. JUCE)
- Nutzt dieselbe API `/api/v1` mit Geräte-Schlüssel (`POST /auth/token`), holt Dateien bitgenau (`q=original`).
- ASIO / WASAPI exklusiv, Ausgabeprofile mit frei benannten Kanälen (z. B. 1+2 Front, 3–6 C/Sub/SL/SR, 7+8 Kopfhörer), Bassmanagement optional.
- Optionaler M/S-Upmix (Stereo → Surround) mit einem Stärke-Regler 0–150 % (dB-Kurve; Delay/Filter/Dekorrelation fest im Preset), A/B mit Pegelausgleich, automatisch aus bei Mehrkanal/Mono, pro Album merkbar, im Signalweg angezeigt. Werte aus den Cubase-Versuchen werden das Preset „Dezent“.
- VST3-Kette pro Profil/Ausgangspaar („zum Würzen“), Signalweg-Anzeige, feste oder digitale Lautstärke.
- Einstellungen pro Gerät speichert der Server (`/geraet/einstellungen`); Live-Kanal für Fernbedienung ist vorgesehen.

## Ideen für später (besprochen, noch nicht gebaut)

### Wärme-EQ und Transient/Sustain für AmberGlow (später auch AmberSilk) – Stand 21.10.2026
- **Ansteuerungs-Kurve („wo sättigt es“):** EQ-artige Kurve mit ziehbaren Punkten. Vor der Kennlinie wird nach der Kurve
  angehoben, danach exakt wieder abgesenkt (Prinzip der Aufnahme-Entzerrung beim Band) – keine Bandaufteilung, keine
  Weichen-Artefakte, keine Phasenprobleme. Beispiel: +6 dB bei 100 Hz → Bass sättigt kräftig, der Rest kaum.
- **Mix-Kurve („wo hört man es“):** gefiltert wird nur der Unterschied zwischen Röhre und Original:
  Ausgang = Original + Kurve × (Röhre − Original). Beide Wege laufen zeitgleich, daher exakt das Original, wo die Kurve
  auf 0 steht. Beispiel: Obertöne in den Mitten ja, in den Höhen nein.
- Oberfläche: vorhandenen EQ-Editor (eqansicht.js, ziehbare Punkte) wiederverwenden.
- **Transient/Sustain getrennt:** schnelle und langsame Hüllkurve → Maske 0…1, die das Signal in Anschlag und Ausklang
  teilt (Summe = Original). Je Teil eigene Ansteuerung und Mischung, z. B. Anschlag sauber (Punch bleibt), Ausklang
  gesättigt (Dichte) – oder umgekehrt (Biss am Anschlag).
- Kombiniert: zweidimensionale „Wärme-Karte“ (Frequenz × Anschlag/Ausklang).
- Voreinstellungen für Einsteiger („Punch erhalten“, „Bass andicken“, „Höhen sauber“), Kurven für Fortgeschrittene.
- Reihenfolge, falls gebaut: zuerst Transient/Sustain (zwei Regler unter Erweitert, sofort hörbar), dann der Wärme-EQ.
- Rechenlast gering (einige Filter und Hüllkurven), läuft im Browser wie in einem späteren Plugin.
- Einordnung: Mehrband-Sättiger (z. B. FabFilter Saturn) und transientenabhängige Sättigung gibt es einzeln; die
  Kombination mit Differenz-Mix und Kurven-Editor wäre eigenständig (nicht recherchiert).

## Versionen
- v0.1: Grundgerüst, Konten, Einlesen, Bibliothek, Player, MusicBrainz-Abgleich, Verwaltung.
- v0.2: fanart.tv, Wikipedia + Übersetzung, Lidarr, Tags zurückschreiben, gapless.
