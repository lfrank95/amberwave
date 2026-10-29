// Windows-Client: Ersatz für das <audio>-Element. Abgespielt wird nicht im Browser, sondern in der Amberwave-Engine
// (WASAPI exklusiv, bitgenau, lückenlos). Die Schnittstelle bildet nur nach, was der Player vom <audio>-Element benutzt:
// src, play(), pause(), paused, ended, currentTime, duration, volume, muted, error und die üblichen Ereignisse.
// Lückenlos: der Player sagt mit vormerken(), was als Nächstes kommt; die Engine geht sample-genau über und meldet das.
// Für den Player sieht das aus wie „ended“ und danach ein neues src mit genau diesem Titel – das läuft dann einfach weiter.

import { t } from './i18n.js';

/** Brücke aus dem Windows-Client (preload) – im Browser undefined */
export const nativ = typeof window !== 'undefined' && window.amberwaveNativ ? window.amberwaveNativ : null;

if (nativ) {
  document.documentElement.classList.add('aw-nativ');
  // Scrollleiste der Seite: im Ruhezustand fast unsichtbar, beim Scrollen und mit der Maus am rechten Rand deutlicher
  const root = document.documentElement;
  let aus = 0;
  const zeigen = () => { root.classList.add('scrollt'); clearTimeout(aus); aus = setTimeout(() => root.classList.remove('scrollt'), 1200); };
  window.addEventListener('scroll', zeigen, { passive: true });
  window.addEventListener('mousemove', (e) => { if (e.clientX > window.innerWidth - 28) zeigen(); }, { passive: true });
}

/**
 * Farbe der Titelleiste (theme-color): Vollbild-Ansichten (große Player-Ansicht, Effektrack) setzen ihre eigene, damit die
 * Fensterknöpfe im Windows Client – und die Titelleiste der installierten PWA – zur Ansicht passen. null = zurück.
 */
const titelStapel = [];
export function titelFarbe(farbe, wer) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  if (!titelStapel.length) titelStapel.push({ wer: null, farbe: meta.content });
  const i = titelStapel.findIndex((x) => x.wer === wer);
  if (i > 0) titelStapel.splice(i, 1);
  if (farbe) titelStapel.push({ wer, farbe });
  meta.content = titelStapel[titelStapel.length - 1].farbe;
}

/** Wie die Engine ausgibt, kurz: „ASIO“, „WASAPI exklusiv“ oder „WASAPI geteilt“ */
/** „Gerät bereit nach 412 ms + 250 ms Aufschlag“ (nach einem Ratenwechsel, exklusiv/ASIO) */
export function anlaufText(a) {
  if (!a) return '';
  return a.zeitueber ? t('Gerät meldete keinen stabilen Takt – nach {ms} ms trotzdem gestartet (+ {pause} ms Pause)', { ms: a.ms, pause: a.aufschlag }) : t('Gerät bereit nach {ms} ms + {pause} ms Pause', { ms: a.ms, pause: a.aufschlag });
}
export const ausgabeWeg = (f) => (!f ? '' : f.asio ? 'ASIO' : f.exklusiv ? t('WASAPI exklusiv') : t('WASAPI geteilt'));
/** Ist die gewählte Ausgabe ein ASIO-Treiber? */
export const istAsio = (geraet) => String(geraet || '').startsWith('asio:');

const idAus = (url) => (String(url || '').match(/\/stream\/(\d+)/) || [])[1] || '';

/** Absolute Adresse mit art=flac (die Engine dekodiert nur FLAC; der Server liefert alles verlustfrei als FLAC) */
function engineUrl(url) {
  const u = new URL(url, location.href);
  u.searchParams.set('art', 'flac');
  u.searchParams.set('wav', '1');   // WAV/AIFF als Original (die Engine liest sie selbst)
  u.searchParams.delete('t');
  return u.href;
}

export class NativAudio extends EventTarget {
  constructor() {
    super();
    this.nativ = true;
    this._src = '';
    this._id = '';          // Titel, den der Player gerade meint
    this._hoerbar = '';     // Titel, den die Engine gerade spielt
    this._offen = false;    // src gesetzt, aber noch nicht an die Engine gegeben (erst bei play())
    this._start = 0;
    this._zeit = 0;
    this._dauer = NaN;
    this._vol = 1;
    this._stumm = false;
    this._spulen = null;
    this._schleife = false;
    this._letztesUpdate = 0;
    this._vorgemerkt = null;
    this._gain = 1;         // Lautheitsangleich des laufenden Titels (die Engine wendet ihn ab der Titelgrenze an)
    this._puffer = 0;       // dekodierter Vorrat in Sekunden
    this.paused = true;
    this.ended = false;
    this.error = null;
    this.preload = 'auto';
    this.crossOrigin = null;
    this.readyState = 0;
    this.format = null;     // {rate, bits, kanaele, aus_rate, aus_kanaele, aus_format, exklusiv, geraet, hinweis}
    this.bitgenau = false;
    nativ.auf((m) => this._meldung(m));
  }

