// Glow (Röhre), Iron (Übertrager) und Silk (Band) im Audio-Thread – gerechnet von der C-Bibliothek (dsp/) als WebAssembly,
// derselbe Code wie im Windows-Client. Gleiche Schnittstelle wie die bisherigen JS-Worklets: Werte per port.postMessage
// ({drive: …}), {messen: bool}, {delta: bool}, {ende: true}; meldet {faerb: [L, R]}.
// Die WebAssembly-Datei kommt als Bytes in processorOptions.wasm (einmal je AudioContext übersetzt, alle Effekte teilen sich
// eine Instanz – sie laufen nacheinander im selben Audio-Thread).
const ARTEN = { 'aw-roehre': 'glow', 'aw-trafo': 'iron', 'aw-band': 'silk' };
const MATHE = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, exp: Math.exp, log: Math.log, log10: Math.log10, log1p: Math.log1p,
  expm1: Math.expm1, pow: Math.pow, tanh: Math.tanh, cosh: Math.cosh, sinh: Math.sinh, atan: Math.atan, atan2: Math.atan2,
};
let W = null;

function laden(bytes) {
  if (W) return W;
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { m: MATHE, env: MATHE });
  W = { ex: inst.exports, puffer: null, u8: null, f32: null, f64: null };
  return W;
}
/** Sichten auf den Speicher (nach einem Wachsen ist der alte Puffer ungültig) */
function sichten() {
  const b = W.ex.memory.buffer;
  if (W.puffer !== b) { W.puffer = b; W.u8 = new Uint8Array(b); W.f32 = new Float32Array(b); W.f64 = new Float64Array(b); }
}
/** Text (nur ASCII nötig: Namen und Werte wie "sm900", "nab") an aw_w_text(), optional zweiter Text dahinter */
function text(a, b) {
  sichten();
  let p = W.ex.aw_w_text();
  const schreiben = (s) => { s = String(s); for (let i = 0; i < s.length && i < 1000; i++) { const c = s.charCodeAt(i); W.u8[p++] = c < 128 ? c : 63; } W.u8[p++] = 0; };
  schreiben(a);
  if (b !== undefined) schreiben(b);
}

class AwDsp extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const p = (o && o.processorOptions) || {};
    laden(p.wasm);
    text(p.art || 'silk');
    this.fx = W.ex.aw_w_neu(sampleRate, Number.isFinite(p.seed) ? p.seed >>> 0 : (Math.random() * 4294967295) >>> 0);
    this.messen = false;
    this.setzen(p);
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.ende) { this.ende = true; return; }
      if (typeof d.messen === 'boolean') { this.messen = d.messen; text('messen'); W.ex.aw_w_steuern(this.fx, d.messen ? 1 : 0); return; }
      if (typeof d.delta === 'boolean') { text('delta'); W.ex.aw_w_steuern(this.fx, d.delta ? 1 : 0); return; }
      this.setzen(d);
    };
  }

  setzen(d) {
    const ex = W.ex;
    let n = 0;
    for (const [k, v] of Object.entries(d)) {
      if (k === 'wasm' || k === 'art' || k === 'seed') continue;
      if (typeof v === 'number' || typeof v === 'boolean') { text(k); ex.aw_w_zahl(+v); n++; }
      else if (typeof v === 'string') { text(k, v); ex.aw_w_textwert(); n++; }
      else if (Array.isArray(v) || ArrayBuffer.isView(v)) {
        sichten();
        const a = ex.aw_w_listenpuffer() >> 3, m = Math.min(v.length, 64);
        for (let i = 0; i < m; i++) W.f64[a + i] = +v[i];
        text(k); ex.aw_w_liste(m); n++;
      }
    }
    if (n) ex.aw_w_setzen(this.fx);
  }

  process(inputs, outputs) {
    const ex = W.ex;
    if (this.ende) { if (this.fx) { ex.aw_w_frei(this.fx); this.fx = 0; } return false; }
    const ein = inputs[0], aus = outputs[0];
    if (!aus || !aus.length) return true;
    const n = aus[0].length, kan = Math.min(aus.length, 16);
    sichten();
    let maske = 0;
    for (let c = 0; c < kan; c++) {
      if (ein && ein[c]) { W.f32.set(ein[c], ex.aw_w_ein(c) >> 2); maske |= 1 << c; }
    }
    ex.aw_w_block(this.fx, kan, n, maske);
    sichten();
    for (let c = 0; c < kan; c++) { const p = ex.aw_w_aus(c) >> 2; aus[c].set(W.f32.subarray(p, p + n)); }
    if (this.messen && ex.aw_w_faerbung(this.fx)) {
      sichten();
      const p = ex.aw_w_faerb() >> 2;
      this.port.postMessage({ faerb: [W.f32[p], W.f32[p + 1]] });
    }
    return true;
  }
}

for (const [name, art] of Object.entries(ARTEN)) {
  registerProcessor(name, class extends AwDsp {
    constructor(o) { super({ ...o, processorOptions: { ...((o && o.processorOptions) || {}), art } }); }
  });
}
