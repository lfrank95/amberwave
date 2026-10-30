// Sättigungs-Schwerpunkt für Glow, Iron und Silk: ein EQ vor dem Effekt bestimmt, wo er sättigt, danach wird er wieder
// herausgerechnet („De-Emphasis“ 0–100 %; bei 100 % bleibt nur der verschobene Klirr, darunter auch ein Teil der Anhebung).
// Gerechnet wird in der C-Bibliothek (dsp/schwerpunkt.c); hier: Einstellung, Parameter und das Popup mit den Punkten.
// Einstellung je Gerät: sp = { an, ausgleich 0–100, baender: [{ f, g (dB), q }] × 5 } – Band 0 Tiefen-Kuhschwanz, 1–3 Glocken,
// 4 Höhen-Kuhschwanz.
import { h, icon } from './ui.js';
import { t } from './i18n.js';

export const SP_TYPEN = ['tief', 'glocke', 'glocke', 'glocke', 'hoch'];
const TYP_NR = { glocke: 1, tief: 2, hoch: 3 };
export const SP_GAIN_MAX = 15;
const F_MIN = 20, F_MAX = 20000;
export const SP_STANDARD = {
  an: false,
  ausgleich: 100,
  baender: [{ f: 100, g: 0, q: 0.7 }, { f: 350, g: 0, q: 1 }, { f: 1200, g: 0, q: 1 }, { f: 4000, g: 0, q: 1 }, { f: 9000, g: 0, q: 0.7 }],
};
const FARBEN = ['#ff8f6b', '#ffcf5a', '#8fe0a8', '#7cc4ff', '#c79bff'];
const clamp = (v, a, b) => Math.max(a, Math.min(b, Number.isFinite(+v) ? +v : a));

export function spNormal(sp) {
  const x = sp && typeof sp === 'object' ? sp : {};
  const b = Array.isArray(x.baender) ? x.baender : [];
  return {
    an: x.an === true,
    ausgleich: Math.round(clamp(x.ausgleich ?? 100, 0, 100)),
    baender: SP_STANDARD.baender.map((s, i) => ({
      f: Math.round(clamp(b[i]?.f ?? s.f, F_MIN, F_MAX)),
      g: Math.round(clamp(b[i]?.g ?? 0, -SP_GAIN_MAX, SP_GAIN_MAX) * 2) / 2,
      q: Math.round(clamp(b[i]?.q ?? s.q, 0.3, 6) * 100) / 100,
    })),
  };
}

/** Wirkt der Schwerpunkt (an und mindestens ein Punkt nicht auf 0 dB)? */
export function spAktiv(sp) {
  const x = spNormal(sp);
  return x.an && x.baender.some((b) => Math.abs(b.g) >= 0.25);
}

/** Werte für den Effekt (Worklet bzw. Engine): sp = 5 × [typ, f, g, q], sp_ausgleich 0–1 */
export function spParameter(sp) {
  const x = spNormal(sp), an = spAktiv(x);
  return {
    sp: x.baender.flatMap((b, i) => (an && Math.abs(b.g) >= 0.25 ? [TYP_NR[SP_TYPEN[i]], b.f, b.g, b.q] : [0, b.f, 0, b.q])),
    sp_ausgleich: x.ausgleich / 100,
  };
}

