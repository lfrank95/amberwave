// Ansichten der App (Start, Alben, Album, Künstler, Suche, Playlists, Favoriten, Verlauf, Profil).
// Jede Ansicht bekommt {app, ziel, param, query, signal} und füllt "ziel".
import { api, versuche } from './api.js';
import { t, tn, locale } from './i18n.js';
import { h, icon, dauer, dauerText, datum, datumZeit, kuenstlerLinks, kuenstlerText, coverHtml, initialen, toast, dialog, bestaetigen, menue, zahl } from './ui.js';
import { exportDialog } from './export.js';
import { netzweg } from './netzweg.js';
import { gemerkt, gemerktAus, merken } from './merker.js';
import { offlineKnopf, offlineTitelEintraege, offlineAlbumEintraege, offlineSeite, offlineAn } from './offline_ui.js';
import {
  albumKachel, kuenstlerKachel, raster, reihe, abschnitt, leer, typZeile, land, KUENSTLER_TYP, formatText,
  albumTrackliste, einfacheTrackliste, creditsPanel,
  eBadge,
} from './bausteine.js';
import { flacKandidaten } from './bausteine.js';

// Bearbeiten-Dialoge (nur Admins) liegen in verwaltung.js – das wird erst geladen, wenn einer aufgerufen wird (240 KB weniger beim Start)
const vwLazy = (name) => (...a) => import('./verwaltung.js').then((m) => m[name](...a));
const albumBearbeiten = vwLazy('albumBearbeiten'), kuenstlerBearbeiten = vwLazy('kuenstlerBearbeiten'), trackBearbeiten = vwLazy('trackBearbeiten');
const titellisteBearbeiten = vwLazy('titellisteBearbeiten'), mitwirkendeBearbeiten = vwLazy('mitwirkendeBearbeiten'), editionBearbeiten = vwLazy('editionBearbeiten');
const editionLoeschen = vwLazy('editionLoeschen'), editionMenue = vwLazy('editionMenue'), coverHochladen = vwLazy('coverHochladen');
const albumAufraeumen = vwLazy('albumAufraeumen'), flacUmwandeln = vwLazy('flacUmwandeln');

const albumCache = new Map();
/** Zwischenspeicher leeren (Bibliothek hat sich geändert) */
export function albumCacheLeeren() { albumCache.clear(); }
let entdeckenIds = [];   // „Entdecken“ der Startseite: beim stillen Auffrischen dieselben Alben behalten

/** Album laden (kurz zwischengespeichert, damit Abspielen aus Kacheln schnell geht) */
async function albumHolen(id, edition = null, signal = undefined) {
  const schluessel = `${id}:${edition || ''}`;
  const c = albumCache.get(schluessel);
  if (c && Date.now() - c.zeit < 60000) return c.daten;
  const daten = await api.get(`/alben/${id}${edition ? `?edition=${edition}` : ''}`, { signal });
  albumCache.set(schluessel, { daten, zeit: Date.now() });
  return daten;
}

/** Tracks eines Albums für den Player (mit Album-Angaben für Cover und Sperrbildschirm) */
function albumTracksFuerPlayer(a) {
  const info = { id: a.id, titel: a.titel, edition_id: a.edition.id, cover: a.edition.cover };
  return a.tracks.map((t) => ({ ...t, album: info }));
}

/**
 * Künstlerseite: Genre-Badges und „Beliebteste Titel“ (weltweit nach ListenBrainz oder bei uns gehört).
 * Weltweit zeigt auch fehlende Titel – gedimmt, mit dem Album, auf dem sie erschienen sind –, damit man sieht, was fehlt.
 */
async function beliebtLaden(app, ziel, kid, signal) {
  let r;
  try { r = await api.get(`/kuenstler/${kid}/beliebt`, { signal }); } catch (e) { return; }
  if (!ziel.isConnected) return;
  const gBox = ziel.querySelector('[data-genres]');
  if (gBox && r.genres.length) {
    gBox.innerHTML = r.genres.map((g) => `<a class="pille genre-badge" href="/alben?genre=${g.id}" data-link title="${r.genres_quelle === 'musicbrainz' ? tn(g.stimmen, '{n} Stimme bei MusicBrainz', '{n} Stimmen bei MusicBrainz') : tn(g.stimmen, '{n} Album in der Sammlung', '{n} Alben in der Sammlung')}">${h(g.name)}</a>`).join('');
  }
  const box = ziel.querySelector('[data-beliebt]');
  if (!box) return;
  const tr = (id) => (id != null ? r.tracks[String(id)] : null);
  const welt = r.welt;
  const beiUns = r.bei_uns.filter((b) => tr(b.track_id));
  if (!welt.length && !beiUns.length) return;
  let ansicht = welt.length ? 'welt' : 'uns'; // weltweit zuerst – gerade die fehlenden Titel sind interessant
  const maxHoerer = Math.max(1, ...welt.map((w) => w.hoerer));
  const maxUns = Math.max(1, ...beiUns.map((b) => b.wiedergaben));
  const zeichnen = () => {
    const zeilen = ansicht === 'welt' ? welt : beiUns.map((b, i) => ({ rang: i + 1, track_id: b.track_id, wiedergaben: b.wiedergaben }));
    const spielbar = zeilen.map((z) => tr(z.track_id)).filter(Boolean);
    const key = liste(app, `beliebt-${kid}-${ansicht}`, spielbar);
    let n = 0;
    const zeile = (z) => {
      const tk = tr(z.track_id);
      const anteil = ansicht === 'welt' ? z.hoerer / maxHoerer : z.wiedergaben / maxUns;
      const zahlText = ansicht === 'welt' ? tn(z.hoerer, '1 Hörer', '{n} Hörer') : t('{n}× gehört', { n: z.wiedergaben });
      if (tk) {
        const i = n++;
        return `<div class="beliebt-zeile" data-track-id="${tk.id}">
          <span class="beliebt-rang">${z.rang}</span>
          <div class="track-nr beliebt-cover"><span>${tk.album?.cover ? `<img src="${h(tk.album.cover)}" alt="" loading="lazy">` : ''}</span>
            <button type="button" data-aktion="track-play" data-liste="${key}" data-i="${i}" aria-label="${h(t('{titel} abspielen', { titel: tk.titel }))}"><b>${icon('play', 14)}</b></button></div>
          <div class="beliebt-haupt"><div class="track-titel" data-aktion="track-play" data-liste="${key}" data-i="${i}">${h(tk.titel)}</div>
            <div class="track-unter"><a href="/alben/${tk.album.id}" data-link>${h(tk.album.titel)}</a></div></div>
          <div class="beliebt-wert" title="${h(zahlText)}"><small>${h(zahlText)}</small><span class="beliebt-spur"><i style="width:${Math.max(3, Math.round(anteil * 100))}%"></i></span></div>
          <button type="button" class="btn-ico" data-aktion="track-menue" data-liste="${key}" data-i="${i}" data-menue-anker aria-label="${t('Mehr')}">${icon('mehr', 18)}</button>
        </div>`;
      }
      return `<div class="beliebt-zeile fehlt">
        <span class="beliebt-rang">${z.rang}</span>
        <div class="beliebt-cover ohne" aria-hidden="true">${icon('plus', 16)}</div>
        <div class="beliebt-haupt"><div class="track-titel">${h(z.titel)}</div>
          <div class="track-unter"><span class="nur-pc-text">${t('fehlt dir · erschienen auf')} </span><span class="nur-handy-text">${t('fehlt')} · </span><b>${h(z.album || t('unbekannt'))}</b>${z.release_mbid ? ` <a href="https://musicbrainz.org/release/${h(z.release_mbid)}" target="_blank" rel="noopener" title="${t('Album bei MusicBrainz ansehen')}" aria-label="${t('Album bei MusicBrainz ansehen')}">↗</a>` : ''}</div></div>
        <div class="beliebt-wert" title="${h(zahlText)}"><small>${h(zahlText)}</small><span class="beliebt-spur"><i style="width:${Math.max(3, Math.round(anteil * 100))}%"></i></span></div>
        <span></span>
      </div>`;
    };
    const fehlend = ansicht === 'welt' ? welt.filter((w) => !tr(w.track_id)) : [];
    const alben = {};
    fehlend.forEach((w) => { alben[w.album || t('unbekannt')] = (alben[w.album || t('unbekannt')] || 0) + 1; });
    const albenText = Object.entries(alben).sort((a, b) => b[1] - a[1]).map(([a, c]) => `${h(a)}${c > 1 ? ` (${c})` : ''}`).join(', ');
    box.innerHTML = `<div class="beliebt-kopf">
        <h2>${t('Beliebteste Titel')}</h2>
        ${welt.length && beiUns.length ? `<div class="nerd-schalter" role="group" aria-label="${t('Quelle')}"><button type="button" data-b-ansicht="welt" class="${ansicht === 'welt' ? 'an' : ''}">${t('Weltweit')}</button><button type="button" data-b-ansicht="uns" class="${ansicht === 'uns' ? 'an' : ''}">${t('Bei uns')}</button></div>` : ''}
        <span class="abstand"></span>
        ${spielbar.length ? `<button type="button" class="btn btn-zweit btn-klein" data-aktion="liste-play" data-liste="${key}">${icon('play', 16)}<span>${spielbar.length < zeilen.length ? t('Vorhandene abspielen ({n})', { n: spielbar.length }) : t('Alle abspielen')}</span></button>` : ''}
      </div>
      <div class="beliebt-liste">${zeilen.map(zeile).join('')}</div>
      <p class="hinweis beliebt-fuss">${fehlend.length ? `${t('<b>{n} der Top {m} fehlen dir</b> – zu finden auf: {alben}.', { n: fehlend.length, m: zeilen.length, alben: albenText })} ` : ''}${ansicht === 'welt' ? t('Beliebtheit nach Hörern bei <a href="https://listenbrainz.org" target="_blank" rel="noopener">ListenBrainz</a>.') : t('Gezählte Wiedergaben aller Familienmitglieder.')}</p>`;
    box.querySelectorAll('[data-b-ansicht]').forEach((b) => b.addEventListener('click', () => { ansicht = b.dataset.bAnsicht; zeichnen(); }));
  };
  box.hidden = false;
  zeichnen();
}

function liste(app, schluessel, tracks) {
  app.listen.set(schluessel, tracks);
  return schluessel;
}

function seitenKopf(titel, unter = '', rechts = '') {
  return `<div class="seiten-kopf"><div><h1>${titel}</h1>${unter ? `<div class="unter">${unter}</div>` : ''}</div>${rechts}</div>`;
}

// ---------------------------------------------------------------------------------------------
// Aktionen (ein Klick-Handler für alle Ansichten)
// ---------------------------------------------------------------------------------------------

