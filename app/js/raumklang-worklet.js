// Raumklang-Worklet: Verfahren „Zwei Ebenen“ (läuft im Audio-Thread). Die älteren Verfahren „Weichen“ und „Spektral“
// sind seit 0.1.118 entfernt; Center (LCR per M/S) und Bassmanagement rechnet raumklang.js im Graphen.

// Fassung – wird beim Start an die Oberfläche gemeldet (Anzeige unter „Raumklang fein einstellen“)
const STAND = '0.1.118';

// ===================== Verfahren „Zwei Ebenen“ (ab 0.1.96) =====================
// Eingang Stereo. STFT mit 2048 Punkten, 75 % Überlappung, √Hann. Pro Frequenz-Bin:
//  • Raum: was zwischen L und R unkorreliert ist (Kohärenz, Messfenster ~50 ms) → wird nach hinten KOPIERT
//    (Front bleibt dafür unverändert). Ab 0.1.110 werden die Kreuzspektren vor der Entscheidung über die Frequenz geglättet
//    (±1/12 Oktave) und die Maske öffnet langsam / schließt sofort – ohne das klingelte und flackerte es („Musical Noise“,
//    Vorechos). Transienten-Unterdrückung mit Vorausschau (4 ms) und Ducking wie beim alten Verfahren.
//  • Effekte: gegenphasige Anteile (Korrelation deutlich negativ) und sehr hart gepannte Anteile → werden nach hinten
//    VERSCHOBEN: leistungserhaltend (vorne cos, hinten sin), gleiche Seite. Entschieden wird je Terzband (ab 150 Hz),
//    nicht je Frequenzlinie: Messung über ~150 ms, Verstärkung gleitet (auf ~200 ms, ab ~1 s; Breite 350 ms / 2,5 s), wird über
//    benachbarte Bänder geglättet, bekommt einen Breitbandanteil und wird zwischen den Bandmitten weich verteilt – so
//    flackern keine schmalen Bereiche (kein „Zwitschern“), keine Terz sticht hinten heraus (nicht „notchy“), nichts pumpt.
//    Unter 150 Hz nichts, bis 250 Hz eingeblendet.
//  • Breite (ab 0.1.98): was im Vordergrund steht (Bandpegel nicht unter dem Langzeitmittel des Bands), auf beiden Seiten
//    ähnlich laut, aber kaum korreliert ist – breite Vocal-Doubles, Leslie-Orgel, breite Synths – wird wie die Effekte
//    verschoben, nur dosiert (eigener Regler). Leise Hallfahnen fallen unter das Langzeitmittel und bleiben im Raum.
//  • Center (optional): nur stabile Mitte (stark korreliert, mittig gepannt), ebenfalls je Terzband – kein Abzug vorne.
// Ausgänge: 0 = Raum L/R, 1 = Effekte Ls/Rs, 2 = Front L/R (Original minus Verschobenes), 3 = Center (mono).
// Alle Ausgänge sind um LATENZ_E = 2048 Samples verzögert (Rekonstruktion exakt: Front = Original, wenn nichts verschoben wird).
const NE = 2048, HOPE = 512, LATE = NE - HOPE, LATENZ_E = NE;
const glatt = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

