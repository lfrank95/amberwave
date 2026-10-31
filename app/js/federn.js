// Android-App: Federn am Scroll-Ende nur für den Seiteninhalt. Das eingebaute Dehnen von Android zieht die ganze Ansicht
// samt Kopf- und Fußleiste mit – das ist in der App ausgeschaltet (overScrollMode, overscroll-behavior). Stattdessen gibt
// der Inhalt (#inhalt) hier selbst nach und springt beim Loslassen zurück.

const MAX = 140;   // höchstens so weit (px) gibt der Inhalt nach

export function federnEinrichten() {
  let basis = null;     // Fingerposition, an der das Ende erreicht war
  let richtung = 0;     // +1 oben gezogen, −1 unten gezogen
  let letztY = 0;
  let el = null;

  const amAnfang = () => window.scrollY <= 0;
  const amEnde = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 1;
  const setzen = (px, weich) => {
    if (!el) return;
    el.style.transition = weich ? 'transform .38s cubic-bezier(.2, .9, .25, 1)' : 'none';
    el.style.transform = px ? `translateY(${px}px)` : '';
  };

  window.addEventListener('touchstart', (e) => {
    basis = null;
    richtung = 0;
    if (e.touches.length !== 1) return;
    const z = e.target;
    const inhalt = document.getElementById('inhalt');
    // nur im Seiteninhalt, nicht in Dialogen, Menüs, dem großen Player oder Bereichen, die selbst scrollen
    if (!inhalt || !inhalt.contains(z) || z.closest?.('[data-kein-federn], dialog, .dialog, .menue, .jetzt, input, textarea, select')) { el = null; return; }
    el = inhalt;
    letztY = e.touches[0].clientY;
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!el || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    const dy = y - letztY;
    letztY = y;
    if (basis === null) {
      if (dy > 0 && amAnfang()) { basis = y - dy; richtung = 1; }
      else if (dy < 0 && amEnde()) { basis = y - dy; richtung = -1; }
      else return;
    }
    const d = (y - basis) * richtung;
    if (d <= 0) { basis = null; richtung = 0; setzen(0, false); return; }
    // Gummiband: je weiter, desto zäher
    const weg = MAX * (1 - 1 / (1 + (d * 0.55) / MAX));
    setzen(weg * richtung, false);
  }, { passive: true });

  const loslassen = () => {
    if (basis !== null) setzen(0, true);
    basis = null;
    richtung = 0;
  };
  window.addEventListener('touchend', loslassen, { passive: true });
  window.addEventListener('touchcancel', loslassen, { passive: true });
}
