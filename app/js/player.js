// Player: Warteschlange, Wiedergabe (Original oder live umgewandelt), Media Session, Hörverlauf.
import { api } from './api.js';
import { toast, kuenstlerText } from './ui.js';
import { LueckenlosMotor } from './lueckenlos.js';
import { Raumklang, RAUMKLANG_PRESETS, raumklangRendern, ausgabeKanaele, layoutFuer, FEIN_STANDARD, reiheNormal, ausgangBassSetzen } from './raumklang.js';
import { vstRack } from './vstrack.js';
import { waermeNormal, waermeWirksam } from './waerme.js';
import { bandNormal, bandWirksam } from './band.js';
import { trafoNormal, trafoWirksam } from './trafo.js';
import { eqNormal, eqWirksam } from './eq.js';
import { netzweg } from './netzweg.js';
import { nativ, NativAudio } from './nativ.js';
import { offline } from './offline.js';
import { androidPlayer } from './android.js';
import { t } from './i18n.js';

const SPEICHER = 'aw-warteschlange';
const EINST = 'aw-player';

/** Welche Formate kann dieser Browser direkt (ohne Umwandlung) abspielen? */
const probe = document.createElement('audio');
const kann = {
  flac: !!probe.canPlayType('audio/flac') || !!probe.canPlayType('audio/x-flac'),
  mp3: !!probe.canPlayType('audio/mpeg'),
  m4a: !!probe.canPlayType('audio/mp4; codecs="mp4a.40.2"'),
  aac: !!probe.canPlayType('audio/aac'),
  ogg: !!probe.canPlayType('audio/ogg; codecs="vorbis"'),
  opus: !!probe.canPlayType('audio/ogg; codecs="opus"'),
  wav: !!probe.canPlayType('audio/wav'),
};

export const QUALITAETEN = [
  ['auto', t('Automatisch')],
  ['original', t('Original (verlustfrei)')],
  ['opus256', 'Opus 256 kbit/s'],
  ['opus160', 'Opus 160 kbit/s'],
  ['opus128', t('Opus 128 kbit/s (Datensparen)')],
  ['aac256', 'AAC 256 kbit/s'],
  ['aac160', 'AAC 160 kbit/s'],
];

