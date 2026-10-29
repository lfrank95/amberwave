// Gemeinsame Bausteine der Ansichten: Kacheln, Tracklisten, Credits, Beschriftungen.
import { h, icon, dauer, kuenstlerLinks, kuenstlerText, coverHtml, initialen } from './ui.js';
import { t, tn, zahl, locale, sprache } from './i18n.js';

/** Kleines „E“ für explizite Inhalte (Titel: 1 = explizit; Alben: true, sobald ein Titel explizit ist) */
export function eBadge(wert) {
  return wert === 1 || wert === true ? `<span class="e-badge" title="${t('Explizit')}" aria-label="${t('Explizit')}">E</span>` : '';
}

export const TYP_NAMEN = { album: 'Album', single: 'Single', ep: 'EP', broadcast: t('Sendung'), sonstiges: t('Sonstiges') };
export const ZUSATZ_NAMEN = {
  compilation: t('Kompilation'), soundtrack: 'Soundtrack', live: 'Live', remix: t('Remix-Album'), 'dj-mix': 'DJ-Mix', spokenword: t('Wortbeitrag'),
  audiobook: t('Hörbuch'), demo: 'Demo', interview: 'Interview', 'mixtape/street': 'Mixtape', 'audio drama': t('Hörspiel'), 'field recording': t('Feldaufnahme'),
};
export const KUENSTLER_TYP = { person: 'Person', gruppe: 'Band', orchester: t('Orchester'), chor: t('Chor'), figur: t('Figur'), sonstiges: sprache === 'en' ? 'Artist' : 'Künstler' };

let laenderNamen = null;
/** Ländercode (DE, US, XW) als Name in der Sprache der Oberfläche */
export function land(code) {
  if (!code) return '';
  if (code === 'XW') return t('weltweit');
  if (code === 'XE') return t('Europa');
  try {
    laenderNamen ??= new Intl.DisplayNames([locale], { type: 'region' });
    return laenderNamen.of(code) || code;
  } catch (e) { return code; }
}

/** "Album · Live · 1982" */
export function typZeile(a) {
  const teile = [];
  const zus = (a.zusatz || []).map((z) => ZUSATZ_NAMEN[z] || z);
  if (a.typ && (a.typ !== 'album' || !zus.length)) teile.push(TYP_NAMEN[a.typ] || a.typ);
  teile.push(...zus);
  return teile.join(' · ');
}

/** Album-Kachel. a = API-Albumobjekt */
export function albumKachel(a, opt = {}) {
  const unter = opt.ohneKuenstler ? (a.jahr || typZeile(a)) : `${kuenstlerLinks(a.kuenstler)}${a.jahr ? ` · ${a.jahr}` : ''}`;
  const fortschritt = a.weiter && opt.fortschritt ? `<div class="kachel-fortschritt"><i style="width:${Math.max(4, Math.min(100, opt.fortschritt(a)))}%"></i></div>` : '';
  // Getrennt angezeigte Versionen verlinken direkt auf ihre Edition
  const ziel = `/alben/${a.id}${a.einzeln && a.edition_id ? `?edition=${a.edition_id}` : ''}`;
  return `<div class="kachel" data-album-kachel="${a.id}">
    <div class="kachel-cover">
      <a class="kachel-bild" href="${ziel}" data-link aria-label="${h(a.titel)}"${/^#[0-9a-f]{6}$/.test(a.farbe || '') ? ` style="background:${a.farbe}"` : ''}>${coverHtml(a.cover, a.titel)}${fortschritt}${a.favorit && opt.herz !== false ? `<span class="herz-mini">${icon('herzVoll', 18)}</span>` : ''}</a>
      <button type="button" class="kachel-play" data-aktion="album-play" data-id="${a.id}" ${a.einzeln && a.edition_id ? `data-edition="${a.edition_id}"` : ''} aria-label="${h(a.titel)} abspielen">${icon('play', 22)}</button>
    </div>
    <div class="kachel-text">
      <a class="kachel-titel" href="${ziel}" data-link title="${h(a.titel)}${a.version ? ` – ${h(a.version)}` : ''}" style="color:inherit;display:block">${h(a.titel)}${eBadge(a.explizit)}${a.version ? ` <span class="kachel-version">${h(a.version)}</span>` : ''}</a>
      <div class="kachel-unter">${unter}</div>
      ${a.hinweis ? `<div class="kachel-hinweis" title="${h(a.hinweis)}">${h(a.hinweis)}</div>` : ''}
    </div>
  </div>`;
}

