// Raumklang-Menü (Popover über der Player-Leiste): Schalter, Preset-Kacheln, Raum, Regler für Intensität, Surround-Pegel,
// „Effekte/Breite nach hinten“ und Center-Anteil, Bassmanagement (Trennfrequenz, LFE-Pegel), Solo je Lautsprecher, Abhören je Ebene, Zurücksetzen.
import { api } from './api.js';
import { t, zahl } from './i18n.js';
import { h, morph, bind, detailsAnimieren } from './ui.js';
import { klangKopf, KLANG } from './klangfamilie.js';
import { RAUMKLANG_PRESETS, FEIN_STANDARD, staerkeWerte, staerkeErkennen, ausgabeKanaele, layoutFuer, irListe, irWaehlen, lautsprecherVon, LCR_TRENNUNGEN, lcrWerte } from './raumklang.js';
import { text as feinText } from './raumklangfein.js';

const PRESET_ICON = {
  dezent: '<path d="M5 10v4h3l4 3V7L8 10zM16 9.5a3.5 3.5 0 010 5"/>',
  raum: '<path d="M3 8l9-4 9 4v9l-9 4-9-4zM3 8l9 4 9-4M12 12v9"/>',
  halle: '<path d="M3 21V10a9 9 0 0118 0v11M8 21v-8a4 4 0 018 0v8M3 21h18"/>',
  live: '<path d="M12 3a3 3 0 013 3v5a3 3 0 01-6 0V6a3 3 0 013-3zM6 11a6 6 0 0012 0M12 17v4M8 21h8"/>',
};
const KURZ = { dezent: t('etwas Raum'), raum: t('großer Raum'), halle: t('dunkler Hall'), live: t('Konzert') };
const REGLER_BASIS = [
  { key: 'intensitaet', titel: t('Intensität (Raum und Hall)'), skala: [t('Hall aus'), t('Preset'), t('mehr')], mitte: true },
  { key: 'pegel', titel: t('Surround-Pegel (Ls/Rs)'), skala: [t('leiser'), t('Preset'), t('lauter')], mitte: true },
];
const REGLER_EFF = { key: 'effekte', titel: t('Effekte nach hinten (gegenphasig)'), skala: [t('aus'), t('etwas'), t('deutlich')], mitte: false };
const REGLER_BREIT = { key: 'breite', titel: t('Breite nach hinten (Doubles, Orgel)'), skala: [t('aus'), t('etwas'), t('rundherum')], mitte: false };
const REGLER_CENTER = { key: 'center', titel: t('Center-Anteil (LCR per M/S)'), skala: [t('nur L/R'), t('klassisch −3 dB'), t('alles im Center')], mitte: true };
const STAERKE_NAMEN = [['klein', t('Subtil')], ['mittel', t('Weit')], ['gross', t('Intensiv')]];
const IR_ARTEN = { kammer: 'Kammer', raum: 'Raum', halle: 'Halle', kirche: 'Kirche', plate: 'Plate/Feder', sonstige: 'Sonstige' };
// Der Server liefert die Art deutsch (Gruppierung/Reihenfolge hängen daran) – nur die Anzeige wird übersetzt
const IR_ART_ANZEIGE = { Kammer: t('Kammer'), Raum: t('Raum'), Halle: t('Halle'), Kirche: t('Kirche'), 'Plate/Feder': t('Plate/Feder'), Sonstige: t('Sonstige') };
const ABHOEREN = [['alles', t('Alles')], ['vorne', t('Vorne')], ['raum', t('Raum')], ['effekte', t('Effekte')]];

let offen = null; // { el, schliessen }

export function raumklangMenueSchliessen() {
  if (offen) offen.schliessen();
}

