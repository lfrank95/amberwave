// Verwaltung (nur Admin): Übersicht, Konten, Bibliothek & Abgleich, Einstellungen, System
// sowie die Bearbeiten-Dialoge für Alben und Künstler.
import { api, versuche } from './api.js';
import { t, tn, zahl as zahlI, locale } from './i18n.js';
import { h, icon, dauer, datum, datumZeit, datumEingabe, groesse, kuenstlerText, toast, dialog, bestaetigen, menue, mbDatum, coverHtml, morph, bind } from './ui.js';
import { TYP_NAMEN, ZUSATZ_NAMEN, KUENSTLER_TYP, land, leer } from './bausteine.js';
import { netzweg } from './netzweg.js';
import { sortierPanel } from './sortieren.js';
import { gemerktAus, merken, scrollSetzen } from './merker.js';

/** Zahl nach Sprache (leere Werte als 0, wie früher in ui.js) */
const zahl = (v, nachkomma) => zahlI(v || 0, nachkomma);

/** innerHTML setzen und dabei aufgeklappte <details> (nach Reihenfolge) wieder aufklappen – für Felder, die sich selbst auffrischen */
function htmlBehalten(box, html) {
  const offen = [...box.querySelectorAll('details')].map((x) => x.open);
  box.innerHTML = html;
  box.querySelectorAll('details').forEach((x, i) => { if (offen[i] !== undefined) x.open = offen[i]; });
}

function tabs(aktiv) {
  const eintraege = [['/verwaltung', t('Übersicht')], ['/verwaltung/aktivitaet', t('Aktivität')], ['/verwaltung/konten', t('Konten')], ['/verwaltung/bibliothek', t('Bibliothek')], ['/verwaltung/protokoll', t('Protokoll')]];
  // Einstellungen (auch die des Servers) liegen jetzt unter /einstellungen – hier nur noch der Weg dorthin
  return `<nav class="verwaltung-tabs" aria-label="${t('Verwaltung')}">${eintraege.map(([p, n]) => `<a href="${p}" data-link class="${p === aktiv ? 'an' : ''}">${n}</a>`).join('')}<a href="/einstellungen/bibliothek" data-link class="tab-weiter">${t('Einstellungen')} ›</a></nav>`;
}

function kopf(titel, unter = '', rechts = '') {
  return `<div class="seiten-kopf"><div><h1>${titel}</h1>${unter ? `<div class="unter">${unter}</div>` : ''}</div>${rechts}</div>`;
}

/**
 * Werkzeuge → „Klanganalyse“: wie klingt jeder Song (für Klangradio und als Signal im Radio). Eingebautes Verfahren immer;
 * das erweiterte Modell installiert der Admin per Knopf (Lizenz bestätigen, Download direkt beim Hersteller), Entfernen
 * fällt auf das eingebaute Verfahren zurück.
 */