export function kuenstlerKachel(k, unter = '') {
  return `<a class="kachel kuenstler-kachel" href="/kuenstler/${k.id}" data-link>
    <span class="kachel-bild">${k.bild ? `<img src="${h(k.bild)}" alt="" loading="lazy">` : `<span class="platzhalter">${h(initialen(k.name))}</span>`}</span>
    <span class="kachel-text"><span class="kachel-titel" style="display:block">${h(k.name)}</span>${unter ? `<span class="kachel-unter" style="display:block">${h(unter)}</span>` : ''}</span>
  </a>`;
}

export function raster(inhalt) { return `<div class="raster">${inhalt}</div>`; }
export function reihe(inhalt) { return `<div class="reihe">${inhalt}</div>`; }

export function abschnitt(titel, inhalt, link = '') {
  if (!inhalt) return '';
  return `<section class="abschnitt"><div class="abschnitt-kopf"><h2>${titel}</h2>${link}</div>${inhalt}</section>`;
}

export function leer(titel, text = '', mehr = '') {
  return `<div class="leer"><h3>${h(titel)}</h3>${text ? `<p>${text}</p>` : ''}${mehr}</div>`;
}

export function spieltAnzeige() { return '<span class="spielt-anzeige" aria-hidden="true"><i></i><i></i><i></i></span>'; }

/** Format-Marke für einen Track: "FLAC 24/96" */
export function formatText(f) {
  if (!f) return '';
  const name = f.codec === 'alac' ? 'ALAC' : (f.datei || f.codec || '').toUpperCase();
  if (f.bittiefe > 0) return `${name} ${f.bittiefe}/${String(Math.round(f.abtastrate / 100) / 10).replace(/\.0$/, '')}`;
  return f.bitrate ? `${name} ${Math.round(f.bitrate / 1000)} kbit/s` : name;
}

/** Rolle mit Instrumenten: "Gitarre, Bass" oder "Produzent" */
export function rolleText(e) {
  return e.instrumente && e.instrumente.length ? e.instrumente.join(', ') : e.rolle;
}

/**
 * Trackliste eines Albums. tracks = API-Tracks, listeKey = Schlüssel in app.listen.
 * albumKuenstler: Credits des Albums (Track-Künstler wird nur gezeigt, wenn abweichend).
 */
