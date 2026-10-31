// Dateifelder im Amberwave-Stil: statt des Browser-Knopfs („Choose File / No file chosen“ in der Sprache des Browsers)
// ein Knopf wie überall und der gewählte Dateiname daneben. Greift für jedes sichtbare <input type="file">, auch in
// Dialogen, die später entstehen. Das Feld selbst bleibt im Formular (required, change-Ereignisse) – nur unsichtbar.
import { t } from './i18n.js';

const fertig = new WeakSet();

function umbauen(feld) {
  if (fertig.has(feld) || feld.hidden || feld.closest('[hidden]') || feld.dataset.nativ !== undefined) return;
  fertig.add(feld);
  const huelle = document.createElement('span');
  huelle.className = 'datei-feld';
  const knopf = document.createElement('button');
  knopf.type = 'button';
  knopf.className = 'btn btn-zweit btn-klein';
  knopf.textContent = feld.multiple ? t('Dateien wählen …') : t('Datei wählen …');
  const name = document.createElement('span');
  name.className = 'datei-feld-name';
  const zeigen = () => {
    const n = feld.files?.length || 0;
    name.textContent = n > 1 ? t('{n} Dateien', { n }) : n ? feld.files[0].name : t('Keine Datei gewählt');
    name.classList.toggle('leer', !n);
  };
  feld.parentNode.insertBefore(huelle, feld);
  huelle.append(feld, knopf, name);
  knopf.addEventListener('click', () => feld.click());
  feld.addEventListener('change', zeigen);
  // das Formular kann das Feld zurücksetzen
  feld.form?.addEventListener('reset', () => setTimeout(zeigen));
  zeigen();
}

function suchen(wurzel) {
  if (wurzel.nodeType !== 1) return;
  if (wurzel.matches?.('input[type="file"]')) umbauen(wurzel);
  wurzel.querySelectorAll?.('input[type="file"]').forEach(umbauen);
}

export function dateifelderBeobachten() {
  suchen(document.body);
  new MutationObserver((liste) => liste.forEach((m) => m.addedNodes.forEach(suchen))).observe(document.body, { childList: true, subtree: true });
}
