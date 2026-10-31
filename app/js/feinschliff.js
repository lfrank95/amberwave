// Kleine Helfer für die ganze Oberfläche, die beim Zeichnen jeder Ansicht greifen (auch in später geöffneten Dialogen):
//  • Wischleisten (Reiter, Chips, Buchstaben): ist rechts oder links noch etwas verborgen, blendet der Rand weich aus –
//    so sieht man, dass sich die Leiste wischen lässt, statt dass ein Reiter mitten im Wort abbricht.
//  • Tabellen mit class="karten": auf schmalen Bildschirmen jede Zeile als Karte, die Spaltennamen stehen vor den Werten.

const LEISTEN = '.verwaltung-tabs, .themen-zeile, .bib-ansichten, .buchstaben, .pk-chips, .fx-kette';
const leisten = new WeakSet();
const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver((e) => e.forEach((x) => raender(x.target))) : null;

function raender(el) {
  const rest = el.scrollWidth - el.clientWidth;
  el.classList.toggle('wisch-l', rest > 2 && el.scrollLeft > 2);
  el.classList.toggle('wisch-r', rest > 2 && el.scrollLeft < rest - 2);
}

function leiste(el) {
  if (leisten.has(el)) return;
  leisten.add(el);
  el.classList.add('wisch');
  el.addEventListener('scroll', () => raender(el), { passive: true });
  ro?.observe(el);
  // aktiven Reiter ins Bild holen (z. B. „Bibliothek“ ganz rechts in der Verwaltung)
  const an = el.querySelector('.an, [aria-current="page"]');
  if (an && el.scrollWidth > el.clientWidth) el.scrollLeft = Math.max(0, an.offsetLeft - (el.clientWidth - an.offsetWidth) / 2);
  raender(el);
}

function tabelle(tab) {
  if (tab.dataset.kartenFertig) return;
  tab.dataset.kartenFertig = '1';
  const namen = [...tab.querySelectorAll('thead th')].map((th) => th.textContent.trim());
  tab.querySelectorAll('tbody tr').forEach((tr) => [...tr.children].forEach((td, i) => { if (namen[i]) td.dataset.k = namen[i]; }));
}

function suchen(wurzel) {
  if (wurzel.nodeType !== 1) return;
  if (wurzel.matches(LEISTEN)) leiste(wurzel);
  wurzel.querySelectorAll(LEISTEN).forEach(leiste);
  if (wurzel.matches('table.karten')) tabelle(wurzel);
  wurzel.querySelectorAll('table.karten').forEach(tabelle);
  if (wurzel.matches('tbody, tr') && wurzel.closest('table.karten')) { const t = wurzel.closest('table.karten'); delete t.dataset.kartenFertig; tabelle(t); }
}

export function feinschliffBeobachten() {
  suchen(document.body);
  new MutationObserver((liste) => liste.forEach((m) => m.addedNodes.forEach(suchen))).observe(document.body, { childList: true, subtree: true });
}
