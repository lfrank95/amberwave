// Schwebende Anzeige „Einlesen läuft im Hintergrund“ – erscheint nur, wenn der Einrichtungs-Assistent sie angestoßen hat
// (sessionStorage 'aw_einlesen'), und nur für Administratoren. Führt zurück zum Einlesen bzw. zur Zusammenfassung.
import { api } from './api.js';
import { t, zahl } from './i18n.js';

const KEY = 'aw_einlesen';
let karte = null;
let timer = null;

function gemerkt() { try { return sessionStorage.getItem(KEY) === '1'; } catch (e) { return false; } }
function vergessen() { try { sessionStorage.removeItem(KEY); } catch (e) { /* egal */ } }

function bauen() {
  const d = document.createElement('div');
  d.setAttribute('role', 'status');
  d.style.cssText = 'position:fixed;z-index:9000;top:calc(max(12px,env(safe-area-inset-top)) + 62px);left:50%;transform:translateX(-50%);width:min(640px,calc(100% - 24px));'
    + 'display:flex;gap:12px;align-items:center;padding:10px 14px;border-radius:14px;background:rgba(30,20,12,.94);border:1px solid rgba(255,181,71,.4);'
    + 'box-shadow:0 10px 36px rgba(0,0,0,.5);color:#f6efe7;font:13.5px/1.35 inherit;backdrop-filter:blur(10px)';
  d.innerHTML = '<div style="flex:1;min-width:0"><div class="sl-t" style="font-weight:700"></div>'
    + '<div style="height:5px;border-radius:5px;background:rgba(255,244,230,.12);margin-top:6px;overflow:hidden"><b class="sl-b" style="display:block;height:100%;width:0;background:linear-gradient(135deg,#ffb547,#ff7a3d);border-radius:5px;transition:width .4s"></b></div></div>'
    + '<a class="sl-a" style="color:#ffc976;text-decoration:none;font-weight:600;white-space:nowrap;border:1px solid rgba(255,236,214,.2);border-radius:999px;padding:5px 12px" href="/einrichtung.php?einlesen=1"></a>'
    + '<button class="sl-x" type="button" style="background:none;border:0;color:#bcae9f;font-size:18px;cursor:pointer;padding:2px 6px">×</button>';
  d.querySelector('.sl-x').setAttribute('aria-label', t('Schließen'));
  d.querySelector('.sl-x').onclick = () => { vergessen(); zu(); };
  document.body.appendChild(d);
  return d;
}

function zu() {
  if (timer) { clearInterval(timer); timer = null; }
  if (karte) { karte.remove(); karte = null; }
}

async function abfragen() {
  if (document.hidden) return;
  let s = null;
  try { s = await api.get('/admin/scan'); } catch (e) { return; }
  if (!gemerkt()) { zu(); return; }
  karte = karte || bauen();
  const l = s.laufend || (s.laeufe && s.laeufe[0]) || null;
  const tx = karte.querySelector('.sl-t'), bar = karte.querySelector('.sl-b'), a = karte.querySelector('.sl-a');
  if (s.laufend) {
    const p = l.gesamt > 0 ? Math.min(100, Math.floor(l.geprueft * 100 / l.gesamt)) : 0;
    tx.textContent = l.gesamt > 0 ? t('Einlesen läuft im Hintergrund · {p} % · {a} von {b}', { p, a: zahl(l.geprueft), b: zahl(l.gesamt) }) : t('Einlesen läuft im Hintergrund …');
    bar.style.width = p + '%';
    a.textContent = t('← Zurück zum Einlesen'); a.href = '/einrichtung.php?einlesen=1';
  } else if (l && l.status === 'fertig') {
    tx.textContent = t('Einlesen abgeschlossen ✓'); bar.style.width = '100%';
    a.textContent = t('Zusammenfassung ansehen'); a.href = '/einrichtung.php?zusammenfassung=1';
    if (timer) { clearInterval(timer); timer = null; }
  } else {
    tx.textContent = l && l.meldung ? t('Das Einlesen wurde beendet: {meldung}', { meldung: l.meldung }) : t('Das Einlesen wurde beendet');
    a.textContent = t('Details'); a.href = '/verwaltung';
    if (timer) { clearInterval(timer); timer = null; }
  }
}

export function scanLeisteStarten() {
  if (!gemerkt()) return;
  abfragen();
  timer = setInterval(abfragen, 3000);
}
