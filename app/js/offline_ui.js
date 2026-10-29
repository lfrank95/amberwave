// Offline – Oberfläche: Knopf „Offline speichern“ an Alben und Playlists, Einträge in den Menüs, Markierung gespeicherter
// Titel in Listen und die Seite „Auf diesem Gerät“ (auch die Startseite, wenn die App ohne Netz startet).
import { h, icon, toast, bestaetigen, menue } from './ui.js';
import { offline, EINZELN, offlineQualitaet } from './offline.js';
import { nativ } from './nativ.js';
import { t, tn, zahl } from './i18n.js';

/** Offline überhaupt anbieten? (nicht im Windows-Client: der spielt immer vom Server/Heimnetz) */
export const offlineAn = () => !nativ && offline.moeglich && offlineErlaubt;
let offlineErlaubt = true;

const mb = (b) => (b >= 1e9 ? `${zahl(b / 1e9, 1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
/** Titel einer gespeicherten Sammlung (der Sammelname „Einzelne Titel“ steht fest auf Deutsch im Speicher) */
const sammlungTitel = (s) => (s?.key === EINZELN ? t('Einzelne Titel') : s?.titel);

/** Runder Knopf für die Aktionen von Album/Playlist */
export function offlineKnopf(art, id) {
  if (!offlineAn()) return '';
  const key = `${art}:${id}`;
  const st = offline.stand(key);
  const an = st.gespeichert && !st.fehler && st.fertig >= st.gesamt;
  return `<button type="button" class="btn btn-zweit btn-rund offline-knopf${an ? ' an' : ''}${st.laeuft ? ' laeuft' : ''}" data-offline="${key}" data-menue-anker title="${h(knopfTitel(key))}" aria-label="${h(knopfTitel(key))}">${knopfInhalt(key)}</button>`;
}

function knopfInhalt(key) {
  const s = offline.stand(key);
  if (!s.gespeichert) return icon('download', 20);
  if (s.fehler) return icon('warnung', 20);
  if (s.fertig >= s.gesamt) return icon('haken', 20);
  return `<span class="offline-ring" style="--anteil:${Math.round(((s.fertig + (offline.titelAnteil?.anteil || 0)) / Math.max(1, s.gesamt)) * 100)}%"></span>${icon('download', 16)}`;
}

function knopfTitel(key) {
  const s = offline.stand(key);
  if (!s.gespeichert) return t('Offline speichern – auf diesem Gerät, ohne Netz abspielbar');
  if (s.fehler) return t('Nicht alles gespeichert: {fehler}', { fehler: s.fehler });
  if (s.fertig >= s.gesamt) return tn(s.gesamt, 'Auf diesem Gerät gespeichert (ein Titel)', 'Auf diesem Gerät gespeichert ({n} Titel)');
  return t('Wird gespeichert … {fertig} von {gesamt} Titeln', { fertig: s.fertig, gesamt: s.gesamt });
}

/** Alle sichtbaren Knöpfe und Markierungen auf den neuesten Stand bringen */
export function offlineAktualisieren(wurzel = document) {
  wurzel.querySelectorAll('[data-offline]').forEach((b) => {
    const key = b.dataset.offline;
    const s = offline.stand(key);
    b.innerHTML = knopfInhalt(key);
    b.title = knopfTitel(key);
    b.setAttribute('aria-label', b.title);
    b.classList.toggle('an', !!s.gespeichert && !s.fehler && s.fertig >= s.gesamt);
    b.classList.toggle('laeuft', !!s.laeuft);
  });
  offlineMarkieren(wurzel);
}

/** Gespeicherte Titel in Listen kennzeichnen (kleiner Haken hinter dem Titel) */
export function offlineMarkieren(wurzel = document) {
  if (!offlineAn()) return;
  wurzel.querySelectorAll('[data-track-id]').forEach((z) => z.classList.toggle('offline-da', offline.hat(z.dataset.trackId)));
}

async function speichern(app, art, id, daten = null) {
  try {
    const s = await offline.speichern(art, id, daten);
    toast(art === 'titel' ? t('„{name}“ wird auf diesem Gerät gespeichert', { name: daten?.[0]?.titel || t('Titel') }) : tn(s.ids.length, '„{name}“ wird auf diesem Gerät gespeichert (ein Titel)', '„{name}“ wird auf diesem Gerät gespeichert ({n} Titel)', { name: sammlungTitel(s) }));
    if (!localStorage.getItem('aw_offline_hinweis') && /iphone|ipad/i.test(navigator.userAgent) && !matchMedia('(display-mode: standalone)').matches) {
      toast(t('Tipp fürs iPhone: Amberwave zum Home-Bildschirm hinzufügen – sonst kann Safari gespeicherte Musik nach einigen Wochen löschen.'), 'info', 9000);
      try { localStorage.setItem('aw_offline_hinweis', '1'); } catch (e) { /* egal */ }
    }
  } catch (e) { toast(e.message, 'fehler'); }
}

async function entfernen(key, name) {
  const s = offline.sammlungen.get(key);
  if (!s) return;
  if (!await bestaetigen(t('Vom Gerät entfernen?'), t('„{name}“ wird von diesem Gerät gelöscht. In der Bibliothek bleibt natürlich alles.', { name: name || sammlungTitel(s) }), t('Entfernen'), true)) return;
  await offline.entfernen(key);
  toast(t('Vom Gerät entfernt'));
}

/** Klick auf einen Offline-Knopf (Album/Playlist) */
function knopfKlick(app, b) {
  const key = b.dataset.offline;
  const [art, id] = key.split(':');
  const s = offline.stand(key);
  if (!s.gespeichert) { speichern(app, art, Number(id)); return; }
  const samm = offline.sammlungen.get(key);
  menue(b, [
    { titel: sammlungTitel(samm) || t('Auf diesem Gerät') },
    ...(s.fehler ? [{ text: t('Erneut versuchen'), icon: 'download', aktion: () => speichern(app, art, Number(id)) }] : []),
    { text: s.fertig >= s.gesamt ? tn(s.gesamt, 'ein Titel gespeichert', '{n} Titel gespeichert') : t('{fertig} von {gesamt} Titeln gespeichert', { fertig: s.fertig, gesamt: s.gesamt }), icon: 'haken', aktion: () => app.navigieren('/offline') },
    { text: t('Vom Gerät entfernen'), icon: 'muell', rot: true, aktion: () => entfernen(key) },
  ]);
}

/** Einträge fürs Titel-Menü */
export function offlineTitelEintraege(app, tt) {
  if (!offlineAn() || tt.verfuegbar === false) return [];
  if (!offline.hat(tt.id) && !offline.titel.has(tt.id)) return [{ text: t('Offline speichern'), icon: 'download', aktion: () => speichern(app, 'titel', 0, [tt]) }];
  const d = offline.titel.get(tt.id);
  if (d?.in.includes(EINZELN)) return [{ text: t('Vom Gerät entfernen'), icon: 'muell', aktion: async () => { await offline.titelEntfernen(tt.id); toast(t('Vom Gerät entfernt')); } }];
  const s = d && offline.sammlungen.get(d.in[0]);
  return [{ text: offline.hat(tt.id) ? t('Auf diesem Gerät') + (s ? ` (${sammlungTitel(s)})` : '') : t('Wird gespeichert …'), icon: 'haken', aktion: () => app.navigieren('/offline') }];
}

/** Einträge fürs Album-Menü */
export function offlineAlbumEintraege(app, a) {
  if (!offlineAn()) return [];
  const key = `album:${a.id}`;
  return offline.hatSammlung(key)
    ? [{ text: t('Vom Gerät entfernen'), icon: 'muell', aktion: () => entfernen(key, a.titel) }]
    : [{ text: t('Offline speichern'), icon: 'download', aktion: () => speichern(app, 'album', a.id) }];
}

/** Einmal beim Start: Klicks, Auffrischen bei Änderungen, Abgleich mit dem Server */
export function offlineEinrichten(app) {
  // Vom Server abgeschaltet (OFFLINE_QUALITAET=0)? Schon Gespeichertes bleibt abspielbar, Neues gibt es nicht
  if (app.ich?.app && 'offline' in app.ich.app) {
    offlineQualitaet(app.ich.app.offline);
    offlineErlaubt = !!app.ich.app.offline;
    // was schon gespeichert ist, weiß der Speicher erst nach dem Laden – dann noch einmal entscheiden
    if (!offlineErlaubt) offline.bereit.then(() => { if (offline.sammlungen.size > 0 && !offlineErlaubt) { offlineErlaubt = true; offlineVerdrahten(app); } }).catch(() => {});
  }
  if (!offlineAn()) return;
  offlineVerdrahten(app);
}

function offlineVerdrahten(app) {
  if (offlineVerdrahten._fertig) return;
  offlineVerdrahten._fertig = true;
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-offline]');
    if (b) { e.preventDefault(); knopfKlick(app, b); }
  });
  let geplant = false;
  const bald = () => { if (geplant) return; geplant = true; requestAnimationFrame(() => { geplant = false; offlineAktualisieren(); if (location.pathname === '/offline' && !app.offline) seiteAuffrischen(app); }); };
  offline.addEventListener('aenderung', bald);
  offline.addEventListener('fortschritt', bald);
  offline.addEventListener('fehler', (e) => toast(e.detail, 'fehler'));
  offline.addEventListener('hinweis', (e) => toast(e.detail));
  offline.bereit.then(() => {
    offlineAktualisieren();
    if (!app.offline) setTimeout(() => { offline.abgleichen(); offline.verlaufNachreichen(); }, 4000);
  });
}

let seiteTimer = null;
function seiteAuffrischen(app) {
  clearTimeout(seiteTimer);
  seiteTimer = setTimeout(() => { if (location.pathname === '/offline' && app.inhalt.querySelector('.offline-seite')) offlineSeite({ app, ziel: app.inhalt }); }, 400);
}

/** Abspielbare Titel einer gespeicherten Sammlung (nur die schon geladenen) */
function sammlungTracks(s) {
  return s.ids.filter((id) => offline.hat(id)).map((id) => offline.track(id)).filter(Boolean);
}

/** Seite „Auf diesem Gerät“ */
export async function offlineSeite({ app, ziel }) {
  await offline.bereit;
  const liste = [...offline.sammlungen.values()].sort((a, b) => (a.key === EINZELN) - (b.key === EINZELN) || b.gespeichert - a.gespeichert);
  let schaetzung = null;
  try { schaetzung = await navigator.storage?.estimate?.(); } catch (e) { /* egal */ }
  let dauerhaft = null;
  try { dauerhaft = await navigator.storage?.persisted?.(); } catch (e) { /* egal */ }
  const belegt = offline.bytes;
  const frei = schaetzung?.quota ? Math.max(0, schaetzung.quota - (schaetzung.usage || 0)) : null;
  const zeile = (s) => {
    const st = offline.stand(s.key);
    const bytes = s.ids.reduce((n, id) => n + (offline.titel.get(id)?.bytes || 0), 0);
    const fertig = st.fertig >= st.gesamt;
    return `<div class="offline-zeile" data-key="${h(s.key)}">
      <a class="offline-cover" ${s.art === 'titel' ? '' : `href="/${s.art === 'album' ? 'alben' : 'playlists'}/${s.id}" data-link`}>${s.cover ? `<img src="${h(s.cover)}" alt="" loading="lazy">` : icon(s.art === 'playlist' ? 'playlists' : 'album', 22)}</a>
      <div class="offline-text"><b>${h(sammlungTitel(s))}</b><small>${h([t(s.unter || ''), fertig ? tn(st.fertig, 'ein Titel', '{n} Titel') : t('{fertig} von {gesamt} Titeln', { fertig: st.fertig, gesamt: st.gesamt }), bytes ? mb(bytes) : ''].filter(Boolean).join(' · '))}</small>
        ${!fertig ? `<span class="offline-balken${st.fehler ? ' fehler' : ''}"><i style="width:${Math.round((st.fertig / Math.max(1, st.gesamt)) * 100)}%"></i></span>${st.fehler ? `<small class="offline-fehler">${h(st.fehler)}</small>` : ''}` : ''}</div>
      <div class="offline-knoepfe">
        <button type="button" class="btn btn-rund" data-off-play="${h(s.key)}" ${st.fertig ? '' : 'disabled'} aria-label="${h(t('{name} abspielen', { name: sammlungTitel(s) }))}">${icon('play', 18)}</button>
        <button type="button" class="btn btn-zweit btn-rund" data-off-weg="${h(s.key)}" aria-label="${h(t('{name} vom Gerät entfernen', { name: sammlungTitel(s) }))}">${icon('muell', 18)}</button>
      </div>
    </div>`;
  };
  ziel.innerHTML = `<div class="offline-seite">
    <div class="seiten-kopf"><div><h1>${t('Auf diesem Gerät')}</h1><div class="unter">${liste.length ? `${tn(liste.length, '{n} Eintrag', '{n} Einträge')} · ${mb(belegt)}${frei != null ? ` · ${t('noch {platz} frei', { platz: mb(frei) })}` : ''}` : t('Für unterwegs, im Auto oder im Flieger')}</div></div></div>
    ${app.offline ? `<div class="offline-band">${icon('warnung', 18)}<span>${t('Kein Netz – du hörst, was auf diesem Gerät gespeichert ist.')}</span><button type="button" class="btn btn-klein btn-zweit" data-off-neu>${t('Neu verbinden')}</button></div>` : ''}
    ${liste.length ? `<div class="glass-panel offline-liste">${liste.map(zeile).join('')}</div>` : `<div class="leer"><h3>${t('Noch nichts gespeichert')}</h3><p>${t('Bei Alben und Playlists auf {symbol} tippen – dann spielt die Musik auch ohne Netz. Gespeichert wird in Opus, bei 256 kbit/s etwa 2 MB pro Minute.', { symbol: icon('download', 16) })}</p></div>`}
    <p class="hinweis offline-fuss">${t('Gespeichert wird im Speicher der App, nicht als Datei. Unterwegs spielt Amberwave gespeicherte Titel immer vom Gerät, das spart Daten. Gespeicherte Alben und Playlists bleiben auf dem Stand der Bibliothek, neue Titel kommen von selbst dazu.')}${dauerhaft === false ? ` ${t('<b>Der Browser darf den Speicher bei Platzmangel leeren</b> – als App installiert ist er geschützt.')}` : ''}</p>
    ${liste.length ? `<p style="text-align:center"><button type="button" class="btn btn-zweit btn-klein btn-rot-text" data-off-alles>${t('Alles vom Gerät entfernen')}</button></p>` : ''}
  </div>`;
  ziel.querySelectorAll('[data-off-play]').forEach((b) => b.addEventListener('click', () => {
    const s = offline.sammlungen.get(b.dataset.offPlay);
    const tracks = s ? sammlungTracks(s) : [];
    if (tracks.length) app.player.abspielen(tracks, 0, s.art === 'album' ? { art: 'album', id: s.id } : { art: 'liste' });
  }));
  ziel.querySelectorAll('[data-off-weg]').forEach((b) => b.addEventListener('click', () => entfernen(b.dataset.offWeg)));
  ziel.querySelector('[data-off-alles]')?.addEventListener('click', async () => {
    if (!await bestaetigen(t('Alles vom Gerät entfernen?'), t('Alle gespeicherten Alben, Playlists und Titel werden von diesem Gerät gelöscht.'), t('Alles entfernen'), true)) return;
    await offline.allesEntfernen();
    toast(t('Alles vom Gerät entfernt'));
  });
  ziel.querySelector('[data-off-neu]')?.addEventListener('click', () => location.reload());
}

/** Gespeichertes Album / gespeicherte Playlist ohne Netz anzeigen */
export async function offlineSammlung({ app, ziel, key }) {
  await offline.bereit;
  const s = offline.sammlungen.get(key);
  if (!s) {
    ziel.innerHTML = `<div class="leer"><h3>${t('Ohne Netz nicht verfügbar')}</h3><p>${t('Das ist nicht auf diesem Gerät gespeichert.')}</p><p><a href="/offline" data-link class="btn">${t('Auf diesem Gerät')}</a></p></div>`;
    return;
  }
  const tracks = sammlungTracks(s);
  app.listen = app.listen || new Map();
  app.listen.set(`off-${key}`, tracks);
  ziel.innerHTML = `<div class="album-kopf">
      <div class="album-cover">${s.cover ? `<img src="${h(s.cover.replace('g=300', 'g=600'))}" alt="">` : `<span class="platzhalter">${h(sammlungTitel(s))}</span>`}</div>
      <div class="album-info"><div class="ueberzeile">${s.art === 'playlist' ? t('Playlist') : t('Album')} · ${t('auf diesem Gerät')}</div><h1>${h(sammlungTitel(s))}</h1>
        <div class="fakten"><span>${h(t(s.unter || ''))}</span><span>${tn(tracks.length, 'ein Titel', '{n} Titel')}</span></div>
        <div class="aktionen"><button type="button" class="btn" data-aktion="liste-play" data-liste="off-${h(key)}" ${tracks.length ? '' : 'disabled'}>${icon('play', 20)}<span>${t('Abspielen')}</span></button>
          <button type="button" class="btn btn-zweit" data-aktion="liste-zufall" data-liste="off-${h(key)}" ${tracks.length ? '' : 'disabled'}>${icon('zufall', 18)}<span>${t('Zufall')}</span></button></div></div>
    </div>
    <div class="glass-panel offline-titel">${tracks.map((tr, i) => `<div class="track offline-da" data-track-id="${tr.id}"><div class="track-nr"><span>${i + 1}</span><button type="button" data-aktion="track-play" data-liste="off-${h(key)}" data-i="${i}" aria-label="${h(t('{name} abspielen', { name: tr.titel }))}"><b>${icon('play', 14)}</b></button></div>
      <div class="track-haupt"><div class="track-titel" data-aktion="track-play" data-liste="off-${h(key)}" data-i="${i}">${h(tr.titel)}</div><div class="track-unter">${h((tr.kuenstler || []).map((k) => k.name).join(', '))}</div></div>
      <div class="track-dauer">${tr.laenge_ms ? `${Math.floor(tr.laenge_ms / 60000)}:${String(Math.round((tr.laenge_ms % 60000) / 1000)).padStart(2, '0')}` : ''}</div></div>`).join('')}</div>`;
}
