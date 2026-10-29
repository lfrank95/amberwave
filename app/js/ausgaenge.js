// ASIO-Ausgänge (Busse) im Windows Client: Layouts, Symbole, Namen und die Raumskizze. Gespeichert werden die Ausgänge
// im Client (je Treiber); hier steht nur, wie man sie zeigt. Kanalfolge wie in der Engine: Stereo L R, Quadro L R Ls Rs,
// 5.1 L R C LFE Ls Rs.
import { h } from './ui.js';
import { t } from './i18n.js';

export const LAYOUTS = {
  stereo: { name: t('Stereo'), kurz: t('Stereo'), sub: '2.1', ls: ['L', 'R'] },
  quadro: { name: t('Quadro'), kurz: t('Quadro'), sub: '4.1', ls: ['L', 'R', 'Ls', 'Rs'] },
  51: { name: t('5.1 Surround'), kurz: '5.1', sub: '5.1', ls: ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'] },
};
export const LS_NAME = { L: t('Links'), R: t('Rechts'), C: t('Center'), LFE: t('Subwoofer (LFE)'), Ls: t('Surround links'), Rs: t('Surround rechts') };
/** Lautsprecher eines Ausgangs in Engine-Reihenfolge – mit separatem Sub (2.1/4.1) kommt LFE hinten dazu */
export const lsVon = (a) => { if (a?.art === 'kh') return ['L', 'R']; const ls = (LAYOUTS[a?.layout] || LAYOUTS.stereo).ls; return a?.sub && a.layout !== '51' ? [...ls, 'LFE'] : ls; };
export const lsName = (layout, k) => (layout === 'quadro' && k === 'Ls' ? t('Hinten links') : layout === 'quadro' && k === 'Rs' ? t('Hinten rechts') : LS_NAME[k] || k);

const ICONS = {
  paar: '<rect x="2.5" y="5" width="7" height="14" rx="1.6"/><circle cx="6" cy="14.5" r="2.2"/><circle cx="6" cy="8.5" r="1"/><rect x="14.5" y="5" width="7" height="14" rx="1.6"/><circle cx="18" cy="14.5" r="2.2"/><circle cx="18" cy="8.5" r="1"/>',
  monitore: '<path d="M3 6.5 9 5v14l-6-1.5z"/><circle cx="6" cy="14" r="1.8"/><circle cx="6" cy="9" r=".9"/><path d="M21 6.5 15 5v14l6-1.5z"/><circle cx="18" cy="14" r="1.8"/><circle cx="18" cy="9" r=".9"/>',
  sub: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="13" r="5"/><circle cx="12" cy="13" r="1.5"/><circle cx="12" cy="6" r=".8"/>',
  kopfhoerer: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="2.5" y="14" width="5" height="7" rx="1.8"/><rect x="16.5" y="14" width="5" height="7" rx="1.8"/>',
  quadro: '<circle cx="12" cy="12" r="1.8"/><rect x="2.5" y="2.5" width="5" height="6" rx="1.2"/><rect x="16.5" y="2.5" width="5" height="6" rx="1.2"/><rect x="2.5" y="15.5" width="5" height="6" rx="1.2"/><rect x="16.5" y="15.5" width="5" height="6" rx="1.2"/>',
  surround: '<circle cx="12" cy="14" r="1.8"/><rect x="2" y="5" width="4.5" height="5.5" rx="1.1"/><rect x="9.75" y="2" width="4.5" height="5" rx="1.1"/><rect x="17.5" y="5" width="4.5" height="5.5" rx="1.1"/><rect x="2" y="16" width="4.5" height="5.5" rx="1.1"/><rect x="17.5" y="16" width="4.5" height="5.5" rx="1.1"/>',
  sofa: '<path d="M4 11V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3"/><path d="M2.5 12.5a1.5 1.5 0 0 1 3 0V15h13v-2.5a1.5 1.5 0 0 1 3 0V18h-19z"/><path d="M5 18v2M19 18v2"/>',
};
export const SYMBOLE = [['auto', t('Automatisch')], ['paar', t('Lautsprecher')], ['monitore', t('Monitore')], ['kopfhoerer', t('Kopfhörer')], ['quadro', t('Quadro')], ['surround', t('Surround')], ['sofa', t('Wohnzimmer')]];
const AUTO_SYMBOL = { stereo: 'paar', quadro: 'quadro', 51: 'surround' };
export const symbolVon = (a) => (a?.symbol && a.symbol !== 'auto' && ICONS[a.symbol] ? a.symbol : a?.art === 'kh' ? 'kopfhoerer' : a?.sub && a?.layout === 'stereo' ? 'sub' : AUTO_SYMBOL[a?.layout] || 'paar');
export const symbolSvg = (name, groesse = 24, klasse = '') => `<svg class="${klasse}" width="${groesse}" height="${groesse}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.paar}</svg>`;

/** Layout-Kurzname, mit separatem Sub 2.1/4.1 */
export const layoutKurz = (a) => (a?.art === 'kh' ? t('Kopfhörer') : (a?.sub ? LAYOUTS[a.layout]?.sub : LAYOUTS[a?.layout]?.kurz) || t('Stereo'));
/** Name des Ausgangs: selbst vergeben oder automatisch („5.1-Lautsprecher“, „Kopfhörer“) */
export const autoName = (a) => (a?.art === 'kh' ? t('Kopfhörer') : t('{layout}-Lautsprecher', { layout: layoutKurz(a) }));
export const ausgangName = (a) => (a?.name || '').trim() || autoName(a);
/** „Kanal 1/2“, „Kanal 1–6“ oder „Kanal 1, 2, 7, 8“ (Ausgänge am Interface, ab 1) */
export function kanaeleText(karte) {
  const k = (karte || []).map((x) => x + 1);
  if (!k.length) return '';
  if (k.length === 2) return t('Kanal {a}/{b}', { a: k[0], b: k[1] });
  const folge = k.every((x, i) => i === 0 || x === k[i - 1] + 1);
  return folge ? t('Kanal {a}–{b}', { a: k[0], b: k[k.length - 1] }) : t('Kanäle {liste}', { liste: k.join(', ') });
}
export const ausgangUnter = (a) => `${layoutKurz(a)} · ${kanaeleText(a?.art === 'kh' ? a.kh?.karte : a?.karte)}`;

/** ASIO-Treiber eines Geräts („asio:{…}#bus“ → „asio:{…}“) */
export const treiberVon = (id) => String(id || '').split('#')[0];

/**
 * Raumskizze von oben: Hörer in der Mitte, Lautsprecher im Kreis. nummern = {L: 1, …} schreibt die Interface-Ausgänge
 * dazu, aus = grau (Layout nicht wählbar), gross = für die Seitenleiste
 */
const WINKEL = { L: -30, R: 30, C: 0, Ls: -110, Rs: 110 };
const WINKEL_QUADRO = { Ls: -135, Rs: 135 };
export function raumSvg(layout, { sub = false, w = 150, h: hoehe = 118, nummern = null, aus = false, gross = false, label = '' } = {}) {
  const cx = w / 2, cy = hoehe * 0.6, r = Math.min(w, hoehe) * 0.38;
  const s = gross ? 1.35 : 1;
  const farbe = aus ? 'var(--aus-raum-aus, #8f8274)' : 'var(--aus-raum-ls, #ffb547)';
  const text = aus ? 'var(--aus-raum-text-aus, #bcae9f)' : 'var(--aus-raum-text, #f6efe7)';
  const f = (x) => Math.round(x * 10) / 10;
  const teile = [`<svg class="aus-raum" width="${w}" height="${hoehe}" viewBox="0 0 ${w} ${hoehe}" role="img" aria-label="${h(label || (sub ? t('Lautsprecher-Anordnung {layout} mit Subwoofer', { layout: LAYOUTS[layout]?.name || '' }) : t('Lautsprecher-Anordnung {layout}', { layout: LAYOUTS[layout]?.name || '' })))}">`,
    `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="none" stroke="currentColor" stroke-opacity=".12" stroke-dasharray="3 5"/>`,
    `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r * 0.13)}" fill="var(--aus-raum-hoerer, #3a2a1d)" stroke="currentColor" stroke-opacity=".35"/>`,
    `<path d="M${f(cx - r * 0.05)} ${f(cy - r * 0.12)} L${f(cx)} ${f(cy - r * 0.2)} L${f(cx + r * 0.05)} ${f(cy - r * 0.12)}" fill="none" stroke="currentColor" stroke-opacity=".5" stroke-width="1.5"/>`];
  const ls = (LAYOUTS[layout] || LAYOUTS.stereo).ls.filter((k) => k !== 'LFE');
  for (const k of ls) {
    const wk = (layout === 'quadro' && WINKEL_QUADRO[k]) || WINKEL[k];
    const a = wk * Math.PI / 180, x = cx + r * Math.sin(a), y = cy - r * Math.cos(a);
    teile.push(`<g transform="translate(${f(x)} ${f(y)}) rotate(${wk})"><rect x="${f(-9 * s)}" y="${f(-11 * s)}" width="${f(18 * s)}" height="${f(22 * s)}" rx="${f(4 * s)}" fill="var(--aus-raum-box, #2a1e15)" stroke="${farbe}" stroke-width="1.6"/><circle cx="0" cy="${f(3 * s)}" r="${f(4.5 * s)}" fill="none" stroke="${farbe}" stroke-width="1.4"/></g>`);
    const ty = Math.abs(wk) <= 30 ? y - 16 * s : y + 24 * s;
    teile.push(`<text x="${f(x)}" y="${f(ty)}" text-anchor="middle" font-size="${Math.round(11 * s)}" font-weight="700" fill="${text}">${k}${nummern && nummern[k] != null ? ` · ${nummern[k]}` : ''}</text>`);
  }
  if (sub || layout === '51') {
    // Subwoofer vorne links außerhalb des Kreises, Beschriftung darunter (rechts wäre zu eng neben R)
    const x = cx - r * (gross ? 1.08 : 1.25), y = cy - r * 0.92;
    teile.push(`<g transform="translate(${f(x)} ${f(y)})"><rect x="${f(-12 * s)}" y="${f(-12 * s)}" width="${f(24 * s)}" height="${f(24 * s)}" rx="${f(4 * s)}" fill="var(--aus-raum-box, #2a1e15)" stroke="${farbe}" stroke-width="1.6"${sub && layout !== '51' ? ' stroke-dasharray="3 3"' : ''}/><circle cx="0" cy="0" r="${f(7 * s)}" fill="none" stroke="${farbe}" stroke-width="1.4"/></g>`);
    teile.push(`<text x="${f(x)}" y="${f(y + 26 * s)}" text-anchor="middle" font-size="${Math.round(11 * s)}" font-weight="700" fill="${text}">LFE${nummern && nummern.LFE != null ? ` · ${nummern.LFE}` : ''}</text>`);
  }
  teile.push('</svg>');
  return teile.join('');
}
