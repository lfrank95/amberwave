// Bandmaschine im Audio-Thread („Band“). Sitzt hinter der Röhre, vor Raumklang und EQ. Stereo wird wie bei der Röhre in
// Mitte/Seite gerechnet (eigener Weg je Ebene, Verteilung regelbar), der trockene Weg läuft gleich verzögert mit.
// Signalweg je Ebene: Vorentzerrung (Aufnahme-Entzerrung: Höhen +gE dB, so sättigen S-Laute und Becken zuerst)
//  → Bandsättigung mit 4-fachem Oversampling (Standard: anhysteretische Magnetisierungskurve = Langevin-Funktion;
//    HQ: Jiles-Atherton-Hysterese – die Magnetisierung hängt von der Vorgeschichte ab, das ergibt die weiche, dichte
//    Band-Kompression und die typische Verrundung kleiner Signale)
//  → Entzerrung (exakte Umkehrung für den linearen Anteil)
//  → pegelabhängiger Höhenverlust (Selbstlöschung/Spaltverlust: bei lauten Passagen fallen die Höhen weiter)
//  → Kopfbump (Bassanhebung durch die Wiedergabekopf-Geometrie, Frequenz je Bandgeschwindigkeit)
//  → HQ: Gleichlauf (Wow ~0,5 Hz, Flutter 5–13 Hz als modulierte Verzögerung) und optional Bandrauschen
//  → HQ „perfekt unperfekt“: Toleranzen je Ebene mit langsamer Drift, Kratz-Flutter (sehr schnelle, feine Unregelmäßigkeit
//    am Kopf), Modulationsrauschen (Rauschen, das mit dem Signal mitläuft – der feine Schimmer um laute Töne), Kopfkontur
//    (Senke unter dem Kopfbump) und Azimut (Rechts um wenige µs gegen Links versetzt – die Höhen werden minimal breiter)
// Auto-Gain wie bei der Röhre: Gegenkopplung zur Ansteuerung (Kleinsignal-Verstärkung bleibt 1).
const STAND = '1';
// Oversampling nach Abtastrate: innere Rate ~192 kHz (Standard) bzw. ~384 kHz (HQ mit innerem 2×) – 48 kHz: 4×, 96 kHz: 2×, 192 kHz: 1×
const OS = sampleRate >= 150000 ? 1 : sampleRate >= 75000 ? 2 : 4;
const TAPS = OS === 1 ? 1 : 40 * OS + 1; // OS·m + 1 (Gesamtverzögerung ganzzahlig); Kaiser-Tiefpass bei fs/2 des Originals; 1 = durchreichen
const PH = Math.ceil(TAPS / OS);
const VERZ = (TAPS - 1) / OS;         // Verzögerung durch Hoch-/Abwärtstastung (Samples)
const WF_VERZ_MS = 3;
// Gleichlauf-Verzögerung: bandbegrenzt interpoliert (Kaiser-Sinc, 32 Punkte, 512 Phasen, linear zwischen den Phasen).
// Kubisch interpoliert hätte die Höhen je nach Bruchteil des Samples bis −7 dB (16–20 kHz) gedämpft – mit dem Wow
// wandert der Bruchteil ständig, die Höhen „atmeten“. So bleibt es bis 19,8 kHz (bei 44,1 kHz) innerhalb 0,03 dB.
const WF_N = 32, WF_P = 512, WF_BETA = 5;
const WF_TAB = (() => {
  const i0 = (x) => { let s = 1, t = 1; for (let k = 1; k < 60; k++) { const q = x / (2 * k); t *= q * q; s += t; if (t < 1e-20 * s) break; } return s; };
  const i0b = i0(WF_BETA), tab = new Float64Array((WF_P + 1) * WF_N);
  for (let p = 0; p <= WF_P; p++) {
    const fr = p / WF_P; let sum = 0;
    for (let j = 0; j < WF_N; j++) {
      const x = j - (WF_N / 2 - 1) - fr, t = x / (WF_N / 2);
      const si = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = t * t < 1 ? i0(WF_BETA * Math.sqrt(1 - t * t)) / i0b : (t * t === 1 ? 1 / i0b : 0);
      tab[p * WF_N + j] = si * w; sum += tab[p * WF_N + j];
    }
    for (let j = 0; j < WF_N; j++) tab[p * WF_N + j] /= sum;
    // ganze Samples exakt (ohne Gleichlauf bleibt der Weg eine reine Verzögerung)
    if (p === 0 || p === WF_P) for (let j = 0; j < WF_N; j++) tab[p * WF_N + j] = j === WF_N / 2 - 1 + (p === WF_P ? 1 : 0) ? 1 : 0;
  }
  return tab;
})();                  // Mittenwert der Gleichlauf-Verzögerung (HQ) – der trockene Weg wird gleich verzögert

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

/** tanh als Padé-Näherung */
function th(x) {
  if (x > 4.97) return 1;
  if (x < -4.97) return -1;
  const x2 = x * x;
  return x * (135135 + x2 * (17325 + x2 * (378 + x2))) / (135135 + x2 * (62370 + x2 * (3150 + 28 * x2)));
}

/** Langevin-Funktion L(x) = coth(x) − 1/x (anhysteretische Magnetisierung), Steigung 1/3 am Ursprung (exakt, für die Tabellen) */
function langevin(x) {
  const ax = x < 0 ? -x : x;
  if (ax < 1e-3) return x / 3 - x * x * x / 45;
  return 1 / th(x) - 1 / x;
}
/** Ableitung der Langevin-Funktion */
function langevinAbl(x) {
  const ax = x < 0 ? -x : x;
  if (ax < 1e-3) return 1 / 3 - x * x / 15;
  const t = th(x);
  return 1 - 1 / (t * t) + 1 / (x * x);
}

