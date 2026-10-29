// Effektrack: alle Klanggeräte in einer Ansicht.
//  • Flyout an der Player-Leiste (PC): Karten wie auf dem Handy, je Gerät aufklappbar
//  • Vollbild: am PC das 19″-Rack (alle Geräte offen, in einer Zeile gelesen), auf Handy und Tablet die Karten
// Glow, Iron, Silk und EQ lassen sich am Griff verschieben – das ändert die Reihenfolge im Signalweg. Eingang, AmberSpace und
// Ausgang stehen fest. Eigene Presets je Gerät und fürs ganze Rack liegen im Konto (/api/v1/presets); A/B und „alles umgehen“
// sind nur zum Vergleichen und werden nicht gemerkt. Die Färbungsmeter zeigen, was die Worklets messen (Klirr wie THD+N).
import { api } from './api.js';
import { h, icon, toast, dialog, bestaetigen } from './ui.js';
import { vstRack, istVstId } from './vstrack.js';
import { vstWaehler } from './vstbrowser.js';
import { WAERME_STUFEN, WAERME_ROEHREN, WAERME_SCHALTUNGEN, waermeNormal, waermeStufe, waermeStufeErkennen, waermeWirksam } from './waerme.js';
import { TRAFO_STUFEN, TRAFO_KERNE, TRAFO_QUELLEN, trafoNormal, trafoStufe, trafoStufeErkennen, trafoWirksam } from './trafo.js';
import { BAND_STUFEN, BAND_SORTEN, BAND_SORTEN_REIHE, BAND_NORMEN, BAND_IPS, bandNormal, bandStufe, bandStufeErkennen, bandWirksam } from './band.js';
import { eqNormal, EQ_STANDARD, EQ_MODI, BAND_TYPEN, F_GRENZEN, Q_GRENZEN, GAIN_MAX, eqBaenderDb, freqText } from './eq.js';
import { RAUMKLANG_PRESETS, FEIN_STANDARD, irListe, irWaehlen, layoutFuer, ausgabeKanaele, reiheNormal, staerkeWerte, staerkeErkennen } from './raumklang.js';
import { text as feinText } from './raumklangfein.js';
import { raumklangMenueOeffnen } from './raumklangmenue.js';
import { titelFarbe } from './nativ.js';
import { t, tn, zahl, sprache } from './i18n.js';

// ---------- Kleinigkeiten ----------
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const dez = (x, n = 0) => (x < -1e-9 && Math.abs(x).toFixed(n) !== (0).toFixed(n) ? '−' : '') + zahl(Math.abs(x), n);
const vz = (x, n = 0) => { const s = Math.abs(x).toFixed(n); return (s === (0).toFixed(n) ? '±' : x > 0 ? '+' : '−') + zahl(Math.abs(x), n); };
const PROZ = (v) => `${Math.round(v)} %`;
const ruhig = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const schmal = () => matchMedia('(max-width: 767px)').matches;
const gross = () => matchMedia('(min-width: 1024px)').matches;
const pick = (o, felder) => Object.fromEntries(felder.map((f) => [f, o?.[f]]));
/** Werte vergleichen (Zahlen mit kleiner Toleranz, Objekte/Listen rekursiv) */
function gleich(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.011;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (Array.isArray(a) !== Array.isArray(b) || ka.length !== kb.length) return false;
    return ka.every((k) => gleich(a[k], b[k]));
  }
  return a === b;
}
const VERT = (v) => (v === 50 ? t('gleich') : v < 50 ? t('Mitte +{n} %', { n: (50 - v) * 2 }) : t('Seiten +{n} %', { n: (v - 50) * 2 }));
const fRund = (f) => (f < 100 ? Math.round(f) : f < 1000 ? Math.round(f / 5) * 5 : f < 10000 ? Math.round(f / 50) * 50 : Math.round(f / 100) * 100);

// ---------- Geräte ----------
const GERAET = {
  eingang: { name: t('Eingang'), rolle: t('QUELLE'), farbe: '#f6efe7', fest: true },
  glow: { name: 'AmberGlow', kurz: 'Glow', rolle: t('VORSTUFE'), farbe: '#ffc976', netz: true, hq: true, hqText: t('Röhrenstufe als Schaltung gelöst, 8× Oversampling (im Gegentakt doppelte Rechenlast)') },
  iron: { name: 'AmberIron', kurz: 'Iron', rolle: t('ÜBERTRAGER'), farbe: '#d9d4ce', netz: true, hq: true, hqText: t('Kern mit Hysterese-Gedächtnis und Toleranzen') },
  silk: { name: 'AmberSilk', kurz: 'Silk', rolle: t('BANDMASCHINE'), farbe: '#f0dfc8', netz: true, hq: true, hqText: t('8× Oversampling, Hysterese-Rest, Gleichlauf') },
  eq: { name: t('Equalizer'), kurz: 'EQ', rolle: 'EQ', farbe: '#c9d8f2', netz: true },
  space: { name: 'AmberSpace', kurz: 'Space', rolle: t('RAUM'), farbe: '#ffb98a', fest: true, netz: true },
  ausgang: { name: t('Ausgang'), rolle: t('AUSGANG'), farbe: '#f6efe7', fest: true },
};
const FREI = ['glow', 'iron', 'silk', 'eq'];
/** Gerät nach Kennung: eingebaute oder ein VST3-Plug-in-Slot (Name HTML-sicher) */
function geraet(art) {
  if (GERAET[art]) return GERAET[art];
  const s = vstRack.finde(art), n = h(s ? s.name : 'VST3');
  return { name: n, kurz: n, rolle: 'VST3', farbe: '#b9dcc9', netz: true, vst: true };
}

const KNOEPFE = {
  glow: [
    { k: 'drive', n: t('Ansteuerung'), min: 0, max: 100, step: 1, fmt: PROZ },
    { k: 'charakter', n: t('Charakter'), min: 0, max: 100, step: 1, fmt: PROZ },
    { k: 'ton', n: t('Höhen'), min: 0, max: 100, step: 1, fmt: (v) => (v < 1 ? t('neutral') : t('samtig {n} %', { n: Math.round(v) })) },
    { k: 'symm', n: t('Symmetrie'), min: 0, max: 100, step: 1, nurGegentakt: true, fmt: PROZ },
    { k: 'mix', n: t('Anteil'), min: 0, max: 100, step: 1, fmt: PROZ },
    { k: 'vert', n: t('Verteilung'), min: 0, max: 100, step: 1, bip: true, fmt: VERT },
  ],
  iron: [
    { k: 'drive', n: t('Ansteuerung'), min: 0, max: 100, step: 1, fmt: PROZ },
    { k: 'glanz', n: t('Glanz'), min: 0, max: 100, step: 1, bip: true, fmt: (v) => `${vz((v - 50) / 50, 1)} dB` },
    { k: 'mix', n: t('Anteil'), min: 0, max: 100, step: 1, fmt: PROZ },
    { k: 'vert', n: t('Verteilung'), min: 0, max: 100, step: 1, bip: true, fmt: VERT },
  ],
  silk: [
    { k: 'drive', n: t('Ansteuerung'), min: 0, max: 100, step: 1, fmt: PROZ },
    { k: 'bias', n: 'Bias', min: 0, max: 100, step: 1, fmt: PROZ },
    { k: 'gleichlauf', n: t('Gleichlauf'), min: 0, max: 100, step: 1, nurHq: true, fmt: (v) => `${dez(v * 0.0025, 3)} %` },
    { k: 'mix', n: t('Anteil'), min: 0, max: 100, step: 1, fmt: PROZ },
    { k: 'vert', n: t('Verteilung'), min: 0, max: 100, step: 1, bip: true, fmt: VERT },
  ],
  space: [
    { k: 'intensitaet', n: t('Raum'), min: 0, max: 100, step: 1, bip: true, fmt: (v) => feinText('intensitaet', v) },
    { k: 'pegel', n: 'Surround', min: 0, max: 100, step: 1, bip: true, fmt: (v) => feinText('pegel', v) },
    { k: 'effekte', n: t('Effekt'), min: 0, max: 100, step: 1, fmt: (v) => feinText('effekte', v) },
    { k: 'breite', n: t('Breite'), min: 0, max: 100, step: 1, fmt: (v) => feinText('breite', v) },
    { k: 'trennung', n: t('LFE-Übergang'), min: 60, max: 250, step: 10, rast: true, fmt: (v) => (v ? `${v} Hz` : t('aus')) },
    { k: 'rear', n: 'Rear-Delay', min: 0, max: 20, step: 1, rast: true, fmt: (v) => `${Math.round(v)} ms` },
  ],
};
function eqKnoepfe(b, modus = 'praezise') {
  const passiv = modus === 'passiv';
  return [
    { k: 'g', n: t('Gain'), min: -GAIN_MAX, max: GAIN_MAX, step: 0.5, bip: true, fmt: (v) => (Math.abs(v) < 0.05 ? '0 dB' : `${vz(v, 1)} dB`) },
    { k: 'f', n: t('Frequenz'), min: F_GRENZEN[b.typ][0], max: F_GRENZEN[b.typ][1], log: true, rund: fRund, fmt: freqText },
    { k: 'q', n: b.typ === 'peaking' ? (passiv ? t('Breite') : 'Q') : (passiv ? t('Kante') : t('Steilheit')), min: Q_GRENZEN[b.typ][0], max: Q_GRENZEN[b.typ][1], log: true, rund: (q) => Math.round(q * 100) / 100, fmt: (v) => dez(v, 2) },
  ];
}
const EQ_FARBEN = ['#ff7a3d', '#ffc976', '#5fdca4', '#8fb4ff'];
const EQ_KURZ = [t('TIEF'), 'B2', 'B3', t('HOCH')];
const EQ_LANG = [t('TIEFEN'), t('BAND 2'), t('BAND 3'), t('HÖHEN')];

// Auswahlfelder
const OPTIONEN = {
  glow: [
    { k: 'roehre', n: t('RÖHRE'), werte: Object.entries(WAERME_ROEHREN).map(([w, x]) => ({ w, t: x.name, info: x.kurz })) },
    { k: 'schaltung', n: t('AUFBAU'), werte: Object.entries(WAERME_SCHALTUNGEN).map(([w, x]) => ({ w, t: x.name, info: x.kurz })) },
  ],
  iron: [
    { k: 'kern', n: t('KERN'), werte: Object.entries(TRAFO_KERNE).map(([w, x]) => ({ w, t: x.name, info: x.kurz })) },
    { k: 'quelle', n: t('QUELLE'), werte: Object.entries(TRAFO_QUELLEN).map(([w, x]) => ({ w, t: x.name, info: x.kurz })) },
  ],
  silk: [
    { k: 'ips', n: 'SPEED', werte: BAND_IPS.map((w) => ({ w, t: `${zahl(w)} ips`, info: w === 7.5 ? t('dichter Bass, weichere Höhen') : w === 15 ? t('der Studio-Standard') : t('offen, Bass etwas schlanker') })) },
    { k: 'sorte', n: t('SORTE'), werte: BAND_SORTEN_REIHE.map((w) => ({ w, t: BAND_SORTEN[w].name, info: BAND_SORTEN[w].kurz })) },
    { k: 'norm', n: t('NORM'), werte: Object.entries(BAND_NORMEN).map(([w, x]) => ({ w, t: x.name, info: x.kurz })) },
  ],
};
const SCHALTER = { silk: [{ k: 'kopf', t: t('Kopfbump') }, { k: 'rauschen', t: t('Rauschen'), nurHq: true }] };

// Felder, die ein eigenes Geräte-Preset speichert (ohne an/aus und HQ – die gehören dem Rack)
const PRESET_FELDER = {
  glow: ['roehre', 'schaltung', 'symm', 'drive', 'charakter', 'ton', 'mix', 'vert'],
  iron: ['kern', 'quelle', 'drive', 'glanz', 'mix', 'vert'],
  silk: ['drive', 'ips', 'bias', 'gleichlauf', 'kopf', 'mix', 'vert', 'sorte', 'norm', 'rauschen'],
};
const FEIN_FELDER = ['intensitaet', 'pegel', 'effekte', 'breite', 'center', 'trennung', 'lfe', 'rear'];
const SPACE_KURZ = { dezent: t('etwas Raum'), raum: t('großer Raum'), halle: t('dunkler Hall'), live: t('Konzert') };

// Mitgelieferte EQ-Presets: [Gain, Frequenz, Güte] je Band (Typen wie Standard: Shelf, Glocke, Glocke, Shelf)
const EQ_PRESETS = [
  ['Neutral', t('alles flach'), [[0, 100, 0.707], [0, 400, 1], [0, 3000, 1], [0, 8000, 0.707]]],
  [t('Wärmer'), t('mehr Fundament, weicher oben'), [[2.5, 120, 0.707], [0, 400, 1], [-1, 2800, 1], [-1, 9000, 0.707]]],
  [t('Klarer'), t('weniger Mulm, mehr Luft'), [[-1, 100, 0.707], [-1.5, 300, 1], [1, 3500, 1.2], [2, 10000, 0.707]]],
  [t('Leise hören'), t('Bass und Höhen für kleine Pegel'), [[4, 100, 0.707], [0, 400, 1], [0, 3000, 1], [2.5, 10000, 0.707]]],
];

// ---------- Zustand lesen und schreiben ----------
function anWert(p, art) {
  if (istVstId(art)) return !!vstRack.finde(art)?.an;
  if (art === 'glow') return waermeWirksam(p.einst.waerme);
  if (art === 'iron') return trafoWirksam(p.einst.trafo);
  if (art === 'silk') return bandWirksam(p.einst.band);
  if (art === 'eq') return !!p.einst.eq.an;
  if (art === 'space') return p.einst.raumklang !== 'aus';
  return true;
}
const geraetObj = (p, art) => ({ glow: p.einst.waerme, iron: p.einst.trafo, silk: p.einst.band, eq: p.einst.eq })[art];
const fein = (p) => ({ ...FEIN_STANDARD, ...(p.einst.raumklang_fein || {}) });
const spaceAlgo = (p) => (p.einst.raumklang !== 'aus' ? p.einst.raumklang : (RAUMKLANG_PRESETS[p.einst.raumklang_letzt] ? p.einst.raumklang_letzt : 'raum'));
const spaceLayout = (p) => layoutFuer(p.raumklang.ctx ? p.raumklang.ctx.destination.maxChannelCount : ausgabeKanaele());

function knopfDef(p, art, key) {
  if (art === 'eq') { const [b, k] = key.split('_'); return eqKnoepfe(p.einst.eq.baender[+b], p.einst.eq.modus).find((d) => d.k === k); }
  return KNOEPFE[art].find((d) => d.k === key);
}
function knopfWert(p, art, key) {
  if (art === 'eq') { const [b, k] = key.split('_'); return p.einst.eq.baender[+b][k]; }
  if (art === 'space') return fein(p)[key];
  return geraetObj(p, art)[key];
}
function knopfSetzen(p, art, key, v) {
  if (art === 'glow') p.waermeSetzen({ ...p.einst.waerme, [key]: v });
  else if (art === 'iron') p.trafoSetzen({ ...p.einst.trafo, [key]: v });
  else if (art === 'silk') p.bandSetzen({ ...p.einst.band, [key]: v });
  else if (art === 'space') p.raumklangFeinSetzen({ [key]: v });
  else if (art === 'eq') {
    const eq = JSON.parse(JSON.stringify(p.einst.eq));
    const [b, k] = key.split('_');
    eq.baender[+b][k] = v;
    if (k === 'g' && Math.abs(v) >= 0.05) eq.an = true;
    p.eqSetzen(eq);
  }
}
const zuN = (d, v) => (d.log ? Math.log(v / d.min) / Math.log(d.max / d.min) : (v - d.min) / (d.max - d.min));
function vonN(d, n) {
  n = clamp(n, 0, 1);
  let v = d.log ? d.min * Math.pow(d.max / d.min, n) : d.min + n * (d.max - d.min);
  if (d.rund) v = d.rund(v);
  else if (d.step) v = Math.round(v / d.step) * d.step;
  return +clamp(v, d.min, d.max).toFixed(4);
}