export function aktionenRegistrieren(app) {
  app.listen = app.listen || new Map();
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-aktion]');
    if (!el || el.disabled) return;
    const aktion = el.dataset.aktion;
    const player = app.player;
    switch (aktion) {
      case 'album-play':
      case 'album-zufall': {
        e.preventDefault();
        const a = await versuche(() => albumHolen(el.dataset.id, el.dataset.edition || null));
        if (!a) return;
        const tracks = albumTracksFuerPlayer(a);
        if (aktion === 'album-zufall' && !player.einst.zufall) player.zufallUmschalten();
        if (aktion === 'album-play' && player.einst.zufall && el.closest('.aktionen')) player.zufallUmschalten();
        const verfuegbar = tracks.map((t, i) => (t.verfuegbar ? i : -1)).filter((i) => i >= 0);
        if (!verfuegbar.length) { toast(t('Von diesem Album liegen keine Dateien vor.'), 'fehler'); return; }
        const start = aktion === 'album-zufall' ? verfuegbar[Math.floor(Math.random() * verfuegbar.length)] : verfuegbar[0];
        player.abspielen(tracks, start, { art: 'album', edition_id: a.edition.id });
        break;
      }
      case 'track-play': {
        const l = app.listen.get(el.dataset.liste);
        if (!l) return;
        const i = Number(el.dataset.i);
        if (player.track && player.track.id === l[i]?.id && player.liste.length === l.filter((t) => t.verfuegbar !== false).length) {
          player.umschalten();
          return;
        }
        player.abspielen(l, i, { art: el.dataset.liste.startsWith('a') ? 'album' : 'liste' });
        break;
      }
      case 'liste-play':
      case 'liste-zufall': {
        const l = app.listen.get(el.dataset.liste);
        if (!l || !l.length) return;
        if (aktion === 'liste-zufall' && !player.einst.zufall) player.zufallUmschalten();
        player.abspielen(l, aktion === 'liste-zufall' ? Math.floor(Math.random() * l.length) : 0, { art: 'liste' });
        break;
      }
      case 'fav': {
        const an = !el.classList.contains('an');
        const r = await versuche(() => api.post('/favoriten', { art: el.dataset.art, id: Number(el.dataset.id), an }));
        if (!r) return;
        document.querySelectorAll(`[data-aktion="fav"][data-art="${el.dataset.art}"][data-id="${el.dataset.id}"]`).forEach((b) => {
          b.classList.toggle('an', an);
          b.setAttribute('aria-pressed', an ? 'true' : 'false');
          b.innerHTML = icon(an ? 'herzVoll' : 'herz', b.closest('.aktionen') ? 20 : 18) + (b.dataset.text ? `<span>${an ? t('Gemerkt') : t('Merken')}</span>` : '');
        });
        for (const l of app.listen.values()) l.forEach((t) => { if (el.dataset.art === 'track' && t.id === Number(el.dataset.id)) t.favorit = an; });
        albumCache.clear();
        if (an) toast(el.dataset.art === 'album' ? t('Album gemerkt') : el.dataset.art === 'kuenstler' ? t('Künstler gemerkt') : t('Zu deinen Lieblingstiteln hinzugefügt'));
        app.leiste?.aktualisieren?.();
        break;
      }
      case 'track-menue': {
        const l = app.listen.get(el.dataset.liste);
        const t = l?.[Number(el.dataset.i)];
        if (t) trackMenue(app, el, t, l, Number(el.dataset.i));
        break;
      }
      case 'album-menue': {
        const a = await versuche(() => albumHolen(el.dataset.id, el.dataset.edition || null));
        if (a) albumMenue(app, el, a);
        break;
      }
      case 'mehr-zeigen': {
        const box = el.previousElementSibling;
        if (box) { box.hidden = false; el.remove(); }
        break;
      }
      case 'credits-umschalten': {
        const box = document.querySelector(`[data-track-credits="${el.dataset.id}"]`);
        if (box) box.hidden = !box.hidden;
        break;
      }
    }
  });
}

/** Nach dem Bearbeiten: Zwischenspeicher leeren und die aktuelle Seite neu zeichnen */
function neuLaden(app) {
  albumCache.clear();
  app.navigieren(location.pathname + location.search, false, true);
}

/** Themenradios: Jahrzehnte und Genres als Knöpfe unter „Mein Radio“ (nur Themen mit genug Songs) */
function themenRadios(th) {
  const alle = [...(th?.jahrzehnte || []), ...(th?.genres || [])];
  if (!alle.length) return '';
  const knopf = (x) => `<button type="button" class="thema-knopf${x.art === 'jahrzehnt' ? ' jahrzehnt' : ''}" data-thema="${x.art}" data-id="${x.id}" title="${h(t('{name}: {n} Songs', { name: x.name, n: x.songs }))}">${icon('radio', 16)}<span>${h(x.name)}</span></button>`;
  return `<div class="themen-radios" data-themen>
      ${th.jahrzehnte?.length ? `<div class="themen-zeile">${th.jahrzehnte.map(knopf).join('')}</div>` : ''}
      ${th.genres?.length ? `<div class="themen-zeile">${th.genres.map(knopf).join('')}</div>` : ''}
    </div>`;
}

function trackMenue(app, anker, tk, l, i) {
  const eintraege = [
    { titel: tk.titel },
    { text: t('Als Nächstes spielen'), icon: 'naechstes', aktion: () => app.player.alsNaechstes([tk]) },
    { text: t('Zur Warteschlange'), icon: 'warteschlange', aktion: () => app.player.anhaengen([tk]) },
    { text: t('Zur Playlist hinzufügen …'), icon: 'playlists', aktion: () => zurPlaylist(app, [tk]) },
    { text: t('Radio ab diesem Titel'), icon: 'radio', aktion: () => app.player.radioStarten({ art: 'track', id: tk.id }) },
    ...(app.ich?.app?.klang ? [{ text: t('Klangradio (klingt ähnlich)'), icon: 'radio', aktion: () => app.player.radioStarten({ art: 'klang', id: tk.id }) }] : []),
  ];
  if (document.querySelector(`[data-track-credits="${tk.id}"]`)) {
    eintraege.push({ text: t('Mitwirkende anzeigen'), icon: 'info', aktion: () => { const b = document.querySelector(`[data-track-credits="${tk.id}"]`); b.hidden = !b.hidden; } });
  }
  eintraege.push({ trenner: true });
  if (tk.album && !location.pathname.startsWith(`/alben/${tk.album.id}`)) eintraege.push({ text: t('Zum Album'), icon: 'album', aktion: () => app.navigieren(`/alben/${tk.album.id}`) });
  (tk.kuenstler || []).slice(0, 3).forEach((k) => eintraege.push({ text: t('Zu {name}', { name: k.name }), icon: 'kuenstler', aktion: () => app.navigieren(`/kuenstler/${k.id}`) }));
  const off = offlineTitelEintraege(app, tk);
  if (off.length || (app.ich.app.downloads && tk.verfuegbar !== false)) eintraege.push({ trenner: true }, ...off);
  if (app.ich.app.downloads && tk.verfuegbar !== false) {
    eintraege.push({ text: t('Datei herunterladen'), icon: 'download', aktion: () => herunterladen(`/api/v1/download/${tk.id}`) });
  }
  if (app.ich.user.rolle === 'admin') {
    eintraege.push({ trenner: true });
    if (tk.verfuegbar === false) eintraege.push({ text: t('Aus anderem Album übernehmen …'), icon: 'album', aktion: () => titelUebernehmen(app, tk) });
    eintraege.push({ text: t('Titel bearbeiten …'), icon: 'bearbeiten', aktion: () => trackBearbeiten(app, tk.id, () => neuLaden(app)) });
  }
  menue(anker, eintraege);
}

/**
 * Fehlenden Titel aus einem anderen Album übernehmen: Vorschläge (gleiche Aufnahme, gleicher Titel vom selben Künstler)
 * und freie Suche über Titel, Künstler und Album. Die gewählte Datei wird kopiert, benannt und umgetaggt.
 */
async function titelUebernehmen(app, tk) {
  const qualitaet = (x) => (x.bittiefe ? `${x.format} ${x.bittiefe}/${(x.abtastrate / 1000).toLocaleString(locale)}` : x.format);
  let ziel = null;
  await dialog({
    titel: t('Titel aus anderem Album übernehmen'),
    breit: true,
    inhalt: `<p class="hinweis" data-ue-ziel style="margin-top:0">${t('Lade …')}</p>
      <div class="such-gross" style="margin:0 0 12px">${icon('suche', 18)}<input type="search" data-ue-q placeholder="${t('Anderen Titel suchen: Titel, Künstler oder Album …')}" autocomplete="off"></div>
      <div class="ue-liste" data-ue-liste><div class="lade"></div></div>
      <p class="hinweis" style="margin:12px 0 0;font-size:.82rem">${t('Die Datei wird in den Ordner dieses Albums kopiert, nach deinem Schema benannt und bekommt die Tags dieses Albums. WAV, AIFF, WavPack und APE werden dabei verlustfrei zu FLAC (Audio bitgenau gleich). Das Original bleibt, wo es ist.')}</p>`,
    knoepfe: [{ text: t('Schließen'), wert: 'abbrechen', art: 'zweit' }],
    beimOeffnen: (d) => {
      const liste = d.querySelector('[data-ue-liste]');
      const eingabe = d.querySelector('[data-ue-q]');
      let timer = null;
      let nr = 0;
      const zeichnen = (r, q) => {
        ziel = r.ziel;
        d.querySelector('[data-ue-ziel]').innerHTML = t('Fehlt: <b>{nr}. {titel}</b>{laenge} in <b>{album}</b>', { nr: h(String(ziel.nr)), titel: h(ziel.titel), laenge: ziel.laenge_ms ? ` (${dauer(ziel.laenge_ms)})` : '', album: h(ziel.album) });
        if (!r.kandidaten.length) {
          liste.innerHTML = `<p class="hinweis" style="margin:8px 0">${q ? t('Nichts gefunden für „{q}“.', { q: h(q) }) : t('Keine passende Aufnahme in deiner Bibliothek gefunden – such oben nach Titel, Künstler oder Album.')}</p>`;
          return;
        }
        liste.innerHTML = `${q ? '' : `<p class="hinweis" style="margin:0 0 6px;font-size:.85rem">${t('Vorschläge')}</p>`}${r.kandidaten.map((k) => {
          const schlechter = ziel.album_bittiefe && (k.bittiefe < ziel.album_bittiefe || (!k.bittiefe && k.format === 'MP3'));
          const laenge = k.laenge_diff_s != null && Math.abs(k.laenge_diff_s) > 5;
          return `<div class="ue-zeile">
            <div class="ue-text"><b>${h(k.titel)}</b><small>${h(k.kuenstler)} · <a href="/alben/${k.album_id}" data-link>${h(k.album)}</a>${k.jahr ? ` (${k.jahr})` : ''}</small>
              <span class="ue-marken">${k.gleiche_aufnahme ? `<span class="marke marke-gut">${t('gleiche Aufnahme')}</span>` : ''}<span class="marke${schlechter ? ' marke-warn' : ''}" title="${schlechter ? t('Schlechtere Qualität als der Rest des Albums') : ''}">${h(qualitaet(k))}</span>${k.zu_flac ? `<span class="marke" title="${t('Wird beim Übernehmen verlustfrei nach FLAC umgewandelt (Audio bitgenau gleich), damit Tags hineinpassen')}">→ FLAC</span>` : ''}${k.laenge_ms ? `<span class="marke${laenge ? ' marke-warn' : ''}" title="${laenge ? t('Länge weicht deutlich ab – andere Fassung?') : ''}">${dauer(k.laenge_ms)}${laenge ? ` (${k.laenge_diff_s > 0 ? '+' : '−'}${Math.abs(k.laenge_diff_s)} s)` : ''}</span>` : ''}</span></div>
            <button type="button" class="btn btn-klein" data-ue-nehmen="${k.track_id}" ${k.moeglich ? '' : `disabled title="${h(t('{format} kann Amberwave nicht umtaggen', { format: k.format }))}"`}>${t('Übernehmen')}</button>
          </div>`;
        }).join('')}`;
        liste.querySelectorAll('[data-ue-nehmen]').forEach((b) => b.addEventListener('click', async () => {
          liste.querySelectorAll('[data-ue-nehmen]').forEach((x) => { x.disabled = true; });
          b.textContent = t('Wird kopiert …');
          const x = await versuche(() => api.post(`/admin/tracks/${tk.id}/uebernehmen`, { quelle: Number(b.dataset.ueNehmen) }));
          if (!x) { liste.querySelectorAll('[data-ue-nehmen]').forEach((y) => { y.disabled = false; }); b.textContent = t('Übernehmen'); return; }
          toast(x.zu_flac ? t('Übernommen (als FLAC): {datei}', { datei: x.pfad.split('/').pop() }) : t('Übernommen: {datei}', { datei: x.pfad.split('/').pop() }));
          d.close();
          neuLaden(app);
        }));
      };
      const laden = async (q) => {
        const meins = ++nr;
        liste.innerHTML = '<div class="lade"></div>';
        try {
          const r = await api.get(`/admin/tracks/${tk.id}/uebernehmen${q ? `?q=${encodeURIComponent(q)}` : ''}`);
          if (meins === nr) zeichnen(r, q);
        } catch (e) { if (meins === nr) liste.innerHTML = `<p class="hinweis" style="color:var(--danger)">${h(e.message)}</p>`; }
      };
      eingabe.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => laden(eingabe.value.trim()), 300); });
      eingabe.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); laden(eingabe.value.trim()); } });
      laden('');
    },
  });
}

function albumMenue(app, anker, a) {
  const tracks = albumTracksFuerPlayer(a);
  const eintraege = [
    { text: t('Als Nächstes spielen'), icon: 'naechstes', aktion: () => app.player.alsNaechstes(tracks) },
    { text: t('Zur Warteschlange'), icon: 'warteschlange', aktion: () => app.player.anhaengen(tracks) },
    { text: t('Zur Playlist hinzufügen …'), icon: 'playlists', aktion: () => zurPlaylist(app, tracks.filter((t) => t.verfuegbar)) },
    { text: t('Radio zu diesem Album'), icon: 'radio', aktion: () => app.player.radioStarten({ art: 'album', id: a.id }) },
    ...offlineAlbumEintraege(app, a),
  ];
  if (app.ich.user.rolle === 'admin') {
    eintraege.push({ trenner: true }, { titel: t('Verwaltung') },
      ...bearbeitenEintraege(app, a));
  }
  menue(anker, eintraege);
}

