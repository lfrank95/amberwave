// Zugriff auf die JSON-API v1 (dieselbe API nutzt später der Windows-Player).
import { toast } from './ui.js';
import { t } from './i18n.js';
import { netzweg } from './netzweg.js';

// Zuhause (Direktadresse erreichbar) gehen alle API-Anfragen direkt an den Server im Heimnetz – nur Anmeldung, Abmelden
// und das Holen des Direkt-Schlüssels bleiben auf dem normalen Weg (dort hängt das Login-Cookie).
const IMMER_NORMAL = [/^\/auth\b/, /^\/abmelden\b/, /^\/direkt\//, /^\/ping\b/, /^\/profil\/passwort\b/, /^\/admin\b/, /^\/heimnetz\b/];

function direktBasis(pfad, normal) {
  const d = netzweg.direkt;
  if (normal || !netzweg.erreichbar || !d?.api_token) return null;
  if (d.bis && d.bis * 1000 < Date.now() + 60000) { netzweg.tokenErneuern(); return null; }
  return IMMER_NORMAL.some((r) => r.test(pfad)) ? null : d.url;
}

/** Langsames Netz oder Datensparmodus: Cover in Listen in der kleinsten Stufe (200 px) laden */
const langsam = () => { const c = navigator.connection; return !!c && (c.saveData || /^(slow-2g|2g|3g)$/.test(c.effectiveType || '')); };
function bilderLeicht(x) {
  if (typeof x === 'string') return x.startsWith('/api/v1/bild/cover/') ? x.replace(/([?&])g=300(?=&|$)/, '$1g=200') : x;
  if (Array.isArray(x)) { for (let i = 0; i < x.length; i++) x[i] = bilderLeicht(x[i]); return x; }
  if (x && typeof x === 'object') { for (const k of Object.keys(x)) x[k] = bilderLeicht(x[k]); }
  return x;
}

/** Bild-Adressen in Antworten auf die Direktadresse umschreiben (Cover, Künstlerbilder) */
function bilderDirekt(x) {
  if (!netzweg.erreichbar || !netzweg.direkt) return x;
  if (typeof x === 'string') return x.startsWith('/api/v1/bild/') ? netzweg.url(x) : x;
  if (Array.isArray(x)) { for (let i = 0; i < x.length; i++) x[i] = bilderDirekt(x[i]); return x; }
  if (x && typeof x === 'object') { for (const k of Object.keys(x)) x[k] = bilderDirekt(x[k]); }
  return x;
}

let csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
export function csrfSetzen(t) { if (t) csrf = t; }

export class ApiFehler extends Error {
  constructor(meldung, status, daten) { super(meldung); this.status = status; this.daten = daten || {}; }
}

async function anfrage(methode, pfad, daten, optionen = {}, normal = false) {
  const kopf = { 'Accept': 'application/json' };
  const basis = direktBasis(pfad, normal);
  if (basis) kopf['X-Amberwave-Direkt'] = netzweg.direkt.api_token;
  let koerper;
  if (daten instanceof FormData) {
    koerper = daten;
  } else if (daten !== undefined) {
    kopf['Content-Type'] = 'application/json';
    koerper = JSON.stringify(daten);
  }
  if (methode !== 'GET' && !basis) kopf['X-CSRF-Token'] = csrf; // direkt: der Schlüssel in der Kopfzeile ersetzt das CSRF-Token
  let antwort;
  try {
    antwort = basis
      ? await fetch(basis + '/api/v1' + pfad, { method: methode, headers: kopf, body: koerper, credentials: 'omit', mode: 'cors', signal: optionen.signal })
      : await fetch('/api/v1' + pfad, { method: methode, headers: kopf, body: koerper, credentials: 'same-origin', signal: optionen.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    // Direktadresse weg (Haus verlassen, WLAN aus): sofort über den normalen Weg wiederholen
    if (basis) { netzweg.ausfall(); return anfrage(methode, pfad, daten, optionen, true); }
    throw new ApiFehler(t('Server nicht erreichbar. Bitte Verbindung prüfen.'), 0);
  }
  // Schlüssel abgelaufen oder Gerät abgemeldet: einmal normal versuchen (dort entscheidet das Login-Cookie)
  if (basis && antwort.status === 401) { netzweg.tokenErneuern(); return anfrage(methode, pfad, daten, optionen, true); }
  let json = null;
  try { json = await antwort.json(); } catch (e) { /* keine JSON-Antwort */ }
  if (antwort.ok && json) { if (langsam()) bilderLeicht(json); bilderDirekt(json); }
  if (!antwort.ok) {
    const meldung = json?.fehler || t('Fehler {status}', { status: antwort.status });
    if (antwort.status === 401 || json?.login) {
      try { localStorage.removeItem('aw_ich'); } catch (e) { /* egal */ }   // abgemeldet: kein Offline-Start als dieses Konto mehr
      window.location.href = '/login.php?grund=' + (/Gerät|device/i.test(meldung) ? 'geraet' : 'abgelaufen') + '&ziel=' + encodeURIComponent(location.pathname);
    } else if (json?.passwort_aendern) {
      window.location.href = '/passwort-erzwingen.php';
    }
    throw new ApiFehler(meldung, antwort.status, json);
  }
  return json;
}

// Vorab angestoßene Anfragen (Start: /start läuft schon, während /ich und der Aufbau noch laufen) – der erste get() dazu nimmt die Antwort
const vorab = new Map();
export const api = {
  vorab: (p) => { if (!vorab.has(p)) vorab.set(p, anfrage('GET', p, undefined, {}).catch((e) => { vorab.delete(p); throw e; })); },
  get: (p, o) => { if (vorab.has(p)) { const v = vorab.get(p); vorab.delete(p); return v; } return anfrage('GET', p, undefined, o); },
  post: (p, d) => anfrage('POST', p, d ?? {}),
  put: (p, d) => anfrage('PUT', p, d ?? {}),
  del: (p) => anfrage('DELETE', p, {}),
};

/** API-Aufruf mit Fehlermeldung als Hinweis; gibt null zurück, wenn es schiefging. */
export async function versuche(fn, erfolgText = '') {
  try {
    const r = await fn();
    if (erfolgText) toast(erfolgText);
    return r ?? true;
  } catch (e) {
    if (e.name !== 'AbortError') toast(e.message, 'fehler', 6000);
    return null;
  }
}
