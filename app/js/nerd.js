// Analyse („Nerd-Ansicht“, nur am PC): Lautheitskurve des laufenden Titels, Spektrum wie im DAW-Analyzer, Meter (Digital/VU),
// alle Messwerte und der Signalweg im Detail.
// Klappt über der Player-Leiste auf (Knopf oder Taste N).
import { api } from './api.js';
import { t, locale, sprache } from './i18n.js';
import { nativ, ausgabeWeg, istAsio, anlaufText } from './nativ.js';
import { h, icon, groesse } from './ui.js';
import { eqWirksam, eqKurzText } from './eq.js';
import { netzweg } from './netzweg.js';
import { QUALITAETEN } from './player.js';
import { RAUMKLANG_PRESETS } from './raumklang.js';
import { Meter, VU_REFERENZEN } from './meter.js';
import { vstRack } from './vstrack.js';

const MERKEN = 'aw_nerd_offen';
const ANSICHT = 'aw_analyse';
const NOTEN = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', sprache === 'en' ? 'B' : 'H'];
/** Frequenz → Note mit Cent-Abweichung (A4 = 440 Hz) */
function note(f) {
  const n = 12 * Math.log2(f / 440) + 57;
  const r = Math.round(n);
  const cent = Math.round((n - r) * 100);
  return `${NOTEN[((r % 12) + 12) % 12]}${Math.floor(r / 12)}${cent ? ` ${cent > 0 ? '+' : '−'}${Math.abs(cent)} ct` : ''}`;
}
const hzText = (f) => (f >= 1000 ? `${k(f / 1000, f >= 10000 ? 1 : 2)} kHz` : `${k(f, f < 100 ? 1 : 0)} Hz`);
const k = (x, n = 1) => (x == null || !isFinite(x) ? '–' : x.toLocaleString(locale, { minimumFractionDigits: n, maximumFractionDigits: n, useGrouping: false }).replace('-', '−'));
const zeitText = (s) => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function farben() {
  const css = getComputedStyle(document.documentElement);
  const v = (n, f) => (css.getPropertyValue(n).trim() || f);
  return {
    akzent: v('--accent-a', '#ffb547'), text: v('--text-primary', '#f5ece2'), leise: v('--text-leise', '#9c8f82'),
    gut: v('--success', '#5fdca4'), raster: 'rgba(255,236,214,.07)', rot: '#ff7a6b',
  };
}

export class NerdAnsicht {
  constructor(app, player) {
    this.app = app;
    this.player = player;
    this.daten = new Map();     // Track-ID -> Antwort von /tracks/{id}/nerd
    this.el = null;
    this.modus = 'nachher';     // 'roh' (wie gemastert) oder 'nachher' (mit Lautheitsangleich)
    this.hover = null;
    this.meter = new Meter();
    // Ansicht pro Gerät: Meter-Art, VU-Referenz, Spektrum-Modus, Neigung, Peak-Hold
    this.ansicht = { meter: 'digital', vuSkala: 'lu', sp: 'stereo', neigung: true, halten: true };
    try { Object.assign(this.ansicht, JSON.parse(localStorage.getItem(ANSICHT) || '{}')); } catch (e) { /* egal */ }
    this.spBereich = [20, 20000];
    this.spFix = null;        // eingefrorene Frequenz (Klick ins Spektrum)
    this.spMaus = null;       // Frequenz unter der Maus
    player.addEventListener('track', () => { this.meter.zuruecksetzen(); if (this.offen) this.laden(); });
    player.addEventListener('zustand', () => { if (this.offen) this.werteZeigen(); });
    try { if (localStorage.getItem(MERKEN) === '1' && this.pcGeeignet()) setTimeout(() => this.oeffnen(), 500); } catch (e) { /* egal */ }
  }

  get offen() { return !!this.el; }

  pcGeeignet() { return window.matchMedia('(min-width: 1024px) and (hover: hover)').matches; }

  umschalten() { if (this.offen) this.schliessen(); else this.oeffnen(); }