// ---------- Presets ----------
function standardPresets(p, art) {
  if (art === 'glow') return Object.entries(WAERME_STUFEN).map(([k, s]) => ({ name: s.name, info: s.kurz, werte: () => waermeStufe(p.einst.waerme, k), passt: () => waermeStufeErkennen(p.einst.waerme) === k, anwenden: () => p.waermeSetzen({ ...waermeStufe(p.einst.waerme, k), an: true }) }));
  if (art === 'iron') return Object.entries(TRAFO_STUFEN).map(([k, s]) => ({ name: s.name, info: s.kurz, werte: () => trafoStufe(p.einst.trafo, k), passt: () => trafoStufeErkennen(p.einst.trafo) === k, anwenden: () => p.trafoSetzen({ ...trafoStufe(p.einst.trafo, k), an: true }) }));
  if (art === 'silk') return Object.entries(BAND_STUFEN).map(([k, s]) => ({ name: s.name, info: s.kurz, werte: () => bandStufe(p.einst.band, k), passt: () => bandStufeErkennen(p.einst.band) === k, anwenden: () => p.bandSetzen({ ...bandStufe(p.einst.band, k), an: true }) }));
  if (art === 'space') return Object.entries(RAUMKLANG_PRESETS).map(([k, x]) => ({ name: x.name, info: SPACE_KURZ[k] || '', werte: () => null, passt: () => spaceAlgo(p) === k, anwenden: () => spaceAlgoSetzen(p, k) }));
  if (art === 'eq') return EQ_PRESETS.map(([name, info, b]) => {
    const soll = () => EQ_STANDARD.baender.map((x, i) => ({ ...x, g: b[i][0], f: b[i][1], q: b[i][2] }));
    return { name, info, werte: () => ({ ...p.einst.eq, baender: soll() }),
      passt: () => gleich(p.einst.eq.baender.map((x) => pick(x, ['typ', 'g', 'f', 'q'])), soll().map((x) => pick(x, ['typ', 'g', 'f', 'q']))),
      anwenden: () => p.eqSetzen({ ...p.einst.eq, an: true, baender: soll() }) };
  });
  return [];
}
async function spaceAlgoSetzen(p, k) {
  if (spaceLayout(p)) { await p.raumklangSetzen(k); return; }
  p.einst.raumklang_letzt = k;
  p.einstSpeichern();
  api.put('/geraet/einstellungen', { einstellungen: { raumklang_letzt: k } }).catch(() => {});
  p.melden('zustand');
}
/** Was ein eigenes Preset dieses Geräts speichert */
function eigeneWerte(p, art) {
  if (PRESET_FELDER[art]) return pick(geraetObj(p, art), PRESET_FELDER[art]);
  if (art === 'eq') return { modus: p.einst.eq.modus, baender: p.einst.eq.baender.map((b) => pick(b, ['typ', 'an', 'f', 'g', 'q'])) };
  if (art === 'space') return { preset: spaceAlgo(p), ir: p.einst.raumklang_ir || 'auto', fein: pick(fein(p), FEIN_FELDER) };
  if (art === 'rack') return p.rackZustand();
  return {};
}
/** Passt ein eigenes Preset zum jetzigen Stand? */
function eigenesPasst(p, art, werte) {
  if (!werte) return false;
  if (art === 'glow') return gleich(pick(waermeNormal({ ...p.einst.waerme, ...werte }), PRESET_FELDER.glow), eigeneWerte(p, art));
  if (art === 'iron') return gleich(pick(trafoNormal({ ...p.einst.trafo, ...werte }), PRESET_FELDER.iron), eigeneWerte(p, art));
  if (art === 'silk') return gleich(pick(bandNormal({ ...p.einst.band, ...werte }), PRESET_FELDER.silk), eigeneWerte(p, art));
  if (art === 'eq') { const n = eqNormal({ ...p.einst.eq, modus: werte.modus || p.einst.eq.modus, baender: werte.baender }); return n.modus === p.einst.eq.modus && gleich(n.baender.map((b) => pick(b, ['typ', 'an', 'f', 'g', 'q'])), eigeneWerte(p, art).baender); }
  if (art === 'space') { const e = eigeneWerte(p, art); return e.preset === werte.preset && e.ir === werte.ir && gleich(pick({ ...FEIN_STANDARD, ...werte.fein }, FEIN_FELDER), e.fein); }
  if (art === 'rack') return gleich(rackVergleich(werte), rackVergleich(p.rackZustand()));
  return false;
}
async function eigenesAnwenden(p, art, werte) {
  if (art === 'glow') p.waermeSetzen({ ...p.einst.waerme, ...werte, an: true });
  else if (art === 'iron') p.trafoSetzen({ ...p.einst.trafo, ...werte, an: true });
  else if (art === 'silk') p.bandSetzen({ ...p.einst.band, ...werte, an: true });
  else if (art === 'eq') p.eqSetzen({ ...p.einst.eq, an: true, modus: werte.modus || p.einst.eq.modus, baender: werte.baender });
  else if (art === 'space') {
    if (werte.fein) p.raumklangFeinSetzen(werte.fein);
    if (werte.ir && werte.ir !== (p.einst.raumklang_ir || 'auto')) await p.raumklangIrSetzen(werte.ir);
    if (RAUMKLANG_PRESETS[werte.preset]) await spaceAlgoSetzen(p, werte.preset);
  } else if (art === 'rack') await p.rackAnwenden(werte);
}
/** Für den Vergleich ganzer Racks: normalisiert und ohne Nebensachen */
function rackVergleich(z) {
  return {
    reihe: reiheNormal(z.reihe), waerme: waermeNormal(z.waerme), trafo: trafoNormal(z.trafo), band: bandNormal(z.band),
    eq: (() => { const e = eqNormal(z.eq); return { an: e.an, b: e.baender.map((b) => pick(b, ['typ', 'an', 'f', 'g', 'q'])) }; })(),
    space: { preset: z.space?.preset || 'aus', ir: z.space?.ir || 'auto', fein: pick({ ...FEIN_STANDARD, ...(z.space?.fein || {}) }, FEIN_FELDER) },
  };
}
/** Ein gespeicherter Rack-Zustand, so verpackt, dass die Preset-Erkennung ihn wie den Player lesen kann */
function scheinPlayer(z) {
  return {
    einst: { waerme: waermeNormal(z.waerme), trafo: trafoNormal(z.trafo), band: bandNormal(z.band), eq: eqNormal(z.eq), reihe: reiheNormal(z.reihe),
      raumklang: z.space?.preset || 'aus', raumklang_letzt: z.space?.letzt, raumklang_ir: z.space?.ir || 'auto', raumklang_fein: z.space?.fein || {} },
    rackZustand: () => z,
  };
}

/** Mitgelieferte Gesamt-Presets: schalten Geräte an/aus und wählen Stufen, alles andere bleibt */
function rackStandard(p) {
  const basis = () => p.rackZustand();
  const mach = (glow, iron, silk) => () => {
    const z = basis();
    z.waerme = glow ? { ...waermeStufe(z.waerme, glow), an: true } : { ...z.waerme, an: false };
    z.trafo = iron ? { ...trafoStufe(z.trafo, iron), an: true } : { ...z.trafo, an: false };
    z.band = silk ? { ...bandStufe(z.band, silk), an: true } : { ...z.band, an: false };
    return z;
  };
  const liste = [
    [t('Rein'), t('alle Färbungen aus'), mach(null, null, null), (z) => { z.eq = { ...z.eq, an: false }; z.space = { ...z.space, preset: 'aus' }; return z; }],
    ['Warm', t('Glow Warm + Iron Satt'), mach('warm', 'satt', null)],
    ['Analog', t('Glow, Iron und Silk'), mach('warm', 'satt', 'fresh')],
    [t('Band'), t('nur Silk, eingespielt'), mach(null, null, 'worn')],
  ];
  return liste.map(([name, info, f, extra]) => {
    const werte = () => (extra ? extra(f()) : f());
    return { name, info, werte, passt: () => gleich(rackVergleich(werte()), rackVergleich(p.rackZustand())), anwenden: () => p.rackAnwenden(werte()) };
  });
}

// ---------- Bausteine (HTML) ----------
const BOGEN = 103.67; // 270° bei r = 22
function knopfSvg(d, v, farbe) {
  const n = clamp(zuN(d, v), 0, 1);
  let dash, start, rot;
  if (d.bip) { const b = (n - 0.5) * 2; dash = Math.abs(b) * BOGEN / 2; start = b >= 0 ? 270 : 270 - Math.abs(b) * 135; rot = b * 135; }
  else { dash = n * BOGEN; start = 135; rot = -135 + n * 270; }
  let raster = '';
  if (d.rast) {
    const stufen = Math.round((d.max - d.min) / d.step);
    for (let i = 0; i <= stufen; i++) {
      const w = (135 + 270 * i / stufen) * Math.PI / 180;
      raster += `M${(28 + 25.5 * Math.cos(w)).toFixed(2)} ${(28 + 25.5 * Math.sin(w)).toFixed(2)}L${(28 + 27.8 * Math.cos(w)).toFixed(2)} ${(28 + 27.8 * Math.sin(w)).toFixed(2)}`;
    }
  }
  return `<svg viewBox="0 0 56 56" aria-hidden="true">
<circle cx="28" cy="28" r="22" fill="none" stroke="rgba(255,236,214,.12)" stroke-width="4" stroke-linecap="round" stroke-dasharray="${BOGEN} 200" transform="rotate(135 28 28)"/>
<circle class="fx-bogen" cx="28" cy="28" r="22" fill="none" stroke="${farbe}" stroke-width="4" stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} 200" transform="rotate(${start.toFixed(1)} 28 28)"/>
${raster ? `<path d="${raster}" fill="none" stroke="rgba(255,236,214,.4)" stroke-width="1.2"/>` : ''}
<circle cx="28" cy="28" r="15" fill="#2a2019" stroke="rgba(255,236,214,.2)"/>
<line x1="28" y1="28" x2="28" y2="16" stroke="#f6efe7" stroke-width="2.5" stroke-linecap="round" transform="rotate(${rot.toFixed(1)} 28 28)"/></svg>`;
}
function knopfHtml(p, art, key, farbe, aus = false) {
  const d = knopfDef(p, art, key), v = knopfWert(p, art, key);
  return `<div class="fx-knopf${aus ? ' gesperrt' : ''}" data-knopf="${key}" data-art="${art}" role="slider" tabindex="0" aria-label="${h(d.n)}" aria-valuetext="${h(d.fmt(v))}" title="${aus ? (d.nurGegentakt ? t('nur im Gegentakt') : t('nur mit HQ')) : t('Ziehen: ändern · Doppelklick: zurück aufs Preset')}">${knopfSvg(d, v, farbe)}<span>${h(d.n)}</span><b>${h(d.fmt(v))}</b></div>`;
}

// Färbungsmeter: logarithmische Skala 0,01 … 10 % Klirr, ab 3 % rot
const VU_W = (pct) => clamp((Math.log10(Math.max(pct, 1e-4)) + 2) / 3, 0, 1);
const VU_PUNKT = (v, r) => { const a = (-50 + 100 * v) * Math.PI / 180; return [90 + r * Math.sin(a), 95 - r * Math.cos(a)]; };
const VU_SKALA = (() => {
  const [x0, y0] = VU_PUNKT(0, 70), [x1, y1] = VU_PUNKT(1, 70), [xr, yr] = VU_PUNKT(VU_W(3), 70);
  let ticks = '';
  for (let i = 0; i <= 12; i++) { const v = i / 12, gr = i % 4 === 0; const [a, b] = VU_PUNKT(v, 70), [c, d] = VU_PUNKT(v, gr ? 78 : 74); ticks += `M${a.toFixed(1)} ${b.toFixed(1)}L${c.toFixed(1)} ${d.toFixed(1)}`; }
  const lab = [[0, zahl(0.01)], [1 / 3, zahl(0.1)], [2 / 3, '1'], [1, '10 %']].map(([v, tx]) => { const [x, y] = VU_PUNKT(v, 86); return `<text x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="middle" font-size="9.5" fill="${v === 1 ? '#c4372d' : '#3b2a1c'}">${tx}</text>`; }).join('');
  return `<path d="M${x0.toFixed(1)} ${y0.toFixed(1)}A70 70 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}" fill="none" stroke="#3b2a1c" stroke-width="2"/>
<path d="M${xr.toFixed(1)} ${yr.toFixed(1)}A70 70 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}" fill="none" stroke="#c4372d" stroke-width="5"/>
<path d="${ticks}" stroke="#3b2a1c" stroke-width="1.4"/>${lab}`;
})();
const vuHtml = (kanal) => `<div class="fx-vu"><div class="fx-vu-skala"><svg viewBox="0 0 180 100" role="img" aria-label="${t('Färbung {kanal}', { kanal })}">
${VU_SKALA}<text x="90" y="62" text-anchor="middle" font-size="8.5" font-weight="700" letter-spacing="1.2" fill="#6b5640">THD</text><text x="90" y="80" text-anchor="middle" font-size="15" font-weight="700" fill="#3b2a1c">${kanal}</text>
<line class="fx-nadel" x1="90" y1="95" x2="90" y2="27" stroke="#1d1208" stroke-width="2" stroke-linecap="round" transform="rotate(-50 90 95)"/>
<circle cx="90" cy="95" r="7" fill="#1d1208"/></svg></div></div>`;
// Gerätebilder fürs große Rack: Röhre (glüht mit der Färbung), Übertragerkern (Fluss), Bandspulen (drehen mit der Bandgeschwindigkeit)
const ROEHRE = `<div class="fx-roehre"><span class="fx-glut-wand"></span>
<svg width="92" height="112" viewBox="0 0 92 112" role="img" aria-label="${t('Röhre, glüht je nach Färbung')}">
<defs><radialGradient id="fxGlut" cx="50%" cy="58%" r="55%"><stop offset="0%" stop-color="#ffd27a"/><stop offset="40%" stop-color="#ff8a3d" stop-opacity=".7"/><stop offset="100%" stop-color="#ff7a3d" stop-opacity="0"/></radialGradient></defs>
<rect x="24" y="4" width="44" height="86" rx="22" fill="rgba(255,244,230,.06)" stroke="rgba(255,236,214,.35)" stroke-width="1.2"/>
<path d="M32 10 Q30 40 33 80" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="2" stroke-linecap="round"/>
<ellipse class="fx-glut-kern" cx="46" cy="54" rx="24" ry="30" fill="url(#fxGlut)" opacity=".15"/>
<rect x="35" y="32" width="22" height="40" rx="3" fill="none" stroke="rgba(255,236,214,.5)" stroke-width="1.2"/>
<path class="fx-glut-faden" d="M40 38 v28 M46 38 v28 M52 38 v28" stroke="#ffd690" stroke-width="1.6" stroke-linecap="round" opacity=".4"/>
<rect x="28" y="90" width="36" height="12" rx="3" fill="#2a2018" stroke="rgba(255,236,214,.25)"/>
<path d="M34 102 v6 M42 102 v6 M50 102 v6 M58 102 v6" stroke="rgba(255,236,214,.35)" stroke-width="2" stroke-linecap="round"/></svg></div>`;
const KERN = `<svg width="124" height="106" viewBox="0 0 124 106" role="img" aria-label="${t('Übertragerkern mit Wicklung')}">
<rect x="8" y="8" width="108" height="90" rx="4" fill="#2f2c29" stroke="rgba(230,226,220,.35)"/>
<path d="M16 16 h92 M16 22 h92 M16 84 h92 M16 90 h92" stroke="rgba(230,226,220,.12)"/>
<rect class="fx-fluss" x="8" y="8" width="108" height="90" rx="4" fill="#ffb547" opacity=".03" style="mix-blend-mode:screen"/>
<rect x="28" y="28" width="68" height="50" rx="2" fill="#0d0a08"/>
<rect x="46" y="18" width="32" height="70" rx="6" fill="#8a4b22" stroke="#c07a3e"/>
<path d="M46 27 h32 M46 36 h32 M46 45 h32 M46 54 h32 M46 63 h32 M46 72 h32 M46 81 h32" stroke="#c07a3e" stroke-width="1.4"/></svg>`;
/** Spulen: Umlaufzeit = Umfang / Bandgeschwindigkeit (10,5″-Spule: voll ≈ 13 cm, leer ≈ 8,5 cm Radius) */
function spulenHtml(ips) {
  const v = ips * 2.54, l = (2 * Math.PI * 13 / v).toFixed(2), r = (2 * Math.PI * 8.5 / v).toFixed(2), b = (0.6 / (v / 38.1)).toFixed(2);
  const spule = (cx, dauer) => `<g class="fx-spule" style="transform-origin:${cx}px 46px;animation-duration:${dauer}s"><path d="M${cx} 31 v-8 M${cx - 13} 54 l-7 4 M${cx + 13} 54 l7 4" stroke="#cfc4b6" stroke-width="4" stroke-linecap="round"/><circle cx="${cx}" cy="38" r="2.4" fill="#6d6257"/><circle cx="${cx - 7}" cy="50" r="2.4" fill="#6d6257"/><circle cx="${cx + 7}" cy="50" r="2.4" fill="#6d6257"/></g>`;
  return `<svg width="206" height="102" viewBox="0 0 210 104" role="img" aria-label="${t('Bandspulen, {ips} ips', { ips: zahl(ips) })}">
<circle cx="52" cy="46" r="40" fill="#3b2b20"/><circle cx="52" cy="46" r="40" fill="none" stroke="rgba(255,236,214,.25)"/><circle cx="52" cy="46" r="15" fill="#cfc4b6"/>${spule(52, l)}<circle cx="52" cy="46" r="5" fill="#0d0a08"/>
<circle cx="158" cy="46" r="40" fill="none" stroke="rgba(255,236,214,.25)"/><circle cx="158" cy="46" r="26" fill="#3b2b20"/><circle cx="158" cy="46" r="15" fill="#cfc4b6"/>${spule(158, r)}<circle cx="158" cy="46" r="5" fill="#0d0a08"/>
<path d="M26 78 Q52 100 105 96 Q150 100 182 66" fill="none" stroke="#5a4130" stroke-width="2"/>
<path class="fx-bandlauf" d="M26 78 Q52 100 105 96 Q150 100 182 66" fill="none" stroke="#8a6748" stroke-width="2" stroke-dasharray="3 7" style="animation-duration:${b}s"/>
<rect x="94" y="90" width="22" height="11" rx="2" fill="#8c8278"/></svg>`;
}
const vusHtml = (bild = '') => `<div class="fx-fenster fx-vus" title="${t('Färbung: wie viel Klirr das Gerät gerade erzeugt (gemessen im Audio-Thread, je Kanal)')}">${bild ? `<div class="fx-bild">${bild}</div><span class="fx-trenner"></span>` : ''}${vuHtml('L')}${vuHtml('R')}</div>`;

