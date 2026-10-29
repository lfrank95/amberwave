// Windows Client: Messpunkte der Engine (Eingang, vor/nach EQ, Messpunkt hinter Kette und Angleich) als Ersatz für
// Web-Audio-AnalyserNodes. Die Engine schickt 16-Bit-PCM; hier liegt je Abgriff ein Ring der letzten ~0,7 s. Die Analyser
// rechnen wie im Browser (getFloatTimeDomainData; getFloatFrequencyData mit Blackman-Fenster, Betrag/N, zeitlicher Glättung
// und dB), damit Rack, Meter und Analyse unverändert damit arbeiten.

const KAP = 32768 * 2;

export class AbgriffRing {
  constructor(kanaele = 2) { this.kanaele = 0; this.rate = 48000; this.pos = 0; this.zuletzt = 0; this.formen(kanaele); }
  formen(k) {
    if (k === this.kanaele) return;
    this.kanaele = k;
    this.daten = Array.from({ length: k }, () => new Float32Array(KAP));
    this.pos = 0;
  }
  /** interleaved Int16 hinein */
  schreiben(i16, k, rate) {
    this.formen(k);
    this.rate = rate;
    const n = i16.length / k;
    let p = this.pos;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < k; c++) this.daten[c][p] = i16[i * k + c] / 32768;
      p = p + 1 === KAP ? 0 : p + 1;
    }
    this.pos = p;
    this.zuletzt = performance.now();
  }
  /** die letzten out.length Werte eines Kanals (bzw. einer Mischung [wL, wR]) */
  lesen(out, kanal) {
    const n = out.length;
    let p = this.pos - n; while (p < 0) p += KAP;
    const frisch = performance.now() - this.zuletzt < 400;
    if (!frisch) { out.fill(0); return; }
    if (Array.isArray(kanal)) {
      const a = this.daten[0], b = this.daten[Math.min(1, this.kanaele - 1)], [wa, wb] = kanal;
      for (let i = 0; i < n; i++) { out[i] = wa * a[p] + wb * b[p]; p = p + 1 === KAP ? 0 : p + 1; }
    } else {
      const d = this.daten[Math.min(kanal, this.kanaele - 1)];
      if (kanal >= this.kanaele && !(this.kanaele === 1 && kanal === 1)) { out.fill(0); return; }
      for (let i = 0; i < n; i++) { out[i] = d[p]; p = p + 1 === KAP ? 0 : p + 1; }
    }
  }
}

/** K-Bewertung (BS.1770) beim Hineinschreiben – für die Lautheitsmessung */
export class KRing extends AbgriffRing {
  schreiben(i16, k, rate) {
    if (rate !== this.kRate || k !== this.kanaele) this.kFilter(rate, k);
    this.formen(k);
    this.rate = rate;
    const n = i16.length / k;
    let p = this.pos;
    const f = this.f;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < k; c++) {
        const z = this.z[c];
        let x = i16[i * k + c] / 32768;
        // zwei Biquads (Direktform I)
        let y = f[0][0] * x + f[0][1] * z[0] + f[0][2] * z[1] - f[0][3] * z[2] - f[0][4] * z[3];
        z[1] = z[0]; z[0] = x; z[3] = z[2]; z[2] = y; x = y;
        y = f[1][0] * x + f[1][1] * z[4] + f[1][2] * z[5] - f[1][3] * z[6] - f[1][4] * z[7];
        z[5] = z[4]; z[4] = x; z[7] = z[6]; z[6] = y;
        this.daten[c][p] = y;
      }
      p = p + 1 === KAP ? 0 : p + 1;
    }
    this.pos = p;
    this.zuletzt = performance.now();
  }
  kFilter(fs, k) {
    this.kRate = fs;
    let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    let K = Math.tan(Math.PI * f0 / fs);
    const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q + K * K;
    const s1 = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
    f0 = 38.13547087602444; Q = 0.5003270373238773;
    K = Math.tan(Math.PI * f0 / fs);
    a0 = 1 + K / Q + K * K;
    const s2 = [1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
    this.f = [s1, s2];
    this.z = Array.from({ length: k }, () => new Float64Array(8));
  }
}

/* ---------- FFT (radix 2, komplex, in place) ---------- */
const fftCache = new Map();
function fftTabellen(n) {
  let t = fftCache.get(n);
  if (t) return t;
  const bits = Math.log2(n), rev = new Uint32Array(n), cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
  const fenster = new Float64Array(n);
  for (let i = 0; i < n; i++) fenster[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / n) + 0.08 * Math.cos(4 * Math.PI * i / n);
  t = { rev, cos, sin, fenster, re: new Float64Array(n), im: new Float64Array(n) };
  fftCache.set(n, t);
  return t;
}
function fft(re, im, t) {
  const n = re.length, { rev, cos, sin } = t;
  for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let x = re[i]; re[i] = re[j]; re[j] = x; x = im[i]; im[i] = im[j]; im[j] = x; } }
  for (let len = 2; len <= n; len <<= 1) {
    const h = len >> 1, schritt = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < h; k++) {
        const wr = cos[k * schritt], wi = sin[k * schritt];
        const a = i + k, b = a + h;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }
}

/** Ersatz für einen AnalyserNode an einem Ring */
export class AbgriffAnalyser {
  constructor(ring, kanal, fftSize = 2048, opt = {}) {
    this.ring = ring; this.kanal = kanal;
    this.fftSize = fftSize;
    this.smoothingTimeConstant = opt.smoothingTimeConstant ?? 0.8;
    this.minDecibels = opt.minDecibels ?? -100;
    this.maxDecibels = opt.maxDecibels ?? -30;
    this.beimLesen = opt.beimLesen || null;
  }
  get frequencyBinCount() { return this.fftSize / 2; }
  getFloatTimeDomainData(out) {
    this.beimLesen?.();
    if (out.length > this.fftSize) { this.ring.lesen(out.subarray(out.length - this.fftSize), this.kanal); out.fill(0, 0, out.length - this.fftSize); }
    else this.ring.lesen(out, this.kanal);
  }
  getFloatFrequencyData(out) {
    this.beimLesen?.();
    const n = this.fftSize, t = fftTabellen(n);
    if (!this.zeit || this.zeit.length !== n) { this.zeit = new Float32Array(n); this.glatt = new Float64Array(n / 2); }
    this.ring.lesen(this.zeit, this.kanal);
    const re = t.re, im = t.im, w = t.fenster;
    for (let i = 0; i < n; i++) { re[i] = this.zeit[i] * w[i]; im[i] = 0; }
    fft(re, im, t);
    const tau = this.smoothingTimeConstant, g = this.glatt, m = Math.min(out.length, n / 2);
    for (let k = 0; k < m; k++) {
      const betrag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / n;
      g[k] = tau * g[k] + (1 - tau) * betrag;
      out[k] = g[k] > 0 ? 20 * Math.log10(g[k]) : -Infinity;
    }
  }
}
