// Die Amber-Klangfamilie: AmberGlow (Röhre), AmberIron (Übertrager), AmberSilk (Band), AmberSpace (Upmixer) – in Signalreihenfolge.
// Hier: Namen, Texte, Icons (klein einfarbig für Leiste/Signalweg, groß mit Bernstein-Verlauf für Menüs und Karten)
// und die Karten-Übersicht für „Läuft gerade“.
import { h, morph, bind } from './ui.js';
import { t, zahl, sprache } from './i18n.js';
import { WAERME_STUFEN, WAERME_ROEHREN, waermeNormal, waermeStufe, waermeStufeErkennen, waermeWirksam } from './waerme.js';
import { BAND_STUFEN, bandNormal, bandStufe, bandStufeErkennen, bandWirksam } from './band.js';
import { TRAFO_STUFEN, TRAFO_KERNE, trafoNormal, trafoStufe, trafoStufeErkennen, trafoWirksam } from './trafo.js';
import { RAUMKLANG_PRESETS, FEIN_STANDARD, staerkeWerte, staerkeErkennen, ausgabeKanaele, layoutFuer } from './raumklang.js';
import { eqNormal, eqWirksam } from './eq.js';

export const KLANG = {
  glow: { name: 'AmberGlow', kurz: 'Glow', art: t('Röhrensättigung'), en: 'Tube', text: t('Harmonische Wärme, samtige Höhen und mehr Klangfülle.') },
  iron: { name: 'AmberIron', kurz: 'Iron', art: t('Übertrager'), en: 'Transformer', text: t('Festes Fundament, dichter Bass und der Glanz klassischer Pulte.') },
  silk: { name: 'AmberSilk', kurz: 'Silk', art: t('Bandsättigung'), en: 'Tape', text: t('Cremige Texturen, samtige Höhen und sanfte Transienten.') },
  space: { name: 'AmberSpace', kurz: 'Space', art: t('Räumliche Wiedergabe'), en: 'Upmixer', text: t('Größere Klangbühne, räumliche Tiefe und umhüllende Atmosphäre.') },
};

// Formen (viewBox 32×32). Klassen: s1 = Hauptlinie, s2 = Akzent (Heizfaden, Seide, Boden), f = Füllung (Glühen, Naben)
const FORM = {
  glow: `<ellipse class="f" cx="16" cy="16.5" rx="5.2" ry="6"/>
    <path class="s1" d="M10 13a6 6 0 0 1 12 0v9.5a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 10 22.5z"/>
    <path class="s1 d" d="M13 21v-5.5M19 21v-5.5"/>
    <path class="s2" d="M13 15.5c1 1.6 2 1.6 3 0s2-1.6 3 0"/>
    <path class="s1" d="M12 25v3M16 25v3M20 25v3"/>
    <path class="s1 d" d="M16 3.2v2.2M8.4 6.2l1.5 1.5M23.6 6.2l-1.5 1.5" opacity=".8"/>`,
  iron: `<rect class="f" x="13.6" y="5" width="4.8" height="22" rx="1.2"/>
    <path class="s1" d="M8.5 7c3.6 0 3.6 4.5 0 4.5c3.6 0 3.6 4.5 0 4.5c3.6 0 3.6 4.5 0 4.5c3.6 0 3.6 4.5 0 4.5"/>
    <path class="s1" d="M23.5 7c-3.6 0-3.6 4.5 0 4.5c-3.6 0-3.6 4.5 0 4.5c-3.6 0-3.6 4.5 0 4.5c-3.6 0-3.6 4.5 0 4.5"/>
    <path class="s2" d="M15 5v22M17 5v22"/>
    <path class="s1 d" d="M3.5 7h5M3.5 25h5M23.5 7h5M23.5 25h5" opacity=".8"/>`,
  silk: `<circle class="s1" cx="9" cy="12" r="5.6"/><circle class="s1" cx="23" cy="12" r="5.6"/>
    <circle class="f s1 d" cx="9" cy="12" r="2.6"/><circle class="f s1 d" cx="23" cy="12" r="2.6"/>
    <path class="s1 d" d="M9 17.6C11.5 19 13 21 16 21s4.5-2 7-3.4"/>
    <path class="s2" d="M3 26.5c3.2-2.6 6.4-2.6 9.6 0s6.4 2.6 9.6 0 4.6-2 6.8-.6"/>`,
  space: `<circle class="f s1 d" cx="16" cy="15" r="2.8"/>
    <path class="s1" d="M11 10a7 7 0 0 0 0 10M21 10a7 7 0 0 1 0 10"/>
    <path class="s1 d" d="M7 6.5a12 12 0 0 0 0 17M25 6.5a12 12 0 0 1 0 17" opacity=".75"/>
    <path class="s2 d" d="M4 27.5c4 1.6 20 1.6 24 0" opacity=".7"/>`,
};

