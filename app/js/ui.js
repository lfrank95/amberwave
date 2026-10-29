// Kleine Helfer für die Oberfläche: Escaping, Formatierung, Symbole, Hinweise, Dialoge, Menüs.
import { t, locale, region } from './i18n.js';

/** HTML-Escaping für alle eingesetzten Texte */
export function h(wert) {
  return String(wert ?? '').replace(/[&<>"']/g, (z) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[z]));
}

/** Dauer in ms -> "4:18" bzw. "1:02:03" */
export function dauer(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  const st = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sek = s % 60;
  return st > 0 ? `${st}:${String(m).padStart(2, '0')}:${String(sek).padStart(2, '0')}` : `${m}:${String(sek).padStart(2, '0')}`;
}

/** Gesamtdauer lesbar: "42 Min." / "1 Std. 12 Min." */
export function dauerText(ms) {
  const min = Math.round((ms || 0) / 60000);
  if (min < 60) return t('{min} Min.', { min });
  return t('{std} Std. {min} Min.', { std: Math.floor(min / 60), min: min % 60 });
}

/** Deutsches Datum TT.MM.JJJJ */
/**
 * Datum immer als TT.MM.JJJJ. Unvollständige Angaben (MusicBrainz, Lebensdaten) ohne erfundenen Tag:
 * „1982-11“ → 11.1982, „1982“ → 1982.
 */
export function datum(iso) { return datumMit(iso); }
// Reihenfolge nach Region (dmy | mdy | ymd); Trenner: Punkt (Deutsch), Bindestrich (ymd), sonst Schrägstrich
function datumMit(iso) {
  if (!iso) return '–';
  const tz = region.datumsformat === 'ymd' ? '-' : locale.startsWith('de') ? '.' : '/';
  const bau = (j, m, tg) => {
    if (!tg) return m ? (region.datumsformat === 'ymd' ? `${j}${tz}${m}` : `${m}${tz}${j}`) : j;
    return region.datumsformat === 'mdy' ? `${m}${tz}${tg}${tz}${j}` : region.datumsformat === 'ymd' ? `${j}${tz}${m}${tz}${tg}` : `${tg}${tz}${m}${tz}${j}`;
  };
  const m = String(iso).match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
  if (m) return bau(m[1], m[2], m[3]);
  const d = new Date(iso);
  if (isNaN(d)) return '–';
  return bau(String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
}

/** Uhrzeit nach Region (24 Stunden oder 12 mit AM/PM) */
export function uhrzeit(d) {
  const h = d.getHours(), mi = String(d.getMinutes()).padStart(2, '0');
  if (region.zeitformat === '12') return `${h % 12 || 12}:${mi} ${h < 12 ? 'AM' : 'PM'}`;
  return `${String(h).padStart(2, '0')}:${mi}`;
}

export function datumZeit(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (isNaN(d)) return '–';
  return `${datum(iso)} ${uhrzeit(d)}`;
}

/** Datum aus MusicBrainz-Form "1982-11-30" / "1982" */
export function mbDatum(s) {
  return s ? datum(s) : '';
}

/** Für Eingabefelder: gespeichertes „1982-11-30“ als „30.11.1982“ anzeigen (der Server versteht beides) */
export function datumEingabe(s) {
  // Eingabefelder bleiben bei TT.MM.JJJJ (das versteht der Server), unabhängig von der Region
  const m = String(s || '').match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
  return m ? [m[3], m[2], m[1]].filter(Boolean).join('.') : (s || '');
}

export function groesse(bytes) {
  const e = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, w = bytes || 0;
  while (w >= 1024 && i < e.length - 1) { w /= 1024; i++; }
  return `${w.toLocaleString(locale, { maximumFractionDigits: i > 2 ? 1 : 0 })} ${e[i]}`;
}

export function zahl(n) {
  return Number(n || 0).toLocaleString(locale);
}

/** Künstler-Credit als Links: [{id, name, verbindung}] */
export function kuenstlerLinks(liste, klasse = '') {
  if (!liste || !liste.length) return `<span class="verb">${h(t('Unbekannter Künstler'))}</span>`;
  return liste.map((k) => `<a href="/kuenstler/${k.id}" data-link class="${klasse}">${h(k.name === '[unbekannt]' ? t('Unbekannter Künstler') : k.name)}</a>${k.verbindung ? `<span class="verb">${h(k.verbindung)}</span>` : ''}`).join('');
}

/** Künstler-Credit als reiner Text */
export function kuenstlerText(liste) {
  if (!liste || !liste.length) return t('Unbekannter Künstler');
  return liste.map((k) => (k.name === '[unbekannt]' ? t('Unbekannter Künstler') : k.name) + (k.verbindung || '')).join('');
}

export function initialen(name) {
  const t = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
  return ((t[0] || '?')[0] + (t.length > 1 ? t[t.length - 1][0] : '')).toUpperCase();
}

// ---------- Symbole (Strich-Icons, erben die Textfarbe) ----------
const pfade = {
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="3"/>',
  handy: '<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/>',
  computer: '<rect x="3" y="4" width="18" height="12" rx="1.8"/><path d="M8 20h8M12 16v4"/>',
  zurueck: '<path d="M19 5 9 12l10 7z" fill="currentColor" stroke="none"/><path d="M6 5v14" stroke-width="2.4"/>',
  weiter: '<path d="m5 5 10 7-10 7z" fill="currentColor" stroke="none"/><path d="M18 5v14" stroke-width="2.4"/>',
  zufall: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  wiederholen: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
  wiederholen1: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/><path d="M11 10h1.5v5" stroke-width="1.8"/>',
  herz: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  stopp: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  herzVoll: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" fill="currentColor"/>',
  mehr: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  suche: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  start: '<path d="M3 11 12 4l9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  alben: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
  kuenstler: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  playlists: '<path d="M4 6h12M4 12h12M4 18h7"/><path d="M19 15v6M16 18h6"/>',
  genres: '<path d="M4 5h7v7H4zM13 5h7v7h-7zM4 14h7v6H4zM13 14h7v6h-7z"/>',
  raster: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  gruppiert: '<circle cx="6" cy="6" r="2.5"/><path d="M11 6h9"/><rect x="4" y="12" width="5" height="5" rx="1"/><rect x="11" y="12" width="5" height="5" rx="1"/>',
  verwaltung: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 9l2 2 3-3M8 16h8M14 12h2"/>',
  einstellungen: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  warteschlange: '<path d="M4 6h16M4 12h10M4 18h10"/><path d="M18 14v6l3-3z" fill="currentColor"/>',
  lautstaerke: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
  stumm: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="m17 9 5 5M22 9l-5 5"/>',
  runter: '<path d="m6 9 6 6 6-6"/>',
  haken: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  schluessel: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>',
  schild: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.9 7.5-9.5V6z"/>',
  stift: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z"/>',
  warnung: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.01"/>',
  zurueckPfeil: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  rechts: '<path d="m9 6 6 6-6 6"/>',
  hoch: '<path d="m6 15 6-6 6 6"/>',
  zu: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  abmelden: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  profil: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  verlauf: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 3"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  nerd: '<path d="M3 20h18"/><path d="M4 16l4-7 3 4 4-9 5 12"/>',
  radio: '<circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19a10 10 0 0 1 0-14"/>',
  regler: '<path d="M6 4v16M12 4v16M18 4v16"/><path d="M3.5 14h5M9.5 8h5M15.5 16h5" stroke-width="2.6"/>',
  band: '<circle cx="7" cy="12" r="3.5"/><circle cx="17" cy="12" r="3.5"/><path d="M7 15.5h10M7 8.5h10M4 19h16"/>',
  roehre: '<path d="M9 3h6v2.5a3 3 0 0 1-6 0zM8 7h8v10a4 4 0 0 1-8 0zM10 21h4M12 17v4"/><path d="M10 11c.7 1 .7 2 0 3M14 11c-.7 1-.7 2 0 3"/>',
  surround: '<circle cx="12" cy="12" r="2.2"/><path d="M8 8a5.7 5.7 0 0 0 0 8M16 8a5.7 5.7 0 0 1 0 8M5 5a9.9 9.9 0 0 0 0 14M19 5a9.9 9.9 0 0 1 0 14"/>',
  messnadel: '<path d="M4 14.5a8 8 0 1 1 16 0"/><path d="M12 14.5l4-5"/><path d="M4 18h16" opacity=".5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  album: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
  naechstes: '<path d="M4 6h12M4 12h12M4 18h7"/><path d="m15 15 5 3-5 3z" fill="currentColor"/>',
  bearbeiten: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  muell: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  installieren: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M12 7v7M9 11.5l3 3 3-3"/>',
  haelfte: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16M8 10l2 2-2 2"/>',
  geraete: '<rect x="2" y="5" width="13" height="10" rx="1.5"/><path d="M6 19h5M8.5 15v4"/><rect x="17" y="8" width="5" height="11" rx="1.2"/>',
  anlage: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="8" cy="12" r="3"/><path d="M14 10h4M14 14h4"/>',
  tablet: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M11 18h2"/>',
  browser: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8.5h18"/>',
  holen: '<path d="M12 3v12M7 10l5 5 5-5M5 20h14"/>',
};

export function icon(name, groesse = 20, extra = '') {
  return `<svg viewBox="0 0 24 24" width="${groesse}" height="${groesse}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${pfade[name] || ''}</svg>`;
}

// ---------- Hinweise (Toasts) ----------
let toastBereich = null;
export function toast(text, art = 'info', ms = 3800) {
  if (!toastBereich) {
    toastBereich = document.createElement('div');
    toastBereich.className = 'toast-bereich';
    toastBereich.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastBereich);
  }
  const t = document.createElement('div');
  t.className = 'toast' + (art === 'fehler' ? ' fehler-toast' : art === 'gut' ? ' gut-toast' : '');
  if (art === 'fehler' || art === 'gut') t.innerHTML = `${icon(art === 'gut' ? 'haken' : 'warnung', 18)}<span>${h(text)}</span>`;
  else t.textContent = text;
  toastBereich.appendChild(t);
  setTimeout(() => { t.classList.add('raus'); setTimeout(() => t.remove(), 220); }, ms);
}

// ---------- Sanfte Oberflächen: Neu zeichnen ohne Sprünge, Aufklapper mit Bewegung ----------

/**
 * Inhalt von el auf neues HTML bringen, ohne die vorhandenen Knoten wegzuwerfen: gleiche Knoten bleiben, nur Attribute
 * und Texte ändern sich – so laufen CSS-Übergänge (Schalter, Stufen, Glühen), Fokus und Scrollposition bleiben erhalten.
 */
export function morph(el, html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  morphKinder(el, t.content);
}
function morphKinder(alt, neu) {
  const a = [...alt.childNodes], n = [...neu.childNodes];
  for (let i = 0; i < n.length; i++) {
    const x = a[i], y = n[i];
    if (!x) { alt.appendChild(y.cloneNode(true)); continue; }
    // Verschönerte Auswahl (auswahl.js packt <select> in eine Hülle): nur die Optionen des inneren <select> abgleichen
    if (x.nodeType === 1 && y.nodeName === 'SELECT' && x.classList.contains('auswahl')) {
      const sel = x.querySelector('select');
      if (sel && sel.innerHTML !== y.innerHTML) sel.innerHTML = y.innerHTML;
      continue;
    }
    if (x.nodeType !== y.nodeType || x.nodeName !== y.nodeName || (x.nodeType === 1 && x.id !== y.id)) { alt.replaceChild(y.cloneNode(true), x); continue; }
    if (x.nodeType === 3 || x.nodeType === 8) { if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue; continue; }
    morphAttribute(x, y);
    if (x.nodeName === 'INPUT') {
      if (x.type === 'checkbox') x.checked = y.hasAttribute('checked');
      else if (document.activeElement !== x && x.value !== (y.getAttribute('value') ?? '')) x.value = y.getAttribute('value') ?? '';
      continue;
    }
    if (x.nodeName === 'SELECT') { if (x.innerHTML !== y.innerHTML) x.innerHTML = y.innerHTML; continue; }
    morphKinder(x, y);
  }
  for (let i = a.length - 1; i >= n.length; i--) a[i].remove();
}
function morphAttribute(x, y) {
  for (const { name } of [...x.attributes]) {
    if (name === 'open' && x.nodeName === 'DETAILS') continue; // Aufklapp-Zustand gehört dem Nutzer (und der Animation)
    if (!y.hasAttribute(name)) x.removeAttribute(name);
  }
  for (const { name, value } of [...y.attributes]) {
    if (name === 'open' && x.nodeName === 'DETAILS') continue;
    if (x.getAttribute(name) !== value) x.setAttribute(name, value);
  }
}

/** Ereignis anhängen und ein früher über bind angehängtes gleichen Typs ersetzen (für Knoten, die morph() stehen lässt) */
export function bind(el, typ, fn) {
  if (!el) return;
  const k = `__aw_${typ}`;
  if (el[k]) el.removeEventListener(typ, el[k]);
  el[k] = fn;
  el.addEventListener(typ, fn);
}

/** <details> unter wurzel weich auf- und zuklappen (Höhe und Inhalt gleiten). Einmal je Element. */
export function detailsAnimieren(wurzel) {
  wurzel.querySelectorAll('details').forEach((d) => {
    if (d.__awAnim) return;
    d.__awAnim = true;
    const summary = d.querySelector(':scope > summary');
    if (!summary) return;
    summary.addEventListener('click', (e) => {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      e.preventDefault();
      d.__laeuft?.cancel();
      const zu = summary.offsetHeight;
      const start = d.offsetHeight;
      d.style.overflow = 'hidden';
      if (!d.open) {
        d.open = true;
        const ziel = d.scrollHeight;
        d.classList.add('klappt-auf');
        d.__laeuft = d.animate({ height: [`${start}px`, `${ziel}px`] }, { duration: 280, easing: 'cubic-bezier(.2,.9,.25,1)' });
      } else {
        d.classList.add('klappt-zu');
        d.__laeuft = d.animate({ height: [`${start}px`, `${zu + (parseFloat(getComputedStyle(d).paddingTop) || 0)}px`] }, { duration: 200, easing: 'cubic-bezier(.4,0,.6,1)' });
      }
      const oeffnend = !d.classList.contains('klappt-zu');
      d.__laeuft.onfinish = () => {
        if (!oeffnend) d.open = false;
        d.style.overflow = '';
        d.classList.remove('klappt-auf', 'klappt-zu');
        d.__laeuft = null;
      };
      d.__laeuft.oncancel = () => { d.style.overflow = ''; d.classList.remove('klappt-auf', 'klappt-zu'); };
    });
  });
}

// ---------- Dialoge ----------
/**
 * Dialog öffnen. inhalt = HTML. knoepfe = [{text, wert, art: 'haupt'|'zweit'|'gefahr'}]
 * Liefert ein Promise mit {wert, form} (form = FormData des Dialogs) oder null bei Abbruch.
 */
export function dialog({ titel, inhalt, knoepfe = [{ text: 'OK', wert: 'ok', art: 'haupt' }], breit = false, beimOeffnen = null }) {
  return new Promise((fertig) => {
    const d = document.createElement('dialog');
    d.className = 'dialog';
    if (breit) d.style.width = 'min(760px, calc(100vw - 24px))';
    d.innerHTML = `<form method="dialog">
      <div class="dialog-kopf"><h3>${h(titel)}</h3><button type="button" class="btn-ico" data-zu aria-label="${h(t('Schließen'))}">${icon('zu')}</button></div>
      <div class="dialog-inhalt">${inhalt}</div>
      <div class="dialog-fuss">${knoepfe.map((k) => `<button type="submit" value="${h(k.wert)}" class="btn ${k.art === 'zweit' ? 'btn-zweit' : k.art === 'gefahr' ? 'btn-gefahr' : ''}">${h(k.text)}</button>`).join('')}</div>
    </form>`;
    document.body.appendChild(d);
    const form = d.querySelector('form');
    let ergebnis = null;
    d.querySelector('[data-zu]').addEventListener('click', () => d.close());
    // Sanft ausblenden, bevor der Dialog wirklich schließt (Knopf, Esc, d.close())
    const echtZu = d.close.bind(d);
    let schliesst = false;
    const sanftZu = (rv) => {
      if (schliesst || !d.open) return;
      schliesst = true;
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) { echtZu(rv); return; }
      d.classList.add('schliesst');
      let fertigZu = false;
      const ende = () => { if (!fertigZu) { fertigZu = true; echtZu(rv); } };
      d.addEventListener('animationend', (ev) => { if (ev.target === d) ende(); });
      setTimeout(ende, 300);
    };
    d.close = sanftZu;
    d.addEventListener('cancel', (e) => { e.preventDefault(); sanftZu(); });
    form.addEventListener('submit', (e) => {
      const wert = e.submitter?.value || 'ok';
      if (wert !== 'abbrechen' && !form.reportValidity()) { e.preventDefault(); return; }
      ergebnis = wert === 'abbrechen' ? null : { wert, form: new FormData(form), element: d };
      e.preventDefault();
      sanftZu(wert);
    });
    // Enter bestätigt immer: löst den Hauptknopf aus, egal wo der Fokus steht (auch auf „Abbrechen“ oder dem X).
    // Ausnahmen: Textfelder mit mehreren Zeilen und Bedienelemente im Inhalt, die Enter selbst brauchen.
    const rang = (k) => (k.art === 'zweit' ? 0 : k.art === 'gefahr' ? 1 : 2);
    let hauptIdx = 0;
    knoepfe.forEach((k, i) => { if (rang(k) >= rang(knoepfe[hauptIdx])) hauptIdx = i; });
    const hauptKnopf = d.querySelectorAll('.dialog-fuss button')[hauptIdx];
    hauptKnopf?.setAttribute('data-haupt', '');
    d.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.repeat || e.isComposing || e.defaultPrevented || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      const t = e.target;
      if (!(t instanceof Element) || t.closest('dialog') !== d) return;
      if (t.closest('textarea, [contenteditable]:not([contenteditable="false"])')) return;
      if (t.closest('.dialog-inhalt') && t.closest('button, a[href], summary, [role="button"], [role="option"], [role="listbox"], [tabindex]:not(input):not(select)')) return;
      if (!hauptKnopf || hauptKnopf.disabled) return;
      e.preventDefault();
      form.requestSubmit(hauptKnopf);
    });
    d.addEventListener('close', () => { d.remove(); fertig(ergebnis); });
    d.showModal();
    if (beimOeffnen) beimOeffnen(d);
    const erstes = d.querySelector('input:not([type=hidden]), select, textarea');
    if (erstes) erstes.focus();
  });
}

