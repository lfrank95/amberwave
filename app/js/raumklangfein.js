// Raumklang-Feineinstellung: Intensität (Raum/Hall), Surround-Pegel (Ls/Rs) – Mitte = wie das Preset –,
// Effekte/Breite nach hinten und Center-Anteil (LCR per M/S).
import { h, dialog } from './ui.js';
import { t, zahl, sprache } from './i18n.js';
import { RAUMKLANG_PRESETS, FEIN_STANDARD, feinDb, workletStand } from './raumklang.js';

const proz = (u) => (sprache === 'en' ? `${u}%` : `${u} %`);
const dbText = (w) => { const d = feinDb(w); return `${d > 0 ? '+' : d < 0 ? '−' : '±'}${zahl(Math.abs(d), 1)} dB`; };
const effText = (w) => { const u = Math.round(Number(w)); return u <= 0 ? t('aus') : proz(u); };
const centerText = (w) => { const u = Math.round(Number(w)); return u <= 0 ? t('nur L/R') : u >= 100 ? t('alles im Center') : `${proz(u)}${u === 50 ? ' (−3 dB)' : ''}`; };
export const text = (key, w) => (key === 'effekte' || key === 'breite' ? effText(w) : key === 'center' ? centerText(w) : key === 'intensitaet' && Number(w) <= 0 ? t('Hall aus') : dbText(w));

/** Welche Fassung des Raumklang-Moduls läuft wirklich? (Hilft, wenn ein Update scheinbar nicht greift) */
function standZeile() {
  const { geladen, erwartet } = workletStand;
  if (!geladen) return `<p class="hinweis" style="font-size:.8rem;margin-bottom:0">${t('Raumklang-Modul: noch nicht geladen (startet mit der ersten Wiedergabe mit Raumklang).')}</p>`;
  if (erwartet && geladen !== erwartet) {
    return `<p class="hinweis" style="font-size:.85rem;margin-bottom:0;color:var(--danger)">${t('Raumklang-Modul läuft noch in Fassung {geladen}, auf dem Server liegt {erwartet}. Bitte die Seite neu laden (am PC Strg+F5; die installierte App einmal ganz schließen und neu öffnen).', { geladen: h(geladen), erwartet: h(erwartet) })}</p>`;
  }
  return `<p class="hinweis" style="font-size:.8rem;margin-bottom:0">${t('Raumklang-Modul: Fassung {geladen} ✓', { geladen: h(geladen) })}</p>`;
}

export function raumklangFeinOeffnen(player) {
  const f = { ...FEIN_STANDARD, ...(player.einst.raumklang_fein || {}) };
  const preset = RAUMKLANG_PRESETS[player.einst.raumklang] || RAUMKLANG_PRESETS[player.einst.raumklang_letzt] || null;
  const regler = (key, titel, info, skala) => `<div class="fein-regler">
      <div class="fein-kopf"><label for="rk-${key}">${titel}</label><b data-wert="${key}">${text(key, f[key])}</b></div>
      <input id="rk-${key}" type="range" class="regler" min="0" max="100" step="1" value="${f[key]}" data-fein="${key}" list="rk-mitte">
      <div class="fein-skala">${skala.map((s) => `<span>${s}</span>`).join('')}</div>
      <p class="hinweis">${info}</p></div>`;
  return dialog({
    titel: t('Raumklang fein einstellen'),
    inhalt: `<datalist id="rk-mitte"><option value="50"></option></datalist>
      <p class="hinweis" style="margin-top:0">${preset ? t('Gilt für jedes Preset (gerade: {name}).', { name: h(preset.name) }) : t('Gilt für jedes Preset.')} ${t('Doppelklick auf einen Regler setzt ihn zurück.')}</p>
      ${regler('intensitaet', t('Intensität'), t('Wie viel Raum und Hall erzeugt wird – mehr macht den Raum größer und hallender, weniger trockener. Mitte = Preset, ±12 dB; ganz links ist der Hall aus (frühe Reflexionen bleiben leise).'), [t('Hall aus'), t('Preset'), t('mehr')])}
      ${regler('pegel', t('Surround-Pegel (Ls/Rs)'), t('Lautstärke der hinteren Lautsprecher insgesamt – zum Anpassen an Raum und Aufstellung. Mitte = Preset, ±12 dB.'), [t('leiser'), t('Preset'), t('lauter')])}
      ${regler('effekte', t('Effekte nach hinten'), t('Gegenphasige und sehr hart gepannte Anteile werden nach hinten verschoben – vorne leiser, hinten lauter, trocken und ohne Verzögerung. Normale Musik bleibt vorne. Das Preset gewichtet mit (Dezent weniger, Live mehr).'), [t('aus'), t('etwas'), t('deutlich')])}
      ${regler('breite', t('Breite nach hinten'), t('Was laut im Vordergrund steht, auf beiden Seiten ähnlich laut, aber kaum korreliert ist – breite Vocal-Doubles, Leslie-Orgel, breite Synths – wandert trocken und hell Richtung hinten auf derselben Seite. Leiser Hall bleibt im Raum.'), [t('aus'), t('etwas'), t('rundherum')])}
      ${regler('center', t('Center-Anteil (LCR per M/S)'), t('Die Front wird per M/S zu L/C/R dekodiert: M = (L+R)/2 geht mit sin in den Center und bleibt mit cos in L/R (Leistung einer Phantommitte bleibt gleich). Mitte = klassische Matrix (Center M mit 0 dB, Front M mit −3 dB), links nur L/R, rechts die ganze Mitte im Center. Bassmanagement (Trennfrequenz 80/100/120 Hz, Linkwitz-Riley 24 dB/Okt., LFE-Pegel) stellst du im Raumklang-Menü an der Player-Leiste ein.'), [t('nur L/R'), t('klassisch'), t('alles im Center')])}
      ${standZeile()}`,
    knoepfe: [{ text: t('Zurücksetzen'), wert: 'reset', art: 'zweit' }, { text: t('Fertig'), wert: 'ok' }],
    beimOeffnen: (dlg) => {
      dlg.querySelectorAll('[data-fein]').forEach((r) => {
        const setzen = () => { dlg.querySelector(`[data-wert="${r.dataset.fein}"]`).textContent = text(r.dataset.fein, r.value); player.raumklangFeinSetzen({ [r.dataset.fein]: Number(r.value) }); };
        r.addEventListener('input', setzen);
        r.addEventListener('dblclick', () => { r.value = FEIN_STANDARD[r.dataset.fein]; setzen(); });
      });
      dlg.querySelector('button[value="reset"]').addEventListener('click', (e) => {
        e.preventDefault();
        dlg.querySelectorAll('[data-fein]').forEach((r) => {
          r.value = FEIN_STANDARD[r.dataset.fein];
          dlg.querySelector(`[data-wert="${r.dataset.fein}"]`).textContent = text(r.dataset.fein, r.value);
        });
        player.raumklangFeinSetzen({ ...FEIN_STANDARD });
      });
    },
  });
}
