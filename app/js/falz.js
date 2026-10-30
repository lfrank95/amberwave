// Faltgeräte: erkennen, ob „zwei Hälften“ gelten, und offenlegen, was der Browser über Falz und Haltung meldet.
//
// Quellen (sofern der Browser sie kennt):
//  - Viewport Segments (Chrome/Edge ≥ 138): (horizontal-viewport-segments: 2) = Falz senkrecht, halb aufgeklappt wie ein Buch;
//    (vertical-viewport-segments: 2) = Falz waagerecht, aufgestellt wie ein Laptop. Ganz flach meldet ein Fold meist nur 1 Segment.
//  - Device Posture: navigator.devicePosture.type = "continuous" | "folded"
//  - Schätzung: Touch-Gerät, 600–1023 px breit, fast quadratisch (aufgeklapptes Fold, auch flach)
// Ergebnis als Klassen auf <html>: zwei-haelften (Layout), falz-buch / falz-tisch (Haltung, nur wenn gemeldet).

import { t } from './i18n.js';
import { android, androidFalz } from './android.js';

const mq = (q) => { try { return matchMedia(q).matches; } catch { return false; } };

export function falzWahl() {
  try { return localStorage.getItem('aw_haelften') || ''; } catch { return ''; }
}

export function falzWahlSetzen(w) {
  try { if (w) localStorage.setItem('aw_haelften', w); else localStorage.removeItem('aw_haelften'); } catch { /* egal */ }
  haelftenPruefen();
}

export function falzStatus() {
  const w = window.innerWidth;
  const hh = window.innerHeight;
  const v = w / Math.max(1, hh);
  // Android-App: Falz und Haltung meldet die App (wie der Browser: zwei Segmente nur halb aufgeklappt)
  const af = android ? androidFalz() : null;
  const halb = af?.zustand === 'halb';
  const segmenteApi = !!af || ('viewport' in window && window.viewport && 'segments' in window.viewport);
  const roh = af ? (halb ? af.segmente : [{ x: 0, y: 0, width: w, height: hh }]) : segmenteApi ? (window.viewport.segments || []) : null;
  const segmente = roh ? roh.map((s) => ({ x: Math.round(s.x), y: Math.round(s.y), b: Math.round(s.width), h: Math.round(s.height) })) : null;
  const buch = af ? halb && af.richtung === 'senkrecht' : mq('(horizontal-viewport-segments: 2)');
  const tisch = af ? halb && af.richtung === 'waagerecht' : mq('(vertical-viewport-segments: 2)');
  const mqBekannt = !!af || buch || tisch || mq('(horizontal-viewport-segments: 1)');
  const haltung = af ? (halb ? 'folded' : 'continuous') : navigator.devicePosture?.type || null;
  const touch = mq('(pointer: coarse)');
  const schaetzung = touch && w >= 600 && w <= 1023 && v >= 0.7 && v <= 1.45;
  const chrome = (navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1];
  const samsung = /SamsungBrowser\/(\d+)/.exec(navigator.userAgent)?.[1];
  const pwa = mq('(display-mode: standalone)') || mq('(display-mode: fullscreen)') || mq('(display-mode: window-controls-overlay)');
  return { w, hh, segmenteApi, segmente, buch, tisch, mqBekannt, haltung, touch, schaetzung, chrome, samsung, pwa, wahl: falzWahl() };
}

export function haelftenPruefen() {
  const s = falzStatus();
  const html = document.documentElement;
  // Tisch-Haltung (Falz waagerecht): oben/unten statt links/rechts – dann keine zwei Spalten
  const gefaltet = s.haltung === 'folded' && s.w / Math.max(1, s.hh) >= 0.7 && s.w / Math.max(1, s.hh) <= 1.45;   // Device Posture als Ersatz
  // Aufgestellt wie ein Laptop: links/rechts ergibt keinen Sinn – gilt auch, wenn „Immer“ gewählt ist
  // „Immer“ nur, wenn zwei Hälften überhaupt Platz haben – zugeklappt (Außendisplay) bleibt es einspaltig
  const zwei = !s.tisch && ((s.wahl === 'an' && s.w >= 600) || (s.wahl !== 'aus' && (s.buch || gefaltet || s.schaetzung)));
  html.classList.toggle('zwei-haelften', zwei);
  html.classList.toggle('falz-buch', s.buch);
  html.classList.toggle('falz-tisch', s.tisch);
  if (s.segmente?.length === 2) {
    const [a, b] = s.segmente;
    // Lage der Falz für CSS (Breite/Höhe des Spalts, Position)
    if (s.buch) { html.style.setProperty('--falz-x', `${a.x + a.b}px`); html.style.setProperty('--falz-breite', `${Math.max(0, b.x - (a.x + a.b))}px`); }
    if (s.tisch) { html.style.setProperty('--falz-y', `${a.y + a.h}px`); html.style.setProperty('--falz-hoehe', `${Math.max(0, b.y - (a.y + a.h))}px`); }
  }
  window.dispatchEvent(new CustomEvent('aw-falz', { detail: s }));
  return s;
}

/** Auf alles hören, was die Haltung ändern kann – Aufklappen ändert nicht immer die Fenstergröße */
export function falzBeobachten() {
  haelftenPruefen();
  const neu = () => haelftenPruefen();
  window.addEventListener('resize', neu);
  window.addEventListener('orientationchange', neu);
  for (const q of ['(horizontal-viewport-segments: 2)', '(vertical-viewport-segments: 2)', '(pointer: coarse)']) {
    try { matchMedia(q).addEventListener('change', neu); } catch { /* ältere Browser */ }
  }
  try { navigator.devicePosture?.addEventListener('change', neu); } catch { /* egal */ }
  try { window.viewport?.addEventListener?.('segmentschange', neu); } catch { /* egal */ }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) neu(); });
  window.addEventListener('aw-android-falz', neu);
}

/** Lesbare Zeilen für die Einstellungen */
export function falzBericht(s = falzStatus()) {
  const ja = (x) => (x ? t('ja') : t('nein'));
  const browser = s.samsung ? `Samsung Internet ${s.samsung}` : s.chrome ? `Chrome ${s.chrome}` : t('unbekannt');
  return [
    [t('Browser'), android ? `${t('Android-App')} · WebView ${s.chrome || '?'}` : `${browser}${s.pwa ? ` · ${t('als App installiert')}` : ` · ${t('im Browser-Tab')}`}`],
    [t('Fenster'), `${s.w} × ${s.hh} px${s.touch ? ` · ${t('Touch')}` : ''}`],
    [t('Falz-Schnittstelle'), s.segmenteApi || s.mqBekannt ? t('vorhanden') : t('fehlt in diesem Browser')],
    [t('Segmente'), s.segmente ? (s.segmente.length > 1 ? s.segmente.map((x) => `${x.b}×${x.h} @${x.x},${x.y}`).join('  |  ') : t('1 (flach oder nicht gemeldet)')) : '–'],
    [t('Halb geklappt wie ein Buch'), ja(s.buch)],
    [t('Aufgestellt wie ein Laptop'), ja(s.tisch)],
    [t('Haltung (Device Posture)'), s.haltung || t('nicht unterstützt')],
    [t('Schätzung „aufgeklapptes Fold“'), ja(s.schaetzung)],
    [t('Zwei Hälften aktiv'), `${ja(document.documentElement.classList.contains('zwei-haelften'))}${s.wahl ? ` (${t('erzwungen: {wahl}', { wahl: s.wahl })})` : ` (${t('automatisch')})`}`],
  ];
}
