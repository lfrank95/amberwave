// Dashboard (nur Admins, Knopf im Kopf): was gerade läuft (wie bei Plex), Übertragungen, wer verbunden ist (Graph),
// Speicher, Hintergrund und Rechner. Frischt sich selbst auf, solange die Seite sichtbar ist.
import { api } from './api.js';
import { t, tn, zahl } from './i18n.js';
import { h, icon, groesse, dauer, datumZeit, kuenstlerText, dialog, toast } from './ui.js';
import { verbindungsGraph, graphDaten } from './verbindungen.js';
import { TempoMesser, tempoText, kompaktKarte, qualiName } from './uebertragung_ui.js';
import { serverUpdateInstallieren } from './update_hinweis.js';

const QUALI_TEXT = { opus320: 'Opus 320', opus256: 'Opus 256', opus160: 'Opus 160', opus96: 'Opus 96', aac256: 'AAC 256', aac160: 'AAC 160', flac1644: 'FLAC 16/44,1', mp3_320: 'MP3 320' };

function seitText(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return t('läuft seit {n} Minuten', { n: Math.max(1, Math.round(s / 60)) });
  if (s < 2 * 86400) return tn(Math.round(s / 3600), 'läuft seit einer Stunde', 'läuft seit {n} Stunden');
  return t('läuft seit {n} Tagen', { n: Math.floor(s / 86400) });
}

const PLATTFORM = () => ({ os: 'Amberwave OS', windows: 'Windows Server', docker: 'Docker', php: 'PHP' });

/** Eine Wiedergabe als Karte – Cover groß, verschwommen im Hintergrund */
function sitzung(w) {
  const trk = w.track || {};
  const d = w.details || {};
  const datei = w.datei;
  const quelle = datei ? `${(datei.format || '').toUpperCase()}${datei.bittiefe ? ` ${datei.bittiefe}/${zahl(datei.abtastrate / 1000)}` : ''}` : '';
  const original = d.art === 'original';
  const q = original ? `${t('Original')}${quelle ? ` · ${quelle}` : ''}` : d.qualitaet ? `${QUALI_TEXT[d.qualitaet] || d.qualitaet} · ${t('umgewandelt')}` : quelle;
  const cover = trk.album?.cover || '';
  const anteil = w.dauer > 0 ? Math.min(100, (w.position / w.dauer) * 100) : 0;
  const ort = w.verbindung === 'extern' ? t('unterwegs') : w.verbindung === 'direkt' ? t('zuhause · direkt') : t('zuhause');
  const ini = String(w.user || '?').split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase();
  return `<article class="db-s db-${w.zustand}" data-schluessel="${h(w.schluessel)}" style="${cover ? `--db-bild:url('${h(cover)}')` : ''}">
    <div class="db-s-hinten"></div>
    ${cover ? `<img class="db-s-cover" src="${h(cover)}" alt="">` : `<span class="db-s-cover db-s-leer">${icon('album', 34)}</span>`}
    <div class="db-s-text">
      <div class="db-s-titel">${trk.album?.id ? `<a href="/alben/${trk.album.id}" data-link>${h(trk.titel || '')}</a>` : h(trk.titel || '')}</div>
      <div class="db-s-unter">${h(kuenstlerText(trk.kuenstler || []))}${trk.album?.titel ? ` · ${h(trk.album.titel)}` : ''}</div>
      <div class="db-s-chips">
        <span class="db-wer"><i>${h(ini)}</i>${h(w.user)}</span>
        <span>${icon(w.geraet_art === 'android' || d.mobil ? 'handy' : 'computer', 13)}${h(w.geraet)}</span>
        <span>${icon(w.verbindung === 'extern' ? 'connect' : 'start', 13)}${h(ort)}</span>
        ${q ? `<span class="db-q${original ? ' gut' : ''}">${h(q)}</span>` : ''}
      </div>
      <div class="db-s-fort"><span class="db-zustand" title="${h(w.zustand === 'spielt' ? t('spielt') : t('pausiert'))}">${icon(w.zustand === 'spielt' ? 'play' : 'pause', 13)}</span>
        <div class="db-balken"><i data-balken style="width:${anteil}%"></i></div><small><span data-pos>${dauer(w.position * 1000)}</span> / ${dauer(w.dauer * 1000)}</small></div>
    </div>
  </article>`;
}

