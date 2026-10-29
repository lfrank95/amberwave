// Röhrensättigung im Audio-Thread („Wärme“). Sitzt direkt hinter der Quelle – vor Raumklang und EQ – und färbt das Stereo-Signal
// wie eine Trioden-Vorstufe: weiche Kompression der Spitzen, gerade Harmonische (k2) durch Arbeitspunkt-Verschiebung, etwas
// samtigere Höhen. Damit nichts rau klingt, läuft die Kennlinie mit 4-fachem Oversampling (Kaiser-FIR hoch und runter) –
// erst dadurch bleiben die Obertöne da, wo sie hingehören, statt als Aliasing zurückzufalten.
// Auto-Gain: reine Gegenkopplung zur Ansteuerung – was vorne mehr in die Röhre geht, wird hinten wieder herausgenommen
// (+3 dB Ansteuerung → −3 dB danach, bezogen auf die Kleinsignal-Verstärkung der Stufe am Arbeitspunkt). Keine Regelung,
// kein Pumpen: die Sättigung selbst darf die Spitzen hörbar zusammendrücken.
// Stereo wird in Mitte/Seite gerechnet: jede Ebene hat ihre eigene Röhre, Kompression der lauten Mitte drückt so nie die
// Seiten zusammen (das Stereobild bleibt auch bei kräftiger Sättigung gleich breit). Verteilung: 0 = Röhre nur in der Mitte,
// 0,5 = beide gleich angefahren, 1 = Röhre nur auf den Seiten – dort wird die (meist leisere) Seite bis +9 dB stärker
// angefahren, damit sie hörbar Obertöne bekommt. Jede Ebene hat ihren eigenen Auto-Gain, der Pegel bleibt.
//
// Standard: statische Trioden-Kennlinie (zwei tanh-Hälften, oben weicher als unten) – sparsam.
// HQ: eine echte 12AX7-Stufe wird je Takt gelöst (Koren-Gleichungen, Newton-Verfahren) – keine Kennlinie, sondern Schaltung:
//  – Anodenwiderstand 100 kΩ an 300 V, Kathodenwiderstand (Arbeitspunkt = „Charakter“: heiß → nah am Gitterstrom, kalt → nah
//    am Sperrbereich) mit großem Kathodenelko, Koppelkondensator am Gitter mit 1 MΩ Ableitwiderstand, Quelle 10 kΩ
//  – Gitterstrom: wird das Gitter positiver als etwa −0,7 V, fließt Strom (2 kΩ innen); er belastet die Quelle (Spitzen
//    werden weich gekappt) und lädt den Koppelkondensator auf – der Arbeitspunkt wandert nach lauten Passagen kurz Richtung
//    Sperrbereich und kehrt mit ~70 ms zurück („Atmen“ der Stufe, Blocking bei Übersteuerung)
//  – Netzteil: 4,7 kΩ/47 µF Siebung – bei hohem Strombedarf sackt die Versorgung leicht (Sag)
//  – Arbeitspunkt-Verschiebung und Kathoden-Gegenkopplung entstehen von selbst aus der Schaltung, ebenso das Verhältnis k2 : k3
//  – „perfekt unperfekt“: Bauteiltoleranzen je Ebene (Kathodenwiderstand ±3 %, Versorgung ±2 %, Ansteuerung ±0,3 dB, Tonblende
//    ±4 %), die über Minuten langsam driften (Erwärmung)
//  Der Frequenzgang bleibt linear: Koppel- und Kathodenkondensator sind so groß, dass unter 40 Hz höchstens 0,1 dB fehlen,
//  die Miller-Kapazität läge weit über dem Hörbereich und wird nicht gerechnet.
const STAND = '2';
// Oversampling richtet sich nach der Abtastrate des Geräts: Ziel ist eine innere Rate von ~192 kHz (Standard) bzw. ~384 kHz (HQ,
// mit dem inneren 2×) – bei 48 kHz also 4×, bei 96 kHz 2×, bei 192 kHz gar nicht mehr (dort wäre 8× nur Rechenlast ohne Nutzen)
const OS = sampleRate >= 150000 ? 1 : sampleRate >= 75000 ? 2 : 4;
const TAPS = OS === 1 ? 1 : 40 * OS + 1; // OS·m + 1 (Gesamtverzögerung ganzzahlig); Kaiser-Tiefpass bei fs/2 des Originals; 1 = durchreichen
const PH = Math.ceil(TAPS / OS); // Taps je Polyphase beim Hochtasten (letzter Koeffizient mit Nullen aufgefüllt)
const VERZ = (TAPS - 1) / OS; // Verzögerung des nassen Wegs in Samples (Hoch- + Abwärtstastung) – der trockene Weg wird gleich verzögert
// HQ: Gitterstrom und Sperrbereich haben Knie, deren hohe Obertöne bei heißer Ansteuerung selbst mit 4× noch zurückspiegeln
// (15 kHz bei −3 dBFS in „Glut“: −67 dB). Darum läuft die Stufe in HQ mit weiteren 2× (intern 8×) über ein Halbband-Filter
// (25 Taps, Kaiser β = 10: Durchlass bis 24 kHz flach, Sperre −97 dB). Laufzeit 24 Takte = genau 3 Samples.
const HB_L = 25, HB_VERZ = 3, HB_MITTE = (HB_L - 1) / 2;
const HB = (() => {
  const m = (HB_L - 1) / 2, h = new Float64Array(HB_L), beta = 10;
  let summe = 0;
  for (let i = 0; i < HB_L; i++) {
    const n = i - m;
    const sinc = n === 0 ? 0.5 : (n % 2 === 0 ? 0 : Math.sin(Math.PI * n / 2) / (Math.PI * n));
    const r = (2 * i) / (HB_L - 1) - 1;
    h[i] = sinc * besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / besselI0(beta);
    summe += h[i];
  }
  for (let i = 0; i < HB_L; i++) h[i] /= summe;
  return h;
})();
const HB_UNGERADE = []; for (let i = 1; i < HB_L; i += 2) HB_UNGERADE.push(i);
const TROCKEN_L = VERZ + HB_VERZ + 1;