export function albumTrackliste(tracks, listeKey, albumKuenstler, opt = {}) {
  const albumText = kuenstlerText(albumKuenstler);
  let disc = null;
  const mehrereDiscs = new Set(tracks.map((tk) => tk.disc)).size > 1;
  let html = '';
  const mitLufs = opt.lautheit !== false && tracks.some((tk) => tk.lautheit);
  const k = (x, n = 1) => (x == null ? '–' : zahl(x, n).replace('-', '−'));
  tracks.forEach((tk, i) => {
    if (mehrereDiscs && tk.disc !== disc) {
      disc = tk.disc;
      html += `<div class="disc-titel">${icon('alben', 16)}<span>${h(tk.disc_titel ? t('CD {nr} · {titel}', { nr: tk.disc, titel: tk.disc_titel }) : t('CD {nr}', { nr: tk.disc }))}</span></div>`;
    }
    const trackText = kuenstlerText(tk.kuenstler);
    const zeigeKuenstler = trackText !== albumText;
    const gaeste = (tk.credits || []).filter((c) => c.gruppe === 'musiker' && !(albumKuenstler || []).some((k) => k.id === c.kuenstler.id)).slice(0, 2);
    const unterTeile = [];
    if (zeigeKuenstler) unterTeile.push(kuenstlerLinks(tk.kuenstler));
    if (!zeigeKuenstler && gaeste.length && opt.gaesteZeigen !== false) {
      unterTeile.push(gaeste.map((g) => `${h(rolleText(g))}: <a href="/kuenstler/${g.kuenstler.id}" data-link>${h(g.kuenstler.name)}</a>`).join(' · '));
    }
    if (!tk.verfuegbar) unterTeile.push(`<span>${t('Datei fehlt')}</span>`);
    html += `<div class="track${tk.verfuegbar ? '' : ' nicht-da'}" data-track-id="${tk.id}">
      <div class="track-nr"><span>${h(String(tk.nr))}</span>${tk.verfuegbar ? `<button type="button" data-aktion="track-play" data-liste="${listeKey}" data-i="${i}" aria-label="${t('{titel} abspielen', { titel: h(tk.titel) })}">${icon('play', 18)}</button>` : ''}</div>
      <div class="track-haupt">
        <div class="track-titel" ${tk.verfuegbar ? `data-aktion="track-play" data-liste="${listeKey}" data-i="${i}" style="cursor:pointer"` : ''}>${h(tk.titel)}${eBadge(tk.explizit)}</div>
        ${unterTeile.length ? `<div class="track-unter">${unterTeile.join(' · ')}</div>` : ''}
      </div>
      ${mitLufs ? `<div class="track-lufs nur-pc" data-lh-i="${i}" ${tk.lautheit ? `title="${h(t('{lufs} LUFS integriert · LRA {lra} LU · True-Peak {tp} dBTP', { lufs: k(tk.lautheit.lufs), lra: k(tk.lautheit.lra), tp: k(tk.lautheit.true_peak) }))}"` : ''}>${tk.lautheit ? k(tk.lautheit.lufs) : ''}</div>` : ''}
      <div class="track-dauer">${tk.laenge_ms ? dauer(tk.laenge_ms) : ''}</div>
      <div class="track-knoepfe">
        <button type="button" class="btn-ico${tk.favorit ? ' an' : ''}" data-aktion="fav" data-art="track" data-id="${tk.id}" aria-label="${t('Favorit')}" aria-pressed="${tk.favorit ? 'true' : 'false'}">${icon(tk.favorit ? 'herzVoll' : 'herz', 18)}</button>
        <button type="button" class="btn-ico" data-aktion="track-menue" data-liste="${listeKey}" data-i="${i}" data-menue-anker aria-label="${t('Mehr zu {titel}', { titel: h(tk.titel) })}">${icon('mehr', 18)}</button>
      </div>
      ${(tk.credits || []).length ? `<div class="track-mehr" hidden data-track-credits="${tk.id}">${trackCredits(tk.credits)}</div>` : ''}
    </div>`;
  });
  return `<div class="trackliste${mitLufs ? ' mit-lufs' : ''}">${html}</div>`;
}

/** Credits eines Tracks kompakt: "Produzent: A · Gitarre: B, C" */
export function trackCredits(credits) {
  const nach = new Map();
  for (const c of credits) {
    const r = rolleText(c);
    if (!nach.has(r)) nach.set(r, []);
    if (!nach.get(r).some((k) => k.id === c.kuenstler.id)) nach.get(r).push(c.kuenstler);
  }
  return `<div class="track-credits">${[...nach].map(([r, ks]) => `<span><b>${h(r)}:</b> ${ks.map((k) => `<a href="/kuenstler/${k.id}" data-link>${h(k.name)}</a>`).join(', ')}</span>`).join('')}</div>`;
}