/** Menü am Anker öffnen (nochmal klicken = schließen). leiste = PlayerLeiste, wird nach Änderungen aktualisiert. */
export function raumklangMenueOeffnen(leiste, anker) {
  if (offen) {
    const war = offen.anker === anker;
    offen.schliessen();
    if (war) return;
  }
  const player = leiste.player;
  const el = document.createElement('div');
  el.className = 'rk-menue';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'AmberSpace');
  document.body.appendChild(el);
  let irs = null;

  const layout = () => layoutFuer(player.raumklang.ctx ? player.raumklang.ctx.destination.maxChannelCount : ausgabeKanaele());
  const fein = () => ({ ...FEIN_STANDARD, ...(player.einst.raumklang_fein || {}) });
  let erweitertOffen = false;
  const aktualisiert = () => { leiste.aktualisieren(); };

  // Pegel je Lautsprecher in den Solo-Knöpfen (Spitze mit Rückfall, ~60 dB Anzeigebereich)
  let pegelRaf = 0;
  const pegelPuffer = new Float32Array(2048), pegelAnz = [];
  const pegelLauf = () => {
    const sp = player.raumklang.spitzen?.(pegelPuffer);
    if (sp) el.querySelectorAll('[data-pegel]').forEach((i) => {
      const c = Number(i.dataset.pegel);
      const db = 20 * Math.log10((sp[c] || 0) + 1e-9);
      const ziel = Math.max(0, Math.min(1, (db + 60) / 60));
      pegelAnz[c] = Math.max(ziel, (pegelAnz[c] || 0) - 0.025);
      i.style.setProperty('--p', pegelAnz[c].toFixed(3));
    });
    pegelRaf = requestAnimationFrame(pegelLauf);
  };

  const zeichnen = () => {
    const l = layout();
    const an = player.einst.raumklang !== 'aus' && !!l;
    const wahl = player.einst.raumklang !== 'aus' ? player.einst.raumklang : null;
    const f = fein();
    const preset = RAUMKLANG_PRESETS[wahl || player.einst.raumklang_letzt] || null;
    const max = player.raumklang.ctx ? player.raumklang.ctx.destination.maxChannelCount : ausgabeKanaele();
    const lw = lcrWerte(f);
    const staerke = staerkeErkennen(f);
    const REGLER = [...REGLER_BASIS, REGLER_EFF, REGLER_BREIT, ...(l && l.c !== null ? [REGLER_CENTER] : [])];
    const abh = player.raumklang.abhoerModus || 'alles';
    el.classList.toggle('stereo', !l);
    const html = `
      ${klangKopf('space', an, l ? (an ? t('Stereo → {name}', { name: l.name }) : t('aus')) : t('nur Stereo'), 'data-rk-schalter', !l)}
      ${l ? '' : `<div class="rk-hinweis"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/></svg>
        <div><b>${t('Dieses Gerät gibt nur Stereo aus ({max} Kanäle).', { max })}</b><span>${t('AmberSpace wirkt erst an einem 5.1- oder Quadro-Ausgang, zum Beispiel am PC per HDMI am AV-Receiver (in Windows auf 5.1 stellen). Die Regler kannst du trotzdem schon vorbereiten.')}</span></div></div>`}
      <div class="rk-presets" role="group" aria-label="${t('Preset')}">
        ${Object.entries(RAUMKLANG_PRESETS).map(([k, x]) => `<button type="button" class="rk-preset${wahl === k ? ' an' : ''}" data-preset="${k}" aria-pressed="${wahl === k}" ${l ? '' : 'disabled'}>
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PRESET_ICON[k] || PRESET_ICON.raum}</svg>
          <b>${h(x.name)}</b><small>${KURZ[k] || ''}</small></button>`).join('')}
      </div>
      <p class="rk-info"><b>${KLANG.space.text}</b> ${preset ? h(preset.info) : ''}</p>
      <div class="rk-regler">
        <div class="rk-verfahren"><span>${t('Stärke')}</span>
          <div class="rk-seg" role="group" aria-label="${t('Stärke des Raumeffekts')}" data-staerke>
            ${STAERKE_NAMEN.map(([k, n]) => `<button type="button" data-s="${k}" aria-pressed="${staerke === k}" title="${({ klein: t('Subtil: die Bühne bleibt vorne, nur etwas Raum'), mittel: t('Weit: spürbarer Raum, Bühne weiter vorne'), gross: t('Intensiv: Raum und Effekte rundherum') })[k]}">${n}</button>`).join('')}
          </div></div>
        <details class="rk-erweitert" data-erweitert ${erweitertOffen ? 'open' : ''}>
          <summary>${t('Erweitert')}${staerke ? '' : ` · ${t('eigene Einstellung')}`}</summary>
          <div class="rk-raum"><span>${t('Raum')}</span>
            <select data-rk-ir aria-label="${t('Raum (Impulsantwort)')}">${irOptionen(wahl || player.einst.raumklang_letzt)}</select></div>
          <div class="rk-ir-neu"><label class="rk-knopf" for="rk-ir-datei">${t('Eigene Impulsantwort hochladen …')}</label>
            <input id="rk-ir-datei" type="file" accept=".wav,audio/wav" data-rk-ir-datei hidden>
            <select data-rk-ir-art aria-label="${t('Art der Impulsantwort')}"><option value="">${t('Art automatisch')}</option>${Object.entries(IR_ARTEN).map(([k, n]) => `<option value="${k}">${IR_ART_ANZEIGE[n]}</option>`).join('')}</select>
            <small data-rk-ir-meldung></small></div>
        ${REGLER.map((r) => `<div class="rk-regler-zeile">
          <div class="rk-regler-kopf"><label for="rkm-${r.key}">${r.titel}</label><b data-wert="${r.key}">${feinText(r.key, f[r.key])}</b></div>
          <input id="rkm-${r.key}" type="range" class="regler rk-r${r.mitte ? ' mitte' : ''}" min="0" max="100" step="1" value="${f[r.key]}" data-fein="${r.key}">
          <div class="rk-skala">${r.skala.map((s) => `<span>${s}</span>`).join('')}</div></div>`).join('')}
          ${l && player.ausgangBassInfo?.an ? `<div class="rk-verfahren"><span>${t('Bass → Sub')}</span>
          <div class="rk-step" role="group" aria-label="${t('Trennfrequenz des Subwoofers (Ausgang)')}">
            <button type="button" data-ab="-10" aria-label="${t('10 Hz tiefer')}" ${player.ausgangBassInfo.hz <= 50 ? 'disabled' : ''}>−</button><b data-ab-w>${player.ausgangBassInfo.hz} Hz</b><button type="button" data-ab="10" aria-label="${t('10 Hz höher')}" ${player.ausgangBassInfo.hz >= 200 ? 'disabled' : ''}>+</button>
          </div></div>
          <p class="rk-notiz">${t('Bassmanagement macht der Ausgang „{name}“ – gleiche Einstellung wie unter Ausgänge &amp; Lautsprecher, wirkt sofort.', { name: h(player.ausgangBassInfo.ausgang?.name || t('Subwoofer')) })}</p>`
          : l && l.kanaele === 6 ? `<div class="rk-verfahren"><span>${t('Bass → LFE')}</span>
          <div class="rk-seg" role="group" aria-label="${t('Trennfrequenz LFE')}" data-trennung>
            ${LCR_TRENNUNGEN.map((tr) => `<button type="button" data-t="${tr}" aria-pressed="${lw.trennung === tr}" title="${tr ? t('Linkwitz-Riley 24 dB/Okt. bei {hz} Hz: darunter zum LFE, darüber L/C/R', { hz: tr }) : t('Kein Bassmanagement: Bass bleibt in L/C/R, LFE leer')}">${tr ? `${tr} Hz` : t('aus')}</button>`).join('')}
          </div></div>
        <div class="rk-verfahren"><span>${t('LFE-Pegel')}</span>
          <div class="rk-seg" role="group" aria-label="${t('LFE-Pegel')}" data-lfe>
            <button type="button" data-l="-10" aria-pressed="${lw.lfe === -10}" title="${t('Der Receiver hebt den LFE um 10 dB an – so kommt der Bass mit dem Originalpegel aus dem Subwoofer')}">−10 dB</button>
            <button type="button" data-l="0" aria-pressed="${lw.lfe === 0}" title="${t('Ohne Absenkung (wenn das Gerät den LFE nicht anhebt)')}">0 dB</button>
          </div></div>` : ''}
        </details>
      </div>
      <div class="rk-fuss"><small>${t('Doppelklick auf einen Regler setzt ihn zurück.')}</small>
        ${leiste.app?.ich?.app?.downloads && player.track ? `<button type="button" class="rk-knopf" data-rk-export title="${t('Den laufenden Titel mit allen Presets als 5.1-WAV rendern (zum Probehören in der DAW)')}">5.1-WAV …</button>` : ''}
        <button type="button" class="rk-knopf" data-rk-reset>${t('Zurücksetzen')}</button></div>`;
    if (el.childElementCount) morph(el, html); else el.innerHTML = html;
    detailsAnimieren(el);
    verbinden();
    cancelAnimationFrame(pegelRaf);
    if (el.querySelector('[data-pegel]')) pegelRaf = requestAnimationFrame(pegelLauf);
    reglerFarben();
    irLaden();
    positionieren();
  };

  const reglerFarben = () => {
    el.querySelectorAll('input[data-fein]').forEach((r) => {
      const w = Number(r.value);
      const mitte = r.classList.contains('mitte');
      r.style.setProperty('--von', (mitte ? Math.min(50, w) : 0) + '%');
      r.style.setProperty('--bis', (mitte ? Math.max(50, w) : w) + '%');
    });
  };

  /** Optionen der Raum-Auswahl (Impulsantworten sind nach dem ersten Laden da) */
  const irOptionen = (k) => {
    const gruppen = {};
    for (const x of irs || []) (gruppen[x.art_name || 'Sonstige'] ||= []).push(x);
    const auto = irs?.length ? irWaehlen(irs, k, 'auto') : null;
    const w = player.einst.raumklang_ir;
    const gueltig = w === 'auto' || w === 'synth' || (irs || []).some((x) => x.id === w);
    const gewaehlt = gueltig ? w : 'auto';
    const opt = (wert, text) => `<option value="${h(wert)}"${gewaehlt === wert ? ' selected' : ''}>${h(text)}</option>`;
    const beschr = (x) => `${x.quelle === 'eigene' ? '★ ' : ''}${x.name}${x.klasse ? ` · ${x.klasse}` : ''}${x.nachhall_s ? ` · ${zahl(x.nachhall_s)} s` : ''}`;
    const reihenfolge = Object.values(IR_ARTEN);
    return opt('auto', auto ? t('Automatisch – {name}', { name: auto.name }) : t('Automatisch – eingebauter Raum')) + opt('synth', t('Eingebaut (synthetisch)'))
      + Object.entries(gruppen).sort((x, y) => reihenfolge.indexOf(x[0]) - reihenfolge.indexOf(y[0]))
        .map(([g, xs]) => `<optgroup label="${h(IR_ART_ANZEIGE[g] ?? g)}">${xs.sort((p, q) => (p.nachhall_s || 0) - (q.nachhall_s || 0)).map((x) => opt(x.id, beschr(x))).join('')}</optgroup>`).join('');
  };
  const irLaden = async () => {
    if (irs) return;
    irs = await irListe();
    if (el.isConnected) zeichnen();
  };

  const verbinden = () => {
    bind(el.querySelector('[data-rk-schalter]'), 'click', async () => { await player.raumklangUmschalten(); zeichnen(); aktualisiert(); });
    el.querySelectorAll('[data-preset]').forEach((b) => bind(b, 'click', async () => {
      const gleich = player.einst.raumklang === b.dataset.preset;
      await player.raumklangSetzen(gleich ? 'aus' : b.dataset.preset);
      zeichnen(); aktualisiert();
    }));
    bind(el.querySelector('[data-rk-ir-datei]'), 'change', async (e) => {
      const f = e.target.files[0];
      const meld = el.querySelector('[data-rk-ir-meldung]');
      if (!f) return;
      const fd = new FormData();
      fd.append('ir', f);
      const art = el.querySelector('[data-rk-ir-art]').value;
      if (art) fd.append('art', art);
      meld.textContent = t('Lädt hoch …');
      try {
        const r = await api.post('/raumklang/ir', fd);
        irs = await irListe(true);
        await player.raumklangIrSetzen(r.id);
        erweitertOffen = true;
        zeichnen();
      } catch (err) { meld.textContent = err.message || t('Hochladen fehlgeschlagen'); }
    });
    bind(el.querySelector('[data-rk-ir]'), 'change', async (e) => { await player.raumklangIrSetzen(e.target.value); zeichnen(); });
    bind(el.querySelector('[data-erweitert]'), 'toggle', (e) => { erweitertOffen = e.target.open; });
    bind(el.querySelector('[data-staerke]'), 'click', (e) => {
      const b = e.target.closest('button[data-s]');
      if (!b) return;
      player.raumklangFeinSetzen(staerkeWerte(b.dataset.s));
      zeichnen();
    });
    el.querySelectorAll('input[data-fein]').forEach((r) => {
      const setzen = () => {
        el.querySelector(`[data-wert="${r.dataset.fein}"]`).textContent = feinText(r.dataset.fein, r.value);
        reglerFarben();
        player.raumklangFeinSetzen({ [r.dataset.fein]: Number(r.value) });
      };
      bind(r, 'input', setzen);
      bind(r, 'dblclick', () => { r.value = FEIN_STANDARD[r.dataset.fein]; setzen(); });
    });
    bind(el.querySelector('[data-trennung]'), 'click', (e) => {
      const b = e.target.closest('button[data-t]');
      if (!b) return;
      player.raumklangFeinSetzen({ trennung: Number(b.dataset.t) });
      zeichnen();
    });
    el.querySelectorAll('[data-ab]').forEach((b) => bind(b, 'click', async () => {
      const i = player.ausgangBassInfo;
      if (!i?.an) return;
      const hz = Math.max(50, Math.min(200, i.hz + Number(b.dataset.ab)));
      el.querySelector('[data-ab-w]').textContent = `${hz} Hz`;
      el.querySelector('[data-ab="-10"]').disabled = hz <= 50;
      el.querySelector('[data-ab="10"]').disabled = hz >= 200;
      player.ausgangBassInfo = { ...i, hz };
      await player.ausgangBassAendern({ trenn: hz });
    }));
    bind(el.querySelector('[data-lfe]'), 'click', (e) => {
      const b = e.target.closest('button[data-l]');
      if (!b) return;
      player.raumklangFeinSetzen({ lfe: Number(b.dataset.l) });
      el.querySelectorAll('[data-lfe] button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    });
    bind(el.querySelector('[data-abhoeren]'), 'click', (e) => {
      const b = e.target.closest('button[data-m]');
      if (!b) return;
      el.querySelectorAll('[data-abhoeren] button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      player.raumklang.abhoeren(b.dataset.m);
    });
    bind(el.querySelector('[data-solo]'), 'click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      const solo = new Set(player.raumklang.solo || []);
      if (b.hasAttribute('data-solo-alle')) solo.clear();
      else {
        const c = Number(b.dataset.c);
        if (e.altKey) { solo.clear(); solo.add(c); }          // Alt-Klick: nur dieser
        else if (solo.has(c)) solo.delete(c); else solo.add(c);
      }
      player.raumklang.soloSetzen(solo);
      el.querySelectorAll('[data-solo] button[data-c]').forEach((x) => x.setAttribute('aria-pressed', String(solo.has(Number(x.dataset.c)))));
      el.querySelector('[data-solo-alle]').disabled = !solo.size;
      el.querySelector('[data-solo]').classList.toggle('aktiv', solo.size > 0);
    });
    bind(el.querySelector('[data-rk-export]'), 'click', () => { schliessen(); player.raumklangExport(); });
    bind(el.querySelector('[data-rk-reset]'), 'click', () => {
      player.raumklangFeinSetzen({ ...FEIN_STANDARD });
      player.raumklang.abhoeren('alles');
      player.raumklang.soloSetzen([]);
      zeichnen();
    });
  };

  /** Über dem Anker, rechtsbündig zum Knopf */
  const positionieren = () => {
    const r = anker.getBoundingClientRect();
    const b = el.offsetWidth || 460;
    const links = Math.max(12, Math.min(window.innerWidth - b - 12, r.right - b + 24));
    el.style.left = `${links}px`;
    if (r.top < 320 && window.innerHeight - r.bottom > r.top) {
      // oben zu wenig Platz (z. B. Karte in „Läuft gerade“): unter dem Anker öffnen
      el.style.bottom = '';
      el.style.top = `${Math.round(r.bottom + 10)}px`;
      el.style.maxHeight = `${Math.max(240, window.innerHeight - r.bottom - 24)}px`;
    } else {
      el.style.top = '';
      el.style.bottom = `${Math.round(window.innerHeight - r.top + 14)}px`;
      el.style.maxHeight = `${Math.max(240, r.top - 28)}px`;
    }
  };

  const ausserhalb = (e) => { if (!el.contains(e.target) && !anker.contains(e.target) && !e.target.closest('.auswahl-liste')) schliessen(); };
  const taste = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); schliessen(); anker.focus?.({ preventScroll: true }); } };
  const groesse = () => positionieren();
  const schliessen = () => {
    document.removeEventListener('pointerdown', ausserhalb, true);
    document.removeEventListener('keydown', taste, true);
    window.removeEventListener('resize', groesse);
    player.removeEventListener?.('zustand', nachziehen);
    anker.setAttribute('aria-expanded', 'false');
    if (offen && offen.el === el) offen = null;
    // Abhören gilt nur, solange das Menü offen ist – sonst bleibt womöglich vorne alles stumm
    if (player.raumklang.abhoerModus && player.raumklang.abhoerModus !== 'alles') player.raumklang.abhoeren('alles');
    if (player.raumklang.solo?.size) player.raumklang.soloSetzen([]);
    cancelAnimationFrame(pegelRaf);
    // Sanft ausblenden, dann entfernen
    el.classList.add('raus');
    let weg = false;
    const ende = () => { if (!weg) { weg = true; el.remove(); } };
    el.addEventListener('animationend', (ev) => { if (ev.target === el) ende(); });
    setTimeout(ende, 260);
  };
  // Taste U und andere Änderungen von außen: Menü nachführen (nicht beim Ziehen eines Reglers)
  const nachziehen = () => { if (!el.contains(document.activeElement) || document.activeElement.tagName !== 'INPUT') zeichnen(); };
  player.addEventListener?.('zustand', nachziehen);

  document.addEventListener('pointerdown', ausserhalb, true);
  document.addEventListener('keydown', taste, true);
  window.addEventListener('resize', groesse);
  anker.setAttribute('aria-expanded', 'true');
  offen = { el, schliessen, anker };
  zeichnen();
  el.querySelector('button:not([disabled])')?.focus({ preventScroll: true });
}
