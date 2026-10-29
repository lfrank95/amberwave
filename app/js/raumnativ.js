// Windows Client: Web-Audio-Ersatz für Space. Raumklang baut den Graphen mit denselben Funktionen wie im Browser, nur gegen
// diesen Kontext. Er schreibt den Graphen als Text für die Engine (dsp/raumgraph.c rechnet ihn wie Web Audio); Änderungen an
// Parametern danach (Blenden, Pegel, Solo) gehen als einzelne Befehle, Impulsantworten einmal als Daten.
// Nur was Space braucht: Gain, Biquad, IIR, Delay, Convolver, Splitter, Merger und der Upmix-Worklet.

const MODUS = { max: 0, 'clamped-max': 1, explicit: 2 };

class Param {
  constructor(knoten, wert) { this.k = knoten; this._v = wert; }
  get value() { return this._v; }
  set value(v) { this._v = Number(v) || 0; this.k.ctx._param(this.k, 'set', this._v, 0); }
  setValueAtTime(v, t) { this._v = v; this.k.ctx._param(this.k, 'set', v, t); return this; }
  linearRampToValueAtTime(v, t) { this._v = v; this.k.ctx._param(this.k, 'ramp', v, t); return this; }
  exponentialRampToValueAtTime(v, t) { return this.linearRampToValueAtTime(v, t); }
  setTargetAtTime(v, t, tau) { this._v = v; this.k.ctx._param(this.k, 'ziel', v, t, tau); return this; }
  setValueCurveAtTime(kurve, t, d) { const v = kurve[kurve.length - 1]; this.k.ctx._param(this.k, 'set', kurve[0], t); return this.linearRampToValueAtTime(v, t + d); }
  cancelScheduledValues(t) { this.k.ctx._param(this.k, 'stopp', 0, t); return this; }
  cancelAndHoldAtTime(t) { return this.cancelScheduledValues(t); }
}

class Knoten {
  constructor(ctx, typ, cc = 2, ccm = 'max', ci = 'speakers') {
    this.ctx = ctx; this.typ = typ; this.id = ++ctx._nId;
    this.channelCount = cc; this.channelCountMode = ccm; this.channelInterpretation = ci;
    this.ziele = [];   // [knoten, ausgang, eingang]
  }
  connect(ziel, aus = 0, ein = 0) {
    if (ziel instanceof Knoten) this.ziele.push([ziel, aus, ein]);
    return ziel;
  }
  disconnect(ziel) {
    this.ziele = ziel ? this.ziele.filter((z) => z[0] !== ziel) : [];
  }
  zeile() {
    return `N ${this.id} ${this.typ} ${this.channelCount} ${MODUS[this.channelCountMode] ?? 0} ${this.channelInterpretation === 'discrete' ? 1 : 0}${this.extra ? ' ' + this.extra() : ''}`;
  }
}

const zahl = (x) => (Number.isFinite(x) ? String(+x) : '0');

