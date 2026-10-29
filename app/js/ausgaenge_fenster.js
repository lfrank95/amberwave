// Lautsprecher-Manager (Windows Client, ASIO): je Treiber beliebig viele Ausgänge – Lautsprecher (Stereo, 2.1, Quadro,
// 5.1) mit Aufstellung, Abständen → Delay, Pegel je Lautsprecher und Subwoofer-Weiche – oder Kopfhörer mit Balance,
// Crossfeed und Pegel. Fertige Ausgänge öffnen mit der Übersicht, neue mit dem Assistenten. Gespeichert wird erst mit
// „Übernehmen“ (im Client, je Treiber); Delay, Pegel und Kopfhörer-Klang sind vorher schon live zu hören, wenn der
// Ausgang gerade spielt.
import { h, icon, toast, bestaetigen } from './ui.js';
import { t, tn, zahl as zahlFmt, region } from './i18n.js';
import { nativ } from './nativ.js';
import { LAYOUTS, SYMBOLE, lsVon, lsName, symbolVon, symbolSvg, ausgangName, autoName, layoutKurz } from './ausgaenge.js';
import { eqNormal, reserveVon, kanalAktiv, aktivAnzahl } from './kanal_eq.js';
import { eqFenster } from './kanal_eq_fenster.js';

const SCHALL = 343;   // m/s bei ~20 °C
const KURVE = { w: 900, fmin: 20, fmax: 2000 };
const WINKEL = { L: -30, R: 30, C: 0, Ls: -110, Rs: 110, LFE: -66 };
const NAME = { L: t('Links'), R: t('Rechts'), C: t('Center'), LFE: t('Subwoofer'), Ls: t('Surround links'), Rs: t('Surround rechts') };
const CF = [['aus', t('Aus'), t('Original')], ['leicht', t('Leicht'), '−6 dB · 700 Hz'], ['mittel', t('Mittel'), `−${zahlFmt(4.5, 1)} dB · 700 Hz`], ['stark', t('Stark'), '−3 dB · 650 Hz']];
const SCHRITTE = [['ausgang', t('Ausgang')], ['anschluss', t('Anschluss')], ['abstand', t('Abstand & Pegel')], ['sub', t('Subwoofer')]];
const KH_SCHRITTE = [['ausgang', t('Ausgang')], ['anschluss', t('Anschluss')], ['klang', t('Klang')]];
const SVG_TREIBER = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="2" y="7" width="20" height="10" rx="2.5"/><circle cx="12" cy="12" r="2.4"/><circle cx="17" cy="12" r="1.6"/><path d="M5 10.5h3M5 13.5h3"/></svg>';

const de = (v, n = 1) => zahlFmt(v, n);
const kopie = (o) => JSON.parse(JSON.stringify(o));
const neueId = () => Math.random().toString(36).slice(2, 10);
// Einheiten folgen der Region des Servers: metrisch → nur m, imperial → nur ft/in (gespeichert wird immer in Metern)
const IMP = region?.einheiten === 'imperial';
const FT = 0.3048, ZOLL = 0.0254;
const distText = (m) => { if (!IMP) return `${de(m, 2)} m`; const z = Math.round(m / ZOLL); return `${Math.floor(z / 12)} ft ${z % 12} in`; };
const zahl0 = (v) => (Math.abs(v) < 0.005 ? 0 : v);

/* ---------- Werte eines Ausgangs ---------- */
const kartenObj = (a) => Object.fromEntries(lsVon({ ...a, art: 'ls' }).map((k, i) => [k, a.karte[i]]));
const kurz = (a) => (a.art === 'kh' ? t('Kopfhörer') : layoutKurz(a));
const delayAuto = (a, k) => { const ls = lsVon({ ...a, art: 'ls' }); const weit = Math.max(...ls.map((x) => a.dist[x])); return (weit - a.dist[k]) / SCHALL * 1000; };
const delayVon = (a, k) => (a.delay_hand?.[k] != null ? a.delay_hand[k] : delayAuto(a, k));
const lsListe = (a) => lsVon({ ...a, art: 'ls' });
const balText = (b) => (b === 0 ? t('Mitte') : b < 0 ? t('{n} % links', { n: -b }) : t('{n} % rechts', { n: b }));
const khDb = (a, seite) => { const b = a.kh.balance; const x = seite === 'L' ? (b > 0 ? 1 - b / 100 : 1) : (b < 0 ? 1 + b / 100 : 1); return x >= 1 ? 0 : x <= 0 ? -60 : 20 * Math.log10(x); };
const khNeutral = (a) => a.kh.balance === 0 && a.kh.crossfeed === 'aus' && a.kh.pegel === 0;

/** Ausgang aus dem Client vollständig machen (ältere Einträge haben keine Abstände/Kopfhörer-Daten) */
function normal(a) {
  const x = kopie(a);
  x.art = x.art === 'kh' ? 'kh' : 'ls';
  x.dist = { L: 2.5, R: 2.5, C: 2.5, LFE: 2.5, Ls: 2.5, Rs: 2.5, ...(x.dist || {}) };
  x.pegel = { L: 0, R: 0, C: 0, LFE: 0, Ls: 0, Rs: 0, ...(x.pegel || {}) };
  x.delay_hand = { ...(x.delay_hand || {}) };
  x.kh = { karte: [x.karte[0] ?? 0, x.karte[1] ?? 1], balance: 0, crossfeed: 'aus', pegel: 0, ...(x.kh || {}) };
  x.trenn = x.trenn || 80;
  x.einheit = !x.einheit || x.einheit === 'ms' ? 'ms' : (IMP ? 'in' : 'm');
  x._mem = kartenObj(x);   // Kanäle von Lautsprechern merken, die ein Layoutwechsel ausblendet
  eqNormal(x);
  return x;
}

/**
 * Öffnet den Manager. treiber = „asio:{…}“, name = Anzeigename des Treibers, aktiv = gerade gewählter Ausgang (Bus-ID),
 * nachher(ergebnis) nach dem Übernehmen
 */