/** Ein Pegelblock (L/R-Balken + Skala) für Plug-in-Module: links EIN, rechts AUS – spart Höhe */
const vstBlock = (titel) => `<div class="fx-balken"><div class="fx-vst-grp">${titel}</div>${['L', 'R'].map((k) => `<div class="fx-zeile"><span>${k}</span><span class="fx-bahn"><i></i></span><i class="fx-clip" title="${t('Übersteuerung (0 dBFS erreicht)')}"></i></div>`).join('')}<div class="fx-zeile fx-skala" aria-hidden="true"><span></span><span class="fx-skala-bahn">${[-48, -36, -24, -12, -6, 0].map((d) => `<span style="left:${((d + 60) / 60 * 100).toFixed(1)}%">${d ? `−${-d}` : '0'}</span>`).join('')}</span><i class="fx-clip-platz"></i></div></div>`;

function digitalHtml(art, kanaele, werte, gruppen = {}) {
  return `<div class="fx-fenster fx-digital"><div class="fx-balken">${kanaele.map((k, i) => `${gruppen[i] ? `<div class="fx-vst-grp">${gruppen[i]}</div>` : ''}<div class="fx-zeile"><span>${k}</span><span class="fx-bahn"><i></i></span><i class="fx-clip" title="${t('Übersteuerung (0 dBFS erreicht)')}"></i></div>`).join('')}<div class="fx-zeile fx-skala" aria-hidden="true"><span></span><span class="fx-skala-bahn">${[-48, -36, -24, -12, -6, 0].map((d) => `<span style="left:${((d + 60) / 60 * 100).toFixed(1)}%">${d ? `−${-d}` : '0 dB'}</span>`).join('')}</span><i class="fx-clip-platz"></i></div></div>
    <div class="fx-werte">${werte.map(([k, kl, e, farbe]) => `<div><em>${k}</em><b${farbe ? ` style="color:${farbe}"` : ''}><span data-wert="${kl}">–</span><small>${e}</small></b></div>`).join('')}</div></div>`;
}

// ---------- Rack-Ansicht ----------
let offen = null; // die eine offene Ansicht

export class RackAnsicht {
  /** modus: 'einzel' (ein Gerät als Flyout an der Leiste, am Handy als Blatt), 'karten' (Vollbild Handy/Tablet) oder 'breit' (Vollbild PC) */
  constructor(rack, modus, anker = null, art = null) {
    this.rack = rack;
    this.p = rack.player;
    this.modus = modus;
    this.anker = anker;
    if (modus === 'breit' || modus === 'karten') titelFarbe('#110c09', 'rack'); // Vollbild: Titelleiste passend zum Rack
    this.offen = art && art !== 'eingang' && art !== 'ausgang' ? art : (modus === 'breit' ? null : rack.zuletzt || 'glow');
    this.art = art;
    this.eqBand = 0;
    this.zug = null;
    this.raf = 0;
    this.glatt = {};
    this.nadel = {};
    this.el = document.createElement('div');
    this.el.className = `fx fx-${modus}${modus === 'einzel' && schmal() ? ' blatt' : ''}`;
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', t('Effektrack'));
    document.body.appendChild(this.el);
    this.zeichnen();
    this.verbinden();
    this.nachfuehren = () => { if (!this.zug) this.aktualisieren(); };
    this.p.addEventListener('zustand', this.nachfuehren);
    this.p.raumklang.messenSetzen(true);
    this.schleife = this.schleife.bind(this);
    this.raf = requestAnimationFrame(this.schleife);
    if (modus === 'einzel') this.positionieren();
    irListe().then((l) => { this.irs = l; if (this.el.isConnected && this.el.querySelector('.fx-mod[data-art="space"]')) this.karteNeu('space'); });
  }

  get breit() { return this.modus === 'breit'; }
  get einzel() { return this.modus === 'einzel'; }
  reihenfolge() { return ['eingang', ...this.p.einst.reihe, 'space', 'ausgang']; }

  // ---------- Zeichnen ----------
  zeichnen() {
    const p = this.p;
    if (this.einzel) {
      this.el.setAttribute('aria-label', geraet(this.art).name);
      this.el.innerHTML = `<div class="fx-einzel-kopf"><button type="button" class="fx-link" data-fx="vollbild" title="${t('Alle Geräte im Effektrack')}">${icon('raster', 15)}<span>${t('Effektrack')}</span>${icon('rechts', 14)}</button>
        <button type="button" class="fx-rund klein" data-fx="zu" aria-label="${t('Schließen')}">${icon('zu', 16)}</button></div>
        <div class="fx-rack" data-rack>${this.karteHtml(this.art, this.reihenfolge().indexOf(this.art))}</div>`;
      this.staffeln(this.el);
      this.aktualisieren();
      return;
    }
    const zurueck = this.modus === 'flyout'
      ? `<button type="button" class="fx-rund" data-fx="vollbild" aria-label="${t('Großes Rack öffnen')}" title="${t('Großes Rack')}">${icon('raster', 18)}</button>`
      : `<button type="button" class="fx-rund" data-fx="zu" aria-label="${t('Zurück')}">${icon('zurueckPfeil', 20)}</button>`;
    this.el.innerHTML = `
      <header class="fx-kopfzeile">
        <div class="fx-kopf-reihe">
          ${zurueck}
          <div class="fx-titel"><h2>${t('Effektrack')}</h2>
            <button type="button" class="fx-gesamt" data-fx="gesamt" aria-haspopup="dialog" title="${t('Gesamt-Preset: Reihenfolge, an/aus und alle Werte')}">${this.breit ? `<em>${t('GESAMT')}</em>` : ''}<b data-gesamt-name></b>${icon('runter', 13)}</button></div>
          <button type="button" class="fx-bypass" data-fx="bypass" aria-pressed="${!!p.bypass}" title="${t('Alle Effekte umgehen (zum Vergleichen, wird nicht gemerkt)')}">BYPASS</button>
          <div class="fx-ab" role="group" aria-label="${t('Vergleich A/B')}" title="${t('A/B: zwei Stände vergleichen, z. B. zwei Presets – B ist anfangs eine Kopie von A, dann in B ein anderes Preset wählen und hin und her schalten')}">
            <button type="button" data-fx="ab" data-v="A" aria-pressed="${this.rack.ab.aktiv === 'A'}">A</button><button type="button" data-fx="ab" data-v="B" aria-pressed="${this.rack.ab.aktiv === 'B'}">B</button></div>
          ${this.modus === 'flyout' ? `<button type="button" class="fx-rund klein" data-fx="zu" aria-label="${t('Schließen')}">${icon('zu', 16)}</button>` : ''}
        </div>
        <div class="fx-kette" data-kette aria-label="${t('Signalweg')}"></div>
        <div class="fx-abzeile" data-abzeile hidden></div>
      </header>
      <div class="fx-rack" data-rack>${this.reihenfolge().map((art, i) => this.karteHtml(art, i)).join('')}${vstRack.verfuegbar ? `<div class="fx-vst-neu"><button type="button" class="fx-feld" data-fx="vst-neu" aria-haspopup="dialog">${icon('plus', 15)}<span>${t('VST3-Plug-in hinzufügen')}</span></button></div>` : ''}</div>
      ${this.breit ? `<p class="fx-hinweis">${t('Regler ziehen (Shift: fein) · Doppelklick: zurück aufs Preset · Glow, Iron, Silk und EQ am Griff verschieben – die Reihenfolge ist der Signalweg')}</p>` : ''}
      ${this.breit ? '' : `<footer class="fx-fuss"><div class="fx-fuss-pegel"><span><span>${t('Ausgang')}</span><b data-fuss-lufs>–</b></span><span class="fx-bahn"><i data-fuss-bahn></i></span></div></footer>`}`;
    this.staffeln(this.el);
    this.aktualisieren();
  }

  karteHtml(art, i) {
    const p = this.p, g = geraet(art);
    const an = anWert(p, art);
    const space = art === 'space';
    const gesperrt = space && !spaceLayout(p);
    const offen = this.breit || this.einzel || this.offen === art;
    const griff = g.fest
      ? `<span class="fx-schloss" title="${t('feste Position')}" aria-label="${t('feste Position')}">${'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>'}</span>`
      : `<span class="fx-griff" data-griff title="${t('Ziehen, um die Reihenfolge zu ändern')}" aria-label="${t('Verschieben')}"><i>${'<b></b>'.repeat(6)}</i></span>`;
    const netz = g.netz ? `<button type="button" class="fx-netz" data-fx="netz" aria-pressed="${an}" aria-label="${an ? t('{name} ausschalten', { name: g.name }) : t('{name} einschalten', { name: g.name })}" title="${gesperrt ? t('AmberSpace braucht einen 5.1- oder Quadro-Ausgang') : t('{name} ein/aus', { name: g.name })}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-width="2.6" stroke-linecap="round"><path d="M12 3v8"/><path d="M6.4 6.6a8 8 0 1 0 11.2 0"/></svg></button>` : '';
    return `<section class="fx-mod${offen ? ' offen' : ''}${g.netz && !an ? ' ist-aus' : ''}${gesperrt ? ' gesperrt' : ''}" data-art="${art}" style="--farbe:${g.farbe}" aria-label="${g.name}">
      <span class="fx-ohr" aria-hidden="true"><i></i><i></i></span>
      <div class="fx-front">
        <div class="fx-kopf" data-fx="auf" ${this.breit ? '' : `role="button" aria-expanded="${offen}"`}>
          ${griff}<span class="fx-nr">${String(i + 1).padStart(2, '0')}${this.breit ? ` · ${g.rolle}` : ''}</span>
          <span class="fx-name"><b>${g.name}</b><small data-kurz></small></span>
          ${netz}${istVstId(art) ? `<button type="button" class="fx-vst-weg" data-fx="vst-weg" title="${t('Plug-in aus dem Rack entfernen')}" aria-label="${t('Plug-in entfernen')}">${icon('zu', 14)}</button>` : ''}${this.breit ? '' : `<svg class="fx-pfeil" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>`}
        </div>
        <div class="fx-koerper"><div class="fx-innen"><div class="fx-inhalt">${this.inhaltHtml(art)}</div></div></div>
      </div>
      <span class="fx-ohr" aria-hidden="true"><i></i><i></i></span>
    </section>`;
  }

  leisteHtml(art, extra = '') {
    const g = geraet(art), o = geraetObj(this.p, art);
    return `<div class="fx-leiste"><button type="button" class="fx-feld fx-preset" data-fx="preset" aria-haspopup="dialog"><span data-preset-name></span>${icon('runter', 14)}</button>
      ${g.hq ? `<button type="button" class="fx-hq" data-fx="hq" aria-pressed="${!!o.hq}" title="High Quality: ${g.hqText}">HQ</button>` : ''}${g.hq ? `<button type="button" class="fx-hq fx-delta" data-fx="delta" aria-pressed="${this.p.raumklang.deltaArt === art}" title="${t('Delta: nur hören, was {name} am Klang verändert (immer nur ein Gerät, wird nicht gemerkt)', { name: g.name })}">Δ</button>` : ''}${extra}
      <div class="fx-gab" role="group" aria-label="A/B ${g.name}" title="${t('A/B nur für {name}: B ist anfangs eine Kopie, dann ein anderes Preset wählen und umschalten', { name: g.name })}">${['A', 'B'].map((v) => `<button type="button" data-fx="gab" data-v="${v}" aria-pressed="${this.rack.abG(art).aktiv === v}" class="${this.rack.abG(art)[v] ? 'voll' : ''}">${v}</button>`).join('')}</div></div>`;
  }

  reglerHtml(art) {
    const p = this.p, hq = geraetObj(p, art)?.hq;
    const o = geraetObj(p, art);
    return `<div class="fx-regler">${KNOEPFE[art].map((d) => knopfHtml(p, art, d.k, '#ffb547', (d.nurHq && !hq) || (d.nurGegentakt && o.schaltung !== 'gegentakt'))).join('')}</div>`;
  }