function besselI0(x) {
  let s = 1, t = 1;
  for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; }
  return s;
}
/**
 * Hoch-/Abwärtstastung: Kaiser-gefensterter sinc, Grenze genau bei der halben Original-Abtastrate (bei 48 kHz: 24 kHz).
 * Der Übergang liegt symmetrisch darum – unten bleibt der Hörbereich bis ~20 kHz unangetastet, oben ist ab ~28 kHz
 * gesperrt (was dazwischen liegt, spiegelt nur in den Bereich über 20 kHz zurück).
 */
function firEntwurf() {
  const h = new Float64Array(PH * OS);
  const m = (TAPS - 1) / 2, fc = 0.5 / OS, beta = 8;
  const i0b = besselI0(beta);
  let summe = 0;
  for (let i = 0; i < TAPS; i++) {
    const n = i - m;
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    const r = TAPS > 1 ? (2 * i) / (TAPS - 1) - 1 : 0;
    h[i] = sinc * besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b;
    summe += h[i];
  }
  for (let i = 0; i < TAPS; i++) h[i] /= summe;
  return h;
}

/** tanh als Padé-Näherung (Fehler < 1e-6 bis |x| ≈ 3, danach geklemmt) – deutlich schneller als Math.tanh */
function th(x) {
  if (x > 4.97) return 1;
  if (x < -4.97) return -1;
  const x2 = x * x;
  return x * (135135 + x2 * (17325 + x2 * (378 + x2))) / (135135 + x2 * (62370 + x2 * (3150 + 28 * x2)));
}

/**
 * Form der Standard-Kennlinie (je Röhre): zwei tanh-Hälften (ap = Rundung oben, an = unten), bs = Faktor auf den Arbeitspunkt.
 * Gegentakt (pp): ½·(g(u) − m·g(−u)) – m = Symmetrie: bei 1 fallen alle geraden Anteile heraus, bei 0 bleibt eine Röhre.
 */
function klRoh(k, v) { return v >= 0 ? th(v * k.ap) / k.ap : th(v * k.an) / k.an; }

/** Ruhewert der Kennlinie am Arbeitspunkt (wird abgezogen, damit ohne Signal kein Gleichanteil entsteht) */
const biasEff = (k, bias) => (bias >= 0 ? bias * k.bs : bias);
function ruhe(k, bias) { return klRoh(k, biasEff(k, bias)); }

/** Statische Trioden-Kennlinie (Standard): weiche Sättigung mit Arbeitspunkt (bias) – oben rundet sie früher ab als unten */
function kennlinie(k, u, bias, s0 = ruhe(k, bias)) {
  const b = biasEff(k, bias), g = klRoh(k, u + b) - s0;
  if (!k.pp) return g;
  return 0.5 * (g - k.m * (klRoh(k, b - u) - s0));
}

/** Stammfunktion der Kennlinie (für ADAA): ∫ tanh(a·v)/a dv = ln(cosh(a·v))/a² – beide Hälften treffen sich glatt bei 0 */
function lnCosh(x) { const a = Math.abs(x); return a > 20 ? a - Math.LN2 : Math.log(Math.cosh(a)); }
function stammRoh(k, v) { return v >= 0 ? lnCosh(v * k.ap) / (k.ap * k.ap) : lnCosh(v * k.an) / (k.an * k.an); }
function kennlinieStamm(k, u, bias) {
  const b = biasEff(k, bias);
  if (!k.pp) return stammRoh(k, u + b);
  return 0.5 * (stammRoh(k, u + b) + k.m * stammRoh(k, b - u));
}
/** Steigung der Kennlinie am Arbeitspunkt (für die Färbungsmessung) */
function steigungB(k, bias) {
  const b = biasEff(k, bias), a = b >= 0 ? k.ap : k.an, t = th(a * b), sl = 1 - t * t;
  return k.pp ? 0.5 * (1 + k.m) * sl : sl;
}
/**
 * Standard-Kennlinie mit Antiderivative-Antialiasing 1. Ordnung (Parker/Zavalishin/Bilbao): statt f(u) wird der Mittelwert
 * von f über den Weg vom letzten zum aktuellen Wert genommen – das drückt die Spiegelprodukte der oberen Obertöne noch einmal
 * deutlich (15 kHz bei −3 dBFS: von −72 auf < −90 dB). Nebenwirkung: ein Halbtakt Verzögerung und ein cos-Abfall oben, den der
 * Aufrufer mit einem kleinen 2-Tap-Boost wieder geradezieht.
 */
function kennlinieADAA(k, st, u, bias, s0) {
  const u0 = st.u, d = u - u0;
  st.u = u;
  if (Math.abs(d) < 1e-5) { st.gueltig = false; return kennlinie(k, (u + u0) * 0.5, bias, s0); }
  const schl = k.pp ? k.m : -1;
  const F1 = st.F = kennlinieStamm(k, u, bias), F0 = st.gueltig && st.bias === bias && st.m === schl ? st.F0 : kennlinieStamm(k, u0, bias);
  st.F0 = F1; st.gueltig = true; st.bias = bias; st.m = schl;
  return (F1 - F0) / d - (k.pp ? 0.5 * s0 * (1 - k.m) : s0);
}
const ADAA_BOOST = 0.2; // 2-Tap-Boost nach der ADAA im 4×-Takt: y + 0,2·(y − y_alt) hebt die cos(π·f/fs_os)-Senke auf (20 kHz: −0,47 → −0,06 dB)