  _feuern(art) { this.dispatchEvent(new Event(art)); }
  _senden(b) { nativ.senden(b); }

  get src() { return this._src; }
  set src(url) {
    this.ended = false;
    this.error = null;
    this._schleife = false;
    if (!url) { this._src = ''; this._id = ''; this._offen = false; this._senden({ c: 'stopp' }); return; }
    this._src = new URL(url, location.href).href;
    const id = idAus(url);
    if (id && id === this._hoerbar && !this._offen && this._id !== id) {
      // die Engine ist schon nahtlos in diesen Titel übergegangen
      this._id = id;
      this._offen = false;
      this.readyState = 4;
      if (this._dauerNeu != null) this._dauer = this._dauerNeu;
      this._feuern('loadstart'); this._feuern('loadedmetadata'); this._feuern('durationchange'); this._feuern('canplay');
      return;
    }
    this._id = id;
    this._offen = true;
    this._start = 0;
    this._zeit = 0;
    this._dauer = NaN;
    this.readyState = 0;
    this._feuern('loadstart');
    this._feuern('emptied');
  }
  get currentSrc() { return this._src; }
  removeAttribute(n) { if (n === 'src') this.src = ''; }
  load() {}

  play() {
    if (!this._src) return Promise.reject(Object.assign(new Error('keine Quelle'), { name: 'NotSupportedError' }));
    const warPause = this.paused;
    this.paused = false;
    this.ended = false;
    // Einblenden macht die Engine sample-genau (der Player setzt einblenden vor dem Start von Hand)
    const fade = this.einblenden > 0 ? this.einblenden : 0;
    this.einblenden = 0;
    if (this._offen) {
      this._offen = false;
      this._senden({ c: 'laden', id: this._id, url: engineUrl(this._src), pos: this._start || 0, spielen: true, gain: this._gain, 'w.fade': fade });
      this._lautstaerkeSenden();
      this._feuern('play');
      this._feuern('waiting');
      return Promise.resolve();
    }
    this._senden({ c: 'spielen', 'w.fade': fade });
    if (warPause) { this._feuern('play'); this._feuern('playing'); }
    return Promise.resolve();
  }

  /** ms > 0: die Engine blendet erst aus und hält dann an (Fortsetzen mitten im Ausblenden zieht wieder hoch) */
  pause(ms = 0) {
    if (this.paused) return;
    this.paused = true;
    this._senden({ c: 'pause', 'w.fade': ms > 0 ? ms : 0 });
    this._feuern('pause');
  }

  get currentTime() { return this._zeit; }
  set currentTime(s) {
    s = Math.max(0, Number(s) || 0);
    if (this._offen) { this._start = s; this._zeit = s; return; }
    if (this._schleife && s < 0.5) { this._schleife = false; return; } // „Titel wiederholen“: die Engine hat ihn schon neu gestartet
    this._spulen = s;
    this._zeit = s;
    this._senden({ c: 'springen', id: this._id, pos: s });
    this._feuern('seeking');
  }

  get duration() { return this._dauer; }

  get volume() { return this._vol; }
  set volume(v) {
    // anders als <audio> darf es über 1 gehen (Lautheitsangleich hebt an; die Decke −1 dBTP verhindert Übersteuern)
    v = Math.max(0, Math.min(4, Number(v) || 0));
    if (v === this._vol) return;
    this._vol = v;
    this._lautstaerkeSenden();
    this._feuern('volumechange');
  }
  get muted() { return this._stumm; }
  set muted(m) { this._stumm = !!m; this._lautstaerkeSenden(); this._feuern('volumechange'); }
  _lautstaerkeSenden() { this._senden({ c: 'lautstaerke', wert: this._stumm ? 0 : this._vol }); }

  /**
   * Lautheitsangleich (linear) des Titels, den der Player meint. Getrennt von der Lautstärke, damit die Engine ihn genau an
   * der Titelgrenze wechselt und bei 1 (Angleich aus) bitgenau bleibt.
   */
  get gain() { return this._gain; }
  set gain(g) {
    g = Math.max(0, Math.min(8, Number(g) || 0));
    if (Math.abs(g - this._gain) < 1e-7) return;
    this._gain = g;
    if (this._id && !this._offen) this._senden({ c: 'gain', id: this._id, wert: g });
  }

