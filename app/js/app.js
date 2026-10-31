// Amberwave – Single-Page-App. Die Musik läuft beim Navigieren weiter, weil die Seite nie neu lädt.
import { api, csrfSetzen } from './api.js';
import { t } from './i18n.js';
import { h, icon, initialen, menue, menueSchliessen, toast } from './ui.js';
import { Player } from './player.js';
import { PlayerLeiste } from './playerleiste.js';
import { Fernsteuerung, fernSicht } from './fernsteuerung.js';
import { ansichten, aktionenRegistrieren, albumCacheLeeren } from './ansichten.js';

// Wie eine App: Safari auf iPhone/iPad ignoriert „user-scalable=no“ – Zwei-Finger-Zoom dort per Geste abfangen
document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
import { scanLeisteStarten } from './scanleiste.js';
import { auswahlStarten } from './auswahl.js';
import { eqNormal } from './eq.js';
import { waermeNormal } from './waerme.js';
import { bandNormal } from './band.js';
import { trafoNormal } from './trafo.js';
import { reiheNormal } from './raumklang.js';
import { netzweg } from './netzweg.js';
import { scrollSetzen, gemerkt } from './merker.js';
import { falzBeobachten } from './falz.js';
import { zoomSperren } from './zoomsperre.js';
import { nativ, ausgabeWeg } from './nativ.js';
import { android, androidRufen, androidVersion } from './android.js';

// Windows-Client passend zur Server-Version: Installer aus dem GitHub-Release derselben Version (Name wie vom Build-Skript)
const istWindowsDesktop = () => !nativ && (navigator.userAgentData?.platform === 'Windows' || /Windows NT/.test(navigator.userAgent)) && !/Mobile|Android/i.test(navigator.userAgent);
// Android-App passend zur Server-Version (APK aus dem GitHub-Release) – nur im Browser am Android-Gerät anbieten
const istAndroidBrowser = () => !android && /Android/i.test(navigator.userAgent);
function apkDownload(version) {
  const v = String(version || '');
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(v) ? `https://github.com/lfrank95/amberwave/releases/download/v${v}/Amberwave-Android-${v}.apk` : '';
}
function clientDownload(version) {
  const v = String(version || '');
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(v) ? `https://github.com/lfrank95/amberwave/releases/download/v${v}/Amberwave-Windows-Client-${v}.exe` : '';
}
import { offlineEinrichten, offlineMarkieren, offlineAn, offlineSammlung } from './offline_ui.js';
import { offline, offlineWunsch } from './offline.js';
import { symbolSvg, symbolVon, ausgangName, treiberVon } from './ausgaenge.js';

/** Bereich einer Listen-Seite (bestimmt den aktiven Navigationspunkt) – Detailseiten liefern null */
function bereichVon(pfad) {
  if (/^\/(alben|kuenstler|playlists)\/\d+$/.test(pfad)) return null;
  if (pfad === '/') return '/';
  return '/' + pfad.split('/')[1];
}
/** Wenn nichts geerbt werden kann (Seite direkt aufgerufen): der naheliegende Bereich */
function naturBereich(pfad) {
  return '/' + pfad.split('/')[1];
}

// Falt-Handys und Phablets: Kopf, Player und Reiter in zwei Hälften (CSS: html.zwei-haelften) – siehe falz.js
falzBeobachten();
zoomSperren();

// Große, selten gebrauchte Teile (Verwaltung 240 KB, Einstellungen 100 KB samt Anhang) erst laden, wenn sie aufgerufen werden –
// der Start lädt und übersetzt dann ein Drittel weniger Skript
const verwaltung = () => import('./verwaltung.js');
const einstellungen = () => import('./einstellungen.js');
const vw = (name) => (ctx) => verwaltung().then((m) => m.verwaltungsAnsichten[name](ctx));
const einstellungenAnsicht = (ctx) => einstellungen().then((m) => m.einstellungenAnsicht(ctx));

class App {
  constructor() {
    this.wurzel = document.getElementById('app');
    this.name = this.wurzel.dataset.appName || 'Amberwave';
    this.ich = null;
    this.aktuell = null;
    this.abbruch = null;
    this.scrollPos = new Map();
    this.listenSeiten = new Map(); // Adresse → Zahl der geladenen Listenseiten (für „Weitere laden“ nach Neuaufbau/Zurück)
  }