export async function bestaetigen(titel, text, ja = t('Ja'), gefahr = false) {
  const r = await dialog({ titel, inhalt: `<p>${h(text)}</p>`, knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: ja, wert: 'ja', art: gefahr ? 'gefahr' : 'haupt' }] });
  return !!r;
}

// ---------- Aufklapp-Menü ----------
let offenesMenue = null;
export function menueSchliessen() {
  if (offenesMenue) {
    const m = offenesMenue;
    offenesMenue = null;
    m.classList.add('raus');
    setTimeout(() => m.remove(), 140);
  }
}
/** eintraege = [{text, icon, aktion: () => {}, rot, trenner, titel}] an einem Element; mit svg/unter/an zweizeilig zum Auswählen */
export function menue(anker, eintraege) {
  menueSchliessen();
  const m = document.createElement('div');
  m.className = 'menue';
  m.setAttribute('role', 'menu');
  m.innerHTML = eintraege.map((e, i) => e.trenner ? '<hr>' : e.titel ? `<div class="menue-titel">${h(e.titel)}</div>`
    : e.svg || e.unter ? `<button type="button" role="menuitemradio" aria-checked="${!!e.an}" data-i="${i}" class="menue-zwei${e.an ? ' an' : ''}">${e.svg ? `<span class="menue-sym">${e.svg}</span>` : ''}<span class="menue-tx"><b>${h(e.text)}</b>${e.unter ? `<small>${h(e.unter)}</small>` : ''}</span>${e.an ? icon('haken', 16) : ''}</button>`
    : `<button type="button" role="menuitem" data-i="${i}" class="${e.rot ? 'rot' : ''}">${e.icon ? icon(e.icon, 18) : ''}${h(e.text)}</button>`).join('');
  // In einem offenen Dialog muss das Menü im Dialog liegen, sonst ist es nicht anklickbar (alles außerhalb ist dann gesperrt)
  (anker.closest('dialog') || document.body).appendChild(m);
  m.style.position = 'fixed';
  m.style.maxHeight = 'calc(100vh - 16px)';
  m.style.overflowY = 'auto';
  const r = anker.getBoundingClientRect();
  const b = m.offsetWidth, hh = Math.min(m.offsetHeight, window.innerHeight - 16);
  const x = Math.min(window.innerWidth - b - 8, Math.max(8, r.right - b));
  let y = r.bottom + 6;
  if (y + hh > window.innerHeight - 8) { y = Math.max(8, r.top - hh - 6); m.classList.add('oben'); }
  m.style.left = `${x}px`;
  m.style.top = `${y}px`;
  m.addEventListener('click', (e) => {
    const k = e.target.closest('button[data-i]');
    if (!k) return;
    const eintrag = eintraege[Number(k.dataset.i)];
    menueSchliessen();
    eintrag.aktion?.();
  });
  offenesMenue = m;
  m.querySelector('button')?.focus({ preventScroll: true });
}
document.addEventListener('click', (e) => {
  if (offenesMenue && !offenesMenue.contains(e.target) && !e.target.closest('[data-menue-anker]')) menueSchliessen();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menueSchliessen(); });
window.addEventListener('resize', menueSchliessen);
window.addEventListener('scroll', menueSchliessen, { passive: true });

/** Cover-Bild oder Platzhalter mit Titel */
export function coverHtml(url, titel, klasse = '') {
  return url
    ? `<img src="${h(url)}" alt="" loading="lazy" decoding="async" class="${klasse}">`
    : `<span class="platzhalter">${h(titel || '')}</span>`;
}
