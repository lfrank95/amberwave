// Kanal-EQ der Lautsprecher (Windows Client): Werte, Filterformeln und Frequenzgang. Die Formeln sind dieselben wie in der
// Engine (RBJ-Cookbook, Butterworth für Hoch-/Tiefpass), damit die Kurve im Fenster zeigt, was wirklich gerechnet wird.
import { t } from './i18n.js';

export const ANZAHL = 8;
/** Typ-Nummern wie in der Engine: 0 Bell, 1 Low-Shelf, 2 High-Shelf, 3 Hochpass, 4 Tiefpass */
export const TYPEN = [['Bell', t('Glocke')], ['Low-Shelf', t('Tiefen-Regal')], ['High-Shelf', t('Höhen-Regal')], [t('Hochpass'), t('Tiefen weg')], [t('Tiefpass'), t('Höhen weg')]];
export const FLANKEN = [6, 12, 18, 24, 36, 48];
export const STD_F = [50, 120, 300, 700, 1500, 3500, 8000, 14000];
/** Kanalpaare, die sich koppeln lassen: Schlüssel → [Kanal, Partner] */
export const PAARE = { LR: ['L', 'R'], LsRs: ['Ls', 'Rs'] };
export const partnerVon = (k) => (k === 'L' ? 'R' : k === 'R' ? 'L' : k === 'Ls' ? 'Rs' : k === 'Rs' ? 'Ls' : null);
export const paarSchluessel = (k) => (k === 'L' || k === 'R' ? 'LR' : k === 'Ls' || k === 'Rs' ? 'LsRs' : null);
export const bandFarbe = (i) => `hsl(${(i * 47 + 24) % 360} 78% 62%)`;

export const neuesBand = (i = 0) => ({ an: false, typ: 0, f: STD_F[i] || 1000, g: 0, q: 1, flanke: 12 });
export const neuerKanal = () => ({ an: true, baender: Array.from({ length: ANZAHL }, (_, i) => neuesBand(i)) });
export const kopie = (o) => JSON.parse(JSON.stringify(o));
const klemme = (v, lo, hi, std) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : std; };

/** Band prüfen (Grenzen wie im Client) */
export function bandNormal(b, i) {
  return {
    an: !!b?.an, typ: Math.round(klemme(b?.typ, 0, TYPEN.length - 1, 0)), f: Math.round(klemme(b?.f, 10, 24000, STD_F[i] || 1000) * 100) / 100,
    g: Math.round(klemme(b?.g, -24, 24, 0) * 10) / 10, q: Math.round(klemme(b?.q, 0.1, 18, 1) * 100) / 100, flanke: FLANKEN.includes(Number(b?.flanke)) ? Number(b.flanke) : 12,
  };
}
/** EQ eines Ausgangs vollständig machen (alle Lautsprecher, Kopplungen) */
export function eqNormal(x, lautsprecher) {
  x.eq = x.eq || {};
  for (const k of ['L', 'R', 'C', 'LFE', 'Ls', 'Rs']) {
    const e = x.eq[k];
    x.eq[k] = { an: e ? e.an !== false : true, baender: Array.from({ length: ANZAHL }, (_, i) => bandNormal(e?.baender?.[i], i)) };
  }
  x.eq_link = { LR: !!x.eq_link?.LR, LsRs: !!x.eq_link?.LsRs };
  x.eq_reserve = klemme(x.eq_reserve, 0, 24, 0);
  return x;
}
export const bandAktiv = (b) => !!b.an && (b.typ >= 3 || Math.abs(b.g) >= 0.005);
export const kanalAktiv = (e) => !!e && e.an && e.baender.some((b) => b.an);