/** Einfache Trackliste mit Cover (Playlists, Favoriten, Suche, Verlauf) */
export function einfacheTrackliste(tracks, listeKey, opt = {}) {
  if (!tracks.length) return '';
  return `<div class="trackliste">${tracks.map((tk, i) => `
    <div class="track${tk.verfuegbar === false ? ' nicht-da' : ''}" data-track-id="${tk.id}" style="grid-template-columns: 46px minmax(0,1fr) auto auto">
      <div class="track-nr" style="width:46px;height:46px">
        <span style="width:46px;height:46px;border-radius:8px;overflow:hidden;display:block;background:rgba(255,181,71,.14)">${tk.album?.cover ? `<img src="${h(tk.album.cover)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover">` : ''}</span>
        ${tk.verfuegbar !== false ? `<button type="button" data-aktion="track-play" data-liste="${listeKey}" data-i="${i}" aria-label="${t('{titel} abspielen', { titel: h(tk.titel) })}" style="background:rgba(0,0,0,.45)">${icon('play', 18)}</button>` : ''}
      </div>
      <div class="track-haupt">
        <div class="track-titel" ${tk.verfuegbar !== false ? `data-aktion="track-play" data-liste="${listeKey}" data-i="${i}" style="cursor:pointer"` : ''}>${h(tk.titel)}${eBadge(tk.explizit)}</div>
        <div class="track-unter">${kuenstlerLinks(tk.kuenstler)}${tk.album ? ` · <a href="/alben/${tk.album.id}" data-link>${h(tk.album.titel)}</a>` : ''}${opt.zusatz ? ` · ${h(opt.zusatz(tk))}` : ''}</div>
      </div>
      <div class="track-dauer">${tk.laenge_ms ? dauer(tk.laenge_ms) : ''}</div>
      <div class="track-knoepfe">
        ${opt.entfernen ? `<button type="button" class="btn-ico" data-aktion="${opt.entfernen}" data-i="${i}" aria-label="${t('Aus der Playlist entfernen')}">${icon('zu', 18)}</button>` : ''}
        <button type="button" class="btn-ico${tk.favorit ? ' an' : ''}" data-aktion="fav" data-art="track" data-id="${tk.id}" aria-label="${t('Favorit')}" aria-pressed="${tk.favorit ? 'true' : 'false'}">${icon(tk.favorit ? 'herzVoll' : 'herz', 18)}</button>
        <button type="button" class="btn-ico" data-aktion="track-menue" data-liste="${listeKey}" data-i="${i}" data-menue-anker aria-label="${t('Mehr')}">${icon('mehr', 18)}</button>
      </div>
    </div>`).join('')}</div>`;
}

/** Mitwirkende-Panel eines Albums */
export function creditsPanel(gruppen, quelle) {
  if (!gruppen || !gruppen.length) return '';
  const zeile = (e) => {
    const tr = e.tracks && e.tracks.length ? ` · ${e.tracks.length > 6 ? tn(e.tracks.length, 'ein Titel', '{n} Titel') : t('Titel {liste}', { liste: e.tracks.join(', ') })}` : '';
    return `<div class="credit"><a href="/kuenstler/${e.kuenstler.id}" data-link>${h(e.kuenstler.name)}</a><span class="rolle">${h(rolleText(e))}${e.gast ? ` (${t('Gast')})` : ''}${h(tr)}</span></div>`;
  };
  const html = gruppen.map((g) => {
    const max = g.gruppe === 'musiker' ? 8 : 12;
    const sichtbar = g.eintraege.slice(0, max).map(zeile).join('');
    const rest = g.eintraege.slice(max);
    return `<div class="credit-gruppe"><h4>${h(g.titel)}</h4>${sichtbar}${rest.length ? `<div hidden data-mehr-inhalt>${rest.map(zeile).join('')}</div>
      <button type="button" class="pille" data-aktion="mehr-zeigen" style="margin-top:6px">${t('+ {n} weitere anzeigen', { n: rest.length })}</button>` : ''}</div>`;
  }).join('');
  return `<div class="glass-panel credits"><h2>${t('Mitwirkende')}</h2>${html}${quelle ? `<div class="quelle"><i></i>${h(quelle)}</div>` : ''}</div>`;
}

/** Verlustfreie Titel, die noch nicht FLAC sind (WAV/AIFF mit PCM, ALAC) – Zahl für „in FLAC umwandeln“ */
export function flacKandidaten(tracks) {
  return (tracks || []).filter((t) => t.format && ((['wav', 'aif', 'aiff'].includes(t.format.datei) && /^pcm_[su]\d/.test(t.format.codec || '')) || t.format.codec === 'alac')).length;
}