/** Gegenkopplung (Standard): Kehrwert der Kleinsignal-Verstärkung (Ansteuerung × Steigung der Kennlinie am Arbeitspunkt) */
function statischerAusgleich(k, drive, bias) {
  const d = 1e-4, s0 = ruhe(k, bias);
  const steigung = (kennlinie(k, d, bias, s0) - kennlinie(k, -d, bias, s0)) / (2 * d);
  return 1 / Math.max(1e-3, drive * steigung);
}

/** Zusätzliche Ansteuerung der Seite: ab Verteilung 0,5 bis +9 dB bei 1 */
function seitenBoost(vert) {
  return Math.pow(10, (9 * Math.max(0, (vert - 0.5) * 2)) / 20);
}

// ---------- Röhrentypen und HQ-Stufe nach Koren (Parameter: Koren 1996 / Norman Korens Modell-Tabelle) ----------
// Je Typ: Koren-Triode (mu, ex, kg1, kp, kvb) mit gemeinsamem Gitterstrom-Modell, Schaltung (Anodenwiderstand ra, Versorgung vb0,
// Kathodenwiderstand von „heiß“ bis „kalt“ für den Regler Charakter), Volt am Gitter bei Vollaussteuerung (vVoll) und die Form der
// Standard-Kennlinie (ap/an: Rundung oben/unten, bStd: Faktor auf den Arbeitspunkt) – an die HQ-Stufe
// angepasst, sodass Standard und HQ je Röhre dieselbe Obertonreihe (H2/H3/H4) zeigen. 12AX7 = die bisherige Stufe.
//  ax7 „Heiß“   – hoher Verstärkungsfaktor (µ 100): früh dicht, viel H2, bei Übersteuerung rau
//  at7 „Punch“  – µ 60: direkter, etwas sauberer, schnelle Transienten
//  au7 „Glatt“  – µ 21: sehr linear, fast nur sanftes H2, erst spät Kante
//  sn7 „Breit“  – 6SN7, µ 20 (Parameter an Datenblattwerte angepasst): am saubersten, großer Aussteuerbereich
const mkRoehre = (name, mu, ex, kg1, kp, ra, rkHeiss, rkKalt, vVoll, ap, an, bStd) => ({ name, mu, ex, kg1, kp, kvb: 300, rgi: 2000, vth: -0.7, w: 0.12, ra, vb0: 300, rkHeiss, rkKalt, vVoll, ap, an, bStd });
const ROEHREN = {
  ax7: mkRoehre('ax7', 100, 1.4, 1060, 600, 100e3, 1000, 2700, 0.5, 0.23345, 0.562948, 4.5442),
  at7: mkRoehre('at7', 60, 1.35, 460, 300, 47e3, 400, 1000, 0.6, 0.1092, 1.600248, 13.9551),
  au7: mkRoehre('au7', 21.5, 1.3, 1180, 84, 47e3, 700, 1700, 0.9, 0.0483, 0.57201, 33.4638),
  sn7: mkRoehre('sn7', 20, 1.4, 1894, 160, 47e3, 900, 3900, 1.1, 0.0602, 0.027176, 19.3895),
};
const SCH = { Ck: 100e-6, Rg: 220e3, Rs: 10e3, Cc: 330e-9, Rb: 4700, Cb: 47e-6 };

/** Anodenstrom und Ableitung nach Vpk (Koren): E1 = Vpk/KP · ln(1 + exp(KP·(1/µ + Vgk/√(KVB + Vpk²)))), Ip = 2·E1^EX/KG1 */
// Ergebnisse ohne Array-Anlegen im heißen Takt: K.ip / K.dip bzw. K.ig / K.dig
const K = { ip: 0, dip: 0, ig: 0, dig: 0 };
function korenIp(T, Vgk, Vpk) {
  if (Vpk < 1e-3) Vpk = 1e-3;
  const s = Math.sqrt(T.kvb + Vpk * Vpk);
  const kpa = T.kp * (1 / T.mu + Vgk / s);
  let L, sig;
  if (kpa > 40) { L = kpa; sig = 1; } else if (kpa < -40) { L = Math.exp(kpa); sig = L; } else { const e = Math.exp(kpa); L = Math.log1p(e); sig = e / (1 + e); }
  const E1 = (Vpk / T.kp) * L;
  if (E1 <= 0) { K.ip = 0; K.dip = 0; return; }
  const p = Math.pow(E1, T.ex - 1);
  K.ip = 2 * p * E1 / T.kg1;
  K.dip = (2 * T.ex * p / T.kg1) * (L / T.kp - Vpk * sig * Vgk * Vpk / (s * s * s));
}

/** Gitterstrom und Ableitung: weiches Knie (softplus) ab Vth, dahinter 1/RGI */
function gitterstrom(T, Vgk) {
  const xg = (Vgk - T.vth) / T.w;
  if (xg > 30) { K.ig = (Vgk - T.vth) / T.rgi; K.dig = 1 / T.rgi; return; }
  if (xg < -40) { K.ig = 0; K.dig = 0; return; }
  const e = Math.exp(xg);
  K.ig = T.w * Math.log1p(e) / T.rgi; K.dig = (e / (1 + e)) / T.rgi;
}

/** Anodenspannung bei gegebenem Gitter/Kathode und Versorgung über Lastwiderstand R (Newton, Start bei Vp) */
function anodeLoesen(T, Vgk, Vk, Vb, R, Vp) {
  for (let n = 0; n < 8; n++) {
    korenIp(T, Vgk, Vp - Vk);
    const d = (Vp - Vb + R * K.ip) / (1 + R * K.dip);
    Vp -= d;
    if (Vp < Vk + 1) Vp = Vk + 1; else if (Vp > Vb) Vp = Vb;
    if (Math.abs(d) < 1e-5) break;
  }
  return Vp;
}

