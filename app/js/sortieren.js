// Verwaltung → Bibliothek → „Unsortiert“: Sortier-Assistent. Analysiert den Eingangsordner (Fingerabdruck je Datei),
// zeigt den Vorschlag als Albumkarten (mit „passt auch zu …“), Dubletten, schon Vorhandenes und Unerkanntes (mit Handsuche)
// und sortiert erst nach „Übernehmen“ ein. Rechnet alles der Server (includes/sortieren.php).
import { api, versuche } from './api.js';
import { h, icon, dauer, groesse, zahl, bestaetigen, bind } from './ui.js';
import { t, tn } from './i18n.js';

const PHASE_TEXT = {
  analyse: t('Analysiert'), ausfuehren: t('Sortiert ein'), warten_scan: t('Liest die neuen Dateien ein'), verknuepfen: t('Verknüpft mit MusicBrainz'),
};

/** Qualitäts-Plakette wie in der Download-Suche */
function qualitaet(q) {
  if (!q) return '';
  const verlustfrei = /^(FLAC|WAV|AIFF|ALAC|APE|WV|DSF|DFF)/i.test(q);
  const hires = verlustfrei && /\b(24|32)\//.test(q) && !/\/44,1$|\/48$/.test(q) ? true : (verlustfrei && /\/(88|96|176|192)/.test(q));
  return `<span class="dl-q ${hires ? 'hires' : verlustfrei ? 'lossless' : 'lossy'}"><b>${h(q.split(' ')[0])}</b><small>${h(q.split(' ').slice(1).join(' '))}</small></span>`;
}