  optionenHtml(art) {
    const p = this.p, o = geraetObj(p, art);
    const opt = (OPTIONEN[art] || []).map((x) => `<div class="fx-opt"><em>${x.n}</em><button type="button" class="fx-feld" data-fx="opt" data-opt="${x.k}" aria-haspopup="dialog"><span>${h(x.werte.find((w) => w.w === o[x.k])?.t || '–')}</span>${icon('runter', 14)}</button></div>`).join('');
    const sw = (SCHALTER[art] || []).map((s) => `<button type="button" data-fx="sw" data-sw="${s.k}" aria-pressed="${!!o[s.k]}" ${s.nurHq && !o.hq ? `disabled title="${t('nur mit HQ')}"` : ''}><i></i>${s.t}</button>`).join('');
    if (!opt && !sw) return '';
    return `<div class="fx-optbox">${opt ? `<div class="fx-optionen">${opt}</div>` : ''}${sw ? `<div class="fx-schalter">${sw}</div>` : ''}</div>`;
  }

  inhaltHtml(art) {
    const p = this.p;
    if (art === 'eingang') return digitalHtml(art, ['L', 'R'], [[t('TITEL'), 'lufs', 'LUFS'], ['TRUE PEAK', 'tp', 'dBTP'], [t('ANGLEICH'), 'gain', 'dB', 'var(--accent-text)']]);
    if (art === 'ausgang') {
      const l = p.raumklang.aktiv ? p.raumklang.layout : null;
      const k = l && l.kanaele === 6 ? ['L', 'R', 'C', 'LFE', 'LS', 'RS'] : l && l.kanaele === 4 ? ['L', 'R', 'LS', 'RS'] : ['L', 'R'];
      return digitalHtml(art, k, [[t('LAUTHEIT'), 'lufsm', 'LUFS'], [t('SPITZE'), 'spitze', 'dBFS'], [t('ZIEL'), 'ziel', 'LUFS']]);
    }
    if (art === 'glow') return `${this.leisteHtml(art)}${vusHtml(this.breit ? ROEHRE : '')}${this.optionenHtml(art)}${this.reglerHtml(art)}`;
    if (art === 'iron' || art === 'silk') return `${this.leisteHtml(art)}${vusHtml(this.breit ? (art === 'iron' ? KERN : spulenHtml(p.einst.band.ips)) : '')}${this.optionenHtml(art)}${this.reglerHtml(art)}`;
    if (art === 'space') {
      const l = spaceLayout(p);
      const hinweis = l ? '' : `<p class="fx-sperre">${t('Dieses Gerät gibt nur Stereo aus – AmberSpace wirkt an einem 5.1- oder Quadro-Ausgang. Einstellen geht trotzdem.')}</p>`;
      return `${this.leisteHtml(art, `<button type="button" class="fx-hq" data-fx="mehr" title="${t('Center, LFE-Pegel, eigene Impulsantworten, Abhören')}">${t('Mehr')}</button>`)}${hinweis}<div class="fx-fenster fx-raumwahl">${this.raumHtml()}</div>${this.reglerHtml(art)}`;
    }
    if (art === 'eq') return this.eqHtml();
    if (istVstId(art)) return this.vstHtml(art);
    return '';
  }

  /** VST3-Plug-in: 1 HE mit digitalen Pegelanzeigen für Eingang und Ausgang, Oberfläche öffnen, Presets */
  vstHtml(art) {
    const v = vstRack.finde(art);
    return `<div class="fx-fenster fx-digital fx-vst-meter">${vstBlock(t('EIN'))}<span class="fx-trenner"></span>${vstBlock(t('AUS'))}</div>
      <div class="fx-leiste fx-vst-leiste">
        <button type="button" class="fx-feld fx-vst-oeffnen" data-fx="vst-editor" aria-pressed="${!!v?.editorAuf}" ${v && v.status === 'bereit' && v.editor !== false ? '' : 'disabled'}>${icon('raster', 15)}<span data-vst-editor-text>${v?.editorAuf ? t('Oberfläche schließen') : t('Oberfläche öffnen')}</span></button>
        <button type="button" class="fx-feld fx-preset" data-fx="vst-preset" aria-haspopup="dialog" ${v && v.status === 'bereit' ? '' : 'disabled'}><span data-vst-preset-name>${h(v?.preset || t('Zustand'))}</span>${icon('runter', 14)}</button>
        <button type="button" class="fx-hq" data-fx="vst-neustart" title="${t('Plug-in neu starten')}" hidden>↻</button>
      </div>
      <p class="fx-vst-status" data-vst-status></p>`;
  }

  irName() {
    const p = this.p, irs = this.irs || [], wahl = p.einst.raumklang_ir || 'auto';
    if (wahl === 'auto') { const a = irs.length ? irWaehlen(irs, spaceAlgo(p), 'auto') : null; return a ? t('Automatisch – {name}', { name: a.name }) : t('Automatisch'); }
    if (wahl === 'synth') return t('Eingebaut (synthetisch)');
    return irs.find((x) => x.id === wahl)?.name || t('eigene Impulsantwort');
  }

  /** Impulsantworten: oben Automatisch/Eingebaut, darunter je Art ein Untermenü, „Eigene“ (falls vorhanden) und Hochladen */
  irMenue(anker) {
    const p = this.p, irs = this.irs || [], wahl = p.einst.raumklang_ir || 'auto';
    const auto = irs.length ? irWaehlen(irs, spaceAlgo(p), 'auto') : null;
    const waehlen = (w) => async () => { await p.raumklangIrSetzen(w); this.karteNeu('space'); };
    const pt = (x) => ({ t: x.name, info: [x.klasse, x.nachhall_s ? `${zahl(x.nachhall_s)} s` : ''].filter(Boolean).join(' · '), an: wahl === x.id, aktion: waehlen(x.id) });
    const sortiert = [...irs].sort((a2, b2) => (a2.nachhall_s || 0) - (b2.nachhall_s || 0));
    const eigene = sortiert.filter((x) => x.quelle === 'eigene');
    const nachArt = {};
    for (const x of sortiert) if (x.quelle !== 'eigene') (nachArt[x.art_name || 'Sonstige'] ||= []).push(x);
    const REIHE = ['Kammer', 'Raum', 'Halle', 'Kirche', 'Plate/Feder', 'Sonstige'];
    const arten = Object.entries(nachArt).sort((x, y) => (REIHE.indexOf(x[0]) + 99) % 99 - (REIHE.indexOf(y[0]) + 99) % 99);
    const unter = (name, xs) => ({ t: name === 'Eigene' ? (sprache === 'en' ? 'Custom' : name) : t(name), info: xs.some((x) => x.id === wahl) ? `✓ ${xs.find((x) => x.id === wahl).name}` : `${xs.length}`, unter: { titel: name === 'Eigene' ? (sprache === 'en' ? 'Custom' : name) : t(name), gruppen: [{ punkte: xs.map(pt) }] } });
    const gruppen = [
      { punkte: [{ t: t('Automatisch'), info: auto ? auto.name : t('passend zum Raum'), an: wahl === 'auto', aktion: waehlen('auto') }, { t: t('Eingebaut (synthetisch)'), an: wahl === 'synth', aktion: waehlen('synth') }] },
      { titel: t('ECHTE RÄUME'), punkte: arten.map(([name, xs]) => unter(name, xs)) },
    ];
    if (eigene.length) gruppen.push({ titel: t('EIGENE'), punkte: [unter('Eigene', eigene)] });
    this.rack.auswahl(anker, t('AmberSpace · Impulsantwort'), gruppen, [{ t: t('Eigene Impulsantwort hochladen …'), icon: 'download', aktion: () => this.irHochladen() }]);
  }