let zaehler = 0;

/** Kleines Icon in currentColor (Leiste, Signalweg, Chips) */
export function klangIconKlein(art, groesse = 18) {
  return `<svg class="ki ki-klein" viewBox="0 0 32 32" width="${groesse}" height="${groesse}" aria-hidden="true">${FORM[art] || ''}</svg>`;
}

/** Großes Icon mit Bernstein-Verlauf und Glühen (Menü-Kopf, Karten) – an = farbig, aus = gedämpft */
export function klangIconGross(art, an = true) {
  const id = `kg${++zaehler}`;
  return `<span class="ki-kachel${an ? ' an' : ''}"><svg class="ki ki-gross" viewBox="0 0 32 32" aria-hidden="true" style="--kg:url(#${id}a);--kf:url(#${id}b)">
    <defs><linearGradient id="${id}a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffd27e"/><stop offset="1" stop-color="#ff7a3d"/></linearGradient>
    <radialGradient id="${id}b" cx="50%" cy="60%" r="50%"><stop offset="0" stop-color="#ffcf6e" stop-opacity=".95"/><stop offset=".55" stop-color="#ff8a3d" stop-opacity=".35"/><stop offset="1" stop-color="#ff7a3d" stop-opacity="0"/></radialGradient></defs>
    ${FORM[art] || ''}</svg></span>`;
}

/** Kopf eines Klang-Menüs: Kachel, Name im Verlauf, Untertitel, Schalter */
export function klangKopf(art, an, zusatz, schalterAttr, schalterAus = false) {
  const k = KLANG[art];
  return `<div class="rk-kopf kf-kopf">
    ${klangIconGross(art, an)}
    <div class="rk-kopf-text"><b class="kf-name${an ? ' an' : ''}">${k.name}</b><small>${k.art}${sprache === 'de' ? ` · <em>${k.en}</em>` : ''}${zusatz ? ` · ${zusatz}` : ''}</small></div>
    <button type="button" class="rk-schalter${an ? ' an' : ''}" role="switch" aria-checked="${an}" aria-label="${an ? t('{name} ausschalten', { name: k.name }) : t('{name} einschalten', { name: k.name })}" ${schalterAttr} ${schalterAus ? 'disabled' : ''}><i></i></button>
  </div>`;
}

/** Prominenter HQ-Schalter (Menüs): Marke, Erklärung, Schalter */
export function hqKnopf(an, attr, text) {
  return `<button type="button" class="hq-knopf${an ? ' an' : ''}" aria-pressed="${an}" ${attr}>
    <span class="hq-marke" aria-hidden="true">HQ</span>
    <span class="hq-text"><b>High Quality${an ? ` · ${t('an')}` : ''}</b><small>${text}</small></span>
    <span class="hq-schalter" aria-hidden="true"><i></i></span>
  </button>`;
}

// ---------- Karten-Übersicht („Läuft gerade“ → Klang) ----------

