// Fernsteuerung: dieses Gerät steuert ein anderes (eigene Geräte; Admins alle) – und lässt sich selbst steuern.
//
// Rückkanal: EventSource auf /api/v1/fern/strom (Befehle an uns, wer uns steuert, Zustand des Ziels). Kein Kanal frei
// oder SSE gestört → alle 2 s nachfragen. Den eigenen Zustand melden wir mit POST /fern/zustand.
//
// Steuert dieses Gerät ein anderes, zeigt die Oberfläche dessen Wiedergabe: fernSicht(player) ist ein Proxy um den
// Player, der Anzeigewerte (Titel, Zeit, Warteschlange, Lautstärke …) vom Ziel liefert und Bedienbefehle (Play, Weiter,
// Album abspielen …) ans Ziel schickt. Der Player selbst (this) bleibt immer der lokale – Befehle, die bei uns
// ankommen, und alles Interne laufen ungestört lokal.
import { api } from './api.js';
import { h, icon, toast } from './ui.js';
// Klang-Blatt fürs Heimnetz (nur Admins, selten): erst beim Aufruf laden
const klangBlattOeffnen = (app, z) => import('./heimnetz.js').then((m) => m.klangBlattOeffnen(app, z));
import { t, zahl } from './i18n.js';

/** Player-Methoden, die im Fernmodus ans Ziel gehen (nur über app.player, also aus der Oberfläche) */
const UMLEITEN = new Set(['umschalten', 'weiter', 'zurueck', 'springenZu', 'springen', 'stoppen', 'abspielen', 'alsNaechstes',
  'anhaengen', 'entfernen', 'zufallUmschalten', 'wiederholenUmschalten', 'lautstaerkeSetzen', 'mischen', 'radioStarten']);
/** Anzeigewerte, die im Fernmodus vom Ziel kommen */
const ANZEIGE = new Set(['track', 'spielt', 'zeit', 'anzeigeZeit', 'dauer', 'liste', 'index', 'modus', 'quelleKontext']);
const LISTE_MAX = 1000;

