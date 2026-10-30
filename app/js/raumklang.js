// Raumklang: dezenter Surround-Upmix im Browser (Stereo → 5.1 bzw. Quadro). Ein Verfahren (ab 0.1.118):
//  • Zwei Ebenen (Worklet): Raum (Unkorreliertes: Hall, Publikum) wird dekorreliert und verzögert nach hinten KOPIERT,
//    extreme Stereo-Effekte und Breites werden nach hinten VERSCHOBEN (Front gibt sie ab).
//  • Front → LCR per M/S: M = (L+R)/2, S = (L−R)/2, L' = S + M·cos θ, R' = −S + M·cos θ, C = √2·M·sin θ
//    (θ = Center-Anteil · 90°; 50 % = klassische Matrix: Center M mit 0 dB, Front M mit −3 dB).
//  • Bassmanagement: Linkwitz-Riley 4. Ordnung (24 dB/Okt.) bei 80/100/120 Hz – L', R', C durch den Hochpass, der LFE
//    bekommt den Tiefpass von L+R (den ganzen Bass der Stereo-Front), um den LFE-Pegel abgesenkt (−10 dB: Receiver hebt an).
// Kanalreihenfolge 5.1 wie WAV/Web Audio: L, R, C, LFE, Ls, Rs.

export const RAUMKLANG_PRESETS = {
  // surround/center/direkt in dB; direkt = wie viel vom Direktschall (ohne Bass) einen Raumhall anregt –
  // nötig für trockene Studioaufnahmen und trockene Hörräume, sonst kommt hinten kaum etwas an
  dezent: {
    name: t('Dezent'), info: t('Etwas mehr Raum, die Bühne bleibt klar vorne'),
    center: null, surround: -9, hp: 220, tief: -3, hoehen: -3, transient: -9, ducking: -5, direkt: -20,
    effekte: 0.6, taps: { l: [[15, 1], [27, 0.5]], r: [[21, 1], [33, 0.5]] }, hall: { rt: 0.6, vor: 18, dunkel: 5000, pegel: -4, max: 1.2 },
    ir: ['French 18th Century Salon', 'Highly Damped Large Room', 'Small Drum Room'],
  },
  raum: {
    name: t('Raum'), info: t('Frühe Reflexionen eines großen Raums, die Bühne bleibt vorne'),
    center: -15, surround: -6, hp: 200, tief: -3, hoehen: -3, transient: -8, ducking: -5, direkt: -16,
    effekte: 1, taps: { l: [[11, 1], [19, 0.7], [29, 0.5], [41, 0.35]], r: [[13, 1], [23, 0.7], [31, 0.5], [43, 0.35]] },
    hall: { rt: 0.8, vor: 22, dunkel: 5000, pegel: -4, max: 1.5 },
    ir: ['Highly Damped Large Room', 'Nice Drum Room', 'French 18th Century Salon'],
  },
  halle: {
    name: t('Halle'), info: t('Dunkler Nachhall – macht den Raum deutlich größer'),
    center: -15, surround: -7, hp: 200, tief: -4, hoehen: -4, transient: -10, ducking: -6, direkt: -12,
    effekte: 0.8, taps: { l: [[17, 0.6]], r: [[23, 0.6]] }, hall: { rt: 1.3, vor: 25, dunkel: 4500, pegel: 0, max: 2.5 },
    ir: ['Musikvereinsaal', 'St Nicolaes Church', 'Large Wide Echo Hall'],
  },
  live: {
    name: t('Live'), info: t('Für Konzertmitschnitte: Publikum und Halle rundherum'),
    center: -12, surround: -5, hp: 150, tief: -2, hoehen: -2, transient: -4, ducking: -3, direkt: -18,
    effekte: 1.2, taps: { l: [[14, 1], [27, 0.5]], r: [[19, 1], [33, 0.5]] }, hall: { rt: 1.6, vor: 25, dunkel: 6000, pegel: -2, max: 2.5 },
    ir: ['Scala Milan Opera Hall', 'Musikvereinsaal'],
  },
};

import { t } from './i18n.js';
import { eqWirksam, eqGainDb, eqKoeffizienten } from './eq.js';
import { waermeWirksam, waermeParameter, waermeBezugDb } from './waerme.js';
import { bandWirksam, bandParameter, bandBezugDb } from './band.js';
import { trafoWirksam, trafoParameter as trafoParameterRoh, trafoBezugDb } from './trafo.js';
import { api } from './api.js';
import { netzweg } from './netzweg.js';
import { nativ } from './nativ.js';
import { NativKontext } from './raumnativ.js';
import { AbgriffRing, KRing, AbgriffAnalyser } from './abgriff.js';
import { vstRack, istVstId } from './vstrack.js';

/** EQ-Koeffizienten schickt der Windows Client für diese Raten mit (die Engine läuft mit der Rate der Datei) */
const NATIV_RATEN = [44100, 48000, 88200, 96000, 176400, 192000];

const LATENZ_EBENEN = 2048; // alle Ausgänge (auch die Front) gleich verzögert (siehe raumklang-worklet.js)
// Worklet-Dateien mit Versionsparameter (aus index.php: Änderungszeit der Datei) – kein Cache kann eine alte Fassung liefern
const metaInhalt = (n) => (typeof document !== 'undefined' && document.querySelector(`meta[name="${n}"]`)?.content) || '';
const WORKLET_URL = new URL(metaInhalt('aw-worklet-raum') || './raumklang-worklet.js', metaInhalt('aw-worklet-raum') ? location.href : import.meta.url).href;
const EQ_WORKLET_URL = new URL(metaInhalt('aw-worklet-eq') || './eq-worklet.js', metaInhalt('aw-worklet-eq') ? location.href : import.meta.url).href;
const WAERME_WORKLET_URL = new URL(metaInhalt('aw-worklet-waerme') || './waerme-worklet.js', metaInhalt('aw-worklet-waerme') ? location.href : import.meta.url).href;
const TRAFO_WORKLET_URL = new URL(metaInhalt('aw-worklet-trafo') || './trafo-worklet.js', metaInhalt('aw-worklet-trafo') ? location.href : import.meta.url).href;
const BAND_WORKLET_URL = new URL(metaInhalt('aw-worklet-band') || './band-worklet.js', metaInhalt('aw-worklet-band') ? location.href : import.meta.url).href;
// Glow, Iron und Silk als WebAssembly (C-Bibliothek dsp/, derselbe Code wie im Windows-Client); die JS-Worklets oben nur noch
// als Rückfall, falls der Browser WebAssembly nicht übersetzen darf
const DSP_WORKLET_URL = new URL(metaInhalt('aw-worklet-dsp') || './dsp-worklet.js', metaInhalt('aw-worklet-dsp') ? location.href : import.meta.url).href;
const DSP_WASM_URL = new URL(metaInhalt('aw-worklet-wasm') || './aw-dsp.wasm', metaInhalt('aw-worklet-wasm') ? location.href : import.meta.url).href;
/** Bytes der WebAssembly-Datei, wenn sie sich hier übersetzen lässt (sonst null → JS-Worklets) */
async function dspWasmLaden() {
  try {
    if (typeof WebAssembly === 'undefined') return null;
    const r = await fetch(DSP_WASM_URL, { credentials: 'same-origin' });
    if (!r.ok) return null;
    const bytes = await r.arrayBuffer();
    await WebAssembly.compile(bytes);   // Probe: scheitert z. B. an einer Content-Security-Policy ohne 'wasm-unsafe-eval'
    return bytes;
  } catch (e) {
    console.warn('Amberwave: Effekte ohne WebAssembly (JS-Rückfall)', e);
    return null;
  }
}

/** Fassung des tatsächlich geladenen Raumklang-Worklets (meldet sich beim Start) und die erwartete App-Version */
export const workletStand = { geladen: null, erwartet: metaInhalt('aw-worklet-stand') || null };
const db = (x) => Math.pow(10, x / 20);

/** Frei verschiebbare Effektstufen und ihre Standard-Reihenfolge (Eingang vorn, Space und Ausgang bleiben fest) */
export const STUFEN = ['glow', 'iron', 'silk', 'eq'];
const KNOTEN_FELD = { glow: 'waermeKnoten', iron: 'trafoKnoten', silk: 'bandKnoten', eq: 'eqKnoten' };
/** Reihenfolge prüfen: jede Stufe genau einmal, Unbekanntes raus, Fehlendes hinten an */
export function reiheNormal(reihe) {
  // VST3-Plug-ins (Windows Client, „vst0“ …) bleiben, solange es ihren Slot gibt; fehlende eingebaute Stufen kommen hinten an
  const r = (Array.isArray(reihe) ? reihe : []).filter((x, i, a) => (STUFEN.includes(x) || (istVstId(x) && vstRack.finde(x))) && a.indexOf(x) === i);
  for (const x of STUFEN) if (!r.includes(x)) r.push(x);
  for (const x of vstRack.ids()) if (!r.includes(x)) r.push(x);
  return r;
}

/**
 * Feineinstellung (0–100, 50 = wie das Preset): Intensität = wie viel Raum/Hall erzeugt wird (Hallanteil und wie stark
 * der Direktschall den Hall anregt), Pegel = Lautstärke der Surround-Lautsprecher (Ls/Rs) insgesamt. ±12 dB.
 */
/** Vorgaben vom Server (.env): Neustart bei Titelwahl/Play, Bassmanagement, Center-Anteil */
export const RAUMKLANG_VORGABEN = (() => {
  const v = { neustart: true, trennung: 80, lfe: -10, center: 50, rear: 0, prozent: 20, mittel: { intensitaet: 34, pegel: 75, effekte: 26, breite: 22 } };
  try { return { ...v, ...JSON.parse(metaInhalt('aw-raumklang') || '{}') }; } catch (e) { return v; }
})();
/** Trennfrequenzen des Bassmanagements: Linkwitz-Riley 24 dB/Okt.; 0 = Bass bleibt vorne, LFE leer */
export const LCR_TRENNUNGEN = [80, 100, 120, 0];
export const FEIN_STANDARD = {
  ...RAUMKLANG_VORGABEN.mittel,
  // Center-Anteil (0–100: wie viel der Mitte per M/S in den Center wandert), Trennfrequenz (Hz), LFE-Pegel (dB)
  center: RAUMKLANG_VORGABEN.center, trennung: RAUMKLANG_VORGABEN.trennung, lfe: RAUMKLANG_VORGABEN.lfe,
  // Rear-Delay in ms (0–20, ganze Millisekunden): Ls/Rs kommen so viel später – das Ohr ortet weiter vorn
  rear: RAUMKLANG_VORGABEN.rear,
};
/**
 * Stärke Subtil/Weit/Intensiv: „Weit“ kommt vom Server (.env, RAUMKLANG_MITTEL_*), Subtil und Intensiv sind Weit um
 * ±Prozent skaliert (RAUMKLANG_STAERKE_PROZENT, Standard 20): Intensität und Surround-Pegel als Amplitude (×0,8 = −1,9 dB,
 * ×1,2 = +1,6 dB), Effekte und Breite direkt (×0,8 / ×1,2).
 */
