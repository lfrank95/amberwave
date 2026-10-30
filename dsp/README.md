# Amberwave DSP (C)

Glow (Röhre), Iron (Übertrager), Silk (Band) und die EQ-Sektionen in C – dieselben Rechnungen wie die Audio-Worklets der
Web-App (`app/js/waerme-worklet.js`, `trafo-worklet.js`, `band-worklet.js`, `eq-worklet.js`), inklusive HQ-Modi,
Mitte/Seite-Verteilung, Auto-Gain, Färbungsmessung (THD-Meter) und Delta-Hören. Gedacht für den Windows Client (in der
Engine, bei der Abtastrate der Datei), später den Windows Server und als WebAssembly im Browser.

Schnittstelle: `aw_dsp.h` (Gerät anlegen, Werte setzen wie `port.postMessage`, Blöcke rechnen, Messung abholen).
Keine Abhängigkeiten außer libm; kompiliert ohne Warnungen mit gcc und llvm-mingw (Windows).

## WebAssembly (Browser)

`wasm/bauen.sh` übersetzt Glow, Iron, Silk und EQ nach `app/js/aw-dsp.wasm` (clang mit wasm32-Ziel, ohne C-Bibliothek:
eigene kleine Laufzeit in `wasm/laufzeit.c`, sin/exp/log/pow … kommen als `Math.*` aus JavaScript). `app/js/dsp-worklet.js`
registriert damit `aw-roehre`, `aw-trafo` und `aw-band` – dieselben Namen und Nachrichten wie die JS-Worklets, die nur noch
als Rückfall dienen (Browser ohne WebAssembly). Nach jeder Änderung an den C-Dateien: `wasm/bauen.sh` und
`GEGEN=wasm tests/vergleich.py` (das Worklet so, wie es im Browser läuft, gegen das JS-Original).

## Prüfung gegen das Original

`tests/vergleich.py` schickt dieselben Testsignale (Sinus, Sweep, Rauschen, Stille, harte Spitzen, Akkorde) mit denselben
Abläufen (Wertänderungen mitten im Lauf, Delta an/aus, Messung) durch das JS-Worklet und die C-Version – je Gerät
Standard und HQ, bei 44,1 / 48 / 96 / 192 kHz, dazu Mono und 5.1. Die Zufallsquelle (Toleranz-Drift, Gleichlauf,
Rauschen) ist im Test auf beiden Seiten dieselbe Folge (mulberry32), damit auch HQ Sample für Sample vergleichbar ist.

Grenze −140 dB. Ergebnis: Glow und Silk −168 … −187 dB (Rundung auf float), Iron und EQ bitgleich. Gegenprobe: ein
absichtlich um 0,4 % verstellter Faktor im Modulationsrauschen fällt mit −102 dB sofort auf.

Weitere Werkzeuge: `tests/tempo.c` (Rechenzeit), `tests/tempo_js.mjs` (dasselbe für die JS-Originale).

## Rechenzeit (ein Kern, Stereo, Anteil an Echtzeit)

| Gerät | 44,1 kHz | 96 kHz | 192 kHz | JS-Original bei 192 kHz |
|---|---|---|---|---|
| EQ | 0,4 % | 0,7 % | 1,4 % | – |
| Glow | 3,2 % | 3,6 % | 3,5 % | 9 % |
| Glow HQ | 29 % | 39 % | 46 % | 98 % |
| Iron | 0,7 % | 1,5 % | 3,2 % | 7,5 % |
| Iron HQ | 3,2 % | 2,9 % | 5,9 % | 11,7 % |
| Silk | 3,6 % | 4,7 % | 4,2 % | 9,6 % |
| Silk HQ | 15 % | 17 % | 16 % | 38 % |

Glow HQ ist die teure Stufe (12AX7 je Takt per Newton gelöst). Mitte und Seite sind unabhängig – in der Engine lassen sie
sich auf zwei Kerne verteilen, das halbiert die Zeit.

## Space (AmberSpace)

- `upmix.c`: der Upmix „Zwei Ebenen“ aus `app/js/raumklang-worklet.js` (STFT 2048, Raum/Effekte/Front/Center). Prüfung:
  `tests/upmix_vergleich.py` – C gegen Worklet bei 44,1 bis 192 kHz, mit und ohne Center: praktisch bitgleich (≤ −205 dB).
- `faltung.c`: Faltung für den Hall, partitioniert in vier Stufen (128 / 1024 / 8192 / 32768), ohne zusätzliche Latenz
  bei 128er-Blöcken wie der ConvolverNode. Gegen direkte Faltung: −152 dB (Rundung auf float).
- `raumgraph.c`: rechnet einen Web-Audio-Graphen nach, den die Web-App mit denselben Funktionen wie im Browser baut
  (`app/js/raumnativ.js` schreibt ihn als Text): Gain, Biquad, IIR, Delay, Convolver, Splitter, Merger, Upmix; Kanalregeln
  (channelCount/-Mode/-Interpretation) und Parameter-Automation wie in der Web-Audio-Spezifikation. Prüfung:
  `tests/raum_vergleich.py` rendert jeden Preset-Graphen in Chromium (OfflineAudioContext) und in C – Front, Center und
  LFE −142 … −294 dB, Surrounds −86 … −112 dB (Chromium rechnet Faltung und Delay-Position in float).
- Rechenzeit (dieser Testrechner, ein Kern, Preset „Live“ 5.1, 2,5 s Hall): 48 kHz 14 %, 192 kHz 68 %. Den größten Teil
  kosten die FFTs der Faltung – eine schnellere FFT (reelle Transformation, SIMD) wäre der nächste Schritt.
- Space (Upmix, Faltungshall, Ambience) als eigener Schritt.
- WebAssembly-Build für den Browser.
