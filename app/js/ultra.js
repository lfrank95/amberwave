// Ultra-Qualität: erster Hinweis je Gerät (dieser Browser bzw. dieser Windows-Client) und automatischer Rückfall auf HQ,
// wenn die Rechnung nicht hinterherkommt – im Browser gemessen in den Worklets (Rechenzeit je Block), in der Windows-Engine
// über deren Rechenlast und Aussetzer. „Trotzdem Ultra“ gilt bis zum Neuladen.
import { t } from './i18n.js';
import { h, toast, dialog } from './ui.js';

const SCHLUESSEL = 'aw-ultra-ok';
const NAMEN = { glow: 'AmberGlow', iron: 'AmberIron', silk: 'AmberSilk' };
const last = {};          // art | 'engine' → { w, t }
let erzwungen = false;

const obj = (p, art) => ({ glow: p.einst.waerme, iron: p.einst.trafo, silk: p.einst.band })[art];
export function geraetSetzen(p, art, o) {
  if (art === 'glow') p.waermeSetzen(o); else if (art === 'iron') p.trafoSetzen(o); else p.bandSetzen(o);
}

/** Rechenlast der Klangkette jetzt (Anteil der Echtzeit, 0…1+), null = unbekannt (spielt nichts) */
export function aktuelleLast() {
  const jetzt = Date.now();
  if (last.engine && jetzt - last.engine.t < 3000) return last.engine.w;
  let s = 0, da = false;
  for (const [a, v] of Object.entries(last)) if (a !== 'engine' && jetzt - v.t < 3000) { s += v.w; da = true; }
  return da ? s : null;
}
export const lastText = (l) => (l == null ? t('wird gemessen, sobald Musik läuft') : t('~{n} % eines Kerns', { n: Math.max(1, Math.round(l * 100)) }));

/** Vor dem ersten Ultra auf diesem Gerät fragen; true = einschalten */
export async function ultraFragen() {
  try { if (localStorage.getItem(SCHLUESSEL) === '1') return true; } catch (e) { /* ohne Speicher: jedes Mal fragen */ }
  const l = aktuelleLast();
  const balken = l == null ? '' : `<div class="ultra-last"><span>${t('Rechenlast jetzt')}</span><i><b style="width:${Math.min(100, Math.round(l * 100))}%"></b></i><span>${Math.round(l * 100)} %</span></div>`;
  const r = await dialog({
    titel: t('Ultra-Qualität'),
    inhalt: `<p>${h(t('Ultra bildet die Schaltung Bauteil für Bauteil nach – mit allem, was im Innenleben einstellbar ist. Das braucht deutlich mehr Rechenleistung als HQ.'))}</p>
      <p>${h(t('Auf diesem Gerät könnte es hakeln. Merkt Amberwave Aussetzer, schaltet es von selbst auf HQ zurück und sagt Bescheid.'))}</p>${balken}
      <label class="ultra-frage"><input type="checkbox" name="nicht_fragen" checked> ${h(t('Auf diesem Gerät nicht mehr fragen'))}</label>`,
    knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Ultra einschalten'), wert: 'ja', art: 'haupt' }],
  });
  if (!r) return false;
  if (r.form.get('nicht_fragen')) { try { localStorage.setItem(SCHLUESSEL, '1'); } catch (e) { /* egal */ } }
  return true;
}

/** Wacht über Ultra: bei Überlast (3 s über 80 %) oder 3 Aussetzern in 15 s alle Ultra-Geräte auf HQ */
export function ultraWache(p) {
  let ueber = 0, letzteBewertung = 0;
  let aussetzer = [];
  const ultraArten = () => ['glow', 'iron', 'silk'].filter((a) => obj(p, a)?.an && obj(p, a)?.q === 2);
  const zurueck = (grund) => {
    const arten = ultraArten();
    if (!arten.length || erzwungen) return;
    for (const a of arten) geraetSetzen(p, a, { ...obj(p, a), q: 1, hq: true });
    ueber = 0; aussetzer = [];
    const namen = arten.map((a) => NAMEN[a]).join(', ');
    toast(tn2(arten.length, namen), 'info', 12000, {
      unter: grund,
      knopf: { text: t('Trotzdem Ultra'), aktion: () => { erzwungen = true; for (const a of arten) geraetSetzen(p, a, { ...obj(p, a), q: 2, hq: true }); } },
    });
  };
  const tn2 = (n, namen) => (n === 1 ? t('{namen} läuft wieder in HQ', { namen }) : t('{namen} laufen wieder in HQ', { namen }));
  addEventListener('aw-klanglast', (e) => {
    const { art, last: w } = e.detail || {};
    if (!art || !Number.isFinite(w)) return;
    last[art] = { w, t: Date.now() };
    const jetzt = Date.now();
    if (jetzt - letzteBewertung < 900) return;
    letzteBewertung = jetzt;
    const l = aktuelleLast();
    if (!ultraArten().length || l == null) { ueber = 0; return; }
    ueber = l > (last.engine ? 0.85 : 0.8) ? ueber + 1 : 0;
    if (ueber >= 3) zurueck(t('In Ultra kam dieses Gerät nicht hinterher (Rechenlast {n} %).', { n: Math.round(l * 100) }));
  });
  addEventListener('aw-aussetzer', () => {
    if (!ultraArten().length) return;
    const jetzt = Date.now();
    aussetzer = aussetzer.filter((x) => jetzt - x < 15000);
    aussetzer.push(jetzt);
    if (aussetzer.length >= 3) zurueck(t('In Ultra kam dieses Gerät nicht hinterher ({n} Aussetzer).', { n: aussetzer.length }));
  });
}
