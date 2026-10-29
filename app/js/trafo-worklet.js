// Übertrager im Audio-Thread („AmberIron“). Sitzt hinter der Röhre, vor dem Band.
//
// Physik, so wie sie in den Datenblättern steht (Jensen: „distortion will be further reduced by lower source impedances“):
// Eine Spannungsquelle treibt über ihren Innenwiderstand plus Wicklungswiderstand (zusammen R) die Primärwicklung. Der Fluss
// ist das Integral der Spannung an der Wicklung, der Magnetisierungsstrom folgt der (nichtlinearen) Kernkennlinie H(B).
// Die Ausgangsspannung ist die Wicklungsspannung: u_aus = u_ein − R · i_m(Φ).
//  → Mit R → 0 gibt es weder Bassabfall noch Klirr (die Quelle hält die Spannung), mit R > 0 kommt beides: der Verlust im
//    Bass (Hochpass 1. Ordnung mit f = R/2πL) und der Klirr, der mit der Krümmung von H(B) wächst – fast nur im Bass, weil
//    nur dort viel Fluss fließt. Genau darum sättigt ein Übertrager unten und bleibt oben sauber.
//  → Quelle: niederohmig (Operationsverstärker), Studio (600 Ω) oder hochohmig (Röhrenstufe). Ist AmberGlow an, treibt die
//    Röhre den Übertrager – dann wird er von selbst hochohmig gefahren, wie in einem echten Röhrengerät.
// Rechnung je Kanal (L/R = zwei Übertrager): impliziter Integrator-Schritt (Newton), Kernkennlinie H(B) = B / (1 − (B/Bs)²)
// (ungerade, k3 ∝ B² wie bei realen Kernen: 6 dB mehr Pegel = 12 dB mehr k3), dahinter Streuinduktivität/Wicklungskapazität
// als leichter Kuhschwanz oben.
// HQ: Hysterese als Preisach-Summe aus Play-Operatoren (Spielbreiten ∝ r, Gewichte ∝ r → Rayleigh-Verhalten: der feine Klirr
// leiser Signale nimmt mit dem Pegel ab), stetig und sprungfrei; dazu 2× Oversampling, Toleranzen L/R, Drift.
const STAND = '3';
// HQ-Oversampling nach Abtastrate: innere Rate ~96–192 kHz reicht dem Kern (Klirr fast nur im Bass) – unter 75 kHz 2×, darüber 1×
const OS = sampleRate >= 75000 ? 1 : 2;
const TAPS = OS === 1 ? 1 : 47 * OS + 1;
const PH = Math.ceil(TAPS / OS);
const VERZ = (TAPS - 1) / OS;