function zustand(player) {
  const w = waermeNormal(player.einst.waerme), b = bandNormal(player.einst.band), tr = trafoNormal(player.einst.trafo);
  const rk = player.raumklang;
  const layout = layoutFuer(rk.ctx ? rk.ctx.destination.maxChannelCount : ausgabeKanaele());
  const fein = { ...FEIN_STANDARD, ...(player.einst.raumklang_fein || {}) };
  return {
    glow: { an: waermeWirksam(w), hq: w.hq, stufen: Object.entries(WAERME_STUFEN).map(([k, s]) => [k, s.name]), wahl: waermeStufeErkennen(w),
      fuss: [WAERME_ROEHREN[w.roehre]?.name, w.schaltung === 'gegentakt' ? t('Gegentakt') : '', 'Auto-Gain', w.vert === 50 ? t('Mitte/Seite') : w.vert < 50 ? t('eher Mitte') : t('eher Seiten')].filter(Boolean).join(' · ') },
    iron: { an: trafoWirksam(tr), hq: tr.hq, stufen: Object.entries(TRAFO_STUFEN).map(([k, s]) => [k, s.name]), wahl: trafoStufeErkennen(tr),
      fuss: [t('Kern {name}', { name: TRAFO_KERNE[tr.kern].name }), 'Auto-Gain'].join(' · ') },
    silk: { an: bandWirksam(b), hq: b.hq, stufen: Object.entries(BAND_STUFEN).map(([k, s]) => [k, s.name]), wahl: bandStufeErkennen(b),
      fuss: [`${zahl(b.ips)} ips`, b.kopf ? t('Kopfbump') : '', 'Auto-Gain'].filter(Boolean).join(' · ') },
    space: { an: player.einst.raumklang !== 'aus' && !!rk.aktiv, stufen: [['klein', t('Subtil')], ['mittel', t('Weit')], ['gross', t('Intensiv')]], wahl: staerkeErkennen(fein),
      gesperrt: !layout,
      fuss: layout ? `Stereo → ${layout.name}${player.einst.raumklang !== 'aus' ? ` · ${RAUMKLANG_PRESETS[player.einst.raumklang]?.name || ''}` : ''}` : t('nur an einem 5.1- oder Quadro-Ausgang') },
  };
}

/** HTML der drei Karten */
export function klangKartenHtml(player) {
  const z = zustand(player);
  return `<div class="kf-karten">${['glow', 'iron', 'silk', 'space'].map((art) => {
    const k = KLANG[art], s = z[art];
    return `<div class="kf-karte${s.an ? ' an' : ''}${s.gesperrt ? ' gesperrt' : ''}" data-kf="${art}">
      ${klangKopf(art, s.an, '', 'data-kf-schalter', s.gesperrt)}
      <p class="kf-text">${k.text}</p>
      <div class="rk-seg kf-seg" role="group" aria-label="${t('Stufe {name}', { name: k.name })}">${s.stufen.map(([key, n]) => `<button type="button" data-kf-stufe="${key}" aria-pressed="${s.an && s.wahl === key}" ${s.gesperrt ? 'disabled' : ''}>${h(n)}</button>`).join('')}</div>
      <div class="kf-fuss">${art !== 'space' ? `<button type="button" class="hq-pille${s.hq ? ' an' : ''}" aria-pressed="${!!s.hq}" data-kf-hq title="High Quality: ${({ glow: t('12AX7-Stufe als Schaltung gelöst, 8× Oversampling'), iron: t('Kern mit Hysterese-Gedächtnis und Toleranzen'), silk: t('8× Oversampling, Hysterese-Rest, Gleichlauf') })[art]}">HQ</button>` : ''}<span>${h(s.fuss)}</span><button type="button" class="kf-mehr" data-kf-mehr>${t('Erweitert')} ›</button></div>
    </div>`;
  }).join('')}</div>`;
}

/**
 * Karten in einen Container zeichnen und verdrahten. oeffnen(art, anker) öffnet das jeweilige Menü (Erweitert).
 * Gibt eine Funktion zurück, die neu zeichnet.
 */
