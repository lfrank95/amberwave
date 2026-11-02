// Amberwave Connect: gekoppelte Amberwave-Server. Eigener Reiter mit allen Servern, darin stöbern wie in der eigenen
// Bibliothek, reinhören (unser Server holt den Titel verschlüsselt ab und reicht ihn durch) und Alben, Titel oder
// Playlists „auf diesen Server laden“. Dazu die Einstellungen (Ausweis, Koppeln, Rechte, Qualität, Tempo).
import { api, versuche } from './api.js';
import { t, tn, zahl } from './i18n.js';
import { h, icon, dauer, dauerText, datumZeit, toast, dialog, bestaetigen, menue, groesse } from './ui.js';
import { verbindungsGraph, graphDaten } from './verbindungen.js';
import { TempoMesser, tempoText, connectKarte, durchsatzKurve, connectZeichen } from './uebertragung_ui.js';
import { albumKachel, kuenstlerKachel, raster, abschnitt, leer, typZeile, albumTrackliste, einfacheTrackliste } from './bausteine.js';

export const QUALITAETEN = () => [
  ['original', t('Original'), t('verlustfrei, genau wie dort gespeichert')],
  ['flac1644', 'FLAC 16/44,1', t('verlustfrei in CD-Qualität – kleiner bei Hi-Res')],
  ['opus256', 'Opus 256', t('klingt wie das Original, etwa ein Viertel so groß')],
  ['opus160', 'Opus 160', t('sehr gut, etwa ein Siebtel')],
  ['opus128', 'Opus 128', t('gut, am kleinsten')],
  ['aac256', 'AAC 256', t('für Geräte ohne Opus')],
  ['aac160', 'AAC 160', t('für Geräte ohne Opus, kleiner')],
];
const qualiName = (q) => QUALITAETEN().find((x) => x[0] === q)?.[1] || q;
const WEG = () => ({ heimnetz: t('Heimnetz'), direkt: t('Direktzugang'), tunnel: t('Tunnel'), rueckkanal: t('Rückkanal') });

// ---------- Hilfen ----------

const istAdmin = (app) => app.ich.user.rolle === 'admin';
const pfad = (sid, rest = '') => `/connect/${sid}${rest}`;

/** Server-Liste (kurz zwischengespeichert – Reiter, Menüs und Ansichten fragen oft) */
let serverCache = null;
async function serverListe(frisch = false) {
  if (!frisch && serverCache && Date.now() - serverCache.zeit < 30000) return serverCache.daten;
  const daten = await api.get('/connect/server');
  serverCache = { daten, zeit: Date.now() };
  return daten;
}
export function connectCacheLeeren() { serverCache = null; }

const lesen = (sid, methode, abfrage = {}, signal) => {
  const q = new URLSearchParams(Object.entries(abfrage).filter(([, v]) => v !== '' && v != null)).toString();
  return api.get(`/connect/server/${sid}/lesen/${methode}${q ? `?${q}` : ''}`, { signal });
};

/** Links und Knöpfe der Bibliotheks-Bausteine auf den gekoppelten Server umbiegen (Merken gibt es dort nicht) */
function umbiegen(html, sid) {
  return html
    .replaceAll('href="/alben/', `href="/connect/${sid}/alben/`)
    .replaceAll('href="/kuenstler/', `href="/connect/${sid}/kuenstler/`)
    .replace(/<button[^>]*data-aktion="fav"[^>]*>[\s\S]*?<\/button>/g, '')
    .replaceAll('data-aktion="album-play"', `data-aktion="c-album-play" data-server="${sid}"`)
    .replaceAll('data-aktion="track-menue"', `data-aktion="c-track-menue" data-server="${sid}"`)
    .replace(/<a class="pille" href="\/alben\?genre=[^"]*" data-link>([^<]*)<\/a>/g, '<span class="pille">$1</span>');
}

/** Titel eines gekoppelten Servers für den Player: eigene ID (c<server>-<titel>), Wege zum Album/Künstler dort */
export function connectTitel(sid, server, tk, album = null) {
  const al = album || tk.album;
  return {
    ...tk, id: `c${sid}-${tk.id}`, rid: tk.id, connect: sid, server, favorit: false, credits: tk.credits || [],
    kuenstler: (tk.kuenstler || []).map((k) => ({ ...k, pfad: pfad(sid, `/kuenstler/${k.id}`) })),
    album: al ? { id: al.id, titel: al.titel, cover: al.cover || al.edition?.cover || null, pfad: pfad(sid, `/alben/${al.id}`) } : null,
  };
}

function wegChipInnen(s) {
  if (!s.erreichbar) return `<span class="einst-chip warn">${h(t('nicht erreichbar'))}</span>`;
  const art = WEG()[s.weg?.art] || s.weg?.art || '';
  return `<span class="einst-chip gut">${h(art)}${s.weg?.ms != null ? ` · ${zahl(s.weg.ms)} ms` : ''}</span>`;
}
function wegChip(s) {
  return `<span data-weg-s="${s.id}">${wegChipInnen(s)}</span>`;
}

/**
 * Verbindungsanzeigen live halten: alle 8 s (nur sichtbar) die Serverliste holen und Weg-Chips sowie die Netzkarte
 * auffrischen – ein Wechsel aufs Heimnetz oder auf den Rückkanal erscheint so ohne Neuladen und ohne „Verbindung prüfen“.
 */
function wegeLiveHalten(wurzel, signal) {
  let zuletzt = '';
  const runde = async () => {
    if (!wurzel.isConnected || signal?.aborted) { clearInterval(uhr); return; }
    if (document.hidden) return;
    let r;
    try { r = await serverListe(true); } catch (e) { return; }
    const stand = JSON.stringify(r.server.map((s) => [s.id, s.erreichbar, s.weg?.art]));
    for (const s of r.server) wurzel.querySelectorAll(`[data-weg-s="${s.id}"]`).forEach((el) => { el.innerHTML = wegChipInnen(s); });
    if (zuletzt && stand !== zuletzt) wurzel.dispatchEvent(new CustomEvent('cn-wege', { detail: r }));
    zuletzt = stand;
  };
  const uhr = setInterval(runde, 8000);
  signal?.addEventListener('abort', () => clearInterval(uhr));
  runde();
}

/** Album-Kachel eines anderen Servers – mit Hinweis, wenn wir das Album selbst schon haben */
function kachel(a, opt = {}) {
  const html = albumKachel({ ...a, favorit: false, ...(a._da ? { hinweis: t('Hast du schon') } : {}) }, { ...opt, herz: false });
  return a._da ? html.replace('<div class="kachel"', '<div class="kachel cn-da"') : html;
}

