// Bausteine für Übertragungen (Amberwave Connect) und Downloads: große Karte mit Stufen, Fortschritt, Tempo und Restzeit,
// aufklappbare Titelliste, kompakte Karte fürs Dashboard, Durchsatzkurve. Das Tempo misst die Oberfläche selbst aus den
// Byte-Ständen zwischen zwei Abfragen (gleitender Mittelwert) – der Server muss dafür nichts mitschreiben.
import { t, tn, zahl } from './i18n.js';
import { h, icon, groesse, datumZeit } from './ui.js';

const ICON_CONNECT = '<rect x="2" y="4" width="8" height="16" rx="1.5"/><rect x="14" y="4" width="8" height="16" rx="1.5"/><path d="M5 8h2M17 8h2M10 12h4"/>';
export const connectZeichen = (gr = 15) => `<svg class="ue-ci" width="${gr}" height="${gr}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${ICON_CONNECT}</svg>`;

/** Tempo je Auftrag aus aufeinanderfolgenden Byte-Ständen; Verlauf (rein) für die Kurve */
export class TempoMesser {
  constructor(minuten = 10) { this.st = new Map(); this.verlauf = []; this.fenster = minuten * 60000; }
  /** Bytes je Sekunde für einen Auftrag (0, solange es noch keine zwei Messpunkte gibt) */
  messen(id, bytes) {
    const jetzt = Date.now();
    const alt = this.st.get(id);
    let tempo = alt?.tempo || 0;
    if (alt && jetzt > alt.zeit && bytes >= alt.bytes) {
      const neu = ((bytes - alt.bytes) * 1000) / (jetzt - alt.zeit);
      tempo = alt.tempo ? alt.tempo * 0.6 + neu * 0.4 : neu;
    }
    this.st.set(id, { bytes, zeit: jetzt, tempo });
    return tempo;
  }
  /** Summe aller gerade gemessenen Tempi als Punkt in den Verlauf schreiben */
  punkt(summe) {
    const jetzt = Date.now();
    this.verlauf.push([jetzt, summe]);
    while (this.verlauf.length && this.verlauf[0][0] < jetzt - this.fenster) this.verlauf.shift();
  }
}

export const tempoText = (bps) => (bps >= 1e6 ? `${zahl(Math.round(bps / 1e5) / 10)} MB/s` : bps >= 1e3 ? `${zahl(Math.round(bps / 1e3))} kB/s` : bps > 0 ? `${zahl(Math.round(bps))} B/s` : '');
export function restText(sek) {
  if (!Number.isFinite(sek) || sek <= 0) return '';
  if (sek < 60) return t('noch etwa {n} s', { n: Math.max(1, Math.round(sek)) });
  if (sek < 3600) return t('noch etwa {n} min', { n: Math.round(sek / 60) });
  return t('noch etwa {h} h {m} min', { h: Math.floor(sek / 3600), m: Math.round((sek % 3600) / 60) });
}

/** Stufenanzeige: erledigte Stufen mit Haken, die aktuelle hervorgehoben */
export function stufen(namen, jetzt) {
  return `<ol class="ue-stufen">${namen.map((n, i) => `<li class="ue-stufe${i < jetzt ? ' fertig' : i === jetzt ? ' ist' : ''}"><i>${i < jetzt ? icon('haken', 12) : i + 1}</i><span>${h(n)}</span></li>`).join('')}</ol>`;
}

const QUALI = { opus256: 'Opus 256', opus160: 'Opus 160', opus128: 'Opus 128', aac256: 'AAC 256', aac160: 'AAC 160', flac1644: 'FLAC 16/44,1' };
export const qualiName = (q) => (q === 'original' ? t('Original') : QUALI[q] || q || '');