export function klangKartenEinrichten(box, player, oeffnen) {
  const zeichnen = () => {
    const html = klangKartenHtml(player);
    if (box.firstElementChild) morph(box, html); else box.innerHTML = html;
    box.querySelectorAll('[data-kf]').forEach((karte) => {
      const art = karte.dataset.kf;
      bind(karte.querySelector('[data-kf-hq]'), 'click', () => {
        if (art === 'glow') { const w = waermeNormal(player.einst.waerme); player.waermeSetzen({ ...w, hq: !w.hq }); }
        else if (art === 'iron') { const t = trafoNormal(player.einst.trafo); player.trafoSetzen({ ...t, hq: !t.hq }); }
        else { const b = bandNormal(player.einst.band); player.bandSetzen({ ...b, hq: !b.hq }); }
        zeichnen();
      });
      bind(karte.querySelector('[data-kf-schalter]'), 'click', async () => {
        if (art === 'glow') { const w = waermeNormal(player.einst.waerme); player.waermeSetzen({ ...w, an: !waermeWirksam(w), mix: w.mix || 85 }); }
        else if (art === 'silk') { const b = bandNormal(player.einst.band); player.bandSetzen({ ...b, an: !bandWirksam(b), mix: b.mix || 100 }); }
        else if (art === 'iron') { const t = trafoNormal(player.einst.trafo); player.trafoSetzen({ ...t, an: !trafoWirksam(t), mix: t.mix || 100 }); }
        else await player.raumklangUmschalten();
        zeichnen();
      });
      karte.querySelectorAll('[data-kf-stufe]').forEach((knopf) => bind(knopf, 'click', async () => {
        const st = knopf.dataset.kfStufe;
        if (art === 'glow') player.waermeSetzen({ ...waermeStufe(waermeNormal(player.einst.waerme), st), an: true });
        else if (art === 'silk') player.bandSetzen({ ...bandStufe(bandNormal(player.einst.band), st), an: true });
        else if (art === 'iron') player.trafoSetzen({ ...trafoStufe(trafoNormal(player.einst.trafo), st), an: true });
        else {
          player.raumklangFeinSetzen(staerkeWerte(st));
          if (player.einst.raumklang === 'aus') await player.raumklangUmschalten();
        }
        zeichnen();
      }));
      bind(karte.querySelector('[data-kf-mehr]'), 'click', (e) => oeffnen(art, e.currentTarget));
    });
  };
  zeichnen();
  return zeichnen;
}

// ---------- Kompakte Liste (Handy, Tablet, Foldable: „Läuft gerade“ → Klang) ----------
// Je Gerät eine Zeile: Symbol, Name und Art, die gewählte Stufe, Schalter. Tippen auf die Zeile öffnet das Effektrack beim
// Gerät. Darunter die Lautheit und ein Hinweis, warum es mit Effekten nicht mehr bitgenau ist.
const STUFE_NAME = (z, art) => { const s = z[art]; const n = s.stufen.find(([k]) => k === s.wahl); return n ? n[1] : t('eigene'); };