// Tabellen für die Hysterese (die Funktionen werden je Takt viermal gebraucht – das war der teuerste Teil von HQ):
// 0 … 40 mit 16384 Stützstellen, linear interpoliert (Fehler < 2e-6); darüber die Asymptoten
const LT_MAX = 40, LT_N = 16384, LT_S = LT_N / LT_MAX;
const LT_L = new Float64Array(LT_N + 2), LT_D = new Float64Array(LT_N + 2);
for (let i = 0; i <= LT_N + 1; i++) { LT_L[i] = langevin(i / LT_S); LT_D[i] = langevinAbl(i / LT_S); }
function langevinT(x) {
  const a = x < 0 ? -x : x;
  let v;
  if (a >= LT_MAX) v = 1 - 1 / a;
  else { const p = a * LT_S, i = p | 0, f = p - i; v = LT_L[i] + (LT_L[i + 1] - LT_L[i]) * f; }
  return x < 0 ? -v : v;
}
function langevinAblT(x) {
  const a = x < 0 ? -x : x;
  if (a >= LT_MAX) return 1 / (a * a);
  const p = a * LT_S, i = p | 0, f = p - i;
  return LT_D[i] + (LT_D[i + 1] - LT_D[i]) * f;
}

/**
 * Stammfunktion der Bandkurve 3·L(x): F(x) = 3·ln(sinh x / x). Für das Antiderivativ-Antialiasing (ADAA 1. Ordnung):
 * y = (F(u) − F(u_alt)) / (u − u_alt) – mittelt die Kurve über den Weg zwischen zwei Takten und drückt die Spiegelprodukte
 * harter Sättigung um 20–30 dB, bei einer halben Takt Verzögerung (im 4×-Takt = 1/8 Sample).
 */
function bandStamm(x) {
  const a = x < 0 ? -x : x;
  if (a < 1e-3) return 3 * (a * a / 6 - a * a * a * a / 180);
  // ln(sinh a / a) = a − ln 2 + ln(1 − e^−2a) − ln a
  return 3 * (a - Math.LN2 + Math.log1p(-Math.exp(-2 * a)) - Math.log(a));
}
/** ADAA-Schritt mit Zustand z = { uAlt, FAlt } (eine Stammfunktion je Takt) */
function bandADAA(z, u) {
  const d = u - z.uAlt;
  let y;
  if (d > 1e-4 || d < -1e-4) { const F = bandStamm(u); y = (F - z.FAlt) / d; z.FAlt = F; }
  else { y = 3 * langevin(0.5 * (u + z.uAlt)); z.FAlt = bandStamm(u); }
  z.uAlt = u;
  return y;
}

/**
 * Jiles-Atherton-Hysterese (normiert: Ms = 1). Zustand: M (Magnetisierung), Hv (letztes Feld).
 * Parameter: a (Form der anhysteretischen Kurve), k (Koerzitivfeld, Breite der Schleife), c (reversibler Anteil),
 * alpha (Kopplung). Integration mit Mittelpunktverfahren je Oversampling-Schritt.
 */
/** Steigung dM/dH der Jiles-Atherton-Gleichung (ohne Closure – wird je Takt zweimal gebraucht) */
function jaAbl(Hx, Mx, delta, p) {
  const He = Hx + p.alpha * Mx;
  const Man = langevinT(He / p.a);
  const dMan = langevinAblT(He / p.a) / p.a;
  const diff = Man - Mx;
  const dM = diff * delta > 0 ? diff : 0;
  const nenner = p.k * delta - p.alpha * dM;
  const irr = (nenner > 1e-9 || nenner < -1e-9) ? (1 - p.c) * dM / nenner : 0;
  return (irr + p.c * dMan) / (1 - p.c * p.alpha * dMan);
}

function jaSchritt(z, H, p) {
  const dH = H - z.Hv;
  const delta = dH >= 0 ? 1 : -1;
  const k1 = jaAbl(z.Hv, z.M, delta, p);
  const Mm = z.M + 0.5 * dH * k1;
  const k2 = jaAbl(z.Hv + 0.5 * dH, Mm, delta, p);
  let M = z.M + dH * k2;
  if (M > 1.2) M = 1.2; else if (M < -1.2) M = -1.2;
  if (!Number.isFinite(M)) M = 0;
  z.M = M; z.Hv = H;
  return M;
}

// Abgestimmt: Kleinsignal-Verstärkung bis ~−9 dBFS·drive konstant (±0,2 dB), darüber Band-Kompression; k3 bei 0,35: −33 dB
const JA = { a: 0.33, k: 0.03, c: 0.85, alpha: 0.008 };

// HQ: Die Hysterese hat Knicke an den Umkehrpunkten – deren hohe Obertöne spiegelten selbst bei 4-fachem Oversampling
// zurück in den Hörbereich (15 kHz laut: Spiegel um −55 dB). Darum läuft sie in HQ mit weiteren 2× (intern 8×), über ein
// Halbband-Filter (25 Taps, Kaiser β = 10: Durchlass bis 24 kHz flach, Sperre −97 dB). Laufzeit: 24 Takte = genau 3 Samples.
const HB_L = 25;
const HB_VERZ = 3; // zusätzliche Verzögerung bei Basisrate (HQ), der trockene Weg wird gleich verzögert
const HB = (() => {
  const i0 = (x) => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; } return s; };
  const m = (HB_L - 1) / 2, h = new Float64Array(HB_L), beta = 10;
  let summe = 0;
  for (let i = 0; i < HB_L; i++) {
    const n = i - m;
    const sinc = n === 0 ? 0.5 : (n % 2 === 0 ? 0 : Math.sin(Math.PI * n / 2) / (Math.PI * n));
    const r = (2 * i) / (HB_L - 1) - 1;
    h[i] = sinc * i0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0(beta);
    summe += h[i];
  }
  for (let i = 0; i < HB_L; i++) h[i] /= summe;
  return h;
})();
const HB_MITTE = (HB_L - 1) / 2;                       // 12 (Mitte = 0,5, gerade Abstände sonst 0)
const HB_UNGERADE = [];                                  // Taps mit ungeradem Index (für die Zwischenwerte beim Hochtasten)
for (let i = 1; i < HB_L; i += 2) HB_UNGERADE.push(i);