/** Große Karte eines Connect-Auftrags (läuft oder wartet) */
export function connectKarte(a, tempo = 0, wegText = '') {
  const pz = a.gesamt ? Math.min(100, (a.bytes * 100) / a.gesamt) : 0;
  const stufe = a.status === 'wartet' ? 0 : a.dateien && a.fertig >= a.dateien ? 2 : 1;
  const rest = tempo > 0 && a.gesamt > a.bytes ? (a.gesamt - a.bytes) / tempo : NaN;
  const art = { album: t('Album'), titel: t('Titel'), playlist: t('Playlist') }[a.art] || a.art;
  const liste = a.titel_liste || [];
  const nFertig = liste.filter((d) => d.status === 'fertig').length;
  const nLaeuft = liste.filter((d) => d.status !== 'fertig' && d.bytes > 0).length;
  const dateiZeile = (d, i) => {
    const p = d.status === 'fertig' ? 100 : d.groesse ? Math.min(100, Math.round((d.bytes * 100) / d.groesse)) : d.bytes > 0 ? 50 : 0;
    const zust = d.status === 'fertig' ? `<span class="ue-d-ok">${icon('haken', 13)}</span>` : d.bytes > 0 ? `<span class="ue-d-p">${d.groesse ? `${p} %` : groesse(d.bytes)}</span>` : `<span class="ue-d-w">${h(t('wartet'))}</span>`;
    return `<div class="ue-d ${d.status === 'fertig' ? 'fertig' : d.bytes > 0 ? 'laeuft' : 'wartet'}"><span class="ue-d-nr">${i + 1}</span><span class="ue-d-titel" title="${h(d.name)}">${h(d.name)}</span>
      <span class="ue-d-gr">${d.groesse ? groesse(d.groesse) : ''}</span><div class="ue-d-balken"><i style="width:${p}%"></i></div>${zust}</div>`;
  };
  return `<article class="ue-karte ue-connect" data-auftrag-karte="${a.id}">
    <div class="ue-kopf">
      ${a.cover ? `<img class="ue-cover" src="${h(a.cover)}" alt="" loading="lazy">` : `<span class="ue-cover ue-cover-leer">${connectZeichen(26)}</span>`}
      <div class="ue-titelblock">
        <div class="ue-quelle">${connectZeichen()}<span>${h(t('Connect · von'))} <b>${h(a.server || '?')}</b></span>${wegText ? `<span class="ue-weg">${h(wegText)}</span>` : ''}</div>
        <h3 title="${h(a.titel || art)}">${h(a.titel || art)}</h3>
        <div class="ue-unter">${h([art, a.unter, a.dateien ? tn(a.dateien, '1 Titel', '{n} Titel') : ''].filter(Boolean).join(' · '))} · <span class="ue-q${a.qualitaet === 'original' ? ' gut' : ''}">${h(qualiName(a.qualitaet))}</span></div>
      </div>
      <div class="ue-aktionen"><button type="button" class="ue-ico" data-auftrag="${a.id}" data-was="abbrechen" title="${h(t('Abbrechen'))}" aria-label="${h(t('Abbrechen'))}">${icon('zu', 16)}</button></div>
    </div>
    ${stufen([t('In der Schlange'), t('Übertragen'), t('Prüfen & Einlesen')], stufe)}
    <div class="ue-fort">
      <div class="ue-fort-zeile"><b>${a.status === 'wartet' ? '–' : `${zahl(Math.floor(pz))} %`}</b><span>${a.gesamt ? t('{a} von {b}', { a: groesse(a.bytes), b: groesse(a.gesamt) }) : ''}</span>${tempo > 0 ? `<span class="ue-tempo">${tempoText(tempo)}</span>` : ''}${restText(rest) ? `<span>${restText(rest)}</span>` : ''}</div>
      <div class="ue-balken gross"><i style="width:${pz}%"></i></div>
      <div class="ue-fakten">${a.dateien ? `<span>${t('Titel {a} von {b}', { a: Math.min(a.dateien, a.fertig + (a.status === 'laeuft' ? 1 : 0)), b: a.dateien })}</span>` : ''}${a.gestartet ? `<span>${t('gestartet {zeit}', { zeit: datumZeit(a.gestartet) })}</span>` : ''}<span>${t('fortsetzbar')}</span>
        ${a.fehler ? `<span class="ue-fakt-warn">${h(a.fehler)}</span>` : ''}</div>
    </div>
    ${liste.length ? `<details class="ue-dateien"${liste.length <= 14 ? ' open' : ''}><summary>${t('Titel')} <small>${h(t('{f} fertig · {l} läuft · {w} warten', { f: nFertig, l: nLaeuft, w: liste.length - nFertig - nLaeuft }))}</small></summary>${liste.map(dateiZeile).join('')}</details>` : ''}
  </article>`;
}

/** Stufe eines Downloads: gesendet → laden → übernehmen → in der Bibliothek (→ einsortiert) */
export function downloadStufe(d, einsortieren) {
  const namen = [t('Gesendet'), t('Laden'), t('Prüfen & Übernehmen'), t('In der Bibliothek'), ...(einsortieren ? [t('Einsortiert')] : [])];
  const i = d.status === 'gesendet' ? 0 : d.status === 'laeuft' ? 1 : d.status === 'fertig' ? 2 : d.status === 'importiert' ? (d.einsortiert_am || !einsortieren ? namen.length : 3) : 0;
  return { namen, i };
}

/** Kompakte Karte fürs Dashboard (Cover, Titel, Richtung, Balken, Tempo) */
export function kompaktKarte({ cover, titel, unter, richtung, connect, weg, wegKlasse, prozent, text }) {
  return `<div class="db-u${connect ? ' db-u-connect' : ''}">${cover ? `<img src="${h(cover)}" alt="" loading="lazy">` : `<span class="db-u-ico">${connect ? connectZeichen(22) : icon('download', 22)}</span>`}<div class="db-u-text">
    <div class="db-u-kopf"><b title="${h(titel)}">${h(titel)}</b><span class="db-u-richtung">${connect ? connectZeichen(13) : ''}${h(richtung)}</span>${weg ? `<span class="db-u-weg ${wegKlasse || ''}"><i></i>${h(weg)}</span>` : ''}</div>
    ${unter ? `<small>${h(unter)}</small>` : ''}
    <div class="db-s-fort"><div class="db-balken"><i style="width:${Math.max(0, Math.min(100, prozent || 0))}%"></i></div><small>${h(text || '')}</small></div></div></div>`;
}

/** Durchsatzkurve der letzten Minuten (SVG) */
export function durchsatzKurve(verlauf, minuten = 10) {
  const jetzt = Date.now(), von = jetzt - minuten * 60000;
  const max = Math.max(1, ...verlauf.map(([, w]) => w));
  const pkt = verlauf.filter(([z]) => z >= von).map(([z, w]) => [((z - von) / (jetzt - von)) * 600, 70 - (w / max) * 62]);
  if (pkt.length < 2) return '<svg viewBox="0 0 600 76" preserveAspectRatio="none" class="ue-kurve"><path d="M0,70 L600,70" class="ue-k-rein"/></svg>';
  const linie = 'M' + pkt.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L');
  const flaeche = `M${pkt[0][0].toFixed(1)},74 L` + pkt.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L') + ` L${pkt[pkt.length - 1][0].toFixed(1)},74 Z`;
  return `<svg viewBox="0 0 600 76" preserveAspectRatio="none" class="ue-kurve" role="img" aria-label="${h(t('Durchsatz der letzten {n} Minuten', { n: minuten }))}"><path d="${flaeche}" class="ue-k-rein-f"/><path d="${linie}" class="ue-k-rein"/></svg>`;
}