/** Kontext für den Windows Client. senden: Befehl an die Engine; rate(): aktuelle Abtastrate; kanaele(): Kanäle des Geräts */
export class NativKontext {
  constructor({ senden, rate, kanaele }) {
    this.nativ = true;
    this._senden = senden; this._rate = rate; this._kanaele = kanaele;
    this._nId = 0;
    this._live = new Set();     // Knoten des Graphen, der in der Engine läuft
    this._irIds = new WeakMap(); this._irNr = 0; this._irGesendet = new Set();
    this.state = 'running'; this.baseLatency = 0; this.outputLatency = 0.06;
    const ich = this;
    this.destination = { get maxChannelCount() { return ich._kanaele(); }, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' };
    this.audioWorklet = { addModule: () => Promise.resolve() };
  }
  get sampleRate() { return this._rate(); }
  get currentTime() { return performance.now() / 1000; }
  resume() { return Promise.resolve(); }
  suspend() { return Promise.resolve(); }

  // ---- Knoten ----
  createGain() { const k = new Knoten(this, 'gain'); k.gain = new Param(k, 1); k.extra = () => `v=${zahl(k.gain._v)}`; return k; }
  createBiquadFilter() {
    const k = new Knoten(this, 'biquad');
    k.type = 'lowpass'; k.frequency = new Param(k, 350); k.Q = new Param(k, 1); k.gain = new Param(k, 0); k.detune = new Param(k, 0);
    k.extra = () => `typ=${k.type} f=${zahl(k.frequency._v * Math.pow(2, k.detune._v / 1200))} q=${zahl(k.Q._v)} g=${zahl(k.gain._v)}`;
    return k;
  }
  createIIRFilter(ff, fb) { const k = new Knoten(this, 'iir'); k.extra = () => `ff=${Array.from(ff).map(zahl).join(',')} fb=${Array.from(fb).map(zahl).join(',')}`; return k; }
  createDelay(max = 1) { const k = new Knoten(this, 'delay'); k.delayTime = new Param(k, 0); k.extra = () => `max=${zahl(max)} v=${zahl(k.delayTime._v)}`; return k; }
  createConvolver() {
    const k = new Knoten(this, 'conv', 2, 'clamped-max');
    k.normalize = true; k.buffer = null;
    k.extra = () => (k.buffer ? `ir=${this._irId(k.buffer)}` : '');
    return k;
  }
  createChannelSplitter(n = 6) { return new Knoten(this, 'split', n, 'explicit', 'discrete'); }
  createChannelMerger(n = 6) { const k = new Knoten(this, 'merge', 1, 'explicit', 'speakers'); k.extra = () => `n=${n}`; return k; }
  createBuffer(kan, laenge, rate) { return new AudioBuffer({ numberOfChannels: kan, length: laenge, sampleRate: rate }); }
  createWorklet(name, o = {}) {
    if (name !== 'aw-upmix-ebenen') throw new Error(`Worklet ${name} gibt es im Windows Client nicht`);
    const k = new Knoten(this, 'upmix', o.channelCount ?? 2, o.channelCountMode ?? 'explicit', o.channelInterpretation ?? 'speakers');
    const p = o.processorOptions || {};
    k.extra = () => `transient=${zahl(p.transient ?? -8)} ducking=${zahl(p.ducking ?? -5)} effekte=${zahl(p.effekte ?? 0.5)} breite=${zahl(p.breite ?? 0.35)} center=${p.center ? 1 : 0}`;
    k.port = {
      onmessage: null,
      postMessage: (m) => {
        if (!m) return;
        if (typeof m.effekte === 'number') p.effekte = m.effekte;
        if (typeof m.breite === 'number') p.breite = m.breite;
        if (this._live.has(k) && (typeof m.effekte === 'number' || typeof m.breite === 'number')) {
          this._senden({ c: 'raum_m', 'w.k': k.id, 'w.effekte': typeof m.effekte === 'number' ? m.effekte : -1, 'w.breite': typeof m.breite === 'number' ? m.breite : -1 });
        }
      },
    };
    return k;
  }

  // ---- intern ----
  _dt(t) { return Math.max(0, (Number(t) || 0) - this.currentTime); }
  _param(k, art, w, t, tau = 0) {
    if (!this._live.has(k)) return;   // noch nicht gesendet: der Wert steht im Graphen
    this._senden({ c: 'raum_p', 'w.k': k.id, 'w.a': art, 'w.w': Number(w) || 0, 'w.dt': this._dt(t), 'w.tau': Number(tau) || 0 });
  }
  _irId(buf) {
    let id = this._irIds.get(buf);
    if (!id) {
      // gleicher Inhalt → gleiche ID (dieselbe aufbereitete IR geht nur einmal an die Engine)
      let h = 2166136261 >>> 0;
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const f = buf.getChannelData(c), d = new Uint32Array(f.buffer, f.byteOffset, f.length);
        for (let i = 0; i < d.length; i += 61) h = Math.imul(h ^ d[i], 16777619) >>> 0;
      }
      id = `ir_${buf.length}_${buf.sampleRate}_${h.toString(36)}`;
      this._irIds.set(buf, id);
    }
    return id;
  }

  /** Engine neu gestartet: nichts läuft dort mehr, Impulsantworten neu schicken */
  zuruecksetzen() { this._live = new Set(); this._irGesendet = new Set(); }

  /** Impulsantwort als Daten (Float32, Base64 je Kanal) */
  _irSenden(buf) {
    const id = this._irId(buf);
    if (this._irGesendet.has(id)) return;
    const o = { c: 'raum_ir', id, 'w.kan': buf.numberOfChannels, 'w.n': buf.length, 'w.rate': buf.sampleRate };
    for (let c = 0; c < buf.numberOfChannels; c++) o[`w.d${c}`] = base64(buf.getChannelData(c));
    this._senden(o);
    this._irGesendet.add(id);
  }

  /** Graph von quelle bis ziel als Text (und die Impulsantworten vorab) an die Engine */
  graphSenden(quelle, ziel) {
    const knoten = [], gesehen = new Set([quelle]);
    const schlange = [quelle];
    while (schlange.length) {
      const k = schlange.shift();
      knoten.push(k);
      for (const [z] of k.ziele) if (!gesehen.has(z)) { gesehen.add(z); schlange.push(z); }
    }
    if (!gesehen.has(ziel)) { gesehen.add(ziel); knoten.push(ziel); }
    for (const k of knoten) if (k.typ === 'conv' && k.buffer) this._irSenden(k.buffer);
    const zeilen = knoten.map((k) => (k === quelle ? k.zeile().replace(' gain ', ' quelle ') : k.zeile()));
    zeilen.push(`E ${quelle.id}`, `A ${ziel.id}`);
    for (const k of knoten) for (const [z, a, e] of k.ziele) if (gesehen.has(z)) zeilen.push(`V ${k.id} ${a} ${z.id} ${e}`);
    this._live = new Set(knoten);
    this._senden({ c: 'raum', 'w.g': zeilen.join('\n'), 'w.rate': this.sampleRate, 'w.kan': this.destination.channelCount || 2 });
    return zeilen.join('\n');
  }
}

function base64(f32) {
  const b = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