/** Titel, die wir selbst schon haben, in einer gezeichneten Liste markieren */
function titelMarkieren(wurzel, tracks) {
  for (const tk of tracks) {
    if (!tk._da) continue;
    const z = wurzel.querySelector(`.track[data-track-id="${CSS.escape(String(tk.id))}"]`);
    if (!z || z.classList.contains('cn-da')) continue;
    z.classList.add('cn-da');
    z.querySelector('.track-titel')?.insertAdjacentHTML('beforeend', `<span class="cn-da-marke" title="${h(t('Diesen Titel hast du schon auf deinem Server'))}">${icon('haken', 12)}${h(t('hast du'))}</span>`);
  }
}

// ---------- Aktionen (ein Klick-Handler für alle Connect-Ansichten) ----------

let registriert = false;
function aktionenRegistrieren(app) {
  if (registriert) return;
  registriert = true;
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-aktion^="c-"]');
    if (!el || el.disabled) return;
    const sid = Number(el.dataset.server);
    switch (el.dataset.aktion) {
      case 'c-album-play':
      case 'c-album-zufall': {
        e.preventDefault();
        const a = await versuche(() => albumLaden(sid, el.dataset.id));
        if (!a) return;
        const tracks = a.tracks.filter((x) => x.verfuegbar).map((x) => connectTitel(sid, a._server.name, x, a));
        if (!tracks.length) { toast(t('Von diesem Album liegen keine Dateien vor.'), 'fehler'); return; }
        if (el.dataset.aktion === 'c-album-zufall' && !app.player.einst.zufall) app.player.zufallUmschalten();
        app.player.abspielen(tracks, el.dataset.aktion === 'c-album-zufall' ? Math.floor(Math.random() * tracks.length) : 0, { art: 'album' });
        break;
      }
      case 'c-track-menue': {
        const l = app.listen.get(el.dataset.liste);
        const tk = l?.[Number(el.dataset.i)];
        if (tk) titelMenue(app, el, sid, tk);
        break;
      }
    }
  });
}

const albumCache = new Map();
async function albumLaden(sid, id, signal) {
  const k = `${sid}:${id}`;
  const c = albumCache.get(k);
  if (c && Date.now() - c.zeit < 60000) return c.daten;
  const daten = await lesen(sid, 'album', { id }, signal);
  albumCache.set(k, { daten, zeit: Date.now() });
  return daten;
}

function titelMenue(app, anker, sid, tk) {
  const s = tk.server || '';
  const e = [
    { titel: tk.titel },
    { text: t('Als Nächstes spielen'), icon: 'naechstes', aktion: () => app.player.alsNaechstes([tk]) },
    { text: t('Zur Warteschlange'), icon: 'warteschlange', aktion: () => app.player.anhaengen([tk]) },
  ];
  if (tk.album && !location.pathname.startsWith(tk.album.pfad)) e.push({ text: t('Zum Album'), icon: 'album', aktion: () => app.navigieren(tk.album.pfad) });
  (tk.kuenstler || []).slice(0, 3).forEach((k) => e.push({ text: t('Zu {name}', { name: k.name }), icon: 'kuenstler', aktion: () => app.navigieren(k.pfad) }));
  const dir = serverCache?.daten?.server?.find((x) => x.id === sid)?.dir_erlaubt;
  if (istAdmin(app) && dir?.holen !== false) {
    e.push({ trenner: true }, { text: t('Auf diesen Server laden …'), icon: 'holen', aktion: () => setTimeout(() => holenMenue(app, anker, sid, { art: 'titel', id: tk.rid, titel: tk.titel, unter: s }), 0) });
  }
  menue(anker, e);
}

/** „Auf diesen Server laden“: Qualität wählen (Standard zuerst), dann Auftrag anlegen */
async function holenMenue(app, anker, sid, ziel) {
  if (!serverCache) await serverListe().catch(() => null);
  const dir = serverCache?.daten?.server?.find((x) => x.id === sid)?.dir_erlaubt || {};
  const std = app.ich.admin?.connect_qualitaet || 'opus256';
  const qs = QUALITAETEN().filter(([q]) => dir.original !== false || !['original', 'flac1644'].includes(q));
  const los = async (q) => {
    const r = await versuche(() => api.post(`/connect/server/${sid}/holen`, { ...ziel, qualitaet: q }));
    if (!r) return;
    toast(t('„{titel}“ wird geholt ({q}) – Fortschritt unter Amberwave Connect.', { titel: ziel.titel, q: qualiName(q) }));
    app.connectZahl?.(1);
  };
  menue(anker, [
    { titel: t('Auf diesen Server laden') },
    ...qs.map(([q, name, unter]) => ({ text: q === std ? t('{name} (Standard)', { name }) : name, unter, an: q === std, svg: icon('holen', 18), aktion: () => los(q) })),
  ]);
}

/** Für die eigenen Menüs (Album, Titel, Playlist): „Auf <Server> laden“ – schickt es zum gekoppelten Server */
export function connectSendenEintraege(app, anker, art, id, titel, unter = '') {
  if (!istAdmin(app)) return [];
  const ziele = (app.ich.app?.connect || []).filter((s) => s.senden);
  if (!ziele.length) return [];
  return [{ trenner: true }, ...ziele.map((s) => ({
    text: t('Auf {server} laden …', { server: s.name }), icon: 'connect',
    aktion: () => setTimeout(() => {
      const std = app.ich.admin?.connect_qualitaet || 'opus256';
      menue(anker, [{ titel: t('Auf {server} laden', { server: s.name }) }, ...QUALITAETEN().map(([q, name, u]) => ({
        text: q === std ? t('{name} (Standard)', { name }) : name, unter: u, an: q === std, svg: icon('connect', 18),
        aktion: async () => {
          if (await versuche(() => api.post(`/connect/server/${s.id}/senden`, { art, id, titel, unter, qualitaet: q }))) {
            toast(t('„{titel}“ geht an {server} – der holt es sich jetzt ab.', { titel, server: s.name }));
          }
        },
      }))]);
    }, 0),
  }))];
}

// ---------- Ansichten ----------

/** Kleine Linien im Knopf „Verbindungen“: wie die Partner gerade erreicht werden */
function cnPunkte(r) {
  const k = { heimnetz: 'nk-heimnetz', direkt: 'nk-direkt', rueckkanal: 'nk-rueck' };
  const arten = [...new Set(r.server.map((s) => (s.erreichbar ? k[s.weg?.art] || 'nk-tunnel' : 'nk-aus')))].slice(0, 3);
  return `<i class="cs-punkte" aria-hidden="true">${arten.map((a) => `<b class="${a}"></b>`).join('')}</i>`;
}