export async function ausgaengeFenster({ treiber, name, aktiv = '', player = null, nachher = null }) {
  if (!nativ?.ausgaengeLesen) { toast(t('Dafür braucht es den neuesten Amberwave Windows Client.'), 'fehler'); return; }
  const start = await nativ.ausgaengeLesen(treiber).catch(() => null);
  if (!start) { toast(t('Ausgänge lassen sich nicht lesen'), 'fehler'); return; }
  const liste = start.ausgaenge.map(normal);
  let namen = start.namen || [];
  let wahl = Math.max(0, liste.findIndex((a) => a.id === aktiv));
  let neu = false;            // „+ Neuer Ausgang“: erst die Art wählen
  let alleK = false;          // alle Ausgänge des Interfaces in der Matrix
  let ton = null;             // gerade laufender Testton (Lautsprecher-Schlüssel, KL/KR)
  let lsWahl = 'L';           // zuletzt angefasster Lautsprecher (markiert in Tabelle/Skizze)
  let vgl = 'klang';          // Kopfhörer A/B: 'orig' | 'klang'
  let geaendert = false;
  let zu = false;
  const schritte = new Map(); // Ausgang-ID → aktueller Schritt (nicht gespeichert)

  const d = document.createElement('dialog');
  d.className = 'dialog lm';
  d.setAttribute('aria-labelledby', 'lm-titel');
  document.body.appendChild(d);

  const a = () => liste[wahl];
  const zahl = () => Math.max(namen.length, ...liste.flatMap((x) => [...x.karte, ...x.kh.karte].map((k) => k + 1)), namen.length ? 0 : 8);
  const kanalName = (c) => namen[c] || t('Ausgang {n}', { n: c + 1 });
  const kopfTx = () => tn(zahl(), '{name} · {n} Ausgang', '{name} · {n} Ausgänge', { name });
  const schritt = (x = a()) => schritte.get(x.id) || (x.fertig ? 'uebersicht' : 'ausgang');
  const schrittSetzen = (s) => { schritte.set(a().id, s); };
  const autoSym = (x) => symbolVon({ ...x, symbol: 'auto' });
  const symVon = (x) => (x.art === 'kh' && (x.symbol === 'auto' || !x.symbol) ? 'kopfhoerer' : symbolVon(x));

  /* ---------- Skizzen ---------- */
  const winkel = (x, k) => (x.layout === 'quadro' && (k === 'Ls' || k === 'Rs') ? (k === 'Ls' ? -135 : 135) : WINKEL[k]);

  /** Aufstellung (nicht maßstäblich): Hörplatz in der Mitte, Lautsprecher auf ihren Plätzen im Layout */
  function aufstellungSvg(x) {
    const w = 420, hh = 360, cx = w / 2, cy = hh * 0.53, r = 112;
    const k = kartenObj(x);
    let s = `<svg class="lm-raum" viewBox="${cx - r - 46} ${cy - r - 64} ${2 * r + 92} ${2 * r + 116}" role="img" aria-label="${t('Aufstellung {name}', { name: h(kurz(x)) })}">
      <rect x="${cx - r - 40}" y="${cy - r - 46}" width="${2 * r + 80}" height="${2 * r + 80}" rx="14" fill="rgba(255,244,230,.02)" stroke="rgba(255,236,214,.1)"/>
      <line x1="${cx - 60}" x2="${cx + 60}" y1="${cy - r - 46}" y2="${cy - r - 46}" stroke="rgba(255,181,71,.35)" stroke-width="3"/><text x="${cx}" y="${cy - r - 52}" class="lm-ringt" style="text-anchor:middle">${t('vorne')}</text>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,236,214,.09)" stroke-dasharray="4 5"/>
      <rect x="${cx - 26}" y="${cy + 6}" width="52" height="20" rx="6" fill="rgba(255,236,214,.06)" stroke="rgba(255,236,214,.18)"/>`;
    for (const l of lsListe(x)) {
      const sub = l === 'LFE';
      const wi = (winkel(x, l) - 90) * Math.PI / 180;
      const px = sub ? cx - r - 6 : cx + Math.cos(wi) * r, py = sub ? cy - r + 8 : cy + Math.sin(wi) * r;
      s += `<line x1="${cx}" y1="${cy}" x2="${px.toFixed(1)}" y2="${py.toFixed(1)}" stroke="${sub ? 'rgba(127,182,255,.18)' : 'rgba(255,181,71,.14)'}"/>
        <g class="lm-ls${sub ? ' sub' : ''}${lsWahl === l ? ' wahl' : ''}${ton === l ? ' ton' : ''}" data-ton="${l}" role="button" tabindex="0" aria-label="${t('Testton {name}', { name: NAME[l] })}" transform="translate(${px.toFixed(1)} ${py.toFixed(1)})">
        ${ton === l ? '<circle class="lm-welle" r="18"/><circle class="lm-welle w2" r="18"/>' : ''}
        <g transform="rotate(${sub ? 0 : winkel(x, l)})"><rect x="-14" y="-17" width="28" height="34" rx="${sub ? 5 : 6}" ${sub ? 'stroke-dasharray="4 3"' : ''}/><circle r="${sub ? 8 : 6}" cy="${sub ? 0 : 4}" fill="none" stroke="${sub ? 'var(--lm-sub)' : 'var(--accent-a)'}" stroke-width="1.5"/>${sub ? '' : '<circle r="2" cy="-9" fill="none" stroke="var(--accent-a)"/>'}</g>
        <text y="-26">${l}</text><text class="lm-nr" y="32">${t('Ausgang {n}', { n: k[l] + 1 })}</text></g>`;
    }
    return s + `<g transform="translate(${cx} ${cy})"><circle r="13" fill="rgba(255,236,214,.1)" stroke="rgba(255,236,214,.45)"/><path d="M0 -7l5 11h-10z" fill="rgba(255,236,214,.75)"/></g></svg>`;
  }

  /** Maßstäbliche Skizze: Radius = Abstand, Ringe je Meter (skalieren mit), an jedem Lautsprecher Abstand und Delay */
  function raumSvg(x) {
    const w = 380, hh = 340, cx = w / 2 + 14, cy = hh * 0.5;
    const ls = lsListe(x), k = kartenObj(x);
    const weit = Math.max(...ls.map((l) => x.dist[l]));
    const px = (Math.min(cx, cy) - 46) / weit;
    const einh = IMP ? FT : 1, schritt = IMP ? (weit / FT > 26 ? 6 : 3) : (weit > 8 ? 2 : 1);
    const max = Math.floor(weit / einh / schritt) * schritt;
    let s = `<svg class="lm-raum" viewBox="0 0 ${w} ${hh}" role="img" aria-label="${t('Raumskizze')}">`;
    for (let m = schritt; m <= max + 1e-6; m += schritt) s += `<circle class="lm-ring" cx="${cx}" cy="${cy}" r="${(m * einh * px).toFixed(1)}"/><text class="lm-ringt" style="text-anchor:middle" x="${cx}" y="${(cy + m * einh * px - 3).toFixed(1)}">${de(m, m % 1 ? 1 : 0)} ${IMP ? 'ft' : 'm'}</text>`;
    for (const l of ls) {
      const wi = (winkel(x, l) - 90) * Math.PI / 180, r = x.dist[l] * px, lx = cx + Math.cos(wi) * r, ly = cy + Math.sin(wi) * r;
      const sub = l === 'LFE', dl = delayVon(x, l);
      s += `<line class="lm-strahl" x1="${cx}" y1="${cy}" x2="${lx.toFixed(1)}" y2="${ly.toFixed(1)}" stroke="${sub ? 'rgba(127,182,255,.4)' : 'rgba(255,181,71,.3)'}"/>`;
      const wert = distText(x.dist[l]), dw = dl < 0.005 ? '0 ms' : `+${de(dl, 2)} ms`;
      s += `<g class="lm-ls${sub ? ' sub' : ''}${lsWahl === l ? ' wahl' : ''}${ton === l ? ' ton' : ''}" data-ton="${l}" role="button" tabindex="0" aria-label="${t('Testton {name}', { name: NAME[l] })}" transform="translate(${lx.toFixed(1)} ${ly.toFixed(1)})">
        ${ton === l ? '<circle class="lm-welle" r="18"/><circle class="lm-welle w2" r="18"/>' : ''}
        <rect x="-15" y="-15" width="30" height="30" rx="${sub ? 5 : 7}" ${sub ? 'stroke-dasharray="4 3"' : ''}/><circle r="${sub ? 8 : 6}" fill="none" stroke="${sub ? 'var(--lm-sub)' : 'var(--accent-a)'}" stroke-width="1.5"/>
        ${sub ? `<text x="-20" y="-3" style="text-anchor:end">${l} · ${k[l] + 1}</text><text class="lm-wert" x="-20" y="9" style="text-anchor:end">${wert}</text><text class="lm-wert d${dl < 0.005 ? ' null' : ''}" x="-20" y="20" style="text-anchor:end">${dw}</text>`
          : `<text y="-21">${l} · ${k[l] + 1}</text><text class="lm-wert" y="27">${wert}</text><text class="lm-wert d${dl < 0.005 ? ' null' : ''}" y="38">${dw}</text>`}</g>`;
    }
    s += `<g transform="translate(${cx} ${cy})"><circle r="14" fill="rgba(255,236,214,.08)" stroke="rgba(255,236,214,.4)"/><path d="M0 -7l5 11h-10z" fill="rgba(255,236,214,.7)"/><text y="28" style="fill:var(--text-muted);font-weight:600">${t('Hörplatz')}</text></g>`;
    return s + '</svg>';
  }

  function zeitBalken(x) {
    const ls = lsListe(x), ankunft = (l) => x.dist[l] / SCHALL * 1000 + delayVon(x, l);
    const max = Math.max(...ls.map(ankunft)) * 1.1 || 1;
    return `<div class="lm-zeit"><span class="lm-lbl">${t('Ankunft am Hörplatz')}</span>${ls.map((l) => `<div class="lm-zb${l === 'LFE' ? ' sub' : ''}"><span>${l}</span><i><b class="dl" style="left:0;width:${(delayVon(x, l) / max * 100).toFixed(1)}%"></b><b style="left:${(delayVon(x, l) / max * 100).toFixed(1)}%;width:${(x.dist[l] / SCHALL * 1000 / max * 100).toFixed(1)}%"></b></i><span>${de(ankunft(l), 2)} ms</span></div>`).join('')}</div>`;
  }

  const lr4 = (f, fc, hoch) => { const v = Math.pow(f / fc, 4); return hoch ? v / (1 + v) : 1 / (1 + v); };
  function kurveSvg(x) {
    const w = KURVE.w, hh = 285, fmin = KURVE.fmin, fmax = KURVE.fmax, fx = (f) => Math.log(f / fmin) / Math.log(fmax / fmin) * w;
    const y = (db) => 14 + (-db) / 30 * (hh - 30);
    const pfad = (fn) => Array.from({ length: 120 }, (_, i) => { const f = fmin * Math.pow(fmax / fmin, i / 119); const db = Math.max(-60, 10 * Math.log10(Math.max(1e-9, fn(f)))); return `${i ? 'L' : 'M'}${fx(f).toFixed(1)} ${y(db).toFixed(1)}`; }).join('');
    let g = '';
    for (const f of [20, 50, 100, 200, 500, 1000, 2000]) g += `<line class="lm-gitter" x1="${fx(f)}" x2="${fx(f)}" y1="10" y2="${hh - 16}"/><text x="${fx(f) + 2}" y="${hh - 4}">${f >= 1000 ? `${f / 1000}k` : f}</text>`;
    for (const db of [0, -6, -12, -24]) g += `<line class="lm-gitter" x1="0" x2="${w}" y1="${y(db)}" y2="${y(db)}"/><text x="2" y="${y(db) - 2}">${db} dB</text>`;
    return `<svg class="lm-kurve" viewBox="0 0 ${w} ${hh}" data-kurve role="slider" aria-label="${t('Trennfrequenz')}" aria-valuemin="50" aria-valuemax="200" aria-valuenow="${x.trenn}" tabindex="0">
      <defs><clipPath id="lm-kclip"><rect x="0" y="0" width="${w}" height="${y(-30)}"/></clipPath>
      <linearGradient id="lm-kblend" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="${(y(-24) / y(-30)).toFixed(3)}" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
      <mask id="lm-kmask"><rect x="0" y="0" width="${w}" height="${y(-30)}" fill="url(#lm-kblend)"/></mask></defs>${g}
      <rect x="${fx(50)}" y="10" width="${fx(200) - fx(50)}" height="${hh - 26}" fill="rgba(127,182,255,.04)"/>
      <g clip-path="url(#lm-kclip)" mask="url(#lm-kmask)"><path d="${pfad((f) => lr4(f, x.trenn, false))}" fill="none" stroke="var(--lm-sub)" stroke-width="2.4"/>
      <path d="${pfad((f) => lr4(f, x.trenn, true))}" fill="none" stroke="var(--accent-a)" stroke-width="2.4"/></g>
      <path d="${pfad(() => 1)}" fill="none" stroke="rgba(255,236,214,.5)" stroke-width="1.2" stroke-dasharray="5 4"/>
      <line x1="${fx(x.trenn)}" x2="${fx(x.trenn)}" y1="10" y2="${hh - 16}" stroke="rgba(255,236,214,.5)" stroke-width="1.5"/><circle cx="${fx(x.trenn)}" cy="${y(-6)}" r="7" fill="#fff3e2" stroke="var(--accent-a)" stroke-width="2"/>
      <text x="${fx(x.trenn) + 9}" y="22" style="fill:var(--text-primary)">${x.trenn} Hz · −6 dB</text></svg>`;
  }
  function miniKurve(x) {
    const w = 220, hh = 64, fmin = 20, fmax = 2000, fx = (f) => Math.log(f / fmin) / Math.log(fmax / fmin) * w, y = (db) => 6 + (-db) / 30 * (hh - 12);
    const pfad = (fn) => Array.from({ length: 60 }, (_, i) => { const f = fmin * Math.pow(fmax / fmin, i / 59); return `${i ? 'L' : 'M'}${fx(f).toFixed(1)} ${y(Math.max(-60, 10 * Math.log10(Math.max(1e-9, fn(f))))).toFixed(1)}`; }).join('');
    return `<svg class="lm-mini-k" viewBox="0 0 ${w} ${hh}" aria-hidden="true"><defs><clipPath id="lm-mk"><rect width="${w}" height="${hh}"/></clipPath></defs>
      <g clip-path="url(#lm-mk)"><path d="${pfad((f) => lr4(f, x.trenn, false))}" fill="none" stroke="var(--lm-sub)" stroke-width="2"/><path d="${pfad((f) => lr4(f, x.trenn, true))}" fill="none" stroke="var(--accent-a)" stroke-width="2"/></g>
      <line x1="${fx(x.trenn)}" x2="${fx(x.trenn)}" y1="0" y2="${hh}" stroke="rgba(255,236,214,.35)" stroke-dasharray="2 3"/></svg>`;
  }
  function kopfSvg(x) {
    const cx = 190, cy = 135;
    const lDb = khDb(x, 'L'), rDb = khDb(x, 'R');
    const st = (db) => Math.pow(10, db / 20);
    const welle = (px, dir, staerke) => [0, 1, 2].map((i) => `<path class="lm-kw" d="M${px - dir * (28 + i * 12)} ${cy - 12 - i * 5} q${-dir * 8} ${12 + i * 5} 0 ${24 + i * 10}" fill="none" stroke="var(--accent-a)" stroke-width="2" opacity="${(staerke * (1 - i * 0.28)).toFixed(2)}"/>`).join('');
    const cf = x.kh.crossfeed !== 'aus';
    const seite = (l, px) => `<g class="lm-ls${ton === `K${l}` ? ' ton' : ''}" data-ton="K${l}" role="button" tabindex="0" aria-label="${l === 'L' ? t('Testton links') : t('Testton rechts')}" transform="translate(${px} ${cy + 6})"><rect x="-18" y="-34" width="36" height="68" rx="14"/><text y="-44">${l} · ${x.kh.karte[l === 'L' ? 0 : 1] + 1}</text><text class="lm-wert" y="50">${(l === 'L' ? lDb : rDb) < 0 ? `−${de(-(l === 'L' ? lDb : rDb), 1)} dB` : '0 dB'}</text></g>`;
    return `<svg class="lm-raum" viewBox="${cx - 140} ${cy - 145} 280 ${cf ? 285 : 230}" role="img" aria-label="${t('Kopfhörer')}">
      <path d="M${cx - 95} ${cy} v-28 a95 95 0 0 1 190 0 v28" fill="none" stroke="rgba(255,236,214,.35)" stroke-width="8" stroke-linecap="round"/>
      <ellipse cx="${cx}" cy="${cy + 6}" rx="62" ry="78" fill="rgba(255,236,214,.05)" stroke="rgba(255,236,214,.2)"/>
      <path d="M${cx} ${cy - 48}l7 12h-14z" fill="rgba(255,236,214,.4)"/><text x="${cx}" y="${cy - 56}" class="lm-ringt" style="text-anchor:middle">${t('vorne')}</text>
      ${cf ? `<path d="M${cx - 70} ${cy + 40} Q${cx} ${cy + 90} ${cx + 70} ${cy + 40}" fill="none" stroke="var(--lm-sub)" stroke-width="1.6" stroke-dasharray="4 4"/><path d="M${cx + 70} ${cy + 52} Q${cx} ${cy + 102} ${cx - 70} ${cy + 52}" fill="none" stroke="var(--lm-sub)" stroke-width="1.6" stroke-dasharray="4 4"/><text x="${cx}" y="${cy + 118}" class="lm-ringt" style="text-anchor:middle;fill:var(--lm-sub)">${t('Crossfeed {stufe}', { stufe: CF.find((c) => c[0] === x.kh.crossfeed)[1].toLowerCase() })}</text>` : ''}
      ${seite('L', cx - 98)}${seite('R', cx + 98)}
      ${ton === 'KL' ? welle(cx - 98, -1, st(lDb)) : ''}${ton === 'KR' ? welle(cx + 98, 1, st(rDb)) : ''}
    </svg>`;
  }

  /* ---------- Bausteine ---------- */
  const stepH = (attr, wert, cls = '') => `<div class="lm-step"><button type="button" data-${attr} data-r="-1" aria-label="${t('weniger')}">−</button><b class="${cls}">${wert}</b><button type="button" data-${attr} data-r="1" aria-label="${t('mehr')}">+</button></div>`;
  const tonKnopf = (key, label, rund = true) => `<button type="button" class="lm-ton${rund ? ' rund' : ''}${ton === key ? ' laeuft' : ''}" data-ton="${key}" aria-label="${t('Testton {name}', { name: h(label) })}" title="${t('Testton {name}', { name: h(label) })}" ${ton && ton !== key ? 'disabled' : ''}>▶</button>`;

  /** EQ-Knopf eines Lautsprechers: Punkt = EQ aktiv (Bänder in der Kurzinfo) */
  const eqKnopf = (x, l) => {
    const e = x.eq[l], an = kanalAktiv(e);
    return `<button type="button" class="lm-eqk${an ? ' an' : ''}" data-eq="${l}" title="${an ? tn(aktivAnzahl(e), 'Equalizer {name} · {n} Band aktiv', 'Equalizer {name} · {n} Bänder aktiv', { name: h(lsName(x.layout, l)) }) : t('Equalizer {name} · aus', { name: h(lsName(x.layout, l)) })}" aria-label="${an ? tn(aktivAnzahl(e), 'Equalizer {name}, {n} Band aktiv', 'Equalizer {name}, {n} Bänder aktiv', { name: h(lsName(x.layout, l)) }) : t('Equalizer {name}', { name: h(lsName(x.layout, l)) })}">EQ${an ? `<i>${aktivAnzahl(e)}</i>` : ''}</button>`;
  };

  function busZeile(x, i) {
    const an = i === wahl && !neu;
    const kanaele = (x.art === 'kh' ? x.kh.karte : x.karte).map((k) => k + 1).join(', ');
    return `<button type="button" class="lm-bus${an ? ' an' : ''}" data-bus="${i}" ${an ? 'aria-current="true"' : ''}><span>${symbolSvg(symVon(x), 22)}</span>
      <span class="lm-bus-tx"><b>${h(ausgangName(x))}</b><small>${h(kurz(x))} · ${t('Kanal {kanaele}', { kanaele })}${x.id === aktiv ? ` · ${t('aktiv')}` : ''}</small></span></button>`;
  }
  const navHtml = () => `<span class="lm-klein">${t('Ausgänge')}</span>${liste.map(busZeile).join('')}<button type="button" class="lm-bus neu${neu ? ' an' : ''}" data-neu>${icon('plus', 16)} ${t('Neuer Ausgang')}</button>
    <p class="lm-nav-hinweis">${t('Jeder Ausgang erscheint als eigenes Gerät in der Geräteliste und in der Schnellwahl im Player. Die Lautstärke wird je Ausgang gemerkt.')}</p>`;

  const artHtml = (x) => `<span class="lm-lbl">${t('Art')}</span><div class="lm-art-w" role="radiogroup" aria-label="${t('Art')}">
    <button type="button" role="radio" aria-checked="${x.art === 'ls'}" class="lm-art${x.art === 'ls' ? ' an' : ''}" data-art="ls">${symbolSvg('paar', 26)}<b>${t('Lautsprecher')}</b><span>${t('Stereo, 2.1, Quadro, 5.1 · mit Aufstellung')}</span></button>
    <button type="button" role="radio" aria-checked="${x.art === 'kh'}" class="lm-art${x.art === 'kh' ? ' an' : ''}" data-art="kh">${symbolSvg('kopfhoerer', 26)}<b>${t('Kopfhörer')}</b><span>${t('L R · Balance, Crossfeed')}</span></button></div>`;

  /** Kanäle, die andere Ausgänge belegen (zur Info in der Matrix) */
  function belegtVonAnderen() {
    const m = {};
    liste.forEach((x, i) => {
      if (i === wahl) return;
      (x.art === 'kh' ? x.kh.karte : x.karte).forEach((c) => { m[c] = ausgangName(x); });
    });
    return m;
  }
  /** Tipp aus den Treibernamen: ein freies Paar, das nach Kopfhörer klingt */
  function kopfhoererTipp() {
    const belegt = new Set(liste.flatMap((x) => (x.art === 'kh' ? x.kh.karte : x.karte)));
    for (let c = 0; c + 1 < namen.length; c++) {
      if (/phones|kopfh|headph|hp\b/i.test(namen[c]) && !belegt.has(c) && !belegt.has(c + 1)) return c;
    }
    return -1;
  }

  /** Kanal-Matrix: zeilen = [[schlüssel, kurz, name, sub?]], karte = {schlüssel: kanal}, attr = data-Attribut */
  function matrixHtml(zeilen, karte, attr, tonPrefix = '') {
    const z = zahl();
    const max = Math.max(...Object.values(karte));
    const n = alleK ? z : Math.min(z, Math.max(10, max + 1));
    const andere = belegtVonAnderen();
    const benutzt = new Set(zeilen.map(([k]) => karte[k]));
    const kopf = Array.from({ length: n }, (_, c) => `<th scope="col" class="${benutzt.has(c) ? 'an' : ''}${andere[c] ? ' fremd' : ''}" title="${h(kanalName(c))}${andere[c] ? ` – ${t('belegt von {name}', { name: h(andere[c]) })}` : ''}"><b>${c + 1}</b><span>${h(kanalName(c))}</span></th>`).join('');
    const reihen = zeilen.map(([k, kz, nm, sub]) => `<tr class="${lsWahl === k ? 'wahl' : ''}"><th scope="row"><span class="lm-k${sub ? ' sub' : ''}">${kz}</span><span class="lm-nm">${nm}</span></th>
      ${Array.from({ length: n }, (_, c) => `<td class="${benutzt.has(c) ? 'spalte' : ''}${andere[c] ? ' fremd' : ''}"><button type="button" class="lm-pt${karte[k] === c ? ' an' : ''}" data-${attr}="${k},${c}" aria-pressed="${karte[k] === c}" aria-label="${t('{name} auf Ausgang {n}', { name: nm, n: c + 1 })}"></button></td>`).join('')}
      <td class="lm-tz">${tonKnopf(tonPrefix + k, nm)}</td></tr>`).join('');
    const fremd = [...new Set(Object.values(andere))];
    return `<div class="lm-mx-rahmen"><table class="lm-mx"><thead><tr><th></th>${kopf}<th></th></tr></thead><tbody>${reihen}</tbody></table></div>
      <div class="lm-mx-fuss"><span>${n < z ? t('Ausgänge {von}–{bis} ausgeblendet', { von: n + 1, bis: z }) : t('alle {n} Ausgänge', { n: z })}${z > 10 ? ` · <button type="button" class="lm-link" data-alle-k>${alleK ? t('weniger zeigen') : t('alle zeigen')}</button>` : ''}</span>
        ${fremd.length ? `<span class="lm-fremd-l"><i></i>${t('belegt von {name}', { name: fremd.map(h).join(', ') })}</span>` : ''}</div>
      <div class="lm-zuordnung">${zeilen.map(([k, kz, , sub]) => `<span class="lm-zu${sub ? ' sub' : ''}"><b>${kz}</b>→ ${karte[k] + 1} <em>${h(kanalName(karte[k]))}</em></span>`).join('')}</div>`;
  }

  function pruefHtml(x) {
    const ls = lsListe(x), k = kartenObj(x), ks = ls.map((l) => k[l]);
    const doppelt = ks.length !== new Set(ks).size, andere = belegtVonAnderen(), fremd = ls.filter((l) => andere[k[l]]);
    const subName = x.sub || x.layout === '51' ? kanalName(k.LFE) : '';
    const zeilen = [
      [!doppelt, doppelt ? t('Ein Ausgang ist doppelt belegt') : t('Alle {n} Lautsprecher haben einen eigenen Ausgang', { n: ls.length })],
      [!fremd.length, fremd.length ? tn(fremd.length, '{ls} teilt sich einen Ausgang mit {name}', '{ls} teilen sich einen Ausgang mit {name}', { ls: fremd.join(', '), name: h(andere[k[fremd[0]]]) }) : t('Kein Ausgang wird auch von einem anderen Ausgang benutzt')],
      ...(subName ? [[!/phones|spdif|s\/pdif/i.test(subName), /phones/i.test(subName) ? t('Sub auf „{name}“ – ein Kopfhörerausgang? Bitte prüfen', { name: h(subName) }) : t('Sub auf „{name}“', { name: h(subName) })]] : []),
    ];
    return `<div class="lm-pruef"><div class="lm-kh-t"><b>${t('Prüfung')}</b><button type="button" class="lm-mini" data-ton="alle-reihum" ${ton ? 'disabled' : ''}>${t('▶ Alle reihum testen')}</button></div>
      ${zeilen.map(([ok, txt]) => `<div class="lm-pz ${ok ? 'ok' : 'warn'}"><i>${ok ? '✓' : '!'}</i>${txt}</div>`).join('')}</div>`;
  }

  const schnelltest = () => `<div class="lm-schnell"><div class="lm-kh-t"><b>${t('Schnelltest')}</b><span>${t('Kopfhörer aufsetzen')}</span></div>
    <div class="lm-schnell-k"><button type="button" class="lm-sk${ton === 'KL' ? ' laeuft' : ''}" data-ton="KL" ${ton ? 'disabled' : ''}><b>L</b><span>${t('links')}</span></button><button type="button" class="lm-sk" data-ton="KLR" ${ton ? 'disabled' : ''}><b>L → R</b><span>${t('nacheinander')}</span></button><button type="button" class="lm-sk${ton === 'KR' ? ' laeuft' : ''}" data-ton="KR" ${ton ? 'disabled' : ''}><b>R</b><span>${t('rechts')}</span></button></div>
    <button type="button" class="lm-tausch" data-khtausch>${t('⇄ Kommt es von der falschen Seite? Seiten tauschen')}</button></div>`;

  /* ---------- Seiten ---------- */
  function neuHtml() {
    const tipp = kopfhoererTipp();
    return {
      tabs: '<div class="lm-schritte"><button type="button" aria-selected="true" class="lm-ueb-tab"><i>+</i>' + t('Neuer Ausgang') + '</button></div>',
      inhalt: `<div class="lm-karte lm-neu-k">
        <h4>${t('Was hängt an diesem Ausgang?')}</h4><span class="lm-hilfe">${t('Danach führt der Assistent durch die passenden Schritte. Die Art lässt sich später im Schritt „Ausgang“ ändern.')}</span>
        <div class="lm-neu-w"><button type="button" class="lm-neu-art" data-neuart="ls">${symbolSvg('paar', 56)}<b>${t('Lautsprecher')}</b><span>${t('Stereo, 2.1, Quadro oder 5.1 – mit Aufstellung, Abständen, Delay und Subwoofer')}</span><em>${t('Ausgang · Anschluss · Abstand &amp; Pegel · Subwoofer')}</em></button>
          <button type="button" class="lm-neu-art" data-neuart="kh">${symbolSvg('kopfhoerer', 56)}<b>${t('Kopfhörer')}</b><span>${t('Linke und rechte Seite – mit Balance, Crossfeed und Pegel')}</span><em>${t('Ausgang · Anschluss · Klang')}</em></button></div>
        ${tipp >= 0 ? `<span class="lm-hilfe lm-vorschlag">${t('Tipp aus dem Treiber: Kanal {a}/{b} heißt „{name}“ – dort ist wohl ein Kopfhörer.', { a: tipp + 1, b: tipp + 2, name: h(kanalName(tipp).replace(/\s*L$/, '')) })}</span>` : ''}</div>`,
      nav: `<button type="button" class="lm-btn" data-zurueck-bus>${t('← Zurück')}</button><button type="button" class="lm-btn weiter" disabled style="visibility:hidden">${t('Weiter →')}</button>`,
    };
  }

  function khHtml(x) {
    const s = schritt(x);
    const ueb = s === 'uebersicht';
    const idx = KH_SCHRITTE.findIndex(([k]) => k === s);
    const tabs = `<div class="lm-schritte" role="tablist"><button type="button" role="tab" aria-selected="${ueb}" class="lm-ueb-tab" data-kh="uebersicht"><i>✓</i>${t('Übersicht')}</button><span class="lm-trenner"></span>${KH_SCHRITTE.map(([k, tx], i) => `<button type="button" role="tab" aria-selected="${s === k}" class="${x.fertig || idx > i ? 'ok' : ''}" data-kh="${k}"><i>${i + 1}</i>${tx}</button>`).join('')}</div>`;
    const kmap = { L: x.kh.karte[0], R: x.kh.karte[1] };
    const neutral = khNeutral(x);
    let inhalt;
    if (ueb) {
      inhalt = `<div class="lm-zeile"><div class="lm-karte lm-ue">
        <div class="lm-ue-kopf"><span class="lm-gross-sym">${symbolSvg(symVon(x), 34)}</span><div class="lm-tx"><b>${h(ausgangName(x))}</b><div class="lm-chips"><span class="lm-chip">${t('Kopfhörer')}</span><span class="lm-chip">${t('Kanal {l} · {r}', { l: kmap.L + 1, r: kmap.R + 1 })}</span>${x.id === aktiv ? `<span class="lm-chip gut">${t('● aktiv im Player')}</span>` : ''}</div></div><button type="button" class="lm-mini" data-kh="ausgang">${t('Bearbeiten ›')}</button></div>
        <div class="lm-ue-block"><div class="lm-ue-t"><span class="lm-lbl">${t('Klang')}</span><button type="button" class="lm-mini" data-kh="klang">${t('Bearbeiten ›')}</button></div>
          <div class="lm-ue-sub"><span><b>${balText(x.kh.balance)}</b>${t('Balance')}</span><span><b>${CF.find((c) => c[0] === x.kh.crossfeed)[1]}</b>${t('Crossfeed')}</span><span><b>${x.kh.pegel === 0 ? '0' : de(x.kh.pegel)}<small> dB</small></b>${t('Pegel')}</span></div></div>
        <div class="lm-ue-block"><div class="lm-ue-t"><span class="lm-lbl">${t('Anschluss')}</span><button type="button" class="lm-mini" data-kh="anschluss">${t('Bearbeiten ›')}</button></div>
          <div class="lm-ue-liste">${['L', 'R'].map((k) => `<div class="lm-ue-ls kh"><span class="lm-k">${k}</span><span class="lm-nm">${k === 'L' ? t('Links') : t('Rechts')}</span><span class="lm-m"><span class="lm-ch">${kmap[k] + 1}</span></span><span class="lm-m r">${khDb(x, k) < 0 ? `−${de(-khDb(x, k), 1)}` : '0'}<small>dB</small></span>${tonKnopf(`K${k}`, k === 'L' ? t('links') : t('rechts'))}</div>`).join('')}</div></div>
        <span class="lm-hilfe">${t('Keine Aufstellung, Abstände oder Sub – beim Kopfhörer sitzt der Schall am Ohr.')}</span>
        <div class="lm-ue-status"><div class="lm-st ${neutral ? 'gut' : 'warn'}"><b>${neutral ? t('Bitgenau möglich') : t('Wird gerechnet')}</b><span>${neutral ? t('Balance Mitte, Crossfeed aus, 0 dB') : t('Balance, Crossfeed oder Pegel ändern das Signal')}</span></div>
          <div class="lm-st info"><b>${t('Lautstärke eigen')}</b><span>${t('wird je Ausgang gemerkt')}</span></div><div class="lm-st gut"><b>${t('Kein Sub')}</b><span>${t('Bass bleibt im Kopfhörer')}</span></div></div></div>
        <div class="lm-karte lm-ue-rechts"><div class="lm-ue-t"><h4>${t('Kopfhörer')}</h4><button type="button" class="lm-mini" data-ton="KLR" ${ton ? 'disabled' : ''}>${t('▶ L, dann R')}</button></div>${kopfSvg(x)}</div></div>`;
    } else if (s === 'ausgang') {
      inhalt = `<div class="lm-zeile"><div class="lm-karte">
        <div class="lm-kopfzeile"><span class="lm-gross-sym">${symbolSvg(symVon(x), 38)}</span><div class="lm-feld"><label for="lm-name">${t('Name')}</label><input id="lm-name" class="lm-name" data-name maxlength="60" value="${h(x.name)}" placeholder="${t('Kopfhörer')}"><span class="lm-hilfe">${t('So heißt er in der Geräteliste und im Player.')}</span></div></div>
        ${artHtml(x)}
        <span class="lm-hilfe">${t('Beim Wechsel bleiben Name und Anschluss erhalten; Aufstellung, Abstände und Sub werden nur ausgeblendet.')}</span>
        ${schnelltest()}
        <button type="button" class="lm-link lm-loeschen" data-loeschen ${liste.length < 2 ? 'disabled' : ''}>${t('Ausgang löschen')}</button></div>
        <div class="lm-karte"><h4>${t('Kopfhörer')} <small>${t('antippen = Testton')}</small></h4>${kopfSvg(x)}</div></div>`;
    } else if (s === 'anschluss') {
      const tipp = /phones|kopfh|headph/i.test(kanalName(kmap.L)) ? t('Vom Treiber: {a}/{b} heißen „{name}“ – passt.', { a: kmap.L + 1, b: kmap.R + 1, name: h(kanalName(kmap.L).replace(/\s*L$/, '')) }) : '';
      inhalt = `<div class="lm-zeile anschl"><div class="lm-karte"><h4>${t('Welche Seite an welchem Ausgang?')} <small>${t('Klick auf einen belegten tauscht')}</small></h4>
        ${matrixHtml([['L', 'L', t('Links')], ['R', 'R', t('Rechts')]], kmap, 'khz', 'K')}
        ${tipp ? `<span class="lm-hilfe lm-vorschlag">${tipp}</span>` : ''}
        ${schnelltest()}</div>
        <div class="lm-karte lm-klein-k"><h4>${t('Kopfhörer')}</h4>${kopfSvg(x)}</div></div>`;
    } else {
      inhalt = `<div class="lm-zeile"><div class="lm-karte lm-kh-klang">
        <div class="lm-kh-r"><div class="lm-kh-t"><b>${t('Balance')}</b><span data-khbw>${balText(x.kh.balance)}</span></div>
          <div class="lm-kh-sl"><span>L</span><input type="range" class="regler" min="-100" max="100" step="5" value="${x.kh.balance}" data-khbal aria-label="${t('Balance')}" style="--wert:${(x.kh.balance + 100) / 2}%"><span>R</span></div></div>
        <div class="lm-kh-r"><div class="lm-kh-t"><b>${t('Crossfeed')}</b><span>${t('wie Lautsprecher statt „im Kopf“')}</span></div>
          <div class="lm-cf" role="radiogroup" aria-label="${t('Crossfeed')}">${CF.map(([k, tx, h2]) => `<button type="button" role="radio" aria-checked="${x.kh.crossfeed === k}" class="lm-cf-k${x.kh.crossfeed === k ? ' an' : ''}" data-khcf="${k}"><b>${tx}</b><span>${h2}</span></button>`).join('')}</div></div>
        <div class="lm-kh-r"><div class="lm-kh-t"><b>${t('Pegel')}</b><span data-khpw>${de(x.kh.pegel)} dB</span></div>
          <div class="lm-kh-sl"><span>−18</span><input type="range" class="regler" min="-18" max="0" step="0.5" value="${x.kh.pegel}" data-khpeg aria-label="${t('Pegel')}" style="--wert:${(x.kh.pegel + 18) / 18 * 100}%"><span>0</span></div>
          <span class="lm-hilfe">${t('Fest absenken für empfindliche Kopfhörer – der Lautstärkeregler hat dann mehr Weg.')}</span></div>
        <div class="lm-ab-v"><div class="lm-kh-t"><b>${t('Vergleichen')}</b><span>${t('während Musik auf diesem Ausgang läuft')}</span></div>
          <div class="lm-ab-k"><button type="button" class="${vgl === 'orig' ? 'an' : ''}" data-khvgl="orig"><b>A</b>${t('Original')}</button><button type="button" class="${vgl !== 'orig' ? 'an' : ''}" data-khvgl="klang"><b>B</b>${t('mit Balance, Crossfeed, Pegel')}</button></div>
          <span class="lm-hilfe">${t('Pegel in A gleich mit – so hört man nur den Unterschied, nicht „lauter = besser“.')}</span></div>
        <div class="lm-kh-fuss ${neutral ? 'gut' : ''}">${neutral ? t('● bitgenau') : t('● wird gerechnet (Balance, Crossfeed oder Pegel)')}</div></div>
        <div class="lm-karte"><h4>${t('Kopfhörer')} <small>${x.kh.crossfeed !== 'aus' ? t('Crossfeed blau') : t('antippen = Testton')}</small></h4>${kopfSvg(x)}</div></div>`;
    }
    const nav = ueb ? `<button type="button" class="lm-btn" data-kh="ausgang">${t('Assistent ›')}</button><button type="button" class="lm-btn weiter" disabled style="visibility:hidden">${t('Weiter →')}</button>`
      : `<button type="button" class="lm-btn" data-kh="${idx > 0 ? KH_SCHRITTE[idx - 1][0] : 'uebersicht'}">${idx > 0 ? t('← Zurück') : t('← Übersicht')}</button><button type="button" class="lm-btn weiter" data-kh="${idx < KH_SCHRITTE.length - 1 ? KH_SCHRITTE[idx + 1][0] : 'uebersicht'}" ${idx === KH_SCHRITTE.length - 1 ? 'data-fertig="1"' : ''}>${idx < KH_SCHRITTE.length - 1 ? t('Weiter →') : t('Fertig ✓')}</button>`;
    return { tabs, inhalt, nav };
  }

  function uebersichtHtml(x) {
    const ls = lsListe(x), k = kartenObj(x);
    const bearb = (s) => `<button type="button" class="lm-mini" data-schritt="${s}">${t('Bearbeiten ›')}</button>`;
    const maxPeg = Math.max(...ls.map((l) => x.pegel[l]));
    const maxDel = Math.max(...ls.map((l) => delayVon(x, l)));
    const eqN = ls.filter((l) => kanalAktiv(x.eq[l])).length, eqRes = reserveVon(x, ls);
    const zeilen = ls.map((l) => {
      const dl = delayVon(x, l), hand = x.delay_hand[l] != null;
      return `<div class="lm-ue-ls${ton === l ? ' spielt' : ''}"><span class="lm-k${l === 'LFE' ? ' sub' : ''}">${l}</span><span class="lm-nm">${NAME[l]}</span>
        <span class="lm-m"><span class="lm-ch">${k[l] + 1}</span></span><span class="lm-m r">${IMP ? distText(x.dist[l]) : `${de(x.dist[l], 2)}<small>m</small>`}</span>
        <span class="lm-m r${hand ? ' hand' : ''}">${dl < 0.005 ? '–' : de(dl, 2)}<small>${dl < 0.005 ? '' : 'ms'}</small>${hand ? `<i title="${t('von Hand')}">●</i>` : ''}</span>
        <span class="lm-m r">${x.pegel[l] === 0 ? '0' : `${x.pegel[l] > 0 ? '+' : ''}${de(x.pegel[l])}`}<small>dB</small></span>${eqKnopf(x, l)}${tonKnopf(l, NAME[l])}</div>`;
    }).join('');
    const status = [
      x.sub ? ['warn', t('Weiche aktiv'), t('Bass unter {hz} Hz geht auf den Sub – nicht bitgenau', { hz: x.trenn })] : eqN ? ['warn', tn(eqN, 'EQ auf {n} Kanal', 'EQ auf {n} Kanälen'), t('Wird gerechnet (64 Bit) – nicht bitgenau')] : maxDel > 0.005 || ls.some((l) => x.pegel[l] !== 0) ? ['warn', t('Wird gerechnet'), t('Delay oder Pegel ändern das Signal')] : ['gut', t('Bitgenau möglich'), t('kein Bassmanagement, keine Delays')],
      maxDel > 0.005 ? ['info', t('Delay ≤ {ms} ms', { ms: de(maxDel, 1) }), t('alle Lautsprecher kommen gleichzeitig am Hörplatz an')] : ['gut', t('Keine Delays'), t('alle Lautsprecher gleich weit weg')],
      eqRes > 0 ? ['info', t('Reserve −{db} dB', { db: de(eqRes + maxPeg) }), t('EQ hebt bis +{db} dB an – alles wird so weit abgesenkt', { db: de(eqRes) })] : maxPeg > 0 ? ['info', t('Reserve −{db} dB', { db: de(maxPeg) }), t('höchster Pegel über 0 dB – alles wird so weit abgesenkt')] : ['gut', t('Volle Reserve'), t('kein Pegel über 0 dB')],
    ];
    return `<div class="lm-zeile">
      <div class="lm-karte lm-ue">
        <div class="lm-ue-kopf"><span class="lm-gross-sym">${symbolSvg(symVon(x), 34)}</span><div class="lm-tx"><b>${h(ausgangName(x))}</b><div class="lm-chips"><span class="lm-chip">${h(kurz(x))}</span><span class="lm-chip">${t('Kanal {kanaele}', { kanaele: ls.map((l) => k[l] + 1).join(' · ') })}</span>${x.id === aktiv ? `<span class="lm-chip gut">${t('● aktiv im Player')}</span>` : ''}</div></div>${bearb('ausgang')}</div>
        <div class="lm-ue-block"><div class="lm-ue-t"><span class="lm-lbl">${t('Lautsprecher')}</span>${bearb('abstand')}</div>
          <div class="lm-ue-ls lm-kopfz"><span></span><span></span><span>${t('Ausg.')}</span><span class="r">${t('Abstand')}</span><span class="r">${t('Delay')}</span><span class="r">${t('Pegel')}</span><span>EQ</span><span></span></div>
          <div class="lm-ue-liste">${zeilen}</div></div>
        ${x.sub ? `<div class="lm-ue-block"><div class="lm-ue-t"><span class="lm-lbl">${t('Subwoofer')}</span>${bearb('sub')}</div>
          <div class="lm-ue-subz">${miniKurve(x)}<div class="lm-ue-sub"><span><b>${x.trenn}<small> Hz</small></b>${t('Trennung')}</span><span><b>${x.phase ? '180°' : '0°'}</b>${t('Phase')}</span><span><b>${de(delayVon(x, 'LFE'), 2)}<small> ms</small></b>${t('Delay')}</span></div></div></div>` : ''}
        <div class="lm-ue-status">${status.map(([art, t, h2]) => `<div class="lm-st ${art}" title="${h2}"><b>${t}</b><span>${h2}</span></div>`).join('')}</div>
      </div>
      <div class="lm-karte lm-ue-rechts"><div class="lm-ue-t"><h4>${t('Aufstellung')}</h4><button type="button" class="lm-mini" data-ton="alle-reihum" ${ton ? 'disabled' : ''}>${t('▶ Alle reihum testen')}</button></div>${raumSvg(x)}${zeitBalken(x)}</div></div>`;
  }

  function lsHtml(x) {
    const liste2 = SCHRITTE.filter(([k]) => k !== 'sub' || x.sub);
    let s = schritt(x);
    if (s === 'sub' && !x.sub) s = 'abstand';
    const idx = liste2.findIndex(([k]) => k === s);
    const ueb = s === 'uebersicht';
    const tabs = `<div class="lm-schritte" role="tablist"><button type="button" role="tab" aria-selected="${ueb}" class="lm-ueb-tab" data-schritt="uebersicht"><i>✓</i>${t('Übersicht')}</button><span class="lm-trenner"></span>${liste2.map(([k, tx], i) => `<button type="button" role="tab" aria-selected="${s === k}" class="${x.fertig || idx > i ? 'ok' : ''}" data-schritt="${k}"><i>${i + 1}</i>${tx}</button>`).join('')}</div>`;
    let inhalt = '';
    if (ueb) inhalt = uebersichtHtml(x);
    else if (s === 'ausgang') {
      inhalt = `<div class="lm-zeile">
        <div class="lm-karte">
          <div class="lm-kopfzeile"><span class="lm-gross-sym">${symbolSvg(symVon(x), 38)}</span>
            <div class="lm-feld"><label for="lm-name">${t('Name')}</label><input id="lm-name" class="lm-name" data-name maxlength="60" value="${h(x.name)}" placeholder="${h(autoName(x))}"><span class="lm-hilfe">${t('So heißt der Ausgang in der Geräteliste und im Player. Leer = „{name}“.', { name: h(autoName(x)) })}</span></div></div>
          ${artHtml(x)}
          <span class="lm-lbl">${t('Symbol')}</span>
          <div class="lm-symbole" role="radiogroup" aria-label="${t('Symbol')}">${SYMBOLE.map(([k, tx]) => `<button type="button" role="radio" aria-checked="${x.symbol === k}" class="lm-sym${x.symbol === k ? ' an' : ''}" data-symbol="${k}">${symbolSvg(k === 'auto' ? autoSym(x) : k, 22)}${t(tx)}</button>`).join('')}</div>
          <span class="lm-lbl">${t('Layout')}</span>
          <div class="lm-layouts" role="radiogroup" aria-label="${t('Layout')}">${['stereo', 'quadro', '51'].map((k) => [k, LAYOUTS[k]]).map(([k, l]) => `<button type="button" role="radio" aria-checked="${x.layout === k}" class="lm-lay${x.layout === k ? ' an' : ''}" data-layout="${k}"><b>${x.sub && k !== '51' ? l.sub : l.kurz}</b><span>${l.ls.join(' ')}${x.sub && k !== '51' ? ' + Sub' : ''}</span></button>`).join('')}</div>
          <button type="button" class="lm-schalter${x.sub ? ' an' : ''}" data-sub role="switch" aria-checked="${!!x.sub}"><span class="lm-sw"></span><span><b>${x.layout === '51' ? t('Bassmanagement') : t('Subwoofer')}</b><small>${x.sub ? t('Bass unter {hz} Hz kommt aus dem Sub', { hz: x.trenn }) : t('Aus: Bass bleibt auf den Hauptlautsprechern')}</small></span></button>
          <button type="button" class="lm-link lm-loeschen" data-loeschen ${liste.length < 2 ? 'disabled' : ''}>${t('Ausgang löschen')}</button></div>
        <div class="lm-karte"><h4>${t('Aufstellung {name}', { name: h(kurz(x)) })} <small>${t('antippen = Testton')}</small></h4>${aufstellungSvg(x)}</div></div>`;
    } else if (s === 'anschluss') {
      inhalt = `<div class="lm-zeile anschl">
        <div class="lm-karte"><h4>${t('Welcher Lautsprecher an welchem Ausgang?')} <small>${t('Klick auf einen belegten tauscht')}</small></h4>
          ${matrixHtml(lsListe(x).map((l) => [l, l, NAME[l], l === 'LFE']), kartenObj(x), 'zelle')}${pruefHtml(x)}</div>
        <div class="lm-karte lm-klein-k"><h4>${t('Aufstellung')}</h4>${aufstellungSvg(x)}<span class="lm-hilfe">${t('Antippen = Testton auf diesem Lautsprecher (rosa Rauschen, −20 dBFS, 2 s).')}</span></div></div>`;
    } else if (s === 'abstand') {
      const dText = (ms) => { const e = x.einheit; const v = Math.round((e === 'm' ? ms / 1000 * SCHALL : e === 'in' ? ms / 1000 * SCHALL / 0.0254 : ms) * 10) / 10; return `${v > 0 ? '+' : ''}${de(zahl0(v))} ${e}`; };
      inhalt = `<div class="lm-zeile breit">
        <div class="lm-karte"><h4>${t('Je Lautsprecher')} <small>${t('Abstand zum Hörplatz')}</small></h4>
          <div class="lm-ab-grid"><span></span><span class="lm-lbl">${t('Abstand')}</span><span class="lm-lbl">${t('Delay')}</span><span></span><span class="lm-lbl">${t('Pegel')}</span><span class="lm-lbl">EQ</span><span></span>
          ${lsListe(x).map((l) => { const hand = x.delay_hand[l] != null; return `<div class="lm-ab-zeile${lsWahl === l ? ' wahl' : ''}"><span class="lm-k${l === 'LFE' ? ' sub' : ''}">${l}</span>
            ${stepH(`dist="${l}"`, distText(x.dist[l]))}
            ${stepH(`del="${l}"`, dText(delayVon(x, l)), hand ? 'manuell' : '')}
            <button type="button" class="lm-auto-k${hand ? ' an' : ''}" data-auto="${l}" title="${hand ? t('zurück auf automatisch ({wert})', { wert: dText(delayAuto(x, l)) }) : t('automatisch aus dem Abstand')}" ${hand ? '' : 'disabled'}>${hand ? '↺' : 'A'}</button>
            <span class="lm-pg"><input type="range" class="regler" min="-12" max="6" step="0.5" value="${x.pegel[l]}" data-pegel="${l}" aria-label="${t('Pegel {name}', { name: NAME[l] })}" style="--wert:${(x.pegel[l] + 12) / 18 * 100}%"><b data-pw="${l}">${x.pegel[l] > 0 ? '+' : ''}${de(x.pegel[l])}</b></span>
            ${eqKnopf(x, l)}${tonKnopf(l, NAME[l])}</div>`; }).join('')}</div>
          <span class="lm-hilfe">${t('A = Delay automatisch aus dem Abstand · ↺ = von Hand verstellt, zurück auf automatisch · Pegel in dB')}</span>
          <div class="lm-einheit-z"><span class="lm-lbl">${t('Delay in')}</span><div class="lm-seg">${(IMP ? [['ms', 'ms'], ['in', 'in']] : [['ms', 'ms'], ['m', 'm']]).map(([k, tx]) => `<button type="button" data-einheit="${k}" aria-pressed="${x.einheit === k}">${tx}</button>`).join('')}</div></div>
          ${zeitBalken(x)}</div>
        <div class="lm-karte"><h4>${t('Skizze')} <small>${t('maßstäblich')}</small></h4>${raumSvg(x)}<span class="lm-hilfe">${t('Grau = Delay, Farbe = Laufzeit durch den Raum – enden alle Balken gleich, kommt alles gleichzeitig an.')}</span></div></div>`;
    } else {
      const dText = (ms) => `${ms > 0.005 ? '+' : ''}${de(zahl0(ms), 2)} ms`;
      inhalt = `<div class="lm-karte lm-kurve-k"><h4>${t('Weiche')} <small>${t('klicken oder ziehen · Linkwitz-Riley 24 dB/Okt.')}</small></h4>${kurveSvg(x)}
          <span class="lm-hilfe"><span style="color:var(--accent-a)">━</span> ${t('Hauptlautsprecher')} · <span style="color:var(--lm-sub)">━</span> ${t('Subwoofer')} · <span style="color:var(--text-muted)">┅</span> ${t('Summe')}</span></div>
        <div class="lm-subraster">
          <div class="lm-karte"><span class="lm-lbl">${t('Trennfrequenz')}</span><div class="lm-step"><button type="button" data-trenn="-10" aria-label="${t('10 Hz tiefer')}" ${x.trenn <= 50 ? 'disabled' : ''}>−</button><b>${x.trenn} Hz</b><button type="button" data-trenn="10" aria-label="${t('10 Hz höher')}" ${x.trenn >= 200 ? 'disabled' : ''}>+</button></div><span class="lm-hilfe">${t('50–200 Hz in 10-Hz-Schritten.')}</span></div>
          <div class="lm-karte"><span class="lm-lbl">${t('Phase Sub')}</span><div class="lm-seg"><button type="button" data-phase="0" aria-pressed="${!x.phase}">0°</button><button type="button" data-phase="1" aria-pressed="${!!x.phase}">${t('180° invertiert')}</button></div>
            <span class="lm-hilfe">${t('Am Hörplatz umschalten: wo der Bass an der Trennfrequenz voller klingt, ist richtig.')}</span></div>
          <div class="lm-karte"><span class="lm-lbl">${t('Delay Sub')}</span><b class="lm-wertgross">${dText(delayVon(x, 'LFE'))}</b><span class="lm-hilfe">${t('Kommt aus Abstand &amp; Pegel – dort einstellen.')}</span><button type="button" class="lm-ton" data-schritt="abstand">${t('→ Abstand &amp; Pegel')}</button></div>
        </div>`;
    }
    const nav = ueb ? `<button type="button" class="lm-btn" data-schritt="ausgang">${t('Assistent ›')}</button><button type="button" class="lm-btn weiter" disabled style="visibility:hidden">${t('Weiter →')}</button>`
      : `<button type="button" class="lm-btn" data-schritt="${idx > 0 ? liste2[idx - 1][0] : 'uebersicht'}">${idx > 0 ? t('← Zurück') : t('← Übersicht')}</button><button type="button" class="lm-btn weiter" data-schritt="${idx < liste2.length - 1 ? liste2[idx + 1][0] : 'uebersicht'}" ${idx === liste2.length - 1 ? 'data-fertig="1"' : ''}>${idx < liste2.length - 1 ? t('Weiter →') : t('Fertig ✓')}</button>`;
    return { tabs, inhalt, nav };
  }

  function fussText(x) {
    if (neu) return '';
    if (x.art === 'kh') return khNeutral(x) ? t('Bitgenau, solange Space, Effekte und Lautstärke-Angleich aus sind.') : t('Balance, Crossfeed oder Pegel: nicht bitgenau, gerechnet in 64 Bit.');
    if (schritt(x) === 'uebersicht') return '';
    if (lsListe(x).some((l) => kanalAktiv(x.eq[l]))) return t('Mit EQ nicht bitgenau: Filter, Delay und Pegel rechnen jedes Sample (64 Bit).');
    if (x.sub) return t('Mit Subwoofer nicht bitgenau: Weiche und Delay rechnen jedes Sample.');
    return t('Bitgenau, solange alle Delays 0, alle Pegel 0 dB und Space, Effekte und Lautstärke-Angleich aus sind.');
  }

  /* ---------- Zeichnen ---------- */
  const hauptZeichnen = () => {
    const x = a();
    const teil = neu ? neuHtml() : x.art === 'kh' ? khHtml(x) : lsHtml(x);
    d.querySelector('[data-haupt]').innerHTML = `${teil.tabs}<div class="lm-inhalt">${teil.inhalt}</div>`;
    d.querySelector('[data-fnav]').innerHTML = teil.nav;
    d.querySelector('[data-fusstext]').textContent = fussText(x);
    d.querySelector('[data-kopfsym]').innerHTML = symbolSvg(neu ? 'paar' : symVon(x), 20);
    d.querySelector('[data-nav]').innerHTML = navHtml();
    verbinden();
  };
  const zeichnen = () => {
    const fokusName = document.activeElement?.matches?.('[data-name]');
    if (!d.querySelector('.lm-rumpf')) {
      d.innerHTML = `
        <header class="lm-dkopf"><span class="lm-kopfsym" data-kopfsym></span><div class="lm-dkopf-tx"><h3 id="lm-titel">${t('Ausgänge &amp; Lautsprecher')}</h3><span>${h(kopfTx())}</span></div>
          <span class="lm-marke">${SVG_TREIBER}ASIO</span><button type="button" class="btn-ico" data-zu aria-label="${t('Schließen')}">${icon('zu')}</button></header>
        <div class="lm-rumpf"><nav class="lm-nav" data-nav aria-label="${t('Ausgänge')}"></nav><div class="lm-haupt" data-haupt></div></div>
        <footer class="lm-fuss"><span class="lm-fnav" data-fnav></span><span class="lm-fusstext" data-fusstext></span>
          <button type="button" class="lm-btn" data-abbrechen>${t('Abbrechen')}</button><button type="button" class="lm-btn haupt" data-uebernehmen>${t('Übernehmen')}</button></footer>`;
      d.querySelector('[data-zu]').addEventListener('click', () => schliessen(false));
      d.querySelector('[data-abbrechen]').addEventListener('click', () => schliessen(false));
      d.querySelector('[data-uebernehmen]').addEventListener('click', () => schliessen(true));
    }
    hauptZeichnen();
    if (fokusName) { const n = d.querySelector('[data-name]'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }
  };

  /* ---------- Live hören (Delay, Pegel, Kopfhörer-Klang) ---------- */
  let vorschauTimer = null;
  const vorschau = (ms = 120) => {
    clearTimeout(vorschauTimer);
    vorschauTimer = setTimeout(() => {
      const x = a();
      if (!x || !nativ.ausgangVorschau) return;
      nativ.ausgangVorschau(treiber, x.id, sauber(x), x.art === 'kh' && vgl === 'orig').catch(() => {});
    }, ms);
  };
  const sauber = (x) => { const { _mem, ...rest } = x; return { ...rest, name: (x.name || '').trim(), eq_reserve: x.art === 'kh' ? 0 : reserveVon(x, lsListe(x)) }; };
  const aendern = (f, nur = false) => { f(a()); geaendert = true; vorschau(); if (!nur) zeichnen(); };

  /* ---------- Testton (über die Engine, auf dem Interface-Ausgang) ---------- */
  const kanalVon = (key) => {
    const x = a();
    if (key === 'KL') return x.kh.karte[0];
    if (key === 'KR') return x.kh.karte[1];
    return kartenObj(x)[key];
  };
  async function tonEins(key) {
    const kanal = kanalVon(key);
    if (kanal == null) return true;
    ton = key; lsWahl = key.startsWith('K') ? lsWahl : key; zeichnen();
    const erg = await nativ.testton(treiber, kanal).catch(() => null);
    ton = null;
    if (d.isConnected) zeichnen();
    if (!erg?.ok) { toast(erg?.fehler || t('Testton geht nicht'), 'fehler'); return false; }
    return true;
  }
  async function testton(key) {
    if (ton) return;
    if (player?.spielt) { player.pausieren?.(); await new Promise((ok) => setTimeout(ok, 450)); }
    if (key === 'KLR') { if (await tonEins('KL')) await tonEins('KR'); return; }
    if (key === 'alle-reihum') { for (const l of lsListe(a())) { if (zu || !(await tonEins(l))) break; } return; }
    await tonEins(key);
  }

  /** − / + gedrückt halten wiederholt (Loslassen am Dokument – der Knopf wird beim Nachziehen neu gebaut) */
  const halten = (knopf, schritt1) => {
    knopf.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || knopf.disabled) return;
      e.preventDefault(); schritt1();
      let t2 = null;
      const t1 = setTimeout(() => { t2 = setInterval(schritt1, 70); }, 380);
      const ende = () => { clearTimeout(t1); clearInterval(t2); document.removeEventListener('pointerup', ende); document.removeEventListener('pointercancel', ende); };
      document.addEventListener('pointerup', ende); document.addEventListener('pointercancel', ende);
    });
    knopf.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); schritt1(); } });
  };

  /** Layout/Sub geändert: Kanalkarte nach Lautsprecher-Namen umbauen (ausgeblendete merken, neue auf freie Ausgänge) */
  const karteNeu = (x, altObj) => {
    Object.assign(x._mem, altObj);
    const ls = lsListe(x), z = zahl(), belegt = new Set();
    const karte = ls.map((l) => { const c = x._mem[l]; if (c != null && c < z && !belegt.has(c)) { belegt.add(c); return c; } return null; });
    for (let i = 0; i < ls.length; i++) {
      if (karte[i] != null) continue;
      let c = Math.max(-1, ...karte.filter((v) => v != null)) + 1;
      for (let n = 0; n < z && belegt.has(c % z); n++) c++;
      c %= Math.max(1, z);
      karte[i] = c; belegt.add(c); x._mem[ls[i]] = c;
    }
    x.karte = karte;
  };

  function verbinden() {
    const $$ = (s, f, ev = 'click') => d.querySelectorAll(s).forEach((b) => b.addEventListener(ev, (e) => f(b, e)));
    $$('[data-bus]', (b) => { neu = false; wahl = Number(b.dataset.bus); ton = null; zeichnen(); vorschau(); });
    $$('[data-neu]', () => { neu = true; zeichnen(); });
    $$('[data-zurueck-bus]', () => { neu = false; zeichnen(); });
    $$('[data-neuart]', (b) => {
      const art = b.dataset.neuart;
      // nächstes freies Paar (bzw. der Tipp aus den Treibernamen für Kopfhörer)
      const belegt = new Set(liste.flatMap((x) => (x.art === 'kh' ? x.kh.karte : x.karte)));
      const tipp = art === 'kh' ? kopfhoererTipp() : -1;
      let s = tipp >= 0 ? tipp : 0;
      if (tipp < 0) { while (belegt.has(s) || belegt.has(s + 1)) s += 2; if (s + 1 >= zahl()) s = 0; }
      const x = normal({ id: neueId(), name: '', symbol: 'auto', art, layout: 'stereo', sub: false, karte: [s, s + 1], fertig: false });
      x.kh.karte = [s, s + 1];
      liste.push(x);
      wahl = liste.length - 1; neu = false; geaendert = true;
      schritte.set(x.id, 'ausgang');
      zeichnen();
      d.querySelector('[data-name]')?.focus();
    });
    $$('[data-schritt]', (b) => { if (b.dataset.fertig) { a().fertig = true; geaendert = true; } schrittSetzen(b.dataset.schritt); zeichnen(); });
    $$('[data-kh]', (b) => { if (b.dataset.fertig) { a().fertig = true; geaendert = true; } schrittSetzen(b.dataset.kh); zeichnen(); });
    $$('[data-art]', (b) => aendern((x) => {
      const art = b.dataset.art;
      if (x.art === art) return;
      // Anschluss mitnehmen: Kopfhörer L/R ⇄ Lautsprecher L/R
      const k = kartenObj(x);
      if (art === 'kh') x.kh.karte = [k.L, k.R];
      else { const alt = { ...k, L: x.kh.karte[0], R: x.kh.karte[1] }; x.karte = lsListe(x).map((l) => alt[l]); }
      x.art = art;
      schritte.set(x.id, 'ausgang');
    }));
    $$('[data-symbol]', (b) => aendern((x) => { x.symbol = b.dataset.symbol; }));
    $$('[data-layout]', (b) => aendern((x) => { if (x.layout === b.dataset.layout) return; const alt = kartenObj(x); x.layout = b.dataset.layout; karteNeu(x, alt); }));
    $$('[data-sub]', () => aendern((x) => { const alt = kartenObj(x); x.sub = !x.sub; karteNeu(x, alt); }));
    $$('[data-name]', (b) => {
      a().name = b.value; geaendert = true;
      const z = d.querySelector(`[data-bus="${wahl}"] b`); if (z) z.textContent = ausgangName(a());
    }, 'input');
    $$('[data-eq]', async (b) => {
      const x = a(); lsWahl = b.dataset.eq;
      await eqFenster({ x, kanal: b.dataset.eq, ls: lsListe(x), kname: (k) => lsName(x.layout, k), geaendert: () => { geaendert = true; vorschau(40); } });
      zeichnen();
    });
    $$('[data-ton]', (b) => testton(b.dataset.ton));
    d.querySelectorAll('g[data-ton]').forEach((g) => g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); testton(g.dataset.ton); } }));
    $$('[data-zelle]', (b) => aendern((x) => {
      const [l, c] = b.dataset.zelle.split(','); const cn = Number(c);
      const ls = lsListe(x), i = ls.indexOf(l), j = x.karte.indexOf(cn);
      if (j >= 0 && j !== i) x.karte[j] = x.karte[i];   // tauschen: ein Ausgang je Lautsprecher
      x.karte[i] = cn; x._mem = { ...x._mem, ...kartenObj(x) };
      lsWahl = l;
    }));
    $$('[data-khz]', (b) => aendern((x) => {
      const [l, c] = b.dataset.khz.split(','); const i = l === 'L' ? 0 : 1, o = 1 - i, cn = Number(c);
      if (x.kh.karte[o] === cn) x.kh.karte[o] = x.kh.karte[i];
      x.kh.karte[i] = cn;
    }));
    $$('[data-khtausch]', () => aendern((x) => { x.kh.karte = [x.kh.karte[1], x.kh.karte[0]]; }));
    $$('[data-alle-k]', () => { alleK = !alleK; zeichnen(); });
    $$('[data-loeschen]', async () => {
      if (liste.length < 2) return;
      if (!await bestaetigen(t('Ausgang löschen?'), t('„{name}“ verschwindet aus der Geräteliste und der Schnellwahl.', { name: ausgangName(a()) }), t('Löschen'), true)) return;
      liste.splice(wahl, 1); wahl = Math.max(0, wahl - 1); geaendert = true; zeichnen();
    });
    // Abstand und Delay: halten wiederholt, Anzeige und Skizze ziehen live mit
    const live = () => { geaendert = true; vorschau(); hauptZeichnen(); };
    d.querySelectorAll('[data-dist]').forEach((b) => halten(b, () => {
      const x = a(), l = b.dataset.dist;
      x.dist[l] = Math.max(0.3, Math.min(15, IMP ? Math.round((Math.round(x.dist[l] / ZOLL) + Number(b.dataset.r)) * ZOLL * 10000) / 10000 : Math.round((x.dist[l] + 0.05 * Number(b.dataset.r)) * 100) / 100));
      lsWahl = l; live();
    }));
    d.querySelectorAll('[data-del]').forEach((b) => halten(b, () => {
      const x = a(), l = b.dataset.del;
      const st = x.einheit === 'm' ? 0.1 / SCHALL * 1000 : x.einheit === 'in' ? 0.1 * 0.0254 / SCHALL * 1000 : 0.1;
      x.delay_hand[l] = Math.round(Math.max(0, Math.min(30, delayVon(x, l) + st * Number(b.dataset.r))) * 1000) / 1000;
      lsWahl = l; live();
    }));
    $$('[data-auto]', (b) => aendern((x) => { delete x.delay_hand[b.dataset.auto]; }));
    $$('[data-einheit]', (b) => aendern((x) => { x.einheit = b.dataset.einheit; }));
    $$('[data-pegel]', (r) => {
      const x = a(), l = r.dataset.pegel;
      x.pegel[l] = Number(r.value); geaendert = true; lsWahl = l;
      r.style.setProperty('--wert', `${(x.pegel[l] + 12) / 18 * 100}%`);
      d.querySelector(`[data-pw="${l}"]`).textContent = `${x.pegel[l] > 0 ? '+' : ''}${de(x.pegel[l])}`;
      vorschau();
    }, 'input');
    $$('[data-pegel]', () => zeichnen(), 'change');
    $$('[data-phase]', (b) => aendern((x) => { x.phase = b.dataset.phase === '1'; }));
    $$('[data-trenn]', (b) => aendern((x) => { x.trenn = Math.max(50, Math.min(200, x.trenn + Number(b.dataset.trenn))); }));
    // Kopfhörer-Klang
    $$('[data-khcf]', (b) => aendern((x) => { x.kh.crossfeed = b.dataset.khcf; }));
    $$('[data-khbal]', (r) => {
      a().kh.balance = Number(r.value); geaendert = true; vorschau();
      r.style.setProperty('--wert', `${(a().kh.balance + 100) / 2}%`);
      d.querySelector('[data-khbw]').textContent = balText(a().kh.balance);
    }, 'input');
    $$('[data-khpeg]', (r) => {
      a().kh.pegel = Number(r.value); geaendert = true; vorschau();
      r.style.setProperty('--wert', `${(a().kh.pegel + 18) / 18 * 100}%`);
      d.querySelector('[data-khpw]').textContent = `${de(a().kh.pegel)} dB`;
    }, 'input');
    $$('[data-khbal], [data-khpeg]', () => zeichnen(), 'change');
    $$('[data-khvgl]', (b) => { vgl = b.dataset.khvgl; vorschau(); zeichnen(); });
    // Weichen-Kurve: klicken oder ziehen
    const kv = d.querySelector('[data-kurve]');
    if (kv) {
      const setzen = (e) => {
        const m = kv.getScreenCTM()?.inverse(); if (!m) return;
        const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
        const f = KURVE.fmin * Math.pow(KURVE.fmax / KURVE.fmin, p.x / KURVE.w);
        const n = Math.max(50, Math.min(200, Math.round(f / 10) * 10));
        if (n !== a().trenn) { a().trenn = n; geaendert = true; hauptZeichnen(); }
      };
      kv.addEventListener('pointerdown', (e) => {
        setzen(e);
        const mv = (ev) => setzen(ev);
        document.addEventListener('pointermove', mv);
        document.addEventListener('pointerup', () => document.removeEventListener('pointermove', mv), { once: true });
      });
      kv.addEventListener('keydown', (e) => {
        const r = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 10 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -10 : 0;
        if (!r) return;
        e.preventDefault(); a().trenn = Math.max(50, Math.min(200, a().trenn + r)); geaendert = true; hauptZeichnen(); d.querySelector('[data-kurve]')?.focus();
      });
    }
  }

  /* ---------- Schließen ---------- */
  const schliessen = async (uebernehmen) => {
    if (zu) return;
    if (uebernehmen) {
      const erg = await nativ.ausgaengeSetzen(treiber, liste.map((x) => ({ ...sauber(x), fertig: true }))).catch(() => null);
      if (!erg) { toast(t('Ausgänge nicht gespeichert'), 'fehler'); return; }
      toast(t('Ausgänge gespeichert'), 'gut');
      nachher?.(erg);
    } else {
      if (geaendert && !await bestaetigen(t('Änderungen verwerfen?'), t('Was du in diesem Fenster geändert hast, wird nicht gespeichert.'), t('Verwerfen'), true)) return;
      // Live-Vorschau zurück auf die gespeicherten Werte
      if (nativ.ausgangVorschau) for (const x of liste) nativ.ausgangVorschau(treiber, x.id, null).catch(() => {});
    }
    zu = true;
    d.classList.add('schliesst');
    setTimeout(() => { d.close(); d.remove(); }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200);
  };
  d.addEventListener('cancel', (e) => { e.preventDefault(); schliessen(false); });

  zeichnen();
  d.showModal();
  d.querySelector('[data-bus].an')?.focus();
  // echte Namen der Treiber-Ausgänge (lädt den Treiber kurz, wenn er nicht offen ist)
  nativ.asioKanaele?.(treiber).then((k) => {
    if (k?.namen?.length) { namen = k.namen; if (!zu) { d.querySelector('.lm-dkopf-tx span').textContent = kopfTx(); zeichnen(); } }
  }).catch(() => {});
}
