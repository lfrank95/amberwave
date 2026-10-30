// „Wärme“: Röhrensättigung vor Raumklang und EQ (Rechnung in waerme-worklet.js). Hier: Stufen, Grenzen, Texte.
// Einstellung pro Gerät: { an, stufe: 'hauch'|'warm'|'glut'|'eigen', drive, charakter, ton, mix, auto }
//  drive     0–150 → Ansteuerung der Kennlinie (0 = kaum, 100 = kräftig, darüber bewusst übertrieben)
//  charakter 0–100 → Arbeitspunkt: mehr = mehr gerade Harmonische (k2), „röhriger“
//  ton       0–100 → Höhen: 0 = unverändert, 100 = samtig (ca. 6 kHz)
//  mix       0–100 → Anteil des gesättigten Signals (Parallelbetrieb erhält die Transienten)
//  vert      0–100 → Verteilung im Stereobild: 0 = Röhre nur in der Mitte, 50 = gleich, 100 = nur auf den Seiten
//  roehre    ax7 | at7 | au7 | sn7 → Röhrentyp (12AX7 heiß, 12AT7 Punch, 12AU7 glatt, 6SN7 breit)
//  schaltung eintakt | gegentakt → Eintakt: gerade Obertöne (H2); Gegentakt: zwei Röhren gegenphasig, gerade Obertöne heben sich auf
//  symm      0–100 → nur Gegentakt: wie gleich die beiden Röhren sind (100 = H2 ganz weg, darunter bleibt ein Rest)
//  hq        true  → echte Röhrenstufe (Koren-Modell, je Takt als Schaltung gelöst: Gitterstrom, Kathodenelko, Koppel-C, Netzteil), 8× Oversampling, ~6-fache Last
//  auto      true  → Gegenkopplung: +3 dB Ansteuerung → −3 dB danach (Kleinsignal-Verstärkung bleibt 1)
//  bezug     true  → Ansteuerung an die gemessene Lautheit des Titels/Albums koppeln: jeder Titel fährt die Röhre gleich an
//                   (Bezugspunkt WAERME_BEZUG_LUFS, Standard −18 LUFS; Korrektur auf ±12 dB begrenzt)
import { t } from './i18n.js';
import { spNormal, spParameter } from './schwerpunkt.js';
const metaInhalt = (n) => (typeof document !== 'undefined' && document.querySelector(`meta[name="${n}"]`)?.content) || '';

export const WAERME_STUFEN = {
  hauch: { name: t('Hauch'), kurz: t('kaum hörbar, etwas Glanz'), drive: 22, charakter: 35, ton: 20, mix: 60, vert: 50 },
  warm: { name: 'Warm', kurz: t('rund und dicht'), drive: 45, charakter: 55, ton: 40, mix: 85, vert: 50 },
  glut: { name: t('Glut'), kurz: t('kräftig, Spitzen schmelzen'), drive: 70, charakter: 75, ton: 60, mix: 100, vert: 50 },
};

const META = (() => { try { return JSON.parse(metaInhalt('aw-waerme') || '{}'); } catch (e) { return {}; } })();
const VORGABE_STUFE = META.vorgabe || 'aus';

/** Röhrentypen: Klangcharakter (Werte der Stufe im Worklet: waerme-worklet.js, ROEHREN) */
export const WAERME_ROEHREN = {
  ax7: { name: '12AX7', kurz: t('Heiß: dicht, viel H2, bei Übersteuerung rau') },
  at7: { name: '12AT7', kurz: t('Punch: direkt, etwas sauberer, schnelle Transienten') },
  au7: { name: '12AU7', kurz: t('Glatt: sehr linear, sanftes H2, spät Kante') },
  sn7: { name: '6SN7', kurz: t('Breit: am saubersten, großer Aussteuerbereich') },
};
export const WAERME_SCHALTUNGEN = {
  eintakt: { name: t('Eintakt'), kurz: t('gerade Obertöne – klassische Röhrenwärme') },
  gegentakt: { name: t('Gegentakt'), kurz: t('ungerade Obertöne – straff, dicht (mit HQ doppelte Rechenlast)') },
};
const VORGABE_ROEHRE = WAERME_ROEHREN[META.roehre] ? META.roehre : 'ax7';
const VORGABE_SCHALTUNG = WAERME_SCHALTUNGEN[META.schaltung] ? META.schaltung : 'eintakt';
export const WAERME_BEZUG_LUFS = Number.isFinite(+META.bezug) ? +META.bezug : -18;