  /** Eigene Impulsantwort (WAV) hochladen – die Art erkennt der Server; danach gleich auswählen */
  irHochladen() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.wav,audio/wav,audio/x-wav';
    inp.addEventListener('change', async () => {
      const f = inp.files[0];
      if (!f) return;
      const fd = new FormData();
      fd.append('ir', f);
      toast(t('Impulsantwort wird hochgeladen …'));
      try {
        const r = await api.post('/raumklang/ir', fd);
        this.irs = await irListe(true);
        await this.p.raumklangIrSetzen(r.id);
        this.karteNeu('space');
        toast(t('„{name}“ hochgeladen und ausgewählt', { name: r.name || f.name }));
      } catch (e) { toast(e.message || t('Hochladen fehlgeschlagen'), 'fehler'); }
    });
    inp.click();
  }

  /** AmberSpace vorn: Raum (Verfahren) und Stärke als Tasten, die Impulsantwort als Auswahlfeld */
  raumHtml() {
    const p = this.p, algo = spaceAlgo(p), st = staerkeErkennen(fein(p));
    const seg = (titel, was, liste, an) => `<div class="fx-seg-gr"><em>${titel}</em><div class="fx-seg" role="radiogroup" aria-label="${titel}">${liste.map(([k, tx, info]) => `<button type="button" role="radio" data-fx="${was}" data-k="${k}" aria-checked="${an === k}" title="${h(info || '')}">${h(tx)}</button>`).join('')}</div></div>`;
    return `${seg(t('RAUM'), 'algo', Object.entries(RAUMKLANG_PRESETS).map(([k, x]) => [k, x.name, x.info]), algo)}
      ${seg(t('STÄRKE'), 'staerke', [['klein', t('Subtil'), t('die Bühne bleibt vorne, nur etwas Raum')], ['mittel', t('Weit'), t('spürbarer Raum')], ['gross', t('Intensiv'), t('Raum und Effekte rundherum')]], st)}
      <div class="fx-opt"><em>${t('IMPULSANTWORT')}</em><button type="button" class="fx-feld" data-fx="irwahl" aria-haspopup="dialog"><span>${h(this.irName())}</span>${icon('runter', 14)}</button></div>`;
  }

  eqHtml() {
    const p = this.p, eq = p.einst.eq;
    const typHtml = (i) => {
      const b = eq.baender[i];
      if (BAND_TYPEN[i].length < 2) return '';
      const ic = { peaking: 'M1 8C5 8 6 2 8 2S11 8 15 8', lowshelf: 'M1 2C5 2 6 8 9 8L15 8', highshelf: 'M1 8L7 8C10 8 11 2 15 2' };
      return `<div class="fx-typ" role="radiogroup" aria-label="${t('Filtertyp {band}', { band: EQ_LANG[i] })}" style="--bandfarbe:${EQ_FARBEN[i]}">${BAND_TYPEN[i].map((typ) => `<button type="button" role="radio" data-fx="typ" data-b="${i}" data-t="${typ}" aria-checked="${b.typ === typ}" title="${typ === 'peaking' ? t('Glocke') : typ === 'lowshelf' ? 'Low-Shelf' : 'High-Shelf'}"><svg width="18" height="11" viewBox="0 0 16 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="${ic[typ]}"/></svg>${typ === 'peaking' ? 'BELL' : 'SHELF'}</button>`).join('')}</div>`;
    };
    const knoepfe = (i) => `<div class="fx-regler fx-eq-knoepfe">${eqKnoepfe(eq.baender[i], eq.modus).map((d) => knopfHtml(p, 'eq', `${i}_${d.k}`, EQ_FARBEN[i])).join('')}</div>`;
    // Modus: präzise (je Band ein Filter in Reihe) oder passiv (Netzwerk wie ein passiver Mastering-EQ)
    const modus = `<div class="fx-typ fx-modus" role="radiogroup" aria-label="${t('EQ-Modus')}" title="${t('Digital: jedes Band genau so, wie eingestellt. Analog: die Bänder liegen parallel wie in einem passiven Mastering-EQ – sie addieren sich sanft, breite Glocken heben weniger an, Shelves haben einen kleinen Überschwinger')}">${Object.entries(EQ_MODI).map(([k, tx]) => `<button type="button" role="radio" data-fx="eqmodus" data-m="${k}" aria-checked="${eq.modus === k}">${tx.toUpperCase()}</button>`).join('')}</div>`;
    const analyzer = `<div class="fx-fenster fx-analyzer" data-analyzer><svg viewBox="0 0 440 160" preserveAspectRatio="none" aria-hidden="true">
      ${[50, 100, 200, 500, 1000, 2000, 5000, 10000].map((f) => { const x = (440 * Math.log10(f / 20) / 3).toFixed(1); return `<line x1="${x}" y1="0" x2="${x}" y2="160" stroke="rgba(200,215,240,${[100, 1000, 10000].includes(f) ? '.16' : '.07'})" vector-effect="non-scaling-stroke"/>`; }).join('')}
      <line x1="0" y1="80" x2="440" y2="80" stroke="rgba(200,215,240,.14)" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>
      <path class="fx-sp-vor" fill="rgba(200,215,240,.13)" stroke="rgba(200,215,240,.35)" stroke-width="1" vector-effect="non-scaling-stroke"/>
      <path class="fx-sp-nach" fill="none" stroke="#ffb547" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      <path class="fx-eq-kurve" fill="none" stroke="#f6efe7" stroke-width="2.2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>
      ${eq.baender.map((b, i) => `<span class="fx-pkt${i === this.eqBand ? ' gew' : ''}" data-pkt="${i}" style="background:${EQ_FARBEN[i]}" title="${t('{band}: ziehen = Frequenz/Gain, Mausrad = Güte, Doppelklick = 0 dB', { band: EQ_LANG[i] })}"></span>`).join('')}
      ${[[100, '100'], [1000, '1k'], [10000, '10k']].map(([f, tx]) => `<span class="fx-mk" style="left:${(100 * Math.log10(f / 20) / 3).toFixed(2)}%">${tx}</span>`).join('')}
      <div class="fx-legende"><span><i style="width:12px;height:6px;border-radius:1px;background:rgba(200,215,240,.35)"></i>${t('vor dem EQ')}</span><span><i style="width:12px;height:2px;background:#ffb547"></i>${t('danach')}</span></div></div>`;
    if (this.breit) {
      const streifen = (i) => `<div class="fx-eq-streifen"><div class="fx-eq-skopf"><span><i style="background:${EQ_FARBEN[i]}"></i>${EQ_LANG[i]}</span>${typHtml(i)}</div>${knoepfe(i)}</div>`;
      return `${this.leisteHtml('eq', modus)}<div class="fx-eq-breit"><div class="fx-eq-seite">${streifen(0)}${streifen(1)}</div>${analyzer}<div class="fx-eq-seite">${streifen(2)}${streifen(3)}</div></div>`;
    }
    const i = this.eqBand;
    return `${this.leisteHtml('eq', modus)}${analyzer}
      <div class="fx-baender" role="radiogroup" aria-label="${t('EQ-Band')}">${eq.baender.map((b, k) => `<button type="button" role="radio" data-fx="band" data-b="${k}" aria-checked="${k === i}"><i style="background:${EQ_FARBEN[k]}"></i>${EQ_KURZ[k]}</button>`).join('')}</div>
      ${typHtml(i)}${knoepfe(i)}`;
  }

  staffeln(root) {
    root.querySelectorAll('.fx-inhalt').forEach((k) => Array.from(k.children).forEach((c, i) => c.style.setProperty('--i', i)));
  }

  /** Eine Karte neu bauen (Struktur geändert: Band, Typ, Optionen, IR-Liste …) */
  karteNeu(art) {
    const alt = this.el.querySelector(`.fx-mod[data-art="${art}"]`);
    if (!alt) return;
    const i = this.reihenfolge().indexOf(art);
    const tmp = document.createElement('div');
    tmp.innerHTML = this.karteHtml(art, i);
    this.staffeln(tmp);
    const neu = tmp.firstElementChild;
    // offene Karte ohne erneutes Einblenden ersetzen
    neu.classList.add('ohne-uebergang');
    alt.replaceWith(neu);
    requestAnimationFrame(() => neu.classList.remove('ohne-uebergang'));
    this.aktualisieren();
  }

  /** Texte, Schalter, Regler und Kette auf den aktuellen Stand bringen (ohne neu zu bauen) */
  aktualisieren() {
    const p = this.p;
    // VST3-Slots hinzugekommen/weg: Rack neu aufbauen
    if (!this.einzel) {
      const soll = this.reihenfolge().join(), ist = [...this.el.querySelectorAll('.fx-mod')].map((x) => x.dataset.art).join();
      if (soll !== ist) { this.zeichnen(); return; }
    }
    for (const sec of this.el.querySelectorAll('.fx-mod')) {
      if (istVstId(sec.dataset.art)) this.vstZeigen(sec);
      const art = sec.dataset.art, g = geraet(art), an = anWert(p, art);
      sec.classList.toggle('ist-aus', !!g.netz && (!an || !!p.bypass));
      const netz = sec.querySelector('.fx-netz');
      if (netz) { netz.setAttribute('aria-pressed', String(an)); netz.setAttribute('aria-label', an ? t('{name} ausschalten', { name: g.name }) : t('{name} einschalten', { name: g.name })); }
      const kurz = sec.querySelector('[data-kurz]');
      if (kurz) kurz.textContent = this.kurztext(art);
      const pn = sec.querySelector('[data-preset-name]');
      if (pn) pn.textContent = this.rack.presetName(art);
      sec.querySelector('[data-fx="delta"]')?.setAttribute('aria-pressed', String(p.raumklang.deltaArt === art));
      sec.querySelectorAll('[data-fx="gab"]').forEach((b) => { const st = this.rack.abG(art); b.setAttribute('aria-pressed', String(st.aktiv === b.dataset.v)); b.classList.toggle('voll', !!st[b.dataset.v]); });
      const hq = sec.querySelector('[data-fx="hq"]');
      if (hq) hq.setAttribute('aria-pressed', String(!!geraetObj(p, art)?.hq));
      sec.querySelectorAll('[data-knopf]').forEach((k) => this.knopfZeigen(k));
    }
    this.el.querySelectorAll('.fx-mod').forEach((s, i) => { const nr = s.querySelector('.fx-nr'); if (nr) nr.textContent = String(i + 1).padStart(2, '0') + (this.breit ? ` · ${geraet(s.dataset.art).rolle}` : ''); });
    const gn = this.el.querySelector('[data-gesamt-name]');
    if (gn) gn.textContent = this.rack.presetName('rack');
    this.el.querySelector('[data-fx="bypass"]')?.setAttribute('aria-pressed', String(!!p.bypass));
    this.el.querySelectorAll('[data-fx="ab"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === this.rack.ab.aktiv)));
    this.kette();
    this.abZeile();
    this.eqZeichnen();
  }

  /** Zustand eines VST3-Moduls (Status, Knöpfe) nachführen */
  vstZeigen(sec) {
    const v = vstRack.finde(sec.dataset.art);
    if (!v) return;
    const bereit = v.status === 'bereit';
    sec.classList.toggle('vst-fehler', v.status === 'fehler');
    const st = sec.querySelector('[data-vst-status]');
    if (st) { st.textContent = v.status === 'fehler' ? t('{text} – Pegelanzeige und Signal laufen ohne das Plug-in weiter.', { text: v.text }) : v.status === 'start' ? t('Plug-in startet …') : ''; st.hidden = !st.textContent; }
    const ed = sec.querySelector('[data-fx="vst-editor"]');
    if (ed) { ed.disabled = !(bereit && v.editor !== false); ed.setAttribute('aria-pressed', String(!!v.editorAuf)); const tx = ed.querySelector('[data-vst-editor-text]'); if (tx) tx.textContent = v.editorAuf ? t('Oberfläche schließen') : t('Oberfläche öffnen'); }
    const pr = sec.querySelector('[data-fx="vst-preset"]'); if (pr) pr.disabled = !bereit;
    const pn = sec.querySelector('[data-vst-preset-name]'); if (pn) pn.textContent = v.preset || t('Zustand');
    const nb = sec.querySelector('[data-fx="vst-neustart"]'); if (nb) nb.hidden = v.status !== 'fehler';
  }

  /** Pegel der VST3-Module: Spitzen je Kanal genau vor (EIN) und hinter (AUS) dem Plug-in – gleiche Anzeige wie Eingang/Ausgang */
  vstPegel() {
    const jetzt = performance.now();
    for (const sec of this.el.querySelectorAll('.fx-mod[data-art^="vst"]')) {
      const art = sec.dataset.art, v = vstRack.finde(art);
      if (!v) continue;
      const frisch = v.status === 'bereit' && v.an && jetzt - v.pegel.t < 400 && !this.p.audio.paused;
      const ein = frisch ? v.pegel.i : [0, 0], aus = frisch ? v.pegel.a : [0, 0];
      this.balken(sec, [...ein, ...aus], art);
    }
  }

  /** Vergleichszeile: was steckt in A, was in B (nur wenn es B gibt) */
  abZeile() {
    const box = this.el.querySelector('[data-abzeile]');
    if (!box) return;
    const u = this.rack.abUnterschied();
    box.hidden = !u;
    if (!u) return;
    const seite = (k, liste) => `<button type="button" data-fx="ab" data-v="${k}" class="${this.rack.ab.aktiv === k ? 'an' : ''}"><b>${k}</b><span>${h(liste.length ? liste.join(' · ') : t('gleich'))}</span></button>`;
    box.innerHTML = `${seite('A', u.a)}${seite('B', u.b)}<button type="button" class="fx-ab-leeren" data-fx="ableeren" title="${t('Vergleich beenden (B verwerfen)')}">${icon('zu', 14)}</button>`;
  }

  kette() {
    const p = this.p, r = this.reihenfolge(), box = this.el.querySelector('[data-kette]');
    if (!box) return;
    box.innerHTML = r.map((art, i) => {
      const g = geraet(art), aus = g.netz && (p.bypass || !anWert(p, art));
      return `<span class="fx-c${g.fest ? '' : ' frei'}${aus ? ' aus' : ''}${p.raumklang.deltaArt === art ? ' delta' : ''}">${p.raumklang.deltaArt === art ? 'Δ ' : ''}${g.kurz || g.name}</span>${i < r.length - 1 ? '<span class="fx-pf">→</span>' : ''}`;
    }).join('');
  }

  kurztext(art) {
    const p = this.p;
    if (art === 'eingang') {
      const tr = p.track, f = tr?.format;
      return tr ? [tr.titel, f ? `${(f.datei || f.codec || '').toUpperCase()}${f.bittiefe ? ` ${f.bittiefe}/${Math.round(f.abtastrate / 1000)}` : ''}` : ''].filter(Boolean).join(' · ') : t('nichts spielt');
    }
    if (art === 'ausgang') {
      const l = p.raumklang.aktiv ? p.raumklang.layout?.name : 'Stereo';
      const lh = p.lautheitFuer(p.track);
      return [l, lh && lh.art !== 'fehlt' ? t('Ziel {ziel} LUFS', { ziel: dez(lh.ziel, 0) }) : p.einst.lautheit === 'aus' ? t('ohne Angleich') : '', 'Auto-Gain'].filter(Boolean).join(' · ');
    }
    if (istVstId(art)) {
      const v = vstRack.finde(art);
      if (!v) return '';
      const ms = v.latenz ? ` · ${t('Latenz {ms} ms', { ms: zahl(v.latenz / (p.raumklang.ctx?.sampleRate || 48000) * 1000, 1) })}` : '';
      return v.status === 'bereit' ? [v.preset || t('aktueller Zustand'), v.anbieter].filter(Boolean).join(' · ') + ms : v.status === 'start' ? t('startet …') : v.text || t('nicht verfügbar');
    }
    const name = this.rack.presetName(art);
    const o = geraetObj(p, art);
    if (art === 'glow') return `${name} · ${WAERME_ROEHREN[o.roehre].name}${o.schaltung === 'gegentakt' ? ` ${t('Gegentakt')}` : ''}${o.hq ? ' · HQ' : ''} · ${t('Ansteuerung {n} %', { n: o.drive })}`;
    if (art === 'iron') return `${name} · ${TRAFO_KERNE[o.kern].name} · ${TRAFO_QUELLEN[o.quelle].name}${o.hq ? ' · HQ' : ''}`;
    if (art === 'silk') return `${name} · ${zahl(o.ips)} ips · ${BAND_SORTEN[o.sorte].name}${o.hq ? ' · HQ' : ''}`;
    if (art === 'eq') return [o.modus === 'passiv' ? 'Analog' : '', ...o.baender.map((b, i) => `${EQ_KURZ[i]} ${vz(b.g, Math.abs(b.g) % 1 ? 1 : 0)}`)].filter(Boolean).join(' · ');
    if (art === 'space') {
      const st = staerkeErkennen(fein(p));
      return [name, st ? ({ klein: t('Subtil'), mittel: t('Weit'), gross: t('Intensiv') })[st] : '', this.irName()].filter(Boolean).join(' · ');
    }
    return '';
  }

  knopfZeigen(el) {
    const p = this.p, art = el.dataset.art, key = el.dataset.knopf;
    const d = knopfDef(p, art, key);
    if (!d) return;
    const v = knopfWert(p, art, key);
    const farbe = art === 'eq' ? EQ_FARBEN[+key.split('_')[0]] : '#ffb547';
    const sig = `${v}|${farbe}|${d.min}|${d.max}`;
    if (el._sig === sig) return;
    el._sig = sig;
    el.querySelector('svg').outerHTML = knopfSvg(d, v, farbe);
    el.querySelector('b').textContent = d.fmt(v);
    el.querySelector('span').textContent = d.n;
    el.setAttribute('aria-valuetext', d.fmt(v));
  }

  // ---------- EQ-Analyzer ----------
  eqZeichnen(nurSpektrum = false) {
    const box = this.el.querySelector('[data-analyzer]');
    if (!box) return;
    const p = this.p, eq = p.einst.eq, svg = box.querySelector('svg');
    const W = 440, H = 160, N = 160, SR = p.raumklang.ctx?.sampleRate || 48000;
    const wirkt = eq.an && !p.bypass;
    const fx = (x) => 20 * Math.pow(1000, x / W);
    const yK = (d) => clamp(H / 2 - d / 15 * (H * 0.4), 2, H - 2);
    if (!nurSpektrum) {
      let kurve = '';
      // Form der Kurve ohne den automatischen Gain (der senkt nur alles gleich ab) – so liegen die Punkte auf der Kurve
      for (let i = 0; i < N; i++) { const x = W * i / (N - 1); const d = wirkt ? eqBaenderDb(eq, fx(x), SR) : 0; kurve += `${i ? 'L' : 'M'}${x.toFixed(1)} ${yK(d).toFixed(1)}`; }
      svg.querySelector('.fx-eq-kurve').setAttribute('d', kurve);
      eq.baender.forEach((b, i) => {
        const pk = box.querySelector(`[data-pkt="${i}"]`);
        if (!pk) return;
        pk.style.left = `${(100 * Math.log10(b.f / 20) / 3).toFixed(2)}%`;
        pk.style.top = `${(yK(b.g) / H * 100).toFixed(2)}%`;
        pk.classList.toggle('gew', i === this.eqBand);
      });
    }
    // Spektren vor/nach dem EQ (nur wenn Web Audio läuft): Echtzeitanalyse in 1/24 Oktave (240 Bänder 20 Hz – 20 kHz),
    // Bandleistung wie ein RTA (rosa Rauschen liegt waagerecht), je Bild geglättet: schnell hoch, langsam zurück
    const ab = p.raumklang.angeschlossen ? p.raumklang.eqAbgriffe() : null;
    const vorP = svg.querySelector('.fx-sp-vor'), nachP = svg.querySelector('.fx-sp-nach');
    if (!ab || p.audio.paused) { vorP.setAttribute('d', ''); nachP.setAttribute('d', ''); this.rtaV = null; return; }
    const n = ab.vor.frequencyBinCount;
    if (!this.spV || this.spV.length !== n) { this.spV = new Float32Array(n); this.spN = new Float32Array(n); this.rtaB = null; }
    ab.vor.getFloatFrequencyData(this.spV);
    ab.nach.getFloatFrequencyData(this.spN);
    const P = 240, binHz = SR / ab.vor.fftSize;
    if (!this.rtaB || this.rtaB.sr !== SR) {
      // Bandgrenzen einmal rechnen: je Band die Bins, oder (unten, schmaler als ein Bin) die Mitte zum Interpolieren
      this.rtaB = { sr: SR, b: [] };
      for (let i = 0; i < P; i++) {
        const f0 = 20 * Math.pow(2, i / 24), f1 = 20 * Math.pow(2, (i + 1) / 24), fm = Math.sqrt(f0 * f1);
        const a = Math.ceil(f0 / binHz), e = Math.floor(f1 / binHz);
        this.rtaB.b.push(e >= a ? { a, e: Math.min(e, n - 1) } : { mitte: fm / binHz, anteil: (f1 - f0) / binHz });
      }
      this.rtaV = null;
    }
    if (!this.rtaV) { this.rtaV = new Float32Array(P).fill(-120); this.rtaN = new Float32Array(P).fill(-120); }
    const band = (sp, b) => {
      if (b.mitte != null) {
        const k = Math.min(n - 2, Math.floor(b.mitte)), fr = b.mitte - k;
        const lin = Math.pow(10, sp[k] / 10) * (1 - fr) + Math.pow(10, sp[k + 1] / 10) * fr;
        return 10 * Math.log10(lin * b.anteil + 1e-20);
      }
      let sum = 0;
      for (let k = b.a; k <= b.e; k++) sum += Math.pow(10, sp[k] / 10);
      return 10 * Math.log10(sum + 1e-20);
    };
    const yS = (d) => clamp((-d - 10) / 90 * H, 0, H).toFixed(1);
    let vor = '', nach = '';
    for (let i = 0; i < P; i++) {
      const b = this.rtaB.b[i];
      const dv = band(this.spV, b), dn = band(this.spN, b);
      this.rtaV[i] += (dv - this.rtaV[i]) * (dv > this.rtaV[i] ? 0.55 : 0.12);
      this.rtaN[i] += (dn - this.rtaN[i]) * (dn > this.rtaN[i] ? 0.55 : 0.12);
      const x = (W * (i + 0.5) / P).toFixed(1);
      vor += `${i ? 'L' : 'M'}${x} ${yS(this.rtaV[i])}`;
      nach += `${i ? 'L' : 'M'}${x} ${yS(this.rtaN[i])}`;
    }
    vorP.setAttribute('d', `${vor}L${W} ${H}L0 ${H}Z`);
    nachP.setAttribute('d', nach);
  }

  // ---------- Meter (je Bildschirmbild) ----------
  schleife(zeit) {
    if (!this.el.isConnected) return;
    const p = this.p, rk = p.raumklang;
    const textJetzt = !this._textT || zeit > this._textT;
    if (textJetzt) this._textT = zeit + 300;
    const glatt = (k, z, a) => { const v = this.glatt[k] ?? z; const n = v + (z - v) * a; this.glatt[k] = n; return n; };
    // Färbung je Gerät: Zeiger mit Trägheit (Feder-Masse-System, ~300 ms Anstieg, leichtes Überschwingen wie ein VU-Meter)
    const dt = Math.min(0.05, Math.max(0.001, (zeit - (this._letztT || zeit)) / 1000));
    this._letztT = zeit;
    this.vstPegel();
    for (const art of ['glow', 'iron', 'silk']) {
      const sec = this.el.querySelector(`.fx-mod[data-art="${art}"]`);
      if (!sec || (!this.breit && !sec.classList.contains('offen'))) continue;
      const m = rk.faerbung?.[art];
      const laeuft = rk.stufeWirksam(art) && !p.audio.paused;
      const frisch = m && performance.now() - m.t < 400 && laeuft;
      let summe = 0;
      sec.querySelectorAll('.fx-vu').forEach((vu, c) => {
        const pct = frisch ? m.w[c] * 100 : 0;
        const n = this.nadel[`${art}${c}`] ||= { x: 0, v: 0 };
        const ziel = frisch ? VU_W(pct) : 0, om = 11, ze = 0.72;
        n.v += (om * om * (ziel - n.x) - 2 * ze * om * n.v) * dt;
        n.x = clamp(n.x + n.v * dt, -0.02, 1.04);
        summe += Math.max(0, n.x);
        vu.querySelector('.fx-nadel').setAttribute('transform', `rotate(${(-50 + 100 * n.x).toFixed(2)} 90 95)`);
      });
      // Gerätebild (großes Rack): glüht/flusst mit der Färbung, Spulen laufen nur beim Abspielen
      const w = summe / 2;
      if (art === 'glow') {
        const kern = sec.querySelector('.fx-glut-kern');
        if (kern) {
          const flacker = laeuft ? 0.04 * Math.sin(zeit / 97) + 0.03 * Math.sin(zeit / 41) : 0;
          const g = glatt('glut', laeuft ? 0.32 + 0.68 * w : 0.1, 0.08) + flacker;
          kern.setAttribute('opacity', clamp(g, 0.06, 1).toFixed(3));
          sec.querySelector('.fx-glut-wand').style.opacity = clamp(g * 0.9, 0, 1).toFixed(3);
          sec.querySelector('.fx-glut-faden').setAttribute('opacity', (laeuft ? 0.75 + 0.25 * Math.random() : 0.35).toFixed(2));
        }
      } else if (art === 'iron') {
        const f = sec.querySelector('.fx-fluss');
        if (f) f.setAttribute('opacity', glatt('fluss', laeuft ? 0.06 + 0.5 * w : 0.02, 0.1).toFixed(3));
      } else {
        sec.querySelector('.fx-vus')?.classList.toggle('steht', !laeuft);
      }
    }
    // Eingang: Pegel je Kanal (vor allen Effekten), Lautheit des Titels
    const lh = p.lautheitFuer(p.track);
    const ein = this.el.querySelector('.fx-mod[data-art="eingang"]');
    if (ein && (this.breit || ein.classList.contains('offen'))) {
      const a = rk.angeschlossen ? rk.eingangAbgriffe() : null;
      // nach dem Lautheitsausgleich: der Gain sitzt hinten in der Kette (angleich) – hier eingerechnet; im Stream steckt er schon drin
      const g = rk.angleich && !rk.angleich.nativ ? rk.angleich.gain.value : 1; // nativ sitzt der Angleich schon vor dem Abgriff
      this.balken(ein, a ? a.map((x) => this.spitze(x) * g) : null, 'e');
      if (textJetzt) {
        this.wert(ein, 'lufs', lh && lh.art !== 'fehlt' ? dez(lh.lufs, 1) : '–');
        this.wert(ein, 'tp', lh && lh.art !== 'fehlt' && Number.isFinite(lh.tp) ? dez(lh.tp, 1) : '–');
        this.wert(ein, 'gain', lh && lh.art !== 'fehlt' ? `${vz(lh.db, 1)}` : '–');
      }
    }
    // Ausgang: Spitzen je Kanal, Lautheit (momentan, K-bewertet) – gleicher Messpunkt wie Pegelanzeige und Analyse
    const aus = this.el.querySelector('.fx-mod[data-art="ausgang"]');
    const sp = rk.angeschlossen ? rk.spitzen(this._puffer ||= new Float32Array(2048)) : null;
    const lufs = rk.angeschlossen && !p.audio.paused ? this.lufsM() : null;
    if (aus && (this.breit || aus.classList.contains('offen'))) {
      this.balken(aus, sp, 'a');
      if (textJetzt) {
        const max = sp ? Math.max(...sp) : 0;
        this._spitze = Math.max(max, (this._spitze || 0) * 0.85);
        this.wert(aus, 'lufsm', lufs != null ? dez(lufs, 1) : '–');
        this.wert(aus, 'spitze', sp && this._spitze > 1e-5 ? dez(20 * Math.log10(this._spitze), 1) : '–');
        this.wert(aus, 'ziel', lh && lh.art !== 'fehlt' ? dez(lh.ziel, 0) : '–');
      }
    }
    // Fuß (Karten): Ausgang
    const fb = this.el.querySelector('[data-fuss-bahn]');
    if (fb) {
      const max = sp ? Math.max(...sp) : 0;
      const w = glatt('fuss', max > 1e-6 ? clamp((20 * Math.log10(max) + 60) / 60, 0, 1) : 0, 0.3);
      fb.style.width = `${(w * 100).toFixed(1)}%`;
      if (textJetzt) this.el.querySelector('[data-fuss-lufs]').textContent = lufs != null ? `${dez(lufs, 1)} LUFS` : rk.angeschlossen ? '–' : t('ohne Web Audio');
    }
    this.eqZeichnen(true);
    this.raf = requestAnimationFrame(this.schleife);
  }

  spitze(an) {
    const b = this._puffer ||= new Float32Array(2048);
    an.getFloatTimeDomainData(b);
    let m = 0;
    for (let i = 0; i < b.length; i++) { const v = b[i] < 0 ? -b[i] : b[i]; if (v > m) m = v; }
    return m;
  }

  /** Pegel je Kanal (Spitze, dBFS): −60 … 0 dB über die ganze Breite, schnell hoch, langsam zurück; Clip-Lampe hält 1,5 s */
  balken(sec, werte, k) {
    const bahnen = sec.querySelectorAll('.fx-bahn i'), clips = sec.querySelectorAll('.fx-clip');
    const jetzt = performance.now();
    bahnen.forEach((b, c) => {
      const v = werte?.[c] || 0, db = v > 1e-6 ? 20 * Math.log10(v) : -90;
      const ziel = clamp((db + 60) / 60, 0, 1), alt = this.glatt[`${k}${c}`] ?? 0;
      const w = alt + (ziel - alt) * (ziel > alt ? 0.6 : 0.08);
      this.glatt[`${k}${c}`] = w;
      b.style.clipPath = `inset(0 ${(100 - w * 100).toFixed(2)}% 0 0)`;
      if (v >= 0.999) this.glatt[`${k}clip${c}`] = jetzt;
      clips[c]?.classList.toggle('an', jetzt - (this.glatt[`${k}clip${c}`] || -1e9) < 1500);
    });
  }

  wert(sec, k, t) { const el = sec.querySelector(`[data-wert="${k}"]`); if (el && el.textContent !== t) el.textContent = t; }

  /** Momentane Lautheit (400 ms, K-bewertet, BS.1770) am Ausgang */
  lufsM() {
    const rk = this.p.raumklang, a = rk.lautheitAnalyser?.();
    if (!a) return null;
    const n = rk.layout ? rk.layout.kanaele : 2;
    const g = n === 6 ? [1, 1, 1, 0, 1.41, 1.41] : n === 4 ? [1, 1, 1.41, 1.41] : [1, 1];
    const b = this._kPuffer ||= new Float32Array(a[0].fftSize);
    const lange = Math.min(b.length, Math.round(rk.ctx.sampleRate * 0.4));
    let s = 0;
    for (let c = 0; c < n; c++) {
      if (!g[c]) continue;
      a[c].getFloatTimeDomainData(b);
      let q = 0;
      for (let i = b.length - lange; i < b.length; i++) q += b[i] * b[i];
      s += g[c] * q / lange;
    }
    return s > 1e-10 ? -0.691 + 10 * Math.log10(s) : null;
  }

  // ---------- Bedienung ----------
  verbinden() {
    const el = this.el;
    el.addEventListener('click', (e) => this.klick(e));
    el.addEventListener('pointerdown', (e) => this.druck(e));
    el.addEventListener('dblclick', (e) => this.doppel(e));
    el.addEventListener('wheel', (e) => this.rad(e), { passive: false });
    el.addEventListener('keydown', (e) => this.taste(e));
    this.bewegen = (e) => this.zugBewegen(e);
    this.loslassen = () => this.zugEnde();
    window.addEventListener('pointermove', this.bewegen, { passive: true });
    window.addEventListener('pointerup', this.loslassen);
    window.addEventListener('pointercancel', this.loslassen);
    this.esc = (e) => { if (e.key === 'Escape' && !document.querySelector('.fx-wahl, dialog[open], .rk-menue')) { e.preventDefault(); e.stopImmediatePropagation(); this.schliessen(); } };
    document.addEventListener('keydown', this.esc, true);
    if (this.modus === 'flyout' || this.einzel) {
      this.aussen = (e) => {
        if (this.el.contains(e.target) || this.anker?.contains(e.target) || e.target.closest('.fx-wahl, .fx-wahl-grund, dialog, .rk-menue')) return;
        this.schliessen();
      };
      document.addEventListener('pointerdown', this.aussen, true);
      this.groesse = () => this.positionieren();
      window.addEventListener('resize', this.groesse);
    }
  }

  async klick(e) {
    const a = e.target.closest('[data-fx]');
    if (!a || a.disabled) return;
    const p = this.p, sec = a.closest('.fx-mod'), art = sec?.dataset.art, was = a.dataset.fx;
    if (was === 'auf') {
      if (this.breit || this.einzel || e.target.closest('[data-griff], .fx-netz') || this._nachZug) return;
      this.oeffnen(this.offen === art ? null : art);
      return;
    }
    if (was === 'zu') { this.schliessen(); return; }
    if (was === 'vollbild') { const o = this.einzel ? this.art : this.offen; this.schliessen(); this.rack.vollbild(o); return; }
    if (was === 'netz') { await this.rack.umschalten(art); if (p.raumklang.deltaArt === art && !p.raumklang.stufeWirksam(art)) p.raumklang.deltaSetzen(null); this.aktualisieren(); return; }
    if (was === 'vst-editor') { vstRack.editor(art); return; }
    if (was === 'vst-neustart') { vstRack.neuStarten(art); return; }
    if (was === 'vst-weg') {
      const v = vstRack.finde(art);
      if (v && await bestaetigen(t('{name} aus dem Rack entfernen?', { name: v.name }), t('Seine gespeicherten Einstellungen gehen dabei verloren (Presets bleiben erhalten).'), t('Entfernen'))) await vstRack.entfernen(art);
      return;
    }
    if (was === 'vst-preset') {
      const v = vstRack.finde(art);
      if (!v) return;
      const liste = await vstRack.presetListe(v);
      this.rack.auswahl(a, t('{name} · Presets', { name: v.name }), [{ titel: liste.length ? t('Eigene Presets') : '', punkte: liste.length ? liste.map((n) => ({ t: n, an: n === v.preset, aktion: async () => { await vstRack.presetLaden(v, n); this.aktualisieren(); },
        werkzeug: [{ titel: t('Preset löschen'), icon: 'zu', aktion: async () => { await vstRack.presetLoeschen(v, n); toast(t('Preset gelöscht')); } }] })) : [{ t: t('Noch keine Presets'), info: t('Die jetzigen Einstellungen werden automatisch gemerkt – als Preset speichern, um sie zu behalten.'), aktion: () => {} }] }],
      [{ t: t('Jetzigen Zustand als Preset speichern …'), aktion: async () => {
        const name = await this.rack.nameFragen(t('{name}: Preset speichern', { name: v.name }), v.preset || '');
        if (name && await vstRack.presetSpeichern(v, name)) { toast(t('Preset „{n}“ gespeichert', { n: name }), 'gut'); this.aktualisieren(); }
      } }]);
      return;
    }
    if (was === 'vst-neu') { vstWaehler(a); return; }
    if (was === 'hq') {
      const o = geraetObj(p, art);
      if (art === 'glow') p.waermeSetzen({ ...o, hq: !o.hq }); else if (art === 'iron') p.trafoSetzen({ ...o, hq: !o.hq }); else p.bandSetzen({ ...o, hq: !o.hq });
      this.karteNeu(art);
      return;
    }
    if (was === 'sw') { const o = geraetObj(p, art); p.bandSetzen({ ...o, [a.dataset.sw]: !o[a.dataset.sw] }); a.setAttribute('aria-pressed', String(!o[a.dataset.sw])); return; }
    if (was === 'opt') {
      const def = OPTIONEN[art].find((x) => x.k === a.dataset.opt), o = geraetObj(p, art);
      this.rack.auswahl(a, `${geraet(art).name} · ${def.n.charAt(0)}${def.n.slice(1).toLowerCase()}`, [{ punkte: def.werte.map((w) => ({ t: w.t, info: w.info, an: w.w === o[def.k], aktion: () => {
        if (art === 'glow') p.waermeSetzen({ ...p.einst.waerme, [def.k]: w.w }); else if (art === 'iron') p.trafoSetzen({ ...p.einst.trafo, [def.k]: w.w }); else p.bandSetzen({ ...p.einst.band, [def.k]: w.w });
        this.karteNeu(art);
      } })) }]);
      return;
    }
    if (was === 'preset') { this.rack.presetWahl(a, art, () => this.karteNeu(art)); return; }
    if (was === 'gesamt') { this.rack.presetWahl(a, 'rack', () => this.zeichnen()); return; }
    if (was === 'bypass') { await p.bypassSetzen(!p.bypass); this.aktualisieren(); return; }
    if (was === 'ab') { await this.rack.abWechseln(a.dataset.v); this.zeichnen(); return; }
    if (was === 'ableeren') { this.rack.abLeeren(); this.aktualisieren(); toast(t('Vergleich beendet – es gilt der jetzige Stand')); return; }
    if (was === 'mehr') { raumklangMenueOeffnen(this.rack.leiste, a); return; }
    if (was === 'algo') { await spaceAlgoSetzen(p, a.dataset.k); this.karteNeu('space'); return; }
    if (was === 'staerke') { p.raumklangFeinSetzen(staerkeWerte(a.dataset.k)); this.karteNeu('space'); return; }
    if (was === 'irwahl') { this.irMenue(a); return; }
    if (was === 'delta') {
      const neu = p.raumklang.deltaArt === art ? null : art;
      if (neu && !p.raumklang.stufeWirksam(art)) { toast(t('{name} ist aus – erst einschalten, dann gibt es ein Delta', { name: geraet(art).name })); return; }
      p.raumklang.deltaSetzen(neu);
      this.aktualisieren();
      if (neu) toast(t('Delta: nur was {name} verändert', { name: geraet(art).name }));
      return;
    }
    if (was === 'gab') { await this.rack.abGeraetWechseln(art, a.dataset.v); this.karteNeu(art); return; }
    if (was === 'band') { this.eqBand = +a.dataset.b; this.karteNeu('eq'); return; }
    if (was === 'eqmodus') { p.eqSetzen({ ...p.einst.eq, modus: a.dataset.m }); this.karteNeu('eq'); return; }
    if (was === 'typ') {
      const eq = JSON.parse(JSON.stringify(p.einst.eq)), b = eq.baender[+a.dataset.b];
      b.typ = a.dataset.t;
      p.eqSetzen(eqNormal(eq));
      this.karteNeu('eq');
    }
  }

  oeffnen(art) {
    this.offen = art;
    if (art) this.rack.zuletzt = art;
    for (const s of this.el.querySelectorAll('.fx-mod')) {
      const auf = s.dataset.art === art;
      s.classList.toggle('offen', auf);
      s.querySelector('.fx-kopf')?.setAttribute('aria-expanded', String(auf));
    }
    if (!art) return;
    setTimeout(() => {
      const s = this.el.querySelector(`.fx-mod[data-art="${art}"]`);
      const box = this.modus === 'flyout' || this.einzel ? this.el.querySelector('[data-rack]') : null;
      if (!s) return;
      const r = s.getBoundingClientRect(), b = box ? box.getBoundingClientRect() : { top: 130, bottom: window.innerHeight - 90 };
      if (r.top < b.top || r.bottom > b.bottom) (box || window).scrollBy({ top: r.top - b.top - 8, behavior: ruhig() ? 'auto' : 'smooth' });
    }, 360);
  }

  druck(e) {
    if (e.button && e.button !== 0) return;
    const k = e.target.closest('[data-knopf]');
    if (k && !k.classList.contains('gesperrt')) {
      e.preventDefault();
      const art = k.dataset.art, key = k.dataset.knopf, d = knopfDef(this.p, art, key);
      // Doppeltippen (Touch): zurück aufs Preset
      const jetzt = performance.now();
      if (e.pointerType !== 'mouse' && this._tipp && this._tipp.k === k && jetzt - this._tipp.t < 320) { this._tipp = null; this.zuruecksetzen(art, key); return; }
      this._tipp = { k, t: jetzt };
      try { k.setPointerCapture(e.pointerId); } catch (x) { /* egal */ }
      k.classList.add('aktiv');
      this.zug = { art: 'knopf', el: k, ga: art, key, d, y: e.clientY, n: zuN(d, knopfWert(this.p, art, key)) };
      return;
    }
    const g = e.target.closest('[data-griff]');
    if (g) { e.preventDefault(); this.verschiebenStart(g.closest('.fx-mod'), e); return; }
    const pk = e.target.closest('[data-analyzer]');
    if (pk) { e.preventDefault(); this.analyzerZug(pk, e, true); }
  }

  zugBewegen(e) {
    const z = this.zug;
    if (!z) return;
    if (z.art === 'knopf') {
      const v = vonN(z.d, z.n + (z.y - e.clientY) / (e.shiftKey ? 900 : 220));
      if (v !== knopfWert(this.p, z.ga, z.key)) { knopfSetzen(this.p, z.ga, z.key, v); this.knopfZeigen(z.el); this.nachKnopf(z.ga); }
    } else if (z.art === 'reihe') this.verschiebenBewegen(e);
    else if (z.art === 'analyzer') this.analyzerZug(z.el, e, false);
  }

  zugEnde() {
    const z = this.zug;
    if (!z) return;
    this.zug = null;
    if (z.art === 'knopf') z.el.classList.remove('aktiv');
    if (z.art === 'reihe') this.verschiebenEnde(z);
    if (z.art === 'analyzer') this.karteNeu('eq');
    this.aktualisieren();
  }

  /** Nach einem Reglerzug: Kopfzeile, Preset-Name, EQ-Kurve */
  nachKnopf(art) {
    const sec = this.el.querySelector(`.fx-mod[data-art="${art}"]`);
    if (!sec) return;
    const kurz = sec.querySelector('[data-kurz]'); if (kurz) kurz.textContent = this.kurztext(art);
    const pn = sec.querySelector('[data-preset-name]'); if (pn) pn.textContent = this.rack.presetName(art);
    const gn = this.el.querySelector('[data-gesamt-name]'); if (gn) gn.textContent = this.rack.presetName('rack');
    clearTimeout(this._abT); this._abT = setTimeout(() => this.abZeile(), 150);
    if (art === 'eq') { this.eqZeichnen(); sec.querySelectorAll('[data-knopf]').forEach((k) => this.knopfZeigen(k)); this.kette(); }
  }

  zuruecksetzen(art, key) {
    const v = this.rack.presetWert(art, key);
    if (v == null) return;
    knopfSetzen(this.p, art, key, v);
    const k = this.el.querySelector(`.fx-mod[data-art="${art}"] [data-knopf="${key}"]`);
    if (k) this.knopfZeigen(k);
    this.nachKnopf(art);
  }

  doppel(e) {
    const k = e.target.closest('[data-knopf]');
    if (k && !k.classList.contains('gesperrt')) { this.zuruecksetzen(k.dataset.art, k.dataset.knopf); return; }
    const pk = e.target.closest('[data-pkt]');
    if (pk) { const i = +pk.dataset.pkt; this.eqBand = i; knopfSetzen(this.p, 'eq', `${i}_g`, 0); this.karteNeu('eq'); }
  }

  /** Mausrad: auf einem Regler fein ändern, auf einem EQ-Punkt die Güte */
  rad(e) {
    const k = e.target.closest('[data-knopf]'), pk = e.target.closest('[data-pkt]');
    if (!k && !pk) return;
    e.preventDefault();
    const art = k ? k.dataset.art : 'eq', key = k ? k.dataset.knopf : `${pk.dataset.pkt}_q`;
    if (k?.classList.contains('gesperrt')) return;
    const d = knopfDef(this.p, art, key);
    const schritt = (e.shiftKey ? 0.004 : 0.02) * (e.deltaY < 0 ? 1 : -1);
    const v = vonN(d, zuN(d, knopfWert(this.p, art, key)) + schritt);
    knopfSetzen(this.p, art, key, v);
    const el = k || this.el.querySelector(`[data-knopf="${key}"]`);
    if (el) this.knopfZeigen(el);
    this.nachKnopf(art);
  }

  /** Tastatur auf einem Regler: Pfeile ändern, Pos1/Ende springen */
  taste(e) {
    const k = e.target.closest?.('[data-knopf]');
    if (!k || k.classList.contains('gesperrt')) return;
    const art = k.dataset.art, key = k.dataset.knopf, d = knopfDef(this.p, art, key);
    const n = zuN(d, knopfWert(this.p, art, key));
    const s = e.shiftKey ? 0.1 : 0.01;
    let neu = null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') neu = n + s;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') neu = n - s;
    else if (e.key === 'Home') neu = 0;
    else if (e.key === 'End') neu = 1;
    if (neu == null) return;
    e.preventDefault();
    knopfSetzen(this.p, art, key, vonN(d, neu));
    this.knopfZeigen(k);
    this.nachKnopf(art);
  }

  /** EQ-Punkte ziehen: waagerecht Frequenz, senkrecht Gain */
  analyzerZug(box, e, start) {
    const p = this.p, r = box.getBoundingClientRect();
    const x = clamp((e.clientX - r.left) / r.width, 0, 1), y = clamp((e.clientY - r.top) / r.height, 0, 1);
    const eq = p.einst.eq;
    if (start) {
      const pkt = e.target.closest('[data-pkt]');
      let wahl = pkt ? +pkt.dataset.pkt : -1;
      if (wahl < 0) {
        let best = 1e9;
        eq.baender.forEach((b, i) => { const bx = Math.log10(b.f / 20) / 3, by = 0.5 - b.g / 15 * 0.4; const d = Math.hypot((bx - x) * r.width, (by - y) * r.height); if (d < best) { best = d; wahl = i; } });
        if (best > 40) return; // nicht in die Nähe eines Punkts getippt: nichts tun (Scrollen bleibt möglich)
      }
      this.eqBand = wahl;
      this.zug = { art: 'analyzer', el: box };
      try { box.setPointerCapture(e.pointerId); } catch (x2) { /* egal */ }
    }
    const i = this.eqBand, b = eq.baender[i];
    const [fmin, fmax] = F_GRENZEN[b.typ];
    const f = clamp(fRund(20 * Math.pow(1000, x)), fmin, fmax);
    const g = clamp(Math.round(((0.5 - y) / 0.4 * 15) * 2) / 2, -GAIN_MAX, GAIN_MAX);
    const neu = JSON.parse(JSON.stringify(eq));
    neu.baender[i].f = f; neu.baender[i].g = g;
    if (Math.abs(g) >= 0.05) neu.an = true;
    p.eqSetzen(neu);
    this.nachKnopf('eq');
  }

  // ---------- Reihenfolge per Griff ----------
  verschiebenStart(sec, e) {
    if (!this.breit && sec.classList.contains('offen')) this.oeffnen(null);
    sec.classList.add('zieht');
    const box = this.el.querySelector('[data-rack]');
    this.zug = { art: 'reihe', sec, startY: e.clientY, startTop: sec.offsetTop, y: e.clientY, box, scroll0: this.scroller().scrollTop };
    try { navigator.vibrate?.(8); } catch (x) { /* egal */ }
    const auto = () => {
      const z = this.zug;
      if (!z || z.art !== 'reihe') return;
      const sc = this.scroller(), r = sc === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : sc.getBoundingClientRect();
      const d = z.y < r.top + 70 ? -8 : z.y > r.bottom - 70 ? 8 : 0;
      if (d) { sc.scrollTop += d; this.verschiebenBewegen({ clientY: z.y }); }
      this._autoRaf = requestAnimationFrame(auto);
    };
    this._autoRaf = requestAnimationFrame(auto);
  }

  scroller() { return this.modus === 'flyout' ? this.el.querySelector('[data-rack]') : this.el; }

  verschiebenBewegen(e) {
    const z = this.zug;
    z.y = e.clientY;
    const frei = [...this.el.querySelectorAll('.fx-mod')].filter((s) => !geraet(s.dataset.art).fest);
    const vorher = new Map(frei.map((s) => [s, s.getBoundingClientRect().top]));
    let bewegt = false;
    for (const s of frei) {
      if (s === z.sec) continue;
      const rc = s.getBoundingClientRect(), mitte = rc.top + rc.height / 2;
      const darueber = s.compareDocumentPosition(z.sec) & Node.DOCUMENT_POSITION_FOLLOWING;
      if (darueber && e.clientY < mitte) { s.before(z.sec); bewegt = true; break; }
      if (!darueber && e.clientY > mitte) { s.after(z.sec); bewegt = true; break; }
    }
    if (bewegt) {
      for (const s of frei) {
        if (s === z.sec) continue;
        const dy = vorher.get(s) - s.getBoundingClientRect().top;
        if (!dy) continue;
        s.classList.remove('flip'); s.style.transform = `translateY(${dy}px)`;
        s.getBoundingClientRect(); s.classList.add('flip'); s.style.transform = '';
      }
      this.el.querySelectorAll('.fx-mod').forEach((s, i) => { const nr = s.querySelector('.fx-nr'); if (nr) nr.textContent = String(i + 1).padStart(2, '0') + (this.breit ? ` · ${geraet(s.dataset.art).rolle}` : ''); });
    }
    const dy = (e.clientY - z.startY) + (this.scroller().scrollTop - z.scroll0) - (z.sec.offsetTop - z.startTop);
    z.sec.style.transform = `translateY(${dy}px)`;
  }

  verschiebenEnde(z) {
    cancelAnimationFrame(this._autoRaf);
    z.sec.classList.remove('zieht');
    z.sec.classList.add('flip');
    z.sec.style.transform = '';
    const reihe = [...this.el.querySelectorAll('.fx-mod')].map((s) => s.dataset.art).filter((a) => FREI.includes(a) || istVstId(a));
    if (reihe.join() !== this.p.einst.reihe.join()) {
      this.p.reiheSetzen(reihe);
      toast(t('Signalweg: {kette}', { kette: this.reihenfolge().map((a) => geraet(a).kurz || geraet(a).name).join(' → ') }));
    }
    this._nachZug = true;
    setTimeout(() => { this._nachZug = false; }, 50);
  }

  // ---------- Platz und Schließen ----------
  positionieren() {
    const a = this.anker;
    if (!a || !a.isConnected) return;
    this.el.classList.toggle('blatt', this.einzel && schmal());
    if (this.el.classList.contains('blatt')) { this.el.style.cssText = ''; return; }
    const r = a.getBoundingClientRect();
    const b = Math.min(440, window.innerWidth - 24);
    this.el.style.width = `${b}px`;
    this.el.style.left = `${Math.max(12, Math.min(window.innerWidth - b - 12, r.right - b + 24))}px`;
    this.el.style.bottom = `${Math.round(window.innerHeight - r.top + 14)}px`;
    this.el.style.maxHeight = `${Math.max(320, r.top - 28)}px`;
  }

  schliessen() {
    if (this.zu) return;
    this.zu = true;
    if (this.modus === 'breit' || this.modus === 'karten') titelFarbe(null, 'rack');
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this._autoRaf);
    this.p.removeEventListener('zustand', this.nachfuehren);
    window.removeEventListener('pointermove', this.bewegen);
    window.removeEventListener('pointerup', this.loslassen);
    window.removeEventListener('pointercancel', this.loslassen);
    document.removeEventListener('keydown', this.esc, true);
    if (this.aussen) document.removeEventListener('pointerdown', this.aussen, true);
    if (this.groesse) window.removeEventListener('resize', this.groesse);
    this.rack.wahlZu();
    this.p.raumklang.messenSetzen(false);
    this.anker?.setAttribute?.('aria-expanded', 'false');
    if (offen === this) offen = null;
    setTimeout(() => { if (!offen) this.p.raumklang.deltaSetzen(null); }, 0);
    document.querySelector('[data-rack-leiste]')?.setAttribute('aria-pressed', 'false');
    this.el.classList.add('raus');
    let weg = false;
    const ende = () => { if (!weg) { weg = true; this.el.remove(); } };
    this.el.addEventListener('animationend', (ev) => { if (ev.target === this.el) ende(); });
    setTimeout(ende, ruhig() ? 0 : 280);
    this.rack.leiste?.aktualisieren?.();
  }
}

