// Übersetzung im Hauptprozess des Windows Clients (Deutsch ist der Schlüssel, Englisch steht in i18n_en.json).
// Einstellung `einst.sprache`: 'de' | 'en' | 'auto' (auto: Windows-Sprache beginnt mit „en“ → Englisch, sonst Deutsch).
// t('Text {x}', { x: 1 })  – feste Texte; tm(text) – Texte der Engine/des VST-Hosts (dürfen Zahlen/Namen enthalten,
// im Wörterbuch als Muster mit {platzhalter}); fehlt ein Eintrag, bleibt der deutsche Text stehen.
const fs = require('fs');
const path = require('path');

let WB = {};
try { WB = JSON.parse(fs.readFileSync(path.join(__dirname, 'i18n_en.json'), 'utf8')); } catch (e) { /* ohne Wörterbuch: Deutsch */ }

let gespeichert = () => 'auto';   // () => 'de' | 'en' | 'auto'
let systemSprache = () => '';     // () => z. B. 'en-US'
let gemerkt = null;

function init(opts = {}) {
  if (opts.gespeichert) gespeichert = opts.gespeichert;
  if (opts.system) systemSprache = opts.system;
  gemerkt = null;
}
/** Eingestellter Wert ('de'|'en'|'auto') */
function einstellung() { const s = gespeichert(); return s === 'de' || s === 'en' ? s : 'auto'; }
/** Wirksame Sprache: 'de' oder 'en' */
function sprache() {
  if (gemerkt) return gemerkt;
  const e = einstellung();
  if (e !== 'auto') return (gemerkt = e);
  let l = '';
  try { l = String(systemSprache() || ''); } catch (x) { /* vor app.ready */ }
  return (gemerkt = /^en/i.test(l) ? 'en' : 'de');
}
/** Nach Änderung der Einstellung aufrufen */
function neuBestimmen() { gemerkt = null; return sprache(); }
const locale = () => (sprache() === 'en' ? 'en-GB' : 'de');

function fuellen(text, p) {
  if (!p) return text;
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m));
}
function t(de, p) {
  const s = sprache() === 'en' && Object.prototype.hasOwnProperty.call(WB, de) ? WB[de] : de;
  return fuellen(s, p);
}

// Muster aus dem Wörterbuch (Schlüssel mit {platzhalter}) für tm()
let muster = null;
function musterBauen() {
  muster = [];
  for (const [de, en] of Object.entries(WB)) {
    if (!/\{\w+\}/.test(de)) continue;
    const namen = [];
    const re = '^' + de.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, (m, k) => { namen.push(k); return '(.+?)'; }) + '$';
    muster.push({ re: new RegExp(re, 's'), namen, en });
  }
}
/** Text aus Engine/Host übersetzen (exakt oder per Muster; Platzhalter-Inhalte werden selbst noch einmal übersetzt) */
function tm(text, tiefe = 0) {
  if (typeof text !== 'string' || !text || sprache() !== 'en') return text;
  if (Object.prototype.hasOwnProperty.call(WB, text)) return WB[text];
  if (!muster) musterBauen();
  if (tiefe > 2) return text;
  for (const m of muster) {
    const r = m.re.exec(text);
    if (!r) continue;
    const p = {};
    m.namen.forEach((k, i) => { p[k] = tm(r[i + 1], tiefe + 1); });
    return fuellen(m.en, p);
  }
  return text;
}
/** Meldung (Objekt) der Engine/des Hosts: sichtbare Textfelder übersetzen */
function tmMeldung(m) {
  if (!m || typeof m !== 'object' || sprache() !== 'en') return m;
  const o = { ...m };
  for (const k of ['text', 'fehler', 'hinweis']) if (typeof o[k] === 'string') o[k] = tm(o[k]);
  return o;
}

/** Wörterbuch für die lokale Einrichtungsseite (nur Englisch nötig) */
const woerterbuch = () => (sprache() === 'en' ? WB : {});

module.exports = { woerterbuch, init, t, tm, tmMeldung, sprache, einstellung, neuBestimmen, locale };