function kachel(wert, name, unter = '') {
  return `<div class="db-k"><b>${h(String(wert))}</b><span>${h(name)}</span>${unter ? `<small>${h(unter)}</small>` : ''}</div>`;
}

function platte(name, unter, teile) {
  const summe = teile.reduce((s, [, b]) => s + b, 0) || 1;
  return `<div class="db-platte"><div class="db-platte-kopf"><b>${h(name)}</b><small>${h(unter)}</small></div>
    <div class="os-platte">${teile.filter(([, b]) => b > 0).map(([k, b, n]) => `<i class="os-teil-${k}" style="width:${Math.max(0.8, (b * 100) / summe)}%" title="${h(`${n}: ${groesse(b)}`)}"></i>`).join('')}</div>
    <div class="db-leg">${teile.filter(([k]) => k !== 'frei').map(([k, b, n]) => `<span><i class="os-punkt os-teil-${k}"></i>${h(n)} <b>${groesse(b)}</b></span>`).join('')}</div></div>`;
}

export async function dashboardAnsicht({ app, ziel, signal }) {
  if (app.ich.user.rolle !== 'admin') { app.navigieren('/', false, true); return; }
  ziel.innerHTML = `<div class="db"><div class="lade"></div></div>`;
  const messer = new TempoMesser();
  let d = null, akt = null, cn = null, auf = [], zuletztAkt = 0;

  const kopfHtml = () => {
    const s = d.server, u = d.update;
    const updKnopf = u.neu ? `<button type="button" class="db-update" data-db-update>${h(t('Update {version}', { version: u.neu.version }))} ›</button>` : '';
    return `<header class="db-kopf"><div><h1>${t('Dashboard')}</h1><p>${h(s.name)} · ${h(t('was gerade läuft, wer verbunden ist und wie es dem Server geht'))}</p></div>
      <div class="db-kopf-chips">${s.seit ? `<span class="einst-chip gut">${h(seitText(s.seit))}</span>` : ''}<span class="einst-chip">${h(`Amberwave ${s.version} · ${PLATTFORM()[s.plattform] || s.plattform}${s.host === 'unraid' ? ' · Unraid' : ''}`)}</span>${updKnopf}</div></header>`;
  };

  const kachelnHtml = () => {
    const w = akt?.wiedergaben || [];
    const spielt = w.filter((x) => x.zustand === 'spielt');
    const heim = spielt.filter((x) => x.verbindung !== 'extern').length;
    const apps = (d.geraete.apps || []).filter((g) => g.aktiv);
    const peers = cn?.server || [];
    return `<div class="db-kacheln">
      ${kachel(spielt.length, t('hören gerade'), spielt.length ? t('{a} zuhause · {b} unterwegs', { a: heim, b: spielt.length - heim }) : t('gerade niemand'))}
      ${kachel(apps.length, t('Geräte verbunden'), apps.length ? [...new Set(apps.map((g) => g.user))].join(', ') : '')}
      ${kachel(peers.length, t('Connect-Partner'), peers.length ? t('{n} erreichbar', { n: peers.filter((p) => p.erreichbar).length }) : t('noch keiner gekoppelt'))}
      ${kachel(zahl(d.zahlen.titel), t('Titel'), t('{a} Alben · {g}', { a: zahl(d.zahlen.alben), g: groesse(d.zahlen.groesse) }))}</div>`;
  };

  const sitzungenHtml = () => {
    const w = akt?.wiedergaben || [];
    return `<section class="db-teil"><h2>${t('Gerade läuft')} <small>${w.length}</small></h2>${w.length ? `<div class="db-sitzungen">${w.map(sitzung).join('')}</div>`
      : `<p class="hinweis db-leer">${h(t('Gerade hört niemand. Sobald jemand etwas abspielt, erscheint es hier – mit Cover, Gerät und Qualität.'))}</p>`}</section>`;
  };

  const uebertragungenHtml = () => {
    const karten = [];
    const wegVon = (sid) => cn?.server?.find((s) => s.id === sid)?.weg?.art || '';
    for (const a of auf.filter((x) => ['laeuft', 'wartet'].includes(x.status))) {
      const tempo = messer.messen(`c${a.id}`, a.bytes);
      const pz = a.gesamt ? (a.bytes * 100) / a.gesamt : 0;
      const art = wegVon(a.server_id);
      karten.push(kompaktKarte({ cover: a.cover, titel: a.titel || a.art, unter: [a.unter, qualiName(a.qualitaet)].filter(Boolean).join(' · '), richtung: `← ${a.server}`, connect: true,
        weg: { heimnetz: t('Heimnetz'), rueckkanal: t('Rückkanal'), tunnel: t('Tunnel'), direkt: t('Direktzugang') }[art] || '', wegKlasse: { rueckkanal: 'nk-rueck', tunnel: 'nk-tunnel', heimnetz: 'nk-heimnetz', direkt: 'nk-direkt' }[art] || '',
        prozent: pz, text: a.status === 'wartet' ? t('wartet') : [a.dateien ? t('{f} von {n} Titeln', { f: a.fertig, n: a.dateien }) : '', tempoText(tempo)].filter(Boolean).join(' · ') }));
    }
    for (const x of d.downloads || []) {
      karten.push(kompaktKarte({ titel: x.titel, unter: x.indexer || '', richtung: t('Download'),
        prozent: x.status === 'fertig' ? 100 : x.prozent, text: x.status === 'fertig' ? t('wird übernommen') : x.status === 'gesendet' ? t('in der Warteschlange') : `${zahl(Math.round(x.prozent))} %${x.groesse ? ` · ${groesse(x.groesse)}` : ''}` }));
    }
    messer.punkt([...messer.st.values()].reduce((s, x) => s + (x.tempo || 0), 0));
    if (!karten.length) return '';
    return `<section class="db-teil"><h2>${t('Übertragungen')} <small>${karten.length}</small><a class="db-mehr" href="${auf.some((x) => ['laeuft', 'wartet'].includes(x.status)) ? '/connect' : '/downloads'}" data-link>${h(t('Alle ansehen'))} ›</a></h2><div class="db-uebertragungen">${karten.join('')}</div></section>`;
  };

  const graphHtml = () => {
    if (!cn) return '';
    const g = graphDaten({ ausweis: cn.ausweis, server: cn.server, geraete: d.geraete, adresseUnterwegs: cn.adressen?.tunnel || cn.adressen?.oeffentlich || '' });
    const zusammen = g.heim.length + g.weg.length;
    const ad = cn.adressen || {};
    const chips = [ad.lan?.[0] ? `<span class="einst-chip gut">${h(t('zuhause: {a}', { a: ad.lan[0].replace(/^https?:\/\//, '') }))}</span>` : '',
      ad.tunnel || ad.oeffentlich ? `<span class="einst-chip gut">${h(t('unterwegs: {a}', { a: (ad.tunnel || ad.oeffentlich).replace(/^https?:\/\//, '') }))}</span>` : ''].join('');
    return `<section class="db-teil db-graph"><h2>${t('Verbindungen')} <small>${zusammen}</small></h2><div class="db-karte">${chips ? `<div class="gz-kopf">${chips}</div>` : ''}${verbindungsGraph(g)}</div></section>`;
  };

  const untenHtml = () => {
    const sp = d.speicher, hg = d.hintergrund, r = d.rechner;
    const mu = sp.musik, da = sp.daten, tl = da.teile || {};
    const datenBelegt = Object.values(tl).reduce((s, x) => s + x, 0);
    const mj = hg.metadaten;
    const scan = hg.scan;
    return `<div class="db-seite">
      <section class="db-teil"><h2>${t('Speicher')}</h2><div class="db-karte">
        ${platte(t('Musik'), mu.gesamt ? t('{a} von {b} belegt', { a: groesse(mu.gesamt - mu.frei), b: groesse(mu.gesamt) }) : mu.pfad, [['musik', mu.belegt_musik, t('Musik')], ['sonstiges', Math.max(0, mu.gesamt - mu.frei - mu.belegt_musik), t('Anderes auf dem Laufwerk')], ['frei', mu.frei, t('Frei')]])}
        ${platte(t('Daten'), t('{a} für Amberwave', { a: groesse(datenBelegt) }), [['programm', tl.datenbank || 0, t('Datenbank')], ['bibliothek', tl.bilder || 0, t('Cover & Bilder')], ['reserve', tl.zwischenspeicher || 0, t('Zwischenspeicher')], ['sicherungen', tl.sicherungen || 0, t('Sicherungen')], ['frei', da.frei, t('Frei')]])}
      </div></section>
      <section class="db-teil"><h2>${t('Im Hintergrund')}</h2><div class="db-karte db-liste">
        ${mj && mj.status === 'laeuft' ? `<div><b>${t('Metadaten-Abgleich')}</b><small>${h(t('{a} von {b}', { a: zahl(mj.geprueft), b: zahl(mj.gesamt) }))}</small><div class="db-balken"><i style="width:${mj.gesamt ? (mj.geprueft * 100) / mj.gesamt : 0}%"></i></div></div>` : ''}
        <div><b>${t('Einlesen')}</b><small>${hg.scan_laeuft ? h(t('läuft gerade')) : scan ? h(`${datumZeit(scan.beendet || scan.gestartet)} · ${scan.neu ? tn(scan.neu, '1 neue Datei', '{n} neue Dateien') : t('nichts Neues')}`) : h(t('noch nie'))}</small></div>
        ${hg.downloads ? `<div><b>${t('Downloads')}</b><small>${h(tn(hg.downloads, '1 läuft', '{n} laufen'))}</small></div>` : ''}
        <div><b>${t('Nächste Sicherung')}</b><small>${hg.sicherung ? h(datumZeit(hg.sicherung)) : h(t('aus'))}</small></div>
      </div></section>
      <section class="db-teil"><h2>${t('Rechner')}</h2><div class="db-karte db-liste">
        <div><b>${h(r.cpu || t('Prozessor'))}${r.kerne ? ` · ${h(tn(r.kerne, '1 Kern', '{n} Kerne'))}` : ''}</b><small>${r.auslastung != null ? h(t('Auslastung {p} %', { p: r.auslastung })) : ''}${r.ram_amberwave ? ` · ${h(t('Amberwave {m} Arbeitsspeicher', { m: groesse(r.ram_amberwave) }))}` : ''}</small>
          ${r.auslastung != null ? `<div class="db-balken"><i style="width:${r.auslastung}%"></i></div>` : ''}</div>
        ${r.ram_gesamt ? `<div><b>${t('Arbeitsspeicher')}</b><small>${h(t('{frei} von {gesamt} frei', { frei: groesse(r.ram_frei || 0), gesamt: groesse(r.ram_gesamt) }))}</small></div>` : ''}
        <div><b>${t('Versionen')}</b><small>${h([`PHP ${r.php}`, r.datenbank ? `${t('Datenbank')} ${r.datenbank}` : '', r.betriebssystem].filter(Boolean).join(' · '))}</small></div>
      </div></section></div>`;
  };

  const zeichnen = () => {
    if (!d || !ziel.isConnected) return;
    ziel.innerHTML = `<div class="db">${kopfHtml()}${kachelnHtml()}${sitzungenHtml()}${uebertragungenHtml()}<div class="db-raster">${graphHtml()}${untenHtml()}</div></div>`;
    ziel.querySelector('[data-db-update]')?.addEventListener('click', updateKlick);
  };

  const updateKlick = async () => {
    const u = d.update;
    if (u.weg === 'knopf') {
      const ok = await dialog({ titel: t('Update auf {version} installieren?', { version: h(u.neu.version) }),
        inhalt: `<p>${t('Der Server lädt die neue Version, beendet sich kurz und startet in der neuen Version wieder. Laufende Wiedergaben brechen ab, Bibliothek, Konten und Einstellungen bleiben.')}</p>`,
        knoepfe: [{ text: t('Abbrechen'), wert: 'nein', art: 'zweit' }, { text: t('Jetzt installieren'), wert: 'ja' }] });
      if (ok?.wert === 'ja') { try { await serverUpdateInstallieren(u.neu.version, d.server.version, d.server.plattform === 'os'); } catch (x) { toast(x.message, 'fehler'); } }
      return;
    }
    const befehl = 'docker compose pull && docker compose up -d';
    await dialog({ titel: t('Update auf {version}', { version: h(u.neu.version) }),
      inhalt: u.weg === 'docker' ? `<p>${t('Amberwave läuft als Docker-Container – das Update holt Docker selbst.')}</p>
        ${u.unraid ? `<p>${t('<b>Unraid:</b> Reiter <i>Docker</i> › Amberwave › <i>Update</i> (oder „Check for Updates“).')}</p>` : ''}
        <p>${u.unraid ? t('Sonst auf dem Server:') : t('Auf dem Server:')}</p><pre class="log">${h(befehl)}</pre>
        <p class="hinweis">${t('Bibliothek, Konten und Einstellungen bleiben; Datenbank-Änderungen laufen beim Start von selbst. Vorher wird automatisch gesichert.')}</p>`
        : `<p>${t('Das Update-Paket spielst du unter Einstellungen › Sicherung & Update ein.')}</p>`,
      knoepfe: [{ text: u.neu.url ? t('Was ist neu?') : t('OK'), wert: 'neu', art: 'zweit' }, { text: t('Schließen'), wert: 'ok' }] }).then((r) => { if (r?.wert === 'neu' && u.neu.url) window.open(u.neu.url, '_blank', 'noopener'); });
  };

  let runde = 0;
  const ladenAlles = async () => {
    // Wiedergaben und Übertragungen alle 5 s, der Rest (Speicher, Rechner, Geräte, Downloads) alle 15 s
    const voll = runde++ % 3 === 0;
    const [a, b, c, e] = await Promise.all([
      voll ? api.get('/admin/dashboard', { signal }).catch(() => null) : null, api.get('/admin/aktivitaet', { signal }).catch(() => null),
      voll ? api.get('/connect/server', { signal }).catch(() => null) : null, api.get('/connect/auftraege', { signal }).catch(() => null)]);
    if (signal?.aborted) return;
    if (a) d = a; if (b) { akt = b; zuletztAkt = Date.now(); } if (c) cn = c; if (e) auf = e.auftraege || [];
    zeichnen();
    if (akt) app.hoerZahl?.(akt.wiedergaben.filter((w) => w.zustand === 'spielt').length);
  };
  await ladenAlles();
  if (!d) { ziel.innerHTML = `<div class="db"><p class="fehler">${h(t('Das Dashboard ließ sich nicht laden.'))}</p></div>`; return; }
  document.title = t('Dashboard');
  // Live: alle 5 s neu (nur sichtbar), dazwischen laufen die Fortschrittsbalken der Wiedergaben weiter
  const takt = setInterval(() => { if (!document.hidden && ziel.isConnected) ladenAlles(); }, 5000);
  const uhr = setInterval(() => {
    if (!akt || !ziel.isConnected) return;
    const dt = (Date.now() - zuletztAkt) / 1000;
    for (const w of akt.wiedergaben) {
      if (w.zustand !== 'spielt') continue;
      const el = ziel.querySelector(`[data-schluessel="${CSS.escape(w.schluessel)}"]`);
      if (!el) continue;
      const pos = Math.min(w.dauer || Infinity, w.position + dt);
      el.querySelector('[data-pos]').textContent = dauer(pos * 1000);
      if (w.dauer > 0) el.querySelector('[data-balken]').style.width = `${Math.min(100, (pos / w.dauer) * 100)}%`;
    }
  }, 1000);
  signal?.addEventListener('abort', () => { clearInterval(takt); clearInterval(uhr); });
}
