// Offline: Alben, Playlists und einzelne Titel auf dem Gerät speichern (Opus 256 kbit/s) und ohne Netz abspielen.
//
// Gespeichert wird im Speicher der App (nicht als Datei im Download-Ordner):
//  - Cache Storage „aw-offline-v1“: der Ton je Titel (WebM/Opus, unter /offline/titel/<id>.webm) und die Cover
//  - IndexedDB „aw-offline“: je Titel die Angaben für den Player (Titel, Künstler, Album, Lautheit, exakte Länge) und je
//    Sammlung (Album, Playlist, „Einzelne Titel“) die Liste der Titel. Ein Titel bleibt, solange ihn eine Sammlung braucht.
// Geladen wird über /stream/kette mit einem Titel: genau der Opus-Strom des lückenlosen Players, ohne Lautheitsangleich
// (den rechnet der Player beim Abspielen) – mit exakter Länge (X-Dauern), damit gespeicherte Titel lückenlos aneinanderpassen.
import { api } from './api.js';
import { netzweg } from './netzweg.js';
import { t } from './i18n.js';

const DB_NAME = 'aw-offline';
const CACHE = 'aw-offline-v1';
// Qualität vom Server (OFFLINE_QUALITAET); Standard Opus 256
let QUALITAET = 'opus256';
let KBIT = 256;
export function offlineQualitaet(q) { if (q) { QUALITAET = q; KBIT = Number(q.replace(/\D/g, '')) || 256; } }
export const EINZELN = 'titel:einzeln';

const tonUrl = (id) => `/offline/titel/${id}.webm`;
const schlafen = (ms) => new Promise((r) => setTimeout(r, ms));

function idbOeffnen() {
  return new Promise((ok, f) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('titel')) db.createObjectStore('titel', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('sammlungen')) db.createObjectStore('sammlungen', { keyPath: 'key' });
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => f(r.error);
  });
}

function anfrage(r) { return new Promise((ok, f) => { r.onsuccess = () => ok(r.result); r.onerror = () => f(r.error); }); }

class Offline extends EventTarget {
  constructor() {
    super();
    this.da = new Set();          // vollständig gespeicherte Titel-IDs
    this.titel = new Map();       // id -> Datensatz (ohne Ton)
    this.sammlungen = new Map();  // key -> Datensatz
    this.laufend = new Map();     // key -> { fertig, gesamt, fehler }
    this.warteschlange = [];      // [{ key, id }]
    this.bereit = this.laden();
  }

  /** Geht das hier? (Cache Storage + IndexedDB; im Windows-Client nicht nötig) */
  get moeglich() { return typeof caches !== 'undefined' && typeof indexedDB !== 'undefined' && window.isSecureContext !== false; }

  async laden() {
    if (!this.moeglich) return;
    try {
      this.db = await idbOeffnen();
      const tx = this.db.transaction(['titel', 'sammlungen']);
      const titel = await anfrage(tx.objectStore('titel').getAll());
      const samm = await anfrage(tx.objectStore('sammlungen').getAll());
      for (const t of titel) { this.titel.set(t.id, t); if (t.bytes > 0) this.da.add(t.id); }
      for (const s of samm) this.sammlungen.set(s.key, s);
      // Unterbrochene Downloads (App geschlossen, Netz weg) weiterführen: alles, was noch keinen Ton hat, wieder einreihen
      for (const t of titel) {
        if (!(t.bytes > 0) && t.in?.length && !this.warteschlange.some((w) => w.id === t.id)) {
          this.warteschlange.push({ key: t.in[0], id: t.id });
          for (const k of t.in) if (!this.laufend.has(k)) this.laufend.set(k, { fehler: null });
        }
      }
    } catch (e) {
      console.warn('Offline-Speicher nicht verfügbar', e);
      this.db = null;
    }
    this.melden();
    if (this.warteschlange.length) this.abarbeiten();
  }

  melden(key = null) { this.dispatchEvent(new CustomEvent('aenderung', { detail: { key } })); }

  async schreiben(store, wert) {
    if (!this.db) return;
    const tx = this.db.transaction(store, 'readwrite');
    tx.objectStore(store).put(wert);
    await new Promise((ok, f) => { tx.oncomplete = ok; tx.onerror = () => f(tx.error); });
  }

  async loeschen(store, key) {
    if (!this.db) return;
    const tx = this.db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    await new Promise((ok, f) => { tx.oncomplete = ok; tx.onerror = () => f(tx.error); });
  }

