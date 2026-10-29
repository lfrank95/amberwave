// Geräte im Heimnetz (DLNA): Klang-Profil für ein Gerät (aus den eigenen Effekt-Einstellungen gebaut, gerechnet vom
// Server) und die Verwaltung unter Einstellungen › Geräte im Heimnetz (Suchen, per IP hinzufügen, Verhalten je Gerät).
import { api } from './api.js';
import { h, icon, toast, bestaetigen } from './ui.js';
import { t, tn, zahl } from './i18n.js';
import { waermeWirksam, waermeParameter, waermeNormal, waermeKurzText, WAERME_BEZUG_LUFS } from './waerme.js';
import { trafoWirksam, trafoParameter, trafoNormal, trafoKurzText, TRAFO_BEZUG_LUFS } from './trafo.js';
import { bandWirksam, bandParameter, bandNormal, bandKurzText, BAND_BEZUG_LUFS } from './band.js';
import { eqWirksam, eqKoeffizienten, eqGainDb, eqKurzText } from './eq.js';
import { reiheNormal, raumBefehle, RAUMKLANG_PRESETS } from './raumklang.js';

const RATEN = [44100, 48000, 88200, 96000, 176400, 192000];
const NAME = { glow: 'Glow', iron: 'Iron', silk: 'Silk', eq: 'EQ' };
const KEINE_STUFE = t('keine Stufe');
const SPACE_RATEN = [44100, 48000];   // Space rechnet der Server in der Familie der Quelle mit 44,1 bzw. 48 kHz

/**
 * Kette wie für die Engine aus Effekt-Einstellungen (einst.waerme/trafo/band/eq/reihe). aus = {glow: false, …} lässt
 * Stufen weg. Die Ansteuerung nach Lautheit (bezug) rechnet der Server je Titel dazu.
 */
export function klangBefehle(einst, aus = {}) {
  const reihe = reiheNormal(einst.reihe).filter((a) => !/^vst\d$/.test(a));
  const an = {
    glow: waermeWirksam(einst.waerme || {}) && aus.glow !== false,
    iron: trafoWirksam(einst.trafo || {}) && aus.iron !== false,
    silk: bandWirksam(einst.band || {}) && aus.silk !== false,
    eq: eqWirksam(einst.eq || {}) && aus.eq !== false,
  };
  const befehle = [], bezug = {};
  for (const a of reihe) {
    if (!an[a]) continue;
    if (a === 'eq') {
      const o = { c: 'fx', art: 'eq' };
      for (const sr of RATEN) {
        o[`w.k@${sr}`] = Array.from(eqKoeffizienten(einst.eq, sr));
        o[`w.gain@${sr}`] = Math.pow(10, eqGainDb(einst.eq, sr) / 20);
      }
      befehle.push(o);
      continue;
    }
    const p = a === 'glow' ? waermeParameter(einst.waerme, 0)
      : a === 'iron' ? trafoParameter(einst.trafo, 0, an.glow && reihe.indexOf('glow') < reihe.indexOf('iron'))
        : bandParameter(einst.band, 0);
    const o = { c: 'fx', art: a };
    for (const [k, v] of Object.entries(p)) if (['number', 'string', 'boolean'].includes(typeof v)) o[`w.${k}`] = v;
    befehle.push(o);
    const n = a === 'glow' ? waermeNormal(einst.waerme) : a === 'iron' ? trafoNormal(einst.trafo) : bandNormal(einst.band);
    if (n.bezug && n.auto) bezug[a] = a === 'glow' ? WAERME_BEZUG_LUFS : a === 'iron' ? TRAFO_BEZUG_LUFS : BAND_BEZUG_LUFS;
  }
  befehle.push({ c: 'kette', reihe: reihe.join(','), stufen: reihe.filter((a) => an[a]).join(',') });
  const kurz = { glow: waermeKurzText(einst.waerme), iron: trafoKurzText(einst.trafo), silk: bandKurzText(einst.band), eq: eqKurzText(einst.eq) };
  return { befehle, bezug, an, beschreibung: reihe.filter((a) => an[a]).map((a) => NAME[a]).join(' · ') || KEINE_STUFE, kurz };
}

