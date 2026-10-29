// Equalizer im Audio-Thread: bis zu 8 Biquads (transponierte Direktform II, doppelte Genauigkeit) + Gain – präzise 4, passiv bis 8.
// Koeffizienten kommen fertig vom Hauptthread (eq-design.js, „matched“ Entwurf). Neue Werte werden über einen
// Block (128 Samples) linear übergeblendet, der Gain gleitet – so knackt Ziehen an der Kurve nicht.
class AwEq extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const p = (o && o.processorOptions) || {};
    this.k = this.leer();
    this.ziel = null;
    this.gain = p.gain ?? 1;
    this.gainZiel = this.gain;
    this.zustand = []; // je Kanal: Float64Array(16) = [s1,s2] × 8 Sektionen
    if (p.k) this.k = this.voll(p.k);
    this.port.onmessage = (e) => {
      if (e.data.k) this.ziel = this.voll(e.data.k);
      if (typeof e.data.gain === 'number') this.gainZiel = e.data.gain;
      if (e.data.ende) this.ende = true; // abgebaut → beenden, sonst läuft er im Audio-Thread weiter
    };
  }

  leer() { const k = new Float64Array(40); for (let b = 0; b < 8; b++) k[b * 5] = 1; return k; }
  /** auf 8 Sektionen auffüllen (ältere Sender schicken 4) */
  voll(k) { const v = this.leer(); for (let i = 0; i < Math.min(k.length, 40); i++) v[i] = k[i]; return v; }

  process(inputs, outputs) {
    if (this.ende) return false;
    const ein = inputs[0], aus = outputs[0];
    if (!aus || !aus.length) return true;
    const n = aus[0].length;
    const alt = this.k, neu = this.ziel;
    const g0 = this.gain, g1 = this.gainZiel;
    for (let c = 0; c < aus.length; c++) {
      const x = ein && ein[c], y = aus[c];
      if (!x) { y.fill(0); continue; }
      let z = this.zustand[c];
      if (!z) { z = new Float64Array(16); this.zustand[c] = z; }
      for (let i = 0; i < n; i++) {
        const t = neu ? (i + 1) / n : 0;
        let v = x[i];
        for (let b = 0; b < 8; b++) {
          const o = b * 5;
          const b0 = neu ? alt[o] + (neu[o] - alt[o]) * t : alt[o];
          if (!neu && b0 === 1 && alt[o + 1] === 0 && alt[o + 2] === 0 && alt[o + 3] === 0 && alt[o + 4] === 0) continue;
          const b1 = neu ? alt[o + 1] + (neu[o + 1] - alt[o + 1]) * t : alt[o + 1];
          const b2 = neu ? alt[o + 2] + (neu[o + 2] - alt[o + 2]) * t : alt[o + 2];
          const a1 = neu ? alt[o + 3] + (neu[o + 3] - alt[o + 3]) * t : alt[o + 3];
          const a2 = neu ? alt[o + 4] + (neu[o + 4] - alt[o + 4]) * t : alt[o + 4];
          const s = b * 2;
          const w = b0 * v + z[s];
          z[s] = b1 * v - a1 * w + z[s + 1];
          z[s + 1] = b2 * v - a2 * w;
          v = w;
        }
        y[i] = v * (g0 + (g1 - g0) * ((i + 1) / n));
      }
    }
    if (neu) { this.k = neu; this.ziel = null; }
    this.gain = g1;
    // Denormale/Reste vermeiden
    for (const z of this.zustand) if (z) for (let i = 0; i < 16; i++) if (Math.abs(z[i]) < 1e-30) z[i] = 0;
    return true;
  }
}
registerProcessor('aw-eq', AwEq);
