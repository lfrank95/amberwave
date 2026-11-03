// Ansteuerung, auf Klirr geeicht: dieselbe Stellung ergibt bei allen drei Geräten ungefähr denselben Klirr – gemessen mit der
// Färbungsanzeige des Racks an rosa Rauschen mit −18 LUFS, also genau dem Pegel, auf den Einpegeln jeden Titel bringt.
//   0 % ≈ sauber · 25 % ≈ 0,3 % · 50 % ≈ 1 % · 75 % ≈ 3 % · 100 % ≈ 10 % · 150 % = so viel, wie das Gerät hergibt
// Zwischen den Ankern wird logarithmisch interpoliert. Bis 0.9.1-beta.18 hatte jedes Gerät seine eigene Kurve (skala 1);
// alte Werte rechnet ansteuerungUmrechnen() so um, dass sie genau gleich klingen.
// Messung: dsp-Kern, HQ, Standardeinstellungen (Glow Charakter 55 %, Iron Stahl/Studio, Silk 15 ips SM 900 NAB).
import { t, zahl } from './i18n.js';

const POS = [0, 25, 50, 75, 100, 150];
/** Ansteuerungsfaktor (wie ihn der DSP-Kern erwartet) an den Ankerstellungen */
const ANKER = {
  glow: [0.1358, 0.4075, 1.3595, 4.1257, 15.859, 52.7672],
  silk: [0.5, 1.6009, 2.9876, 5.5326, 13.6825, 32.6424],
  iron: [1.0, 10.4158, 17.4704, 25.2179, 36.993, 87.1315],
};
/** gemessene Kurve: Faktor → Klirr (%) bei −18 LUFS */
const KURVE = {
  glow: [[0.1, 0.074], [0.1417, 0.104], [0.2007, 0.148], [0.2843, 0.209], [0.4027, 0.296], [0.5704, 0.42], [0.8081, 0.595], [1.1447, 0.842], [1.6216, 1.192], [2.2971, 1.686], [3.2541, 2.379], [4.6096, 3.343], [6.5299, 4.638], [9.2502, 6.242], [13.1037, 8.372], [18.5625, 11.578], [26.2954, 15.233], [37.2496, 17.696], [52.7672, 18.054], [74.7492, 16.52], [105.8885, 13.852], [150.0, 10.776]],
  silk: [[0.05, 0.0], [0.0732, 0.001], [0.1072, 0.001], [0.1569, 0.003], [0.2298, 0.006], [0.3364, 0.013], [0.4925, 0.029], [0.7211, 0.062], [1.0558, 0.132], [1.5458, 0.28], [2.2633, 0.59], [3.3137, 1.218], [4.8517, 2.422], [7.1035, 4.509], [10.4004, 7.578], [15.2275, 11.142], [22.2949, 14.13], [32.6424, 15.554], [47.7925, 15.161], [69.974, 13.386], [102.4505, 10.885], [150.0, 8.18]],
  iron: [[0.5, 0.0], [0.656, 0.001], [0.8608, 0.001], [1.1294, 0.002], [1.4818, 0.005], [1.9443, 0.009], [2.551, 0.016], [3.3472, 0.028], [4.3917, 0.049], [5.7623, 0.086], [7.5605, 0.151], [9.92, 0.269], [13.0157, 0.491], [17.0776, 0.938], [22.407, 2.005], [29.3997, 5.061], [38.5745, 11.321], [50.6126, 19.429], [66.4074, 26.142], [87.1315, 29.054], [114.3229, 28.58], [150.0, 25.692]],
};
/** die alten, je Gerät verschiedenen Kurven (skala 1) */
const ALT = { glow: (v) => 0.6 * Math.pow(10, (v / 100) * 1.1), silk: (v) => 0.5 * Math.pow(10, (v / 100) * 1.2), iron: (v) => Math.pow(10, v / 100) };

const ln = Math.log;
function interp(x, xs, ys) {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]) { const a = (x - xs[i - 1]) / (xs[i] - xs[i - 1]); return ys[i - 1] + a * (ys[i] - ys[i - 1]); }
  return ys[ys.length - 1];
}

/** Stellung 0–150 → Faktor für den DSP-Kern */
export function ansteuerungFaktor(art, pos) {
  const a = ANKER[art];
  return Math.exp(interp(Math.max(0, Math.min(150, +pos || 0)), POS, a.map(ln)));
}
/** Faktor → Stellung (Umkehrung, begrenzt auf 0–150) */
export function ansteuerungStellung(art, faktor) {
  const a = ANKER[art];
  return Math.max(0, Math.min(150, interp(ln(Math.max(1e-6, faktor)), a.map(ln), POS)));
}
/** alter Wert (skala 1) → neue Stellung, klingt identisch */
export function ansteuerungUmrechnen(art, alt) {
  return Math.round(ansteuerungStellung(art, ALT[art](Math.max(0, Math.min(150, +alt || 0)))));
}
/** erwarteter Klirr (%) bei lauten Stellen (−18 LUFS nach Einpegeln) */
export function ansteuerungKlirr(art, pos) {
  const k = KURVE[art], f = ln(ansteuerungFaktor(art, pos));
  return interp(f, k.map((x) => ln(x[0])), k.map((x) => x[1]));
}
/** in Worten */
export function ansteuerungWort(klirr) {
  return klirr < 0.15 ? t('sauber') : klirr < 0.5 ? t('Hauch') : klirr < 1.7 ? t('warm') : klirr < 5 ? t('dicht') : klirr < 13 ? t('angezerrt') : t('heiß');
}
/** Anzeige unter dem Knopf: „warm · 1 %“ (erwarteter Klirr bei lauten Stellen) */
export function ansteuerungText(art, pos) {
  const k = ansteuerungKlirr(art, pos);
  return `${ansteuerungWort(k)} · ${k < 0.1 ? '<0,1' : zahl(k, k < 1 ? 1 : 0)} %`;
}