function besselI0(x) {
  let s = 1, t = 1;
  for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; }
  return s;
}
function firEntwurf(sr) {
  const h = new Float64Array(PH * OS);
  const m = (TAPS - 1) / 2, fc = 0.5 / OS, beta = 8.6, i0b = besselI0(beta);
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

/**
 * Kerne. bs = Sättigungsfluss (normiert: Fluss 1 = Vollpegel bei fRef), fRef = Bezugsfrequenz der Flussnormierung (kleinerer
 * Kern = höhere fRef = sättigt schon bei höheren Bassfrequenzen), rCu = Wicklungswiderstand als Hochpass-Eckfrequenz (Hz) bei
 * idealer Quelle, hfF/hfDb = Kuhschwanz oben, hyst = Spielbreite der Hysterese (HQ), hystW = ihr Anteil.
 */
const KERNE = {
  nickel: { bs: 2.6, fRef: 20, rCu: 1.0, hfF: 14000, hfDb: 0.3, hyst: 0.012, hystW: 0.25 },
  stahl: { bs: 2.0, fRef: 24, rCu: 2.0, hfF: 11000, hfDb: 0.5, hyst: 0.03, hystW: 0.35 },
  eisen: { bs: 1.5, fRef: 30, rCu: 3.5, hfF: 8000, hfDb: -1.2, hyst: 0.07, hystW: 0.45 },
};
// Quelle: zusätzliche Hochpass-Eckfrequenz (Hz) durch den Innenwiderstand der Quelle (R/2πL)
const QUELLEN = { nieder: 0.6, studio: 3.0, roehre: 9.0 };
const PLAYS = 6; // Play-Operatoren je Kanal (HQ)

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

class AwTrafo extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const p = (o && o.processorOptions) || {};
    this.kanal = [];
    this.fir = firEntwurf(sampleRate);
    this.ziel = { drive: 1, kern: 'stahl', glanz: 0.5, mix: 1, vert: 0.5, auto: 1, hq: 0, quelle: 'studio' };
    this.trockenPuffer = [new Float32Array(128), new Float32Array(128)];
    this.restPuffer = [new Float32Array(128), new Float32Array(128)];
    this.ist = null;
    this.setzen(p);
    this.ist = this.abgeleitet;
    this.tol = [{ f: 1.03, d: 1.02, r: 1.06 }, { f: 0.97, d: 0.98, r: 0.95 }];
    this.drift = { ph: 0.7, wert: [1, 1] };
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
    if (typeof d.kern === 'string' && KERNE[d.kern]) z.kern = d.kern;
    if (typeof d.quelle === 'string' && QUELLEN[d.quelle] !== undefined) z.quelle = d.quelle;
    if (typeof d.glanz === 'number') z.glanz = Math.max(0, Math.min(1, d.glanz));
    if (typeof d.mix === 'number') z.mix = Math.max(0, Math.min(1, d.mix));
    if (typeof d.vert === 'number') z.vert = Math.max(0, Math.min(1, d.vert));
    if (typeof d.auto === 'number' || typeof d.auto === 'boolean') z.auto = d.auto ? 1 : 0;
    if (typeof d.hq === 'number' || typeof d.hq === 'boolean') z.hq = d.hq ? 1 : 0;
    const neuStart = this.abgeleitet && (this.abgeleitet.kern !== z.kern || this.abgeleitet.hq !== z.hq);
    this.abgeleitet = this.ableiten(z);
    if (neuStart) for (const k of this.kanal) if (k) { k.phi = 0; k.play.fill(0); }
  }

  ableiten(z) {
    const k = KERNE[z.kern];
    const sr = sampleRate;
    // Kuhschwanz oben: je Kern, Glanz ±1 dB
    const gDb = k.hfDb + (z.glanz - 0.5) * 2;
    const A = Math.pow(10, gDb / 40), w0 = 2 * Math.PI * Math.min(k.hfF, sr * 0.45) / sr, cw = Math.cos(w0), sw = Math.sin(w0);
    const al = sw / 2 * Math.SQRT2;
    const sq = 2 * Math.sqrt(A) * al;
    const a0 = (A + 1) - (A - 1) * cw + sq;
    const shelf = {
      b0: A * ((A + 1) + (A - 1) * cw + sq) / a0, b1: -2 * A * ((A - 1) + (A + 1) * cw) / a0, b2: A * ((A + 1) + (A - 1) * cw - sq) / a0,
      a1: 2 * ((A - 1) - (A + 1) * cw) / a0, a2: ((A + 1) - (A - 1) * cw - sq) / a0,
    };
    // Widerstand (Quelle + Wicklung) als Hochpass-Eckfrequenz; normiert: rho = fHP / fRef
    const fHP = k.rCu + QUELLEN[z.quelle];
    const rho = fHP / k.fRef;
    // Play-Breiten (HQ): r_j ∝ j, Gewichte ∝ r_j (Rayleigh-Verteilung), normiert
    const r = [], w = []; let ws = 0;
    for (let j = 1; j <= PLAYS; j++) { r.push(k.hyst * j / PLAYS); w.push(j); ws += j; }
    for (let j = 0; j < PLAYS; j++) w[j] /= ws;
    return { ...z, k, shelf, rho, wRef: 2 * Math.PI * k.fRef, playR: r, playW: w };
  }

  kanalZustand(c) {
    let z = this.kanal[c];
    if (!z) {
      z = { phi: 0, s1: 0, s2: 0, play: new Float64Array(PLAYS),
        hoch: new Float64Array(PH * 2), hochPos: 0, runter: new Float64Array(TAPS * 2), runterPos: 0,
        trocken: new Float64Array(VERZ + 2), trockenPos: 0 };
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
    const z0 = this.ist, z1 = this.abgeleitet;
    const drive = z0.drive, dDrive = (z1.drive - z0.drive) / n;
    const mix = z0.mix, dMix = (z1.mix - z0.mix) / n;
    const vert = z0.vert ?? 0.5, dVert = ((z1.vert ?? 0.5) - vert) / n;
    // Stereo: nass und trocken getrennt sammeln, gemischt wird danach in Mitte/Seite (Verteilung wie bei Glow und Silk)
    const ms = aus.length === 2 && ein && ein[0] && ein[1];
    if (ms && this.trockenPuffer[0].length !== n) { this.trockenPuffer = [new Float32Array(n), new Float32Array(n)]; this.restPuffer = [new Float32Array(n), new Float32Array(n)]; }
    const hq = z1.hq === 1, k = z1.k, sh = z1.shelf, sr = sampleRate, auto = z1.auto === 1;
    const bs = k.bs, bs2 = bs * bs, rhoBasis = z1.rho;
    const playR = z1.playR, playW = z1.playW, hystW = hq ? k.hystW : 0;
    if (hq) {
      const d = this.drift;
      d.ph += 2 * Math.PI * n / (sr * 97);
      d.wert[0] = 1 + 0.006 * Math.sin(d.ph); d.wert[1] = 1 - 0.005 * Math.sin(d.ph * 1.3 + 1);
    }
    const mess = this.messen ? this.messer : null;
    if (mess) mess.start(n);
    for (let c = 0; c < aus.length; c++) {
      const x = ein && ein[c], y = aus[c];
      if (!x) { y.fill(0); continue; }
      const z = this.kanalZustand(c);
      const mA = mess ? mess.abw[c & 1] : null, mL = mess ? mess.lin[c & 1] : null;
      let kAbw = 0, kLin = 0; // Färbung: Magnetisierungsstrom gegen den eines linearen Kerns (gleicher Fluss)
      let phi = z.phi, s1 = z.s1, s2 = z.s2;
      const play = z.play;
      const tol = hq ? this.tol[c & 1] : { f: 1, d: 1, r: 1 };
      const dft = hq ? this.drift.wert[c & 1] : 1;
      const fsK = hq ? sr * OS : sr;
      const cI = z1.wRef * tol.f * dft / fsK;  // Integrationsschritt (Fluss je Spannung und Takt)
      const rho = rhoBasis * tol.r;
      const fir = this.fir, hoch = z.hoch, runter = z.runter, trk = z.trocken, tLen = trk.length;
      let hpP = z.hochPos, rp = z.runterPos, tp = z.trockenPos;
      // ein Takt des Kerns: Spannung u → neuer Fluss (implizit, Newton), Magnetisierungsstrom, Wicklungsspannung
      const kern = (u) => {
        let p = phi;
        for (let it = 0; it < 3; it++) {
          let b = p, dbdp = 1;
          if (hystW > 0) {
            // Play-Operatoren (Preisach): y_j folgt p mit Spiel r_j; Ableitung 1, wenn sie mitläuft, sonst 0
            let bh = 0, dh = 0;
            for (let j = 0; j < PLAYS; j++) {
              const r = playR[j]; let yj = play[j];
              if (p - yj > r) { yj = p - r; dh += playW[j]; } else if (yj - p > r) { yj = p + r; dh += playW[j]; }
              bh += playW[j] * yj;
            }
            b = (1 - hystW) * p + hystW * bh; dbdp = (1 - hystW) + hystW * dh;
          }
          const q = Math.min(0.96, b * b / bs2);
          const H = b / (1 - q);
          const dH = (1 + q) / ((1 - q) * (1 - q)) * dbdp;
          const f = p - phi - cI * (u - rho * H);
          const df = 1 + cI * rho * dH;
          p -= f / df;
          if (p > bs * 0.98) p = bs * 0.98; else if (p < -bs * 0.98) p = -bs * 0.98;
        }
        let bh = 0;
        if (hystW > 0) {
          for (let j = 0; j < PLAYS; j++) {
            const r = playR[j]; let yj = play[j];
            if (p - yj > r) yj = p - r; else if (yj - p > r) yj = p + r;
            play[j] = yj; bh += playW[j] * yj;
          }
        }
        const b = hystW > 0 ? (1 - hystW) * p + hystW * bh : p;
        const q = Math.min(0.96, b * b / bs2);
        const H = b / (1 - q);
        phi = p;
        kAbw = rho * (H - b); kLin = u - rho * b; // Hysterese (Phase, Verluste) zählt nicht als Klirr
        return u - rho * H;
      };
      for (let i = 0; i < n; i++) {
        const dr = (drive + dDrive * i) * tol.d;
        const mx = mix + dMix * i;
        const e = x[i];
        let v, trocken = e, rest = 0;
        if (!hq) {
          v = kern(e * dr);
          if (mA) { mA[i] = kAbw * mx; mL[i] = kLin; }
          if (dzA) rest = -kAbw;
        } else {
          trk[tp] = e;
          let lp = tp - VERZ; if (lp < 0) lp += tLen;
          trocken = trk[lp];
          tp = tp === tLen - 1 ? 0 : tp + 1;
          hoch[hpP] = e; hoch[hpP + PH] = e;
          const basis = hpP + PH;
          for (let s = 0; s < OS; s++) {
            let u = 0;
            for (let j = 0; j < PH; j++) u += fir[s + OS * j] * hoch[basis - j];
            const w = kern(u * OS * dr);
            if (s === 0 && mA) { mA[i] = kAbw * mx; mL[i] = kLin; }
            if (dzA) { const rd = z.deltaRunter ||= new Float64Array(TAPS * 2); rd[rp] = -kAbw; rd[rp + TAPS] = -kAbw; }
            runter[rp] = w; runter[rp + TAPS] = w;
            rp = rp === TAPS - 1 ? 0 : rp + 1;
          }
          hpP = hpP === PH - 1 ? 0 : hpP + 1;
          v = 0;
          const b2 = (rp === 0 ? TAPS - 1 : rp - 1) + TAPS;
          for (let t = 0; t < TAPS; t++) v += fir[t] * runter[b2 - t];
          if (dzA) { const rd = z.deltaRunter; rest = 0; for (let t = 0; t < TAPS; t++) rest += fir[t] * rd[b2 - t]; }
        }
        if (auto) v /= dr;
        // Kuhschwanz oben, transponierte DF2
        const o = sh.b0 * v + s1;
        s1 = sh.b1 * v - sh.a1 * o + s2;
        s2 = sh.b2 * v - sh.a2 * o;
        v = o;
        if (dzA) {
          // Delta: nur der nichtlineare Magnetisierungsstrom (gegen einen linearen Kern), auf Eingangspegel und durch denselben Kuhschwanz
          if (auto) rest /= dr;
          const d = z.delta ||= { s1: 0, s2: 0 };
          const od = sh.b0 * rest + d.s1; d.s1 = sh.b1 * rest - sh.a1 * od + d.s2; d.s2 = sh.b2 * rest - sh.a2 * od; rest = od;
        }
        if (ms) { y[i] = v; this.trockenPuffer[c][i] = trocken; this.restPuffer[c][i] = rest; }
        else { const normal = trocken + (v - trocken) * mx; y[i] = dzA ? normal * (1 - dzA[i]) + rest * mx * dzA[i] : normal; }
      }
      z.hochPos = hpP; z.runterPos = rp; z.trockenPos = tp;
      z.phi = phi; z.s1 = s1; z.s2 = s2;
    }
    if (ms) {
      const yl = aus[0], yr = aus[1], tl = this.trockenPuffer[0], tr = this.trockenPuffer[1];
      for (let i = 0; i < n; i++) {
        const mx = mix + dMix * i, vt = vert + dVert * i;
        const mxM = mx * Math.min(1, 2 * (1 - vt)), mxS = mx * Math.min(1, 2 * vt);
        const dM = (tl[i] + tr[i]) * 0.5, dS = (tl[i] - tr[i]) * 0.5, wM = (yl[i] + yr[i]) * 0.5, wS = (yl[i] - yr[i]) * 0.5;
        const nM = dM + (wM - dM) * mxM, nS = dS + (wS - dS) * mxS;
        let oM = nM, oS = nS;
        if (dzA) {
          const dz = dzA[i], rl = this.restPuffer[0][i], rr = this.restPuffer[1][i];
          oM = nM * (1 - dz) + (rl + rr) * 0.5 * mxM * dz; oS = nS * (1 - dz) + (rl - rr) * 0.5 * mxS * dz;
        }
        yl[i] = oM + oS; yr[i] = oM - oS;
      }
    }
    if (mess) mess.sammeln(n, false, this.port);
    this.ist = z1;
    return true;
  }
}
registerProcessor('aw-trafo', AwTrafo);