function kopf(titel, unter = '', rechts = '') {
  return `<div class="seiten-kopf"><div><h1>${titel}</h1>${unter ? `<div class="unter">${unter}</div>` : ''}</div>${rechts}</div>`;
}

/** Brotkrumen: Amberwave Connect › Server */
function pfadZeile(s, extra = '') {
  return `<div class="cn-pfad"><a href="/connect" data-link>${icon('connect', 15)}<span>Amberwave Connect</span></a>${s ? `<span>›</span><a href="${pfad(s.id)}" data-link>${h(s.name)}</a>` : ''}${extra}</div>`;
}

/** Ein wartender Auftrag als Zeile der Warteschlange */
function warteZeile(a, platz) {
  const art = { album: t('Album'), titel: t('Titel'), playlist: t('Playlist') }[a.art] || a.art;
  return `<div class="ue-zeile">${a.cover ? `<img src="${h(a.cover)}" alt="" loading="lazy">` : `<span class="ue-cover-leer ue-zeile-ico">${connectZeichen(20)}</span>`}
    <div class="ue-zeile-text"><b>${h(a.titel || art)}</b><small>${connectZeichen(13)}${h([t('von {server}', { server: a.server }), art, a.dateien ? tn(a.dateien, '1 Titel', '{n} Titel') : '', qualiName(a.qualitaet), a.gesamt ? groesse(a.gesamt) : ''].filter(Boolean).join(' · '))}</small></div>
    <span class="einst-chip">${h(t('Platz {n}', { n: platz }))}</span>
    <button type="button" class="ue-ico" data-auftrag="${a.id}" data-was="abbrechen" title="${h(t('Abbrechen'))}" aria-label="${h(t('Abbrechen'))}">${icon('zu', 16)}</button></div>`;
}

/** Ein fehlgeschlagener Auftrag */
function fehlerZeile(a) {
  return `<div class="ue-fehler"><span class="ue-fehler-ico">${icon('warnung', 18)}</span>
    <div class="ue-zeile-text"><b>${h(a.titel || a.art)}${a.server ? ` – ${h(a.server)}` : ''}</b><small>${h(a.fehler || t('Abgebrochen'))}${a.dateien ? ` · ${h(t('{f} von {n} Titeln übertragen', { f: a.fertig, n: a.dateien }))}` : ''}</small></div>
    <button type="button" class="btn btn-zweit btn-klein" data-auftrag="${a.id}" data-was="wiederholen">${t('Nochmal')}</button>
    <button type="button" class="ue-ico" data-auftrag="${a.id}" data-was="entfernen" title="${h(t('Aus der Liste entfernen'))}" aria-label="${h(t('Aus der Liste entfernen'))}">${icon('zu', 16)}</button></div>`;
}

/** Fertige Übertragungen als Tabelle */
function fertigTabelle(liste) {
  const dauerVon = (a) => (a.gestartet && a.fertig_am ? Math.max(0, (new Date(a.fertig_am) - new Date(a.gestartet)) / 1000) : 0);
  const zeile = (a) => {
    const sek = dauerVon(a);
    return `<tr><td>${a.cover ? `<img src="${h(a.cover)}" alt="" loading="lazy">` : ''}</td><td><b>${h(a.titel || a.art)}</b><small>${connectZeichen(13)}${h(t('von {server}', { server: a.server }))}</small></td>
      <td>${h(qualiName(a.qualitaet))}</td><td>${a.gesamt ? groesse(a.gesamt) : ''}</td><td>${sek ? dauer(sek * 1000) : ''}</td><td>${sek && a.gesamt ? tempoText(a.gesamt / sek) : ''}</td>
      <td>${a.fertig_am ? h(datumZeit(a.fertig_am)) : ''}</td>
      <td><button type="button" class="ue-ico" data-auftrag="${a.id}" data-was="entfernen" title="${h(t('Aus der Liste entfernen'))}" aria-label="${h(t('Aus der Liste entfernen'))}">${icon('zu', 14)}</button></td></tr>`;
  };
  return `<div class="ue-tabelle"><table><thead><tr><th></th><th>${t('Album')}</th><th>${t('Qualität')}</th><th>${t('Größe')}</th><th>${t('Dauer')}</th><th>${t('Tempo')}</th><th>${t('Fertig')}</th><th></th></tr></thead><tbody>${liste.map(zeile).join('')}</tbody></table></div>`;
}

/** Übertragungen im Stil eines Download-Managers: Übersicht mit Durchsatz, Probleme, Läuft, Warteschlange, Fertig */
async function auftraegeZeichnen(app, box, signal) {
  let timer = null;
  const messer = new TempoMesser();
  let wege = {};
  const zeichnen = async () => {
    clearTimeout(timer);
    let r;
    try { r = await api.get('/connect/auftraege', { signal }); } catch (e) { return; }
    if (!box.isConnected) return;
    try { wege = Object.fromEntries((await serverListe()).server.map((s) => [s.id, s.erreichbar ? WEG()[s.weg?.art] || '' : t('nicht erreichbar')])); } catch (e) { /* ohne Wege */ }
    const l = r.auftraege || [];
    const laeuft = l.filter((a) => a.status === 'laeuft'), wartet = l.filter((a) => a.status === 'wartet');
    const probleme = l.filter((a) => ['fehler', 'abgebrochen'].includes(a.status)), fertig = l.filter((a) => a.status === 'fertig');
    const tempi = Object.fromEntries(laeuft.map((a) => [a.id, messer.messen(a.id, a.bytes)]));
    messer.punkt(Object.values(tempi).reduce((x, y) => x + y, 0));
    const summe = Object.values(tempi).reduce((x, y) => x + y, 0);
    const heute = new Date().toDateString();
    if (!l.length) {
      box.innerHTML = `<p class="ue-leer">${t('Noch nichts übertragen. Im Menü eines Albums, Titels oder einer Playlist auf einem gekoppelten Server: „Auf diesen Server laden“.')}</p>`;
    } else {
      const auf = box.querySelector('.ue-dateien')?.open;
      box.innerHTML = `<div class="ue">
        <section class="ue-uebersicht">
          <div class="ue-zahlen"><div><b>${laeuft.length}</b><span>${t('laufen')}</span></div><div><b>${wartet.length}</b><span>${t('warten')}</span></div>
            <div class="${probleme.length ? 'ue-zahl-warn' : ''}"><b>${probleme.length}</b><span>${tn(probleme.length, 'Problem', 'Probleme')}</span></div>
            <div><b>${fertig.filter((a) => a.fertig_am && new Date(a.fertig_am).toDateString() === heute).length}</b><span>${t('fertig heute')}</span></div></div>
          <div class="ue-durchsatz"><div class="ue-d-kopf"><span><i class="ue-leg rein"></i>${t('rein')} <b>${tempoText(summe) || '–'}</b></span></div>
            ${durchsatzKurve(messer.verlauf)}<div class="ue-achse"><span>${t('vor 10 min')}</span><span>${t('jetzt')}</span></div></div>
        </section>
        ${probleme.length ? `<section class="ue-teil"><h2>${t('Probleme')}</h2><div class="ue-liste">${probleme.map(fehlerZeile).join('')}</div></section>` : ''}
        ${laeuft.length ? `<section class="ue-teil"><h2>${t('Läuft')}</h2><div class="ue-aktiv-liste">${laeuft.map((a) => connectKarte(a, tempi[a.id], wege[a.server_id] || '')).join('')}</div></section>` : ''}
        ${wartet.length ? `<section class="ue-teil"><h2>${t('Warteschlange')} <small>${h(t('der Reihe nach'))}</small></h2><div class="ue-liste">${wartet.map((a, i) => warteZeile(a, i + 1)).join('')}</div></section>` : ''}
        ${fertig.length ? `<section class="ue-teil"><h2>${t('Fertig')}</h2>${fertigTabelle(fertig)}</section>` : ''}
      </div>`;
      if (auf != null) box.querySelectorAll('.ue-dateien').forEach((d) => { d.open = auf; });
    }
    const offen = laeuft.length + wartet.length;
    app.connectZahl?.(offen, true);
    if (offen) timer = setTimeout(zeichnen, 2000);
  };
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-auftrag]');
    if (!b) return;
    b.disabled = true;
    await versuche(() => api.post(`/connect/auftraege/${b.dataset.auftrag}/${b.dataset.was}`));
    zeichnen();
  });
  signal?.addEventListener('abort', () => clearTimeout(timer));
  await zeichnen();
}

