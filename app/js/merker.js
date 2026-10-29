// Kleine Helfer, damit sich die Oberfläche Dinge merkt:
//  - gemerkt()/merken(): Einstellungen pro Gerät (Sortierung, Ansicht, Filter) im Browser dieses Geräts
//  - mitScrollerhalt(): eine Liste neu zeichnen, ohne dass die Seite an den Anfang springt

/** Pro Gerät gemerkten Wert lesen (leer/Standard, wenn nichts gemerkt oder Speicher gesperrt) */
export function gemerkt(schluessel, standard = '') {
  try {
    const w = localStorage.getItem('aw_' + schluessel);
    return w === null ? standard : w;
  } catch { return standard; }
}

export function merken(schluessel, wert) {
  try { localStorage.setItem('aw_' + schluessel, String(wert)); } catch { /* privater Modus */ }
}

/** Gemerkten Wert nur annehmen, wenn er zu den erlaubten gehört (sonst Standard) */
export function gemerktAus(schluessel, erlaubt, standard) {
  const w = gemerkt(schluessel, '');
  return erlaubt.includes(w) ? w : standard;
}

/** Scrollposition (wieder) einstellen; mehrere Versuche, falls die Seite noch wächst (Bilder, nachgeladene Listen) */
export function scrollSetzen(y, versuche = 8) {
  let n = 0;
  const los = () => {
    window.scrollTo(0, y);
    if (Math.abs(window.scrollY - y) > 3 && n++ < versuche) setTimeout(los, 120);
  };
  requestAnimationFrame(los);
}

/**
 * Führt fn aus (z. B. eine Liste neu laden) und stellt danach die Scrollposition wieder her.
 * Kurz bevor die Liste ersetzt wird, hält min-height den Platz, damit die Seite nicht zusammenfällt.
 */
export async function mitScrollerhalt(fn, huelle = null) {
  const y = window.scrollY;
  if (huelle) huelle.style.minHeight = huelle.offsetHeight + 'px';
  try {
    return await fn();
  } finally {
    if (huelle) huelle.style.minHeight = '';
    scrollSetzen(y);
  }
}
