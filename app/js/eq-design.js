// EQ-Filterentwurf: „matched“ Biquads (Ansatz nach M. Vicanek, „Matched Second Order Digital Filters“, 2016).
//
// Warum nicht das übliche RBJ-Kochbuch (bilineare Transformation)? Die verbiegt die Frequenzachse zur Nyquist-
// Frequenz hin („Cramping“): Glocken über ~8 kHz werden schmaler und schief, Shelves oben erreichen ihren Pegel
// nicht. Hier werden stattdessen
//   1. die Pole des analogen Vorbilds exakt übertragen (z = e^{sT}),
//   2. die Nullstellen so bestimmt, dass der Betrag bei 0 Hz und bei der Bandfrequenz exakt dem analogen Vorbild
//      entspricht und dazwischen bis Nyquist bestmöglich (gewichtete kleinste Quadrate auf dem Betragsquadrat).
// Ergebnis: Der digitale Frequenzgang folgt dem analogen bis nahe Nyquist (Abweichung typ. < 0,1 dB).
// Analoge Vorbilder wie im RBJ-Kochbuch (Glocke mit konstanter Güte, Shelves mit Güte/Steilheit).

/** Betragsquadrat des analogen Vorbilds bei Ω = f/f0 */
function analogBetragQ(typ, A, Q, x) {
  const x2 = x * x;
  const betrag = (nr, ni, dr, di) => (nr * nr + ni * ni) / (dr * dr + di * di);
  if (typ === 'peaking') {
    // H(s) = (s² + s·A/Q + 1) / (s² + s/(A·Q) + 1)
    return betrag(1 - x2, x * A / Q, 1 - x2, x / (A * Q));
  }
  const sA = Math.sqrt(A);
  if (typ === 'lowshelf') {
    // H(s) = A · (s² + (√A/Q)s + A) / (A s² + (√A/Q)s + 1)
    return A * A * betrag(A - x2, x * sA / Q, 1 - A * x2, x * sA / Q);
  }
  // highshelf: H(s) = A · (A s² + (√A/Q)s + 1) / (s² + (√A/Q)s + A)
  return A * A * betrag(1 - A * x2, x * sA / Q, A - x2, x * sA / Q);
}

/** Analoge Pole → digitale Nenner-Koeffizienten (a1, a2); wp = Polfrequenz in rad/Sample, zeta = Dämpfung */
function poleMatched(wp, zeta) {
  const e = Math.exp(-zeta * wp);
  let a1;
  if (zeta <= 1) a1 = -2 * e * Math.cos(Math.sqrt(1 - zeta * zeta) * wp);
  else a1 = -2 * e * Math.cosh(Math.sqrt(zeta * zeta - 1) * wp);
  return [a1, e * e];
}

/**
 * Koeffizienten {b0, b1, b2, a1, a2} (a0 = 1) für ein Band.
 * band: {typ: 'peaking'|'lowshelf'|'highshelf', f, g (dB), q}
 */
