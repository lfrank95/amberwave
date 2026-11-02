// Verbindungsgraph: wer gerade mit diesem Server verbunden ist – oben das Heimnetz, in der Mitte der Server, darunter das
// Internet mit allem, was unterwegs ist. Amberwave-Connect-Server tragen einen goldenen Rahmen und das Connect-Zeichen.
// Großer Bildschirm: SVG; Handy: eine einfache Liste (Linienart vorn zeigt, wie das Gerät verbunden ist).
// Gebraucht im Dashboard und auf der Connect-Seite (dort hinter dem Knopf „Verbindungen“).
import { t } from './i18n.js';
import { h, icon } from './ui.js';

const ICON_CONNECT = '<rect x="2" y="4" width="8" height="16" rx="1.5"/><rect x="14" y="4" width="8" height="16" rx="1.5"/><path d="M5 8h2M17 8h2M10 12h4"/>';
const MAX_JE_REIHE = 4;

/** Linienklasse aus der Verbindungsart */
const KLASSE = { heimnetz: 'nk-heimnetz', direkt: 'nk-direkt', tunnel: 'nk-tunnel', rueck: 'nk-rueck', aus: 'nk-aus' };

function kuerzen(s, n) { s = String(s || ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; }

function knoten(x, y, k, w, hoehe, eigen = false) {
  const connect = !!k.connect;
  const ring = connect ? `<rect class="gz-ring" x="${x - w / 2 - 5}" y="${y - hoehe / 2 - 5}" width="${w + 10}" height="${hoehe + 10}" rx="${hoehe / 2 + 5}"/>` : '';
  const ic = connect ? `<svg x="${x - w / 2 + 12}" y="${y - 9}" width="18" height="18" viewBox="0 0 24 24" class="gz-ci">${ICON_CONNECT}</svg>` : '';
  const tx = x + (connect ? 10 : 0);
  const zeichen = Math.max(12, Math.floor((w - (connect ? 46 : 24)) / 7.6));
  const klasse = ['nk-knoten', eigen ? 'nk-eigen' : '', k.blass ? 'nk-weg' : '', connect ? 'gz-connect' : ''].filter(Boolean).join(' ');
  return `<g class="${klasse}" tabindex="0" role="img" aria-label="${h(`${k.name} – ${k.unter || ''}`)}"><title>${h(`${k.name} – ${k.unter || ''}`)}</title>${ring}
    <rect x="${x - w / 2}" y="${y - hoehe / 2}" width="${w}" height="${hoehe}" rx="${eigen ? 16 : hoehe / 2}"/>${ic}
    <text x="${tx}" y="${y - 3}" class="nk-name">${h(kuerzen(k.name, zeichen))}</text><text x="${tx}" y="${y + 15}" class="nk-unter">${h(kuerzen(k.unter || '', zeichen + 6))}</text></g>`;
}

/** Knoten einer Reihe (höchstens vier; der Rest als „+ n weitere“) */
function reihe(liste) {
  if (liste.length <= MAX_JE_REIHE) return liste;
  const rest = liste.length - (MAX_JE_REIHE - 1);
  return [...liste.slice(0, MAX_JE_REIHE - 1), { name: t('+ {n} weitere', { n: rest }), unter: liste.slice(MAX_JE_REIHE - 1).map((x) => x.name).join(', '), linie: 'aus', blass: false }];
}

/**
 * HTML des Graphen.
 * daten = { server: { name, unter, linie }, heim: [knoten], weg: [knoten] }
 * knoten = { name, unter, linie: heimnetz|direkt|tunnel|rueck|aus, connect?: bool, blass?: bool }
 */
export function verbindungsGraph(daten) {
  const heim = reihe(daten.heim || []);
  const weg = reihe(daten.weg || []);
  const B = 1000, mitte = B / 2;
  const breite = (n) => Math.min(230, (B - 60) / Math.max(1, n) - 24);
  const xs = (n) => Array.from({ length: n }, (_, i) => 30 + ((B - 60) / n) * (i + 0.5));
  const S = { y: 244, w: 250, h: 64 };
  let linien = '', knotenHtml = '';
  // Heimnetz oben
  const hx = xs(heim.length), hw = breite(heim.length);
  heim.forEach((k, i) => {
    const x = hx[i], ziel = mitte + (i - (heim.length - 1) / 2) * 22;
    linien += `<path class="nk-linie ${KLASSE[k.linie] || 'nk-heimnetz'}" d="M${x},117 C${x},175 ${ziel},165 ${ziel},${S.y - S.h / 2}"/>`;
    knotenHtml += knoten(x, 92, k, hw, 50);
  });
  // Server in der Mitte, darunter das Internet (nur, wenn jemand unterwegs ist)
  knotenHtml += knoten(mitte, S.y, { name: daten.server.name, unter: daten.server.unter }, S.w, S.h, true);
  const netzY = 320;
  if (weg.length) {
    const sk = KLASSE[daten.server.linie] || 'nk-tunnel';
    linien += daten.server.linie === 'rueck'
      ? `<path class="nk-linie ${sk}" d="M${mitte},${S.y + S.h / 2} L${mitte},${netzY - 24}" marker-end="url(#vg-pfeil)"/>`
      : `<path class="nk-linie ${sk}" d="M${mitte},${S.y + S.h / 2} L${mitte},${netzY - 20}"/>`;
    linien += `<text x="${mitte + 12}" y="${S.y + S.h / 2 + 22}" class="nk-beschr ${sk}">${h(daten.server.linieText || '')}</text>`;
    knotenHtml += `<g class="nk-netz"><rect x="${mitte - 60}" y="${netzY - 20}" width="120" height="40" rx="20"/><text x="${mitte}" y="${netzY + 5}">${h(t('Internet'))}</text></g>`;
    const wx = xs(weg.length), ww = breite(weg.length);
    weg.forEach((k, i) => {
      const x = wx[i], start = mitte + (i - (weg.length - 1) / 2) * 22, kl = KLASSE[k.linie] || 'nk-tunnel';
      linien += k.linie === 'rueck'
        ? `<path class="nk-linie ${kl}" d="M${x},415 C${x},375 ${start},385 ${start},${netzY + 24}" marker-end="url(#vg-pfeil)"/>`
        : `<path class="nk-linie ${kl}" d="M${start},${netzY + 20} C${start},385 ${x},375 ${x},415"/>`;
      knotenHtml += knoten(x, 440, k, ww, 50);
    });
  }
  const H = weg.length ? 500 : 290;
  const zonen = `<rect x="10" y="8" width="${B - 20}" height="150" rx="20" class="gz-zone gz-heim"/><text x="30" y="34" class="gz-titel">${h(t('Heimnetz'))}</text>
    ${heim.length ? '' : `<text x="${mitte}" y="98" class="gz-leer">${h(t('gerade niemand im Heimnetz'))}</text>`}
    ${weg.length ? `<rect x="10" y="352" width="${B - 20}" height="140" rx="20" class="gz-zone gz-weg"/><text x="30" y="482" class="gz-titel">${h(t('Unterwegs & Partner'))}</text>` : ''}`;
  const svg = `<svg viewBox="0 0 ${B} ${H}" role="group" aria-label="${h(t('Wer gerade mit diesem Server verbunden ist'))}">
    <defs><marker id="vg-pfeil" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="nk-pfeilspitze"/></marker></defs>
    ${zonen}${linien}${knotenHtml}</svg>`;
  return `<div class="vg"><div class="nk-bild vg-bild">${svg}</div>${verbindungsListe(daten)}${legende()}</div>`;
}

/** Handy: dieselben Verbindungen als einfache Liste */
function verbindungsListe(daten) {
  const zeile = (k) => `<div class="gz-m${k.blass ? ' gz-m-weg' : ''}${k.connect ? ' gz-m-connect' : ''}"><i class="gz-m-linie ${KLASSE[k.linie] || ''}"></i>
    <b>${k.connect ? `<svg class="gz-ci" width="16" height="16" viewBox="0 0 24 24">${ICON_CONNECT}</svg>` : ''}${h(k.name)}</b><span>${h(k.unter || '')}</span></div>`;
  const alle = [...(daten.heim || []), ...(daten.weg || [])];
  const gruppe = (titel, liste, zusatz = '') => (liste.length ? `<div class="gz-m-gruppe">${h(titel)}${zusatz ? ` <small>${h(zusatz)}</small>` : ''}</div>${liste.map(zeile).join('')}` : '');
  return `<div class="gz-mobil">${gruppe(t('Zuhause'), (daten.heim || []).filter((k) => !k.connect))}${gruppe(t('Unterwegs'), (daten.weg || []).filter((k) => !k.connect), daten.unterwegsAdresse || '')}${gruppe('Amberwave Connect', alle.filter((k) => k.connect))}
    ${alle.length ? '' : `<p class="hinweis">${h(t('Gerade ist niemand verbunden.'))}</p>`}</div>`;
}

function legende() {
  return `<div class="nk-legende">${[['nk-heimnetz', t('Heimnetz')], ['nk-direkt', t('Direktzugang')], ['nk-tunnel', t('Tunnel / offene Adresse')], ['nk-rueck', t('Rückkanal – hält die Verbindung von innen offen (CGNAT)')], ['nk-aus', t('gerade nicht verbunden')]]
    .map(([k, n]) => `<span><i class="${k}" aria-hidden="true"></i>${h(n)}</span>`).join('')}<span class="vg-connect-leg">${icon('connect', 14)}${h(t('Amberwave-Server'))}</span></div>`;
}

const WEG_TEXT = () => ({ heimnetz: t('Heimnetz'), direkt: t('Direktzugang'), tunnel: t('Tunnel'), rueckkanal: t('Rückkanal'), oeffentlich: t('offen') });

/** Knoten für gekoppelte Connect-Server (aus /connect/server) */
export function connectKnoten(server) {
  return (server || []).map((s) => {
    const art = s.erreichbar ? s.weg?.art || '' : '';
    const linie = !art ? 'aus' : art === 'heimnetz' ? 'heimnetz' : art === 'rueckkanal' ? 'rueck' : art === 'direkt' ? 'direkt' : 'tunnel';
    const ms = s.weg?.ms != null ? ` · ${s.weg.ms} ms` : '';
    return { name: s.name, unter: art ? `${WEG_TEXT()[art] || art}${ms}` : t('nicht erreichbar'), linie, connect: true, blass: !art, heim: art === 'heimnetz' };
  });
}

const aktivZuerst = (l) => [...l.filter((k) => !k.blass), ...l.filter((k) => k.blass)];

/** Daten für den Graphen aus Dashboard-Stand (Geräte) und Connect-Liste */
export function graphDaten({ ausweis, server: peers, geraete, adresseUnterwegs }) {
  const apps = geraete?.apps || [];
  const artText = { windows: 'Windows Client', android: t('Android'), app: 'App', browser: t('Browser') };
  const app = (g) => ({ name: g.name, unter: `${artText[g.art] || ''}${g.user ? ` · ${g.user}` : ''}${g.spielt ? ` · ${t('spielt')}` : ''}`, linie: !g.aktiv ? 'aus' : g.ort === 'heim' ? 'heimnetz' : 'tunnel', blass: !g.aktiv });
  const heimGer = (geraete?.heim || []).filter((x) => x.da).map((x) => ({ name: x.name, unter: x.modell || t('Gerät im Heimnetz'), linie: 'heimnetz' }));
  const cn = connectKnoten(peers);
  const vonAussen = ausweis?.von_aussen;
  return {
    server: { name: ausweis?.name || t('Dieser Server'), unter: `${t('dieser Server')}${vonAussen ? ` · ${ausweis.tunnel ? t('Tunnel') : t('offen')}` : ` · ${t('nur ausgehend')}`}`,
      linie: vonAussen ? 'tunnel' : 'rueck', linieText: vonAussen ? (ausweis.tunnel ? t('Tunnel') : t('offen')) : t('nur ausgehend') },
    // Aktive zuerst – was gerade nicht verbunden ist, landet bei vielen Geräten in „+ n weitere“
    heim: aktivZuerst([...apps.filter((g) => g.ort === 'heim').map(app), ...heimGer, ...cn.filter((k) => k.heim)]),
    weg: aktivZuerst([...apps.filter((g) => g.ort !== 'heim').map(app), ...cn.filter((k) => !k.heim)]),
    unterwegsAdresse: adresseUnterwegs || '',
  };
}