export function klangListeHtml(player) {
  const z = zustand(player);
  const eq = eqNormal(player.einst.eq);
  const eqAn = eqWirksam(eq);
  const zeilen = ['glow', 'iron', 'silk', 'space'].map((art) => {
    const k = KLANG[art], s = z[art];
    const wert = s.gesperrt ? t('nur Mehrkanal') : s.an ? STUFE_NAME(z, art) : t('aus');
    return `<div class="kl-zeile${s.an ? ' an' : ''}${s.gesperrt ? ' gesperrt' : ''}" data-kl="${art}">
      <button type="button" class="kl-oeffnen" data-kl-oeffnen aria-label="${t('{name} einstellen', { name: k.name })}">${klangIconGross(art, s.an)}<span class="kl-tx"><b>${k.kurz}</b><small>${k.art}</small></span><span class="kl-wert">${h(wert)}</span></button>
      <button type="button" class="rk-schalter${s.an ? ' an' : ''}" role="switch" aria-checked="${s.an}" aria-label="${s.an ? t('{name} ausschalten', { name: k.name }) : t('{name} einschalten', { name: k.name })}" data-kl-schalter ${s.gesperrt ? 'disabled' : ''}><i></i></button>
    </div>`;
  });
  zeilen.push(`<div class="kl-zeile${eqAn ? ' an' : ''}" data-kl="eq">
      <button type="button" class="kl-oeffnen" data-kl-oeffnen aria-label="${t('Equalizer einstellen')}"><span class="ki-kachel kl-eq${eqAn ? ' an' : ''}"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 4v16M12 4v16M18 4v16"/><rect x="4" y="13" width="4" height="3" rx="1"/><rect x="10" y="7" width="4" height="3" rx="1"/><rect x="16" y="11" width="4" height="3" rx="1"/></svg></span><span class="kl-tx"><b>EQ</b><small>${t('Equalizer')}</small></span><span class="kl-wert">${eqAn ? t('an') : t('aus')}</span></button>
      <button type="button" class="rk-schalter${eqAn ? ' an' : ''}" role="switch" aria-checked="${eqAn}" aria-label="${eqAn ? t('Equalizer ausschalten') : t('Equalizer einschalten')}" data-kl-schalter><i></i></button>
    </div>`);
  const titel = player.track;
  const lh = titel ? player.lautheitFuer(titel) : null;
  const komma = (x, n = 1) => zahl(x, n).replace('-', '−');
  const lhHtml = player.einst.lautheit === 'aus'
    ? `<div class="kl-lh"><small>${t('Lautheit')}</small><b>${t('Angleich aus')}</b><span>${t('Spielt so laut wie gemastert')}</span></div>`
    : lh && lh.art !== 'fehlt'
      ? `<div class="kl-lh"><small>${t('Lautheit')}</small><b>${lh.art === 'album' ? t('Album {db} dB', { db: `${lh.db > 0 ? '+' : ''}${komma(lh.db)}` }) : t('Titel {db} dB', { db: `${lh.db > 0 ? '+' : ''}${komma(lh.db)}` })}</b><span>${t('{lufs} LUFS → Ziel {ziel} LUFS · EBU R128', { lufs: komma(lh.lufs), ziel: komma(lh.ziel, 0) })}${lh.begrenzt ? ` · ${t('begrenzt')}` : ''}</span>
        <div class="kl-lh-balken" aria-hidden="true"><i style="left:${Math.max(0, Math.min(100, (lh.lufs + 30) / 26 * 100)).toFixed(1)}%"></i><em style="left:${Math.max(0, Math.min(100, (lh.ziel + 30) / 26 * 100)).toFixed(1)}%"></em></div></div>`
      : `<div class="kl-lh"><small>${t('Lautheit')}</small><b>${t('noch nicht gemessen')}</b><span>${t('spielt ohne Angleich')}</span></div>`;
  const irgendwas = ['glow', 'iron', 'silk', 'space'].some((a) => z[a].an) || eqAn;
  return `<div class="kl-liste">${zeilen.join('')}</div>${lhHtml}
    <p class="kl-hinweis">${irgendwas ? t('Mit Effekten ist es nicht mehr bitgenau – die Engine rechnet in 64 Bit und dithert ins Ausgabeformat.') : t('Alle Effekte aus: die Musik kommt unverändert an.')}</p>`;
}

/** Liste zeichnen und verdrahten; oeffnen(art) öffnet das Effektrack beim Gerät. Gibt die Neu-Zeichnen-Funktion zurück */
export function klangListeEinrichten(box, player, oeffnen) {
  const zeichnen = () => {
    box.innerHTML = klangListeHtml(player);
    box.querySelectorAll('[data-kl]').forEach((zeile) => {
      const art = zeile.dataset.kl;
      bind(zeile.querySelector('[data-kl-oeffnen]'), 'click', () => oeffnen(art));
      bind(zeile.querySelector('[data-kl-schalter]'), 'click', async () => {
        if (art === 'glow') { const w = waermeNormal(player.einst.waerme); player.waermeSetzen({ ...w, an: !waermeWirksam(w), mix: w.mix || 85 }); }
        else if (art === 'silk') { const b = bandNormal(player.einst.band); player.bandSetzen({ ...b, an: !bandWirksam(b), mix: b.mix || 100 }); }
        else if (art === 'iron') { const t = trafoNormal(player.einst.trafo); player.trafoSetzen({ ...t, an: !trafoWirksam(t), mix: t.mix || 100 }); }
        else if (art === 'eq') { const e = eqNormal(player.einst.eq); player.eqSetzen({ ...e, an: !e.an }); }
        else await player.raumklangUmschalten();
        zeichnen();
      });
    });
  };
  zeichnen();
  return zeichnen;
}