/** Downloads: Suchfeld (Prowlarr), Treffer mit „Holen“ (SABnzbd), darunter die Aufträge mit Fortschritt und Import */
function downloadsPanel(app, box, signal, sichtbar, zaehler) {
  let timer = null;
  let stand = null;
  let suche = null;     // { suche, treffer, begriff }
  let sucht = false;
  signal?.addEventListener('abort', () => clearTimeout(timer));
  const STATUS = { gesendet: [t('Übergeben'), ''], laeuft: [t('Lädt'), ''], fertig: [t('Wird kopiert'), ''], importiert: [t('In der Bibliothek'), 'gut'], fehler: [t('Fehler'), 'schlecht'] };
  const statusText = (a) => {
    if (a.status !== 'importiert') return STATUS[a.status] || [a.status, ''];
    if (a.einsortiert_am) return [t('Einsortiert'), 'gut'];
    return [stand?.einsortieren ? t('In der Bibliothek – wartet auf Abgleich und Einsortieren') : t('In der Bibliothek'), 'gut'];
  };
  let qFilter = 'alle';
  let idxFilter = '';   // Indexer-Quelle (leer = alle)
  let alleZeigen = false;   // auch unpassende Treffer (fehlendes Wort, keine Musik)
  // Sortierung der Treffer (im Browser gemerkt): Feld + Richtung; zweiter Klick auf dasselbe Feld dreht die Richtung
  const SORT = { relevanz: [t('Relevanz'), null], alter: [t('Alter'), 'auf'], groesse: [t('Größe'), 'ab'], grabs: [t('Beliebt'), 'ab'] };
  let sortierung = (() => { try { const x = JSON.parse(localStorage.getItem('aw-dl-sort') || 'null'); if (x && SORT[x.feld]) return x; } catch (e) { /* egal */ } return { feld: 'relevanz', richtung: null }; })();
  const sortieren = (liste) => {
    const { feld, richtung } = sortierung;
    if (feld === 'relevanz') return liste; // kommt vom Server schon nach Relevanz sortiert
    const wert = (t) => feld === 'alter' ? (t.alter_tage ?? 99999) : feld === 'groesse' ? (t.groesse || 0) : (t.grabs ?? -1);
    const f = richtung === 'ab' ? -1 : 1;
    // passende bleiben vor unpassenden, innerhalb davon nach dem gewählten Feld
    return [...liste].sort((a, b) => ((b.passend !== false) - (a.passend !== false)) || f * (wert(a) - wert(b)));
  };
  const sortPfeil = (k) => sortierung.feld !== k || !sortierung.richtung ? '' : k === 'alter' ? (sortierung.richtung === 'auf' ? ' ↑' : ' ↓') : (sortierung.richtung === 'ab' ? ' ↓' : ' ↑');
  // Künstler-Suche über MusicBrainz: Künstler wählen → Diskografie → Klick füllt die Usenet-Suche mit „Künstler Album“
  let modus = 'kuenstler';  // 'kuenstler' | 'usenet'
  let mbSuche = null;       // { begriff, kuenstler: [] }
  let disko = null;         // { kuenstler, releases, gesamt }
  let mbLaedt = false;
  let kontext = null;       // { kuenstler, album } aus der Diskografie – fürs „Hast du das schon?“ beim Holen
  let artFilter = new Set(['album', 'ep']);
  const ohneCover = new Set(); // Release Groups, deren Cover nicht kam (nicht bei jedem Zeichnen neu versuchen)
  const ARTEN = [['album', t('Alben')], ['ep', 'EPs'], ['single', 'Singles'], ['live', 'Live'], ['compilation', 'Compilations'], ['sonstiges', t('Sonstiges')]];
  // Album-Titel für die Usenet-Suche: Klammer-Zusätze (Deluxe, Remastered …) weg, die stehen in Release-Namen selten gleich
  const albumKurz = (t) => t.replace(/\s*[([][^)\]]*[)\]]\s*/g, ' ').replace(/\s+/g, ' ').trim() || t;
  const usenetSuchen = async (begriff, ktx = null) => {
    kontext = ktx;
    modus = 'usenet';
    sucht = true; suche = suche ? { ...suche, begriff } : null; zeichnen();
    const eingabe = box.querySelector('[data-dl-suche] input'); if (eingabe) eingabe.value = begriff;
    const r = await versuche(() => api.post('/admin/downloads/suche', { q: begriff, kuenstler: ktx?.kuenstler || '', album: ktx?.album || '' }));
    sucht = false;
    if (r) { suche = { ...r, begriff }; alleZeigen = false; qFilter = 'alle'; idxFilter = ''; }
    zeichnen();
  };
  const kuenstlerSuchen = async (begriff) => {
    mbLaedt = true; disko = null; mbSuche = { begriff, kuenstler: mbSuche?.kuenstler || [] }; zeichnen();
    const r = await versuche(() => api.get('/admin/downloads/kuenstler?q=' + encodeURIComponent(begriff)));
    mbLaedt = false;
    mbSuche = { begriff, kuenstler: r?.kuenstler || [] };
    // Eindeutiger Treffer (genau der Name, deutlich vor dem Rest): gleich die Diskografie öffnen
    const k = mbSuche.kuenstler;
    if (k.length && k[0].score === 100 && k[0].name.toLowerCase() === begriff.toLowerCase() && (k.length === 1 || k[1].score < 90 || k[1].name.toLowerCase() !== begriff.toLowerCase())) { diskoLaden(k[0].mbid); return; }
    zeichnen();
  };
  const diskoLaden = async (mbid) => {
    mbLaedt = true; zeichnen();
    const r = await versuche(() => api.get('/admin/downloads/kuenstler/' + mbid));
    mbLaedt = false;
    if (r) { disko = r; const da = new Set(r.releases.map((x) => x.art)); if (![...artFilter].some((a) => da.has(a))) artFilter = new Set(da); }
    zeichnen();
  };
  const kuenstlerHtml = () => {
    if (disko) {
      const k = disko.kuenstler;
      const zaehl = Object.fromEntries(ARTEN.map(([a]) => [a, disko.releases.filter((r) => r.art === a).length]));
      const liste = disko.releases.filter((r) => artFilter.has(r.art));
      return `<div class="dl-disko">
        <div class="dl-treffer-kopf">
          <span class="dl-disko-name">${mbSuche?.kuenstler?.length ? `<button type="button" class="pille" data-dl-mb-zurueck>${t('‹ Künstler')}</button>` : ''}<b>${h(k.name)}</b>${k.unterscheidung ? `<small>${h(k.unterscheidung)}</small>` : ''}<small>${[land(k.land), k.beginn?.slice(0, 4)].filter(Boolean).map(h).join(' · ')}</small></span>
          <button type="button" class="pille" data-dl-alles="${h(k.name)}" title="${h(t('Usenet nach allem von {name} durchsuchen', { name: k.name }))}">${h(t('Alles von {name} suchen', { name: k.name }))}</button>
        </div>
        <div class="dl-arten" data-dl-arten>${ARTEN.filter(([a]) => zaehl[a]).map(([a, n]) => `<button type="button" class="dl-art" data-art="${a}" aria-pressed="${artFilter.has(a)}">${n} <small>${zaehl[a]}</small></button>`).join('')}</div>
        <div class="dl-releases">${liste.map((r) => `<button type="button" class="dl-release${r.hier ? ' hier' : ''}" data-dl-release="${h(r.mbid)}" title="${h(t('Im Usenet suchen: {name}', { name: `${k.name} ${albumKurz(r.titel)}` }))}">
            <span class="dl-cover">${ohneCover.has(r.mbid) ? '' : `<img src="/api/v1/admin/mb-cover/${h(r.mbid)}?art=rg&g=250" alt="" loading="lazy" data-dl-cover="${h(r.mbid)}">`}${icon('album', 26)}${r.hier ? `<i class="dl-hier">${t('In der Bibliothek')}</i>` : ''}</span>
            <b>${h(r.titel)}</b><small>${[r.datum?.slice(0, 4), r.typ].filter(Boolean).map(h).join(' · ')}${r.zusatz ? ` · ${h(r.zusatz)}` : ''}</small>
          </button>`).join('') || `<p class="hinweis" style="margin:0">${t('Nichts in dieser Auswahl.')}</p>`}</div>
        ${disko.gesamt > disko.releases.length ? `<p class="hinweis" style="margin:0">${t('Gezeigt werden {n} von {gesamt} Veröffentlichungen.', { n: zahl(disko.releases.length), gesamt: zahl(disko.gesamt) })}</p>` : ''}
      </div>`;
    }
    if (mbSuche && !mbLaedt) {
      return `<div class="dl-treffer">${mbSuche.kuenstler.map((a) => `<button type="button" class="dl-kuenstler" data-dl-mb-k="${h(a.mbid)}">
          <span class="dl-k-name"><b>${h(a.name)}</b>${a.unterscheidung ? `<small>${h(a.unterscheidung)}</small>` : ''}</span>
          <span class="dl-wert">${[KUENSTLER_TYP[a.typ] || '', land(a.land), a.beginn ? a.beginn.slice(0, 4) + (a.ende ? '–' + a.ende.slice(0, 4) : '') : ''].filter(Boolean).map(h).join(' · ')}</span>
          ${a.alben_hier ? `<span class="dl-q lossless" title="${t('Schon in der Bibliothek')}"><b>${t('{n} hier', { n: a.alben_hier })}</b></span>` : '<span></span>'}
        </button>`).join('') || `<p class="hinweis" style="margin:0;padding:14px 16px">${h(t('Kein Künstler „{name}“ bei MusicBrainz.', { name: mbSuche.begriff }))}</p>`}</div>`;
    }
    return '';
  };
  const QFILTER = [['alle', t('Alle')], ['hires', 'Hi-Res'], ['lossless', t('Verlustfrei')], ['lossy', t('Verlustbehaftet')]];
  const qualiBadge = (q) => {
    if (!q || q.stufe === 'unbekannt' && !q.format) return `<span class="dl-q unbekannt" title="${t('Qualität steht nicht im Namen')}">?</span>`;
    const haupt = [q.format, q.detail].filter(Boolean).join(' ');
    const neben = [q.quelle, q.kanaele].filter(Boolean).join(' · ');
    const titel = `${{ hires: t('Hochauflösend'), lossless: t('Verlustfrei'), lossy: t('Verlustbehaftet'), unbekannt: t('Unbekannt') }[q.stufe]}${q.aus_kategorie ? t(' – aus Kategorie oder Angaben geschlossen') : t(' – aus dem Namen gelesen')}`;
    return `<span class="dl-q ${q.stufe}${q.aus_kategorie ? ' geschaetzt' : ''}" title="${h(titel)}"><b>${h(haupt)}</b>${neben ? `<small>${h(neben)}</small>` : ''}</span>`;
  };
  // „Prowlarr ✓ · Indexer A ✓ → SABnzbd ✓“ – welche Anbieter und Clients bereit sind
  const anbieterText = (s) => {
    if (!s.indexer) return `Prowlarr ${s.prowlarr ? '✓' : '–'} · SABnzbd ${s.sab ? '✓' : '–'}`;
    const liste = (xs) => xs.filter((x) => x.bereit).map((x) => `${x.name} ✓`).join(', ') || '–';
    return `${t('Suche')}: ${liste(s.indexer)} · ${t('Laden')}: ${liste(s.clients || [])}`;
  };
  const alter = (tage) => (tage == null ? '' : tage < 1 ? t('heute') : tage < 2 ? t('1 Tag') : tage < 60 ? t('{n} Tage', { n: tage }) : tage < 730 ? t('{n} Monate', { n: Math.round(tage / 30) }) : t('{n} Jahre', { n: Math.round(tage / 365) }));
  const zeichnen = () => {
    if (!box.isConnected || !stand) return;
    const s = stand;
    const fehltWas = !s.prowlarr || !s.sab;
    const laufend = (s.auftraege || []).filter((a) => ['gesendet', 'laeuft', 'fertig'].includes(a.status)).length;
    if (zaehler) zaehler.textContent = laufend ? String(laufend) : '';
    const html = `<div class="dl">
      <div class="dl-kopf"><h2 style="font-size:1.15rem;margin:0">Downloads</h2>
        <span class="hinweis">${h(anbieterText(s))} · ${h(t('→ Musikordner/{ziel}', { ziel: s.ziel }))}${s.einsortieren ? t(' → nach Abgleich einsortiert') : ''}</span></div>
      ${fehltWas ? `<p class="hinweis" style="margin:0;color:var(--accent-text)">${t('Noch nicht eingerichtet: {was} – unter <a href="/einstellungen/downloads" data-link>Einstellungen → Downloads</a>.', { was: [!s.prowlarr ? t('ein Suchanbieter (Prowlarr oder Newznab)') : '', !s.sab ? t('ein Downloadclient (SABnzbd)') : ''].filter(Boolean).join(t(' und ')) })}</p>` : ''}
      ${(() => { const pr = Object.values(s.pruefung?.pruefungen || {}).filter((x) => x.ok === false); return pr.length ? `<div class="dl-pruefung"><b>${t('Einrichtung prüfen:')}</b><ul>${pr.map((x) => `<li>${h(x.text)}${x.tipp ? `<small>${h(x.tipp)}</small>` : ''}</li>`).join('')}</ul><small>${t('Mit „Alles prüfen“ unter <a href="/einstellungen/downloads" data-link>Einstellungen → Downloads</a> werden auch alle Suchanbieter und Downloadclients geprüft.')}</small></div>` : ''; })()}
      ${app.ich.admin && !app.ich.admin.musik_schreiben ? `<p class="hinweis" style="margin:0;color:var(--accent-text)">${t('Der Musikordner steht auf „nur lesen“: Downloads werden geladen, aber erst übernommen, wenn du unter <a href="/einstellungen/bibliothek" data-link>Einstellungen → Bibliothek &amp; Automatik</a> das Schreiben erlaubst.')}</p>` : ''}
      ${s.fehler ? `<p class="hinweis" style="margin:0;color:var(--danger)">${h(s.fehler)}</p>` : ''}
      ${s.konflikt ? `<p class="hinweis" style="margin:0;color:var(--danger)">${t('<b>Importe angehalten,</b> bis das korrigiert ist: nichts wird importiert, nichts gelöscht, der Musikordner wird komplett eingelesen.')}</p>` : ''}
      <div class="rk-seg dl-modus" role="group" aria-label="${t('Suchart')}" data-dl-modus>
        <button type="button" data-modus="kuenstler" aria-pressed="${modus === 'kuenstler'}">${t('Künstler · MusicBrainz')}</button>
        <button type="button" data-modus="usenet" aria-pressed="${modus === 'usenet'}">${t('Usenet direkt')}</button>
      </div>
      <form class="dl-suche" data-dl-suche data-modus="${modus}">
        <div class="such-gross" style="margin:0;flex:1">${icon('suche', 18)}<input type="search" name="q" value="${h(modus === 'kuenstler' ? (mbSuche?.begriff || '') : (suche?.begriff || ''))}" placeholder="${modus === 'kuenstler' ? t('Künstler, z. B. Alexis Jordan – dann Album wählen') : t('Künstler und Album, z. B. Bruno Mars Unorthodox Jukebox – „genau so“, -ausschließen')}" ${modus === 'usenet' && !s.prowlarr ? 'disabled' : ''} autocomplete="off"></div>
        <button type="submit" class="btn" ${(modus === 'kuenstler' ? !mbLaedt : s.prowlarr && !sucht) ? '' : 'disabled'}>${(modus === 'kuenstler' ? mbLaedt : sucht) ? t('Sucht …') : t('Suchen')}</button>
      </form>
      ${modus === 'kuenstler' ? kuenstlerHtml() : ''}
      ${modus === 'usenet' && disko ? `<button type="button" class="pille dl-zurueck" data-dl-zur-disko>${h(t('‹ Zurück zur Diskografie von {name}', { name: disko.kuenstler.name }))}</button>` : ''}
      ${modus === 'usenet' && suche ? (() => {
        const passend = suche.treffer.filter((t) => t.passend !== false);
        const basis = alleZeigen ? suche.treffer : passend;
        const versteckt = suche.treffer.length - passend.length;
        // Quelle: Treffer zählen auch für die Indexer, bei denen dasselbe Release zusätzlich liegt („+1“)
        const quellenVon = (x) => [x.indexer, ...(x.auch || [])].filter(Boolean);
        const quellen = [...new Set(basis.flatMap(quellenVon))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        if (idxFilter && !quellen.includes(idxFilter)) idxFilter = '';
        const liste = sortieren(basis.filter((t) => (qFilter === 'alle' || t.qualitaet?.stufe === qFilter) && (!idxFilter || quellenVon(t).includes(idxFilter))));
        const mehrClients = new Set(suche.treffer.map((x) => x.client)).size > 1;
        return `<div class="dl-treffer">
        ${(suche.fehler || []).length ? `<p class="dl-anbieter-fehler">${suche.fehler.map((f) => h(t('{indexer}: {fehler}', f))).join('<br>')}</p>` : ''}
        <div class="dl-treffer-kopf"><span>${h(passend.length ? tn(passend.length, 'ein passender Treffer für „{b}“', '{n} passende Treffer für „{b}“', { b: suche.begriff }) : t('Nichts Passendes für „{b}“', { b: suche.begriff }))}</span>
          ${basis.length ? `<div class="rk-seg dl-qfilter" role="group" aria-label="${t('Nach Qualität filtern')}" data-dl-qf>${QFILTER.map(([k, n]) => {
            const anzahl = k === 'alle' ? basis.length : basis.filter((t) => t.qualitaet?.stufe === k).length;
            return `<button type="button" data-qf="${k}" aria-pressed="${qFilter === k}" ${anzahl || k === 'alle' ? '' : 'disabled'}>${n} <small>${anzahl}</small></button>`;
          }).join('')}</div>` : ''}
          ${basis.length > 1 ? `<div class="dl-sort" data-dl-sort role="group" aria-label="${t('Sortieren')}"><span>${t('Sortieren')}</span>${Object.entries(SORT).map(([k, [n]]) => `<button type="button" data-sort="${k}" aria-pressed="${sortierung.feld === k}" title="${k === 'alter' ? t('Neueste zuerst – nochmal klicken: älteste zuerst') : k === 'relevanz' ? t('Am besten passend zuerst') : t('Größte zuerst – nochmal klicken: kleinste zuerst')}">${n}${sortPfeil(k)}</button>`).join('')}</div>` : ''}
          <button type="button" class="pille" data-dl-zu>${t('Schließen')}</button></div>
        ${quellen.length > 1 ? `<div class="dl-quellen" role="group" aria-label="${t('Nach Indexer filtern')}" data-dl-idx><span>${t('Quelle')}</span>${['', ...quellen].map((q) => {
          const anzahl = basis.filter((x) => (qFilter === 'alle' || x.qualitaet?.stufe === qFilter) && (!q || quellenVon(x).includes(q))).length;
          return `<button type="button" class="dl-art" data-idx="${h(q)}" aria-pressed="${idxFilter === q}" ${anzahl || !q ? '' : 'disabled'}>${q ? h(q) : t('Alle')} <small>${anzahl}</small></button>`;
        }).join('')}</div>` : ''}
        ${!liste.length && basis.length ? `<p class="hinweis dl-tipp">${t('Keine Treffer mit diesen Filtern.')}</p>` : ''}
        ${liste.map((tr) => `<div class="dl-zeile${tr.passend === false ? ' unpassend' : ''}">
          ${qualiBadge(tr.qualitaet)}
          <div class="dl-titel"><b title="${h(tr.titel)}">${h(tr.titel)}</b><small><i class="dl-mobil">${groesse(tr.groesse)} · ${alter(tr.alter_tage)} · </i>${h(tr.indexer)}${mehrClients && tr.client_name ? ` <span class="dl-client">→ ${h(tr.client_name)}</span>` : ''}${tr.auch?.length ? ` <span title="${h(t('Gleiches Release auch bei {indexer}', { indexer: tr.auch.join(', ') }))}">+${tr.auch.length}</span>` : ''}${tr.kategorien?.length ? ` · ${h(tr.kategorien.join(', '))}` : ''}${tr.passend === false ? ` · <em>${h(tr.grund)}</em>` : ''}</small></div>
          <span class="dl-wert">${groesse(tr.groesse)}</span><span class="dl-wert">${alter(tr.alter_tage)}</span><span class="dl-wert" title="${t('So oft geladen')}">${tr.grabs != null ? `${zahl(tr.grabs)}×` : ''}</span>
          <button type="button" class="btn btn-klein" data-dl-holen="${tr.nr}" ${(tr.client_bereit ?? s.sab) ? '' : 'disabled'} title="${h(tr.client_name ? t('Lädt mit {client}', { client: tr.client_name }) : '')}">${tr.geholt ? t('Geholt ✓') : t('Holen')}</button>
        </div>`).join('')}
        ${versteckt ? `<button type="button" class="dl-mehr" data-dl-alle>${alleZeigen ? tn(versteckt, 'ein unpassender Treffer wieder ausblenden', '{n} unpassende Treffer wieder ausblenden') : tn(versteckt, 'ein unpassender Treffer ausgeblendet (fehlendes Wort, keine Musik) – anzeigen', '{n} unpassende Treffer ausgeblendet (fehlendes Wort, keine Musik) – anzeigen')}</button>` : ''}
        ${!passend.length && !versteckt ? '' : !passend.length ? `<p class="hinweis dl-tipp">${t('Tipp: Schreibweise prüfen, weniger Wörter, „genaue Wortfolge“ in Anführungszeichen oder -wort zum Ausschließen.')}</p>` : ''}
      </div>`;
      })() : ''}
      <h3 style="font-size:1rem;margin:6px 0 0">${t('Aufträge')}</h3>
      <div class="dl-auftraege">${(s.auftraege || []).map((a) => {
        const [text, art] = statusText(a);
        const prozent = a.status === 'laeuft' ? Number(a.prozent) : a.status === 'importiert' || a.status === 'fertig' ? 100 : 0;
        return `<div class="dl-auftrag ${art}">
          <div class="dl-titel"><b title="${h(a.titel)}">${h(a.titel)}</b><small>${h(text)}${(s.clients || []).length > 1 && a.client ? ` · ${h(a.client)}` : ''}${a.meldung ? ` · ${h(a.meldung)}` : ''}</small>
            ${['gesendet', 'laeuft', 'fertig'].includes(a.status) ? `<div class="fortschritt dl-fort"><i style="width:${Math.max(2, prozent)}%"></i></div>` : ''}</div>
          <span class="dl-wert">${groesse(Number(a.groesse))}</span>
          <span class="dl-knoepfe">${a.status === 'fehler' ? `<button type="button" class="pille" data-dl-anderes="${h(a.suchbegriff || a.titel)}" title="${t('Usenet-Suche mit demselben Begriff öffnen')}">${t('Anderes Release suchen')}</button>${a.pfad_sab !== '' ? `<button type="button" class="pille" data-dl-erneut="${a.id}">${t('Import wiederholen')}</button>` : ''}` : ''}${['importiert', 'fehler'].includes(a.status) ? `<button type="button" class="pille" data-dl-weg="${a.id}" title="${t('Nur aus dieser Liste entfernen')}">${icon('zu', 14)}</button>` : ''}</span>
        </div>`;
      }).join('') || `<p class="hinweis" style="margin:0">${t('Noch nichts geholt.')}</p>`}</div>
    </div>`;
    // angepasst statt neu aufgebaut: Suchfeld behält Fokus und Eingabe, Fortschrittsbalken gleiten
    if (box.querySelector('.dl')) morph(box, html); else box.innerHTML = html;
    bind(box.querySelector('[data-dl-suche]'), 'submit', (e) => {
      e.preventDefault();
      const begriff = new FormData(e.target).get('q')?.toString().trim();
      if (!begriff) return;
      if (modus === 'kuenstler') kuenstlerSuchen(begriff);
      else { disko = null; usenetSuchen(begriff); }
    });
    bind(box.querySelector('[data-dl-modus]'), 'click', (e) => {
      const b = e.target.closest('button[data-modus]'); if (!b || b.dataset.modus === modus) return;
      modus = b.dataset.modus; zeichnen();
      const eingabe = box.querySelector('[data-dl-suche] input');
      if (eingabe) { eingabe.value = modus === 'kuenstler' ? (mbSuche?.begriff || '') : (suche?.begriff || ''); eingabe.focus(); }
    });
    box.querySelectorAll('[data-dl-mb-k]').forEach((b) => bind(b, 'click', () => diskoLaden(b.dataset.dlMbK)));
    bind(box.querySelector('[data-dl-mb-zurueck]'), 'click', () => { disko = null; zeichnen(); });
    bind(box.querySelector('[data-dl-zur-disko]'), 'click', () => { modus = 'kuenstler'; zeichnen(); });
    bind(box.querySelector('[data-dl-alles]'), 'click', (e) => usenetSuchen(e.currentTarget.dataset.dlAlles, { kuenstler: e.currentTarget.dataset.dlAlles, album: '' }));
    bind(box.querySelector('[data-dl-arten]'), 'click', (e) => {
      const b = e.target.closest('button[data-art]'); if (!b) return;
      const a = b.dataset.art;
      if (artFilter.has(a) && artFilter.size > 1) artFilter.delete(a); else artFilter.add(a);
      zeichnen();
    });
    box.querySelectorAll('[data-dl-release]').forEach((b) => bind(b, 'click', () => {
      const r = disko?.releases.find((x) => x.mbid === b.dataset.dlRelease);
      if (r) usenetSuchen(`${disko.kuenstler.name} ${albumKurz(r.titel)}`, { kuenstler: disko.kuenstler.name, album: r.titel });
    }));
    box.querySelectorAll('[data-dl-cover]').forEach((i) => bind(i, 'error', () => { ohneCover.add(i.dataset.dlCover); i.remove(); }));
    bind(box.querySelector('[data-dl-zu]'), 'click', () => { suche = null; qFilter = 'alle'; idxFilter = ''; alleZeigen = false; zeichnen(); });
    bind(box.querySelector('[data-dl-idx]'), 'click', (e) => { const b = e.target.closest('button[data-idx]'); if (b && !b.disabled) { idxFilter = idxFilter === b.dataset.idx ? '' : b.dataset.idx; zeichnen(); } });
    bind(box.querySelector('[data-dl-sort]'), 'click', (e) => {
      const b = e.target.closest('button[data-sort]'); if (!b) return;
      const k = b.dataset.sort;
      const umdrehen = (r) => (r === 'ab' ? 'auf' : 'ab');
      sortierung = sortierung.feld === k && SORT[k][1] ? { feld: k, richtung: umdrehen(sortierung.richtung) } : { feld: k, richtung: SORT[k][1] };
      try { localStorage.setItem('aw-dl-sort', JSON.stringify(sortierung)); } catch (err) { /* egal */ }
      zeichnen();
    });
    bind(box.querySelector('[data-dl-alle]'), 'click', () => { alleZeigen = !alleZeigen; zeichnen(); });
    bind(box.querySelector('[data-dl-qf]'), 'click', (e) => { const b = e.target.closest('button[data-qf]'); if (b && !b.disabled) { qFilter = b.dataset.qf; zeichnen(); } });
    box.querySelectorAll('[data-dl-holen]').forEach((b) => bind(b, 'click', async () => {
      b.disabled = true; b.textContent = t('Wird übergeben …');
      const nr = Number(b.dataset.dlHolen);
      const daten = { suche: suche.suche, nr, kuenstler: kontext?.kuenstler || '', album: kontext?.album || '' };
      let r = await versuche(() => api.post('/admin/downloads/holen', daten));
      if (r?.schon_da) {
        // Hast du das schon? Zeigen, was da ist – und nur auf Wunsch trotzdem holen
        const liste = r.schon_da.map((a) => `<li><b>${h(a.kuenstler)} – ${h(a.titel)}</b><ul>${a.editionen.map((e) => `<li><code>${h(e.ordner)}</code> <small class="hinweis">${[e.jahr, e.format, e.qualitaet, tn(e.dateien, '{n} Datei', '{n} Dateien')].filter(Boolean).map(h).join(' · ')}</small></li>`).join('')}</ul></li>`).join('');
        const w = await dialog({ titel: t('Das hast du schon'), inhalt: `<p>${t('In der Bibliothek liegt bereits:')}</p><ul class="dl-schon">${liste}</ul><p class="hinweis">${t('Eine andere Edition (z. B. Hi-Res statt CD) kannst du trotzdem holen – sie landet als eigene Edition neben der vorhandenen.')}</p>`,
          knoepfe: [{ text: t('Nicht holen'), wert: 'nein', art: 'zweit' }, { text: t('Trotzdem holen'), wert: 'ja', art: 'haupt' }] });
        if (w !== 'ja') { b.disabled = false; b.textContent = t('Holen'); return; }
        r = await versuche(() => api.post('/admin/downloads/holen', { ...daten, trotzdem: true }));
        if (r?.ok) toast(t('An {client} übergeben', { client: r.client || 'SABnzbd' }));
      } else if (r?.ok) {
        toast(t('An {client} übergeben', { client: r.client || 'SABnzbd' }));
      }
      if (r?.ok) { const t = suche.treffer.find((x) => x.nr === nr); if (t) t.geholt = true; }
      else { b.disabled = false; b.textContent = t('Holen'); }
      laden();
    }));
    box.querySelectorAll('[data-dl-anderes]').forEach((b) => bind(b, 'click', () => {
      // Release-Namen zum Suchbegriff eindampfen, falls kein Begriff gespeichert ist (ältere Aufträge)
      const roh = b.dataset.dlAnderes;
      const begriff = /^[^\[(]*-\s|\s-\s/.test(roh) || roh.split(' ').length <= 6 ? roh : roh.replace(/[\[(][^\])]*[\])]/g, ' ').replace(/[._]/g, ' ').replace(/\b(19|20)\d{2}\b.*$/, '').replace(/\s+/g, ' ').trim();
      usenetSuchen(begriff, kontext);
      box.querySelector('[data-dl-suche]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
    box.querySelectorAll('[data-dl-erneut]').forEach((b) => bind(b, 'click', async () => { stand = await versuche(() => api.post(`/admin/downloads/${b.dataset.dlErneut}/erneut`, {})) || stand; zeichnen(); }));
    box.querySelectorAll('[data-dl-weg]').forEach((b) => bind(b, 'click', async () => { stand = await versuche(() => api.post(`/admin/downloads/${b.dataset.dlWeg}/entfernen`, {})) || stand; zeichnen(); }));
  };
  const laden = async () => {
    clearTimeout(timer);
    if (signal?.aborted) return;
    try { stand = await api.get('/admin/downloads', { signal }); } catch (e) { if (signal?.aborted) return; }
    zeichnen();
    const aktiv = (stand?.auftraege || []).some((a) => ['gesendet', 'laeuft', 'fertig'].includes(a.status));
    if (!signal?.aborted) timer = setTimeout(laden, aktiv && sichtbar() ? 3000 : 20000);
  };
  laden();
}

function klangPanel(app, box, signal) {
  let timer = null;
  signal?.addEventListener('abort', () => clearTimeout(timer));
  const zeichnen = (st) => {
    clearTimeout(timer);
    if (!st || !box.isConnected) return;
    const inst = st.installation || {};
    const installiert = inst.status === 'laeuft';
    const prozent = st.gesamt ? Math.round((st.analysiert / st.gesamt) * 100) : 0;
    const verfahren = st.modell ? t('Erweitertes Modell (Discogs-EffNet der MTG)') : t('Eingebaut (Klangfarbe, Energie, Rhythmus, Tonalität)');
    htmlBehalten(box, `<div style="display:flex;flex-direction:column;gap:10px;height:100%">
      <div><h2 style="font-size:1.15rem;margin-bottom:4px">${t('Klanganalyse')}</h2>
        <p class="hinweis" style="margin:0">${t('Hört sich jeden Titel einmal an und merkt sich, wie er klingt – für das <b>Klangradio</b> („klingt ähnlich“, im Titelmenü) und als zusätzliches Signal im Radio. Läuft im Hintergrund mit niedriger Priorität.')}</p></div>
      ${!st.bereit ? `<p class="hinweis" style="margin:0;color:var(--danger)">${t('<b>Python mit numpy fehlt im Container.</b> Bitte das Image neu bauen (ab v0.1.106 enthalten) – bis dahin ruht die Analyse.')}</p>` : ''}
      ${!st.aktiv ? `<p class="hinweis" style="margin:0;color:var(--accent-text)">${t('Ausgeschaltet (Einstellungen → Bibliothek & Automatik).')}</p>` : ''}
      <p class="hinweis" style="margin:0"><b>${t('Verfahren:')}</b> ${h(verfahren)}</p>
      ${st.modell ? `<p class="hinweis" style="margin:0"><b>${t('Stil-Erkennung:')}</b> ${st.stile ? t('an ({a} von {g} Titeln) – verfeinert Genre-Familien und Radio', { a: zahl(st.stile_fertig), g: zahl(st.gesamt) }) : t('noch nicht installiert – „Stil-Erkennung nachinstallieren“ lädt den Stil-Kopf (400 Discogs-Stile).')}</p>` : ''}
      <div><div class="fortschritt" style="margin:0 0 6px"><i style="width:${Math.max(prozent ? 3 : 0, prozent)}%"></i></div>
        <span class="hinweis">${t('{a} von {g} Titeln analysiert', { a: zahl(st.analysiert), g: zahl(st.gesamt) })}${st.laeuft ? t(' · läuft …') : ''}${st.fehler ? t(' · {n} nicht lesbar', { n: zahl(st.fehler) }) : ''}${st.index?.anzahl ? t(' · Ähnlichkeiten berechnet für {n}', { n: zahl(st.index.anzahl) }) : ''}</span></div>
      ${st.meldung ? `<p class="hinweis" style="margin:0;color:var(--accent-text)">${h(st.meldung)}</p>` : ''}
      ${inst.status ? `<p class="hinweis" style="margin:0;color:${inst.status === 'fehler' ? 'var(--danger)' : 'var(--accent-text)'}">${installiert ? t('Installation läuft: ') : ''}${h(inst.schritt || '')}</p>
        ${inst.log ? `<details><summary class="hinweis" style="cursor:pointer">${t('Protokoll')}</summary><pre class="log" style="max-height:220px;overflow:auto">${h(inst.log)}</pre></details>` : ''}` : ''}
      <div class="zeilen-knoepfe" style="margin-top:auto">
        ${st.index?.anzahl ? `<button type="button" class="btn btn-zweit" data-klang-qualitaet>${t('Qualität &amp; Stichprobe')}</button>` : ''}
        ${st.gesamt ? `<button type="button" class="btn btn-zweit" data-klang-neu ${installiert ? 'disabled' : ''}>${t('Neu analysieren …')}</button>` : ''}
        ${st.modell && !st.stile ? `<button type="button" class="btn btn-zweit" data-klang-modell ${installiert ? 'disabled' : ''}>${t('Stil-Erkennung nachinstallieren …')}</button>` : ''}
        ${st.modell ? `<button type="button" class="btn btn-zweit" data-klang-weg>${t('Modell entfernen')}</button>`
          : `<button type="button" class="btn btn-zweit" data-klang-modell ${installiert || !st.bereit ? 'disabled' : ''}>${installiert ? t('Wird installiert …') : t('Erweitertes Modell installieren …')}</button>`}
      </div></div>`);
    box.querySelector('[data-klang-modell]')?.addEventListener('click', () => installieren(st));
    box.querySelector('[data-klang-qualitaet]')?.addEventListener('click', () => qualitaet(st));
    box.querySelector('[data-klang-neu]')?.addEventListener('click', async () => {
      const r = await dialog({
        titel: t('Klanganalyse neu aufbauen'),
        inhalt: `<p style="margin-top:0">${t('Für Updates und Reparaturen: Die bisherigen Analyse-Ergebnisse werden verworfen und im Hintergrund neu gerechnet. Bibliothek, Tags, Playlists und Hörverlauf bleiben unberührt.')}</p>
          ${st.stile ? `<label class="checkbox-zeile"><input type="radio" name="was" value="stile" checked><span>${t('<b>Nur Stil-Erkennung</b> – die 400 Discogs-Stile je Song neu (die Klangvektoren bleiben, das Radio funktioniert solange weiter)')}</span></label>` : ''}
          <label class="checkbox-zeile"><input type="radio" name="was" value="alles" ${st.stile ? '' : 'checked'}><span>${t('<b>Alles</b> – Klangvektoren, Stile und Ähnlichkeiten komplett neu. Bis die Analyse durch ist, hat das Klangradio weniger Material (bei großen Sammlungen kann das Stunden bis Tage dauern).')}</span></label>`,
        knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Neu aufbauen'), wert: 'ok', art: 'haupt' }],
      });
      if (!r || r.wert !== 'ok') return;
      const was = r.form?.get('was') || 'alles';
      zeichnen(await versuche(() => api.post('/admin/klang/neu', { was })));
    });
    box.querySelector('[data-klang-weg]')?.addEventListener('click', async () => {
      if (!(await bestaetigen(t('Erweitertes Modell entfernen?'), t('Python-Paket und Modell werden gelöscht, Amberwave nutzt wieder das eingebaute Verfahren (dessen Ergebnisse sind noch da). Die Modell-Ergebnisse bleiben gespeichert, falls du es später wieder installierst.'), t('Entfernen')))) return;
      zeichnen(await versuche(() => api.post('/admin/klang/entfernen', {})));
    });
    if ((st.laeuft || installiert || (st.aktiv && st.bereit && st.offen > 0)) && !signal?.aborted) timer = setTimeout(laden, 4000);
  };
  const installieren = async (st) => {
    const d = await dialog({
      titel: t('Erweitertes Klang-Modell installieren'),
      breit: true,
      inhalt: `<p style="margin-top:0">${t('Das erweiterte Modell erkennt Stil, Instrumente und Stimmung deutlich feiner als das eingebaute Verfahren – ähnlich wie Plexamp.')}</p>
        <p class="hinweis">${t('<b>Lizenz:</b> Das Modell <i>Discogs-EffNet</i> stammt von der Music Technology Group (MTG) der Universitat Pompeu Fabra und steht unter <a href="{url}" target="_blank" rel="noopener">CC BY-NC-SA 4.0</a> – frei nur für <b>nicht-kommerzielle</b> Nutzung. Für kommerzielle Nutzung bietet die MTG eigene Lizenzen an. Die Analyse-Bibliothek <i>Essentia</i> steht unter AGPL-3.0.', { url: h(st.lizenz_url) })}</p>
        <p class="hinweis">${t('<b>Amberwave liefert beides nicht mit.</b> Dein Server lädt es direkt beim Hersteller: das Python-Paket <code>{paket}</code> von PyPI und das Modell von <code>{url}</code>. Platzbedarf etwa 0,5–1 GB im Cache-Ordner, die Analyse ist etwas langsamer. Danach wird die Sammlung im Hintergrund neu analysiert; bis dahin bleibt das eingebaute Verfahren aktiv. Schlägt etwas fehl, bleibt ebenfalls alles beim eingebauten Verfahren.', { paket: h(st.paket), url: h(st.modell_url) })}</p>
        <label class="checkbox-zeile" style="margin-top:12px"><input type="checkbox" name="lizenz" value="1" required> ${t('Ich nutze Amberwave privat und nicht kommerziell und akzeptiere die Lizenz des Modells.')}</label>`,
      knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Vom Hersteller laden und installieren'), wert: 'ok' }],
    });
    if (!d || d.form.get('lizenz') !== '1') return;
    const x = await versuche(() => api.post('/admin/klang/installieren', { lizenz: true }), t('Installation gestartet – läuft im Hintergrund'));
    if (x) zeichnen(x);
  };
  // Ehrliche Kennzahlen aus der eigenen Sammlung + Stichprobe zum Reinhören
  const qualitaet = async (st) => {
    const q = await versuche(() => api.get('/admin/klang/qualitaet'));
    if (!q) return;
    const k = q.kuenstler || {};
    const u = q.ueberspringen || {};
    const zeile = (n) => `<div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:3px 0;font-size:.88rem">
        <span>${h(n.titel)} <span class="hinweis">· ${h(n.kuenstler)}${n.jahr ? ` · ${n.jahr}` : ''}</span></span>
        <span class="hinweis" title="${t('Klang (Kosinus) · Metadaten (0–1)')}">${t('Klang {a} · Meta {b}', { a: zahl(n.klang, 2), b: zahl(n.meta, 2) })}</span></div>`;
    await dialog({
      titel: t('Klanganalyse: Qualität'),
      breit: true,
      inhalt: `<p class="hinweis" style="margin-top:0">${t('Verfahren: <b>{verfahren}</b>. Sortiert wird wie im Klangradio: Klang findet, Metadaten (Genres von Track, Album und Künstler, Ära, Mitwirkende) sortieren.', { verfahren: st.modell ? t('Erweitertes Modell') : t('Eingebaut') })}</p>
        <div class="formular-raster" style="grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:10px 0 16px">
          <div class="glass-panel" style="padding:12px 14px"><b>${t('Gleicher Künstler unter den 5 Ähnlichsten')}</b>
            <div style="font-size:1.6rem;font-weight:800;margin:4px 0">${k.anteil ?? '–'} %</div>
            <span class="hinweis">${t('Zufall wäre {z} % ({n} Paare geprüft). Der Künstler fließt nicht in die Sortierung ein – je deutlicher über Zufall, desto besser trifft der Klang.', { z: k.zufall ?? '–', n: zahl(k.paare || 0) })}</span></div>
          <div class="glass-panel" style="padding:12px 14px"><b>${t('Übersprungen im Radio (90 Tage)')}</b>
            <div style="font-size:1.6rem;font-weight:800;margin:4px 0">${u.klang ?? '–'} % <span class="hinweis" style="font-size:.9rem;font-weight:600">${t('Klang-Vorschläge')}</span></div>
            <span class="hinweis">${u.radio !== null && u.radio !== undefined ? t('Übrige Radio-Titel: {n} %. ', { n: u.radio }) : ''}${u.klang === null || u.klang === undefined ? t('Noch zu wenig gehört ({n} von mindestens 20).', { n: zahl(u.klang_n || 0) }) : t('Aus {n} Klang-Vorschlägen.', { n: zahl(u.klang_n) })} ${t('Niedriger ist besser.')}</span></div>
        </div>
        <h3 style="font-size:1rem;margin:0 0 6px">${t('Stichprobe zum Reinhören')}</h3>
        ${(q.stichprobe || []).map((s, i) => `<div style="padding:10px 0;border-top:1px solid var(--glass-border)">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:center"><b>${h(s.titel)} <span class="hinweis">· ${h(s.kuenstler)}${s.jahr ? ` · ${s.jahr}` : ''}</span></b>
            <button type="button" class="pille" data-probe="${i}">${t('Klangradio')}</button></div>
          ${s.nachbarn.map(zeile).join('')}</div>`).join('') || `<p class="hinweis">${t('Noch keine Ähnlichkeiten berechnet.')}</p>`}`,
      knoepfe: [{ text: t('Schließen'), wert: 'zu' }],
      beimOeffnen: (el) => el.querySelectorAll('[data-probe]').forEach((b) => b.addEventListener('click', () => {
        const s = q.stichprobe[Number(b.dataset.probe)];
        app.player.radioStarten({ art: 'klang', id: s.track });
        el.close();
      })),
    });
  };
  const laden = async () => { if (box.isConnected) zeichnen(await api.get('/admin/klang').catch(() => null)); };
  laden();
}

/**
 * Werkzeuge → „Metadaten abgleichen“: fehlende Angaben von MusicBrainz (und Kennzeichnung „explizit“ von Deezer) nachholen –
 * nur verknüpfte Editionen. Läuft als Auftrag auf dem Server weiter, auch wenn die Seite gewechselt oder die App geschlossen
 * wird; hier wird nur der Stand angezeigt (alle 2,5 s, solange er läuft und das Panel sichtbar ist).
 */
function metadatenPanel(box, signal, nachFertig = null) {
  let timer = null;
  let warLaeuft = false;
  const stoppen = () => { clearTimeout(timer); timer = null; };
  signal?.addEventListener('abort', stoppen);
  const zeichnen = (st) => {
    if (!st || !box.isConnected) return;
    const j = st.auftrag || {};
    const laeuft = j.status === 'laeuft';
    const angehalten = j.status === 'angehalten' && j.art === 'alle';
    // Fortschritt je Schritt: 1 Alben → 2 Künstler → 3 Bilder (bei einer Auswahl alles je Album)
    const phase = j.art === 'auswahl' ? 'auswahl' : (j.phase || 'alben');
    const [n, von, schritt] = phase === 'kuenstler' ? [j.k_geprueft || 0, j.k_gesamt || 0, t('Schritt 2 von 3 · Künstler')]
      : phase === 'bilder' ? [j.b_geprueft || 0, j.b_gesamt || 0, t('Schritt 3 von 3 · Künstlerbilder')]
        : phase === 'auswahl' ? [j.geprueft, j.gesamt, t('Ausgewählte Alben samt Künstlern und Bildern')] : [j.geprueft, j.gesamt, t('Schritt 1 von 3 · Alben')];
    const prozent = von ? Math.min(100, Math.round((n / Math.max(1, von)) * 100)) : 0;
    let zeile = '';
    if (laeuft) {
      zeile = `${j.pause ? t('Kurze Pause ({grund}) – geht in {min} Min. von selbst weiter.', { grund: h(j.fehler || t('MusicBrainz nicht erreichbar')), min: Math.ceil(j.pause / 60) }) : t('Läuft auf dem Server{auto} – du kannst die Seite wechseln oder die App schließen.', { auto: j.auto ? t(' (automatisch)') : '' })}
        <div class="fortschritt"><i style="width:${Math.max(3, prozent)}%"></i></div>
        <b>${schritt}:</b> ${t('{n} von {von}', { n: zahl(n), von: zahl(von) })}
        <br><span style="color:var(--text-leise)">${t('Alben: {a} ergänzt ({f} Angaben) · Künstler: {k} abgeglichen · Bilder: {b} geholt', { a: zahl(j.geaendert), f: zahl(j.felder), k: zahl(j.k_geaendert || 0), b: zahl(j.b_geholt || 0) })}</span>`;
    } else if (j.meldung && (j.status === 'fertig' || angehalten)) {
      zeile = h(j.meldung) + (j.beendet ? ` <span style="color:var(--text-leise)">· ${datumZeit(j.beendet)}</span>` : '');
    }
    const offen = st.luecken + (st.kuenstler_offen || 0) + (st.bilder_offen || 0);
    box.innerHTML = `<h2 style="font-size:1.15rem">${t('Metadaten vervollständigen')}</h2>
      <p class="hinweis" style="margin:6px 0 10px">${t('Holt in drei Schritten alles, was noch fehlt: <b>1. Alben</b> – Datum, Land, Barcode, Format, Label, Cover, Erstveröffentlichung, Genres (MusicBrainz) und die Kennzeichnung „explizit“ (Deezer); <b>2. Künstler</b> – Typ, Land, Lebensdaten, Aliase, Bandmitglieder für verknüpfte Künstler, die noch nie abgeglichen wurden; <b>3. Künstlerbilder</b> von fanart.tv. Nur was mit MusicBrainz verknüpft ist. Vorhandenes, von Hand Eingetragenes und geschützte Felder werden nie überschrieben. Läuft auf dem Server im Hintergrund – nach dem Einlesen, nach jedem Album-Abgleich und nachts auch automatisch.')}</p>
      <p class="hinweis" style="margin:0 0 10px">${tn(st.luecken, 'Offen: {n} Edition mit Lücken (von {g} verknüpften) · {k} Künstler · {b}', 'Offen: {n} Editionen mit Lücken (von {g} verknüpften) · {k} Künstler · {b}', { g: zahl(st.gesamt), k: zahl(st.kuenstler_offen || 0), b: st.fanart_aktiv ? t('{n} Künstler ohne Bild', { n: zahl(st.bilder_offen || 0) }) : t('Künstlerbilder: fanart.tv-Schlüssel unter Einstellungen eintragen') })}</p>
      ${zeile ? `<div class="hinweis" style="margin:0 0 12px;color:var(--text-primary)">${zeile}</div>` : ''}
      <div class="zeilen-knoepfe">
        ${laeuft ? `<button type="button" class="btn btn-zweit" data-meta-halt>${t('Anhalten')}</button>`
          : `<button type="button" class="btn" data-meta-los ${offen || angehalten ? '' : 'disabled'}>${angehalten ? t('Fortsetzen') : t('Jetzt vervollständigen')}</button>
             ${angehalten || st.pos > 0 ? `<button type="button" class="btn btn-zweit" data-meta-neu>${t('Von vorn')}</button>` : ''}`}
      </div>`;
    box.querySelector('[data-meta-los]')?.addEventListener('click', () => aktion('/admin/metadaten-abgleich/start', { neu: false }));
    box.querySelector('[data-meta-neu]')?.addEventListener('click', () => aktion('/admin/metadaten-abgleich/start', { neu: true }));
    box.querySelector('[data-meta-halt]')?.addEventListener('click', () => aktion('/admin/metadaten-abgleich/anhalten', {}));
    if (warLaeuft && !laeuft && j.status === 'fertig') nachFertig?.();
    warLaeuft = laeuft;
    stoppen();
    if (laeuft && !signal?.aborted) timer = setTimeout(laden, 2500);
  };
  const laden = async () => { if (box.isConnected) zeichnen(await api.get('/admin/metadaten-abgleich').catch(() => null)); };
  const aktion = async (pfad, daten) => { const st = await versuche(() => api.post(pfad, daten)); if (st) zeichnen(st); };
  laden();
  return { neuLaden: laden };
}

const STATUS_TEXT = { aktiv: t('Aktiv'), pending: t('Wartet auf Freigabe'), gesperrt: t('Gesperrt'), abgelaufen: t('Abgelaufen') };
const ROLLEN_SPERRBAR = {
  album: [['titel', t('Titel ')], ['kuenstler', t('Künstler ')], ['typ', t('Art')], ['jahr', t('Jahr')], ['genres', t('Genres')], ['beschreibung', t('Beschreibung')]],
  edition: [['titel', t('Titel ')], ['kuenstler', t('Künstler ')], ['datum', t('Datum')], ['land', t('Land')], ['kommentar', t('Kommentar')]],
  track: [['titel', t('Titel ')], ['kuenstler', t('Künstler ')], ['nummer', t('CD und Nummer')]],
  kuenstler: [['name', t('Name')], ['sortname', t('Sortiername')], ['typ', t('Typ')], ['unterscheidung', t('Unterscheidung')], ['land', t('Land')], ['beginn', t('Beginn')], ['ende', t('Ende')], ['bio', t('Biografie')]],
};

function sperrFelder(art, gesperrt) {
  return `<fieldset style="border:1px solid var(--glass-border);border-radius:12px;padding:10px 14px;margin:18px 0 6px">
    <legend style="padding:0 6px;color:var(--text-muted);font-size:.85rem">${t('Vor automatischem Überschreiben schützen')}</legend>
    <div style="display:flex;flex-wrap:wrap;gap:4px 18px">${ROLLEN_SPERRBAR[art].map(([k, n]) => `<label class="checkbox-zeile" style="margin:4px 0"><input type="checkbox" name="gesperrt" value="${k}" ${gesperrt.includes(k) ? 'checked' : ''}> ${n}</label>`).join('')}</div>
  </fieldset>`;
}

/** Monatsauswahl 1–24 + unbegrenzt */
function monateAuswahl(name = 'monate', standard = 12) {
  const m = [1, 2, 3, 6, 9, 12, 18, 24];
  return `<select name="${name}">${m.map((x) => `<option value="${x}" ${x === standard ? 'selected' : ''}>${tn(x, '{n} Monat', '{n} Monate')}</option>`).join('')}<option value="0">${t('Unbegrenzt')}</option></select>`;
}

// ---------------------------------------------------------------------------------------------

const VERBINDUNG = {
  direkt: { text: t('Direkt im Heimnetz'), klasse: 'gut', icon: '●' },
  heim: { text: t('Zuhause über Cloudflare'), klasse: 'mittel', icon: '◐' },
  extern: { text: t('Unterwegs (Internet)'), klasse: 'extern', icon: '○' },
};
const QUALI_TEXT = { opus256: 'Opus 256', opus160: 'Opus 160', opus128: 'Opus 128', aac256: 'AAC 256', aac160: 'AAC 160' };

function aktivitaetKarte(w) {
  const trk = w.track || {};
  const d = w.details || {};
  const v = VERBINDUNG[w.verbindung] || VERBINDUNG.extern;
  const datei = w.datei;
  const quelle = datei ? `${(datei.format || '').toUpperCase()}${datei.bittiefe ? ` ${datei.bittiefe}/${zahl(datei.abtastrate / 1000)}` : ''}` : '';
  const original = d.art === 'original';
  const qualitaet = original ? (d.bitgenau ? t('{q} · bitgenau', { q: quelle }) : t('{q} · verlustfrei', { q: quelle }))
    : d.qualitaet ? `${QUALI_TEXT[d.qualitaet] || d.qualitaet}${quelle ? t(' (aus {q})', { q: quelle }) : ''}` : (quelle || t('unbekannt'));
  const anteil = w.dauer > 0 ? Math.min(100, (w.position / w.dauer) * 100) : 0;
  const marken = [
    `<span class="marke ${original ? 'marke-gut' : ''}">${h(qualitaet)}</span>`,
    d.lueckenlos ? `<span class="marke">${t('lückenlos')}</span>` : '',
    d.ersatz ? `<span class="marke" title="${t('Original geht auf diesem Gerät nicht lückenlos')}">${t('statt Original')}</span>` : '',
    d.lautheit ? `<span class="marke">${h(locale.startsWith('de') ? d.lautheit.replace('.', ',') : d.lautheit)}</span>` : '',
    d.eq ? '<span class="marke">EQ</span>' : '',
    d.raumklang ? `<span class="marke">${t('Raumklang')} ${h(d.raumklang)}${d.layout ? ` · ${h(d.layout)}` : ''}</span>` : '',
    `<span class="marke">≈ ${zahl(w.kbit)} kbit/s</span>`,
  ].filter(Boolean).join('');
  const geraet = [w.geraet, d.app ? 'App' : (d.browser || ''), d.mobil ? t('Handy/Tablet') : ''].filter(Boolean).join(' · ');
  return `<article class="aktiv-karte ${w.zustand}" data-schluessel="${h(w.schluessel)}">
    <div class="aktiv-cover">${trk.album?.cover ? `<img src="${h(trk.album.cover)}" alt="">` : ''}<span class="aktiv-zustand" title="${w.zustand === 'spielt' ? t('spielt') : w.zustand === 'pausiert' ? t('pausiert') : t('keine Meldung mehr')}">${icon(w.zustand === 'spielt' ? 'play' : 'pause', 14)}</span></div>
    <div class="aktiv-inhalt">
      <div class="aktiv-kopf"><b class="aktiv-nutzer">${h(w.user)}</b><span class="aktiv-verbindung ${v.klasse}">${v.icon} ${v.text}</span></div>
      <div class="aktiv-titel">${trk.album?.id ? `<a href="/alben/${trk.album.id}" data-link>${h(trk.titel || '')}</a>` : h(trk.titel || '')}</div>
      <div class="aktiv-unter">${h(kuenstlerText(trk.kuenstler || []))}${trk.album?.titel ? ` · ${h(trk.album.titel)}` : ''}</div>
      <div class="aktiv-fortschritt"><span data-pos>${dauer(w.position * 1000)}</span><i><b data-balken style="width:${anteil}%"></b></i><span>${dauer(w.dauer * 1000)}</span></div>
      <div class="aktiv-marken">${marken}</div>
      <div class="aktiv-geraet">${icon(d.mobil ? 'handy' : 'computer', 14)} ${h(geraet)} · ${h(w.ip)}${w.zustand === 'getrennt' ? t(' · seit {n} s keine Meldung', { n: w.aktualisiert_vor }) : ''}${w.zustand === 'pausiert' && w.pause_sek !== null ? t(' · pausiert seit {d}', { d: dauer(w.pause_sek * 1000) }) : ''}</div>
    </div>
  </article>`;
}

export const verwaltungsAnsichten = {
  /** Downloads als eigene Seite (Hauptmenü, wenn unter Einstellungen → Downloads eingeschaltet) */
  async downloads({ app, ziel, signal }) {
    if (!app.ich.admin?.usenet) {
      ziel.innerHTML = kopf('Downloads') + `<div class="glass-panel" style="padding:22px"><p style="margin:0 0 12px">${t('Usenet-Downloads sind ausgeschaltet.')}</p>
        <p class="hinweis" style="margin:0 0 16px">${t('Einschalten unter Einstellungen → Downloads. Dort richtest du auch Indexer und SABnzbd ein.')}</p>
        <a class="btn" href="/einstellungen/downloads" data-link>${t('Zu den Einstellungen')}</a></div>`;
      return;
    }
    ziel.innerHTML = kopf('Downloads', t('Usenet-Suche über Prowlarr und Newznab-Indexer, geladen wird mit SABnzbd – das Fertige landet in der Bibliothek.'))
      + '<div class="glass-panel dl-panel" data-downloads><div class="lade"></div></div>';
    // Zahl der laufenden Aufträge auch am Menüpunkt
    const zaehler = { set textContent(v) { app.downloadZahl(Number(v) || 0); } };
    downloadsPanel(app, ziel.querySelector('[data-downloads]'), signal, () => true, zaehler);
  },

  async aktivitaet({ app, ziel, signal }) {
    ziel.innerHTML = tabs('/verwaltung/aktivitaet') + kopf(t('Aktivität'), t('Wer hört gerade was – live, alle paar Sekunden aktualisiert. Geschlossene Tabs verschwinden nach gut einer Minute, Pausen nach einer Weile.')) + `
      <div class="aktiv-summe" data-summe></div>
      <div class="aktiv-liste" data-liste><div class="lade"></div></div>`;
    let stand = null, zuletzt = 0;
    const zeichnen = () => {
      if (!stand) return;
      const s = stand.summe;
      ziel.querySelector('[data-summe]').innerHTML = [
        [t('Spielen gerade'), s.aktiv], [t('Direkt im Heimnetz'), s.direkt || 0], [t('Zuhause über Cloudflare'), s.heim || 0], [t('Unterwegs'), s.extern || 0],
        [t('Pausiert'), s.pausiert], [t('Umwandlungen (ffmpeg)'), `${stand.umwandlungen} / ${stand.max_umwandlungen}`], [t('Über das Internet'), `≈ ${zahl(s.kbit_internet)} kbit/s`],
      ].map(([t, w]) => `<div class="glass-panel aktiv-zahl"><b>${h(String(w))}</b><span>${h(t)}</span></div>`).join('');
      const liste = ziel.querySelector('[data-liste]');
      liste.innerHTML = stand.wiedergaben.length ? stand.wiedergaben.map(aktivitaetKarte).join('')
        : leer(t('Gerade hört niemand'), t('Sobald jemand etwas abspielt, erscheint es hier.'));
    };
    const laden = async () => {
      const r = await api.get('/admin/aktivitaet', { signal }).catch(() => null);
      if (!r || signal.aborted) return;
      stand = r; zuletzt = Date.now();
      zeichnen();
    };
    await laden();
    // Zwischen den Abfragen die Fortschrittsbalken weiterlaufen lassen
    const tick = setInterval(() => {
      if (!stand) return;
      const dt = (Date.now() - zuletzt) / 1000;
      for (const w of stand.wiedergaben) {
        if (w.zustand !== 'spielt') continue;
        const el = ziel.querySelector(`[data-schluessel="${CSS.escape(w.schluessel)}"]`);
        if (!el) continue;
        const pos = Math.min(w.dauer || Infinity, w.position + dt);
        el.querySelector('[data-pos]').textContent = dauer(pos * 1000);
        if (w.dauer > 0) el.querySelector('[data-balken]').style.width = `${Math.min(100, pos / w.dauer * 100)}%`;
      }
    }, 1000);
    const abfrage = setInterval(laden, 5000);
    signal.addEventListener('abort', () => { clearInterval(tick); clearInterval(abfrage); });
  },

  async uebersicht({ app, ziel, signal }) {
    const r = await api.get('/admin/uebersicht', { signal });
    const z = r.zahlen;
    const hinweise = [];
    if (!r.secret_key) hinweise.push(`<div class="fehler">${t('<b>Kein dauerhafter Schlüssel.</b> Amberwave kann seinen Schlüssel nicht im App-Daten-Ordner ablegen (keine Schreibrechte?). Gespeicherte Passwörter (E-Mail, API-Schlüssel) wären nach einem Neustart unlesbar und Geräte müssten sich neu verbinden – bitte die Rechte des App-Daten-Ordners prüfen oder APP_SECRET_KEY in der .env setzen.')}</div>`);
    if (!r.musikordner_ok) hinweise.push(`<div class="fehler">${t('Der Musikordner <code>{ordner}</code> ist im Container nicht vorhanden. Bitte <code>MUSIK_PFAD</code> in der .env prüfen.', { ordner: h(r.musikordner) })}</div>`);
    if (z.konten_wartend) hinweise.push(`<div class="hinweis-box">${tn(z.konten_wartend, '{n} Registrierung wartet auf Freigabe. <a href="/verwaltung/konten" data-link>Jetzt ansehen</a>', '{n} Registrierungen warten auf Freigabe. <a href="/verwaltung/konten" data-link>Jetzt ansehen</a>')}</div>`);
    if (r.update) hinweise.push(`<div class="hinweis-box">${t('<b>Neue Version {version} verfügbar.</b>', { version: h(r.update.version) })} ${r.update.url ? `<a href="${h(r.update.url)}" target="_blank" rel="noopener">${t('Was ist neu?')}</a> · ` : ''}${r.image ? t('Update auf dem Server: <code>docker compose pull &amp;&amp; docker compose up -d</code>') : `<a href="/einstellungen/sicherung" data-link>${t('Update einspielen')}</a>`}</div>`);
    if (!r.mail_eingerichtet) hinweise.push(`<div class="hinweis-box">${t('Der E-Mail-Versand ist noch nicht eingerichtet. <a href="/einstellungen/mail" data-link>Einstellungen → E-Mail</a>')}</div>`);
    if (z.konten_bald_ablaufend) hinweise.push(`<div class="hinweis-box">${tn(z.konten_bald_ablaufend, '{n} Konto läuft in den nächsten 30 Tagen ab. <a href="/verwaltung/konten?filter=bald" data-link>Ansehen</a>', '{n} Konten laufen in den nächsten 30 Tagen ab. <a href="/verwaltung/konten?filter=bald" data-link>Ansehen</a>')}</div>`);
    const kachel = (wert, text) => `<div class="glass-panel kennzahl"><b>${wert}</b><span>${text}</span></div>`;
    const l = r.letzter_scan;
    if (app.ich.app.gebuendelt === false) hinweise.push(`<p class="hinweis">${t('Die Oberfläche läuft ungebündelt (js/_b fehlt oder passt nicht zu den Quellen) – der erste Start dauert länger. Abhilfe: bash app/scripts/buendeln.sh, dann neu einspielen.')}</p>`);
    ziel.innerHTML = tabs('/verwaltung') + kopf(t('Übersicht'), `${h(app.ich.app.name)} ${h(r.version)}`) + hinweise.join('') + `
      <div class="kennzahlen">
        ${kachel(zahl(z.alben), t('Alben'))}${kachel(zahl(z.editionen), t('Editionen'))}${kachel(zahl(z.tracks), t('Titel gesamt'))}${kachel(zahl(z.kuenstler), t('Künstler & Mitwirkende'))}
        ${kachel(groesse(z.groesse), tn(z.dateien, '1 Datei', '{n} Dateien'))}${kachel(zahl(Math.round(z.laenge_ms / 3600000)) + ' h', t('Spielzeit'))}
        ${kachel(zahl(z.konten_aktiv), t('aktive Konten'))}${kachel(zahl(z.ohne_cover), t('Alben ohne Cover'))}
      </div>
      <div class="zweispaltig">
        <div class="glass-panel"><h2 style="font-size:1.15rem;margin-bottom:10px">${t('Letztes Einlesen')}</h2>
          ${l ? `<p style="margin:0 0 6px">${scanStatusText(l)}</p><p class="hinweis" style="margin:0">${datumZeit(l.gestartet)} · ${t('{n} Dateien · {neu} neu · {g} geändert · {e} entfernt', { n: zahl(l.gesamt), neu: zahl(l.neu), g: zahl(l.geaendert), e: zahl(l.entfernt) })}${l.fehler ? ` · <span style="color:var(--danger)">${tn(l.fehler, '1 Fehler', '{n} Fehler')}</span>` : ''}</p>` : `<p class="hinweis">${t('Noch nie eingelesen.')}</p>`}
          <p style="margin:14px 0 0"><a class="btn btn-zweit" href="/verwaltung/bibliothek" data-link>${t('Zur Bibliothek')}</a></p>
          ${z.dateien_fehler || z.dateien_ohne_track ? `<p class="hinweis" style="margin-top:12px">${z.dateien_fehler ? `${tn(z.dateien_fehler, '1 Datei nicht lesbar.', '{n} Dateien nicht lesbar.')} ` : ''}${z.dateien_ohne_track ? tn(z.dateien_ohne_track, '1 Datei keinem Titel zugeordnet.', '{n} Dateien keinem Titel zugeordnet.') : ''}</p>` : ''}
        </div>
        <div class="glass-panel"><h2 style="font-size:1.15rem;margin-bottom:10px">${t('Formate')}</h2>
          ${r.formate.length ? `<div class="pillen">${r.formate.map((f) => `<span class="pille" style="cursor:default">${h(f.format)} <small style="opacity:.7">${zahl(f.n)}</small></span>`).join('')}</div>` : `<p class="hinweis">${t('Noch keine Dateien.')}</p>`}
        </div>
      </div>`;
  },

  async konten({ app, ziel, query, signal }) {
    const FILTER = ['alle', 'wartend', 'bald', 'gesperrt'];
    let filter = FILTER.includes(query.get('filter')) ? query.get('filter') : gemerktAus('konten_filter', FILTER, 'alle');
    const zeichnen = async () => {
      const r = await api.get('/admin/konten', { signal });
      const liste = r.konten.filter((k) => filter === 'alle' || (filter === 'wartend' && k.status === 'pending') || (filter === 'bald' && k.bald_ablaufend) || (filter === 'gesperrt' && (k.status === 'gesperrt' || k.status === 'abgelaufen')));
      const n = (f) => r.konten.filter((k) => (f === 'wartend' ? k.status === 'pending' : f === 'bald' ? k.bald_ablaufend : k.status === 'gesperrt' || k.status === 'abgelaufen')).length;
      ziel.innerHTML = tabs('/verwaltung/konten') + kopf(t('Konten'), tn(r.konten.length, '1 Konto', '{n} Konten'), `<button type="button" class="btn" data-neu>${icon('plus', 18)}<span>${t('Konto anlegen')}</span></button>`) + `
        <div class="reiter">${[['alle', t('Alle')], ['wartend', t('Wartend ({n})', { n: n('wartend') })], ['bald', t('Läuft bald ab ({n})', { n: n('bald') })], ['gesperrt', t('Gesperrt/abgelaufen ({n})', { n: n('gesperrt') })]].map(([w, bez]) => `<button type="button" class="pille${filter === w ? ' an' : ''}" data-f="${w}">${bez}</button>`).join('')}</div>
        <div class="glass-panel" style="padding:8px 8px 4px"><div class="tabelle-scroll"><table>
          <thead><tr><th>${t('Name')}</th><th>${t('Status')}</th><th>${t('Gültig bis')}</th><th>${t('Geräte')}</th><th>${t('Zuletzt aktiv')}</th><th></th></tr></thead>
          <tbody>${liste.map((k) => `<tr>
            <td><b>${h(k.vorname)} ${h(k.nachname)}</b>${k.rolle === 'admin' ? ' <span class="marke marke-akzent">Admin</span>' : ''}<br><small>@${h(k.benutzername)} · ${h(k.email)}</small></td>
            <td><span class="status status-${k.status}">${STATUS_TEXT[k.status] || k.status}</span>${k.status === 'gesperrt' && k.gesperrt_bis ? `<br><small>${t('bis {d}', { d: datum(k.gesperrt_bis) })}</small>` : ''}${k.sperr_grund ? `<br><small>${h(k.sperr_grund)}</small>` : ''}</td>
            <td>${k.rolle === 'admin' ? '<small>–</small>' : k.gueltig_bis ? `${datum(k.gueltig_bis)}${k.bald_ablaufend ? ` <span class="marke marke-akzent">${t('bald')}</span>` : ''}` : k.status === 'pending' ? '<small>–</small>' : t('unbegrenzt')}</td>
            <td>${k.geraete}</td>
            <td><small>${k.zuletzt_aktiv ? datumZeit(k.zuletzt_aktiv) : '–'}</small></td>
            <td><div class="zeilen-knoepfe">${k.status === 'pending' ? `<button type="button" class="btn btn-klein" data-a="freischalten" data-id="${k.id}">${t('Freischalten')}</button><button type="button" class="btn btn-zweit btn-klein" data-a="ablehnen" data-id="${k.id}">${t('Ablehnen')}</button>`
              : k.rolle !== 'admin' ? `<button type="button" class="btn btn-zweit btn-klein" data-a="verlaengern" data-id="${k.id}">${t('Verlängern')}</button>` : ''}
              <button type="button" class="btn-ico" data-a="menue" data-id="${k.id}" data-menue-anker aria-label="${t('Weitere Aktionen')}">${icon('mehr', 18)}</button></div></td>
          </tr>`).join('') || `<tr><td colspan="6" class="hinweis">${t('Keine Konten in dieser Ansicht.')}</td></tr>`}</tbody></table></div></div>`;
      ziel.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.f; merken('konten_filter', filter); history.replaceState(history.state || {}, '', '/verwaltung/konten' + (filter !== 'alle' ? '?filter=' + filter : '')); zeichnen(); }));
      ziel.querySelector('[data-neu]').addEventListener('click', () => kontoAnlegen(app, zeichnen));
      ziel.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', (e) => kontoAktion(app, r.konten.find((k) => k.id === Number(b.dataset.id)), b.dataset.a, e.currentTarget, zeichnen)));
    };
    await zeichnen();
  },

  async bibliothek({ app, ziel, query, signal }) {
    const FILTER = ['ohne_mb', 'alle', 'ohne_cover', 'mehrere', 'unvollstaendig', 'eigen'];
    const usenet = !!app.ich.admin?.usenet;
    const BEREICHE = ['alben', 'werkzeuge', 'auffaellig', ...(usenet ? ['downloads'] : []), 'unsortiert'];
    const SORT = [['offen', t('Offenes zuerst')], ['titel', t('Titel A–Z')], ['jahr', t('Jahr')], ['neu', t('Zuletzt hinzugefügt')]];
    let filter = FILTER.includes(query.get('filter')) ? query.get('filter') : gemerktAus('bib_filter', FILTER, 'ohne_mb');
    let bereich = BEREICHE.includes(query.get('bereich')) ? query.get('bereich') : 'alben';
    let sortierung = gemerktAus('bib_sort', SORT.map((s) => s[0]), 'offen');
    let formatF = gemerktAus('bib_format', ['', 'flac', 'mp3', 'sonst'], '');
    let dekade = gemerktAus('bib_dekade', ['', '1960', '1970', '1980', '1990', '2000'], '');
    let q = query.get('q') || '';
    let seite = 1;
    let abfrageTimer = null;
    ziel.innerHTML = tabs('/verwaltung/bibliothek') + `<div class="seiten-kopf"><div class="bib-titel"><h1>${t('Bibliothek')}</h1><button type="button" class="btn btn-klein bib-scan-knopf" data-scan-kopf title="${t('Neue und geänderte Dateien einlesen')}">${icon('verlauf', 16)}<span>${t('Scannen')}</span></button></div></div>` + `
      <div class="bib-bereiche" role="tablist" aria-label="${t('Bereich')}" data-bereiche>
        <button type="button" role="tab" class="pille" data-bereich="alben">${t('Alben')}</button>
        <button type="button" role="tab" class="pille" data-bereich="werkzeuge">${t('Werkzeuge')} <b data-werk-n></b></button>
        <button type="button" role="tab" class="pille" data-bereich="auffaellig">${t('Auffälligkeiten')} <b data-auff-n></b></button>
        ${usenet ? `<button type="button" role="tab" class="pille" data-bereich="downloads">Downloads <b data-dl-n></b></button>` : ''}
        <button type="button" role="tab" class="pille" data-bereich="unsortiert">${t('Unsortiert')} <b data-srt-n></b></button>
      </div>
      <div class="bib-status" data-status></div>
      <section data-teil="alben" class="bib-werk">
        <aside class="bib-rail" aria-label="${t('Ansichten und Eingrenzen')}">
          <div class="bib-rail-titel">${t('Ansichten')}</div>
          <div class="bib-ansichten" data-ansichten></div>
          <div class="bib-rail-titel">${t('Eingrenzen')}</div>
          <div class="bib-facetten" data-facetten></div>
          <p class="bib-rail-hinweis">${t('Filter, Sortierung und Auswahl werden pro Gerät gemerkt. Eingrenzungen lassen sich kombinieren.')}</p>
        </aside>
        <div class="bib-liste">
          <div class="bib-leiste">
            <div class="such-gross" style="margin:0;flex:1 1 220px">${icon('suche', 18)}<input type="search" data-q value="${h(q)}" placeholder="${t('Album oder Künstler')}" style="height:42px;font-size:.95rem"></div>
            <select data-sort aria-label="${t('Sortieren')}">${SORT.map(([w, bez]) => `<option value="${w}" ${w === sortierung ? 'selected' : ''}>${bez}</option>`).join('')}</select>
          </div>
          <div class="bib-sammel" data-sammel hidden></div>
          <div class="bib-kopfzeile" aria-hidden="true"><span></span><span></span><span>${t('Album · Künstler')}</span><span class="bib-jahr">${t('Jahr')}</span><span>${t('Quelle')}</span><span class="bib-titelzahl">${t('Titel gesamt')}</span><span class="bib-qual">${t('Qualität')}</span></div>
          <div data-alben><div class="lade"></div></div>
          <div class="bib-fuss"><span data-zaehler></span><span data-mehr></span></div>
        </div>
        <aside class="bib-detail" data-detail hidden aria-live="polite"></aside>
      </section>
      <section data-teil="werkzeuge" class="bib-werkzeuge" hidden>
        <div class="bib-karten">
          <div class="glass-panel" data-scan><div class="lade"></div></div>
          <div class="glass-panel" data-meta><div class="lade"></div></div>
          <div class="glass-panel" data-klang><div class="lade"></div></div>
          <div class="glass-panel" data-flac><div class="lade"></div></div>
        </div>
        <div class="glass-panel" data-erkennung style="margin-top:20px"><h2 style="font-size:1.15rem">${t('Alben am Klang erkennen')}</h2><div class="lade"></div></div>
        <div class="glass-panel" data-aufraeumen style="margin-top:20px"><h2 style="font-size:1.15rem">${t('Dateien aufräumen')}</h2><div class="lade"></div></div>
      </section>
      <section data-teil="downloads" hidden>
        <div class="glass-panel dl-panel" data-downloads><div class="lade"></div></div>
      </section>
      <section data-teil="unsortiert" hidden>
        <div class="glass-panel" data-unsortiert><div class="lade"></div></div>
      </section>
      <section data-teil="auffaellig" hidden>
        <div class="glass-panel" data-probleme><h2 style="font-size:1.15rem;margin-bottom:10px">${t('Auffälligkeiten')}</h2><div class="lade"></div></div>
      </section>`;
    const bereichZeigen = (b, merkenUrl = true) => {
      bereich = b;
      ziel.querySelectorAll('[data-teil]').forEach((e) => { e.hidden = e.dataset.teil !== b; });
      ziel.querySelectorAll('[data-bereich]').forEach((e) => { e.classList.toggle('an', e.dataset.bereich === b); e.setAttribute('aria-selected', String(e.dataset.bereich === b)); });
      if (merkenUrl) {
        history.replaceState(history.state || {}, '', `/verwaltung/bibliothek?filter=${filter}&bereich=${b}${q ? '&q=' + encodeURIComponent(q) : ''}`);
        app.gezeichnet = location.pathname + location.search;
      }
    };
    ziel.querySelector('[data-bereiche]').addEventListener('click', (e) => { const b = e.target.closest('[data-bereich]'); if (b) bereichZeigen(b.dataset.bereich); });
    bereichZeigen(bereich, false);
    // ---- Einlesen ----
    const scanBox = ziel.querySelector('[data-scan]');
    const scanKopf = ziel.querySelector('[data-scan-kopf]');
    scanKopf.addEventListener('click', async () => {
      scanKopf.disabled = true;
      if (await versuche(() => api.post('/admin/scan', { art: 'neu' }), t('Einlesen gestartet'))) setTimeout(scanZeichnen, 600);
      else scanKopf.disabled = false;
    });
    const scanZeichnen = async () => {
      if (!ziel.isConnected) return;
      const s = await api.get('/admin/scan').catch(() => null);
      if (!s) { scanKopf.disabled = false; return; }
      const l = s.laufend || s.laeufe[0];
      const prozent = s.laufend && s.laufend.gesamt ? Math.round((s.laufend.geprueft / Math.max(1, s.laufend.gesamt)) * 100) : null;
      // Knopf neben der Überschrift: während des Einlesens Fortschritt statt „Scannen“
      scanKopf.disabled = !!s.laufend;
      scanKopf.classList.toggle('laeuft', !!s.laufend);
      scanKopf.querySelector('span').textContent = s.laufend ? (prozent !== null ? t('Scannt … {p} %', { p: prozent }) : t('Scannt …')) : t('Scannen');
      scanBox.innerHTML = `<h2 style="font-size:1.15rem;margin-bottom:10px">${t('Musiksammlung einlesen')}</h2>
        ${s.laufend ? `<p style="margin:0">${icon('verlauf', 16)} ${t('Läuft: {x}', { x: h(s.laufend.aktuell || t('startet …')) })}</p><div class="fortschritt"><i style="width:${prozent ?? 3}%"></i></div>
          <p class="hinweis" style="margin:0">${t('{a} von {g} Dateien · {n} neue Alben', { a: zahl(s.laufend.geprueft), g: zahl(s.laufend.gesamt), n: zahl(s.laufend.alben_neu) })}</p>
          <p style="margin:12px 0 0"><button type="button" class="btn btn-zweit btn-klein" data-abbrechen="${s.laufend.id}">${t('Abbrechen')}</button></p>`
          : `<p class="hinweis" style="margin:0 0 14px">${t('Neue und geänderte Dateien werden eingelesen, ohne Rückfragen. Abgeglichene Alben behalten ihre MusicBrainz-Daten.')}</p>
          <div class="zeilen-knoepfe"><button type="button" class="btn" data-start="neu">${icon('verlauf', 18)}<span>${t('Neues einlesen')}</span></button>
          <button type="button" class="btn btn-zweit" data-start="voll">${t('Alles neu lesen')}</button></div>
          ${l ? `<p class="hinweis" style="margin:14px 0 0">${t('Zuletzt: {status} · {zeit} · {n} Dateien, {neu} neu, {g} geändert, {e} entfernt{f}', { status: scanStatusText(l), zeit: datumZeit(l.beendet || l.gestartet), n: zahl(l.gesamt), neu: zahl(l.neu), g: zahl(l.geaendert), e: zahl(l.entfernt), f: l.fehler ? `, <span style="color:var(--danger)">${tn(l.fehler, '1 Fehler', '{n} Fehler')}</span>` : '' })}</p>` : ''}
          ${s.auto_stunden ? `<p class="quelle-hinweis">${tn(s.auto_stunden, 'Automatisch jede Stunde.', 'Automatisch alle {n} Stunden.')}</p>` : `<p class="quelle-hinweis">${t('Automatisches Einlesen: Einstellungen → Bibliothek & Automatik.')}</p>`}`}
        ${!s.laufend && s.kein_zugriff ? `<div class="glass-panel" style="margin-top:14px;padding:12px 14px;border-color:rgba(255,107,107,.45)">
          ${t('<b>{n} Ordner/Dateien ohne Leserecht</b> – sie wurden übersprungen, bereits Eingelesenes davon bleibt erhalten.', { n: s.kein_zugriff })}
          <p class="hinweis" style="margin:6px 0 0;font-size:.85rem">${t('Die App liest als Benutzer {benutzer}. Abhilfe: in der .env <code>PUID=99</code> und <code>PGID=100</code> (wie Lidarr) und den Stack mit dem neuen Startbefehl neu starten – oder auf Unraid „Tools → New Permissions“ für die Musik-Freigabe. Liste unten unter „Fehler beim letzten Lauf“.', { benutzer: h(s.benutzer || '?') })}</p></div>` : ''}
        ${!s.laufend && s.fehler.length ? `<details style="margin-top:12px"><summary class="hinweis" style="cursor:pointer">${tn(s.fehler.length, '1 Fehler beim letzten Lauf', '{n} Fehler beim letzten Lauf')}</summary><pre class="log">${s.fehler.map((f) => `${h(f.pfad)}\n  → ${h(f.fehler)}`).join('\n')}</pre></details>` : ''}`;
      scanBox.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', async () => {
        if (b.dataset.start === 'voll' && !(await bestaetigen(t('Alles neu lesen?'), t('Alle Dateien werden neu gelesen. Das dauert bei großen Sammlungen eine Weile. Abgeglichene Alben bleiben erhalten.'), t('Starten')))) return;
        if (await versuche(() => api.post('/admin/scan', { art: b.dataset.start }), t('Einlesen gestartet'))) setTimeout(scanZeichnen, 600);
      }));
      scanBox.querySelector('[data-abbrechen]')?.addEventListener('click', async (e) => {
        await versuche(() => api.post(`/admin/scan/${e.currentTarget.dataset.abbrechen}/abbrechen`));
        setTimeout(scanZeichnen, 600);
      });
      if (s.laufend) {
        clearTimeout(abfrageTimer);
        abfrageTimer = setTimeout(() => { scanZeichnen(); albenLaden(); }, 2500);
      }
    };
    // ---- Auffälligkeiten ----
    const problemeLaden = async () => {
      const p = await api.get('/admin/dateien', { signal }).catch(() => null);
      const box = ziel.querySelector('[data-probleme]');
      if (!p) { box.innerHTML += `<p class="hinweis">${t('Konnte nicht geladen werden.')}</p>`; return; }
      const teil = (titel, liste, fn) => liste.length ? `<details><summary style="cursor:pointer;margin:6px 0">${titel} <span class="marke">${liste.length}</span></summary><pre class="log">${liste.slice(0, 200).map(fn).join('\n')}</pre></details>` : '';
      const nAuff = p.fehler.length + p.ohne_track.length + (p.versteckt || []).length + p.ohne_cover.length;
      ziel.querySelector('[data-auff-n]').textContent = nAuff || '';
      box.innerHTML = `<h2 style="font-size:1.15rem;margin-bottom:10px">${t('Auffälligkeiten')}</h2>`
        + (teil(t('Nicht lesbare Dateien'), p.fehler, (f) => `${h(f.pfad)}\n  → ${h(f.fehler)}`)
        + teil(t('Dateien ohne Titel'), p.ohne_track, (f) => h(f.pfad))
        + teil(t('Weitere Editionen mit Dateien (Familie sieht nur die angezeigte)'), p.versteckt || [], (v) => `${h(v.album)} – ${h(v.edition)}: ${tn(v.dateien, '1 Datei', '{n} Dateien')}\n  ${h(v.ordner)}`)
        + teil(t('Alben ohne Cover'), p.ohne_cover, (a) => `${h(a.titel)}  (${h(a.ordner)})`) || `<p class="hinweis" style="margin:0">${t('Alles in Ordnung.')}</p>`);
    };
    // ---- Statusleiste: ein Blick, wo etwas offen ist ----
    const statusBox = ziel.querySelector('[data-status]');
    let statusTimer = null, metaPanel = null;
    signal.addEventListener('abort', () => clearTimeout(statusTimer));
    const statusLaden = async () => {
      if (!ziel.isConnected) return;
      const [s, f, m] = await Promise.all([
        api.get('/admin/scan').catch(() => null), null, api.get('/admin/metadaten-abgleich').catch(() => null),
      ]);
      if (!ziel.isConnected) return;
      const kacheln = [];
      if (s) {
        const l = s.laufend || (s.laeufe || [])[0];
        kacheln.push({ id: 'scan', titel: t('Einlesen'), wert: s.laufend ? t('Läuft …') : l ? zeitVor(l.beendet || l.gestartet) : t('Noch nie'), zeile: s.laufend ? t('{a} von {g} Dateien', { a: zahl(s.laufend.geprueft), g: zahl(s.laufend.gesamt) }) : l ? `${t('{n} Dateien', { n: zahl(l.gesamt) })}${l.fehler ? ` · ${tn(l.fehler, '1 Fehler', '{n} Fehler')}` : ''}` : t('Neues einlesen'), ampel: s.laufend ? 'an' : l && l.fehler ? 'warn' : 'gut' });
      }
      if (m) {
        const j = m.auftrag || {};
        kacheln.push(j.status === 'laeuft'
          ? { id: 'meta', titel: t('Metadaten'), wert: t('Läuft …'), zeile: j.art === 'auswahl' ? t('{a} von {g} Alben', { a: zahl(j.geprueft), g: zahl(j.gesamt) }) : { kuenstler: t('Schritt 2: Künstler'), bilder: t('Schritt 3: Künstlerbilder') }[j.phase] || t('Schritt 1: {a} von {g} Alben', { a: zahl(j.geprueft), g: zahl(j.gesamt) }), ampel: 'an' }
          : (() => {
            const offen = m.luecken + (m.kuenstler_offen || 0) + (m.bilder_offen || 0);
            const teile = [m.luecken ? t('{n} Alben', { n: zahl(m.luecken) }) : '', m.kuenstler_offen ? t('{n} Künstler', { n: zahl(m.kuenstler_offen) }) : '', m.bilder_offen ? t('{n} ohne Bild', { n: zahl(m.bilder_offen) }) : ''].filter(Boolean);
            return { id: 'meta', titel: t('Metadaten'), wert: offen ? t('{n} offen', { n: zahl(offen) }) : t('Vollständig'), zeile: teile.length ? teile.join(' · ') : t('{n} verknüpfte Editionen', { n: zahl(m.gesamt) }), ampel: offen ? 'warn' : 'gut' };
          })());
        clearTimeout(statusTimer);
        if (j.status === 'laeuft') statusTimer = setTimeout(statusLaden, 5000);
      }
      statusBox.innerHTML = kacheln.map((k) => `<button type="button" class="bib-kachel" data-kachel="${k.id}"><span class="bib-kachel-kopf"><span>${h(k.titel)}</span><i class="ampel ${k.ampel}"></i></span><b>${h(k.wert)}</b><small>${h(k.zeile)}</small></button>`).join('');
      const offenN = kacheln.filter((k) => k.ampel === 'warn' || k.ampel === 'an').length;
      ziel.querySelector('[data-werk-n]').textContent = offenN || '';
    };
    const zeitVor = (iso) => {
      const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
      if (min < 2) return t('Gerade eben');
      if (min < 90) return t('Vor {n} Min.', { n: min });
      if (min < 60 * 36) return t('Vor {n} Std.', { n: Math.round(min / 60) });
      return t('Vor {n} Tagen', { n: Math.round(min / 1440) });
    };
    statusBox.addEventListener('click', (e) => {
      const k = e.target.closest('[data-kachel]');
      if (!k) return;
      bereichZeigen('werkzeuge');
      const ziele = { scan: '[data-scan]', meta: '[data-meta]' };
      ziel.querySelector(ziele[k.dataset.kachel])?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    // ---- Alben ----
    const albenBox = ziel.querySelector('[data-alben]');
    const mehrBox = ziel.querySelector('[data-mehr]');
    const sammelBox = ziel.querySelector('[data-sammel]');
    const detailBox = ziel.querySelector('[data-detail]');
    const werk = ziel.querySelector('.bib-werk');
    const auswahl = new Set();
    const zeilenDaten = new Map(); // Album-ID → Zeile aus der Liste
    let detailId = null;
    let letzterBuchstabe = '';
    const albenHolen = (s2) => {
      const p = new URLSearchParams({ filter, seite: s2, pro_seite: 60, sort: sortierung });
      if (q) p.set('q', q);
      if (formatF) p.set('format', formatF);
      if (dekade) p.set('dekade', dekade);
      return api.get('/admin/alben?' + p).catch((e) => { albenBox.innerHTML = leer(t('Fehler'), h(e.message)); return null; });
    };
    const ANSICHTEN = [['alle', t('Alle Alben'), 'alle'], ['ohne_mb', t('Ohne MusicBrainz'), 'ohne_mb'], ['ohne_cover', t('Ohne Cover'), 'ohne_cover'], ['mehrere', t('Mehrere Editionen'), 'mehrere'], ['unvollstaendig', t('Unvollständig'), 'unvollstaendig'], ['eigen', t('Eigene, so belassen'), 'eigen']];
    const FORMATE = [['flac', 'FLAC'], ['mp3', 'MP3'], ['sonst', t('Andere')]];
    const DEKADEN = [['1960', t('1960er')], ['1970', t('1970er')], ['1980', t('1980er')], ['1990', t('1990er')], ['2000', t('2000er+')]];
    const railZeichnen = (zahlen) => {
      ziel.querySelector('[data-ansichten]').innerHTML = ANSICHTEN.map(([w, bez, z]) => `<button type="button" class="bib-ansicht${filter === w ? ' an' : ''}" data-fw="${w}" aria-pressed="${filter === w}"><span>${bez}</span><b>${zahl(zahlen[z] ?? 0)}</b></button>`).join('');
      ziel.querySelector('[data-facetten]').innerHTML = FORMATE.map(([w, bez]) => `<button type="button" class="pille${formatF === w ? ' an' : ''}" data-ff="${w}" aria-pressed="${formatF === w}">${bez}</button>`).join('')
        + DEKADEN.map(([w, bez]) => `<button type="button" class="pille${dekade === w ? ' an' : ''}" data-fd="${w}" aria-pressed="${dekade === w}">${bez}</button>`).join('');
    };
    const zeileHtml = (a) => {
      const fehlt = a.tracks > a.dateien;
      let kopfZeile = '';
      if (sortierung === 'titel') {
        const b = (a.titel.trim()[0] || '#').toLocaleUpperCase(locale);
        const buchstabe = /\p{L}/u.test(b) ? b : '#';
        if (buchstabe !== letzterBuchstabe) { letzterBuchstabe = buchstabe; kopfZeile = `<div class="bib-gruppe">${h(buchstabe)}</div>`; }
      }
      return `${kopfZeile}<div class="bib-zeile${auswahl.has(a.id) ? ' gewaehlt' : ''}${detailId === a.id ? ' aktiv' : ''}" data-id="${a.id}" tabindex="0">
        <span class="bib-haken"><input type="checkbox" data-wahl ${auswahl.has(a.id) ? 'checked' : ''} aria-label="${h(t('{titel} auswählen', { titel: a.titel }))}"></span>
        <span class="bib-cover">${a.cover ? `<img src="${h(a.cover)}" alt="" loading="lazy">` : ''}</span>
        <div class="bib-titel"><a href="/alben/${a.id}" data-link>${h(a.titel)}</a>
          <small>${h(kuenstlerText(a.kuenstler))}${a.editionen > 1 ? ` · <b>${t('{n} Editionen', { n: a.editionen })}</b>` : ''}${fehlt ? ` · <span class="warn">${tn(a.tracks - a.dateien, '{n} Titel fehlt', '{n} Titel fehlen')}</span>` : ''}</small></div>
        <span class="bib-jahr">${a.jahr || ''}</span>
        <span><span class="marke ${a.abgeglichen ? 'marke-akzent' : ''}">${a.abgeglichen ? 'MusicBrainz' : a.eigen ? t('Eigene') : 'Tags'}</span></span>
        <span class="bib-titelzahl${fehlt ? ' warn' : ''}">${a.dateien}/${a.tracks}</span>
        <span class="bib-qual">${h(a.qualitaet || '')}</span></div>`;
    };
    // behalten = nach dem Bearbeiten neu zeichnen: alle bisher geladenen Seiten holen und die Scrollposition halten
    const albenLaden = async (anhaengen = false, behalten = false) => {
      const y = window.scrollY;
      history.replaceState(history.state || {}, '', `/verwaltung/bibliothek?filter=${filter}${bereich !== 'alben' ? '&bereich=' + bereich : ''}${q ? '&q=' + encodeURIComponent(q) : ''}`);
      app.gezeichnet = location.pathname + location.search;
      const r = await albenHolen(behalten ? 1 : seite);
      if (!r) return;
      const seiten = [r];
      if (behalten) {
        for (let s2 = 2; s2 <= seite; s2++) {
          const r2 = await albenHolen(s2);
          if (!r2) break;
          seiten.push(r2);
        }
        seite = seiten.length;
      }
      const letzte = seiten[seiten.length - 1];
      railZeichnen(r.zahlen);
      const alle = seiten.flatMap((x) => x.alben);
      if (!anhaengen) { zeilenDaten.clear(); letzterBuchstabe = ''; }
      alle.forEach((a) => zeilenDaten.set(a.id, a));
      const neuHtml = (anhaengen ? letzte.alben : alle).map(zeileHtml).join('');
      if (anhaengen) albenBox.querySelector('.bib-zeilen')?.insertAdjacentHTML('beforeend', neuHtml);
      else albenBox.innerHTML = alle.length ? `<div class="bib-zeilen">${neuHtml}</div>` : leer(filter === 'ohne_mb' && !formatF && !dekade && !q ? t('Alles abgeglichen oder bewusst belassen') : t('Keine Alben in dieser Ansicht'));
      const geladen = zeilenDaten.size;
      ziel.querySelector('[data-zaehler]').textContent = tn(r.gesamt, '{a} von {n} Album', '{a} von {n} Alben', { a: zahl(geladen) });
      mehrBox.innerHTML = letzte.seite * letzte.pro_seite < r.gesamt ? `<button type="button" class="btn btn-zweit btn-klein" data-mehr-laden>${t('Weitere laden')}</button>` : '';
      sammelZeichnen();
      if (behalten) scrollSetzen(y);
    };

    // ---- Auswahl und Sammelaktionen ----
    const sammelZeichnen = () => {
      sammelBox.hidden = auswahl.size === 0;
      if (!auswahl.size) { sammelBox.innerHTML = ''; return; }
      sammelBox.innerHTML = `<b>${t('{n} ausgewählt', { n: zahl(auswahl.size) })}</b>
        <button type="button" class="bib-link" data-alle-seite>${t('alle {n} geladenen', { n: zahl(zeilenDaten.size) })}</button>
        <span class="abstand"></span>
        <button type="button" class="btn btn-klein" data-luecken title="${t('Holt alles Fehlende – Alben, Künstler, Künstlerbilder – nur bei Verknüpfung mit MusicBrainz, nur leere Felder')}">${t('Lücken füllen')}</button>
        <button type="button" class="btn btn-zweit btn-klein" data-eigen="${filter === 'eigen' ? 0 : 1}" title="${filter === 'eigen' ? t('Zurück nach „Ohne MusicBrainz“') : t('Gibt es bei MusicBrainz nicht – bleibt mit den Tags der Dateien, taucht nicht mehr als offen auf')}">${filter === 'eigen' ? t('Wieder als offen führen') : t('Kein Treffer – so belassen')}</button>
        <button type="button" class="btn btn-zweit btn-klein" data-wahl-weg>${t('Auswahl aufheben')}</button>`;
    };
    const zeilenMarkieren = () => albenBox.querySelectorAll('.bib-zeile').forEach((z) => {
      const id = Number(z.dataset.id);
      z.classList.toggle('gewaehlt', auswahl.has(id));
      z.querySelector('[data-wahl]').checked = auswahl.has(id);
    });
    sammelBox.addEventListener('click', async (e) => {
      if (e.target.closest('[data-wahl-weg]')) { auswahl.clear(); zeilenMarkieren(); sammelZeichnen(); return; }
      if (e.target.closest('[data-alle-seite]')) { zeilenDaten.forEach((_, id) => auswahl.add(id)); zeilenMarkieren(); sammelZeichnen(); return; }
      const eig = e.target.closest('[data-eigen]');
      if (eig) {
        const r = await versuche(() => api.post('/admin/alben/markieren', { ids: [...auswahl], wert: eig.dataset.eigen === '1' }), eig.dataset.eigen === '1' ? t('Als eigene Alben belassen') : t('Wieder als offen geführt'));
        if (r) { auswahl.clear(); await albenLaden(false, true); }
        return;
      }
      const los = e.target.closest('[data-luecken]');
      if (!los) return;
      los.disabled = true;
      const r = await versuche(() => api.post('/admin/alben/luecken', { ids: [...auswahl] }));
      los.disabled = false;
      if (!r) return;
      toast(tn(auswahl.size, '{n} Album wird samt Künstlern und Bildern auf dem Server im Hintergrund ergänzt – Fortschritt unter Werkzeuge → Metadaten vervollständigen.', '{n} Alben werden samt Künstlern und Bildern auf dem Server im Hintergrund ergänzt – Fortschritt unter Werkzeuge → Metadaten vervollständigen.'), 'info', 6000);
      auswahl.clear(); zeilenMarkieren(); sammelZeichnen();
      metaPanel?.neuLaden();
      statusLaden();
    });

    // ---- Detailleiste ----
    const detailSchliessen = () => {
      detailId = null;
      werk.classList.remove('mit-detail');
      detailBox.classList.remove('offen');
      setTimeout(() => { if (detailId === null) detailBox.hidden = true; }, 240);
      albenBox.querySelectorAll('.bib-zeile.aktiv').forEach((z) => z.classList.remove('aktiv'));
    };
    const detailOeffnen = async (id) => {
      detailId = id;
      albenBox.querySelectorAll('.bib-zeile').forEach((z) => z.classList.toggle('aktiv', Number(z.dataset.id) === id));
      const z = zeilenDaten.get(id);
      detailBox.hidden = false;
      werk.classList.add('mit-detail');
      requestAnimationFrame(() => detailBox.classList.add('offen'));
      if (!detailBox.querySelector('.bib-detail-inhalt')) detailBox.innerHTML = '<div class="lade"></div>';
      const a = await api.get(`/admin/alben/${id}`).catch(() => null);
      if (detailId !== id) return;
      if (!a) { detailBox.innerHTML = leer(t('Fehler'), t('Album konnte nicht geladen werden.')); return; }
      const abgeglichen = a.editionen.some((e) => e.quelle === 'musicbrainz');
      const edId = z?.edition_id ?? (a.editionen.find((e) => e.angezeigt) || a.editionen[0])?.id ?? null;
      detailBox.innerHTML = `<div class="bib-detail-inhalt">
        <div class="bib-detail-zu"><button type="button" class="btn-ico" data-detail-zu aria-label="${t('Detail schließen')}">${icon('zu', 18)}</button></div>
        <div class="bib-detail-kopf"><span class="bib-detail-cover">${z?.cover ? `<img src="${h(z.cover)}" alt="">` : ''}</span>
          <div><h3>${h(a.titel)}</h3><div class="hinweis">${h(kuenstlerText(a.kuenstler))}${a.jahr ? ` · ${a.jahr}` : ''}</div>
          <span class="marke ${abgeglichen ? 'marke-akzent' : ''}" style="margin-top:6px;display:inline-block">${abgeglichen ? 'MusicBrainz' : z?.eigen ? t('Eigenes Album · so belassen') : t('Tags · nicht abgeglichen')}</span></div></div>
        <div class="bib-detail-knoepfe">
          ${edId ? `<a class="btn ${abgeglichen ? 'btn-zweit ' : ''}btn-klein" href="/verwaltung/abgleich/${edId}" data-link>${abgeglichen ? t('Neu abgleichen') : t('Abgleichen')}</a>` : ''}
          ${!abgeglichen ? `<button type="button" class="btn btn-zweit btn-klein" data-detail-eigen="${z?.eigen ? 0 : 1}">${z?.eigen ? t('Wieder als offen führen') : t('Kein Treffer – so belassen')}</button>` : ''}
          <button type="button" class="btn btn-zweit btn-klein" data-detail-bearbeiten>${t('Bearbeiten')}</button>
          <a class="btn btn-zweit btn-klein" href="/alben/${a.id}" data-link>${t('Öffnen')}</a></div>
        <dl class="bib-fakten">
          ${z ? `<dt>${t('Titel gesamt')}</dt><dd>${t('{a} von {b} vorhanden', { a: z.dateien, b: z.tracks })}</dd><dt>${t('Qualität')}</dt><dd>${h(z.qualitaet || '–')}</dd>` : ''}
          <dt>Genres</dt><dd>${a.genres.length ? h(a.genres.join(' · ')) : '–'}</dd>
          ${z?.ordner ? `<dt>${t('Ordner')}</dt><dd class="bib-pfad">${h(z.ordner)}</dd>` : ''}</dl>
        <div class="bib-rail-titel">${t('Editionen ({n})', { n: a.editionen.length })}</div>
        ${a.editionen.map((e) => `<div class="bib-edition"><div><b>${h(e.titel && e.titel !== a.titel ? e.titel : (e.kommentar || 'Edition'))}</b>
          <small>${[mbDatum(e.datum), e.land ? land(e.land) : '', e.format, e.quelle === 'musicbrainz' ? 'MusicBrainz' : 'Tags'].filter(Boolean).map(h).join(' · ')}${e.angezeigt ? t(' · wird angezeigt') : ''}</small></div></div>`).join('')}</div>`;
    };
    albenBox.addEventListener('click', (e) => {
      const hak = e.target.closest('[data-wahl]');
      const zeile = e.target.closest('.bib-zeile');
      if (!zeile) return;
      const id = Number(zeile.dataset.id);
      if (hak) { if (hak.checked) auswahl.add(id); else auswahl.delete(id); zeile.classList.toggle('gewaehlt', hak.checked); sammelZeichnen(); return; }
      if (e.target.closest('a')) return;
      detailOeffnen(id);
    });
    albenBox.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('bib-zeile')) { e.preventDefault(); detailOeffnen(Number(e.target.dataset.id)); }
    });
    detailBox.addEventListener('click', (e) => {
      if (e.target.closest('[data-detail-zu]')) { detailSchliessen(); return; }
      const de = e.target.closest('[data-detail-eigen]');
      if (de && detailId) {
        const id = detailId;
        versuche(() => api.post('/admin/alben/markieren', { ids: [id], wert: de.dataset.detailEigen === '1' }), de.dataset.detailEigen === '1' ? t('Als eigenes Album belassen') : t('Wieder als offen geführt'))
          .then(async (r) => { if (r) { await albenLaden(false, true); if (detailId === id) detailOeffnen(id); statusLaden(); } });
        return;
      }
      if (e.target.closest('[data-detail-bearbeiten]') && detailId) {
        const id = detailId;
        albumBearbeiten(app, id, async () => { await albenLaden(false, true); if (detailId === id) detailOeffnen(id); });
      }
    });
    ziel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && detailId !== null && !document.querySelector('dialog[open]')) detailSchliessen(); });
    ziel.querySelector('.bib-rail').addEventListener('click', (e) => {
      const fw = e.target.closest('[data-fw]');
      const ff = e.target.closest('[data-ff]');
      const fd = e.target.closest('[data-fd]');
      if (!fw && !ff && !fd) return;
      if (fw) { filter = fw.dataset.fw; merken('bib_filter', filter); }
      if (ff) { formatF = formatF === ff.dataset.ff ? '' : ff.dataset.ff; merken('bib_format', formatF); }
      if (fd) { dekade = dekade === fd.dataset.fd ? '' : fd.dataset.fd; merken('bib_dekade', dekade); }
      seite = 1;
      albenLaden();
    });
    ziel.querySelector('[data-sort]').addEventListener('change', (e) => { sortierung = e.target.value; merken('bib_sort', sortierung); seite = 1; albenLaden(); });
    mehrBox.addEventListener('click', (e) => { if (e.target.closest('[data-mehr-laden]')) { seite++; albenLaden(true); } });
    let sucheTimer = null;
    ziel.querySelector('[data-q]').addEventListener('input', (e) => { clearTimeout(sucheTimer); sucheTimer = setTimeout(() => { q = e.target.value.trim(); seite = 1; albenLaden(); }, 300); });
    signal.addEventListener('abort', () => { clearTimeout(abfrageTimer); clearTimeout(sucheTimer); });
    erkennungPanel(app, ziel.querySelector('[data-erkennung]'), signal, () => albenLaden(false, true));
    aufraeumenPanel(app, ziel.querySelector('[data-aufraeumen]'), signal);
    klangPanel(app, ziel.querySelector('[data-klang]'), signal);
    flacPanel(app, ziel.querySelector('[data-flac]'), signal);
    if (usenet) downloadsPanel(app, ziel.querySelector('[data-downloads]'), signal, () => bereich === 'downloads', ziel.querySelector('[data-dl-n]'));
    sortierPanel(app, ziel.querySelector('[data-unsortiert]'), signal, () => bereich === 'unsortiert', ziel.querySelector('[data-srt-n]'));
    metaPanel = metadatenPanel(ziel.querySelector('[data-meta]'), signal, () => { albenLaden(false, true); statusLaden(); });
    await Promise.all([scanZeichnen(), problemeLaden(), albenLaden()]);
    statusLaden();
  },

  async abgleich({ app, ziel, param, signal }) {
    const id = Number(param[0]);
    const ed = await api.get(`/admin/editionen/${id}`, { signal });
    const discs = new Set(ed.tracks.filter((t) => t.datei).map((t) => t.disc)).size;
    ziel.innerHTML = tabs('/verwaltung/bibliothek') + `
      <div class="album-kopf" style="margin-bottom:22px;align-items:center">
        <div class="album-cover" style="width:150px">${coverHtml(ed.cover, ed.album_titel)}</div>
        <div class="album-info">
          <div class="ueberzeile">${t('Mit MusicBrainz abgleichen')}</div>
          <h1 style="font-size:clamp(1.6rem,3vw,2.4rem)">${h(ed.album_titel)}</h1>
          <div class="album-kuenstler">${h(ed.kuenstler_text || t('Unbekannter Künstler'))}</div>
          <div class="fakten"><span>${tn(ed.dateien, '1 Datei', '{n} Dateien')}${discs > 1 ? ` ${t('auf {n} Datenträgern', { n: discs })}` : ''}</span>${ed.jahr ? `<span>${ed.jahr}</span>` : ''}${ed.qualitaet ? `<span>${h(ed.qualitaet)}</span>` : ''}<span title="${h(ed.ordner)}">${h(ed.ordner)}</span></div>
          <div class="aktionen" style="margin-top:4px">
            <a class="btn btn-zweit" href="/alben/${ed.album_id}?edition=${id}" data-link>${t('Zum Album')}</a>
            ${ed.quelle === 'musicbrainz' ? `<span class="marke marke-akzent">${t('abgeglichen {d}', { d: ed.abgleich_am ? datum(ed.abgleich_am) : '' })}</span><button type="button" class="btn btn-zweit" data-loesen>${t('Verknüpfung lösen')}</button>` : ''}
          </div>
        </div>
      </div>
      <form class="glass-panel filterleiste" data-suche style="padding:16px;align-items:flex-end">
        <div style="flex:2 1 240px"><label style="margin-top:0">Album</label><input type="text" name="titel" value="${h(ed.album_titel)}" required></div>
        <div style="flex:2 1 200px"><label style="margin-top:0">${t('Künstler ')} <small>${t('(leer = beliebig)')}</small></label><input type="text" name="kuenstler" value="${h(ed.kuenstler_text === 'Various Artists' ? '' : ed.kuenstler_text)}"></div>
        <button type="submit" class="btn" style="flex:none">${icon('suche', 18)}<span>${t('Bei MusicBrainz suchen')}</span></button>
      </form>
      <div data-ergebnis style="margin-top:22px"></div>`;
    const box = ziel.querySelector('[data-ergebnis]');
    let ergebnis = null;
    const filter = { passend: false, land: '', format: '' };
    const zeichnen = () => {
      if (!ergebnis) return;
      const laender = new Set(), formate = new Set();
      ergebnis.gruppen.forEach((g) => g.editionen.forEach((e) => { if (e.land) laender.add(e.land); if (e.format) formate.add(e.format); }));
      const gruppenHtml = ergebnis.gruppen.map((g) => {
        const eds = g.editionen.filter((e) => (!filter.passend || e.trackanzahl_passt) && (!filter.land || e.land === filter.land) && (!filter.format || e.format === filter.format));
        if (!eds.length) return '';
        return `<div class="glass-panel" style="padding:18px 18px 8px;margin-bottom:18px">
          <div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px;margin-bottom:8px">
            <h3 style="font-size:1.15rem">${h(g.titel)}</h3><span class="hinweis">${h(g.kuenstler)}</span>
            <span class="marke">${h([TYP_NAMEN[g.typ] || g.typ, ...(g.zusatz || []).map((z) => ZUSATZ_NAMEN[z] || z)].join(' · '))}</span>${g.erstjahr ? `<span class="marke">${g.erstjahr}</span>` : ''}
            <span class="hinweis" style="font-size:.85rem">${tn(g.editionen.length, '{n} Edition', '{n} Editionen')}${g.vollstaendig ? '' : t(' (aus der Suche)')}</span>
            <a href="https://musicbrainz.org/release-group/${h(g.mbid)}" target="_blank" rel="noopener" style="font-size:.85rem;margin-left:auto">${t('bei MusicBrainz ↗')}</a>
          </div>
          <div class="tabelle-scroll"><table class="abgleich-tabelle"><thead><tr><th></th><th>${t('Datum')}</th><th>${t('Land')}</th><th>${t('Format')}</th><th>${t('Titel ')}</th><th>${t('Label / Katalognr.')}</th><th>Barcode</th><th></th></tr></thead><tbody>
          ${eds.map((e) => `<tr class="abgleich-zeile${e.trackanzahl_passt ? ' passt' : ''}${e.verknuepft ? ' verknuepft' : ''}" data-mbid="${h(e.mbid)}" tabindex="0">
            <td style="width:60px"><span class="mb-thumb"><img src="/api/v1/admin/mb-cover/${h(e.mbid)}?g=250" alt="" loading="lazy" data-mb-thumb></span></td>
            <td>${h(mbDatum(e.datum) || '–')}</td><td>${h(e.land ? land(e.land) : '–')}</td>
            <td>${h(e.format || '–')}<br><span class="marke${e.trackanzahl_passt ? ' marke-gut' : ''}">${t('{x} Titel', { x: e.medien.length > 1 ? e.medien.join(' + ') : e.tracks })}</span></td>
            <td>${h(e.titel)}${e.kommentar ? `<br><small>${h(e.kommentar)}</small>` : ''}${e.status && e.status !== 'Official' ? `<br><small>${h(e.status === 'Bootleg' ? 'Bootleg' : e.status === 'Promotion' ? 'Promo' : e.status)}</small>` : ''}${e.verknuepft ? `<br><span class="marke marke-akzent">${t('aktuell verknüpft')}</span>` : ''}</td>
            <td><small>${h(e.labels || '–')}</small></td><td><small>${h(e.barcode || '–')}</small></td>
            <td><button type="button" class="btn btn-zweit btn-klein" data-vergleich="${h(e.mbid)}">${t('Vergleichen')}</button></td></tr>`).join('')}
          </tbody></table></div></div>`;
      }).join('');
      box.innerHTML = `<div class="filterleiste">
          <span class="hinweis">${tn(ergebnis.gruppen.length, '{a} Editionen in {n} Album gefunden', '{a} Editionen in {n} Alben gefunden', { a: ergebnis.anzahl })}</span><span class="abstand"></span>
          <label class="checkbox-zeile" style="margin:0"><input type="checkbox" data-fp ${filter.passend ? 'checked' : ''}> ${t('Nur passende Titelanzahl ({n})', { n: ed.dateien })}</label>
          <select data-fl><option value="">${t('Alle Länder')}</option>${[...laender].sort((a, b) => land(a).localeCompare(land(b), locale)).map((l) => `<option value="${h(l)}" ${filter.land === l ? 'selected' : ''}>${h(land(l))}</option>`).join('')}</select>
          <select data-ff><option value="">${t('Alle Formate')}</option>${[...formate].sort().map((f) => `<option value="${h(f)}" ${filter.format === f ? 'selected' : ''}>${h(f)}</option>`).join('')}</select>
        </div>${gruppenHtml || leer(t('Keine Edition passt zu den Filtern'))}`;
      box.querySelector('[data-fp]').addEventListener('change', (e) => { filter.passend = e.target.checked; zeichnen(); });
      // Gibt es bei MusicBrainz kein Cover (404), bleibt der Platz leer
      box.querySelectorAll('[data-mb-thumb]').forEach((i) => i.addEventListener('error', () => { i.style.visibility = 'hidden'; }));
      box.querySelector('[data-fl]').addEventListener('change', (e) => { filter.land = e.target.value; zeichnen(); });
      box.querySelector('[data-ff]').addEventListener('change', (e) => { filter.format = e.target.value; zeichnen(); });
    };
    const suchen = async (titel, kuenstler) => {
      box.innerHTML = `<div class="glass-panel" style="text-align:center"><div class="lade" style="padding:20px 0"></div><p class="hinweis" style="margin:0">${t('Suche alle Editionen bei MusicBrainz … Das dauert ein paar Sekunden, weil MusicBrainz nur eine Anfrage pro Sekunde erlaubt.')}</p></div>`;
      try {
        ergebnis = await api.get(`/admin/editionen/${id}/mb-suche?titel=${encodeURIComponent(titel)}&kuenstler=${encodeURIComponent(kuenstler)}`, { signal });
        if (!ergebnis.gruppen.length) {
          box.innerHTML = leer(t('Nichts gefunden'), t('MusicBrainz kennt kein passendes Album. Versuche einen anderen Titel oder lass den Künstler leer.'));
          return;
        }
        zeichnen();
      } catch (e) {
        if (e.name !== 'AbortError') box.innerHTML = `<div class="fehler">${h(e.message)}</div>`;
      }
    };
    // Nach dem Übernehmen schließt „OK“ nur das Fenster; die Seite wird an Ort und Stelle aufgefrischt (Verknüpfung, Titelzahl …)
    const nachVergleich = async (p) => { if (await p && !app.vomAbgleichZurueck()) app.navigieren(location.pathname + location.search, false, true); };
    ziel.querySelector('[data-suche]').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      suchen(String(f.get('titel')).trim(), String(f.get('kuenstler')).trim());
    });
    box.addEventListener('click', (e) => {
      const z = e.target.closest('[data-vergleich], .abgleich-zeile');
      if (z) nachVergleich(vergleichZeigen(app, ed, z.dataset.vergleich || z.dataset.mbid));
    });
    box.addEventListener('keydown', (e) => { const z = e.target.closest('.abgleich-zeile'); if (z && e.key === 'Enter') nachVergleich(vergleichZeigen(app, ed, z.dataset.mbid)); });
    ziel.querySelector('[data-loesen]')?.addEventListener('click', async () => {
      if (!(await bestaetigen(t('Verknüpfung lösen?'), t('Die Edition wird wieder aus den Datei-Tags aufgebaut (Einlesen startet automatisch). Von Hand Gepflegtes bleibt erhalten.'), t('Lösen'), true))) return;
      if (await versuche(() => api.post(`/admin/editionen/${id}/mb-loesen`), t('Verknüpfung gelöst – Einlesen läuft')) && !app.vomAbgleichZurueck()) app.navigieren('/verwaltung/bibliothek');
    });
    suchen(ed.album_titel, ed.kuenstler_text === 'Various Artists' ? '' : ed.kuenstler_text);
  },

  /** Alte Adresse: Server-Einstellungen sind jetzt unter /einstellungen */
  async einstellungen({ app }) {
    history.replaceState(history.state, '', '/einstellungen/bibliothek');
    await app.navigieren('/einstellungen/bibliothek', false);
  },

  /** Sicherheitsprotokoll (früher unter „System“; Sicherung, Update, Direktzugang, Räume sind jetzt in den Einstellungen) */
  async protokoll({ app, ziel, signal }) {
    const log = await api.get('/admin/sicherheitslog', { signal });
    ziel.innerHTML = tabs('/verwaltung/protokoll') + kopf(t('Sicherheitsprotokoll'), `${h(app.ich.app.name)} ${h(app.ich.app.version)} · ${t('Anmeldungen, Sperren, Passwort- und Rechteänderungen')}`) + `
      <div class="glass-panel" style="padding:8px"><div class="tabelle-scroll"><table><thead><tr><th>${t('Zeit')}</th><th>${t('Ereignis')}</th><th>${t('Nutzer')}</th><th>Details</th><th>IP</th></tr></thead>
      <tbody>${log.eintraege.map((z) => `<tr><td><small>${datumZeit(z.zeit)}</small></td><td>${h(ereignisText(z.ereignis))}</td><td>${h(z.nutzer || '–')}</td><td><small>${h(z.details || '')}</small></td><td><small>${h(z.ip || '')}</small></td></tr>`).join('')}</tbody></table></div></div>`;
  },

  /** Alte Adresse „System“ → Protokoll */
  async system({ app }) {
    history.replaceState(history.state, '', '/verwaltung/protokoll');
    await app.navigieren('/verwaltung/protokoll', false);
  },
};