  async start() {
    // Startseite: ihre Daten schon holen, während /ich und der Aufbau laufen (spart im Mobilnetz eine volle Laufzeit)
    if (location.pathname === '/' && navigator.onLine !== false) { try { api.vorab('/start'); } catch (e) { /* egal */ } }
    try {
      // /ich liegt schon in der Seite (index.php kennt den Nutzer) – spart die erste Laufzeit; sonst wie bisher holen
      let eingebettet = null;
      try { const el = document.getElementById('aw-ich'); if (el) { if (!document.documentElement.dataset.awHuelle) eingebettet = JSON.parse(el.textContent || 'null'); el.remove(); } } catch (x) { eingebettet = null; }
      this.ich = eingebettet?.user ? eingebettet : await api.get('/ich');
      csrfSetzen(this.ich.csrf);
      // Konto für den Offline-Start merken – ohne Schlüssel (CSRF, Direktzugang) und E-Mail; anderes Konto als zuletzt:
      // was der Vorgänger auf diesem Gerät gespeichert hat, gehört ihm, nicht dem neuen Konto
      try {
        const alt = JSON.parse(localStorage.getItem('aw_ich') || 'null');
        if (alt?.user?.id && alt.user.id !== this.ich.user.id) { localStorage.removeItem('aw_verlauf_offen'); offline.bereit.then(() => offline.allesEntfernen()).catch(() => {}); }
        const { csrf, direkt, ...rest } = this.ich;
        localStorage.setItem('aw_ich', JSON.stringify({ ...rest, user: { ...rest.user, email: undefined } }));
      } catch (x) { /* egal */ }
    } catch (e) {
      // Kein Netz (Server nicht erreichbar, keine Antwort): mit dem zuletzt bekannten Konto offline starten – es spielt,
      // was auf diesem Gerät gespeichert ist
      let gemerkt = null;
      try { gemerkt = JSON.parse(localStorage.getItem('aw_ich') || 'null'); } catch (x) { /* egal */ }
      if (gemerkt && !e.status && offlineAn()) {
        await offline.bereit;
        this.ich = gemerkt;
        this.offline = true;
        document.documentElement.classList.add('app-offline');
      } else {
        this.wurzel.innerHTML = `<div class="leer"><h3>${h(t('{name} ist gerade nicht erreichbar', { name: this.name }))}</h3><p>${h(e.message)}</p><p><a href="/">${t('Neu laden')}</a></p></div>`;
        return;
      }
    }
    // Direktzugang im Heimnetz: sofort prüfen, ob die Direktadresse antwortet (höchstens 1,5 s)
    netzweg.einrichten(this.ich.direkt);
    const player = new Player(this);
    // app.player zeigt im Fernmodus das gesteuerte Gerät und schickt Bedienbefehle dorthin (siehe fernsteuerung.js)
    this.player = fernSicht(player);
    this.fern = new Fernsteuerung(this, player);
    this.geruestBauen();
    this.leiste = new PlayerLeiste(this, this.player);
    aktionenRegistrieren(this);
    offlineEinrichten(this);
    auswahlStarten();
    this.klicksAbfangen();
    window.addEventListener('popstate', () => this.navigieren(location.pathname + location.search, false));
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    this.navigieren(location.pathname + location.search, false);
    if (this.ich.user.rolle === 'admin' && !this.offline) scanLeisteStarten();   // nach der Einrichtung: Hinweis, solange das erste Einlesen läuft
    if (this.ich.user.rolle === 'admin' && !this.offline) setTimeout(() => verwaltung().then((m) => m.flacWachtStarten()), 6000);   // erst, wenn der Start durch ist (lädt das Verwaltungs-Stück nach)   // läuft noch eine FLAC-Umwandlung? Ende dann melden
    // Zahl am Menüpunkt „Downloads“ aktuell halten (nur wenn eingeschaltet und die Seite sichtbar ist)
    setInterval(() => { if (!document.hidden && this.ich?.admin?.download_reiter && location.pathname !== '/downloads') this.zaehlerAktualisieren(); }, 60000);
    // Android-App: ohne Service Worker – die Oberfläche für den Start ohne Netz hält die App selbst
    if (android) this.huelleVorladen();
    else if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(() => this.huelleVorladen()).catch(() => {});
    // Netz weg oder wieder da: selbst zwischen Online- und Offline-Ansicht wechseln (Android-App meldet es zusätzlich nativ)
    this.offlineGestartet = !!this.offline;
    window.addEventListener('online', () => this.wiederOnline());
    window.addEventListener('offline', () => this.netzPruefen());
    window.addEventListener('aw-netz', (e) => { if (e.detail) this.wiederOnline(); else this.netzPruefen(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !this.offline && navigator.onLine === false) this.netzPruefen(); });
    if (this.offline) { this.offlineUhr = setInterval(() => { if (!document.hidden) this.wiederOnline(); }, 20000); androidRufen('offlineMelden', '1'); return; }
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); this.installHinweis = e; });
    // Einmal je Browser: am Windows-PC auf den Windows-Client hinweisen (Download im Profilmenü)
    if (istWindowsDesktop() && clientDownload(this.ich.app.version)) {
      let gezeigt = false;
      try { gezeigt = localStorage.getItem('aw-winclient-hinweis') === '1'; localStorage.setItem('aw-winclient-hinweis', '1'); } catch (e) { gezeigt = true; }
      if (!gezeigt) setTimeout(() => toast(t('Für den besten Klang am PC gibt es den Windows-Client (bitgenau, ASIO, VST) – Download im Profilmenü oben rechts.'), 'info', 9000), 4000);
    }
    // Einmal je Browser: am Android-Gerät auf die App hinweisen (Offline-Musik als Dateien, Wiedergabe im Hintergrund)
    if (istAndroidBrowser() && apkDownload(this.ich.app.version)) {
      let gezeigt = false;
      try { gezeigt = localStorage.getItem('aw-android-hinweis') === '1'; localStorage.setItem('aw-android-hinweis', '1'); } catch (e) { gezeigt = true; }
      if (!gezeigt) setTimeout(() => toast(t('Es gibt Amberwave als Android-App – Musik bleibt offline sicher auf dem Handy und spielt im Hintergrund weiter. Download im Profilmenü.'), 'info', 9000), 4000);
    }
    // Geräte-Einstellungen vom Server übernehmen (z. B. nach Neuinstallation)
    // Die Qualität ist pro Gerät gemerkt: der Server-Stand gilt, sonst wird der Stand dieses Browsers hochgeladen
    api.get('/geraet/einstellungen').then((r) => {
      const e = r?.einstellungen || {};
      const pl = this.player;
      const neu = {};
      for (const b of ['heim', 'unterwegs']) {
        const k = `qualitaet_${b}`;
        if (typeof e[k] === 'string') pl.einst[k] = e[k];
        else neu[k] = pl.einst[k];
      }
      if (typeof e.lueckenlos === 'boolean') pl.einst.lueckenlos = e.lueckenlos;
      if (typeof e.lueckenlos_vorrang === 'boolean') pl.einst.lueckenlos_vorrang = e.lueckenlos_vorrang;
      if (typeof e.raumklang === 'string') pl.einst.raumklang = e.raumklang;
      if (typeof e.raumklang_letzt === 'string') pl.einst.raumklang_letzt = e.raumklang_letzt;
      if (typeof e.pegel === 'boolean') pl.einst.pegel = e.pegel;
      if (e.lautheit === 'aus' || e.lautheit === 'auto') pl.einst.lautheit = e.lautheit;
      if (typeof e.lautheit_ziel === 'number' && e.lautheit_ziel >= -30 && e.lautheit_ziel <= -10) pl.einst.lautheit_ziel = e.lautheit_ziel;
      if (e.eq && typeof e.eq === 'object') { pl.einst.eq = eqNormal(e.eq); pl.raumklang.eqSetzen(pl.einst.eq); }
      if (Array.isArray(e.reihe)) { pl.einst.reihe = reiheNormal(e.reihe); pl.raumklang.reiheSetzen(pl.einst.reihe); }
      else if (e.eq_vorne === true) { pl.reiheSetzen(['eq', ...pl.einst.reihe.filter((x) => x !== 'eq')]); }
      if (e.waerme && typeof e.waerme === 'object') { pl.einst.waerme = waermeNormal(e.waerme); pl.raumklang.waermeSetzen(pl.einst.waerme); }
      if (e.band && typeof e.band === 'object') { pl.einst.band = bandNormal(e.band); pl.raumklang.bandSetzen(pl.einst.band); }
      if (e.trafo && typeof e.trafo === 'object') { pl.einst.trafo = trafoNormal(e.trafo); pl.raumklang.trafoSetzen(pl.einst.trafo); }
      if (typeof e.raumklang_ir === 'string') { pl.einst.raumklang_ir = e.raumklang_ir; pl.raumklang.irWahl = e.raumklang_ir; }
      if (e.raumklang_fein && typeof e.raumklang_fein === 'object') { pl.einst.raumklang_fein = e.raumklang_fein; pl.raumklang.feinSetzen(e.raumklang_fein); }
      if (typeof e.offline_qualitaet === 'string') { pl.einst.offline_qualitaet = e.offline_qualitaet; offlineWunsch(e.offline_qualitaet); }
      if (typeof e.qualitaet === 'string' && typeof e.qualitaet_unterwegs !== 'string' && e.qualitaet !== 'auto') { pl.einst.qualitaet_unterwegs = e.qualitaet; neu.qualitaet_unterwegs = e.qualitaet; }
      pl.einstSpeichern();
      if (Object.keys(neu).length) api.put('/geraet/einstellungen', { einstellungen: neu }).catch(() => {});
      this.leiste?.aktualisieren?.();
    }).catch(() => {});
  }

  /** Damit die App ohne Netz startet: alle Dateien der Oberfläche einmal in den Service Worker (je Version einmal) */
  async huelleVorladen() {
    if (this.offline || !offlineAn()) return;
    const urls = new Set(['/img/logo.svg', '/fonts/manrope-latin-v1.woff2', '/fonts/spacegrotesk-latin-v1.woff2', '/fonts/manrope-latin-ext-v1.woff2', '/fonts/spacegrotesk-latin-ext-v1.woff2']);
    try { Object.values(JSON.parse(document.querySelector('script[type=importmap]')?.textContent || '{}').imports || {}).forEach((u) => urls.add(u)); } catch (e) { /* egal */ }
    // gebündelte Oberfläche: Einstieg, vorgeladene Stücke und die nachladbaren Stücke (Verwaltung, Einstellungen …)
    document.querySelectorAll('link[rel=modulepreload], script[type=module][src]').forEach((l) => { const u = new URL(l.href || l.src, location.href); if (u.origin === location.origin) urls.add(u.pathname + u.search); });
    document.querySelectorAll('meta[name="aw-buendel"]').forEach((m) => m.content.split(' ').forEach((u) => u && urls.add(u)));
    document.querySelectorAll('link[rel=stylesheet]').forEach((l) => { const u = new URL(l.href, location.href); if (u.origin === location.origin) urls.add(u.pathname + u.search); });
    document.querySelectorAll('meta[name^="aw-worklet-"]').forEach((m) => { if (m.content.startsWith('/')) urls.add(m.content); });
    const stand = [...urls].sort().join('|');
    try { if (localStorage.getItem('aw_huelle') === stand) return; } catch (e) { /* egal */ }
    if (android) androidRufen('huelleVorladen', [...urls]);
    else (await navigator.serviceWorker.ready).active?.postMessage({ art: 'vorladen', urls: [...urls] });
    try { localStorage.setItem('aw_huelle', stand); } catch (e) { /* egal */ }
  }

  /** Antwortet der Server? (kurz – unterwegs zählt jede Sekunde) */
  async serverDa(ms = 4000) {
    try { const r = await fetch('/api/v1/ping', { cache: 'no-store', signal: AbortSignal.timeout(ms) }); return r.ok; } catch (e) { return false; }
  }

  /** Netz weg? Zweimal nachfragen (ein kurzer Aussetzer im Tunnel zählt nicht), dann in die Offline-Ansicht */
  async netzPruefen() {
    if (this.offline || this._pruefeNetz || !offlineAn()) return;
    this._pruefeNetz = true;
    try {
      if (await this.serverDa()) return;
      await new Promise((r) => setTimeout(r, 3000));
      if (await this.serverDa()) return;
      this.offlineWechseln();
    } finally { this._pruefeNetz = false; }
  }

  /** Während des Betriebs offline gehen: Musik läuft weiter (ab jetzt vom Gerät), Ansicht zeigt das Gespeicherte */
  offlineWechseln() {
    if (this.offline) return;
    this.offline = true;
    document.documentElement.classList.add('app-offline');
    androidRufen('offlineMelden', '1');
    toast(t('Kein Netz – Amberwave zeigt jetzt, was auf diesem Gerät gespeichert ist.'));
    const pfad = location.pathname;
    this.navigieren(/^\/(alben|playlists)\/\d+$/.test(pfad) ? pfad : '/offline');
    clearInterval(this.offlineUhr);
    this.offlineUhr = setInterval(() => { if (!document.hidden) this.wiederOnline(); }, 20000);
  }

  /** Netz wieder da: offline gestartet → neu verbinden (sofort, wenn gerade nichts läuft); erst unterwegs offline
   *  gegangen → ohne Neuladen zurück in die normale Ansicht */
  async wiederOnline() {
    if (!this.offline || this._pruefeOnline) return;
    this._pruefeOnline = true;
    try { if (!await this.serverDa()) return; } finally { this._pruefeOnline = false; }
    if (!this.offline) return;
    if (!this.offlineGestartet) {
      this.offline = false;
      document.documentElement.classList.remove('app-offline');
      androidRufen('offlineMelden', '0');
      clearInterval(this.offlineUhr);
      this.offlineUhr = null;
      toast(t('Wieder online'));
      this.navigieren(location.pathname + location.search, false);
      offline.verlaufNachreichen();
      offline.abgleichen();
      return;
    }
    androidRufen('offlineMelden', '0');
    if (!this.player?.spielt) { location.reload(); return; }
    if (this._onlineGezeigt) return;
    this._onlineGezeigt = true;
    toast(t('Wieder Netz – nach diesem Titel verbindet sich Amberwave neu.'));
    this.player.addEventListener('track', () => location.reload(), { once: true });
  }

  geruestBauen() {
    const u = this.ich.user;
    const admin = u.rolle === 'admin';
    const warten = this.ich.admin?.wartende_konten || 0;
    const navPunkt = (pfad, ico, text, badge = 0) =>
      `<a href="${pfad}" data-link data-nav="${pfad}">${icon(ico, 18)}<span class="l">${h(text)}</span>${badge ? `<span class="badge">${badge}</span>` : ''}</a>`;
    this.wurzel.innerHTML = `
      <header class="kopf">
        <a class="logo" href="/" data-link aria-label="${h(this.name)} – ${t('Start')}"><img src="/img/logo.svg" alt="" width="34" height="34"><span>${h(this.name)}</span></a>
        <button type="button" class="zurueck-knopf" data-zurueck-nav aria-label="${t('Zurück')}" title="${t('Zurück')}" hidden>${icon('zurueckPfeil', 20)}</button>
        <nav class="haupt-nav" aria-label="${t('Hauptmenü')}">
          ${navPunkt('/', 'start', t('Start'))}
          ${navPunkt('/alben', 'alben', t('Alben'))}
          ${navPunkt('/kuenstler', 'kuenstler', t('Künstler'))}
          ${navPunkt('/playlists', 'playlists', t('Playlists'))}
          ${admin && this.ich.admin?.download_reiter ? navPunkt('/downloads', 'download', t('Downloads'), this.ich.admin.downloads_laufen) : ''}
          ${admin ? navPunkt('/verwaltung', 'verwaltung', t('Verwaltung'), warten) : ''}
        </nav>
        <form class="kopf-suche" role="search" data-kopf-suche>
          ${icon('suche', 18)}
          <input type="search" name="q" placeholder="${t('Album, Künstler, Titel, Produzent …')}" aria-label="${t('Suchen')}" autocomplete="off" enterkeyhint="search">
          <div class="vorschlag" hidden></div>
        </form>
        <span class="kopf-ort" data-kopf-ort aria-hidden="true"></span>
        <div class="kopf-rechts">
          <a href="/einstellungen" data-link data-nav="/einstellungen" class="kopf-zahnrad" aria-label="${t('Einstellungen')}" title="${t('Einstellungen')}">${icon('einstellungen', 20)}</a>
          <button type="button" class="nutzer-chip" data-nutzer-menue aria-haspopup="menu" aria-expanded="false" title="${t('Konto und Einstellungen')}">
            ${this.avatarHtml()}<span class="name" data-chip-name>${h(u.vorname || u.name)}</span><span class="chip-pfeil">${icon('runter', 14)}</span>
          </button>
        </div>
      </header>
      <main class="inhalt" id="inhalt" tabindex="-1"></main>
      <div class="player leer-player" id="player"></div>
      <nav class="tabs" aria-label="${t('Navigation')}">
        <a href="/" data-link data-nav="/">${icon('start', 22)}<span>${t('Start')}</span></a>
        <a href="/alben" data-link data-nav="/alben">${icon('alben', 22)}<span>${t('Alben')}</span></a>
        <a href="/kuenstler" data-link data-nav="/kuenstler">${icon('kuenstler', 22)}<span>${t('Künstler')}</span></a>
        <a href="/suche" data-link data-nav="/suche">${icon('suche', 22)}<span>${t('Suche')}</span></a>
        <a href="/mehr" data-link data-nav="/mehr">${icon('playlists', 22)}<span>${t('Mehr')}</span>${admin && warten ? `<span class="badge">${warten}</span>` : ''}</a>
      </nav>`;
    this.inhalt = this.wurzel.querySelector('#inhalt');
    this.wurzel.querySelector('[data-nutzer-menue]').addEventListener('click', (e) => this.nutzerMenue(e.currentTarget));
    this.kopfSucheVerbinden();
    this.wurzel.querySelector('[data-zurueck-nav]')?.addEventListener('click', () => this.zurueck());
  }

  /** Avatar: Profilbild oder Initialen */
  avatarHtml(gross = false) {
    const u = this.ich.user;
    return u.bild
      ? `<span class="avatar mit-bild${gross ? ' gross' : ''}" style="background-image:url('${h(u.bild)}')"></span>`
      : `<span class="avatar${gross ? ' gross' : ''}">${h(initialen(u.name))}</span>`;
  }

  /** Nach Änderungen im Konto (Name, Bild): Kopfzeile nachziehen */
  profilAktualisieren(neu) {
    const u = this.ich.user;
    if ('bild' in neu) u.bild = neu.bild;
    if (neu.vorname !== undefined) { u.vorname = neu.vorname; u.nachname = neu.nachname; u.name = `${neu.vorname} ${neu.nachname}`.trim(); }
    const chip = this.wurzel.querySelector('[data-nutzer-menue]');
    chip.querySelector('.avatar').outerHTML = this.avatarHtml();
    chip.querySelector('[data-chip-name]').textContent = u.vorname || u.name;
  }

  /** Benutzer-Flyout oben rechts: wer, wo, wie ausgegeben wird – und der Weg zu den Einstellungen */
  nutzerMenue(anker) {
    if (this.flyout) { this.flyoutSchliessen(); return; }
    menueSchliessen();
    const admin = this.ich.user.rolle === 'admin';
    const pl = this.player;
    const warten = this.ich.admin?.wartende_konten || 0;
    const f = pl.audio?.format;
    const lokal = netzweg.direkt || pl.netz?.lokal;
    const qName = { auto: t('Automatisch'), original: 'Original', opus256: 'Opus 256', opus160: 'Opus 160', opus128: 'Opus 128', aac256: 'AAC 256', aac160: 'AAC 160' };
    const wiedergabe = `${qName[lokal ? pl.einst.qualitaet_heim : pl.einst.qualitaet_unterwegs] || ''}${pl.einst.lautheit === 'aus' ? '' : ` · ${String(pl.einst.lautheit_ziel).replace('-', '−')} LUFS`}`;
    // ASIO-Ausgänge des gewählten Treibers: hier direkt umschalten
    const gwAus = pl.nativAusgabe?.geraet || '';
    const busse = nativ ? (pl.nativGeraete || []).filter((g) => g.ausgang && g.treiber === treiberVon(gwAus)) : [];
    const aktBus = busse.find((g) => g.id === gwAus) || (gwAus && !gwAus.includes('#') ? busse[0] : null);
    if (nativ) pl.nativGeraeteLaden?.();   // fürs nächste Öffnen frisch
    const punkt = (aktion, ico, text, wert = '', extra = '') => `<button type="button" role="menuitem" class="fly-punkt ${extra}" data-fly="${aktion}">${icon(ico, 18)}<span>${h(text)}</span>${wert}</button>`;
    const m = document.createElement('div');
    m.className = 'nutzer-flyout';
    m.setAttribute('role', 'menu');
    m.setAttribute('aria-label', t('Konto und Einstellungen'));
    m.innerHTML = `<div class="fly-kopf">${this.avatarHtml(true)}<div><b>${h(this.ich.user.name)}</b><small>${admin ? t('Administrator') : t('Familie')}${this.ich.geraet_name ? ` · ${h(this.ich.geraet_name)}` : ''}</small></div></div>
      <div class="fly-status"><span class="fly-chip ${lokal ? 'gut' : ''}">${lokal ? (netzweg.direkt ? t('Zuhause · direkt') : t('Zuhause')) : t('Unterwegs')}</span>${nativ ? `<span class="fly-chip">${f ? `${h(ausgabeWeg(f))}${pl.audio.bitgenau ? ` · ${t('bitgenau')}` : ''}` : 'Windows Client'}</span>` : ''}</div>
      <div class="fly-gruppe">
        ${punkt('/einstellungen/konto', 'profil', t('Konto'))}
        ${punkt('/einstellungen/wiedergabe', 'play', t('Wiedergabe'), `<small class="fly-wert">${h(wiedergabe)}</small>`)}
        ${nativ ? punkt('/einstellungen/ausgabe', 'computer', t('Windows-Ausgabe'), aktBus ? `<small class="fly-wert">${h(ausgangName(aktBus.ausgang))}</small>` : f ? `<small class="fly-wert">${h(f.geraet || '')}</small>` : '') : ''}
        ${busse.length > 1 ? `<div class="fly-busse" role="group" aria-label="${t('Ausgang wählen')}">${busse.map((g) => `<button type="button" class="fly-bus${g === aktBus ? ' an' : ''}" data-fly-bus="${h(g.id)}" aria-pressed="${g === aktBus}" title="${h(ausgangName(g.ausgang))}">${symbolSvg(symbolVon(g.ausgang), 18)}<span>${h(ausgangName(g.ausgang))}</span></button>`).join('')}</div>` : ''}
      </div>
      <div class="fly-gruppe">
        ${punkt('/favoriten', 'herz', t('Gemerkt'))}
        ${punkt('/verlauf', 'verlauf', t('Zuletzt gehört'))}
        ${punkt('/genres', 'genres', t('Genres'))}
        ${offlineAn() ? punkt('/offline', 'download', t('Auf diesem Gerät')) : ''}
      </div>
      ${admin ? `<div class="fly-gruppe">
        ${punkt('/einstellungen/bibliothek', 'einstellungen', t('Server-Einstellungen'))}
        ${punkt('/verwaltung', 'verwaltung', t('Verwaltung'), warten ? `<span class="fly-zahl">${warten}</span>` : '')}
      </div>` : ''}
      <div class="fly-gruppe">
        ${this.installHinweis ? punkt('installieren', 'installieren', t('App installieren')) : ''}
        ${istWindowsDesktop() && clientDownload(this.ich.app.version) ? punkt('windows-client', 'download', t('Windows-Client herunterladen')) : ''}
        ${istAndroidBrowser() && apkDownload(this.ich.app.version) ? punkt('android-app', 'download', t('Android-App herunterladen')) : ''}
        ${punkt('abmelden', 'abmelden', t('Abmelden'), '', 'rot')}
      </div>
      <div class="fly-fuss">${h(this.ich.app.name)} ${h(this.ich.app.version)}${nativ?.version ? ` · ${h(t('Client {version}', { version: nativ.version }))}` : ''}${android ? ` · ${h(t('App {version}', { version: androidVersion() }))}` : ''}</div>`;
    document.body.appendChild(m);
    const r = anker.getBoundingClientRect();
    m.style.top = `${r.bottom + 8}px`;
    m.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
    anker.setAttribute('aria-expanded', 'true');
    this.flyout = m;
    this.flyoutAnker = anker;
    m.addEventListener('click', (e) => {
      const bus = e.target.closest('[data-fly-bus]');
      if (bus) {
        if (bus.dataset.flyBus !== gwAus) { pl.nativAusgabeSetzen({ geraet: bus.dataset.flyBus }); toast(t('Ausgang: {name}', { name: bus.title })); }
        this.flyoutSchliessen();
        return;
      }
      const b = e.target.closest('[data-fly]');
      if (!b) return;
      const ziel = b.dataset.fly;
      this.flyoutSchliessen();
      if (ziel === 'abmelden') this.abmelden();
      else if (ziel === 'installieren') { this.installHinweis?.prompt(); this.installHinweis = null; }
      else if (ziel === 'windows-client') { location.href = clientDownload(this.ich.app.version); }
      else if (ziel === 'android-app') { location.href = apkDownload(this.ich.app.version); }
      else this.navigieren(ziel);
    });
    m.querySelector('.fly-punkt')?.focus({ preventScroll: true });
    // Außen klicken, Esc, Scrollen der Seite: zu
    this._flyAussen = (e) => { if (!m.contains(e.target) && !anker.contains(e.target)) this.flyoutSchliessen(); };
    this._flyTaste = (e) => {
      if (e.key === 'Escape') { this.flyoutSchliessen(); anker.focus(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const alle = [...m.querySelectorAll('.fly-punkt')];
        const i = alle.indexOf(document.activeElement);
        alle[(i + (e.key === 'ArrowDown' ? 1 : alle.length - 1)) % alle.length]?.focus();
        e.preventDefault();
      }
    };
    setTimeout(() => { document.addEventListener('click', this._flyAussen, true); document.addEventListener('keydown', this._flyTaste, true); });
  }

  flyoutSchliessen() {
    const m = this.flyout;
    if (!m) return;
    this.flyout = null;
    this.flyoutAnker?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', this._flyAussen, true);
    document.removeEventListener('keydown', this._flyTaste, true);
    m.classList.add('raus');
    setTimeout(() => m.remove(), 140);
  }

  async abmelden() {
    this.player.audio.pause();
    this.player.speichern(true);
    try { localStorage.removeItem('aw_ich'); } catch (e) { /* egal */ }   // kein Offline-Start als dieses Konto mehr
    try { await api.post('/abmelden'); } catch (e) {}
    window.location.href = '/login.php?grund=abgemeldet';
  }

  kopfSucheVerbinden() {
    const form = this.wurzel.querySelector('[data-kopf-suche]');
    const feld = form.querySelector('input');
    const box = form.querySelector('.vorschlag');
    let timer = null, laufend = null;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      box.hidden = true;
      if (feld.value.trim()) this.navigieren('/suche?q=' + encodeURIComponent(feld.value.trim()));
    });
    feld.addEventListener('input', () => {
      clearTimeout(timer);
      const q = feld.value.trim();
      if (q.length < 2) { box.hidden = true; return; }
      timer = setTimeout(async () => {
        laufend?.abort();
        laufend = new AbortController();
        try {
          const r = await api.get('/suche?q=' + encodeURIComponent(q), { signal: laufend.signal });
          this.listen = this.listen || new Map();
          this.listen.set('vorschlag', r.tracks.slice(0, 6));
          box.innerHTML = ansichten.sucheVorschlag(r);
          box.hidden = !box.innerHTML.trim();
        } catch (e) {}
      }, 180);
    });
    feld.addEventListener('keydown', (e) => { if (e.key === 'Escape') { box.hidden = true; feld.blur(); } });
    document.addEventListener('click', (e) => { if (!form.contains(e.target)) box.hidden = true; });
    box.addEventListener('click', (e) => { if (e.target.closest('a')) { box.hidden = true; feld.value = ''; } });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') && getComputedStyle(form).display !== 'none') { e.preventDefault(); feld.focus(); }
    });
  }

  klicksAbfangen() {
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-link]');
      if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      e.preventDefault();
      this.navigieren(url.pathname + url.search);
    });
  }

  /** Nach dem Abgleich zurück zur Seite, von der er gestartet wurde (mit Scrollposition); ohne Herkunft bleibt es bei der Abgleich-Seite */
  vomAbgleichZurueck() {
    const von = this.abgleichVon;
    if (!von) return false;
    this.abgleichVon = null;
    if ((history.state?.aw || 0) > 0) history.back();
    else this.navigieren(von);
    return true;
  }

  /** Zu einer Seite wechseln (ohne Neuladen – die Musik läuft weiter). */
  async navigieren(ziel, neuerEintrag = true, behalten = false) {
    const vorher = location.pathname + location.search;
    this.leiseAbbruch?.abort();
    this.navNr = (this.navNr || 0) + 1;
    // Scrollposition der Seite merken, die gerade verlassen wird. Bei „Zurück/Vor“ steht die Adresse schon auf dem Ziel –
    // dann gilt die zuletzt gezeichnete Seite (sonst würde die gemerkte Position des Ziels überschrieben).
    this.scrollPos.set(neuerEintrag || behalten ? vorher : (this.gezeichnet || vorher), window.scrollY);
    const url = new URL(ziel, location.origin);
    const pfad = url.pathname.replace(/\/+$/, '') || '/';
    // Abgleich mit MusicBrainz: merken, von welcher Seite der Nutzer kam (Verwaltung, Album, Künstler …), damit er danach dorthin zurückkehrt
    if (neuerEintrag && pfad.startsWith('/verwaltung/abgleich/') && !vorher.startsWith('/verwaltung/abgleich/')) this.abgleichVon = vorher;
    // Bereich der Navigation: Listen-Seiten bestimmen ihn selbst, Detailseiten (Album, Künstler, Playlist) erben ihn –
    // wer über „Künstler“ zu einem Album kommt, bleibt in „Künstler“. Gemerkt im Verlauf (auch für Zurück/Vor).
    let bereich = bereichVon(pfad);
    if (!bereich) bereich = (neuerEintrag ? this.bereich : history.state?.bereich) || naturBereich(pfad);
    if (neuerEintrag && ziel !== vorher) history.pushState({ aw: (history.state?.aw || 0) + 1, bereich }, '', ziel);
    else if (history.state?.bereich !== bereich) history.replaceState({ ...(history.state || { aw: 0 }), bereich }, '');
    this.bereich = bereich;
    this.leiste?.jetztSchliessen();
    this.navMarkieren(bereich);
    this.zurueckAnzeigen(pfad);
    this.abbruch?.abort();
    this.abbruch = new AbortController();
    const signal = this.abbruch.signal;
    this.inhalt.innerHTML = `<div class="lade" aria-label="${t('Wird geladen')}"></div>`;
    const route = this.route(pfad);
    if (!route) {
      this.inhalt.innerHTML = `<div class="leer"><h3>${t('Seite nicht gefunden')}</h3><p><a href="/" data-link>${t('Zur Startseite')}</a></p></div>`;
      return;
    }
    try {
      await route.fn({ app: this, ziel: this.inhalt, param: route.param, query: url.searchParams, signal, wiederherstellen: !neuerEintrag });
      if (signal.aborted) return;
      document.title = route.titel ? `${route.titel()} – ${this.name}` : this.name;
      const ort = this.wurzel.querySelector('[data-kopf-ort]');
      if (ort) ort.textContent = route.titel ? route.titel() : this.name;
      if (this.player.track && !this.player.audio.paused) this.player.metadaten();
      this.gezeichnet = location.pathname + location.search;
      scrollSetzen(neuerEintrag ? 0 : (this.scrollPos.get(ziel) || 0));
      this.leiste?.trackMarkieren();
      offlineMarkieren(this.inhalt);
    } catch (e) {
      if (e.name === 'AbortError' || signal.aborted) return;
      this.inhalt.innerHTML = `<div class="leer"><h3>${t('Das hat nicht geklappt')}</h3><p>${h(e.message)}</p></div>`;
    }
  }

  /**
   * Die Bibliothek hat sich geändert (Rückkanal, Ereignis „bib“) – etwa ein frisch eingelesenes oder abgeglichenes Album.
   * Kurz warten (Abgleich schreibt in Schüben), dann Player-Angaben und die sichtbare Seite still neu holen. Unsichtbar
   * (Tab im Hintergrund) erst beim Zurückkommen; während ein Dialog, Menü oder Eingabefeld offen ist, etwas später.
   */
  bibliothekGeaendert() {
    albumCacheLeeren();
    this.leiste?.creditsCache?.clear();
    clearTimeout(this._bibTimer);
    this._bibTimer = setTimeout(() => this.bibliothekAuffrischen(), 2500);
  }

  async bibliothekAuffrischen(versuch = 0) {
    if (document.hidden) {
      if (!this._bibSichtbar) {
        this._bibSichtbar = () => { if (document.hidden) return; document.removeEventListener('visibilitychange', this._bibSichtbar); this._bibSichtbar = null; this.bibliothekAuffrischen(); };
        document.addEventListener('visibilitychange', this._bibSichtbar);
      }
      return;
    }
    albumCacheLeeren();
    this.player.angabenAuffrischen();
    if (offlineAn() && !this.offline) offline.abgleichen();
    const pfad = location.pathname.replace(/\/+$/, '') || '/';
    const q = new URLSearchParams(location.search);
    const passt = /^\/(alben(\/\d+)?|kuenstler(\/\d+)?|genres|suche|favoriten|verlauf|playlists(\/\d+)?)?$/.test(pfad) && !(/^\/(alben|kuenstler)$/.test(pfad) && (q.get('sort') || gemerkt(pfad === '/alben' ? 'alben_sort' : 'kuenstler_sort')) === 'zufall');
    if (!passt) return;
    const aktiv = document.activeElement;
    const beschaeftigt = document.querySelector('dialog[open], .menue, .fern-wahl, .nutzer-flyout, .vorschlag:not([hidden])')
      || (aktiv && this.inhalt.contains(aktiv) && /INPUT|TEXTAREA|SELECT/.test(aktiv.tagName))
      || (String(window.getSelection?.() || '').length > 0);
    if (beschaeftigt) {
      if (versuch < 40) { clearTimeout(this._bibTimer); this._bibTimer = setTimeout(() => this.bibliothekAuffrischen(versuch + 1), 3000); }
      return;
    }
    await this.leiseNeuZeichnen();
  }

  /**
   * Aktuelle Seite ohne Ladekreis und ohne Sprung neu zeichnen: in ein unsichtbares Element rechnen, dann austauschen.
   * Navigiert der Nutzer währenddessen, gilt die neue Seite und das Ergebnis wird verworfen.
   */
  async leiseNeuZeichnen() {
    const voll = location.pathname + location.search;
    const url = new URL(voll, location.origin);
    const pfad = url.pathname.replace(/\/+$/, '') || '/';
    const route = this.route(pfad);
    if (!route) return;
    this.leiseAbbruch?.abort();
    const ctrl = new AbortController();
    this.leiseAbbruch = ctrl;
    const nr = this.navNr;
    const alt = this.inhalt;
    const neu = alt.cloneNode(false);
    const titel = document.title;
    try {
      await route.fn({ app: this, ziel: neu, param: route.param, query: url.searchParams, signal: ctrl.signal, wiederherstellen: true, leise: true });
    } catch (e) {
      if (ctrl.signal.aborted || nr !== this.navNr) return;
      // Album zusammengeführt (alte Nummer gibt es nicht mehr): zum Album, in dem seine Titel jetzt stecken
      if (e.status === 404 && /^\/alben\/\d+$/.test(pfad)) {
        const l = this.listen?.get(`a${pfad.split('/')[2]}`) || [];
        const r = l.length ? await api.post('/bibliothek/frisch', { tracks: l.slice(0, 50).map((t) => t.id) }).catch(() => null) : null;
        const ziel = r?.tracks?.[0]?.album?.id;
        if (nr !== this.navNr) return;
        if (ziel) { history.replaceState(history.state, '', `/alben/${ziel}`); this.navigieren(`/alben/${ziel}`, false, true); }
      }
      return;
    }
    if (ctrl.signal.aborted || nr !== this.navNr || this.inhalt !== alt) return;
    const y = window.scrollY;
    const fokus = alt.contains(document.activeElement);
    alt.replaceWith(neu);
    this.inhalt = neu;
    // Die neu gezeichnete Ansicht gehört ab jetzt zur normalen Navigation: alte Timer/Handler beenden, ihre Signale
    // beim nächsten Seitenwechsel mit abbrechen (sonst liefen Handler und Abfragen der leisen Fassung weiter)
    this.abbruch?.abort();
    this.abbruch = ctrl;
    this.leiseAbbruch = null;
    if (fokus) neu.focus({ preventScroll: true });
    offlineMarkieren(neu);
    window.scrollTo(0, y);
    const ort = this.wurzel.querySelector('[data-kopf-ort]');
    if (ort) ort.textContent = route.titel ? route.titel() : this.name;
    if (this.player.track && !this.player.audio.paused) this.player.metadaten(); else if (document.title !== titel && !route.titel) document.title = titel;
    this.leiste?.trackMarkieren();
  }

  /** Zurück-Knopf oben rechts: innerhalb der App eine Seite zurück, sonst zur übergeordneten Seite */
  zurueckAnzeigen(pfad) {
    const k = this.wurzel.querySelector('[data-zurueck-nav]');
    if (!k) return;
    k.hidden = pfad === '/' && !(history.state?.aw > 0);
  }

  zurueck() {
    if (history.state?.aw > 0) { history.back(); return; }
    const pfad = location.pathname.replace(/\/+$/, '') || '/';
    const eltern = pfad.replace(/\/[^/]+$/, '') || '/';
    const ziel = { '/verwaltung/abgleich': '/verwaltung/bibliothek' }[eltern] || eltern;
    this.navigieren(ziel);
    history.replaceState({ aw: 0, bereich: this.bereich }, '', ziel); // kein Kreislauf: übergeordnete Seite ist jetzt der Anfang
  }

  route(pfad) {
    if (this.offline) {
      const titel = () => this.inhalt.querySelector('h1')?.textContent?.trim() || '';
      const m = pfad.match(/^\/(alben|playlists)\/(\d+)$/);
      if (m) return { fn: (o) => offlineSammlung({ ...o, key: `${m[1] === 'alben' ? 'album' : 'playlist'}:${m[2]}` }), param: [], titel };
      return { fn: ansichten.offline, param: [], titel };
    }
    const r = [
      [/^\/$/, ansichten.start],
      [/^\/alben$/, ansichten.alben],
      [/^\/alben\/(\d+)$/, ansichten.album],
      [/^\/kuenstler$/, ansichten.kuenstlerListe],
      [/^\/kuenstler\/(\d+)$/, ansichten.kuenstler],
      [/^\/genres$/, ansichten.genres],
      [/^\/suche$/, ansichten.suche],
      [/^\/playlists$/, ansichten.playlists],
      [/^\/playlists\/(\d+)$/, ansichten.playlist],
      [/^\/favoriten$/, ansichten.favoriten],
      [/^\/verlauf$/, ansichten.verlauf],
      [/^\/offline$/, ansichten.offline],
      [/^\/profil$/, ({ app }) => app.umleiten('/einstellungen/konto')],
      [/^\/einstellungen$/, einstellungenAnsicht],
      [/^\/einstellungen\/([a-z]+)$/, einstellungenAnsicht],
      [/^\/mehr$/, ansichten.mehr],
      [/^\/downloads$/, vw('downloads')],
      [/^\/verwaltung$/, vw('uebersicht')],
      [/^\/verwaltung\/aktivitaet$/, vw('aktivitaet')],
      [/^\/verwaltung\/konten$/, vw('konten')],
      [/^\/verwaltung\/bibliothek$/, vw('bibliothek')],
      [/^\/verwaltung\/abgleich\/(\d+)$/, vw('abgleich')],
      [/^\/verwaltung\/einstellungen$/, vw('einstellungen')],
      [/^\/verwaltung\/system$/, vw('system')],
      [/^\/verwaltung\/protokoll$/, vw('protokoll')],
    ];
    for (const [muster, fn] of r) {
      const m = pfad.match(muster);
      if (m && fn) {
        if ((pfad.startsWith('/verwaltung') || pfad === '/downloads') && this.ich.user.rolle !== 'admin') return null;
        return { fn, param: m.slice(1), titel: () => this.inhalt.querySelector('h1')?.textContent?.trim() || '' };
      }
    }
    return null;
  }

  navMarkieren(bereich) {
    const mehrBereiche = ['/playlists', '/favoriten', '/verlauf', '/genres', '/profil', '/einstellungen', '/verwaltung', '/mehr', '/downloads'];
    this.wurzel.querySelectorAll('[data-nav]').forEach((a) => {
      const n = a.dataset.nav;
      const an = n === bereich || (n === '/mehr' && mehrBereiche.includes(bereich) && a.closest('.tabs'));
      a.classList.toggle('an', !!an);
      if (an) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }

  /** Zähler „wartende Konten“ neu laden (nach Freischaltungen) */
  async zaehlerAktualisieren() {
    try {
      this.ich = await api.get('/ich');
      const n = this.ich.admin?.wartende_konten || 0;
      this.wurzel.querySelectorAll('[data-nav="/verwaltung"] .badge, .tabs [data-nav="/mehr"] .badge').forEach((b) => b.remove());
      if (n) {
        this.wurzel.querySelector('.haupt-nav [data-nav="/verwaltung"]')?.insertAdjacentHTML('beforeend', `<span class="badge">${n}</span>`);
        this.wurzel.querySelector('.tabs [data-nav="/mehr"]')?.insertAdjacentHTML('beforeend', `<span class="badge">${n}</span>`);
      }
      // Menüpunkt „Downloads“ (Einstellung kann sich gerade geändert haben)
      const nav = this.wurzel.querySelector('.haupt-nav');
      const da = nav?.querySelector('[data-nav="/downloads"]');
      const soll = this.ich.user.rolle === 'admin' && this.ich.admin?.download_reiter;
      if (soll && !da && nav) {
        nav.querySelector('[data-nav="/verwaltung"]')?.insertAdjacentHTML('beforebegin', `<a href="/downloads" data-link data-nav="/downloads">${icon('download', 18)}<span class="l">${t('Downloads')}</span></a>`);
      } else if (!soll && da) da.remove();
      if (soll) this.downloadZahl(this.ich.admin.downloads_laufen || 0);
    } catch (e) {}
  }

  /** Zahl der laufenden Downloads am Menüpunkt */
  downloadZahl(n) {
    const a = this.wurzel.querySelector('.haupt-nav [data-nav="/downloads"]');
    if (!a) return;
    a.querySelector('.badge')?.remove();
    if (n > 0) a.insertAdjacentHTML('beforeend', `<span class="badge">${n}</span>`);
  }

  toast(t, art) { toast(t, art); }

  /** Alte Adresse ersetzen und dorthin wechseln (ohne zusätzlichen Verlaufseintrag) */
  async umleiten(ziel) {
    history.replaceState(history.state, '', ziel);
    await this.navigieren(ziel, false);
  }
}

const app = new App();
window.amberwave = app;
app.start();