  // ---------- Abfragen (synchron, für die Oberfläche) ----------
  hat(id) { return this.da.has(Number(id)); }
  hatSammlung(key) { return this.sammlungen.has(key); }

  /** Stand einer Sammlung: { gespeichert, fertig, gesamt, laeuft, fehler } */
  stand(key) {
    const s = this.sammlungen.get(key);
    if (!s) return { gespeichert: false };
    const gesamt = s.ids.length;
    const fertig = s.ids.filter((id) => this.da.has(id)).length;
    const l = this.laufend.get(key);
    return { gespeichert: true, fertig, gesamt, laeuft: !!l && fertig < gesamt, fehler: l?.fehler || null };
  }

  /** Belegter Speicher (Ton) in Bytes */
  get bytes() { let n = 0; for (const t of this.titel.values()) n += t.bytes || 0; return n; }

  /** Gespeicherte Angaben eines Titels für den Player (mit Lautheit) */
  track(id) { return this.titel.get(Number(id))?.track || null; }
  lautheit(id) { return this.titel.get(Number(id))?.lh || null; }
  dauer(id) { return this.titel.get(Number(id))?.dauer || 0; }

  async ton(id) {
    const r = await (await caches.open(CACHE)).match(tonUrl(id));
    return r ? r.blob() : null;
  }

  // ---------- Speichern ----------
  /**
   * Sammlung speichern. art: 'album' | 'playlist' | 'titel' (einzelne Titel landen in „Einzelne Titel“).
   * daten: bei 'titel' die Track-Objekte (Player-Form); sonst wird die Liste vom Server geholt.
   */
  async speichern(art, id, daten = null) {
    await this.bereit;
    if (!this.db) throw new Error(t('Der Speicher dieses Browsers ist gesperrt (privater Modus?).'));
    try { await navigator.storage?.persist?.(); } catch (e) { /* egal */ }
    let s;
    if (art === 'titel') {
      const alt = this.sammlungen.get(EINZELN);
      const tracks = (daten || []).filter((t) => t && t.verfuegbar !== false);
      const ids = [...new Set([...(alt?.ids || []), ...tracks.map((t) => t.id)])];
      s = { key: EINZELN, art: 'titel', id: 0, titel: t('Einzelne Titel'), unter: '', cover: netzweg.relativ(alt?.cover || tracks[0]?.album?.cover || null), ids, auto: false, gespeichert: alt?.gespeichert || Date.now() };
      await this.titelVormerken(tracks, EINZELN);
    } else {
      const l = await this.listeHolen(art, id);
      s = { key: `${art}:${id}`, art, id: Number(id), titel: l.titel, unter: l.unter, cover: netzweg.relativ(l.cover), ids: l.tracks.map((t) => t.id), auto: true, gespeichert: Date.now(), stand: l.stand || null };
      await this.titelVormerken(l.tracks, s.key);
    }
    this.sammlungen.set(s.key, s);
    await this.schreiben('sammlungen', s);
    this.coverSpeichern([s.cover]);
    this.melden(s.key);
    this.abarbeiten();
    return s;
  }

  /** Titel einer Sammlung vom Server: Player-Form wie beim Abspielen */
  async listeHolen(art, id) {
    if (art === 'album') {
      const a = await api.get(`/alben/${id}`);
      const info = { id: a.id, titel: a.titel, edition_id: a.edition.id, cover: a.edition.cover };
      const kuenstler = (a.kuenstler || []).map((k) => k.name).join(', ');
      return { titel: a.titel, unter: [kuenstler, a.jahr].filter(Boolean).join(' · '), cover: a.edition.cover, tracks: a.tracks.filter((t) => t.verfuegbar !== false).map((t) => ({ ...t, album: info })) };
    }
    if (art === 'playlist') {
      const p = await api.get(`/playlists/${id}`);
      return { titel: p.name, unter: t('Playlist') + (p.familie ? ' · ' + t('Familie') : ''), cover: p.cover?.[0] || null, tracks: p.eintraege.filter((t) => t.verfuegbar !== false), stand: p.aktualisiert };
    }
    throw new Error(t('Unbekannte Art'));
  }