  oeffnen() {
    if (this.offen || !this.pcGeeignet()) return;
    const el = document.createElement('section');
    el.className = 'nerd';
    // Schublade: schiebt Player-Leiste und Seite nach oben, statt etwas zu verdecken
    const hoehe = Math.round(Math.max(420, Math.min(640, window.innerHeight * 0.58)));
    this.hoehe = hoehe;
    el.style.height = `${hoehe}px`;
    el.setAttribute('aria-label', t('Analyse'));
    el.innerHTML = `
      <div class="nerd-kopf">
        <b>${t('Analyse')}</b><span class="nerd-titel" data-n-titel></span>
        <div class="nerd-schalter" role="group" aria-label="${t('Kurve zeigen')}">
          <button type="button" data-n-modus="roh">${t('wie gemastert')}</button><button type="button" data-n-modus="nachher">${t('nach Angleich')}</button>
        </div>
        <button type="button" class="btn-ico" data-n-zu aria-label="${t('Analyse schließen')}">${icon('runter', 20)}</button>
      </div>
      <div class="nerd-weg" data-n-weg></div>
      <div class="nerd-inhalt">
        <div class="nerd-links">
          <div class="nerd-legende"><span class="l-p">${t('True-Peak (0,2 s)')}</span><span class="l-m">Momentary (400 ms)</span><span class="l-s">Short-term (3 s)</span><span class="l-i">${t('Integriert')}</span><span class="l-z">${t('Ziel')}</span><span class="l-d">−1 dBTP</span></div>
          <div class="nerd-kurve"><canvas data-n-kurve></canvas><div class="nerd-tip" data-n-tip hidden></div><div class="nerd-hinweis" data-n-hinweis></div></div>
          <div class="nerd-jetzt" data-n-jetzt></div>
          <div class="nerd-sp-kopf">
            <span class="nerd-sp-titel">${t('Spektrum')} <small data-n-sp-info></small></span>
            <div class="nerd-schalter" role="group" aria-label="${t('Kanäle im Spektrum')}">
              <button type="button" data-n-sp="stereo" title="${t('Mittel aus links und rechts')}">Stereo</button><button type="button" data-n-sp="lr" title="${t('Links und rechts getrennt')}">L/R</button><button type="button" data-n-sp="ms" title="${t('Mitte (L+R) und Seite (L−R)')}">M/S</button>
            </div>
            <button type="button" class="nerd-chip" data-n-sp-opt="halten" title="${t('Höchstwerte halten, fallen langsam ab')}">Peak-Hold</button>
            <button type="button" class="nerd-chip" data-n-sp-opt="neigung" title="${t('+4,5 dB je Oktave um 1 kHz – ausgewogene Musik liegt damit ungefähr waagrecht (wie in DAW-Analyzern)')}">${t('Neigung 4,5 dB/Okt')}</button>
          </div>
          <div class="nerd-spektrum"><canvas data-n-spektrum></canvas><div class="nerd-tip nerd-sp-tip" data-n-sp-tip hidden></div><div class="nerd-hinweis" data-n-sp-hinweis hidden></div></div>
        </div>
        <div class="nerd-meter">
          <div class="nerd-meter-kopf"><span>${t('Meter')}</span>
            <div class="nerd-schalter" role="group" aria-label="${t('Meter-Art')}"><button type="button" data-n-meter="digital">${t('Digital')}</button><button type="button" data-n-meter="vu">VU vintage</button></div>
          </div>
          <div class="nerd-meter-flaeche"><canvas data-n-meter-canvas></canvas><div class="nerd-hinweis" data-n-mt-hinweis hidden></div></div>
        </div>
        <div class="nerd-rechts" data-n-werte></div>
      </div>`;
    document.body.appendChild(el);
    this.el = el;
    document.body.classList.add('nerd-offen');
    document.documentElement.style.setProperty('--nerd-h', `${hoehe}px`);
    requestAnimationFrame(() => {
      el.classList.add('offen');
      // Inhalt mitschieben: was eben unten sichtbar war, bleibt sichtbar
      this.geschoben = !document.querySelector('.jetzt');
      if (this.geschoben) window.scrollBy({ top: hoehe, behavior: 'smooth' });
    });
    el.addEventListener('click', (e) => {
      const q = e.target.closest('[data-n-q]');
      if (q) { this.player.qualitaetSetzen(q.dataset.nQ); this.app.leiste?.aktualisieren?.(); setTimeout(() => this.werteZeigen(), 50); }
    });
    el.querySelector('[data-n-zu]').addEventListener('click', () => this.schliessen());
    el.querySelectorAll('[data-n-modus]').forEach((b) => b.addEventListener('click', () => { this.modus = b.dataset.nModus; this.statischNeu = true; this.werteZeigen(); }));
    const kurve = el.querySelector('[data-n-kurve]');
    const anteil = (e) => {
      const r = kurve.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const l = (this.statisch?.links ?? 0) / dpr, re = (this.statisch?.rechts ?? r.width * dpr) / dpr;
      return Math.max(0, Math.min(1, (e.clientX - r.left - l) / Math.max(1, re - l)));
    };
    kurve.addEventListener('mousemove', (e) => { this.hover = anteil(e); });
    kurve.addEventListener('mouseleave', () => { this.hover = null; });
    kurve.addEventListener('click', (e) => {
      const d = this.player.dauer;
      if (d > 0) this.player.springen(anteil(e) * d);
    });
    this.groesseBeobachter = new ResizeObserver(() => { this.statischNeu = true; });
    this.groesseBeobachter.observe(kurve);
    this.groesseBeobachter.observe(el.querySelector('[data-n-spektrum]'));
    this.spektrumVerbinden(el);
    try { localStorage.setItem(MERKEN, '1'); } catch (e) { /* egal */ }
    this.app.leiste?.aktualisieren?.();
    this.app.leiste?.jetztAktualisieren?.();
    this.laden();
    const schleife = () => { if (!this.el) return; this.zeichnen(); this.raf = requestAnimationFrame(schleife); };
    this.raf = requestAnimationFrame(schleife);
    this.werteTimer = setInterval(() => this.werteZeigen(), 1000);
  }

  schliessen() {
    if (!this.el) return;
    cancelAnimationFrame(this.raf);
    clearInterval(this.werteTimer);
    this.groesseBeobachter?.disconnect();
    const el = this.el;
    this.el = null;
    el.classList.remove('offen');
    setTimeout(() => el.remove(), 320);
    document.documentElement.style.setProperty('--nerd-h', '0px');
    if (this.geschoben) window.scrollBy({ top: -(this.hoehe || 0), behavior: 'smooth' });
    this.geschoben = false;
    document.body.classList.remove('nerd-offen');
    try { localStorage.setItem(MERKEN, '0'); } catch (e) { /* egal */ }
    this.app.leiste?.aktualisieren?.();
    this.app.leiste?.jetztAktualisieren?.();
  }

  async laden() {
    const tr = this.player.track;
    this.statischNeu = true;
    this.werteZeigen();
    if (!tr || this.daten.has(tr.id)) return;
    const hinweis = this.el?.querySelector('[data-n-hinweis]');
    if (hinweis) hinweis.textContent = t('Lautheitskurve wird geladen … (noch nicht gemessene Titel werden jetzt gemessen)');
    try {
      const d = await api.get(`/tracks/${tr.id}/nerd`);
      this.daten.set(tr.id, d);
    } catch (e) {
      this.daten.set(tr.id, { fehler: e.message || t('nicht verfügbar') });
    }
    if (this.player.track?.id === tr.id) { this.statischNeu = true; this.werteZeigen(); }
  }

  get aktuelle() { const t = this.player.track; return t ? this.daten.get(t.id) : null; }

  /** Gain, um den die Kurve in der Ansicht „nach Angleich“ verschoben wird */
  get verschiebung() {
    if (this.modus !== 'nachher') return 0;
    return this.player.lautheitFuer(this.player.track)?.db || 0;
  }