// ---------------------------------------------------------------------------------------------
// Raumklang – Räume (Impulsantworten): Voxengo laden, eigene hochladen (Einstellungen → Räume)
export function raeumePanel(raeume, signal) {
    // ---- Raumklang: Impulsantworten ----
    const raeumeZeichnen = (r, meldung = '') => {
      const v = r.voxengo;
      const eigene = r.irs.filter((x) => x.quelle === 'eigene');
      const vox = r.irs.filter((x) => x.quelle === 'voxengo');
      raeume.innerHTML = `<h2 style="font-size:1.15rem">${t('Raumklang – Räume (Impulsantworten)')}</h2>
        <p class="hinweis">${t('Echte Räume für den Hall der Surrounds. Die Presets wählen automatisch einen passenden Raum (Dezent: Salon, Raum: großer gedämpfter Raum, Halle: Musikvereinssaal, Live: Scala Mailand); jedes Gerät kann im Raumklang-Menü des Players auch einen bestimmten wählen.')}</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0">
          ${v.installiert
            ? `<span class="hinweis" style="margin:0">${t('✓ Voxengo IM Reverbs: {n} Räume', { n: vox.length })}</span><button type="button" class="btn btn-zweit" data-vox-weg>${t('Entfernen')}</button>`
            : `<button type="button" class="btn" data-vox-laden>${t('Voxengo IM Reverbs laden (ca. 7 MB)')}</button>`}
        </div>
        <p class="hinweis" style="font-size:.8rem">${t('Voxengo IM Reverbs © Aleksey Vaneev, <a href="https://www.voxengo.com/impulses/" target="_blank" rel="noopener">voxengo.com/impulses</a> – kostenlos nutzbar, nicht verkaufen. Dein Server lädt das Paket selbst herunter; es wird nicht mit Amberwave ausgeliefert.')}</p>
        <label for="ir-datei" style="margin-top:12px">${t('Eigene Impulsantwort (WAV, Stereo empfohlen)')}</label>
        <input id="ir-datei" type="file" accept=".wav,audio/wav" data-ir-datei>
        ${eigene.length ? `<div style="margin-top:10px">${eigene.map((x) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 0"><span>${h(x.name)} <small style="color:var(--text-muted)">${groesse(x.groesse)}</small></span><button type="button" class="btn btn-zweit btn-klein" data-ir-weg="${h(x.id)}">${t('Löschen')}</button></div>`).join('')}</div>` : ''}
        ${meldung ? `<p class="hinweis" style="color:var(--accent-text);margin-top:8px">${h(meldung)}</p>` : ''}`;
      raeume.querySelector('[data-vox-laden]')?.addEventListener('click', async (e) => {
        e.target.disabled = true; e.target.textContent = t('Lädt herunter …');
        try { const n = await api.post('/admin/raumklang/voxengo', {}); raeumeZeichnen(n, t('{n} Räume geladen.', { n: n.anzahl })); }
        catch (err) { raeumeZeichnen(r, err.message); }
      });
      raeume.querySelector('[data-vox-weg]')?.addEventListener('click', async () => {
        if (!(await bestaetigen(t('Voxengo-Räume entfernen?'), t('Geräte mit „Automatisch“ nutzen dann den eingebauten Hall.'), t('Entfernen')))) return;
        raeumeZeichnen(await api.del('/admin/raumklang/ir?id=' + encodeURIComponent(vox[0].id)));
      });
      raeume.querySelectorAll('[data-ir-weg]').forEach((b) => b.addEventListener('click', async () => {
        raeumeZeichnen(await api.del('/admin/raumklang/ir?id=' + encodeURIComponent(b.dataset.irWeg)));
      }));
      raeume.querySelector('[data-ir-datei]').addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const fd = new FormData(); fd.append('ir', f);
        try { const n = await api.post('/admin/raumklang/ir', fd); raeumeZeichnen(n, t('Hochgeladen.')); }
        catch (err) { raeumeZeichnen(r, err.message); }
      });
    };
    api.get('/raumklang/irs', { signal }).then((r) => raeumeZeichnen(r)).catch(() => { raeume.hidden = true; });

}

// ---------------------------------------------------------------------------------------------
// Datensicherung: nächtlich, von Hand, Liste mit Herunterladen / Wiederherstellen / Löschen
export function sicherungPanel(box, signal) {
  const zeichnen = (r, meldung = '') => {
    const stunden = [-1, ...Array.from({ length: 24 }, (_, i) => i)];
    const fehler = r.meldung.startsWith('FEHLER');
    box.innerHTML = `<h2 style="font-size:1.15rem">${t('Datensicherung')}</h2>
      <p class="hinweis">${t('Sichert die Datenbank (Bibliothek, Konten, Playlists, Einstellungen, Hörverlauf) – {zeit}. Aufbewahrt werden die letzten {tage} täglichen und {wochen}; von Hand angelegte bleiben, bis du sie löschst. Ordner: <code>{ordner}</code>. Musik und Cover liegen in deinem Musikordner und sind nicht Teil dieser Sicherung.', { zeit: r.stunde < 0 ? t('<strong>die nächtliche Sicherung ist aus</strong>') : t('jede Nacht ab {h} Uhr', { h: r.stunde }), tage: r.tage, wochen: r.wochen ? t('zusätzlich je Woche eine für weitere {n} Wochen', { n: r.wochen }) : t('keine wöchentlichen'), ordner: h(r.ordner) })}</p>
      ${r.meldung ? `<p class="hinweis" style="${fehler ? 'color:var(--danger)' : ''}">${h(r.meldung)}</p>` : ''}
      <form data-s-einst style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin:12px 0">
        <div><label for="s-stunde">${t('Nachts um')}</label><select id="s-stunde" name="sicherung_stunde">${stunden.map((s) => `<option value="${s}" ${r.stunde === s ? 'selected' : ''}>${s < 0 ? t('aus') : t('{n} Uhr', { n: s })}</option>`).join('')}</select></div>
        <div><label for="s-tage">${t('Tägliche behalten')}</label><input id="s-tage" name="sicherung_tage" type="number" min="1" max="365" value="${r.tage}" style="width:7em"></div>
        <div><label for="s-wochen">${t('Wöchentliche behalten')}</label><input id="s-wochen" name="sicherung_wochen" type="number" min="0" max="104" value="${r.wochen}" style="width:7em"></div>
        <button type="submit" class="btn btn-zweit">${t('Speichern')}</button>
        <button type="button" class="btn" data-s-jetzt>${t('Jetzt sichern')}</button>
      </form>
      ${meldung ? `<p class="hinweis" style="color:var(--accent-text)">${h(meldung)}</p>` : ''}
      ${r.laeuft ? `<p class="hinweis" style="color:var(--danger)">${t('Gerade läuft eine Wiederherstellung …')}</p>` : ''}
      ${r.liste.length ? `<div class="tabelle-scroll"><table><thead><tr><th>${t('Stand')}</th><th>${t('Art')}</th><th>${t('Größe')}</th><th></th></tr></thead><tbody>
        ${r.liste.map((s) => `<tr><td>${datumZeit(s.zeit)}</td><td>${h(s.art_text)}${s.woche ? ` <span class="pille" style="cursor:default">${t('Wochensicherung')}</span>` : ''}</td><td><small>${groesse(s.groesse)}</small></td>
          <td style="text-align:right;white-space:nowrap">
            <a class="btn btn-zweit btn-klein" href="${h('/api/v1/admin/sicherungen/datei?name=' + encodeURIComponent(s.name))}" download>${t('Herunterladen')}</a>
            <button type="button" class="btn btn-zweit btn-klein" data-s-zurueck="${h(s.name)}" data-s-zeit="${h(s.zeit)}">${t('Wiederherstellen')}</button>
            ${s.art !== 'update' ? `<button type="button" class="btn btn-zweit btn-klein" data-s-weg="${h(s.name)}" aria-label="${t('Löschen')}">${icon('muell', 16)}</button>` : ''}
          </td></tr>`).join('')}</tbody></table></div>` : `<p class="hinweis">${t('Noch keine Sicherung vorhanden.')}</p>`}`;

    box.querySelector('[data-s-einst]').addEventListener('submit', (e) => versuche(async () => {
      e.preventDefault();
      const f = new FormData(e.target);
      await api.put('/admin/einstellungen', { einstellungen: Object.fromEntries(['sicherung_stunde', 'sicherung_tage', 'sicherung_wochen'].map((k) => [k, String(f.get(k))])) });
      zeichnen(await api.get('/admin/sicherungen'), t('Gespeichert. Überzählige alte Sicherungen werden bei der nächsten Sicherung entfernt.'));
    }));
    box.querySelector('[data-s-jetzt]').addEventListener('click', (e) => versuche(async () => {
      e.target.disabled = true; e.target.textContent = t('Sichere …');
      try { const n = await api.post('/admin/sicherungen', {}); zeichnen(n, t('Sicherung angelegt.')); }
      finally { e.target.disabled = false; e.target.textContent = t('Jetzt sichern'); }
    }));
    box.querySelectorAll('[data-s-weg]').forEach((b) => b.addEventListener('click', () => versuche(async () => {
      if (!(await bestaetigen(t('Sicherung löschen?'), t('Die Datei wird endgültig aus dem Backup-Ordner entfernt.'), t('Löschen'), true))) return;
      zeichnen(await api.del('/admin/sicherungen?name=' + encodeURIComponent(b.dataset.sWeg)));
    })));
    box.querySelectorAll('[data-s-zurueck]').forEach((b) => b.addEventListener('click', async () => {
      if (await sicherungWiederherstellen(b.dataset.sZurueck, b.dataset.sZeit)) zeichnen(await api.get('/admin/sicherungen'));
    }));
  };
  api.get('/admin/sicherungen', { signal }).then((r) => zeichnen(r)).catch((e) => { box.innerHTML = `<h2 style="font-size:1.15rem">${t('Datensicherung')}</h2><p class="hinweis">${h(e.message)}</p>`; });
}

/** Eine Sicherung zurückspielen (mit Bestätigung durch Eintippen). Liefert true, wenn die Liste neu geladen werden soll. */
export async function sicherungWiederherstellen(name, zeit) {
  const stand = datumZeit(zeit);
  // Das Bestätigungswort wird je Sprache getippt; an den Server geht immer das deutsche (dort wird es so geprüft)
  const bestaetigungsWort = t('WIEDERHERSTELLEN');
  const antwort = await dialog({
    titel: t('Datenbank wiederherstellen?'),
    inhalt: `<p>${t('Die gesamte Datenbank wird auf den Stand vom <strong>{stand}</strong> zurückgesetzt. Alles, was seitdem geändert wurde – Metadaten, Playlists, Konten, Hörverlauf, Einstellungen – ist danach nicht mehr da.', { stand: h(stand) })}</p>
      <p class="hinweis">${t('Vorher wird der aktuelle Stand automatisch gesichert („Vor Wiederherstellung“), damit du es rückgängig machen kannst. Die Sicherung wird zuerst vollständig geprüft; schlägt das Einspielen fehl, wird der vorherige Stand automatisch zurückgespielt. Musikdateien werden nicht angefasst. Laufende Aufträge pausieren solange. Geräte, die sich nach dem Sicherungsstand angemeldet haben, müssen sich danach neu anmelden – womöglich auch du.')}</p>
      <label for="s-best">${t('Zur Bestätigung <strong>{wort}</strong> eintippen', { wort: bestaetigungsWort })}</label>
      <input id="s-best" name="bestaetigung" autocomplete="off" required pattern="${bestaetigungsWort}">
      <label for="s-pw">${t('Zur Sicherheit: dein Anmelde-Passwort')}</label><input id="s-pw" type="password" name="passwort" required autocomplete="current-password">`,
    knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Wiederherstellen'), wert: 'ja', art: 'gefahr' }],
  });
  if (!antwort) return false;
  const ergebnis = await dialog({ titel: t('Wiederherstellung läuft …'), inhalt: `<pre class="log" data-s-log>${t('Prüfe die Sicherung und spiele sie ein. Bitte das Fenster offen lassen.')}</pre>`, knoepfe: [{ text: t('Schließen'), wert: 'ok', art: 'haupt' }],
    beimOeffnen: async (d) => {
      const log = d.querySelector('[data-s-log]');
      const knopf = d.querySelector('.dialog-fuss button');
      knopf.disabled = true;
      try {
        const r = await api.post('/admin/sicherungen/wiederherstellen', { name, bestaetigung: antwort.form.get('bestaetigung') === bestaetigungsWort ? 'WIEDERHERSTELLEN' : antwort.form.get('bestaetigung'), passwort: antwort.form.get('passwort') || '' });
        log.textContent = (r.ok ? t('✓ Wiederhergestellt.') : t('✗ Nicht wiederhergestellt.')) + '\n\n' + r.log.join('\n') + (r.ok ? '\n\n' + t('Beim Schließen lädt die App neu.') : '');
        d.dataset.neuLaden = r.ok ? '1' : '';
      } catch (err) { log.textContent = err.message; }
      knopf.disabled = false;
    } });
  if (ergebnis?.element?.dataset.neuLaden === '1') { location.reload(); return false; }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Erkennung am Klang: Fingerabdruck → AcoustID → MusicBrainz; Fortschritt und Vorschläge zum Bestätigen
const ERK_MARKE = { regeln: 'marke-akzent', eindeutig: 'marke-gut', unsicher: '', uebernommen: 'marke-gut', doppelt: '', fehler: '' };
function erkennungPanel(app, box, signal, nachher) {
  let timer = null;
  let offenListe = false;
  const offeneKand = new Set(); // Alben, bei denen „weitere Editionen geprüft“ aufgeklappt ist (überlebt das Neuzeichnen alle 5 s)
  const kandText = (k) => [k.titel + (k.zusatz ? ` (${k.zusatz})` : ''), k.format, k.land ? land(k.land) : '', mbDatum(k.datum), t('{n} Titel', { n: k.tracks })].filter(Boolean).join(' · ');
  const zeichnen = (r) => {
    clearTimeout(timer);
    const s = r.status || {};
    const proz = r.editionen ? Math.floor((r.alben_fertig / r.editionen) * 100) : 100;
    const pruefen = r.liste.filter((l) => l.status !== 'uebernommen' || l.pruefen || /prüfen/.test(l.info));
    const pille = (n, text, warn = false) => (n ? `<span class="pille" style="cursor:default${warn ? ';border-color:rgba(255,181,71,.6)' : ''}">${zahl(n)} ${text}</span>` : '');
    const zeile = (l) => {
      const vorschlag = l.kandidaten.find((k) => k.mbid === l.mbid) || null;
      const weitere = l.kandidaten.filter((k) => k !== vorschlag);
      return `<div class="erk-zeile" data-ed="${l.edition_id}">
        <div class="erk-kopf">
          <div style="min-width:0"><b>${h(l.album_titel)}</b> <span class="hinweis">${h(l.kuenstler)}</span><br><small class="hinweis" title="${h(l.ordner)}">${h(l.ordner)}</small></div>
          <span class="marke ${ERK_MARKE[l.status] ?? ''}">${h(l.status_text)}${l.sicherheit ? ` · ${l.sicherheit} %` : ''}</span>
        </div>
        <p class="hinweis" style="margin:6px 0 0;font-size:.85rem">${h(l.info)}</p>
        ${vorschlag ? `<p style="margin:6px 0 0;font-size:.9rem">${l.status === 'uebernommen' ? t('Übernommen') : t('Vorschlag')}: ${h(kandText(vorschlag))}</p>` : ''}
        <div class="zeilen-knoepfe" style="margin-top:8px">
          ${l.klang_moeglich && r.schluessel && r.werkzeug ? `<button type="button" class="btn btn-klein" data-erk-klang>${t('Am Klang erkennen')}</button>` : ''}
          ${vorschlag && l.status !== 'uebernommen' ? `<button type="button" class="btn btn-klein" data-erk-vergleich="${h(vorschlag.mbid)}">${t('Vergleichen &amp; übernehmen')}</button>` : ''}
          ${l.status === 'uebernommen' ? `<a class="btn btn-zweit btn-klein" href="/alben/${l.album_id}?edition=${l.edition_id}" data-link>${t('Zum Album')}</a><button type="button" class="btn btn-zweit btn-klein" data-erk-ok>${t('Passt')}</button>` : ''}
          <a class="btn btn-zweit btn-klein" href="/verwaltung/abgleich/${l.edition_id}" data-link>${t('Selbst suchen')}</a>
          ${l.status !== 'uebernommen' ? `<button type="button" class="btn btn-zweit btn-klein" data-erk-ignorieren>${t('Ignorieren')}</button>` : ''}
        </div>
        ${weitere.length ? `<details class="erk-weitere" ${offeneKand.has(l.edition_id) ? 'open' : ''} style="margin-top:8px"><summary class="hinweis" style="cursor:pointer;font-size:.85rem">${tn(weitere.length, '{n} weitere Edition geprüft', '{n} weitere Editionen geprüft')}</summary>
          ${weitere.map((k) => `<div class="erk-kand"><span>${h(kandText(k))}</span><span class="hinweis">${k.sicherheit} %${k.abw != null ? ` · Ø ${String(k.abw).replace('.', locale.startsWith('de') ? ',' : '.')} s` : ''}</span><button type="button" class="pille" data-erk-vergleich="${h(k.mbid)}">${t('Vergleichen')}</button></div>`).join('')}</details>` : ''}
      </div>`;
    };
    box.innerHTML = `<div style="display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px">
        <div style="flex:1 1 420px"><h2 style="font-size:1.15rem;margin-bottom:4px">${t('Alben mit MusicBrainz verknüpfen')}</h2>
          <p class="hinweis" style="margin:0">${t('Zuerst über die Tags: Interpret, Titel oder die MusicBrainz-ID, dazu Titelzahl, Reihenfolge und Laufzeiten – das fragt AcoustID nicht. Nur Alben ohne brauchbare Tags bekommen automatisch einen akustischen Fingerabdruck; bei allem Unsicheren entscheidest du, ob der Klang gefragt wird{gruendlich}. An deinen Dateien ändert sich nichts. {auto}', { gruendlich: r.modus === 'gruendlich' ? t(' (Einstellung „gründlich“: das geschieht automatisch)') : '', auto: r.auto === 'aus' ? t('Alles kommt zur Bestätigung hierher.') : r.auto === 'eindeutig' ? t('Eindeutiges wird automatisch übernommen, alles andere kommt hierher.') : t('Eindeutiges wird automatisch übernommen; bei gleicher Titelliste auf mehreren Editionen wählen Regeln (offiziell, Format passend zu deinen Dateien, Land, frühestes Datum) – diese Alben stehen unten zum Prüfen.') })}</p></div>
        ${r.aktiv ? `<div class="zeilen-knoepfe">${r.offen ? `<button type="button" class="btn ${r.laeuft ? 'btn-zweit' : ''}" data-erk-start ${r.laeuft ? 'disabled' : ''}>${r.laeuft ? t('Läuft …') : t('Jetzt starten')}</button>` : ''}
          ${r.wartet && r.schluessel && r.werkzeug ? `<button type="button" class="btn btn-zweit btn-klein" data-erk-klang-alle>${t('{n} unsichere am Klang erkennen', { n: zahl(r.wartet) })}</button>` : ''}
          <button type="button" class="btn btn-zweit btn-klein" data-erk-neu="unsicher">${t('Unsichere neu prüfen')}</button></div>` : ''}
      </div>
      ${!r.aktiv ? `<p class="hinweis" style="color:var(--accent-text)">${t('Abgeschaltet (<code>ERKENNUNG_AKTIV=0</code>).')}</p>`
        : `${!r.schluessel ? `<p class="hinweis" style="margin:12px 0 0">${t('Die Zuordnung über Tags läuft schon. Für Alben ohne Tags und für den Knopf „Am Klang erkennen“ trage unter <a href="/einstellungen/dienste" data-link>Einstellungen → Dienste</a> einen kostenlosen AcoustID-Schlüssel ein (acoustid.org → „Register an application“).')}</p>`
          : !r.werkzeug ? `<p class="hinweis" style="margin:12px 0 0;color:var(--danger)">${t('Kein Fingerabdruck-Werkzeug im Container: ffmpeg ohne Chromaprint und kein <code>fpcalc</code>. Die Zuordnung über Tags läuft trotzdem.')}</p>` : ''}
        <div class="fortschritt" style="margin:12px 0 6px"><i style="width:${proz}%"></i></div>
        <p class="hinweis" style="margin:0">${t('{a} von {e} Alben erledigt ({p} %), {m} davon mit MusicBrainz verknüpft · {tags} über die Tags, {k} am Klang{x}{y}', { a: zahl(r.alben_fertig), e: zahl(r.editionen), p: proz, m: zahl(r.abgeglichen), tags: zahl(r.ueber_tags), k: zahl(r.ueber_klang), x: r.abgefragt ? t(' ({n} von {m} abgefragten Titeln erkannt)', { n: zahl(r.erkannt), m: zahl(r.abgefragt) }) : '', y: r.offen ? t(' · {n} Alben noch offen{l}', { n: zahl(r.offen), l: r.laeuft ? t(' · läuft gerade …') : '' }) : '' })}</p>
        <div class="pillen" style="margin-top:10px">${pille(s.uebernommen, t('automatisch übernommen'))}${pille(s.bestaetigt, t('von Hand übernommen'))}${pille(s.regeln, t('Edition nach Regeln'), true)}${pille(s.eindeutig, t('eindeutig, wartet'), true)}${pille(s.unsicher, t('unsicher'), true)}${pille(s.nichts, t('nicht erkannt'))}${pille(r.klang_offen, t('warten auf den Klang'))}${pille(s.doppelt, t('doppelt'))}${pille(s.ignoriert, t('ignoriert'))}${pille(s.fehler, t('Fehler '), true)}</div>`}
      ${r.fehler ? `<p class="hinweis" style="margin:10px 0 0;color:var(--danger)">${h(r.fehler)}</p>` : ''}
      ${pruefen.length ? `<details class="erk-liste" ${offenListe ? 'open' : ''}><summary style="cursor:pointer;margin-top:14px"><b>${tn(pruefen.length, '{n} Album zum Prüfen', '{n} Alben zum Prüfen')}</b></summary>${pruefen.map(zeile).join('')}</details>` : ''}`;
    // Nur echte Klicks des Nutzers merken (summary), nicht das „toggle“, das beim Neuzeichnen von selbst feuert
    box.querySelector('.erk-liste > summary')?.addEventListener('click', () => { offenListe = !box.querySelector('.erk-liste').open; });
    box.querySelectorAll('.erk-weitere > summary').forEach((sm) => sm.addEventListener('click', () => {
      const dt = sm.parentElement, id = Number(dt.closest('[data-ed]').dataset.ed);
      if (dt.open) offeneKand.delete(id); else offeneKand.add(id);
    }));
    box.querySelector('[data-erk-start]')?.addEventListener('click', async () => zeichnen(await api.post('/admin/erkennung/start', {})));
    box.querySelector('[data-erk-klang-alle]')?.addEventListener('click', async () => zeichnen(await api.post('/admin/erkennung/klang', {})));
    box.querySelectorAll('[data-erk-klang]').forEach((b) => b.addEventListener('click', async () => zeichnen(await api.post(`/admin/erkennung/${b.closest('[data-ed]').dataset.ed}/klang`, {}))));
    box.querySelector('[data-erk-neu]')?.addEventListener('click', async () => zeichnen(await api.post('/admin/erkennung/neu', { was: 'unsicher' })));
    box.querySelectorAll('[data-erk-vergleich]').forEach((b) => b.addEventListener('click', async () => {
      const ed = Number(b.closest('[data-ed]').dataset.ed);
      await vergleichZeigen(app, { id: ed }, b.dataset.erkVergleich);
      if (box.isConnected) { holen(); nachher?.(); }
    }));
    box.querySelectorAll('[data-erk-ignorieren]').forEach((b) => b.addEventListener('click', async () => zeichnen(await api.post(`/admin/erkennung/${b.closest('[data-ed]').dataset.ed}/ignorieren`, {}))));
    box.querySelectorAll('[data-erk-ok]').forEach((b) => b.addEventListener('click', async () => zeichnen(await api.post(`/admin/erkennung/${b.closest('[data-ed]').dataset.ed}/erledigt`, {}))));
    if (r.aktiv && (r.laeuft || r.offen || r.klang_offen)) timer = setTimeout(holen, 5000);
  };
  const holen = () => {
    if (signal?.aborted || !box.isConnected) return;
    api.get('/admin/erkennung').then(zeichnen).catch(() => { box.hidden = true; });
  };
  signal?.addEventListener('abort', () => clearTimeout(timer));
  holen();
}

// ---------------------------------------------------------------------------------------------
// Dateien aufräumen: Tags/Cover in die Dateien, Umbenennen nach Schema, Müll weg – Vorschau, dann Freigabe
const AF_STATUS = { offen: t('Vorschau'), freigegeben: t('freigegeben'), laeuft: t('läuft …'), fertig: t('erledigt'), fehler: t('mit Fehlern') };
const FELD_NAMEN = { TITLE: t('Titel '), ARTIST: t('Interpret'), ARTISTS: t('Interpreten (einzeln)'), ALBUM: 'Album', ALBUMARTIST: t('Albuminterpret'), ALBUMARTISTS: t('Albuminterpreten (einzeln)'),
  TRACKNUMBER: t('Titelnr.'), TRACKTOTAL: t('Titel gesamt'), DISCNUMBER: t('CD-Nr.'), DISCTOTAL: t('CDs gesamt'), DATE: t('Datum'), ORIGINALDATE: t('Erstveröffentlichung'), GENRE: 'Genre',
  LABEL: 'Label', CATALOGNUMBER: t('Katalognr.'), BARCODE: 'Barcode', RELEASECOUNTRY: t('Land'), MEDIA: 'Medium', COMPOSER: t('Komponist'), LYRICIST: t('Texter'), PRODUCER: t('Produzent'),
  PERFORMER: t('Musiker'), MIXER: 'Mix', ENGINEER: t('Toningenieur'), ARRANGER: t('Arrangement'), CONDUCTOR: t('Dirigent'), WORK: t('Werk'), AMBERWAVE_EDITION: 'Edition',
  REPLAYGAIN_TRACK_GAIN: t('ReplayGain Titel'), REPLAYGAIN_ALBUM_GAIN: 'ReplayGain Album' };

/** Plan eines Albums ansehen (und freigeben) */
async function aufraeumPlanZeigen(app, editionId, nachher) {
  const r = await versuche(() => api.get(`/admin/aufraeumen/${editionId}`));
  if (!r) return;
  const p = r.plan || { dateien: [], muell: [], sonstige: [], probleme: [] };
  const name = (x) => (x ? x.split('/').slice(-1).join('/') : '');
  const erstesMitDiff = p.dateien.find((d) => d.unterschiede.length);
  const zeile = (d) => `<tr>
      <td><small>${h(name(d.von))}</small>${d.nach ? `<br><b>→ ${h(name(d.nach))}</b>` : ''}</td>
      <td class="zahl">${d.unterschiede.length ? tn(d.unterschiede.length, '1 Feld', '{n} Felder') : '–'}</td>
      <td>${d.cover ? '✓' : ''}</td>
      <td>${d.hinweis ? `<small style="color:var(--accent-text)">${h(d.hinweis)}</small>` : ''}</td></tr>`;
  const knoepfe = r.status === 'offen' && r.aenderungen
    ? [{ text: t('Schließen'), wert: 'zu', art: 'zweit' }, { text: t('Freigeben & ausführen'), wert: 'ok' }]
    : [{ text: t('Schließen'), wert: 'zu' }];
  const d = await dialog({
    titel: t('Dateien aufräumen'),
    breit: true,
    inhalt: `<div style="display:flex;flex-wrap:wrap;gap:6px 14px;align-items:baseline;margin-bottom:8px"><b style="font-size:1.05rem">${h(r.album_titel)}</b><span class="hinweis">${h(r.kuenstler)}</span><span class="marke">${h(AF_STATUS[r.status] || r.status)}</span></div>
      <p style="margin:0 0 6px">${h(r.zusammenfassung)}</p>
      ${p.ordner_neu && p.ordner_alt !== p.ordner_neu ? `<p class="hinweis" style="margin:0 0 10px;font-size:.88rem">${t('Ordner')}: <code>${h(p.ordner_alt)}</code><br>→ <code>${h(p.ordner_neu)}</code></p>` : ''}
      ${p.probleme.map((x) => `<p class="hinweis" style="color:var(--accent-text);margin:4px 0">${h(x)}</p>`).join('')}
      <div class="tabelle-scroll" style="max-height:34vh"><table><thead><tr><th>${t('Datei')}</th><th>Tags</th><th>Cover</th><th></th></tr></thead><tbody>${p.dateien.map(zeile).join('')}</tbody></table></div>
      ${erstesMitDiff ? `<details style="margin-top:10px"><summary class="hinweis" style="cursor:pointer">${h(t('Tag-Änderungen am Beispiel „{name}“', { name: name(erstesMitDiff.von) }))}</summary>
        <div class="tabelle-scroll" style="max-height:30vh"><table><thead><tr><th>${t('Feld')}</th><th>${t('bisher')}</th><th>${t('neu')}</th></tr></thead><tbody>
        ${erstesMitDiff.unterschiede.map(([f, alt, neuW]) => `<tr><td><small>${h(FELD_NAMEN[f] || f)}</small></td><td><small style="color:var(--text-leise)">${h(alt || '–')}</small></td><td><small${neuW === '' ? ' style="color:var(--danger)"' : ''}>${neuW === '' ? t('wird entfernt') : h(neuW)}</small></td></tr>`).join('')}
        </tbody></table></div></details>` : ''}
      ${p.muell.length ? `<p class="hinweis" style="margin:10px 0 0;font-size:.85rem">${t('In den Papierkorb: {liste}', { liste: p.muell.map((m) => h(m.split('/').pop())).join(', ') })}</p>` : ''}
      ${p.sonstige.length ? `<p class="hinweis" style="margin:4px 0 0;font-size:.85rem">${t('Wandert mit: {liste}', { liste: p.sonstige.map((m) => h(m.von.split('/').pop())).join(', ') })}</p>` : ''}
      ${r.log ? `<details style="margin-top:10px" ${r.status === 'fehler' ? 'open' : ''}><summary class="hinweis" style="cursor:pointer">${t('Protokoll')} ${r.ausgefuehrt_am ? datumZeit(r.ausgefuehrt_am) : ''}</summary><pre class="log">${h(r.log)}</pre></details>` : ''}
      <p class="hinweis" style="margin:10px 0 0;font-size:.8rem">${t('Alte Tags und Gelöschtes liegen danach im Papierkorb-Ordner <code>.amberwave-papierkorb</code> im Musikordner. Das Audio bleibt bitgenau (wird vor und nach dem Schreiben geprüft).')}</p>`,
    knoepfe,
  });
  if (d?.wert === 'ok' && r.status === 'offen' && r.aenderungen) { // nur der Knopf „Freigeben & ausführen“ – Schließen/✕/Esc tun nichts
    await versuche(() => api.post('/admin/aufraeumen/freigeben', { edition_ids: [editionId] }));
    toast(t('Freigegeben – läuft im Hintergrund.'));
  }
  nachher?.();
}

/** Aus dem Album-Menü: Vorschau für dieses Album erstellen und zeigen */
export async function albumAufraeumen(app, editionId) {
  toast(t('Erstelle Vorschau …'));
  const r = await versuche(() => api.post('/admin/aufraeumen/vorschau', { edition_id: editionId }));
  if (r) aufraeumPlanZeigen(app, editionId);
}

function aufraeumenPanel(app, box, signal) {
  let timer = null;
  let offenListe = false;
  let warVorschau = false;
  const zeichnen = (r, meldung = '') => {
    clearTimeout(timer);
    const s = r.status || {};
    // Vorschau für alle läuft als Auftrag auf dem Server (weiter, auch wenn die Seite zu ist)
    const va = r.auftrag || {};
    const vorschauLaeuft = va.status === 'laeuft';
    if (warVorschau && !vorschauLaeuft) offenListe = true;
    warVorschau = vorschauLaeuft;
    if (!meldung && vorschauLaeuft) {
      meldung = va.pause ? t('Vorschau: kurze Pause ({grund}) – geht von selbst weiter.', { grund: va.fehler || t('Fehler') })
        : t('Vorschau läuft auf dem Server{auto}: {a} von {g} Alben – du kannst die Seite verlassen.', { auto: va.auto ? t(' (automatisch nach dem Einlesen)') : '', a: zahl(va.geprueft), g: zahl(va.gesamt) });
    } else if (!meldung && va.meldung && (va.status === 'angehalten' || (va.status === 'fertig' && va.beendet && Date.now() - new Date(va.beendet).getTime() < 3600e3))) {
      meldung = va.meldung;
    }
    const mitAenderung = r.liste.filter((l) => l.status === 'offen' && l.aenderungen > 0 && !l.ohne_mb);
    const ohneMb = r.liste.filter((l) => l.status === 'offen' && l.aenderungen > 0 && l.ohne_mb);
    const gb = (b) => (b > 1e9 ? `${zahl(b / 1e9, 1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
    const pille = (n, text, warn = false) => (n ? `<span class="pille" style="cursor:default${warn ? ';border-color:rgba(255,181,71,.6)' : ''}">${zahl(n)} ${text}</span>` : '');
    const listeZeile = (l) => `<div class="erk-zeile" data-ed="${l.edition_id}">
        <div class="erk-kopf"><div style="min-width:0"><b>${h(l.album_titel)}</b> <span class="hinweis">${h(l.kuenstler)}</span><br><small class="hinweis" title="${h(l.ordner)}">${h(l.ordner)}</small></div>
          <span style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">${l.ohne_mb && l.status !== 'fertig' ? `<span class="marke marke-warn" title="${t('Nicht mit MusicBrainz abgeglichen – Namen kommen nur aus den Datei-Tags')}">${t('ohne MusicBrainz')}</span>` : ''}<span class="marke ${l.status === 'fertig' ? 'marke-gut' : l.status === 'freigegeben' || l.status === 'laeuft' ? 'marke-akzent' : ''}">${h(AF_STATUS[l.status] || l.status)}${l.probleme ? ` · ${tn(l.probleme, '1 Hinweis', '{n} Hinweise')}` : ''}${l.veraltet ? t(' · veraltet') : ''}</span></span></div>
        <p class="hinweis" style="margin:6px 0 0;font-size:.85rem">${h(l.zusammenfassung)}</p>
        ${l.log && l.status !== 'fertig' ? `<p class="hinweis" style="margin:4px 0 0;font-size:.8rem;color:${l.status === 'fehler' ? 'var(--danger)' : 'var(--accent-text)'}">${h(String(l.log).slice(0, 400))}</p>` : ''}
        <div class="zeilen-knoepfe" style="margin-top:8px"><button type="button" class="btn btn-zweit btn-klein" data-af-ansehen>${t('Ansehen')}</button>
          ${l.status === 'offen' && l.aenderungen ? `<button type="button" class="btn btn-klein" data-af-frei>${l.ohne_mb ? t('Trotzdem freigeben') : t('Freigeben')}</button><button type="button" class="btn btn-zweit btn-klein" data-af-weg>${t('Verwerfen')}</button>${l.ohne_mb ? `<a class="btn btn-zweit btn-klein" href="/verwaltung/abgleich/${l.edition_id}" data-link>${t('Abgleichen')}</a>` : ''}` : ''}
          ${l.status === 'fertig' || l.status === 'fehler' ? `<button type="button" class="btn btn-zweit btn-klein" data-af-neu>${t('Erneut prüfen')}</button>` : ''}</div>
      </div>`;
    const sichtbar = r.liste.filter((l) => l.status !== 'offen' || l.aenderungen > 0 || l.probleme > 0);
    box.innerHTML = `<div style="display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px">
        <div style="flex:1 1 420px"><h2 style="font-size:1.15rem;margin-bottom:4px">${t('Dateien aufräumen')}</h2>
          <p class="hinweis" style="margin:0">${t('Für abgeglichene Alben: Tags{cover} in die Dateien schreiben (FLAC, MP3, M4A – das Audio bleibt bitgenau){sauber}, Ordner und Dateien einheitlich benennen, Müll (.nfo, .sfv, .m3u, .log, .cue, Thumbs.db …) entfernen. Erst Vorschau, ausgeführt wird nur, was du freigibst.', { cover: r.schema.cover ? t(' und Cover') : '', sauber: r.schema.tags === 'sauber' ? t(', alte und fremde Tags werden dabei bereinigt (es bleiben: {x})', { x: h(r.schema.behalten.join(', ') || t('nichts')) }) : '' })}</p>
          ${r.schreibtest && !r.schreibtest.ok ? `<p class="hinweis" style="margin:8px 0 0;color:var(--danger)"><b>${t('Schreiben nicht möglich:')}</b> ${h(r.schreibtest.meldung)}${r.schreibtest.uid !== null ? ` <small>${t('(Amberwave läuft als UID {uid}/GID {gid})', { uid: r.schreibtest.uid, gid: r.schreibtest.gid })}</small>` : ''}</p>` : ''}
          <p class="hinweis" style="margin:6px 0 0;font-size:.82rem">${t('Schema:')} <code>${h(r.schema.ordner)}/${h(r.schema.datei)}</code> (<code>AUFRAEUMEN_ORDNER</code>, <code>AUFRAEUMEN_DATEI</code>)</p></div>
        <div class="zeilen-knoepfe">
          ${vorschauLaeuft ? `<button type="button" class="btn btn-zweit" data-af-halt>${t('Vorschau anhalten')}</button>`
            : `<button type="button" class="btn ${r.ohne_vorschau ? '' : 'btn-zweit'}" data-af-vorschau>${va.status === 'angehalten' && r.ohne_vorschau ? t('Vorschau fortsetzen ({n})', { n: zahl(r.ohne_vorschau) }) : r.ohne_vorschau ? t('Vorschau erstellen ({n})', { n: zahl(r.ohne_vorschau) }) : t('Vorschau neu erstellen')}</button>`}
          ${mitAenderung.length ? `<button type="button" class="btn btn-klein" data-af-alle>${t('Alle {n} freigeben', { n: zahl(mitAenderung.length) })}</button>` : ''}
        </div>
      </div>
      <div class="pillen" style="margin-top:12px">${pille(mitAenderung.length, t('mit Änderungen'), true)}${pille(ohneMb.length, t('ohne MusicBrainz (nur einzeln)'), true)}${pille(s.freigegeben, t('freigegeben'))}${pille(s.laeuft, t('läuft'))}${pille(s.fertig, t('erledigt'))}${pille(s.fehler, t('mit Fehlern'), true)}
        ${r.papierkorb.dateien ? `<span class="pille" style="cursor:default">${t('Papierkorb: {n} Dateien, {gb} · {tage} Tage', { n: zahl(r.papierkorb.dateien), gb: gb(r.papierkorb.bytes), tage: r.schema.papierkorb_tage })}</span><button type="button" class="pille" data-af-korb>${t('Papierkorb leeren')}</button>` : ''}
        <button type="button" class="pille" data-af-rechte title="${h(t('Alles, was Amberwave im Musikordner angelegt hat, auf {rechte} setzen', { rechte: r.schema.rechte || '777/666' }))}">${t('Rechte reparieren')}</button>
        <button type="button" class="pille" data-af-debug title="${t('Zeigt Schritt für Schritt, was nach der Freigabe passiert')}">${t('Debug-Protokoll')}</button></div>
      ${meldung ? `<p class="hinweis" style="margin:8px 0 0;color:var(--accent-text)">${h(meldung)}</p>` : ''}
      ${sichtbar.length ? `<details class="erk-liste" ${offenListe ? 'open' : ''}><summary style="cursor:pointer;margin-top:14px"><b>${tn(sichtbar.length, '{n} Album', '{n} Alben')}</b> <span class="hinweis">${t('(Alben ohne Änderungen sind ausgeblendet)')}</span></summary>${sichtbar.map(listeZeile).join('')}</details>` : ''}`;
    box.querySelector('.erk-liste > summary')?.addEventListener('click', () => { offenListe = !box.querySelector('.erk-liste').open; });
    box.querySelector('[data-af-vorschau]')?.addEventListener('click', async () => {
      if (!r.ohne_vorschau && !(await bestaetigen(t('Vorschau neu erstellen?'), t('Alle Pläne, die noch nicht ausgeführt wurden, werden neu berechnet. Das läuft auf dem Server im Hintergrund.'), t('Neu erstellen')))) return;
      const x = await versuche(() => api.post('/admin/aufraeumen/vorschau', { neu: !r.ohne_vorschau }));
      if (x) zeichnen(x);
    });
    box.querySelector('[data-af-halt]')?.addEventListener('click', async () => {
      const x = await versuche(() => api.post('/admin/aufraeumen/vorschau/anhalten', {}));
      if (x) zeichnen(x);
    });
    box.querySelector('[data-af-alle]')?.addEventListener('click', async () => {
      if (!(await bestaetigen(tn(mitAenderung.length, '{n} Album aufräumen?', '{n} Alben aufräumen?'), t('Tags und Cover werden in die Dateien geschrieben, Dateien umbenannt und Müll in den Papierkorb verschoben. Das läuft im Hintergrund.') + (ohneMb.length ? ' ' + tn(ohneMb.length, '{n} Album ohne MusicBrainz-Abgleich bleibt außen vor – das gibst du einzeln frei.', '{n} Alben ohne MusicBrainz-Abgleich bleiben außen vor – die gibst du einzeln frei.') : ''), t('Freigeben')))) return;
      zeichnen(await api.post('/admin/aufraeumen/freigeben', { alle: true }));
    });
    box.querySelector('[data-af-rechte]')?.addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = t('Prüfe Rechte …');
      const x = await api.post('/admin/aufraeumen/rechte', {}).catch((f) => ({ fehler: f.message }));
      if (x.fehler) { zeichnen(r, x.fehler); return; }
      zeichnen(r, t('{a} Einträge geprüft, {b} Rechte korrigiert{g}.', { a: zahl(x.geprueft), b: zahl(x.geaendert), g: x.gruppe ? t(', {n} auf die richtige Gruppe gesetzt', { n: zahl(x.gruppe) }) : '' })
        + (x.fremd ? ' ' + t('{n} gehören einem anderen Benutzer (z. B. von Windows kopiert) – die kann nur Unraid ändern: Tools → New Permissions.', { n: zahl(x.fremd) }) : '')
        + (x.unlesbar ? ' ' + t('{n} kann Amberwave nicht lesen.', { n: zahl(x.unlesbar) }) : ''));
    });
    box.querySelector('[data-af-debug]')?.addEventListener('click', async () => {
      const x = await versuche(() => api.get('/admin/aufraeumen/debug'));
      if (!x) return;
      await dialog({
        titel: t('Debug-Protokoll (Aufräumen)'),
        breit: true,
        inhalt: `<p class="hinweis" style="margin-top:0">${t('Zeigt die letzten Schritte nach einem Klick auf „Freigeben“. Datei im Container: <code>{pfad}</code>', { pfad: h(x.pfad) })}</p>`
          + (x.leer ? `<p class="hinweis">${t('Noch nichts aufgezeichnet. Klick erst auf „Freigeben“ und öffne das Protokoll dann erneut.')}</p>`
            : `<pre class="log" style="max-height:60vh;overflow:auto;white-space:pre-wrap;font-size:.82rem">${h(x.zeilen.join('\n'))}</pre>`),
        knoepfe: [{ text: t('Schließen'), wert: 'zu' }],
      });
    });
    box.querySelector('[data-af-korb]')?.addEventListener('click', async () => {
      if (!(await bestaetigen(t('Papierkorb leeren?'), t('Alles im Papierkorb-Ordner wird endgültig gelöscht – auch die gesicherten alten Tags.'), t('Leeren')))) return;
      zeichnen(await api.post('/admin/aufraeumen/papierkorb-leeren', {}));
    });
    box.querySelectorAll('[data-af-ansehen]').forEach((b) => b.addEventListener('click', () => aufraeumPlanZeigen(app, Number(b.closest('[data-ed]').dataset.ed), holen)));
    box.querySelectorAll('[data-af-frei]').forEach((b) => b.addEventListener('click', async () => zeichnen(await api.post('/admin/aufraeumen/freigeben', { edition_ids: [Number(b.closest('[data-ed]').dataset.ed)] }))));
    box.querySelectorAll('[data-af-weg]').forEach((b) => b.addEventListener('click', async () => zeichnen(await api.post('/admin/aufraeumen/verwerfen', { edition_ids: [Number(b.closest('[data-ed]').dataset.ed)] }))));
    box.querySelectorAll('[data-af-neu]').forEach((b) => b.addEventListener('click', async () => {
      const ed = Number(b.closest('[data-ed]').dataset.ed);
      b.disabled = true; b.textContent = t('Prüfe …');
      const x = await versuche(() => api.post('/admin/aufraeumen/vorschau', { edition_id: ed }));
      if (!x) { b.disabled = false; b.textContent = t('Erneut prüfen'); return; }
      offenListe = true;
      zeichnen(await api.get('/admin/aufraeumen'), t('Neu geprüft – falls es etwas zu tun gibt, steht das Album jetzt oben mit „Freigeben“.'));
    }));
    if (r.laeuft || s.freigegeben || s.laeuft || vorschauLaeuft) timer = setTimeout(holen, 3000);
  };
  const holen = () => {
    if (signal?.aborted || !box.isConnected) return;
    api.get('/admin/aufraeumen').then((r) => zeichnen(r)).catch(() => { box.hidden = true; });
  };
  signal?.addEventListener('abort', () => clearTimeout(timer));
  holen();
}

// ---------------------------------------------------------------------------------------------
// Lautheitsanalyse: Fortschritt der Messung im Hintergrund
export function lautheitPanel(box, signal) {
  let timer = null;
  const k = (x) => (x == null ? '–' : String(x).replace('.', locale.startsWith('de') ? ',' : '.').replace('-', '−'));
  const zeichnen = (r) => {
    const proz = r.dateien ? Math.floor((r.gemessen / r.dateien) * 100) : 100;
    const fertig = r.gemessen >= r.dateien;
    box.innerHTML = `<h2 style="font-size:1.15rem">${t('Lautheitsanalyse (EBU R128)')}</h2>
      <p class="hinweis">${t('Misst im Hintergrund jeden Titel (Lautheit, Lautheitsumfang, True-Peak) und daraus jedes Album am Stück. Die Player gleichen damit die Lautstärke an – Alben als Ganzes. Läuft mit niedriger Priorität, {n} Titel gleichzeitig (<code>LAUTHEIT_PARALLEL</code>).', { n: zahl(r.parallel) })}</p>
      ${r.aktiv ? '' : `<p class="hinweis" style="color:var(--accent-text)">${t('Abgeschaltet (<code>LAUTHEIT_AKTIV=0</code>).')}</p>`}
      <div class="fortschritt" style="margin:12px 0 6px" role="progressbar" aria-valuenow="${proz}" aria-valuemin="0" aria-valuemax="100"><i style="width:${proz}%"></i></div>
      <p class="hinweis" style="margin:0">${t('{a} von {d} Titeln ({p} %) · {b} von {c} Alben', { a: zahl(r.gemessen), d: zahl(r.dateien), p: proz, b: zahl(r.alben_fertig), c: zahl(r.alben) })}
        ${!fertig ? t(' · noch ca. {h} h Musik{x}', { h: k(r.rest_stunden), x: r.laeuft ? t(' · misst gerade …') : t(' · nächster Durchgang in unter einer Minute') }) : t(' · fertig')}
        ${r.fehler ? ` · <span style="color:var(--accent-text)">${t('{n} nicht messbar', { n: zahl(r.fehler) })}</span>` : ''}</p>
      ${r.schnitt_lufs != null ? `<p class="hinweis" style="margin:6px 0 0">${t('Durchschnitt der Bibliothek: {lufs} LUFS · LRA {lra} LU', { lufs: k(r.schnitt_lufs), lra: k(r.schnitt_lra) })}</p>` : ''}
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">
        ${r.fehler ? `<button type="button" class="btn btn-zweit btn-klein" data-lh-fehler>${t('Fehlgeschlagene erneut messen')}</button>` : ''}
        <button type="button" class="btn btn-zweit btn-klein" data-lh-neu>${t('Alles neu messen')}</button>
      </div>`;
    box.querySelector('[data-lh-fehler]')?.addEventListener('click', async () => zeichnen(await api.post('/admin/lautheit/neu', { nur_fehler: true })));
    box.querySelector('[data-lh-neu]').addEventListener('click', async () => {
      if (!(await bestaetigen(t('Alles neu messen?'), t('Alle Titel werden im Hintergrund noch einmal gemessen. Bis dahin spielen sie ohne Angleich.'), t('Neu messen')))) return;
      zeichnen(await api.post('/admin/lautheit/neu', {}));
    });
    clearTimeout(timer);
    if (!fertig && r.aktiv) timer = setTimeout(holen, 5000);
  };
  const holen = () => {
    if (signal?.aborted || !box.isConnected) return;
    api.get('/admin/lautheit').then(zeichnen).catch(() => { box.hidden = true; });
  };
  holen();
}

// ---------------------------------------------------------------------------------------------
// Direktzugang im Heimnetz (wie Plex): Cloudflare-Token → Name/IP → Zertifikat → fertig
const SCHRITT_ICON = { laeuft: '⏳', ok: '✓', warnung: '⚠', fehler: '✗' };

export function direktEinrichten(box, signal) {
  let stand = null;
  let poll = null;
  let meldung = '';

  const laden = async () => {
    stand = await api.get('/admin/direktzugang', { signal }).catch((e) => { box.innerHTML = `<p class="hinweis">${h(e.message)}</p>`; return null; });
    if (stand) zeichnen();
    return stand;
  };

  const schritteHtml = (lauf) => {
    if (!lauf?.schritte?.length) return '';
    return `<ol class="direkt-schritte">${lauf.schritte.map((x) => `<li class="${h(x.status)}"><span class="i">${SCHRITT_ICON[x.status] || '·'}</span><span><b>${h(x.text)}</b>${x.info ? `<small>${h(x.info)}</small>` : ''}</span></li>`).join('')}</ol>
      ${!lauf.laeuft && lauf.meldung ? `<p class="hinweis" style="margin-top:8px;color:${lauf.ok ? 'var(--success)' : 'var(--danger, #ff7a6b)'}">${h(lauf.meldung)}</p>` : ''}`;
  };

  const zeichnen = () => {
    const s = stand;
    const z = s.zertifikat;
    const laeuft = !!s.lauf?.laeuft;
    const echt = z && !z.platzhalter;
    const erreichbar = netzweg.erreichbar;
    box.innerHTML = `
      <div class="direkt-kopf">
        <div>
          <h2 style="font-size:1.15rem;margin-bottom:4px">${t('Direktzugang im Heimnetz')}</h2>
          <p class="hinweis" style="margin:0">${t('Wie bei Plex: Zuhause kommt die Musik direkt vom Server statt über Cloudflare – schneller, ohne Internet-Umweg. Unterwegs bleibt alles wie bisher. Kein offener Port im Router nötig (funktioniert auch hinter CGNAT).')}</p>
        </div>
        ${s.aktiv ? `<span class="marke ${erreichbar ? 'marke-gut' : ''}">${erreichbar ? t('● von hier direkt erreichbar') : t('○ von hier nicht direkt erreichbar')}</span>` : ''}
      </div>
      ${s.app_url_fehlt ? `<p class="hinweis" style="color:var(--accent-text)">${t('Bitte zuerst <code>APP_URL</code> in der .env setzen (die normale Adresse der App) – sonst lässt der Server die App nicht über die Direktadresse zu.')}</p>` : ''}
      ${s.fest ? `<p class="hinweis">${t('Feste Direktadresse aus der .env (<code>DIREKT_URL</code>): <b>{url}</b>. Zertifikat und DNS verwaltest du selbst.', { url: h(s.url) })}</p>
        <div class="aktionen" style="margin-top:10px"><button type="button" class="btn btn-zweit" data-d-pruefen>${t('Von diesem Gerät prüfen')}</button></div>` : `
      ${s.aktiv && echt ? `<div class="direkt-status">
          <div><small>${t('Adresse')}</small><b>${h(s.url)}</b></div>
          <div><small>${t('Zeigt auf')}</small><b>${h(s.ip)}</b></div>
          <div><small>${t('Zertifikat')}</small><b>${t('gültig bis {d}', { d: h(datum(z.gueltig_bis)) })}</b><small>${h(z.aussteller || '')} · ${tn(z.tage, 'noch 1 Tag', 'noch {n} Tage')}</small></div>
          <div class="direkt-erneuern">
            <label class="checkbox-zeile" style="margin:0"><input type="checkbox" data-d-auto ${s.auto ? 'checked' : ''}><span><b>${t('Automatisch erneuern')}</b><small>${s.auto
              ? t('{n} Tage vor Ablauf – nächste Erneuerung {d}', { n: s.erneuern_tage, d: s.naechste_erneuerung ? h(datum(s.naechste_erneuerung)) : t('bald') })
              : t('aus – das Zertifikat läuft dann ab und die Direktadresse wird ungültig')}${s.auto_quelle === 'env' ? t(' (aus der .env)') : ''}</small></span></label>
            <button type="button" class="btn btn-zweit btn-klein" data-d-erneuern ${laeuft ? 'disabled' : ''}>${t('Jetzt erneuern')}</button>
          </div>
        </div>` : ''}
      <div class="direkt-schritt">
        <h3><span class="nr">1</span> ${t('Cloudflare-Token')}</h3>
        ${s.token_gesetzt ? `<p class="hinweis" style="margin:0">${t('✓ Token gespeichert')}${s.token_quelle === 'env' ? t(' (aus der .env)') : t(' (verschlüsselt)')}. <button type="button" class="link-knopf" data-d-token-neu>${t('Ändern')}</button></p>` : ''}
        <div data-d-token-form ${s.token_gesetzt ? 'hidden' : ''}>
          <p class="hinweis">${t('Auf <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener">dash.cloudflare.com → Mein Profil → API-Token</a> „Token erstellen“ → Vorlage <b>„Zone-DNS bearbeiten“</b> → bei „Zonenressourcen“ deine Domain wählen → erstellen und hier einfügen. Das Token darf nur DNS-Einträge dieser einen Domain ändern.')}</p>
          <div class="direkt-zeile"><input type="password" data-d-token placeholder="${t('Cloudflare-API-Token')}" autocomplete="off"><button type="button" class="btn" data-d-token-speichern>${t('Prüfen &amp; speichern')}</button></div>
        </div>
      </div>
      <div class="direkt-schritt" ${s.token_gesetzt ? '' : 'data-aus'}>
        <h3><span class="nr">2</span> ${t('Name und Adresse im Heimnetz')}</h3>
        <div class="direkt-felder">
          <label>${t('Name')} <input type="text" data-d-host value="${h(s.host || s.vorschlag_host)}" placeholder="lokal.musik.example.de"></label>
          <label>${t('IP des Servers im Heimnetz')} <input type="text" data-d-ip value="${h(s.ip || s.vorschlag_ip)}" placeholder="192.168.1.10" inputmode="decimal"></label>
          <label>${t('HTTPS-Port (Stack)')} <input type="number" data-d-port value="${h(String(s.port))}" min="1" max="65535"></label>
          <label>${t('E-Mail für Let\'s Encrypt (optional)')} <input type="email" data-d-email value="${h(s.email || '')}" placeholder="${t('für Ablauf-Hinweise')}"></label>
        </div>
        <p class="hinweis" style="margin:6px 0 0">${s.vorschlag_ip
          ? t('IP erkannt, weil du die Verwaltung über die Server-IP geöffnet hast.')
          : t('Tipp: Öffnest du die Verwaltung einmal über <code>http://&lt;Server-IP&gt;:{port}</code>, wird die IP automatisch eingetragen.', { port: h(String(s.app_port)) })}
          ${t('Der HTTPS-Port ist die <b>linke</b> Zahl der Port-Zeile im Stack (<code>{port}:8443</code>, nur im Heimnetz){env}. Er muss sich vom App-Port {app} unterscheiden. Nach dem Update einmal den Stack neu starten.', { port: h(String(s.port)), env: s.port_quelle === 'env' ? t(' – hier aus <code>LOKAL_HTTPS_PORT</code> in der .env übernommen') : '', app: h(String(s.app_port)) })}</p>
      </div>
      <div class="direkt-schritt" ${s.token_gesetzt ? '' : 'data-aus'}>
        <h3><span class="nr">3</span> ${t('Einrichten')}</h3>
        <p class="hinweis" style="margin:0 0 10px">${t('Legt den DNS-Eintrag an (nur DNS, ohne Cloudflare-Proxy), holt das Zertifikat bei Let\'s Encrypt und lädt den Webserver neu. Dauert meist 30–90 Sekunden.')}</p>
        <div class="aktionen">
          <button type="button" class="btn" data-d-los ${laeuft || !s.token_gesetzt ? 'disabled' : ''}>${laeuft ? t('Läuft …') : s.aktiv ? t('Erneut einrichten') : t('Einrichten')}</button>
          ${s.aktiv ? `<button type="button" class="btn btn-zweit" data-d-pruefen>${t('Von diesem Gerät prüfen')}</button><button type="button" class="btn btn-zweit" data-d-aus>${t('Abschalten')}</button>` : ''}
        </div>
        ${schritteHtml(s.lauf)}
      </div>
      <p class="hinweis" style="margin-top:12px;font-size:.8rem">${t('Falls dein Router einen DNS-Rebind-Schutz hat (Fritzbox, manche UniFi-Einstellungen): den Namen dort als Ausnahme eintragen, sonst wird die Antwort mit der privaten IP verworfen. Am Handy „Privates DNS“ auf Automatisch lassen.')}</p>`}
      ${meldung ? `<p class="hinweis" style="margin-top:8px;color:var(--accent-text);white-space:pre-line">${h(meldung)}</p>` : ''}
      ${s.aktiv && !netzweg.direkt ? `<p class="hinweis" style="margin-top:8px">${t('Damit diese Seite die neue Adresse benutzen darf, einmal neu laden.')} <button type="button" class="btn btn-zweit btn-klein" data-d-neu>${t('Jetzt neu laden')}</button></p>` : ''}`;
    verbinden();
  };

  const verbinden = () => {
    box.querySelector('[data-d-neu]')?.addEventListener('click', () => location.reload());
    box.querySelector('[data-d-auto]')?.addEventListener('change', async (e) => {
      try { stand = await api.post('/admin/direktzugang/auto', { an: e.target.checked }); meldung = e.target.checked ? t('Automatische Erneuerung an.') : t('Automatische Erneuerung aus.'); }
      catch (err) { meldung = err.message; }
      zeichnen();
    });
    box.querySelector('[data-d-erneuern]')?.addEventListener('click', async () => {
      meldung = '';
      stand.lauf = { laeuft: true, schritte: [{ text: t('Zertifikat erneuern'), status: 'laeuft' }] };
      zeichnen();
      clearInterval(poll);
      poll = setInterval(async () => { const r = await api.get('/admin/direktzugang').catch(() => null); if (r && r.lauf?.laeuft) { stand = r; zeichnen(); } }, 1500);
      try { stand = await api.post('/admin/direktzugang/erneuern', {}); } catch (err) { meldung = err.message; await laden(); }
      clearInterval(poll);
      zeichnen();
    });
    box.querySelector('[data-d-token-neu]')?.addEventListener('click', () => { box.querySelector('[data-d-token-form]').hidden = false; box.querySelector('[data-d-token]').focus(); });
    box.querySelector('[data-d-token-speichern]')?.addEventListener('click', async (e) => {
      const token = box.querySelector('[data-d-token]').value.trim();
      if (!token) return;
      e.target.disabled = true; e.target.textContent = t('Prüfe …');
      try {
        const r = await api.post('/admin/direktzugang/token', { token });
        stand = r;
        meldung = r.zonen?.length ? t('Token gültig – Zugriff auf: {zonen}', { zonen: r.zonen.join(', ') }) : t('Token gültig, aber ohne Zonen-Zugriff – bei „Zonenressourcen“ die Domain auswählen.');
      } catch (err) { meldung = err.message; }
      zeichnen();
    });
    box.querySelector('[data-d-los]')?.addEventListener('click', async () => {
      const wert = (sel) => box.querySelector(sel).value.trim();
      const daten = { host: wert('[data-d-host]'), ip: wert('[data-d-ip]'), port: Number(wert('[data-d-port]')) || 8443, email: wert('[data-d-email]') };
      meldung = '';
      stand.lauf = { laeuft: true, schritte: [{ text: t('Startet …'), status: 'laeuft' }] };
      zeichnen();
      clearInterval(poll);
      poll = setInterval(async () => {
        const r = await api.get('/admin/direktzugang').catch(() => null);
        if (r && r.lauf?.laeuft) { stand = r; zeichnen(); }
      }, 1500);
      try {
        stand = await api.post('/admin/direktzugang/einrichten', daten);
      } catch (err) {
        meldung = err.message;
        await laden();
      }
      clearInterval(poll);
      // Neue Direktadresse: die geladene Seite darf sie erst nach dem Neuladen benutzen (Sicherheitsrichtlinie)
      if (netzweg.direkt) { try { netzweg.einrichten(await api.get('/direkt/token')); } catch (e) { /* egal */ } }
      setTimeout(() => zeichnen(), 1700);
      zeichnen();
    });
    box.querySelectorAll('[data-d-pruefen]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = t('Prüfe …');
      meldung = await direktDiagnose(stand);
      zeichnen();
    }));
    box.querySelector('[data-d-aus]')?.addEventListener('click', async () => {
      const r = await dialog({
        titel: t('Direktzugang abschalten?'),
        inhalt: `<p>${t('Die App holt die Musik dann wieder nur über den normalen Weg.')}</p><label class="checkbox-zeile"><input type="checkbox" name="dns" checked><span>${t('DNS-Eintrag bei Cloudflare löschen')}</span></label>`,
        knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Abschalten'), wert: 'ja', art: 'gefahr' }],
      });
      if (!r) return;
      stand = await api.post('/admin/direktzugang/aus', { dns_loeschen: r.form.get('dns') === 'on' });
      netzweg.einrichten(null);
      meldung = t('Abgeschaltet.');
      zeichnen();
    });
  };

  netzweg.addEventListener('wechsel', () => { if (stand && box.isConnected) zeichnen(); });
  laden().then((s) => {
    if (s?.lauf?.laeuft) {
      poll = setInterval(async () => { const r = await laden(); if (!r?.lauf?.laeuft) clearInterval(poll); }, 1500);
    }
  });
  signal?.addEventListener('abort', () => clearInterval(poll));
}