/** Ruhepunkt der Stufe (Vk, Vp, Versorgung nach Siebung) und Kleinsignal-Verstärkung dort */
function ruhepunkt(T, Rk, Vb0) {
  const R = T.ra + SCH.Rb; // Siebwiderstand liegt für Gleichstrom in Reihe
  // Gitter in Ruhe: der winzige Gitterstrom fließt über Rg ab (Vg = −Rg·Ig), der Koppelkondensator trägt −Vg
  const gitterRuhe = (Vk) => { let Vg = 0; for (let i = 0; i < 8; i++) { gitterstrom(T, Vg - Vk); Vg = -SCH.Rg * K.ig; } return Vg; };
  let lo = 0, hi = 40, Vp = Vb0 * 0.6, Vg = 0;
  for (let i = 0; i < 60; i++) {
    const Vk = (lo + hi) / 2;
    Vg = gitterRuhe(Vk);
    Vp = anodeLoesen(T, Vg - Vk, Vk, Vb0, R, Vp);
    const Ip = (Vb0 - Vp) / R;
    if (Ip > Vk / Rk) lo = Vk; else hi = Vk;
  }
  const Vk = (lo + hi) / 2, Ip = (Vb0 - Vp) / R, Vb = Vb0 - SCH.Rb * Ip;
  const d = 1e-3;
  const Vp1 = anodeLoesen(T, Vg - Vk + d, Vk, Vb, T.ra, Vp), Vp2 = anodeLoesen(T, Vg - Vk - d, Vk, Vb, T.ra, Vp);
  const gain = Math.abs(Vp1 - Vp2) / (2 * d) * (SCH.Rg / (SCH.Rg + SCH.Rs));
  return { Vk, Vp, Vb, Vg, gain };
}

function rkAusBias(T, bias) {
  const t = Math.max(0, Math.min(1, (bias - 0.04) / 0.4));
  return T.rkHeiss + (T.rkKalt - T.rkHeiss) * t;
}

/**
 * Ein Takt (8×) der Röhrenstufe am Zustand z (eine Stufe): Gitterspannung u (Volt) hinein, Anodenhub (Volt, nicht invertiert) heraus.
 * (Als feste Funktion statt Closure im Block: so bleibt sie im JIT optimiert.)
 */
function roehrenTakt(T, z, u, Rk, Vb0, dt) {
  const { Ck, Rg, Rs, Cc, Rb, Cb } = SCH, Ra = T.ra;
  let Vg = z.Vg, Vk = z.Vk, Vp = z.Vp, Vb = z.Vb;
  // Gitterknoten: (Vs − Vc − Vg)/Rs = Vg/Rg + Ig(Vg − Vk); ohne Gitterstrom geschlossen lösbar
  const Vs = u - z.Vc;
  Vg = Vs * (Rg / (Rg + Rs));
  if (Vg - Vk > T.vth - 12 * T.w) { // darunter ist der Gitterstrom < 3 nA – ohne Sprung vernachlässigbar
    for (let it = 0; it < 4; it++) {
      gitterstrom(T, Vg - Vk);
      const f = (Vs - Vg) / Rs - Vg / Rg - K.ig;
      const dstep = f / (-1 / Rs - 1 / Rg - K.dig);
      Vg -= dstep;
      if (Math.abs(dstep) < 2e-4) break; // quadratische Konvergenz: Restfehler dann < 1 µV
    }
  }
  z.Vc += dt * ((Vs - Vg) / Rs) / Cc;
  // Anode: Vp = Vb − Ra·Ip(Vgk, Vpk), Newton; Startwert linear fortgeschrieben (meist reicht ein Schritt)
  const Vgk = Vg - Vk;
  const VpNeu = 2 * Vp - z.VpAlt; z.VpAlt = Vp; Vp = VpNeu;
  if (Vp < Vk + 1) Vp = Vk + 1; else if (Vp > Vb) Vp = Vb;
  for (let it = 0; it < 8; it++) {
    korenIp(T, Vgk, Vp - Vk);
    const dstep = (Vp - Vb + Ra * K.ip) / (1 + Ra * K.dip);
    Vp -= dstep;
    if (Vp < Vk + 1) Vp = Vk + 1; else if (Vp > Vb) Vp = Vb;
    // Newton konvergiert quadratisch: ein Schritt unter 30 mV lässt einen Restfehler weit unter 0,1 mV (bei ~100 V Hub)
    if (Math.abs(dstep) < 0.03) break;
  }
  const Ip = (Vb - Vp) / Ra;
  z.Vk = Vk + dt * (Ip - Vk / Rk) / Ck;
  z.Vb = Vb + dt * ((Vb0 - Vb) / Rb - Ip) / Cb;
  z.Vg = Vg; z.Vp = Vp;
  return z.vpq - Vp; // invertierende Stufe → zurückgedreht (Mix und Original gleichphasig); Bezug ist die Ruhe-Anodenspannung zum aktuellen langsamen Zustand (s. process)
}

/**
 * Färbungsmessung (nur solange das Effektrack offen ist – sonst kostet sie nichts): Abweichung der Kennlinie von ihrer
 * Geraden im Verhältnis zum linearen Signal, je Kanal L/R über ~50 ms, gewichtet mit dem Anteil. Gleichanteil und der Teil, der
 * nur den Grundton lauter/leiser macht (Kompression, kein Klirr), werden herausgerechnet – übrig bleibt Klirr wie bei THD+N.
 * Meldet { faerb: [L, R] } als Bruchteil (0,01 = 1 %).
 */