export const STAERKEN = ['klein', 'mittel', 'gross'];
export function staerkeWerte(name) {
  const m = RAUMKLANG_VORGABEN.mittel;
  const r = (x) => Math.max(0, Math.min(100, Math.round(x)));
  const d = name === 'klein' ? -1 : name === 'gross' ? 1 : 0;
  const f = 1 + d * (Number(RAUMKLANG_VORGABEN.prozent) || 20) / 100;
  const dbZuRegler = (wert) => r(50 + ((feinDb(wert) + 20 * Math.log10(f)) / 12) * 50);
  return { intensitaet: d ? dbZuRegler(m.intensitaet) : r(m.intensitaet), pegel: d ? dbZuRegler(m.pegel) : r(m.pegel), effekte: r(m.effekte * f), breite: r(m.breite * f) };
}
/** Welche Stärke entsprechen die Regler gerade? null = eigene Einstellung */
export function staerkeErkennen(fein) {
  return STAERKEN.find((n) => { const w = staerkeWerte(n); return Object.keys(w).every((k) => Math.abs(Number(fein?.[k]) - w[k]) < 1); }) || null;
}
/** LCR/Bassmanagement: Werte prüfen (Trennung aus der Liste, LFE −10 oder 0 dB, Center 0–100) */
export function lcrWerte(fein) {
  const t = Number(fein?.trennung);
  const lfe = Number(fein?.lfe);
  return {
    trennung: t === 0 ? 0 : t >= 60 && t <= 250 ? Math.round(t / 10) * 10 : 80,
    lfe: lfe === 0 ? 0 : -10,
    center: Math.max(0, Math.min(100, Number(fein?.center ?? 50))),
  };
}
/** „Effekte nach hinten“ (0–100) × Preset-Faktor → Stärke im Worklet (0 … 1,5; ab etwa 1 werden voll gegenphasige Anteile fast ganz verschoben) */
export function effekteWert(preset, fein) {
  const u = Math.max(0, Math.min(100, Number(fein?.effekte ?? FEIN_STANDARD.effekte)));
  return Math.min(1.5, (u / 100) * 1.5 * (RAUMKLANG_PRESETS[preset]?.effekte ?? 1));
}
/** „Breite nach hinten“ (0–100) × Preset-Faktor → Anteil im Worklet (0 … 1; bei 100 sitzen breite Doubles/Leslie fast ganz hinten) */
export function breiteWert(preset, fein) {
  const u = Math.max(0, Math.min(100, Number(fein?.breite ?? FEIN_STANDARD.breite)));
  return Math.min(1, (u / 100) * 0.9 * (RAUMKLANG_PRESETS[preset]?.effekte ?? 1));
}
/** Intensität: Hall-Faktor (Regler ganz links = Hall aus) und Faktor der frühen Reflexionen (wirken halb, nie aus) */
export function intensitaetWerte(fein) {
  const u = Number(fein?.intensitaet ?? 50);
  const d = db(feinDb(Math.max(0, u)));
  return { hall: u <= 0 ? 0 : d, reflex: Math.sqrt(d) };
}
/** Rear-Delay in Sekunden (0–20 ms, ganze ms) */
export function rearSek(fein) { const ms = Math.round(Number(fein?.rear ?? 0)); return Math.max(0, Math.min(20, Number.isFinite(ms) ? ms : 0)) / 1000; }
export function feinDb(wert) { return Math.round(((Number(wert ?? 50) - 50) / 50) * 12 * 10) / 10; }

/** Wie viele Kanäle kann das Ausgabegerät? (Web Audio; ohne Abspielen, ohne Ton) */
let kanaeleCache = null;
export function ausgabeKanaele(neu = false) {
  if (kanaeleCache !== null && !neu) return kanaeleCache;
  try {
    const C = window.AudioContext || window.webkitAudioContext;
    const c = new C();
    kanaeleCache = c.destination.maxChannelCount || 2;
    c.close?.();
  } catch (e) { kanaeleCache = 2; }
  return kanaeleCache;
}

/** Layout für eine Kanalzahl: 5.1 ab 6 Kanälen, Quadro bei 4–5, sonst keins */
/**
 * Bassmanagement des Ausgangs (Windows Client, ASIO mit Sub/Bassmanagement): dann trennt nur die Engine, der Upmixer
 * gibt Vollbereich aus. Ohne Bassmanagement am Ausgang trennt der Upmixer nur bei 5.1 selbst (bei Quadro gibt es keinen Sub).
 */
export const ausgangBass = { an: false, hz: 80 };
export function ausgangBassSetzen(info) { ausgangBass.an = !!info?.an; ausgangBass.hz = Number(info?.hz) || 80; }
/** Trennfrequenz, mit der der Upmixer selbst trennt (0 = gar nicht) */
export function upmixTrennung(fein, layout) {
  return ausgangBass.an || layout?.kanaele !== 6 ? 0 : lcrWerte(fein).trennung;
}

export function layoutFuer(kanaele) {
  if (kanaele >= 6) return { kanaele: 6, name: '5.1', c: 2, ls: 4, rs: 5 };
  if (kanaele >= 4) return { kanaele: 4, name: t('Quadro'), c: null, ls: 2, rs: 3 };
  return null;
}

/** Lautsprecher eines Layouts mit Kanalnummer (Reihenfolge wie Web Audio / WAV) */
export function lautsprecherVon(layout) {
  if (!layout) return [];
  return layout.kanaele === 6
    ? [['L', 0], ['C', 2], ['R', 1], ['Ls', 4], ['LFE', 3], ['Rs', 5]]
    : [['L', 0], ['R', 1], ['Ls', 2], ['Rs', 3]];
}

/** Stereo-Impulsantwort: abklingendes Rauschen, links/rechts verschieden, mit der Zeit dunkler */
function hallImpuls(ctx, h) {
  const sr = ctx.sampleRate;
  const vor = Math.round(sr * h.vor / 1000);
  const n = vor + Math.round(sr * h.rt * 1.2);
  const buf = ctx.createBuffer(2, n, sr);
  const zufall = () => Math.random() * 2 - 1;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0, lp2 = 0, energie = 0;
    for (let i = vor; i < n; i++) {
      const t = (i - vor) / sr;
      const fc = h.dunkel * Math.exp(-t * 1.5);              // wird mit der Zeit dunkler
      const a = Math.exp(-2 * Math.PI * Math.max(500, fc) / sr);
      lp = a * lp + (1 - a) * zufall();
      lp2 = a * lp2 + (1 - a) * lp;                            // 12 dB/Okt: weicher, weniger „Blech“
      const ein = Math.min(1, t / 0.012);                      // dichter werdender Einsatz statt Knall
      d[i] = lp2 * Math.exp(-6.91 * t / h.rt) * ein;
      energie += d[i] * d[i];
    }
    const norm = db(h.pegel) / Math.sqrt(energie || 1);
    for (let i = vor; i < n; i++) d[i] *= norm;
  }
  return buf;
}


// ---------- Impulsantworten (echte Räume) ----------
const irRohCache = new Map();   // `${id}@${sampleRate}` → AudioBuffer (dekodiert)
let irListeCache = null;

/** Liste der verfügbaren Impulsantworten vom Server (gemerkt) */
export async function irListe(neu = false) {
  if (irListeCache && !neu) return irListeCache;
  try {
    irListeCache = (await api.get('/raumklang/irs')).irs || []; // zuhause über die Direktadresse
  } catch (e) { irListeCache = []; }
  return irListeCache;
}

/** Welche IR nimmt ein Preset? wahl: 'auto' (passend zum Preset), 'synth' (eingebaut) oder eine IR-ID */
export function irWaehlen(liste, preset, wahl = 'auto') {
  if (wahl === 'synth' || !liste?.length) return null;
  if (wahl && wahl !== 'auto') return liste.find((x) => x.id === wahl) || null;
  const wunsch = RAUMKLANG_PRESETS[preset]?.ir || [];
  const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const w of wunsch) {
    const t = liste.find((x) => norm(x.name).includes(norm(w)));
    if (t) return t;
  }
  return null;
}