// ---------- Steuerung: Presets, A/B, Auswahl ----------
export class Rack {
  constructor(player, leiste) {
    this.player = player;
    this.leiste = leiste;
    this.presets = null;
    this.ab = { aktiv: 'A', A: null, B: null };
    this.zuletzt = 'glow';
    try { this.gewaehlt = JSON.parse(localStorage.getItem('aw-rack-gewaehlt') || '{}') || {}; } catch (e) { this.gewaehlt = {}; }
    this.laden();
  }

  async laden() {
    try { this.presets = (await api.get('/presets')).presets || []; } catch (e) { this.presets = this.presets || []; }
    offen?.aktualisieren();
  }

  eigene(art) { return (this.presets || []).filter((x) => x.art === art); }

  /** Name für den Preset-Knopf: eigenes oder mitgeliefertes, das genau passt – sonst das zuletzt gewählte mit Stern */
  presetName(art, z = null) {
    const p = z ? scheinPlayer(z) : this.player;
    const e = this.eigene(art).find((x) => eigenesPasst(p, art, x.werte));
    const s = e ? null : (art === 'rack' ? rackStandard(p) : standardPresets(p, art)).find((x) => x.passt());
    const treffer = e?.name || s?.name;
    if (z) return treffer || t('eigene Einstellung');
    if (treffer) { if (this.gewaehlt[art] !== treffer) this.merken(art, treffer); return treffer; }
    const g = this.gewaehlt[art];
    return g ? `${g}*` : t('Eigene Einstellung');
  }

