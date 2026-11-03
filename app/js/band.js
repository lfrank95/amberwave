// „Band“: Bandmaschine hinter der Röhre, vor Raumklang und EQ (Rechnung in band-worklet.js). Hier: Stufen, Grenzen, Texte.
// Einstellung pro Gerät: { an, stufe: 'fresh'|'worn'|'old'|'eigen', drive, ips, bias, gleichlauf, kopf, mix, vert, auto, hq, rauschen, bezug }
//  drive      0–150 → Ansteuerung des Bands (Aufnahmepegel; über 100 bewusst übertrieben)
//  ips        7.5 | 15 | 30 → Bandgeschwindigkeit: Höhenverlust, Kopfbump-Frequenz, Entzerrung
//  bias       0–100 → Vormagnetisierung: wenig = frühere Sättigung und offene Höhen, viel = sauberer, aber dunkler
//  gleichlauf 0–100 → Wow und Flutter (HQ), 100 ≈ 0,25 % Geschwindigkeitsabweichung
//  kopf       true  → Kopfbump (Bassanhebung je Geschwindigkeit)
//  mix        0–100 → Anteil des Bandsignals (parallel)
//  vert       0–100 → Verteilung der Ansteuerung: Richtung 100 fahren die Seiten bis +9 dB heißer und die Mitte bis −9 dB sanfter ins Gerät, Richtung 0 umgekehrt; danach genau zurück (dsp/gemeinsam.c)
//  auto       true  → Gegenkopplung zur Ansteuerung (Kleinsignal-Verstärkung bleibt 1)
//  bezug      true  → Ansteuerung an die gemessene Lautheit des Titels koppeln (wie bei der Röhre, gleicher Bezugspunkt)
//  hq         true  → innere 8× Rechnung mit Hysterese-Rest, Toleranzen, Gleichlauf, Modulationsrauschen, optional Rauschen
//  rauschen   true  → Bandrauschen (nur HQ)
//  sorte      sm900 | 456 | sm468 → Bandsorte (Datenblatt: MOL/SOL je Geschwindigkeit, Schichtdicke, Rauschen)
//  norm       nab | ccir → Entzerrungsnorm (Zeitkonstante der Höhen-Vorentzerrung)
import { t } from './i18n.js';
import { spNormal, spParameter } from './schwerpunkt.js';
import { qualitaet, innenNormal, innenParameter } from './innenleben.js';
import { ansteuerungFaktor, ansteuerungUmrechnen } from './ansteuerung.js';
const metaInhalt = (n) => (typeof document !== 'undefined' && document.querySelector(`meta[name="${n}"]`)?.content) || '';
const META = (() => { try { return JSON.parse(metaInhalt('aw-band') || '{}'); } catch (e) { return {}; } })();
const VORGABE_STUFE = META.vorgabe || 'aus';
export const BAND_BEZUG_LUFS = Number.isFinite(+META.bezug) ? +META.bezug : -18;
export const BAND_SORTEN = {
  sm900: { name: 'SM 900', kurz: t('modern, viel Headroom – sättigt spät und sauber') },
  '456': { name: '456', kurz: t('der Klassiker – sättigt früher, satter Bass') },
  sm468: { name: 'SM 468', kurz: t('weich, bei 7,5 ips schnell dicht') },
};
export const BAND_SORTEN_REIHE = ['sm900', '456', 'sm468']; // Anzeige-Reihenfolge (Objektschlüssel „456“ würde sonst vorrutschen)
export const BAND_NORMEN = {
  nab: { name: 'NAB', kurz: t('USA, 50 µs – Höhen werden vor dem Band stärker angehoben, sättigen früher') },
  ccir: { name: 'CCIR', kurz: t('Europa/IEC, 35 µs bei 15 ips – offener, Höhen sättigen später') },
};
const VORGABE_SORTE = BAND_SORTEN[META.sorte] ? META.sorte : 'sm900';
const VORGABE_NORM = BAND_NORMEN[META.norm] ? META.norm : 'nab';

export const BAND_STUFEN = {
  fresh: { name: 'Fresh', kurz: t('15 ips, neues Band'), drive: ansteuerungUmrechnen('silk', 30), ips: 15, bias: 55, gleichlauf: 8, kopf: true, mix: 100 },
  worn: { name: 'Worn In', kurz: t('7,5 ips, eingespielt'), drive: ansteuerungUmrechnen('silk', 50), ips: 7.5, bias: 45, gleichlauf: 25, kopf: true, mix: 100 },
  old: { name: 'Old', kurz: t('altes Band, lebt'), drive: ansteuerungUmrechnen('silk', 62), ips: 7.5, bias: 35, gleichlauf: 55, kopf: true, mix: 100 },
};
const STUFEN_FELDER = ['drive', 'ips', 'bias', 'gleichlauf', 'kopf', 'mix'];
export const BAND_IPS = [7.5, 15, 30];

