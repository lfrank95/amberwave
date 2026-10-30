// Android-App: Brücke zur App (window.AwAndroid, von der App eingehängt) – im Browser null.
// Die App speichert Offline-Titel als Dateien in ihrem eigenen Speicher (Android räumt sie nicht weg), lädt im Hintergrund
// weiter, wenn die App zu ist, und zeigt die Wiedergabe in der Benachrichtigung und auf dem Sperrbildschirm.
// Die Oberfläche spricht dafür wie gewohnt mit navigator.mediaSession – das leitet dieses Modul an die App weiter.

export const android = typeof window !== 'undefined' && window.AwAndroid ? window.AwAndroid : null;

/** Methode der App aufrufen (Fehler nur ins Protokoll – die Oberfläche läuft weiter) */
export function androidRufen(name, ...args) {
  if (!android || typeof android[name] !== 'function') return null;
  try { return android[name](...args.map((a) => (a !== null && typeof a === 'object' ? JSON.stringify(a) : a))); } catch (e) { console.warn('Android', name, e); return null; }
}

/** Wie androidRufen, Antwort als JSON gelesen */
export function androidJson(name, ...args) {
  const r = androidRufen(name, ...args);
  if (r == null || r === '') return null;
  try { return JSON.parse(r); } catch (e) { return null; }
}

const hoerer = new Set();
/** Ereignisse der App (Downloads: fortschritt, fertig, fehler, platz, wartet) */
export function androidHoeren(f) { hoerer.add(f); return () => hoerer.delete(f); }

/** Version der App (z. B. „0.9.1-beta.5“) */
export const androidVersion = () => (android ? String(androidRufen('version') || '') : '');

if (android) {
  document.documentElement.classList.add('aw-android');
  window.awAndroidEreignis = (e) => {
    const d = typeof e === 'string' ? JSON.parse(e) : e;
    for (const f of hoerer) { try { f(d); } catch (x) { console.warn(x); } }
  };
  medienSitzung();
}

/** navigator.mediaSession nachbilden: Titel, Cover, Zustand und Knöpfe gehen an die Benachrichtigung der App */
function medienSitzung() {
  const handler = {};
  let meta = null;
  let zustand = 'none';
  let letztePos = 0;
  const abs = (u) => { try { return new URL(u, location.href).href; } catch (e) { return ''; } };
  const ms = {
    get metadata() { return meta; },
    set metadata(m) {
      meta = m;
      const bild = m?.artwork?.length ? m.artwork[m.artwork.length - 1].src : '';
      androidRufen('medienMeta', m ? { titel: m.title || '', kuenstler: m.artist || '', album: m.album || '', bild: bild ? abs(bild) : '' } : {});
    },
    get playbackState() { return zustand; },
    set playbackState(s) { zustand = s; androidRufen('medienZustand', String(s)); },
    setActionHandler(aktion, f) {
      if (f) handler[aktion] = f; else delete handler[aktion];
      androidRufen('medienAktionen', Object.keys(handler));
    },
    setPositionState(p) {
      // höchstens einmal je Sekunde – die Benachrichtigung rechnet dazwischen selbst weiter
      const jetzt = Date.now();
      if (jetzt - letztePos < 1000) return;
      letztePos = jetzt;
      androidRufen('medienPosition', { dauer: Number(p?.duration) || 0, position: Number(p?.position) || 0, tempo: Number(p?.playbackRate) || 1 });
    },
  };
  try { Object.defineProperty(navigator, 'mediaSession', { value: ms, configurable: true }); } catch (e) { /* bleibt ohne */ }
  if (typeof window.MediaMetadata === 'undefined') {
    window.MediaMetadata = class { constructor(o = {}) { Object.assign(this, { title: '', artist: '', album: '', artwork: [] }, o); } };
  }
  // Knöpfe aus Benachrichtigung, Sperrbildschirm, Kopfhörer und Auto
  window.awAndroidAktion = (aktion, daten) => {
    const f = handler[aktion];
    if (!f) return;
    const d = typeof daten === 'string' ? JSON.parse(daten || '{}') : (daten || {});
    f({ action: aktion, ...d });
  };
}

/** Zustand des Players (spielt / Pause) an die App melden – aus den Ereignissen des Audio-Elements */
export function androidPlayer(audio) {
  if (!android || !audio) return;
  const melden = (s) => { try { navigator.mediaSession.playbackState = s; } catch (e) { androidRufen('medienZustand', s); } };
  audio.addEventListener('playing', () => melden('playing'));
  audio.addEventListener('pause', () => melden('paused'));
  audio.addEventListener('ended', () => melden('paused'));
}
