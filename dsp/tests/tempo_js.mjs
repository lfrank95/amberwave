import fs from 'fs';
for (const [art, datei] of [['glow', 'waerme-worklet.js'], ['iron', 'trafo-worklet.js'], ['silk', 'band-worklet.js']]) for (const hq of [0, 1]) {
  const zeile = [];
  for (const sr of [44100, 96000, 192000]) {
    let K; globalThis.sampleRate = sr;
    globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() {} }; } };
    globalThis.registerProcessor = (n, k) => { K = k; };
    (0, eval)(fs.readFileSync(new URL('../../app/js/' + datei, import.meta.url), 'utf8'));
    const p = new K({ processorOptions: { drive: 4, hq, mix: 1 } });
    const l = new Float32Array(128), r = new Float32Array(128);
    const bl = Math.floor(5 * sr / 128), t0 = performance.now();
    for (let b = 0; b < bl; b++) { for (let i = 0; i < 128; i++) { l[i] = Math.random() - 0.5; r[i] = Math.random() - 0.5; } p.process([[l, r]], [[l, r]]); }
    zeile.push(`${sr} Hz: ${((performance.now() - t0) / 50).toFixed(2)} %`);
  }
  console.log(art, hq ? 'HQ ' : 'std', zeile.join('  '));
}