const sektion = (b0, b1, b2, a0, a1, a2) => [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
/** Biquad-Sektionen eines Bandes bei Abtastrate fs (leer = neutral) */
export function sektionen(b, fs) {
  if (!b.an) return [];
  const f = Math.max(10, Math.min(fs * 0.49, b.f)), q = Math.max(0.1, Math.min(30, b.q));
  const w0 = 2 * Math.PI * f / fs, cs = Math.cos(w0), sn = Math.sin(w0);
  if (b.typ === 0) {
    if (Math.abs(b.g) < 0.005) return [];
    const A = 10 ** (b.g / 40), al = sn / (2 * q);
    return [sektion(1 + al * A, -2 * cs, 1 - al * A, 1 + al / A, -2 * cs, 1 - al / A)];
  }
  if (b.typ === 1 || b.typ === 2) {
    if (Math.abs(b.g) < 0.005) return [];
    const A = 10 ** (b.g / 40), al = sn / (2 * q), sa = 2 * Math.sqrt(A) * al;
    return [b.typ === 1
      ? sektion(A * ((A + 1) - (A - 1) * cs + sa), 2 * A * ((A - 1) - (A + 1) * cs), A * ((A + 1) - (A - 1) * cs - sa), (A + 1) + (A - 1) * cs + sa, -2 * ((A - 1) + (A + 1) * cs), (A + 1) + (A - 1) * cs - sa)
      : sektion(A * ((A + 1) + (A - 1) * cs + sa), -2 * A * ((A - 1) + (A + 1) * cs), A * ((A + 1) + (A - 1) * cs - sa), (A + 1) - (A - 1) * cs + sa, 2 * ((A - 1) - (A + 1) * cs), (A + 1) - (A - 1) * cs - sa)];
  }
  const hoch = b.typ === 3, n = Math.max(1, Math.min(8, Math.round(b.flanke / 6))), o = [];
  for (let k = 1; k <= Math.floor(n / 2) && o.length < 4; k++) {
    const qk = n === 2 ? q : 1 / (2 * Math.sin(Math.PI * (2 * k - 1) / (2 * n))), al = sn / (2 * qk);
    o.push(hoch ? sektion((1 + cs) / 2, -(1 + cs), (1 + cs) / 2, 1 + al, -2 * cs, 1 - al) : sektion((1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + al, -2 * cs, 1 - al));
  }
  if (n % 2 && o.length < 4) {
    const K = Math.tan(w0 / 2);
    o.push(hoch ? [1 / (1 + K), -1 / (1 + K), 0, (K - 1) / (1 + K), 0] : [K / (1 + K), K / (1 + K), 0, (K - 1) / (1 + K), 0]);
  }
  return o;
}
/** Betrag einer Sektion in dB bei Frequenz f */
function sektionDb(c, f, fs) {
  const w = 2 * Math.PI * f / fs, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c[0] + c[1] * c1 + c[2] * c2, ni = -(c[1] * s1 + c[2] * s2);
  const dr = 1 + c[3] * c1 + c[4] * c2, di = -(c[3] * s1 + c[4] * s2);
  return 10 * Math.log10(Math.max(1e-30, (nr * nr + ni * ni) / (dr * dr + di * di)));
}
/** Frequenzgang (dB) eines Bandes bzw. aller Bänder eines Kanals; fs nur für die Darstellung (Engine rechnet in der echten Rate) */
export const bandDb = (b, f, fs = 96000) => sektionen(b, fs).reduce((s, c) => s + sektionDb(c, f, fs), 0);
export const kanalDb = (e, f, fs = 96000) => (e && e.an ? e.baender.reduce((s, b) => s + bandDb(b, f, fs), 0) : 0);
/** höchste Anhebung eines Kanals (dB, ≥ 0) – Grundlage für die Reserve gegen Übersteuern */
export function spitzeDb(e, fs = 96000) {
  if (!kanalAktiv(e)) return 0;
  let m = 0;
  for (let i = 0; i <= 480; i++) m = Math.max(m, kanalDb(e, 10 * Math.pow(2400, i / 480), fs));
  return m;
}
/** Reserve eines Ausgangs: größte Anhebung aller Lautsprecher, aufgerundet auf 0,1 dB (alle Kanäle gleich abgesenkt, Balance bleibt) */
export function reserveVon(x, lautsprecher) {
  const m = Math.max(0, ...lautsprecher.map((k) => spitzeDb(x.eq?.[k])));
  return Math.min(24, Math.ceil(m * 10 - 1e-9) / 10);
}
export const aktivAnzahl = (e) => (e && e.an ? e.baender.filter((b) => b.an).length : 0);
