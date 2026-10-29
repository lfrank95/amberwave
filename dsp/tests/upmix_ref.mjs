// Referenz: Raumklang-Worklet (Upmix „Zwei Ebenen“) durch 128er-Blöcke. node upmix_ref.mjs <rate> <ein.f32 (stereo)> <aus.f32 (7 Kanäle)> <center 0/1>
import fs from 'fs';
const [srT, einD, ausD, cT] = process.argv.slice(2);
globalThis.sampleRate = Number(srT);
let K;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: () => {} }; } };
globalThis.registerProcessor = (n, k) => { K = k; };
(0, eval)(fs.readFileSync(new URL('../../app/js/raumklang-worklet.js', import.meta.url), 'utf8'));
const p = new K({ processorOptions: { transient: -8, ducking: -5, effekte: 0.6, breite: 0.35, center: cT === '1' } });
const roh = new Float32Array(fs.readFileSync(einD).buffer.slice(0));
const n = roh.length / 2, B = 128;
const aus = new Float32Array(n * 7);
const ein = [new Float32Array(B), new Float32Array(B)];
const o = [[new Float32Array(B), new Float32Array(B)], [new Float32Array(B), new Float32Array(B)], [new Float32Array(B), new Float32Array(B)], [new Float32Array(B)]];
for (let b = 0; b * B < n; b++) {
  if (b === 300) p.port.onmessage({ data: { effekte: 1.2, breite: 0.8 } });
  const len = Math.min(B, n - b * B);
  for (let c = 0; c < 2; c++) { ein[c].fill(0); for (let i = 0; i < len; i++) ein[c][i] = roh[(b * B + i) * 2 + c]; }
  p.process([ein], o);
  const flach = [o[0][0], o[0][1], o[1][0], o[1][1], o[2][0], o[2][1], o[3][0]];
  for (let c = 0; c < 7; c++) for (let i = 0; i < len; i++) aus[(b * B + i) * 7 + c] = flach[c][i];
}
fs.writeFileSync(ausD, Buffer.from(aus.buffer));
