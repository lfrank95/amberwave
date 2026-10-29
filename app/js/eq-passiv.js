// EQ-Modus „Passiv“: dieselben vier Bänder (Frequenz, Pegel, Güte), aber gerechnet wie ein passiver Mastering-EQ.
//  • Die Bänder liegen parallel in einem Netzwerk und addieren sich als Spannung, nicht in dB: zwei überlappende +6 dB
//    geben zusammen ≈ +9,5 dB, nicht +12 (Boost-Netzwerk H = 1 + Σ gᵢ·Bᵢ(s)); Absenkungen wirken reziprok (1 / (1 + Σ gⱼ·Bⱼ(s))).
//  • Bei Glocken hängt der Hub an der Bandbreite: breit (Q 0,3) erreicht der Regler nur ≈ 65 % des Pegels in dB, schmal den vollen –
//    breite Kurven bleiben sanft. Die Glocke selbst ist unten breiter als eine digitale (Addition statt Multiplikation).
//  • Proportional Q: Glocken werden bei wenig Gain breiter, bei viel Gain so schmal wie eingestellt; Shelf-Kanten werden mit
//    dem Gain steiler (wie bei vielen analogen EQs – die Breite hängt am Hub).
//  • Shelves sind resonante Tief-/Hochpässe 2. Ordnung im Parallelzweig: ein Low-Shelf-Boost hat oberhalb der Eckfrequenz eine
//    kleine Senke und bei schmaler Güte einen Buckel an der Kante (Pultec-Effekt); die Güte (0,3 … 2) regelt den Überschwinger.
// Rechnung: das Netzwerk wird exakt als analoge Übertragungsfunktion (bis 8. Ordnung je Boost und Cut) aufgestellt, die Nullstellen
// numerisch bestimmt, in Biquads zerlegt und bilinear (Frequenzen vorverzerrt) in den vorhandenen EQ-Worklet gegeben – keine
// Näherung, keine zusätzliche Latenz. Ergebnis: bis zu 8 Sektionen {b0, b1, b2, a1, a2}.

const MAX_SEKTIONEN = 8;

/** Polynom-Helfer: Koeffizienten aufsteigend (p[0] + p[1]·s + …), reell */
function mul(a, b) {
  const r = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) r[i + j] += a[i] * b[j];
  return r;
}
function add(a, b) {
  const r = new Array(Math.max(a.length, b.length)).fill(0);
  for (let i = 0; i < r.length; i++) r[i] = (a[i] || 0) + (b[i] || 0);
  return r;
}
const skal = (a, k) => a.map((x) => x * k);

/** Nullstellen eines reellen Polynoms (Durand–Kerner, komplex), Grad ≤ 8 – Rückgabe [[re, im], …] */
function nullstellen(p) {
  let n = p.length - 1;
  while (n > 0 && Math.abs(p[n]) < 1e-300) n--;
  if (n < 1) return [];
  const c = p.slice(0, n + 1).map((x) => x / p[n]); // monisch
  // Startwerte: auf einem Kreis mit Radius aus der Cauchy-Schranke
  // Startwerte: Kreis um den Betrag des geometrischen Mittels der Nullstellen (|c₀|^(1/n)), leicht gedreht (keine Symmetrie-Falle)
  const r = Math.max(1e-6, Math.pow(Math.abs(c[0]) || 1, 1 / n));
  const zr = [], zi = [];
  for (let k = 0; k < n; k++) { const w = 2 * Math.PI * k / n + 0.4; zr.push(r * Math.cos(w)); zi.push(r * Math.sin(w)); }
  const wert = (x, y) => { // Horner komplex
    let ar = 1, ai = 0;
    for (let i = n - 1; i >= 0; i--) { const t = ar * x - ai * y + c[i]; ai = ar * y + ai * x; ar = t; }
    return [ar, ai];
  };
  for (let it = 0; it < 2000; it++) {
    let maxD = 0;
    for (let k = 0; k < n; k++) {
      const [pr, pi] = wert(zr[k], zi[k]);
      let dr = 1, di = 0;
      for (let j = 0; j < n; j++) {
        if (j === k) continue;
        const xr = zr[k] - zr[j], xi = zi[k] - zi[j];
        const t = dr * xr - di * xi; di = dr * xi + di * xr; dr = t;
      }
      const m = dr * dr + di * di || 1e-300;
      const qr = (pr * dr + pi * di) / m, qi = (pi * dr - pr * di) / m;
      zr[k] -= qr; zi[k] -= qi;
      maxD = Math.max(maxD, Math.abs(qr) + Math.abs(qi));
    }
    if (maxD < 1e-12 * r) break;
  }
  return zr.map((x, k) => [x, zi[k]]);
}

