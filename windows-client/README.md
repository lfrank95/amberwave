# Amberwave Windows Client

Client for the Amberwave server (not to be confused with a later Amberwave Windows Server): shows the web app of your own server in a window (Electron) and plays through a
dedicated audio engine – bit-perfect via WASAPI exclusive, gapless, sample rate follows the file. Admin, library,
accounts and presets stay on the server.

## Structure

- `client/` – Electron shell (`main.js`), bridge to the web app (`preload.js`), server discovery on the home network (`suche.js`),
  setup page (`einrichtung.html`).
- `engine/` – audio engine in C: download (WinHTTP), FLAC (dr_flac), ring buffer with track/format/end markers, output via
  WASAPI (`ausgabe_wasapi.c`). Controlled via JSON lines on stdin/stdout (commands and messages: see the header of `engine.c`).
  `ausgabe_test.c` and `netz_posix.c` are a test device and HTTP for Linux (automated tests).
- Sound chain in the engine (`engine/klang.c`): Glow, Iron, Silk and EQ from the shared C library `dsp/`
  (exact port of the worklets), order freely selectable, rebuilds with a 60 ms crossfade. Without an active stage the
  integer path keeps running (bit-perfect). Loudness matching per track (`gain` on `laden`/`vormerken`) switches sample-accurately at
  the track boundary. Measurement points (input, before/after EQ, measurement point after chain and matching) go as 16-bit PCM to
  the web app (`app/js/abgriff.js`), where meters, rack and analysis run unchanged.
- Space: the web app builds the graph as in the browser against `app/js/raumnativ.js`, the engine computes it with
  `dsp/raumgraph.c` (upmix, convolution, filters, bass management) after the chain and before the matching. For this the device is opened with
  the channels of the layout (5.1/quad, speaker mask of the device); stereo stays bit-perfect on it as soon as Space
  is off again. Impulse responses are sent to the engine once as data.
- ASIO (`engine/ausgabe_asio.c`, interface in `engine/asio.h` – our own description of the driver ABI, without the
  Steinberg SDK): drivers from the registry appear as “ASIO · …” in the device list. The driver runs in its own
  thread (COM as STA); the engine writes in the driver’s format (Int16/24/32, Float32/64, Int32 with 16–24 bits) into a
  ring buffer (100 ms), the callback distributes to the channels – bit-perfect, sample rate of the file, Space with 6 channels. Reset requests from the
  driver (buffer size/rate changed in the driver window) reopen the device; the driver window is opened by the command
  `asio_einstellungen` (Profile and quality menu). On Linux a driver dummy (`engine/asio_attrappe.c`) is used for testing.
- ASIO rate change: the same driver is only reconfigured (stop, rate, buffers anew, continue) instead of being unloaded and reloaded
  – only the switching time of the interface remains.
- Fixed output rate (Profile → “Sample rate at device”): `engine/geraet.c` opens the device at this rate and converts the
  source with `dsp/umrechner.c` (polyphase FIR, Kaiser sinc, passband up to 90.7 % of the smaller Nyquist frequency,
  150 dB stopband attenuation, linear phase; measurement `dsp/tests/umrechner_test.py`: residual −146 … −154 dB, image/alias ≤ −155 dB).
  Changes of the source rate are seamless, the device keeps running; the same rate stays bit-perfect. Output with TPDF dither
  at 16/24 bit.
- Title bar: the header bar of the web app is the title bar (`titleBarOverlay`, color from `theme-color`), the
  Windows buttons stay native. Fullscreen views (large player view, effects rack) turn their top row into the
  title bar, leave room on the right for the buttons and set the matching title color (theme-color).
- Identification at the server: `AmberwaveClient/<version> (<computer name>)` in the user agent – the admin area shows the device as
  “<computer name> · Windows Client”.
- The web app recognizes the client by `window.amberwaveNativ` and replaces the `<audio>` element with `NativAudio`
  (`app/js/nativ.js`). Gapless: the player queues the next track, the engine crosses over sample-accurately.

## VST3 plug-ins (stage 1)

Your own VST3 effects (stereo, no instruments) – “bring your own plugins”. `vsthost/vsthost.cpp` is a dedicated host process
(`amberwave-vsthost.exe`, one process per plug-in so that a crash only affects that plug-in); it uses only the interfaces
of the VST3 SDK (MIT, `pluginterfaces`); loading, host objects, windows and audio processing are our own code. Invocations:
`--scan <datei>` (classes as JSON lines), `--probe <datei> <klasse> [sek]` (send noise through, level/latency/parameters/CPU time),
`--editor <datei> <klasse>` (user interface in its own window). `client/vst.js` searches in `%CommonProgramFiles%\VST3` and custom
folders, each file in its own process with a time limit, and remembers the list (`vst-plugins.json`, unchanged files are not
reloaded). Operation in the web app: `app/js/vstbrowser.js`.