  merken(art, name) {
    this.gewaehlt[art] = name;
    try { localStorage.setItem('aw-rack-gewaehlt', JSON.stringify(this.gewaehlt)); } catch (e) { /* egal */ }
  }

  /** Wert eines Reglers im gewählten Preset (Doppelklick: zurück dorthin), sonst Standard */
  presetWert(art, key) {
    const p = this.player, name = (this.gewaehlt[art] || '').replace(/\*$/, '');
    const e = this.eigene(art).find((x) => x.name === name);
    if (art === 'eq') {
      const [b, k] = key.split('_');
      if (e) return e.werte.baender?.[+b]?.[k];
      const s = standardPresets(p, 'eq').find((x) => x.name === name);
      const quelle = s ? s.werte().baender : EQ_STANDARD.baender;
      const v = quelle[+b][k];
      return k === 'typ' ? null : v;
    }
    if (art === 'space') return e ? ({ ...FEIN_STANDARD, ...e.werte.fein })[key] : FEIN_STANDARD[key];
    if (e && e.werte[key] != null) return e.werte[key];
    const s = standardPresets(p, art).find((x) => x.name === name) || standardPresets(p, art).find((x) => x.passt()) || standardPresets(p, art)[1];
    const w = s?.werte?.();
    return w ? w[key] : null;
  }