/**
 * Bandsorten nach Datenblatt (RMGI/BASF SM 900 und SM 468; die 456-Klasse nach den üblichen Herstellerangaben), je Geschwindigkeit:
 *  mol = Maximum Output Level bei 1 kHz (3 % Klirr), sol = Sättigungspegel bei 10 kHz – beide in dB über dem Bezugsfluss 320 nWb/m.
 *  Die Langevin-Kurve trifft die Datenblatt-Steigung: vom Bezugspegel (0,12 % Klirr) bis MOL (3 %) sind es 14 dB.
 *  mol−sol sagt, wie viel früher die Höhen sättigen – das ist die Vorentzerrung, die ins Band geht (bei 15 ips fast nichts,
 *  bei 7,5 ips 6–7 dB). schicht = Schichtdicke (µm) für den Schichtdickenverlust.
 */
const BAENDER = {
  sm900: { name: 'SM 900', mol: { 7.5: 11.5, 15: 14.0, 30: 14.0 }, sol: { 7.5: 4.0, 15: 12.5, 30: 13.0 }, schicht: 12, rauschen: { 7.5: -63, 15: -62, 30: -66 } },
  '456': { name: '456', mol: { 7.5: 9.5, 15: 12.0, 30: 12.5 }, sol: { 7.5: 2.5, 15: 10.0, 30: 11.5 }, schicht: 13.5, rauschen: { 7.5: -61, 15: -60, 30: -63 } },
  sm468: { name: 'SM 468', mol: { 7.5: 7.5, 15: 12.0, 30: 12.0 }, sol: { 7.5: 1.0, 15: 12.0, 30: 12.5 }, schicht: 14.5, rauschen: { 7.5: -64, 15: -62.5, 30: -64.5 } },
};
// Entzerrungs-Zeitkonstanten (µs) für die Höhen: NAB 50 µs (7,5 und 15 ips), IEC/CCIR 70 µs (7,5) und 35 µs (15), AES 17,5 µs (30 ips)
const TAU = { nab: { 7.5: 50, 15: 50, 30: 17.5 }, ccir: { 7.5: 70, 15: 35, 30: 17.5 } };
// Wiedergabekopf: Spalt 3 µm, Band-Kopf-Abstand 0,3 µm (gute Maschine, saubere Köpfe)
const SPALT_UM = 3.0, ABSTAND_UM = 0.3;