/** Verbindungen: derselbe Graph wie im Dashboard, als Fenster (am Handy von unten) – frischt sich auf, solange es offen ist */
async function verbindungenOeffnen(app) {
  const d = document.createElement('dialog');
  d.className = 'cs-fenster';
  d.setAttribute('aria-label', t('Verbindungen'));
  document.body.appendChild(d);
  let geraete = null;
  const zeichnen = async () => {
    let r;
    try { r = await serverListe(true); } catch (e) { return; }
    if (istAdmin(app)) geraete = (await api.get('/admin/dashboard?teil=geraete').catch(() => null))?.geraete || geraete;
    if (!d.open) return;
    const ad = r.adressen || {};
    const unterwegs = ad.tunnel || ad.oeffentlich || '';
    const chips = [ad.lan?.[0] ? `<span class="einst-chip gut">${h(t('zuhause: {a}', { a: ad.lan[0].replace(/^https?:\/\//, '') }))}</span>` : '',
      unterwegs ? `<span class="einst-chip gut">${h(t('unterwegs: {a}', { a: unterwegs.replace(/^https?:\/\//, '') }))}</span>` : '',
      r.server.length ? `<span class="einst-chip">${h(tn(r.server.length, '1 Connect-Partner', '{n} Connect-Partner'))}</span>` : ''].join('');
    const offen = d.querySelector('.cs-inhalt');
    const html = `${chips ? `<div class="gz-kopf">${chips}</div>` : ''}${verbindungsGraph(graphDaten({ ausweis: r.ausweis, server: r.server, geraete, adresseUnterwegs: unterwegs }))}`;
    if (offen) offen.innerHTML = html;
    else {
      d.innerHTML = `<div class="cs-fenster-kopf"><div><h2>${t('Verbindungen')}</h2><p>${h(t('Wer gerade mit {name} verbunden ist – Apps, Geräte und andere Amberwave-Server', { name: r.ausweis.name }))}</p></div>
        <button type="button" class="cs-zu" data-zu aria-label="${h(t('Schließen'))}">${icon('zu', 20)}</button></div><div class="cs-inhalt">${html}</div>`;
      d.querySelector('[data-zu]').addEventListener('click', () => d.close());
    }
  };
  d.innerHTML = '<div class="lade"></div>';
  d.showModal();
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });   // Klick auf den Schleier
  d.addEventListener('close', () => { clearInterval(uhr); d.remove(); });
  const uhr = setInterval(() => { if (!document.hidden) zeichnen(); }, 8000);
  await zeichnen();
}