class FaerbMesser {
  constructor() { this.puffer(128); this.leeren(); }
  puffer(n) { if (!this.abw || this.abw[0].length !== n) { this.abw = [new Float32Array(n), new Float32Array(n)]; this.lin = [new Float32Array(n), new Float32Array(n)]; } }
  leeren() { this.r = [0, 0]; this.rs = [0, 0]; this.s = [0, 0]; this.rl = [0, 0]; this.n = 0; }
  start(n) { this.puffer(n); this.abw[0].fill(0); this.abw[1].fill(0); this.lin[0].fill(0); this.lin[1].fill(0); }
  sammeln(n, ms, port) {
    const a0 = this.abw[0], a1 = this.abw[1], l0 = this.lin[0], l1 = this.lin[1];
    for (let i = 0; i < n; i++) {
      let ra = a0[i], rb = a1[i], sa = l0[i], sb = l1[i];
      if (ms) { const x = ra + rb; rb = ra - rb; ra = x; const u = sa + sb; sb = sa - sb; sa = u; }
      this.r[0] += ra * ra; this.rs[0] += ra; this.s[0] += sa * sa; this.rl[0] += ra * sa;
      this.r[1] += rb * rb; this.rs[1] += rb; this.s[1] += sb * sb; this.rl[1] += rb * sb;
    }
    this.n += n;
    if (this.n >= sampleRate * 0.05) {
      const w = [0, 1].map((c) => {
        if (!(this.s[c] > 1e-9 * this.n)) return 0;
        const e = this.r[c] - this.rs[c] * this.rs[c] / this.n - this.rl[c] * this.rl[c] / this.s[c];
        return this.s[c] > 1e-9 * this.n ? Math.min(1, Math.sqrt(Math.max(0, e) / this.s[c])) : 0;
      });
      port.postMessage({ faerb: w });
      this.leeren();
    }
  }
}

/** Delta-Hören: 0 = normal, 1 = nur was das Gerät verändert (nass − trocken, bei gleichem Pegel); gleitet in 20 ms um */
function deltaVerlauf(p, n) {
  const ziel = p.deltaZiel || 0;
  if (!p.dz && !ziel) return null;
  if (!p.dzBuf || p.dzBuf.length !== n) p.dzBuf = new Float32Array(n);
  const schritt = 1 / (0.02 * sampleRate);
  let d = p.dz || 0;
  for (let i = 0; i < n; i++) { d += Math.max(-schritt, Math.min(schritt, ziel - d)); p.dzBuf[i] = d; }
  p.dz = d < 1e-6 && !ziel ? 0 : d;
  return p.dzBuf;
}