  // ---------- Werte rechts ----------
  werteZeigen() {
    if (!this.el) return;
    const p = this.player;
    const tr = p.track;
    this.el.querySelector('[data-n-titel]').textContent = tr ? ` · ${tr.titel}` : '';
    this.el.querySelectorAll('[data-n-modus]').forEach((b) => b.classList.toggle('an', b.dataset.nModus === this.modus));
    const d = this.aktuelle;
    const hinweis = this.el.querySelector('[data-n-hinweis]');
    if (d?.kurve) hinweis.textContent = '';
    else if (d) hinweis.textContent = d.fehler ? t('Keine Kurve: {fehler}', { fehler: d.fehler }) : t('Keine Kurve vorhanden.');
    const lh = tr ? p.lautheitFuer(tr) : null;
    const zeile = (a, b, titel = '') => `<dt>${h(a)}</dt><dd ${titel ? `title="${h(titel)}"` : ''}>${b}</dd>`;
    const tw = d?.titel || {};
    const aw = d?.album || {};
    const plr = tw.true_peak != null && tw.lufs != null ? tw.true_peak - tw.lufs : null;
    const f = d?.datei;
    const m = p.modus || {};
    const motor = p.nativ ? t('Amberwave Engine, lückenlos (sample-genau)') : p.motor?.aktiv ? (p.motor.art === 'flac' ? t('FLAC-Strom (MSE), lückenlos') : t('Opus-Kette (MSE), lückenlos')) : t('klassisch (ein Titel je Anfrage)');
    const strom = p.nativ ? t('Original, verlustfrei als FLAC') : m.art === 'original' ? (p.motor?.aktiv && !p.motor?.aktuell?.bitgenau ? t('Original, verlustfrei dekodiert') : t('Original, bitgenau')) : m.qualitaet ? `${m.qualitaet.replace(/(\d+)/, ' $1')} kbit/s` : '–';
    const vor = (() => { const b = p.audio.buffered; const c = p.audio.currentTime; for (let i = 0; i < b.length; i++) if (b.start(i) <= c + 0.1 && b.end(i) > c) return b.end(i) - c; return 0; })();
    const ctx = p.raumklang?.ctx;
    const lat = ctx ? ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000 : null;
    const gainText = !lh ? t('aus (bitgenau)') : lh.art === 'fehlt' ? t('nicht gemessen') : t(lh.art === 'album' ? 'Album {gain} dB' : 'Titel {gain} dB', { gain: `${lh.db > 0 ? '+' : ''}${k(lh.db, 2)}` });
    this.wegZeigen(d, lh, vor, ctx, lat);
    this.el.querySelector('[data-n-werte]').innerHTML = `
      <h4>${t('Titel')}</h4><dl>
        ${zeile(t('Integriert'), `${k(tw.lufs)} LUFS`)}${zeile(t('Lautheitsumfang'), `${k(tw.lra)} LU`)}
        ${zeile(t('True-Peak'), `${k(tw.true_peak)} dBTP`)}${zeile(t('Sample-Peak'), `${k(tw.sample_peak)} dBFS`)}
        ${zeile('PLR', `${k(plr)} dB`, t('Abstand True-Peak zu integrierter Lautheit – je größer, desto mehr Dynamik'))}
      </dl>
      <h4>${t('Album')}</h4><dl>
        ${zeile(t('Integriert'), `${k(aw.lufs)} LUFS`)}${zeile(t('Lautheitsumfang'), `${k(aw.lra)} LU`)}${zeile(t('True-Peak'), `${k(aw.true_peak)} dBTP`)}
      </dl>
      <h4>${t('Angleich')}</h4><dl>
        ${zeile('Gain', gainText, lh?.begrenzt ? t('Anheben begrenzt durch True-Peak {tp} dBTP', { tp: k(lh.tp) }) : '')}
        ${lh && lh.art !== 'fehlt' ? zeile(t('Ziel'), `${k(lh.ziel, 0)} LUFS${lh.begrenzt ? ` · ${t('begrenzt')}` : ''}`) : ''}
        ${f?.replaygain?.track_db != null ? zeile(t('ReplayGain-Tag'), t('{spur} dB (Album {album} dB)', { spur: k(f.replaygain.track_db, 2), album: k(f.replaygain.album_db, 2) })) : ''}
      </dl>
      <h4>${t('Datei')}</h4><dl>
        ${f ? zeile(t('Name'), `<span class="nerd-datei">${h(f.name)}</span>`, f.name) : ''}
        ${f ? zeile(t('Format'), `${h((f.format || '').toUpperCase())}${f.codec && f.codec !== f.format ? ` (${h(f.codec)})` : ''} · ${f.bittiefe ? `${f.bittiefe} Bit / ` : ''}${k(f.abtastrate / 1000, f.abtastrate % 1000 ? 1 : 0)} kHz`) : ''}
        ${f ? zeile(t('Kanäle · Bitrate'), `${f.kanaele} · ${Math.round(f.bitrate / 1000)} kbit/s`) : ''}
        ${f ? zeile(t('Größe'), groesse(f.groesse)) : ''}
      </dl>
      <h4>${t('Wiedergabe')}</h4><dl>
        ${zeile(t('Strom'), h(strom))}${zeile(t('Motor'), h(motor))}
        ${zeile(t('Puffer voraus'), `${k(vor, 0)} s`)}
        ${p.nativ ? zeile(t('Ausgabe'), h(this.nativAusgabeText()), p.audio.format?.hinweis || '') : zeile('Web Audio', ctx ? `${k(ctx.sampleRate / 1000, 1)} kHz · ${k(lat, 0)} ms` : t('aus'))}
      </dl>${this.protokollHtml()}`;
  }

  /** ASIO: was der Treiber bei der letzten Umstellung (Ratenwechsel, Öffnen) wann getan hat */
  protokollHtml() {
    const a = this.player.audio?.anlaufLetzt;
    if (!a?.asio || !a.protokoll?.length) return '';
    return `<h4>${t('Letzte Umstellung (ASIO)')}</h4><ol class="nerd-protokoll">${a.protokoll.map((x) => `<li><span>${x.ms} ms</span>${h(x.t)}</li>`).join('')}
      <li><span>${a.ms} ms</span>${a.zeitueber ? t('kein stabiler Takt – trotzdem los') : t('bereit')}${a.aufschlag ? `, ${t('dann {ms} ms Pause', { ms: a.aufschlag })}` : ''}</li></ol>`;
  }

  /** Windows Client: wie die Engine das Gerät geöffnet hat */
  nativAusgabeText() {
    const f = this.player.audio.format;
    if (!f) return t('noch nicht geöffnet');
    const gr = f.geraet_rate || f.aus_rate;
    return `${ausgabeWeg(f)}${f.umgerechnet ? ` · ${t('fest {rate} kHz (umgerechnet)', { rate: k(gr / 1000, gr % 1000 ? 1 : 0) })}` : ''} · ${f.aus_format || ''} / ${k(gr / 1000, gr % 1000 ? 1 : 0)} kHz · ${t('{n} Kan.', { n: f.aus_kanaele })}${this.player.audio.bitgenau ? ` · ${t('bitgenau')}` : ''}`;
  }