  /** Datensätze anlegen bzw. die Sammlung eintragen; Lautheit gleich mit holen */
  async titelVormerken(tracks, key) {
    const neu = [];
    for (const t of tracks) {
      const alt = this.titel.get(t.id);
      const d = alt || { id: t.id, bytes: 0, dauer: 0, in: [] };
      d.track = { ...t, album: t.album ? { ...t.album, cover: netzweg.relativ(t.album.cover) } : t.album };
      if (!d.in.includes(key)) d.in.push(key);
      this.titel.set(t.id, d);
      neu.push(d);
    }
    try {
      const ids = neu.map((d) => d.id);
      for (let i = 0; i < ids.length; i += 400) {
        const r = await api.get(`/lautheit?ids=${ids.slice(i, i + 400).join(',')}`);
        for (const id of ids.slice(i, i + 400)) { const d = this.titel.get(id); if (d && r?.tracks?.[id]) d.lh = r.tracks[id]; }
        if (typeof r?.decke === 'number') try { localStorage.setItem('aw_lh_decke', String(r.decke)); } catch (e) { /* egal */ }
      }
    } catch (e) { /* ohne Lautheit – der Player gleicht dann nicht an */ }
    for (const d of neu) {
      await this.schreiben('titel', d);
      if (!this.da.has(d.id) && !this.warteschlange.some((w) => w.id === d.id)) this.warteschlange.push({ key, id: d.id });
    }
    const l = this.laufend.get(key) || { fehler: null };
    this.laufend.set(key, l);
  }

  /** Cover in den Cache – unter dem relativen Pfad (ohne Direktadresse und Schlüssel), so findet sie der Service Worker offline */
  async coverSpeichern(urls) {
    try {
      const c = await caches.open(CACHE);
      for (const u of urls.filter(Boolean).map((x) => netzweg.relativ(x))) {
        for (const g of [u, u.replace(/g=\d+/, 'g=600')]) {
          if (await c.match(g)) continue;
          try { const r = await this.holen(g); if (r.ok) await c.put(g, r); } catch (e) { /* später */ }
        }
      }
    } catch (e) { /* egal */ }
  }

  /** Warteschlange abarbeiten: ein Titel nach dem anderen (der Server wandelt um) */
  async abarbeiten() {
    if (this._laeuft) return;
    this._laeuft = true;
    try {
      while (this.warteschlange.length) {
        if (!navigator.onLine) { await schlafen(5000); continue; }
        const w = this.warteschlange[0];
        const d = this.titel.get(w.id);
        if (!d || this.da.has(w.id) || !d.in.length) { this.warteschlange.shift(); continue; }
        try {
          await this.titelLaden(d);
          this.warteschlange = this.warteschlange.filter((x) => x !== w);
          for (const k of d.in) { const l = this.laufend.get(k); if (l) l.fehler = null; }
          this.melden(w.key);
        } catch (e) {
          if (e.name === 'QuotaExceededError') {
            for (const k of d.in) this.laufend.set(k, { fehler: t('Kein Platz mehr auf dem Gerät') });
            this.warteschlange = [];
            this.melden(w.key);
            this.dispatchEvent(new CustomEvent('fehler', { detail: t('Kein Platz mehr auf dem Gerät – gespeichert wurde, was passte.') }));
            break;
          }
          w.versuche = (w.versuche || 0) + 1;
          if (w.versuche >= 4) {
            this.warteschlange = this.warteschlange.filter((x) => x !== w);
            for (const k of d.in) this.laufend.set(k, { fehler: e.message });
            this.melden(w.key);
          } else await schlafen(e.warten || 3000 * w.versuche);
        }
      }
      // Sammlungen ohne Fehler sind fertig – Laufend-Eintrag weg
      for (const [k, l] of this.laufend) if (!l.fehler && !this.warteschlange.some((w) => this.titel.get(w.id)?.in.includes(k))) this.laufend.delete(k);
      this.melden();
    } finally { this._laeuft = false; }
  }

  async holen(pfad) {
    const voll = netzweg.url(pfad);
    const direkt = voll !== pfad;
    try {
      const r = await fetch(voll, { credentials: direkt ? 'omit' : 'same-origin', mode: direkt ? 'cors' : 'same-origin' });
      if (!r.ok && direkt) { netzweg.ausfall(); return this.holen(pfad); }
      return r;
    } catch (e) {
      if (direkt) { netzweg.ausfall(); return this.holen(pfad); }
      throw e;
    }
  }