/** Handy oder Tablet? (Client Hints, sonst Browserkennung; iPadOS meldet sich als Mac mit Touch) */
export function istMobilgeraet() {
  if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean' && navigator.userAgentData.mobile) return true;
  const ua = navigator.userAgent || '';
  if (/Android|iPhone|iPad|iPod|Mobile|Tablet|Silk|Kindle|PlayBook/i.test(ua)) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

// Lautheitsangleich (EBU R128): 'auto' = Album-Gain für Titel, die im Album direkt aufeinander folgen, sonst Titel-Gain
export const LAUTHEIT_ZIELE = [[-23, t('−23 LUFS (Rundfunk, sehr viel Reserve)')], [-20, '−20 LUFS'], [-18, t('−18 LUFS (wie ReplayGain)')],
  [-16, t('−16 LUFS (empfohlen)')], [-14, t('−14 LUFS (wie Spotify/YouTube)')]];
function lautJeLesen() { try { const j = JSON.parse(localStorage.getItem('aw_laut_je') || '{}'); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; } }
const STANDARD_EINST = { qualitaet_heim: 'auto', qualitaet_unterwegs: 'auto', lueckenlos: true, raumklang: 'aus', raumklang_letzt: 'dezent', raumklang_ir: 'auto', lautheit: 'auto', lautheit_ziel: -16, lautstaerke: 1, zufall: false, wiederholen: 'aus' };

function einstellungenLaden() {
  let e;
  try { e = Object.assign({}, STANDARD_EINST, JSON.parse(localStorage.getItem(EINST) || '{}')); } catch (x) { e = { ...STANDARD_EINST }; }
  // frühere Einzel-Einstellung „qualitaet“ gilt künftig für unterwegs; zuhause startet mit Automatisch (= Original)
  if (e.qualitaet) {
    if (e.qualitaet !== 'auto' && !localStorage.getItem(EINST + '-migriert')) e.qualitaet_unterwegs = e.qualitaet;
    delete e.qualitaet;
    try { localStorage.setItem(EINST + '-migriert', '1'); } catch (x) { /* egal */ }
  }
  return e;
}

export class Player extends EventTarget {
  constructor(app) {
    super();
    this.app = app;
    // Windows-Client: abgespielt wird in der Engine (bitgenau, WASAPI) statt im Browser
    this.audio = nativ ? new NativAudio() : new Audio();
    androidPlayer(this.audio);   // Android-App: Zustand an Benachrichtigung und Sperrbildschirm
    this.nativ = !!nativ;
    this.audio.preload = 'auto';
    // CORS-fähig, damit Streams von der Direktadresse im Heimnetz auch durch EQ/Raumklang/Pegel laufen dürfen
    this.audio.crossOrigin = 'anonymous';
    netzweg.addEventListener('wechsel', () => { this.melden('netz'); this.melden('zustand'); });
    this.liste = [];       // Tracks in Abspielreihenfolge
    this.index = -1;
    this.offset = 0;       // Startsekunde bei umgewandelten Streams (Spulen = neu starten ab t)
    this.modus = null;     // {art: 'original'|'umgewandelt', qualitaet, codec}
    this.einst = einstellungenLaden();
    this.netz = app.ich?.netz || { lokal: false, grund: 'extern' };
    this.mobil = istMobilgeraet();
    this.netzGeprueft = Date.now();
    this.netzBeobachten();
    // Wieder Netz: gespeicherte Titel nur noch unterwegs bevorzugen, Offline-Verlauf nachreichen
    window.addEventListener('online', () => { this._lokalErzwungen = false; setTimeout(() => offline.verlaufNachreichen(), 3000); });
    this.wiedergabeId = 0;
    this.gehoert = 0;
    this.letzteZeit = 0;
    this.letzteMeldung = 0;
    this.quelleKontext = null; // z. B. {art:'album', edition_id}
    this.audio.volume = this.einst.lautstaerke;
    this.serverZustand = 0;
    // Lückenlose Wiedergabe (gapless): ein durchgehender Strom, Titel sample-genau aneinander
    this.lautheit = new Map(); // Track-ID -> Messwerte (vom Server, einmal je Sitzung)
    this.lhDecke = -1;         // höchster True-Peak nach dem Anheben (dBTP)
    this.motor = new LueckenlosMotor(this.audio, {
      // Gespeichertes Original (FLAC, MP3 …) passt nicht in den Opus-Strom: dort endet der Motor, der Player lädt es einzeln
      naechster: (t) => { const n = this.naechsterNach(t); return n && this.lokal(n) && offline.format(n.id) !== 'opus' ? null : n; },
      // Opus-Ketten: der Server rechnet den Gain je Titel ein (sample-genau an jeder Titelgrenze)
      gain: (t) => this.lautheitFuer(t)?.db ?? 0,
      // offline gespeicherte Titel kommen aus dem Speicher der App
      lokal: (t) => this.lokal(t),
      ton: (t) => offline.ton(t.id),
      dauer: (t) => offline.dauer(t.id),
    });
    this.motor.addEventListener('wechsel', (e) => this.motorWechsel(e.detail));
    this.motor.addEventListener('fehler', (e) => this.motorFehler(e.detail));
    // Raumklang (Upmix): hängt sich erst beim ersten Abspielen an, und nur wenn eingeschaltet
    this.raumklang = new Raumklang(this.audio);
    this.raumklang.irWahl = this.einst.raumklang_ir || 'auto';
    this.raumklang.fein = { ...FEIN_STANDARD, ...(this.einst.raumklang_fein || {}) };
    this.einst.eq = eqNormal(this.einst.eq);
    this.raumklang.eq = this.einst.eq;
    // Reihenfolge der Effekte (früher nur „EQ vor/nach den Effekten“: vor = EQ zuerst)
    this.einst.reihe = reiheNormal(this.einst.reihe || (this.einst.eq_vorne ? ['eq', 'glow', 'iron', 'silk'] : null));
    delete this.einst.eq_vorne;
    this.raumklang.reihe = [...this.einst.reihe];
    this.einst.waerme = waermeNormal(this.einst.waerme);
    this.raumklang.waerme = this.einst.waerme;
    this.einst.band = bandNormal(this.einst.band);
    this.raumklang.band = this.einst.band;
    this.einst.trafo = trafoNormal(this.einst.trafo);
    this.raumklang.trafo = this.einst.trafo;
    // VST3-Plug-ins (Windows Client): Slot kommt/geht/läuft/fällt aus → Reihenfolge normalisieren, Kette der Engine neu
    vstRack.addEventListener('aenderung', (e) => {
      if (!e.detail?.nurAnzeige) {
        const neu = reiheNormal(this.einst.reihe);
        if (neu.join() !== this.einst.reihe.join()) this.reiheSetzen(neu);
        else this.raumklang.umbauen();
      }
      this.melden('zustand');
    });
    this.raumklang.beimAnschluss = () => this.lautstaerkeAnwenden();
    this.raumklang.beimWechsel = () => this.melden('zustand');   // Space schaltet sich auch selbst zu (Gerät meldet Surround)
    this.webAudioVorbereiten();
    this.audio.addEventListener('play', () => {
      if (!this.bypass && this.einst.raumklang !== 'aus' && this.raumklang.preset !== this.einst.raumklang) {
        this.raumklang.setzen(this.einst.raumklang).then(() => this.melden('zustand')).catch(() => {});
      }
    });
    // Titelwechsel an der Naht zügig erkennen (timeupdate kommt nur alle ~250 ms)
    setInterval(() => { if (this.motor.aktiv && !this.audio.paused) { this.motor.pruefen(); this.gainVorplanen(); } }, 100);
    this.fadeFaktor = 1; // 0..1, kurze Ein-/Ausblendung beim Starten, Pausieren und Fortsetzen (liegt auf der Lautstärke)
    // Nach einer ausgeblendeten Pause bleibt der Faktor auf 0: in Röhre, Band und Raumklang steckt noch ein Rest Signal
    // (Puffer, Verzögerungen, Hall), der sonst beim Zurücksetzen auf 1 kurz laut nachklingt. Hochgezogen wird beim nächsten Play.
    this.audio.addEventListener('pause', () => { this._gainGeplant = null; if (!this._fadeEinAktiv && !this._pauseGefadet) this.fadeFaktor = 1; this.lautstaerkeAnwenden(); });
    this.audio.addEventListener('play', () => {
      if (!this._pauseGefadet) return;
      this._pauseGefadet = false;
      // Start über umschalten() blendet selbst ein; jeder andere Start (Medientaste, Titelwahl, Kopfhörer) zieht hier hoch
      if (!this._fadeEinAktiv && !this._fadeTimer) this.fadeZu(1, document.hidden ? 0 : 150);
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.fadeBeenden(); });
    this.verbinden();
    this.statusVerbinden();
    this.wiederherstellen();
    this.mediaSession();
    if (nativ) this.nativVerbinden();
  }

  /** Windows-Client: nächsten Titel vormerken (lückenlos), Medientasten, Meldungen der Engine */
  nativVerbinden() {
    let geplant = false;
    const planen = () => {
      if (geplant) return;
      geplant = true;
      queueMicrotask(() => {
        geplant = false;
        const t = this.track;
        const n = t && this.audio.src ? this.naechsterNach(t) : null;
        this.audio.vormerken(n ? this.url(n, 'original') : null, n ? this.gainLinear(n) : 1);
      });
    };
    for (const e of ['track', 'liste', 'zustand']) this.addEventListener(e, planen);
    nativ.aufTaste?.((t) => {
      // über app.player: steuert dieses Gerät gerade ein anderes, gehen auch Medientasten und Tray dorthin
      const p = this.app?.player || this;
      if (t === 'playpause') p.umschalten();
      else if (t === 'next') p.weiter();
      else if (t === 'prev') p.zurueck();
      else if (t === 'stop') { if (this.fern?.aktiv) p.umschalten(); else this.pausieren(); }
    });
    this.audio.addEventListener('nativfehler', (e) => { toast(e.detail || t('Ausgabegerät-Fehler'), 'fehler'); this.melden('zustand'); });
    this.audio.addEventListener('nativformat', () => this.melden('zustand'));
    this.nativAusgabe = { geraet: '', exklusiv: false };
    this.nativGeraete = [];
    nativ.ausgabeLesen?.().then((w) => { if (w) this.nativAusgabe = w; this.melden('zustand'); this.ausgangBassLaden(); }).catch(() => {});
    this.nativGeraeteLaden();
  }

  /** Geräteliste des Clients (für die Schnellwahl der ASIO-Ausgänge im Player) */
  nativGeraeteLaden() {
    return nativ.geraete?.().then((l) => { if (Array.isArray(l) && l.length) this.nativGeraete = l; return this.nativGeraete; }).catch(() => this.nativGeraete);
  }

  /**
   * Windows-Client: Ausgabegerät/Modus ändern (gemerkt im Client; die Engine öffnet das Gerät sofort neu bzw. leitet bei
   * einem anderen Ausgang desselben ASIO-Treibers nur um). Die Lautstärke wird je Ausgabegerät gemerkt.
   */
  nativAusgabeSetzen(werte) {
    const alt = this.nativAusgabe.geraet || '';
    if (werte.geraet !== undefined && werte.geraet !== alt) {
      const je = lautJeLesen();
      je[alt] = this.einst.lautstaerke;
      if (je[werte.geraet] != null) this.lautstaerkeSetzen(je[werte.geraet]);
      try { localStorage.setItem('aw_laut_je', JSON.stringify(je)); } catch (e) { /* egal */ }
    }
    this.nativAusgabe = { ...this.nativAusgabe, ...werte };
    nativ.ausgabeSetzen(this.nativAusgabe);
    this.melden('zustand');
    this.ausgangBassLaden();
  }

  /**
   * Hat der gewählte Ausgang (ASIO) einen Sub bzw. Bassmanagement? Dann trennt nur die Engine; der Upmixer zeigt dieselbe
   * Trennfrequenz und ändert sie live am Ausgang (nativ.ausgangBass).
   */
  async ausgangBassLaden() {
    const g = String(this.nativAusgabe?.geraet || '');
    let info = { an: false };
    if (g.startsWith('asio:') && nativ?.ausgaengeLesen) {
      const [treiber, bus] = g.split('#');
      const r = await nativ.ausgaengeLesen(treiber).catch(() => null);
      const a = r?.ausgaenge?.find((x) => x.id === bus) || r?.ausgaenge?.[0];
      if (a?.sub && a.art !== 'kh') info = { an: true, hz: a.trenn || 80, treiber, id: a.id, ausgang: a };
    }
    this.ausgangBassInfo = info;
    ausgangBassSetzen(info);
    this.raumklang?.ausgangBassGeaendert?.();
    this.melden('zustand');
    return info;
  }

  /** Trennfrequenz (bzw. Delay/Phase) des Ausgangs live ändern – aus dem Space-Menü */
  async ausgangBassAendern(werte) {
    const i = this.ausgangBassInfo;
    if (!i?.an || !nativ?.ausgangBass) return null;
    const a = await nativ.ausgangBass(i.treiber, i.id, werte).catch(() => null);
    if (a) { this.ausgangBassInfo = { ...i, hz: a.trenn, ausgang: a }; ausgangBassSetzen(this.ausgangBassInfo); }
    return a;
  }

  /** gemerkte Lautstärke eines Ausgabegeräts (das gewählte: die aktuelle) */
  lautstaerkeVon(geraet) {
    if (geraet === (this.nativAusgabe.geraet || '')) return this.einst.lautstaerke;
    const w = lautJeLesen()[geraet];
    return w != null ? w : null;
  }

  get track() { return this.liste[this.index] || null; }
  get spielt() { return !this.audio.paused && !this.audio.ended; }
  get zeit() { return this.motor?.aktiv ? this.motor.zeitImTitel() : this.offset + (this.audio.currentTime || 0); }
  /**
   * Zeit für Anzeigen (Fortschrittsbalken): nach dem Spulen das Ziel, bis die Wiedergabe dort angekommen ist – beim
   * Neuladen ab der Stelle steht die echte Zeit sonst kurz auf 0 und der Balken zuckt an den Anfang. Höchstens 3 s.
   */
  get anzeigeZeit() {
    const z = this.zeit, s = this._sprung;
    if (!s) return z;
    if (s.track !== this.track || performance.now() > s.bis || Math.abs(z - s.ziel) < 1) { this._sprung = null; return z; }
    return s.ziel;
  }
  get dauer() {
    if (this.motor?.aktiv && this.motor.dauerTitel()) return this.motor.dauerTitel();
    const t = this.track;
    if (t && t.laenge_ms) return t.laenge_ms / 1000;
    return isFinite(this.audio.duration) ? this.audio.duration + this.offset : 0;
  }

  melden(art) {
    if (art === 'track' || art === 'lautheit') this.waermeBezugAnwenden();
    this.dispatchEvent(new Event(art));
  }

  verbinden() {
    const a = this.audio;
    a.addEventListener('play', () => this.melden('zustand'));
    a.addEventListener('pause', () => { this.melden('zustand'); this.verlaufMelden('fortschritt'); this.speichern(); });
    a.addEventListener('playing', () => {
      if (!this.wiedergabeId && this.track) this.verlaufMelden('start');
      this.melden('zustand');
    });
    a.addEventListener('timeupdate', () => {
      if (this.motor.aktiv) this.motor.pruefen();
      const jetzt = a.currentTime;
      const d = jetzt - this.letzteZeit;
      if (d > 0 && d < 2) this.gehoert += d;
      this.letzteZeit = jetzt;
      if (Date.now() - this.letzteMeldung > 30000) this.verlaufMelden('fortschritt');
      this.melden('zeit');
      if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && this.dauer > 0) {
        try { navigator.mediaSession.setPositionState({ duration: this.dauer, position: Math.min(this.zeit, this.dauer), playbackRate: 1 }); } catch (e) {}
      }
    });
    a.addEventListener('ended', () => {
      this.verlaufMelden('ende');
      if (this.einst.wiederholen === 'eins') { this.springen(0); this.audio.play(); return; }
      this.weiter(true);
    });
    a.addEventListener('error', () => {
      if (!this.track) return;
      // Direktadresse weg (z. B. Haus verlassen): auf dem normalen Weg weiter
      if (!this.motor.aktiv && netzweg.istDirekt(a.currentSrc || a.src)) {
        netzweg.ausfall();
        this.laden(this.zeit, true);
        return;
      }
      if (this.lokalErsatz()) return;
      if (this.motor.aktiv) { this.motorFehler(a.error); return; }
      // Original nicht abspielbar? Einmal mit Umwandlung versuchen.
      if (this.modus?.art === 'original' && !this._ersatzVersucht) {
        this._ersatzVersucht = true;
        this.laden(this.zeit, true, 'opus256');
        return;
      }
      toast(t('Dieser Titel lässt sich gerade nicht abspielen.'), 'fehler');
      this.melden('zustand');
    });
    a.addEventListener('waiting', () => this.melden('zustand'));
    a.addEventListener('volumechange', () => this.melden('lautstaerke'));
    window.addEventListener('pagehide', () => { this.verlaufMelden('fortschritt', true); this.speichern(true); });
  }

  // ---------- Qualität ----------
  /** „heim“ oder „unterwegs“ – je nachdem, wo das Gerät gerade ist */
  get bereich() { return (this.netz?.lokal || netzweg.erreichbar) ? 'heim' : 'unterwegs'; }
  /** Eingestellte Qualität für den aktuellen Bereich (auf diesem Gerät gemerkt) */
  get qualitaet() { return this.einst[`qualitaet_${this.bereich}`] || 'auto'; }

  // ---------- Offline gespeicherte Titel ----------
  /** Nur gespeicherte Titel spielbar? (App ohne Server gestartet oder Gerät offline) */
  get nurLokal() { return !nativ && (!!this.app?.offline || navigator.onLine === false); }

  /**
   * Titel aus dem Speicher der App spielen statt vom Server? Ja, wenn er gespeichert ist und das Gerät offline oder
   * unterwegs ist (spart Daten, Opus 256 ist ohnehin die Qualität unterwegs) – zuhause läuft weiter das Original.
   */
  lokal(t) {
    if (!t || nativ || !offline.hat(t.id)) return false;
    return this.nurLokal || this._lokalErzwungen || this.bereich === 'unterwegs';
  }

  /** Server nicht erreichbar, Titel aber gespeichert: ab hier aus dem Speicher weiterspielen */
  lokalErsatz() {
    const t = this.track;
    if (!t || nativ || this._lokalErzwungen || !offline.hat(t.id) || this.modus?.art === 'offline' || this.motor.aktuell?.lokal) return false;
    this._lokalErzwungen = true;
    this.laden(this.zeit, true);
    return true;
  }

  /** Was „Automatisch“ gerade bedeutet, mit Begründung */
  autoQualitaet() {
    if (netzweg.erreichbar) return { q: 'original', grund: t('direkt im Heimnetz') };
    if (this.netz?.lokal) return { q: 'original', grund: t('zuhause im Heimnetz') };
    const c = navigator.connection;
    const sparen = c && (c.saveData || c.type === 'cellular' || ['slow-2g', '2g', '3g'].includes(c.effectiveType));
    if (this.mobil) return sparen ? { q: 'opus128', grund: t('Handy/Tablet im Mobilfunk') } : { q: 'opus160', grund: t('Handy/Tablet unterwegs') };
    if (sparen) return { q: 'opus128', grund: t('langsame Verbindung') };
    const std = this.app.ich?.app?.stream_standard;
    return { q: std && std !== 'auto' ? std : 'opus256', grund: t('unterwegs') };
  }

  zielQualitaet(track) {
    if (nativ) return 'original'; // Windows-Client: die Engine spielt immer das Original (alles als FLAC vom Server)
    let q = this.qualitaet;
    if (q === 'auto') q = this.autoQualitaet().q;
    if (q === 'original' && this.lueckenlosMoeglich('flac')) return 'original'; // der Server liefert jedes Format verlustfrei als FLAC
    // Original geht hier nicht lückenlos (z. B. Chrome auf Android: kein FLAC im MSE-Strom) – dann lückenlos mit Opus 256,
    // sofern gewünscht (Standard). Opus 256 ist in der Praxis transparent; die Pausen zwischen den Titeln wären es nicht.
    if (q === 'original' && this.einst.lueckenlos !== false && this.einst.lueckenlos_vorrang !== false && this.lueckenlosMoeglich('opus')) return 'opus256';
    if (q === 'original') {
      const fmt = track?.format?.datei;
      const ok = fmt && (kann[fmt] || (fmt === 'opus' && kann.opus) || (fmt === 'm4a' && kann.m4a && track.format.codec !== 'alac'));
      if (!fmt || ok) return 'original';
      q = 'opus256'; // z. B. WavPack, DSD, APE: Browser kann das nicht direkt
    }
    if (q.startsWith('opus') && !kann.opus) q = q.replace('opus', 'aac').replace('aac128', 'aac160');
    return q;
  }

  url(track, q, ab = 0) {
    const t = ab > 0.5 ? `&t=${ab.toFixed(1)}` : '';
    // Umgewandelte Streams bekommen den Lautheitsangleich gleich vom Server (dann geht auch Anheben ohne Web Audio)
    const g = q !== 'original' ? this.lautheitFuer(track)?.db || 0 : 0;
    return netzweg.url(`/api/v1/stream/${track.id}?q=${q}${q === 'original' ? '' : t}${g ? `&g=${g.toFixed(2)}` : ''}`);
  }

  /** Läuft der aktuelle Titel direkt im Heimnetz? */
  get direktAktiv() {
    return this.motor?.aktiv ? !!this.motor.direkt : netzweg.istDirekt(this.audio.currentSrc || this.audio.src);
  }

  // ---------- Lautheit (EBU R128) ----------
  /** Messwerte für Titel nachladen (nur fehlende; noch nicht gemessene werden nach 5 Minuten erneut gefragt) */
  async lautheitLaden(tracks) {
    if (this.einst.lautheit === 'aus') return;
    const jetzt = Date.now();
    let ids = [...new Set((tracks || []).filter((t) => t?.id).map((t) => t.id))].filter((id) => {
      const l = this.lautheit.get(id);
      return !l || (l.q === 'fehlt' && jetzt - l.zeit > 300000);
    });
    // Gespeicherte Titel bringen ihre Messwerte mit (auch ohne Netz)
    ids = ids.filter((id) => {
      const l = offline.lautheit(id);
      if (!l) return true;
      this.lautheit.set(id, { ...l, zeit: jetzt });
      return false;
    });
    if (this.lhDecke === -1 && this.nurLokal) { const d = Number(localStorage.getItem('aw_lh_decke')); if (Number.isFinite(d) && d) this.lhDecke = d; }
    if (!ids.length || this.nurLokal) return;
    for (let i = 0; i < ids.length; i += 400) {
      const teil = ids.slice(i, i + 400);
      try {
        const r = await api.get(`/lautheit?ids=${teil.join(',')}`);
        if (typeof r?.decke === 'number') this.lhDecke = r.decke;
        for (const id of teil) this.lautheit.set(id, r?.tracks?.[id] ? { ...r.tracks[id], zeit: jetzt } : { q: 'fehlt', zeit: jetzt });
      } catch (e) { return; } // offline – ohne Angleich weiter
    }
  }

  /**
   * Gain für einen Titel in der Warteschlange.
   * Album-Gain, wenn der Titel mit seinem Vorgänger oder Nachfolger in Albumreihenfolge direkt zusammenhängt
   * (ganzes Album, aber auch zwei aufeinanderfolgende Albumtitel in einer Playlist) – so bleiben die Lautstärkeverhältnisse
   * innerhalb des Albums erhalten. Sonst Titel-Gain. Anheben nur, solange der True-Peak unter der Decke (−1 dBTP) bleibt.
   */
  lautheitFuer(track, liste = this.liste, trotzAus = false) {
    if (!track || (this.einst.lautheit === 'aus' && !trotzAus)) return null;
    const l = this.lautheit.get(track.id);
    if (!l || l.q === 'fehlt') return { db: 0, art: 'fehlt' };
    const i = liste.indexOf(track);
    const folgt = (a, b) => a && b && a.q !== 'fehlt' && b.q !== 'fehlt' && a.e === b.e && b.o === a.o + 1;
    const nachbar = (o) => this.lautheit.get(liste[i + o]?.id);
    const album = l.a != null && i >= 0 && (folgt(nachbar(-1), l) || folgt(l, nachbar(1)));
    const lufs = album ? l.a : (l.t ?? l.a);
    const tp = album ? l.atp : (l.ttp ?? l.atp);
    if (lufs == null) return { db: 0, art: 'fehlt' };
    const ziel = Number(this.einst.lautheit_ziel) || -16;
    let db = ziel - lufs;
    let begrenzt = false;
    if (db > 0) {
      const raum = tp == null ? 0 : Math.max(0, this.lhDecke - tp);
      if (db > raum) { db = raum; begrenzt = true; }
    }
    return { db: Math.round(db * 100) / 100, art: album ? 'album' : 'titel', lufs, tp, ziel, begrenzt, quelle: l.q };
  }

  /** Wird der Gain des laufenden Titels vom Server eingerechnet (umgewandelter Stream)? */
  get gainAmServer() { return this.gainImStrom(this.track); }

  /** Steckt der Lautheitsangleich für diesen Titel schon im Strom? (Opus-Kette vom Server ja, gespeicherte Titel nicht) */
  gainImStrom(track) {
    if (this.motor?.aktiv) {
      if (this.motor.art !== 'opus') return false;
      const a = track === this.track ? this.motor.aktuell : this.motor.abschnitte.find((x) => x.track === track);
      return !(a ? a.lokal : this.lokal(track));
    }
    return this.modus?.art === 'umgewandelt';
  }

  /** Lautstärke-Faktor für einen Titel (Regler × Lautheitsangleich, sofern der nicht schon im Stream steckt) */
  /** Lautheits-Gain linear, soweit er im Browser angewandt wird (steckt er schon im Stream, 1) */
  gainLinear(track) {
    const db = this.gainImStrom(track) ? 0 : (this.lautheitFuer(track)?.db || 0);
    return Math.pow(10, db / 20);
  }

  lautstaerkeWert(track) {
    return Math.max(0, this.einst.lautstaerke * this.gainLinear(track));
  }

  /** Lautheit, wie sie an der Röhre ankommt: Datei-LUFS, bzw. das Ziel, wenn der Angleich schon im Stream steckt */
  waermeBezugAnwenden(track = this.track) {
    if (!this.raumklang) return;
    // Messwerte gelten auch, wenn der Lautheitsangleich aus ist – dann kommt der Titel mit seiner Original-Lautheit an
    const angleichAn = this.einst.lautheit !== 'aus';
    const lh = this.lautheitFuer(track, this.liste, true);
    let lufs = null;
    if (lh && lh.art !== 'fehlt' && lh.lufs != null) lufs = angleichAn && this.gainAmServer ? lh.lufs + lh.db : lh.lufs;
    this.raumklang.waermeLautheit(lufs);
  }

  lautstaerkeAnwenden() {
    this.waermeBezugAnwenden();
    // Über Web Audio: Gain vor dem Messpunkt (Meter zeigen den Pegel nach Angleich), Lautstärke dahinter; dort geht auch Anheben
    const f = this.fadeFaktor ?? 1;
    if (nativ) {
      // Engine: Angleich und Lautstärke getrennt – der Angleich wechselt sample-genau an der Titelgrenze, Anheben geht (Decke −1 dBTP)
      const g = this.gainLinear(this.track);
      this.audio.gain = g;
      this.audio.volume = Math.max(0, this.einst.lautstaerke) * f;
      this.raumklang?.lautstaerke(Math.max(0, this.einst.lautstaerke) * f, g);
    } else if (this.raumklang?.angeschlossen) { this.audio.volume = 1; this.raumklang.lautstaerke(Math.max(0, this.einst.lautstaerke) * f, this.gainLinear(this.track)); }
    else this.audio.volume = Math.min(1, this.lautstaerkeWert(this.track) * f); // ohne Web Audio kann das Element nur absenken
  }

  // ---------- Kurze Fades (Start, Pause, Fortsetzen) ----------
  // Nur auf Handgriffe des Nutzers; Titelwechsel von selbst und der lückenlose Übergang bleiben unberührt.
  // Im Hintergrund (Sperrbildschirm, anderer Tab) gibt es keine Fades, weil dort Zeitgeber gedrosselt werden könnten.
  fadeZu(ziel, ms, fertig = null) {
    this.fadeAbbrechen();
    if (document.hidden || ms <= 0 || Math.abs((this.fadeFaktor ?? 1) - ziel) < 0.001) {
      this.fadeFaktor = ziel;
      this.lautstaerkeAnwenden();
      if (fertig) fertig();
      return;
    }
    const von = this.fadeFaktor ?? 1;
    const t0 = performance.now();
    const schritt = () => {
      const t = Math.min(1, (performance.now() - t0) / ms);
      // Sinus-Kurve: sanfter Anfang und Ende, kein hörbarer Knick
      this.fadeFaktor = von + (ziel - von) * Math.sin(t * Math.PI / 2);
      this.lautstaerkeAnwenden();
      if (t < 1) { this._fadeTimer = setTimeout(schritt, 12); return; }
      this._fadeTimer = null;
      this.fadeFaktor = ziel;
      this.lautstaerkeAnwenden();
      if (fertig) fertig();
    };
    schritt();
  }

  fadeAbbrechen() {
    clearTimeout(this._fadeTimer);
    this._fadeTimer = null;
    this._fadeAusPause = null;
  }

  /** Fade sofort auf den Endwert (z. B. wenn die Seite in den Hintergrund geht) */
  fadeBeenden() {
    if (this._fadeTimer || this._fadeAusPause) {
      const pausieren = this._fadeAusPause;
      this.fadeAbbrechen();
      if (pausieren) { this._pauseGefadet = true; this.audio.pause(); this.fadeFaktor = 0; } else this.fadeFaktor = 1;
      this._fadeEinAktiv = false;
      this.lautstaerkeAnwenden();
    }
  }

  /** Nach dem Start einer Wiedergabe von Hand einblenden (vorher: Lautstärke auf 0 setzen) */
  fadeEinVorbereiten() {
    if (nativ) { this.audio.einblenden = 200; return; } // Windows-Client: die Engine blendet sample-genau ein
    if (document.hidden) return;
    this.fadeAbbrechen();
    this._fadeEinAktiv = true;
    this.fadeFaktor = 0;
    this.lautstaerkeAnwenden();
    // Sicherung: scheitert der Start (Fehler, abgelehnt), darf die Lautstärke nicht auf 0 hängen bleiben
    clearTimeout(this._fadeWacht);
    this._fadeWacht = setTimeout(() => { if (this._fadeEinAktiv && !this._fadeTimer) { this._fadeEinAktiv = false; this.fadeFaktor = 1; this.lautstaerkeAnwenden(); } }, 7000);
  }

  fadeEinStarten(ms = 200) {
    if (!this._fadeEinAktiv) return;
    this.fadeZu(1, ms, () => { this._fadeEinAktiv = false; });
  }

  /** Pause von Hand: kurz ausblenden, dann anhalten */
  /** Stopp: anhalten und an den Anfang des Titels (die Warteschlange bleibt) */
  stoppen() {
    if (!this.track) return;
    const zumAnfang = () => { this.springen(0, false); this.melden('zeit'); this.melden('zustand'); };
    if (this.audio.paused) { zumAnfang(); return; }
    this.pausieren();
    setTimeout(zumAnfang, 260);   // erst ausblenden lassen
  }

  pausieren() {
    if (this.audio.paused) return;
    if (nativ) { this.audio.pause(150); return; } // Engine blendet aus und hält erst danach an
    if (document.hidden || this._fadeAusPause) { this.fadeAbbrechen(); this.audio.pause(); return; }
    this._fadeEinAktiv = false;
    this.fadeZu(0, 150, () => {
      // Lautstärke-Rampe (10 ms Zeitkonstante) erst ganz auslaufen lassen, dann anhalten
      this._fadeTimer = setTimeout(() => { this._fadeTimer = null; this._fadeAusPause = null; this._pauseGefadet = true; this.audio.pause(); }, 60);
    });
    this._fadeAusPause = true; // fadeZu leert das Merkzeichen zuerst, darum danach setzen
  }

  /**
   * FLAC-Strom über Web Audio: den Gain des nächsten Titels genau auf die Titelgrenze legen
   * (statt erst beim Erkennen des Wechsels, das bis zu 100 ms später kommt).
   */
  gainVorplanen() {
    if (!this.raumklang?.angeschlossen || this.einst.lautheit === 'aus') return;
    const a = this.motor.aktuell;
    const n = a && this.motor.abschnitte[this.motor.abschnitte.indexOf(a) + 1];
    if (!n || this._gainGeplant === n) return;
    const rest = n.start - this.audio.currentTime;
    if (rest <= 0 || rest > 0.4) return;
    this._gainGeplant = n;
    const g = this.gainLinear(n.track);
    if (Math.abs(g - this.gainLinear(this.track)) > 1e-4) this.raumklang.lautstaerke(Math.max(0, this.einst.lautstaerke), g, rest, 0.002);
  }

  /** Lautheitsangleich ein/aus bzw. Zielwert – pro Gerät gemerkt */
  async lautheitSetzen(werte) {
    Object.assign(this.einst, werte);
    this.einstSpeichern();
    api.put('/geraet/einstellungen', { einstellungen: werte }).catch(() => {});
    await this.lautheitLaden(this.liste);
    // Steckt der Gain im Stream, muss der neu angefordert werden; sonst genügt die Lautstärke
    if (this.gainAmServer && this.track && this.audio.src) this.laden(this.zeit, !this.audio.paused, this.modus?.qualitaet);
    else this.lautstaerkeAnwenden();
    this.melden('zustand');
  }

  /** Pegelanzeige an? (Standard: an am Desktop, aus an Handy/Tablet – dort könnte Web Audio die Wiedergabe im Hintergrund stören) */
  get pegelAn() { return this.einst.pegel ?? !this.mobil; }

  /** Web Audio braucht eine Nutzeraktion: beim ersten Klick/Tastendruck anschließen, falls Pegel oder Raumklang an sind */
  webAudioVorbereiten() {
    if (nativ) {
      // Windows Client: Kette und Messpunkte sitzen in der Engine – kein Web Audio, keine Nutzeraktion nötig. Unberührt bleibt es
      // bitgenau: die Engine rechnet erst, wenn eine Stufe wirksam ist.
      const fertig = this.raumklang.anschliessen().then(() => (!this.bypass && this.einst.raumklang !== 'aus' ? this.raumklang.setzen(this.einst.raumklang) : null));
      fertig.then(() => { this.melden('zustand'); this.melden('pegel'); }).catch((e) => console.warn('Engine-Kette', e));
      return;
    }
    const los = () => {
      if (this.pegelAn || this.einst.raumklang !== 'aus' || eqWirksam(this.einst.eq) || waermeWirksam(this.einst.waerme) || bandWirksam(this.einst.band) || trafoWirksam(this.einst.trafo)) {
        document.removeEventListener('pointerdown', los, true);
        document.removeEventListener('keydown', los, true);
        const fertig = this.einst.raumklang !== 'aus' ? this.raumklang.setzen(this.einst.raumklang) : this.raumklang.anschliessen();
        fertig.then(() => { this.melden('zustand'); this.melden('pegel'); }).catch((e) => console.warn('Web Audio', e));
      }
    };
    document.addEventListener('pointerdown', los, true);
    document.addEventListener('keydown', los, true);
  }

  /** EQ-Einstellung übernehmen: sofort hörbar, im Browser sofort und am Server (pro Gerät) kurz verzögert gemerkt */
  eqSetzen(eq) {
    this.einst.eq = eqNormal(eq);
    this.raumklang.eqSetzen(this.einst.eq);
    if (eqWirksam(this.einst.eq) && !this.raumklang.angeschlossen) {
      this.raumklang.anschliessen().then(() => { this.melden('zustand'); this.melden('pegel'); }).catch(() => {});
    }
    this.einstSpeichern();
    clearTimeout(this._eqTimer);
    this._eqTimer = setTimeout(() => api.put('/geraet/einstellungen', { einstellungen: { eq: this.einst.eq } }).catch(() => {}), 600);
    this.melden('zustand');
  }

  /** Reihenfolge von Glow, Iron, Silk und EQ – sofort hörbar (kurze Blende), pro Gerät gemerkt */
  reiheSetzen(reihe) {
    this.einst.reihe = reiheNormal(reihe);
    this.raumklang.reiheSetzen(this.einst.reihe);
    this.einstSpeichern();
    api.put('/geraet/einstellungen', { einstellungen: { reihe: this.einst.reihe } }).catch(() => {});
    this.melden('zustand');
  }

  /** Alle Effekte umgehen (zum Vergleichen, wird nicht gemerkt): Glow, Iron, Silk, EQ und Space */
  async bypassSetzen(an) {
    this.bypass = !!an;
    this.raumklang.bypassSetzen(this.bypass);
    if (this.raumklang.angeschlossen) {
      const soll = this.bypass ? 'aus' : this.einst.raumklang;
      if (this.raumklang.preset !== soll) { try { await this.raumklang.setzen(soll); } catch (e) { /* egal */ } }
    }
    this.melden('zustand');
  }

  /**
   * Zustand des ganzen Racks (für Gesamt-Presets und A/B): Reihenfolge, an/aus, HQ und alle Werte jedes Geräts.
   * Die Ausgabe (Stereo/5.1) gehört dem Gerät und steht nicht darin.
   */
  rackZustand() {
    const e = this.einst;
    return JSON.parse(JSON.stringify({
      reihe: e.reihe, waerme: e.waerme, trafo: e.trafo, band: e.band, eq: e.eq,
      space: { preset: e.raumklang, letzt: e.raumklang_letzt, ir: e.raumklang_ir || 'auto', fein: { ...FEIN_STANDARD, ...(e.raumklang_fein || {}) } },
    }));
  }

  /** Rack-Zustand übernehmen (Gesamt-Preset oder A/B) – alles sofort hörbar und pro Gerät gemerkt */
  async rackAnwenden(z) {
    if (!z || typeof z !== 'object') return;
    if (z.waerme) this.waermeSetzen(z.waerme);
    if (z.trafo) this.trafoSetzen(z.trafo);
    if (z.band) this.bandSetzen(z.band);
    if (z.eq) this.eqSetzen(z.eq);
    if (z.reihe) this.reiheSetzen(z.reihe);
    const sp = z.space;
    if (sp && typeof sp === 'object') {
      if (sp.fein) this.raumklangFeinSetzen(sp.fein);
      if (typeof sp.letzt === 'string' && RAUMKLANG_PRESETS[sp.letzt]) this.einst.raumklang_letzt = sp.letzt;
      const irNeu = typeof sp.ir === 'string' && sp.ir !== (this.einst.raumklang_ir || 'auto');
      if (irNeu) { this.einst.raumklang_ir = sp.ir; this.raumklang.irWahl = sp.ir; api.put('/geraet/einstellungen', { einstellungen: { raumklang_ir: sp.ir } }).catch(() => {}); }
      const preset = RAUMKLANG_PRESETS[sp.preset] ? sp.preset : 'aus';
      const kann = !!layoutFuer(this.raumklang.ctx ? this.raumklang.ctx.destination.maxChannelCount : ausgabeKanaele());
      if (preset !== this.einst.raumklang || (irNeu && this.raumklang.aktiv)) {
        if (preset === 'aus' || kann) await this.raumklangSetzen(preset);
        else { this.einst.raumklang = 'aus'; api.put('/geraet/einstellungen', { einstellungen: { raumklang: 'aus', raumklang_letzt: this.einst.raumklang_letzt } }).catch(() => {}); }
      }
    }
    this.einstSpeichern();
    this.melden('zustand');
  }

  /** Wärme (Röhrensättigung) übernehmen: sofort hörbar, pro Gerät gemerkt */
  waermeSetzen(w) {
    this.einst.waerme = waermeNormal(w);
    this.waermeBezugAnwenden();
    this.raumklang.waermeSetzen(this.einst.waerme);
    if (waermeWirksam(this.einst.waerme) && !this.raumklang.angeschlossen) {
      this.raumklang.anschliessen().then(() => { this.melden('zustand'); this.melden('pegel'); }).catch(() => {});
    }
    this.einstSpeichern();
    clearTimeout(this._waermeTimer);
    this._waermeTimer = setTimeout(() => api.put('/geraet/einstellungen', { einstellungen: { waerme: this.einst.waerme } }).catch(() => {}), 600);
    this.melden('zustand');
  }

  /** Übertrager übernehmen: sofort hörbar, pro Gerät gemerkt */
  trafoSetzen(t) {
    this.einst.trafo = trafoNormal(t);
    this.waermeBezugAnwenden();
    this.raumklang.trafoSetzen(this.einst.trafo);
    if (trafoWirksam(this.einst.trafo) && !this.raumklang.angeschlossen) {
      this.raumklang.anschliessen().then(() => { this.melden('zustand'); this.melden('pegel'); }).catch(() => {});
    }
    this.einstSpeichern();
    clearTimeout(this._trafoTimer);
    this._trafoTimer = setTimeout(() => api.put('/geraet/einstellungen', { einstellungen: { trafo: this.einst.trafo } }).catch(() => {}), 600);
    this.melden('zustand');
  }

  /** Band (Bandmaschine) übernehmen: sofort hörbar, pro Gerät gemerkt */
  bandSetzen(b) {
    this.einst.band = bandNormal(b);
    this.waermeBezugAnwenden();
    this.raumklang.bandSetzen(this.einst.band);
    if (bandWirksam(this.einst.band) && !this.raumklang.angeschlossen) {
      this.raumklang.anschliessen().then(() => { this.melden('zustand'); this.melden('pegel'); }).catch(() => {});
    }
    this.einstSpeichern();
    clearTimeout(this._bandTimer);
    this._bandTimer = setTimeout(() => api.put('/geraet/einstellungen', { einstellungen: { band: this.einst.band } }).catch(() => {}), 600);
    this.melden('zustand');
  }

  pegelSetzen(an) {
    this.einst.pegel = !!an;
    this.einstSpeichern();
    api.put('/geraet/einstellungen', { einstellungen: { pegel: !!an } }).catch(() => {});
    if (an && !this.raumklang.angeschlossen) this.raumklang.anschliessen().then(() => { this.melden('zustand'); this.melden('pegel'); });
    else this.melden('pegel');
  }

  /** Lückenlos möglich? (Einstellung an, Browser kann es, kein Fehler in dieser Sitzung) */
  lueckenlosMoeglich(art) {
    if (nativ) return false; // die Engine macht das selbst (sample-genau)
    return this.einst.lueckenlos !== false && !this._motorGestoert?.[art] && LueckenlosMotor.kann(art);
  }

  /** Warum läuft „Original“ hier nicht lückenlos? (null = es läuft) */
  get lueckenlosGrund() {
    if (this.einst.lueckenlos === false) return 'aus';
    if (this._motorGestoert?.flac) return 'fehler';
    if (!LueckenlosMotor.kann('flac')) return 'browser';
    return null;
  }

  /** Welcher Titel folgt auf track? (für das Vorladen; berücksichtigt Wiederholen) */
  naechsterNach(track) {
    const i = this.liste.indexOf(track);
    if (i < 0) return null;
    if (this.einst.wiederholen === 'eins') return track;
    // Ohne Netz nur gespeicherte Titel; die anderen werden übersprungen
    const geht = (t) => !this.nurLokal || offline.hat(t.id);
    for (let k = i + 1; k < this.liste.length; k++) if (geht(this.liste[k])) return this.liste[k];
    if (this.einst.wiederholen === 'alle') for (let k = 0; k <= i; k++) if (geht(this.liste[k])) return this.liste[k];
    return null;
  }

  /** Nahtloser Übergang zum nächsten Titel (vom Motor gemeldet) */
  motorWechsel({ track }) {
    this.verlaufMelden('ende');
    const i = this.liste.indexOf(track);
    if (i >= 0) this.index = i;
    this.neuerTrack();
    this.letzteZeit = this.audio.currentTime;
    this.lautstaerkeAnwenden();
    this.metadaten();
    this.verlaufMelden('start');
    this.melden('track');
    this.melden('liste');
    this.speichern();
  }

  /** Fehler im lückenlosen Strom: für diese Sitzung auf die klassische Wiedergabe umschalten */
  motorFehler(e) {
    if (this.lokalErsatz()) return;   // Server weg, Titel aber gespeichert
    const art = this.motor.art || 'flac';
    console.warn(`Lückenlose Wiedergabe (${art}) gestört:`, e);
    this._motorGestoert = this._motorGestoert || {};
    if (this._motorGestoert[art]) return;
    this._motorGestoert[art] = true;
    this.motorFehlerText = `${art.toUpperCase()}: ${e?.message || e?.name || e?.code || t('unbekannter Fehler')}`;
    const pos = this.zeit;
    const spielte = !this.audio.paused;
    this.motor.stop();
    this.laden(pos, spielte || true);
  }

  /** Nach Änderungen an der Warteschlange: Vorgeladenes anpassen */
  planAnpassen() {
    this.lautheitLaden(this.liste).then(() => this.lautstaerkeAnwenden());
    if (this.motor.aktiv && !this.motor.planPruefen()) this.laden(this.zeit, !this.audio.paused, this.modus?.qualitaet);
  }

  /** Track laden (ohne Format-Infos werden sie bei Bedarf nachgeladen). */
  async laden(ab = 0, abspielen = true, erzwingen = null) {
    let trk = this.track;
    if (!trk) return;
    if (this.nurLokal && !offline.hat(trk.id)) {
      // Ohne Netz: zum nächsten gespeicherten Titel
      const i = this.liste.findIndex((x, k) => k > this.index && offline.hat(x.id));
      if (i < 0) { toast(t('Ohne Netz spielen nur Titel, die auf diesem Gerät gespeichert sind.'), 'fehler'); this.audio.pause(); this.melden('zustand'); return; }
      this.index = i;
      trk = this.track;
      ab = 0;
      this.melden('liste');
    }
    if (this.lokal(trk)) { await this.lokalLaden(trk, ab, abspielen); return; }
    if (netzweg.laeuft) await netzweg.laeuft; // Prüfung der Direktadresse läuft gerade (höchstens 2,5 s)
    netzweg.beiTitel(); // Titelwechsel = Gelegenheit zu prüfen, ob wir wieder zuhause sind (gilt ab dem nächsten Titel, blockiert nichts)
    // Lautheit der Warteschlange holen (meist schon da); höchstens 1,5 s warten, sonst ohne Angleich starten
    await Promise.race([this.lautheitLaden(this.liste), new Promise((r) => setTimeout(r, 1500))]);
    if (this.track !== trk) return; // inzwischen anderer Titel gewählt
    const qm = erzwingen || this.zielQualitaet(trk);
    const art = qm === 'original' ? 'flac' : qm.startsWith('opus') ? 'opus' : null;
    if (art && this.lueckenlosMoeglich(art)) {
      const gewuenscht = erzwingen || (this.qualitaet === 'auto' ? this.autoQualitaet().q : this.qualitaet);
      this.modus = { art: qm === 'original' ? 'original' : 'umgewandelt', qualitaet: qm, lueckenlos: true, ersatz: gewuenscht === 'original' && qm !== 'original' };
      this.offset = 0;
      this.letzteZeit = ab;
      const start = this.motor.start(trk, ab, art, qm);
      this.lautstaerkeAnwenden();
      this.metadaten();
      this.melden('track');
      this.melden('zustand');
      try { await start; } catch (e) { this.motorFehler(e); return; } // z. B. Format beim Anlegen abgelehnt
      if (abspielen) {
        try { await this.audio.play(); this.fadeEinStarten(); } catch (e) { this.fadeEinStarten(0); if (e.name !== 'AbortError') this.melden('zustand'); }
      }
      return;
    }
    this.motor.stop();
    if (!trk.format && this.zielQualitaet({}) === 'original') {
      try { const info = await api.get(`/tracks/${trk.id}`); trk.format = info.datei ? { datei: info.datei.format, codec: info.datei.codec, abtastrate: info.datei.abtastrate, bittiefe: info.datei.bittiefe, kanaele: info.datei.kanaele } : null; } catch (e) {}
    }
    const q = erzwingen || this.zielQualitaet(trk);
    this.modus = { art: q === 'original' ? 'original' : 'umgewandelt', qualitaet: q };
    this.offset = q === 'original' ? 0 : ab;
    this.letzteZeit = 0;
    this.audio.src = this.url(trk, q, ab);
    if (nativ && ab > 0) this.audio.currentTime = ab;
    else if (q === 'original' && ab > 0) {
      const setzen = () => { this.audio.currentTime = ab; this.audio.removeEventListener('loadedmetadata', setzen); };
      this.audio.addEventListener('loadedmetadata', setzen);
    }
    this.lautstaerkeAnwenden();
    this.metadaten();
    this.melden('track');
    this.melden('zustand');
    if (abspielen) {
      try { await this.audio.play(); this.fadeEinStarten(); } catch (e) { this.fadeEinStarten(0); if (e.name !== 'AbortError') this.melden('zustand'); }
    }
  }

  /** Gespeicherten Titel spielen: lückenlos über den Motor (Opus aus dem Speicher), sonst direkt als Datei */
  async lokalLaden(trk, ab, abspielen) {
    await this.lautheitLaden(this.liste);
    if (this.track !== trk) return;
    const q = offline.qualitaet(trk.id);
    if (offline.format(trk.id) === 'opus' && this.lueckenlosMoeglich('opus')) {
      this.modus = { art: 'offline', qualitaet: q, lueckenlos: true };
      this.offset = 0;
      this.letzteZeit = ab;
      const start = this.motor.start(trk, ab, 'opus', q);
      this.lautstaerkeAnwenden();
      this.metadaten();
      this.melden('track');
      this.melden('zustand');
      try { await start; } catch (e) { this.motorFehler(e); return; }
    } else {
      this.motor.stop();
      const blob = await offline.ton(trk.id);
      if (this.track !== trk) return;
      if (!blob) { toast(t('Der gespeicherte Titel fehlt – bitte neu speichern.'), 'fehler'); return; }
      if (this._blobUrl) URL.revokeObjectURL(this._blobUrl);
      this._blobUrl = URL.createObjectURL(blob);
      this.modus = { art: 'offline', qualitaet: q };
      this.offset = 0;
      this.letzteZeit = 0;
      this.audio.src = this._blobUrl;
      if (ab > 0) {
        const setzen = () => { this.audio.currentTime = ab; this.audio.removeEventListener('loadedmetadata', setzen); };
        this.audio.addEventListener('loadedmetadata', setzen);
      }
      this.lautstaerkeAnwenden();
      this.metadaten();
      this.melden('track');
      this.melden('zustand');
    }
    if (abspielen) {
      try { await this.audio.play(); this.fadeEinStarten(); } catch (e) { this.fadeEinStarten(0); if (e.name !== 'AbortError') this.melden('zustand'); }
    }
  }

  // ---------- Steuerung ----------
  /** Neue Warteschlange starten. tracks = Array, start = Index, ab = Startsekunde im ersten Titel (Übernahme von einem anderen Gerät) */
  abspielen(tracks, start = 0, kontext = null, ab = 0) {
    const spielbar = tracks.filter((t) => t.verfuegbar !== false);
    if (!spielbar.length) { toast(t('Keine abspielbaren Titel.'), 'fehler'); return; }
    const startTrack = tracks[start];
    this.verlaufMelden('fortschritt');
    this.original = spielbar.slice();
    this.liste = spielbar.slice();
    this.index = Math.max(0, this.liste.indexOf(startTrack));
    this.quelleKontext = kontext;
    if (this.einst.zufall) this.mischen(true);
    this.neuerTrack();
    this.raumklang.neustart(); // Raumklang-Modul frisch starten (Titel von Hand gewählt)
    this.fadeEinVorbereiten();
    this.laden(Math.max(0, Number(ab) || 0), true);
    this.speichern();
    this.melden('liste');
  }

  neuerTrack() {
    setTimeout(() => this.radioNachfuellen(), 0);
    this.wiedergabeId = 0;
    this.gehoert = 0;
    this.letzteMeldung = 0;
    this._ersatzVersucht = false;
  }

  umschalten() {
    if (!this.track) return;
    if (this._fadeAusPause) {
      // Mitten im Ausblenden wieder auf Play: einfach wieder hochziehen, nicht anhalten
      this.fadeAbbrechen();
      this._fadeEinAktiv = true;
      this.fadeEinStarten(180);
      return;
    }
    if (this.audio.paused) {
      // Raumklang-Modul frisch starten, dann spielen (dauert nur ~50 ms)
      this.fadeEinVorbereiten();
      const los = () => {
        if (!this.audio.src) this.laden(this._wiederPos || 0, true);
        else this.audio.play().then(() => this.fadeEinStarten(220), () => { this._fadeEinAktiv = false; this.fadeFaktor = 1; this.lautstaerkeAnwenden(); });
      };
      this.raumklang.neustart().then(los, los);
    } else {
      this.pausieren();
    }
  }

  /** Von Hand weiter, bevor der Titel zu Ende war → „übersprungen“ (Signal fürs Radio); kurz vor Schluss zählt als gehört */
  abbruchMelden() {
    const rest = this.dauer - this.zeit;
    this.verlaufMelden(this.dauer > 0 && rest > 8 ? 'ueberspringen' : 'fortschritt');
  }

  weiter(automatisch = false) {
    if (!this.liste.length) return;
    if (automatisch) this.verlaufMelden('ende'); else this.abbruchMelden();
    if (this.index + 1 < this.liste.length) {
      this.index++;
    } else if (this.einst.wiederholen === 'alle') {
      this.index = 0;
    } else {
      if (automatisch) { this.audio.pause(); this.springen(0, false); this.melden('zustand'); }
      return;
    }
    this.neuerTrack();
    if (!automatisch) { this.raumklang.neustart(); this.fadeEinVorbereiten(); } // Skip von Hand; der lückenlose Übergang bleibt unberührt
    if (!this.titelImPuffer()) this.laden(0, true);
    this.speichern();
    this.melden('liste');
  }

  /** Liegt der (neue) aktuelle Titel schon vorgeladen im lückenlosen Strom? Dann einfach dorthin springen. */
  titelImPuffer() {
    if (!this.motor.aktiv || !this.motor.springeZuTitel(this.track)) return false;
    this.letzteZeit = this.audio.currentTime;
    this.lautstaerkeAnwenden();
    this.metadaten();
    this.melden('track');
    this.audio.play().then(() => this.fadeEinStarten(150), () => this.fadeEinStarten(0));
    return true;
  }

  zurueck() {
    if (!this.liste.length) return;
    if (this.zeit > 4 || this.index === 0) { this.raumklang.neustart(); this.springen(0); return; }
    this.verlaufMelden('fortschritt');
    this.index--;
    this.neuerTrack();
    this.raumklang.neustart();
    this.fadeEinVorbereiten();
    this.laden(0, true);
    this.speichern();
    this.melden('liste');
  }

  springenZu(i) {
    if (i < 0 || i >= this.liste.length) return;
    if (i > this.index) this.abbruchMelden(); else this.verlaufMelden('fortschritt');
    this.index = i;
    this.neuerTrack();
    this.raumklang.neustart();
    this.fadeEinVorbereiten();
    if (!this.titelImPuffer()) this.laden(0, true);
    this.speichern();
    this.melden('liste');
  }

  /** Spulen. Original: direkt; umgewandelt: Stream ab dieser Stelle neu anfordern. */
  springen(sek, weiterSpielen = null) {
    if (!this.track) return;
    sek = Math.max(0, Math.min(sek, Math.max(0, this.dauer - 0.5)));
    this._sprung = { ziel: sek, track: this.track, bis: performance.now() + 3000 };
    const spielte = weiterSpielen ?? !this.audio.paused;
    if (this.motor.aktiv) {
      if (!this.motor.springen(sek)) this.laden(sek, spielte, this.modus?.qualitaet);
      else if (weiterSpielen === false) this.audio.pause();
      this.letzteZeit = this.audio.currentTime;
      this.melden('zeit');
      return;
    }
    if (this.modus?.art === 'original' || this.modus?.art === 'offline') {
      this.audio.currentTime = sek;
      this.letzteZeit = sek;
    } else {
      this.laden(sek, spielte, this.modus?.qualitaet);
    }
    this.melden('zeit');
  }

  alsNaechstes(tracks) {
    const neu = tracks.filter((t) => t.verfuegbar !== false);
    if (!neu.length) return;
    if (!this.track) { this.abspielen(neu, 0); return; }
    this.liste.splice(this.index + 1, 0, ...neu);
    this.planAnpassen();
    this.speichern();
    this.melden('liste');
    toast(neu.length === 1 ? t('„{titel}“ kommt als Nächstes', { titel: neu[0].titel }) : t('{n} Titel kommen als Nächstes', { n: neu.length }));
  }

  anhaengen(tracks) {
    const neu = tracks.filter((t) => t.verfuegbar !== false);
    if (!neu.length) return;
    if (!this.track) { this.abspielen(neu, 0); return; }
    this.liste.push(...neu);
    this.planAnpassen();
    this.speichern();
    this.melden('liste');
    toast(neu.length === 1 ? t('„{titel}“ hinzugefügt', { titel: neu[0].titel }) : t('{n} Titel zur Warteschlange hinzugefügt', { n: neu.length }));
  }

  entfernen(i) {
    if (i === this.index || i < 0 || i >= this.liste.length) return;
    this.liste.splice(i, 1);
    if (i < this.index) this.index--;
    this.planAnpassen();
    this.speichern();
    this.melden('liste');
  }

  mischen(stillschweigend = false) {
    if (this.liste.length < 2) return;
    const aktuell = this.track;
    const rest = this.liste.filter((t, i) => i !== this.index);
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    this.liste = aktuell ? [aktuell, ...rest] : rest;
    this.index = aktuell ? 0 : -1;
    if (!stillschweigend) { this.planAnpassen(); this.speichern(); this.melden('liste'); }
  }

  zufallUmschalten() {
    this.einst.zufall = !this.einst.zufall;
    if (this.einst.zufall) this.mischen();
    else if (this.original) {
      const aktuell = this.track;
      const bekannt = new Set(this.liste.map((t) => t.id));
      this.liste = this.original.filter((t) => bekannt.has(t.id));
      this.index = Math.max(0, this.liste.findIndex((t) => t === aktuell || t.id === aktuell?.id));
      this.planAnpassen();
      this.melden('liste');
    }
    this.einstSpeichern();
    this.melden('zustand');
  }

  wiederholenUmschalten() {
    this.einst.wiederholen = { aus: 'alle', alle: 'eins', eins: 'aus' }[this.einst.wiederholen] || 'aus';
    this.einstSpeichern();
    this.planAnpassen();
    this.melden('zustand');
  }

  lautstaerkeSetzen(w) {
    this.einst.lautstaerke = Math.max(0, Math.min(1, w));
    this.lautstaerkeAnwenden();
    this.einstSpeichern();
    clearTimeout(this._lautMeldung);
    this._lautMeldung = setTimeout(() => this.melden('lautstaerke'), 120);   // u. a. für Fernbedienungen
  }

  /** Qualität für „heim“ oder „unterwegs“ setzen – gemerkt im Browser und am Gerät auf dem Server */
  qualitaetSetzen(q, bereich = this.bereich) {
    this.einst[`qualitaet_${bereich}`] = q;
    this.einstSpeichern();
    api.put('/geraet/einstellungen', { einstellungen: { [`qualitaet_${bereich}`]: q } }).catch(() => {});
    if (bereich === this.bereich && this.track && this.audio.src) this.laden(this.zeit, !this.audio.paused);
  }

  /** Netzwechsel erkennen (WLAN ↔ Mobilfunk, App wieder im Vordergrund); gilt ab dem nächsten Titel */
  netzBeobachten() {
    const pruefen = () => this.netzPruefen();
    navigator.connection?.addEventListener?.('change', pruefen);
    window.addEventListener('online', pruefen);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - this.netzGeprueft > 120000) pruefen(); });
  }

  async netzPruefen() {
    this.netzGeprueft = Date.now();
    try {
      const r = await api.get('/netz');
      if (!r || r.lokal === this.netz?.lokal) return;
      this.netz = r;
      this.melden('netz');
      this.melden('zustand');
    } catch (e) { /* offline – später erneut */ }
  }

  // ---------- Aktivität (für das Dashboard in der Verwaltung) ----------
  statusVerbinden() {
    const bald = () => { clearTimeout(this._statusTimer); this._statusTimer = setTimeout(() => this.statusMelden(), 400); };
    // Erst melden, wenn auf dieser Seite wirklich etwas gespielt wurde (eine nur geladene Warteschlange zählt nicht)
    this.audio.addEventListener('playing', () => { this._gespielt = true; });
    for (const e of ['play', 'playing', 'pause', 'ended', 'seeked']) this.audio.addEventListener(e, bald);
    this.addEventListener('track', bald);
    netzweg.addEventListener('wechsel', bald);
    // Beim Öffnen: einen evtl. liegengebliebenen Eintrag dieses Geräts (Seite neu geladen) aufräumen
    setTimeout(() => { if (!this._gespielt) api.post('/status', { track_id: 0 }).catch(() => {}); }, 1500);
    // Lebenszeichen: spielend alle 10 s, pausiert alle 30 s – geschlossene Tabs verschwinden so nach gut einer Minute
    let takt = 0;
    setInterval(() => {
      takt++;
      if (!this._gespielt) return;
      if (this.spielt || takt % 3 === 0) this.statusMelden();
    }, 10000);
    window.addEventListener('pagehide', () => {
      if (!this._gespielt || !this.track || !navigator.sendBeacon) return;
      const fd = new FormData();
      fd.append('track_id', String(this.track.id));
      fd.append('spielt', '');
      fd.append('ereignis', 'stopp'); // Seite wird geschlossen: hier spielt nichts mehr
      fd.append('position', String(Math.round(this.zeit)));
      fd.append('dauer', String(Math.round(this.dauer)));
      fd.append('csrf_token', document.querySelector('meta[name="csrf-token"]')?.content || '');
      navigator.sendBeacon('/api/v1/status', fd);
    });
  }

  statusInfo() {
    const m = this.modus || {};
    const ua = navigator.userAgent;
    const browser = this.nativ ? null : /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox\//.test(ua) ? 'Firefox'
      : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const lh = this.lautheitFuer(this.track);
    const bitgenau = this.nativ ? !!this.audio.bitgenau : m.art === 'original' && (!m.lueckenlos || !!this.motor?.aktuell?.bitgenau) && !this.raumklang?.angeschlossen && !(lh?.db);
    return {
      qualitaet: m.qualitaet || null, art: m.art || null, lueckenlos: !!m.lueckenlos, bitgenau, ersatz: !!m.ersatz,
      direkt: this.direktAktiv, eq: eqWirksam(this.einst.eq),
      lautheit: lh && lh.art !== 'fehlt' ? `${lh.art === 'album' ? t('Album') : t('Titel')} ${lh.db > 0 ? '+' : ''}${lh.db.toFixed(1)} dB` : null,
      raumklang: this.raumklang?.aktiv ? this.raumklang.preset : null, layout: this.raumklang?.layout?.name || null,
      app: window.matchMedia?.('(display-mode: standalone)').matches || false, mobil: this.mobil, browser,
    };
  }

  statusMelden() {
    if (!this._gespielt) return;
    const t = this.track;
    if (!t) { if (this._statusGemeldet) { this._statusGemeldet = false; api.post('/status', { track_id: 0 }).catch(() => {}); } return; }
    this._statusGemeldet = true;
    api.post('/status', { track_id: t.id, position: Math.round(this.zeit * 10) / 10, dauer: Math.round(this.dauer * 10) / 10, spielt: this.spielt, info: this.statusInfo() }).catch(() => {});
  }

  // ---------- Raumklang ----------
  /** Preset setzen ('aus', 'dezent', 'raum', 'halle', 'live') – pro Gerät gemerkt */
  async raumklangSetzen(preset, merken = true) {
    if (!RAUMKLANG_PRESETS[preset]) preset = 'aus';
    this.einst.raumklang = preset;
    if (preset !== 'aus') this.einst.raumklang_letzt = preset;
    if (merken) {
      this.einstSpeichern();
      api.put('/geraet/einstellungen', { einstellungen: { raumklang: preset, raumklang_letzt: this.einst.raumklang_letzt } }).catch(() => {});
    }
    let layout = null;
    try { layout = await this.raumklang.setzen(preset); } catch (e) { console.warn('Raumklang', e); }
    if (preset !== 'aus' && !layout) {
      toast(t('Dieses Ausgabegerät gibt nur Stereo aus. AmberSpace braucht einen 5.1- oder Quadro-Ausgang (z. B. PC per HDMI am AV-Receiver).'), 'fehler');
    }
    this.melden('zustand');
    return layout;
  }

  /** Hall-Impulsantwort wählen: 'auto' (passend zum Preset), 'synth' (eingebaut) oder eine IR-ID */
  async raumklangIrSetzen(wahl) {
    this.einst.raumklang_ir = wahl || 'auto';
    this.raumklang.irWahl = this.einst.raumklang_ir;
    this.einstSpeichern();
    api.put('/geraet/einstellungen', { einstellungen: { raumklang_ir: this.einst.raumklang_ir } }).catch(() => {});
    if (this.raumklang.aktiv) await this.raumklang.setzen(this.einst.raumklang, this.einst.raumklang_ir);
    this.melden('zustand');
  }

  // ---------- Radio (lernt aus Hören und Überspringen) ----------
  /** saat: null = Mein Radio, sonst {art: 'track'|'album'|'kuenstler', id} */
  async radioStarten(saat = null) {
    try {
      const r = await api.post('/radio', { saat, ausschluss: this.liste.slice(Math.max(0, this.index - 50)).map((t) => t.id), anzahl: 25 });
      if (!r.tracks?.length) { toast(t('Für das Radio ist die Sammlung noch zu leer.'), 'fehler'); return; }
      this.radioGruende = { ...(r.gruende || {}) };
      this.abspielen(r.tracks, 0, { art: 'radio', saat, titel: r.titel });
      toast(r.titel);
    } catch (e) { toast(e.message || t('Radio konnte nicht starten.'), 'fehler'); }
  }

  /** Läuft das Radio bald aus? Dann leise nachfüllen */
  async radioNachfuellen() {
    if (this.quelleKontext?.art !== 'radio' || this._radioLaedt || this.liste.length - this.index > 5) return;
    this._radioLaedt = true;
    try {
      const r = await api.post('/radio', { saat: this.quelleKontext.saat || null, ausschluss: this.liste.slice(-300).map((t) => t.id), anzahl: 15 });
      if (this.quelleKontext?.art === 'radio' && r.tracks?.length) {
        this.radioGruende = { ...(this.radioGruende || {}), ...(r.gruende || {}) };
        const neu = r.tracks.filter((t) => t.verfuegbar !== false);
        this.liste.push(...neu);
        if (this.original) this.original.push(...neu);
        this.planAnpassen();
        this.speichern();
        this.melden('liste');
      }
    } catch (e) { /* später erneut */ }
    this._radioLaedt = false;
  }

  /** Warum läuft dieser Titel im Radio? */
  radioGrund(track = this.track) {
    return this.quelleKontext?.art === 'radio' && track ? (this.radioGruende?.[track.id] || null) : null;
  }

  /** Raumklang-Feineinstellung (Intensität, Surround-Pegel, Umhüllung; 0–100) – sofort hörbar, pro Gerät gemerkt */
  raumklangFeinSetzen(fein) {
    this.einst.raumklang_fein = { ...FEIN_STANDARD, ...(this.einst.raumklang_fein || {}), ...fein };
    this.raumklang.feinSetzen(this.einst.raumklang_fein);
    this.einstSpeichern();
    clearTimeout(this._feinTimer);
    this._feinTimer = setTimeout(() => api.put('/geraet/einstellungen', { einstellungen: { raumklang_fein: this.einst.raumklang_fein } }).catch(() => {}), 600);
    this.melden('zustand');
  }

  /** A/B: zwischen Aus und dem zuletzt gewählten Preset umschalten */
  raumklangUmschalten() {
    const an = this.einst.raumklang !== 'aus';
    const ziel = an ? 'aus' : (this.einst.raumklang_letzt || 'dezent');
    if (ziel !== 'aus' && !layoutFuer(this.raumklang.ctx ? this.raumklang.ctx.destination.maxChannelCount : ausgabeKanaele(true))) {
      toast(t('AmberSpace geht nur an einem 5.1- oder Quadro-Ausgang – dieses Gerät gibt Stereo aus.'), 'fehler');
      return Promise.resolve(null);
    }
    toast(ziel === 'aus' ? t('AmberSpace aus') : t('AmberSpace: {name}', { name: RAUMKLANG_PRESETS[ziel].name }));
    return this.raumklangSetzen(ziel);
  }

  /** Aktuellen Titel offline mit allen Presets als 5.1-WAV rendern und herunterladen (zum Probehören in der DAW) */
  async raumklangExport(track = this.track) {
    if (!track) return;
    toast(t('AmberSpace-Export läuft … (je Preset ein paar Sekunden)'));
    let daten = null;
    for (const url of [`/api/v1/stream/${track.id}?q=original`, `/api/v1/stream/${track.id}?q=original&art=luecken`]) {
      try {
        const voll = netzweg.url(url); // zuhause direkt (schnell), sonst normal
        const r = await fetch(voll, voll !== url ? { credentials: 'omit', mode: 'cors' } : { credentials: 'same-origin' });
        if (!r.ok) continue;
        const ab = await r.arrayBuffer();
        // prüfen, ob der Browser es dekodieren kann
        await new OfflineAudioContext(1, 1, 44100).decodeAudioData(ab.slice(0));
        daten = ab;
        break;
      } catch (e) { /* nächster Versuch */ }
    }
    if (!daten) { toast(t('Dieser Titel lässt sich im Browser nicht dekodieren.'), 'fehler'); return; }
    const name = `${String(track.label || track.nr || '').padStart(2, '0')} ${track.titel}`.trim().replace(/[\\/:*?"<>|]+/g, '_');
    for (const [schluessel, p] of Object.entries(RAUMKLANG_PRESETS)) {
      const blob = await raumklangRendern(daten.slice(0), schluessel, 6, this.einst.raumklang_ir, this.einst.raumklang_fein);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${name} - AmberSpace ${p.name} 5.1.wav`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
    toast(t('Fertig: 4 Dateien (5.1, 24 Bit, Kanäle L R C LFE Ls Rs)'));
  }

  einstSpeichern() {
    try { localStorage.setItem(EINST, JSON.stringify(this.einst)); } catch (e) {}
  }

  // ---------- Hörverlauf ----------
  verlaufMelden(ereignis, beacon = false) {
    const t = this.track;
    if (!t) return;
    if (ereignis !== 'start' && !this.wiedergabeId && this.gehoert < 1) return;
    this.letzteMeldung = Date.now();
    // Quelle fürs Radio-Lernen und die Qualitätsanzeige der Klanganalyse: Klangradio bzw. Klang-Vorschlag im Radio getrennt zählen
    const art = this.quelleKontext?.art || '';
    // von einem anderen Gerät gestartet: im Verlauf als „fern“ vermerkt
    const quelle = this.quelleKontext?.fern ? 'fern' : art === 'radio' ? (this.quelleKontext?.saat?.art === 'klang' ? 'klangradio' : String(this.radioGruende?.[t.id] || '').startsWith('klingt wie') ? 'radioklang' : 'radio') : art;
    const daten = { track_id: t.id, ereignis, sekunden: Math.round(this.gehoert), position: Math.round(this.zeit), wiedergabe_id: this.wiedergabeId || 0, quelle };
    // Ohne Netz: auf dem Gerät merken und später nachreichen (mit der Zeit, zu der der Titel lief)
    if (this._verlaufTrack !== t) { this._verlaufTrack = t; this._verlaufStart = Date.now(); this._verlaufLokal = false; }
    const lokalMerken = () => offline.verlaufMerken({ lokal: `${this._verlaufStart}-${t.id}`, track_id: t.id, zeit: this._verlaufStart, sekunden: daten.sekunden, quelle: quelle || 'offline', ueberspringen: ereignis === 'ueberspringen' });
    if (this.nurLokal || this._verlaufLokal) { this._verlaufLokal = true; lokalMerken(); return; }
    if (beacon && navigator.sendBeacon) {
      // sendBeacon kann keine Kopfzeilen setzen -> CSRF-Token als Formularfeld
      const fd = new FormData();
      Object.entries(daten).forEach(([k, v]) => fd.append(k, String(v)));
      fd.append('csrf_token', document.querySelector('meta[name="csrf-token"]')?.content || '');
      navigator.sendBeacon('/api/v1/wiedergabe', fd);
      return;
    }
    api.post('/wiedergabe', daten).then((r) => {
      if (r?.wiedergabe_id && this.track === t) this.wiedergabeId = r.wiedergabe_id;
    }).catch((e) => { if (!e?.status && !this.wiedergabeId && this._verlaufTrack === t) { this._verlaufLokal = true; lokalMerken(); } });
  }

  // ---------- Merken & Wiederherstellen ----------
  speichern(sofort = false) {
    // Lokal: höchstens alle 1,5 s und nur ein Ausschnitt um den aktuellen Titel (ohne schwere Felder wie Mitwirkende) –
    // bei langen Warteschlangen war das sonst bei jedem Titelwechsel mehrere MB JSON im Haupt-Thread
    clearTimeout(this._lokalTimer);
    const lokal = () => {
      const von = Math.max(0, this.index - 100);
      const liste = this.liste.slice(von, von + 1000).map(({ credits, mitwirkende, beziehungen, ...rest }) => rest);
      const zustand = { liste, index: this.index - von, position: this.zeit, kontext: this.quelleKontext };
      try { localStorage.setItem(SPEICHER, JSON.stringify(zustand)); } catch (e) {}
    };
    if (sofort) lokal(); else this._lokalTimer = setTimeout(lokal, 1500);
    clearTimeout(this._serverTimer);
    // Server: bis zu 5.000 Titel um den aktuellen herum (reicht für jede Warteschlange, die man durchhört)
    const senden = () => {
      const von = Math.max(0, this.index - 500);
      const ids = this.liste.slice(von, von + 5000).map((t) => t.id);
      api.put('/warteschlange', { track_ids: ids, index: this.index - von, position: Math.round(this.zeit) }).catch(() => {});
    };
    if (sofort) senden(); else this._serverTimer = setTimeout(senden, 4000);
  }

  wiederherstellen() {
    try {
      const z = JSON.parse(localStorage.getItem(SPEICHER) || 'null');
      if (z && Array.isArray(z.liste) && z.liste.length) {
        this.liste = z.liste;
        this.original = z.liste.slice();
        this.index = Math.min(Math.max(0, z.index || 0), z.liste.length - 1);
        this._wiederPos = z.position || 0;
        this.quelleKontext = z.kontext || null;
        this.metadaten();
      }
    } catch (e) {}
  }

  // ---------- Sperrbildschirm / Medientasten ----------
  mediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const setzen = (aktion, fn) => { try { ms.setActionHandler(aktion, fn); } catch (e) {} };
    setzen('play', () => this.umschalten());
    setzen('pause', () => this.pausieren());
    setzen('previoustrack', () => this.zurueck());
    setzen('nexttrack', () => this.weiter());
    setzen('seekto', (d) => this.springen(d.seekTime));
    setzen('seekbackward', (d) => this.springen(this.zeit - (d.seekOffset || 10)));
    setzen('seekforward', (d) => this.springen(this.zeit + (d.seekOffset || 10)));
  }

  /**
   * Bibliothek geändert (z. B. frisch abgeglichenes Album): Titel, Künstler, Album und Cover der Titel in der Warteschlange
   * neu holen und in die vorhandenen Objekte schreiben – Wiedergabe, Reihenfolge und Stelle bleiben, wie sie sind.
   */
  async angabenAuffrischen() {
    if (!this.liste.length) return false;
    const von = Math.max(0, this.index - 200);
    const teil = this.liste.slice(von, von + 1500);
    let r;
    try { r = await api.post('/bibliothek/frisch', { tracks: teil.map((t) => t.id) }); } catch (e) { return false; }
    const neu = new Map(r.tracks.map((t) => [t.id, t]));
    const felder = ['titel', 'kuenstler', 'laenge_ms', 'disc', 'nr', 'explizit', 'verfuegbar'];
    let geaendert = false, aktuellNeu = false;
    const gesehen = new Set();
    for (const t of [...this.liste, ...(this.original || [])]) {
      if (!t || gesehen.has(t)) continue;
      gesehen.add(t);
      const n = neu.get(t.id);
      if (!n) continue;
      const vorher = JSON.stringify([felder.map((f) => t[f]), t.album?.id, t.album?.titel, t.album?.cover, t.album?.edition_id]);
      for (const f of felder) if (n[f] !== undefined) t[f] = n[f];
      t.album = { ...(t.album || {}), ...n.album };
      if (JSON.stringify([felder.map((f) => t[f]), t.album?.id, t.album?.titel, t.album?.cover, t.album?.edition_id]) !== vorher) {
        geaendert = true;
        if (t === this.track) aktuellNeu = true;
      }
    }
    if (!geaendert) return false;
    if (aktuellNeu) { this.metadaten(); this.melden('track'); }
    this.melden('liste');
    try { localStorage.setItem(SPEICHER, JSON.stringify({ liste: this.liste.slice(0, 1000), index: this.index, position: this.zeit, kontext: this.quelleKontext })); } catch (e) {}
    return true;
  }

  metadaten() {
    const t = this.track;
    if (!t || !('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    const cover = t.album?.cover ? t.album.cover.replace(/g=\d+/, 'g=600') : null;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.titel, artist: kuenstlerText(t.kuenstler), album: t.album?.titel || '',
      artwork: cover ? [{ src: cover, sizes: '600x600', type: 'image/jpeg' }] : [],
    });
    document.title = `${t.titel} · ${kuenstlerText(t.kuenstler)}`;
  }
}