Logs: `%APPDATA%\<Client>\log\` – `client.log` (Electron, engine output and crashes) and `vsthost.log` (every step while loading:
LoadLibrary, createInstance, initialize, buses, setupProcessing …; on a crash the exception code, module+offset, backtrace
and the last step). “Create diagnostic file” packs system information and the last 1500 lines of both logs into a text file on the desktop.
Building: `bauen.sh` (VST3 SDK path `VST3_SDK`, containing `pluginterfaces/` and `public.sdk/`).

### VST3 plug-ins in the sound chain (stage 2)

`amberwave-vsthost.exe --slot <datei> <klasse> <vstN> <zustandsdatei>` runs as its own process per plug-in (Windows program without a
console). Audio: the engine (`engine/vstanbindung.c`) writes each block (128 frames) into shared memory (`vsthost/vstshm.h`), sets an
event, waits at most 40 ms for the second one and reads the result; eight times in a row too late or a terminated host → the
signal continues unchanged at that point (`vstfehler` to the web app). Besides the four built-in stages, the chain (`engine/klang.c`) knows the slots `vst0` … `vst7`;
during the 60 ms crossfade when rebuilding, a plug-in runs only in the new chain.
The host reconfigures the plug-in on every change of the sample rate (stereo, Float32, up to 4096 frames), passes control movements from
the user interface on to the processor, returns output parameters to the controller and saves the state (component +
controller) 1.5 s after the last change and on exit to `%APPDATA%\<Client>\vst-zustand\<slot>-<klasse>.bin`; presets are stored
as `.awv` in `vst-presets\<klasse>\`. Commands to the host (stdin): `editor_auf`, `editor_zu`, `zustand_speichern`, `zustand_laden`, `ende`;
messages (stdout): `bereit`, `fehler`, `editor`, `zustand`, `latenz`. Levels (`vstpegel`, 20 Hz) are computed by the engine itself. The slot list
of the web app is kept in localStorage (`app/js/vstrack.js`), `client/vst.js` (`VstSlots`) starts/stops the hosts and connects them to the engine.

## Finding the server

On first start the client queries all addresses of its own networks (each /24, excluding VPN/virtual adapters) on the
Amberwave port (default 9950) for `/api/v1/ping`. The home network address and the public address (`APP_URL`) are remembered.
If the server’s IP changes, it is recognized again at the next start by its name or by the public address.

## Building (on Linux, for Windows)

`bauen.sh` – needs llvm-mingw (cross compiler) and the Electron package for win32-x64 (see variables in the script).
Result: `Amberwave-Windows-Client-<version>.zip` (runs without installation: unpack, start `Amberwave Client.exe`).

## Fades and device start-up

- **Pause/resume:** The engine fades out (150 ms) and in (200 ms) itself, sample by sample (`pause`/`spielen` with
  `w.fade`). It only stops once the faded-out audio has actually been played; the silence behind it is discarded, and on
  resume playback continues exactly where the fade ended. Play in the middle of a fade-out ramps up again from there.
  Fades do not count as “not bit-perfect”.
- **Start-up after a rate change (exclusive/ASIO):** After opening or reconfiguring with a new rate, the engine writes silence
  and measures whether the device consumes steadily at the new rate (window of several device buffers, no stall,
  twice in a row). Only then comes the adjustable padding (`w.aufschlag`, default 250 ms, 0–2000) and afterwards
  the music from the first sample. After 3 s without a stable clock it starts anyway (`zeitueber`). Message
  `{"e":"anlauf","ms","aufschlag","zeitueber","stille"}`; the app shows it in the analysis and under Profile → Output.
  ASIO additionally waits until the driver also reports the new rate (at most 2 s). What happens behind the driver
  (converters that briefly mute the output) cannot be seen by any software – that is what the padding is for.
  Test: `AW_ASIOANLAUF=ms` makes the ASIO dummy not run at all for that long, then run at half clock (output muted).

## Device keeps running (ASIO)

- **Track change and seeking:** The driver is not stopped. The engine fades out the next 10 ms in the buffer in front of the
  driver, discards the rest and writes the new position directly behind it (`ger_weich_neu`: the timing starts
  again at 0, just without a stop). The new position is faded in over 5 ms, the effects (Glow, Iron, Silk, EQ) are created
  fresh so that nothing of the old material rings on.
- **Pause:** fade out, then write nothing more – the driver plays silence. After 5 minutes of pause or 10 s after the
  end of the queue or stop, the device is released (Windows may sleep); by then enough silence has
  run that nothing old is left in the interface. Resume then reopens, at the same position.
- **Rate change:** the only case in which it stops. Beforehand, silence of the length of the output latency reported by the driver
  (`getLatencies`) plus two driver buffers, at least three buffers, at most 500 ms. The latency is shown in the
  nerd panel.
- Driver buffers are filled with silence on creation, before every start and after every stop.
- Buffer between engine and driver: three driver buffers, at least 50 ms (was 100 ms).
- WASAPI still stops on a track change (what has been written is already in the device and can no longer be faded out).
- Test: `AW_ASIOFIFO=frames` gives the dummy an internal buffer behind the ASIO halves (like USB interfaces) that remains
  when stopping; `AW_RUHE_PAUSE`/`AW_RUHE_ENDE` shorten the idle times.

## WAV and AIFF

The engine reads WAV/AIFF with integer PCM itself (dr_wav): the server delivers them unchanged with `art=flac&wav=1`,
bit-perfect and instantly seekable. Everything else (MP3, AAC, ALAC, floating-point WAV …) the server still converts to FLAC; within that stream
the engine seeks forward by decoding (these streams have no seek table).

## Package

`bauen.sh` sets icon and version info in `Amberwave Client.exe` (`werkzeug/pe_symbol.py`, without Windows tools) and in
the engine, removes the WebGPU compiler and software graphics and packs everything into `Amberwave-Windows-Client-<version>.exe`:
a small unpacker (`sfx/`, xz-embedded) with an appended xz stream (LZMA2 9e, x86 filter). It unpacks into the folder
“Amberwave Windows Client” next to itself, replacing an older version in the process (settings are kept in `%APPDATA%`), and
offers to launch afterwards. The core (`sfx_kern.c`) can be tested on Linux: `test_sfx paket.exe zielordner`.

## Open for the next build

- Faster FFT for the convolution (Space at 192 kHz otherwise needs a lot of CPU time).
- Test ASIO with real hardware (so far only tested against the dummy); channel selection (which outputs) for interfaces
  with many outputs.
- The ASIO 2.3 query of the internal buffer size (in addition to `getLatencies`) is not built in yet.