/** Betrag eines Bands in dB bei Frequenz f (dieselben RBJ-Formeln wie dsp/schwerpunkt.c) */
function bandDb(typ, f0, g, q, f, sr) {
  if (Math.abs(g) < 1e-6) return 0;
  f0 = Math.min(Math.max(f0, 10), sr * 0.49);
  const A = Math.pow(10, g / 40), w0 = 2 * Math.PI * f0 / sr, c = Math.cos(w0), s = Math.sin(w0), al = s / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (typ === 'glocke') { b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; }
  else {
    const sA = 2 * Math.sqrt(A) * al;
    if (typ === 'tief') {
      b0 = A * ((A + 1) - (A - 1) * c + sA); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - sA);
      a0 = (A + 1) + (A - 1) * c + sA; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - sA;
    } else {
      b0 = A * ((A + 1) + (A - 1) * c + sA); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - sA);
      a0 = (A + 1) - (A - 1) * c + sA; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - sA;
    }
  }
  const w = 2 * Math.PI * f / sr, cw = Math.cos(w), sw = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * cw + b2 * c2, ni = -(b1 * sw + b2 * s2), dr = a0 + a1 * cw + a2 * c2, di = -(a1 * sw + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

/** Anhebung vor dem Effekt in dB bei f */
export function spVorDb(sp, f, sr = 48000) {
  const x = spNormal(sp);
  return x.baender.reduce((s, b, i) => s + bandDb(SP_TYPEN[i], b.f, b.g, b.q, f, sr), 0);
}

const W = 440, H = 180, DB_SICHT = 18;
const xVonF = (f) => W * Math.log10(f / 20) / 3;
const fVonX = (x) => 20 * Math.pow(1000, x / W);
const yVonDb = (d) => clamp(H / 2 - d / DB_SICHT * (H * 0.45), 2, H - 2);
const fText = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1).replace('.0', '')} kHz` : `${Math.round(f)} Hz`);

let offen = null;
export function spPopupZu() {
  if (!offen) return;
  offen.zu();
}

/**
 * Popup öffnen. o: { anker, name, farbe, wert (sp-Einstellung), setzen(neu), spektrum() → AnalyserNode|null, sr }
 * Ändert die Einstellung live (setzen bei jeder Bewegung) und schließt mit Esc, Klick daneben oder dem Knopf.
 */
export function spPopup(o) {
  spPopupZu();
  let sp = spNormal(o.wert);
  let gew = 0, zug = null, raf = 0, rta = null, spBuf = null;
  const el = document.createElement('div');
  el.className = 'sp-popup';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', t('{name} · Sättigungs-Schwerpunkt', { name: o.name }));
  el.style.setProperty('--farbe', o.farbe || '#ffb547');
  el.innerHTML = `<div class="sp-kopf"><span class="sp-titel"><b>${h(o.name)}</b> · ${t('Schwerpunkt')}</span>
      <button type="button" class="sp-an" data-sp="an" aria-pressed="${sp.an}"><i></i>${t('An')}</button>
      <button type="button" class="sp-zu" data-sp="zu" aria-label="${t('Schließen')}">${icon('zu', 16)}</button></div>
    <div class="sp-graf" data-graf><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      ${[50, 100, 200, 500, 1000, 2000, 5000, 10000].map((f) => `<line x1="${xVonF(f).toFixed(1)}" y1="0" x2="${xVonF(f).toFixed(1)}" y2="${H}" class="sp-raster${[100, 1000, 10000].includes(f) ? ' stark' : ''}" vector-effect="non-scaling-stroke"/>`).join('')}
      ${[-12, -6, 6, 12].map((d) => `<line x1="0" y1="${yVonDb(d)}" x2="${W}" y2="${yVonDb(d)}" class="sp-raster" vector-effect="non-scaling-stroke"/>`).join('')}
      <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" class="sp-null" vector-effect="non-scaling-stroke"/>
      <path class="sp-spektrum" vector-effect="non-scaling-stroke"/>
      <path class="sp-rest" vector-effect="non-scaling-stroke"/>
      <path class="sp-kurve" vector-effect="non-scaling-stroke"/></svg>
      ${sp.baender.map((b, i) => `<span class="sp-pkt" data-pkt="${i}" style="--pf:${FARBEN[i]}" tabindex="0" role="slider" aria-label="${SP_TYPEN[i] === 'glocke' ? t('Glocke {n}', { n: i }) : SP_TYPEN[i] === 'tief' ? t('Tiefen') : t('Höhen')}"></span>`).join('')}
      ${[[100, '100'], [1000, '1k'], [10000, '10k']].map(([f, tx]) => `<span class="sp-mk" style="left:${(100 * xVonF(f) / W).toFixed(2)}%">${tx}</span>`).join('')}
      <span class="sp-info" data-info></span></div>
    <div class="sp-fuss">
      <label class="sp-regler"><span>${t('De-Emphasis')}</span><input type="range" min="0" max="100" step="1" value="${sp.ausgleich}" data-sp="ausgleich"><output data-ausgleich>${sp.ausgleich} %</output></label>
      <button type="button" class="sp-knopf" data-sp="null">${t('Alles auf 0')}</button>
    </div>
    <p class="sp-hinweis">${t('Punkt hoch = dort mehr Sättigung. Ziehen: Frequenz und Stärke · Mausrad: Breite · Doppelklick: 0 dB. De-Emphasis 100 %: der Klang bleibt neutral, nur der Klirr wandert; weniger lässt einen Teil der Anhebung stehen.')}</p>`;
  document.body.appendChild(el);

  const graf = el.querySelector('[data-graf]'), svg = graf.querySelector('svg');
  const info = el.querySelector('[data-info]');
  const aendern = (neu) => { sp = spNormal(neu); o.setzen(sp); zeichnen(); };
  const zeichnen = () => {
    const sr = o.sr || 48000;
    let kurve = '', rest = '';
    const restAnteil = 1 - sp.ausgleich / 100;
    for (let i = 0; i <= 160; i++) {
      const x = W * i / 160, d = sp.an ? spVorDb(sp, fVonX(x), sr) : 0;
      kurve += `${i ? 'L' : 'M'}${x.toFixed(1)} ${yVonDb(d).toFixed(1)}`;
      rest += `${i ? 'L' : 'M'}${x.toFixed(1)} ${yVonDb(d * restAnteil).toFixed(1)}`;
    }
    svg.querySelector('.sp-kurve').setAttribute('d', kurve);
    svg.querySelector('.sp-rest').setAttribute('d', sp.an && restAnteil > 0.005 ? rest : '');
    sp.baender.forEach((b, i) => {
      const p = graf.querySelector(`[data-pkt="${i}"]`);
      p.style.left = `${(100 * xVonF(b.f) / W).toFixed(2)}%`;
      p.style.top = `${(100 * yVonDb(b.g) / H).toFixed(2)}%`;
      p.classList.toggle('gew', i === gew);
      p.setAttribute('aria-valuetext', `${fText(b.f)}, ${b.g > 0 ? '+' : ''}${b.g} dB`);
    });
    const b = sp.baender[gew];
    info.textContent = `${fText(b.f)} · ${b.g > 0 ? '+' : ''}${b.g.toFixed(1)} dB${SP_TYPEN[gew] === 'glocke' ? ` · Q ${b.q.toFixed(2)}` : ''}`;
    el.classList.toggle('aus', !sp.an);
    el.querySelector('[data-sp="an"]').setAttribute('aria-pressed', String(sp.an));
    el.querySelector('[data-ausgleich]').textContent = `${sp.ausgleich} %`;
  };
  // Spektrum der Musik (hinter den Effekten) als Orientierung, 1/12 Oktave, schnell hoch, langsam zurück
  const spektrum = () => {
    raf = requestAnimationFrame(spektrum);
    const a = o.spektrum?.();
    const pfad = svg.querySelector('.sp-spektrum');
    if (!a) { pfad.setAttribute('d', ''); return; }
    const n = a.frequencyBinCount, sr = o.sr || 48000;
    if (!spBuf || spBuf.length !== n) spBuf = new Float32Array(n);
    a.getFloatFrequencyData(spBuf);
    const P = 120, binHz = sr / (n * 2);
    if (!rta) rta = new Float32Array(P).fill(-120);
    let d = '';
    for (let i = 0; i < P; i++) {
      const f0 = 20 * Math.pow(2, i / 12), f1 = 20 * Math.pow(2, (i + 1) / 12);
      const k0 = Math.max(1, Math.floor(f0 / binHz)), k1 = Math.min(n - 1, Math.max(k0, Math.floor(f1 / binHz)));
      let s = 0;
      for (let k = k0; k <= k1; k++) s += Math.pow(10, spBuf[k] / 10);
      const db = 10 * Math.log10(s + 1e-20);
      rta[i] += (db - rta[i]) * (db > rta[i] ? 0.5 : 0.1);
      const x = W * Math.log10(Math.sqrt(f0 * f1) / 20) / 3;
      d += `${i ? 'L' : 'M'}${x.toFixed(1)} ${clamp((-rta[i] - 10) / 90 * H, 0, H).toFixed(1)}`;
    }
    pfad.setAttribute('d', `${d}L${W} ${H}L0 ${H}Z`);
  };

  const ziehen = (e, start) => {
    const r = graf.getBoundingClientRect();
    const x = clamp((e.clientX - r.left) / r.width, 0, 1), y = clamp((e.clientY - r.top) / r.height, 0, 1);
    if (start) {
      const pkt = e.target.closest('[data-pkt]');
      let wahl = pkt ? +pkt.dataset.pkt : -1;
      if (wahl < 0) {
        let best = 1e9;
        sp.baender.forEach((b, i) => { const d = Math.hypot((xVonF(b.f) / W - x) * r.width, (yVonDb(b.g) / H - y) * r.height); if (d < best) { best = d; wahl = i; } });
        if (best > 44) return false;
      }
      gew = wahl;
      zug = true;
      try { graf.setPointerCapture(e.pointerId); } catch (x2) { /* egal */ }
    }
    const neu = JSON.parse(JSON.stringify(sp));
    const g = Math.round(((0.5 - y) / 0.45 * DB_SICHT) * 2) / 2;
    neu.baender[gew].f = Math.round(fVonX(x * W));
    neu.baender[gew].g = clamp(g, -SP_GAIN_MAX, SP_GAIN_MAX);
    if (!neu.an && Math.abs(neu.baender[gew].g) >= 0.25) neu.an = true;
    aendern(neu);
    return true;
  };
  graf.addEventListener('pointerdown', (e) => { if (ziehen(e, true)) e.preventDefault(); });
  graf.addEventListener('pointermove', (e) => { if (zug) ziehen(e, false); });
  const loslassen = () => { zug = null; };
  graf.addEventListener('pointerup', loslassen);
  graf.addEventListener('pointercancel', loslassen);
  graf.addEventListener('dblclick', (e) => {
    const pkt = e.target.closest('[data-pkt]');
    if (!pkt) return;
    const neu = JSON.parse(JSON.stringify(sp));
    neu.baender[+pkt.dataset.pkt].g = 0;
    aendern(neu);
  });
  graf.addEventListener('wheel', (e) => {
    if (SP_TYPEN[gew] !== 'glocke' && SP_TYPEN[gew] !== 'tief' && SP_TYPEN[gew] !== 'hoch') return;
    e.preventDefault();
    const neu = JSON.parse(JSON.stringify(sp)), b = neu.baender[gew];
    b.q = clamp(b.q * Math.pow(1.12, e.deltaY < 0 ? 1 : -1), 0.3, 6);
    aendern(neu);
  }, { passive: false });
  graf.addEventListener('keydown', (e) => {
    const pkt = e.target.closest('[data-pkt]');
    if (!pkt) return;
    const i = +pkt.dataset.pkt, neu = JSON.parse(JSON.stringify(sp)), b = neu.baender[i];
    const schritt = { ArrowUp: [0, 0.5], ArrowDown: [0, -0.5], ArrowRight: [1, 0], ArrowLeft: [-1, 0] }[e.key];
    if (!schritt) return;
    e.preventDefault();
    gew = i;
    b.f = clamp(b.f * Math.pow(2, schritt[0] / 12), F_MIN, F_MAX);
    b.g = clamp(b.g + schritt[1], -SP_GAIN_MAX, SP_GAIN_MAX);
    if (Math.abs(b.g) >= 0.25) neu.an = true;
    aendern(neu);
  });
  el.addEventListener('click', (e) => {
    const k = e.target.closest('[data-sp]');
    if (!k) return;
    if (k.dataset.sp === 'zu') zu();
    else if (k.dataset.sp === 'an') aendern({ ...sp, an: !sp.an });
    else if (k.dataset.sp === 'null') aendern({ ...sp, baender: sp.baender.map((b) => ({ ...b, g: 0 })) });
  });
  el.querySelector('[data-sp="ausgleich"]').addEventListener('input', (e) => aendern({ ...sp, ausgleich: +e.target.value }));

  // Platz: neben bzw. unter dem Anker, auf schmalen Bildschirmen als Blatt unten
  const platzieren = () => {
    if (matchMedia('(max-width: 767px)').matches) { el.classList.add('blatt'); return; }
    const r = o.anker.getBoundingClientRect(), b = el.offsetWidth, hh = el.offsetHeight;
    el.style.left = `${clamp(r.left + r.width / 2 - b / 2, 8, window.innerWidth - b - 8)}px`;
    const unten = r.bottom + 8 + hh <= window.innerHeight - 8 || r.top < hh + 16;
    el.style.top = `${Math.round(unten ? Math.min(r.bottom + 8, window.innerHeight - hh - 8) : r.top - hh - 8)}px`;
  };
  const aussen = (e) => { if (!el.contains(e.target) && !o.anker.contains(e.target)) zu(); };
  const taste = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); zu(); o.anker.focus?.(); } };
  function zu() {
    cancelAnimationFrame(raf);
    document.removeEventListener('pointerdown', aussen, true);
    document.removeEventListener('keydown', taste, true);
    window.removeEventListener('resize', platzieren);
    el.remove();
    if (offen && offen.el === el) offen = null;
    o.zu?.();
  }
  document.addEventListener('pointerdown', aussen, true);
  document.addEventListener('keydown', taste, true);
  window.addEventListener('resize', platzieren);
  offen = { el, zu };
  zeichnen();
  platzieren();
  spektrum();
  graf.querySelector(`[data-pkt="${gew}"]`).focus({ preventScroll: true });
  return offen;
}
