// Equalizer: 4 Bänder – Band 1 und 4 als Shelf (Standard) oder Glocke umschaltbar, zwei vollparametrische Glocken – plus Gain.
// Filterentwurf: „matched“ Biquads (eq-design.js), gerechnet im eigenen Worklet (eq-worklet.js) in doppelter Genauigkeit.
// Gain: immer automatisch (so viel absenken, wie die Kurve maximal anhebt – kann nicht übersteuern).
import { bandKoeffizienten, koeffDb } from './eq-design.js';
import { passivSektionen } from './eq-passiv.js';
import { t, locale } from './i18n.js';

export const GAIN_MAX = 15;          // je Band ±
export const GESAMT_MIN = -24, GESAMT_MAX = 12;
export const Q_GRENZEN = { peaking: [0.3, 10], lowshelf: [0.3, 2], highshelf: [0.3, 2] };
export const F_GRENZEN = { peaking: [20, 20000], lowshelf: [20, 5000], highshelf: [500, 20000] };

/** Modus: praezise = je Band ein „matched“ Biquad in Reihe (genau das, was eingestellt ist); passiv = Netzwerk wie ein passiver Mastering-EQ (eq-passiv.js) */
export const EQ_MODI = { praezise: 'Digital', passiv: 'Analog' };
export const SEKTIONEN = 8; // Biquads im Worklet (passiv braucht bis zu 8)

export const EQ_STANDARD = {
  an: false,
  modus: 'praezise',
  gain: { auto: true, db: 0 },
  baender: [
    { typ: 'lowshelf', an: true, f: 100, g: 0, q: 0.707 },
    { typ: 'peaking', an: true, f: 400, g: 0, q: 1 },
    { typ: 'peaking', an: true, f: 3000, g: 0, q: 1 },
    { typ: 'highshelf', an: true, f: 8000, g: 0, q: 0.707 },
  ],
};

export const BAND_NAMEN = [t('Tiefen'), t('Band {n}', { n: 2 }), t('Band {n}', { n: 3 }), t('Höhen')];
/** Erlaubte Filtertypen je Band (erstes = Standard): Tiefen und Höhen wahlweise als Glocke */
export const BAND_TYPEN = [['lowshelf', 'peaking'], ['peaking'], ['peaking'], ['highshelf', 'peaking']];

/** Einstellung prüfen/vervollständigen (alte oder kaputte Werte → Standard) */
export function eqNormal(eq) {
  const s = JSON.parse(JSON.stringify(EQ_STANDARD));
  if (!eq || typeof eq !== 'object') return s;
  s.an = !!eq.an;
  s.modus = EQ_MODI[eq.modus] ? eq.modus : 'praezise';
  s.gain = { auto: true, db: 0 }; // Gain immer automatisch
  (eq.baender || []).slice(0, 4).forEach((b, i) => {
    const z = s.baender[i];
    if (!b) return;
    if (BAND_TYPEN[i].includes(b.typ)) z.typ = b.typ;
    z.an = true; // Bänder lassen sich nicht mehr einzeln abschalten (der alte EQ-Dialog konnte das – solche Bänder wirkten unsichtbar nicht)
    const f = Number(b.f), g = Number(b.g), q = Number(b.q);
    const [fmin, fmax] = F_GRENZEN[z.typ], [qmin, qmax] = Q_GRENZEN[z.typ];
    if (isFinite(f)) z.f = Math.max(fmin, Math.min(fmax, f));
    if (isFinite(g)) z.g = Math.max(-GAIN_MAX, Math.min(GAIN_MAX, g));
    if (isFinite(q)) z.q = Math.max(qmin, Math.min(qmax, q));
  });
  return s;
}

/** Ist der EQ im Signalweg? (an und ein Band ≠ 0 dB oder Gain ≠ 0) */
export function eqWirksam(eq) {
  if (!eq?.an) return false;
  return eq.baender.some((b) => b.an && Math.abs(b.g) >= 0.05) || (!eq.gain?.auto && Math.abs(eq.gain?.db || 0) >= 0.05);
}

/** Biquad-Sektionen je nach Modus (präzise: eine je Band; passiv: das Netzwerk) */
export function eqSektionen(eq, sr) {
  if (eq.modus === 'passiv') return passivSektionen(eq.baender, sr);
  return eq.baender.map((b) => bandKoeffizienten(b, sr));
}

/** Koeffizienten für den Worklet (flach, SEKTIONEN × [b0 b1 b2 a1 a2], Rest neutral) */
export function eqKoeffizienten(eq, sr) {
  const aus = [];
  for (const k of eqSektionen(eq, sr).slice(0, SEKTIONEN)) aus.push(k.b0, k.b1, k.b2, k.a1, k.a2);
  while (aus.length < SEKTIONEN * 5) aus.push(1, 0, 0, 0, 0);
  return aus;
}

/** Kurve nur der Bänder in dB (ohne Gain) */
export function eqBaenderDb(eq, f, sr = 48000, sektionen = null) {
  let s = 0;
  for (const k of sektionen || eqSektionen(eq, sr)) s += koeffDb(k, f, sr);
  return s;
}

/** Wirksamer Gain in dB: automatisch = −(größte Anhebung der Bänder), sonst von Hand */
export function eqGainDb(eq, sr = 48000) {
  if (!eq?.an) return 0;
  if (!eq.gain?.auto) return eq.gain?.db || 0;
  let max = 0;
  const ks = eqSektionen(eq, sr);
  for (let i = 0; i <= 300; i++) {
    const f = 20 * Math.pow(1000, i / 300);
    const s = eqBaenderDb(eq, f, sr, ks);
    if (s > max) max = s;
  }
  return -max;
}

export function freqText(f) {
  return f >= 1000 ? `${(f / 1000).toLocaleString(locale, { maximumFractionDigits: f >= 10000 ? 1 : 2 })} kHz` : `${Math.round(f)} Hz`;
}

export function eqKurzText(eq) {
  if (!eqWirksam(eq)) return '';
  const teile = eq.baender.filter((b) => b.an && Math.abs(b.g) >= 0.05)
    .map((b) => `${b.g > 0 ? '+' : ''}${b.g.toLocaleString(locale, { maximumFractionDigits: 1 })} dB @ ${freqText(b.f)}`);
  const g = eqGainDb(eq);
  if (Math.abs(g) >= 0.05) teile.push(`Gain ${g > 0 ? '+' : ''}${g.toLocaleString(locale, { maximumFractionDigits: 1 })} dB${eq.gain.auto ? ' (auto)' : ''}`);
  return teile.join(', ');
}
