// Laufschrift: Titel und Künstler im Player stehen immer in einer Zeile. Passt der Text nicht, läuft er langsam hin und
// her, statt umzubrechen – so springt die Höhe der Player-Elemente nicht von Titel zu Titel.

const beobachtet = new WeakSet();
const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver((e) => e.forEach((x) => messen(x.target))) : null;

/** Nach jedem Setzen des Inhalts aufrufen: packt den Inhalt in eine innere Zeile und misst neu */
export function laufschrift(el) {
  if (!el) return;
  el.classList.add('lauf');
  let innen = el.firstElementChild?.classList.contains('lauf-innen') ? el.firstElementChild : null;
  if (!innen) {
    innen = document.createElement('span');
    innen.className = 'lauf-innen';
    while (el.firstChild) innen.appendChild(el.firstChild);
    el.appendChild(innen);
  }
  if (ro && !beobachtet.has(el)) { beobachtet.add(el); ro.observe(el); }
  messen(el);
}

function messen(el) {
  const innen = el.firstElementChild;
  if (!innen?.classList.contains('lauf-innen')) return;
  requestAnimationFrame(() => {
    const weg = innen.scrollWidth - el.clientWidth;
    const laeuft = weg > 3;
    if (laeuft) {
      el.style.setProperty('--lauf-weg', `${-weg}px`);
      // etwa 30 px pro Sekunde, dazu Pausen an beiden Enden
      el.style.setProperty('--lauf-zeit', `${Math.max(5, weg / 30 + 3).toFixed(1)}s`);
    }
    if (el.classList.contains('laeuft') !== laeuft) el.classList.toggle('laeuft', laeuft);
  });
}