  async titelLaden(d) {
    const r = await this.holen(`/api/v1/stream/kette?ids=${d.id}&q=${QUALITAET}`);
    if (r.status === 503) { const e = new Error(t('Server ausgelastet')); e.warten = (Number(r.headers.get('Retry-After')) || 5) * 1000; throw e; }
    if (!r.ok) throw new Error(t('Titel {id}: Server antwortet {status}', { id: d.id, status: r.status }));
    const dauer = Number((r.headers.get('X-Dauern') || '').split(',')[0]) || (d.track?.laenge_ms || 0) / 1000;
    // Stückweise lesen, damit der Fortschritt im Titel sichtbar ist (geschätzt aus Länge × 256 kbit/s)
    const erwartet = Math.max(1, dauer * KBIT * 125);
    const leser = r.body.getReader();
    const teile = [];
    let n = 0;
    for (;;) {
      const { done, value } = await leser.read();
      if (done) break;
      teile.push(value);
      n += value.length;
      this.titelAnteil = { id: d.id, anteil: Math.min(0.99, n / erwartet) };
      this.dispatchEvent(new CustomEvent('fortschritt', { detail: this.titelAnteil }));
    }
    if (n < 1000) throw new Error(t('Titel {id}: leere Antwort', { id: d.id }));
    // inzwischen entfernt (Sammlung gelöscht, während der Titel lud)? Dann nichts ablegen
    if (this.titel.get(d.id) !== d || !d.in.length) { this.titelAnteil = null; return; }
    const blob = new Blob(teile, { type: 'audio/webm' });
    const c = await caches.open(CACHE);
    await c.put(tonUrl(d.id), new Response(blob, { headers: { 'Content-Type': 'audio/webm', 'Content-Length': String(blob.size) } }));
    if (this.titel.get(d.id) !== d || !d.in.length) { await c.delete(tonUrl(d.id)); this.titelAnteil = null; return; }
    d.bytes = blob.size;
    d.dauer = dauer;
    d.gespeichert = Date.now();
    await this.schreiben('titel', d);
    this.da.add(d.id);
    this.titelAnteil = null;
    if (d.track?.album?.cover) this.coverSpeichern([d.track.album.cover]);
  }

  // ---------- Entfernen ----------
  async entfernen(key) {
    await this.bereit;
    const s = this.sammlungen.get(key);
    if (!s) return;
    this.sammlungen.delete(key);
    this.laufend.delete(key);
    await this.loeschen('sammlungen', key);
    await this.titelLoesen(s.ids, key);
    this.melden(key);
  }

  /** Einzelnen Titel aus „Einzelne Titel“ entfernen */
  async titelEntfernen(id) {
    const s = this.sammlungen.get(EINZELN);
    if (!s) return;
    s.ids = s.ids.filter((x) => x !== id);
    if (s.ids.length) await this.schreiben('sammlungen', s); else { this.sammlungen.delete(EINZELN); await this.loeschen('sammlungen', EINZELN); }
    await this.titelLoesen([id], EINZELN);
    this.melden(EINZELN);
  }

  async titelLoesen(ids, key) {
    const c = await caches.open(CACHE);
    for (const id of ids) {
      const d = this.titel.get(id);
      if (!d) continue;
      d.in = d.in.filter((k) => k !== key);
      if (d.in.length) { await this.schreiben('titel', d); continue; }
      this.titel.delete(id);
      this.da.delete(id);
      this.warteschlange = this.warteschlange.filter((w) => w.id !== id);
      await this.loeschen('titel', id);
      await c.delete(tonUrl(id));
    }
  }

  async allesEntfernen() {
    await this.bereit;
    this.warteschlange = [];
    this.laufend.clear();
    for (const k of [...this.sammlungen.keys()]) { this.sammlungen.delete(k); await this.loeschen('sammlungen', k); }
    for (const id of [...this.titel.keys()]) { this.titel.delete(id); await this.loeschen('titel', id); }
    this.da.clear();
    await caches.delete(CACHE);
    this.melden();
  }