  async umschalten(art) {
    const p = this.player;
    if (art === 'glow') { const w = p.einst.waerme; p.waermeSetzen({ ...w, an: !waermeWirksam(w), mix: w.mix || 85 }); }
    else if (art === 'iron') { const t = p.einst.trafo; p.trafoSetzen({ ...t, an: !trafoWirksam(t), mix: t.mix || 100 }); }
    else if (art === 'silk') { const b = p.einst.band; p.bandSetzen({ ...b, an: !bandWirksam(b), mix: b.mix || 100 }); }
    else if (art === 'eq') p.eqSetzen({ ...p.einst.eq, an: !p.einst.eq.an });
    else if (art === 'space') await p.raumklangUmschalten();
    else if (istVstId(art)) vstRack.anSetzen(art, !vstRack.finde(art)?.an);
  }

  /**
   * A/B: zwei Stände des ganzen Racks zum Vergleichen – z. B. zwei Presets eines Geräts. B ist beim ersten Wechsel eine
   * Kopie von A; was du in B wählst oder drehst, bleibt in B, A bleibt wie es war. Jeder Wechsel merkt den verlassenen Stand.
   */
  async abWechseln(ziel) {
    if (ziel === this.ab.aktiv) return;
    const p = this.player;
    this.ab[this.ab.aktiv] = p.rackZustand();
    const neu = !this.ab[ziel];
    if (neu) this.ab[ziel] = p.rackZustand();
    this.ab.aktiv = ziel;
    this._abG = {}; // Geräte-A/B passen nach einem Rack-Wechsel nicht mehr
    await p.rackAnwenden(this.ab[ziel]);
    toast(neu ? t('{ziel} ist eine Kopie von {von} – jetzt ein anderes Preset wählen, dann hin und her schalten', { ziel, von: ziel === 'B' ? 'A' : 'B' }) : t('Vergleich: {ziel}', { ziel }));
  }

  /** A/B eines einzelnen Geräts (unabhängig vom Rack-A/B) */
  abG(art) { return (this._abG ||= {})[art] ||= { aktiv: 'A', A: null, B: null }; }

  async abGeraetWechseln(art, ziel) {
    const st = this.abG(art);
    if (ziel === st.aktiv) return;
    const feld = { glow: 'waerme', iron: 'trafo', silk: 'band', eq: 'eq', space: 'space' }[art];
    const p = this.player, z = p.rackZustand();
    st[st.aktiv] = { [feld]: z[feld] };
    const neu = !st[ziel];
    if (neu) st[ziel] = { [feld]: z[feld] };
    st.aktiv = ziel;
    await p.rackAnwenden(st[ziel]);
    const name = (zz) => this.presetName(art, { ...p.rackZustand(), ...zz });
    toast(neu ? t('{kurz} {ziel}: Kopie – jetzt ein anderes Preset wählen, dann umschalten', { kurz: geraet(art).kurz, ziel }) : `${geraet(art).kurz} ${ziel}: ${name(st[ziel])}`);
  }

  /** A/B zurücksetzen (beide wieder gleich, nichts mehr zu vergleichen) */
  abLeeren() { this.ab = { aktiv: 'A', A: null, B: null }; }

  /** Was unterscheidet A und B? → ['Glow Warm', …] je Seite (null, solange es nur A gibt) */
  abUnterschied() {
    const { A, B, aktiv } = this.ab;
    if (!A && !B) return null;
    const jetzt = this.player.rackZustand();
    const za = aktiv === 'A' ? jetzt : A, zb = aktiv === 'B' ? jetzt : B;
    if (!za || !zb) return null;
    const va = rackVergleich(za), vb = rackVergleich(zb);
    const teile = { a: [], b: [] };
    const geraete = [['glow', 'waerme'], ['iron', 'trafo'], ['silk', 'band'], ['eq', 'eq'], ['space', 'space']];
    for (const [art, feld] of geraete) {
      if (gleich(va[feld], vb[feld])) continue;
      const an = (z, v) => (art === 'eq' ? v.eq.an : art === 'space' ? v.space.preset !== 'aus' : v[feld].an);
      const text = (z, v) => (an(z, v) ? `${geraet(art).kurz} ${this.presetName(art, z)}` : t('{kurz} aus', { kurz: geraet(art).kurz }));
      teile.a.push(text(za, va)); teile.b.push(text(zb, vb));
    }
    if (!gleich(va.reihe, vb.reihe)) { teile.a.push(va.reihe.map((x) => geraet(x).kurz).join('→')); teile.b.push(vb.reihe.map((x) => geraet(x).kurz).join('→')); }
    return teile;
  }

  // ---------- Auswahl (Popover am PC, Blatt von unten am Handy) ----------
  wahlZu() {
    const w = this._wahl;
    if (!w) return;
    this._wahl = null;
    w.el.classList.add('raus'); w.grund?.classList.add('raus');
    document.removeEventListener('pointerdown', w.aussen, true);
    document.removeEventListener('keydown', w.taste, true);
    setTimeout(() => { w.el.remove(); w.grund?.remove(); }, ruhig() ? 0 : 200);
  }

  /** gruppen = [{titel, punkte: [{t, info, an, aktion, werkzeug: [{icon, titel, aktion}]}]}], fuss = [{t, aktion}] */
  /**
   * gruppen = [{titel, punkte: [{t, info, an, aktion, werkzeug: [{icon, titel, aktion}], unter: {titel, gruppen, fuss}}]}],
   * fuss = [{t, icon, aktion}]. Punkte mit „unter“ öffnen ein Untermenü im selben Fenster (mit Zurück).
   */
  auswahl(anker, titel, gruppen, fuss = []) {
    this.wahlZu();
    const blatt = schmal();
    const el = document.createElement('div');
    el.className = `fx-wahl${blatt ? ' blatt' : ''}`;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', titel);
    const stapel = [{ titel, gruppen, fuss }];
    let aktionen = [];
    let zeichnen = () => {
      const e = stapel[stapel.length - 1];
      aktionen = [];
      const knopf = (f) => { aktionen.push(f); return aktionen.length - 1; };
      el.innerHTML = `${blatt ? '<div class="fx-wahl-zug"></div>' : ''}<div class="fx-wahl-titel">${stapel.length > 1 ? `<button type="button" class="fx-wahl-zurueck" data-a="${knopf(() => { stapel.pop(); zeichnen(); return true; })}" aria-label="${t('Zurück')}">${icon('zurueckPfeil', 16)}</button>` : ''}<span>${h(e.titel)}</span></div>
        ${e.gruppen.map((g) => `${g.titel ? `<div class="fx-wahl-gr">${h(g.titel)}</div>` : ''}${g.punkte.map((pt) => `<div class="fx-wahl-zeile">
          <button type="button" class="fx-wahl-pt${pt.unter ? ' unter' : ''}" role="${pt.unter ? 'menuitem' : 'menuitemradio'}" ${pt.unter ? '' : `aria-checked="${!!pt.an}"`} data-a="${knopf(pt.unter ? () => { stapel.push(pt.unter); zeichnen(); return true; } : pt.aktion)}"><span class="h">${pt.an ? '✓' : ''}</span><span class="tx"><span class="t">${h(pt.t)}</span>${pt.info ? `<small>${h(pt.info)}</small>` : ''}</span>${pt.unter ? icon('rechts', 15) : ''}</button>
          ${(pt.werkzeug || []).map((w) => `<button type="button" class="fx-wahl-wz" data-a="${knopf(w.aktion)}" aria-label="${h(w.titel)}" title="${h(w.titel)}">${icon(w.icon, 16)}</button>`).join('')}</div>`).join('')}`).join('')}
        ${e.fuss?.length ? `<div class="fx-wahl-trenn"></div>${e.fuss.map((f) => `<button type="button" class="fx-wahl-pt neu" data-a="${knopf(f.aktion)}"><span class="h">${icon(f.icon || 'plus', 15)}</span><span class="t">${h(f.t)}</span></button>`).join('')}` : ''}`;
      el.querySelector('[aria-checked="true"], .fx-wahl-pt')?.focus({ preventScroll: true });
    };
    // Platz: unter dem Anker, wenn es passt, sonst darüber (unten am Anker festgemacht – Untermenüs bleiben dort)
    let oben = null;
    const platzieren = () => {
      if (blatt) return;
      const r = anker.getBoundingClientRect(), b = el.offsetWidth;
      el.style.left = `${clamp(r.left, 8, window.innerWidth - b - 8)}px`;
      if (oben === null) oben = r.bottom + 6 + Math.min(el.scrollHeight, 420) > window.innerHeight - 8 && r.top > window.innerHeight - r.bottom;
      if (oben) { el.style.top = ''; el.style.bottom = `${Math.round(window.innerHeight - r.top + 6)}px`; el.style.maxHeight = `${Math.round(r.top - 14)}px`; }
      else { el.style.bottom = ''; el.style.top = `${Math.round(r.bottom + 6)}px`; el.style.maxHeight = `${Math.round(window.innerHeight - r.bottom - 14)}px`; }
    };
    const zeichnenAlt = zeichnen;
    zeichnen = () => { zeichnenAlt(); platzieren(); };
    const grund = blatt ? document.createElement('div') : null;
    if (grund) { grund.className = 'fx-wahl-grund'; document.body.appendChild(grund); }
    document.body.appendChild(el);
    zeichnen();
    el.addEventListener('click', (e) => {
      const k = e.target.closest('[data-a]');
      if (!k) return;
      const f = aktionen[+k.dataset.a];
      if (!f) return;
      // Untermenü/Zurück: im Fenster bleiben; sonst schließen und ausführen
      const bleibt = k.classList.contains('unter') || k.classList.contains('fx-wahl-zurueck');
      if (bleibt) { f(); return; }
      this.wahlZu();
      f();
    });
    const aussen = (e) => { if (!el.contains(e.target) && !anker.contains(e.target)) { e.stopPropagation(); this.wahlZu(); } };
    const taste = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); if (stapel.length > 1) { stapel.pop(); zeichnen(); } else { this.wahlZu(); anker.focus?.(); } } };
    document.addEventListener('pointerdown', aussen, true);
    document.addEventListener('keydown', taste, true);
    this._wahl = { el, grund, aussen, taste };
  }

  /** Preset-Auswahl eines Geräts (art) oder des ganzen Racks ('rack') */
  presetWahl(anker, art, fertig) {
    const p = this.player;
    const standard = art === 'rack' ? rackStandard(p) : standardPresets(p, art);
    const eigene = this.eigene(art);
    const passend = eigene.find((x) => eigenesPasst(p, art, x.werte)) || null;
    const std = passend ? null : standard.find((x) => x.passt());
    const gruppen = art === 'space' ? [] : [{ titel: art === 'rack' ? t('GANZES RACK') : t('STUFEN'), punkte: standard.map((s) => ({ t: s.name, info: s.info, an: s === std, aktion: async () => { await s.anwenden(); this.merken(art, s.name); fertig?.(); offen?.aktualisieren(); } })) }];
    if (art === 'space' && !eigene.length) gruppen.push({ titel: '', punkte: [{ t: t('Noch keine eigenen Presets'), info: t('Raum und Stärke wählst du vorn'), an: false, aktion: () => {} }] });
    if (eigene.length) gruppen.push({ titel: t('EIGENE'), punkte: eigene.map((x) => ({ t: x.name, an: x === passend, aktion: async () => { await eigenesAnwenden(p, art, x.werte); this.merken(art, x.name); fertig?.(); offen?.aktualisieren(); },
      werkzeug: [
        { icon: 'bearbeiten', titel: t('Umbenennen'), aktion: () => this.umbenennen(x) },
        { icon: 'muell', titel: t('Löschen'), aktion: () => this.loeschen(x) },
      ] })) });
    const titel = art === 'rack' ? t('Gesamt-Preset') : t('{name} · Presets', { name: geraet(art).name });
    this.auswahl(anker, titel, gruppen, [{ t: art === 'rack' ? t('Ganzes Rack speichern …') : t('Aktuelle Einstellung speichern …'), aktion: () => this.speichern(art, fertig) }]);
  }

  async nameFragen(titel, vorschlag = '', knopf = t('Speichern')) {
    let name = null;
    const r = await dialog({
      titel,
      inhalt: `<label class="feld"><span>${t('Name')}</span><input type="text" name="name" maxlength="60" required value="${h(vorschlag)}" autocomplete="off"></label>`,
      knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: knopf, wert: 'ok' }],
    });
    if (r) name = String(r.form.get('name') || '').trim();
    return name || null;
  }

  async speichern(art, fertig) {
    const p = this.player;
    const vorschlag = (this.gewaehlt[art] || '').replace(/\*$/, '');
    const name = await this.nameFragen(art === 'rack' ? t('Ganzes Rack als Preset speichern') : t('{name}: Preset speichern', { name: geraet(art).name }), this.eigene(art).some((x) => x.name === vorschlag) ? vorschlag : '');
    if (!name) return;
    const werte = eigeneWerte(p, art);
    try {
      await api.post('/presets', { art, name, werte });
    } catch (e) {
      if (e.status !== 409) { toast(e.message || t('Speichern fehlgeschlagen'), 'fehler'); return; }
      if (!(await bestaetigen(t('Preset überschreiben?'), t('„{name}“ gibt es schon. Mit der aktuellen Einstellung überschreiben?', { name }), t('Überschreiben')))) return;
      try { await api.post('/presets', { art, name, werte, ersetzen: true }); } catch (e2) { toast(e2.message || t('Speichern fehlgeschlagen'), 'fehler'); return; }
    }
    this.merken(art, name);
    toast(t('Gespeichert: „{name}“ – auf allen deinen Geräten', { name }));
    await this.laden();
    fertig?.();
  }

  async umbenennen(x) {
    const name = await this.nameFragen(t('Preset umbenennen'), x.name, t('Umbenennen'));
    if (!name || name === x.name) return;
    try { await api.put(`/presets/${x.id}`, { name }); } catch (e) { toast(e.message || t('Umbenennen fehlgeschlagen'), 'fehler'); return; }
    if (this.gewaehlt[x.art] === x.name) this.merken(x.art, name);
    await this.laden();
  }

  async loeschen(x) {
    if (!(await bestaetigen(t('Preset löschen?'), t('„{name}“ wird auf allen deinen Geräten gelöscht.', { name: x.name }), t('Löschen'), true))) return;
    try { await api.del(`/presets/${x.id}`); } catch (e) { toast(e.message || t('Löschen fehlgeschlagen'), 'fehler'); return; }
    await this.laden();
  }

  // ---------- Öffnen ----------
  /** Ein Gerät als Flyout an seinem Knopf (am Handy als Blatt von unten); nochmal klicken = schließen */
  flyout(anker, art = 'glow') {
    if (offen && offen.einzel && offen.anker === anker) { offen.schliessen(); return; }
    offen?.schliessen();
    anker?.setAttribute?.('aria-expanded', 'true');
    offen = new RackAnsicht(this, 'einzel', anker, art);
  }

  /** Vollbild: am PC das große Rack, sonst die Karten */
  vollbild(art = null) {
    offen?.schliessen();
    offen = new RackAnsicht(this, gross() ? 'breit' : 'karten', null, art);
    document.querySelector('[data-rack-leiste]')?.setAttribute('aria-pressed', 'true');
  }

  /** Knopf „Effektrack“ in der Leiste: öffnet das Rack, ist es schon offen (Vollbild), schließt er es */
  vollbildUmschalten() {
    if (offen && !offen.einzel && offen.modus !== 'flyout') { offen.schliessen(); return; }
    this.vollbild();
  }

  schliessen() { offen?.schliessen(); }
  get istOffen() { return !!offen; }
}