export function fernSicht(player) {
  return new Proxy(player, {
    get(t, k) {
      const f = t.fern;
      if (f?.aktiv) {
        if (ANZEIGE.has(k)) return f.anzeige(k);
        if (k === 'einst') return f.einstSicht;
        if (UMLEITEN.has(k)) return (...a) => f.umleiten(k, a);
      }
      const v = Reflect.get(t, k, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

/** Sinnbild eines Geräts */
function geraetSymbol(g) {
  const z = g?.zustand;
  if (z?.art === 'windows' || z?.art === 'dlna') return 'anlage';
  if (z?.art === 'cast') return 'radio';
  if (z?.mobil) return /ipad|tablet|tab\b/i.test(g.name || '') ? 'tablet' : 'handy';
  return /android|iphone/i.test(g?.name || '') ? 'handy' : 'computer';
}
const vorZeit = (s) => (s < 90 ? t('vor 1 Min.') : s < 3600 ? t('vor {n} Min.', { n: Math.round(s / 60) }) : s < 86400 ? t('vor {n} Std.', { n: Math.round(s / 3600) }) : t('gestern'));

export class Fernsteuerung extends EventTarget {
  constructor(app, player) {
    super();
    this.app = app;
    this.p = player;           // der echte, lokale Player
    player.fern = this;
    this.ziel = null;          // Geräte-ID, die wir steuern
    this.zielName = '';
    this.zielSym = 'geraete';
    this.z = null;             // Zustand des Ziels (wie gemeldet, ggf. vorläufig geändert)
    this.zBest = null;         // zuletzt vom Ziel bestätigt
    this.l = [];               // Warteschlange des Ziels
    this.online = true;
    this.beobachter = [];      // wer steuert uns
    this.ab = 0; this.zv = -1; this.lv = -1;
    this.geraete = [];
    const p = player;
    this.einstSicht = new Proxy({}, {
      get: (_, k) => {
        const z = this.z;
        if (z) {
          if (k === 'lautstaerke') return typeof z.vol === 'number' ? z.vol : p.einst.lautstaerke;
          if (k === 'zufall') return !!z.zufall;
          if (k === 'wiederholen') return z.wdh || 'aus';
        }
        return p.einst[k];
      },
      set: (_, k, v) => { p.einst[k] = v; return true; },
      has: (_, k) => k in p.einst,
      ownKeys: () => Reflect.ownKeys(p.einst),
      getOwnPropertyDescriptor: (_, k) => { const d = Object.getOwnPropertyDescriptor(p.einst, k); if (d) d.configurable = true; return d; },
    });
    this.eigenesMelden();
    this.kanalOeffnen();
    // Anzeige der Zeit weiterlaufen lassen, solange das Ziel spielt
    setInterval(() => { if (this.aktiv && this.z?.spielt && this.online) this.feuern('zeit'); }, 500);
    document.addEventListener('visibilitychange', () => {
      this.zustandPlanen();
      if (!document.hidden && !this.es && !this._nachfragenTimer) this.kanalOeffnen();
    });
    window.addEventListener('pagehide', () => {
      if (!navigator.sendBeacon) return;
      const fd = new FormData();
      fd.append('csrf_token', document.querySelector('meta[name="csrf-token"]')?.content || '');
      navigator.sendBeacon('/api/v1/fern/weg', fd);
    });
  }

  get aktiv() { return !!this.ziel; }

  // ---------- Rückkanal ----------
  kanalUrl(einmal = false) { return `/fern/strom?ab=${this.ab}&zv=${this.zv}&lv=${this.lv}&bv=${this.bv || ''}${einmal ? '&einmal=1' : ''}`; }

  kanalOeffnen() {
    if (this.app?.offline) return;   // ohne Netz gestartet: kein Rückkanal
    this.es?.close();
    this.es = null;
    clearTimeout(this._nachfragenTimer); this._nachfragenTimer = null;
    if (typeof EventSource === 'undefined' || (this.nachfragenBis || 0) > Date.now()) { this.nachfragen(); return; }
    const es = new EventSource('/api/v1' + this.kanalUrl());
    this.es = es;
    let hallo = false;
    const lesen = (e) => { try { return JSON.parse(e.data); } catch { return null; } };
    es.addEventListener('hallo', (e) => { hallo = true; this.fehler = 0; const d = lesen(e); if (d?.ab) this.ab = d.ab; });
    for (const n of ['befehl', 'beobachter', 'zustand', 'liste', 'online', 'getrennt', 'bib']) es.addEventListener(n, (e) => { const d = lesen(e); if (d) this.ereignis(n, d); });
    es.addEventListener('ende', (e) => {
      const d = lesen(e);
      if (d) { this.ab = d.ab; this.zv = d.zv; this.lv = d.lv; if (d.bv) this.bv = d.bv; }
      es.close();
      if (this.es === es) this.kanalOeffnen();
    });
    es.onerror = () => {
      es.close();
      if (this.es !== es) return;
      this.es = null;
      this.fehler = (this.fehler || 0) + 1;
      // ohne „hallo“ mehrfach gescheitert (alle Kanäle belegt, Proxy puffert): eine Minute lang nachfragen
      if (!hallo && this.fehler >= 2) this.nachfragenBis = Date.now() + 60000;
      setTimeout(() => { if (!this.es) this.kanalOeffnen(); }, Math.min(8000, 700 * this.fehler));
    };
  }

  async nachfragen() {
    clearTimeout(this._nachfragenTimer);
    try {
      const r = await api.get(this.kanalUrl(true));
      this.ab = r.ab; this.zv = r.zv; this.lv = r.lv;
      for (const [n, d] of r.ereignisse || []) this.ereignis(n, d);
    } catch (e) { /* offline – gleich nochmal */ }
    this._nachfragenTimer = setTimeout(() => {
      this._nachfragenTimer = null;
      if ((this.nachfragenBis || 0) > Date.now() || typeof EventSource === 'undefined') this.nachfragen(); else this.kanalOeffnen();
    }, document.hidden ? 4000 : 2000);
  }

  /** Neues Ziel: Zustand von vorn, Kanal neu */
  neuVerbinden() { this.zv = -1; this.lv = -1; this.kanalOeffnen(); }

  ereignis(n, d) {
    if (n === 'bib') {
      // Bibliothek geändert – der erste Stand nach dem Öffnen ist nur der Ausgangspunkt
      const erst = !this.bv;
      this.bv = d.stand;
      if (!erst) this.app.bibliothekGeaendert?.();
      return;
    }
    if (n === 'befehl') { if (d.id > this.ab) this.ab = d.id; this.ausfuehren(d); return; }
    if (n === 'beobachter') {
      const alt = new Set(this.beobachter.map((b) => b.id));
      this.beobachter = Array.isArray(d) ? d : [];
      const neu = this.beobachter.filter((b) => !alt.has(b.id));
      if (neu.length) {
        this._mitListe = true;
        this.zustandPlanen(0);
        for (const b of neu) toast(t('{name} steuert jetzt dieses Gerät', { name: this.werText(b) }));
      }
      this.ui();
      return;
    }
    if (!this.ziel || d.ziel !== this.ziel) return;
    if (n === 'getrennt') {
      // anderswo beendet – meist hat das Ziel selbst uns gewählt (dann steuert es jetzt uns)
      const name = this.zielName;
      this.trennen(false);
      if (!d.neu) toast(t('{name} hat übernommen – du spielst wieder hier', { name }));
      return;
    }
    if (n === 'zustand') {
      const vorher = this.z?.track?.id, vorherListe = this.z?.lv;
      this.z = d.zustand || null;
      this.zBest = this.z ? { ...this.z } : null;
      this.zEmpfang = performance.now();
      this.zAlter = Math.max(0, (d.jetzt || 0) - (this.z?.t || d.jetzt || 0));
      this.wartenEnde();
      const m = this.z?.meldung;
      if (m?.t && m.t !== this._meldungT) { if (this._meldungT !== undefined || Date.now() - m.t < 15000) toast(m.text, 'fehler'); this._meldungT = m.t; }
      if (this.z?.track?.id !== vorher) this.feuern('track');
      if (this.z?.lv !== vorherListe) this.feuern('liste');
      this.feuern('zustand'); this.feuern('zeit'); this.feuern('lautstaerke');
      this.ui();
    } else if (n === 'liste') {
      this.l = Array.isArray(d.liste) ? d.liste : [];
      this.feuern('liste'); this.feuern('track');
    } else if (n === 'online') {
      this.online = !!d.online;
      if (!this.online) this.wartenEnde();
      this.feuern('zustand');
      this.ui();
    }
  }

  feuern(art) { this._feuertSelbst = true; try { this.p.dispatchEvent(new Event(art)); } finally { this._feuertSelbst = false; } }
  werText(v) { return v.fremd && v.nutzer ? `${v.nutzer} (${v.name})` : v.name; }

  // ---------- Anzeige im Fernmodus ----------
  position() {
    const z = this.z;
    if (!z) return 0;
    let s = Number(z.pos) || 0;
    if (z.spielt && this.online) s += (performance.now() - (this.zEmpfang || performance.now()) + (this.zAlter || 0)) / 1000;
    return z.dauer ? Math.min(s, z.dauer) : s;
  }

  anzeige(k) {
    const z = this.z;
    const versatz = z?.versatz || 0;
    switch (k) {
      case 'track': {
        if (!z?.track) return null;
        const t = this.l[(z.index ?? 0) - versatz];
        return t && t.id === z.track.id ? t : z.track;
      }
      case 'spielt': return !!(z?.spielt && this.online);
      case 'zeit': case 'anzeigeZeit': return this.position();
      case 'dauer': return Number(z?.dauer) || 0;
      case 'liste': return this.l.length ? this.l : (z?.track ? [z.track] : []);
      case 'index': return this.l.length ? (z?.index ?? 0) - versatz : (z?.track ? 0 : -1);
      case 'modus': return null;
      case 'quelleKontext': return z?.kontext || null;
      default: return undefined;
    }
  }

  // ---------- Befehle ans Ziel ----------
  umleiten(name, a) {
    const z = this.z || (this.z = {});
    const versatz = z.versatz || 0;
    switch (name) {
      case 'umschalten': z.spielt = !z.spielt; z.pos = this.position(); this.zEmpfang = performance.now(); this.zAlter = 0; return this.senden('pp');
      case 'weiter': return this.senden('weiter');
      case 'zurueck': return this.senden('zurueck');
      case 'springenZu': z.index = (a[0] ?? 0) + versatz; z.pos = 0; return this.senden('springen_zu', a[0]);
      case 'springen': z.pos = Math.max(0, Number(a[0]) || 0); this.zEmpfang = performance.now(); this.zAlter = 0; return this.senden('springen', z.pos);
      case 'stoppen': z.spielt = false; z.pos = 0; return this.senden('stopp');
      case 'zufallUmschalten': z.zufall = !z.zufall; return this.senden('zufall');
      case 'wiederholenUmschalten': z.wdh = { aus: 'alle', alle: 'eins', eins: 'aus' }[z.wdh || 'aus']; return this.senden('wdh');
      case 'entfernen': return this.senden('entfernen', a[0]);
      case 'lautstaerkeSetzen': return this.volSenden(Math.max(0, Math.min(1, Number(a[0]) || 0)));
      case 'mischen': toast(t('Mischen geht nur am Gerät selbst – oder Zufall einschalten')); return undefined;
      case 'radioStarten': toast(t('Radio bitte direkt auf {name} starten', { name: this.zielName })); return undefined;
      case 'abspielen': {
        const [tracks, start = 0, kontext = null] = a;
        const l = (tracks || []).slice(0, LISTE_MAX);
        if (!l.length) return undefined;
        toast(t('Spielt auf {name}', { name: this.zielName }));
        return this.senden('abspielen', { tracks: l, start: Math.min(start, l.length - 1), kontext });
      }
      case 'alsNaechstes': case 'anhaengen': {
        const l = (a[0] || []).filter((t) => t.verfuegbar !== false).slice(0, LISTE_MAX);
        if (!l.length) return undefined;
        toast(name === 'alsNaechstes' ? t('Kommt auf {name} als Nächstes', { name: this.zielName }) : t('Auf {name} angehängt', { name: this.zielName }));
        return this.senden(name === 'alsNaechstes' ? 'naechstes' : 'anhaengen', { tracks: l });
      }
      default: return undefined;
    }
  }

  volSenden(w) {
    if (this.z) this.z.vol = w;
    this.feuern('lautstaerke');
    clearTimeout(this._volTimer);
    const los = () => { this._volZeit = Date.now(); this.senden('vol', w, false); };
    if (Date.now() - (this._volZeit || 0) > 160) los(); else this._volTimer = setTimeout(los, 170);
  }

  async senden(befehl, daten = null, warten = true) {
    if (!this.online) { toast(t('{name} antwortet nicht', { name: this.zielName }), 'fehler'); this.zuruecksetzen(); return; }
    if (warten) {
      // Anzeige gleich ändern, bis das Ziel bestätigt (gedimmt); ohne Antwort zurück auf den alten Stand
      document.documentElement.classList.add('fern-wartet');
      clearTimeout(this._wartenTimer);
      this._wartenTimer = setTimeout(() => { if (this.aktiv) { toast(t('{name} hat nicht geantwortet', { name: this.zielName }), 'fehler'); this.zuruecksetzen(); } }, 3000);
      this.feuern('zustand'); this.feuern('zeit');
    }
    try {
      await api.post('/fern/befehl', { befehl, daten });
    } catch (e) {
      toast(e.message, 'fehler');
      this.zuruecksetzen();
    }
  }

  wartenEnde() { clearTimeout(this._wartenTimer); document.documentElement.classList.remove('fern-wartet'); }
  zuruecksetzen() {
    this.wartenEnde();
    if (this.zBest) { this.z = { ...this.zBest }; this.feuern('zustand'); this.feuern('track'); this.feuern('zeit'); this.feuern('lautstaerke'); }
  }

  // ---------- Ziel wählen ----------
  async wechseln(ziel) {
    this.listeSchliessen();
    ziel = ziel || null;
    if (ziel === this.ziel) return;
    const p = this.p;
    const g = this.geraete.find((x) => x.id === ziel);
    // Spielt hier gerade Musik und wir wählen ein anderes Gerät: die Musik wandert mit (ab derselben Stelle)
    const mitnehmen = ziel && !this.ziel && p.spielt && p.track;
    let r;
    try { r = await api.post('/fern/verbinden', { ziel }); } catch (e) { toast(e.message, 'fehler'); return; }
    if (!ziel) { this.trennen(false); return; }
    this.ziel = ziel;
    this.zielName = r.name || g?.name || t('Gerät');
    this.zielSym = g ? geraetSymbol(g) : 'geraete';
    this.z = null; this.zBest = null; this.l = []; this.online = true;
    if (mitnehmen) {
      const von = Math.max(0, Math.min(p.index - 100, p.liste.length - LISTE_MAX));
      const l = p.liste.slice(von, von + LISTE_MAX);
      try {
        await api.post('/fern/befehl', { befehl: 'abspielen', daten: { tracks: l, start: p.index - von, kontext: p.quelleKontext, ab: Math.round(p.zeit * 10) / 10 } });
        toast(t('Läuft jetzt auf {name}', { name: this.zielName }), 'gut');
      } catch (e) { toast(e.message, 'fehler'); }
    } else toast(t('Du steuerst jetzt {name}', { name: this.zielName }));
    if (p.spielt) p.pausieren();
    this.neuVerbinden();
    this.allesNeu();
  }

  /** Fernsteuerung beenden (melden = auch dem Server sagen) */
  async trennen(melden = true) {
    if (melden) { try { await api.post('/fern/verbinden', { ziel: null }); } catch (e) { /* egal */ } }
    this.ziel = null; this.z = null; this.zBest = null; this.l = []; this.online = true;
    this.wartenEnde();
    this.neuVerbinden();
    this.allesNeu();
  }

  /** „Hierher holen“: Warteschlange und Stelle des Ziels übernehmen, dort pausieren */
  async holen() {
    this.listeSchliessen();
    const z = this.z, name = this.zielName;
    const liste = this.l.length ? this.l : (z?.track ? [z.track] : []);
    const index = this.l.length ? (z?.index ?? 0) - (z?.versatz || 0) : 0;
    const pos = this.position();
    const kontext = z?.kontext ? { ...z.kontext } : null;
    if (kontext) delete kontext.fern;
    if (this.online) api.post('/fern/befehl', { befehl: 'holen' }).catch(() => {});
    await this.trennen(true);
    if (liste.length) {
      this.p.abspielen(liste, Math.max(0, Math.min(index, liste.length - 1)), kontext, pos);
      toast(this.online ? t('Von {name} hierher geholt – dort pausiert', { name }) : t('Weiter ab der letzten bekannten Stelle'), 'gut');
    }
  }

  get admin() { return this.app?.ich?.user?.rolle === 'admin'; }

  allesNeu() { for (const e of ['track', 'liste', 'zustand', 'zeit', 'lautstaerke']) this.feuern(e); this.ui(); }

  // ---------- Befehle an uns ----------
  ausfuehren(d) {
    const p = this.p, x = d.daten, wer = this.werText(d.von || {});
    const max = this.maxVol ?? 1;
    const versatz = this._versatz || 0;
    let zeigen = '';
    switch (d.befehl) {
      case 'play': if (!p.spielt) p.umschalten(); zeigen = t('▶ Weiter'); break;
      case 'pause': p.pausieren(); zeigen = t('❚❚ Pause'); break;
      case 'pp': zeigen = p.spielt ? t('❚❚ Pause') : t('▶ Weiter'); p.umschalten(); break;
      case 'weiter': p.weiter(); zeigen = t('⏭ Nächster Titel'); break;
      case 'zurueck': p.zurueck(); zeigen = t('⏮ Zurück'); break;
      case 'springen': p.springen(Number(x) || 0); break;
      case 'springen_zu': p.springenZu((Number(x) || 0) + versatz); zeigen = t('▶ Titel gewählt'); break;
      case 'stopp': p.stoppen(); zeigen = t('■ Stopp'); break;
      case 'vol': p.lautstaerkeSetzen(Math.min(max, Math.max(0, Number(x) || 0))); p.melden('lautstaerke'); break;
      case 'zufall': p.zufallUmschalten(); break;
      case 'wdh': p.wiederholenUmschalten(); break;
      case 'abspielen':
        if (Array.isArray(x?.tracks) && x.tracks.length) {
          p.abspielen(x.tracks, Number(x.start) || 0, { ...(x.kontext || {}), fern: true }, Number(x.ab) || 0);
          zeigen = `▶ ${x.tracks[Math.min(Number(x.start) || 0, x.tracks.length - 1)]?.titel || t('Abspielen')}`;
        }
        break;
      case 'naechstes': if (Array.isArray(x?.tracks)) p.alsNaechstes(x.tracks); break;
      case 'anhaengen': if (Array.isArray(x?.tracks)) p.anhaengen(x.tracks); break;
      case 'entfernen': p.entfernen((Number(x) || 0) + versatz); break;
      case 'holen': p.pausieren(); toast(t('{wer} hat die Wiedergabe übernommen', { wer })); break;
      default: return;
    }
    if (zeigen) toast(t('{aktion} – von {wer}', { aktion: zeigen, wer }));
    this._mitListe = this._mitListe || ['abspielen', 'naechstes', 'anhaengen', 'entfernen', 'zufall'].includes(d.befehl);
    this.zustandPlanen(120);
  }

  // ---------- Eigener Zustand ----------
  eigenesMelden() {
    const p = this.p;
    const bald = () => this.zustandPlanen();
    for (const e of ['track', 'zustand', 'lautstaerke']) p.addEventListener(e, () => { if (!this._feuertSelbst) bald(); });
    p.addEventListener('liste', () => { if (this._feuertSelbst) return; this._mitListe = true; bald(); });
    p.audio.addEventListener?.('seeked', bald);
    // Drift ausgleichen, solange jemand zusieht; sonst nur ab und zu (Geräteliste der anderen)
    setInterval(() => { if (this.beobachter.length || Date.now() - (this._gemeldet || 0) > 60000) this.zustandMelden(); }, 10000);
    setTimeout(() => this.zustandMelden(), 900);
    // Grenze für Fernsteuerung dieses Geräts (Einstellung „Höchste Lautstärke“)
    api.get('/geraet/einstellungen').then((r) => {
      const m = Number(r?.einstellungen?.fern_max_lautstaerke);
      this.maxVol = m > 0 && m <= 100 ? m / 100 : 1;
    }).catch(() => {});
  }

  zustandPlanen(ms = 220) { clearTimeout(this._zustandTimer); this._zustandTimer = setTimeout(() => this.zustandMelden(), ms); }

  eigenerZustand() {
    const p = this.p;
    const ua = navigator.userActivation;
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches;
    const n = p.liste.length;
    const versatz = n > LISTE_MAX ? Math.max(0, Math.min(p.index - 100, n - LISTE_MAX)) : 0;
    this._versatz = versatz;
    return {
      art: p.nativ ? 'windows' : standalone ? 'pwa' : 'browser',
      mobil: !!p.mobil, sichtbar: !document.hidden,
      aktiviert: ua ? !!ua.hasBeenActive : !!p._gespielt,
      spielt: !!p.spielt, pos: Math.round((p.zeit || 0) * 10) / 10, dauer: Math.round((p.dauer || 0) * 10) / 10,
      vol: Math.round((p.einst.lautstaerke ?? 1) * 1000) / 1000, zufall: !!p.einst.zufall, wdh: p.einst.wiederholen || 'aus',
      index: p.index, anzahl: n, versatz, lv: this._lv || 0,
      track: p.track || null, kontext: p.quelleKontext || null,
      bitgenau: !!(p.nativ && p.audio?.bitgenau),
    };
  }

  async zustandMelden() {
    clearTimeout(this._zustandTimer);
    const z = this.eigenerZustand();
    const body = { zustand: z };
    if (this._mitListe && this.beobachter.length) {
      this._mitListe = false;
      this._lv = (this._lv || 0) + 1;
      z.lv = this._lv;
      body.liste = this.p.liste.slice(z.versatz, z.versatz + LISTE_MAX);
    }
    // Zu groß (riesige Track-Objekte)? Ohne Details melden
    if (JSON.stringify(z).length > 36000) z.track = z.track ? { id: z.track.id, titel: z.track.titel, kuenstler: z.track.kuenstler, album: { titel: z.track.album?.titel, cover: z.track.album?.cover } } : null;
    this._gemeldet = Date.now();
    try { await api.post('/fern/zustand', body); } catch (e) { /* nächste Meldung */ }
  }

  // ---------- Oberfläche ----------
  /** Knöpfe, Streifen und Marken in Player-Leiste und „Läuft gerade“ auf den Stand bringen */
  ui() {
    const fern = this.aktiv, off = fern && !this.online;
    const n = this.beobachter.length;
    const steuernde = this.beobachter.map((b) => this.werText(b)).join(', ');
    document.querySelectorAll('[data-fern]').forEach((b) => {
      b.classList.toggle('fern-an', fern);
      b.classList.toggle('fern-off', off);
      b.classList.toggle('fern-gesteuert', !fern && n > 0);
      const gross = b.dataset.fern === 'gross';
      b.innerHTML = fern
        ? `<span class="fern-punkt"></span>${icon(this.zielSym, gross ? 18 : 17)}<span class="fern-name">${h(this.zielName)}</span>`
        : `${icon('geraete', gross ? 21 : 19)}${n ? `<span class="fern-zahl">${n}</span>` : ''}`;
      b.title = fern ? t('Du steuerst {name}', { name: this.zielName }) + (off ? ' – ' + t('nicht erreichbar') : '') + ' · ' + t('Klick: Gerät wählen') : n ? t('Gesteuert von {wer} · Klick: Gerät wählen', { wer: steuernde }) : t('Wiedergabe auf … (anderes Gerät steuern)');
      b.setAttribute('aria-label', b.title);
    });
    document.querySelectorAll('[data-fern-band]').forEach((el) => {
      el.hidden = !fern;
      if (!fern) return;
      el.classList.toggle('warn', off);
      el.innerHTML = `${icon(this.zielSym, 15)}<span>${off ? t('{name} nicht erreichbar', { name: h(this.zielName) }) : t('Spielt auf {name}', { name: h(this.zielName) })}</span>
        ${(this.z?.art === 'dlna' || this.z?.art === 'cast') && !off ? `<span class="fern-klang">${this.z?.vol_text ? h(this.z.vol_text) : ''}${this.z?.klang?.weg === 'effekte' ? ` · ${t('Effekte')}` : this.z?.bitgenau ? ` · ${t('bitgenau')}` : ''}</span>${this.admin ? `<button type="button" data-fern-klang>${icon('regler', 14)}${t('Klang')}</button>` : ''}` : ''}
        ${off ? `<button type="button" data-fern-holen>${icon('holen', 14)}${t('Hierher holen')}</button>` : `<button type="button" data-fern-trennen>${t('Trennen')}</button>`}`;
      el.querySelector('[data-fern-klang]')?.addEventListener('click', () => klangBlattOeffnen(this.app, this.z));
      el.querySelector('[data-fern-holen]')?.addEventListener('click', () => this.holen());
      el.querySelector('[data-fern-trennen]')?.addEventListener('click', () => this.trennen());
    });
    document.querySelectorAll('[data-fern-marke]').forEach((el) => {
      const text = fern ? t('auf {name}', { name: this.zielName }) : n ? t('gesteuert von {wer}', { wer: steuernde }) : '';
      el.hidden = !text;
      el.innerHTML = text ? `${icon(fern ? this.zielSym : 'geraete', 13)}${h(text)}` : '';
    });
    document.documentElement.classList.toggle('fern-modus', fern);
    // Lautstärke des Ziels: bitgenau → am Verstärker regeln
    const sperre = fern && !!this.z?.bitgenau && this.z?.art !== 'dlna' && this.z?.art !== 'cast';
    document.querySelectorAll('[data-vol], [data-vol-jetzt]').forEach((v) => {
      v.disabled = sperre;
      v.title = sperre ? t('{name} spielt bitgenau – Lautstärke dort am Verstärker', { name: this.zielName }) : fern ? t('Lautstärke von {name}', { name: this.zielName }) : '';
    });
    this.dispatchEvent(new Event('ui'));
  }

  // ---------- Geräteliste „Wiedergabe auf“ ----------
  async listeOeffnen(anker) {
    if (this.wahl) { this.listeSchliessen(); return; }
    const el = document.createElement('div');
    const blatt = matchMedia('(max-width: 700px)').matches;
    el.className = `fern-wahl${blatt ? ' blatt' : ''}`;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', t('Wiedergabe auf'));
    el.innerHTML = `${blatt ? '<div class="fw-griff"></div>' : ''}<h4><span>${t('Wiedergabe auf')}</span><span data-fw-zahl></span></h4><div class="fw-liste" data-fw-liste><div class="lade" style="padding:14px"></div></div><div data-fw-fuss></div>`;
    this.wahl = el;
    this.wahlAnker = anker;
    if (blatt) {
      const hg = document.createElement('div');
      hg.className = 'fern-hg';
      hg.addEventListener('click', () => this.listeSchliessen());
      document.body.appendChild(hg);
      this.wahlHg = hg;
    }
    document.body.appendChild(el);
    if (!blatt && anker) this.wahlPlatzieren();
    anker?.setAttribute('aria-expanded', 'true');
    this._wahlAussen = (e) => { if (!el.contains(e.target) && !anker?.contains(e.target)) this.listeSchliessen(); };
    this._wahlTaste = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.listeSchliessen(); } };
    setTimeout(() => { document.addEventListener('pointerdown', this._wahlAussen, true); document.addEventListener('keydown', this._wahlTaste, true); }, 0);
    await this.listeLaden();
    this._wahlTimer = setInterval(() => { if (!el.querySelector('input:active') && document.activeElement?.type !== 'range') this.listeLaden(); }, 3000);
  }

  wahlPlatzieren() {
    const el = this.wahl, r = this.wahlAnker.getBoundingClientRect();
    const w = Math.min(380, innerWidth - 24);
    el.style.width = `${w}px`;
    el.style.left = `${Math.max(12, Math.min(innerWidth - w - 12, r.right - w))}px`;
    if (r.top > innerHeight / 2) { el.style.bottom = `${innerHeight - r.top + 10}px`; el.style.top = 'auto'; el.style.maxHeight = `${r.top - 24}px`; }
    else { el.style.top = `${r.bottom + 10}px`; el.style.bottom = 'auto'; el.style.maxHeight = `${innerHeight - r.bottom - 24}px`; }
  }

  listeSchliessen() {
    const el = this.wahl;
    if (!el) return;
    this.wahl = null;
    clearInterval(this._wahlTimer);
    document.removeEventListener('pointerdown', this._wahlAussen, true);
    document.removeEventListener('keydown', this._wahlTaste, true);
    this.wahlAnker?.setAttribute('aria-expanded', 'false');
    el.classList.add('raus');
    this.wahlHg?.classList.add('raus');
    const hg = this.wahlHg; this.wahlHg = null;
    setTimeout(() => { el.remove(); hg?.remove(); }, 160);
  }

  async listeLaden() {
    let r;
    try { r = await api.get('/fern/geraete'); } catch (e) { if (this.wahl) this.wahl.querySelector('[data-fw-liste]').innerHTML = `<p class="fw-leer">${h(e.message)}</p>`; return; }
    this.geraete = r.geraete || [];
    if (r.ziel !== this.ziel && !r.ziel && this.ziel) { /* Server weiß nichts mehr davon (z. B. übernommen) */ this.trennen(false); }
    if (!this.wahl) return;
    this.listeZeichnen(r);
  }

  listeZeichnen(r) {
    const el = this.wahl;
    const ich = r.ich;
    const zeile = (g) => {
      const z = g.zustand;
      const an = g.ich ? !this.ziel : g.id === this.ziel;
      const waehlbar = g.ich || g.steuerbar;
      let info;
      if (!g.online) info = `<small class="warn">${t('nicht erreichbar · zuletzt {zeit}', { zeit: vorZeit(g.alter_sek) })}</small>`;
      else if (!g.ich && g.grund) info = `<small class="warn">${h(g.grund)}</small>`;
      else if (g.heim && z?.art === 'cast') info = `<small${z?.spielt && z.titel ? ' class="gut"' : ''}>${z?.spielt && z.titel ? `▶ ${h(z.titel)} · ` : ''}Google Cast${z.eingang && z.eingang !== 'Amberwave' ? ` · ${t('läuft: {was}', { was: h(z.eingang) })}` : ''}${g.klang === 'effekte' ? ` · ${t('Effekte')}` : ''}</small>`;
      else if (g.heim) info = `<small${z?.spielt && z.titel ? ' class="gut"' : ''}>${z?.spielt && z.titel ? `▶ ${h(z.titel)} · ` : ''}DLNA${z?.steuerung ? ` · ${z.an === false ? t('Standby') : z.an ? t('an') : ''}${z.an && z.eingang ? ` · ${h(z.eingang)}` : ''}` : ''}${g.klang === 'effekte' ? ` · ${t('Effekte')}` : ''}</small>`;
      else if (z?.spielt && z.titel) info = `<small class="gut">▶ ${h(z.titel)}${z.kuenstler ? ` · ${h(z.kuenstler)}` : ''}</small>`;
      else info = `<small>${z?.art === 'windows' ? 'Windows Client' : z?.art === 'pwa' ? 'App' : 'Browser'}${z?.titel ? ` · ${t('pausiert')} · ${h(z.titel)}` : ` · ${t('bereit')}`}</small>`;
      const marke = an ? (g.ich ? t('spielt hier') : t('du steuerst')) : g.steuert === ich ? t('steuert dich') : g.gesteuert_von.length ? t('gesteuert') : '';
      const vol = g.ich ? this.p.einst.lautstaerke : z?.vol;
      const volAn = g.online && (g.ich || g.steuerbar) && typeof vol === 'number';
      const gesperrt = !g.ich && z?.bitgenau && !g.heim;
      return `<div class="fw-z${an ? ' an' : ''}${waehlbar ? '' : ' aus'}" ${waehlbar ? `data-fw-ziel="${g.ich ? '' : g.id}" role="button" tabindex="0"` : ''}>
        <span class="fw-sym">${icon(g.ich ? geraetSymbol({ ...g, zustand: { ...(z || {}), art: this.p.nativ ? 'windows' : z?.art, mobil: this.p.mobil } }) : geraetSymbol(g), 20)}${z?.spielt && g.online ? '<span class="fw-eq"><i></i><i></i><i></i></span>' : ''}</span>
        <span class="fw-tx"><b>${g.ich ? t('Dieses Gerät') : h(g.name)}</b>${info}</span><em>${marke}</em>
        ${volAn ? `<div class="fw-vol">${icon('lautstaerke', 14)}<input type="range" class="regler" min="0" max="${g.ich ? 100 : g.max_vol || 100}" step="1" value="${Math.round(vol * 100)}" data-fw-vol="${g.ich ? '' : g.id}" ${gesperrt ? `disabled title="${h(t('bitgenau – Lautstärke dort am Verstärker'))}"` : ''} aria-label="${g.ich ? t('Lautstärke hier') : t('Lautstärke {name}', { name: h(g.name) })}" style="--wert:${Math.round(vol * 100)}%"><span>${gesperrt ? t('bitgenau') : g.heim && z?.vol_text ? h(z.vol_text) : `${Math.round(vol * 100)} %`}</span></div>` : ''}
      </div>`;
    };
    // eigene zuerst, dann (Admins) je Person
    const gruppen = new Map();
    for (const g of r.geraete) {
      const k = g.besitzer.ich ? '' : g.besitzer.name;
      if (!gruppen.has(k)) gruppen.set(k, []);
      gruppen.get(k).push(g);
    }
    let html = '';
    // eigene, dann die Geräte im Heimnetz, dann andere Personen
    const reihe = [...gruppen].sort(([a, la], [b, lb]) => (a === '' ? 0 : la[0].heim ? 1 : 2) - (b === '' ? 0 : lb[0].heim ? 1 : 2));
    for (const [name, l] of reihe) {
      if (name) html += `<div class="fw-person">${h(name)}</div>`;
      html += l.map(zeile).join('');
    }
    el.querySelector('[data-fw-liste]').innerHTML = html || `<p class="fw-leer">${t('Noch keine anderen Geräte – Amberwave auf einem zweiten Gerät öffnen.')}</p>`;
    el.querySelector('[data-fw-zahl]').textContent = t('{n} online', { n: zahl(r.geraete.filter((g) => g.online).length) });
    el.querySelector('[data-fw-fuss]').innerHTML = `${this.ziel ? `<button type="button" class="fw-holen" data-fw-holen>${icon('holen', 16)}${t('Hierher holen – hier weiterhören')}</button>` : ''}
      <p class="fw-hinweis">${r.admin ? t('Als Admin siehst und steuerst du alle Geräte.') : t('Nur Geräte deines Kontos.')} ${t('Spielt hier gerade Musik, wandert sie aufs gewählte Gerät mit.')}</p>`;
    el.querySelectorAll('[data-fw-ziel]').forEach((z) => {
      const los = (e) => { if (e.target.closest('.fw-vol')) return; this.wechseln(Number(z.dataset.fwZiel) || null); };
      z.addEventListener('click', los);
      z.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); los(e); } });
    });
    el.querySelector('[data-fw-holen]')?.addEventListener('click', () => this.holen());
    el.querySelectorAll('[data-fw-vol]').forEach((v) => {
      const id = Number(v.dataset.fwVol) || null;
      const anzeigen = () => { v.style.setProperty('--wert', `${v.value}%`); v.nextElementSibling.textContent = `${v.value} %`; };
      v.addEventListener('input', () => {
        anzeigen();
        const w = v.value / 100;
        if (!id) { this.p.lautstaerkeSetzen(w); this.p.melden('lautstaerke'); }
        else if (id === this.ziel) this.volSenden(w);
      });
      v.addEventListener('change', () => {
        if (id && id !== this.ziel) api.post('/fern/befehl', { ziel: id, befehl: 'vol', daten: v.value / 100 }).catch((e) => toast(e.message, 'fehler'));
      });
    });
    if (this.wahlAnker && !this.wahl.classList.contains('blatt')) this.wahlPlatzieren();
  }
}

/** Kurztext für die Anzeige „Spielt auf …“ (z. B. im Nutzer-Menü) */
export const fernText = (f) => (f?.aktiv ? t('Steuert {name}', { name: f.zielName }) : '');
