// Amberwave Windows Client: Hülle um die Amberwave-Web-App des eigenen Servers, abgespielt wird in der Amberwave-Engine
// (bitgenau über WASAPI exklusiv, lückenlos). Verwaltung, Bibliothek und Konten bleiben auf dem Server.
//
// Ablauf beim Start: gemerkten Server anpingen (zuerst im Heimnetz, dann die öffentliche Adresse). Antwortet keiner,
// wird das Heimnetz durchsucht (anderer Server-IP? derselbe Server wird am Namen bzw. der öffentlichen Adresse erkannt).
// Sonst: Einrichtungsseite (Suche, Liste, Adresse von Hand).
const { app, BrowserWindow, ipcMain, session, globalShortcut, Tray, Menu, shell, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { suchen, pingen, adresseNormal } = require('./suche');
const log = require('./log');
const { Vst, VstSlots } = require('./vst');
const i18n = require('./i18n');
const { t, tm, tmMeldung } = i18n;

const VERSION = require('./package.json').version;
// Kennung für den Server (Verwaltung → Aktivität, Profil → Geräte): Client-Version und Windows-Computername
const RECHNER = String(require('os').hostname() || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
app.userAgentFallback = `${app.userAgentFallback} AmberwaveClient/${VERSION}${RECHNER ? ` (${RECHNER})` : ''}`;
const STANDARD_PORT = 9950;
// Schnittstellen-Stand zwischen Client und Server: der Server meldet in /api/v1/ping „client_protokoll“. Weicht er ab,
// sagt der Client, wer aktualisiert werden muss (ältere Server ohne Angabe gelten als passend).
const PROTOKOLL = 1;
// Neue Versionen: Releases des Projekts auf GitHub (Platzhalter = keine Abfrage)
const RELEASES_URL = 'https://api.github.com/repos/lfrank95/amberwave/releases';
const RELEASES_SEITE = 'https://github.com/lfrank95/amberwave/releases';

// Medientasten selbst abfangen (Chromium würde sie sonst an eine nicht vorhandene Browser-Wiedergabe geben)
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');
app.setAppUserModelId('de.amberwave.client');

if (process.env.AW_DATEN) app.setPath('userData', process.env.AW_DATEN); // für Tests
log.starten(app.getPath('userData'));
log.schreiben('INFO', `=== Amberwave Windows Client ${require('./package.json').version} gestartet (Electron ${process.versions.electron}, ${process.platform} ${process.arch})`);
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/* ---------- Einstellungen (pro Windows-Benutzer) ---------- */
const EINST_DATEI = path.join(app.getPath('userData'), 'einstellungen.json');
let einst = { server: null, port: STANDARD_PORT, ausgabe: { geraet: '', exklusiv: false, rate: 0, aufschlag_je: {} }, fenster: null };
const RATEN = [0, 44100, 48000, 88200, 96000, 176400, 192000];   // 0 = folgt der Datei
const rateNormal = (r) => (RATEN.includes(Number(r)) ? Number(r) : 0);
// Stille nach einem Ratenwechsel, sobald das Gerät stabil läuft (ms, 0–5000) – je Ausgabegerät gemerkt (ein RME braucht
// nichts, manches USB-Interface schaltet seinen Ausgang erst nach Sekunden frei)
const aufschlagNormal = (a) => { const n = Number(a); return Number.isFinite(n) ? Math.max(0, Math.min(5000, Math.round(n))) : 250; };
// Standard: ASIO-Interfaces schalten beim Ratenwechsel oft spürbar langsamer frei (wie ein CD-Wechsel) → 2 s; Windows-Geräte 250 ms
// Gemerkt je Treiber (ein ASIO-Ausgang „asio:{…}#bus“ zählt zu seinem Treiber)
const treiberVon = (geraet) => String(geraet || '').split('#')[0];
const aufschlagFuer = (geraet) => {
  const je = einst.ausgabe.aufschlag_je?.[treiberVon(geraet)];
  if (je != null) return aufschlagNormal(je);
  return String(geraet || '').startsWith('asio:') ? 2000 : aufschlagNormal(einst.ausgabe.aufschlag ?? 250);
};

/* ---------- ASIO-Ausgänge (Busse): je Treiber eine Liste, mindestens „Stereo · Kanal 1/2“ ---------- */
// Engine-Kanalfolge je Layout: Stereo L R, Quadro L R Ls Rs, 5.1 L R C LFE Ls Rs
const LAYOUT_KANAELE = { stereo: 2, quadro: 4, '51': 6 };
const SYMBOLE = ['auto', 'paar', 'monitore', 'kopfhoerer', 'quadro', 'surround', 'sofa'];
const STANDARD_AUSGANG = () => ({ id: 'std', name: '', symbol: 'auto', layout: 'stereo', sub: false, karte: [0, 1] });
function ausgangPruefen(a) {
  if (!a || typeof a !== 'object') return null;
  const layout = LAYOUT_KANAELE[a.layout] ? a.layout : 'stereo';
  const sub = !!a.sub;
  const n = LAYOUT_KANAELE[layout] + (sub && layout !== '51' ? 1 : 0);   // Stereo/Quadro + Sub: LFE hinten an
  const karte = Array.isArray(a.karte) ? a.karte.slice(0, n).map((k) => Math.max(0, Math.min(255, Math.round(Number(k) || 0)))) : [];
  while (karte.length < n) karte.push(karte.length);
  return {
    id: /^[a-z0-9]{1,20}$/.test(String(a.id || '')) ? a.id : Math.random().toString(36).slice(2, 10),
    name: String(a.name || '').trim().slice(0, 60),
    symbol: SYMBOLE.includes(a.symbol) ? a.symbol : 'auto',
    layout, sub, karte,
    // Subwoofer: Trennfrequenz 50–200 Hz (10er-Schritte), Delay in ms (+ = Sub später, − = Hauptlautsprecher später)
    trenn: Math.max(50, Math.min(200, Math.round((Number(a.trenn) || 80) / 10) * 10)),
    delay: Math.max(-30, Math.min(30, Math.round((Number(a.delay) || 0) * 1000) / 1000)),
    einheit: ['ms', 'm', 'in'].includes(a.einheit) ? a.einheit : 'ms',
    phase: !!a.phase,   // Sub um 180° gedreht
    ...lsUndKh(a, karte),
  };
}
/* Lautsprecher-Manager: Art (Lautsprecher/Kopfhörer), Abstände → Delay, Pegel je Lautsprecher; Kopfhörer mit eigener
 * Kanalwahl, Balance, Crossfeed und Pegel. Beide Arten bleiben gespeichert, damit ein Wechsel hin und zurück nichts verliert. */
const LS_ALLE = ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'];
const CROSSFEED = ['aus', 'leicht', 'mittel', 'stark'];
const zahlIn = (v, lo, hi, std) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : std; };
function lsUndKh(a, karte) {
  const dist = {}, pegel = {}, delayHand = {};
  for (const k of LS_ALLE) {
    dist[k] = Math.round(zahlIn(a.dist?.[k], 0.3, 15, 2.5) * 100) / 100;
    pegel[k] = Math.round(zahlIn(a.pegel?.[k], -12, 6, 0) * 2) / 2;
    if (a.delay_hand?.[k] != null) delayHand[k] = Math.round(zahlIn(a.delay_hand[k], 0, 30, 0) * 1000) / 1000;
  }
  // ältere Einstellung: ein Sub-Delay (± ms) → von Hand gesetztes Delay am Sub bzw. an allen Hauptlautsprechern
  if (!a.dist && Number(a.delay)) {
    const d = zahlIn(a.delay, -30, 30, 0);
    if (d > 0) delayHand.LFE = d; else for (const k of LS_ALLE) if (k !== 'LFE') delayHand[k] = -d;
  }
  const kk = Array.isArray(a.kh?.karte) && a.kh.karte.length === 2 ? a.kh.karte : [karte[0] ?? 0, karte[1] ?? 1];
  const kh = {
    karte: kk.map((k) => Math.max(0, Math.min(255, Math.round(Number(k) || 0)))),
    balance: Math.round(zahlIn(a.kh?.balance, -100, 100, 0) / 5) * 5,
    crossfeed: CROSSFEED.includes(a.kh?.crossfeed) ? a.kh.crossfeed : 'aus',
    pegel: Math.round(zahlIn(a.kh?.pegel, -18, 0, 0) * 2) / 2,
  };
  if (kh.karte[0] === kh.karte[1]) kh.karte[1] = kh.karte[0] + 1;
  return { art: a.art === 'kh' ? 'kh' : 'ls', dist, pegel, delay_hand: delayHand, kh, fertig: a.fertig !== false, ...eqPruefen(a) };
}
/* Kanal-EQ je Lautsprecher: 8 Bänder (Bell, Low-/High-Shelf, Hoch-/Tiefpass), Kanalpaare lassen sich koppeln (gleiche Werte) */
const EQ_BAENDER = 8, EQ_TYPEN = 5, EQ_FLANKEN = [6, 12, 18, 24, 36, 48];
const EQ_STD_F = [50, 120, 300, 700, 1500, 3500, 8000, 14000];
const EQ_LINKS = ['LR', 'LsRs'];
function eqBand(b, i) {
  const f = Math.round(zahlIn(b?.f, 10, 24000, EQ_STD_F[i] || 1000) * 100) / 100;
  const fl = Number(b?.flanke);
  return {
    an: !!b?.an, typ: Math.round(zahlIn(b?.typ, 0, EQ_TYPEN - 1, 0)), f,
    g: Math.round(zahlIn(b?.g, -24, 24, 0) * 10) / 10, q: Math.round(zahlIn(b?.q, 0.1, 18, 1) * 100) / 100,
    flanke: EQ_FLANKEN.includes(fl) ? fl : 12,
  };
}
function eqPruefen(a) {
  const eq = {};
  for (const k of LS_ALLE) {
    const e = a.eq?.[k];
    eq[k] = { an: e ? e.an !== false : true, baender: Array.from({ length: EQ_BAENDER }, (_, i) => eqBand(e?.baender?.[i], i)) };
  }
  const link = {};
  for (const k of EQ_LINKS) link[k] = !!a.eq_link?.[k];
  return { eq, eq_link: link, eq_reserve: Math.round(zahlIn(a.eq_reserve, 0, 24, 0) * 10) / 10 };
}
/** Engine-Liste eines Kanal-EQs: [Kanal an, 8 × (an, Typ, Hz, dB, Q, Flanke)] */
const eqListe = (e) => [e && e.an ? 1 : 0, ...(e ? e.baender : Array.from({ length: EQ_BAENDER }, (_, i) => eqBand(null, i))).flatMap((b) => [b.an ? 1 : 0, b.typ, b.f, b.g, b.q, b.flanke])];
/** Lautsprecher eines Ausgangs in Engine-Reihenfolge (mit separatem Sub hinten LFE) */
const LS_LAYOUT = { stereo: ['L', 'R'], quadro: ['L', 'R', 'Ls', 'Rs'], '51': ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'] };
const lsVon = (a) => { const l = LS_LAYOUT[a.layout] || LS_LAYOUT.stereo; return a.sub && a.layout !== '51' ? [...l, 'LFE'] : l; };
/** Delay je Lautsprecher: von Hand gesetzt oder aus den Abständen (der weiteste 0 ms) */
function delaysVon(a) {
  const ls = lsVon(a), weit = Math.max(...ls.map((k) => a.dist[k]));
  return ls.map((k) => (a.delay_hand[k] != null ? a.delay_hand[k] : (weit - a.dist[k]) / 343 * 1000));
}
/** Korrektur für die Engine: Kanäle in Engine-Reihenfolge; Pegel so gesenkt, dass keiner über 0 dB liegt */
function korrekturVon(a) {
  if (!a) return { an: false, delays: [], gains: [], cf: 0 };
  if (a.art === 'kh') {
    const b = a.kh.balance, db = (x) => (x <= 0 ? -60 : 20 * Math.log10(x));
    const gains = [a.kh.pegel + (b > 0 ? db(1 - b / 100) : 0), a.kh.pegel + (b < 0 ? db(1 + b / 100) : 0)];
    const cf = CROSSFEED.indexOf(a.kh.crossfeed);
    return { an: cf > 0 || gains.some((g) => g !== 0), delays: [0, 0], gains, cf };
  }
  const ls = lsVon(a);
  const delays = delaysVon(a).map((d) => Math.round(d * 1000) / 1000);
  const hoch = Math.max(0, ...ls.map((k) => a.pegel[k]));
  const reserve = eqAktiv(a) ? a.eq_reserve || 0 : 0;   // EQ-Anhebungen: alles so weit absenken, dass nichts übersteuert
  const gains = ls.map((k) => a.pegel[k] - hoch - reserve);
  return { an: delays.some((d) => d > 0.004) || gains.some((g) => g !== 0), delays, gains, cf: 0 };
}
function ausgaengeFuer(treiber) {
  const l = (einst.asio_ausgaenge?.[treiber] || []).map(ausgangPruefen).filter(Boolean);
  return l.length ? l : [ausgangPruefen(STANDARD_AUSGANG())];
}
/** Auswahl → Geräte-ID für die Engine: ASIO-Ausgang „asio:{…}#bus“ → „asio:{…}#0,1,…“ (Kanalkarte) */
function engineGeraet(geraet) {
  const g = String(geraet || '');
  if (!g.startsWith('asio:')) return g;
  const [treiber, bus] = g.split('#');
  const l = ausgaengeFuer(treiber);
  const a = l.find((x) => x.id === bus) || l[0];
  return `${treiber}#${(a.art === 'kh' ? a.kh.karte : a.karte).join(',')}`;
}
function ausgangVon(geraet) {
  const g = String(geraet || '');
  if (!g.startsWith('asio:')) return null;
  const [treiber, bus] = g.split('#');
  const l = ausgaengeFuer(treiber);
  return l.find((x) => x.id === bus) || l[0];
}
/** Delay/Pegel je Lautsprecher bzw. Kopfhörer-Klang des gewählten Ausgangs an die Engine (sonst neutral) */
function korrAnEngine(geraet) {
  const a = ausgangVon(geraet);
  korrSenden(a, false);
}
/** Ist an diesem Ausgang mindestens ein EQ-Band aktiv? (nur Lautsprecher) */
const eqAktiv = (a) => !!a && a.art !== 'kh' && lsVon(a).some((k) => a.eq?.[k]?.an && a.eq[k].baender.some((b) => b.an));
/** Korrektur (Delay, Pegel, Crossfeed) und Kanal-EQ an die Engine; neutral = alles aus (A/B-Vergleich „Original“) */
function korrSenden(a, neutral) {
  const k = neutral ? { an: false, delays: [], gains: [], cf: 0 } : korrekturVon(a);
  engineSenden({ c: 'korrektur', 'w.an': k.an ? 1 : 0, 'w.delays': k.delays, 'w.gains': k.gains, 'w.cf': k.cf });
  const ls = a && a.art !== 'kh' && !neutral ? lsVon(a) : [];
  for (let i = 0; i < 8; i++) engineSenden({ c: 'kanal_eq', 'w.k': i, 'w.p': ls[i] ? eqListe(a.eq[ls[i]]) : [0] });
}
/** Subwoofer/Bassmanagement des gewählten ASIO-Ausgangs an die Engine (sonst aus) */
function bassAnEngine(geraet) {
  const g = String(geraet || '');
  let a = null;
  if (g.startsWith('asio:')) { const [treiber, bus] = g.split('#'); const l = ausgaengeFuer(treiber); a = l.find((x) => x.id === bus) || l[0]; }
  const an = !!a?.sub && a.art !== 'kh';
  // Delay des Subs steckt jetzt in der Korrektur (Abstände je Lautsprecher)
  engineSenden({ c: 'bass', 'w.an': an ? 1 : 0, 'w.hz': a?.trenn || 80, 'w.delay': 0, 'w.layout': a ? LAYOUT_KANAELE[a.layout] : 2, 'w.phase': an && a.phase ? 1 : 0 });
  korrAnEngine(geraet);
}
function ausgabeAnEngine() {
  bassAnEngine(einst.ausgabe.geraet);
  engineSenden({ c: 'ausgabe', geraet: engineGeraet(einst.ausgabe.geraet), exklusiv: einst.ausgabe.exklusiv === true, 'w.rate': rateNormal(einst.ausgabe.rate), 'w.aufschlag': aufschlagFuer(einst.ausgabe.geraet) });
}
// Antworten der Engine, auf die jemand wartet (Kanalnamen, Testton)
let antwortWarter = [];
function engineFragen(befehl, passt, ms) {
  return new Promise((r) => {
    const w = { passt, r };
    antwortWarter.push(w);
    engineSenden(befehl);
    setTimeout(() => { if (antwortWarter.includes(w)) { antwortWarter = antwortWarter.filter((x) => x !== w); r(null); } }, ms);
  });
}
try { einst = { ...einst, ...JSON.parse(fs.readFileSync(EINST_DATEI, 'utf8')) }; } catch (e) { /* erster Start */ }
function einstSpeichern() {
  try {
    fs.mkdirSync(path.dirname(EINST_DATEI), { recursive: true });
    fs.writeFileSync(EINST_DATEI, JSON.stringify(einst, null, 2));
  } catch (e) { console.error('Einstellungen nicht gespeichert', e); }
}
// Sprache: einst.sprache = 'de' | 'en' | 'auto' (auto: Windows-Sprache). Chromium-eigene Menüs (Kopieren/Einfügen …) folgen
// der gewählten Sprache nach einem Neustart des Clients.
i18n.init({ gespeichert: () => einst.sprache, system: () => app.getLocale() });
if (einst.sprache === 'en' || einst.sprache === 'de') app.commandLine.appendSwitch('lang', einst.sprache === 'en' ? 'en-US' : 'de');   // Chromium-Menüs (muss vor ready stehen)
const spracheSetzen = (w) => {
  if (!['de', 'en', 'auto'].includes(w) || w === (einst.sprache || 'auto')) return;
  einst.sprache = w;
  einstSpeichern();
  i18n.neuBestimmen();
  trayAktualisieren();
  // Einrichtungsfenster steht in der Sprache des Clients: neu laden. Die Web-App im Fenster hat ihre eigene Kontosprache.
  if (fenster && !fenster.isDestroyed() && fenster.webContents.getURL().startsWith('file:')) fenster.loadFile(path.join(__dirname, 'einrichtung.html'));
};
const ports = () => [...new Set([Number(einst.port) || STANDARD_PORT, STANDARD_PORT])];

let fenster = null;
let fensterGezeigt = false;
let tray = null;
let basis = '';          // geladene Server-Adresse (Origin)
let beenden = false;

/** darf diese Seite die Engine benutzen? Nur der eingerichtete Server */
function erlaubt(url) {
  try {
    const o = new URL(url).origin;
    const s = einst.server;
    if (!s) return false;
    return [s.lan, s.url].filter(Boolean).some((a) => new URL(a).origin === o);
  } catch (e) { return false; }
}

/* ---------- Engine ---------- */
let engine = null;
let engineStarts = [];
let geraeteWarter = [];
let spielt = false;
let titelText = '';

function engineSenden(b) {
  if (!engine || !engine.stdin.writable) return;
  engine.stdin.write(JSON.stringify(b) + '\n');
}

function engineStarten() {
  const exe = process.env.AW_ENGINE || path.join(__dirname, 'engine', process.platform === 'win32' ? 'amberwave-engine.exe' : 'amberwave-engine');
  engineStarts = engineStarts.filter((t) => Date.now() - t < 60000);
  engineStarts.push(Date.now());
  try {
    engine = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    console.error('Engine startet nicht', e);
    engine = null;
    return;
  }
  let rest = '';
  engine.stdout.setEncoding('utf8');
  engine.stdout.on('data', (d) => {
    rest += d;
    let i;
    while ((i = rest.indexOf('\n')) >= 0) {
      const z = rest.slice(0, i).trim();
      rest = rest.slice(i + 1);
      if (z) engineMeldung(z);
    }
  });
  engine.stderr.on('data', (d) => console.error('[engine]', String(d).trim()));
  log.schreiben('INFO', `Engine gestartet (pid ${engine.pid})`);
  setTimeout(() => vstSlots.engineNeu(), 500);
  const dieses = engine;
  engine.on('error', (e) => console.error('Engine-Fehler', e));
  engine.on('exit', (code) => {
    if (engine === dieses) engine = null;
    if (beenden) return;
    console.error('Engine beendet mit', code);
    if (engineStarts.length >= 5) {
      senden('engine', { e: 'fehler', id: '', text: t('Die Audio-Engine stürzt wiederholt ab – bitte Amberwave neu starten.') });
      return;
    }
    setTimeout(() => { engineStarten(); senden('engine', { e: 'neustart' }); }, 400);
  });
  ausgabeAnEngine();
}

function engineMeldung(z) {
  let m;
  try { m = JSON.parse(z); } catch (e) { return; }
  if (m.e === 'geraete') { for (const r of geraeteWarter) r(m.liste || []); geraeteWarter = []; return; }
  for (const w of antwortWarter) if (w.passt(m)) { antwortWarter = antwortWarter.filter((x) => x !== w); w.r(m); break; }
  // Audio-Ereignisse ins Log (für Fehlersuche: Aussetzer, Formatwechsel, Anlauf, Plug-in-Ausfälle)
  if (['aussetzer', 'format', 'formatwechsel', 'anlauf', 'vstfehler', 'fehler'].includes(m.e)) log.schreiben(m.e === 'fehler' || m.e === 'aussetzer' ? 'WARN' : 'INFO', `Engine: ${z.length > 600 ? z.slice(0, 600) + '…' : z}`);
  if (m.e === 'zeit') spielt = true;
  if (m.e === 'ende') spielt = false;
  senden('engine', tmMeldung(m));
}

function senden(kanal, daten) {
  if (fenster && !fenster.isDestroyed()) fenster.webContents.send(kanal, daten);
}

/** Cookie-Kopfzeile für eine Stream-Adresse (Anmeldung der Web-App gilt auch für die Engine) */
async function cookieKopf(url) {
  try {
    const cs = await session.defaultSession.cookies.get({ url });
    return cs.length ? `Cookie: ${cs.map((c) => `${c.name}=${c.value}`).join('; ')}\r\n` : '';
  } catch (e) { return ''; }
}

// Befehle in Reihenfolge weitergeben (das Nachschlagen der Cookies ist asynchron)
let kette = Promise.resolve();
ipcMain.on('engine-senden', (e, b) => {
  if (!erlaubt(e.senderFrame?.url || '') || !b || typeof b.c !== 'string') return;
  kette = kette.then(async () => {
    const befehl = { ...b };
    if ((befehl.c === 'laden' || befehl.c === 'vormerken') && befehl.url) {
      if (!/^https?:\/\//i.test(befehl.url)) return;
      befehl.kopf = await cookieKopf(befehl.url);
    }
    if (befehl.c === 'pause' || befehl.c === 'stopp') spielt = false;
    if (befehl.c === 'spielen' || befehl.c === 'laden') spielt = true;
    engineSenden(befehl);
    trayAktualisieren();
  }).catch((x) => console.error(x));
});

ipcMain.on('client-info', (e) => {
  const url = e.senderFrame?.url || '';
  e.returnValue = { erlaubt: erlaubt(url), einrichtung: url.startsWith('file:') && url.endsWith('/einrichtung.html'), version: VERSION, plattform: process.platform, sprache: i18n.sprache() };
});
ipcMain.handle('geraete', (e) => {
  if (!erlaubt(e.senderFrame?.url || '')) return [];
  // Liste der Engine plus, was dieser PC je Gerät gemerkt hat: eigener Name, ausgeblendet
  const merk = einst.geraete || {};
  return new Promise((r) => {
    // ASIO: je Treiber seine Ausgänge als eigene Geräte („asio:{…}#bus“, treiber = der Treiber, ausgang = Einstellung)
    const fertig = (liste) => r((liste || []).flatMap((g) => {
      const basis = { ...g, eigener_name: merk[g.id]?.name || '', aus: !!merk[g.id]?.aus };
      if (!g.asio) return [basis];
      return ausgaengeFuer(g.id).map((a) => ({ ...basis, id: `${g.id}#${a.id}`, treiber: g.id, ausgang: a, kanaele: a.art === 'kh' ? 2 : LAYOUT_KANAELE[a.layout] }));
    }));
    geraeteWarter.push(fertig);
    engineSenden({ c: 'geraete' });
    setTimeout(() => { geraeteWarter = geraeteWarter.filter((x) => x !== fertig); r([]); }, 4000);
  });
});
// Gerät benennen oder ausblenden (nur auf diesem PC; leerer Name = wieder der erkannte)
ipcMain.on('geraet-merken', (e, w) => {
  if (!erlaubt(e.senderFrame?.url || '') || !w || typeof w.id !== 'string' || w.id.length > 300) return;
  w = { ...w, id: treiberVon(w.id) };   // Name und Ausblenden gelten für den ganzen Treiber
  const alle = { ...(einst.geraete || {}) };
  const g = { ...(alle[w.id] || {}) };
  if (typeof w.name === 'string') { const n = w.name.trim().slice(0, 80); if (n) g.name = n; else delete g.name; }
  if (typeof w.aus === 'boolean') { if (w.aus) g.aus = true; else delete g.aus; }
  if (Object.keys(g).length) alle[w.id] = g; else delete alle[w.id];
  einst.geraete = alle;
  einstSpeichern();
});
ipcMain.handle('ausgabe-lesen', () => {
  const { aufschlag_je, ...rest } = einst.ausgabe;
  return { ...rest, aufschlag: aufschlagFuer(einst.ausgabe.geraet) };
});
ipcMain.on('ausgabe-setzen', (e, w) => {
  if (!erlaubt(e.senderFrame?.url || '') || !w) return;
  const geraet = String(w.geraet || '');
  const je = { ...(einst.ausgabe.aufschlag_je || {}) };
  // Pause gilt je Gerät (Treiber): bei einem Gerätewechsel zählt der gemerkte Wert des neuen Geräts, nicht der mitgeschickte alte
  if (w.aufschlag != null && treiberVon(geraet) === treiberVon(einst.ausgabe.geraet)) je[treiberVon(geraet)] = aufschlagNormal(w.aufschlag);
  einst.ausgabe = { geraet, exklusiv: w.exklusiv === true, rate: rateNormal(w.rate ?? einst.ausgabe.rate), aufschlag_je: je };
  einstSpeichern();
  ausgabeAnEngine();
});
// Ausgänge eines ASIO-Treibers lesen/speichern (Fenster „Ausgänge & Lautsprecher“)
const treiberGueltig = (t) => typeof t === 'string' && /^asio:[^#]{1,120}$/.test(t);
ipcMain.handle('ausgaenge-lesen', (e, treiber) => {
  if (!erlaubt(e.senderFrame?.url || '') || !treiberGueltig(treiber)) return null;
  return { ausgaenge: ausgaengeFuer(treiber), namen: einst.asio_namen?.[treiber] || [] };
});
ipcMain.handle('ausgaenge-setzen', (e, treiber, liste) => {
  if (!erlaubt(e.senderFrame?.url || '') || !treiberGueltig(treiber) || !Array.isArray(liste)) return null;
  const neu = [];
  for (const a of liste.slice(0, 16)) { const x = ausgangPruefen(a); if (x && !neu.some((y) => y.id === x.id)) neu.push(x); }
  if (!neu.length) neu.push(ausgangPruefen(STANDARD_AUSGANG()));
  const g = String(einst.ausgabe.geraet || '');
  const vorher = engineGeraet(g);   // Kanalkarte vor dem Speichern
  einst.asio_ausgaenge = { ...(einst.asio_ausgaenge || {}), [treiber]: neu };
  // gewählter Ausgang dieses Treibers: neue Kanalkarte gleich an die Engine (gelöscht → erster Ausgang)
  if (treiberVon(g) === treiber) {
    const bus = g.split('#')[1];
    if (!neu.some((x) => x.id === bus)) einst.ausgabe = { ...einst.ausgabe, geraet: `${treiber}#${neu[0].id}` };
    einstSpeichern();
    // nur Sub-Werte geändert (gleiche Kanalkarte): Gerät nicht neu öffnen, nur die Weiche nachstellen
    if (engineGeraet(einst.ausgabe.geraet) === vorher) bassAnEngine(einst.ausgabe.geraet); else ausgabeAnEngine();
  } else einstSpeichern();
  return { ausgaenge: neu, geraet: einst.ausgabe.geraet };
});
// Subwoofer-Werte eines Ausgangs live ändern (Space-Menü im Player): Trennfrequenz, Delay, Phase – ohne Neuöffnen
ipcMain.handle('ausgang-bass', (e, treiber, id, werte) => {
  if (!erlaubt(e.senderFrame?.url || '') || !treiberGueltig(treiber) || !werte || typeof werte !== 'object') return null;
  const l = ausgaengeFuer(treiber);
  const i = l.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const x = ausgangPruefen({ ...l[i], ...Object.fromEntries(['trenn', 'delay', 'phase', 'einheit'].filter((k) => k in werte).map((k) => [k, werte[k]])) });
  l[i] = x;
  einst.asio_ausgaenge = { ...(einst.asio_ausgaenge || {}), [treiber]: l };
  einstSpeichern();
  if (treiberVon(einst.ausgabe.geraet) === treiber) bassAnEngine(einst.ausgabe.geraet);
  return x;
});
// Vorschau aus dem Lautsprecher-Manager: Delay/Pegel/Kopfhörer-Klang des gerade bearbeiteten Ausgangs live hören, ohne zu
// speichern (nur wenn er gerade spielt). ausgang = null → wieder die gespeicherten Werte. neutral = A/B-Vergleich „Original“.
ipcMain.handle('ausgang-vorschau', (e, treiber, id, ausgang, neutral) => {
  if (!erlaubt(e.senderFrame?.url || '') || !treiberGueltig(treiber)) return null;
  const g = String(einst.ausgabe.geraet || '');
  if (treiberVon(g) !== treiber || (g.split('#')[1] || ausgaengeFuer(treiber)[0]?.id) !== id) return { aktiv: false };
  if (!ausgang) { korrAnEngine(g); return { aktiv: true }; }
  const a = ausgangPruefen({ ...ausgang, id });
  // Kanalkarte oder Art geändert: das hört man erst nach dem Übernehmen (Gerät wird neu geöffnet)
  const gespeichert = ausgangVon(g);
  if (!a || !gespeichert || a.art !== gespeichert.art) return { aktiv: true, vorschau: false };
  korrSenden(a, !!neutral);
  return { aktiv: true, vorschau: true };
});
// EQ-Presets (Lautsprecher-Manager): Name → 8 Bänder, im Client gemerkt
ipcMain.handle('eq-presets', (e) => (erlaubt(e.senderFrame?.url || '') ? Object.entries(einst.eq_presets || {}).map(([name, baender]) => ({ name, baender })) : []));
ipcMain.handle('eq-preset-setzen', (e, name, baender) => {
  if (!erlaubt(e.senderFrame?.url || '') || typeof name !== 'string') return null;
  const n = name.trim().slice(0, 60);
  if (!n) return null;
  const p = { ...(einst.eq_presets || {}) };
  if (baender == null) delete p[n];
  else if (Array.isArray(baender)) { if (Object.keys(p).length >= 100 && !(n in p)) return null; p[n] = Array.from({ length: EQ_BAENDER }, (_, i) => eqBand(baender[i], i)); }
  else return null;
  einst.eq_presets = p;
  einstSpeichern();
  return Object.entries(p).map(([name2, b]) => ({ name: name2, baender: b }));
});
// Namen der Treiber-Ausgänge (Engine lädt den Treiber dafür kurz, wenn er nicht offen ist) – gemerkt für später
ipcMain.handle('asio-kanaele', async (e, treiber) => {
  if (!erlaubt(e.senderFrame?.url || '') || !treiberGueltig(treiber)) return null;
  const m = await engineFragen({ c: 'asio_kanaele', geraet: treiber }, (x) => x.e === 'asio_kanaele' && treiberVon(x.geraet) === treiber, 8000);
  if (m?.namen?.length) {
    einst.asio_namen = { ...(einst.asio_namen || {}), [treiber]: m.namen.map((n) => String(n).slice(0, 40)) };
    einstSpeichern();
    return { namen: einst.asio_namen[treiber] };
  }
  return { namen: einst.asio_namen?.[treiber] || [], fehler: tm(m?.fehler) || t('Der Treiber hat nicht geantwortet') };
});
// Testton auf einem Treiber-Ausgang (0 = erster)
ipcMain.handle('testton', async (e, treiber, ausgang) => {
  if (!erlaubt(e.senderFrame?.url || '') || !treiberGueltig(treiber)) return null;
  const n = Math.max(0, Math.min(255, Math.round(Number(ausgang) || 0)));
  const geraet = `${treiber}#${n}`;
  const m = await engineFragen({ c: 'testton', geraet, 'w.ms': 2000 }, (x) => x.e === 'testton' && x.geraet === geraet, 15000);
  return m ? (m.ok ? { ok: true } : { fehler: tm(m.fehler) || t('Testton geht nicht') }) : { fehler: t('Keine Antwort von der Engine') };
});
ipcMain.on('server-wechseln', () => einrichtungZeigen());
ipcMain.on('sprache-setzen', (e, w) => { if (erlaubt(e.senderFrame?.url || '') || eigeneSeite(e)) spracheSetzen(String(w)); });

/* ---------- VST3-Plug-ins (Suchen, Probelauf, Editor zum Testen; Log und Diagnosedatei) ---------- */
const vst = new Vst(app.getPath('userData'), () => einst.vst || {});
const vstOk = (e) => erlaubt(e.senderFrame?.url || '');
const vstSlots = new VstSlots(app.getPath('userData'), (b) => engineSenden(b), (id, m) => senden('vst-ereignis', { id, ...m }));
ipcMain.handle('vst-slot-start', (e, id, pfad, cid) => (vstOk(e) ? vstSlots.starten(String(id), String(pfad), String(cid), vst) : null));
ipcMain.handle('vst-slot-weg', (e, id, loeschen) => { if (vstOk(e)) vstSlots.beenden(String(id), !!loeschen); return true; });
ipcMain.handle('vst-slot-editor', (e, id, auf) => (vstOk(e) ? (auf === false ? vstSlots.editorZu(String(id)) : vstSlots.editor(String(id))) : false));
ipcMain.handle('vst-slot-liste', (e) => (vstOk(e) ? vstSlots.liste() : []));
ipcMain.handle('vst-preset-liste', (e, cid) => (vstOk(e) ? vstSlots.presetListe(String(cid)) : []));
ipcMain.handle('vst-preset-speichern', (e, id, cid, name) => (vstOk(e) ? vstSlots.presetSpeichern(String(id), String(cid), String(name)) : null));
ipcMain.handle('vst-preset-laden', (e, id, cid, name) => (vstOk(e) ? vstSlots.presetLaden(String(id), String(cid), String(name)) : null));
ipcMain.handle('vst-preset-loeschen', (e, cid, name) => (vstOk(e) ? vstSlots.presetLoeschen(String(cid), String(name)) : false));
ipcMain.handle('vst-liste', (e) => (vstOk(e) ? vst.liste() : null));
ipcMain.handle('vst-scannen', async (e, komplett) => {
  if (!vstOk(e)) return null;
  const sender = e.sender;
  return vst.scannen(!!komplett, (f) => { if (!sender.isDestroyed()) sender.send('vst-fortschritt', f); });
});
ipcMain.handle('vst-probe', (e, pfad, cid) => (vstOk(e) ? vst.probe(String(pfad), String(cid)) : null));
ipcMain.handle('vst-editor', (e, pfad, cid) => (vstOk(e) ? vst.editor(String(pfad), String(cid)) : null));
ipcMain.handle('vst-ordner-setzen', (e, liste) => {
  if (!vstOk(e) || !Array.isArray(liste)) return null;
  einst.vst = { ...(einst.vst || {}), ordner: liste.map(String).filter((x) => x && x.length < 400).slice(0, 20) };
  einstSpeichern();
  return vst.liste();
});
ipcMain.handle('log-ordner-oeffnen', (e) => { if (vstOk(e)) shell.openPath(log.ordner()); return true; });
ipcMain.handle('diagnose-erstellen', (e) => {
  if (!vstOk(e)) return null;
  try {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const name = `${t('Amberwave-Diagnose')}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.txt`;
    const ziel = log.diagnose(path.join(app.getPath('desktop'), name), `Client ${VERSION} · Electron ${process.versions.electron}`);
    shell.showItemInFolder(ziel);
    return { ok: true, pfad: ziel };
  } catch (x) { log.schreiben('FEHLER', `Diagnosedatei: ${x.message}`); return { ok: false, text: x.message }; }
});
// Client-Einstellungen aus der Web-App: im Infobereich weiterlaufen, mit Windows starten
const clientEinst = () => {
  let autostart = false;
  try { autostart = !!app.getLoginItemSettings({ args: ['--versteckt'] }).openAtLogin; } catch (e) { /* Linux-Test */ }
  return { tray: einst.tray !== false, autostart, sprache: i18n.einstellung() };
};
ipcMain.handle('client-einst', (e) => (erlaubt(e.senderFrame?.url || '') ? clientEinst() : null));
ipcMain.handle('client-einst-setzen', (e, w) => {
  if (!erlaubt(e.senderFrame?.url || '') || !w || typeof w !== 'object') return null;
  if (typeof w.tray === 'boolean') { einst.tray = w.tray; einstSpeichern(); }
  if (typeof w.sprache === 'string') spracheSetzen(w.sprache);
  if (typeof w.autostart === 'boolean') {
    try { app.setLoginItemSettings({ openAtLogin: w.autostart, args: ['--versteckt'] }); } catch (x) { /* Linux-Test */ }
  }
  return clientEinst();
});

/* ---------- Einrichtung (Server finden) ---------- */
const eigeneSeite = (e) => (e.senderFrame?.url || '').startsWith('file:');
ipcMain.handle('einrichtung-info', () => ({ version: VERSION, server: einst.server, port: einst.port || STANDARD_PORT, meldung: einrichtungMeldung, sprache: i18n.sprache(), spracheEinst: i18n.einstellung(), woerterbuch: i18n.woerterbuch() }));
ipcMain.handle('einrichtung-suchen', async (e, port) => {
  if (!eigeneSeite(e)) return null;
  if (port) { einst.port = Number(port) || STANDARD_PORT; einstSpeichern(); }
  return suchen(ports());
});
ipcMain.handle('einrichtung-pruefen', async (e, adresse, port) => {
  if (!eigeneSeite(e)) return null;
  const a = adresseNormal(adresse, Number(port) || einst.port || STANDARD_PORT);
  if (!a) return { fehler: t('Bitte eine Adresse wie 192.168.1.10 oder https://musik.example.de eingeben.') };
  const j = await pingen(a, 4000);
  if (!j) return { fehler: t('Unter {adresse} antwortet kein Amberwave-Server.', { adresse: a }) };
  const host = new URL(a).hostname;
  const lokal = /^http:\/\//.test(a) && (/^(10|127)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\./.test(host) || !host.includes('.') || /\.(local|lan|home\.arpa|fritz\.box|internal)$/i.test(host));
  return { server: { lan: lokal ? a : '', url: j.url || (lokal ? '' : a), name: j.name || 'Amberwave', version: j.version || '' } };
});
ipcMain.handle('einrichtung-verbinden', async (e, s) => {
  if (!eigeneSeite(e)) return null;
  if (!s || (!s.lan && !s.url)) return false;
  einst.server = { lan: s.lan || '', url: s.url || '', name: s.name || 'Amberwave', version: s.version || '' };
  einstSpeichern();
  const ziel = await erreichbar(einst.server);
  if (!ziel) return false;
  serverLaden(ziel);
  return true;
});

let einrichtungMeldung = '';
function einrichtungZeigen(meldung = '') {
  einrichtungMeldung = meldung;
  basis = '';
  engineSenden({ c: 'stopp' });
  fensterSicherstellen();
  fenster.loadFile(path.join(__dirname, 'einrichtung.html'));
}

/** Server erreichbar? Zuerst direkt im Heimnetz, dann über die öffentliche Adresse */
async function erreichbar(s) {
  if (!s) return '';
  if (s.lan && await pingen(s.lan, 1500)) return s.lan;
  if (s.url && await pingen(s.url, 3500)) return s.url;
  return '';
}

function serverLaden(adresse) {
  basis = new URL(adresse).origin;
  fensterSicherstellen();
  fenster.loadURL(`${basis}/`);
  passtZumServer(basis);
}

/* ---------- Passt der Server? Neue Version? ---------- */
let protokollGewarnt = '';
async function passtZumServer(adresse) {
  const j = await pingen(adresse, 4000).catch(() => null);
  const sp = Number(j?.client_protokoll || 0);
  if (!sp || sp === PROTOKOLL || protokollGewarnt === adresse) return;
  protokollGewarnt = adresse;
  const serverNeuer = sp > PROTOKOLL;
  log.schreiben('WARN', `Schnittstelle passt nicht: Server ${j.version || '?'} (Protokoll ${sp}), Client ${VERSION} (Protokoll ${PROTOKOLL})`);
  const r = await dialog.showMessageBox(fenster || undefined, {
    type: 'warning', title: 'Amberwave',
    message: serverNeuer ? t('Der Server ist neuer als dieser Client.') : t('Dieser Client ist neuer als der Server.'),
    detail: (serverNeuer ? t('Bitte den Windows-Client aktualisieren (Server {server}, Client {client}). Bis dahin kann manches nicht funktionieren.')
      : t('Bitte den Server aktualisieren (Server {server}, Client {client}). Bis dahin kann manches nicht funktionieren.')).replace('{server}', j.version || '?').replace('{client}', VERSION),
    buttons: serverNeuer ? [t('Herunterladen'), t('Später')] : [t('OK')], defaultId: 0, cancelId: serverNeuer ? 1 : 0,
  }).catch(() => ({ response: -1 }));
  if (serverNeuer && r.response === 0) shell.openExternal(RELEASES_SEITE);
}

/** Versionen vergleichen (1.2.3, 0.9.0-beta.2): >0 wenn a neuer ist */
function versionVergleich(a, b) {
  const teil = (v) => { const [kern, vor = ''] = String(v).replace(/^v/i, '').split('-'); return [kern.split('.').map((x) => Number(x) || 0), vor]; };
  const [ka, va] = teil(a), [kb, vb] = teil(b);
  for (let i = 0; i < 3; i++) if ((ka[i] || 0) !== (kb[i] || 0)) return (ka[i] || 0) - (kb[i] || 0);
  if (va === vb) return 0;
  if (!va) return 1;   // 1.0.0 ist neuer als 1.0.0-beta.3
  if (!vb) return -1;
  return va.localeCompare(vb, undefined, { numeric: true });
}

let neueVersion = null;   // { version, url }
async function aufNeueVersionPruefen() {
  if (einst.update_hinweis === false) return;
  try {
    const r = await fetch(`${RELEASES_URL}?per_page=20`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `AmberwaveClient/${VERSION}` }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return;
    const liste = await r.json();
    const vorab = VERSION.includes('-');
    let best = null;
    for (const x of Array.isArray(liste) ? liste : []) {
      if (!x || x.draft || (x.prerelease && !vorab)) continue;
      const v = String(x.tag_name || '').replace(/^v/i, '');
      if (/^\d+\.\d+\.\d+/.test(v) && (!best || versionVergleich(v, best.version) > 0)) best = { version: v, url: x.html_url || RELEASES_SEITE };
    }
    if (best && versionVergleich(best.version, VERSION) > 0 && best.version !== neueVersion?.version) {
      neueVersion = best;
      log.schreiben('INFO', `Neue Version verfügbar: ${best.version}`);
      trayAktualisieren();
      try { tray?.displayBalloon({ title: t('Neue Version {version}', { version: best.version }), content: t('Rechtsklick aufs Amberwave-Symbol → herunterladen.'), iconType: 'info' }); } catch (e) { /* nur Windows */ }
    }
  } catch (e) { /* offline – später nochmal */ }
}

async function ueberZeigen() {
  const ordner = path.dirname(process.execPath);
  const r = await dialog.showMessageBox(fenster || undefined, {
    type: 'info', title: t('Über Amberwave'), message: `Amberwave Windows Client ${VERSION}`,
    detail: t('Lizenz: GNU AGPL-3.0. Enthält Electron/Chromium, dr_flac/dr_wav und die Schnittstellen des VST3-SDK – die Liste der Fremdkomponenten mit ihren Lizenzen liegt im Programmordner.') + `\n\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    buttons: [t('Lizenzen anzeigen'), t('Schließen')], defaultId: 1, cancelId: 1,
  }).catch(() => ({ response: 1 }));
  if (r.response === 0) {
    for (const datei of ['DRITTANBIETER.md', 'LIZENZ-Amberwave.txt']) {
      const p = path.join(ordner, datei);
      if (fs.existsSync(p)) shell.openPath(p);
    }
  }
}

/* ---------- Fenster ---------- */
const TITEL_FARBE = '#120d0a', TITEL_SYMBOL = '#f6efe7', TITEL_HOEHE = 40;
/** theme-color der Seite → Titelleiste (Fensterknöpfe); Symbolfarbe hell oder dunkel je nach Helligkeit */
function titelFarbe(farbe) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(farbe || '').trim());
  if (!m || !fenster || fenster.isDestroyed()) return;
  const n = parseInt(m[1], 16), hell = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 140;
  try { fenster.setTitleBarOverlay({ color: '#' + m[1], symbolColor: hell ? '#1a120c' : TITEL_SYMBOL, height: TITEL_HOEHE }); } catch (e) { /* ältere Systeme */ }
}

function fensterSicherstellen() {
  if (fenster && !fenster.isDestroyed()) return;
  const f = einst.fenster || {};
  fenster = new BrowserWindow({
    width: f.width || 1360, height: f.height || 860, x: f.x, y: f.y,
    minWidth: 420, minHeight: 520,
    backgroundColor: '#120d0a',
    title: 'Amberwave Client',
    icon: path.join(__dirname, 'bilder', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    // Titelleiste in der App-Farbe: die Kopfzeile der Web-App ist die Titelleiste, die Windows-Knöpfe bleiben nativ
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: TITEL_FARBE, symbolColor: TITEL_SYMBOL, height: TITEL_HOEHE },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  if (f.max) fenster.maximize();
  // Autostart mit Windows: unsichtbar im Infobereich starten
  const versteckt = process.argv.includes('--versteckt') && !fensterGezeigt && tray;
  fenster.once('ready-to-show', () => { if (!versteckt) { fenster.show(); fensterGezeigt = true; } });
  fenster.on('page-title-updated', (_e, t) => { titelText = String(t || '').slice(0, 120); trayAktualisieren(); });
  fenster.webContents.on('did-change-theme-color', (_e, farbe) => titelFarbe(farbe || TITEL_FARBE));
  fenster.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  fenster.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:')) return;
    if (!erlaubt(url)) { e.preventDefault(); shell.openExternal(url); }
  });
  // Seite neu geladen (F5) oder verlassen: wie im Browser hört die Wiedergabe auf
  fenster.webContents.on('did-start-navigation', (d) => {
    if (d.isMainFrame && !d.isSameDocument) engineSenden({ c: 'stopp' });
  });
  fenster.webContents.on('did-fail-load', (_e, code, text, url, haupt) => {
    if (!haupt || code === -3 || url.startsWith('file:')) return;
    einrichtungZeigen(t('Der Server ist gerade nicht erreichbar ({grund}).', { grund: text }));
  });
  // Kein Zoom: die Oberfläche sitzt immer passend im Fenster (auch ein früher gemerkter Zoom wird zurückgesetzt)
  try { Promise.resolve(fenster.webContents.setVisualZoomLevelLimits(1, 1)).catch(() => {}); } catch { /* ältere Electron */ }
  fenster.webContents.on('did-finish-load', () => fenster.webContents.setZoomFactor(1));
  fenster.webContents.on('zoom-changed', () => fenster.webContents.setZoomFactor(1));
  fenster.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.control && !input.alt && ['+', '-', '=', '0'].includes(input.key)) { e.preventDefault(); return; }
    if (input.key === 'F5') { fenster.webContents.reload(); e.preventDefault(); }
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) { fenster.webContents.toggleDevTools(); e.preventDefault(); }
  });
  const merken = () => {
    if (!fenster || fenster.isDestroyed()) return;
    const max = fenster.isMaximized();
    einst.fenster = { ...(max ? einst.fenster || {} : fenster.getBounds()), max };
  };
  fenster.on('resize', merken);
  fenster.on('move', merken);
  fenster.on('close', (e) => {
    merken(); einstSpeichern();
    // Im Infobereich weiterlaufen: Fenster nur verstecken – Wiedergabe und Fernsteuerung laufen weiter
    if (!beenden && einst.tray !== false && tray) {
      e.preventDefault();
      fenster.hide();
      if (!einst.tray_hinweis) {
        einst.tray_hinweis = true; einstSpeichern();
        try { tray.displayBalloon({ title: t('Amberwave läuft weiter'), content: t('Im Infobereich – so bleibt der PC per Fernsteuerung erreichbar. Beenden: Rechtsklick aufs Symbol.'), iconType: 'info' }); } catch (x) { /* nur Windows */ }
      }
    }
  });
  fenster.on('closed', () => { fenster = null; });
}

/* ---------- Infobereich (Tray) und Medientasten ---------- */
function trayAktualisieren() {
  if (!tray) return;
  tray.setToolTip(titelText ? `Amberwave – ${titelText}` : 'Amberwave');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('Amberwave anzeigen'), click: () => { fensterSicherstellen(); fenster.show(); fenster.focus(); } },
    { type: 'separator' },
    { label: spielt ? t('Pause') : t('Abspielen'), click: () => senden('taste', 'playpause') },
    { label: t('Nächster Titel'), click: () => senden('taste', 'next') },
    { label: t('Vorheriger Titel'), click: () => senden('taste', 'prev') },
    { type: 'separator' },
    { label: t('Server wechseln …'), click: () => einrichtungZeigen() },
    {
      label: t('Sprache / Language'),
      submenu: [['auto', t('Automatisch')], ['de', 'Deutsch'], ['en', 'English']].map(([wert, label]) => ({
        label, type: 'radio', checked: i18n.einstellung() === wert, click: () => spracheSetzen(wert),
      })),
    },
    ...(neueVersion ? [{ label: t('Neue Version {version} – herunterladen', { version: neueVersion.version }), click: () => shell.openExternal(neueVersion.url) }] : []),
    { label: t('Über Amberwave …'), click: () => ueberZeigen() },
    { label: t('Version {version}', { version: VERSION }), enabled: false },
    { label: t('Beenden'), click: () => { beenden = true; app.quit(); } },
  ]));
}

function medientasten() {
  const tasten = { MediaPlayPause: 'playpause', MediaNextTrack: 'next', MediaPreviousTrack: 'prev', MediaStop: 'stop' };
  for (const [taste, art] of Object.entries(tasten)) {
    try { globalShortcut.register(taste, () => senden('taste', art)); } catch (e) { /* belegt */ }
  }
}


/* ---------- Start ---------- */
app.on('second-instance', () => {
  if (fenster) { if (fenster.isMinimized()) fenster.restore(); fenster.show(); fenster.focus(); }
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  engineStarten();
  medientasten();
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'bilder', 'tray.png')));
    tray.on('click', () => { fensterSicherstellen(); fenster.show(); fenster.focus(); });
    trayAktualisieren();
  } catch (e) { tray = null; }

  setTimeout(aufNeueVersionPruefen, 20000);
  setInterval(aufNeueVersionPruefen, 12 * 3600 * 1000);
  const s = einst.server;
  if (s) {
    const ziel = await erreichbar(s);
    if (ziel) { serverLaden(ziel); return; }
    // anderer Platz im Netz (neue IP)? Derselbe Server wird am Namen bzw. an der öffentlichen Adresse erkannt
    const funde = await suchen(ports());
    const gleich = funde.find((f) => (s.url && f.url === s.url) || (f.name && f.name === s.name));
    if (gleich) {
      einst.server = { ...s, lan: gleich.lan, version: gleich.version };
      einstSpeichern();
      serverLaden(gleich.lan);
      return;
    }
    einrichtungZeigen(t('„{name}“ ist gerade nicht erreichbar.', { name: s.name }));
    return;
  }
  einrichtungZeigen();
});

app.on('before-quit', () => { beenden = true; try { vstSlots.alleBeenden(); } catch (e) { /* egal */ } });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  beenden = true;
  globalShortcut.unregisterAll();
  engineSenden({ c: 'beenden' });
  const e = engine;
  if (e) setTimeout(() => { try { e.kill(); } catch (x) { /* schon weg */ } }, 1500);
});
