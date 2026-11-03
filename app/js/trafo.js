// „AmberIron“: Übertrager hinter der Röhre, vor dem Band (Rechnung in trafo-worklet.js). Hier: Stufen, Kerne, Grenzen, Texte.
// Einstellung pro Gerät: { an, stufe: 'hauch'|'satt'|'schwer'|'eigen', kern, drive, glanz, mix, hq, auto, bezug }
//  kern   nickel | stahl | eisen → Kernmaterial: Nickel sättigt spät und hart (klar, offen), Stahl mittel (satter Bass,
//         etwas Glanz), Eisen früh und weich (Ausgangsübertrager: dicht, rund, etwas dunkler oben)
//  drive  0–150 → Ansteuerung (wie heiß der Übertrager gefahren wird); wirkt fast nur im Bass – so arbeitet ein Kern
//  glanz  0–100 → oberste Oktave: 0 = runder, 100 = offener (±1 dB um den Kern-Charakter)
//  quelle auto | nieder | studio | roehre → was den Übertrager treibt: der Innenwiderstand der Quelle bestimmt (physikalisch),
//         wie viel Klirr und Bassabfall entstehen. auto = Röhre, wenn AmberGlow an ist, sonst Studio (600 Ω)
//  mix    0–100 → Anteil des Übertragersignals (parallel)
//  vert   0–100 → Verteilung der Ansteuerung: Richtung 100 fahren die Seiten bis +9 dB heißer und die Mitte bis −9 dB sanfter ins Gerät, Richtung 0 umgekehrt; danach genau zurück (dsp/gemeinsam.c)
//  hq     true  → Hysterese mit Gedächtnis (Play-Operatoren): feiner Klirr auch bei leisen Signalen, Nebenschleifen, Toleranzen L/R
//  auto   true  → Ansteuerung wird hinter dem Kern herausgerechnet (gleich laut, nur dichter) – immer an
//  bezug  true  → Ansteuerung folgt der gemessenen Lautheit (wie Glow und Silk) – immer an
import { t } from './i18n.js';
import { spNormal, spParameter } from './schwerpunkt.js';
import { qualitaet, innenNormal, innenParameter } from './innenleben.js';
import { ansteuerungFaktor, ansteuerungUmrechnen } from './ansteuerung.js';
const metaInhalt = (n) => (typeof document !== 'undefined' && document.querySelector(`meta[name="${n}"]`)?.content) || '';
const META = (() => { try { return JSON.parse(metaInhalt('aw-trafo') || '{}'); } catch (e) { return {}; } })();
const VORGABE_STUFE = META.vorgabe || 'aus';
const VORGABE_KERN = ['nickel', 'stahl', 'eisen', 'mumetall', 'amorph'].includes(META.kern) ? META.kern : 'stahl';
export const TRAFO_BEZUG_LUFS = Number.isFinite(+META.bezug) ? +META.bezug : -18;

// Ansteuerung auf der Klirr-Skala (Stahl, Studio, −18 LUFS): Hauch ≈ 0,3 %, Satt ≈ 1,2 %, Schwer ≈ 3 % – bis beta.19 lagen alle drei unter 0,1 %
/** Ansteuerung der Stufen bis beta.19 (alte Skala) */
const ALT_STUFEN = { hauch: 25, satt: 50, schwer: 75 };
export const TRAFO_STUFEN = {
  hauch: { name: t('Hauch'), kurz: t('nur ganz unten etwas dichter'), drive: 30, mix: 100 },
  satt: { name: t('Satt'), kurz: t('fester Bass, dichte Mitten'), drive: 60, mix: 100 },
  schwer: { name: t('Schwer'), kurz: t('heiß gefahren, Bass verdichtet'), drive: 80, mix: 100 },
};
export const TRAFO_QUELLEN = {
  auto: { name: 'Auto', kurz: t('Röhre, wenn AmberGlow an ist, sonst Studio') },
  nieder: { name: t('Niederohmig'), kurz: t('Operationsverstärker: fast kein Klirr, kein Bassabfall') },
  studio: { name: 'Studio', kurz: t('600 Ω: der normale Fall') },
  roehre: { name: t('Röhre'), kurz: t('hochohmige Röhrenstufe: mehr Klirr, etwas Bassabfall') },
};
export const TRAFO_KERNE = {
  nickel: { name: 'Nickel', kurz: t('klar und schnell – sättigt spät, dann deutlich') },
  stahl: { name: t('Stahl'), kurz: t('satter Bass, etwas Glanz – der Pult-Klassiker') },
  eisen: { name: t('Eisen'), kurz: t('früh und weich, rund – wie ein Ausgangsübertrager') },
  mumetall: { name: t('Mu-Metall'), kurz: t('sehr sauber bis zum Knie, dann recht plötzlich – Mikrofon-Übertrager') },
  amorph: { name: t('Amorph'), kurz: t('kaum Hysterese, sehr offen – moderne Bandkerne') },
};
const STUFEN_FELDER = ['drive', 'mix'];

