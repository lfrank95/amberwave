// Sprachen (Deutsch = Quellsprache, Englisch). Der deutsche Text ist der Schlüssel: t('Titel speichern').
// Platzhalter: t('{n} Titel', { n: 3 }); Einzahl/Mehrzahl: tn(3, 'ein Titel', '{n} Titel').
// Fehlt eine Übersetzung, erscheint der deutsche Text. Wörterbuch: /js/i18n_en.js (erzeugt aus i18n/quelle/*.json).
const meta = typeof document !== 'undefined' ? document.querySelector('meta[name="aw-sprache"]')?.content : '';
export const sprache = meta === 'en' ? 'en' : 'de';
const metaLoc = typeof document !== 'undefined' ? document.querySelector('meta[name="aw-locale"]')?.content : '';
export const locale = /^[a-z]{2}(-[A-Z]{2})?$/.test(metaLoc || '') ? metaLoc : (sprache === 'en' ? 'en-GB' : 'de-DE');
/** Region des Servers: Datums-/Zeitformat (dmy|mdy|ymd, 24|12), Währung, Land, Zeitzone */
export const region = (() => {
  try { return Object.assign({ zeitformat: '24', datumsformat: 'dmy', waehrung: 'EUR', land: '', zeitzone: '' }, JSON.parse(document.querySelector('meta[name="aw-region"]')?.content || '{}')); } catch { return { zeitformat: '24', datumsformat: 'dmy', waehrung: 'EUR', land: '', zeitzone: '' }; }
})();
/** Betrag in der Währung der Region */
export const preis = (v, waehrung = region.waehrung) => { try { return new Intl.NumberFormat(locale, { style: 'currency', currency: waehrung }).format(Number(v)); } catch { return `${zahl(v, 2)} ${waehrung}`; } };
let woerter = {};
if (sprache === 'en') {
  try { woerter = (await import('/js/i18n_en.js')).default || {}; } catch { woerter = {}; }
}
if (typeof document !== 'undefined') document.documentElement.lang = sprache;

export function t(de, p) {
  let s = sprache === 'de' ? de : (woerter[de] ?? de);
  if (p) for (const k in p) s = s.split(`{${k}}`).join(String(p[k]));
  return s;
}
/** Einzahl/Mehrzahl; {n} ist automatisch gesetzt */
export const tn = (n, eins, viele, p) => t(n === 1 ? eins : viele, { n: zahl(n), ...p });
/** Zahl nach Sprache (Tausendertrenner, Komma/Punkt) */
export const zahl = (v, nachkomma) => Number(v).toLocaleString(locale, nachkomma == null ? undefined : { minimumFractionDigits: nachkomma, maximumFractionDigits: nachkomma });