  /** Signalweg als Kette von Stationen: Datei → Übertragung → Lautheit → Klang → Ausgabe, dazu die Qualitätswahl */
  wegZeigen(d, lh, vor, ctx, lat) {
    const p = this.player;
    const box = this.el.querySelector('[data-n-weg]');
    const m = p.modus || {};
    const f = d?.datei || null;
    const fmt = f || p.track?.format ? (() => {
      const x = f || { format: p.track.format.datei, codec: p.track.format.codec, bittiefe: p.track.format.bittiefe, abtastrate: p.track.format.abtastrate, kanaele: p.track.format.kanaele, bitrate: p.track.format.bitrate };
      const name = x.codec === 'alac' ? 'ALAC' : (x.format || x.codec || '').toUpperCase();
      return { name, aufl: x.bittiefe ? `${x.bittiefe} Bit / ${k(x.abtastrate / 1000, x.abtastrate % 1000 ? 1 : 0)} kHz` : `${Math.round((x.bitrate || 0) / 1000)} kbit/s`, x };
    })() : null;
    const hires = fmt && (fmt.x.bittiefe > 16 || fmt.x.abtastrate > 48000);
    const stationen = [];
    // 1. Datei
    stationen.push({ titel: t('Datei'), wert: fmt ? `${fmt.name} ${hires ? '<span class="nerd-marke">Hi-Res</span>' : ''}` : '–',
      info: fmt ? `${fmt.aufl} · ${fmt.x.kanaele === 1 ? 'Mono' : fmt.x.kanaele === 2 ? 'Stereo' : t('{n} Kanäle', { n: fmt.x.kanaele })}${f ? ` · ${Math.round(f.bitrate / 1000)} kbit/s` : ''}` : '', art: 'datei' });
    // 2. Übertragung
    const original = m.art === 'original';
    const bitgenau = original && !p.nativ && (!m.lueckenlos || !!p.motor?.aktuell?.bitgenau);
    const weg = netzweg.direkt ? (p.direktAktiv ? t('direkt im Heimnetz') : t('über Cloudflare')) : (p.netz?.lokal ? t('zuhause') : t('unterwegs'));
    stationen.push({ titel: t('Übertragung'), wert: original ? (bitgenau ? t('Original · bitgenau') : t('Original · verlustfrei')) : `${(m.qualitaet || '').replace(/^(opus|aac)/, (x) => x === 'aac' ? 'AAC ' : 'Opus ')} kbit/s`,
      info: `${p.nativ ? (['wav', 'aif', 'aiff'].includes(fmt?.x?.format) && /^pcm_[su]/.test(fmt?.x?.codec || '') ? t('Original-Datei an die Engine, lückenlos') : t('FLAC an die Engine, lückenlos')) : m.lueckenlos ? t('lückenlos ({art})', { art: p.motor?.art === 'flac' ? t('FLAC-Strom') : t('Opus-Kette') }) : t('einzeln')} · ${weg} · ${t('Puffer {n} s', { n: k(vor, 0) })}${m.ersatz ? ` · ${t('statt Original')}` : ''}`,
      art: original ? 'gut' : 'veraendert' });
    // 3. Lautheit
    stationen.push(!lh ? { titel: t('Lautheit'), wert: t('aus'), info: t('wie gemastert'), art: 'aus' }
      : lh.art === 'fehlt' ? { titel: t('Lautheit'), wert: t('nicht gemessen'), info: t('spielt ohne Angleich'), art: 'aus' }
      : { titel: t('Lautheit'), wert: t(lh.art === 'album' ? 'Album {gain} dB' : 'Titel {gain} dB', { gain: `${lh.db > 0 ? '+' : ''}${k(lh.db)}` }),
        info: `${k(lh.lufs)} → ${k(lh.ziel, 0)} LUFS · ${p.gainAmServer ? t('im Stream') : p.nativ ? t('Engine') : ctx ? 'Web Audio' : t('Lautstärke')}${lh.begrenzt ? ` · ${t('begrenzt')}` : ''}`, art: Math.abs(lh.db) < 0.05 ? 'gut' : 'angepasst' });
    // 4. Klang
    // in der eingestellten Reihenfolge, nur was wirklich im Weg ist (alles umgangen: nichts)
    const rkK = p.raumklang;
    const kette = rkK?.angeschlossen ? (p.einst.reihe || []).filter((a) => rkK.stufeWirksam(a)).map((a) => ({ glow: 'Glow', iron: 'Iron', silk: 'Silk', eq: 'EQ' })[a] || vstRack.finde(a)?.name) : [];
    const rk = rkK?.aktiv;
    if (rk) kette.push(`Space ${h(RAUMKLANG_PRESETS[rkK.preset]?.name || '')}`);
    stationen.push({ titel: t('Klang'), wert: kette.length ? kette.join(' → ') : p.bypass ? t('alles umgangen') : t('unverändert'),
      info: [rk ? `Stereo → ${rkK.layout?.name || ''}` : '', eqWirksam(p.einst.eq) && kette.includes('EQ') ? h(eqKurzText(p.einst.eq)) : ''].filter(Boolean).join(' · ') || (kette.length ? t('Effektkette') : t('keine Effekte')), art: kette.length ? 'angepasst' : 'gut' });
    // 5. Ausgabe
    if (p.nativ) {
      const af = p.audio.format;
      const gr = af ? af.geraet_rate || af.aus_rate : 0;
      const umr = af && (af.umgerechnet || (!af.exklusiv && gr && Math.abs(gr - af.rate) > 1));
      const runter = af && af.aus_kanaele < af.kanaele;
      stationen.push({ titel: t('Ausgabe'), wert: af ? `${ausgabeWeg(af)}${p.audio.bitgenau ? ' · bitgenau' : ''}` : '–',
        info: af ? [h(af.geraet || ''), `${af.aus_format || ''} / ${k(gr / 1000, gr % 1000 ? 1 : 0)} kHz`, umr ? (af.umgerechnet ? t('feste Rate: {a} → {b} kHz umgerechnet', { a: k(af.rate / 1000, 1), b: k(gr / 1000, 1) }) : t('Windows rechnet {a} → {b} kHz um', { a: k(af.rate / 1000, 1), b: k(gr / 1000, 1) })) : '', runter ? t('auf {n} Kanäle gemischt', { n: af.aus_kanaele }) : '', af.asio && af.latenz > 0 ? t('Treiber-Latenz {ms} ms', { ms: k(af.latenz / (gr || af.rate) * 1000, 1) }) : '', anlaufText(p.audio.anlauf)].filter(Boolean).join(' · ') : t('Engine startet …'),
        art: umr || runter ? 'veraendert' : 'gut' });
    } else {
    const rate = fmt?.x?.abtastrate || 0;
    const quellRate = original ? rate : 48000;
    const umrechnen = ctx && quellRate && Math.abs(ctx.sampleRate - quellRate) > 1;
    stationen.push({ titel: t('Ausgabe'), wert: ctx ? `Web Audio ${k(ctx.sampleRate / 1000, 1)} kHz` : t('Browser direkt'),
      info: ctx ? `${t('{n} Kanäle', { n: ctx.destination.maxChannelCount })} · ${t('{ms} ms Latenz', { ms: k(lat, 0) })}${umrechnen ? ` · ${t('rechnet {a} → {b} kHz um', { a: k(quellRate / 1000, 1), b: k(ctx.sampleRate / 1000, 1) })}` : ''}` : t('Betriebssystem mischt'),
      art: umrechnen ? 'veraendert' : 'gut' });
    }
    const qAktuell = p.qualitaet;
    const auto = p.autoQualitaet();
    const html = `<div class="nerd-stationen">${stationen.map((x, i) => `${i ? '<span class="nerd-pfeil" aria-hidden="true">→</span>' : ''}<div class="nerd-station ${x.art}"><small>${x.titel}</small><b>${x.wert}</b><span>${x.info}</span></div>`).join('')}</div>
      ${p.nativ ? '' : `<div class="nerd-qualitaet" role="group" aria-label="${p.bereich === 'heim' ? t('Qualität zuhause') : t('Qualität unterwegs')}"><small>${p.bereich === 'heim' ? t('Qualität zuhause') : t('Qualität unterwegs')}</small>
        ${QUALITAETEN.map(([w, bez]) => `<button type="button" data-n-q="${w}" class="${qAktuell === w ? 'an' : ''}" title="${h(w === 'auto' ? t('Automatisch – jetzt {q} ({grund})', { q: auto.q, grund: auto.grund }) : bez)}">${h(w === 'auto' ? t('Auto') : w === 'original' ? t('Original') : bez.replace(' kbit/s', '').replace(/\s*\(.*\)/, ''))}</button>`).join('')}</div>`}`;
    if (box._letzt !== html) { box.innerHTML = html; box._letzt = html; }
  }