export const WAERME_STANDARD = { an: VORGABE_STUFE !== 'aus' && !!WAERME_STUFEN[VORGABE_STUFE], stufe: WAERME_STUFEN[VORGABE_STUFE] ? VORGABE_STUFE : 'warm', ...WAERME_STUFEN[WAERME_STUFEN[VORGABE_STUFE] ? VORGABE_STUFE : 'warm'], auto: true, bezug: true, roehre: VORGABE_ROEHRE, schaltung: VORGABE_SCHALTUNG, symm: 90 };

const clamp = (v, a, b) => Math.max(a, Math.min(b, Number.isFinite(+v) ? +v : a));

export function waermeNormal(w) {
  const x = { ...WAERME_STANDARD, ...(w || {}) };
  const aus = {
    an: !!x.an,
    stufe: WAERME_STUFEN[x.stufe] ? x.stufe : (x.stufe === 'eigen' ? 'eigen' : 'warm'),
    drive: Math.round(clamp(x.drive, 0, 150)), charakter: Math.round(clamp(x.charakter, 0, 100)),
    ton: Math.round(clamp(x.ton, 0, 100)), mix: Math.round(clamp(x.mix, 0, 100)), vert: Math.round(clamp(x.vert ?? 50, 0, 100)),
    sp: spNormal(x.sp),   // Sättigungs-Schwerpunkt (schwerpunkt.js)
    auto: true,   // immer an (Gegenkopplung zur Ansteuerung)
    bezug: true,  // immer an (Ansteuerung folgt der gemessenen Lautheit)
    hq: x.hq === true,
    roehre: WAERME_ROEHREN[x.roehre] ? x.roehre : VORGABE_ROEHRE,
    schaltung: WAERME_SCHALTUNGEN[x.schaltung] ? x.schaltung : VORGABE_SCHALTUNG,
    symm: Math.round(clamp(x.symm ?? 90, 0, 100)),
  };
  delete aus.name; delete aus.kurz;
  return aus;
}

/** Welche Stufe passt zu den Werten? (null = eigene Einstellung) */
export function waermeStufeErkennen(w) {
  for (const [k, s] of Object.entries(WAERME_STUFEN)) {
    if (['drive', 'charakter', 'ton', 'mix'].every((f) => Math.abs((w[f] ?? -1) - s[f]) <= 1)) return k;
  }
  return null;
}

/** Werte einer Stufe übernehmen */
export function waermeStufe(w, stufe) {
  const s = WAERME_STUFEN[stufe];
  if (!s) return waermeNormal(w);
  return waermeNormal({ ...w, stufe, drive: s.drive, charakter: s.charakter, ton: s.ton, mix: s.mix });
}

export function waermeWirksam(w) {
  return !!(w && w.an && w.mix > 0);
}

/**
 * Korrektur der Ansteuerung in dB aus der Lautheit, die an der Röhre ankommt (LUFS): leise Titel werden stärker, laute
 * schwächer angefahren, damit die Röhre bei jedem Titel gleich arbeitet. null/unbekannt → 0 dB. Begrenzt auf ±12 dB.
 */
export function waermeBezugDb(w, lufsEingang) {
  const x = waermeNormal(w);
  if (!x.bezug || !x.auto || lufsEingang == null || !Number.isFinite(lufsEingang)) return 0;
  return Math.max(-12, Math.min(12, WAERME_BEZUG_LUFS - lufsEingang));
}

/** Einstellung → Parameter für den Worklet (drive als Faktor auf die Kennlinie, bias, ton, mix 0–1); bezugDb = Korrektur der Ansteuerung */
export function waermeParameter(w, bezugDb = 0) {
  const x = waermeNormal(w);
  return {
    drive: 0.6 * Math.pow(10, (x.drive / 100) * 1.1) * Math.pow(10, (bezugDb || 0) / 20),  // 0 → 0,6 … 100 → 7,5 … 150 → 27 (logarithmisch), × Lautheitsbezug
    bias: 0.04 + (x.charakter / 100) * 0.4,              // 0,04 … 0,44
    ton: x.ton / 100,
    mix: x.mix / 100,
    vert: x.vert / 100,
    ...spParameter(x.sp),
    auto: x.auto ? 1 : 0,
    hq: x.hq ? 1 : 0,
    roehre: x.roehre,
    gegentakt: x.schaltung === 'gegentakt' ? 1 : 0,
    symm: x.symm / 100,
  };
}

export function waermeKurzText(w) {
  const x = waermeNormal(w);
  if (!waermeWirksam(x)) return t('Wärme');
  const s = waermeStufeErkennen(x);
  return s ? WAERME_STUFEN[s].name : t('Eigen');
}
