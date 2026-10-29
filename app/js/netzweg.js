// Netzweg: Kommt die Musik direkt im Heimnetz (Direktadresse mit eigenem Zertifikat) oder über den normalen Weg?
// Die App prüft beim Start, bei jedem Netzwechsel und regelmäßig, ob die Direktadresse antwortet. Wenn ja, holt der
// Player Streams von dort (mit kurzlebigem Stream-Schlüssel statt Login-Cookie) – sonst wie bisher. Fällt die
// Direktadresse mitten im Hören weg (Haus verlassen), schaltet er sofort auf den normalen Weg zurück.
import { api } from './api.js';
import { t } from './i18n.js';

class Netzweg extends EventTarget {
  constructor() {
    super();
    this.direkt = null;      // { url, token, bis }
    this.erreichbar = false;
    this.geprueft = 0;
    this.laeuft = null;
    this.letzterFehler = '';
    const pruefen = () => this.pruefen();
    window.addEventListener('online', pruefen);
    navigator.connection?.addEventListener?.('change', pruefen);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - this.geprueft > 60000) pruefen(); });
    window.addEventListener('focus', () => { if (!this.erreichbar && Date.now() - this.geprueft > 5000) pruefen(); });
    // Zuhause erreichbar: alle 5 Minuten kurz bestätigen, sonst jede Minute nachsehen (nur bei sichtbarem Fenster).
    // Schneller geht es beim Hören: jeder Titelwechsel prüft zusätzlich (beiTitel)
    setInterval(() => {
      if (document.hidden || !this.direkt) return;
      if (Date.now() - this.geprueft > (this.erreichbar ? 5 : 1) * 60000) this.pruefen();
    }, 10000);
    setInterval(() => this.tokenErneuern(), 4 * 3600000);
  }

  /** Daten aus /ich übernehmen ({url, token, bis} oder null) */
  einrichten(info) {
    this.direkt = info && info.url ? info : null;
    if (!this.direkt) { this.setzen(false); return Promise.resolve(false); }
    return this.pruefen();
  }

  /** Antwortet die Direktadresse? (höchstens 2,5 s warten) */
  pruefen() {
    if (!this.direkt) return Promise.resolve(false);
    if (this.laeuft) return this.laeuft;
    this.laeuft = (async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 2500);
      let ok = false;
      try {
        const r = await fetch(`${this.direkt.url}/api/v1/ping`, { signal: ac.signal, mode: 'cors', credentials: 'omit', cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        ok = !!(j && j.ok && j.app === 'amberwave');
        this.letzterFehler = ok ? '' : t('Antwort {status}', { status: r.status });
      } catch (e) {
        this.letzterFehler = e.name === 'AbortError' ? t('keine Antwort') : (e.message || e.name);
      } finally {
        clearTimeout(timer);
      }
      this.geprueft = Date.now();
      this.setzen(ok);
      this.laeuft = null;
      return ok;
    })();
    return this.laeuft;
  }

  /** Ein Titel startet: unterwegs/nicht erreichbar → kurz prüfen, ob die Direktadresse wieder antwortet (höchstens alle 20 s) */
  beiTitel() {
    if (this.direkt && !this.erreichbar && !this.laeuft && Date.now() - this.geprueft > 20000) this.pruefen();
  }

  setzen(ok) {
    if (ok === this.erreichbar) return;
    this.erreichbar = ok;
    this.dispatchEvent(new Event('wechsel'));
  }

  /** Direktadresse antwortet nicht mehr (z. B. Haus verlassen): sofort normal weiter, später erneut prüfen */
  ausfall() {
    this.setzen(false);
    setTimeout(() => this.pruefen(), 30000);
  }

  async tokenErneuern() {
    if (!this.direkt) return;
    try {
      const r = await api.get('/direkt/token');
      if (r?.url) this.direkt = { url: r.url, token: r.token, api_token: r.api_token, bis: r.bis };
    } catch (e) { /* später erneut */ }
  }

  /** Adresse für Medien: direkt (mit Schlüssel), wenn erreichbar – sonst der normale relative Pfad */
  url(pfad) {
    if (!this.erreichbar || !this.direkt) return pfad;
    if (this.direkt.bis && this.direkt.bis * 1000 < Date.now() + 60000) { this.tokenErneuern(); return pfad; }
    return `${this.direkt.url}${pfad}${pfad.includes('?') ? '&' : '?'}st=${encodeURIComponent(this.direkt.token)}`;
  }

  /** Direkt-Adresse zurück in den normalen relativen Pfad (ohne Schlüssel) */
  relativ(url) {
    if (!this.istDirekt(url)) return url;
    const u = new URL(url);
    u.searchParams.delete('st');
    return u.pathname + (u.search || '');
  }

  istDirekt(url) {
    return !!(this.direkt && url && url.startsWith(this.direkt.url));
  }

  /** Für die Anzeige: Host der Direktadresse */
  get name() {
    try { return this.direkt ? new URL(this.direkt.url).host : ''; } catch (e) { return ''; }
  }
}

export const netzweg = new Netzweg();

// Bild über die Direktadresse lädt nicht (Schlüssel abgelaufen, unterwegs)? Dann über den normalen Weg.
window.addEventListener('error', (e) => {
  const el = e.target;
  if (el && el.tagName === 'IMG' && netzweg.istDirekt(el.src)) el.src = netzweg.relativ(el.src);
}, true);