  // ---------- Zeichnen ----------
  canvasVorbereiten(c) {
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr));
    const hh = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; }
    return { w, h: hh, dpr };
  }

  zeichnen() {
    const kurve = this.el.querySelector('[data-n-kurve]');
    const spektrum = this.el.querySelector('[data-n-spektrum]');
    this.kurveZeichnen(kurve);
    this.spektrumZeichnen(spektrum);
    this.meterZeichnen();
  }

  ansichtMerken() {
    try { localStorage.setItem(ANSICHT, JSON.stringify(this.ansicht)); } catch (e) { /* egal */ }
    this.schalterZeigen();
  }

  schalterZeigen() {
    if (!this.el) return;
    this.el.querySelectorAll('[data-n-sp]').forEach((b) => b.classList.toggle('an', b.dataset.nSp === this.ansicht.sp));
    this.el.querySelectorAll('[data-n-sp-opt]').forEach((b) => b.classList.toggle('an', !!this.ansicht[b.dataset.nSpOpt]));
    this.el.querySelectorAll('[data-n-meter]').forEach((b) => b.classList.toggle('an', b.dataset.nMeter === this.ansicht.meter));
  }

  /** Bedienung von Spektrum und Meter: Modus, Optionen, Maus (Wert ablesen), Klick (einfrieren), Mausrad (zoomen) */
  spektrumVerbinden(el) {
    this.schalterZeigen();
    el.querySelectorAll('[data-n-sp]').forEach((b) => b.addEventListener('click', () => { this.ansicht.sp = b.dataset.nSp; this.spHalten = null; this.ansichtMerken(); }));
    el.querySelectorAll('[data-n-sp-opt]').forEach((b) => b.addEventListener('click', () => { const o = b.dataset.nSpOpt; this.ansicht[o] = !this.ansicht[o]; this.spHalten = null; this.ansichtMerken(); }));
    el.querySelectorAll('[data-n-meter]').forEach((b) => b.addEventListener('click', () => { this.ansicht.meter = b.dataset.nMeter; this.ansichtMerken(); }));
    const c = el.querySelector('[data-n-spektrum]');
    const freq = (e) => {
      const r = c.getBoundingClientRect();
      const g = this.spGeometrie;
      if (!g) return null;
      const x = (e.clientX - r.left) * g.dpr;
      if (x < g.links || x > g.rechts) return null;
      return g.f(x);
    };
    c.addEventListener('mousemove', (e) => { this.spMaus = freq(e); });
    c.addEventListener('mouseleave', () => { this.spMaus = null; });
    c.addEventListener('click', (e) => { const f = freq(e); this.spFix = this.spFix || !f ? null : f; });
    c.addEventListener('dblclick', () => { this.spBereich = [20, 20000]; this.spFix = null; this.spHalten = null; });
    c.addEventListener('wheel', (e) => {
      const f = freq(e);
      if (!f) return;
      e.preventDefault();
      const [a, b] = this.spBereich;
      const fak = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      let na = f * Math.pow(a / f, fak), nb = f * Math.pow(b / f, fak);
      if (nb / na < 2) return;                              // mindestens eine Oktave
      if (na < 20) { nb *= 20 / na; na = 20; }
      if (nb > 20000) { na *= 20000 / nb; nb = 20000; }
      this.spBereich = [Math.max(20, na), Math.min(20000, nb)];
      this.spHalten = null;
    }, { passive: false });
    const m = el.querySelector('[data-n-meter-canvas]');
    const mPunkt = (e) => { const r = m.getBoundingClientRect(), dpr = window.devicePixelRatio || 1; return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr]; };
    m.addEventListener('mousemove', (e) => { const t = this.meter.treffer(...mPunkt(e)); m.style.cursor = t ? 'pointer' : ''; m.title = t ? t.titel : ''; });
    m.addEventListener('click', (e) => {
      const t = this.meter.treffer(...mPunkt(e));
      if (t?.aktion === 'peak') this.meter.zuruecksetzen(false);
      if (t?.aktion === 'referenz') {
        const i = VU_REFERENZEN.indexOf(this.ansicht.vuSkala);
        this.ansicht.vuSkala = VU_REFERENZEN[(i + 1) % VU_REFERENZEN.length];
        this.ansichtMerken();
      }
    });
  }

  /** Web Audio fehlt (Wiedergabe läuft direkt und bitgenau): Hinweis mit Knopf zum Einschalten */
  webAudioHinweis(hinweis, rk, text) {
    if (!hinweis.hidden) return;
    hinweis.hidden = false;
    hinweis.innerHTML = `${text} <button type="button" class="link" data-n-wa>${t('Einschalten')}</button>`;
    hinweis.querySelector('[data-n-wa]').addEventListener('click', () => rk.anschliessen().then(() => this.player.lautstaerkeAnwenden()));
  }

  meterZeichnen() {
    const c = this.el.querySelector('[data-n-meter-canvas]');
    const { dpr } = this.canvasVorbereiten(c);
    const rk = this.player.raumklang;
    const hinweis = this.el.querySelector('[data-n-mt-hinweis]');
    if (!rk?.ctx) { c.getContext('2d').clearRect(0, 0, c.width, c.height); this.webAudioHinweis(hinweis, rk, t('Meter brauchen Web Audio.')); return; }
    hinweis.hidden = true;
    // Integrierte Lautheit aus der Titelmessung (ganzer Titel), so wie sie am Messpunkt ankommt (gemessen + Angleich-Gain);
    // Momentary/Short-term misst das Meter live
    const d = this.aktuelle;
    const lh = this.player.lautheitFuer(this.player.track);
    const gainDb = lh?.db || 0;
    const iTitel = d?.titel?.lufs ?? (lh && lh.art !== 'fehlt' ? lh.lufs : null);
    const ziel = Number(this.player.einst.lautheit_ziel) || -16;
    const lufs = { i: iTitel != null ? iTitel + gainDb : null, ziel: lh && lh.art !== 'fehlt' ? lh.ziel : ziel };
    const skala = this.ansicht.vuSkala;
    let referenz;
    if (skala === 'lu') referenz = { art: 'lu', ziel: lh?.ziel ?? ziel };
    else if (skala === 'auto') referenz = { db: iTitel != null ? iTitel + gainDb + 3 : -18, auto: true }; // Durchschnitt um −3 VU
    else referenz = { db: Number(skala) || -18 };
    this.meter.zeichnen(c, rk, this.ansicht.meter, lufs, referenz, dpr, !this.player.audio.paused);
  }

  /** Statische Ebene (Kurven, Raster) nur bei Änderungen neu, darüber jedes Bild die Abspielposition */
  kurveZeichnen(c) {
    const { w, h: hh, dpr } = this.canvasVorbereiten(c);
    const d = this.aktuelle;
    const g = c.getContext('2d');
    const dauer = this.player.dauer || (d?.datei?.laenge_ms || 0) / 1000;
    const schluessel = `${this.player.track?.id}|${w}|${hh}|${this.modus}|${this.verschiebung}|${!!d?.kurve}`;
    if (this.statischNeu || this._schluessel !== schluessel) {
      this.statisch = this.statischBauen(w, hh, dpr, d, dauer);
      this._schluessel = schluessel;
      this.statischNeu = false;
    }
    g.clearRect(0, 0, w, hh);
    if (this.statisch) g.drawImage(this.statisch.bild, 0, 0);
    if (!d?.kurve || !dauer || !this.statisch) { this.jetztZeigen(null); return; }
    const { x, y, links, rechts, oben, unten } = this.statisch;
    const fb = farben();
    const pos = Math.min(dauer, this.player.anzeigeZeit);
    // Abspielposition
    g.strokeStyle = fb.text; g.lineWidth = 1.5 * dpr;
    g.beginPath(); g.moveTo(x(pos), oben); g.lineTo(x(pos), unten); g.stroke();
    // Gespieltes leicht abdunkeln
    g.fillStyle = 'rgba(0,0,0,.18)';
    g.fillRect(links, oben, Math.max(0, x(pos) - links), unten - oben);
    // Hover: Fadenkreuz und Werte
    const tip = this.el.querySelector('[data-n-tip]');
    if (this.hover != null) {
      const zt = Math.max(0, Math.min(dauer, this.hover * dauer));
      const v = this.werteBei(d, zt);
      g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = dpr; g.setLineDash([3 * dpr, 3 * dpr]);
      g.beginPath(); g.moveTo(x(zt), oben); g.lineTo(x(zt), unten); g.stroke(); g.setLineDash([]);
      tip.hidden = false;
      tip.innerHTML = `<b>${zeitText(zt)}</b> M ${k(v.m)} · S ${k(v.s)} LUFS · TP ${k(v.p)} dBTP<br><small>${t('Klick: hierhin springen')}</small>`;
      const xp = (x(zt) / dpr);
      tip.style.left = `${Math.min(xp + 10, c.clientWidth - 230)}px`;
    } else tip.hidden = true;
    this.jetztZeigen(this.werteBei(d, pos));
    void rechts; void y;
  }

  werteBei(d, t) {
    const k2 = d.kurve;
    const i = Math.max(0, Math.min(k2.m.length - 1, Math.floor(t / k2.schritt)));
    const v = this.verschiebung;
    const gueltig = (x) => (x <= -119 ? null : x + v);
    return { m: gueltig(k2.m[i]), s: gueltig(k2.s[i]), p: gueltig(k2.p[i]) };
  }

  jetztZeigen(v) {
    const box = this.el.querySelector('[data-n-jetzt]');
    if (!v) { box.innerHTML = ''; return; }
    const balken = (x, min = -40, max = 0) => `<i style="width:${x == null ? 0 : Math.max(0, Math.min(100, ((x - min) / (max - min)) * 100))}%"></i>`;
    const html = `<span>${t('Jetzt')}</span>
      <div><small>Momentary</small><b>${k(v.m)}</b><em>LUFS</em><div class="nerd-balken m">${balken(v.m)}</div></div>
      <div><small>Short-term</small><b>${k(v.s)}</b><em>LUFS</em><div class="nerd-balken s">${balken(v.s)}</div></div>
      <div><small>${t('True-Peak')}</small><b>${k(v.p)}</b><em>dBTP</em><div class="nerd-balken p">${balken(v.p, -40, 0)}</div></div>`;
    if (box._letzt !== html) { box.innerHTML = html; box._letzt = html; }
  }

  statischBauen(w, hh, dpr, d, dauer) {
    const bild = document.createElement('canvas');
    bild.width = w; bild.height = hh;
    const g = bild.getContext('2d');
    const fb = farben();
    g.font = `${10 * dpr}px system-ui, sans-serif`;
    if (!d?.kurve || !dauer) return { bild, x: () => 0, y: () => 0, links: 0, rechts: w, oben: 0, unten: hh };
    const k2 = d.kurve;
    const v = this.verschiebung;
    const gueltig = (x) => x > -119;
    // Bereich: Ruhige Stellen bis knapp über die lauteste Spitze, in 6-dB-Schritten
    const ss = k2.s.filter(gueltig).map((x) => x + v);
    const ps = k2.p.filter(gueltig).map((x) => x + v);
    // Bereich: von der lautesten Spitze bis knapp unter die leiseren Passagen (Ein-/Ausblendungen zählen nicht)
    const sortiert = ss.slice().sort((a, b) => a - b);
    const leise = sortiert.length ? sortiert[Math.floor(sortiert.length * 0.05)] : -40;
    const maxW = ps.length ? Math.max(...ps) : -6;
    const oberGrenze = Math.max(0, Math.min(6, Math.ceil((maxW + 1) / 3) * 3));
    const unterGrenze = Math.max(-72, Math.min(oberGrenze - 18, Math.floor((leise - 6) / 6) * 6));
    const links = 34 * dpr, rechts = w - 8 * dpr, oben = 8 * dpr, unten = hh - 18 * dpr;
    const rasterSchritt = (unten - oben) / ((oberGrenze - unterGrenze) / 6) < 16 * dpr ? 12 : 6;
    const x = (t) => links + (t / dauer) * (rechts - links);
    const y = (db) => unten - ((Math.max(unterGrenze, Math.min(oberGrenze, db)) - unterGrenze) / (oberGrenze - unterGrenze)) * (unten - oben);
    // Raster
    g.strokeStyle = fb.raster; g.fillStyle = fb.leise; g.lineWidth = dpr; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let db = Math.ceil(unterGrenze / rasterSchritt) * rasterSchritt; db <= oberGrenze; db += rasterSchritt) {
      g.beginPath(); g.moveTo(links, y(db)); g.lineTo(rechts, y(db)); g.stroke();
      g.fillText(k(db, 0), links - 5 * dpr, y(db));
    }
    const takt = dauer > 900 ? 120 : dauer > 400 ? 60 : dauer > 120 ? 30 : 10;
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (let t = 0; t <= dauer; t += takt) {
      g.beginPath(); g.moveTo(x(t), oben); g.lineTo(x(t), unten); g.stroke();
      g.fillText(zeitText(t), x(t), unten + 4 * dpr);
    }
    const schritt = k2.schritt;
    // True-Peak als Fläche
    g.beginPath(); g.moveTo(x(0), unten);
    k2.p.forEach((p, i) => g.lineTo(x(i * schritt), gueltig(p) ? y(p + v) : unten));
    g.lineTo(x((k2.p.length - 1) * schritt), unten); g.closePath();
    g.fillStyle = 'rgba(255,181,71,.10)'; g.fill();
    const linie = (reihe, farbe, breite) => {
      g.beginPath(); let an = false;
      reihe.forEach((wert, i) => {
        if (!gueltig(wert)) { an = false; return; }
        const px = x(i * schritt + schritt), py = y(wert + v);
        if (an) g.lineTo(px, py); else { g.moveTo(px, py); an = true; }
      });
      g.strokeStyle = farbe; g.lineWidth = breite * dpr; g.lineJoin = 'round'; g.stroke();
    };
    linie(k2.m, 'rgba(245,236,226,.32)', 1);
    linie(k2.s, fb.akzent, 2);
    // Waagrechte Linien: integriert, Ziel, −1 dBTP
    const waagrecht = (db, farbe, text, strich) => {
      if (db == null || db < unterGrenze || db > oberGrenze) return;
      g.setLineDash(strich.map((s) => s * dpr)); g.strokeStyle = farbe; g.lineWidth = dpr;
      g.beginPath(); g.moveTo(links, y(db)); g.lineTo(rechts, y(db)); g.stroke(); g.setLineDash([]);
      // Beschriftung über der Linie, ganz oben darunter; mit dunklem Hintergrund, damit sie über den Kurven lesbar bleibt
      const unterhalb = y(db) - oben < 14 * dpr;
      const ty = unterhalb ? y(db) + 3 * dpr : y(db) - 3 * dpr;
      g.textAlign = 'right'; g.textBaseline = unterhalb ? 'top' : 'bottom';
      const breite = g.measureText(text).width;
      g.fillStyle = 'rgba(22,16,12,.85)';
      g.fillRect(rechts - breite - 6 * dpr, unterhalb ? ty - dpr : ty - 12 * dpr, breite + 6 * dpr, 13 * dpr);
      g.fillStyle = farbe; g.fillText(text, rechts - 3 * dpr, ty);
    };
    const lh = this.player.lautheitFuer(this.player.track);
    const zielZeigen = this.modus === 'nachher' && lh && lh.art !== 'fehlt';
    const iWert = d.titel?.lufs != null ? d.titel.lufs + v : null;
    if (zielZeigen && iWert != null && Math.abs(iWert - lh.ziel) < 1.5) {
      waagrecht(lh.ziel, fb.gut, t('I {i} = Ziel {ziel}', { i: k(iWert), ziel: k(lh.ziel, 0) }), [5, 4]);
    } else {
      if (iWert != null) waagrecht(iWert, fb.text, `I ${k(iWert)}`, [5, 4]);
      if (zielZeigen) waagrecht(lh.ziel, fb.gut, t('Ziel {ziel}', { ziel: k(lh.ziel, 0) }), [2, 3]);
    }
    waagrecht(-1, fb.rot, '−1 dBTP', [6, 3]);
    return { bild, x, y, links, rechts, oben, unten };
  }

  /**
   * Spektrum wie im Analyzer einer DAW: FFT 16384, logarithmische Achse, Glättung 1/24 Oktave (Leistungsmittel),
   * optional +4,5 dB/Okt Neigung um 1 kHz, Peak-Hold, Stereo / L+R getrennt / Mitte+Seite, Wert unter der Maus mit Note.
   */
  spektrumZeichnen(c) {
    const { w, h: hh, dpr } = this.canvasVorbereiten(c);
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, hh);
    const rk = this.player.raumklang;
    const hinweis = this.el.querySelector('[data-n-sp-hinweis]');
    const tip = this.el.querySelector('[data-n-sp-tip]');
    if (!rk?.ctx) { tip.hidden = true; this.webAudioHinweis(hinweis, rk, t('Spektrum braucht Web Audio (sonst läuft die Wiedergabe direkt und bitgenau).')); return; }
    hinweis.hidden = true;
    const an = rk.spektrum();
    const rate = rk.ctx.sampleRate;
    const n = an.l.frequencyBinCount;
    const fft = 2 * n;
    const info = this.el.querySelector('[data-n-sp-info]');
    const infoText = t('FFT {fft} · {hz} Hz je Wert · 1/24 Okt.', { fft, hz: k(rate / fft, 1) });
    if (info.textContent !== infoText) info.textContent = infoText;
    const lesen = (a, name) => {
      this.spPuffer = this.spPuffer || {};
      if (!this.spPuffer[name] || this.spPuffer[name].length !== n) this.spPuffer[name] = new Float32Array(n);
      a.getFloatFrequencyData(this.spPuffer[name]);
      return this.spPuffer[name];
    };
    const modus = this.ansicht.sp;
    const reihen = modus === 'lr' ? [['L', lesen(an.l, 'l')], ['R', lesen(an.r, 'r')]]
      : modus === 'ms' ? [['M', lesen(an.m, 'm')], ['S', lesen(an.s, 's')]]
      : [['L+R', null, lesen(an.l, 'l'), lesen(an.r, 'r')]];
    const fb = farben();
    const links = 34 * dpr, rechts = w - 8 * dpr, oben = 6 * dpr, unten = hh - 16 * dpr;
    const [fA, fB] = this.spBereich;
    const lgA = Math.log(fA), lgS = Math.log(fB / fA);
    const fx = (f) => links + ((Math.log(f) - lgA) / lgS) * (rechts - links);
    const xf = (x) => Math.exp(lgA + ((x - links) / (rechts - links)) * lgS);
    const MIN = -102, MAX = -6;
    const fy = (db) => unten - ((Math.max(MIN, Math.min(MAX, db)) - MIN) / (MAX - MIN)) * (unten - oben);
    this.spGeometrie = { links, rechts, dpr, f: xf };
    // Raster: Dekaden kräftig, dazwischen fein; Beschriftung je nach Zoom
    g.lineWidth = dpr;
    g.font = `${9.5 * dpr}px system-ui, sans-serif`; g.textBaseline = 'top'; g.textAlign = 'center';
    const pxProOkt = (rechts - links) / (Math.log2(fB / fA));
    for (let dek = 10; dek <= 10000; dek *= 10) {
      for (let m = 1; m <= 9; m++) {
        const f = dek * m;
        if (f < fA || f > fB) continue;
        const x = fx(f);
        g.strokeStyle = m === 1 ? 'rgba(255,236,214,.13)' : 'rgba(255,236,214,.045)';
        g.beginPath(); g.moveTo(x, oben); g.lineTo(x, unten); g.stroke();
        const zeigen = m === 1 || m === 2 || m === 5 || (pxProOkt > 170 * dpr) || (pxProOkt > 75 * dpr && m === 3);
        if (zeigen) { g.fillStyle = m === 1 ? fb.text : fb.leise; g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), Math.min(x, rechts - 9 * dpr), unten + 3 * dpr); }
      }
    }
    // Oktaven (C) als dezente Marken unten im Bild
    g.fillStyle = 'rgba(156,143,130,.45)'; g.textAlign = 'left'; g.textBaseline = 'bottom';
    for (let o = 0; o <= 10; o++) { const f = 16.3516 * Math.pow(2, o); if (f >= fA && f <= fB && pxProOkt > 26 * dpr) g.fillText(`C${o}`, fx(f) + 2 * dpr, unten - 2 * dpr); }
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let db = -96; db <= -12; db += 12) {
      g.strokeStyle = 'rgba(255,236,214,.05)'; g.beginPath(); g.moveTo(links, fy(db)); g.lineTo(rechts, fy(db)); g.stroke();
      g.fillStyle = fb.leise; g.fillText(String(db).replace('-', '−'), links - 5 * dpr, fy(db));
    }
    // Spalten (alle 2 px) mit 1/24-Oktave-Band; ist das Band schmaler als ein FFT-Wert (tiefer Bass beim Zoomen),
    // wird zwischen den Werten interpoliert
    const spalten = Math.max(2, Math.round((rechts - links) / (2 * dpr)));
    const halb = Math.pow(2, 1 / 48);
    const binHz = rate / fft;
    const tiltAn = this.ansicht.neigung;
    const wert = (daten, fc) => {
      const b0 = (fc / halb) / binHz, b1 = (fc * halb) / binHz;
      let i0 = Math.ceil(b0), i1 = Math.floor(b1);
      if (i1 < i0) {
        const b = fc / binHz, j = Math.floor(b), t = b - j;
        const a = daten[Math.max(0, Math.min(n - 1, j))], c2 = daten[Math.max(0, Math.min(n - 1, j + 1))];
        return a + (c2 - a) * t;
      }
      i0 = Math.max(0, i0); i1 = Math.min(n - 1, i1);
      let summe = 0;
      for (let i = i0; i <= i1; i++) summe += Math.pow(10, daten[i] / 10);
      return 10 * Math.log10(summe / (i1 - i0 + 1) + 1e-30);
    };
    const kurven = reihen.map(([name, daten, dl, dr]) => {
      const werte = new Float32Array(spalten);
      for (let s = 0; s < spalten; s++) {
        const fc = xf(links + ((s + 0.5) / spalten) * (rechts - links));
        let v = daten ? wert(daten, fc) : 10 * Math.log10((Math.pow(10, wert(dl, fc) / 10) + Math.pow(10, wert(dr, fc) / 10)) / 2 + 1e-30);
        if (tiltAn) v += 4.5 * Math.log2(fc / 1000);
        werte[s] = Math.max(-160, v);
      }
      return { name, werte };
    });
    const sx = (s) => links + ((s + 0.5) / spalten) * (rechts - links);
    // Peak-Hold der ersten Kurve
    const haupt = kurven[0].werte;
    if (this.ansicht.halten) {
      if (!this.spHalten || this.spHalten.length !== spalten) this.spHalten = Float32Array.from(haupt);
      for (let s = 0; s < spalten; s++) this.spHalten[s] = Math.max(haupt[s], this.spHalten[s] - 0.12);
    }
    const farbenK = [fb.akzent, '#7fd4ff'];
    // Fläche unter der ersten Kurve
    const verlauf = g.createLinearGradient(0, oben, 0, unten);
    verlauf.addColorStop(0, 'rgba(255,181,71,.42)'); verlauf.addColorStop(0.65, 'rgba(255,122,61,.12)'); verlauf.addColorStop(1, 'rgba(255,122,61,0)');
    g.beginPath(); g.moveTo(links, unten);
    for (let s = 0; s < spalten; s++) g.lineTo(sx(s), fy(haupt[s]));
    g.lineTo(rechts, unten); g.closePath(); g.fillStyle = verlauf; g.fill();
    // Linien (zweite Kurve zuerst, damit die erste oben liegt)
    for (let j = kurven.length - 1; j >= 0; j--) {
      const werte = kurven[j].werte;
      g.beginPath();
      for (let s = 0; s < spalten; s++) { const py = fy(werte[s]); if (s) g.lineTo(sx(s), py); else g.moveTo(sx(s), py); }
      g.strokeStyle = farbenK[j]; g.lineWidth = 1.5 * dpr; g.lineJoin = 'round';
      if (j === 0) { g.shadowColor = 'rgba(255,181,71,.55)'; g.shadowBlur = 6 * dpr; }
      g.stroke(); g.shadowBlur = 0;
    }
    if (this.ansicht.halten && this.spHalten) {
      g.beginPath();
      for (let s = 0; s < spalten; s++) { const py = fy(this.spHalten[s]); if (s) g.lineTo(sx(s), py); else g.moveTo(sx(s), py); }
      g.strokeStyle = 'rgba(245,236,226,.5)'; g.lineWidth = dpr; g.stroke();
    }
    // Legende bei zwei Kurven
    if (kurven.length > 1) {
      g.textAlign = 'right'; g.textBaseline = 'top'; g.font = `600 ${10 * dpr}px system-ui, sans-serif`;
      kurven.forEach((kv, j) => { g.fillStyle = farbenK[j]; g.fillText(kv.name, rechts - 6 * dpr - (kurven.length - 1 - j) * 22 * dpr, oben + 4 * dpr); });
    }
    if (fA > 20.5 || fB < 19999) {
      g.textAlign = 'left'; g.textBaseline = 'top'; g.fillStyle = fb.leise; g.font = `${9.5 * dpr}px system-ui, sans-serif`;
      g.fillText(t('Zoom {a} – {b} · Doppelklick: alles', { a: hzText(fA), b: hzText(fB) }), links + 6 * dpr, oben + 4 * dpr);
    }
    // Wert ablesen: Maus oder eingefrorene Frequenz
    const f = this.spMaus || this.spFix;
    if (f && f >= fA && f <= fB) {
      const s = Math.max(0, Math.min(spalten - 1, Math.floor(((fx(f) - links) / (rechts - links)) * spalten)));
      const x = fx(f);
      g.strokeStyle = this.spFix && !this.spMaus ? 'rgba(127,212,255,.7)' : 'rgba(246,239,231,.5)';
      g.setLineDash([3 * dpr, 3 * dpr]); g.lineWidth = dpr;
      g.beginPath(); g.moveTo(x, oben); g.lineTo(x, unten); g.stroke(); g.setLineDash([]);
      g.fillStyle = '#fff'; g.beginPath(); g.arc(x, fy(haupt[s]), 3 * dpr, 0, 7); g.fill();
      const dbT = (v) => (v <= -140 ? '–' : k(v));
      const zweite = kurven[1] ? ` · ${kurven[1].name} ${dbT(kurven[1].werte[s])}` : '';
      tip.hidden = false;
      tip.innerHTML = `<b>${hzText(f)}</b> <small>${note(f)}</small> · ${kurven[0].name} <b>${dbT(haupt[s])} dB</b>${zweite}${this.ansicht.halten && this.spHalten ? ` <small>· Peak ${dbT(this.spHalten[s])}</small>` : ''}${this.spFix && !this.spMaus ? ` <small>· ${t('eingefroren')}</small>` : ''}`;
      const xp = x / dpr, breite = tip.offsetWidth || 260;
      tip.style.left = `${xp + 12 + breite > c.clientWidth ? xp - 12 - breite : xp + 12}px`;
      tip.style.top = `${Math.max(4, fy(haupt[s]) / dpr - 40)}px`;
    } else tip.hidden = true;
  }
}