/* ---------- Klang-Blatt für ein Gerät im Heimnetz (nur Admins) ---------- */
export function klangBlattOeffnen(app, z) {
  const hid = z?.geraet?.hn_id;
  if (!hid) return;
  document.querySelector('.hn-blatt')?.remove();
  document.querySelector('.hn-hg')?.remove();
  const einst = app.fern?.p?.einst || app.player.einst;
  let weg = z.klang?.weg === 'effekte' ? 'effekte' : 'original';
  const aus = {};
  let lautheit = einst.lautheit !== 'aus';
  // Space: eigene Wahl je Gerät (Preset aus dem eigenen Space, falls dort keins an ist das zuletzt benutzte)
  const sp = z.klang?.space || {};
  const eigenesPresetRoh = einst.raumklang && einst.raumklang !== 'aus' ? einst.raumklang : (einst.raumklang_letzt || 'dezent');
  const eigenesPreset = RAUMKLANG_PRESETS[eigenesPresetRoh] ? eigenesPresetRoh : 'dezent';
  const space = { an: sp.an ?? (einst.raumklang && einst.raumklang !== 'aus'), preset: RAUMKLANG_PRESETS[sp.preset] ? sp.preset : eigenesPreset, geht: sp.geht ?? null, grund: sp.grund || '' };
  let bereitet = false;
  const hg = document.createElement('div');
  hg.className = 'fern-hg hn-hg';
  const el = document.createElement('div');
  el.className = `fern-wahl hn-blatt${matchMedia('(max-width: 700px)').matches ? ' blatt' : ''}`;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', t('Klang am Gerät'));
  let offen = true;
  const zu = () => { offen = false; el.classList.add('raus'); hg.classList.add('raus'); setTimeout(() => { el.remove(); hg.remove(); }, 160); };
  hg.addEventListener('click', zu);
  const spaceHtml = () => {
    const nein = space.geht === false;
    const an = space.an && !nein;
    const p = RAUMKLANG_PRESETS[space.preset];
    return `<div class="hn-space${an ? ' an' : ''}"${weg === 'effekte' ? '' : ' inert'}>
      <button type="button" class="hn-stufe hn-space-knopf${an ? ' an' : ''}" data-space ${nein ? `disabled title="${h(t('Das Gerät hat 5.1 abgelehnt') + (space.grund ? `: ${space.grund}` : ''))}"` : ''}>
        <b>Space</b><small>${nein ? t('geht an diesem Gerät nicht') : an ? `${h(p.name)} · 5.1` : t('aus – Stereo')}</small></button>
      ${nein
    ? `<p class="hn-space-text">${t('Das Gerät hat den 5.1-Stream abgelehnt')}${space.grund ? ` (${h(space.grund)})` : ''}. <button type="button" class="link-knopf" data-space-neu>${t('Erneut versuchen')}</button></p>`
    : an ? `<div class="hn-modi">${Object.entries(RAUMKLANG_PRESETS).map(([key, x]) => `<button type="button" class="pille${key === space.preset ? ' an' : ''}" data-space-preset="${key}" title="${h(x.info)}">${h(x.name)}</button>`).join('')}</div>
        <p class="hn-space-text">${t('Der Server rechnet Stereo zu 5.1 und schickt 6 Kanäle.')} ${space.geht === true ? t('Das Gerät spielt das.') : t('Kann das Gerät es nicht, merkt sich Amberwave das und spielt in Stereo.')}</p>`
      : ''}
    </div>`;
  };
  const zeichnen = () => {
    if (!offen) return;
    const k = klangBefehle(einst, aus);
    const moeglich = { glow: waermeWirksam(einst.waerme || {}), iron: trafoWirksam(einst.trafo || {}), silk: bandWirksam(einst.band || {}), eq: eqWirksam(einst.eq || {}) };
    const modi = z.geraet?.tonmodi || {};
    el.innerHTML = `${el.classList.contains('blatt') ? '<div class="fw-griff"></div>' : ''}
      <h4><span>${t('Klang am Gerät')}</span><span>${h(app.fern?.zielName || '')}</span></h4>
      <div class="hn-wege">
        <button type="button" class="hn-weg${weg === 'original' ? ' an' : ''}" data-weg="original"><b>${t('Original')}</b><span>${t('Das Gerät holt die Datei selbst – bitgenau, Lautstärke regelt das Gerät')}</span></button>
        <button type="button" class="hn-weg${weg === 'effekte' ? ' an' : ''}" data-weg="effekte"><b>${t('Mit Effekten')}</b><span>${t('Der Server rechnet deine Effekte und schickt 24 Bit')}</span></button>
      </div>
      <div class="hn-kette"${weg === 'effekte' ? '' : ' inert'}>
        ${['glow', 'iron', 'silk', 'eq'].map((a) => `<button type="button" class="hn-stufe${k.an[a] ? ' an' : ''}" data-stufe="${a}" ${moeglich[a] ? '' : `disabled title="${h(t('Bei dir aus – im Effektrack einschalten'))}"`}><b>${NAME[a]}</b><small>${moeglich[a] ? h(k.kurz[a]) : t('aus')}</small></button>`).join('')}
      </div>
      ${spaceHtml()}
      <label class="hn-zeile"${weg === 'effekte' ? '' : ' inert'}><input type="checkbox" data-lautheit ${lautheit ? 'checked' : ''}> ${t('Lautstärke angleichen ({ziel} LUFS)', { ziel: String(einst.lautheit_ziel ?? -16).replace('-', '−') })}</label>
      <p class="fw-hinweis">${weg === 'effekte' ? t('Es gelten deine Einstellungen aus dem Effektrack. Zu hören nach dem Puffer des Geräts, etwa 2–4 s.') : t('Bitgenau, solange das Gerät das Format kann. Sonst rechnet der Server es passend um.')}</p>
      ${Object.keys(modi).length ? `<h4 style="margin-top:6px"><span>${t('Tonmodus des Geräts')}</span></h4><div class="hn-modi">${Object.entries(modi).map(([key, n]) => `<button type="button" class="pille" data-modus="${key}">${h(n)}</button>`).join('')}</div>` : ''}
      <div class="hn-knoepfe"><button type="button" class="btn btn-zweit btn-klein" data-zu>${t('Abbrechen')}</button><button type="button" class="btn btn-klein" data-speichern ${bereitet ? 'disabled' : ''}>${bereitet ? (space.an && weg === 'effekte' && space.geht !== false ? t('Space wird vorbereitet …') : t('Wird übernommen …')) : t('Übernehmen')}</button></div>`;
    el.querySelector('[data-space]')?.addEventListener('click', () => { space.an = !space.an; zeichnen(); });
    el.querySelectorAll('[data-space-preset]').forEach((b) => b.addEventListener('click', () => { space.preset = b.dataset.spacePreset; space.an = true; zeichnen(); }));
    el.querySelector('[data-space-neu]')?.addEventListener('click', async () => {
      try {
        await api.post(`/heimnetz/geraete/${hid}/space`);
        space.geht = null; space.grund = ''; space.an = true;
        toast(t('Space wird beim nächsten Titel neu ausprobiert'), 'gut');
        zeichnen();
      } catch (e) { toast(e.message, 'fehler'); }
    });
    el.querySelectorAll('[data-weg]').forEach((b) => b.addEventListener('click', () => { weg = b.dataset.weg; zeichnen(); }));
    el.querySelectorAll('[data-stufe]').forEach((b) => b.addEventListener('click', () => { aus[b.dataset.stufe] = aus[b.dataset.stufe] === false; zeichnen(); }));
    el.querySelector('[data-lautheit]')?.addEventListener('change', (e) => { lautheit = e.target.checked; });
    el.querySelector('[data-zu]').addEventListener('click', zu);
    el.querySelectorAll('[data-modus]').forEach((b) => b.addEventListener('click', async () => {
      try { await api.post(`/heimnetz/geraete/${hid}/tonmodus`, { modus: b.dataset.modus }); toast(t('Tonmodus: {modus}', { modus: b.textContent }), 'gut'); } catch (e) { toast(e.message, 'fehler'); }
    }));
    el.querySelector('[data-speichern]').addEventListener('click', async () => {
      if (bereitet) return;   // kein Doppelklick
      const k2 = klangBefehle(einst, aus);
      const daten = { weg, befehle: k2.befehle, bezug: k2.bezug, beschreibung: k2.beschreibung, lautheit, ziel: Number(einst.lautheit_ziel) || -16 };
      const mitSpace = weg === 'effekte' && space.an && space.geht !== false;
      try {
        bereitet = true; zeichnen();
        if (mitSpace) {
          // Space für den Server: Graph und Impulsantworten je Abtastrate (44,1 / 48 kHz) bauen und hochladen
          const raten = {};
          for (const rate of SPACE_RATEN) {
            const text = await raumBefehle({ preset: space.preset, fein: einst.raumklang_fein, irWahl: einst.raumklang_ir || 'auto', kanaele: 6, rate });
            if (!text) throw new Error(t('Space ließ sich nicht vorbereiten'));
            const fd = new FormData();
            fd.append('kette', new Blob([text], { type: 'application/x-ndjson' }), `space-${rate}.jsonl`);
            raten[rate] = (await api.post('/heimnetz/raum', fd)).hash;
          }
          daten.space = { an: true, preset: space.preset, name: RAUMKLANG_PRESETS[space.preset].name, kanaele: 6, raten };
        } else if (space.geht !== false) {
          daten.space = { an: false };
        }
        await api.post(`/heimnetz/geraete/${hid}/klang`, daten);
        toast(weg === 'effekte' ? t('Effekte am Gerät: {was}', { was: [k2.beschreibung, mitSpace ? `Space ${RAUMKLANG_PRESETS[space.preset].name}` : ''].filter((x) => x && x !== KEINE_STUFE).join(' · ') || KEINE_STUFE }) : t('Original – bitgenau'), 'gut');
        zu();
      } catch (e) { bereitet = false; zeichnen(); toast(e.message, 'fehler'); }
    });
  };
  zeichnen();
  document.body.append(hg, el);
  if (!el.classList.contains('blatt')) {
    el.style.width = 'min(420px, calc(100vw - 24px))';
    el.style.left = '50%'; el.style.top = '50%'; el.style.transform = 'translate(-50%, -50%)'; el.style.maxHeight = '86vh';
  }
}