/** Nullstellen zu reellen Quadraten s² + b1·s + b0 zusammenfassen (konjugierte Paare; reelle paarweise nach Lage) */
function quadrate(ns) {
  const komplex = ns.filter((z) => Math.abs(z[1]) > 1e-7 * (1 + Math.abs(z[0]))).filter((z) => z[1] > 0);
  const reell = ns.filter((z) => Math.abs(z[1]) <= 1e-7 * (1 + Math.abs(z[0]))).map((z) => z[0]).sort((a, b) => a - b);
  const aus = komplex.map(([re, im]) => ({ b1: -2 * re, b0: re * re + im * im }));
  for (let i = 0; i + 1 < reell.length; i += 2) aus.push({ b1: -(reell[i] + reell[i + 1]), b0: reell[i] * reell[i + 1] });
  return aus;
}

/**
 * Sektionen des passiven Netzwerks für die Abtastrate sr. baender wie im EQ: {typ, an, f, g, q}.
 * Gibt [] zurück, wenn kein Band wirkt.
 */
export function passivSektionen(baender, sr) {
  const c = 2 * sr;
  const aktiv = baender.filter((b) => b.an !== false && Math.abs(b.g) >= 0.05);
  if (!aktiv.length) return [];
  // Frequenzen auf die geometrische Mitte der Bänder normieren (sonst Koeffizienten bis 10⁴⁰ – die Nullstellensuche verhungert)
  const wRef = Math.exp(aktiv.reduce((s2, b) => s2 + Math.log(c * Math.tan(Math.PI * Math.min(b.f, sr * 0.45) / sr)), 0) / aktiv.length);
  const boost = [], cut = [];
  for (const b of aktiv) {
    const f0 = Math.min(b.f, sr * 0.45);
    const w = c * Math.tan(Math.PI * f0 / sr) / wRef; // vorverzerrt: die Mitte landet nach der Bilineartransformation genau
    const q = Math.max(0.1, b.q || 0.707);
    let N, k = 1, Qn;
    if (b.typ === 'peaking') {
      // Hub hängt an der Bandbreite: Q 0,3 → 65 % des dB-Werts, Q 10 → 100 % (logarithmisch dazwischen)
      const t = Math.max(0, Math.min(1, Math.log(q / 0.3) / Math.log(10 / 0.3)));
      const dB = Math.abs(b.g) * (0.65 + 0.35 * t);
      k = Math.pow(10, dB / 20) - 1;
      // Proportional Q: die eingestellte Breite gilt bei vollem Hub (15 dB); wenig Gain → breiter (1 dB ≈ halbe Güte),
      // viel Gain → so schmal wie eingestellt – kleine Korrekturen wirken großflächig, große zielen genau
      Qn = q * (0.55 + 1.1 * Math.min(1, Math.abs(b.g) / 15)); // bei vollem Hub etwa so breit wie Digital mit gleicher Güte, bei 1 dB gut 1,6-mal so breit
      N = [0, w / Qn, 0];
    } else {
      // Shelf 2. Ordnung mit zahmer Kante: Zähler = Plateau + ρ·Bandpass-Anteil. ρ = 1 heißt „1 − Hochpass“ (kein Überschwinger,
      // nichts kann sich auslöschen), ρ → 0 wäre ein reiner Tiefpass im Parallelzweig (starke Senke/Buckel an der Kante).
      // Die Güte (0,3 … 2) stellt die Kante: weich … deutlicher Pultec-Buckel; bei viel Hub wird sie automatisch zahmer,
      // damit sich zwei Shelves nie zu einem Loch addieren.
      // Kante wächst mit dem Gain: bei wenig Hub weich und flach, bei viel Hub steiler mit deutlicherem Buckel/Senke
      const t = Math.max(0, Math.min(1, (q - 0.3) / 1.7)) * (0.35 + 0.65 * Math.min(1, Math.abs(b.g) / 12));
      k = Math.pow(10, Math.abs(b.g) / 20) - 1;
      Qn = 0.55 + 0.45 * t;
      const rho = Math.max(1 - 0.7 * t, Math.min(1, 0.2 + 0.08 * k));
      N = b.typ === 'lowshelf' ? [w * w, rho * w / Qn, 0] : [0, rho * w / Qn, 1];
    }
    const D = [w * w, w / Qn, 1];
    (b.g > 0 ? boost : cut).push({ N: skal(N, k), D });
  }
  if (!boost.length && !cut.length) return [];
  // Netzwerk: Zähler = Π D + Σ gᵢ Nᵢ Π_{j≠i} Dⱼ, Nenner = Π D
  const netz = (teile) => {
    let zaehler = [0];
    let nenner = [1];
    for (const t of teile) nenner = mul(nenner, t.D);
    for (let i = 0; i < teile.length; i++) {
      let p = teile[i].N;
      for (let j = 0; j < teile.length; j++) if (j !== i) p = mul(p, teile[j].D);
      zaehler = add(zaehler, p);
    }
    return { zaehler: add(nenner, zaehler), nenner };
  };
  const B = netz(boost), C = netz(cut);
  // Gesamt: H = B.zaehler · C.nenner / (B.nenner · C.zaehler) – Pole aus B.nenner (bekannt) und C.zaehler (gesucht)
  const pole = [...boost.map((t) => ({ b1: t.D[1], b0: t.D[0] })), ...quadrate(nullstellen(C.zaehler))];
  const nullen = [...quadrate(nullstellen(B.zaehler)), ...cut.map((t) => ({ b1: t.D[1], b0: t.D[0] }))];
  const kAus = (B.zaehler[B.zaehler.length - 1] / B.nenner[B.nenner.length - 1]) * (C.nenner[C.nenner.length - 1] / C.zaehler[C.zaehler.length - 1]);
  // zurück auf echte Frequenzen (s = wRef·s'): b1·wRef, b0·wRef²
  for (const q of [...pole, ...nullen]) { q.b1 *= wRef; q.b0 *= wRef * wRef; }
  // Pole und Nullstellen nach Lage paaren (gleiche Frequenzgegend in eine Sektion → gut konditioniert)
  const frei = [...nullen];
  const sektionen = pole.map((p) => {
    let best = 0, abst = Infinity;
    frei.forEach((z, i) => { const d = Math.abs(Math.log((z.b0 + 1e-9) / (p.b0 + 1e-9))); if (d < abst) { abst = d; best = i; } });
    const z = frei.splice(best, 1)[0] || { b1: 0, b0: 0 };
    return { z, p };
  });
  // Bilinear (ohne weitere Vorverzerrung): s = c·(1 − z⁻¹)/(1 + z⁻¹)
  const aus = sektionen.map(({ z, p }, i) => {
    const bz0 = z.b0 + z.b1 * c + c * c, bz1 = 2 * (z.b0 - c * c), bz2 = z.b0 - z.b1 * c + c * c;
    const az0 = p.b0 + p.b1 * c + c * c, az1 = 2 * (p.b0 - c * c), az2 = p.b0 - p.b1 * c + c * c;
    const k = (i === 0 ? kAus : 1) / az0;
    return { b0: bz0 * k, b1: bz1 * k, b2: bz2 * k, a1: az1 / az0, a2: az2 / az0 };
  });
  return aus.slice(0, MAX_SEKTIONEN);
}