export const connectAnsichten = {
  /** Alle gekoppelten Server und die Übertragungen */
  async uebersicht({ app, ziel, signal }) {
    aktionenRegistrieren(app);
    const r = await serverListe(true);
    const admin = istAdmin(app);
    const karte = (s) => `<a class="cn-server" href="${pfad(s.id)}" data-link>
        <span class="cn-server-sym">${icon('connect', 26)}</span>
        <span class="cn-server-text"><b>${h(s.name)}</b><small>${h(s.kennung)}${s.version ? ` · ${h(s.version)}` : ''}</small><span class="cn-server-weg">${wegChip(s)}</span></span>
      </a>`;
    ziel.innerHTML = kopf('Amberwave Connect', t('Dein Server {name} · Ausweis {kennung}', { name: h(r.ausweis.name), kennung: `<code>${h(r.ausweis.kennung)}</code>` }),
      `<div class="cs-knoepfe">${r.server.length || admin ? `<button type="button" class="btn btn-zweit cs-knopf" data-verbindungen>${icon('graph', 18)}<span>${t('Verbindungen')}</span>${cnPunkte(r)}</button>` : ''}
        ${admin ? `<a class="btn btn-zweit" href="/einstellungen/connect" data-link>${icon('einstellungen', 18)}<span>${t('Server koppeln')}</span></a>` : ''}</div>`) + `
      ${r.server.length ? `<div class="cn-server-liste">${r.server.map(karte).join('')}</div>`
        : leer(t('Noch kein Server gekoppelt'), admin ? t('Koppel einen zweiten Amberwave – etwa im Wohnwagen oder bei der Familie. Dann stöberst du hier in seiner Musik, hörst rein und holst dir Alben herüber.') : t('Ein Admin kann unter Einstellungen › Amberwave Connect einen weiteren Amberwave-Server koppeln.'),
          admin ? `<a class="btn" href="/einstellungen/connect" data-link>${t('Server koppeln')}</a>` : '')}
      ${admin ? abschnitt(t('Übertragungen'), '<div data-auftraege><div class="lade"></div></div>') : ''}`;
    wegeLiveHalten(ziel, signal);
    ziel.querySelector('[data-verbindungen]')?.addEventListener('click', () => verbindungenOeffnen(app));
    ziel.addEventListener('cn-wege', (e) => { const p = ziel.querySelector('.cs-punkte'); if (p) p.outerHTML = cnPunkte(e.detail); });
    const box = ziel.querySelector('[data-auftraege]');
    if (box) await auftraegeZeichnen(app, box, signal);
    document.title = 'Amberwave Connect';
  },

  /** Ein Server: Alben, Künstler, Playlists und Suche – wie die eigene Bibliothek */
  async server({ app, ziel, param, query, signal }) {
    aktionenRegistrieren(app);
    const sid = Number(param[0]);
    const zeige = ['alben', 'kuenstler', 'playlists'].includes(query.get('zeige')) ? query.get('zeige') : 'alben';
    const q = query.get('q') || '';
    const reiter = (w, tx) => `<a class="pille${zeige === w && !q ? ' an' : ''}" href="${pfad(sid, w === 'alben' ? '' : `?zeige=${w}`)}" data-link>${h(tx)}</a>`;
    // Erst der Kopf (der Weg zum Server wird beim Lesen gesucht – das kann einen Moment dauern)
    const s0 = (await serverListe().catch(() => ({ server: [] }))).server.find((x) => x.id === sid) || { id: sid, name: '…' };
    ziel.innerHTML = pfadZeile(null) + kopf(h(s0.name), `<span data-cn-weg>${s0.kennung ? `${h(s0.kennung)} · ` : ''}${wegChip(s0)}</span>`, '') + `
      <div class="filterleiste cn-filter">
        <div class="pillen" style="margin:0">${reiter('alben', t('Alben'))}${reiter('kuenstler', t('Künstler'))}${reiter('playlists', t('Playlists'))}</div>
        <span class="abstand"></span>
        <form class="cn-suche" data-cn-suche role="search">${icon('suche', 16)}<input type="search" name="q" value="${h(q)}" placeholder="${h(t('Bei {name} suchen', { name: s0.name }))}" aria-label="${h(t('Suchen'))}" enterkeyhint="search"></form>
      </div>
      <div data-cn-inhalt><div class="lade"></div></div>`;
    ziel.querySelector('[data-cn-suche]').addEventListener('submit', (e) => {
      e.preventDefault();
      const w = new FormData(e.currentTarget).get('q').trim();
      app.navigieren(pfad(sid, w ? `?q=${encodeURIComponent(w)}` : ''));
    });
    const inhalt = ziel.querySelector('[data-cn-inhalt]');
    let r;
    try {
      r = q ? await lesen(sid, 'suche', { q, limit: 50 }, signal)
        : zeige === 'kuenstler' ? await lesen(sid, 'kuenstler_liste', { sort: 'name' }, signal)
        : zeige === 'playlists' ? await lesen(sid, 'playlists', {}, signal)
        : await lesen(sid, 'alben', { sort: 'kuenstler' }, signal);
    } catch (e) {
      if (e.name === 'AbortError') return;
      inhalt.innerHTML = leer(t('Gerade kein Zugriff'), h(e.message || t('Der Server ist nicht erreichbar.')),
        `<button type="button" class="btn btn-zweit" data-cn-nochmal>${t('Nochmal versuchen')}</button>`);
      inhalt.querySelector('[data-cn-nochmal]')?.addEventListener('click', async () => {
        await versuche(() => api.post(`/connect/server/${sid}/pruefen`));
        connectCacheLeeren();
        app.navigieren(location.pathname + location.search, false, true);
      });
      return;
    }
    const s = r._server;
    ziel.querySelector('h1').textContent = s.name;
    ziel.querySelector('[data-cn-weg]').innerHTML = `${h(s.kennung)} · ${wegChip(s)}`;
    if (q) {
      const tracks = (r.tracks || []).map((x) => connectTitel(sid, s.name, x));
      app.listen.set(`cs${sid}`, tracks);
      inhalt.innerHTML = umbiegen([
        abschnitt(t('Songs'), tracks.length ? einfacheTrackliste(tracks, `cs${sid}`) : ''),
        abschnitt(t('Alben'), (r.alben || []).length ? raster(r.alben.map((a) => kachel(a)).join('')) : ''),
        abschnitt(t('Künstler'), (r.kuenstler || []).length ? raster(r.kuenstler.map((k) => kuenstlerKachel(k)).join('')) : ''),
      ].join('') || leer(t('Nichts gefunden'), t('Zu „{q}“ gibt es dort nichts.', { q: h(q) })), sid);
      titelMarkieren(inhalt, tracks);
    } else if (zeige === 'kuenstler') {
      inhalt.innerHTML = umbiegen(r.kuenstler.length ? raster(r.kuenstler.map((k) => kuenstlerKachel(k, tn(k.alben || 0, '1 Album', '{n} Alben'))).join('')) : leer(t('Keine Künstler')), sid);
    } else if (zeige === 'playlists') {
      const pl = r.playlists || [];
      inhalt.innerHTML = pl.length ? `<div class="raster">${pl.map((p) => `<a class="kachel" href="${pfad(sid, `/playlists/${p.id}`)}" data-link>
          <span class="kachel-bild">${p.cover?.[0] ? `<img src="${h(p.cover[0])}" alt="" loading="lazy">` : `<span class="platzhalter">${icon('playlists', 34)}</span>`}</span>
          <span class="kachel-text"><span class="kachel-titel" style="display:block">${h(p.name)}</span><span class="kachel-unter" style="display:block">${h(tn(p.anzahl || 0, '1 Titel', '{n} Titel'))}</span></span></a>`).join('')}</div>`
        : leer(t('Keine Playlists'), t('Dort gibt es keine Playlists, die geteilt werden.'));
    } else {
      inhalt.innerHTML = umbiegen(r.alben.length ? raster(r.alben.map((a) => kachel(a)).join('')) : leer(t('Noch keine Alben'), t('Auf diesem Server liegt noch keine Musik.')), sid);
      // Weitere Seiten auf Knopfdruck (jede Seite ist eine Anfrage beim anderen Server)
      let seite = 1, geladen = r.alben.length;
      const mehr = () => {
        inhalt.querySelector('[data-cn-mehr]')?.remove();
        if (geladen >= r.gesamt) return;
        inhalt.insertAdjacentHTML('beforeend', `<div style="text-align:center;margin-top:24px" data-cn-mehr><button type="button" class="btn btn-zweit">${t('Mehr laden ({n} von {gesamt})', { n: zahl(geladen), gesamt: zahl(r.gesamt) })}</button></div>`);
        inhalt.querySelector('[data-cn-mehr] button').addEventListener('click', async (e) => {
          e.currentTarget.disabled = true;
          const x = await versuche(() => lesen(sid, 'alben', { sort: 'kuenstler', seite: seite + 1 }, signal));
          if (!x) { e.currentTarget.disabled = false; return; }
          seite++;
          geladen += x.alben.length;
          inhalt.querySelector('.raster').insertAdjacentHTML('beforeend', umbiegen(x.alben.map((a) => kachel(a)).join(''), sid));
          if (!x.alben.length) geladen = r.gesamt;
          mehr();
        });
      };
      mehr();
    }
    document.title = `${s.name} – Amberwave Connect`;
  },

  async album({ app, ziel, param, signal }) {
    aktionenRegistrieren(app);
    const sid = Number(param[0]), id = Number(param[1]);
    await serverListe().catch(() => null);
    const a = await albumLaden(sid, id, signal);
    const s = a._server, ed = a.edition;
    const key = `ca${sid}-${id}`;
    app.listen.set(key, a.tracks.map((x) => connectTitel(sid, s.name, x, a)));
    const verfuegbar = a.tracks.filter((x) => x.verfuegbar).length;
    const holen = istAdmin(app) && s.dir_erlaubt?.holen !== false;
    ziel.innerHTML = pfadZeile(s) + `
      <div class="album-kopf">
        <div class="album-cover">${ed.cover_gross ? `<img src="${h(ed.cover_gross)}" alt="${h(t('Cover von {titel}', { titel: a.titel }))}">` : `<span class="platzhalter">${h(a.titel)}</span>`}</div>
        <div class="album-info">
          <div class="ueberzeile">${h(typZeile(a))} · ${h(t('auf {server}', { server: s.name }))}</div>
          ${a._da ? `<div class="cn-da-hinweis">${icon('haken', 16)}<span>${t('Hast du schon auf deinem Server')}</span></div>` : a.tracks.some((x) => x._da) ? `<div class="cn-da-hinweis teil">${icon('haken', 16)}<span>${t('{n} von {gesamt} Titeln hast du schon', { n: a.tracks.filter((x) => x._da).length, gesamt: a.tracks.length })}</span></div>` : ''}
          <h1>${h(a.titel)}</h1>
          <div class="album-kuenstler">${umbiegen((a.kuenstler || []).map((k) => `<a href="/kuenstler/${k.id}" data-link>${h(k.name)}</a>${k.verbindung ? `<span class="verb">${h(k.verbindung)}</span>` : ''}`).join(''), sid)}</div>
          <div class="fakten">${[a.jahr ? `<span>${a.jahr}</span>` : '', `<span>${tn(a.tracks.length, '1 Titel · {dauer}', '{n} Titel · {dauer}', { dauer: dauerText(ed.laenge_ms) })}</span>`,
            ed.qualitaet ? `<span class="marke${/^(FLAC|ALAC|WAV|AIFF|WV)/.test(ed.qualitaet) ? ' marke-akzent' : ''}">${h(ed.qualitaet)}</span>` : ''].join('')}</div>
          <div class="aktionen">
            <button type="button" class="btn" data-aktion="c-album-play" data-server="${sid}" data-id="${id}" ${verfuegbar ? '' : 'disabled'}>${icon('play', 20)}<span>${t('Abspielen')}</span></button>
            <button type="button" class="btn btn-zweit" data-aktion="c-album-zufall" data-server="${sid}" data-id="${id}" ${verfuegbar ? '' : 'disabled'}>${icon('zufall', 18)}<span>${t('Zufall')}</span></button>
            ${holen ? `<button type="button" class="btn btn-zweit" data-cn-holen data-menue-anker>${icon('holen', 18)}<span>${t('Auf diesen Server laden')}</span></button>` : ''}
          </div>
        </div>
      </div>
      <div class="album-tracks">${umbiegen(albumTrackliste(a.tracks.map((x) => ({ ...x, id: `c${sid}-${x.id}` })), key, a.kuenstler, { gaesteZeigen: false }), sid)}</div>`;
    titelMarkieren(ziel, a.tracks.map((x) => ({ ...x, id: `c${sid}-${x.id}` })));
    ziel.querySelector('[data-cn-holen]')?.addEventListener('click', (e) => holenMenue(app, e.currentTarget, sid,
      { art: 'album', id, titel: a.titel, unter: (a.kuenstler || []).map((k) => k.name + (k.verbindung || '')).join('') }));
    document.title = `${a.titel} – ${s.name}`;
  },

  async kuenstler({ app, ziel, param, signal }) {
    aktionenRegistrieren(app);
    const sid = Number(param[0]), id = Number(param[1]);
    const k = await lesen(sid, 'kuenstler', { id }, signal);
    const s = k._server;
    const name = k.name === '[unbekannt]' ? t('Unbekannter Künstler') : k.name;
    ziel.innerHTML = pfadZeile(s) + kopf(h(name), h(t('auf {server}', { server: s.name }))) + umbiegen([
      abschnitt(t('Alben'), (k.alben || []).length ? raster(k.alben.map((a) => kachel(a, { ohneKuenstler: true })).join('')) : ''),
      abschnitt(t('Mitgewirkt'), (k.gast || []).length ? raster(k.gast.map((a) => kachel(a)).join('')) : ''),
    ].join('') || leer(t('Keine Alben')), sid);
    document.title = `${name} – ${s.name}`;
  },

  async playlist({ app, ziel, param, signal }) {
    aktionenRegistrieren(app);
    const sid = Number(param[0]), id = Number(param[1]);
    await serverListe().catch(() => null);
    const p = await lesen(sid, 'playlist', { id }, signal);
    const s = p._server;
    const tracks = (p.tracks || []).map((x) => connectTitel(sid, s.name, x));
    const key = `cp${sid}-${id}`;
    app.listen.set(key, tracks);
    const holen = istAdmin(app) && s.dir_erlaubt?.holen !== false;
    ziel.innerHTML = pfadZeile(s) + kopf(h(p.name), h([t('Playlist auf {server}', { server: s.name }), tn(tracks.length, '1 Titel', '{n} Titel')].join(' · ')),
      `<div class="aktionen" style="margin:0">
        <button type="button" class="btn" data-aktion="liste-play" data-liste="${key}" ${tracks.length ? '' : 'disabled'}>${icon('play', 20)}<span>${t('Abspielen')}</span></button>
        ${holen ? `<button type="button" class="btn btn-zweit" data-cn-holen data-menue-anker>${icon('holen', 18)}<span>${t('Auf diesen Server laden')}</span></button>` : ''}
      </div>`) + umbiegen(einfacheTrackliste(tracks, key), sid);
    titelMarkieren(ziel, tracks);
    ziel.querySelector('[data-cn-holen]')?.addEventListener('click', (e) => holenMenue(app, e.currentTarget, sid, { art: 'playlist', id, titel: p.name, unter: s.name }));
    document.title = `${p.name} – ${s.name}`;
  },
};