/* ---------- Einstellungen › Geräte im Heimnetz ---------- */
const STEUERUNG = { denon: 'Denon/Marantz', yamaha: 'Yamaha MusicCast', onkyo: 'Onkyo/Pioneer (eISCP)', cast: 'Google Cast', '': t('nur DLNA') };
const istCast = (g) => g.art === 'cast';
const QUELLE = { env: t('aus der .env (HEIMNETZ_URL)'), einstellung: t('von Hand eingetragen'), gelernt: t('erkannt, als ein Admin die App im Heimnetz geöffnet hat'), direkt_ip: t('aus dem Direktzugang (IP)'), direkt_host: t('aus dem Direktzugang (Name)'), unbekannt: t('unbekannt') };

export async function heimnetzZeichnen(app, inhalt, signal) {
  inhalt.innerHTML = '<div class="einst-karte einst-frei"><div class="lade"></div></div>';
  let d;
  try { d = await api.get('/heimnetz', { signal }); } catch (e) { if (e.name !== 'AbortError') inhalt.innerHTML = `<div class="einst-karte"><p>${h(e.message)}</p></div>`; return; }
  let funde = null, sucht = false;
  const offen = new Set();
  const zahlDe = (v) => zahl(v).replace('-', '−');
  const zustandText = (g) => {
    const z = g.zustand || {};
    if (z.erreichbar === false) return `<span class="hn-warn">${t('nicht erreichbar')}</span>`;
    if (istCast(g)) return `${z.eingang && z.eingang !== 'Amberwave' ? t('läuft: {was}', { was: h(z.eingang) }) : t('bereit')}${g.vol_text ? ` · ${h(g.vol_text)}` : ''}`;
    if (!g.steuerung) return t('bereit');
    return `${z.an ? t('an') : t('Standby')}${z.an && z.eingang ? ` · ${h(z.eingang)}` : ''}${g.vol_text ? ` · ${h(g.vol_text)}` : ''}`;
  };
  const spaceText = (g) => {
    const sp = g.klang?.space || {};
    if (sp.geht === false) return t('nein – abgelehnt') + (sp.grund ? ` (${sp.grund})` : '');
    if (sp.geht === true) return t('✓ spielt 5.1 vom Server');
    return t('noch nicht ausprobiert');
  };
  const kannText = (g) => {
    const f = g.faehig || {};
    if (istCast(g)) {
      const fmt = f.flac ? t('FLAC bis {bits}/{rate}, MP3', { bits: f.max_bits || 24, rate: Math.round((f.max_rate || 96000) / 1000) }) : t('WAV bis {bits}/{rate} (der Server rechnet um – das Gerät hat FLAC abgelehnt)', { bits: f.max_bits || 24, rate: Math.round((f.max_rate || 96000) / 1000) });
      return [[t('Abspielen (Google Cast)'), '✓'], [t('Formate'), f.umrechnen ? `${fmt} · ${t('alles umgerechnet')}` : fmt], [t('Lückenlos'), f.setnext ? t('✓ Warteschlange des Geräts') : t('nein – nächster Titel am Ende')],
        [t('Lautstärke'), t('✓ am Gerät')], ['Space (5.1)', spaceText(g)], ...(f.gruppe ? [[t('Gruppe'), t('✓ spielt auf allen Lautsprechern der Gruppe')]] : [])];
    }
    const fmt = f.flac ? t('FLAC bis {bits}/{rate}', { bits: f.max_bits || 24, rate: Math.round((f.max_rate || 192000) / 1000) }) : f.wav ? t('WAV bis {bits}/{rate} (FLAC rechnet der Server um)', { bits: f.max_bits || 16, rate: Math.round((f.max_rate || 48000) / 1000) }) : t('unbekannt');
    return [[t('Abspielen (DLNA)'), '✓'], [t('Formate'), fmt], [t('Lückenlos (SetNext)'), f.setnext ? '✓' : t('nein – nächster Titel am Ende')], [t('Mehrkanal'), f.mehrkanal ? '✓' : t('nein')], ['Space (5.1)', spaceText(g)],
      [t('Ein, Eingang, Lautstärke'), g.steuerung ? `✓ ${STEUERUNG[g.steuerung]}` : t('nur Lautstärke (DLNA)')]];
  };
  const optionen = (liste, wert) => liste.map(([v, tx]) => `<option value="${h(v)}"${String(v) === String(wert ?? '') ? ' selected' : ''}>${h(tx)}</option>`).join('');
  const geraetHtml = (g) => {
    const e = g.einst || {};
    const db = g.vol_bereich?.einheit === 'dB';
    const maxListe = db ? [['', t('Standard (−10 dB)')], ...[-25, -20, -15, -10, -5, 0].map((v) => [v, `${zahlDe(v)} dB`])]
      : istCast(g) ? [['', t('keine (100 %)')], ...[40, 50, 60, 70, 80, 90].map((v) => [v, `${v} %`])]
        : [['', t('Standard (60)')], ...[30, 40, 50, 60, 70, 80, 100].map((v) => [v, String(v)])];
    const startListe = db ? [['', t('wie zuletzt')], ...[-50, -45, -40, -35, -30, -25].map((v) => [v, `${zahlDe(v)} dB`])] : [['', t('wie zuletzt')], ...[15, 20, 25, 30, 35, 40].map((v) => [v, String(v)])];
    const auf = offen.has(g.id);
    return `<div class="hn-g${auf ? ' auf' : ''}" data-g="${g.id}">
      <button type="button" class="hn-g-kopf" data-auf="${g.id}" aria-expanded="${auf}">
        <span class="einst-mini">${icon(g.faehig?.tv ? 'computer' : istCast(g) ? 'radio' : 'anlage', 18)}</span>
        <span class="hn-g-tx"><b>${h(g.name)}</b><small>${h(istCast(g) ? (g.modell || g.hersteller) : `${g.hersteller} ${g.modell}`.trim())} · ${h(g.ip)} · ${zustandText(g)}</small></span>
        <span class="einst-chip">${h(STEUERUNG[g.steuerung] || 'nur DLNA')}</span>${g.aktiv ? '' : `<span class="einst-chip">${t('ausgeblendet')}</span>`}
        ${icon('runter', 18)}
      </button>
      ${auf ? `<div class="hn-g-rumpf">
        <div class="hn-spalte">
          <label class="hn-feld"><span>${t('Name')}</span><input type="text" class="einst-feld" data-name value="${h(g.name)}" maxlength="80"></label>
          <label class="hn-feld hn-feld-sw"><span>${t('In „Wiedergabe auf“ anbieten')}</span><button type="button" class="schalter" role="switch" aria-checked="${g.aktiv}" data-aktiv></button></label>
          ${g.steuerung && !istCast(g) ? `<label class="hn-feld hn-feld-sw"><span>${t('Einschalten, wenn im Standby')}</span><button type="button" class="schalter" role="switch" aria-checked="${e.einschalten !== false}" data-e="einschalten"></button></label>
          <label class="hn-feld hn-feld-sw"><span>${t('Eingang auf Netzwerk/Server stellen')}</span><button type="button" class="schalter" role="switch" aria-checked="${e.eingang !== false}" data-e="eingang"></button></label>
          <label class="hn-feld"><span>${t('Tonmodus beim Abspielen')}</span><select class="einst-feld" data-e="tonmodus">${optionen([['', t('nicht ändern')], ...Object.entries(g.tonmodi || {})], e.tonmodus)}</select></label>
          <label class="hn-feld"><span>${t('Nach Stille ausschalten')}</span><select class="einst-feld" data-e="aus_minuten">${optionen([[0, t('nie')], [10, t('nach 10 Min.')], [30, t('nach 30 Min.')], [60, t('nach 1 Std.')]], e.aus_minuten || 0)}</select></label>
          <label class="hn-feld"><span>${t('Lautstärke beim Einschalten')}</span><select class="einst-feld" data-e="start_vol">${optionen(startListe, e.start_vol)}</select></label>` : ''}
          <label class="hn-feld"><span>${t('Höchste Lautstärke (Schutz)')}</span><select class="einst-feld" data-e="max_vol">${optionen(maxListe, e.max_vol)}</select></label>
          <label class="hn-feld"><span>${t('Höchstes Format')}</span><select class="einst-feld" data-e="format">${optionen([['', t('automatisch ({rate} kHz/{bits} Bit)', { rate: Math.round((g.faehig?.max_rate || 192000) / 1000), bits: g.faehig?.max_bits || 24 })], ...(istCast(g) ? [] : [['192000/24', '192 kHz / 24 Bit']]), ['96000/24', '96 kHz / 24 Bit'], ['48000/24', '48 kHz / 24 Bit'], ['48000/16', '48 kHz / 16 Bit'], ['44100/16', t('44,1 kHz / 16 Bit')]], e.max_rate ? `${e.max_rate}/${e.max_bits || 24}` : '')}</select></label>
        </div>
        <div class="hn-spalte">
          <div class="hn-kann">${kannText(g).map(([k, v]) => `<div><span>${k}</span><b>${h(v)}</b></div>`).join('')}</div>
          <div class="hn-kann"><div><span>${t('Klang')}</span><b>${g.klang?.weg === 'effekte' ? `${t('Effekte')} · ${h(g.klang.beschreibung || '')}${g.klang.space?.an ? ` · Space ${h(g.klang.space.name || '')}${g.klang.space.geht === false ? ` ${t('(ruht – Gerät kann kein 5.1)')}` : ''}` : ''}` : t('Original')}</b></div></div>
          <div class="hn-prot">${(g.protokoll || []).slice(0, 14).map((z) => `<div>${h(z)}</div>`).join('') || `<div>${t('noch nichts')}</div>`}</div>
          <div class="hn-knoepfe"><button type="button" class="btn btn-zweit btn-klein" data-pruefen>${t('Neu prüfen')}</button><button type="button" class="btn btn-zweit btn-klein btn-rot-text" data-weg>${t('Entfernen')}</button></div>
        </div>
      </div>` : ''}
    </div>`;
  };
  const castKarte = () => {
    const c = d.cast;
    if (!c || (!c.geraete && !c.app_id)) return '';
    return `<div class="einst-karte">
      <h2><span>${t('Amberwave-Bildschirm für Google Cast')}</span>${c.app_id ? `<span class="einst-chip gut">${t('eingerichtet')}</span>` : `<span class="einst-chip">${t('Standard-Empfänger')}</span>`}</h2>
      <div class="einst-zeile"><div class="einst-text"><span class="einst-name">${t('Eigener Bildschirm auf Fernseher und Nest Hub')}</span>
        <p>${t('Statt des schlichten Standard-Empfängers von Google zeigt der Fernseher großes Cover, weich gezeichneten Hintergrund, Format und „Als Nächstes“. Dafür muss der Bildschirm einmal bei Google angemeldet werden.')} <a href="/cast/empfaenger.html?demo=1" target="_blank" rel="noopener">${t('Vorschau ansehen')}</a></p></div>
        <div class="einst-regler hn-basis">${c.quelle === 'env' ? `<code>${h(c.app_id)}</code>` : `<input type="text" class="einst-feld" data-cast-id placeholder="${h(t('App-ID, z. B. 1A2B3C4D'))}" maxlength="8" value="${h(c.app_id)}" style="width:170px;text-transform:uppercase"><button type="button" class="btn btn-zweit btn-klein" data-cast-ok>${t('Speichern')}</button>`}</div></div>
      <ol class="hn-schritte">
        <li>${t('In der <a href="https://cast.google.com/publish" target="_blank" rel="noopener">Google Cast SDK Developer Console</a> anmelden (einmalig 5 US-Dollar Gebühr).')}</li>
        <li>${t('„Add new application“ → „Custom Receiver“, Name „Amberwave“, als „Receiver Application URL“:')}<br><code class="hn-url">${h(c.empfaenger)}</code> <button type="button" class="btn btn-zweit btn-klein" data-cast-kopieren>${t('Kopieren')}</button>
          ${c.https ? '' : `<br><span class="hn-warn">${t('Diese Adresse ist kein HTTPS – Google verlangt HTTPS. Richte unter Zugang &amp; Netz den Direktzugang ein oder setze APP_URL mit https.')}</span>`}</li>
        <li>${t('Die angezeigte App-ID (8 Zeichen) oben eintragen.')}</li>
        <li>${t('„Publish“ – dann läuft der Bildschirm auf allen Cast-Geräten. Ohne Veröffentlichung nur auf Geräten, die dort mit Seriennummer als Testgerät eingetragen sind (15 Minuten warten, Gerät neu starten). Startet er nicht, nimmt Amberwave von selbst den Standard-Empfänger.')}</li>
      </ol>
    </div>`;
  };
  const zeichnen = () => {
    const b = d.basis || {};
    inhalt.innerHTML = `
      <div class="einst-karte">
        <h2><span>${t('Adresse des Servers im Heimnetz')}</span></h2>
        <div class="einst-zeile"><div class="einst-text"><span class="einst-name">${b.url ? h(b.url) : `<span class="hn-warn">${t('unbekannt')}</span>`}</span>
          <p>${t('Dort holen Receiver &amp; Co. die Musik.')} ${h(QUELLE[b.quelle] || '')}. ${t('Öffne Amberwave einmal im Heimnetz über die IP (z. B. http://192.168.1.10:9950), dann wird sie von selbst erkannt.')}</p></div>
          <div class="einst-regler hn-basis">${b.quelle === 'env' ? '' : `<input type="url" class="einst-feld" data-basis placeholder="http://192.168.1.10:9950" value="${b.quelle === 'einstellung' ? h(b.url) : ''}"><button type="button" class="btn btn-zweit btn-klein" data-basis-ok>${t('Speichern')}</button>`}</div></div>
        ${d.render ? '' : `<p class="einst-fuss hn-warn">${t('Der Effekt-Rechner (bin/aw-render) fehlt – „Mit Effekten“ spielt dann das Original.')}</p>`}
      </div>
      ${castKarte()}
      <div class="einst-karte">
        <h2><span>${t('Geräte')}</span><span class="hn-werkzeug">
          <button type="button" class="btn btn-zweit btn-klein" data-suchen ${sucht ? 'disabled' : ''}>${sucht ? `<span class="lade-klein"></span> ${t('sucht …')}` : `${icon('suche', 15)} ${t('Heimnetz durchsuchen')}`}</button>
          <input type="text" inputmode="decimal" class="einst-feld hn-ip" data-ip placeholder="${h(t('IP, z. B. 192.168.1.42'))}"><button type="button" class="btn btn-klein" data-ip-ok>${icon('plus', 15)} ${t('Hinzufügen')}</button></span></h2>
        ${funde ? `<div class="hn-funde">${funde.funde.length ? funde.funde.map((f) => `<div class="hn-fund"><span class="einst-mini">${icon(f.art === 'cast' ? 'radio' : 'anlage', 16)}</span><span class="hn-g-tx"><b>${h(f.name)}</b><small>${h(f.art === 'cast' ? (f.modell || f.hersteller) : `${f.hersteller} ${f.modell}`)} · ${h(f.ip)}</small></span>
          <span class="einst-chip">${f.art === 'cast' ? 'Google Cast' : 'DLNA'}</span>
          ${f.bekannt ? `<span class="einst-chip">${t('schon da')}</span>` : `<button type="button" class="btn btn-klein" data-dazu="${h(f.ort)}">${t('Hinzufügen')}</button>`}</div>`).join('') : `<p class="einst-fuss">${t('Nichts gefunden in {netze} ({n} Adressen). Ist das Gerät an und hat „Netzwerk-Standby“? Sonst die IP eintragen.', { netze: h(funde.netze.join(', ')), n: funde.adressen })}</p>`}</div>` : ''}
        <div class="hn-liste">${d.geraete.length ? d.geraete.map(geraetHtml).join('') : `<p class="einst-fuss">${t('Noch keine Geräte. „Heimnetz durchsuchen“ findet DLNA-Abspielgeräte (AV-Receiver von Denon, Marantz, Yamaha, Onkyo, Pioneer …, Fernseher, Streamer) und Google-Cast-Geräte (Android TV/Google TV, Nest Hub und Nest Audio, Chromecast, Lautsprecher mit Chromecast built-in, Cast-Gruppen).')}</p>`}</div>
        <p class="einst-fuss">${t('Gesucht wird gezielt in {netze} – das klappt auch, wenn Amberwave in einem eigenen Docker-Netz läuft. Andere Netze: HEIMNETZ_NETZE in der .env.', { netze: h((d.netze || []).join(', ') || t('keinem Netz')) })}</p>
      </div>`;
    verbinden();
  };
  const neuLaden = async () => { try { d = await api.get('/heimnetz'); } catch (e) { toast(e.message, 'fehler'); } if (inhalt.isConnected) zeichnen(); };
  const ersetzen = (g) => { d.geraete = d.geraete.map((x) => (x.id === g.id ? g : x)); };
  const verbinden = () => {
    const $ = (s) => inhalt.querySelector(s);
    $('[data-cast-ok]')?.addEventListener('click', async () => {
      try { const r = await api.put('/heimnetz/cast', { app_id: $('[data-cast-id]').value }); d.cast = r.cast; toast(r.cast.app_id ? t('Amberwave-Bildschirm eingerichtet – gilt ab dem nächsten Abspielen') : t('Standard-Empfänger'), 'gut'); zeichnen(); } catch (e) { toast(e.message, 'fehler'); }
    });
    $('[data-cast-kopieren]')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(d.cast.empfaenger); toast(t('Adresse kopiert'), 'gut'); } catch (e) { toast(d.cast.empfaenger); }
    });
    $('[data-basis-ok]')?.addEventListener('click', async () => {
      try { const r = await api.put('/heimnetz/basis', { url: $('[data-basis]').value }); d.basis = r.basis; toast(t('Gespeichert'), 'gut'); zeichnen(); } catch (e) { toast(e.message, 'fehler'); }
    });
    $('[data-suchen]').addEventListener('click', async () => {
      sucht = true; zeichnen();
      try { funde = await api.post('/heimnetz/suchen', {}); } catch (e) { toast(e.message, 'fehler'); }
      sucht = false; if (inhalt.isConnected) zeichnen();
    });
    const dazu = async (wo, knopf) => {
      if (knopf) { knopf.disabled = true; knopf.textContent = t('prüft …'); }
      try {
        const r = await api.post('/heimnetz/geraete', /^(https?|cast):/.test(wo) ? { ort: wo } : { ip: wo });
        toast(t('{name} hinzugefügt', { name: r.geraet.name }), 'gut');
        offen.add(r.geraet.id);
        if (funde) funde.funde = funde.funde.map((f) => (f.ip === r.geraet.ip ? { ...f, bekannt: r.geraet.id } : f));
        await neuLaden();
      } catch (e) { toast(e.message, 'fehler'); if (knopf) { knopf.disabled = false; knopf.textContent = t('Hinzufügen'); } }
    };
    $('[data-ip-ok]').addEventListener('click', (e) => { const v = $('[data-ip]').value.trim(); if (v) dazu(v, e.currentTarget); });
    $('[data-ip]').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('[data-ip-ok]').click(); } });
    inhalt.querySelectorAll('[data-dazu]').forEach((b) => b.addEventListener('click', () => dazu(b.dataset.dazu, b)));
    inhalt.querySelectorAll('[data-auf]').forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.dataset.auf);
      if (offen.has(id)) offen.delete(id); else offen.add(id);
      zeichnen();
    }));
    inhalt.querySelectorAll('.hn-g.auf').forEach((el) => {
      const id = Number(el.dataset.g);
      const speichern = async (body) => {
        try { const r = await api.put(`/heimnetz/geraete/${id}`, body); ersetzen(r.geraet); toast(t('Gespeichert'), 'gut'); } catch (e) { toast(e.message, 'fehler'); }
      };
      el.querySelector('[data-name]').addEventListener('change', (e) => speichern({ name: e.target.value }).then(zeichnen));
      el.querySelector('[data-aktiv]').addEventListener('click', (e) => { const an = e.currentTarget.getAttribute('aria-checked') !== 'true'; e.currentTarget.setAttribute('aria-checked', String(an)); speichern({ aktiv: an }); });
      el.querySelectorAll('button[data-e]').forEach((s) => s.addEventListener('click', () => {
        const an = s.getAttribute('aria-checked') !== 'true';
        s.setAttribute('aria-checked', String(an));
        speichern({ einst: { [s.dataset.e]: an } });
      }));
      el.querySelectorAll('select[data-e]').forEach((s) => s.addEventListener('change', () => {
        if (s.dataset.e === 'format') { const [r, bits] = s.value.split('/'); speichern({ einst: { max_rate: r ? Number(r) : null, max_bits: bits ? Number(bits) : null } }); return; }
        speichern({ einst: { [s.dataset.e]: s.value === '' ? null : Number.isNaN(Number(s.value)) ? s.value : Number(s.value) } });
      }));
      el.querySelector('[data-pruefen]').addEventListener('click', async (e) => {
        e.currentTarget.disabled = true; e.currentTarget.textContent = t('prüft …');
        try { const r = await api.post(`/heimnetz/geraete/${id}/pruefen`, {}); ersetzen(r.geraet); toast(r.ok ? t('Geprüft') : t('Gerät antwortet nicht'), r.ok ? 'gut' : 'fehler'); } catch (x) { toast(x.message, 'fehler'); }
        zeichnen();
      });
      el.querySelector('[data-weg]').addEventListener('click', async () => {
        const g = d.geraete.find((x) => x.id === id);
        if (!await bestaetigen(t('Gerät entfernen?'), t('„{name}“ verschwindet aus „Wiedergabe auf“. Später lässt es sich wieder hinzufügen.', { name: g?.name }), t('Entfernen'), true)) return;
        try { await api.del(`/heimnetz/geraete/${id}`); offen.delete(id); await neuLaden(); } catch (x) { toast(x.message, 'fehler'); }
      });
    });
  };
  zeichnen();
}
