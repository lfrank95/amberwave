// Amberwave Connect: gekoppelte Amberwave-Server. Eigener Reiter mit allen Servern, darin stöbern wie in der eigenen
// Bibliothek, reinhören (unser Server holt den Titel verschlüsselt ab und reicht ihn durch) und Alben, Titel oder
// Playlists „auf diesen Server laden“. Dazu die Einstellungen (Ausweis, Koppeln, Rechte, Qualität, Tempo).
import { api, versuche } from './api.js';
import { t, tn, zahl } from './i18n.js';
import { h, icon, dauer, dauerText, datumZeit, toast, dialog, bestaetigen, menue, groesse } from './ui.js';
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
const WEG = () => ({ heimnetz: t('Heimnetz'), direkt: t('Direktzugang'), tunnel: t('Tunnel') });

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

function wegChip(s) {
  if (!s.erreichbar) return `<span class="einst-chip warn">${h(t('nicht erreichbar'))}</span>`;
  const art = WEG()[s.weg?.art] || s.weg?.art || '';
  return `<span class="einst-chip gut">${h(art)}${s.weg?.ms != null ? ` · ${zahl(s.weg.ms)} ms` : ''}</span>`;
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
function holenMenue(app, anker, sid, ziel) {
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

function kopf(titel, unter = '', rechts = '') {
  return `<div class="seiten-kopf"><div><h1>${titel}</h1>${unter ? `<div class="unter">${unter}</div>` : ''}</div>${rechts}</div>`;
}

/** Brotkrumen: Amberwave Connect › Server */
function pfadZeile(s, extra = '') {
  return `<div class="cn-pfad"><a href="/connect" data-link>${icon('connect', 15)}<span>Amberwave Connect</span></a>${s ? `<span>›</span><a href="${pfad(s.id)}" data-link>${h(s.name)}</a>` : ''}${extra}</div>`;
}

function auftragZeile(a) {
  const pz = a.gesamt ? Math.min(100, Math.round(a.bytes * 100 / a.gesamt)) : 0;
  const status = { wartet: t('wartet'), laeuft: a.fehler ? t('wartet auf Verbindung') : t('läuft'), fertig: t('fertig'), fehler: t('Fehler'), abgebrochen: t('abgebrochen') }[a.status] || a.status;
  const knoepfe = [
    ['wartet', 'laeuft'].includes(a.status) ? `<button type="button" class="btn btn-zweit btn-klein" data-auftrag="${a.id}" data-was="abbrechen">${t('Abbrechen')}</button>` : '',
    ['fehler', 'abgebrochen'].includes(a.status) ? `<button type="button" class="btn btn-zweit btn-klein" data-auftrag="${a.id}" data-was="wiederholen">${t('Nochmal')}</button>` : '',
    a.status !== 'laeuft' ? `<button type="button" class="btn-ico" data-auftrag="${a.id}" data-was="entfernen" aria-label="${t('Aus der Liste entfernen')}" title="${t('Aus der Liste entfernen')}">${icon('zu', 16)}</button>` : '',
  ].join('');
  const art = { album: t('Album'), titel: t('Titel'), playlist: t('Playlist') }[a.art] || a.art;
  return `<div class="cn-auftrag" data-status="${h(a.status)}">
    <div class="cn-auftrag-text"><b>${h(a.titel || art)}</b>
      <small>${h([art, t('von {server}', { server: a.server }), qualiName(a.qualitaet), a.dateien ? t('{f} von {n} Dateien', { f: a.fertig, n: a.dateien }) : '', a.gesamt ? `${groesse(a.bytes)} / ${groesse(a.gesamt)}` : ''].filter(Boolean).join(' · '))}</small>
      ${a.status !== 'fertig' ? `<div class="flac-balken cn-balken"><i style="width:${Math.max(a.status === 'laeuft' ? 2 : 0, pz)}%"></i></div>` : ''}
      ${a.fehler ? `<small class="cn-fehler">${h(a.fehler)}</small>` : ''}</div>
    <span class="einst-chip ${a.status === 'fertig' ? 'gut' : a.status === 'fehler' ? 'warn' : ''}">${h(status)}${a.status === 'laeuft' && pz ? ` · ${pz} %` : ''}</span>
    <div class="cn-auftrag-knoepfe">${knoepfe}</div>
  </div>`;
}

/** Übertragungen: Liste mit Fortschritt, frischt sich auf, solange etwas läuft */
async function auftraegeZeichnen(app, box, signal) {
  let timer = null;
  const zeichnen = async () => {
    clearTimeout(timer);
    let r;
    try { r = await api.get('/connect/auftraege', { signal }); } catch (e) { return; }
    if (!box.isConnected) return;
    const l = r.auftraege || [];
    box.innerHTML = l.length ? `<div class="cn-auftraege">${l.map(auftragZeile).join('')}</div>`
      : `<p class="hinweis">${t('Noch nichts übertragen. Im Menü eines Albums, Titels oder einer Playlist auf einem gekoppelten Server: „Auf diesen Server laden“.')}</p>`;
    const offen = l.filter((a) => ['wartet', 'laeuft'].includes(a.status)).length;
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

export const connectAnsichten = {
  /** Alle gekoppelten Server und die Übertragungen */
  async uebersicht({ app, ziel, signal }) {
    aktionenRegistrieren(app);
    const r = await serverListe(true);
    const admin = istAdmin(app);
    const karte = (s) => `<a class="cn-server" href="${pfad(s.id)}" data-link>
        <span class="cn-server-sym">${icon('connect', 26)}</span>
        <span class="cn-server-text"><b>${h(s.name)}</b><small>${h(s.kennung)}${s.version ? ` · ${h(s.version)}` : ''}</small></span>
        ${wegChip(s)}
      </a>`;
    ziel.innerHTML = kopf('Amberwave Connect', t('Dein Server {name} · Ausweis {kennung}', { name: h(r.ausweis.name), kennung: `<code>${h(r.ausweis.kennung)}</code>` }),
      admin ? `<a class="btn btn-zweit" href="/einstellungen/connect" data-link>${icon('einstellungen', 18)}<span>${t('Server koppeln')}</span></a>` : '') + `
      ${r.server.length ? `<div class="cn-server-liste">${r.server.map(karte).join('')}</div>`
        : leer(t('Noch kein Server gekoppelt'), admin ? t('Koppel einen zweiten Amberwave – etwa im Wohnwagen oder bei der Familie. Dann stöberst du hier in seiner Musik, hörst rein und holst dir Alben herüber.') : t('Ein Admin kann unter Einstellungen › Amberwave Connect einen weiteren Amberwave-Server koppeln.'),
          admin ? `<a class="btn" href="/einstellungen/connect" data-link>${t('Server koppeln')}</a>` : '')}
      ${admin ? abschnitt(t('Übertragungen'), '<div data-auftraege><div class="lade"></div></div>') : ''}`;
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
        abschnitt(t('Alben'), (r.alben || []).length ? raster(r.alben.map((a) => albumKachel(a)).join('')) : ''),
        abschnitt(t('Künstler'), (r.kuenstler || []).length ? raster(r.kuenstler.map((k) => kuenstlerKachel(k)).join('')) : ''),
      ].join('') || leer(t('Nichts gefunden'), t('Zu „{q}“ gibt es dort nichts.', { q: h(q) })), sid);
    } else if (zeige === 'kuenstler') {
      inhalt.innerHTML = umbiegen(r.kuenstler.length ? raster(r.kuenstler.map((k) => kuenstlerKachel(k, tn(k.alben || 0, '1 Album', '{n} Alben'))).join('')) : leer(t('Keine Künstler')), sid);
    } else if (zeige === 'playlists') {
      const pl = r.playlists || [];
      inhalt.innerHTML = pl.length ? `<div class="raster">${pl.map((p) => `<a class="kachel" href="${pfad(sid, `/playlists/${p.id}`)}" data-link>
          <span class="kachel-bild">${p.cover?.[0] ? `<img src="${h(p.cover[0])}" alt="" loading="lazy">` : `<span class="platzhalter">${icon('playlists', 34)}</span>`}</span>
          <span class="kachel-text"><span class="kachel-titel" style="display:block">${h(p.name)}</span><span class="kachel-unter" style="display:block">${h(tn(p.anzahl || 0, '1 Titel', '{n} Titel'))}</span></span></a>`).join('')}</div>`
        : leer(t('Keine Playlists'), t('Dort gibt es keine Playlists, die geteilt werden.'));
    } else {
      inhalt.innerHTML = umbiegen(r.alben.length ? raster(r.alben.map((a) => albumKachel(a)).join('')) : leer(t('Noch keine Alben'), t('Auf diesem Server liegt noch keine Musik.')), sid);
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
          inhalt.querySelector('.raster').insertAdjacentHTML('beforeend', umbiegen(x.alben.map((a) => albumKachel(a)).join(''), sid));
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
      abschnitt(t('Alben'), (k.alben || []).length ? raster(k.alben.map((a) => albumKachel(a, { ohneKuenstler: true })).join('')) : ''),
      abschnitt(t('Mitgewirkt'), (k.gast || []).length ? raster(k.gast.map((a) => albumKachel(a)).join('')) : ''),
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
    ziel.querySelector('[data-cn-holen]')?.addEventListener('click', (e) => holenMenue(app, e.currentTarget, sid, { art: 'playlist', id, titel: p.name, unter: s.name }));
    document.title = `${p.name} – ${s.name}`;
  },
};

// ---------- Einstellungen › Amberwave Connect ----------

const karte = (titel, inhalt, rechts = '', attr = '') => `<div class="einst-karte" ${attr}><h2><span>${h(titel)}</span>${rechts}</h2>${inhalt}</div>`;
const zeile = (k, name, hinweis, regler = '', attr = '') => `<div class="einst-zeile" data-k="${k}" ${attr}><div class="einst-text"><span class="einst-name">${name}</span>${hinweis ? `<p>${hinweis}</p>` : ''}</div>${regler ? `<div class="einst-regler">${regler}</div>` : ''}</div>`;
const schalter = (an, attr) => `<button type="button" class="schalter" role="switch" aria-checked="${an ? 'true' : 'false'}" ${attr}></button>`;

const RECHTE = () => [
  ['stoebern', t('Stöbern und reinhören'), t('Darf deine Alben, Künstler und Playlists sehen und Titel abspielen.')],
  ['holen', t('Kopieren'), t('Darf Alben, Titel und Playlists zu sich herüberladen.')],
  ['original', t('Verlustfrei'), t('Darf Originale und FLAC bekommen. Aus: nur Opus – spart deinen Upload.')],
  ['senden', t('Dir etwas schicken'), t('Darf dir Alben zuschicken, die dein Server dann bei ihm abholt.')],
];

/**
 * Oberer Teil des Bereichs (Ausweis, gekoppelte Server, Koppeln). Der untere Teil – Qualität und Tempo – sind normale
 * Server-Einstellungen und kommen aus der gemeinsamen Beschreibung in einstellungen.js.
 */
export async function connectEinstellungenZeichnen(app, inhalt, signal) {
  const r = await serverListe(true);
  if (signal?.aborted) return;
  const ad = r.adressen || {};
  const adressen = [...(ad.lan || []).map((u) => [t('Heimnetz'), u]), ...(ad.direkt ? [[t('Direktzugang'), ad.direkt]] : []), ...(ad.oeffentlich ? [[t('Von außen'), ad.oeffentlich]] : [])];
  const serverKarte = (s) => {
    const dir = s.dir_erlaubt || {};
    return `<div class="einst-zeile cn-gekoppelt" data-s="${s.id}">
      <div class="einst-text"><span class="einst-name">${h(s.name)} ${wegChip(s)}</span>
        <p>${h(s.kennung)}${s.version ? ` · Amberwave ${h(s.version)}` : ''} · ${h(t('gekoppelt {datum}', { datum: datumZeit(s.gekoppelt) }))}${s.zuletzt ? ` · ${h(t('zuletzt {datum}', { datum: datumZeit(s.zuletzt) }))}` : ''}</p>
        <p class="cn-dir">${h(t('Er erlaubt dir:'))} ${RECHTE().map(([k, n]) => `<span class="einst-chip ${dir[k] ? 'gut' : ''}">${h(n)}${dir[k] ? '' : ` – ${h(t('nein'))}`}</span>`).join(' ')}</p>
        <div class="cn-rechte"><b>${h(t('Du erlaubst {name}:', { name: s.name }))}</b>${RECHTE().map(([k, n, u]) => `<label class="cn-recht" title="${h(u)}">${schalter(s.rechte[k], `data-recht="${k}" aria-label="${h(n)}"`)}<span>${h(n)}</span></label>`).join('')}</div>
      </div>
      <div class="einst-regler cn-knoepfe"><button type="button" class="btn btn-zweit btn-klein" data-pruefen>${t('Verbindung prüfen')}</button>
        <button type="button" class="btn btn-zweit btn-klein rot" data-trennen>${t('Trennen')}</button></div>
    </div>`;
  };
  inhalt.innerHTML = `
    ${karte(t('Ausweis dieses Servers'), `
      <p class="einst-karten-hinweis">${t('Daran erkennen gekoppelte Server und deine Apps diesen Amberwave wieder – auch wenn er eine neue IP-Adresse oder einen anderen Namen bekommt. Der Schlüssel dahinter verlässt den Server nie (er steckt in jeder Sicherung).')}</p>
      ${zeile('kennung', h(r.ausweis.name), t('Kennung'), `<code class="cn-kennung">${h(r.ausweis.kennung)}</code>`)}
      ${zeile('adressen', t('Erreichbar unter'), adressen.length ? '' : t('Noch keine Adresse bekannt – öffne Amberwave einmal über die Adresse im Heimnetz (z. B. http://192.168.178.20:8095).'),
        adressen.length ? `<div class="os-chips">${adressen.map(([a, u]) => `<span class="einst-chip" title="${h(a)}">${h(u.replace(/^https?:\/\//, ''))}</span>`).join('')}</div>` : '')}`)}
    ${karte(t('Gekoppelte Server'), r.server.length ? r.server.map(serverKarte).join('') : `<p class="einst-karten-hinweis">${t('Noch keiner. Unten koppeln – einmal mit einem sechsstelligen Code, danach finden sich die beiden von selbst: im Heimnetz direkt, sonst über Direktzugang oder Tunnel. Alles ist Ende zu Ende verschlüsselt.')}</p>`)}
    ${karte(t('Server koppeln'), `
      <p class="einst-karten-hinweis">${t('Auf einem Server den Code anzeigen, auf dem anderen eingeben. Der Code gilt 10 Minuten; Konten, Favoriten und Gehörtes bleiben auf jedem Server für sich.')}</p>
      ${zeile('code', t('Code anzeigen'), t('Für den anderen Server: dort „Mit Code koppeln“ und diesen Code eingeben.'), '<div data-code-box></div>')}
      ${zeile('koppeln', t('Mit Code koppeln'), t('Adresse des anderen Servers und den Code, den er gerade anzeigt.'),
        `<form class="cn-koppeln" data-koppeln>
          <input type="text" class="einst-feld" name="adresse" placeholder="${h(t('192.168.178.20:8095 oder musik.example.de'))}" autocomplete="off" spellcheck="false" autocapitalize="none" required aria-label="${h(t('Adresse'))}">
          <input type="text" class="einst-feld cn-code-feld" name="code" placeholder="000000" inputmode="numeric" maxlength="7" pattern="[0-9 ]{6,7}" required aria-label="${h(t('Code'))}">
          <button type="submit" class="btn btn-klein">${t('Koppeln')}</button>
        </form>`)}
      ${zeile('suchen', t('Im Heimnetz suchen'), t('Findet andere Amberwave-Server im selben Netz – dann musst du die Adresse nicht abtippen.'),
        `<button type="button" class="btn btn-zweit btn-klein" data-suchen>${t('Suchen')}</button>`)}
      <div data-funde></div>`)}
    <div data-cn-server-einst></div>`;

  const neu = () => { connectCacheLeeren(); app.zaehlerAktualisieren?.(); connectEinstellungenZeichnen(app, inhalt, signal); };

  // Rechte, Prüfen, Trennen
  inhalt.querySelectorAll('.cn-gekoppelt').forEach((z) => {
    const sid = Number(z.dataset.s);
    const s = r.server.find((x) => x.id === sid);
    z.querySelectorAll('[data-recht]').forEach((b) => b.addEventListener('click', async () => {
      const an = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', String(an));
      if (!(await versuche(() => api.put(`/connect/server/${sid}`, { rechte: { [b.dataset.recht]: an } }), t('Gespeichert')))) b.setAttribute('aria-checked', String(!an));
    }));
    z.querySelector('[data-pruefen]').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      e.currentTarget.textContent = t('Prüfe …');
      const x = await versuche(() => api.post(`/connect/server/${sid}/pruefen`));
      if (x) toast(x.erreichbar ? t('{name} erreichbar über {weg} ({ms} ms)', { name: s.name, weg: WEG()[x.weg?.art] || x.weg?.art, ms: zahl(x.weg?.ms ?? 0) }) : t('{name} antwortet gerade nicht.', { name: s.name }), x.erreichbar ? 'info' : 'fehler');
      neu();
    });
    z.querySelector('[data-trennen]').addEventListener('click', async () => {
      if (!(await bestaetigen(t('„{name}“ trennen?', { name: s.name }), t('Danach kann keiner mehr beim anderen stöbern oder holen. Schon kopierte Musik bleibt. Zum Wiederverbinden neu koppeln.'), t('Trennen'), true))) return;
      if (await versuche(() => api.del(`/connect/server/${sid}`), t('Getrennt'))) neu();
    });
  });

  // Code anzeigen (läuft er schon, gleich wieder anzeigen)
  const codeBox = inhalt.querySelector('[data-code-box]');
  let uhr = null;
  signal?.addEventListener('abort', () => clearInterval(uhr));
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
      if (++n % 3 === 0) {
        const x = await serverListe(true).catch(() => null);
        if (x && x.server.length > vorher) { toast(t('Gekoppelt mit {name}', { name: x.server[x.server.length - 1].name })); neu(); }
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
    b.disabled = true;
    b.textContent = t('Suche … (bis zu 30 s)');
    const x = await versuche(() => api.get('/connect/heimnetz'));
    b.disabled = false;
    b.textContent = t('Nochmal suchen');
    const box = inhalt.querySelector('[data-funde]');
    if (!x) return;
    const l = x.server || [];
    box.innerHTML = l.length ? l.map((f) => zeile('fund', `${h(f.name || f.adresse)} <span class="einst-chip">${h(f.kennung)}</span>`, h(f.adresse.replace(/^https?:\/\//, '')),
      f.gekoppelt ? `<span class="einst-chip gut">${t('schon gekoppelt')}</span>` : `<button type="button" class="btn btn-zweit btn-klein" data-uebernehmen="${h(f.adresse)}">${t('Übernehmen')}</button>`)).join('')
      : `<p class="einst-karten-hinweis">${x.netze?.length ? t('Im Netz {netz} hat kein anderer Amberwave geantwortet.', { netz: x.netze.map((n) => `${n}.x`).join(', ') }) : t('Dieser Server kennt sein Heimnetz noch nicht. Öffne Amberwave einmal über seine Adresse im Heimnetz und versuch es dann nochmal.')}</p>`;
    box.querySelectorAll('[data-uebernehmen]').forEach((u) => u.addEventListener('click', () => {
      form.adresse.value = u.dataset.uebernehmen.replace(/^https?:\/\//, '');
      form.code.focus();
    }));
  });
}