export function sortierPanel(app, box, signal, sichtbar, zaehler) {
  let stand = null;
  let timer = null;
  let offen = null;             // aufgeklapptes Album (id)
  let detail = null;            // dessen Dateien/Alternativen
  let listen = {};              // rolle → { gesamt, dateien, seite }
  let listeOffen = null;        // 'dublette' | 'bibliothek' | 'unerkannt'
  let suche = {};               // datei-id → { laedt, ergebnis }
  let filterAlben = 'alle';     // alle | unvollstaendig | unsicher | abgewaehlt
  signal?.addEventListener('abort', () => clearTimeout(timer));

  const laeuft = () => ['analyse', 'ausfuehren', 'warten_scan', 'verknuepfen'].includes(stand?.phase);

  const listeLaden = async (rolle, seite = 1) => {
    const r = await versuche(() => api.get(`/admin/sortieren/liste/${rolle}?seite=${seite}`, { signal }));
    if (r) listen[rolle] = r;
    zeichnen();
  };
  const detailLaden = async (id) => {
    detail = null; zeichnen();
    const r = await versuche(() => api.get(`/admin/sortieren/album/${id}`, { signal }));
    if (offen === id) { detail = r; zeichnen(); }
  };
  const neu = async (antwort) => {
    if (antwort && antwort.phase) stand = antwort;
    else stand = await api.get('/admin/sortieren', { signal }).catch(() => stand);
    if (listeOffen) await listeLaden(listeOffen, listen[listeOffen]?.seite || 1);
    if (offen) await detailLaden(offen); else zeichnen();
  };

  // ---------- Bausteine ----------
  const kopfHtml = () => `
    <div class="dl-kopf"><h2 style="font-size:1.15rem;margin:0">${t('Unsortierte Musik importieren')}</h2>
      ${stand?.phase === 'bereit' ? `<button type="button" class="pille" data-srt-neu title="${t('Ordner erneut lesen – schon Erkanntes bleibt erkannt')}">${t('Neu analysieren')}</button>` : ''}</div>
    <p class="hinweis" style="margin:6px 0 14px">${t('Lege unsortierte Dateien in den Ordner <code>{ordner}</code> im Musikordner – beliebig verschachtelt, Namen und Tags egal. Jede Datei wird am Klang erkannt, dann schlägt Amberwave vor, zu welchen Alben sie am besten zusammenpassen. Verschoben wird erst, wenn du den Vorschlag übernimmst.', { ordner: h(stand?.eingang || '_unsortiert') })}</p>`;

  const fortschrittHtml = () => {
    const z = stand.zahlen;
    const fertig = z.erkannt + z.unerkannt + z.fehler;
    const proz = stand.phase === 'analyse' ? Math.round((fertig / Math.max(1, z.gesamt)) * 100) : null;
    return `<div class="srt-lauf">
      <p style="margin:0">${icon('verlauf', 16)} <b>${h(PHASE_TEXT[stand.phase] || '')}</b>${stand.schritt ? ` · ${h(stand.schritt)}` : ''}</p>
      ${proz !== null ? `<div class="fortschritt"><i style="width:${Math.max(3, proz)}%"></i></div>
        <p class="hinweis" style="margin:0">${z.offen
          ? t('{gesamt} Dateien · {erkannt} erkannt · {unerkannt} unerkannt · noch {offen} offen (≈ {min} min)', { gesamt: zahl(z.gesamt), erkannt: zahl(z.erkannt), unerkannt: zahl(z.unerkannt), offen: zahl(z.offen), min: Math.max(1, Math.ceil(z.offen / 150)) })
          : t('{gesamt} Dateien · {erkannt} erkannt · {unerkannt} unerkannt', { gesamt: zahl(z.gesamt), erkannt: zahl(z.erkannt), unerkannt: zahl(z.unerkannt) })}</p>`
        : '<div class="fortschritt unbestimmt"><i></i></div>'}
      ${stand.fehler ? `<p class="srt-fehler">${h(stand.fehler)}</p>` : ''}
    </div>`;
  };

  const albumKarte = (a) => {
    const unsicher = a.sicherheit < 85;
    const zustand = a.status === 'fertig' ? 'gut' : a.status === 'fehler' ? 'schlecht' : '';
    const titelInfo = [a.jahr, a.typ, a.medien > 1 ? t('{n} CDs', { n: a.medien }) : ''].filter(Boolean).join(' · ');
    return `<div class="srt-album ${a.aktiv ? '' : 'aus'} ${offen === a.id ? 'offen' : ''} ${zustand}" data-srt-album="${a.id}">
      <button type="button" class="srt-album-kopf" data-srt-auf="${a.id}" aria-expanded="${offen === a.id}">
        <span class="srt-cover"><img src="/api/v1/admin/mb-cover/${h(a.mbid)}?g=250" alt="" loading="lazy" data-srt-cover="${h(a.rg)}">${icon('album', 26)}</span>
        <span class="srt-album-text"><b>${h(a.titel)}</b><small>${h(a.kuenstler)}</small><small>${h(titelInfo)}</small></span>
        <span class="srt-album-zahl ${a.vollstaendig ? 'voll' : ''}"><b>${a.anzahl}</b><small>${t('von {n}', { n: a.tracks || '?' })}</small></span>
      </button>
      <div class="srt-marken">
        ${a.in_bibliothek && a.status === 'vorschlag' ? `<span class="marke marke-gut">${t('ergänzt dein Album')}</span>` : ''}
        ${a.vollstaendig ? `<span class="marke marke-gut">${t('vollständig')}</span>` : ''}
        ${unsicher ? `<span class="marke marke-warn" title="${t('Erkennungssicherheit {n} %', { n: a.sicherheit })}">${t('unsicher')}</span>` : ''}
        ${a.status === 'fertig' ? `<span class="marke marke-gut">${h(a.meldung || t('einsortiert'))}</span>` : ''}
        ${a.status === 'fehler' ? `<span class="marke marke-schlecht">${h(a.meldung || t('Fehler'))}</span>` : ''}
        ${a.status === 'vorschlag' ? `<label class="srt-schalter" title="${t('Dieses Album übernehmen')}"><input type="checkbox" data-srt-aktiv="${a.id}" ${a.aktiv ? 'checked' : ''} ${stand.phase !== 'bereit' ? 'disabled' : ''}><span>${t('übernehmen')}</span></label>` : ''}
      </div>
      ${offen === a.id ? detailHtml(a) : ''}
    </div>`;
  };

  const dateiZeile = (d, extra = '') => `<div class="srt-datei">
      <span class="srt-pos">${d.position ? `${d.position.disc > 1 ? d.position.disc + '-' : ''}${d.position.pos}` : ''}</span>
      <span class="srt-datei-text"><b>${h(d.titel || d.tag_titel || d.pfad.split('/').pop())}</b><small title="${h(d.pfad)}">${h(d.pfad)}${d.dauer_ms ? ' · ' + dauer(d.dauer_ms) : ''}${d.manuell ? ` · ${t('von Hand zugeordnet')}` : d.sicherheit && d.sicherheit < 85 ? ` · ${t('{n} % sicher', { n: d.sicherheit })}` : ''}</small>${d.meldung ? `<small class="srt-meldung">${h(d.meldung)}</small>` : ''}</span>
      ${qualitaet(d.qualitaet)}${extra}</div>`;

  const detailHtml = (a) => {
    if (!detail || detail.album.id !== a.id) return '<div class="srt-detail"><div class="lade"></div></div>';
    const alt = detail.alternativen || [];
    return `<div class="srt-detail">
      <div class="srt-dateien">${detail.dateien.map((d) => dateiZeile(d)).join('')}</div>
      ${detail.dubletten.length ? `<p class="hinweis" style="margin:10px 0 4px">${t('Weitere Fassungen dieser Titel (Dubletten): {liste}', { liste: detail.dubletten.map((d) => `${h(d.pfad.split('/').pop())} (${h(d.qualitaet)})`).join(', ') })}</p>` : ''}
      ${alt.length && a.status === 'vorschlag' ? `<div class="srt-alt"><span class="hinweis">${t('Passt auch zu:')}</span>
        ${alt.map((r) => `<button type="button" class="pille" data-srt-release="${h(r.mbid)}" ${stand.phase !== 'bereit' ? 'disabled' : ''} title="${h([r.kuenstler, r.land, r.format].filter(Boolean).join(' · '))}">
          ${h(r.titel)}${r.jahr ? ` <small>${r.jahr}</small>` : ''} <small>${h(r.typ)} · ${t('{a} von {b}', { a: r.enthaelt, b: r.tracks || '?' })}</small></button>`).join('')}</div>` : ''}
    </div>`;
  };

  const AKTIONEN = {
    dublette: [['papierkorb', t('In den Papierkorb')], ['liegen', t('Liegen lassen')]],
    bibliothek: [['liegen', t('Liegen lassen')], ['papierkorb', t('In den Papierkorb')], ['ersetzen', t('Ersetzen (bessere Qualität)')]],
    unerkannt: [['liegen', t('Liegen lassen')], ['papierkorb', t('In den Papierkorb')]],
  };
  const aktionWahl = (d, liste) => {
    const optionen = AKTIONEN[liste].filter(([w]) => w !== 'ersetzen' || d.ersetzbar);
    return `<select class="srt-aktion" data-srt-aktion="${d.id}" aria-label="${t('Was mit dieser Datei passiert')}" ${stand.phase !== 'bereit' ? 'disabled' : ''}>
      ${optionen.map(([w, txt]) => `<option value="${w}" ${d.aktion === w ? 'selected' : ''}>${txt}</option>`).join('')}</select>`;
  };

  const listeHtml = (rolle) => {
    const l = listen[rolle];
    if (!l) return '<div class="lade"></div>';
    if (!l.dateien.length) return `<p class="hinweis">${t('Nichts.')}</p>`;
    const zeilen = l.dateien.map((d) => {
      let info = '';
      if (rolle === 'dublette' && d.behalten) {
        const kuerzer = d.behalten.dauer_ms - d.dauer_ms > 3000;
        info = `<small>${t('Behalten wird: {pfad} ({qualitaet}, {dauer})', { pfad: h(d.behalten.pfad), qualitaet: h(d.behalten.qualitaet), dauer: dauer(d.behalten.dauer_ms) })}${kuerzer ? ` · <b class="srt-kurz">${t('diese Datei ist abgeschnitten')}</b>` : ''}</small>`;
      }
      if (rolle === 'bibliothek') info = `<small>${t('In der Bibliothek: {name}', { name: h(d.bibliothek) })}${d.besser ? ` · <b class="srt-besser">${t('diese Datei ist besser')}</b>` : ''}</small>`;
      if (rolle === 'unerkannt') {
        const tags = [d.tag_kuenstler, d.tag_titel, d.tag_album].filter(Boolean).join(' – ');
        info = `<small>${d.rolle === 'ohne_album' ? t('Erkannt als „{kuenstler} – {titel}“, aber auf keinem Album bei MusicBrainz', { kuenstler: h(d.kuenstler), titel: h(d.titel) }) : d.fehler ? h(d.fehler) : tags ? t('Tags: {tags}', { tags: h(tags) }) : t('Keine Tags')}</small>`;
      }
      const s = suche[d.id];
      const sucheHtml = rolle !== 'unerkannt' || stand.phase !== 'bereit' ? '' : `
        <form class="srt-suche" data-srt-suche="${d.id}"><input type="search" placeholder="${t('Künstler – Titel')}" value="${h(s?.q ?? [d.tag_kuenstler, d.tag_titel].filter(Boolean).join(' - '))}" aria-label="${t('Bei MusicBrainz suchen')}">
          <button type="submit" class="pille" ${s?.laedt ? 'disabled' : ''}>${s?.laedt ? t('Sucht …') : t('Suchen')}</button></form>
        ${s?.ergebnis ? (s.ergebnis.treffer.length ? `<div class="srt-treffer">${s.ergebnis.treffer.map((tf) => `<div class="srt-treffer-zeile ${tf.passt_laenge ? '' : 'unpassend'}">
            <span><b>${h(tf.titel)}</b> <small>${h(tf.kuenstler)}${tf.laenge_ms ? ' · ' + dauer(tf.laenge_ms) : ''}${tf.passt_laenge ? '' : ` · ${t('Länge passt nicht')}`}</small>
            <small>${tf.releases.map((r) => `${h(r.titel)}${r.jahr ? ' (' + r.jahr + ')' : ''}${r.typ ? ' · ' + h(r.typ) : ''}`).join(' / ')}${tf.anzahl_releases > tf.releases.length ? ` ${t('und {n} weitere', { n: tf.anzahl_releases - tf.releases.length })}` : ''}</small></span>
            <button type="button" class="pille" data-srt-zuordnen="${d.id}" data-aufnahme="${h(tf.mbid)}">${t('Das ist es')}</button></div>`).join('')}</div>`
          : `<p class="hinweis" style="margin:6px 0 0">${t('Nichts gefunden – anders schreiben (z. B. nur den Titel)?')}</p>`) : ''}`;
      return `<div class="srt-zeile">${dateiZeile(d, aktionWahl(d, rolle))}<div class="srt-zeile-info">${info}${sucheHtml}</div></div>`;
    }).join('');
    const seiten = Math.ceil(l.gesamt / 100);
    return zeilen + (seiten > 1 ? `<div class="srt-seiten">${Array.from({ length: seiten }, (_, i) => `<button type="button" class="pille ${l.seite === i + 1 ? 'an' : ''}" data-srt-seite="${i + 1}">${i + 1}</button>`).join('')}</div>` : '');
  };

  const abschnitt = (rolle, titel, n, bytes, text) => n ? `<details class="srt-abschnitt" data-srt-liste="${rolle}" ${listeOffen === rolle ? 'open' : ''}>
      <summary><b>${titel}</b> <span class="marke">${zahl(n)}</span>${bytes ? ` <small class="hinweis">${groesse(bytes)}</small>` : ''}<small class="hinweis srt-abschnitt-text">${text}</small></summary>
      <div class="srt-liste">${listeOffen === rolle ? listeHtml(rolle) : ''}</div></details>` : '';

  const vorschlagHtml = () => {
    const r = stand.rollen || {};
    const alben = stand.alben || [];
    const zahlAlben = alben.length;
    const voll = alben.filter((a) => a.vollstaendig).length;
    const gefiltert = alben.filter((a) => filterAlben === 'alle' || (filterAlben === 'unvollstaendig' && !a.vollstaendig) || (filterAlben === 'unsicher' && a.sicherheit < 85) || (filterAlben === 'abgewaehlt' && !a.aktiv));
    const ak = stand.aktionen || {};
    const fertigPhase = stand.phase === 'fertig';
    return `
      <div class="srt-zusammen">
        <span>${tn(stand.zahlen.gesamt, '<b>{n}</b> Datei', '<b>{n}</b> Dateien')}</span>
        <span>${tn(zahlAlben, '<b>{n}</b> Album', '<b>{n}</b> Alben')}${voll ? ` <small>(${t('{n} vollständig', { n: voll })})</small>` : ''}</span>
        ${r.dublette ? `<span>${tn(r.dublette.n, '<b>{n}</b> Dublette', '<b>{n}</b> Dubletten')} <small>${groesse(r.dublette.bytes)}</small></span>` : ''}
        ${r.bibliothek ? `<span>${t('<b>{n}</b> schon in der Bibliothek', { n: zahl(r.bibliothek.n) })}</span>` : ''}
        ${(r.unerkannt?.n || 0) + (r.ohne_album?.n || 0) + (r.fehler?.n || 0) ? `<span>${t('<b>{n}</b> unerkannt', { n: zahl((r.unerkannt?.n || 0) + (r.ohne_album?.n || 0) + (r.fehler?.n || 0)) })}</span>` : ''}
      </div>
      ${zahlAlben > 6 ? `<div class="pillen srt-filter" role="group" aria-label="${t('Alben filtern')}">${[['alle', t('Alle')], ['unvollstaendig', t('Unvollständig')], ['unsicher', t('Unsicher')], ['abgewaehlt', t('Abgewählt')]].map(([k, txt]) => `<button type="button" class="pille ${filterAlben === k ? 'an' : ''}" data-srt-filter="${k}">${txt}</button>`).join('')}</div>` : ''}
      <div class="srt-alben">${gefiltert.map(albumKarte).join('') || (zahlAlben ? `<p class="hinweis">${t('Keine Alben in diesem Filter.')}</p>` : '')}</div>
      ${abschnitt('dublette', t('Dubletten'), r.dublette?.n || 0, r.dublette?.bytes || 0, t('gleiche Aufnahme mehrfach – die beste Fassung kommt ins Album'))}
      ${abschnitt('bibliothek', t('Schon in der Bibliothek'), r.bibliothek?.n || 0, 0, t('bessere Fassungen können die vorhandene Datei ersetzen'))}
      ${abschnitt('unerkannt', t('Unerkannt'), (r.unerkannt?.n || 0) + (r.ohne_album?.n || 0) + (r.fehler?.n || 0), 0, t('von Hand bei MusicBrainz suchen – oder liegen lassen'))}
      ${!fertigPhase ? `<div class="srt-fuss">
        <p class="hinweis" style="margin:0">${t('Übernehmen: <b>{alben}</b> Alben mit {dateien} Dateien einsortieren', { alben: zahl(ak.alben || 0), dateien: zahl(ak.album_dateien || 0) })}${ak.papierkorb ? `, ${t('<b>{n}</b> Dateien ({groesse}) in den Papierkorb ({tage} Tage)', { n: zahl(ak.papierkorb), groesse: groesse(ak.papierkorb_bytes), tage: stand.papierkorb_tage })}` : ''}${ak.ersetzen ? `, ${t('<b>{n}</b> Bibliotheksdateien durch bessere ersetzen', { n: zahl(ak.ersetzen) })}` : ''}${ak.liegen ? `; ${t('{n} bleiben liegen', { n: zahl(ak.liegen) })}` : ''}.</p>
        <div class="zeilen-knoepfe"><button type="button" class="btn" data-srt-los ${stand.phase !== 'bereit' || !(ak.album_dateien || ak.papierkorb || ak.ersetzen) ? 'disabled' : ''}>${icon('haken', 18)}<span>${t('Übernehmen')}</span></button>
          <button type="button" class="btn btn-zweit" data-srt-reset ${stand.phase !== 'bereit' ? 'disabled' : ''} title="${t('Eigene Änderungen am Vorschlag verwerfen')}">${t('Vorschlag zurücksetzen')}</button></div></div>` : ''}`;
  };

  const zeichnen = () => {
    if (!box.isConnected || !stand) return;
    const z = stand.zahlen || {};
    if (zaehler) zaehler.textContent = stand.phase === 'bereit' ? (stand.alben?.length || '') : laeuft() ? '…' : '';
    let inhalt = '';
    if (!stand.acoustid) {
      inhalt = `<div class="srt-warnung">${icon('info', 18)} ${t('Für die Erkennung am Klang braucht Amberwave einen kostenlosen AcoustID-Schlüssel – <a href="/einstellungen/dienste" data-link>Einstellungen → Dienste</a>.')}</div>`;
    } else if (stand.phase === 'leer' || stand.phase === 'pause' || (stand.phase === 'fertig' && !(stand.alben || []).length && !Object.keys(stand.erledigt || {}).length)) {
      inhalt = `${stand.fehler ? `<p class="srt-fehler">${h(stand.fehler)}</p>` : ''}
        ${!stand.eingang_da ? `<p class="hinweis">${t('Der Ordner <code>{ordner}</code> wird beim ersten Analysieren angelegt.', { ordner: h(stand.eingang) })}</p>` : ''}
        <div class="zeilen-knoepfe"><button type="button" class="btn" data-srt-start>${icon('suche', 18)}<span>${stand.phase === 'pause' ? t('Analyse fortsetzen') : t('Ordner analysieren')}</span></button></div>`;
    } else if (laeuft()) {
      inhalt = fortschrittHtml() + (stand.phase !== 'analyse' ? vorschlagHtml() : '');
    } else {
      // bereit oder fertig
      const e = stand.erledigt || {};
      inhalt = (stand.phase === 'fertig' ? `<div class="srt-ergebnis">${icon('haken', 18)} <span>${t('Fertig:')} ${tn((stand.alben || []).filter((a) => a.status === 'fertig').length, 'ein Album einsortiert', '{n} Alben einsortiert')}${e.ersetzt ? `, ${tn(e.ersetzt, 'eine Datei ersetzt', '{n} Dateien ersetzt')}` : ''}${e.papierkorb ? `, ${t('{n} in den Papierkorb', { n: zahl(e.papierkorb) })}` : ''}${e.fehler ? `, <b style="color:var(--danger)">${tn(e.fehler, 'ein Fehler', '{n} Fehler')}</b>` : ''}. ${t('Die Alben wandern jetzt an ihren Platz (Aufräumen).')}</span>
          <button type="button" class="btn btn-zweit btn-klein" data-srt-start>${t('Weitere Musik analysieren')}</button></div>` : '')
        + (stand.fehler ? `<p class="srt-fehler">${h(stand.fehler)}</p>` : '')
        + (z.gesamt || (stand.alben || []).length ? vorschlagHtml() : `<p class="hinweis">${t('Der Ordner ist leer.')}</p>`);
    }
    box.innerHTML = kopfHtml() + inhalt;
    verbinden();
  };

  const verbinden = () => {
    bind(box.querySelector('[data-srt-start]'), 'click', async () => { const r = await versuche(() => api.post('/admin/sortieren/analyse', {}), t('Analyse gestartet')); if (r) { listen = {}; offen = null; neu(r); planen(); } });
    bind(box.querySelector('[data-srt-neu]'), 'click', async () => { const r = await versuche(() => api.post('/admin/sortieren/analyse', {})); if (r) { listen = {}; neu(r); planen(); } });
    bind(box.querySelector('[data-srt-reset]'), 'click', async () => {
      if (!(await bestaetigen(t('Vorschlag zurücksetzen?'), t('Deine Änderungen am Vorschlag (anderes Album gewählt, Alben abgewählt, Aktionen je Datei) werden verworfen. Von Hand gesuchte Zuordnungen bleiben.'), t('Zurücksetzen')))) return;
      neu(await versuche(() => api.post('/admin/sortieren/zuruecksetzen', {})));
    });
    bind(box.querySelector('[data-srt-los]'), 'click', async () => {
      const ak = stand.aktionen || {};
      const text = t('{alben} Alben ({dateien} Dateien) werden einsortiert – erst in „{zwischen}“, nach dem Abgleich mit MusicBrainz an ihren Platz nach deinem Ordnerschema.', { alben: ak.alben, dateien: ak.album_dateien, zwischen: stand.zwischen })
        + (ak.papierkorb ? ' ' + t('{n} Dateien gehen in den Papierkorb (dort {tage} Tage).', { n: ak.papierkorb, tage: stand.papierkorb_tage }) : '')
        + (ak.ersetzen ? ' ' + t('{n} Dateien in der Bibliothek werden durch bessere ersetzt (die alten in den Papierkorb).', { n: ak.ersetzen }) : '');
      if (!(await bestaetigen(t('Vorschlag übernehmen?'), text, t('Übernehmen')))) return;
      const r = await versuche(() => api.post('/admin/sortieren/ausfuehren', {}), t('Wird einsortiert'));
      if (r) { neu(r); planen(); }
    });
    box.querySelectorAll('[data-srt-auf]').forEach((b) => bind(b, 'click', () => {
      const id = Number(b.dataset.srtAuf);
      offen = offen === id ? null : id;
      if (offen) detailLaden(offen); else zeichnen();
    }));
    box.querySelectorAll('[data-srt-aktiv]').forEach((c) => bind(c, 'change', async () => {
      neu(await versuche(() => api.post(`/admin/sortieren/album/${c.dataset.srtAktiv}`, { aktiv: c.checked })));
    }));
    box.querySelectorAll('[data-srt-release]').forEach((b) => bind(b, 'click', async () => {
      const r = await versuche(() => api.post(`/admin/sortieren/album/${offen}`, { release: b.dataset.srtRelease }), t('Umgehängt'));
      if (r) { offen = null; detail = null; neu(r); }
    }));
    box.querySelectorAll('[data-srt-cover]').forEach((img) => bind(img, 'error', () => {
      // kein Cover für dieses Release: das der Release-Gruppe versuchen, sonst Platzhalter
      if (img.dataset.srtCover && !img.dataset.rg) { img.dataset.rg = '1'; img.src = `/api/v1/admin/mb-cover/${img.dataset.srtCover}?art=rg&g=250`; } else img.remove();
    }));
    box.querySelectorAll('[data-srt-filter]').forEach((b) => bind(b, 'click', () => { filterAlben = b.dataset.srtFilter; zeichnen(); }));
    box.querySelectorAll('[data-srt-liste]').forEach((d) => bind(d, 'toggle', () => {
      // „toggle“ kommt auch, wenn ein schon offenes <details> neu gezeichnet wird – nur echte Wechsel zählen
      const rolle = d.dataset.srtListe;
      if (d.open === (listeOffen === rolle)) return;
      if (d.open) { listeOffen = rolle; if (!listen[rolle]) listeLaden(rolle); else zeichnen(); } else { listeOffen = null; }
    }));
    box.querySelectorAll('[data-srt-seite]').forEach((b) => bind(b, 'click', () => listeLaden(listeOffen, Number(b.dataset.srtSeite))));
    box.querySelectorAll('[data-srt-aktion]').forEach((s) => bind(s, 'change', async () => {
      if (await versuche(() => api.post(`/admin/sortieren/datei/${s.dataset.srtAktion}`, { aktion: s.value }))) neu();
    }));
    box.querySelectorAll('[data-srt-suche]').forEach((f) => bind(f, 'submit', async (e) => {
      e.preventDefault();
      const id = Number(f.dataset.srtSuche);
      const q = f.querySelector('input').value;
      suche[id] = { q, laedt: true }; zeichnen();
      const r = await versuche(() => api.post(`/admin/sortieren/datei/${id}/suche`, { q }));
      suche[id] = { q, laedt: false, ergebnis: r || null }; zeichnen();
    }));
    box.querySelectorAll('[data-srt-zuordnen]').forEach((b) => bind(b, 'click', async () => {
      b.disabled = true;
      const r = await versuche(() => api.post(`/admin/sortieren/datei/${b.dataset.srtZuordnen}/zuordnen`, { aufnahme: b.dataset.aufnahme }), t('Zugeordnet'));
      if (r) { delete suche[b.dataset.srtZuordnen]; listen = {}; neu(r); } else b.disabled = false;
    }));
  };

  const planen = () => {
    clearTimeout(timer);
    if (signal?.aborted) return;
    timer = setTimeout(async () => {
      if (!box.isConnected) return;
      const vorher = stand?.phase;
      try { stand = await api.get('/admin/sortieren', { signal }); } catch (e) { if (signal?.aborted) return; }
      if (vorher !== stand?.phase) { listen = {}; if (listeOffen) listeLaden(listeOffen); }
      // während sich etwas tut, die Ansicht nachziehen – aber nicht, solange jemand tippt
      if (!box.contains(document.activeElement) || document.activeElement.tagName !== 'INPUT') zeichnen();
      planen();
    }, laeuft() && sichtbar() ? 2000 : 30000);
  };

  (async () => {
    try { stand = await api.get('/admin/sortieren', { signal }); } catch (e) { if (signal?.aborted) return; box.innerHTML = kopfHtml() + `<p class="hinweis">${t('Konnte nicht geladen werden.')}</p>`; return; }
    zeichnen();
    planen();
  })();
}