/** Alles, was ein Admin an einem Album bearbeiten kann (Album-Menü und Knopf „Bearbeiten“) */
function bearbeitenEintraege(app, a) {
  const fertig = () => neuLaden(app);
  const ed = { id: a.edition.id, titel: a.edition.titel || a.titel };
  const e = [
    { text: t('Album bearbeiten …'), icon: 'bearbeiten', aktion: () => albumBearbeiten(app, a.id, fertig) },
    { text: t('Titelliste bearbeiten …'), icon: 'warteschlange', aktion: () => titellisteBearbeiten(app, a.edition.id, fertig) },
    { text: t('Mitwirkende bearbeiten …'), icon: 'kuenstler', aktion: () => mitwirkendeBearbeiten(app, ed, fertig) },
    { text: t('Edition bearbeiten …'), icon: 'alben', aktion: () => editionBearbeiten(app, { id: a.edition.id }, fertig) },
    { text: t('Edition löschen …'), icon: 'muell', rot: true, aktion: () => editionLoeschen(app, { id: a.edition.id }, fertig) },
    { text: t('Cover hochladen …'), icon: 'album', aktion: () => coverHochladen(app, ed, fertig) },
    { text: t('Mit MusicBrainz abgleichen'), icon: 'suche', aktion: () => app.navigieren(`/verwaltung/abgleich/${a.edition.id}`) },
    { text: t('Dateien aufräumen …'), icon: 'verlauf', aktion: () => albumAufraeumen(app, a.edition.id) },
  ];
  const nFlac = flacKandidaten(a.tracks);
  if (nFlac) e.push({ text: t('Verlustfreie Titel in FLAC umwandeln ({n})', { n: nFlac }), icon: 'download', aktion: () => flacUmwandeln(app, a.edition.id, fertig) });
  if (a.editionen && a.editionen.length > 1) e.push({ text: t('Editionen anzeigen …'), icon: 'alben', aktion: () => editionWaehlen(app, a) });
  (a.kuenstler || []).slice(0, 4).forEach((k) => e.push({ text: t('Künstler „{name}“ bearbeiten …', { name: k.name }), icon: 'kuenstler', aktion: () => kuenstlerBearbeiten(app, k.id, fertig) }));
  return e;
}

/** Dialog: Titel zu einer (neuen oder vorhandenen) Playlist hinzufügen */
export async function zurPlaylist(app, tracks) {
  if (!tracks.length) return;
  const r = await versuche(() => api.get('/playlists'));
  if (!r) return;
  const eigene = r.playlists.filter((p) => p.eigene || app.ich.user.rolle === 'admin' && p.familie);
  const auswahl = eigene.map((p, i) => `<label class="checkbox-zeile" style="margin:8px 0"><input type="radio" name="playlist" value="${p.id}" ${i === 0 ? 'checked' : ''}> ${h(p.name)} <small style="color:var(--text-leise)">${tn(p.anzahl, '1 Titel', '{n} Titel')}</small></label>`).join('');
  const d = await dialog({
    titel: tracks.length === 1 ? t('„{titel}“ hinzufügen', { titel: tracks[0].titel }) : t('{n} Titel hinzufügen', { n: tracks.length }),
    inhalt: `${auswahl ? `<div>${auswahl}</div>` : ''}
      <label class="checkbox-zeile" style="margin:12px 0 4px"><input type="radio" name="playlist" value="neu" ${eigene.length ? '' : 'checked'}> ${t('Neue Playlist')}</label>
      <input type="text" name="name" placeholder="${t('Name der neuen Playlist')}" maxlength="200">`,
    knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Hinzufügen'), wert: 'ok' }],
  });
  if (!d) return;
  const wahl = d.form.get('playlist');
  const ids = tracks.map((t) => t.id);
  if (wahl === 'neu' || !wahl) {
    const name = String(d.form.get('name') || '').trim();
    if (!name) { toast(t('Bitte einen Namen für die neue Playlist eingeben.'), 'fehler'); return; }
    await versuche(() => api.post('/playlists', { name, track_ids: ids }), t('Playlist „{name}“ angelegt', { name }));
  } else {
    await versuche(() => api.post(`/playlists/${wahl}/tracks`, { track_ids: ids }), t('Zur Playlist hinzugefügt'));
  }
}

async function editionWaehlen(app, a) {
  const mitDateien = a.editionen.filter((e) => e.dateien > 0).length;
  const optionen = a.editionen.map((e) => `<label class="checkbox-zeile" style="margin:10px 0;align-items:flex-start"><input type="radio" name="ed" value="${e.id}" ${e.angezeigt ? 'checked' : ''} style="margin-top:3px">
    <span><b>${h(e.titel)}</b> <small style="color:var(--text-muted)">${h([e.jahr, land(e.land), e.format, t('{dateien}/{tracks} Titel', { dateien: e.dateien, tracks: e.tracks }), e.qualitaet].filter(Boolean).join(' · '))}</small><br><small style="color:var(--text-leise)">${h(e.ordner || '–')}</small></span></label>`).join('');
  const d = await dialog({
    titel: t('Editionen anzeigen'),
    inhalt: `<label class="checkbox-zeile" style="margin:4px 0 6px;align-items:flex-start"><input type="checkbox" name="einzeln" value="1" ${a.einzeln ? 'checked' : ''} ${mitDateien < 2 ? 'disabled' : ''} style="margin-top:3px">
        <span><b>${t('Jede Edition als eigenes Album zeigen')}</b><br><small style="color:var(--text-muted)">${t('z. B. Original und Remaster nebeneinander – ohne Umschalten.')} ${mitDateien < 2 ? t('Dafür braucht es mindestens zwei Editionen mit Dateien.') : tn(mitDateien, '1 Edition hat Dateien.', '{n} Editionen haben Dateien.')}</small></span></label>
      <p class="hinweis" style="margin-top:16px">${t('Sonst sieht die Familie eine Edition. Automatisch ist es die mit den meisten Titeln, bei Gleichstand die neueste:')}</p>
      <label class="checkbox-zeile" style="margin:10px 0"><input type="radio" name="ed" value="0"> ${t('Automatisch wählen')}</label>${optionen}`,
    knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Speichern'), wert: 'ok' }],
  });
  if (!d) return;
  if (await versuche(() => api.put(`/admin/alben/${a.id}/edition`, { edition_id: Number(d.form.get('ed')) || 0, einzeln: d.form.get('einzeln') === '1' }), t('Gespeichert'))) {
    albumCache.clear();
    app.navigieren(`/alben/${a.id}`, false);
  }
}

// ---------------------------------------------------------------------------------------------
// Ansichten
// ---------------------------------------------------------------------------------------------