  /** wie <audio>.buffered: von 0 bis zum Ende des dekodierten Vorrats */
  get buffered() {
    const ende = this._zeit + (this._offen ? 0 : this._puffer);
    const leer = !this._src || this._offen;
    return { length: leer ? 0 : 1, start: () => 0, end: () => ende };
  }

  /** nächsten Titel für den lückenlosen Übergang (oder null), mit seinem Angleich */
  vormerken(url, gain = 1) {
    const id = url ? idAus(url) : '';
    const schluessel = id ? `${id}|${engineUrl(url)}|${gain.toFixed(6)}` : '';
    if (schluessel === this._vorgemerkt) return;
    this._vorgemerkt = schluessel;
    this._senden(id ? { c: 'vormerken', id, url: engineUrl(url), gain } : { c: 'vormerken', id: '', url: '' });
  }

  _meldung(m) {
    switch (m.e) {
      case 'geladen':
        if (m.id === this._id) {
          this._dauer = m.dauer > 0 ? m.dauer : NaN;
          this.readyState = 4;
          this._feuern('loadedmetadata'); this._feuern('durationchange'); this._feuern('canplay');
        } else this._dauerNeu = m.dauer > 0 ? m.dauer : null;
        break;
      case 'start': {
        this._vorgemerkt = null;
        const vorher = this._hoerbar;
        this._hoerbar = m.id;
        if (m.id === this._id && m.vorher === this._id && m.vorher) {
          // derselbe Titel noch einmal (Wiederholen: dieser Titel)
          this._schleife = true;
          this._zeit = this._dauer || this._zeit;
          this.ended = true;
          this._feuern('timeupdate');
          this._feuern('ended');
          this.ended = false;
          this._zeit = 0;
        } else if (m.id === this._id) {
          this._feuern('playing');
        } else if (vorher && vorher === this._id && m.vorher === this._id) {
          // nahtlos in den vorgemerkten Titel übergegangen: für den Player endet der bisherige
          this._zeit = isFinite(this._dauer) ? this._dauer : this._zeit;
          this.ended = true;
          this._feuern('timeupdate');
          this._feuern('ended');
        }
        break;
      }
      case 'zeit':
        if (m.id !== this._id || this._offen) break;
        if (this._spulen != null) {
          if (Math.abs(m.pos - this._spulen) > 1.5) break; // alte Meldung von vor dem Spulen
          this._spulen = null;
          this._zeit = m.pos;
          this._feuern('seeked');
        }
        this._zeit = m.pos;
        if (m.puffer != null) this._puffer = m.puffer;
        if (m.dauer > 0 && !(this._dauer > 0)) { this._dauer = m.dauer; this._feuern('durationchange'); }
        if (performance.now() - this._letztesUpdate > 240) { this._letztesUpdate = performance.now(); this._feuern('timeupdate'); }
        break;
      case 'ende':
        if (m.id !== this._id) break;
        this._hoerbar = '';
        this._zeit = isFinite(this._dauer) ? this._dauer : this._zeit;
        this.paused = true;
        this.ended = true;
        this._feuern('timeupdate');
        this._feuern('pause');
        this._feuern('ended');
        break;
      case 'aussetzer':
        this.aussetzerZahl = (this.aussetzerZahl || 0) + 1;
        this._feuern('waiting');
        break;
      case 'anlauf':
        // Gerät nach einem Ratenwechsel nachweislich bereit (ms seit Beginn des Umstellens) + Aufschlag
        this.anlauf = m;
        this.anlaufLetzt = m;   // bleibt bis zur nächsten Umstellung (Einstellungen, Nerd-Panel)
        this.dispatchEvent(new CustomEvent('nativformat', { detail: this.format }));
        break;
      case 'format':
        this.format = m;
        this.anlauf = null;
        this.aussetzerZahl = 0;   // gezählt seit dem Öffnen des Geräts
        this.dispatchEvent(new CustomEvent('nativformat', { detail: m }));
        break;
      case 'bitgenau':
        this.bitgenau = !!m.wert;
        this.dispatchEvent(new CustomEvent('nativformat', { detail: this.format }));
        break;
      case 'fehler':
        if (!m.id || m.id === this._id) {
          if (!m.id) { this.paused = true; this.dispatchEvent(new CustomEvent('nativfehler', { detail: m.text })); this._feuern('pause'); break; }
          this.error = { code: 4, message: m.text };
          this.paused = true;
          this._feuern('error');
        }
        break;
      case 'neustart':
        // Engine wurde neu gestartet (abgestürzt): an der letzten Stelle weiter
        if (this._id && this._src) {
          const spielte = !this.paused;
          this._offen = true;
          this._start = this._zeit;
          this._hoerbar = '';
          this._vorgemerkt = null;
          this.paused = true;
          if (spielte) this.play();
        }
        break;
    }
  }
}