const stufeOderSatt = TRAFO_STUFEN[VORGABE_STUFE] ? VORGABE_STUFE : 'satt';
export const TRAFO_STANDARD = { an: VORGABE_STUFE !== 'aus' && !!TRAFO_STUFEN[VORGABE_STUFE], stufe: stufeOderSatt, ...TRAFO_STUFEN[stufeOderSatt], kern: VORGABE_KERN, glanz: 50, vert: 50, auto: true, bezug: true, skala: 2, hq: false };

const clamp = (v, a, b) => Math.max(a, Math.min(b, Number.isFinite(+v) ? +v : a));

export function trafoNormal(t) {
  const x = { ...TRAFO_STANDARD, ...(t || {}) };
  return {
    an: !!x.an,
    stufe: TRAFO_STUFEN[x.stufe] ? x.stufe : 'eigen',
    kern: TRAFO_KERNE[x.kern] ? x.kern : 'stahl',
    quelle: TRAFO_QUELLEN[x.quelle] ? x.quelle : 'auto',
    drive: Math.round(clamp(t && t.skala !== 2 && t.drive != null ? (TRAFO_STUFEN[t.stufe] && Math.abs(t.drive - ALT_STUFEN[t.stufe]) <= 1 ? TRAFO_STUFEN[t.stufe].drive : ansteuerungUmrechnen('iron', t.drive)) : x.drive, 0, 150)),   // Klirr-Skala; alte Werte umgerechnet
    skala: 2,
    glanz: Math.round(clamp(x.glanz, 0, 100)),
    mix: Math.round(clamp(x.mix, 0, 100)),
    vert: Math.round(clamp(x.vert ?? 50, 0, 100)),
    sp: spNormal(x.sp),   // Sättigungs-Schwerpunkt (schwerpunkt.js)
    auto: true,
    bezug: x.bezug !== false,
    q: qualitaet(x),
    hq: qualitaet(x) >= 1,
    ...innenNormal('iron', x),
  };
}

export function trafoStufeErkennen(t) {
  for (const [k, s] of Object.entries(TRAFO_STUFEN)) {
    if (STUFEN_FELDER.every((f) => Math.abs((t[f] ?? -1) - s[f]) <= 1)) return k;
  }
  return null;
}

export function trafoStufe(t, stufe) {
  const s = TRAFO_STUFEN[stufe];
  if (!s) return trafoNormal(t);
  const neu = { ...t, skala: 2, stufe };
  for (const f of STUFEN_FELDER) neu[f] = s[f];
  return trafoNormal(neu);
}

export function trafoWirksam(t) {
  return !!(t && t.an && t.mix > 0);
}

export function trafoBezugDb(t, lufsEingang) {
  const x = trafoNormal(t);
  if (!x.bezug || !x.auto || lufsEingang == null || !Number.isFinite(lufsEingang)) return 0;
  return Math.max(-12, Math.min(12, TRAFO_BEZUG_LUFS - lufsEingang));
}

/**
 * Einstellung → Parameter für den Worklet (drive: 0 → 1 … 50 → 3,2 … 100 → 10 … 150 → 32, × Lautheitsbezug).
 * glowAn: treibt die Röhre den Übertrager? (für quelle = auto)
 */
export function trafoParameter(t, bezugDb = 0, glowAn = false) {
  const x = trafoNormal(t);
  return {
    drive: ansteuerungFaktor('iron', x.drive) * Math.pow(10, (bezugDb || 0) / 20),
    kern: x.kern,
    quelle: x.quelle === 'auto' ? (glowAn ? 'roehre' : 'studio') : x.quelle,
    glanz: x.glanz / 100,
    mix: x.mix / 100,
    vert: x.vert / 100,
    ...spParameter(x.sp),
    auto: x.auto ? 1 : 0,
    hq: x.hq ? 1 : 0,
    ...innenParameter('iron', x),
  };
}

export function trafoKurzText(tr) {
  const x = trafoNormal(tr);
  if (!trafoWirksam(x)) return 'Iron';
  const s = trafoStufeErkennen(x);
  return `${s ? TRAFO_STUFEN[s].name : t('Eigen')} · ${TRAFO_KERNE[x.kern].name}`;
}