const stufeOderWarm = BAND_STUFEN[VORGABE_STUFE] ? VORGABE_STUFE : 'fresh';
export const BAND_STANDARD = { an: VORGABE_STUFE !== 'aus' && !!BAND_STUFEN[VORGABE_STUFE], stufe: stufeOderWarm, ...BAND_STUFEN[stufeOderWarm], vert: 50, auto: true, bezug: true, skala: 2, hq: false, rauschen: false, sorte: VORGABE_SORTE, norm: VORGABE_NORM };

const clamp = (v, a, b) => Math.max(a, Math.min(b, Number.isFinite(+v) ? +v : a));

export function bandNormal(b) {
  const x = { ...BAND_STANDARD, ...(b || {}) };
  return {
    an: !!x.an,
    stufe: BAND_STUFEN[x.stufe] ? x.stufe : 'eigen',
    drive: Math.round(clamp(b && b.skala !== 2 && b.drive != null ? ansteuerungUmrechnen('silk', b.drive) : x.drive, 0, 150)),   // Klirr-Skala; alte Werte umgerechnet
    skala: 2,
    ips: BAND_IPS.includes(+x.ips) ? +x.ips : 15,
    bias: Math.round(clamp(x.bias, 0, 100)),
    gleichlauf: Math.round(clamp(x.gleichlauf, 0, 100)),
    kopf: x.kopf !== false,
    mix: Math.round(clamp(x.mix, 0, 100)),
    vert: Math.round(clamp(x.vert ?? 50, 0, 100)),
    sp: spNormal(x.sp),   // Sättigungs-Schwerpunkt (schwerpunkt.js)
    auto: true,   // immer an
    bezug: x.bezug !== false,
    q: qualitaet(x),
    hq: qualitaet(x) >= 1,
    ...innenNormal('silk', x),
    rauschen: x.rauschen === true,
    sorte: BAND_SORTEN[x.sorte] ? x.sorte : VORGABE_SORTE,
    norm: BAND_NORMEN[x.norm] ? x.norm : VORGABE_NORM,
  };
}

export function bandStufeErkennen(b) {
  for (const [k, s] of Object.entries(BAND_STUFEN)) {
    if (STUFEN_FELDER.every((f) => (typeof s[f] === 'boolean' ? !!b[f] === s[f] : Math.abs((b[f] ?? -1) - s[f]) <= 1))) return k;
  }
  return null;
}

export function bandStufe(b, stufe) {
  const s = BAND_STUFEN[stufe];
  if (!s) return bandNormal(b);
  const neu = { ...b, skala: 2, stufe };
  for (const f of STUFEN_FELDER) neu[f] = s[f];
  return bandNormal(neu);
}

export function bandWirksam(b) {
  return !!(b && b.an && b.mix > 0);
}

export function bandBezugDb(b, lufsEingang) {
  const x = bandNormal(b);
  if (!x.bezug || !x.auto || lufsEingang == null || !Number.isFinite(lufsEingang)) return 0;
  return Math.max(-12, Math.min(12, BAND_BEZUG_LUFS - lufsEingang));
}

/** Einstellung → Parameter für den Worklet */
export function bandParameter(b, bezugDb = 0) {
  const x = bandNormal(b);
  return {
    drive: ansteuerungFaktor('silk', x.drive) * Math.pow(10, (bezugDb || 0) / 20),   // Klirr-Skala (ansteuerung.js) × Lautheitsbezug
    ips: x.ips,
    bias: x.bias / 100,
    gleichlauf: x.gleichlauf / 100,
    kopf: x.kopf ? 1 : 0,
    mix: x.mix / 100,
    vert: x.vert / 100,
    ...spParameter(x.sp),
    auto: x.auto ? 1 : 0,
    hq: x.hq ? 1 : 0,
    rauschen: x.rauschen ? 1 : 0,
    band: x.sorte,
    norm: x.norm,
    ...innenParameter('silk', x),
  };
}

export function bandKurzText(b) {
  const x = bandNormal(b);
  if (!bandWirksam(x)) return t('Band');
  const s = bandStufeErkennen(x);
  return s ? BAND_STUFEN[s].name : t('Eigen');
}
