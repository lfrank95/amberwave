// Das WebAssembly-Worklet (app/js/dsp-worklet.js mit aw-dsp.wasm) durch dieselben Blöcke schicken – Gegenstück zu js_ref.mjs.
// node wasm_ref.mjs <art> <rate> <kanäle> <ein.f32> <ablauf.txt> <aus.f32> <messung.txt> [seed]
import fs from 'fs';
const [art, srT, kanT, einD, ablaufD, ausD, messD, seedT] = process.argv.slice(2);
const sr = Number(srT), kan = Number(kanT);
const NAME = { glow: 'aw-roehre', iron: 'aw-trafo', silk: 'aw-band' }[art];
const WASM = fs.readFileSync(process.env.AW_WASM || new URL('../../app/js/aw-dsp.wasm', import.meta.url));
// Math.random → mulberry32 (identisch in C: aw_zufall)
let a = Number(seedT || 12345) >>> 0;
Math.random = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), 1 | t); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
let K;
const meldungen = [];
globalThis.sampleRate = sr;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: (m) => meldungen.push(m) }; } };
const KL = {};
globalThis.registerProcessor = (n, k) => { KL[n] = k; };
(0, eval)(fs.readFileSync(new URL('../../app/js/dsp-worklet.js', import.meta.url), 'utf8'));
K = KL[NAME];
// Ablauf: "block befehl schlüssel wert"
const zeilen = fs.readFileSync(ablaufD, 'utf8').split('\n').map((z) => z.trim()).filter((z) => z && !z.startsWith('#'));
const wert = (w) => (w.includes(',') ? w.split(',').map(Number) : /^-?[\d.]+(e-?\d+)?$/.test(w) ? Number(w) : w);
const jeBlock = new Map();
for (const z of zeilen) {
  const [b, befehl, k, w] = z.split(/\s+/);
  if (!jeBlock.has(+b)) jeBlock.set(+b, []);
  const liste = jeBlock.get(+b);
  if (befehl === 'set') { const letzte = liste[liste.length - 1]; if (letzte && letzte.set) letzte.set[k] = wert(w); else liste.push({ set: { [k]: wert(w) } }); }
  else liste.push({ [befehl]: k === '1' });
}
const start = (jeBlock.get(0) || []).filter((m) => m.set).reduce((o, m) => Object.assign(o, m.set), {});
const p = new K({ processorOptions: { ...start, wasm: WASM, seed: Number(seedT || 12345) } });
const roh = new Float32Array(fs.readFileSync(einD).buffer.slice(0));
const n = roh.length / kan, B = 128;
const aus = new Float32Array(roh.length);
const ein = Array.from({ length: kan }, () => new Float32Array(B)), raus = Array.from({ length: kan }, () => new Float32Array(B));
const mess = [];
for (let b = 0; b * B < n; b++) {
  for (const m of jeBlock.get(b) || []) {
    if (m.set) { if (b > 0) p.port.onmessage({ data: m.set }); }
    else p.port.onmessage({ data: m });
  }
  const len = Math.min(B, n - b * B);
  for (let c = 0; c < kan; c++) { ein[c].fill(0); for (let i = 0; i < len; i++) ein[c][i] = roh[(b * B + i) * kan + c]; }
  meldungen.length = 0;
  p.process([ein], [raus]);
  for (const m of meldungen) if (m.faerb) mess.push(`${b} ${m.faerb[0]} ${m.faerb[1]}`);
  for (let c = 0; c < kan; c++) for (let i = 0; i < len; i++) aus[(b * B + i) * kan + c] = raus[c][i];
}
fs.writeFileSync(ausD, Buffer.from(aus.buffer));
fs.writeFileSync(messD, mess.join('\n') + '\n');
