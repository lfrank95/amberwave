// Ansteuerung in dB, wie der Eingangsregler eines echten Geräts: 0 dB ist der Arbeitspunkt – dort fängt das Gerät bei lauten
// Stellen an, hörbar zu färben (gemessen mit der Färbungsanzeige an rosa Rauschen mit −18 LUFS, also genau dem Pegel, auf den
// Einpegeln jeden Titel bringt). Jedes dB darüber oder darunter ist ein echtes dB Verstärkung ins Gerät; danach nimmt Auto-Gain
// genau so viel wieder zurück. Bereich −24 … +24 dB.
// Umrechnung alter Werte, damit sie gleich klingen: skala fehlt = Prozent bis 0.9.1-beta.19 (je Gerät eigene Kurve),
// skala 2 = Prozent auf der Klirr-Skala (nur in Vorabständen von beta.20), skala 3 = dB.
import { zahl } from './i18n.js';

export const DB_MIN = -24, DB_MAX = 24;
/** Ansteuerungsfaktor für den DSP-Kern am Arbeitspunkt (0 dB) */
const NULL_DB = { glow: 1.3595, iron: 17.4704, silk: 2.9876 };

/** skala 2 (Vorabstand): Stellung 0–150 → Faktor, logarithmisch zwischen den Ankern */
const POS = [0, 25, 50, 75, 100, 150];
const ANKER2 = {
  glow: [0.1358, 0.4075, 1.3595, 4.1257, 15.859, 52.7672],
  silk: [0.5, 1.6009, 2.9876, 5.5326, 13.6825, 32.6424],
  iron: [1.0, 10.4158, 17.4704, 25.2179, 36.993, 87.1315],
};
/** bis beta.19: Prozent → Faktor, je Gerät eine eigene Kurve */
const ALT = { glow: (v) => 0.6 * Math.pow(10, (v / 100) * 1.1), silk: (v) => 0.5 * Math.pow(10, (v / 100) * 1.2), iron: (v) => Math.pow(10, v / 100) };

function interp(x, xs, ys) {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]) { const a = (x - xs[i - 1]) / (xs[i] - xs[i - 1]); return ys[i - 1] + a * (ys[i] - ys[i - 1]); }
  return ys[ys.length - 1];
}
const auf = (db) => Math.round(Math.max(DB_MIN, Math.min(DB_MAX, db)) * 2) / 2;

/** dB → Faktor für den DSP-Kern */
export function ansteuerungFaktor(art, db) {
  return NULL_DB[art] * Math.pow(10, (Number.isFinite(+db) ? +db : 0) / 20);
}
/** alter Wert → dB (auf 0,5 dB gerundet), klingt gleich; skala: undefined (bis beta.19) oder 2 */
export function ansteuerungUmrechnen(art, wert, skala) {
  const v = Math.max(0, Math.min(150, +wert || 0));
  const f = skala === 2 ? Math.exp(interp(v, POS, ANKER2[art].map(Math.log))) : ALT[art](v);
  return auf(20 * Math.log10(f / NULL_DB[art]));
}
/** Anzeige am Knopf: „+3,5 dB“ */
export function ansteuerungText(db) {
  const v = +db || 0;
  return `${Math.abs(v) < 0.05 ? '±' : v > 0 ? '+' : '−'}${zahl(Math.abs(v), 1)} dB`;
}