// ---------- Einstellungen › Amberwave Connect ----------

const karte = (titel, inhalt, rechts = '', attr = '') => `<div class="einst-karte" ${attr}><h2><span>${h(titel)}</span>${rechts}</h2>${inhalt}</div>`;
const zeile = (k, name, hinweis, regler = '', attr = '') => `<div class="einst-zeile" data-k="${k}" ${attr}><div class="einst-text"><span class="einst-name">${name}</span>${hinweis ? `<p>${hinweis}</p>` : ''}</div>${regler ? `<div class="einst-regler">${regler}</div>` : ''}</div>`;
/**
 * Oberer Teil des Bereichs (dieser Server, gekoppelte Server, koppeln). Der untere Teil – Qualität und Tempo – sind normale
 * Server-Einstellungen und kommen aus der gemeinsamen Beschreibung in einstellungen.js.
 * Gekoppelt heißt immer: beide Seiten dürfen stöbern, reinhören und Musik holen.
 */
let einstAbbruch = null;   // Timer und Poller des letzten Zeichnens – beim Neuzeichnen gestoppt
export async function connectEinstellungenZeichnen(app, inhalt, signal) {
  einstAbbruch?.abort();
  const ctrl = new AbortController();
  einstAbbruch = ctrl;
  signal?.addEventListener('abort', () => ctrl.abort());
  const r = await serverListe(true);
  if (signal?.aborted || ctrl.signal.aborted) return;
  const ad = r.adressen || {};
  const adressen = [...(ad.lan || []).map((u) => [t('Heimnetz'), u]), ...(ad.direkt ? [[t('Direktzugang'), ad.direkt]] : []), ...(ad.oeffentlich ? [[t('Von außen'), ad.oeffentlich]] : []), ...(ad.tunnel ? [[t('Tunnel'), ad.tunnel]] : [])];
  const serverZeile = (s) => `<div class="cn-peer" data-s="${s.id}">
      <span class="cn-server-sym">${icon('connect', 22)}</span>
      <div class="cn-peer-text">
        <div class="cn-peer-name"><b>${h(s.name)}</b>${wegChip(s)}</div>
        <small>${h([s.kennung, s.version ? `Amberwave ${s.version}` : '', t('gekoppelt {datum}', { datum: datumZeit(s.gekoppelt) }), s.zuletzt ? t('zuletzt {datum}', { datum: datumZeit(s.zuletzt) }) : ''].filter(Boolean).join(' · '))}</small>
      </div>
      <div class="cn-peer-knoepfe">
        <a class="btn btn-zweit btn-klein" href="${pfad(s.id)}" data-link>${t('Öffnen')}</a>
        <button type="button" class="btn-ico" data-peer-menue data-menue-anker aria-label="${h(t('Mehr zu {name}', { name: s.name }))}">${icon('mehr', 18)}</button>
      </div>
    </div>`;
  inhalt.innerHTML = `
    ${karte(t('Dieser Server'), `
      ${zeile('name', t('Name'), r.name_fest ? t('Festgelegt in der .env (CLIENT_SERVERNAME).') : t('So sehen ihn gekoppelte Server und deine Apps.'),
        `<form class="cn-name" data-name><input type="text" class="einst-feld" name="name" value="${h(r.ausweis.name)}" maxlength="60" required ${r.name_fest ? 'disabled' : ''} aria-label="${h(t('Name'))}">
          <button type="submit" class="btn btn-klein" hidden>${t('Speichern')}</button></form>`)}
      ${zeile('kennung', t('Ausweis'), t('Daran erkennen gekoppelte Server und Apps diesen Server wieder – auch mit neuer IP-Adresse oder neuem Namen.'), `<code class="cn-kennung">${h(r.ausweis.kennung)}</code>`)}
      ${zeile('adressen', t('Erreichbar unter'), [
          adressen.length ? '' : t('Noch keine Adresse bekannt – öffne Amberwave einmal über die Adresse im Heimnetz (z. B. http://192.168.178.20:8095).'),
          r.rueckkanal?.length ? h(t('Von außen nicht direkt erreichbar – gekoppelte Server erreichen ihn trotzdem: Er hält über {namen} einen Rückkanal offen.', { namen: r.rueckkanal.join(', ') })) : '',
        ].filter(Boolean).join(' '),
        adressen.length ? `<div class="os-chips">${adressen.map(([a, u]) => `<span class="einst-chip" title="${h(a)}">${h(u.replace(/^https?:\/\//, ''))}</span>`).join('')}</div>` : '')}`)}
    ${karte(t('Gekoppelte Server'), r.server.length
      ? `<p class="einst-karten-hinweis">${t('Gekoppelte Server teilen ihre Musik gegenseitig: stöbern, reinhören und herüberladen – in beide Richtungen.')}</p><div class="cn-peers">${r.server.map(serverZeile).join('')}</div>`
      : `<p class="einst-karten-hinweis">${t('Noch keiner. Unten koppeln – einmal mit einem sechsstelligen Code, danach finden sich die beiden von selbst: im Heimnetz direkt, sonst über Direktzugang oder Tunnel. Alles ist Ende zu Ende verschlüsselt.')}</p>`)}
    ${karte(t('Server koppeln'), `
      <p class="einst-karten-hinweis">${t('Auf einem Server den Code anzeigen, auf dem anderen eingeben. Der Code gilt 10 Minuten; Konten, Favoriten und Gehörtes bleiben auf jedem Server für sich.')}</p>
      <div class="cn-koppel-wege">
        <section class="cn-weg"><h3>${t('Code anzeigen')}</h3><p>${t('Für den anderen Server: dort „Mit Code koppeln“ und diesen Code eingeben.')}</p><div data-code-box></div></section>
        <section class="cn-weg"><h3>${t('Mit Code koppeln')}</h3><p>${t('Adresse des anderen Servers und den Code, den er gerade anzeigt.')}</p>
          <form class="cn-koppeln" data-koppeln>
            <input type="text" class="einst-feld" name="adresse" placeholder="${h(t('192.168.178.20:8095 oder musik.example.de'))}" autocomplete="off" spellcheck="false" autocapitalize="none" required aria-label="${h(t('Adresse'))}">
            <div class="cn-koppeln-zeile"><input type="text" class="einst-feld cn-code-feld" name="code" placeholder="000000" inputmode="numeric" maxlength="7" pattern="[0-9 ]{6,7}" required aria-label="${h(t('Code'))}">
            <button type="submit" class="btn btn-klein">${t('Koppeln')}</button></div>
          </form>
          <button type="button" class="cn-link" data-suchen>${icon('suche', 15)}<span>${t('Im Heimnetz suchen')}</span></button>
          <div data-funde></div>
        </section>
      </div>`)}`;

  wegeLiveHalten(inhalt, ctrl.signal);
  const neu = () => { connectCacheLeeren(); app.zaehlerAktualisieren?.(); connectEinstellungenZeichnen(app, inhalt, signal); };

  // Eigener Name: Speichern erscheint, sobald etwas geändert ist
  const nf = inhalt.querySelector('[data-name]');
  nf.name.addEventListener('input', () => { nf.querySelector('button').hidden = nf.name.value.trim() === r.ausweis.name; });
  nf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const knopf = nf.querySelector('button');
    knopf.disabled = true;
    const x = await versuche(() => api.put('/connect/name', { name: nf.name.value }), t('Name gespeichert'));
    knopf.disabled = false;
    if (x) { app.name = x.name; neu(); }
  });

  // Je Server: Prüfen, Trennen
  inhalt.querySelectorAll('.cn-peer').forEach((z) => {
    const sid = Number(z.dataset.s);
    const s = r.server.find((x) => x.id === sid);
    z.querySelector('[data-peer-menue]').addEventListener('click', (e) => menue(e.currentTarget, [
      { titel: s.name },
      { text: t('Verbindung prüfen'), icon: 'verlauf', aktion: async () => {
        toast(t('Prüfe …'));
        const x = await versuche(() => api.post(`/connect/server/${sid}/pruefen`));
        if (x) toast(x.erreichbar ? t('{name} erreichbar über {weg} ({ms} ms)', { name: s.name, weg: WEG()[x.weg?.art] || x.weg?.art, ms: zahl(x.weg?.ms ?? 0) }) : t('{name} antwortet gerade nicht.', { name: s.name }), x.erreichbar ? 'info' : 'fehler');
        neu();
      } },
      { trenner: true },
      { text: t('Trennen …'), icon: 'muell', rot: true, aktion: async () => {
        if (!(await bestaetigen(t('„{name}“ trennen?', { name: s.name }), t('Danach kann keiner mehr beim anderen stöbern oder holen. Schon kopierte Musik bleibt. Zum Wiederverbinden neu koppeln.'), t('Trennen'), true))) return;
        if (await versuche(() => api.del(`/connect/server/${sid}`), t('Getrennt'))) neu();
      } },
    ]));
  });

  // Code anzeigen (läuft er schon, gleich wieder anzeigen)
  const codeBox = inhalt.querySelector('[data-code-box]');
  let uhr = null;
  ctrl.signal.addEventListener('abort', () => clearInterval(uhr));
  const codeZeigen = (c) => {
    clearInterval(uhr);
    if (!c) {
      codeBox.innerHTML = `<button type="button" class="btn btn-klein" data-code-neu>${t('Code anzeigen')}</button>`;
      codeBox.querySelector('[data-code-neu]').addEventListener('click', async () => { const x = await versuche(() => api.post('/connect/code')); if (x) codeZeigen(x); });
      return;
    }
    const bis = Date.now() + c.rest * 1000;
    const vorher = r.server.length;
    codeBox.innerHTML = `<div class="cn-code"><span class="cn-code-ziffern" aria-label="${h(t('Code'))}">${h(c.code.slice(0, 3))} ${h(c.code.slice(3))}</span>
      <small data-rest></small><button type="button" class="btn btn-zweit btn-klein" data-code-aus>${t('Beenden')}</button></div>`;
    codeBox.querySelector('[data-code-aus]').addEventListener('click', async () => { await versuche(() => api.del('/connect/code')); codeZeigen(null); });
    let n = 0;
    const takt = async () => {
      const rest = Math.max(0, Math.round((bis - Date.now()) / 1000));
      const el = codeBox.querySelector('[data-rest]');
      if (!el) { clearInterval(uhr); return; }
      el.textContent = t('noch {m}:{s}', { m: Math.floor(rest / 60), s: String(rest % 60).padStart(2, '0') });
      if (!rest) { codeZeigen(null); return; }
      // Alle 3 s schauen, ob der andere Server gekoppelt hat
      if (++n % 3 === 0 && !ctrl.signal.aborted) {
        const x = await serverListe(true).catch(() => null);
        if (ctrl.signal.aborted) return;
        if (x && x.server.length > vorher) { clearInterval(uhr); toast(t('Gekoppelt mit {name}', { name: x.server[x.server.length - 1].name })); neu(); }
      }
    };
    takt();
    uhr = setInterval(takt, 1000);
  };
  codeZeigen(r.einladung);

  // Mit Code koppeln
  const form = inhalt.querySelector('[data-koppeln]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const knopf = form.querySelector('button');
    knopf.disabled = true;
    knopf.textContent = t('Verbinde …');
    const x = await versuche(() => api.post('/connect/koppeln/mit', { adresse: f.get('adresse'), code: f.get('code') }));
    knopf.disabled = false;
    knopf.textContent = t('Koppeln');
    if (x) { toast(t('Gekoppelt mit {name}', { name: x.name || x.server?.name || '' })); neu(); }
  });

  // Im Heimnetz suchen
  inhalt.querySelector('[data-suchen]').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    const tx = b.querySelector('span');
    b.disabled = true;
    tx.textContent = t('Suche … (bis zu 30 s)');
    const x = await versuche(() => api.get('/connect/heimnetz'));
    b.disabled = false;
    tx.textContent = t('Nochmal suchen');
    const box = inhalt.querySelector('[data-funde]');
    if (!x) return;
    const l = x.server || [];
    box.innerHTML = l.length ? `<div class="cn-funde">${l.map((f) => `<button type="button" class="cn-fund" ${f.gekoppelt ? 'disabled' : ''} data-uebernehmen="${h(f.adresse)}">
        <b>${h(f.name || f.adresse)}</b><small>${h(f.adresse.replace(/^https?:\/\//, ''))} · ${h(f.kennung)}</small>
        ${f.gekoppelt ? `<span class="einst-chip gut">${t('schon gekoppelt')}</span>` : `<span class="cn-fund-los">${t('Übernehmen')}</span>`}</button>`).join('')}</div>`
      : `<p class="cn-hinweis">${x.netze?.length ? t('Im Netz {netz} hat kein anderer Amberwave geantwortet.', { netz: h(x.netze.map((n) => `${n}.x`).join(', ')) }) : t('Dieser Server kennt sein Heimnetz noch nicht. Öffne Amberwave einmal über seine Adresse im Heimnetz und versuch es dann nochmal.')}</p>`;
    box.querySelectorAll('[data-uebernehmen]:not([disabled])').forEach((u) => u.addEventListener('click', () => {
      form.adresse.value = u.dataset.uebernehmen.replace(/^https?:\/\//, '');
      form.code.focus();
    }));
  });
}