/**
 * Diagnose „Von diesem Gerät prüfen“: findet heraus, WARUM die Direktadresse nicht klappt
 * (Seite nicht neu geladen, Netz/DNS/Port/Zertifikat, Freigabe für diese Seite, Chrome-Erlaubnis).
 */
async function direktDiagnose(stand) {
  try { netzweg.einrichten(await api.get('/direkt/token')); } catch (e) { /* egal */ }
  if (!netzweg.direkt) return t('✗ Der Direktzugang ist nicht eingeschaltet.');
  if (await netzweg.pruefen()) return t('✓ Dieses Gerät erreicht den Server direkt – Musik kommt hier ab jetzt ohne Umweg.');
  const url = `${netzweg.direkt.url}/api/v1/ping`;
  const zeilen = [t('✗ {name} antwortet dieser Seite nicht. Diagnose:', { name: netzweg.name })];
  // 1. Darf diese Seite die Adresse überhaupt ansprechen (Sicherheitsrichtlinie der geladenen Seite)?
  let csp = false;
  const aufCsp = (e) => { if (String(e.blockedURI || '').startsWith(netzweg.direkt.url)) csp = true; };
  document.addEventListener('securitypolicyviolation', aufCsp);
  // 2. Ist der Server über Netz/DNS/Port/Zertifikat erreichbar? (ohne Freigabe-Prüfung)
  let netzOk = false;
  try { await fetch(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit' }); netzOk = true; } catch (e) { netzOk = false; }
  await new Promise((r) => setTimeout(r, 50));
  document.removeEventListener('securitypolicyviolation', aufCsp);
  if (csp) {
    zeilen.push(t('• Diese Seite wurde vor dem Einrichten geladen und darf die neue Adresse noch nicht benutzen → Seite neu laden und erneut prüfen.'));
    return zeilen.join('\n');
  }
  if (!netzOk) {
    zeilen.push(t('• Netz: nicht erreichbar. Öffne {url} in einem neuen Tab: kommt eine Zertifikatswarnung, liefert der Server noch das Platzhalter-Zertifikat (Container neu starten); „nicht erreichbar“ heißt DNS-Name unbekannt oder Port nicht freigegeben. Bist du im Heimnetz?', { url }));
    return zeilen.join('\n');
  }
  zeilen.push(t('• Netz, Port und Zertifikat: in Ordnung.'));
  // 3. Freigabe (CORS): erlaubt sind APP_URL und Aufrufe über die Server-IP im Heimnetz
  let appOrigin = '';
  try { appOrigin = stand?.app_url ? new URL(stand.app_url).origin : ''; } catch (e) { appOrigin = ''; }
  const heim = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(location.hostname) || /\.(local|lan|home\.arpa|internal)$/i.test(location.hostname);
  if (!appOrigin) zeilen.push(t('• APP_URL ist in der .env nicht gesetzt – der Server weiß nicht, welche Seite die Direktadresse benutzen darf.'));
  else if (appOrigin !== location.origin && !heim) zeilen.push(t('• Diese Seite läuft unter {origin}, APP_URL ist aber {app}. In der .env APP_URL={origin} setzen (ohne / am Ende) und den Stack neu starten.', { origin: location.origin, app: stand.app_url }));
  // 4. Chrome: Erlaubnis für Zugriffe ins lokale Netzwerk
  try {
    const p = await navigator.permissions.query({ name: 'local-network-access' });
    if (p.state === 'denied') zeilen.push(t('• Chrome hat den Zugriff auf Geräte im lokalen Netzwerk für diese Seite blockiert → links neben der Adresse auf das Symbol → Website-Einstellungen → „Lokales Netzwerk“ erlauben.'));
    else if (p.state === 'prompt') zeilen.push(t('• Chrome fragt beim nächsten Versuch, ob die Seite auf das lokale Netzwerk zugreifen darf → erlauben.'));
  } catch (e) { /* Browser kennt diese Erlaubnis nicht */ }
  if (zeilen.length === 2) zeilen.push(t('• Die Freigabe für diese Seite fehlt. Ist das neueste Update eingespielt und der Container danach neu gestartet?'));
  return zeilen.join('\n');
}

function scanStatusText(l) {
  return { fertig: t('✓ Abgeschlossen'), laeuft: t('Läuft …'), wartet: t('Startet …'), fehler: `${t('✗ Fehler')}${l.meldung ? `: ${h(l.meldung)}` : ''}`, abgebrochen: t('Abgebrochen') }[l.status] || l.status;
}

// ---------------------------------------------------------------------------------------------
// Konten
// ---------------------------------------------------------------------------------------------

async function kontoAnlegen(app, nachher) {
  const d = await dialog({
    titel: t('Konto anlegen'),
    inhalt: `<div class="form-zeilen"><div><label>${t('Vorname')}</label><input type="text" name="vorname" required></div><div><label>${t('Nachname')}</label><input type="text" name="nachname" required></div></div>
      <label>${t('Benutzername')}</label><input type="text" name="benutzername" required pattern="[A-Za-z0-9._\\-]{3,50}" autocapitalize="none">
      <label>${t('E-Mail-Adresse')}</label><input type="email" name="email" required>
      <label>${t('Start-Passwort')} <small>${t('(muss beim ersten Login geändert werden)')}</small></label><input type="text" name="passwort" required minlength="8" autocomplete="off">
      <div class="form-zeilen"><div><label>${t('Gültigkeit')}</label>${monateAuswahl()}</div><div><label>${t('Rolle')}</label><select name="rolle"><option value="user">${t('Familie')}</option><option value="admin">Admin</option></select></div></div>`,
    knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Anlegen'), wert: 'ok' }],
  });
  if (!d) return;
  const daten = Object.fromEntries(d.form.entries());
  daten.monate = Number(daten.monate);
  if (await versuche(() => api.post('/admin/konten', daten), t('Konto angelegt'))) nachher();
}

async function kontoAktion(app, k, aktion, anker, nachher) {
  const ausfuehren = async (a, daten = {}, text = t('Erledigt')) => {
    if (await versuche(() => api.post(`/admin/konten/${k.id}/${a}`, daten), text)) { nachher(); app.zaehlerAktualisieren(); }
  };
  if (aktion === 'freischalten' || aktion === 'verlaengern') {
    const d = await dialog({
      titel: aktion === 'freischalten' ? t('{name} freischalten', { name: `${k.vorname} ${k.nachname}` }) : t('Konto von {name} verlängern', { name: k.vorname }),
      inhalt: `<label>${t('Gültigkeit')}</label>${monateAuswahl()}<p class="hinweis" style="margin-top:10px">${aktion === 'verlaengern'
        ? (k.gueltig_bis && new Date(k.gueltig_bis) > new Date() ? t('Noch gültig bis {d} – die Zeit wird darauf addiert.', { d: datum(k.gueltig_bis) }) : t('Abgelaufen – die Zeit zählt ab heute.'))
        : t('Ab heute. Eine Bestätigung geht per E-Mail raus.')}</p>`,
      knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: aktion === 'freischalten' ? t('Freischalten') : t('Verlängern'), wert: 'ok' }],
    });
    if (d) ausfuehren(aktion, { monate: Number(d.form.get('monate')) }, aktion === 'freischalten' ? t('Freigeschaltet') : t('Verlängert'));
    return;
  }
  if (aktion === 'ablehnen') {
    if (await bestaetigen(t('Registrierung ablehnen?'), t('Die Registrierung von {name} wird gelöscht.', { name: `${k.vorname} ${k.nachname}` }), t('Ablehnen'), true)) ausfuehren('ablehnen', {}, t('Abgelehnt'));
    return;
  }
  if (aktion !== 'menue') return;
  const eintraege = [{ titel: `${k.vorname} ${k.nachname}` },
    { text: t('Bearbeiten'), icon: 'bearbeiten', aktion: async () => {
      const d = await dialog({ titel: t('Konto bearbeiten'), inhalt: `<div class="form-zeilen"><div><label>${t('Vorname')}</label><input type="text" name="vorname" value="${h(k.vorname)}" required></div><div><label>${t('Nachname')}</label><input type="text" name="nachname" value="${h(k.nachname)}" required></div></div>
        <label>${t('Benutzername')}</label><input type="text" name="benutzername" value="${h(k.benutzername)}" required><label>${t('E-Mail')}</label><input type="email" name="email" value="${h(k.email)}" required>
        <label>${t('Rolle')}</label><select name="rolle"><option value="user" ${k.rolle === 'user' ? 'selected' : ''}>${t('Familie')}</option><option value="admin" ${k.rolle === 'admin' ? 'selected' : ''}>Admin</option></select>`,
        knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Speichern'), wert: 'ok' }] });
      if (d && await versuche(() => api.put(`/admin/konten/${k.id}`, Object.fromEntries(d.form.entries())), t('Gespeichert'))) nachher();
    } },
    { text: t('Neues Passwort setzen'), icon: 'einstellungen', aktion: async () => {
      const d = await dialog({ titel: t('Neues Passwort'), inhalt: `<label>${t('Passwort')} <small>${t('(muss beim nächsten Login geändert werden)')}</small></label><input type="text" name="passwort" required minlength="8" autocomplete="off">`,
        knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Setzen'), wert: 'ok' }] });
      if (d) ausfuehren('passwort', { passwort: d.form.get('passwort') }, t('Passwort gesetzt'));
    } },
    { text: t('Auf allen Geräten abmelden'), icon: 'abmelden', aktion: () => ausfuehren('geraete_abmelden', {}, t('Abgemeldet')) },
  ];
  if (k.status === 'gesperrt') eintraege.push({ text: t('Entsperren'), icon: 'profil', aktion: () => ausfuehren('entsperren', {}, t('Entsperrt')) });
  else if (k.id !== app.ich.user.id && k.status !== 'pending') eintraege.push({ text: t('Sperren …'), icon: 'zu', aktion: async () => {
    const d = await dialog({ titel: t('{name} sperren', { name: k.vorname }), inhalt: `<label>${t('Bis')} <small>${t('(TT.MM.JJJJ, leer = unbefristet)')}</small></label><input type="text" name="bis" placeholder="${t('TT.MM.JJJJ')}" inputmode="numeric" maxlength="10"><label>${t('Grund')} <small>${t('(sieht der Nutzer beim Login)')}</small></label><input type="text" name="grund" maxlength="500">`,
      knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Sperren'), wert: 'ok', art: 'gefahr' }] });
    if (d) ausfuehren('sperren', { bis: d.form.get('bis'), grund: d.form.get('grund') }, t('Gesperrt'));
  } });
  if (k.id !== app.ich.user.id) eintraege.push({ trenner: true }, { text: t('Konto löschen'), icon: 'muell', rot: true, aktion: async () => {
    if (await bestaetigen(t('Konto löschen?'), t('{name} wird endgültig gelöscht, inklusive Playlists, Favoriten und Hörverlauf.', { name: `${k.vorname} ${k.nachname}` }), t('Löschen'), true)
      && await versuche(() => api.del(`/admin/konten/${k.id}`), t('Gelöscht'))) nachher();
  } });
  menue(anker, eintraege);
}

// ---------------------------------------------------------------------------------------------
// MusicBrainz-Vergleich
// ---------------------------------------------------------------------------------------------

async function vergleichZeigen(app, ed, mbid) {
  let daten = null;
  let abbildung = null;   // von Hand angepasste Zuordnung { track_id: MusicBrainz-Index | null }, null = automatisch
  let aufgenommen = null; // Klick-Variante (Touch/Tastatur): Datei, die gerade „in der Hand“ ist
  let verschoben = [];    // zuletzt bewegte Dateien (kurz hervorgehoben)
  let auto = null;        // die automatische Zuordnung (zum Erkennen, welche Dateien von Hand verschoben wurden)
  let sperrenLoesen = false; // Haken: Sperren verschobener Dateien aufheben
  const d = dialog({
    titel: t('Vergleich mit MusicBrainz'),
    breit: true,
    inhalt: '<div data-v><div class="lade"></div></div>',
    knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Diese Edition übernehmen'), wert: 'ok' }],
    beimOeffnen: async (el) => {
      el.style.width = 'min(1040px, calc(100vw - 24px))';
      const knopf = el.querySelector('.dialog-fuss button[value="ok"]');
      knopf.disabled = true;
      const laden = () => (abbildung
        ? api.post(`/admin/editionen/${ed.id}/mb-vergleich/${mbid}`, { zuordnung: abbildung })
        : api.get(`/admin/editionen/${ed.id}/mb-vergleich/${mbid}`));
      /** Aktuelle Zuordnung aller eigenen Dateien aus den angezeigten Zeilen */
      const aktuelleAbbildung = () => Object.fromEntries(daten.vergleich.zeilen.filter((z) => z.wir).map((z) => [z.wir.track_id, z.mb ? z.mb_i : null]));
      /** Datei `quelle` (track_id) auf die Zeile `zielIndex` legen; liegt dort schon eine Datei, tauschen beide */
      const verschieben = async (quelle, zielIndex) => {
        aufgenommen = null;
        const zeilen = daten.vergleich.zeilen;
        const ziel = zeilen[zielIndex];
        if (!ziel || (ziel.wir && ziel.wir.track_id === quelle)) { zeichnen(); return; }
        const m = aktuelleAbbildung();
        const zielMb = ziel.mb ? ziel.mb_i : null;
        verschoben = [quelle];
        if (ziel.wir) { m[ziel.wir.track_id] = m[quelle] ?? null; verschoben.push(ziel.wir.track_id); }
        m[quelle] = zielMb;
        abbildung = m;
        await neuLaden();
      };
      const neuLaden = async () => {
        knopf.disabled = true;
        el.querySelector('.tabelle-scroll')?.classList.add('laedt');
        try {
          daten = await laden();
        } catch (e) {
          toast(e.message, 'fehler', 6000);
          abbildung = null;
          try { daten = await laden(); } catch (e2) { el.querySelector('[data-v]').innerHTML = `<div class="fehler">${h(e2.message)}</div>`; return; }
        }
        zeichnen();
      };
      try {
        daten = await laden();
        auto = aktuelleAbbildung();
      } catch (e) {
        el.querySelector('[data-v]').innerHTML = `<div class="fehler">${h(e.message)}</div>`;
        return;
      }
      /** Verschobene Dateien, deren Titel/Nummer von Hand gesperrt sind */
      const gesperrteVerschobene = () => (abbildung ? daten.vergleich.zeilen.filter((z) => z.wir && z.wir.gesperrt.length && (auto[z.wir.track_id] ?? null) !== (z.mb ? z.mb_i : null)) : []);
      const zeichnen = () => {
        const v = daten.vergleich;
        const s = v.zusammenfassung;
        const e = daten.edition;
        const coverWahl = el.querySelector('[name="cover"]')?.value;
        const scroll = el.querySelector('.tabelle-scroll')?.scrollTop || 0;
        const zeile = (z, i) => {
          const tid = z.wir ? z.wir.track_id : '';
          const klassen = ['vergleich-zeile', z.status, z.wir && verschoben.includes(z.wir.track_id) ? 'verschoben' : '', z.wir && aufgenommen === z.wir.track_id ? 'aufgenommen' : ''].filter(Boolean).join(' ');
          return `<tr class="${klassen}" data-i="${i}">
        <td><small>${z.mb ? h(z.mb.nummer || z.mb.pos) : ''}</small></td>
        <td class="vergleich-datei" ${z.wir ? `draggable="true" data-tid="${tid}"` : ''}>${z.wir ? `<div class="vergleich-datei-in"><button type="button" class="vergleich-griff" data-griff="${tid}" aria-pressed="${aufgenommen === z.wir.track_id}" title="${t('Ziehen – oder anklicken und dann die Zielzeile anklicken')}" aria-label="${h(t('Datei „{titel}“ einer anderen Zeile zuordnen', { titel: z.wir.titel }))}">⠿</button><span>${h(z.wir.titel)}${z.wir.gesperrt.length ? ` <span class="vergleich-schloss" title="${h(t('{felder} von Hand gesperrt – bleibt bei der Übernahme, wie es ist', { felder: z.wir.gesperrt.map((f) => ({ titel: t('Titel ').trim(), kuenstler: t('Künstler ').trim(), nummer: t('Nummer') }[f])).join(', ') }))}">🔒</span>` : ''}<br><small>${h(z.wir.datei || '')}</small></span></div>` : `<small>${t('– keine Datei –')}</small>`}${z.mb ? `<select class="vergleich-wahl" data-datei="${i}" aria-label="${h(t('Welche Datei ist „{titel}“?', { titel: z.mb.titel }))}"><option value="-1" ${z.wir ? '' : 'selected'}>${t('– keine Datei –')}</option>${v.zeilen.filter((q) => q.wir).map((q) => `<option value="${q.wir.track_id}" ${z.wir && z.wir.track_id === q.wir.track_id ? 'selected' : ''}>${h(q.wir.datei || q.wir.titel)} (${h(dauer(q.wir.laenge_ms))})</option>`).join('')}</select>` : ''}${z.mb ? '' : `<select class="vergleich-wahl" data-wahl="${tid}" aria-label="${h(t('Welcher Titel ist „{titel}“?', { titel: z.wir.titel }))}"><option value="-1" ${z.mb ? '' : 'selected'}>${t('– nicht zugeordnet –')}</option>${v.zeilen.filter((q) => q.mb).map((q) => `<option value="${q.mb_i}" ${z.mb && z.mb_i === q.mb_i ? 'selected' : ''}>${h(String(q.mb.nummer || q.mb.pos).padStart(2, '0'))} · ${h(q.mb.titel)}${q.wir && q.wir.track_id !== z.wir.track_id ? t(' (tauscht)') : ''}</option>`).join('')}</select>`}</td>
        <td class="zahl">${z.wir ? dauer(z.wir.laenge_ms) : ''}</td>
        <td>${z.mb ? `${h(z.mb.titel)}${z.mb.kuenstler && z.mb.kuenstler !== e.kuenstler ? `<br><small>${h(z.mb.kuenstler)}</small>` : ''}` : `<small>${t('– nicht bei MusicBrainz –')}</small>`}</td>
        <td class="zahl">${z.mb && z.mb.laenge_ms ? dauer(z.mb.laenge_ms) : ''}</td>
        <td><span class="vergleich-marke">${{ gut: '✓', abweichend: z.titel_gleich === false ? t('Titel anders') : `±${z.diff_sek} s`, falsch: `±${z.diff_sek} s`, fehlt: t('fehlt bei dir'), extra: t('zusätzlich') }[z.status]}</span></td></tr>`;
        };
        const coverBox = (url, beschriftung, keins) => `<figure style="margin:0;width:150px;text-align:center"><div style="width:150px;height:150px;border-radius:10px;overflow:hidden;background:rgba(255,181,71,.12);display:grid;place-items:center;padding:6px">
          ${url ? `<img src="${h(url)}" alt="${h(beschriftung)}" data-cover-pruefen style="width:100%;height:100%;object-fit:cover;margin:-6px">` : `<small class="hinweis">${keins}</small>`}</div>
          <figcaption style="font-size:.8rem;color:var(--text-muted);margin-top:5px">${beschriftung}</figcaption></figure>`;
        el.querySelector('[data-v]').innerHTML = `
        <div style="display:flex;flex-wrap:wrap;gap:12px 18px;margin-bottom:12px">
        ${coverBox(ed.cover, t('Dein Cover'), t('Kein Cover'))}${coverBox(daten.cover_mb, t('Cover bei MusicBrainz'), t('Keins bei MusicBrainz'))}
        <div style="flex:1 1 320px;min-width:0">
        <div style="display:flex;flex-wrap:wrap;gap:6px 16px;align-items:baseline;margin-bottom:10px">
          <b style="font-size:1.05rem">${h(e.titel)}</b><span class="hinweis">${h(e.kuenstler)}</span>
          <span class="marke">${h([mbDatum(e.datum), land(e.land), e.format].filter(Boolean).join(' · '))}</span>
          ${e.labels ? `<span class="hinweis" style="font-size:.85rem">${h(e.labels)}</span>` : ''}
          <a href="${h(daten.link)}" target="_blank" rel="noopener" style="margin-left:auto;font-size:.85rem">${t('bei MusicBrainz ansehen ↗')}</a>
        </div>
        <div class="pillen" style="margin-bottom:12px">
          <span class="pille" style="cursor:default">${t('{n} passen', { n: s.passend })}</span>
          ${s.abweichend ? `<span class="pille" style="cursor:default;border-color:rgba(255,181,71,.6)">${t('{n} weichen ab', { n: s.abweichend })}</span>` : ''}
          ${s.fehlt ? `<span class="pille" style="cursor:default">${t('{n} fehlen bei dir', { n: s.fehlt })}</span>` : ''}
          ${s.extra ? `<span class="pille" style="cursor:default;border-color:rgba(255,107,107,.6)">${t('{n} ohne Gegenstück', { n: s.extra })}</span>` : ''}
          <span class="pille" style="cursor:default">${t('größte Abweichung {n} s', { n: s.max_diff_sek })}</span>
          <span class="pille" style="cursor:default">${t('{n} Mitwirkende', { n: daten.mitwirkende })}</span>
          ${v.zuordnung === 'reihe' ? `<span class="pille" style="cursor:default">${t('Zuordnung der Reihe nach')}</span>` : ''}
          ${v.zuordnung === 'namen' ? `<span class="pille" style="cursor:default">${t('Zuordnung nach Namen')}</span>` : ''}
          ${v.zuordnung === 'hand' ? `<span class="pille" style="cursor:default;border-color:rgba(255,181,71,.6)">${t('Von Hand zugeordnet')}</span>` : ''}
        </div>
        <p class="hinweis" style="margin:0;font-size:.85rem">${t('Passt die Zuordnung nicht, wähle in der Zeile des MusicBrainz-Titels, welche deiner Dateien das ist (die Reihenfolge des Releases bleibt, deine Dateien passen sich an) – oder zieh die Datei (⠿) auf die Zeile. Liegt dort schon eine Datei, tauschen beide. Mit „Zuordnung leeren“ fängst du von vorn an; nicht zugeordnete Dateien stehen unten in der Liste. Genau diese Zuordnung wird beim Übernehmen verwendet.')}
          ${abbildung ? `<button type="button" class="pille" data-auto style="margin-left:6px">${t('Automatisch zuordnen')}</button>` : ''}
          <button type="button" class="pille" data-leeren style="margin-left:6px">${t('Zuordnung leeren')}</button></p>
        </div></div>
        <div class="tabelle-scroll" style="max-height:52vh"><table class="vergleich${aufgenommen !== null ? ' ablegen' : ''}"><thead><tr><th>#</th><th>${t('Deine Datei')}</th><th></th><th>MusicBrainz</th><th></th><th></th></tr></thead><tbody>${v.zeilen.map(zeile).join('')}</tbody></table></div>
        ${(() => { const g = gesperrteVerschobene(); return g.length ? `<label class="checkbox-zeile vergleich-sperre"><input type="checkbox" name="sperren_loesen" value="1" data-sperren ${sperrenLoesen ? 'checked' : ''}> <span>${tn(g.length, '<b>{n} verschobene Datei hat von Hand gesperrte Angaben</b> (🔒). Sperre für sie aufheben, damit sie Titel und Nummer des neuen Platzes bekommt. Ohne Haken bleiben Titel und Nummer, wie du sie gesetzt hast.', '<b>{n} verschobene Dateien haben von Hand gesperrte Angaben</b> (🔒). Sperre für diese aufheben, damit sie Titel und Nummer des neuen Platzes bekommen. Ohne Haken bleiben Titel und Nummer, wie du sie gesetzt hast.')}</span></label>` : ''; })()}
        <div class="form-zeilen" style="margin-top:10px">
          <div><label>Cover</label><select name="cover">
            <option value="fehlend">${t('Nur übernehmen, wenn keins vorhanden ist')}</option>
            <option value="immer" ${daten.cover_moeglich ? '' : 'disabled'}>${t('Von MusicBrainz übernehmen')}${daten.cover_moeglich ? '' : t(' (keins vorhanden)')}</option>
            <option value="nie">${t('Eigenes Cover behalten')}</option></select></div>
          <div><label>${t('Wird übernommen')}</label><p class="hinweis" style="margin:4px 0 0;font-size:.88rem">${t('Album, Edition, Titel, Künstler mit allen Beteiligten, Label, Genres{g}. Gesperrte Felder bleiben, wie sie sind.{f}', { g: daten.genres.length ? ` (${h(daten.genres.join(', '))})` : '', f: s.fehlt ? ' ' + t('Fehlende Titel werden ergänzt und als „Datei fehlt“ angezeigt.') : '' })}</p></div>
        </div>`;
        if (coverWahl) { const sel = el.querySelector('[name="cover"]'); if (sel && !sel.querySelector(`option[value="${coverWahl}"]`)?.disabled) sel.value = coverWahl; }
        const box = el.querySelector('.tabelle-scroll');
        box.scrollTop = scroll;
        // Lädt ein Bild nicht (Cover Art Archive nicht erreichbar), statt des kaputten Symbols einen Hinweis zeigen
        el.querySelectorAll('[data-cover-pruefen]').forEach((i) => i.addEventListener('error', () => i.replaceWith(Object.assign(document.createElement('small'), { className: 'hinweis', textContent: t('Nicht ladbar') }))));
        el.querySelector('[data-auto]')?.addEventListener('click', () => { abbildung = null; verschoben = []; aufgenommen = null; sperrenLoesen = false; neuLaden(); });
        el.querySelector('[data-sperren]')?.addEventListener('change', (ev) => { sperrenLoesen = ev.target.checked; });
        el.querySelector('[data-leeren]')?.addEventListener('click', () => { abbildung = Object.fromEntries(Object.keys(aktuelleAbbildung()).map((k) => [k, null])); verschoben = []; aufgenommen = null; neuLaden(); });
        el.querySelectorAll('select[data-datei]').forEach((sel) => sel.addEventListener('change', async () => {
          const i = Number(sel.dataset.datei);
          const tid = Number(sel.value);
          if (tid < 0) {
            const alt = daten.vergleich.zeilen[i].wir;
            if (alt) { const m = aktuelleAbbildung(); m[alt.track_id] = null; abbildung = m; verschoben = [alt.track_id]; await neuLaden(); }
            return;
          }
          await verschieben(tid, i);
        }));
        el.querySelectorAll('select[data-wahl]').forEach((sel) => sel.addEventListener('change', async () => {
          const tid = Number(sel.dataset.wahl);
          const wert = Number(sel.value);
          if (wert < 0) { const m = aktuelleAbbildung(); m[tid] = null; abbildung = m; verschoben = [tid]; await neuLaden(); return; }
          const i = daten.vergleich.zeilen.findIndex((q) => q.mb && q.mb_i === wert);
          if (i >= 0) await verschieben(tid, i);
        }));
        // Ziehen (Maus) …
        const tabelle = box.querySelector('table');
        let ueber = null;
        const ueberWeg = () => { ueber?.classList.remove('ueber'); ueber = null; };
        tabelle.addEventListener('dragstart', (ev) => {
          const td = ev.target.closest?.('td[data-tid]');
          if (!td) { ev.preventDefault(); return; }
          ev.dataTransfer.setData('text/plain', td.dataset.tid);
          ev.dataTransfer.effectAllowed = 'move';
          td.closest('tr').classList.add('zieht');
        });
        tabelle.addEventListener('dragend', () => { ueberWeg(); tabelle.querySelectorAll('.zieht').forEach((t) => t.classList.remove('zieht')); });
        tabelle.addEventListener('dragover', (ev) => {
          const tr = ev.target.closest('tr[data-i]');
          if (!tr) return;
          ev.preventDefault();
          ev.dataTransfer.dropEffect = 'move';
          if (ueber !== tr) { ueberWeg(); ueber = tr; tr.classList.add('ueber'); }
        });
        tabelle.addEventListener('dragleave', (ev) => { if (!tabelle.contains(ev.relatedTarget)) ueberWeg(); });
        tabelle.addEventListener('drop', (ev) => {
          const tr = ev.target.closest('tr[data-i]');
          const quelle = Number(ev.dataTransfer.getData('text/plain'));
          ueberWeg();
          if (!tr || !quelle) return;
          ev.preventDefault();
          verschieben(quelle, Number(tr.dataset.i));
        });
        // … oder anklicken und ablegen (Touch, Tastatur)
        tabelle.addEventListener('click', (ev) => {
          const griff = ev.target.closest('[data-griff]');
          if (griff) {
            const tid = Number(griff.dataset.griff);
            aufgenommen = aufgenommen === tid ? null : tid;
            verschoben = [];
            zeichnen();
            return;
          }
          const tr = ev.target.closest('tr[data-i]');
          if (aufgenommen !== null && tr) verschieben(aufgenommen, Number(tr.dataset.i));
        });
        knopf.disabled = false;
        knopf.textContent = (s.falsch || s.extra > 0 || s.abweichend > s.passend) ? t('Trotzdem übernehmen') : t('Diese Edition übernehmen');
      };
      zeichnen();
    },
  });
  const r = await d;
  if (!r || !daten) return false;
  toast(t('Übernehme von MusicBrainz …'));
  const body = { mbid, cover: r.form.get('cover') || 'fehlend' };
  if (abbildung) {
    body.zuordnung = Object.fromEntries(daten.vergleich.zeilen.filter((z) => z.wir).map((z) => [z.wir.track_id, z.mb ? z.mb_i : null]));
    if (sperrenLoesen && r.form.get('sperren_loesen')) body.sperren_loesen = true;
  }
  const ok = await versuche(() => api.post(`/admin/editionen/${ed.id}/mb-uebernehmen`, body));
  if (!ok) return false;
  await dialog({ titel: t('Übernommen'), inhalt: `<pre class="log">${ok.log.map(h).join('\n')}</pre>`, knoepfe: [{ text: 'OK', wert: 'ok' }] });
  return true;
}

// ---------------------------------------------------------------------------------------------
// Bearbeiten-Dialoge
// ---------------------------------------------------------------------------------------------

/** Ereignisse im Sicherheitsprotokoll lesbar (unbekannte: Unterstriche zu Leerzeichen) */
const EREIGNISSE = {
  album_bearbeitet: () => t('Album bearbeitet'),
  app_anmeldung: () => t('App angemeldet'),
  cover_geaendert: () => t('Cover geändert'),
  dateien_aufraeumen: () => t('Dateien aufgeräumt'),
  datenbank_passwort_geaendert: () => t('Datenbank-Passwort geändert'),
  datenbank_zugang_angezeigt: () => t('Datenbank-Zugang angezeigt'),
  edition_bearbeitet: () => t('Edition bearbeitet'),
  edition_geloescht: () => t('Edition gelöscht'),
  einstellungen_geaendert: () => t('Einstellungen geändert'),
  geraet_verdraengt: () => t('Gerät abgemeldet (zu viele)'),
  konto_angelegt: () => t('Konto angelegt'),
  konto_entsperrt: () => t('Konto entsperrt'),
  konto_freigeschaltet: () => t('Konto freigeschaltet'),
  konto_geaendert: () => t('Konto geändert'),
  konto_geloescht: () => t('Konto gelöscht'),
  konto_gesperrt: () => t('Konto gesperrt'),
  konto_verlaengert: () => t('Konto verlängert'),
  kuenstler_bearbeitet: () => t('Künstler bearbeitet'),
  kuenstler_musicbrainz: () => t('Künstler mit MusicBrainz verknüpft'),
  login_erfolgreich: () => t('Anmeldung'),
  mitwirkende_ergaenzt: () => t('Mitwirkende ergänzt'),
  musicbrainz_geloest: () => t('MusicBrainz-Verknüpfung gelöst'),
  musicbrainz_uebernommen: () => t('MusicBrainz übernommen'),
  name_geaendert: () => t('Name geändert'),
  papierkorb_geleert: () => t('Papierkorb geleert'),
  passwort_geaendert: () => t('Passwort geändert'),
  passwort_gesetzt: () => t('Passwort gesetzt'),
  rechte_repariert: () => t('Rechte repariert'),
  registrierung_abgelehnt: () => t('Registrierung abgelehnt'),
  sicherung_erstellt: () => t('Sicherung erstellt'),
  sicherung_geloescht: () => t('Sicherung gelöscht'),
  titel_bearbeitet: () => t('Titel bearbeitet'),
  titel_uebernommen: () => t('Titel übernommen'),
  titelliste_bearbeitet: () => t('Titelliste bearbeitet'),
};
const ereignisText = (e) => EREIGNISSE[e]?.() || String(e || '').replace(/_/g, ' ');

const VERBINDUNGEN = ['', ' & ', ', ', ' feat. ', ' x ', ' vs. ', ' und ', ' with ', ' / '];

/** Eine Zeile im Künstler-Editor (Name + Verbindungswort zum nächsten) */
function kZeile(k, i) {
  return `<div class="form-zeilen" data-k-zeile style="grid-template-columns:1fr 130px auto;align-items:end">
    <div><input type="text" name="k_name" value="${h(k.name)}" data-k-id="${k.id || ''}" list="k-vorschlaege" autocomplete="off" aria-label="${t('Künstler {n}', { n: i + 1 })}" required></div>
    <div><select name="k_verb" aria-label="${t('Verbindung')}">${VERBINDUNGEN.map((v) => `<option value="${h(v)}" ${v === (k.verbindung || '') ? 'selected' : ''}>${v.trim() === '' ? t('(Ende)') : h(v.trim())}</option>`).join('')}</select></div>
    <div><button type="button" class="btn-ico" data-k-weg aria-label="${t('Entfernen')}">${icon('zu', 16)}</button></div></div>`;
}

/** HTML des Künstler-Editors (mehrere echte Künstler mit Verbindungswörtern) */
function kuenstlerEditor(liste) {
  return `<div data-kuenstler>${(liste.length ? liste : [{ name: '', verbindung: '' }]).map(kZeile).join('')}</div>
    <datalist id="k-vorschlaege"></datalist>
    <button type="button" class="pille" data-k-neu style="margin-top:6px">${icon('plus', 14)} ${t('Künstler hinzufügen')}</button>`;
}

/** Knöpfe und Namensvorschläge (vorhandene Künstler) im Editor verdrahten */
function kuenstlerEditorEinrichten(el) {
  const liste = el.querySelector('[data-kuenstler]');
  if (!liste) return;
  el.querySelector('[data-k-neu]').addEventListener('click', () => {
    const letzte = liste.querySelector('[data-k-zeile]:last-child select');
    if (letzte && !letzte.value) letzte.value = ' & ';
    liste.insertAdjacentHTML('beforeend', kZeile({ name: '', verbindung: '' }, liste.children.length));
    liste.lastElementChild.querySelector('input').focus();
  });
  liste.addEventListener('click', (e) => { const b = e.target.closest('[data-k-weg]'); if (b && liste.children.length > 1) b.closest('[data-k-zeile]').remove(); });
  const dl = el.querySelector('#k-vorschlaege');
  let vorschlagTimer = null;
  liste.addEventListener('input', (e) => {
    if (e.target.name !== 'k_name') return;
    clearTimeout(vorschlagTimer);
    const q = e.target.value.trim();
    if (q.length < 2) return;
    vorschlagTimer = setTimeout(async () => {
      try {
        const r = await api.get(`/kuenstler?alle=1&pro_seite=10&q=${encodeURIComponent(q)}`);
        dl.innerHTML = r.kuenstler.map((k) => `<option value="${h(k.name)}"></option>`).join('');
      } catch { /* Vorschläge sind nur Komfort */ }
    }, 200);
  });
}

/** Künstlerliste aus dem Formular lesen; IDs bleiben nur, wenn der Name unverändert ist */
function kuenstlerAusForm(element, form, alt) {
  const namen = form.getAll('k_name');
  const verb = form.getAll('k_verb');
  const ids = [...element.querySelectorAll('[name="k_name"]')].map((i) => Number(i.dataset.kId) || null);
  return namen.map((n, i) => ({ name: String(n).trim(), verbindung: i < namen.length - 1 ? (verb[i] || ' & ') : '', id: ids[i] }))
    .map((k) => ({ ...k, id: alt.some((x) => x.id === k.id && x.name === k.name) ? k.id : null })).filter((k) => k.name);
}

const kreditText = (l) => l.map((k) => k.name + (k.verbindung || '')).join('');

export async function albumBearbeiten(app, albumId, nachher) {
  const a = await versuche(() => api.get(`/admin/alben/${albumId}`));
  if (!a) return;
  const d = await dialog({
    titel: t('Album bearbeiten'),
    breit: true,
    inhalt: `
      <label>${t('Titel ')}</label><input type="text" name="titel" value="${h(a.titel)}" required maxlength="500">
      <label>${t('Albumkünstler')} <small>${t('(jeder Künstler einzeln – so landet das Album bei allen auf der Künstlerseite)')}</small></label>
      ${kuenstlerEditor(a.kuenstler)}
      <div class="form-zeilen" style="margin-top:4px">
        <div><label>${t('Art')}</label><select name="typ">${Object.entries(TYP_NAMEN).map(([k, n]) => `<option value="${k}" ${a.typ === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div><label>${t('Erstveröffentlichung (Jahr)')}</label><input type="number" name="jahr" value="${a.jahr ?? ''}" min="1000" max="2200"></div>
      </div>
      <label>${t('Zusätzlich')}</label><div style="display:flex;flex-wrap:wrap;gap:4px 16px">${['compilation', 'soundtrack', 'live', 'remix', 'dj-mix', 'demo', 'spokenword', 'audiobook', 'audio drama'].map((z) => `<label class="checkbox-zeile" style="margin:2px 0"><input type="checkbox" name="zusatz" value="${z}" ${a.zusatz.includes(z) ? 'checked' : ''}> ${ZUSATZ_NAMEN[z]}</label>`).join('')}</div>
      <label>${t('Genres / Schlagworte')} <small>${t('(mit Komma trennen, frei wählbar)')}</small></label><input type="text" name="genres" value="${h(a.genres.join(', '))}">
      <label>${t('Beschreibung')}</label><textarea name="beschreibung" rows="5">${h(a.beschreibung)}</textarea>
      ${sperrFelder('album', a.gesperrt)}
      <h4 style="margin:22px 0 8px;font-size:1rem">${t('Editionen')}</h4>
      ${a.editionen.map((e) => `<div class="track" style="grid-template-columns:48px minmax(0,1fr) auto">
        <span style="width:48px;height:48px;border-radius:8px;overflow:hidden;display:block;background:rgba(255,181,71,.14)">${e.cover ? `<img src="${h(e.cover)}" alt="" style="width:100%;height:100%;object-fit:cover">` : ''}</span>
        <div class="track-haupt"><div class="track-titel">${h(e.titel)} ${e.quelle === 'musicbrainz' ? '<span class="marke marke-akzent">MusicBrainz</span>' : '<span class="marke">Tags</span>'}${e.angezeigt ? ` <span class="marke">${t('angezeigt')}</span>` : ''}</div>
          <div class="track-unter">${h([mbDatum(e.datum), land(e.land), e.format, t('{a}/{b} Titel', { a: e.dateien, b: e.tracks }), e.qualitaet].filter(Boolean).join(' · '))}</div><div class="track-unter" style="color:var(--text-leise)">${h(e.ordner)}</div></div>
        <div class="zeilen-knoepfe"><a class="btn btn-klein ${e.quelle === 'musicbrainz' ? 'btn-zweit' : ''}" href="/verwaltung/abgleich/${e.id}" data-link data-schliessen>${t('Abgleichen')}</a>
          <button type="button" class="btn-ico" data-ed-menue="${e.id}" data-menue-anker aria-label="${t('Edition bearbeiten')}">${icon('mehr', 18)}</button></div></div>`).join('')}`,
    knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Speichern'), wert: 'ok' }],
    beimOeffnen: (el) => {
      kuenstlerEditorEinrichten(el);
      el.querySelectorAll('[data-schliessen]').forEach((x) => x.addEventListener('click', () => el.close()));
      el.querySelectorAll('[data-ed-menue]').forEach((b) => b.addEventListener('click', () => {
        const e = a.editionen.find((x) => x.id === Number(b.dataset.edMenue));
        editionMenue(app, b, { ...e, album_id: a.id }, nachher, () => el.close());
      }));
    },
  });
  if (!d) return;
  const f = d.form;
  const kuenstler = kuenstlerAusForm(d.element, f, a.kuenstler);
  const daten = {
    titel: f.get('titel'), typ: f.get('typ'), jahr: f.get('jahr') || null, zusatz: f.getAll('zusatz'), beschreibung: f.get('beschreibung'),
    genres: String(f.get('genres') || '').split(',').map((g) => g.trim()).filter(Boolean), gesperrt: f.getAll('gesperrt'),
  };
  if (kreditText(kuenstler) !== kreditText(a.kuenstler)) daten.kuenstler = kuenstler;
  if (await versuche(() => api.put(`/admin/alben/${albumId}`, daten), t('Gespeichert'))) nachher();
}

/** Menü zu einer Edition (Album-Seite und Album-Dialog): bearbeiten, Titelliste, Cover, anzeigen, löschen */
/* ---------- Von unterwegs: Cloudflare Tunnel ---------- */
export function tunnelEinrichten(box, signal) {
  let stand = null, poll = null, meldung = '', liste = null, gewaehlt = '';
  const schritteHtml = (lauf) => {
    if (!lauf?.schritte?.length) return '';
    return `<ol class="direkt-schritte">${lauf.schritte.map((x) => `<li class="${h(x.status)}"><span class="i">${SCHRITT_ICON[x.status] || '·'}</span><span><b>${h(x.text)}</b>${x.info ? `<small>${h(x.info)}</small>` : ''}</span></li>`).join('')}</ol>
      ${!lauf.laeuft && lauf.meldung ? `<p class="hinweis" style="margin-top:8px;color:${lauf.ok ? 'var(--success)' : 'var(--danger, #ff7a6b)'}">${h(lauf.meldung)}</p>` : ''}`;
  };
  const laden = async () => {
    stand = await api.get('/admin/tunnel', { signal }).catch((e) => { if (e.name !== 'AbortError') box.innerHTML = `<p class="hinweis">${h(e.message)}</p>`; return null; });
    if (!stand) return;
    gewaehlt = gewaehlt || (stand.fremd ? stand.id : '');
    zeichnen();
    if (stand.modus === 'vorhanden' && stand.token_gesetzt && liste === null) {
      liste = [];
      try { liste = (await api.get('/admin/tunnel/liste', { signal })).tunnel || []; } catch (e) { if (e.name !== 'AbortError') meldung = e.message; }
      if (!gewaehlt && liste.length === 1) gewaehlt = liste[0].id;
      zeichnen();
    }
  };
  const zeichnen = () => {
    const s = stand, laeuft = !!s.lauf?.laeuft, L = s.links || {}, fremd = s.modus === 'vorhanden';
    const verb = s.verbindungen || [];
    const proxyText = s.proxy_env?.length ? t('aus der .env (PROXY_IPS): {liste}', { liste: s.proxy_env.join(', ') })
      : s.proxy_eingetragen ? t('eingetragen: {x}', { x: s.proxy_eingetragen })
        : !fremd && s.container_ip ? t('Tunnel-Container im Stack ({ip})', { ip: s.container_ip })
          : fremd ? t('noch nicht eingetragen – Besucher-IPs werden dann nicht erkannt (Login-Sperre, „zuhause“)') : t('Tunnel-Container nicht gefunden – läuft der Dienst „tunnel“ im Stack?');
    box.innerHTML = `
      <div class="direkt-kopf">
        <div>
          <h2 style="font-size:1.15rem;margin-bottom:4px">${t('Von unterwegs: Cloudflare Tunnel')}</h2>
          <p class="hinweis" style="margin:0">${fremd
    ? t('Du betreibst schon ein cloudflared auf dem Server oder im Netz. Amberwave trägt nur seine Regel in dessen Tunnel ein – alle anderen Regeln bleiben, dein cloudflared übernimmt die Änderung sofort, ohne Neustart.')
    : t('Amberwave legt den Tunnel selbst an. Der Dienst „tunnel“ im Stack (cloudflared) baut eine ausgehende Verbindung zu Cloudflare auf – kein offener Port im Router, kein Portforwarding, funktioniert auch hinter CGNAT.')} ${t('Nutzt das Cloudflare-Token vom Direktzugang; es braucht zusätzlich das Recht <b>Konto · Cloudflare Tunnel · Bearbeiten</b>.')}</p>
          <p class="hinweis" style="margin:6px 0 0;font-size:.85rem">${t('Für den Tunnel gelten die <a href="https://www.cloudflare.com/terms/" target="_blank" rel="noopener">Nutzungsbedingungen von Cloudflare</a>. Sie sehen große Mediendateien ohne Bezahldienste eigentlich nicht vor – Musik in Haushaltsmengen ist eine Grauzone. Alternativen ohne Cloudflare: Tailscale/WireGuard oder ein eigener Reverse Proxy.')}</p>
        </div>
        ${s.aktiv ? `<span class="marke ${s.verbunden ? 'marke-gut' : ''}">${s.verbunden ? t('● Tunnel verbunden') : s.status === 'geloescht' ? t('○ bei Cloudflare gelöscht') : t('○ Tunnel nicht verbunden')}</span>` : ''}
      </div>
      <div class="tunnel-modus">
        <span class="${fremd ? '' : 'an'}">${t('Eigener Container im Stack')}</span><span class="${fremd ? 'an' : ''}">${t('Vorhandenes cloudflared')}</span>
        <small>${t('Umschalten in der .env: <code>TUNNEL_IM_STACK={wert}</code>, dann den Stack neu starten{zusatz}.', { wert: fremd ? '1' : '0', zusatz: fremd ? '' : t(' (bei 0 legt Compose den Container „tunnel“ nicht an)') })}</small>
      </div>
      ${s.aktiv ? `<div class="direkt-status">
        <div><small>${t('Adresse')}</small><b><a href="${h(s.url)}" target="_blank" rel="noopener">${h(s.url)}</a></b></div>
        <div><small>${t('Verbindungen')}</small><b>${verb.length ? verb.map((v) => h(v.ort)).join(' · ') : t('keine')}</b>${s.version ? `<small>cloudflared ${h(s.version)}</small>` : ''}${s.name ? `<small>${t('Tunnel „{name}“{x}', { name: h(s.name), x: s.fremd ? t(' (vorhanden)') : '' })}</small>` : ''}</div>
        <div><small>${t('Weiterleitung')}</small><b>${h(s.host)} → ${h(s.ziel)}</b></div>
        <div><small>${t('Diese Seite')}</small><b>${s.diese_anfrage_im_tunnel ? t('kommt durch den Tunnel') : t('kommt nicht durch den Tunnel')}</b><small>Proxy: ${h(proxyText)}</small></div>
      </div>` : ''}
      ${s.fehler ? `<p class="hinweis" style="color:var(--accent-text)">Cloudflare: ${h(s.fehler)}</p>` : ''}
      ${!s.token_gesetzt ? `<p class="hinweis" style="color:var(--accent-text)">${t('Bitte zuerst oben beim Direktzugang das Cloudflare-Token eintragen.')}</p>` : ''}
      ${fremd ? `<div class="direkt-schritt" ${s.token_gesetzt ? '' : 'data-aus'}>
        <h3><span class="nr">1</span> ${t('Vorhandener Tunnel')}</h3>
        ${liste === null ? `<p class="hinweis">${t('Tunnel werden geladen …')}</p>` : !liste.length ? `<p class="hinweis">${t('Kein Tunnel in deinem Cloudflare-Konto gefunden – oder dem Token fehlt „Konto · Cloudflare Tunnel · Bearbeiten“.')}</p>`
    : `<div class="tunnel-liste">${liste.map((tu) => `<label class="tunnel-eintrag${tu.remote ? '' : ' aus'}"><input type="radio" name="tunnel-wahl" value="${h(tu.id)}" ${tu.id === gewaehlt ? 'checked' : ''} ${tu.remote ? '' : 'disabled'}><span><b>${h(tu.name)}</b><small>${h(tu.status)} · ${tn(tu.verbindungen, '{n} Verbindung', '{n} Verbindungen')}${tu.konto_name ? ` · ${h(tu.konto_name)}` : ''}${tu.remote ? '' : t(' · lokal per config.yml konfiguriert – nicht änderbar')}</small></span></label>`).join('')}</div>`}
        <div class="direkt-felder" style="margin-top:10px"><label>${t('Ziel: so erreicht dein cloudflared die App')} <input type="text" data-t-ziel value="${h(s.fremd && s.ziel && !s.ziel.includes('<') ? s.ziel : (s.ziel_vorschlag.includes('<') ? '' : s.ziel_vorschlag))}" placeholder="${h(s.ziel_vorschlag)}"></label></div>
        <p class="hinweis" style="margin:6px 0 0">${t('Läuft cloudflared als eigener Docker-Container auf demselben Unraid, ist das die Server-IP mit dem App-Port; läuft es im selben Docker-Netz, geht auch <code>http://amberwave_app:80</code>.')}</p>
      </div>` : ''}
      <div class="direkt-schritt" ${s.token_gesetzt ? '' : 'data-aus'}>
        <h3><span class="nr">${fremd ? 2 : 1}</span> ${t('Öffentlicher Name')}</h3>
        <div class="direkt-felder"><label>${t('Name')} <input type="text" data-t-host value="${h(s.host || s.vorschlag_host)}" placeholder="musik.example.de"></label></div>
        <p class="hinweis" style="margin:6px 0 0">${t('Eine Domain bei Cloudflare. Amberwave setzt den DNS-Eintrag (über Cloudflare, orange Wolke) und die Weiterleitung.')}${s.app_url_aus_env ? '' : ' ' + t('Ohne <code>APP_URL</code> in der .env gilt diese Adresse danach als öffentliche Adresse der App.')}</p>
      </div>
      <div class="direkt-schritt" ${s.token_gesetzt ? '' : 'data-aus'}>
        <h3><span class="nr">${fremd ? 3 : 2}</span> ${t('Einrichten')}</h3>
        <div class="aktionen">
          <button type="button" class="btn" data-t-los ${laeuft || !s.token_gesetzt ? 'disabled' : ''}>${laeuft ? t('Läuft …') : s.aktiv ? t('Erneut einrichten') : fremd ? t('Regel eintragen') : t('Tunnel einrichten')}</button>
          ${s.aktiv ? `<button type="button" class="btn btn-zweit" data-t-neu>${t('Status aktualisieren')}</button><button type="button" class="btn btn-zweit btn-rot-text" data-t-weg>${s.fremd ? t('Regel entfernen') : t('Tunnel entfernen')}</button>` : ''}
        </div>
        ${schritteHtml(s.lauf)}
      </div>
      ${fremd ? `<div class="direkt-schritt" ${s.token_gesetzt ? '' : 'data-aus'}>
        <h3><span class="nr">4</span> ${t('Proxy-Adresse')}</h3>
        <p class="hinweis" style="margin:0 0 8px">${t('Damit Amberwave die echte Besucher-IP sieht (Login-Sperre, Erkennung „zuhause“), muss es wissen, von welcher Adresse dein cloudflared die Anfragen weiterreicht. Aktuell: <b>{x}</b>.', { x: h(proxyText) })}</p>
        ${s.proxy_vorschlag && !s.proxy_env?.length ? `<p class="hinweis" style="margin:0 0 8px;color:var(--accent-text)">${t('Diese Seite kam mit Cloudflare-Kopfzeilen von <b>{ip}</b>, der Adresse wird aber noch nicht vertraut. <button type="button" class="link-knopf" data-t-proxy-uebernehmen>Als Proxy eintragen</button>', { ip: h(s.proxy_vorschlag) })}</p>` : ''}
        ${s.proxy_env?.length ? '' : `<div class="direkt-zeile"><input type="text" data-t-proxy value="${h(s.proxy_eingetragen || '')}" placeholder="${t('172.17.0.11 oder 172.17.0.0/16')}"><button type="button" class="btn btn-zweit" data-t-proxy-speichern>${t('Speichern')}</button></div>`}
      </div>` : ''}
      ${meldung ? `<p class="hinweis" style="margin-top:8px;color:var(--accent-text);white-space:pre-line">${h(meldung)}</p>` : ''}
      <p class="hinweis tunnel-fuss">${t('Verbindung über <b>Cloudflare Tunnel</b>. cloudflared ist freie Software (<a href="{lizenz}" target="_blank" rel="noopener">Apache-Lizenz 2.0</a>); für den Tunnel gelten die <a href="{bedingungen}" target="_blank" rel="noopener">Nutzungsbedingungen</a> und die <a href="{datenschutz}" target="_blank" rel="noopener">Datenschutzerklärung</a> von Cloudflare (<a href="{doku}" target="_blank" rel="noopener">Dokumentation</a>). Cloudflare ist eine Marke von Cloudflare, Inc.; Amberwave steht in keiner Verbindung zu Cloudflare. Hinweis: Cloudflares CDN-Bedingungen sehen Video und große Dateien ohne Bezahldienste nicht vor – Musik in Haushaltsmengen ist eine Grauzone, zuhause holt Amberwave die Musik ohnehin direkt aus dem Heimnetz.', { lizenz: h(L.lizenz || '#'), bedingungen: h(L.bedingungen || '#'), datenschutz: h(L.datenschutz || '#'), doku: h(L.doku || '#') })}</p>`;
    box.querySelectorAll('[name="tunnel-wahl"]').forEach((r) => r.addEventListener('change', () => { gewaehlt = r.value; }));
    box.querySelector('[data-t-neu]')?.addEventListener('click', () => { liste = null; laden(); });
    box.querySelector('[data-t-los]')?.addEventListener('click', async () => {
      const host = box.querySelector('[data-t-host]').value.trim();
      const daten = { host };
      if (fremd) { daten.tunnel = gewaehlt; daten.ziel = box.querySelector('[data-t-ziel]').value.trim(); }
      meldung = '';
      stand.lauf = { laeuft: true, schritte: [{ text: t('Startet …'), status: 'laeuft' }] };
      zeichnen();
      clearInterval(poll);
      poll = setInterval(async () => { const r = await api.get('/admin/tunnel?kurz=1').catch(() => null); if (r?.lauf?.laeuft) { stand = { ...stand, lauf: r.lauf }; zeichnen(); } }, 1500);
      try { stand = await api.post('/admin/tunnel/einrichten', daten); } catch (err) { meldung = err.message; await laden(); }
      clearInterval(poll);
      zeichnen();
    });
    box.querySelector('[data-t-weg]')?.addEventListener('click', async () => {
      const text = stand.fremd ? t('Amberwaves Regel für {host} wird aus dem Tunnel genommen und der DNS-Eintrag gelöscht. Der Tunnel selbst bleibt.', { host: stand.host }) : t('Der Tunnel und der DNS-Eintrag {host} werden bei Cloudflare gelöscht. Von unterwegs ist Amberwave danach nicht mehr erreichbar.', { host: stand.host });
      if (!await bestaetigen(stand.fremd ? t('Regel entfernen?') : t('Tunnel entfernen?'), text, t('Entfernen'))) return;
      try { stand = await api.post('/admin/tunnel/entfernen'); meldung = stand.probleme?.length ? stand.probleme.join('\n') : t('Entfernt.'); } catch (err) { meldung = err.message; }
      zeichnen();
    });
    const proxySetzen = async (ip) => {
      try { stand = { ...stand, ...(await api.post('/admin/tunnel/proxy', { ip })) }; meldung = ip ? t('Proxy {ip} eingetragen.', { ip }) : t('Proxy-Adresse entfernt.'); } catch (err) { meldung = err.message; }
      zeichnen();
    };
    box.querySelector('[data-t-proxy-uebernehmen]')?.addEventListener('click', () => proxySetzen(stand.proxy_vorschlag));
    box.querySelector('[data-t-proxy-speichern]')?.addEventListener('click', () => proxySetzen(box.querySelector('[data-t-proxy]').value.trim()));
  };
  laden();
}

export function editionMenue(app, anker, e, nachher, vorher = () => {}) {
  const los = (fn) => () => { vorher(); fn(); };
  const eintraege = [
    { text: t('Edition bearbeiten …'), icon: 'bearbeiten', aktion: los(() => editionBearbeiten(app, e, nachher)) },
    { text: t('Titelliste bearbeiten …'), icon: 'warteschlange', aktion: los(() => titellisteBearbeiten(app, e.id, nachher)) },
    { text: t('Mitwirkende bearbeiten …'), icon: 'kuenstler', aktion: los(() => mitwirkendeBearbeiten(app, e, nachher)) },
    { text: t('Cover hochladen …'), icon: 'album', aktion: los(() => coverHochladen(app, e, nachher)) },
    ...(e.mbid ? [{ text: t('Cover von MusicBrainz'), icon: 'download', aktion: async () => { if (await versuche(() => api.post(`/admin/editionen/${e.id}/cover`, { quelle: 'musicbrainz' }), t('Cover übernommen'))) { vorher(); nachher(); } } }] : []),
    { text: t('Cover aus den Dateien'), icon: 'verlauf', aktion: async () => { if (await versuche(() => api.post(`/admin/editionen/${e.id}/cover`, { quelle: 'datei' }), t('Cover neu gelesen'))) { vorher(); nachher(); } } },
    { text: t('Mit MusicBrainz abgleichen'), icon: 'suche', aktion: los(() => app.navigieren(`/verwaltung/abgleich/${e.id}`)) },
    { text: t('Verlustfreie Titel in FLAC umwandeln'), icon: 'download', aktion: los(() => flacUmwandeln(app, e.id, nachher)) },
  ];
  if (e.album_id && !e.angezeigt) {
    eintraege.push({ text: t('Diese Edition anzeigen'), icon: 'alben', aktion: async () => { if (await versuche(() => api.put(`/admin/alben/${e.album_id}/edition`, { edition_id: e.id }), t('Wird jetzt angezeigt'))) { vorher(); nachher(); } } });
  }
  eintraege.push({ trenner: true }, { text: t('Edition löschen …'), icon: 'muell', rot: true, aktion: los(() => editionLoeschen(app, e, nachher)) });
  menue(anker, eintraege);
}

export async function editionBearbeiten(app, e0, nachher) {
  const e = await versuche(() => api.get(`/admin/editionen/${e0.id}`));
  if (!e) return;
  const labelZeile = (l) => `<div class="form-zeilen label-zeile" style="margin-bottom:6px"><div><input type="text" name="label_name" value="${h(l.name)}" placeholder="Label" maxlength="500" aria-label="Label"></div>
    <div><input type="text" name="label_kat" value="${h(l.katalognummer)}" placeholder="${t('Katalognummer')}" maxlength="100" aria-label="${t('Katalognummer')}"></div></div>`;
  const d = await dialog({
    titel: t('Edition bearbeiten'),
    inhalt: `<label>${t('Titel ')}</label><input type="text" name="titel" value="${h(e.titel)}" required>
      <label>${t('Name der Version')} <small>${t('(z. B. „Remaster“, „Deluxe Edition“ – erscheint hinter dem Albumtitel, auch in den Dateien)')}</small></label><input type="text" name="kommentar" value="${h(e.kommentar)}" maxlength="255">
      <div class="form-zeilen"><div><label>${t('Datum')} <small>${t('(TT.MM.JJJJ, MM.JJJJ oder JJJJ)')}</small></label><input type="text" name="datum" value="${h(datumEingabe(e.datum))}" placeholder="${t('TT.MM.JJJJ')}"></div>
      <div><label>${t('Land')} <small>${t('(Kürzel, z. B. DE, US)')}</small></label><input type="text" name="land" value="${h(e.land)}" maxlength="10"></div></div>
      <div class="form-zeilen"><div><label>${t('Format')} <small>${t('(z. B. CD, Vinyl, Digital Media)')}</small></label><input type="text" name="format" value="${h(e.format)}" maxlength="120"></div>
      <div><label>Barcode</label><input type="text" name="barcode" value="${h(e.barcode)}" maxlength="40" inputmode="numeric"></div></div>
      <label>${t('Label und Katalognummer')}</label><div data-labels>${(e.labels.length ? e.labels : [{ name: '', katalognummer: '' }]).map(labelZeile).join('')}</div>
      <button type="button" class="btn btn-zweit btn-klein" data-label-plus style="margin-top:2px">${icon('plus', 16)}<span>${t('Weiteres Label')}</span></button>
      ${e.editionen_im_album > 1 && !e.angezeigt ? `<label class="checkbox-zeile" style="margin-top:16px"><input type="checkbox" name="anzeigen" value="1"> ${t('Diese Edition in der Familie anzeigen')}</label>` : ''}
      <p class="hinweis" style="margin:14px 0 0">${t('Ordner')}: ${h(e.ordner || '–')} · ${t('{a}/{b} Titel mit Datei', { a: e.dateien, b: e.tracks.length })}</p>
      ${sperrFelder('edition', e.gesperrt)}`,
    knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Edition löschen …'), wert: 'loeschen', art: 'gefahr' }, { text: t('Speichern'), wert: 'ok' }],
    beimOeffnen: (el) => el.querySelector('[data-label-plus]').addEventListener('click', () => {
      el.querySelector('[data-labels]').insertAdjacentHTML('beforeend', labelZeile({ name: '', katalognummer: '' }));
      el.querySelector('[data-labels] .label-zeile:last-child input')?.focus();
    }),
  });
  if (!d) return;
  if (d.wert === 'loeschen') { editionLoeschen(app, e, nachher); return; }
  const namen = d.form.getAll('label_name');
  const kats = d.form.getAll('label_kat');
  const daten = {
    titel: d.form.get('titel'), datum: d.form.get('datum'), land: d.form.get('land'), kommentar: d.form.get('kommentar'), gesperrt: d.form.getAll('gesperrt'),
    format: d.form.get('format'), barcode: d.form.get('barcode'), labels: namen.map((n, i) => ({ name: n, katalognummer: kats[i] || '' })),
  };
  if (!(await versuche(() => api.put(`/admin/editionen/${e.id}`, daten), t('Gespeichert')))) return;
  if (d.form.get('anzeigen') === '1') await versuche(() => api.put(`/admin/alben/${e.album_id}/edition`, { edition_id: e.id }), t('Wird jetzt angezeigt'));
  nachher();
}

/** Edition löschen: mit Dateien wandern sie in den Papierkorb im Musikordner (sonst käme die Edition beim nächsten Einlesen zurück) */
export async function editionLoeschen(app, e0, nachher) {
  const e = await versuche(() => api.get(`/admin/editionen/${e0.id}`));
  if (!e) return;
  const hatDateien = e.dateien > 0;
  const einzige = e.editionen_im_album <= 1;
  const d = await dialog({
    titel: t('Edition löschen?'),
    inhalt: `<p><b>${h(e.titel)}</b>${e.jahr ? ` (${e.jahr})` : ''} ${h(t('von {k}', { k: e.kuenstler_text || '–' }))}</p>
      ${hatDateien
        ? `<p>${tn(e.dateien, 'Die <b>{n} Datei</b> aus <code>{ordner}</code> wird in den Papierkorb im Musikordner verschoben (<code>.amberwave-papierkorb</code>) und dort einige Tage aufgehoben. Liegt danach keine Musik mehr im Ordner, kommen auch Cover und Beilagen mit.', 'Die <b>{n} Dateien</b> aus <code>{ordner}</code> werden in den Papierkorb im Musikordner verschoben (<code>.amberwave-papierkorb</code>) und dort einige Tage aufgehoben. Liegt danach keine Musik mehr im Ordner, kommen auch Cover und Beilagen mit.', { ordner: h(e.ordner || '?') })}</p>
           <p class="hinweis" style="margin:0 0 10px">${t('Zurückholen: Dateien aus dem Papierkorb wieder in den Ordner legen und die Bibliothek einlesen.')}</p>`
        : `<p>${t('Zu dieser Edition gibt es keine Dateien – es wird nur der Eintrag in der Bibliothek entfernt.')}</p>`}
      ${einzige ? `<p style="color:var(--accent-text)">${t('<b>Das ist die einzige Edition:</b> das ganze Album verschwindet damit aus der Bibliothek.')}</p>` : ''}
      <p class="hinweis" style="margin:0">${t('Favoriten, Verlauf und Playlist-Einträge dieser Titel gehen verloren.')}</p>`,
    knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: hatDateien ? t('In den Papierkorb und löschen') : t('Löschen'), wert: 'ja', art: 'gefahr' }],
  });
  if (!d) return;
  const r = await versuche(() => api.post(`/admin/editionen/${e.id}/loeschen`, hatDateien ? { dateien: 'papierkorb' } : {}),
    hatDateien ? t('Edition gelöscht, Dateien liegen im Papierkorb') : t('Edition gelöscht'));
  if (!r) return;
  // Auf der Seite des gelöschten Albums (oder der gelöschten Edition) geht es mit der Albumliste bzw. dem Album weiter
  const aufAlbum = location.pathname === `/alben/${r.album_id}`;
  if (r.album_geloescht && aufAlbum) { app.navigieren('/alben'); return; }
  if (aufAlbum && location.search) history.replaceState(history.state || {}, '', location.pathname);
  nachher();
}

export async function coverHochladen(app, e, nachher) {
  const d = await dialog({
    titel: t('Cover hochladen'),
    inhalt: `<label>${t('Bild (JPG, PNG oder WebP, am besten quadratisch, mind. 600 px)')}</label><input type="file" name="bild" accept="image/jpeg,image/png,image/webp" required>`,
    knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Hochladen'), wert: 'ok' }],
  });
  if (!d) return;
  const fd = new FormData();
  fd.append('bild', d.form.get('bild'));
  if (await versuche(() => api.post(`/admin/editionen/${e.id}/cover`, fd), t('Cover gespeichert'))) nachher();
}

export async function mitwirkendeBearbeiten(app, e, nachher) {
  let daten = await versuche(() => api.get(`/admin/editionen/${e.id}/mitwirkende`));
  if (!daten) return;
  const zeichnen = (el) => {
    const nachTrack = new Map(daten.tracks.map((t) => [t.aufnahme_id, t]));
    el.querySelector('[data-liste]').innerHTML = daten.eintraege.length ? daten.eintraege.map((x) => `<div class="credit" style="justify-content:space-between;border-bottom:1px solid rgba(255,236,214,.07);padding:7px 0">
      <span><b>${h(x.kuenstler.name)}</b> <span class="rolle">${h(x.instrumente || x.rolle)} · ${x.zu_art === 'edition' ? t('ganze Edition') : h(nachTrack.get(x.zu_id)?.label + ' ' + (nachTrack.get(x.zu_id)?.titel || ''))}</span> <span class="marke">${{ manuell: t('von Hand'), musicbrainz: 'MusicBrainz', tags: 'Tags' }[x.quelle]}</span></span>
      <button type="button" class="btn-ico" data-weg="${x.id}" aria-label="${t('Entfernen')}">${icon('muell', 16)}</button></div>`).join('') : `<p class="hinweis">${t('Noch keine Mitwirkenden.')}</p>`;
  };
  await dialog({
    titel: t('Mitwirkende – {titel}', { titel: e.titel }),
    breit: true,
    inhalt: `<p class="hinweis" style="margin-top:0">${t('Von Hand Eingetragenes bleibt bei jedem neuen Abgleich erhalten. Einträge von MusicBrainz oder aus den Tags werden beim nächsten Abgleich wieder überschrieben.')}</p>
      <div data-liste style="max-height:38vh;overflow-y:auto"></div>
      <h4 style="margin:18px 0 4px;font-size:1rem">${t('Hinzufügen')}</h4>
      <div class="form-zeilen"><div><label>${t('Name')}</label><input type="text" name="name" data-neu-name></div>
        <div><label>${t('Rolle')}</label><select data-neu-rolle>${daten.typen.map((t) => `<option value="${t.schluessel}">${h(t.name)}</option>`).join('')}</select></div></div>
      <label>${t('Instrument(e)')} <small>${t('(bei Musikern, mit Komma trennen, z. B. „guitar, bass“ oder „Gitarre“)')}</small></label><input type="text" data-neu-instr>
      <label>${t('Gilt für')}</label><div style="max-height:22vh;overflow-y:auto;border:1px solid var(--glass-border);border-radius:10px;padding:6px 10px">
        <label class="checkbox-zeile" style="margin:4px 0"><input type="checkbox" data-alle checked> ${t('Ganze Edition')}</label>
        ${daten.tracks.filter((t) => t.aufnahme_id).map((t) => `<label class="checkbox-zeile" style="margin:4px 0"><input type="checkbox" data-auf value="${t.aufnahme_id}"> ${h(t.label)} ${h(t.titel)}</label>`).join('')}</div>
      <button type="button" class="btn" data-hinzu style="margin-top:12px">${icon('plus', 16)}<span>${t('Hinzufügen')}</span></button>`,
    knoepfe: [{ text: t('Fertig'), wert: 'ok' }],
    beimOeffnen: (el) => {
      zeichnen(el);
      el.querySelectorAll('[data-auf]').forEach((c) => c.addEventListener('change', () => { el.querySelector('[data-alle]').checked = ![...el.querySelectorAll('[data-auf]')].some((x) => x.checked); }));
      el.querySelector('[data-alle]').addEventListener('change', (ev) => { if (ev.target.checked) el.querySelectorAll('[data-auf]').forEach((x) => { x.checked = false; }); });
      el.querySelector('[data-hinzu]').addEventListener('click', async () => {
        const name = el.querySelector('[data-neu-name]').value.trim();
        if (!name) { toast(t('Bitte einen Namen eingeben.'), 'fehler'); return; }
        const r = await versuche(() => api.post(`/admin/editionen/${e.id}/mitwirkende`, {
          name, rolle: el.querySelector('[data-neu-rolle]').value, instrumente: el.querySelector('[data-neu-instr]').value,
          aufnahmen: [...el.querySelectorAll('[data-auf]:checked')].map((x) => Number(x.value)),
        }), t('Hinzugefügt'));
        if (r) { daten = r; zeichnen(el); el.querySelector('[data-neu-name]').value = ''; el.querySelector('[data-neu-instr]').value = ''; }
      });
      el.querySelector('[data-liste]').addEventListener('click', async (ev) => {
        const b = ev.target.closest('[data-weg]');
        if (!b) return;
        const r = await versuche(() => api.del(`/admin/editionen/${e.id}/mitwirkende/${b.dataset.weg}`));
        if (r) { daten = r; zeichnen(el); }
      });
    },
  });
  nachher();
}

export async function kuenstlerBearbeiten(app, id, nachher) {
  let k = await versuche(() => api.get(`/admin/kuenstler/${id}`));
  if (!k) return;
  const d = await dialog({
    titel: t('Künstler bearbeiten'),
    breit: true,
    inhalt: `
      <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
        <span class="kuenstler-bild" style="width:96px;font-size:2rem" data-bild>${k.bild ? `<img src="${h(k.bild)}" alt="">` : h(k.name.slice(0, 2).toUpperCase())}</span>
        <div style="flex:1;min-width:200px"><label style="margin-top:0">${t('Bild hochladen')}</label><input type="file" accept="image/jpeg,image/png,image/webp" data-bild-datei>
          <div class="zeilen-knoepfe" style="margin-top:6px"><button type="button" class="pille" data-fanart-bild>${t('Von fanart.tv holen')}</button>${k.bild ? `<button type="button" class="pille" data-bild-weg>${t('Bild entfernen')}</button>` : ''}</div></div>
      </div>
      <div class="glass-panel" style="padding:14px 16px;margin-top:16px">
        <b>MusicBrainz</b> ${k.mbid ? `<span class="marke marke-akzent">${t('verknüpft')}</span> <a href="https://musicbrainz.org/artist/${h(k.mbid)}" target="_blank" rel="noopener" style="font-size:.85rem">${t('ansehen ↗')}</a>` : `<span class="marke">${t('nicht verknüpft')}</span>`}
        ${k.abgleich_am ? `<small class="hinweis">${t(' · zuletzt {d}', { d: datum(k.abgleich_am) })}</small>` : ''}
        <p class="hinweis" style="margin:6px 0 10px;font-size:.88rem">${t('Übernimmt Typ, Land, Lebensdaten, andere Namen und Bandmitgliedschaften.')}</p>
        <div class="zeilen-knoepfe">${k.mbid ? `<button type="button" class="btn btn-klein" data-mb-neu>${t('Daten aktualisieren')}</button>` : ''}<button type="button" class="btn btn-zweit btn-klein" data-mb-suche>${k.mbid ? t('Anderen Eintrag wählen') : t('Bei MusicBrainz suchen')}</button></div>
        <div data-mb-treffer></div>
      </div>
      <div class="form-zeilen"><div><label>${t('Name')}</label><input type="text" name="name" value="${h(k.name)}" required></div><div><label>${t('Sortiername')}</label><input type="text" name="sortname" value="${h(k.sortname)}"></div></div>
      <div class="form-zeilen"><div><label>${t('Typ')}</label><select name="typ"><option value="">–</option>${Object.entries(KUENSTLER_TYP).map(([w, n]) => `<option value="${w}" ${k.typ === w ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div><label>${t('Land')} <small>${t('(Kürzel)')}</small></label><input type="text" name="land" value="${h(k.land)}" maxlength="10"></div></div>
      <div class="form-zeilen"><div><label>${t('Beginn / geboren')}</label><input type="text" name="beginn" value="${h(datumEingabe(k.beginn))}" placeholder="${t('TT.MM.JJJJ')}"></div><div><label>${t('Ende / gestorben')}</label><input type="text" name="ende" value="${h(datumEingabe(k.ende))}" placeholder="${t('TT.MM.JJJJ')}"></div></div>
      <label>${t('Unterscheidung')} <small>${t('(z. B. „US-Rockband“ bei Namensgleichheit)')}</small></label><input type="text" name="unterscheidung" value="${h(k.unterscheidung)}">
      <label>${t('Biografie')}</label><textarea name="bio" rows="6">${h(k.bio)}</textarea>
      ${sperrFelder('kuenstler', k.gesperrt)}`,
    knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Speichern'), wert: 'ok' }],
    beimOeffnen: (el) => {
      el.querySelector('[data-bild-datei]').addEventListener('change', async (ev) => {
        const fd = new FormData();
        fd.append('bild', ev.target.files[0]);
        const r = await versuche(() => api.post(`/admin/kuenstler/${id}/bild`, fd), t('Bild gespeichert'));
        if (r?.bild) el.querySelector('[data-bild]').innerHTML = `<img src="${h(r.bild)}" alt="">`;
      });
      el.querySelector('[data-fanart-bild]').addEventListener('click', async (ev) => {
        const knopf = ev.currentTarget;
        knopf.disabled = true;
        const r = await versuche(() => api.post(`/admin/kuenstler/${id}/fanart`, {}));
        knopf.disabled = false;
        if (!r) return;
        toast(r.meldung);
        if (r.kuenstler?.bild) el.querySelector('[data-bild]').innerHTML = `<img src="${h(r.kuenstler.bild)}" alt="">`;
      });
      el.querySelector('[data-bild-weg]')?.addEventListener('click', async () => {
        if (await versuche(() => api.post(`/admin/kuenstler/${id}/bild`, { entfernen: true }), t('Bild entfernt'))) el.querySelector('[data-bild]').textContent = k.name.slice(0, 2).toUpperCase();
      });
      const uebernehmen = async (mbid) => {
        const r = await versuche(() => api.post(`/admin/kuenstler/${id}/mb-uebernehmen`, mbid ? { mbid } : {}));
        if (!r) return;
        toast(r.log.join(' '));
        el.close();
        nachher();
      };
      el.querySelector('[data-mb-neu]')?.addEventListener('click', () => uebernehmen(null));
      el.querySelector('[data-mb-suche]').addEventListener('click', async () => {
        const box = el.querySelector('[data-mb-treffer]');
        box.innerHTML = '<div class="lade" style="padding:14px 0"></div>';
        const r = await versuche(() => api.get(`/admin/kuenstler/${id}/mb-suche`));
        if (!r) { box.innerHTML = ''; return; }
        box.innerHTML = r.treffer.length ? `<div style="margin-top:10px;max-height:34vh;overflow-y:auto">${r.treffer.map((tr) => `<div class="credit" style="justify-content:space-between;border-bottom:1px solid rgba(255,236,214,.07);padding:7px 0">
          <span><b>${h(tr.name)}</b> <span class="rolle">${h([KUENSTLER_TYP[tr.typ] || '', land(tr.land), tr.beginn ? tr.beginn.slice(0, 4) + (tr.ende ? '–' + tr.ende.slice(0, 4) : '') : '', tr.unterscheidung].filter(Boolean).join(' · '))}</span></span>
          <button type="button" class="btn btn-klein" data-mb-wahl="${h(tr.mbid)}">${t('Übernehmen')}</button></div>`).join('')}</div>` : `<p class="hinweis">${t('Nichts gefunden.')}</p>`;
        box.querySelectorAll('[data-mb-wahl]').forEach((b) => b.addEventListener('click', () => uebernehmen(b.dataset.mbWahl)));
      });
    },
  });
  if (!d) return;
  const daten = Object.fromEntries(['name', 'sortname', 'typ', 'land', 'beginn', 'ende', 'unterscheidung', 'bio'].map((x) => [x, d.form.get(x)]));
  daten.gesperrt = d.form.getAll('gesperrt');
  if (await versuche(() => api.put(`/admin/kuenstler/${id}`, daten), t('Gespeichert'))) nachher();
}

/** Einen Titel bearbeiten: Name, Nummer, Künstler (auch abweichend vom Album, z. B. „feat.“) */
const EXPLIZIT_TEXT = { 0: t('nicht explizit'), 1: t('explizit'), 2: t('Clean-Fassung') };

export async function trackBearbeiten(app, trackId, nachher) {
  const tr = await versuche(() => api.get(`/admin/tracks/${trackId}`));
  if (!tr) return;
  const d = await dialog({
    titel: t('Titel bearbeiten'),
    breit: true,
    inhalt: `<p class="hinweis" style="margin-top:0">${h(tr.album_titel)}${tr.datei ? ` · <small>${h(tr.datei)}</small>` : t(' · keine Datei')}</p>
      <div class="form-zeilen" style="grid-template-columns:72px 90px 1fr">
        <div><label>CD</label><input type="number" name="disc" value="${tr.disc}" min="1" max="99" required></div>
        <div><label>${t('Nr.')}</label><input type="number" name="pos" value="${tr.pos}" min="1" max="999" required></div>
        <div><label>${t('Titel ')}</label><input type="text" name="titel" value="${h(tr.titel)}" required maxlength="500"></div>
      </div>
      <label>${t('Künstler dieses Titels')}</label>
      <label class="checkbox-zeile" style="margin:4px 0 8px"><input type="checkbox" name="wie_album" value="1" ${tr.wie_album ? 'checked' : ''} data-wie-album> ${t('Wie das Album ({x})', { x: h(kreditText(tr.album_kuenstler) || '–') })}</label>
      <div data-k-box ${tr.wie_album ? 'hidden' : ''}>${kuenstlerEditor(tr.kuenstler)}</div>
      <p class="hinweis" style="font-size:.85rem">${t('Jeder Künstler wird einzeln verknüpft – ein Gast („feat.“) taucht so auch auf seiner eigenen Künstlerseite auf.')}</p>
      <div class="form-zeilen" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);margin-top:6px">
        <div><label for="tb-explizit">${t('Kennzeichnung')}</label><select id="tb-explizit" name="explizit">
          ${[['auto', `${t('Automatisch')}${tr.explizit_quelle !== 'hand' ? ` (${EXPLIZIT_TEXT[tr.explizit] ?? t('unbekannt')}${tr.explizit_quelle === 'datei' ? t(', aus der Datei') : tr.explizit_quelle === 'deezer' ? t(', von Deezer') : ''})` : ''}`], ['1', t('Explizit (E)')], ['0', t('Nicht explizit')], ['2', t('Clean-Fassung')]]
            .map(([w, n]) => `<option value="${w}" ${(tr.explizit_quelle === 'hand' ? String(tr.explizit) : 'auto') === w ? 'selected' : ''}>${h(n)}</option>`).join('')}</select></div>
        <div><label>ISRC</label><input type="text" value="${h(tr.isrc || '–')}" readonly></div>
      </div>
      ${sperrFelder('track', tr.gesperrt)}
      <p class="hinweis" style="font-size:.85rem;margin-top:4px">${t('Was du änderst, wird automatisch geschützt. Die Datei selbst bleibt unverändert.')}</p>
      <div class="zeilen-knoepfe" style="margin-top:14px">
        <button type="button" class="pille" data-mitwirkende>${icon('kuenstler', 14)} ${t('Mitwirkende bearbeiten …')}</button>
        <button type="button" class="pille" data-titelliste>${icon('warteschlange', 14)} ${t('Ganze Titelliste …')}</button>
      </div>`,
    knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Speichern'), wert: 'ok' }],
    beimOeffnen: (el) => {
      kuenstlerEditorEinrichten(el);
      el.querySelector('[data-wie-album]').addEventListener('change', (e) => {
        const box = el.querySelector('[data-k-box]');
        box.hidden = e.target.checked;
        box.querySelectorAll('input[name="k_name"]').forEach((i) => { i.required = !e.target.checked; });
      });
      if (tr.wie_album) el.querySelectorAll('[data-k-box] input[name="k_name"]').forEach((i) => { i.required = false; });
      el.querySelector('[data-mitwirkende]').addEventListener('click', () => { el.close(); mitwirkendeBearbeiten(app, { id: tr.edition_id, titel: tr.album_titel }, nachher); });
      el.querySelector('[data-titelliste]').addEventListener('click', () => { el.close(); titellisteBearbeiten(app, tr.edition_id, nachher); });
    },
  });
  if (!d) return;
  const ex = d.form.get('explizit');
  const daten = { titel: d.form.get('titel'), pos: Number(d.form.get('pos')), disc: Number(d.form.get('disc')), gesperrt: d.form.getAll('gesperrt'), explizit: ex === 'auto' ? 'auto' : Number(ex) };
  if (d.form.get('wie_album') === '1') daten.wie_album = true;
  else {
    const k = kuenstlerAusForm(d.element, d.form, tr.kuenstler);
    if (!k.length) { toast(t('Bitte mindestens einen Künstler angeben.'), 'fehler'); return; }
    if (kreditText(k) !== kreditText(tr.kuenstler) || tr.wie_album) daten.kuenstler = k;
  }
  if (await versuche(() => api.put(`/admin/tracks/${trackId}`, daten), t('Gespeichert'))) nachher();
}

/** Alle Titel einer Edition auf einmal umbenennen / umnummerieren / auf andere CDs verteilen */
export async function titellisteBearbeiten(app, editionId, nachher) {
  const e = await versuche(() => api.get(`/admin/editionen/${editionId}`));
  if (!e) return;
  const spalten = '58px 72px 1fr';
  const d = await dialog({
    titel: t('Titelliste – {titel}', { titel: e.titel }),
    breit: true,
    inhalt: `<p class="hinweis" style="margin-top:0">${t('Geänderte Titel werden automatisch vor dem Überschreiben durch Scan und MusicBrainz geschützt. Eine neue CD entsteht, sobald du eine neue CD-Nummer einträgst; leere CDs verschwinden. Künstler je Titel änderst du über „Titel bearbeiten“ im Menü ⋯ eines Titels.')}</p>
      <div class="form-zeilen titelliste-kopf" style="grid-template-columns:${spalten};margin:0 0 4px"><small class="hinweis" style="margin:0">CD</small><small class="hinweis" style="margin:0">${t('Nr.')}</small><small class="hinweis" style="margin:0">${t('Titel ')}</small></div>
      <div style="max-height:56vh;overflow-y:auto;padding-right:4px">${e.tracks.map((tr) => `<div class="form-zeilen" style="grid-template-columns:${spalten};align-items:center;margin:0 0 6px" data-t="${tr.id}">
        <input type="number" name="disc" value="${tr.disc}" min="1" max="99" required aria-label="${t('CD')}" style="margin:0">
        <input type="number" name="pos" value="${tr.pos}" min="1" max="999" required aria-label="${t('Nummer')}" style="margin:0">
        <input type="text" name="titel" value="${h(tr.titel)}" maxlength="500" aria-label="${t('Titel ')}" style="margin:0" title="${h(tr.datei || t('keine Datei'))}"></div>`).join('')}</div>
      <p class="hinweis titelliste-doppelt" style="color:var(--danger);margin:8px 0 0" hidden></p>`,
    knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Speichern'), wert: 'ok' }],
    beimOeffnen: (el) => {
      // Doppelte CD + Nummer sofort zeigen (und Speichern sperren, bis es eindeutig ist)
      const pruefen = () => {
        const zeilen = [...el.querySelectorAll('[data-t]')];
        const zaehl = new Map();
        for (const z of zeilen) { const k = `${z.querySelector('[name="disc"]').value}-${z.querySelector('[name="pos"]').value}`; zaehl.set(k, (zaehl.get(k) || 0) + 1); }
        let doppelt = [];
        for (const z of zeilen) {
          const dI = z.querySelector('[name="disc"]'), pI = z.querySelector('[name="pos"]');
          const bad = zaehl.get(`${dI.value}-${pI.value}`) > 1;
          for (const i of [dI, pI]) i.setCustomValidity(bad ? t('Doppelt belegt') : '');
          if (bad) doppelt.push(t('CD {d} Nr. {n}', { d: dI.value, n: pI.value }));
        }
        doppelt = [...new Set(doppelt)];
        const hinweis = el.querySelector('.titelliste-doppelt');
        hinweis.hidden = !doppelt.length;
        hinweis.textContent = doppelt.length ? t('Doppelt belegt: {liste}', { liste: doppelt.join(', ') }) : '';
      };
      el.addEventListener('input', (ev) => { if (ev.target.matches('[name="disc"], [name="pos"]')) pruefen(); });
    },
  });
  if (!d) return;
  const tracks = [...d.element.querySelectorAll('[data-t]')].map((z) => ({ id: Number(z.dataset.t), disc: Number(z.querySelector('[name="disc"]').value), pos: Number(z.querySelector('[name="pos"]').value), titel: z.querySelector('[name="titel"]').value }));
  const r = await versuche(() => api.put(`/admin/editionen/${editionId}/tracks`, { tracks }));
  if (r) { toast(r.geaendert ? tn(r.geaendert, '1 Titel geändert', '{n} Titel geändert') : t('Nichts geändert')); nachher(); }
}

// ---------- Verlustfreie Titel in FLAC umwandeln ----------
/** Wie viele Titel einer Trackliste ließen sich umwandeln? (WAV/AIFF mit ganzzahligem PCM, ALAC) */

function flacText(r) {
  const nicht = (r.nicht || []).length ? `<details style="margin-top:10px"><summary>${tn(r.nicht.length, '{n} Titel bleibt wie er ist', '{n} Titel bleiben wie sie sind')}</summary><ul class="hinweis" style="margin:6px 0 0 18px">${r.nicht.map((x) => `<li>${h(x.album)} – ${h(x.titel)}: ${h(x.grund)}</li>`).join('')}</ul></details>` : '';
  return nicht + (!r.schreiben.ok ? `<p class="fehler" style="margin-top:10px">${h(r.schreiben.meldung)}</p>` : '');
}

function flacFortschritt(a) {
  const prob = (a.probleme || []).length ? `<ul class="hinweis" style="margin:6px 0 0 18px">${a.probleme.map((p) => `<li>${h(p.pfad.split('/').pop())}: ${h(p.text)}</li>`).join('')}</ul>` : '';
  if (a.status === 'laeuft') return `<div class="flac-zeile"><div class="flac-balken"><i style="width:${a.gesamt ? Math.round(a.geprueft / a.gesamt * 100) : 0}%"></i></div><span>${t('{a} von {g} Titeln …', { a: a.geprueft, g: a.gesamt })}</span></div>${prob}`;
  if (a.status === 'fertig') return `<p class="flac-gut" style="margin:0">${h(a.meldung)}</p>${prob}`;
  if (a.status === 'angehalten') return `<p class="hinweis" style="margin:0">${t('Angehalten bei {a} von {g}.', { a: a.geprueft, g: a.gesamt })}</p>${prob}`;
  return a.fehler ? `<p class="fehler">${h(a.fehler)}</p>` : '';
}

// Beobachter im Hintergrund: fragt den Auftrag ab, solange er läuft, und meldet das Ende als grüne oder rote Meldung.
// Läuft app-weit (auch beim Weiterblättern), startet nach dem Neuladen der Seite wieder, wenn noch umgewandelt wird.
const flacWacht = { timer: null, lief: false, nachher: [], fehler: '' };
// Gestarteten Auftrag merken: endet er, während die Seite neu lädt, kommt die Meldung nach dem Laden trotzdem
const FLAC_MERK = 'aw_flac_auftrag';
const flacMerken = (gestartet) => { try { if (gestartet) localStorage.setItem(FLAC_MERK, gestartet); else localStorage.removeItem(FLAC_MERK); } catch (e) { /* egal */ } };
const flacGemerkt = () => { try { return localStorage.getItem(FLAC_MERK) || ''; } catch (e) { return ''; } };

function flacErgebnisMelden(a) {
  const probleme = a.probleme || [];
  const n = Number(a.geaendert || 0);
  if (a.status === 'angehalten') { toast(tn(n, 'FLAC-Umwandlung angehalten – 1 Titel umgewandelt.', 'FLAC-Umwandlung angehalten – {n} Titel umgewandelt.')); return; }
  if (!probleme.length) { toast(n ? tn(n, '1 Titel in FLAC umgewandelt.', '{n} Titel in FLAC umgewandelt.') : t('FLAC-Umwandlung fertig – nichts zu tun.'), 'gut', 6000); return; }
  // ffmpeg-Ausgabe kürzen: Kennungen in eckigen Klammern weg, Dateipfad weg, höchstens ein Satz
  let grund = String(probleme[0].text || t('unbekannter Fehler')).replace(/\[[^\]]*\]\s*/g, '').replace(/\s*Error opening input file .*/s, '').replace(/^Umwandeln nach FLAC fehlgeschlagen:\s*/, '').trim();
  if (grund.length > 140) grund = grund.slice(0, 137).replace(/\s+\S*$/, '') + ' …';
  const wer = (probleme[0].pfad || '').split('/').pop();
  toast(n ? t('{n} Titel in FLAC umgewandelt, {p} nicht: {wer} – {grund}', { n, p: probleme.length, wer, grund }) : t('FLAC-Umwandlung fehlgeschlagen: {wer} – {grund}', { wer, grund }), 'fehler', 9000);
}

export function flacBeobachten(nachher = null) {
  if (nachher) flacWacht.nachher.push({ fn: nachher, pfad: location.pathname });
  if (flacWacht.timer) return;
  const abfragen = async () => {
    flacWacht.timer = null;
    let a;
    try { a = (await api.get('/admin/flac?stand=1')).auftrag; } catch (e) { flacWacht.timer = setTimeout(abfragen, 5000); return; }
    if (a.status === 'laeuft') {
      flacWacht.lief = true;
      // Dienst-/Dateifehler während des Laufs (der Auftrag versucht es danach weiter): einmal rot melden
      if (a.fehler && a.fehler !== flacWacht.fehler) toast(t('FLAC-Umwandlung: {x}', { x: a.fehler }), 'fehler', 8000);
      flacWacht.fehler = a.fehler || '';
      flacWacht.timer = setTimeout(abfragen, document.hidden ? 4000 : 1500);
      return;
    }
    if (flacWacht.lief) flacErgebnisMelden(a);
    flacWacht.lief = false; flacWacht.fehler = '';
    flacMerken(null);
    // Seite neu zeichnen, auf der die Umwandlung gestartet wurde (Album zeigt danach FLAC) – nur wenn man noch dort ist
    const liste = flacWacht.nachher.splice(0);
    for (const x of liste) if (x.pfad === location.pathname) { try { x.fn(); } catch (e) { /* egal */ } }
  };
  flacWacht.lief = true;   // gerade gestartet (oder nach dem Neuladen: läuft womöglich) – Ende wird gemeldet
  flacWacht.timer = setTimeout(abfragen, 700);
}

/** Nach dem Laden der App (nur Admins): läuft noch eine Umwandlung, weiter beobachten */
export async function flacWachtStarten() {
  try {
    const a = (await api.get('/admin/flac?stand=1')).auftrag;
    if (a.status === 'laeuft') { flacBeobachten(); return; }
    const merk = flacGemerkt();
    if (merk && merk === a.gestartet && ['fertig', 'angehalten'].includes(a.status)) flacErgebnisMelden(a);
    if (merk) flacMerken(null);
  } catch (e) { /* egal */ }
}

/** Albummenü: „Verlustfreie Titel in FLAC umwandeln“ – startet sofort im Hintergrund, das Ergebnis kommt als Meldung */
export async function flacUmwandeln(app, editionId, nachher) {
  const r = await versuche(() => api.get(`/admin/flac?edition=${editionId}`));
  if (!r) return;
  if (!r.titel) { toast(r.nicht?.length ? t('Nicht als FLAC speicherbar: {grund}', { grund: r.nicht[0].grund }) : t('Hier gibt es nichts umzuwandeln.'), r.nicht?.length ? 'fehler' : 'info'); return; }
  if (!r.schreiben.ok) { toast(r.schreiben.meldung, 'fehler', 8000); return; }
  if (r.auftrag?.status === 'laeuft') { toast(t('Es läuft schon eine FLAC-Umwandlung – bitte warten, bis sie fertig ist.'), 'fehler'); flacBeobachten(); return; }
  const s = await versuche(() => api.post('/admin/flac/start', { edition_id: editionId }));
  if (!s) return;
  flacMerken(s.auftrag?.gestartet);
  toast(tn(r.titel, 'Umwandlung läuft im Hintergrund – 1 Titel ({f}). Du bekommst Bescheid, wenn sie fertig ist.', 'Umwandlung läuft im Hintergrund – {n} Titel ({f}). Du bekommst Bescheid, wenn sie fertig ist.', { f: r.alben[0].formate.join(', ') }));
  flacBeobachten(nachher);
}

/** Werkzeuge → „In FLAC umwandeln“ für die ganze Bibliothek, mit Vorschau */
function flacPanel(app, box, signal) {
  let timer = null;
  signal?.addEventListener('abort', () => clearTimeout(timer));
  const zeichnen = (r) => {
    if (!box.isConnected) return;
    const a = r.auftrag;
    const laeuft = a.status === 'laeuft';
    box.innerHTML = `<h2 style="font-size:1.15rem">${t('In FLAC umwandeln')}</h2>
      <p class="hinweis" style="margin-top:0">${t('WAV, AIFF und ALAC verlustfrei als FLAC: gleiche Bittiefe und Abtastrate, Audio vor dem Ersetzen Sample für Sample geprüft, Originale in den Papierkorb. Spart Platz und lässt sich vollständig taggen.')}</p>
      ${r.titel ? `<p style="margin:6px 0">${tn(r.alben.length, '<b>{t}</b> Titel in <b>{n}</b> Album · {g}', '<b>{t}</b> Titel in <b>{n}</b> Alben · {g}', { t: zahl(r.titel), g: groesse(r.groesse) })}</p>
        <details><summary>${t('Betroffene Alben')}</summary><ul class="hinweis" style="margin:6px 0 0 18px">${r.alben.map((x) => `<li><a href="/alben/${x.album_id}" data-link>${h(x.album || t('ohne Titel'))}</a> – ${tn(x.titel, '1 Titel ({f})', '{n} Titel ({f})', { f: h(x.formate.join(', ')) })}</li>`).join('')}</ul></details>`
        : `<p class="hinweis" style="margin:6px 0">${laeuft ? '' : t('Alles Verlustfreie liegt schon als FLAC vor.')}</p>`}
      ${flacText(r)}
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
        ${laeuft ? `<button type="button" class="btn btn-zweit" data-flac-halt>${t('Anhalten')}</button>` : r.titel && r.schreiben.ok ? `<button type="button" class="btn" data-flac-los>${t('Alle umwandeln')}</button>` : ''}
      </div>
      <div style="margin-top:10px">${a.status === 'fertig' ? `<span class="hinweis">${t('Zuletzt: ')}</span>` : ''}${a.status !== 'bereit' ? flacFortschritt(a) : ''}</div>`;
    box.querySelector('[data-flac-los]')?.addEventListener('click', async () => {
      if (!await bestaetigen(t('Alle umwandeln?'), tn(r.titel, '1 Titel wird in FLAC umgewandelt; das Original wandert in den Papierkorb.', '{n} Titel werden in FLAC umgewandelt; die Originale wandern in den Papierkorb.'), t('Umwandeln'))) return;
      const s = await versuche(() => api.post('/admin/flac/start', {}));
      if (s) { zeichnen(s); planen(); flacMerken(s.auftrag?.gestartet); flacBeobachten(); }
    });
    box.querySelector('[data-flac-halt]')?.addEventListener('click', async () => { const s = await versuche(() => api.post('/admin/flac/anhalten', {})); if (s) zeichnen(s); });
    if (laeuft) planen();
  };
  const laden = async () => { try { zeichnen(await api.get('/admin/flac', { signal })); } catch (e) { if (!signal?.aborted) box.innerHTML = `<h2 style="font-size:1.15rem">${t('In FLAC umwandeln')}</h2><p class="fehler">${h(e.message)}</p>`; } };
  const planen = () => { clearTimeout(timer); timer = setTimeout(laden, 1500); };
  laden();
}