export function bandKoeffizienten(band, sr) {
  const g = band.an === false ? 0 : band.g;
  if (Math.abs(g) < 1e-4) return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  const A = Math.pow(10, g / 40);
  const Q = Math.max(0.1, band.q || Math.SQRT1_2);
  const f0 = Math.min(band.f, sr * 0.4999);
  const w0 = 2 * Math.PI * f0 / sr;
  // Pole des Vorbilds
  let wp, zeta;
  if (band.typ === 'peaking') { wp = w0; zeta = 1 / (2 * A * Q); }
  else if (band.typ === 'lowshelf') { wp = w0 / Math.sqrt(A); zeta = 1 / (2 * Q); }
  else { wp = w0 * Math.sqrt(A); zeta = 1 / (2 * Q); }
  // Pole jenseits von Nyquist (hohes High-Shelf mit viel Anhebung): auf knapp unter Nyquist begrenzen,
  // die Betragsanpassung unten gleicht den Rest aus
  wp = Math.min(wp, Math.PI * 0.98);
  const [a1, a2] = poleMatched(wp, zeta);
  // |D|² in der φ-Darstellung
  const A0 = (1 + a1 + a2) ** 2, A1 = (1 - a1 + a2) ** 2, A2 = -4 * a2;
  const ziel = (w) => analogBetragQ(band.typ, A, Q, (w / w0));
  const phi = (w) => { const s = Math.sin(w / 2) ** 2; return [1 - s, s, 4 * (1 - s) * s]; };
  const dQ = (p) => A0 * p[0] + A1 * p[1] + A2 * p[2];
  // Zähler |N|² = B0 φ0 + B1 φ1 + B2 φ2 (linear in B). Exakt bei 0 Hz und bei der Bandfrequenz; der letzte
  // Freiheitsgrad wird über das ganze Band (log. verteilt bis knapp unter Nyquist) bestmöglich angepasst
  // (relativer Fehler, gewichtete kleinste Quadrate).
  const B0 = ziel(0) * A0;
  const pm = phi(w0);
  const T0 = ziel(w0) * dQ(pm);
  let B1;
  if (pm[2] < 1e-9) B1 = ziel(Math.PI) * A1;
  else {
    let zaehler = 0, nenner = 0;
    const wMin = 2 * Math.PI * 20 / sr;
    for (let i = 0; i <= 120; i++) {
      const w = wMin * Math.pow((Math.PI * 0.995) / wMin, i / 120);
      const p = phi(w);
      const y = ziel(w) * dQ(p);
      const c = B0 * p[0] + p[2] * (T0 - B0 * pm[0]) / pm[2];
      const d = p[1] - p[2] * pm[1] / pm[2];
      const gew = 1 / (y * y + 1e-30);
      zaehler += gew * d * (y - c); nenner += gew * d * d;
    }
    B1 = nenner > 0 ? zaehler / nenner : ziel(Math.PI) * A1;
  }
  B1 = Math.max(0, B1);
  let B2 = (T0 - B0 * pm[0] - B1 * pm[1]) / pm[2];
  // Spektrale Faktorisierung
  const r0 = Math.sqrt(Math.max(0, B0)), r1 = Math.sqrt(Math.max(0, B1));
  const W = 0.5 * (r0 + r1);
  if (W * W + B2 < 0) B2 = -W * W; // nicht faktorisierbar → an die Grenze
  const b0 = 0.5 * (W + Math.sqrt(Math.max(0, W * W + B2)));
  const b1 = 0.5 * (r0 - r1);
  const b2 = b0 !== 0 ? -B2 / (4 * b0) : 0;
  return { b0, b1, b2, a1, a2 };
}

/** Betrag in dB eines Koeffizientensatzes bei Frequenz f */
export function koeffDb(k, f, sr) {
  const w = 2 * Math.PI * f / sr;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = k.b0 + k.b1 * c1 + k.b2 * c2, ni = -(k.b1 * s1 + k.b2 * s2);
  const dr = 1 + k.a1 * c1 + k.a2 * c2, di = -(k.a1 * s1 + k.a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

/** Analoges Vorbild in dB (zum Vergleich/Test) */
export function analogDb(band, f) {
  const g = band.an === false ? 0 : band.g;
  if (Math.abs(g) < 1e-4) return 0;
  return 10 * Math.log10(analogBetragQ(band.typ, Math.pow(10, g / 40), band.q || Math.SQRT1_2, f / band.f));
}

/** RBJ-Kochbuch (bilinear), nur zum Vergleich */
export function rbjKoeffizienten(band, sr) {
  const A = Math.pow(10, band.g / 40), w0 = 2 * Math.PI * band.f / sr, cw = Math.cos(w0), sw = Math.sin(w0);
  const Q = band.q || Math.SQRT1_2, alpha = sw / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  if (band.typ === 'peaking') { b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; }
  else {
    const k = 2 * Math.sqrt(A) * alpha;
    if (band.typ === 'lowshelf') { b0 = A * ((A + 1) - (A - 1) * cw + k); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - k); a0 = (A + 1) + (A - 1) * cw + k; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - k; }
    else { b0 = A * ((A + 1) + (A - 1) * cw + k); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - k); a0 = (A + 1) - (A - 1) * cw + k; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - k; }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}