/** Wiedergabeverluste (linear, 0–1) bei Frequenz f und Bandgeschwindigkeit ips: Spalt (sin x/x) · Abstand (e^−2πd/λ) · Schicht ((1−e^−kδ)/kδ) */
function wiedergabeverlust(f, ips, schichtUm, mitSchicht = true) {
  const v = ips * 25.4e-3;            // m/s
  const lambda = v / f;               // m
  const k = 2 * Math.PI / lambda;
  const g = SPALT_UM * 1e-6, d = ABSTAND_UM * 1e-6, delta = schichtUm * 1e-6;
  const x = Math.PI * g / lambda;
  const spalt = x < 1e-6 ? 1 : Math.abs(Math.sin(x) / x);
  const abstand = Math.exp(-k * d);
  const kd = k * delta;
  const schicht = !mitSchicht || kd < 1e-6 ? 1 : (1 - Math.exp(-kd)) / kd;
  return spalt * abstand * schicht;
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

class AwBand extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const p = (o && o.processorOptions) || {};
    this.fir = firEntwurf();
    this.kanal = [];
    this.ziel = { drive: 1, ips: 15, bias: 0.5, gleichlauf: 0.3, kopf: 1, mix: 1, vert: 0.5, auto: 1, hq: 0, rauschen: 0, norm: 'nab', band: 'sm900', unperfekt: 1 };
    this.ist = null;
    this.setzen(p);
    this.ist = this.ableiten(this.ziel);
    this.msEin = [new Float32Array(128), new Float32Array(128)];
    this.wfPhase = [0, 0, 0, 0];
    this.wfRausch = 0;
    this.rauschZ = [0, 0, 0];
    this.tol = [{ bias: 1.03, drive: 1.035, hf: 0.97 }, { bias: 0.97, drive: 0.966, hf: 1.03 }];
    this.drift = { ph1: 1.3, ph2: 0.4, walk: 0, wert: [1, 1] };
    this.kratz = 0;
    this.azimutZ = 0;
    this.messer = new FaerbMesser();
    this.port.onmessage = (e) => {
      if (e.data.ende) { this.ende = true; return; }
      if (typeof e.data.messen === 'boolean') { this.messen = e.data.messen; this.messer.leeren(); return; }
      if (typeof e.data.delta === 'boolean') { this.deltaZiel = e.data.delta ? 1 : 0; return; }
      this.setzen(e.data);
    };
  }

  setzen(d) {
    const z = this.ziel;
    if (typeof d.drive === 'number') z.drive = Math.max(0.05, Math.min(30, d.drive));
    if (typeof d.ips === 'number') z.ips = [7.5, 15, 30].includes(d.ips) ? d.ips : 15;
    if (typeof d.bias === 'number') z.bias = Math.max(0, Math.min(1, d.bias));
    if (typeof d.gleichlauf === 'number') z.gleichlauf = Math.max(0, Math.min(1, d.gleichlauf));
    if (typeof d.kopf === 'number' || typeof d.kopf === 'boolean') z.kopf = d.kopf ? 1 : 0;
    if (typeof d.mix === 'number') z.mix = Math.max(0, Math.min(1, d.mix));
    if (typeof d.vert === 'number') z.vert = Math.max(0, Math.min(1, d.vert));
    if (typeof d.auto === 'number' || typeof d.auto === 'boolean') z.auto = d.auto ? 1 : 0;
    if (typeof d.hq === 'number' || typeof d.hq === 'boolean') z.hq = d.hq ? 1 : 0;
    if (typeof d.rauschen === 'number' || typeof d.rauschen === 'boolean') z.rauschen = d.rauschen ? 1 : 0;
    if (typeof d.norm === 'string' && (d.norm === 'nab' || d.norm === 'ccir')) z.norm = d.norm;
    if (typeof d.unperfekt === 'number') z.unperfekt = Math.max(0, Math.min(1, d.unperfekt)); // Toleranzen, Drift, Kratz-Flutter, Modulationsrauschen (HQ)
    if (typeof d.band === 'string' && BAENDER[d.band]) z.band = d.band;
    this.abgeleitet = this.ableiten(z);
    // Hysterese-Zustände frisch starten, wenn der Modus wechselt (sonst bleibt ein alter Arbeitspunkt stehen)
    if (this.ist && this.ist.hq !== z.hq) for (const k of this.kanal) if (k) { k.ja.M = 0; k.ja.Hv = 0; }
  }

  /** Aus den Zielwerten die Filterkoeffizienten und den Pegelausgleich ableiten */
  ableiten(z) {
    const sr = sampleRate;
    const band = BAENDER[z.band] || BAENDER.sm900;
    // Aufnahme-Entzerrung (Kuhschwanz oben): Eckfrequenz aus der Norm-Zeitkonstante (NAB 50 µs = 3183 Hz, CCIR 35 µs = 4547 Hz …),
    // Höhe aus dem Datenblatt: so viel früher sättigen die Höhen als die Mitten (MOL − SOL bei 10 kHz), plus 1 dB für den
    // Bereich darüber; wenig Bias treibt die Höhen zusätzlich etwas härter ins Band (Unterbias = mehr HF-Sättigung)
    const tauUs = (TAU[z.norm] || TAU.nab)[z.ips];
    const fE = 1e6 / (2 * Math.PI * tauUs);
    const hfDb = Math.max(1.0, band.mol[z.ips] - band.sol[z.ips]) + 1.0 + (0.5 - z.bias) * 2;
    // 1-Pol-Shelf: Verstärkung bei 10 kHz soll hfDb betragen → g so wählen, dass 1 + g·(1 − |LP(10k)|) = 10^(hfDb/20)
    const aE = 1 - Math.exp(-2 * Math.PI * fE / sr);
    const lp10 = 1 / Math.sqrt(1 + Math.pow(10000 / fE, 2));
    const gE = (Math.pow(10, hfDb / 20) - 1) / Math.max(0.05, 1 - lp10);
    const pre = { a: aE, g: gE };
    const a0 = (1 + gE) - gE * aE;
    const post = { b0: 1 / a0, b1: -(1 - aE) / a0, a1: -(1 + gE) * (1 - aE) / a0 };
    // Rest-Höhenverlust der abgeglichenen Maschine: Spalt- und Abstandsverlust sind bis 10 kHz einjustiert, was darüber bleibt,
    // wird mit einem Pol nachgebildet (Grenzfrequenz so, dass der Verlust bei 20 kHz stimmt). Der Schichtdickenverlust gehört
    // nicht hierher – ihn gleicht die Aufnahme-Entzerrung aus, und er steckt schon im SOL des Datenblatts.
    const v10 = wiedergabeverlust(10000, z.ips, band.schicht, false), v20 = wiedergabeverlust(20000, z.ips, band.schicht, false);
    const rest20 = Math.max(0.3, Math.min(0.999, v20 / v10)); // linear, < 1
    const fcBasis = Math.min(200000, 20000 / Math.sqrt(1 / (rest20 * rest20) - 1)); // darf über der Nyquistfrequenz liegen (ein Pol)
    // Kopfbump: Peak-Biquad, Frequenz je Geschwindigkeit
    const fK = ({ 7.5: 75, 15: 45, 30: 28 })[z.ips], gK = ({ 7.5: 2.6, 15: 1.8, 30: 1.2 })[z.ips], qK = 0.8;
    const A = Math.pow(10, gK / 40), w0 = 2 * Math.PI * fK / sr, al = Math.sin(w0) / (2 * qK);
    const kb0 = 1 + al * A, kb1 = -2 * Math.cos(w0), kb2 = 1 - al * A, ka0 = 1 + al / A, ka1 = kb1, ka2 = 1 - al / A;
    const kopfF = { b0: kb0 / ka0, b1: kb1 / ka0, b2: kb2 / ka0, a1: ka1 / ka0, a2: ka2 / ka0 };
    // Kopfkontur (HQ): Senke −1,2 dB knapp unter dem Kopfbump
    const fS = fK / 2.2, AS = Math.pow(10, -1.2 / 40), w1 = 2 * Math.PI * fS / sr, al1 = Math.sin(w1) / (2 * 1.2);
    const sb0 = 1 + al1 * AS, sb1 = -2 * Math.cos(w1), sb2 = 1 - al1 * AS, sa0 = 1 + al1 / AS, sa2 = 1 - al1 / AS;
    const konturF = { b0: sb0 / sa0, b1: sb1 / sa0, b2: sb2 / sa0, a1: sb1 / sa0, a2: sa2 / sa0 };
    // Azimut (HQ): Rechts gegen Links um ~7 µs versetzt (Bruchteil eines Samples, Allpass 1. Ordnung)
    const azimut = 7e-6 * sr;
    // Sättigung: Bias verschiebt den Arbeitsbereich der Kurve (wenig Bias = früher Knick, mehr Verzerrung)
    const kurve = 1.6 - 0.8 * z.bias; // Faktor auf die Ansteuerung vor der Kurve
    const molSkala = Math.pow(10, -(band.mol[z.ips] - 12.0) / 20); // Band mit mehr Headroom (MOL) sättigt entsprechend später
    const drive = z.drive * kurve * molSkala;
    // Kleinsignal-Verstärkung der Kurve: 3·L'(0)·drive = drive (die Hysterese-Abweichung ist im Kleinsignal ≈ 0)
    const ausgleich = z.auto ? 1 / drive : 1;
    const hyNorm = z.hq ? drive / this.kleinsignal(drive, true) : 1;
    // Gleichlauf: Wow-Amplitude in Samples; 100 % ≈ 0,25 % Geschwindigkeitsabweichung bei 0,55 Hz (Flutter anteilig, siehe process)
    const tiefe = z.gleichlauf * z.gleichlauf * 0.0025 * sr / (2 * Math.PI * 0.55);
    return { ...z, pre, post, fcBasis, kopfF, konturF, azimut, drive, ausgleich, tiefe, rauschDb: band.rauschen[z.ips], hyNorm };
  }

  /** Kleinsignal-Verstärkung der Bandkurve: Standard = 3·L'(0)·drive = drive; HQ numerisch (leiser Sinus durch die Hysterese) */
  kleinsignal(drive, hq) {
    if (!hq) return drive;
    const z = { M: 0, Hv: 0 };
    let ein = 0, aus = 0;
    for (let i = 0; i < 4096; i++) {
      const x = 0.02 * Math.sin(2 * Math.PI * i / 256);
      const m = 3 * jaSchritt(z, x * drive, JA);
      if (i >= 2048) { ein += x * x; aus += m * m; }
    }
    return aus > 1e-18 ? Math.sqrt(aus / ein) : drive;
  }

  kanalZustand(c) {
    let z = this.kanal[c];
    if (!z) {
      const wf = Math.ceil(sampleRate * WF_VERZ_MS / 1000 * 2.5) + 4;
      z = {
        hoch: new Float64Array(PH * 2), hochPos: 0,
        runter: new Float64Array(TAPS * 2), runterPos: 0,
        trocken: new Float64Array(VERZ + HB_VERZ + Math.ceil(sampleRate * WF_VERZ_MS / 1000) + 2), trockenPos: 0,
        hbU: new Float64Array(HB_MITTE + 2), hbUPos: 0,   // Verlauf der 4×-Werte (innere Hochtastung)
        hbD: new Float64Array(HB_L), hbDPos: 0,           // Verlauf der 8×-Werte (innere Abwärtstastung)
        preLP: 0, postX1: 0, postY1: 0, env: 0, hfLP: 0, dcX: 0, dcY: 0,
        k1: 0, k2: 0, // Kopfbump (transponierte DF2)
        s1: 0, s2: 0, // Kopfkontur
        ja: { M: 0, Hv: 0 }, adaa: { uAlt: 0, FAlt: 0 }, adaaY: 0, hyLP: 0, hyLP2: 0,
        wf: new Float64Array(wf * 2), wft: new Float64Array(wf * 2), wfPos: 0, wfLen: wf, // je gespiegelt: 32 Punkte am Stück
      };
      this.kanal[c] = z;
    }
    return z;
  }

  /** Einfache Rauschquelle (rosa-ähnlich, 3 Pole) */
  rausch() {
    const w = Math.random() * 2 - 1;
    const r = this.rauschZ;
    r[0] = 0.99765 * r[0] + w * 0.0990460;
    r[1] = 0.96300 * r[1] + w * 0.2965164;
    r[2] = 0.57000 * r[2] + w * 1.0526913;
    return (r[0] + r[1] + r[2] + w * 0.1848) * 0.11;
  }

  process(inputs, outputs) {
    if (this.ende) return false;
    const ein = inputs[0], aus = outputs[0];
    if (!aus || !aus.length) return true;
    const n = aus[0].length;
    const dzA = deltaVerlauf(this, n);
    const fir = this.fir, z0 = this.ist, z1 = this.abgeleitet;
    const sr = sampleRate;
    const g = (k) => [z0[k], (z1[k] - z0[k]) / n];
    const [drive, dDrive] = g('drive'), [mix, dMix] = g('mix'), [vert, dVert] = g('vert'), [ausg, dAusg] = g('ausgleich'), [tiefe, dTiefe] = g('tiefe');
    const hq = z1.hq === 1, kopfAn = z1.kopf === 1, rauschAn = hq && z1.rauschen === 1;
    // Hysterese-Rest (HQ): Anteil 6 % bei viel Bias bis 20 % bei wenig, Eingang tiefpassbegrenzt bei 4 kHz (im 8×-Takt)
    const hyW = hq ? 0.06 + 0.14 * (1 - z1.bias) : 0;
    const hyK = 1 - Math.exp(-2 * Math.PI * 3000 / (sr * OS * 2));
    const hyNorm = z1.hyNorm || 1; // Kleinsignal der Hysterese auf die der Kurve normiert (Abweichung ≈ 0 bei kleinen Signalen)
    const pre = z1.pre, post = z1.post, kopf = z1.kopfF, kontur = z1.konturF;
    if (hq) {
      const d = this.drift;
      d.ph1 += 2 * Math.PI * n / (sr * 83); d.ph2 += 2 * Math.PI * n / (sr * 127);
      d.walk += 0.02 * ((Math.random() * 2 - 1) - d.walk);
      const w = 0.01 * Math.sin(d.ph1) + 0.005 * Math.sin(d.ph2) + 0.006 * d.walk;
      d.wert[0] = 1 + w; d.wert[1] = 1 - 0.8 * w;
    }
    const fcBasis = z1.fcBasis, cw20 = 2 * (1 - Math.cos(2 * Math.PI * Math.min(20000, sr * 0.45) / sr));
    const dcR = 1 - 2 * Math.PI * 6 / sr;
    const envA = 1 - Math.exp(-1 / (sr * 0.003)), envR = 1 - Math.exp(-1 / (sr * 0.08));
    const wfNominal = Math.round(sr * WF_VERZ_MS / 1000); // ganzzahlig: ohne Modulation liest die Verzögerung genau ein Sample
    // HQ: der trockene Weg läuft durch dieselbe modulierte Verzögerung (sonst kämmt Mix < 1 wie ein Flanger)
    const trockenVerz = VERZ + (hq ? HB_VERZ : 0);
    const ms = aus.length === 2 && ein && ein[0] && ein[1];
    if (ms) {
      if (this.msEin[0].length !== n) this.msEin = [new Float32Array(n), new Float32Array(n)];
      const l = ein[0], r = ein[1], m = this.msEin[0], sd = this.msEin[1];
      for (let i = 0; i < n; i++) { m[i] = (l[i] + r[i]) * 0.5; sd[i] = (l[i] - r[i]) * 0.5; }
    }
    // Gleichlauf-Modulation (für beide Ebenen gleich – ein Band): Wow 0,55 Hz, Flutter 5,3/8,9/13 Hz plus etwas Rauschen
    let wfMod = null;
    if (hq && (tiefe > 0 || dTiefe !== 0)) {
      wfMod = new Float64Array(n);
      const ph = this.wfPhase;
      const fq = [0.55, 5.3, 8.9, 13.1], inc = fq.map((f) => 2 * Math.PI * f / sr);
      // Flutter-Anteile so skaliert, dass ihre Tonhöhenabweichung 40/30/20 % der Wow-Abweichung beträgt
      const fl = [1, 0.4 * fq[0] / fq[1], 0.3 * fq[0] / fq[2], 0.2 * fq[0] / fq[3]];
      for (let i = 0; i < n; i++) {
        const t = tiefe + dTiefe * i;
        this.wfRausch += 0.0015 * ((Math.random() * 2 - 1) - this.wfRausch);
        wfMod[i] = t * (fl[0] * Math.sin(ph[0]) + fl[1] * Math.sin(ph[1]) + fl[2] * Math.sin(ph[2]) + fl[3] * Math.sin(ph[3]) + 0.3 * this.wfRausch);
        for (let k = 0; k < 4; k++) { ph[k] += inc[k]; if (ph[k] > 2 * Math.PI) ph[k] -= 2 * Math.PI; }
      }
    }
    const rauschPegel = rauschAn ? Math.pow(10, (z1.rauschDb ?? -62) / 20) : 0;
    const mess = this.messen ? this.messer : null;
    if (mess) mess.start(n);
    for (let c = 0; c < aus.length; c++) {
      const x = ms ? this.msEin[c] : ein && ein[c], y = aus[c];
      if (!x) { y.fill(0); continue; }
      const seite = ms && c === 1;
      const z = this.kanalZustand(c);
      const mA = mess ? mess.abw[c & 1] : null, mL = mess ? mess.lin[c & 1] : null;
      const hoch = z.hoch, runter = z.runter, trk = z.trocken, tLen = trk.length;
      let hp = z.hochPos, rp = z.runterPos, tp = z.trockenPos;
      let preLP = z.preLP, postX1 = z.postX1, postY1 = z.postY1, env = z.env, hfLP = z.hfLP, dcX = z.dcX, dcY = z.dcY, k1 = z.k1, k2 = z.k2;
      const ja = z.ja, wf = z.wf, wft = z.wft, wfLen = z.wfLen, wk = this.wk || (this.wk = new Float64Array(WF_N));
      let wfPos = z.wfPos, s1 = z.s1, s2 = z.s2;
      const up = hq ? z1.unperfekt : 0;
      const tol = hq ? { bias: 1 + (this.tol[c & 1].bias - 1) * up, drive: 1 + (this.tol[c & 1].drive - 1) * up, hf: 1 + (this.tol[c & 1].hf - 1) * up } : null;
      const dft = hq ? 1 + (this.drift.wert[c & 1] - 1) * up : 1;
      const fcB = hq ? fcBasis * tol.hf : fcBasis;
      for (let i = 0; i < n; i++) {
        const vt = vert + dVert * i;
        const dr = (drive + dDrive * i) * (hq ? tol.drive * dft : 1), ag = ausg + dAusg * i;
        const mx = (mix + dMix * i) * (!ms ? 1 : seite ? Math.min(1, 2 * vt) : Math.min(1, 2 * (1 - vt)));
        const ein_i = x[i];
        // trockener Weg verzögern (Ringpuffer, Länge tLen ≥ trockenVerz)
        trk[tp] = ein_i;
        let lesePos = tp - trockenVerz; if (lesePos < 0) lesePos += tLen;
        let trocken = trk[lesePos];
        tp = tp === tLen - 1 ? 0 : tp + 1;
        // Aufnahme-Entzerrung: Höhen anheben
        preLP += pre.a * (ein_i - preLP);
        const vorband = ein_i + pre.g * (ein_i - preLP);
        // Hochtasten + Bandkurve + Abwärtstasten
        hoch[hp] = vorband; hoch[hp + PH] = vorband;
        const basis = hp + PH;
        for (let k = 0; k < OS; k++) {
          let u = 0;
          for (let j = 0; j < PH; j++) u += fir[k + OS * j] * hoch[basis - j];
          u *= OS * dr;
          // Färbung: Bandkurve 3·L(u) gegen ihre Gerade (Steigung 1 im Nullpunkt)
          if (k === 0 && mA) { mA[i] = (3 * langevinT(u) - u) * mx; mL[i] = u; }
          let v;
          if (!hq) {
            // ADAA mittelt über einen Takt (cos-Senke oben: 20 kHz −0,47 dB) – ein kleiner 2-Tap-Boost zieht das wieder gerade
            const ya = bandADAA(z.adaa, u);
            v = ya + 0.2 * (ya - z.adaaY); z.adaaY = ya;
          }
          else {
            // innere 2×: Zwischenwerte per Halbband (gerade Phase = Wert von vor 6 Takten, ungerade = gefiltert)
            const hu = z.hbU, hl = hu.length, hd = z.hbD;
            let up = z.hbUPos; hu[up] = u; z.hbUPos = up = up === hl - 1 ? 0 : up + 1;
            const alt = (j) => { let q = up - 1 - j; while (q < 0) q += hl; return hu[q]; };
            const gerade = alt(HB_MITTE / 2);
            let ungerade = 0;
            for (let t = 0; t < HB_UNGERADE.length; t++) { const i = HB_UNGERADE[t]; ungerade += HB[i] * alt((i - 1) / 2); }
            ungerade *= 2;
            // Bei AC-Vormagnetisierung folgt die Remanenz der anhysteretischen Kurve (Langevin) – der Bias löscht die
            // Schleife. Ein kleiner Hysterese-Rest bleibt (umso mehr, je weniger Bias), und zwar nur dort, wo viel Fluss
            // ist: unter ~4 kHz. Beides im 8×-Takt, in zeitlicher Reihenfolge; Ausgang nach dem geraden Wert.
            let dp = z.hbDPos;
            // Hysterese-Rest im 8×-Takt, Eingang mit zwei Polen auf ~3 kHz begrenzt (dort ist der Fluss; die Schleife selbst
            // hat scharfe Ecken und darf oben nichts beitragen): nur die Abweichung von der anhysteretischen Kurve kommt dazu –
            // so bleibt der Kleinsignal-Frequenzgang unberührt, nur die Schleife (Klirr, Phase) wirkt
            const schritt = (uu) => {
              let abw = 0;
              if (hyW > 0) {
                z.hyLP += hyK * (uu - z.hyLP); z.hyLP2 += hyK * (z.hyLP - z.hyLP2);
                abw = hyW * (hyNorm * 3 * jaSchritt(ja, z.hyLP2, JA) - 3 * langevin(z.hyLP2));
              }
              return bandADAA(z.adaa, uu) + abw;
            };
            hd[dp] = schritt(gerade); dp = dp === HB_L - 1 ? 0 : dp + 1;
            let s = 0;
            for (let t = 0; t < HB_L; t++) { let q = dp - 1 - t; if (q < 0) q += HB_L; s += HB[t] * hd[q]; }
            hd[dp] = schritt(ungerade); dp = dp === HB_L - 1 ? 0 : dp + 1;
            z.hbDPos = dp;
            v = s;
          }
          if (dzA) {
            // Delta-Pfad: nur der nichtlineare Anteil der Bandkurve (3·L(u) gegen ihre Gerade), gleich heruntergetastet
            const rd = z.deltaRunter ||= new Float64Array(TAPS * 2), rr = 3 * langevinT(u) - u;
            rd[rp] = rr; rd[rp + TAPS] = rr;
          }
          runter[rp] = v; runter[rp + TAPS] = v;
          rp = rp === TAPS - 1 ? 0 : rp + 1;
        }
        hp = hp === PH - 1 ? 0 : hp + 1;
        let band = 0;
        {
          const b2 = (rp === 0 ? TAPS - 1 : rp - 1) + TAPS;
          for (let t = 0; t < TAPS; t++) band += fir[t] * runter[b2 - t];
        }
        band *= ag;
        // Wiedergabe-Entzerrung (Umkehrung)
        const ent = post.b0 * band + post.b1 * postX1 - post.a1 * postY1; postX1 = band; postY1 = ent; band = ent;
        // Pegelabhängiger Höhenverlust (Selbstlöschung): erst oberhalb einer Schwelle, dann bis −60 % Grenzfrequenz
        const betrag = Math.abs(vorband * dr);
        env += (betrag > env ? envA : envR) * (betrag - env);
        const ueber = Math.max(0, Math.min(1, (env - 0.8) / 1.2)); // erst nahe der Sättigung (Langevin knickt ab u ≈ 1)
        const fc = fcB * (1 - 0.5 * ueber);
        // Ein Pol, dessen Dämpfung bei 20 kHz unabhängig von der Abtastrate genau der des analogen Pols bei fc entspricht
        // (ein Pol per e^−2πfc/fs würde bei 48 kHz einen Pol über der Nyquistfrequenz fast ganz verschlucken): geschlossene Lösung
        const cq = cw20 * (fc / 20000) * (fc / 20000);
        const hfK = Math.min(1, (-cq + Math.sqrt(cq * cq + 4 * cq)) / 2);
        hfLP += hfK * (band - hfLP); band = hfLP;
        // Kopfbump
        if (kopfAn) {
          const o = kopf.b0 * band + k1;
          k1 = kopf.b1 * band - kopf.a1 * o + k2;
          k2 = kopf.b2 * band - kopf.a2 * o;
          band = o;
          if (hq) { const o2 = kontur.b0 * band + s1; s1 = kontur.b1 * band - kontur.a1 * o2 + s2; s2 = kontur.b2 * band - kontur.a2 * o2; band = o2; }
        }
        // DC-Sperre
        const w = band - dcX + dcR * dcY; dcX = band; dcY = w; band = w;
        let rest = 0;
        if (dzA) {
          // Delta: Rest auf Eingangspegel, dann dieselbe Wiedergabe-Entzerrung, Höhenverlust, Kopfbump und DC-Sperre wie das Band
          const rd = z.deltaRunter, b2 = (rp === 0 ? TAPS - 1 : rp - 1) + TAPS;
          let r = 0; for (let t = 0; t < TAPS; t++) r += fir[t] * rd[b2 - t];
          r *= ag;
          const d = z.delta ||= { pX: 0, pY: 0, hf: 0, k1: 0, k2: 0, s1: 0, s2: 0, dX: 0, dY: 0 };
          const e2 = post.b0 * r + post.b1 * d.pX - post.a1 * d.pY; d.pX = r; d.pY = e2; r = e2;
          d.hf += hfK * (r - d.hf); r = d.hf;
          if (kopfAn) {
            const o = kopf.b0 * r + d.k1; d.k1 = kopf.b1 * r - kopf.a1 * o + d.k2; d.k2 = kopf.b2 * r - kopf.a2 * o; r = o;
            if (hq) { const o2 = kontur.b0 * r + d.s1; d.s1 = kontur.b1 * r - kontur.a1 * o2 + d.s2; d.s2 = kontur.b2 * r - kontur.a2 * o2; r = o2; }
          }
          const rw = r - d.dX + dcR * d.dY; d.dX = r; d.dY = rw;
          rest = rw;
        }
        // Gleichlauf (HQ): modulierte Verzögerung um wfNominal
        if (hq) {
          wf[wfPos] = band; wf[wfPos + wfLen] = band;
          wft[wfPos] = trocken; wft[wfPos + wfLen] = trocken;
          // Kratz-Flutter: feine, schnelle Unregelmäßigkeit (Rauschen bis ~150 Hz, Bruchteile eines Samples)
          if (c === 0 || !ms) this.kratz += 0.02 * ((Math.random() * 2 - 1) - this.kratz);
          // Kratz-Flutter: feine, schnelle Unregelmäßigkeit am Kopf – klein halten (≈ 0,3 µs Spitze), sonst verschmieren die Höhen
          const d = wfNominal + (wfMod ? wfMod[i] : 0) + this.kratz * 0.015 * sr / 48000 * (0.3 + z1.gleichlauf) * up;
          let lp = wfPos - d; while (lp < 0) lp += wfLen;
          const i0 = Math.floor(lp), fr = lp - i0;
          const pf = fr * WF_P, p = Math.floor(pf), a = pf - p, h0 = p * WF_N, h1 = h0 + WF_N;
          for (let j = 0; j < WF_N; j++) wk[j] = WF_TAB[h0 + j] + a * (WF_TAB[h1 + j] - WF_TAB[h0 + j]);
          let st = i0 - (WF_N / 2 - 1); if (st < 0) st += wfLen;
          let sb = 0; for (let j = 0; j < WF_N; j++) sb += wk[j] * wf[st + j];
          band = sb;
          if (mx !== 1) { let st2 = 0; for (let j = 0; j < WF_N; j++) st2 += wk[j] * wft[st + j]; trocken = st2; }
          wfPos = wfPos === wfLen - 1 ? 0 : wfPos + 1;
          // Modulationsrauschen: läuft mit dem Signal mit (≈ −46 dB unter der Hüllkurve), unabhängig vom Grundrauschen
          band += this.rausch() * (Math.min(1, env) * 0.0025 * up + (rauschAn ? rauschPegel * (seite ? 0.7 : 1) : 0));
        }
        const normal = trocken + (band - trocken) * mx;
        y[i] = dzA ? normal * (1 - dzA[i]) + rest * mx * dzA[i] : normal;
      }
      z.hochPos = hp; z.runterPos = rp; z.trockenPos = tp; z.preLP = preLP; z.postX1 = postX1; z.postY1 = postY1;
      z.env = env; z.hfLP = hfLP; z.dcX = dcX; z.dcY = dcY; z.k1 = k1; z.k2 = k2; z.wfPos = wfPos; z.s1 = s1; z.s2 = s2;
    }
    if (ms) {
      const yM = aus[0], yS = aus[1];
      for (let i = 0; i < n; i++) { const m = yM[i], sd = yS[i]; yM[i] = m + sd; yS[i] = m - sd; }
    }
    if (mess) mess.sammeln(n, ms, this.port);
    if (ms) {
      if (hq) {
        // Azimut: Rechts um wenige µs verzögern (Allpass 1. Ordnung, Verzögerung ≈ azimut·mix Samples)
        const dAz = z1.azimut * Math.max(0, Math.min(1, z1.mix));
        const eta = (1 - dAz) / (1 + dAz);
        const r = aus[1];
        let zz = this.azimutZ;
        for (let i = 0; i < n; i++) { const xin = r[i]; const yo = eta * xin + zz; zz = xin - eta * yo; r[i] = yo; }
        this.azimutZ = zz;
      }
    }
    this.ist = z1;
    return true;
  }
}
registerProcessor('aw-band', AwBand);