class AwRoehre extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const p = (o && o.processorOptions) || {};
    this.fir = firEntwurf();
    this.kanal = [];
    this.T = ROEHREN.ax7;
    this.ziel = { drive: 2, bias: 0.12, ton: 0.4, mix: 0.8, auto: 1, vert: 0.5, hq: 0, pp: 0, symm: 0.9 };
    this.dtOs = 1 / (sampleRate * OS * 2); // HQ rechnet die Stufe im inneren Takt (~384 kHz)
    // Toleranzen je Ebene (fest, wie zwei verschiedene Exemplare) und langsame Drift (zwei Sinus mit 71 s und 113 s plus Zufallsweg)
    this.tol = [{ bias: 1.03, drive: 1.035, ton: 0.96, vb: 1.02 }, { bias: 0.975, drive: 0.968, ton: 1.04, vb: 0.985 }];
    this.drift = { ph1: 0.7, ph2: 2.1, walk: 0, wert: [0, 0] };
    this.rpCache = new Map();

    this.ist = null;
    this.setzen(p);
    this.ist = { ...this.ziel, ausgleich: this.ausgleich, ausgleichS: this.ausgleichS, hqAusgleich: this.hqAusgleich, hqAusgleichS: this.hqAusgleichS };
    this.msEin = [new Float32Array(128), new Float32Array(128)];
    this.messer = new FaerbMesser();
    this.port.onmessage = (e) => {
      if (e.data.ende) { this.ende = true; return; }
      if (typeof e.data.messen === 'boolean') { this.messen = e.data.messen; this.messer.leeren(); return; }
      if (typeof e.data.delta === 'boolean') { this.deltaZiel = e.data.delta ? 1 : 0; return; }
      this.setzen(e.data);
    };
  }

  /** Ruhepunkt für Kathodenwiderstand/Versorgung (gerundet, gecacht – wird bei jeder Parameteränderung gebraucht) */
  ruhe(Rk, Vb0) {
    const k = this.T.name + ':' + Math.round(Rk) + ':' + Math.round(Vb0 * 10);
    let r = this.rpCache.get(k);
    if (!r) { r = ruhepunkt(this.T, Rk, Vb0); if (this.rpCache.size > 64) this.rpCache.clear(); this.rpCache.set(k, r); }
    return r;
  }

  setzen(d) {
    if (typeof d.drive === 'number') this.ziel.drive = Math.max(0.1, Math.min(40, d.drive));
    if (typeof d.bias === 'number') this.ziel.bias = Math.max(-0.6, Math.min(0.6, d.bias));
    if (typeof d.ton === 'number') this.ziel.ton = Math.max(0, Math.min(1, d.ton));
    if (typeof d.mix === 'number') this.ziel.mix = Math.max(0, Math.min(1, d.mix));
    if (typeof d.auto === 'number' || typeof d.auto === 'boolean') this.ziel.auto = d.auto ? 1 : 0;
    if (typeof d.vert === 'number') this.ziel.vert = Math.max(0, Math.min(1, d.vert));
    if (typeof d.hq === 'number' || typeof d.hq === 'boolean') this.ziel.hq = d.hq ? 1 : 0;
    if (typeof d.gegentakt === 'number' || typeof d.gegentakt === 'boolean') this.ziel.pp = d.gegentakt ? 1 : 0;
    if (typeof d.symm === 'number') this.ziel.symm = Math.max(0, Math.min(1, d.symm));
    if (typeof d.roehre === 'string' && ROEHREN[d.roehre] && ROEHREN[d.roehre] !== this.T) {
      this.T = ROEHREN[d.roehre]; this.rpCache.clear();
      for (let c = 0; c < this.kanal.length; c++) if (this.kanal[c]) this.kanalStufen(this.kanal[c], c);
    }
    const T = this.T, kz = this.kurve(this.ziel);
    this.ausgleich = this.ziel.auto ? statischerAusgleich(kz, this.ziel.drive, this.ziel.bias) : 1;
    this.ziel.sBoost = seitenBoost(this.ziel.vert);
    this.ausgleichS = this.ziel.auto ? statischerAusgleich(kz, this.ziel.drive * this.ziel.sBoost, this.ziel.bias) : 1;
    // HQ: Kleinsignal-Verstärkung der Stufe am Arbeitspunkt herausrechnen (und die Ansteuerung, wenn Auto)
    this.ziel.rk = rkAusBias(T, this.ziel.bias);
    const rp = this.ruhe(this.ziel.rk, T.vb0);
    const dr = this.ziel.auto ? this.ziel.drive * T.vVoll : T.vVoll;
    const pg = this.ziel.pp ? 0.5 * (1 + this.ziel.symm) : 1; // Gegentakt: Kleinsignal-Verstärkung ½·(1 + m)
    this.hqAusgleich = 1 / (rp.gain * dr * pg);
    this.hqAusgleichS = 1 / (rp.gain * dr * pg * (this.ziel.auto ? this.ziel.sBoost : 1));
    // Tonblende: ein Pol, 0 = wirklich neutral (kein Filter), ab 10 % von ca. 20 kHz bis 1 = samtig (ca. 6 kHz).
    // Zwischen 0 und 10 % wird weich in den Filter übergeblendet (ein Pol bei 20 kHz kostet sonst schon −0,5 dB bei 10 kHz).
    const t = this.ziel.ton;
    const fc = 20000 * Math.pow(6000 / 20000, t);
    const k = 1 - Math.exp(-2 * Math.PI * Math.min(fc, sampleRate * 0.45) / sampleRate);
    this.tonK = t >= 0.1 ? k : 1 + (k - 1) * (t / 0.1);
    this.ziel.tonK = this.tonK;
  }

  /** Form der Standard-Kennlinie der gewählten Röhre (Gegentakt, Symmetrie) */
  kurve(w) { const T = this.T; return { ap: T.ap, an: T.an, bs: T.bStd, m: w.symm, pp: !!w.pp }; }

  /** Ruhezustand beider Röhrenstufen (HQ; Stufe 1 nur im Gegentakt) für Kanal c – bei Anlage und beim Wechsel der Röhre */
  kanalStufen(z, c) {
    const tol = this.tol[c & 1];
    const rp = this.ruhe(this.ziel.rk * tol.bias, this.T.vb0 * tol.vb);
    z.s = [0, 1].map(() => ({ Vk: rp.Vk, Vp: rp.Vp, VpAlt: rp.Vp, Vc: -rp.Vg, Vb: rp.Vb, Vg: rp.Vg, vpq: rp.Vp }));
  }

  kanalZustand(c) {
    let z = this.kanal[c];
    if (!z) {
      z = {
        hoch: new Float64Array(PH * 2), hochPos: 0,     // doppelt geführter Ring (Polyphase-Hochtastung, lesen ohne Umbruch)
        runter: new Float64Array(TAPS * 2), runterPos: 0, // doppelt geführter Ring (Abwärtstastung)
        trocken: new Float64Array(TROCKEN_L), trockenPos: 0, // Verzögerung des trockenen Wegs (Mix ohne Kammfilter)
        hbU: new Float64Array(HB_MITTE + 2), hbUPos: 0,   // HQ: Verlauf der 4×-Werte (innere Hochtastung)
        hbD: new Float64Array(HB_L), hbDPos: 0,           // HQ: Verlauf der 8×-Werte (innere Abwärtstastung)
        dcX: 0, dcY: 0, ton: 0,
        adaa: { u: 0, F0: 0, F: 0, gueltig: false, bias: NaN }, adaaY: 0, // Standard: ADAA-Zustand und letzter Wert (Boost)
      };
      // HQ: Schaltungszustand je Stufe – Kathoden-, Anoden-, Koppel-C- und Versorgungsspannung, Gitterspannung (Newton-Start)
      this.kanalStufen(z, c);
      this.kanal[c] = z;
    }
    return z;
  }

  process(inputs, outputs) {
    if (this.ende) return false;
    const ein = inputs[0], aus = outputs[0];
    if (!aus || !aus.length) return true;
    const n = aus[0].length;
    const dzA = deltaVerlauf(this, n);
    const fir = this.fir, z0 = this.ist, z1 = this.ziel;
    // Parameter gleiten über den Block
    const g = (k) => [z0[k], (z1[k] - z0[k]) / n];
    const [drive, dDrive] = g('drive'), [bias, dBias] = g('bias'), [mix, dMix] = g('mix'), [vert, dVert] = g('vert');
    const ms = aus.length === 2 && ein && ein[0] && ein[1]; // Stereo: in Mitte/Seite rechnen
    if (ms) {
      if (this.msEin[0].length !== n) this.msEin = [new Float32Array(n), new Float32Array(n)];
      const l = ein[0], r = ein[1], m = this.msEin[0], sd = this.msEin[1];
      for (let i = 0; i < n; i++) { m[i] = (l[i] + r[i]) * 0.5; sd[i] = (l[i] - r[i]) * 0.5; }
    }
    const hq = z1.hq === 1;
    const gl = (a, b) => [a ?? b, (b - (a ?? b)) / n];
    const [ausgS, dAusgS] = gl(hq ? z0.hqAusgleichS : z0.ausgleichS, hq ? this.hqAusgleichS : this.ausgleichS);
    const [ausg, dAusg] = gl(hq ? z0.hqAusgleich : z0.ausgleich, hq ? this.hqAusgleich : this.ausgleich);
    const [boost, dBoost] = gl(z0.sBoost, z1.sBoost ?? 1);
    const [tonK, dTon] = gl(z0.tonK, z1.tonK ?? this.tonK);
    const [rkA, dRk] = gl(z0.rk, z1.rk);
    const T = this.T, kz = this.kurve(z1);
    const s0a = ruhe(kz, z0.bias), s0b = ruhe(kz, z1.bias), dS0 = (s0b - s0a) / n;
    const dcR = 1 - 2 * Math.PI * 4 / sampleRate; // DC-Sperre bei 4 Hz nach dem Abwärtstasten (20 Hz: −0,17 dB; die Kennlinie erzeugt signalabhängigen Gleichanteil)
    const dt = this.dtOs;
    const mess = this.messen ? this.messer : null;
    if (mess) mess.start(n);
    // Steigung der Kennlinie am Arbeitspunkt (für die Färbungsmessung)
    const slB = steigungB(kz, bias);
    for (let c = 0; c < aus.length; c++) {
      const x = ms ? this.msEin[c] : ein && ein[c], y = aus[c];
      if (!x) { y.fill(0); continue; }
      const seite = ms && c === 1;
      const z = this.kanalZustand(c);
      const mA = mess ? mess.abw[c & 1] : null, mL = mess ? mess.lin[c & 1] : null;
      const hoch = z.hoch, runter = z.runter, trk = z.trocken;
      let hp = z.hochPos, rp = z.runterPos, tp = z.trockenPos, dcX = z.dcX, dcY = z.dcY, ton = z.ton;
      // Drift je Block fortschreiben (langsam, ±1,5 %): Ebene 0 und 1 gegenläufig
      if (hq && c === 0) {
        const d = this.drift;
        d.ph1 += 2 * Math.PI * n / (sampleRate * 71); d.ph2 += 2 * Math.PI * n / (sampleRate * 113);
        d.walk += 0.002 * ((Math.random() * 2 - 1) - d.walk);
        const w = 0.01 * Math.sin(d.ph1) + 0.005 * Math.sin(d.ph2) + 0.006 * d.walk;
        d.wert[0] = 1 + w; d.wert[1] = 1 - 0.8 * w;
      }
      const tol = hq ? this.tol[c & 1] : null, dft = hq ? this.drift.wert[c & 1] : 1;
      const Vb0 = hq ? T.vb0 * tol.vb : T.vb0;
      for (let i = 0; i < n; i++) {
        const vt = vert + dVert * i;
        let dr = (drive + dDrive * i) * (seite ? boost + dBoost * i : 1), bi = bias + dBias * i, tk = tonK + dTon * i, s0 = s0a + dS0 * i;
        const drBasis = dr; // ohne HQ-Toleranzen und Volt-Skalierung (für den Delta-Pfad)
        let Rk = rkA + dRk * i;
        if (hq) {
          // Toleranzen: Ansteuerung driftet (Erwärmung), der Arbeitspunkt ist je Ebene fest (ein Driften des Ruhepunkts
          // wäre nur als Rumpeln hörbar); Tonblende als Verschiebung der Grenzfrequenz (bei 0 bleibt sie wirklich neutral)
          dr *= tol.drive * dft * T.vVoll; Rk *= tol.bias;
          if (tk < 0.999) tk = 1 - Math.pow(1 - tk, tol.ton);
        }
        const ag = seite ? ausgS + dAusgS * i : ausg + dAusg * i;
        const mx = (mix + dMix * i) * (!ms ? 1 : seite ? Math.min(1, 2 * vt) : Math.min(1, 2 * (1 - vt)));
        const ein_i = x[i];
        // trockener Weg um die Verzögerung des nassen Wegs verspäten
        trk[tp] = ein_i;
        let tq = tp - (hq ? VERZ + HB_VERZ : VERZ); if (tq < 0) tq += TROCKEN_L;
        const trocken = trk[tq]; tp = tp === TROCKEN_L - 1 ? 0 : tp + 1;
        if (hq) {
          // Ruhe-Anodenspannung zum aktuellen langsamen Zustand (Kathoden-, Koppel-C-, Versorgungsspannung): Wandert der
          // Arbeitspunkt (Gitterstrom, Kathoden-Elko, Sag), wandert sie mit – so wird der Hub relativ dazu ausgegeben und das
          // Wandern selbst erzeugt keinen Gleichspannungs-Sprung, der nach lauten Passagen als Rumpeln durch die DC-Sperre käme.
          // (Die Asymmetrie der Kennlinie – der eigentliche Röhrenklang – bleibt vollständig erhalten.) Einmal je Sample.
          for (let sn = 0; sn < (z1.pp ? 2 : 1); sn++) {
            const sp = z.s[sn], VgQ = -sp.Vc * (SCH.Rg / (SCH.Rg + SCH.Rs));
            sp.vpq = anodeLoesen(T, VgQ - sp.Vk, sp.Vk, sp.Vb, T.ra, sp.vpq);
          }
        }
        // Hochtasten (Polyphase): neuestes Sample an hp und hp+PH, gelesen wird rückwärts ab hp+PH ohne Umbruch
        hoch[hp] = ein_i; hoch[hp + PH] = ein_i;
        const basis = hp + PH;
        for (let k = 0; k < OS; k++) {
          let u = 0;
          for (let j = 0; j < PH; j++) u += fir[k + OS * j] * hoch[basis - j];
          u *= OS * dr;
          if (k === 0 && mA) { const uu = hq ? u / T.vVoll : u, lin = slB * uu; mA[i] = (kennlinie(kz, uu, bi, s0) - lin) * mx; mL[i] = lin; }
          let v;
          if (!hq) {
            const ya = kennlinieADAA(kz, z.adaa, u, bi, s0);
            v = ya + ADAA_BOOST * (ya - z.adaaY); z.adaaY = ya;
          } else {
            // innere 2×: Zwischenwert per Halbband (gerade Phase = Wert von vor 6 Takten, ungerade = gefiltert)
            const hu = z.hbU, hl = hu.length, hd = z.hbD;
            let up = z.hbUPos; hu[up] = u; z.hbUPos = up = up === hl - 1 ? 0 : up + 1;
            let q = up - 1 - HB_MITTE / 2; if (q < 0) q += hl;
            const gerade = hu[q];
            let ungerade = 0;
            for (let t = 0; t < HB_UNGERADE.length; t++) { const i = HB_UNGERADE[t]; let qq = up - 1 - (i - 1) / 2; if (qq < 0) qq += hl; ungerade += HB[i] * hu[qq]; }
            ungerade *= 2;
            let dp = z.hbDPos;
            let r1 = roehrenTakt(T, z.s[0], gerade, Rk, Vb0, dt);
            if (z1.pp) r1 = 0.5 * (r1 - z1.symm * roehrenTakt(T, z.s[1], -gerade, Rk, Vb0, dt));
            hd[dp] = r1; dp = dp === HB_L - 1 ? 0 : dp + 1;
            let sum = 0;
            for (let t = 0; t < HB_L; t++) { let q2 = dp - 1 - t; if (q2 < 0) q2 += HB_L; sum += HB[t] * hd[q2]; }
            let r2 = roehrenTakt(T, z.s[0], ungerade, Rk, Vb0, dt);
            if (z1.pp) r2 = 0.5 * (r2 - z1.symm * roehrenTakt(T, z.s[1], -ungerade, Rk, Vb0, dt));
            hd[dp] = r2; dp = dp === HB_L - 1 ? 0 : dp + 1;
            z.hbDPos = dp;
            v = sum;
          }
          if (dzA) {
            // Delta-Pfad: nur der nichtlineare Anteil der Kennlinie (Kurve minus ihre Gerade), gleich heruntergetastet
            const uu = hq ? u / T.vVoll : u, rr = kennlinie(kz, uu, bi, s0) - slB * uu;
            const rd = z.deltaRunter ||= new Float64Array(TAPS * 2);
            rd[rp] = rr; rd[rp + TAPS] = rr;
          }
          runter[rp] = v; runter[rp + TAPS] = v;
          rp = rp === TAPS - 1 ? 0 : rp + 1;
        }
        hp = hp === PH - 1 ? 0 : hp + 1;
        // Abwärtstasten: FIR über die letzten TAPS hochgetasteten Werte (neuester zuletzt geschrieben an rp−1)
        let ausgang = 0;
        {
          const b2 = (rp === 0 ? TAPS - 1 : rp - 1) + TAPS;
          for (let t = 0; t < TAPS; t++) ausgang += fir[t] * runter[b2 - t];
        }
        // Pegelkorrektur, DC-Sperre (der Arbeitspunkt erzeugt signalabhängigen Gleichanteil) und Tonblende – nach dem Abwärtstasten
        const v = ausgang * ag;
        const w = v - dcX + dcR * dcY; dcX = v; dcY = w;
        ton += tk * (w - ton);
        let rest = 0;
        if (dzA) {
          // Delta: Rest auf Eingangspegel bringen (Kehrwert von Ansteuerung × Steigung) und durch dieselbe DC-Sperre und Tonblende
          const rd = z.deltaRunter, b2 = (rp === 0 ? TAPS - 1 : rp - 1) + TAPS;
          let r = 0; for (let t = 0; t < TAPS; t++) r += fir[t] * rd[b2 - t];
          r /= Math.max(1e-6, drBasis * slB);
          const rw = r - (z.dDcX || 0) + dcR * (z.dDcY || 0); z.dDcX = r; z.dDcY = rw;
          z.dTon = (z.dTon || 0) + tk * (rw - (z.dTon || 0));
          rest = z.dTon;
        }
        const normal = trocken + (ton - trocken) * mx;
        y[i] = dzA ? normal * (1 - dzA[i]) + rest * mx * dzA[i] : normal;
      }
      z.hochPos = hp; z.runterPos = rp; z.trockenPos = tp; z.dcX = dcX; z.dcY = dcY; z.ton = ton;
    }
    if (ms) {
      const yM = aus[0], yS = aus[1];
      for (let i = 0; i < n; i++) { const m = yM[i], sd = yS[i]; yM[i] = m + sd; yS[i] = m - sd; }
    }
    if (mess) mess.sammeln(n, ms, this.port);
    this.ist = { ...z1, ausgleich: this.ausgleich, ausgleichS: this.ausgleichS, hqAusgleich: this.hqAusgleich, hqAusgleichS: this.hqAusgleichS, tonK: z1.tonK ?? this.tonK };
    for (const z of this.kanal) if (z && Math.abs(z.ton) < 1e-30) z.ton = 0;
    return true;
  }
}
registerProcessor('aw-roehre', AwRoehre);