/** Roh-IR für die Abtastrate des Kontexts laden und dekodieren */
async function irRoh(ctx, id) {
  const schluessel = `${id}@${ctx.sampleRate}`;
  if (irRohCache.has(schluessel)) return irRohCache.get(schluessel);
  const pfad = `/api/v1/raumklang/ir?id=${encodeURIComponent(id)}`;
  const voll = netzweg.url(pfad);
  let r;
  try { r = await fetch(voll, voll !== pfad ? { credentials: 'omit', mode: 'cors' } : { credentials: 'same-origin' }); } catch (e) { r = null; }
  if ((!r || !r.ok) && voll !== pfad) r = await fetch(pfad, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(t('IR nicht ladbar'));
  const daten = await r.arrayBuffer();
  const buf = await new OfflineAudioContext(2, 1, ctx.sampleRate).decodeAudioData(daten);
  irRohCache.set(schluessel, buf);
  return buf;
}

/**
 * Echte IR für die Surrounds aufbereiten: Direktschall abschneiden (nur der Raum soll nach hinten),
 * weich einblenden, auf die Preset-Länge kürzen und ausblenden, Vorverzögerung davor, Pegel wie beim
 * eingebauten Hall (gleiche Energie). Mono-IRs bekommen eine versetzte Kopie als zweiten Kanal.
 */
function irAufbereiten(ctx, roh, h, vorMs) {
  const sr = ctx.sampleRate;
  const kanaele = [roh.getChannelData(0), roh.getChannelData(Math.min(1, roh.numberOfChannels - 1))];
  const mono = roh.numberOfChannels === 1;
  let spitze = 0, wo = 0;
  const such = Math.min(roh.length, Math.round(sr * 0.3));
  for (const d of kanaele) for (let i = 0; i < such; i++) { const v = Math.abs(d[i]); if (v > spitze) { spitze = v; wo = i; } }
  const start = wo + Math.round(sr * 0.004);
  const versatz = mono ? Math.round(sr * 0.011) : 0;
  const len = Math.max(1, Math.min(roh.length - start - versatz, Math.round(sr * (h.max || 2))));
  const vor = Math.round(sr * Math.max(0, vorMs) / 1000);
  const buf = ctx.createBuffer(2, vor + len, sr);
  const ein = Math.round(sr * 0.006), aus = Math.round(len * 0.3);
  for (let ch = 0; ch < 2; ch++) {
    const q = kanaele[ch], z = buf.getChannelData(ch);
    const off = start + (ch === 1 ? versatz : 0);
    let energie = 0;
    for (let i = 0; i < len; i++) {
      let w = 1;
      if (i < ein) w = i / ein;
      if (i > len - aus) w *= 0.5 + 0.5 * Math.cos(Math.PI * (i - (len - aus)) / aus);
      const v = (q[off + i] || 0) * w;
      z[vor + i] = v;
      energie += v * v;
    }
    const norm = db(h.pegel) / Math.sqrt(energie || 1);
    for (let i = vor; i < vor + len; i++) z[i] *= norm;
  }
  return buf;
}

/** Hall-Puffer für ein Preset: echte IR, wenn gewählt und vorhanden, sonst null (→ eingebauter Hall) */
export async function hallFuer(ctx, preset, wahl = 'auto', latenzSamples = 0) {
  const p = RAUMKLANG_PRESETS[preset];
  if (!p?.hall) return null;
  const eintrag = irWaehlen(await irListe(), preset, wahl);
  if (!eintrag) return null;
  try {
    const roh = await irRoh(ctx, eintrag.id);
    const latenz = latenzSamples / ctx.sampleRate;
    return { buffer: irAufbereiten(ctx, roh, p.hall, p.hall.vor - latenz * 1000), name: eintrag.name };
  } catch (e) {
    console.warn('Raumklang: IR', eintrag.id, e);
    return null;
  }
}

/**
 * Baut den Upmix-Graphen: eingang (Stereo-Knoten) → Rückgabe {ausgang, knoten}
 * Der Worklet muss im Kontext schon geladen sein.
 */
export function raumklangGraph(ctx, eingang, preset, layout, hall = null, fein = FEIN_STANDARD) {
  return raumklangGraphEbenen(ctx, eingang, preset, layout, hall, fein);
}

/** Linkwitz-Riley 4. Ordnung: zwei identische Butterworth-Biquads (Q = 1/√2) in Reihe, Koeffizienten exakt für die Abtastrate */
function lr4(ctx, neu, f, art) {
  const om = 2 * Math.PI * f / ctx.sampleRate, c = Math.cos(om), al = Math.sin(om) / (2 * Math.SQRT1_2), a0 = 1 + al;
  const ff = art === 'lowpass' ? [(1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0] : [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0];
  const fb = [1, -2 * c / a0, (1 - al) / a0];
  const a = neu(ctx.createIIRFilter(ff, fb)), b = neu(ctx.createIIRFilter(ff, fb));
  for (const x of [a, b]) { x.channelCount = 1; x.channelCountMode = 'explicit'; }
  a.connect(b);
  return { ein: a, aus: b };
}

/**
 * Verfahren „Zwei Ebenen“: Worklet trennt Raum (kopiert), Effekte (verschoben) und Front.
 *  Front  → (um die Latenz verzögert, sonst unverändert, außer verschobenen Effekten) → LCR per M/S:
 *           L' = S + M·cos θ, R' = −S + M·cos θ, C = √2·M·sin θ (θ = Center-Anteil · 90°; Leistung einer Phantommitte bleibt)
 *           → Bassmanagement: Hochpass LR4 (24 dB/Okt.) für L'/R'/C, der LFE bekommt den Tiefpass von L+R der Front
 *           (um den LFE-Pegel abgesenkt). Trennfrequenz 0 = alles bleibt vorne, LFE leer.
 *  Raum   → Hochpass, Tiefmitten-Absenkung, Höhen dunkler + Tiefpass 9 kHz → je Seite Allpass-Kette (L und R
 *           verschieden = dekorreliert) und 12 bzw. 17 ms Verzögerung (Präzedenzeffekt: Bühne bleibt vorne), dazu leise
 *           die weiteren frühen Reflexionen des Presets und die Hallfahne (IR oder eingebaut) → Ls/Rs
 *  Effekte/Breite → trocken, ohne Verzögerung, phasengleich, volle Höhen → Ls/Rs auf derselben Seite; dazu ein eigener
 *           Hall (L/R getrennt gefaltet, ohne Bass, −12 dB, folgt der Intensität), der sie glättet und diffuser macht
 * Zum Abhören (Solo) hat jede Ebene ein eigenes Gain.
 */
const EFF_HALL = db(-12); // Hall der Effekte/Breite relativ zu ihrem trockenen Anteil (Intensität in der Mitte)
const ALLPASS = { l: [[310, 0.7], [1250, 0.9], [3100, 0.8], [7200, 0.7]], r: [[470, 0.8], [1650, 0.7], [4100, 0.9], [9300, 0.6]] };
function raumklangGraphEbenen(ctx, eingang, preset, layout, hall, fein) {
  const p = RAUMKLANG_PRESETS[preset];
  const { hall: intensitaet, reflex: reflexWert } = intensitaetWerte(fein);
  const pegel = db(feinDb(fein?.pegel));
  const k = [];
  const neu = (x) => { k.push(x); return x; };
  const gain = (wert, mono = false) => {
    const g = neu(ctx.createGain());
    g.gain.value = wert;
    if (mono) { g.channelCount = 1; g.channelCountMode = 'explicit'; }
    return g;
  };
  const filter = (typ, f, q = 0.707, g = 0, kanaele = 1) => {
    const b = neu(ctx.createBiquadFilter());
    b.type = typ; b.frequency.value = f; b.Q.value = q; b.gain.value = g;
    b.channelCount = kanaele; b.channelCountMode = 'explicit';
    return b;
  };
  const verz = (s) => { const d = neu(ctx.createDelay(0.2)); d.delayTime.value = s; d.channelCount = 1; d.channelCountMode = 'explicit'; return d; };
  const w = lcrWerte(fein);
  const upmixOpt = {
    numberOfInputs: 1, numberOfOutputs: 4, outputChannelCount: [2, 2, 2, 1],
    channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    processorOptions: { transient: p.transient, ducking: p.ducking, effekte: effekteWert(preset, fein), breite: breiteWert(preset, fein), center: false },
  };
  // Windows Client: der Upmix läuft in der Engine (dsp/upmix.c, gleiche Rechnung)
  const node = neu(ctx.nativ ? ctx.createWorklet('aw-upmix-ebenen', upmixOpt) : new AudioWorkletNode(ctx, 'aw-upmix-ebenen', upmixOpt));
  eingang.connect(node);
  node.port.onmessage = (e) => { if (e.data?.stand) workletStand.geladen = e.data.stand; };
  const misch = neu(ctx.createChannelMerger(layout.kanaele));

  // Front (Abhören: ein Gain vor der Matrix – wirkt auf L', R', C und LFE)
  const frontG = gain(1);
  frontG.channelCount = 2; frontG.channelCountMode = 'explicit';
  node.connect(frontG, 2);
  const frontTeiler = neu(ctx.createChannelSplitter(2));
  frontG.connect(frontTeiler);
  // M und S
  const m = gain(1, true), sPlus = gain(1, true), sMinus = gain(-1, true);
  const mL = gain(0.5, true), mR = gain(0.5, true), sL = gain(0.5, true), sR = gain(-0.5, true);
  frontTeiler.connect(mL, 0); frontTeiler.connect(mR, 1); mL.connect(m); mR.connect(m);
  frontTeiler.connect(sL, 0); frontTeiler.connect(sR, 1); sL.connect(sPlus); sR.connect(sPlus);
  sPlus.connect(sMinus);
  // Matrix (mCos/cSin gleiten live beim Ziehen des Center-Reglers); ohne Center-Lautsprecher (Quadro) bleibt L/R unverändert
  const theta = layout.c !== null ? (w.center / 100) * Math.PI / 2 : 0;
  const mCos = gain(Math.cos(theta), true), cSin = gain(Math.SQRT2 * Math.sin(theta), true);
  m.connect(mCos); m.connect(cSin);
  const links = gain(1, true), rechts = gain(1, true);
  sPlus.connect(links); mCos.connect(links);
  sMinus.connect(rechts); mCos.connect(rechts);
  // Bassmanagement
  const ziele = [[links, 0], [rechts, 1]];
  if (layout.c !== null) ziele.push([cSin, layout.c]);
  let lfeGain = null;
  const trennung = upmixTrennung(fein, layout);
  if (trennung > 0) {
    for (const [q, kanal] of ziele) { const hpB = lr4(ctx, neu, trennung, 'highpass'); q.connect(hpB.ein); hpB.aus.connect(misch, 0, kanal); }
    if (layout.kanaele === 6) {
      const summe = gain(1, true);
      frontTeiler.connect(summe, 0); frontTeiler.connect(summe, 1);
      const tpB = lr4(ctx, neu, trennung, 'lowpass');
      lfeGain = gain(db(w.lfe), true);
      summe.connect(tpB.ein); tpB.aus.connect(lfeGain).connect(misch, 0, 3);
    }
  } else {
    for (const [q, kanal] of ziele) q.connect(misch, 0, kanal);
  }

  // Raum
  const hp1 = filter('highpass', p.hp, 0.707, 0, 2), hp2 = filter('highpass', p.hp, 0.707, 0, 2);
  const tief = filter('peaking', 350, 0.8, p.tief, 2);
  const hoch = filter('highshelf', 7000, 0.707, p.hoehen - 1, 2);
  const tp = filter('lowpass', 9000, 0.5, 0, 2);
  node.connect(hp1, 0); hp1.connect(hp2).connect(tief).connect(hoch).connect(tp);
  const raumTeiler = neu(ctx.createChannelSplitter(2));
  tp.connect(raumTeiler);
  const summeL = gain(db(p.surround) * pegel, true), summeR = gain(db(p.surround) * pegel, true);
  const raumL = gain(1, true), raumR = gain(1, true);       // Abhören
  raumL.connect(summeL); raumR.connect(summeR);
  const reflexL = gain(reflexWert, true), reflexR = gain(reflexWert, true);
  reflexL.connect(raumL); reflexR.connect(raumR);
  const kette = (kanal, aps, s, ziel) => {
    let x = verz(s);
    raumTeiler.connect(x, kanal);
    for (const [f, q] of aps) x = x.connect(filter('allpass', f, q));
    x.connect(ziel);
  };
  kette(0, ALLPASS.l, 0.012, reflexL);
  kette(1, ALLPASS.r, 0.017, reflexR);
  // weitere frühe Reflexionen des Presets, leise (die erste ersetzt die dekorrelierte Hauptverzögerung)
  const taps = (kanal, liste, ziel) => {
    for (const [ms, g] of liste.slice(1)) {
      const d = verz(ms / 1000);
      raumTeiler.connect(d, kanal);
      d.connect(gain(g * (hall ? 0.25 : 0.4), true)).connect(ziel);
    }
  };
  taps(0, p.taps.l, reflexL);
  taps(1, p.taps.r, reflexR);
  let hallAnteil = null, hallPuffer = null;
  if (p.hall) {
    const hallK = neu(ctx.createConvolver());
    hallK.normalize = false;
    hallPuffer = hall?.buffer || hallImpuls(ctx, p.hall);
    hallK.buffer = hallPuffer;
    hallK.channelCount = 1; hallK.channelCountMode = 'explicit';
    hallAnteil = gain(intensitaet);
    tp.connect(hallK);
    if (p.direkt !== undefined) {
      // Direktschall (Front, gleich verzögert) regt den Hall an – ohne Bass und Tiefmitten
      const d1 = filter('highpass', p.hp, 0.707, 0, 2), d2 = filter('highpass', p.hp, 0.707, 0, 2);
      const dt = filter('peaking', 350, 0.8, p.tief, 2);
      const dg = gain(db(p.direkt));
      node.connect(d1, 2); d1.connect(d2).connect(dt).connect(dg).connect(hallK);
    }
    const hallTeiler = neu(ctx.createChannelSplitter(2));
    hallK.connect(hallAnteil).connect(hallTeiler);
    hallTeiler.connect(raumL, 0);
    hallTeiler.connect(raumR, 1);
  }

  // Effekte: trocken, sofort, gleiche Seite; Preset-Surround-Gain aufheben (kommen so laut an, wie sie vorne fehlen)
  const effBasis = 1 / db(p.surround);
  const effTeiler = neu(ctx.createChannelSplitter(2));
  node.connect(effTeiler, 1);
  const effL = gain(effBasis, true), effR = gain(effBasis, true);
  // Ohne Allpässe (0.1.97 hatte welche): dasselbe Signal vorne und phasengedreht hinten löscht sich am Hörplatz bei
  // einzelnen Frequenzen aus (klingt „notchy“). Phasengleich entsteht stattdessen eine Richtung zwischen vorne und hinten.
  effTeiler.connect(effL, 0); effTeiler.connect(effR, 1);
  // Eigener Hall für Effekte und Breite: glättet und macht sie hinten diffuser. Links und rechts werden getrennt gefaltet
  // (Stereo-Eingang × Stereo-IR: L mit Kanal 0, R mit Kanal 1) – bei einer Mono-Summe würden sich gegenphasige
  // Effekte auslöschen. Ohne Bass, Pegel folgt der Intensität (bei Mitte −12 dB unter den trockenen Effekten).
  let effHallAnteil = null;
  if (hallPuffer) {
    const eh1 = filter('highpass', p.hp, 0.707, 0, 2), eh2 = filter('highpass', p.hp, 0.707, 0, 2);
    const effHall = neu(ctx.createConvolver());
    effHall.normalize = false;
    effHall.channelCount = 2; effHall.channelCountMode = 'explicit'; effHall.channelInterpretation = 'discrete';
    effHall.buffer = hallPuffer; // eingebaute und aufbereitete IRs sind immer stereo
    effHallAnteil = gain(EFF_HALL * intensitaet);
    effHallAnteil.channelCount = 2; effHallAnteil.channelCountMode = 'explicit'; effHallAnteil.channelInterpretation = 'discrete';
    node.connect(eh1, 1); eh1.connect(eh2).connect(effHall).connect(effHallAnteil);
    const ehTeiler = neu(ctx.createChannelSplitter(2));
    effHallAnteil.connect(ehTeiler);
    ehTeiler.connect(effL, 0); ehTeiler.connect(effR, 1);
  }
  effL.connect(summeL); effR.connect(summeR);

  summeL.connect(misch, 0, layout.ls);
  summeR.connect(misch, 0, layout.rs);
  return { ausgang: misch, knoten: k, huelle: node, hinten: [summeL, summeR], hintenBasis: db(p.surround),
    hintenPegel: db(p.surround) * pegel, hallAnteil, effHallAnteil, reflexAnteile: [reflexL, reflexR], hallName: p.hall ? (hall?.name || t('eingebaut')) : null,
    trennung, lfeGain, matrix: layout.c !== null ? { mCos, cSin } : null,
    abhoer: { front: frontG, raum: [raumL, raumR], eff: [effL, effR], effBasis } };
}

function zielEinrichten(ziel, kanaele) {
  ziel.channelCount = kanaele;
  ziel.channelCountMode = 'explicit';
  ziel.channelInterpretation = kanaele > 2 ? 'discrete' : 'speakers';
}

/** Steuerung im Player: hängt sich einmalig per Web Audio an das Audio-Element */
export class Raumklang {
  constructor(audio) {
    this.audio = audio;
    this.ctx = null;
    this.quelle = null;
    this.graph = null;
    this.preset = 'aus';
    this.wunsch = 'aus';     // was eingestellt ist – kann bis zur Kanalmeldung des Geräts noch nicht wirken (preset bleibt dann 'aus')
    this.layout = null;
    this.workletBereit = null;
    this.irWahl = 'auto';
    this.fein = { ...FEIN_STANDARD };
    this.reihe = [...STUFEN];
    this.bypass = false;
    this.faerbung = {};      // art → { w: [L, R] (Anteil 0…1), t } – nur während messenAn
    this.messenAn = false;
    audio.addEventListener('play', () => { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); this.hintenOffen(true); });
    // Pause/Stopp: Hall und Surrounds sofort mit ausblenden, damit nichts nachklingt
    audio.addEventListener('pause', () => this.hintenOffen(false));
    audio.addEventListener('emptied', () => this.hintenOffen(false));
  }

  hintenOffen(an) {
    if (!this.ctx || !this.graph) return;
    const t = this.ctx.currentTime;
    for (const g of this.graph.hinten) {
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(an ? this.graph.hintenPegel : 0, t, an ? 0.02 : 0.015);
    }
  }

  /** Läuft das Audio-Element schon über Web Audio? (dann nicht mehr bitgenau, bis die Seite neu lädt) */
  get angeschlossen() { return !!this.ctx; }
  get aktiv() { return this.preset !== 'aus' && !!this.graph; }

  async kontext() {
    if (this.ctx) return this.ctx;
    if (this.audio?.nativ) return this.nativKontext();
    const C = window.AudioContext || window.webkitAudioContext;
    const ctx = new C({ latencyHint: 'playback' });
    this.workletBereit = (async () => {
      this.dspWasm = await dspWasmLaden();
      const effekte = this.dspWasm ? [DSP_WORKLET_URL] : [WAERME_WORKLET_URL, BAND_WORKLET_URL, TRAFO_WORKLET_URL];
      await Promise.all([WORKLET_URL, EQ_WORKLET_URL, ...effekte].map((u) => ctx.audioWorklet.addModule(u)));
    })();
    await this.workletBereit;
    this.quelle = ctx.createMediaElementSource(this.audio);
    // quelle → [Glow, Iron, Silk, EQ in der gewählten Reihenfolge] → vorne → [Upmix-Graph oder direkt] → ausgang (Überblendung) →
    // angleich (Lautheits-Gain) → mess (Messpunkt für Pegelanzeige, Meter, Spektrum) → fader (Lautstärke) → Gerät. Gemessen wird
    // also immer nach Effekten, Raumklang und Angleich – egal ob der Gain hier sitzt (Original/FLAC) oder schon im Stream (Opus/AAC) –,
    // aber ohne die Lautstärke.
    this.vorne = ctx.createGain();   // Stereo hinter der Effektkette: Eingang für Upmix oder direkt
    this.ausgang = ctx.createGain();
    this.angleich = ctx.createGain();
    this.angleich.gain.value = this.gainWert ?? 1;
    this.mess = ctx.createGain();
    this.fader = ctx.createGain();
    this.fader.gain.value = this.lautstaerkeWert ?? 1;
    this.angleich.connect(this.mess);
    this.mess.connect(this.fader);
    this.fader.connect(ctx.destination);
    const teiler = ctx.createChannelSplitter(6);
    this.mess.connect(teiler);
    this.messTeiler = teiler;
    this.ctx = ctx;
    this.ausgang.connect(this.angleich);
    this.analyser = [0, 1, 2, 3, 4, 5].map((c) => { const a = ctx.createAnalyser(); a.fftSize = 2048; teiler.connect(a, c); return a; });
    zielEinrichten(ctx.destination, 2);
    this.ketteVerdrahten();
    this.vorne.connect(this.ausgang);
    this.ctx = ctx;
    if (!this.audio.paused || navigator.userActivation?.isActive) ctx.resume().catch(() => {});
    this.beimAnschluss?.();
    return ctx;
  }

  // ---------- Windows Client: Kette und Messpunkte in der Engine ----------
  // Statt Web-Audio-Knoten: „virtuelle“ Stufen, deren port.postMessage an die Engine geht; die Analyser lesen die
  // Messpunkte der Engine (abgriff.js). Rack, Meter und Analyse arbeiten damit unverändert.

  nativKontext() {
    if (this.ctx) return this.ctx;
    const ich = this;
    this.ringe = { mess: new AbgriffRing(2), messK: new KRing(2), eingang: new AbgriffRing(2), eqvor: new AbgriffRing(1), eqnach: new AbgriffRing(1) };
    this.abgriffBedarf = {};
    // Kontext, der Space als Graph an die Engine gibt (raumnativ.js); Kanäle: was das Ausgabegerät in Windows hat
    this.ctx = new NativKontext({
      senden: (m) => nativ.senden(m),
      rate: () => ich.audio.format?.rate || ich.ringe.mess.rate || 48000,
      kanaele: () => ich.audio.format?.geraet_kanaele || ich.geraetKanaele || 2,
    });
    // Kanalzahl des Geräts kommt asynchron (Geräteliste) – setzen() wartet beim Start darauf, statt Space mangels Kanälen abzuschalten
    this._kanaeleBereit = Promise.all([nativ.geraete?.(), nativ.ausgabeLesen?.()]).then(([liste, wahl]) => {
      const g = (liste || []).find((x) => (wahl?.geraet ? x.id === wahl.geraet : x.standard));
      if (g?.kanaele) this.geraetKanaele = g.kanaele;
    }).catch(() => {});
    this.vorne = this.ctx.createGain();
    this.ausgang = this.ctx.createGain();
    this.vorne.connect(this.ausgang);
    this.analyser = [0, 1, 2, 3, 4, 5].map((c) => new AbgriffAnalyser(this.ringe.mess, c, 2048, { beimLesen: () => this.bedarf('mess') }));
    this.angleich = { nativ: true, gain: { value: this.gainWert ?? 1 } };
    nativ.auf((m) => this.nativMeldung(m));
    setInterval(() => this.abgriffePruefen(), 1000);
    nativ.senden({ c: 'messen', an: !!this.messenAn });
    nativ.senden({ c: 'delta', art: this.deltaArt || '' });
    this.ketteVerdrahten();
    this.beimAnschluss?.();
    return this.ctx;
  }

  /** ein Messpunkt wird gebraucht (Rack, Meter, Analyse offen) – nach 2,5 s ohne Zugriff schickt die Engine ihn nicht mehr */
  bedarf(t) {
    const neu = !this.abgriffBedarf[t] || performance.now() - this.abgriffBedarf[t] > 2000;
    this.abgriffBedarf[t] = performance.now();
    if (neu) this.abgriffePruefen();
  }

  abgriffePruefen() {
    const jetzt = performance.now();
    const liste = Object.entries(this.abgriffBedarf || {}).filter(([, t]) => jetzt - t < 2500).map(([k]) => k).sort().join(',');
    if (liste === this.abgriffListe) return;
    this.abgriffListe = liste;
    nativ.senden({ c: 'abgriffe', liste });
  }

  nativMeldung(m) {
    if (m.e === 'pcm') {
      const ring = this.ringe[m.t];
      if (!ring || !m.d) return;
      let roh;
      if (typeof m.d === 'string') { const t = atob(m.d); roh = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) roh[i] = t.charCodeAt(i); }
      else roh = m.d instanceof Uint8Array ? m.d : new Uint8Array(m.d);
      const i16 = new Int16Array(roh.slice().buffer);
      ring.schreiben(i16, m.k, m.r);
      if (m.t === 'mess') this.ringe.messK.schreiben(i16, m.k, m.r);
    } else if (m.e === 'faerb') {
      this.faerbung[m.art] = { w: m.w, t: performance.now() };
    } else if (m.e === 'format') {
      if (this.eqKnoten) this.nativEq();
      if (m.geraet_kanaele) this.geraetKanaele = m.geraet_kanaele;
      // Space ist eingestellt, konnte aber noch nicht wirken (Kanalzahl unbekannt oder Gerät war Stereo): jetzt nachholen
      if (this.wunsch !== 'aus' && this.preset === 'aus' && layoutFuer(m.geraet_kanaele || 2)) {
        clearTimeout(this._raumNeu);
        this._raumNeu = setTimeout(() => this.setzen(this.wunsch).catch(() => {}), 50);
      }
      // Space ist für eine Abtastrate und ein Layout gebaut: bei neuer Rate (oder anderem Gerät) neu bauen
      if (this.preset !== 'aus' && this.graph && (m.rate !== this.raumRate || layoutFuer(m.geraet_kanaele || 2)?.kanaele !== this.layout?.kanaele)) {
        clearTimeout(this._raumNeu);
        this._raumNeu = setTimeout(() => this.setzen(this.preset).catch(() => {}), 50);
      }
    } else if (m.e === 'neustart') {
      this.ctx.zuruecksetzen();
      if (this.wunsch !== 'aus') setTimeout(() => this.setzen(this.wunsch).catch(() => {}), 100);
      // Engine neu gestartet: Kette, Messpunkte und Messung neu übergeben
      this.abgriffListe = null;
      nativ.senden({ c: 'messen', an: !!this.messenAn });
      nativ.senden({ c: 'delta', art: this.deltaArt || '' });
      this.ketteVerdrahten();
      this.abgriffePruefen();
    }
  }

  /** Werte einer Stufe an die Engine (flach: "w.<name>") */
  nativFx(art, d) {
    if (!d || d.ende) return;
    if (typeof d.messen === 'boolean' || typeof d.delta === 'boolean') return; // laufen über messenSetzen/deltaSetzen
    if (art === 'eq') { this.nativEq(); return; }
    const o = { c: 'fx', art };
    for (const [k, v] of Object.entries(d)) if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' || (Array.isArray(v) && v.every(Number.isFinite))) o[`w.${k}`] = v;
    nativ.senden(o);
  }

  /** EQ: Koeffizienten für alle üblichen Raten (die Engine nimmt die zur Datei passende) */
  nativEq() {
    const raten = new Set(NATIV_RATEN);
    if (this.ctx?.sampleRate) raten.add(Math.round(this.ctx.sampleRate));
    const o = { c: 'fx', art: 'eq' };
    for (const sr of raten) {
      o[`w.k@${sr}`] = Array.from(eqKoeffizienten(this.eq, sr));
      o[`w.gain@${sr}`] = Math.pow(10, eqGainDb(this.eq, sr) / 20);
    }
    nativ.senden(o);
  }

  /** virtuelle Stufe: Startwerte jetzt, spätere Werte über port.postMessage */
  nativStufe(art) {
    if (istVstId(art)) return { nativ: true, vst: true, port: { postMessage: () => {} } };
    const k = { nativ: true, port: { postMessage: (d) => this.nativFx(art, d) } };
    if (art === 'eq') this.nativEq();
    else if (art === 'glow') this.nativFx(art, waermeParameter(this.waerme, this.waermeBezug || 0));
    else if (art === 'iron') this.nativFx(art, this.trafoParameter(this.trafo, this.trafoBezug || 0));
    else this.nativFx(art, bandParameter(this.band, this.bandBezug || 0));
    return k;
  }

  /**
   * Analyser für das Spektrum (Analyse): Front links/rechts, Mitte (L+R)/2 und Seite (L−R)/2 – hinter EQ/Raumklang,
   * vor der Lautstärke. FFT 16384 Punkte (bei 44,1 kHz alle 2,7 Hz ein Wert). Wird beim ersten Aufruf angelegt.
   */
  spektrum() {
    if (!this.ctx) return null;
    if (this.ctx.nativ && !this.spektrumKnoten) {
      const o = { smoothingTimeConstant: 0.55, minDecibels: -140, maxDecibels: 0, beimLesen: () => this.bedarf('mess') };
      const r = this.ringe.mess;
      this.spektrumKnoten = { l: new AbgriffAnalyser(r, 0, 16384, o), r: new AbgriffAnalyser(r, 1, 16384, o), m: new AbgriffAnalyser(r, [0.5, 0.5], 16384, o), s: new AbgriffAnalyser(r, [0.5, -0.5], 16384, o) };
    }
    if (!this.spektrumKnoten) {
      const ctx = this.ctx;
      const neu = () => {
        const a = ctx.createAnalyser();
        a.fftSize = 16384;
        a.smoothingTimeConstant = 0.55;
        a.minDecibels = -140;
        a.maxDecibels = 0;
        return a;
      };
      const mono = (wert) => { const g = ctx.createGain(); g.gain.value = wert; g.channelCount = 1; g.channelCountMode = 'explicit'; return g; };
      const l = neu(), r = neu(), m = neu(), s = neu();
      this.messTeiler.connect(l, 0);
      this.messTeiler.connect(r, 1);
      const mL = mono(0.5), mR = mono(0.5), sL = mono(0.5), sR = mono(-0.5);
      this.messTeiler.connect(mL, 0); this.messTeiler.connect(mR, 1);
      this.messTeiler.connect(sL, 0); this.messTeiler.connect(sR, 1);
      const mSumme = mono(1), sSumme = mono(1);
      mL.connect(mSumme); mR.connect(mSumme); sL.connect(sSumme); sR.connect(sSumme);
      mSumme.connect(m); sSumme.connect(s);
      this.spektrumKnoten = { l, r, m, s };
    }
    return this.spektrumKnoten;
  }

  /**
   * K-bewertete Abgriffe je Kanal (ITU-R BS.1770 / EBU R128: Vorfilter-Kuhschwanz +4 dB über ~1,7 kHz und RLB-Hochpass
   * ~38 Hz, exakte Koeffizienten für die Abtastrate des Kontexts) – für die Live-Lautheit der Meter. Gleicher Messpunkt
   * wie Pegelanzeige und Spektrum. Puffer 32768 Samples: 400 ms bis 48 kHz Abtastrate, darüber das längste, was passt (96 kHz: 341 ms).
   */
  lautheitAnalyser() {
    if (!this.ctx) return null;
    if (this.ctx.nativ && !this.khAnalyser) this.khAnalyser = [0, 1, 2, 3, 4, 5].map((c) => new AbgriffAnalyser(this.ringe.messK, c, 32768, { beimLesen: () => this.bedarf('mess') }));
    if (!this.khAnalyser) {
      const ctx = this.ctx, fs = ctx.sampleRate;
      // Stufe 1: Kuhschwanz (wie libebur128)
      let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
      let K = Math.tan(Math.PI * f0 / fs);
      const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
      let a0 = 1 + K / Q + K * K;
      const s1 = { feedforward: [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0], feedback: [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] };
      // Stufe 2: RLB-Hochpass
      f0 = 38.13547087602444; Q = 0.5003270373238773;
      K = Math.tan(Math.PI * f0 / fs);
      a0 = 1 + K / Q + K * K;
      const s2 = { feedforward: [1, -2, 1], feedback: [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] };
      const mono = (x) => { x.channelCount = 1; x.channelCountMode = 'explicit'; return x; };
      this.khAnalyser = [0, 1, 2, 3, 4, 5].map((c) => {
        const f1 = mono(new IIRFilterNode(ctx, s1));
        const f2 = mono(new IIRFilterNode(ctx, s2));
        const a = ctx.createAnalyser();
        a.fftSize = 32768;
        this.messTeiler.connect(f1, c);
        f1.connect(f2).connect(a);
        return a;
      });
    }
    return this.khAnalyser;
  }

  /** Nur anschließen (für die Pegelanzeige), ohne Upmix */
  async anschliessen() {
    if (this._anschluss) return this._anschluss;
    this._anschluss = this.kontext();
    return this._anschluss;
  }

  // ---------- Effektkette: Glow, Iron, Silk und EQ in frei wählbarer Reihenfolge ----------
  // quelle → [Stufen in this.reihe, nur die wirksamen] → vorne → [Upmix oder direkt] → ausgang → angleich → mess → fader.
  // Umgestellt wird mit kurzer Blende (15 ms aus, umstecken, 20 ms ein) – kein Knacken. Laufende Worklets bleiben beim
  // Umstellen erhalten (kein Neustart ihrer Filterzustände), nur abgeschaltete werden beendet.

  /** Ist die Stufe im Signalweg? (aus, wenn alle Effekte umgangen werden) */
  stufeWirksam(art) {
    if (this.bypass) return false;
    if (istVstId(art)) return vstRack.wirksam(art);
    if (art === 'glow') return waermeWirksam(this.waerme || {});
    if (art === 'iron') return trafoWirksam(this.trafo || {});
    if (art === 'silk') return bandWirksam(this.band || {});
    if (art === 'eq') return eqWirksam(this.eq || {});
    return false;
  }

  /** Worklet einer Stufe anlegen (mit Färbungsmessung, wenn das Rack offen ist) */
  stufeBauen(art) {
    if (this.ctx?.nativ) return this.nativStufe(art);
    const ctx = this.ctx;
    const stereo = { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' };
    const wasm = this.dspWasm ? { wasm: this.dspWasm } : {};
    let k;
    if (art === 'eq') {
      k = new AudioWorkletNode(ctx, 'aw-eq', {
        numberOfInputs: 1, numberOfOutputs: 1, channelCountMode: 'max', channelInterpretation: 'discrete',
        processorOptions: { k: eqKoeffizienten(this.eq, ctx.sampleRate), gain: Math.pow(10, eqGainDb(this.eq, ctx.sampleRate) / 20) },
      });
    } else if (art === 'glow') {
      k = new AudioWorkletNode(ctx, 'aw-roehre', { ...stereo, processorOptions: { ...waermeParameter(this.waerme, this.waermeBezug || 0), ...wasm } });
    } else if (art === 'iron') {
      k = new AudioWorkletNode(ctx, 'aw-trafo', { ...stereo, processorOptions: { ...this.trafoParameter(this.trafo, this.trafoBezug || 0), ...wasm } });
    } else {
      k = new AudioWorkletNode(ctx, 'aw-band', { ...stereo, processorOptions: { ...bandParameter(this.band, this.bandBezug || 0), ...wasm } });
    }
    if (art !== 'eq') {
      k.port.onmessage = (e) => { if (e.data && e.data.faerb) this.faerbung[art] = { w: e.data.faerb, t: performance.now() }; };
      if (this.messenAn) k.port.postMessage({ messen: true });
      if (this.deltaArt === art) k.port.postMessage({ delta: true });
    }
    return k;
  }

  /**
   * Eine komplette Kette bauen: frische Worklets für jede wirksame Stufe in der eingestellten Reihenfolge, am Ende ein eigener
   * Gain (für die Überblendung) → vorne. Jede Verbindung wird gemerkt, damit sie später einzeln gelöst werden kann – die
   * Quelle speist während einer Überblendung zwei Ketten gleichzeitig.
   */
  ketteBauen(start = 1) {
    if (this.ctx?.nativ) {
      // Werte jeder Stufe zuerst, dann die Kette – die Engine baut sie um und blendet selbst über
      const knoten = {};
      for (const art of this.reihe) if (this.stufeWirksam(art)) knoten[art] = this.stufeBauen(art);
      nativ.senden({ c: 'kette', reihe: this.reihe.join(','), stufen: this.reihe.filter((a) => knoten[a]).join(',') });
      return { knoten, g: null, verb: [] };
    }
    const ctx = this.ctx, verb = [], knoten = {};
    const g = ctx.createGain();
    g.gain.value = start;
    const verbinde = (a, b) => { a.connect(b); verb.push([a, b]); };
    let vor = this.quelle;
    for (const art of this.reihe) {
      const n = this.stufeWirksam(art) ? this.stufeBauen(art) : null;
      if (art === 'eq' && this.eqAbgriff) { verbinde(vor, this.eqAbgriff.vor); verbinde(n || vor, this.eqAbgriff.nach); }
      if (n) { verbinde(vor, n); vor = n; knoten[art] = n; }
    }
    verbinde(vor, g);
    verbinde(g, this.vorne);
    return { knoten, g, verb };
  }

  /** Diese Kette ist ab jetzt die, an die alle Parameter gehen */
  ketteAktivieren(k) {
    for (const art of STUFEN) this[KNOTEN_FELD[art]] = k.knoten[art] || null;
    for (const art of STUFEN) if (!k.knoten[art]) delete this.faerbung[art];
    this.kette = k;
  }

  /** Alte Kette lösen und ihre Worklets beenden (abgeklemmt liefen sie sonst im Audio-Thread weiter) */
  ketteAbbauen(k) {
    if (!k.g) return; // Windows Client: nichts abzubauen
    for (const [a, b] of k.verb) { try { a.disconnect(b); } catch (e) { /* schon weg */ } }
    for (const n of Object.values(k.knoten)) { try { n.port.postMessage({ ende: true }); } catch (e) { /* egal */ } }
  }

  /** Kette sofort neu stecken (ohne Überblendung – beim Anschließen oder wenn nichts spielt) */
  ketteVerdrahten() {
    if (!this.ctx) return;
    const alt = this.kette;
    this.ketteAktivieren(this.ketteBauen(1));
    if (alt) this.ketteAbbauen(alt);
  }

  /**
   * Kette umbauen (Ein/Aus einer Stufe, andere Reihenfolge, alles umgehen) – ohne Lücke: die neue Kette läuft parallel an
   * und wird in 60 ms gleichleistend über die alte geblendet (cos/sin), danach wird die alte abgebaut. Kurz rechnen beide.
   */
  umbauen() {
    if (!this.ctx) return;
    if (this.ctx.nativ) { this.ketteVerdrahten(); return; }
    if (this.ctx.state !== 'running' || !this.kette) { this.ketteVerdrahten(); return; }
    const alt = this.kette, neu = this.ketteBauen(0);
    this.ketteAktivieren(neu);
    const N = 64, D = 0.06, t = this.ctx.currentTime + 0.01;
    const altWert = alt.g.gain.value;
    const aus = new Float32Array(N), ein = new Float32Array(N);
    for (let i = 0; i < N; i++) { const x = i / (N - 1) * Math.PI / 2; aus[i] = altWert * Math.cos(x); ein[i] = Math.sin(x); }
    alt.g.gain.cancelScheduledValues(0); alt.g.gain.setValueCurveAtTime(aus, t, D);
    neu.g.gain.cancelScheduledValues(0); neu.g.gain.setValueCurveAtTime(ein, t, D);
    setTimeout(() => this.ketteAbbauen(alt), (D + 0.12) * 1000);
  }

  /** Reihenfolge von Glow, Iron, Silk und EQ (Eingang vorn, Space und Ausgang hinten bleiben fest) */
  reiheSetzen(reihe) {
    const r = reiheNormal(reihe);
    if (r.join() === this.reihe.join()) return;
    this.reihe = r;
    this.trafoQuelleNachziehen();
    this.umbauen();
  }

  /** Alle Effekte umgehen (Vergleich): Glow, Iron, Silk und EQ raus – Space schaltet der Player */
  bypassSetzen(an) {
    if (!!an === !!this.bypass) return;
    this.bypass = !!an;
    this.trafoQuelleNachziehen();
    this.umbauen();
  }

  /** Delta-Hören: nur bei einem Gerät (oder keinem) hören, was es verändert – nass minus trocken, gleitet in 20 ms */
  deltaSetzen(art) {
    this.deltaArt = ['glow', 'iron', 'silk'].includes(art) ? art : null;
    if (this.ctx?.nativ) { nativ.senden({ c: 'delta', art: this.deltaArt || '' }); return; }
    for (const a of ['glow', 'iron', 'silk']) { const n = this[KNOTEN_FELD[a]]; if (n) n.port.postMessage({ delta: this.deltaArt === a }); }
  }

  /** Färbungsmessung in den Worklets an/aus (nur solange das Rack sichtbar ist – sonst kostet sie nichts) */
  messenSetzen(an) {
    this.messenAn = !!an;
    if (this.ctx?.nativ) { nativ.senden({ c: 'messen', an: !!an }); if (!an) this.faerbung = {}; return; }
    for (const art of ['glow', 'iron', 'silk']) { const n = this[KNOTEN_FELD[art]]; if (n) n.port.postMessage({ messen: !!an }); }
    if (!an) this.faerbung = {};
  }

  /** Pegel am Eingang (vor allen Effekten) je Kanal L/R – für das Eingangsmeter im Rack, beim ersten Aufruf angelegt */
  eingangAbgriffe() {
    if (!this.ctx) return null;
    if (this.ctx.nativ && !this.eingangAbgriff) this.eingangAbgriff = { a: [0, 1].map((c) => new AbgriffAnalyser(this.ringe.eingang, c, 2048, { beimLesen: () => this.bedarf('eingang') })) };
    if (!this.eingangAbgriff) {
      const teiler = this.ctx.createChannelSplitter(2);
      const a = [0, 1].map((c) => { const x = this.ctx.createAnalyser(); x.fftSize = 2048; teiler.connect(x, c); return x; });
      this.eingangAbgriff = { teiler, a };
      this.quelle.connect(teiler);
    }
    return this.eingangAbgriff.a;
  }

  /** Abgriffe vor und hinter dem EQ (Analyzer im Rack) – an seinem Platz in der Kette, auch wenn er gerade nichts tut */
  eqAbgriffe() {
    if (!this.ctx) return null;
    if (this.ctx.nativ && !this.eqAbgriff) {
      const o = { smoothingTimeConstant: 0.5, minDecibels: -140, maxDecibels: 0, beimLesen: () => this.bedarf('eq') };
      this.eqAbgriff = { vor: new AbgriffAnalyser(this.ringe.eqvor, 0, 16384, o), nach: new AbgriffAnalyser(this.ringe.eqnach, 0, 16384, o) };
    }
    if (!this.eqAbgriff) {
      const neu = () => { const a = this.ctx.createAnalyser(); a.fftSize = 16384; a.smoothingTimeConstant = 0.5; a.minDecibels = -140; a.maxDecibels = 0; return a; };
      this.eqAbgriff = { vor: neu(), nach: neu() };
      this.umbauen(); // Abgriffe in die Kette – mit Überblendung, ohne Lücke
    }
    return this.eqAbgriff;
  }

  /** EQ-Einstellung übernehmen (Werte gleiten, damit Ziehen nicht knackt; Ein/Aus mit kurzer Blende) */
  eqSetzen(eq) {
    const vorher = this.stufeWirksam('eq');
    this.eq = eq;
    if (!this.ctx) return;
    if (vorher !== this.stufeWirksam('eq')) { this.umbauen(); return; }
    this.eqWerte();
  }

  eqWerte() {
    if (!this.eqKnoten) return;
    if (this.ctx?.nativ) { this.nativEq(); return; }
    this.eqKnoten.port.postMessage({ k: eqKoeffizienten(this.eq, this.ctx.sampleRate), gain: Math.pow(10, eqGainDb(this.eq, this.ctx.sampleRate) / 20) });
  }

  /** Wärme (Röhrensättigung) übernehmen: Werte gleiten; Ein/Aus mit kurzer Blende umstecken */
  waermeSetzen(w) {
    const vorher = this.stufeWirksam('glow');
    this.waerme = w;
    this.waermeBezug = waermeBezugDb(w || {}, this.waermeLufs);
    if (vorher !== this.stufeWirksam('glow')) setTimeout(() => this.trafoQuelleNachziehen(), 0);
    if (!this.ctx) return;
    if (vorher !== this.stufeWirksam('glow')) { this.umbauen(); return; }
    if (this.waermeKnoten) this.waermeKnoten.port.postMessage(waermeParameter(w, this.waermeBezug));
  }

  /** Nach einem Wechsel der Röhre oder der Reihenfolge: die Quelle des Übertragers (auto) folgt */
  trafoQuelleNachziehen() {
    if (this.trafoKnoten) this.trafoKnoten.port.postMessage(this.trafoParameter(this.trafo, this.trafoBezug || 0));
  }

  /** Lautheit am Eingang der Röhre (LUFS des laufenden Titels, wie er hier ankommt) → Ansteuerung nachführen */
  waermeLautheit(lufsEingang) {
    this.waermeLufs = lufsEingang;
    const dbT = trafoBezugDb(this.trafo || {}, lufsEingang);
    if (Math.abs(dbT - (this.trafoBezug || 0)) >= 0.05) {
      this.trafoBezug = dbT;
      if (this.trafoKnoten) this.trafoKnoten.port.postMessage(this.trafoParameter(this.trafo, dbT));
    }
    const dbB = bandBezugDb(this.band || {}, lufsEingang);
    if (Math.abs(dbB - (this.bandBezug || 0)) >= 0.05) {
      this.bandBezug = dbB;
      if (this.bandKnoten) this.bandKnoten.port.postMessage(bandParameter(this.band, dbB));
    }
    const db = waermeBezugDb(this.waerme || {}, lufsEingang);
    if (Math.abs(db - (this.waermeBezug || 0)) < 0.05) return;
    this.waermeBezug = db;
    if (this.waermeKnoten) this.waermeKnoten.port.postMessage(waermeParameter(this.waerme, db));
  }

  /** Parameter des Übertragers – Quelle „auto“ = Röhre, wenn AmberGlow an ist und VOR ihm sitzt */
  trafoParameter(t, bezug) {
    const roehreDavor = this.stufeWirksam('glow') && this.reihe.indexOf('glow') < this.reihe.indexOf('iron');
    return trafoParameterRoh(t, bezug, roehreDavor);
  }

  /** Übertrager übernehmen: Werte gleiten; Ein/Aus mit kurzer Blende umstecken */
  trafoSetzen(t) {
    const vorher = this.stufeWirksam('iron');
    this.trafo = t;
    this.trafoBezug = trafoBezugDb(t || {}, this.waermeLufs);
    if (!this.ctx) return;
    if (vorher !== this.stufeWirksam('iron')) { this.umbauen(); return; }
    if (this.trafoKnoten) this.trafoKnoten.port.postMessage(this.trafoParameter(t, this.trafoBezug));
  }

  /** Band (Bandmaschine) übernehmen: Werte gleiten; Ein/Aus mit kurzer Blende umstecken */
  bandSetzen(b) {
    const vorher = this.stufeWirksam('silk');
    this.band = b;
    this.bandBezug = bandBezugDb(b || {}, this.waermeLufs);
    if (!this.ctx) return;
    if (vorher !== this.stufeWirksam('silk')) { this.umbauen(); return; }
    if (this.bandKnoten) this.bandKnoten.port.postMessage(bandParameter(b, this.bandBezug));
  }

  /**
   * Lautstärke (linear, hinter dem Messpunkt) und Lautheits-Gain (linear, darf über 1, vor dem Messpunkt).
   * inSek = Sekunden bis zur Änderung des Gains (z. B. Titelgrenze); die Lautstärke gilt sofort.
   */
  lautstaerke(v, gain = 1, inSek = 0, tau = 0.01) {
    if (this.ctx?.nativ) {
      // Windows Client: Lautstärke und Angleich setzt der Player an der Engine; hier nur für die Meter merken
      this.lautstaerkeWert = v; this.gainWert = gain; if (this.angleich) this.angleich.gain.value = gain;
      return;
    }
    this.lautstaerkeWert = v;
    const gainNeu = Math.abs(gain - (this.gainWert ?? 1)) > 1e-6 || inSek > 0;
    this.gainWert = gain;
    if (!this.fader) return;
    const t = this.ctx.currentTime;
    this.fader.gain.cancelScheduledValues(t);
    this.fader.gain.setTargetAtTime(v, t, 0.01);
    // Gain nur anfassen, wenn er sich ändert – sonst bliebe ein an der Titelgrenze vorgeplanter Wechsel beim Lautstärke-Ziehen nicht stehen
    if (gainNeu) {
      this.angleich.gain.cancelScheduledValues(t);
      this.angleich.gain.setTargetAtTime(gain, t + Math.max(0, inSek), tau);
    }
  }

  /** Spitzenpegel je Kanal (linear, 0..1+), Anzahl je nach Layout */
  spitzen(puffer) {
    if (!this.analyser) return null;
    const n = this.layout ? this.layout.kanaele : 2;
    const aus = [];
    for (let c = 0; c < n; c++) {
      this.analyser[c].getFloatTimeDomainData(puffer);
      let m = 0;
      for (let i = 0; i < puffer.length; i++) { const v = puffer[i] < 0 ? -puffer[i] : puffer[i]; if (v > m) m = v; }
      aus.push(m);
    }
    return aus;
  }

  /** Preset setzen ('aus' oder Schlüssel aus RAUMKLANG_PRESETS); gibt das Layout zurück oder null */
  async setzen(preset, irWahl = this.irWahl) {
    if (this.audio?.nativ && !this.ctx) await this.anschliessen(); // Windows Client: Layout nach den Kanälen des Geräts
    if (!RAUMKLANG_PRESETS[preset]) preset = 'aus';
    this.irWahl = irWahl || 'auto';
    this.wunsch = preset;
    this.preset = preset;
    if (preset === 'aus' && !this.ctx) return null;   // nie angeschlossen: Element spielt direkt (bitgenau)
    let layout = layoutFuer(this.ctx ? this.ctx.destination.maxChannelCount : ausgabeKanaele(true));
    if (preset !== 'aus' && !layout && this.audio?.nativ && this._kanaeleBereit) {
      // Windows Client beim Start: Kanalzahl des Geräts noch unterwegs – bis 3 s darauf warten
      await Promise.race([this._kanaeleBereit, new Promise((r) => setTimeout(r, 3000))]);
      if (this.wunsch !== preset) return null;   // inzwischen anders eingestellt
      layout = layoutFuer(this.ctx.destination.maxChannelCount);
    }
    // Gerät (noch) ohne Surround: Space ruht, bleibt aber eingestellt – kommt ein passendes Format, schaltet es sich zu
    // (lief schon ein Surround-Graph, wird er unten abgebaut und Stereo durchgereicht)
    if (preset !== 'aus' && !layout) { this.preset = 'aus'; if (!this.ctx || !this.graph) { this.beimWechsel?.(); return null; } }
    const ctx = await this.anschliessen();
    const hall = preset !== 'aus' ? await hallFuer(ctx, preset, this.irWahl) : null;
    // kurz ausblenden, umbauen, einblenden (kein Knacken)
    const g = this.ausgang.gain;
    const jetzt = ctx.currentTime;
    if (ctx.state === 'running') {
      g.cancelScheduledValues(jetzt);
      g.setValueAtTime(g.value, jetzt);
      g.linearRampToValueAtTime(0, jetzt + 0.03);
      await new Promise((r) => setTimeout(r, 40));
    }
    this.abbauen();
    if (this.preset === 'aus' || !layout) {
      zielEinrichten(ctx.destination, 2);
      this.vorne.connect(this.ausgang);
      this.layout = null;
    } else {
      zielEinrichten(ctx.destination, layout.kanaele);
      this.graph = raumklangGraph(ctx, this.vorne, this.preset, layout, hall, this.fein);
      // Solo je Lautsprecher: hinter dem Upmixer ein Gain je Kanal (wirkt bei jedem Verfahren)
      const teiler = ctx.createChannelSplitter(layout.kanaele), zusammen = ctx.createChannelMerger(layout.kanaele);
      this.soloGains = [];
      this.rearDelays = [];
      for (let c = 0; c < layout.kanaele; c++) {
        const gn = ctx.createGain();
        gn.channelCount = 1; gn.channelCountMode = 'explicit';
        teiler.connect(gn, c);
        // Rear-Delay: ganz am Ende des Upmixers, nur Ls/Rs (0–20 ms) – rückt per Präzedenzeffekt die Bühne nach vorn
        if (c === layout.ls || c === layout.rs) {
          const d = ctx.createDelay(0.05);
          d.channelCount = 1; d.channelCountMode = 'explicit';
          d.delayTime.value = rearSek(this.fein);
          gn.connect(d); d.connect(zusammen, 0, c);
          this.rearDelays.push(d);
          this.graph.knoten.push(d);
        } else gn.connect(zusammen, 0, c);
        this.soloGains.push(gn);
        this.graph.knoten.push(gn);
      }
      this.graph.knoten.push(teiler, zusammen);
      this.graph.ausgang.connect(teiler);
      zusammen.connect(this.ausgang);
      this.soloAnwenden(true);
      this.layout = layout;
      if (this.audio.paused) for (const x of this.graph.hinten) x.gain.value = 0;
      if (this.abhoerModus && this.abhoerModus !== 'alles') this.abhoeren(this.abhoerModus, true);
    }
    if (ctx.nativ) { ctx.graphSenden(this.vorne, this.ausgang); this.raumRate = ctx.sampleRate; }
    const t = ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(1, t + 0.03);
    if (!this.audio.paused) ctx.resume().catch(() => {});
    this.beimWechsel?.();
    return this.layout;
  }

  /** Intensität/Pegel live ändern (ohne Umbau, weich gleitend) */
  feinSetzen(fein) {
    this.fein = { ...FEIN_STANDARD, ...this.fein, ...fein };
    const g = this.graph;
    if (!g || !this.ctx) return;
    const t = this.ctx.currentTime;
    const gleiten = (param, wert) => { param.cancelScheduledValues(t); param.setTargetAtTime(wert, t, 0.03); };
    g.hintenPegel = g.hintenBasis * db(feinDb(this.fein.pegel));
    if (!this.audio.paused) for (const x of g.hinten) gleiten(x.gain, g.hintenPegel);
    const iw = intensitaetWerte(this.fein);
    if (g.hallAnteil) gleiten(g.hallAnteil.gain, iw.hall);
    if (g.effHallAnteil) gleiten(g.effHallAnteil.gain, EFF_HALL * iw.hall);
    for (const x of g.reflexAnteile || []) gleiten(x.gain, iw.reflex);
    const w = lcrWerte(this.fein);
    if (g.matrix) {
      const theta = (w.center / 100) * Math.PI / 2;
      gleiten(g.matrix.mCos.gain, Math.cos(theta));
      gleiten(g.matrix.cSin.gain, Math.SQRT2 * Math.sin(theta));
    }
    if (g.lfeGain) gleiten(g.lfeGain.gain, db(w.lfe));
    for (const d of this.rearDelays || []) gleiten(d.delayTime, rearSek(this.fein));
    const umbauNoetig = () => this.graph && upmixTrennung(this.fein, this.layout) !== this.graph.trennung;
    if (umbauNoetig()) {
      // Andere Trennfrequenz: Filter neu rechnen → einmal kurz umbauen (mit Blende)
      clearTimeout(this._umbauTimer);
      this._umbauTimer = setTimeout(() => { if (umbauNoetig()) this.setzen(this.preset); }, 150);
    }
    g.huelle?.port.postMessage({ effekte: effekteWert(this.preset, this.fein), breite: breiteWert(this.preset, this.fein) });
  }

  /**
   * Abhören (wird nicht gespeichert): 'alles', 'vorne' (L/C/R + LFE), 'raum' (nur Raum
   * und Hall hinten) oder 'effekte' (nur die verschobenen Effekte hinten). Weich umgeblendet.
   */
  /** Bassmanagement des Ausgangs an/aus oder andere Frequenz: Upmixer neu bauen, wenn er dadurch anders trennen muss */
  ausgangBassGeaendert() {
    if (this.graph && this.preset !== 'aus' && upmixTrennung(this.fein, this.layout) !== this.graph.trennung) this.setzen(this.preset);
  }

  abhoeren(modus = 'alles', sofort = false) {
    this.abhoerModus = modus;
    const a = this.graph?.abhoer;
    if (!a || !this.ctx) return;
    const t = this.ctx.currentTime;
    const setz = (param, wert) => { param.cancelScheduledValues(t); if (sofort) param.value = wert; else param.setTargetAtTime(wert, t, 0.02); };
    const vorne = modus === 'alles' || modus === 'vorne';
    setz(a.front.gain, vorne ? 1 : 0);
    for (const x of a.raum) setz(x.gain, modus === 'alles' || modus === 'raum' ? 1 : 0);
    for (const x of a.eff) setz(x.gain, modus === 'alles' || modus === 'effekte' ? a.effBasis : 0);
  }


  /**
   * Solo je Lautsprecher (wird nicht gespeichert): leere Menge = alle hören, sonst nur die gewählten Kanäle.
   * Mehrere gleichzeitig möglich (z. B. Ls + Rs). Weich umgeblendet.
   */
  soloSetzen(kanaele) {
    this.solo = new Set(kanaele || []);
    this.soloAnwenden(false);
  }

  soloAnwenden(sofort) {
    if (!this.soloGains || !this.ctx) return;
    const t = this.ctx.currentTime, solo = this.solo || new Set();
    this.soloGains.forEach((gn, c) => {
      const w = !solo.size || solo.has(c) ? 1 : 0;
      gn.gain.cancelScheduledValues(t);
      if (sofort) gn.gain.value = w; else gn.gain.setTargetAtTime(w, t, 0.015);
    });
  }

  /**
   * Raumklang-Modul frisch starten (neuer Graph, neue Worklet-Instanz, alle Mess- und Filterzustände leer), mit kurzer
   * Blende. Bei Titelwahl, Skip und Play – nicht beim lückenlosen Übergang. Abschaltbar mit RAUMKLANG_NEUSTART=0.
   */
  async neustart() {
    if (!RAUMKLANG_VORGABEN.neustart || !this.graph || this._neustartLaeuft) return;
    this._neustartLaeuft = true;
    try { await this.setzen(this.preset); } catch (e) { console.warn('Raumklang-Neustart', e); } finally { this._neustartLaeuft = false; }
  }

  abbauen() {
    try { this.vorne?.disconnect(); } catch (e) { /* egal */ }
    if (this.graph) {
      for (const n of this.graph.knoten) { try { n.disconnect(); } catch (e) { /* egal */ } }
      // Worklets beenden: abgeklemmt laufen sie sonst im Audio-Thread weiter (je Umbau einer mehr → Aussetzer)
      try { this.graph.huelle?.port.postMessage({ ende: true }); } catch (e) { /* egal */ }
      this.graph = null;
      this.soloGains = null;
    }
  }
}

// ---------- Space für den Server (Geräte im Heimnetz) ----------

/**
 * Space als Befehle für bin/aw-render (dieselben, die der Windows Client an die Engine schickt): Graph als Text,
 * Impulsantworten als Daten. Gebaut wie in setzen() – Upmix, dahinter je Kanal das Rear-Delay –, nur für eine feste
 * Abtastrate und Kanalzahl. Rückgabe: JSON-Zeilen (Text) oder '' (kein Layout).
 */
export async function raumBefehle({ preset, fein = FEIN_STANDARD, irWahl = 'auto', kanaele = 6, rate = 48000 }) {
  const layout = layoutFuer(kanaele);
  if (!layout || !RAUMKLANG_PRESETS[preset]) return '';
  const zeilen = [];
  const ctx = new NativKontext({ senden: (m) => zeilen.push(JSON.stringify(m)), rate: () => rate, kanaele: () => layout.kanaele });
  ctx.destination.channelCount = layout.kanaele;
  const vorne = ctx.createGain(), ausgang = ctx.createGain();
  const f = { ...FEIN_STANDARD, ...(fein || {}) };
  const graph = raumklangGraph(ctx, vorne, preset, layout, await hallFuer(ctx, preset, irWahl), f);
  const teiler = ctx.createChannelSplitter(layout.kanaele), zusammen = ctx.createChannelMerger(layout.kanaele);
  graph.ausgang.connect(teiler);
  for (let c = 0; c < layout.kanaele; c++) {
    const gn = ctx.createGain();
    gn.channelCount = 1; gn.channelCountMode = 'explicit';
    teiler.connect(gn, c);
    if (c === layout.ls || c === layout.rs) {
      const d = ctx.createDelay(0.05);
      d.channelCount = 1; d.channelCountMode = 'explicit';
      d.delayTime.value = rearSek(f);
      gn.connect(d); d.connect(zusammen, 0, c);
    } else gn.connect(zusammen, 0, c);
  }
  zusammen.connect(ausgang);
  ctx.graphSenden(vorne, ausgang);
  return zeilen.join('\n') + '\n';
}

// ---------- Export als Mehrkanal-WAV (zum Probehören in der DAW) ----------

/** Rendert eine Audiodatei (ArrayBuffer) offline mit einem Preset → WAV-Blob (24 Bit, 5.1 mit Kanalmaske) */
export async function raumklangRendern(daten, preset, kanaele = 6, irWahl = 'auto', fein = FEIN_STANDARD) {
  const C = window.AudioContext || window.webkitAudioContext;
  const dekoder = new C();
  let buf;
  try { buf = await dekoder.decodeAudioData(daten); } finally { dekoder.close?.(); }
  const layout = layoutFuer(kanaele);
  const ctx = new OfflineAudioContext(layout.kanaele, buf.length, buf.sampleRate);
  await ctx.audioWorklet.addModule(WORKLET_URL);
  const q = ctx.createBufferSource();
  q.buffer = buf;
  let stereo = q;
  if (buf.numberOfChannels !== 2) {
    stereo = ctx.createGain();
    stereo.channelCount = 2; stereo.channelCountMode = 'explicit'; stereo.channelInterpretation = 'speakers';
    q.connect(stereo);
  }
  zielEinrichten(ctx.destination, layout.kanaele);
  const g = raumklangGraph(ctx, stereo, preset, layout, await hallFuer(ctx, preset, irWahl), fein);
  g.ausgang.connect(ctx.destination);
  q.start();
  const erg = await ctx.startRendering();
  return wavKodieren(erg, layout.kanaele === 6 ? 0x3f : 0x33);
}

/** WAVE_FORMAT_EXTENSIBLE, 24 Bit PCM */
export function wavKodieren(buf, maske) {
  const k = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate;
  const bps = 3, block = k * bps, datenLaenge = n * block;
  const ab = new ArrayBuffer(68 + datenLaenge);
  const v = new DataView(ab);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 60 + datenLaenge, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 40, true);
  v.setUint16(20, 0xfffe, true); v.setUint16(22, k, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * block, true); v.setUint16(32, block, true); v.setUint16(34, 24, true);
  v.setUint16(36, 22, true); v.setUint16(38, 24, true); v.setUint32(40, maske, true);
  // KSDATAFORMAT_SUBTYPE_PCM 00000001-0000-0010-8000-00aa00389b71
  [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71].forEach((b, i) => v.setUint8(44 + i, b));
  str(60, 'data'); v.setUint32(64, datenLaenge, true);
  const kan = [];
  for (let c = 0; c < k; c++) kan.push(buf.getChannelData(c));
  let o = 68;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < k; c++) {
      let s = kan[c][i];
      s = s > 1 ? 1 : s < -1 ? -1 : s;
      const x = Math.round(s * 8388607);
      v.setUint8(o, x & 0xff); v.setUint8(o + 1, (x >> 8) & 0xff); v.setUint8(o + 2, (x >> 16) & 0xff);
      o += 3;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}