class UpmixEbenen extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const p = (o && o.processorOptions) || {};
    const k = (ms) => Math.exp(-1 / (sampleRate * ms / 1000));
    this.tMin = Math.pow(10, (p.transient ?? -8) / 20);
    // Ducking sanfter als beim alten Verfahren (höchstens −3 dB, langsamer), sonst pumpt der Raum hörbar mit
    this.dMin = Math.max(Math.pow(10, (p.ducking ?? -5) / 20), Math.pow(10, -3 / 20));
    this.fA = k(0.5); this.fR = k(40); this.sA = k(25); this.sR = k(250); this.dA = k(60); this.dR = k(400);
    this.lK = k(2000); this.gA = k(3); this.gR = k(40);   // Eingriff auf 3 ms statt 1 ms: kein Knacken auf Hallfahnen
    this.fast = 0; this.slow = 0; this.duck = 0; this.lang = 0; this.g = 1;
    this.vor = Math.round(sampleRate * 0.004);             // 4 ms Vorausschau (passend zum weicheren Eingriff)
    this.gRing = new Float32Array(4096).fill(1); this.gPos = 0;
    this.effekte = Math.max(0, Math.min(1.5, p.effekte ?? 0.5)); this.effG = this.effekte;
    this.breite = Math.max(0, Math.min(1, p.breite ?? 0.35)); this.breiteG = this.breite;
    this.mitCenter = !!p.center;
    const H = NE / 2 + 1;
    this.win = new Float32Array(NE);
    for (let i = 0; i < NE; i++) this.win[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / NE));
    this.inL = new Float32Array(NE); this.inR = new Float32Array(NE);
    const f = () => new Float32Array(NE), f2 = () => new Float32Array(2 * NE);
    this.out = [f(), f(), f(), f(), f(), f(), f()];         // Raum L/R, Effekte L/R, Front L/R, Center
    this.acc = [f2(), f2(), f2(), f2(), f2(), f2(), f2()];
    this.rover = LATE;
    this.re = new Float64Array(NE); this.im = new Float64Array(NE);
    this.zr0 = new Float64Array(NE); this.zi0 = new Float64Array(NE);
    const d = () => new Float64Array(H);
    this.aLL = d(); this.aRR = d(); this.aXr = d(); this.aXi = d();
    this.wa = d(); this.cm = d(); this.gf = d(); this.gr = d();
    // Raum-Maske ohne Ringing (ab 0.1.110): die Kreuzspektren werden vor der Kohärenz über die Frequenz geglättet
    // (±1/12 Oktave, mindestens ±2 Linien, Dreieckskern), die Maske danach zeitlich geführt (auf ~80 ms, zu ~25 ms)
    // und unter 8 % geschlossen. Eine je Linie flackernde Maske hat im 46-ms-Fenster eine lange Impulsantwort:
    // Vorechos, „Musical Noise“, metallisches Klingeln. Geglättet ist sie kurz und ruhig.
    this.sLL = d(); this.sRR = d(); this.sXr = d(); this.sXi = d(); this.waG = d();
    this.praefix = new Float64Array(H + 1);
    this.gw = new Int16Array(H);
    for (let kk = 0; kk < H; kk++) { const w = Math.round(kk * 0.03); this.gw[kk] = w < 1 ? 1 : w > 12 ? 12 : w; } // halbe Breite je Durchgang (2 Durchgänge)
    // Terzbänder ab 150 Hz (bis 20 kHz bzw. Nyquist) – Messung und Entscheidung je Band, Verteilung je Bin interpoliert
    const kanten = [];
    for (let fr = 150; fr < Math.min(20000, sampleRate / 2); fr *= Math.pow(2, 1 / 3)) kanten.push(fr);
    kanten.push(sampleRate / 2);
    const nB = this.nB = kanten.length - 1;
    const mitten = kanten.slice(0, -1).map((kk, i) => Math.sqrt(kk * Math.min(kanten[i + 1], 18000)));
    this.binBand = new Int16Array(H).fill(-1);
    this.ip0 = new Uint16Array(H); this.ip1 = new Uint16Array(H); this.ipW = new Float64Array(H);
    for (let kk = 0; kk < H; kk++) {
      const fr = kk * sampleRate / NE;
      for (let b = 0; b < nB; b++) if (fr >= kanten[b] && (fr < kanten[b + 1] || b === nB - 1)) { this.binBand[kk] = b; break; }
      if (fr <= mitten[0]) { this.ip0[kk] = this.ip1[kk] = 0; }
      else if (fr >= mitten[nB - 1]) { this.ip0[kk] = this.ip1[kk] = nB - 1; }
      else {
        let b = 0; while (fr >= mitten[b + 1]) b++;
        const x = Math.log(fr / mitten[b]) / Math.log(mitten[b + 1] / mitten[b]);
        this.ip0[kk] = b; this.ip1[kk] = b + 1; this.ipW[kk] = 0.5 - 0.5 * Math.cos(Math.PI * x); // weicher Übergang
      }
    }
    const bd = () => new Float64Array(nB);
    this.tLL = bd(); this.tRR = bd(); this.tXr = bd();   // Summen des aktuellen Blocks
    this.bLL = bd(); this.bRR = bd(); this.bXr = bd();   // geglättet
    this.bE = bd(); this.bC = bd(); this.bW = bd();      // Verstärkungen je Band (Effekte, Center, Breite)
    this.bLang = bd();                                   // Langzeitpegel je Band (~3 s) für „Vordergrund“
    this.bP = bd(); this.sE = bd(); this.sW = bd();      // Bandpegel; über benachbarte Bänder geglättete Verstärkungen
    this.bandW = d();
    for (let kk = 0; kk < H; kk++) { const fr = kk * sampleRate / NE; this.bandW[kk] = fr <= 150 ? 0 : fr >= 250 ? 1 : (fr - 150) / 100; }
    const blk = (s) => Math.exp(-(HOPE / sampleRate) / s);
    this.lamA = blk(0.05); this.lamB = blk(0.15); this.gAuf = blk(0.2); this.gAb = blk(1.0); this.gAufW = blk(0.35); this.gAbW = blk(2.5); this.lamL = blk(3);
    this.mAuf = blk(0.08);
    this.rev = new Uint16Array(NE);
    const bits = Math.log2(NE);
    for (let i = 0; i < NE; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    this.cos = new Float64Array(NE / 2); this.sin = new Float64Array(NE / 2);
    for (let i = 0; i < NE / 2; i++) { this.cos[i] = Math.cos(2 * Math.PI * i / NE); this.sin[i] = Math.sin(2 * Math.PI * i / NE); }
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (typeof m.effekte === 'number') this.effekte = Math.max(0, Math.min(1.5, m.effekte));
      if (typeof m.breite === 'number') this.breite = Math.max(0, Math.min(1, m.breite));
      if (m.ende) this.ende = true;
    };
    this.port.postMessage({ stand: STAND, verfahren: 'ebenen' });
  }

  fft(re, im, inv) {
    const { rev, cos, sin } = this;
    for (let i = 0; i < NE; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= NE; size <<= 1) {
      const half = size >> 1, step = NE / size;
      for (let s = 0; s < NE; s += size) {
        for (let j = 0; j < half; j++) {
          const wr = cos[j * step], wi = inv ? sin[j * step] : -sin[j * step];
          const a = s + j, b = a + half;
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  /** Über die Frequenz glätten: gleitendes Mittel mit frequenzabhängiger Breite, zweimal (= Dreieckskern); in place */
  glaetten(a) {
    const H = NE / 2, P = this.praefix, gw = this.gw;
    for (let d = 0; d < 2; d++) {
      P[0] = 0;
      for (let kk = 0; kk <= H; kk++) P[kk + 1] = P[kk] + a[kk];
      for (let kk = 0; kk <= H; kk++) {
        const w = gw[kk];
        let u = kk - w, v = kk + w;
        if (u < 0) u = 0;
        if (v > H) v = H;
        a[kk] = (P[v + 1] - P[u]) / (v - u + 1);
      }
    }
  }

  /** Spektrum (Z = L + iR, als Kopie in zr0/zi0) mit einer reellen, symmetrischen Bin-Verstärkung → Ausgabe-Paar */
  ausgabe(gain, oi) {
    const { re, im, zr0, zi0, win } = this, H = NE / 2;
    for (let kk = 0; kk < NE; kk++) { const w = gain[kk <= H ? kk : NE - kk]; re[kk] = zr0[kk] * w; im[kk] = zi0[kk] * w; }
    this.ola(oi, oi + 1);
  }

  ola(a, b) {
    const { re, im, win } = this;
    this.fft(re, im, true);
    const s = 0.5 / NE, A = this.acc[a], O = this.out[a];
    if (b !== null) {
      const B = this.acc[b], P = this.out[b];
      for (let i = 0; i < NE; i++) { A[i] += re[i] * win[i] * s; B[i] += im[i] * win[i] * s; }
      for (let i = 0; i < HOPE; i++) { O[i] = A[i]; P[i] = B[i]; }
      B.copyWithin(0, HOPE); B.fill(0, 2 * NE - HOPE);
    } else {
      for (let i = 0; i < NE; i++) A[i] += re[i] * win[i] * s;
      for (let i = 0; i < HOPE; i++) O[i] = A[i];
    }
    A.copyWithin(0, HOPE); A.fill(0, 2 * NE - HOPE);
  }

  block() {
    const { re, im, win, inL, inR, zr0, zi0, aLL, aRR, aXr, aXi, sLL, sRR, sXr, sXi, waG, mAuf, wa, cm, gf, gr, bandW, lamA, lamB, binBand, tLL, tRR, tXr, bLL, bRR, bXr, bE, bC, bW, bLang, bP, sE, sW, lamL, nB } = this;
    const H = NE / 2;
    for (let i = 0; i < NE; i++) { re[i] = inL[i] * win[i]; im[i] = inR[i] * win[i]; }
    this.fft(re, im, false);
    zr0.set(re); zi0.set(im);
    tLL.fill(0); tRR.fill(0); tXr.fill(0);
    for (let kk = 0; kk <= H; kk++) {
      const nk = (NE - kk) % NE;
      const lr = 0.5 * (re[kk] + re[nk]), li = 0.5 * (im[kk] - im[nk]);
      const rr = 0.5 * (im[kk] + im[nk]), ri = -0.5 * (re[kk] - re[nk]);
      const pl = lr * lr + li * li, pr = rr * rr + ri * ri, xr = lr * rr + li * ri, xi = li * rr - lr * ri;
      aLL[kk] = lamA * aLL[kk] + (1 - lamA) * pl; aRR[kk] = lamA * aRR[kk] + (1 - lamA) * pr;
      aXr[kk] = lamA * aXr[kk] + (1 - lamA) * xr; aXi[kk] = lamA * aXi[kk] + (1 - lamA) * xi;
      const bb = kk < H ? binBand[kk] : nB - 1;
      if (bb >= 0) { tLL[bb] += pl; tRR[bb] += pr; tXr[bb] += xr; }
    }
    // Raum: unkorreliert und auf beiden Seiten ähnlich laut – aus den über die Frequenz geglätteten Kreuzspektren
    sLL.set(aLL); sRR.set(aRR); sXr.set(aXr); sXi.set(aXi);
    this.glaetten(sLL); this.glaetten(sRR); this.glaetten(sXr); this.glaetten(sXi);
    for (let kk = 0; kk <= H; kk++) {
      const pa = sLL[kk] * sRR[kk];
      const koh = Math.sqrt(sXr[kk] * sXr[kk] + sXi[kk] * sXi[kk]) / Math.sqrt(pa + 1e-24);
      const balA = 2 * Math.sqrt(pa) / (sLL[kk] + sRR[kk] + 1e-24);
      const z = 0.65 * glatt(((1 - (koh < 1 ? koh : 1)) * Math.sqrt(balA) - 0.08) / 0.92); // 0,65: Pegel wie bisher (die alte, linienweise Schätzung lag im Schnitt ~4 dB zu tief)
      // öffnen langsam (Hallfahnen blenden ein, nichts flackert), schließen sofort (ein kohärenter Anschlag darf nicht nach hinten)
      waG[kk] = z >= waG[kk] ? mAuf * waG[kk] + (1 - mAuf) * z : z;
      wa[kk] = waG[kk];
    }
    // Effekte und Mitte je Terzband
    const { gAuf, gAb } = this;
    for (let b = 0; b < nB; b++) {
      bLL[b] = lamB * bLL[b] + (1 - lamB) * tLL[b]; bRR[b] = lamB * bRR[b] + (1 - lamB) * tRR[b]; bXr[b] = lamB * bXr[b] + (1 - lamB) * tXr[b];
      const pe = bLL[b] * bRR[b], summe = bLL[b] + bRR[b] + 1e-24;
      let c = bXr[b] / (Math.sqrt(pe) + 1e-24); c = c < -1 ? -1 : c > 1 ? 1 : c;
      const pan = (bLL[b] - bRR[b]) / summe, apan = pan < 0 ? -pan : pan;
      const balE = 2 * Math.sqrt(pe) / summe;
      const anti = glatt((-c - 0.15) / 0.5) * Math.sqrt(balE);
      const hart = glatt((apan - 0.8) / 0.18) * 0.3;                       // hart Gepanntes nur Richtung Seite (max. ~45 %)
      const zE = anti > hart ? anti : hart;
      const zC = this.mitCenter ? glatt((c - 0.8) / 0.15) * glatt((0.25 - apan) / 0.2) : 0;
      // Breite: kaum korreliert (voll ab c ≤ 0, nichts ab c ≥ 0,45), beide Seiten ähnlich laut, im Vordergrund
      const pegel = summe * 0.5;
      bLang[b] = bLang[b] > 0 ? lamL * bLang[b] + (1 - lamL) * pegel : pegel;
      const vorn = glatt((10 * Math.log10((pegel + 1e-24) / (bLang[b] + 1e-24)) + 18) / 10); // 0 bei −18 dB, voll ab −8 dB
      bP[b] = pegel;
      const zW = glatt((0.45 - c) / 0.45) * balE * balE * vorn * (1 - anti);
      const kw = zW > bW[b] ? this.gAufW : this.gAbW;
      bW[b] = kw * bW[b] + (1 - kw) * zW;
      const ke = zE > bE[b] ? gAuf : gAb;
      bE[b] = ke * bE[b] + (1 - ke) * zE;
      const kc = zC > bC[b] ? gAuf : gAb;
      bC[b] = kc * bC[b] + (1 - kc) * zC;
    }
    // Über benachbarte Bänder glätten (≈ ±2/3 Oktave) und einen Breitbandanteil (pegelgewichtetes Mittel) beimischen:
    // keine einzelnen Terzen, die hinten herausstechen oder vorne fehlen (kein „notchy“), der Klang wandert als Ganzes
    let pSum = 0, mE = 0, mW = 0;
    for (let b = 0; b < nB; b++) { pSum += bP[b]; mE += bE[b] * bP[b]; mW += bW[b] * bP[b]; }
    mE /= pSum + 1e-24; mW /= pSum + 1e-24;
    const K = [1, 2, 3, 2, 1];
    for (let b = 0; b < nB; b++) {
      let se = 0, sw = 0, ks = 0;
      for (let o = -2; o <= 2; o++) { const q = b + o; if (q < 0 || q >= nB) continue; const kk2 = K[o + 2]; se += bE[q] * kk2; sw += bW[q] * kk2; ks += kk2; }
      sE[b] = 0.7 * (se / ks) + 0.3 * mE;
      sW[b] = 0.6 * (sw / ks) + 0.4 * mW;
    }
    this.effG += (this.effekte - this.effG) * 0.3;
    this.breiteG += (this.breite - this.breiteG) * 0.3;
    const amt = this.effG, amtW = this.breiteG, { ip0, ip1, ipW } = this;
    for (let kk = 0; kk <= H; kk++) {
      const j = kk < H ? kk : H - 1, w = ipW[j];
      const e = (sE[ip0[j]] * (1 - w) + sE[ip1[j]] * w) * bandW[kk];
      cm[kk] = (bC[ip0[j]] * (1 - w) + bC[ip1[j]] * w) * bandW[kk];
      const wb = (sW[ip0[j]] * (1 - w) + sW[ip1[j]] * w) * bandW[kk];
      let m = e * amt + wb * amtW; if (m > 0.92) m = 0.92;
      const th = m * Math.PI / 2;
      gf[kk] = Math.cos(th); gr[kk] = Math.sin(th);
    }
    if (!(bE[0] === bE[0]) || !(wa[H >> 1] === wa[H >> 1]) || !(bC[0] === bC[0]) || !(bW[0] === bW[0])) { // NaN nie festhalten
      for (const a of [aLL, aRR, aXr, aXi, sLL, sRR, sXr, sXi, waG, bLL, bRR, bXr, bE, bC, bW, bLang, bP, sE, sW, cm]) a.fill(0);
      wa.fill(0); gf.fill(1); gr.fill(0);
    }
    this.ausgabe(wa, 0);
    this.ausgabe(gr, 2);
    this.ausgabe(gf, 4);
    if (this.mitCenter) {
      // Center = cm · (L + R) / 2 als reelles Signal: Z = C (Imaginärteil 0)
      for (let kk = 0; kk <= H; kk++) {
        const nk = (NE - kk) % NE;
        const lr = 0.5 * (zr0[kk] + zr0[nk]), li = 0.5 * (zi0[kk] - zi0[nk]);
        const rr = 0.5 * (zi0[kk] + zi0[nk]), ri = -0.5 * (zr0[kk] - zr0[nk]);
        const w = 0.5 * cm[kk];
        const cr = w * (lr + rr), ci = w * (li + ri);
        re[kk] = cr; im[kk] = ci;
        if (kk > 0 && kk < H) { re[nk] = cr; im[nk] = -ci; }
      }
      this.ola(6, null);
    }
    inL.copyWithin(0, HOPE); inR.copyWithin(0, HOPE);
  }

  process(inputs, outputs) {
    if (this.ende) return false;
    const o0 = outputs[0], o1 = outputs[1], o2 = outputs[2], o3 = outputs[3];
    if (!o0 || !o0[0]) return true;
    const e = inputs[0] || [];
    const xL = e[0], xR = e[1] || e[0];
    const len = o0[0].length;
    const { fA, fR, sA, sR, dA, dR, lK, gA, gR, tMin, dMin, gRing, vor, out } = this;
    let { fast, slow, duck, lang, g, gPos, rover } = this;
    const verz = LATENZ_E - vor;
    const [aL, aR, eL, eR, vL, vR, cC] = out;
    for (let i = 0; i < len; i++) {
      const l = xL ? xL[i] : 0, r = xR ? xR[i] : 0;
      const sd = 0.5 * (l - r), a = sd < 0 ? -sd : sd;
      fast = a > fast ? fA * fast + (1 - fA) * a : fR * fast + (1 - fR) * a;
      slow = a > slow ? sA * slow + (1 - sA) * a : sR * slow + (1 - sR) * a;
      let gt = 1;
      if (fast > slow * 1.6 && fast > 1e-6) { const q = slow * 1.6 / fast; gt = q * q; if (gt < tMin) gt = tMin; }
      const sc = Math.sqrt((l * l + r * r) * 0.5);
      duck = sc > duck ? dA * duck + (1 - dA) * sc : dR * duck + (1 - dR) * sc;
      lang = lK * lang + (1 - lK) * duck;
      let gd = 1;
      if (duck > lang && duck > 1e-6) { gd = Math.pow(lang / duck, 0.8); if (gd < dMin) gd = dMin; }
      gRing[gPos] = gt * gd;
      const ziel = gRing[(gPos - verz + 4096) & 4095];
      gPos = (gPos + 1) & 4095;
      g = ziel < g ? gA * g + (1 - gA) * ziel : gR * g + (1 - gR) * ziel;
      this.inL[rover] = l; this.inR[rover] = r;
      const j = rover - LATE;
      o0[0][i] = aL[j] * g; if (o0[1]) o0[1][i] = aR[j] * g;
      if (o1 && o1[0]) { o1[0][i] = eL[j]; if (o1[1]) o1[1][i] = eR[j]; }
      if (o2 && o2[0]) { o2[0][i] = vL[j]; if (o2[1]) o2[1][i] = vR[j]; }
      if (o3 && o3[0]) o3[0][i] = this.mitCenter ? cC[j] : 0;
      rover++;
      if (rover >= NE) { rover = LATE; this.block(); }
    }
    this.fast = fast; this.slow = slow; this.duck = duck; this.lang = lang; this.g = g; this.gPos = gPos; this.rover = rover;
    return true;
  }
}

registerProcessor('aw-upmix-ebenen', UpmixEbenen);