  // ---------- Abgleich mit dem Server ----------
  /**
   * Gespeicherte Alben und Playlists auf den Stand des Servers bringen: neue Titel laden, entfernte freigeben und die
   * Angaben (Titel, Künstler, Cover) aller gespeicherten Titel auffrischen. Läuft beim Start und nach Änderungen.
   */
  async abgleichen() {
    await this.bereit;
    if (!this.db || !navigator.onLine || this._gleicht) return;
    this._gleicht = true;
    try {
      for (const s of [...this.sammlungen.values()]) {
        if (!s.auto || s.art === 'titel') continue;
        let l;
        try { l = await this.listeHolen(s.art, s.id); } catch (e) {
          if (e.status === 404) { await this.entfernen(s.key); this.dispatchEvent(new CustomEvent('hinweis', { detail: t('„{name}“ gibt es nicht mehr – vom Gerät entfernt.', { name: s.titel }) })); }
          continue;
        }
        const neuIds = l.tracks.map((t) => t.id);
        const weg = s.ids.filter((id) => !neuIds.includes(id));
        const dazu = l.tracks.filter((t) => !s.ids.includes(t.id));
        Object.assign(s, { titel: l.titel, unter: l.unter, cover: l.cover, ids: neuIds, stand: l.stand || s.stand });
        await this.schreiben('sammlungen', s);
        if (dazu.length) await this.titelVormerken(dazu, s.key);
        if (weg.length) await this.titelLoesen(weg, s.key);
        // Angaben der übrigen auffrischen
        for (const t of l.tracks) { const d = this.titel.get(t.id); if (d) { d.track = { ...t }; await this.schreiben('titel', d); } }
        this.coverSpeichern([s.cover]);
        if (dazu.length || weg.length) this.melden(s.key);
      }
      // Einzelne Titel: nur die Angaben
      const einzeln = this.sammlungen.get(EINZELN);
      if (einzeln?.ids.length) {
        try {
          const r = await api.post('/bibliothek/frisch', { tracks: einzeln.ids });
          for (const t of r.tracks) { const d = this.titel.get(t.id); if (d) { d.track = { ...d.track, ...t }; await this.schreiben('titel', d); } }
        } catch (e) { /* egal */ }
      }
      this.melden();
      this.abarbeiten();
    } finally { this._gleicht = false; }
  }

  // ---------- Hörverlauf ohne Netz ----------
  /** Wiedergabe merken, die gerade nicht gemeldet werden konnte (wird nachgereicht) */
  verlaufMerken(e) {
    try {
      const l = JSON.parse(localStorage.getItem('aw_verlauf_offen') || '[]');
      const i = l.findIndex((x) => x.lokal === e.lokal);
      if (i >= 0) l[i] = { ...l[i], sekunden: Math.max(l[i].sekunden || 0, e.sekunden || 0), ueberspringen: l[i].ueberspringen || e.ueberspringen };
      else l.push(e);
      localStorage.setItem('aw_verlauf_offen', JSON.stringify(l.slice(-2000)));
    } catch (x) { /* egal */ }
  }

  async verlaufNachreichen() {
    if (this._reicht || !navigator.onLine) return;
    let l;
    try { l = JSON.parse(localStorage.getItem('aw_verlauf_offen') || '[]'); } catch (e) { l = []; }
    if (!l.length) return;
    this._reicht = true;
    try {
      while (l.length) {
        const e = l[0];
        if ((e.sekunden || 0) < 1 && !e.ueberspringen) { l.shift(); this.verlaufAustragen(e.lokal); continue; }
        try {
          const r = await api.post('/wiedergabe', { track_id: e.track_id, ereignis: 'fortschritt', sekunden: e.sekunden || 0, position: e.sekunden || 0, wiedergabe_id: 0, quelle: e.quelle || 'offline', zeit: e.zeit, lokal: e.lokal });
          if (e.ueberspringen && r?.wiedergabe_id) await api.post('/wiedergabe', { track_id: e.track_id, ereignis: 'ueberspringen', sekunden: e.sekunden || 0, wiedergabe_id: r.wiedergabe_id, zeit: e.zeit });
        } catch (x) {
          if (!x.status) break;      // wieder offline – später weiter
        }
        l.shift();
        this.verlaufAustragen(e.lokal);
      }
    } finally { this._reicht = false; }
  }

  /** Einen Eintrag aus dem gespeicherten Verlauf nehmen – frisch gelesen, damit parallel Gemerktes nicht verloren geht */
  verlaufAustragen(lokal) {
    try {
      const l = JSON.parse(localStorage.getItem('aw_verlauf_offen') || '[]').filter((x) => x.lokal !== lokal);
      localStorage.setItem('aw_verlauf_offen', JSON.stringify(l));
    } catch (e) { /* egal */ }
  }
}

export const offline = new Offline();