export const ansichten = {
  offline: offlineSeite,

  async start({ app, ziel, signal, leise }) {
    const r = await api.get('/start' + (leise && entdeckenIds.length ? `?entdecken=${entdeckenIds.join(',')}` : ''), { signal });
    entdeckenIds = r.entdecken.map((a) => a.id);
    const name = app.ich.user.vorname && app.ich.user.vorname !== 'Admin' ? `, ${h(app.ich.user.vorname)}` : '';
    const stunde = new Date().getHours();
    const gruss = stunde < 11 ? t('Guten Morgen') : stunde < 18 ? t('Hallo') : t('Guten Abend');
    if (!r.zahlen.alben) {
      ziel.innerHTML = seitenKopf(`${gruss}${name}`) + leer(t('Noch keine Musik in der Sammlung'),
        app.ich.user.rolle === 'admin' ? t('Lies unter Verwaltung → Bibliothek deine Musiksammlung ein.') : t('Sobald Musik eingelesen ist, erscheint sie hier.'),
        app.ich.user.rolle === 'admin' ? `<p><a class="btn" href="/verwaltung/bibliothek" data-link>${t('Bibliothek einlesen')}</a></p>` : '');
      return;
    }
    const weiter = r.weiterhoeren.map((a) => albumKachel({ ...a, hinweis: t('Weiterhören') }, { herz: false })).join('');
    ziel.innerHTML = seitenKopf(`${gruss}${name}`, t('{alben} Alben · {kuenstler} Künstler · {tracks} Titel', { alben: zahl(r.zahlen.alben), kuenstler: zahl(r.zahlen.kuenstler), tracks: zahl(r.zahlen.tracks) }))
      + `<button type="button" class="radio-karte" data-mein-radio>
          <span class="radio-symbol">${icon('radio', 30)}</span>
          <span class="radio-text"><b>${t('Mein Radio')}</b><small>${t('Endlos aus deinen Lieblingen und dem, was dazu passt – auch aus Ecken der Sammlung, die du noch nicht kennst. Lernt einfach mit: was du komplett hörst, oft wiederholst oder überspringst.')}</small></span>
          <span class="radio-play">${icon('play', 22)}</span>
        </button>`
      + themenRadios(r.radio_themen)
      + abschnitt(t('Weiterhören'), weiter ? reihe(weiter) : '')
      + abschnitt(t('Neu in der Sammlung'), reihe(r.neu.map((a) => albumKachel(a)).join('')), `<a href="/alben?sort=neu" data-link>${t('Alle anzeigen')}</a>`)
      + abschnitt(t('Oft gehört'), r.oft.length ? reihe(r.oft.map((a) => albumKachel(a)).join('')) : '')
      + abschnitt(t('Entdecken'), reihe(r.entdecken.map((a) => albumKachel(a)).join('')), `<a href="/alben?sort=zufall" data-link>${t('Mehr Zufall')}</a>`);
    ziel.querySelector('[data-mein-radio]')?.addEventListener('click', () => app.player.radioStarten(null));
    ziel.querySelector('[data-themen]')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-thema]');
      if (b) app.player.radioStarten({ art: b.dataset.thema, id: b.dataset.thema === 'familie' ? b.dataset.id : Number(b.dataset.id) });
    });
  },

  async alben({ app, ziel, query, signal, wiederherstellen }) {
    const genres = await api.get('/genres', { signal }).catch(() => ({ genres: [] }));
    const SORTEN = ['kuenstler', 'titel', 'jahr', 'neu', 'zufall'];
    const zustand = {
      typ: query.get('typ') || '', genre: query.get('genre') || (query.get('familie') ? `f:${query.get('familie')}` : ''), jahrzehnt: query.get('jahrzehnt') || '',
      sort: SORTEN.includes(query.get('sort')) ? query.get('sort') : gemerktAus('alben_sort', SORTEN, 'kuenstler'),
      favoriten: query.get('favoriten') === '1', seite: 1,
      ansicht: query.get('ansicht') || gemerkt('alben_ansicht') || 'raster', buchstabe: query.get('b') || '',
    };
    if (!['raster', 'kuenstler'].includes(zustand.ansicht)) zustand.ansicht = 'raster';
    const jahrzehnte = [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020];
    const buchstaben = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
    const sel = (wert, aktuell) => (String(wert) === String(aktuell) ? 'selected' : '');
    ziel.innerHTML = seitenKopf(t('Alben'), '<span data-anzahl></span>', `<div class="umschalter" role="group" aria-label="${t('Ansicht')}">
        <button type="button" data-ansicht="raster" aria-pressed="${zustand.ansicht === 'raster'}" title="${t('Alle Alben als Raster')}">${icon('raster', 18)}<span>${t('Raster')}</span></button>
        <button type="button" data-ansicht="kuenstler" aria-pressed="${zustand.ansicht === 'kuenstler'}" title="${t('Nach Albumkünstler gruppiert')}">${icon('gruppiert', 18)}<span>${t('Nach Künstler')}</span></button></div>`) + `
      <div class="filterleiste" data-filter>
        <select name="typ" aria-label="${t('Art')}">
          <option value="">${t('Alle Arten')}</option><option value="studio" ${sel('studio', zustand.typ)}>${t('Studioalben')}</option>
          <option value="album" ${sel('album', zustand.typ)}>${t('Alben')}</option><option value="ep" ${sel('ep', zustand.typ)}>${t('EPs')}</option>
          <option value="single" ${sel('single', zustand.typ)}>${t('Singles')}</option><option value="live" ${sel('live', zustand.typ)}>${t('Live')}</option>
          <option value="compilation" ${sel('compilation', zustand.typ)}>${t('Kompilationen')}</option><option value="soundtrack" ${sel('soundtrack', zustand.typ)}>${t('Soundtracks')}</option>
        </select>
        <select name="genre" aria-label="${t('Genre')}"><option value="">${t('Alle Genres')}</option>${genres.familien?.length ? `<optgroup label="${t('Genre-Familien')}">${genres.familien.map((f) => `<option value="f:${f.key}" ${sel(`f:${f.key}`, zustand.genre)}>${h(f.name)} (${f.alben})</option>`).join('')}</optgroup><optgroup label="${t('Einzelne Genres')}">` : ''}${genres.genres.map((g) => `<option value="${g.id}" ${sel(g.id, zustand.genre)}>${h(g.name)} (${g.alben})</option>`).join('')}${genres.familien?.length ? '</optgroup>' : ''}</select>
        <select name="jahrzehnt" aria-label="${t('Jahrzehnt')}"><option value="">${t('Alle Jahrzehnte')}</option>${jahrzehnte.map((j) => `<option value="${j}" ${sel(j, zustand.jahrzehnt)}>${t('{j}er', { j: String(j).slice(2) })}</option>`).join('')}</select>
        <button type="button" class="pille${zustand.favoriten ? ' an' : ''}" data-fav-filter style="min-height:40px">${icon('herz', 16)} ${t('Gemerkt')}</button>
        <span class="abstand"></span>
        <select name="sort" aria-label="${t('Sortierung')}" data-sort>
          <option value="kuenstler" ${sel('kuenstler', zustand.sort)}>${t('Künstler A–Z')}</option><option value="titel" ${sel('titel', zustand.sort)}>${t('Titel A–Z')}</option>
          <option value="jahr" ${sel('jahr', zustand.sort)}>${t('Erscheinungsjahr')}</option><option value="neu" ${sel('neu', zustand.sort)}>${t('Zuletzt hinzugefügt')}</option>
          <option value="zufall" ${sel('zufall', zustand.sort)}>${t('Zufall')}</option>
        </select>
      </div>
      <div class="buchstaben" data-buchstaben>${buchstaben.map((x) => `<button type="button" data-b="${x}" class="${zustand.buchstabe === x ? 'an' : ''}">${x}</button>`).join('')}</div>
      <div data-raster></div><div data-mehr style="text-align:center;margin-top:26px"></div>`;
    const rasterEl = ziel.querySelector('[data-raster]');
    const mehrEl = ziel.querySelector('[data-mehr]');
    const sortEl = ziel.querySelector('[data-sort]');
    const bEl = ziel.querySelector('[data-buchstaben]');
    const gruppiert = () => zustand.ansicht === 'kuenstler';
    const ansichtZeigen = () => {
      ziel.querySelectorAll('[data-ansicht]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.ansicht === zustand.ansicht));
      sortEl.hidden = gruppiert();
      bEl.hidden = !gruppiert();
    };
    ansichtZeigen();
    const kreditSchluessel = (a) => a.kuenstler.map((k) => `${k.id}${k.verbindung || ''}`).join('|') || '–';
    const gruppeHtml = (schluessel, alben, bilder) => {
      const k = alben[0].kuenstler;
      const bild = k[0] && bilder[k[0].id];
      const avatar = `<a class="gruppe-bild" ${k[0] ? `href="/kuenstler/${k[0].id}" data-link` : ''} aria-hidden="true" tabindex="-1">${bild ? `<img src="${h(bild)}" alt="" loading="lazy">` : h(initialen(k[0]?.name || '?'))}</a>`;
      return `<section class="gruppe" data-gruppe="${h(schluessel)}">
        <div class="gruppe-kopf">${avatar}<div><h2>${k.length ? kuenstlerLinks(k) : t('Unbekannt')}</h2><small data-gruppe-anzahl></small></div></div>
        ${raster(alben.map((a) => albumKachel(a, { ohneKuenstler: true })).join(''))}</section>`;
    };
    const anzahlenSetzen = () => rasterEl.querySelectorAll('.gruppe').forEach((g) => {
      const n = g.querySelectorAll('.kachel').length;
      g.querySelector('[data-gruppe-anzahl]').textContent = tn(n, '1 Album', '{n} Alben');
    });
    const laden = async (anhaengen = false) => {
      const p = new URLSearchParams();
      for (const k of ['typ', 'genre', 'jahrzehnt']) if (zustand[k]) { if (k === 'genre' && String(zustand[k]).startsWith('f:')) p.set('familie', String(zustand[k]).slice(2)); else p.set(k, zustand[k]); }
      if (!gruppiert()) p.set('sort', zustand.sort);
      if (zustand.favoriten) p.set('favoriten', '1');
      if (gruppiert()) { p.set('ansicht', 'kuenstler'); if (zustand.buchstabe) p.set('b', zustand.buchstabe); }
      history.replaceState(history.state || {}, '', '/alben' + (p.toString() ? '?' + p : ''));
      app.gezeichnet = location.pathname + location.search;
      p.delete('ansicht');
      p.delete('b');
      if (gruppiert()) { p.set('sort', 'gruppiert'); if (zustand.buchstabe) p.set('buchstabe', zustand.buchstabe); }
      p.set('seite', zustand.seite);
      p.set('pro_seite', gruppiert() ? 240 : 120);
      const r = await api.get('/alben?' + p, { signal });
      if (gruppiert()) {
        // Aufeinanderfolgende Alben mit derselben Künstlerangabe bilden eine Gruppe
        const gruppen = [];
        r.alben.forEach((a) => {
          const s2 = kreditSchluessel(a);
          if (gruppen.length && gruppen[gruppen.length - 1][0] === s2) gruppen[gruppen.length - 1][1].push(a);
          else gruppen.push([s2, [a]]);
        });
        if (!anhaengen) rasterEl.innerHTML = r.alben.length ? '' : leer(t('Keine Alben gefunden'), t('Mit anderen Filtern versuchen.'));
        gruppen.forEach(([s2, alben], i) => {
          const letzte = rasterEl.querySelector('.gruppe:last-child');
          if (i === 0 && anhaengen && letzte && letzte.dataset.gruppe === s2) {
            letzte.querySelector('.raster').insertAdjacentHTML('beforeend', alben.map((a) => albumKachel(a, { ohneKuenstler: true })).join(''));
          } else rasterEl.insertAdjacentHTML('beforeend', gruppeHtml(s2, alben, r.bilder || {}));
        });
        anzahlenSetzen();
      } else {
        const html = r.alben.map((a) => albumKachel(a)).join('');
        if (anhaengen) rasterEl.querySelector('.raster').insertAdjacentHTML('beforeend', html);
        else rasterEl.innerHTML = r.alben.length ? raster(html) : leer(t('Keine Alben gefunden'), t('Mit anderen Filtern versuchen.'));
      }
      ziel.querySelector('[data-anzahl]').textContent = tn(r.gesamt, '1 Album', '{n} Alben');
      mehrEl.innerHTML = r.seite * r.pro_seite < r.gesamt ? '<button type="button" class="btn btn-zweit" data-mehr-laden>' + t('Weitere laden') + '</button>' : '';
      app.listenSeiten.set(location.pathname + location.search, zustand.seite);
    };
    ziel.querySelector('[data-filter]').addEventListener('change', (e) => {
      if (!e.target.name) return;
      zustand[e.target.name] = e.target.value;
      if (e.target.name === 'sort') merken('alben_sort', zustand.sort);
      zustand.seite = 1;
      laden();
    });
    ziel.querySelector('[data-fav-filter]').addEventListener('click', (e) => {
      zustand.favoriten = !zustand.favoriten;
      e.currentTarget.classList.toggle('an', zustand.favoriten);
      zustand.seite = 1;
      laden();
    });
    ziel.querySelectorAll('[data-ansicht]').forEach((x) => x.addEventListener('click', () => {
      if (zustand.ansicht === x.dataset.ansicht) return;
      zustand.ansicht = x.dataset.ansicht;
      merken('alben_ansicht', zustand.ansicht);
      zustand.seite = 1;
      ansichtZeigen();
      laden();
    }));
    bEl.addEventListener('click', (e) => {
      const x = e.target.closest('button[data-b]');
      if (!x) return;
      zustand.buchstabe = zustand.buchstabe === x.dataset.b ? '' : x.dataset.b;
      bEl.querySelectorAll('[data-b]').forEach((y) => y.classList.toggle('an', y.dataset.b === zustand.buchstabe));
      zustand.seite = 1;
      laden();
    });
    mehrEl.addEventListener('click', (e) => { if (e.target.closest('[data-mehr-laden]')) { zustand.seite++; laden(true); } });
    // Nach Bearbeiten/Zurück: die schon geladenen „Weitere laden“-Seiten wieder holen, damit die Scrollposition passt
    // (der Stand muss vor dem ersten Laden gelesen werden – das Laden überschreibt ihn)
    const bis = wiederherstellen && zustand.sort !== 'zufall' ? app.listenSeiten.get(location.pathname + location.search) || 1 : 1;
    await laden();
    for (let s2 = 2; s2 <= bis && !signal.aborted; s2++) { zustand.seite = s2; await laden(true); }
  },

  async album({ app, ziel, param, query, signal }) {
    const id = Number(param[0]);
    const a = await albumHolen(id, query.get('edition'), signal);
    const admin = app.ich.user.rolle === 'admin';
    const ed = a.edition;
    const key = liste(app, `a${id}`, albumTracksFuerPlayer(a));
    const label = [...new Set(ed.labels.filter((l) => l.name).map((l) => l.name))].map(h).join(', ');
    const verfuegbar = a.tracks.filter((t) => t.verfuegbar).length;
    const fakten = [
      a.jahr ? `<span>${a.jahr}</span>` : '',
      `<span>${verfuegbar < a.tracks.length ? tn(a.tracks.length, '1 Titel ({v} vorhanden) · {dauer}', '{n} Titel ({v} vorhanden) · {dauer}', { v: verfuegbar, dauer: dauerText(ed.laenge_ms) }) : tn(a.tracks.length, '1 Titel · {dauer}', '{n} Titel · {dauer}', { dauer: dauerText(ed.laenge_ms) })}</span>`,
      label ? `<span>${label}</span>` : '',
      ed.qualitaet ? `<span class="marke${/^(FLAC|ALAC|WAV|AIFF|WV)/.test(ed.qualitaet) ? ' marke-akzent' : ''}">${h(ed.qualitaet)}</span>` : '',
    ].filter(Boolean).join('');
    const quelleText = a.credits_quelle || (ed.quelle === 'musicbrainz' ? t('Quelle: MusicBrainz') : ed.quelle === 'manuell' ? t('Von Hand gepflegt') : t('Aus den Datei-Tags'));
    const editionHinweis = admin && a.editionen && a.editionen.length > 1
      ? `<div class="glass-panel" style="margin-top:20px"><h4 style="font-family:var(--font-body);font-size:.74rem;letter-spacing:.1em;text-transform:uppercase;color:var(--text-leise);margin-bottom:10px">${t('Editionen (nur für dich sichtbar)')}</h4>
        ${a.editionen.map((e) => `<div class="credit" style="justify-content:space-between;align-items:center"><a href="/alben/${id}?edition=${e.id}" data-link>${h(e.titel)}${e.jahr ? ` (${e.jahr})` : ''}</a>
          <span style="display:inline-flex;align-items:center;gap:6px"><span class="rolle">${h([land(e.land), e.format, `${e.dateien}/${e.tracks}`, e.quelle === 'musicbrainz' ? 'MB' : ''].filter(Boolean).join(' · '))}${e.angezeigt ? ` · ${t('angezeigt')}` : ''}</span>
          <button type="button" class="btn-ico" data-ed-panel="${e.id}" data-menue-anker aria-label="${t('Edition bearbeiten oder löschen')}">${icon('mehr', 16)}</button></span></div>`).join('')}</div>` : '';
    ziel.innerHTML = `
      <div class="album-kopf">
        <div class="album-cover">${ed.cover_gross ? `<img src="${h(ed.cover_gross)}" alt="${h(t('Cover von {titel}', { titel: a.titel }))}">` : `<span class="platzhalter">${h(a.titel)}</span>`}</div>
        <div class="album-info">
          <div class="ueberzeile">${h(typZeile(a))}</div>
          <h1>${h(a.titel)}${eBadge(ed.explizit)}${ed.clean ? `<span class="clean-badge" title="${t('Bereinigte Fassung')}">Clean</span>` : ''}${ed.name ? ` <span class="edition-name">${h(ed.name)}</span>` : ''}</h1>
          <div class="album-kuenstler">${kuenstlerLinks(a.kuenstler)}</div>
          <div class="fakten">${fakten}</div>
          ${a.versionen && a.versionen.length > 1 ? `<div class="pillen versionen" aria-label="${t('Versionen')}">${a.versionen.map((v) => `<a class="pille${v.aktiv ? ' an' : ''}" href="/alben/${id}?edition=${v.id}" data-link ${v.aktiv ? 'aria-current="page"' : ''}>${h(v.name || t('Version'))}</a>`).join('')}</div>` : ''}
          ${a.genres.length ? `<div class="pillen">${a.genres.map((g) => `<a class="pille" href="/alben?genre=${g.id}" data-link>${h(g.name)}</a>`).join('')}</div>` : ''}
          <div class="aktionen">
            <button type="button" class="btn" data-aktion="album-play" data-id="${id}" ${query.get('edition') ? `data-edition="${h(query.get('edition'))}"` : ''} ${verfuegbar ? '' : 'disabled'}>${icon('play', 20)}<span>${t('Abspielen')}</span></button>
            <button type="button" class="btn btn-zweit" data-aktion="album-zufall" data-id="${id}" ${query.get('edition') ? `data-edition="${h(query.get('edition'))}"` : ''} ${verfuegbar ? '' : 'disabled'}>${icon('zufall', 18)}<span>${t('Zufall')}</span></button>
            <button type="button" class="btn btn-zweit btn-rund${a.favorit ? ' an' : ''}" data-aktion="fav" data-art="album" data-id="${id}" aria-label="${t('Album merken')}" aria-pressed="${a.favorit}">${icon(a.favorit ? 'herzVoll' : 'herz', 20)}</button>
            ${offlineKnopf('album', id)}
            <button type="button" class="btn btn-zweit btn-rund" data-aktion="album-menue" data-id="${id}" ${query.get('edition') ? `data-edition="${h(query.get('edition'))}"` : ''} data-menue-anker aria-label="${t('Mehr')}">${icon('mehr', 20)}</button>
            ${admin ? `<button type="button" class="btn btn-zweit" data-album-bearbeiten data-menue-anker>${icon('bearbeiten', 18)}<span>${t('Bearbeiten')}</span></button>` : ''}
          </div>
        </div>
      </div>
      <div class="album-spalten">
        <div class="album-tracks">${albumTrackliste(a.tracks, key, a.kuenstler)}
          ${a.beschreibung ? `<section class="abschnitt" style="margin-top:34px"><div class="abschnitt-kopf"><h2>${t('Über das Album')}</h2></div><div class="beschreibung">${h(a.beschreibung)}</div>
            ${a.beschreibung_quelle && a.beschreibung_quelle !== 'manuell' ? `<div class="beschreibung-quelle">${t('Quelle:')} ${/^https?:/.test(a.beschreibung_quelle) ? `<a href="${h(a.beschreibung_quelle)}" target="_blank" rel="noopener">${h(a.beschreibung_quelle.replace(/^https?:\/\//, '').split('/')[0])}</a>` : h(a.beschreibung_quelle)}${a.beschreibung_maschinell ? ` · ${t('maschinell übersetzt')}` : ''}</div>` : ''}</section>` : ''}
        </div>
        <aside class="album-seite">${lautheitPanel(a, app.player)}${creditsPanel(a.credits, quelleText) || `<div class="glass-panel credits"><h2>${t('Mitwirkende')}</h2><p class="hinweis" style="margin:0">${t('Noch keine Mitwirkenden eingetragen.')}${admin ? ` <a href="/verwaltung/abgleich/${ed.id}" data-link>${t('Mit MusicBrainz abgleichen')}</a>` : ''}</p><div class="quelle"><i></i>${h(quelleText)}</div></div>`}${editionHinweis}</aside>
      </div>
      <div class="album-verwandt">${a.verwandt.map((v) => abschnitt(v.art === 'kuenstler' ? t('Mehr von {name}', { name: `<a href="/kuenstler/${v.kuenstler.id}" data-link style="color:inherit">${h(v.kuenstler.name)}</a>` })
        : v.art === 'rolle' ? `${h(v.titel)} <a href="/kuenstler/${v.kuenstler.id}" data-link>${h(v.kuenstler.name)}</a>` : h(v.titel),
        reihe(v.alben.map((x) => albumKachel(x)).join('')))).join('')}</div>`;
    ziel.querySelector('[data-album-bearbeiten]')?.addEventListener('click', (e) => menue(e.currentTarget, bearbeitenEintraege(app, a)));
    ziel.querySelectorAll('[data-ed-panel]').forEach((b) => b.addEventListener('click', () => {
      const e = a.editionen.find((x) => x.id === Number(b.dataset.edPanel));
      if (e) editionMenue(app, b, { ...e, album_id: a.id }, () => neuLaden(app));
    }));
    lautheitVerbinden(ziel);
    leerraumFuellen(ziel);
    // Track-Zeile anklicken (außer Links/Knöpfe) klappt die Mitwirkenden auf
    ziel.querySelectorAll('.track').forEach((z) => z.addEventListener('dblclick', () => {
      const b = z.querySelector('[data-track-credits]');
      if (b) b.hidden = !b.hidden;
    }));
    document.title = `${a.titel} – ${kuenstlerText(a.kuenstler)}`;
  },

  async kuenstlerListe({ app, ziel, query, signal, wiederherstellen }) {
    // Auf dem Handy gibt es weder Alphabetleiste noch „Mitwirkende ohne eigenes Album“ (siehe CSS .nicht-handy) – dort gilt immer: nur Künstler mit Album
    const handy = window.matchMedia('(max-width: 767px)').matches;
    const SORTEN = ['name', 'name_ab', 'alben', 'neu', 'gehoert', 'zufall'];
    const zustand = {
      q: query.get('q') || '', buchstabe: handy ? '' : query.get('b') || '',
      alle: handy ? false : query.has('alle') ? query.get('alle') === '1' : gemerkt('kuenstler_alle') === '1', seite: 1,
      sort: SORTEN.includes(query.get('sort')) ? query.get('sort') : gemerktAus('kuenstler_sort', SORTEN, 'name'),
      typ: query.has('typ') ? query.get('typ') : gemerktAus('kuenstler_typ', ['', 'person', 'gruppe'], ''),
      saat: Math.floor(Math.random() * 1e6) + 1,
    };
    const buchstaben = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
    const sel = (w, a) => (w === a ? 'selected' : '');
    ziel.innerHTML = seitenKopf(t('Künstler{pl}', { pl: '' }), '<span data-anzahl></span>') + `
      <div class="filterleiste">
        <div class="such-gross" style="margin:0;flex:1 1 260px;max-width:420px">${icon('suche', 18)}<input type="search" data-q value="${h(zustand.q)}" placeholder="${t('Künstler suchen')}" aria-label="${t('Künstler suchen')}" style="height:44px;font-size:1rem"></div>
        <select data-typ aria-label="${t('Art')}"><option value="">${t('Alle')}</option><option value="person" ${sel('person', zustand.typ)}>${t('Personen')}</option><option value="gruppe" ${sel('gruppe', zustand.typ)}>${t('Bands &amp; Ensembles')}</option></select>
        <label class="checkbox-zeile nicht-handy" style="margin:0 0 0 8px"><input type="checkbox" data-alle ${zustand.alle ? 'checked' : ''}> ${t('Auch Mitwirkende ohne eigenes Album')}</label>
        <span class="abstand"></span>
        <select data-sort aria-label="${t('Sortierung')}">
          <option value="name" ${sel('name', zustand.sort)}>${t('Name A–Z')}</option><option value="name_ab" ${sel('name_ab', zustand.sort)}>${t('Name Z–A')}</option>
          <option value="alben" ${sel('alben', zustand.sort)}>${t('Meiste Alben')}</option><option value="neu" ${sel('neu', zustand.sort)}>${t('Zuletzt hinzugefügt')}</option>
          <option value="gehoert" ${sel('gehoert', zustand.sort)}>${t('Von dir am meisten gehört')}</option><option value="zufall" ${sel('zufall', zustand.sort)}>${t('Zufall')}</option>
        </select>
      </div>
      <div class="buchstaben nicht-handy" data-buchstaben>${buchstaben.map((b) => `<button type="button" data-b="${b}" class="${zustand.buchstabe === b ? 'an' : ''}">${b}</button>`).join('')}</div>
      <div data-raster></div><div data-mehr style="text-align:center;margin-top:26px"></div>`;
    const laden = async (anhaengen = false) => {
      const p = new URLSearchParams();
      if (zustand.q) p.set('q', zustand.q);
      if (zustand.buchstabe) p.set('buchstabe', zustand.buchstabe);
      if (zustand.alle) p.set('alle', '1');
      if (zustand.typ) p.set('typ', zustand.typ);
      if (zustand.sort !== 'name') p.set('sort', zustand.sort);
      history.replaceState(history.state || {}, '', '/kuenstler' + (p.toString() ? '?' + p.toString().replace('buchstabe=', 'b=') : ''));
      app.gezeichnet = location.pathname + location.search;
      p.set('seite', zustand.seite);
      if (zustand.sort === 'zufall') p.set('saat', zustand.saat);
      const r = await api.get('/kuenstler?' + p, { signal });
      const unter = (k) => {
        const alben = k.alben ? tn(k.alben, '1 Album', '{n} Alben') : KUENSTLER_TYP[k.typ] || '';
        if (zustand.sort === 'gehoert' && k.gehoert) return t('{n}× gehört', { n: zahl(k.gehoert) });
        if (zustand.sort === 'neu' && k.zuletzt) return t('{alben} · neu seit {datum}', { alben, datum: datum(k.zuletzt) });
        return alben;
      };
      const html = r.kuenstler.map((k) => kuenstlerKachel(k, unter(k))).join('');
      const el = ziel.querySelector('[data-raster]');
      if (anhaengen) el.querySelector('.raster').insertAdjacentHTML('beforeend', html);
      else el.innerHTML = r.kuenstler.length ? raster(html) : leer(t('Keine Künstler gefunden'));
      ziel.querySelector('[data-anzahl]').textContent = tn(r.gesamt, '1 Künstler', '{n} Künstler');
      ziel.querySelector('[data-mehr]').innerHTML = zustand.seite * 200 < r.gesamt ? '<button type="button" class="btn btn-zweit" data-mehr-laden>' + t('Weitere laden') + '</button>' : '';
      app.listenSeiten.set(location.pathname + location.search, zustand.seite);
    };
    let zeit = null;
    ziel.querySelector('[data-q]').addEventListener('input', (e) => { clearTimeout(zeit); zeit = setTimeout(() => { zustand.q = e.target.value.trim(); zustand.seite = 1; laden(); }, 250); });
    ziel.querySelector('[data-alle]').addEventListener('change', (e) => { zustand.alle = e.target.checked; merken('kuenstler_alle', zustand.alle ? '1' : '0'); zustand.seite = 1; laden(); });
    ziel.querySelector('[data-typ]').addEventListener('change', (e) => { zustand.typ = e.target.value; merken('kuenstler_typ', zustand.typ); zustand.seite = 1; laden(); });
    ziel.querySelector('[data-sort]').addEventListener('change', (e) => {
      zustand.sort = e.target.value;
      merken('kuenstler_sort', zustand.sort);
      zustand.saat = Math.floor(Math.random() * 1e6) + 1;
      zustand.seite = 1;
      laden();
    });
    ziel.querySelector('[data-buchstaben]').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-b]');
      if (!b) return;
      zustand.buchstabe = zustand.buchstabe === b.dataset.b ? '' : b.dataset.b;
      ziel.querySelectorAll('[data-b]').forEach((x) => x.classList.toggle('an', x.dataset.b === zustand.buchstabe));
      zustand.seite = 1;
      laden();
    });
    ziel.querySelector('[data-mehr]').addEventListener('click', (e) => { if (e.target.closest('[data-mehr-laden]')) { zustand.seite++; laden(true); } });
    const bis = wiederherstellen && zustand.sort !== 'zufall' ? app.listenSeiten.get(location.pathname + location.search) || 1 : 1;
    await laden();
    for (let s2 = 2; s2 <= bis && !signal.aborted; s2++) { zustand.seite = s2; await laden(true); }
  },

  async kuenstler({ app, ziel, param, signal }) {
    const id = Number(param[0]);
    const k = await api.get(`/kuenstler/${id}`, { signal });
    const admin = app.ich.user.rolle === 'admin';
    const reiter = [];
    if (k.alben.length) reiter.push({ id: 'alben', titel: k.typ === 'person' || !k.typ ? t('Als Künstler') : t('Alben'), alben: k.alben, ohneKuenstler: true });
    k.rollen.forEach((r) => reiter.push({ id: r.gruppe, titel: r.titel, alben: r.alben }));
    if (k.gast.length) reiter.push({ id: 'gast', titel: t('Gastauftritte'), alben: k.gast });
    const lebensdaten = (b, e) => [b ? datum(b) : '', e ? datum(e) : ''];
    const [b, e] = lebensdaten(k.beginn, k.ende);
    const ueber = [KUENSTLER_TYP[k.typ] || '', land(k.land), b || e ? (k.typ === 'person' ? `${b ? `* ${b}` : ''}${e ? `  † ${e}` : ''}` : `${b || '?'} – ${e || t('heute{z}', { z: '' })}`) : ''].filter(Boolean).join(' · ');
    const zeitraum = (x) => (x.beginn || x.ende ? ` · ${(x.beginn || '?').slice(0, 4)}–${x.ende ? x.ende.slice(0, 4) : t('heute{z}', { z: '' })}` : '');
    const seite = [];
    if (k.mitglieder.length) {
      seite.push(`<div class="glass-panel" style="padding:20px"><h3 style="font-size:1.05rem;margin-bottom:8px">${t('Besetzung')}</h3><div class="partner">${k.mitglieder.map((m) => `<a href="/kuenstler/${m.id}" data-link><span class="mini-avatar">${h(initialen(m.name))}</span><span>${h(m.name)}<small>${h((m.instrumente || '') + zeitraum(m))}</small></span></a>`).join('')}</div></div>`);
    }
    if (k.bands.length) {
      seite.push(`<div class="glass-panel" style="padding:20px"><h3 style="font-size:1.05rem;margin-bottom:8px">${t('Mitglied in')}</h3><div class="partner">${k.bands.map((m) => `<a href="/kuenstler/${m.id}" data-link><span class="mini-avatar">${h(initialen(m.name))}</span><span>${h(m.name)}<small>${h(zeitraum(m).replace(/^ · /, ''))}</small></span></a>`).join('')}</div></div>`);
    }
    if (k.partner.length) {
      seite.push(`<div class="glass-panel" style="padding:20px"><h3 style="font-size:1.05rem;margin-bottom:8px">${t('Arbeitet oft zusammen mit')}</h3><div class="partner">${k.partner.map((p) => `<a href="/kuenstler/${p.id}" data-link><span class="mini-avatar">${p.bild ? `<img src="${h(p.bild)}" alt="">` : h(initialen(p.name))}</span><span>${h(p.name)}<small>${tn(p.alben, '1 gemeinsames Album', '{n} gemeinsame Alben')}</small></span></a>`).join('')}</div></div>`);
    }
    if (k.aliase.length) {
      seite.push(`<div class="glass-panel" style="padding:20px"><h3 style="font-size:1.05rem;margin-bottom:8px">${t('Auch bekannt als')}</h3><p style="margin:0;color:var(--text-muted)">${k.aliase.slice(0, 12).map(h).join(' · ')}</p></div>`);
    }
    ziel.innerHTML = `
      <div class="kuenstler-kopf">
        <div class="kuenstler-bild">${k.bild ? `<img src="${h(k.bild)}" alt="">` : h(initialen(k.name))}</div>
        <div class="kuenstler-info">
          ${ueber ? `<div class="ueberzeile">${h(ueber)}</div>` : ''}
          <h1>${h(k.name)}</h1>
          ${k.unterscheidung ? `<div class="hinweis">${h(k.unterscheidung)}</div>` : ''}
          <div class="pillen genre-badges" data-genres></div>
          ${k.bio ? `<div class="beschreibung" style="max-height:9.5em;overflow:hidden" data-bio>${h(k.bio)}</div><div><button type="button" class="pille" data-bio-mehr>${t('Weiterlesen')}</button>
            ${k.bio_quelle && k.bio_quelle !== 'manuell' ? `<span class="beschreibung-quelle" style="margin-left:10px">${t('Quelle:')} ${/^https?:/.test(k.bio_quelle) ? `<a href="${h(k.bio_quelle)}" target="_blank" rel="noopener">${h(k.bio_quelle.replace(/^https?:\/\//, '').split('/')[0])}</a>` : h(k.bio_quelle)}${k.bio_maschinell ? ` · ${t('maschinell übersetzt')}` : ''}</span>` : ''}</div>` : ''}
          <div class="aktionen">
            <button type="button" class="btn btn-zweit" data-kuenstler-radio>${icon('radio', 18)}<span>${t('Radio')}</span></button>
            <button type="button" class="btn btn-zweit${k.favorit ? ' an' : ''}" data-aktion="fav" data-art="kuenstler" data-id="${id}" data-text="1" aria-pressed="${k.favorit}">${icon(k.favorit ? 'herzVoll' : 'herz', 20)}<span>${k.favorit ? t('Gemerkt') : t('Merken')}</span></button>
            ${admin ? `<button type="button" class="btn btn-zweit" data-bearbeiten>${icon('bearbeiten', 18)}<span>${t('Bearbeiten')}</span></button>` : ''}
          </div>
        </div>
      </div>
      <div class="album-spalten">
        <div class="album-tracks">
          <section class="beliebt" data-beliebt hidden></section>
          ${reiter.length ? `<div class="reiter" role="tablist">${reiter.map((r, i) => `<button type="button" class="pille${i === 0 ? ' an' : ''}" role="tab" data-reiter="${r.id}" aria-selected="${i === 0}">${h(r.titel)} <small>${r.alben.length}</small></button>`).join('')}</div>
            <div data-reiter-inhalt></div>` : leer(t('Noch keine Alben'), t('Von diesem Künstler ist bisher nichts in der Sammlung.'))}
        </div>
        ${seite.length ? `<aside class="album-seite" style="display:flex;flex-direction:column;gap:18px">${seite.join('')}</aside>` : ''}
      </div>`;
    const inhalt = ziel.querySelector('[data-reiter-inhalt]');
    // Eigene Veröffentlichungen nach Art gruppieren: Alben, EPs, Singles, Live, Kompilationen …
    const ARTEN = [['album', t('Alben')], ['ep', t('EPs')], ['single', t('Singles')], ['live', t('Live')], ['compilation', t('Kompilationen')],
      ['soundtrack', t('Soundtracks')], ['remix', t('Remixe & Mixe')], ['sonstiges', t('Sonstiges')]];
    const artVon = (a) => {
      const z = a.zusatz || [];
      if (z.includes('live')) return 'live';
      if (z.includes('soundtrack')) return 'soundtrack';
      if (z.includes('compilation')) return 'compilation';
      if (z.includes('remix') || z.includes('dj-mix') || z.includes('mixtape/street')) return 'remix';
      return ['album', 'ep', 'single'].includes(a.typ) ? a.typ : 'sonstiges';
    };
    const zeigen = (rid) => {
      const r = reiter.find((x) => x.id === rid);
      if (!r || !inhalt) return;
      const kachel = (a) => albumKachel(a, { ohneKuenstler: r.ohneKuenstler });
      const gruppen = r.id === 'alben' ? ARTEN.map(([art, titel]) => [titel, r.alben.filter((a) => artVon(a) === art)]).filter(([, l]) => l.length) : [];
      inhalt.innerHTML = gruppen.length
        ? gruppen.map(([titel, l]) => `<section class="art-gruppe"><h3>${h(titel)} <small>${l.length}</small></h3>${raster(l.map(kachel).join(''))}</section>`).join('')
        : raster(r.alben.map(kachel).join(''));
      ziel.querySelectorAll('[data-reiter]').forEach((x) => { x.classList.toggle('an', x.dataset.reiter === rid); x.setAttribute('aria-selected', x.dataset.reiter === rid); });
    };
    if (reiter.length) zeigen(reiter[0].id);
    ziel.querySelector('.reiter')?.addEventListener('click', (ev) => { const b = ev.target.closest('[data-reiter]'); if (b) zeigen(b.dataset.reiter); });
    ziel.querySelector('[data-bio-mehr]')?.addEventListener('click', (ev) => {
      const bio = ziel.querySelector('[data-bio]');
      const zu = bio.style.maxHeight !== 'none';
      bio.style.maxHeight = zu ? 'none' : '9.5em';
      ev.currentTarget.textContent = zu ? t('Weniger') : t('Weiterlesen');
    });
    ziel.querySelector('[data-bearbeiten]')?.addEventListener('click', () => kuenstlerBearbeiten(app, id, () => app.navigieren(`/kuenstler/${id}`, false)));
    ziel.querySelector('[data-kuenstler-radio]')?.addEventListener('click', () => app.player.radioStarten({ art: 'kuenstler', id }));
    beliebtLaden(app, ziel, id, signal);
  },

  async genres({ ziel, signal }) {
    const r = await api.get('/genres', { signal });
    const fam = (r.familien || []).length
      ? `<h3 style="margin:0 0 10px">${t('Familien')}</h3><div class="pillen" style="gap:10px;margin-bottom:22px">${r.familien.map((f) => `<a class="pille" style="font-size:1rem;padding:10px 18px" href="/alben?familie=${f.key}" data-link><b>${h(f.name)}</b> <small style="opacity:.6">${f.alben}</small></a>`).join('')}</div><h3 style="margin:0 0 10px">${t('Einzelne Genres')}</h3>` : '';
    ziel.innerHTML = seitenKopf(t('Genres'), tn(r.genres.length, '1 Genre', '{n} Genres')) + (r.genres.length
      ? `${fam}<div class="pillen" style="gap:10px">${r.genres.map((g) => `<a class="pille" style="font-size:.95rem;padding:9px 16px" href="/alben?genre=${g.id}" data-link>${h(g.name)} <small style="opacity:.6">${g.alben}</small></a>`).join('')}</div>`
      : leer(t('Noch keine Genres'), t('Genres kommen aus den Datei-Tags oder vom MusicBrainz-Abgleich.')));
  },

  async suche({ app, ziel, query, signal }) {
    let q = query.get('q') || '';
    ziel.innerHTML = `<div class="such-gross">${icon('suche', 22)}<input type="search" data-q value="${h(q)}" placeholder="${t('Album, Künstler, Titel, Produzent …')}" aria-label="${t('Suchen')}" autofocus enterkeyhint="search"></div><div data-ergebnis></div>`;
    const feld = ziel.querySelector('[data-q]');
    const box = ziel.querySelector('[data-ergebnis]');
    let ctrl = null;
    const suchen = async () => {
      q = feld.value.trim();
      history.replaceState(history.state || {}, '', '/suche' + (q ? '?q=' + encodeURIComponent(q) : ''));
      if (q.length < 2) { box.innerHTML = leer(t('Wonach suchst du?'), t('Alben, Künstler, Musiker, Produzenten und einzelne Titel.')); return; }
      ctrl?.abort();
      ctrl = new AbortController();
      try {
        const r = await api.get('/suche?q=' + encodeURIComponent(q), { signal: ctrl.signal });
        const key = liste(app, 'suche', r.tracks.map((t) => ({ ...t })));
        let topHtml = '';
        const tp = r.top;
        if (tp) {
          if (tp.art === 'kuenstler') {
            const k2 = liste(app, 'suche-top', tp.tracks.map((x) => ({ ...x })));
            topHtml = `<section class="abschnitt such-top"><div class="abschnitt-kopf"><h2>${t('Bester Treffer')}</h2></div><div class="such-top-karte">
              <a class="such-top-kopf" href="/kuenstler/${tp.kuenstler.id}" data-link><span class="such-top-bild rund">${tp.kuenstler.bild ? `<img src="${h(tp.kuenstler.bild)}" alt="">` : `<span class="platzhalter">${h(initialen(tp.kuenstler.name))}</span>`}</span>
              <span class="such-top-text"><b>${h(tp.kuenstler.name)}</b><small>${t('Künstler{pl}', { pl: '' })}${tp.alben ? ` · ${tn(tp.alben, '1 Album', '{n} Alben')}` : ''}</small></span></a>
              ${tp.tracks.length ? `<div class="such-top-titel">${einfacheTrackliste(tp.tracks, k2)}</div>` : ''}</div></section>`;
          } else if (tp.art === 'track') {
            const k2 = liste(app, 'suche-top', [{ ...tp.track }]);
            topHtml = `<section class="abschnitt such-top"><div class="abschnitt-kopf"><h2>${t('Bester Treffer')}</h2></div><div class="such-top-karte">${einfacheTrackliste([tp.track], k2)}</div></section>`;
          } else {
            topHtml = `<section class="abschnitt such-top"><div class="abschnitt-kopf"><h2>${t('Bester Treffer')}</h2></div>${raster(albumKachel(tp.album))}</section>`;
          }
        }
        const hinweis = r.aehnlich ? `<p class="hinweis">${t('Nichts genau passend – das sind ähnliche Treffer zu „{q}“.', { q: h(q) })}</p>` : '';
        box.innerHTML = (r.alben.length + r.kuenstler.length + r.tracks.length === 0) ? leer(t('Nichts gefunden'), t('Zu „{q}“ gibt es keine Treffer.', { q: h(q) }))
          : hinweis + topHtml + abschnitt(t('Künstler{pl}', { pl: '' }), r.kuenstler.length ? reihe(r.kuenstler.map((k) => kuenstlerKachel(k)).join('')) : '')
          + abschnitt(t('Titel{pl}', { pl: '' }), einfacheTrackliste(r.tracks, key))
          + abschnitt(t('Alben'), r.alben.length ? raster(r.alben.map((a) => albumKachel(a)).join('')) : '');
      } catch (e) { if (e.name !== 'AbortError') box.innerHTML = leer(t('Suche fehlgeschlagen'), h(e.message)); }
    };
    let zeit = null;
    feld.addEventListener('input', () => { clearTimeout(zeit); zeit = setTimeout(suchen, 250); });
    if (signal.aborted) return;
    await suchen();
    feld.focus();
  },

  /** Kurze Vorschlagsliste unter dem Suchfeld im Kopf */
  sucheVorschlag(r) {
    const zeilen = [];
    // Cover mit Play-Knopf beim Überfahren; der Rest der Zeile führt zur Seite
    const cover = (bild, knopf) => `<span class="vorschlag-cover">${bild ? `<img src="${h(bild)}" alt="">` : '<span class="mini"></span>'}${knopf}</span>`;
    const play = (attr, label) => `<button type="button" class="vorschlag-play" ${attr} aria-label="${h(label)}">${icon('play', 14)}</button>`;
    if (r.kuenstler.length) {
      zeilen.push(`<div class="vorschlag-kopf">${t('Künstler{pl}', { pl: '' })}</div>`);
      r.kuenstler.slice(0, 4).forEach((k) => zeilen.push(`<a class="vorschlag-zeile" href="/kuenstler/${k.id}" data-link>${k.bild ? `<img class="rund" src="${h(k.bild)}" alt="">` : `<span class="mini rund" style="display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--accent-text)">${h(initialen(k.name))}</span>`}<span>${h(k.name)}</span></a>`));
    }
    if (r.tracks.length) {
      zeilen.push(`<div class="vorschlag-kopf">${t('Titel{pl}', { pl: '' })}</div>`);
      r.tracks.slice(0, 6).forEach((tk, i) => zeilen.push(`<div class="vorschlag-zeile">${tk.verfuegbar === false ? cover(tk.album.cover, '') : cover(tk.album.cover, play(`data-aktion="track-play" data-liste="vorschlag" data-i="${i}"`, t('{titel} abspielen', { titel: tk.titel })))}
        <a class="vorschlag-link" href="/alben/${tk.album.id}" data-link>${h(tk.titel)}<small>${h(kuenstlerText(tk.kuenstler))} · ${h(tk.album.titel)}</small></a></div>`));
    }
    if (r.alben.length) {
      zeilen.push(`<div class="vorschlag-kopf">${t('Alben')}</div>`);
      r.alben.slice(0, 3).forEach((a) => zeilen.push(`<div class="vorschlag-zeile">${cover(a.cover, play(`data-aktion="album-play" data-id="${a.id}" ${a.einzeln ? `data-edition="${a.edition_id}"` : ''}`, t('{titel} abspielen', { titel: a.titel })))}
        <a class="vorschlag-link" href="/alben/${a.id}${a.einzeln ? `?edition=${a.edition_id}` : ''}" data-link>${h(a.titel)}${a.version ? ` <span class="kachel-version">${h(a.version)}</span>` : ''}<small>${h(kuenstlerText(a.kuenstler))}${a.jahr ? ` · ${a.jahr}` : ''}</small></a></div>`));
    }
    return zeilen.join('');
  },

  async playlists({ app, ziel, signal }) {
    const r = await api.get('/playlists', { signal });
    const kachel = (p) => `<a class="kachel" href="/playlists/${p.id}" data-link>
      <span class="kachel-bild">${p.cover.length >= 4 ? `<span style="display:grid;grid-template-columns:1fr 1fr;width:100%;height:100%">${p.cover.slice(0, 4).map((c) => `<img src="${h(c)}" alt="" loading="lazy">`).join('')}</span>`
        : p.cover.length ? `<img src="${h(p.cover[0])}" alt="" loading="lazy">` : `<span class="platzhalter">${h(p.name)}</span>`}</span>
      <span class="kachel-text"><span class="kachel-titel" style="display:block">${h(p.name)}</span><span class="kachel-unter" style="display:block">${tn(p.anzahl, '1 Titel', '{n} Titel')}${p.familie ? ` · ${t('Familie')}${p.eigene ? '' : ` · ${t('von {name}', { name: h(p.besitzer) })}`}` : ''}</span></span></a>`;
    const eigene = r.playlists.filter((p) => p.eigene);
    const familie = r.playlists.filter((p) => !p.eigene);
    ziel.innerHTML = seitenKopf(t('Playlists'), '', '<button type="button" class="btn" data-neu>' + icon('plus', 18) + '<span>' + t('Neue Playlist') + '</span></button>')
      + (r.playlists.length ? abschnitt(t('Meine Playlists'), eigene.length ? raster(eigene.map(kachel).join('')) : `<p class="hinweis">${t('Noch keine eigenen Playlists.')}</p>`)
        + abschnitt(t('Von der Familie'), familie.length ? raster(familie.map(kachel).join('')) : '')
        : leer(t('Noch keine Playlists'), t('Über das Menü ⋯ an jedem Titel oder Album fügst du Musik zu einer Playlist hinzu.')));
    ziel.querySelector('[data-neu]').addEventListener('click', async () => {
      const d = await dialog({ titel: t('Neue Playlist'), inhalt: `<label>${t('Name')}</label><input type="text" name="name" required maxlength="200">
        <label class="checkbox-zeile" style="margin-top:14px"><input type="checkbox" name="familie" value="1"> ${t('Mit der Familie teilen')}</label>`,
        knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Anlegen'), wert: 'ok' }] });
      if (!d) return;
      const p = await versuche(() => api.post('/playlists', { name: d.form.get('name'), familie: d.form.get('familie') === '1' }));
      if (p) app.navigieren(`/playlists/${p.id}`);
    });
  },

  async playlist({ app, ziel, param, signal }) {
    const id = Number(param[0]);
    const p = await api.get(`/playlists/${id}`, { signal });
    const key = liste(app, `p${id}`, p.eintraege);
    const darf = p.eigene || (app.ich.user.rolle === 'admin' && p.familie);
    ziel.innerHTML = `
      <div class="album-kopf">
        <div class="album-cover">${p.cover.length >= 4 ? `<span style="display:grid;grid-template-columns:1fr 1fr;width:100%;height:100%">${p.cover.slice(0, 4).map((c) => `<img src="${h(c.replace('g=300', 'g=600'))}" alt="">`).join('')}</span>` : p.cover.length ? `<img src="${h(p.cover[0].replace('g=300', 'g=600'))}" alt="">` : `<span class="platzhalter">${h(p.name)}</span>`}</div>
        <div class="album-info">
          <div class="ueberzeile">${t('Playlist')}${p.familie ? ` · ${t('Familie')}` : ''}</div>
          <h1>${h(p.name)}</h1>
          ${p.beschreibung ? `<div class="beschreibung">${h(p.beschreibung)}</div>` : ''}
          <div class="fakten"><span>${tn(p.anzahl, '1 Titel', '{n} Titel')} · ${dauerText(p.laenge_ms)}</span>${!p.eigene ? `<span>${t('von {name}', { name: h(p.besitzer) })}</span>` : ''}<span>${t('geändert {datum}', { datum: datum(p.aktualisiert) })}</span></div>
          <div class="aktionen">
            <button type="button" class="btn" data-aktion="liste-play" data-liste="${key}" ${p.eintraege.length ? '' : 'disabled'}>${icon('play', 20)}<span>${t('Abspielen')}</span></button>
            <button type="button" class="btn btn-zweit" data-aktion="liste-zufall" data-liste="${key}" ${p.eintraege.length ? '' : 'disabled'}>${icon('zufall', 18)}<span>${t('Zufall')}</span></button>
            ${p.eintraege.length ? offlineKnopf('playlist', id) : ''}
            ${p.eigene || app.ich.app?.downloads ? `<button type="button" class="btn btn-zweit btn-rund" data-pl-menue data-menue-anker aria-label="${t('Mehr zur Playlist')}">${icon('mehr', 20)}</button>` : ''}
          </div>
        </div>
      </div>
      ${p.eintraege.length ? einfacheTrackliste(p.eintraege, key, { entfernen: darf ? 'pl-entfernen' : null }) : leer(t('Die Playlist ist noch leer'), t('Über das Menü ⋯ an Titeln und Alben fügst du Musik hinzu.'))}`;
    ziel.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-aktion="pl-entfernen"]');
      if (!b) return;
      const eintrag = p.eintraege[Number(b.dataset.i)];
      if (eintrag && await versuche(() => api.del(`/playlists/${id}/eintraege/${eintrag.eintrag_id}`))) app.navigieren(`/playlists/${id}`, false);
    });
    ziel.querySelector('[data-pl-menue]')?.addEventListener('click', (e) => menue(e.currentTarget, [
      ...(app.ich.app?.downloads && p.eintraege.length ? [{ text: t('Als WAV exportieren (z. B. fürs Mischpult) …'), icon: 'download',
        aktion: () => exportDialog(app, { art: 'playlist', id, name: p.name, anzahl: p.anzahl, laenge_ms: p.laenge_ms }) }] : []),
      ...(p.eigene ? [{ text: t('Umbenennen / beschreiben'), icon: 'bearbeiten', aktion: async () => {
        const d = await dialog({ titel: t('Playlist bearbeiten'), inhalt: `<label>${t('Name')}</label><input type="text" name="name" value="${h(p.name)}" required maxlength="200">
          <label>${t('Beschreibung')}</label><textarea name="beschreibung" rows="3">${h(p.beschreibung || '')}</textarea>
          <label class="checkbox-zeile" style="margin-top:14px"><input type="checkbox" name="familie" value="1" ${p.familie ? 'checked' : ''}> ${t('Mit der Familie teilen')}</label>`,
          knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Speichern'), wert: 'ok' }] });
        if (d && await versuche(() => api.put(`/playlists/${id}`, { name: d.form.get('name'), beschreibung: d.form.get('beschreibung'), familie: d.form.get('familie') === '1' }), t('Gespeichert'))) app.navigieren(`/playlists/${id}`, false);
      } },
      { text: t('Playlist löschen'), icon: 'muell', rot: true, aktion: async () => {
        if (await bestaetigen(t('Playlist löschen?'), t('„{name}“ wird gelöscht. Die Musik selbst bleibt natürlich erhalten.', { name: p.name }), t('Löschen'), true)
          && await versuche(() => api.del(`/playlists/${id}`), t('Playlist gelöscht'))) app.navigieren('/playlists');
      } }] : []),
    ]));
  },

  async favoriten({ app, ziel, signal }) {
    const r = await api.get('/favoriten', { signal });
    const key = liste(app, 'fav', r.tracks);
    ziel.innerHTML = seitenKopf(t('Gemerkt'), t('Deine Lieblingsalben, -künstler und -titel'))
      + ((r.alben.length + r.kuenstler.length + r.tracks.length) === 0 ? leer(t('Noch nichts gemerkt'), t('Tippe bei Alben, Künstlern oder Titeln auf {herz}, um sie hier zu sammeln.', { herz: icon('herz', 16) })) : '')
      + abschnitt(t('Alben'), r.alben.length ? raster(r.alben.map((a) => albumKachel(a, { herz: false })).join('')) : '')
      + abschnitt(t('Künstler{pl}', { pl: '' }), r.kuenstler.length ? reihe(r.kuenstler.map((k) => kuenstlerKachel(k)).join('')) : '')
      + abschnitt(t('Lieblingstitel'), einfacheTrackliste(r.tracks, key), r.tracks.length ? `<button type="button" class="link" data-aktion="liste-play" data-liste="${key}">${t('Alle abspielen')}</button>` : '');
  },

  async verlauf({ app, ziel, signal }) {
    const r = await api.get('/verlauf', { signal });
    const key = liste(app, 'verlauf', r.tracks);
    ziel.innerHTML = seitenKopf(t('Zuletzt gehört')) + (r.tracks.length ? einfacheTrackliste(r.tracks, key, { zusatz: (t) => datumZeit(t.zuletzt) }) : leer(t('Noch nichts gehört'), t('Hier erscheinen die Titel, die du zuletzt gehört hast.')));
  },

  async mehr({ app, ziel }) {
    const admin = app.ich.user.rolle === 'admin';
    const warten = app.ich.admin?.wartende_konten || 0;
    const zeile = (pfad, ico, text, unter = '', badge = 0) => `<a href="${pfad}" data-link class="vorschlag-zeile" style="padding:14px 10px">
      <span class="mini" style="display:flex;align-items:center;justify-content:center;color:var(--accent-text)">${icon(ico, 20)}</span><span style="flex:1">${h(text)}${unter ? `<small>${h(unter)}</small>` : ''}</span>${badge ? `<span class="badge">${badge}</span>` : ''}</a>`;
    const dl = admin && app.ich.admin?.download_reiter;
    ziel.innerHTML = seitenKopf(t('Mehr')) + `<div class="glass-panel" style="padding:10px">
      ${dl ? zeile('/downloads', 'download', t('Downloads'), t('Usenet-Suche und laufende Downloads'), app.ich.admin.downloads_laufen || 0) : ''}
      ${zeile('/playlists', 'playlists', t('Playlists'))}
      ${zeile('/favoriten', 'herz', t('Gemerkt'), t('Alben, Künstler, Lieblingstitel'))}
      ${zeile('/verlauf', 'verlauf', t('Zuletzt gehört'))}
      ${zeile('/genres', 'genres', t('Genres'))}
      ${offlineAn() ? zeile('/offline', 'download', t('Auf diesem Gerät'), t('Offline gespeicherte Musik')) : ''}
      ${zeile('/einstellungen', 'einstellungen', t('Einstellungen'), admin ? t('{name} · Konto, Wiedergabe, Server', { name: app.ich.user.name }) : t('{name} · Konto, Wiedergabe', { name: app.ich.user.name }))}
      ${admin ? zeile('/verwaltung', 'verwaltung', t('Verwaltung'), t('Konten, Bibliothek, Einstellungen'), warten) : ''}
      <button type="button" class="vorschlag-zeile" data-abmelden style="padding:14px 10px;width:100%;border:0;background:transparent;font:inherit;text-align:left">
        <span class="mini" style="display:flex;align-items:center;justify-content:center;color:#ffb0b0">${icon('abmelden', 20)}</span><span>${t('Abmelden')}</span></button>
    </div>
    <p class="hinweis" style="text-align:center;margin-top:20px;font-size:.85rem">${h(app.ich.app.name)} ${h(app.ich.app.version)}</p>`;
    ziel.querySelector('[data-abmelden]').addEventListener('click', () => app.abmelden());
  },
};

/** Lautheit eines Albums (EBU R128) – nur am PC: Werte, Einordnung, Verlauf je Titel und was dieses Gerät daraus macht */
function lautheitPanel(a, pl) {
  const l = a.edition.lautheit;
  if (!l) return '';
  const k = (x, n = 1) => (x == null ? '–' : x.toLocaleString(locale, { minimumFractionDigits: n, maximumFractionDigits: n, useGrouping: false }).replace('-', '−'));
  const plr = l.plr;
  const einordnung = plr == null ? '' : plr >= 14 ? t('viel Dynamik') : plr >= 10 ? t('gesunde Dynamik') : plr >= 7 ? t('laut gemastert') : t('stark komprimiert');
  const warnungen = [];
  if (plr != null && plr < 7) warnungen.push(t('Sehr wenig Abstand zwischen Spitzen und Lautheit – typisch für den „Loudness War“.'));
  if (l.true_peak != null && l.true_peak > 0) warnungen.push(t('True-Peak über 0 dBTP ({wert}): zwischen den Samples übersteuert – beim Absenken durch den Angleich unkritisch.', { wert: k(l.true_peak) }));
  let geraet = t('Angleich auf diesem Gerät aus – das Album spielt so laut wie gemastert.');
  if (pl.einst.lautheit !== 'aus') {
    const ziel = Number(pl.einst.lautheit_ziel) || -16;
    let g = ziel - l.lufs;
    let grenze = '';
    if (g > 0) {
      const raum = l.true_peak == null ? 0 : Math.max(0, pl.lhDecke - l.true_peak);
      if (g > raum) { g = raum; grenze = ` (${t('Anheben durch den True-Peak begrenzt')})`; }
    }
    geraet = t('Als Album gespielt: <b>{gain} dB</b> auf alle Titel (Ziel {ziel} LUFS){grenze}.', { gain: `${g > 0 ? '+' : ''}${k(g)}`, ziel: k(ziel, 0), grenze });
  }
  // Feste Skala, damit Alben untereinander vergleichbar sind
  const MIN = -32, MAX = -4;
  const pos = (x) => Math.max(0, Math.min(100, ((x - MIN) / (MAX - MIN)) * 100));
  const hoehe = (x) => Math.max(3, pos(x)); // sehr leise Titel (unter −32) als kleiner Stummel sichtbar lassen
  const mitWert = a.tracks.some((t) => t.lautheit);
  const balken = a.tracks.length > 1 && mitWert ? `<div class="lh-diagramm">
      <div class="lh-achse"><span>−4</span><span>−18</span><span>−32</span></div>
      <div class="lh-verlauf" aria-label="${t('Lautheit je Titel')}">
        ${[-10, -18, -26].map((x) => `<i class="lh-raster" style="bottom:${pos(x)}%"></i>`).join('')}
        ${a.tracks.map((t, i) => (t.lautheit
          ? `<button type="button" data-lh-i="${i}" style="height:${hoehe(t.lautheit.lufs)}%" title="${h(`${t.label} ${t.titel}\n${k(t.lautheit.lufs)} LUFS · LRA ${k(t.lautheit.lra)} LU · TP ${k(t.lautheit.true_peak)} dBTP`)}"></button>`
          : '<span></span>')).join('')}
        <i class="lh-linie" style="bottom:${pos(l.lufs)}%"><b>${t('Album {wert}', { wert: k(l.lufs) })}</b></i>
      </div>
    </div>` : '';
  return `<div class="glass-panel lautheit-panel nur-pc">
    <h2>${t('Lautheit')}</h2>
    <div class="lh-werte">
      <div><b>${k(l.lufs)}</b><small>${t('LUFS integriert')}</small></div>
      <div><b>${k(l.lra)}</b><small>${t('LU Lautheitsumfang')}</small></div>
      <div><b>${k(plr)}</b><small>dB PLR</small>${einordnung ? `<em class="lh-einordnung lh-${plr >= 10 ? 'gut' : plr >= 7 ? 'mittel' : 'schlecht'}">${einordnung}</em>` : ''}</div>
      <div><b>${k(l.true_peak)}</b><small>${t('dBTP True-Peak')}</small></div>
    </div>
    ${balken}
    ${warnungen.map((w) => `<p class="hinweis lh-warnung">${h(w)}</p>`).join('')}
    <p class="hinweis" style="margin:12px 0 0">${geraet}</p>
    <div class="quelle"><i></i>${t('Gemessen nach EBU R128 über alle Titel am Stück')}</div>
  </div>`;
}

/** Diagramm und Titelliste verbinden: Hover hebt beides hervor, Klick auf einen Balken springt zum Titel */
function lautheitVerbinden(ziel) {
  const panel = ziel.querySelector('.lautheit-panel');
  if (!panel) return;
  const zeilen = [...ziel.querySelectorAll('.trackliste .track')];
  const markieren = (i, an) => {
    zeilen[i]?.classList.toggle('lh-markiert', an);
    panel.querySelector(`.lh-verlauf [data-lh-i="${i}"]`)?.classList.toggle('an', an);
  };
  zeilen.forEach((z, i) => {
    z.addEventListener('mouseenter', () => markieren(i, true));
    z.addEventListener('mouseleave', () => markieren(i, false));
  });
  panel.querySelectorAll('.lh-verlauf [data-lh-i]').forEach((b) => {
    const i = Number(b.dataset.lhI);
    b.addEventListener('mouseenter', () => markieren(i, true));
    b.addEventListener('mouseleave', () => markieren(i, false));
    b.addEventListener('click', () => {
      zeilen[i]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      zeilen[i]?.classList.add('lh-blitz');
      setTimeout(() => zeilen[i]?.classList.remove('lh-blitz'), 1200);
    });
  });
}

/**
 * Ist die Seitenspalte (Lautheit, Mitwirkende) viel länger als die Titelliste – typisch ohne Albumbeschreibung –,
 * rücken „Mehr von …“ und die Empfehlungen in die linke Spalte unter die Titel, statt erst unter der Seitenspalte zu beginnen.
 */
function leerraumFuellen(ziel) {
  const links = ziel.querySelector('.album-tracks');
  const seite = ziel.querySelector('.album-seite');
  const verwandt = ziel.querySelector('.album-verwandt');
  if (!links || !seite || !verwandt) return;
  const nebeneinander = () => seite.getBoundingClientRect().top - links.getBoundingClientRect().top < 40;
  const pruefen = () => {
    if (!verwandt.children.length) return;
    const drin = verwandt.parentElement === links;
    if (!nebeneinander()) { if (drin) links.parentElement.after(verwandt); verwandt.classList.remove('in-spalte'); return; }
    const luecke = seite.offsetHeight - (links.offsetHeight - (drin ? verwandt.offsetHeight : 0));
    if (luecke > 160 && !drin) { links.appendChild(verwandt); verwandt.classList.add('in-spalte'); }
    else if (luecke <= 160 && drin) { links.parentElement.after(verwandt); verwandt.classList.remove('in-spalte'); }
  };
  // Reicht das nicht, die Mitwirkenden auf die Höhe der Titelliste kürzen (aufklappbar)
  const credits = seite.querySelector('.credits');
  let aufgeklappt = false;
  const kuerzen = () => {
    if (!credits || aufgeklappt) return;
    credits.style.maxHeight = '';
    credits.classList.remove('gekuerzt');
    if (!nebeneinander()) return;
    const luecke = seite.offsetHeight - links.offsetHeight;
    if (luecke <= 160) return;
    const ziel2 = Math.max(280, credits.offsetHeight - luecke);
    if (credits.offsetHeight - ziel2 < 120) return; // lohnt nicht
    credits.style.maxHeight = `${ziel2}px`;
    credits.classList.add('gekuerzt');
    if (!credits.querySelector('[data-credits-alle]')) {
      credits.insertAdjacentHTML('beforeend', `<button type="button" class="credits-alle" data-credits-alle>${t('Alle Mitwirkenden zeigen')}</button>`);
      credits.querySelector('[data-credits-alle]').addEventListener('click', () => {
        aufgeklappt = true;
        credits.style.maxHeight = '';
        credits.classList.remove('gekuerzt');
      });
    }
  };
  const alles = () => { pruefen(); kuerzen(); };
  requestAnimationFrame(alles);
  // Cover und Texte laden nach – danach und bei Größenänderung noch einmal prüfen
  let wartet = false;
  // Fenster-Listener mit Abbruch: sonst bleibt pro Albumseite einer hängen (samt ganzer Seite im Speicher)
  const ab = new AbortController();
  const beob = new ResizeObserver(() => {
    if (!ziel.contains(seite)) { beob.disconnect(); ab.abort(); return; }
    if (wartet) return;
    wartet = true;
    requestAnimationFrame(() => { wartet = false; alles(); });
  });
  beob.observe(links);
  window.addEventListener('resize', () => { if (!ziel.contains(seite)) { ab.abort(); beob.disconnect(); return; } requestAnimationFrame(alles); }, { passive: true, signal: ab.signal });
}

/** Download starten – zuhause über die Direktadresse (volle LAN-Geschwindigkeit statt Cloudflare-Tunnel), sonst normal */
function herunterladen(pfad) {
  const a = document.createElement('a');
  a.href = netzweg.url(pfad);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
