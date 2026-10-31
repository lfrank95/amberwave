// Player-Leiste unten und die Vollbild-Ansicht „Läuft gerade“ (mit „Wer spielt hier?“, Signalweg und Warteschlange).
import { laufschrift } from './laufschrift.js';
import { api } from './api.js';
import { nativ, ausgabeWeg, istAsio, titelFarbe } from './nativ.js';
import { h, icon, dauer, kuenstlerLinks, kuenstlerText, menue, initialen } from './ui.js';
import { t, tn, zahl, locale } from './i18n.js';
import { QUALITAETEN, LAUTHEIT_ZIELE } from './player.js';
import { RAUMKLANG_PRESETS, ausgabeKanaele, layoutFuer } from './raumklang.js';
import { Pegel } from './pegel.js';
import { netzweg } from './netzweg.js';
import { eqWirksam, eqKurzText } from './eq.js';
import { formatText, spieltAnzeige, typZeile, eBadge } from './bausteine.js';
import { zurPlaylist } from './ansichten.js';
import { exportDialog } from './export.js';
import { raumklangMenueSchliessen } from './raumklangmenue.js';
import { waermeWirksam, waermeKurzText } from './waerme.js';
import { bandWirksam, bandKurzText } from './band.js';
import { trafoWirksam, trafoKurzText } from './trafo.js';
import { KLANG, klangIconKlein, klangKartenEinrichten, klangListeEinrichten } from './klangfamilie.js';
import { vstRack } from './vstrack.js';
import { symbolSvg, symbolVon, ausgangName, layoutKurz, treiberVon } from './ausgaenge.js';
import { Plattenkiste, gruppenVon } from './plattenkiste.js';

/** Original unverändert – auch offline in Originalqualität gespeichert (Android-App) */
const istOriginal = (p) => p.modus?.art === 'original' || p.modus?.qualitaet === 'original';
const QUALI_KURZ = { opus256: 'Opus 256', opus160: 'Opus 160', opus128: 'Opus 128', aac256: 'AAC 256', aac160: 'AAC 160' };

/** Stufe der Qualitätsanzeige als Wort: bitgenau / klanglich unverändert / verändert */
const stufeText = (bw) => (bw.stufe === 'bitgenau' ? t('bitgenau') : bw.stufe === 'transparent' ? t('klanglich unverändert') : t('verändert'));

/** Inhalt der Seite einmal komplett neu zeichnen lassen (verwirft alte Compositor-Kacheln) */
function seiteNeuZeichnen() {
  const el = document.getElementById('inhalt');
  if (!el) return;
  // Deckkraft knapp unter 1 zwingt Chromium, den Bereich neu zu rastern (anders als transform ändert es nichts an
  // fest positionierten Elementen darin)
  el.style.opacity = '0.999';
  requestAnimationFrame(() => requestAnimationFrame(() => { el.style.opacity = ''; }));
}

export class PlayerLeiste {
  constructor(app, player) {
    this.app = app;
    this.player = player;
    this.el = document.getElementById('player');
    this.jetzt = null;
    this.ziehen = false;
    this.creditsCache = new Map();
    this.pegel = new Pegel(player);
    // Analyse (Nerd) und Effektrack erst laden, wenn sie geöffnet werden – zusammen 150 KB Skript, die beim Start sonst mitliefen
    this.nerd = {
      offen: false, aktuelle: null,
      umschalten: () => this.nerdLaden().then((n) => n.umschalten()),
      schliessen: () => {},
    };
    this.rack = {
      presets: null,
      flyout: (anker, art) => this.rackLaden().then((r) => r.flyout(anker, art)),
      vollbild: (art) => this.rackLaden().then((r) => r.vollbild(art)),
      vollbildUmschalten: () => this.rackLaden().then((r) => r.vollbildUmschalten()),
    };
    this.bauen();
    // „track“ und „liste“ kommen beim Titelwechsel direkt hintereinander: einmal gebündelt nachziehen statt alles doppelt
    // (die Player-Leiste und „Läuft gerade“ wurden zweimal aufgebaut – mitten im Einfahren der CD)
    const plan = { a: false, tr: false, ws: false, offen: false };
    const nachziehen = () => {
      plan.offen = false;
      const { a, tr, ws } = plan;
      plan.a = plan.tr = plan.ws = false;
      if (a) this.aktualisieren();
      if (ws) this.jetztWarteschlange();
      if (tr) this.jetztTrack();   // (trackMarkieren steckt in aktualisieren)
    };
    const planen = () => { if (!plan.offen) { plan.offen = true; queueMicrotask(nachziehen); } };
    player.addEventListener('zustand', () => { plan.a = true; planen(); });
    player.addEventListener('track', () => { plan.a = plan.tr = true; planen(); });
    player.addEventListener('liste', () => { plan.a = plan.ws = true; planen(); });
    player.addEventListener('zeit', () => this.zeit());
    player.addEventListener('lautstaerke', () => this.lautstaerke());
    player.addEventListener('netz', () => { this.aktualisieren(); if (this.blatt) this.blattFuellen(); });
    document.addEventListener('keydown', (e) => this.tasten(e));
    // Zurück im Verlauf: zuerst „Läuft gerade“ schließen (vor dem Router der App registriert → kann ihn anhalten)
    window.addEventListener('popstate', (e) => {
      if (this.popIgnorieren) { this.popIgnorieren = false; e.stopImmediatePropagation(); return; }
      if (this.jetzt && !e.state?.jetzt) { e.stopImmediatePropagation(); this.jetztSchliessen(true); }
    });
    // Foldable auf- oder zugeklappt, während „Läuft gerade“ offen ist: rechte Hälfte gleich füllen
    // (aw-falz kommt bei jeder Prüfung – auch wenn sich nur die Haltung ändert, ohne dass das Fenster seine Größe ändert)
    window.addEventListener('aw-falz', () => {
      // Tisch-Modus: Fold aufgestellt → „Läuft gerade“ öffnet sich von selbst (oben Kiste, unten Steuerung),
      // flach oder zu → wieder schließen, wenn wir es geöffnet hatten. Nur beim Wechsel der Haltung, damit
      // Schließen von Hand respektiert wird.
      const tisch = document.documentElement.classList.contains('falz-tisch');
      if (tisch !== !!this.warTisch) {
        this.warTisch = tisch;
        if (tisch && !this.jetzt && this.player.track) { this.jetztOeffnen(); this.tischAuto = true; }
        else if (!tisch && this.tischAuto) { this.tischAuto = false; if (this.jetzt) this.jetztSchliessen(); }
        if (this.jetzt) setTimeout(() => this.kiste?.messen(), 50);
      }
      if (!this.jetzt) return;
      const zwei = document.documentElement.classList.contains('zwei-haelften');
      if (zwei && !this.blatt) this.blattOeffnen(this.blattZuletzt || 'naechstes');
      if (zwei) this.haelfteSetzen(this.ohneBlatt()); else this.jetzt.classList.remove('ohne-blatt');
    });
    this.aktualisieren();
  }

  bauen() {
    // Streifen „Spielt auf …“ über der Leiste (eigenes Element: die Leiste schneidet am Handy ab)
    if (!document.querySelector('.leiste-fern-band')) {
      const band = document.createElement('div');
      band.className = 'fern-band leiste-fern-band';
      band.dataset.fernBand = '';
      band.hidden = true;
      document.body.appendChild(band);
    }
    this.el.innerHTML = `
      <div class="player-zeit-mini"><i style="width:0"></i></div>
      <div class="player-titel">
        <button type="button" class="mini-cover" data-jetzt aria-label="${t('Läuft gerade öffnen')}"></button>
        <div class="texte" data-jetzt-text style="cursor:pointer"><div class="t">${t('Nichts ausgewählt')}</div><div class="k">${t('Wähle ein Album oder einen Titel')}</div></div>
      </div>
      <div class="player-mitte">
        <div class="player-knoepfe">
          <button type="button" class="btn-ico nur-gross fav-knopf" data-fav aria-label="${t('Titel merken')}" aria-pressed="false">${icon('herz', 18)}</button>
          <button type="button" class="btn-ico nur-gross" data-zufall aria-label="${t('Zufallswiedergabe')}">${icon('zufall', 18)}</button>
          <button type="button" class="btn-ico nur-gross" data-zurueck aria-label="${t('Vorheriger Titel')}">${icon('zurueck', 20)}</button>
          <button type="button" class="btn-ico fern-knopf nur-klein" data-fern="klein" aria-haspopup="dialog" aria-expanded="false" aria-label="${t('Wiedergabe auf …')}">${icon('geraete', 19)}</button>
          <button type="button" class="play-knopf" data-play aria-label="${t('Abspielen')}">${icon('play', 22)}</button>
          <button type="button" class="btn-ico" data-weiter aria-label="${t('Nächster Titel')}">${icon('weiter', 20)}</button>
          <button type="button" class="btn-ico nur-gross" data-wdh aria-label="${t('Wiederholen')}">${icon('wiederholen', 18)}</button>
          <button type="button" class="btn-ico nur-gross" data-stopp aria-label="${t('Stopp (an den Anfang)')}" title="${t('Stopp')}">${icon('stopp', 18)}</button>
        </div>
        <div class="zeitleiste"><span data-zeit>0:00</span><input type="range" class="regler" data-pos min="0" max="1000" value="0" step="1" aria-label="${t('Position im Titel')}"><span data-dauer>0:00</span></div>
      </div>
      <div class="player-rechts">
        <canvas class="pegel nur-gross" data-pegel hidden aria-hidden="true"></canvas>
        <button type="button" class="qualitaet-chip schlank" data-quali data-menue-anker title="${t('Wiedergabe-Qualität')}"><i></i><span>–</span></button>
        <div class="klang-leiste nur-pc" role="group" aria-label="${t('Klang')}">
          <button type="button" class="klang-k" data-wm-leiste aria-haspopup="dialog" aria-expanded="false" title="${t('AmberGlow – Röhrensättigung')}">${klangIconKlein('glow', 18)}<span class="klang-t" data-wm-leiste-text>Glow</span></button>
          <button type="button" class="klang-k" data-tr-leiste aria-haspopup="dialog" aria-expanded="false" title="${t('AmberIron – Übertrager')}">${klangIconKlein('iron', 18)}<span class="klang-t" data-tr-leiste-text>Iron</span></button>
          <button type="button" class="klang-k" data-bd-leiste aria-haspopup="dialog" aria-expanded="false" title="${t('AmberSilk – Bandsättigung')}">${klangIconKlein('silk', 18)}<span class="klang-t" data-bd-leiste-text>Silk</span></button>
          <button type="button" class="klang-k" data-rk-leiste aria-haspopup="dialog" aria-expanded="false" title="${t('AmberSpace – Räumliche Wiedergabe')}">${klangIconKlein('space', 18)}<span class="klang-t" data-rk-leiste-text>Space</span></button>
          <button type="button" class="klang-k" data-eq-leiste aria-haspopup="dialog" aria-expanded="false" title="${t('Equalizer')}">${icon('regler', 16)}<span class="klang-t">EQ</span></button>
        </div>
        <button type="button" class="klang-k klang-rack nur-pc" data-rack-leiste aria-pressed="false" title="${t('Effektrack: alle Geräte im Vollbild (nochmal klicken: schließen)')}"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.5h18M3 14.5h18"/><path d="M6 6.8h.01M6 12h.01M6 17.2h.01" stroke-width="2.6"/></svg><span class="klang-t">${t('Effektrack')}</span></button>
        <button type="button" class="btn-ico nur-pc" data-nerd aria-label="${t('Analyse (Taste A)')}" title="${t('Analyse: Signalweg, Lautheitskurve, Spektrum, alle Messwerte (Taste A)')}">${icon('nerd', 18)}</button>
        <button type="button" class="btn-ico fern-knopf" data-fern aria-haspopup="dialog" aria-expanded="false" aria-label="${t('Wiedergabe auf …')}">${icon('geraete', 19)}</button>
        <button type="button" class="btn-ico" data-ws aria-label="${t('Warteschlange')}">${icon('warteschlange', 18)}</button>
        <button type="button" class="btn-ico" data-stumm aria-label="${t('Stumm schalten')}">${icon('lautstaerke', 18)}</button>
        <input type="range" class="regler" data-vol min="0" max="100" step="1" aria-label="${t('Lautstärke')}">
      </div>`;
    const $ = (s) => this.el.querySelector(s);
    this.pegel.anmelden($('[data-pegel]'));
    $('[data-play]').addEventListener('click', () => this.player.umschalten());
    $('[data-weiter]').addEventListener('click', () => this.player.weiter());
    $('[data-zurueck]').addEventListener('click', () => this.player.zurueck());
    $('[data-zufall]').addEventListener('click', () => this.player.zufallUmschalten());
    $('[data-wdh]').addEventListener('click', () => this.player.wiederholenUmschalten());
    $('[data-stopp]').addEventListener('click', () => this.player.stoppen());
    $('[data-fav]').addEventListener('click', () => this.trackFavorit());
    $('[data-jetzt]').addEventListener('click', () => this.jetztOeffnen());
    $('[data-jetzt-text]').addEventListener('click', (e) => { if (!e.target.closest('a')) this.jetztOeffnen(); });
    $('[data-ws]').addEventListener('click', () => this.jetztOeffnen(true));
    this.el.querySelectorAll('[data-fern]').forEach((b) => b.addEventListener('click', (e) => this.app.fern?.listeOeffnen(e.currentTarget)));
    $('[data-quali]').addEventListener('click', (e) => this.qualitaetMenue(e.currentTarget));
    // Klang-Knöpfe: je ein Flyout mit genau diesem Gerät; „Rack“ öffnet das ganze Effektrack im Vollbild
    for (const [sel, art] of [['[data-wm-leiste]', 'glow'], ['[data-tr-leiste]', 'iron'], ['[data-bd-leiste]', 'silk'], ['[data-rk-leiste]', 'space'], ['[data-eq-leiste]', 'eq']]) {
      $(sel).addEventListener('click', (e) => { raumklangMenueSchliessen(); this.rack.flyout(e.currentTarget, art); });
    }
    $('[data-rack-leiste]').addEventListener('click', () => { raumklangMenueSchliessen(); this.rack.vollbildUmschalten(); });
    $('[data-nerd]').addEventListener('click', () => this.nerd.umschalten());
    $('[data-stumm]').addEventListener('click', () => { this.player.audio.muted = !this.player.audio.muted; this.lautstaerke(); });
    this.reglerVerbinden($('[data-pos]'));
    const vol = $('[data-vol]');
    vol.addEventListener('input', () => { this.player.audio.muted = false; this.player.lautstaerkeSetzen(vol.value / 100); this.lautstaerke(); });
    this.lautstaerke();
  }

  reglerVerbinden(regler) {
    regler.addEventListener('input', () => {
      this.ziehen = true;
      const sek = (regler.value / 1000) * this.player.dauer;
      regler.style.setProperty('--wert', `${regler.value / 10}%`);
      const z = regler.parentElement.querySelector('[data-zeit]');
      if (z) z.textContent = dauer(sek * 1000);
    });
    regler.addEventListener('change', () => {
      this.ziehen = false;
      this.player.springen((regler.value / 1000) * this.player.dauer);
    });
  }

  tasten(e) {
    if (e.defaultPrevented) return; // schon von einem offenen Menü (z. B. AmberGlow) behandelt
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') && document.activeElement.type !== 'range') return;
    if (document.querySelector('dialog[open]')) return;
    if (e.key === ' ' && !e.target.closest('button, a')) { e.preventDefault(); this.player.umschalten(); }
    else if (e.key === 'Escape' && this.nerd?.offen) this.nerd.schliessen();
    else if (e.key === 'Escape' && this.jetzt) { if (this.blatt) this.blattSchliessen(); else this.jetztSchliessen(); }
    else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); this.player.weiter(); }
    else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); this.player.zurueck(); }
    else if ((e.key === 'u' || e.key === 'U') && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); this.player.raumklangUmschalten().then(() => this.aktualisieren()); }
    else if (['a', 'A', 'n', 'N'].includes(e.key) && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); this.nerd.umschalten(); }
    else if (e.key === 'Escape' && this.nerd.offen) this.nerd.schliessen();
  }

  /** Ganz kurz für die Player-Leiste: „FLAC“, „FLAC Hi-Res“, „Opus 160“ */
  qualitaetKurz() {
    const p = this.player;
    if (!p.track || !p.modus) return '–';
    if (!istOriginal(p)) return (QUALI_KURZ[p.modus.qualitaet] || p.modus.qualitaet).replace(/\s*kbit\/s/, '');
    const f = p.track.format;
    if (!f) return 'Original';
    const name = f.codec === 'alac' ? 'ALAC' : (f.datei || f.codec || '').toUpperCase();
    return f.bittiefe > 16 || f.abtastrate > 48000 ? `${name} Hi-Res` : name;
  }

  /**
   * Qualitätsanzeige in drei Stufen:
   *  – 'bitgenau' (grün mit Ring): was in der Datei steht, geht unverändert ans Interface (nur der Windows Client exklusiv)
   *  – 'transparent' (grün): nur Pegel (Lautstärke, Lautheitsangleich) in hoher Auflösung bzw. Betriebssystem mischt ohne
   *    umzurechnen – klanglich unverändert, aber nicht bitgenau
   *  – 'veraendert' (gelb): echter Eingriff – verlustbehaftet übertragen, Abtastrate umgerechnet, Effekte/Space,
   *    Heruntermischen, Pegeländerung bei nur 16 Bit Ausgabe
   * Rückgabe { stufe, grund }.
   */
  bewertung() {
    const p = this.player;
    if (!p.track || !p.modus) return { stufe: 'transparent', grund: '' };
    const khz = (r) => `${(r / 1000).toLocaleString(locale)} kHz`;
    if (!istOriginal(p)) return { stufe: 'veraendert', grund: t('verlustbehaftet übertragen ({q} kbit/s)', { q: QUALI_KURZ[p.modus.qualitaet] || p.modus.qualitaet }) };
    const rk = p.raumklang;
    const effekte = rk?.angeschlossen && !p.bypass ? (p.einst.reihe || []).filter((a) => rk.stufeWirksam(a)).map((a) => ({ glow: 'Glow', iron: 'Iron', silk: 'Silk', eq: 'EQ' })[a] || vstRack.finde(a)?.name) : [];
    if (rk?.aktiv) effekte.push('Space');
    if (effekte.length) return { stufe: 'veraendert', grund: t('Klang bearbeitet: {liste}', { liste: effekte.join(', ') }) };
    if (p.nativ) {
      const f = p.audio.format;
      if (!f) return { stufe: 'transparent', grund: '' };
      if (f.aus_kanaele < f.kanaele) return { stufe: 'veraendert', grund: t('auf {n} Kanäle heruntergemischt', { n: f.aus_kanaele }) };
      if (f.umgerechnet) return { stufe: 'veraendert', grund: t('feste Ausgaberate: {von} → {nach} umgerechnet', { von: khz(f.rate), nach: khz(f.aus_rate) }) };
      if (!f.exklusiv) {
        const gr = f.geraet_rate || f.aus_rate;
        if (gr && Math.abs(gr - f.rate) > 1) return { stufe: 'veraendert', grund: `${t('Windows rechnet {von} → {nach} um (geteilt)', { von: khz(f.rate), nach: khz(gr) })}${f.hinweis ? ` – ${f.hinweis}` : ''}` };
        return { stufe: 'transparent', grund: f.hinweis || t('geteilt: Windows mischt mit, ohne umzurechnen') };
      }
      if (p.audio.bitgenau) return { stufe: 'bitgenau', grund: t('die Datei geht unverändert ans Interface') };
      if (f.aus_format === '16 Bit') return { stufe: 'veraendert', grund: t('Pegel geändert bei nur 16 Bit Ausgabe (Dither hörbar nah am Rauschen der Aufnahme)') };
      return { stufe: 'transparent', grund: t('Pegel angepasst (Lautstärke/Angleich, 64 Bit gerechnet, Dither auf 24 Bit) – klanglich unverändert, nicht bitgenau') };
    }
    const ctx = rk?.ctx;
    const rate = p.track.format?.abtastrate || this.nerd?.aktuelle?.datei?.abtastrate || 0;
    if (ctx && rate && Math.abs(ctx.sampleRate - rate) > 1) {
      return { stufe: 'veraendert', grund: t('Browser rechnet {von} → {nach} um', { von: khz(rate), nach: khz(ctx.sampleRate) }) };
    }
    return { stufe: 'transparent', grund: t('Browser und Betriebssystem geben aus – bitgenau nur im Windows Client (exklusiv)') };
  }

  /** Grund für Gelb – oder null */
  verschlechterung() {
    const b = this.bewertung();
    return b.stufe === 'veraendert' ? b.grund : null;
  }

  unveraendert() { return !this.verschlechterung(); }

  /** Klassen der Anzeige setzen: bitgenau (Ring) / transparent (grün) / sonst gelb */
  stufeSetzen(el) {
    const b = this.bewertung();
    el.classList.toggle('bitgenau', b.stufe !== 'veraendert');
    el.classList.toggle('ring', b.stufe === 'bitgenau');
    return b;
  }

  /** Text für die Qualitäts-Anzeige */
  qualitaetText() {
    const p = this.player;
    if (!p.track || !p.modus) return { text: '–', gut: false };
    if (istOriginal(p)) {
      const f = p.nativ ? p.audio.format : null;
      const weg = f ? ` · ${ausgabeWeg(f)}${p.audio.bitgenau && f.exklusiv ? ` · ${t('bitgenau')}` : ''} · ${f.asio ? f.geraet.replace(/^ASIO · /, '') : f.geraet}` : '';
      return { text: (formatText(p.track.format) || 'Original') + weg, gut: true };
    }
    return { text: QUALI_KURZ[p.modus.qualitaet] || p.modus.qualitaet, gut: false };
  }

  aktualisieren() {
    const p = this.player;
    const trk = p.track;
    const $ = (s) => this.el.querySelector(s);
    this.el.classList.toggle('leer-player', !trk);
    $('[data-jetzt]').innerHTML = trk?.album?.cover ? `<img src="${h(trk.album.cover)}" alt="">` : '';
    $('.player-titel .t').innerHTML = trk ? h(trk.titel) + eBadge(trk.explizit) : t('Nichts ausgewählt');
    $('.player-titel .k').innerHTML = trk ? kuenstlerLinks(trk.kuenstler) : t('Wähle ein Album oder einen Titel');
    laufschrift($('.player-titel .t'));
    laufschrift($('.player-titel .k'));
    const spielt = p.spielt;
    const play = $('[data-play]');
    play.innerHTML = icon(spielt ? 'pause' : 'play', 22);
    play.setAttribute('aria-label', spielt ? t('Pause') : t('Abspielen'));
    $('[data-zufall]').classList.toggle('an', !!p.einst.zufall);
    const fav = $('[data-fav]');
    fav.innerHTML = icon(trk?.favorit ? 'herzVoll' : 'herz', 18);
    fav.classList.toggle('an', !!trk?.favorit);
    fav.setAttribute('aria-pressed', trk?.favorit ? 'true' : 'false');
    this.jetzt?.querySelector('[data-eq-jetzt]')?.classList.toggle('an', eqWirksam(p.einst.eq));
    const wdh = $('[data-wdh]');
    wdh.classList.toggle('an', p.einst.wiederholen !== 'aus');
    wdh.innerHTML = icon(p.einst.wiederholen === 'eins' ? 'wiederholen1' : 'wiederholen', 18);
    wdh.setAttribute('aria-label', { aus: t('Wiederholen: aus'), alle: t('Wiederholen: alle'), eins: t('Wiederholen: diesen Titel') }[p.einst.wiederholen]);
    this.lautheitChip();
    $('[data-nerd]')?.classList.toggle('an', this.nerd?.offen);
    const q = this.qualitaetText();
    const chip = $('[data-quali]');
    // Schlank: nur Format bzw. Stream-Qualität und ein Punkt (grün = unverändert); Details in der Analyse
    chip.querySelector('span').textContent = this.qualitaetKurz();
    const bw = this.stufeSetzen(chip);
    chip.title = t('{text} – {stufe}{grund} · Klick: Qualität wählen · Details: Analyse (A)', { text: q.text, stufe: stufeText(bw), grund: bw.grund ? `: ${bw.grund}` : '' });
    this.klangKnoepfe();
    this.zeit();
    this.trackMarkieren();
    if (this.jetzt) this.jetztAktualisieren();
    this.app.fern?.ui();
  }

  /** EQ- und Raumklang-Knopf in der Leiste: aktiv = gefüllt; Raumklang zeigt das Preset */
  klangKnoepfe() {
    const p = this.player;
    const eq = this.el.querySelector('[data-eq-leiste]');
    const rk = this.el.querySelector('[data-rk-leiste]');
    if (!eq || !rk) return;
    const wm = this.el.querySelector('[data-wm-leiste]');
    if (wm) {
      const wmAn = waermeWirksam(p.einst.waerme);
      wm.classList.toggle('an', wmAn);
      wm.setAttribute('aria-pressed', String(wmAn));
      wm.querySelector('[data-wm-leiste-text]').textContent = wmAn ? `Glow · ${waermeKurzText(p.einst.waerme)}` : 'Glow';
      wm.title = wmAn ? t('AmberGlow · {wert} – Klick öffnet das Menü', { wert: waermeKurzText(p.einst.waerme) }) : t('AmberGlow (Röhrensättigung) aus – Klick öffnet das Menü');
    }
    const tr = this.el.querySelector('[data-tr-leiste]');
    if (tr) {
      const trAn = trafoWirksam(p.einst.trafo);
      tr.classList.toggle('an', trAn);
      tr.setAttribute('aria-pressed', String(trAn));
      tr.querySelector('[data-tr-leiste-text]').textContent = trAn ? `Iron · ${trafoKurzText(p.einst.trafo)}` : 'Iron';
      tr.title = trAn ? t('AmberIron · {wert} – Klick öffnet das Menü', { wert: trafoKurzText(p.einst.trafo) }) : t('AmberIron (Übertrager) aus – Klick öffnet das Menü');
    }
    const bd = this.el.querySelector('[data-bd-leiste]');
    if (bd) {
      const bdAn = bandWirksam(p.einst.band);
      bd.classList.toggle('an', bdAn);
      bd.setAttribute('aria-pressed', String(bdAn));
      bd.querySelector('[data-bd-leiste-text]').textContent = bdAn ? `Silk · ${bandKurzText(p.einst.band)}` : 'Silk';
      bd.title = bdAn ? t('AmberSilk · {wert} – Klick öffnet das Menü', { wert: bandKurzText(p.einst.band) }) : t('AmberSilk (Bandsättigung) aus – Klick öffnet das Menü');
    }
    const eqAn = eqWirksam(p.einst.eq);
    eq.classList.toggle('an', eqAn);
    eq.setAttribute('aria-pressed', String(eqAn));
    eq.title = eqAn ? t('Equalizer an: {wert}', { wert: eqKurzText(p.einst.eq) }) : t('Equalizer (aus)');
    const aktiv = p.einst.raumklang !== 'aus' && !!p.raumklang.aktiv;
    const name = RAUMKLANG_PRESETS[p.einst.raumklang]?.name;
    const layout = layoutFuer(p.raumklang.ctx ? p.raumklang.ctx.destination.maxChannelCount : ausgabeKanaele());
    rk.classList.toggle('an', aktiv);
    rk.querySelector('[data-rk-leiste-text]').textContent = aktiv && name ? `Space · ${name}` : 'Space';
    rk.title = aktiv ? t('AmberSpace · {name}: Stereo → {layout} (Taste U schaltet um)', { name, layout: p.raumklang.layout?.name || '' }) : layout ? t('AmberSpace aus – Klick öffnet das Menü (Taste U schaltet um)') : t('AmberSpace – dieser Ausgang ist nur Stereo');
  }

  zeit() {
    const p = this.player;
    const d = p.dauer;
    const z = p.anzeigeZeit;
    const anteil = d > 0 ? Math.min(1, z / d) : 0;
    for (const wurzel of [this.el, this.jetzt].filter(Boolean)) {
      const regler = wurzel.querySelector('[data-pos]');
      if (regler && !this.ziehen) {
        regler.value = Math.round(anteil * 1000);
        regler.style.setProperty('--wert', `${anteil * 100}%`);
        const zeitEl = wurzel.querySelector('[data-zeit]');
        if (zeitEl) zeitEl.textContent = dauer(z * 1000);
      }
      const dEl = wurzel.querySelector('[data-dauer]');
      if (dEl) dEl.textContent = dauer(d * 1000);
    }
    const mini = this.el.querySelector('.player-zeit-mini i');
    if (mini) mini.style.width = `${anteil * 100}%`;
  }

  lautstaerke() {
    const a = this.player.audio;
    const vol = this.el.querySelector('[data-vol]');
    const w = a.muted ? 0 : this.player.einst.lautstaerke;
    vol.value = Math.round(w * 100);
    vol.style.setProperty('--wert', `${w * 100}%`);
    this.el.querySelector('[data-stumm]').innerHTML = icon(a.muted || w === 0 ? 'stumm' : 'lautstaerke', 18);
    const jv = this.jetzt?.querySelector('[data-vol-jetzt]');
    if (jv) {
      jv.value = Math.round(w * 100);
      jv.style.setProperty('--wert', `${w * 100}%`);
      this.jetzt.querySelector('[data-stumm-jetzt]').innerHTML = icon(a.muted || w === 0 ? 'stumm' : 'lautstaerke', 20);
    }
  }

  /** Auswahl für den aktuellen Bereich (zuhause/unterwegs); „Automatisch“ zeigt, was es gerade bedeutet */
  qualitaetEintraege() {
    const p = this.player;
    const a = p.autoQualitaet();
    if (p.nativ) {
      // Windows-Client: immer Original; wählbar ist, wie es an die Soundkarte geht
      const ex = !!p.nativAusgabe?.exklusiv;
      if (istAsio(p.nativAusgabe?.geraet)) {
        const f = p.audio.format;
        // Schnellwahl: alle Ausgänge des Treibers (Umschalten ohne Pause, Lautstärke je Ausgang)
        const treiber = treiberVon(p.nativAusgabe.geraet);
        const busse = (p.nativGeraete || []).filter((g) => g.treiber === treiber);
        p.nativGeraeteLaden();   // fürs nächste Mal frisch
        const gw = p.nativAusgabe.geraet.includes('#') ? p.nativAusgabe.geraet : busse[0]?.id;
        const tName = busse[0] ? (busse[0].eigener_name || busse[0].name.replace(/^ASIO · /, '')) : f?.asio ? f.geraet.replace(/^ASIO · /, '') : t('ASIO-Treiber');
        const prozent = (g) => { const v = p.lautstaerkeVon(g.id); return v == null ? '' : ` · ${t('Lautstärke {n} %', { n: Math.round(v * 100) })}`; };
        const wahlen = busse.length && busse[0].ausgang
          ? busse.map((g) => ({ text: ausgangName(g.ausgang), unter: `${layoutKurz(g.ausgang)}${prozent(g)}`, svg: symbolSvg(symbolVon(g.ausgang), 24), an: g.id === gw,
            aktion: () => { if (g.id !== gw) { p.nativAusgabeSetzen({ geraet: g.id }); this.aktualisieren(); } } }))
          : [{ text: t('✓ {name} – bitgenau, an Windows vorbei', { name: tName }), aktion: () => {} }];
        return [
          { titel: t('Ausgang · {name}', { name: tName }) },
          ...wahlen,
          { trenner: true },
          { text: t('Treiber-Einstellungen …'), aktion: () => nativ.senden({ c: 'asio_einstellungen' }) },
          ...(nativ.ausgaengeLesen ? [{ text: t('Ausgänge & Lautsprecher …'), aktion: () => import('./ausgaenge_fenster.js').then(({ ausgaengeFenster }) => ausgaengeFenster({ treiber, name: tName, aktiv: (gw || '').split('#')[1] || '', player: p, nachher: () => { p.ausgangBassLaden(); p.nativGeraeteLaden().then(() => this.aktualisieren()); } })) }] : []),
          { text: t('Zurück zu Windows (WASAPI exklusiv)'), aktion: () => { p.nativAusgabeSetzen({ geraet: '', exklusiv: true }); this.aktualisieren(); } },
          { trenner: true },
          { text: t('Ausgabegerät …'), aktion: () => this.app.navigieren('/einstellungen/ausgabe') },
        ];
      }
      return [
        { titel: t('Ausgabe (Windows)') },
        { text: `${!ex ? '✓ ' : ''}${t('Geteilt – andere Programme bleiben hörbar')}`, aktion: () => { p.nativAusgabeSetzen({ exklusiv: false }); this.aktualisieren(); } },
        { text: `${ex ? '✓ ' : ''}${t('Exklusiv – bitgenau, Amberwave belegt das Gerät')}`, aktion: () => { p.nativAusgabeSetzen({ exklusiv: true }); this.aktualisieren(); } },
        { trenner: true },
        { text: t('Ausgabegerät …'), aktion: () => this.app.navigieren('/einstellungen/ausgabe') },
      ];
    }
    return [
      { titel: p.bereich === 'heim' ? t('Qualität zuhause (dieses Gerät)') : t('Qualität unterwegs (dieses Gerät)') },
      ...QUALITAETEN.map(([w, bez]) => ({
        text: (p.qualitaet === w ? '✓ ' : '') + (w === 'auto' ? t('Automatisch – jetzt {q}', { q: QUALI_KURZ[a.q] || 'Original' }) : bez),
        aktion: () => { p.qualitaetSetzen(w); this.aktualisieren(); },
      })),
      { trenner: true },
      { text: `${t('Effektrack …')}${eqWirksam(p.einst.eq) ? ` (${t('EQ an')})` : ''}`, aktion: () => this.rack.vollbild('eq') },
    ];
  }

  qualitaetMenue(anker) {
    menue(anker, this.qualitaetEintraege());
  }

  /** Kleiner Chip „A +2,6“ (Album-Gain) bzw. „T −4,1“ (Titel-Gain) neben der Qualität – nur am PC */
  lautheitChip() {
    for (const chip of [...this.el.querySelectorAll('[data-lh]'), ...(this.jetzt ? this.jetzt.querySelectorAll('[data-lh]') : [])]) this.lautheitChipSetzen(chip);
  }

  lautheitChipSetzen(chip) {
    const p = this.player;
    const lh = p.track ? p.lautheitFuer(p.track) : null;
    const komma = (x, n = 1) => zahl(x, n).replace('-', '−');
    const lang = chip.dataset.lang !== undefined;
    const ziel = chip.querySelector('[data-lh-text]') || chip;
    if (!lang) chip.hidden = !p.track;
    chip.classList.toggle('aus', !lh || lh.art === 'fehlt');
    chip.classList.toggle('an', !!lh && lh.art !== 'fehlt');
    if (!lh) { ziel.textContent = lang ? t('Lautheit') : t('R128 aus'); chip.title = t('Lautstärke-Angleich aus (bitgenau)'); return; }
    if (lh.art === 'fehlt') { ziel.textContent = lang ? t('Lautheit') : 'R128 –'; chip.title = t('Lautstärke-Angleich an – dieser Titel ist noch nicht gemessen'); return; }
    ziel.textContent = lang ? `${lh.db > 0 ? '+' : lh.db < 0 ? '' : '±'}${komma(lh.db)} dB` : `${lh.art === 'album' ? 'A' : 'T'} ${lh.db > 0 ? '+' : ''}${komma(lh.db)}`;
    chip.title = t('{art} {db} dB · {lufs} LUFS → Ziel {ziel} LUFS', { art: lh.art === 'album' ? t('Album-Gain') : t('Titel-Gain'), db: `${lh.db > 0 ? '+' : ''}${komma(lh.db, 2)}`, lufs: komma(lh.lufs), ziel: komma(lh.ziel, 0) })
      + (lh.begrenzt ? ` · ${t('Anheben begrenzt (True-Peak {tp} dBTP)', { tp: komma(lh.tp) })}` : '') + (lh.quelle === 'tags' ? ` · ${t('vorläufig aus ReplayGain-Tags')}` : '');
  }

  lautheitMenue(anker) {
    const p = this.player;
    const an = p.einst.lautheit !== 'aus';
    const ziel = Number(p.einst.lautheit_ziel) || -16;
    const setzen = async (w) => { await p.lautheitSetzen(w); this.aktualisieren(); this.signalweg(); };
    menue(anker, [
      { titel: t('Lautstärke angleichen (EBU R128)') },
      { text: `${an ? '✓ ' : ''}${t('Automatisch – Album als Ganzes')}`, aktion: () => setzen({ lautheit: 'auto' }) },
      { text: `${!an ? '✓ ' : ''}${t('Aus – bitgenau')}`, aktion: () => setzen({ lautheit: 'aus' }) },
      { trenner: true },
      { titel: t('Zielwert') },
      ...LAUTHEIT_ZIELE.map(([w, t]) => ({ text: `${an && w === ziel ? '✓ ' : ''}${t}`, aktion: () => setzen({ lautheit: 'auto', lautheit_ziel: w }) })),
    ]);
  }

  /** Laufenden Titel in der aktuellen Trackliste markieren */
  trackMarkieren() {
    const t = this.player.track;
    const inhalt = this.app.inhalt;
    if (!inhalt) return;
    inhalt.querySelectorAll('.track.spielt').forEach((z) => {
      if (!t || Number(z.dataset.trackId) !== t.id) {
        z.classList.remove('spielt', 'pausiert');
        const nr = z.querySelector('.track-nr > span');
        if (nr && nr.dataset.nr !== undefined) { nr.textContent = nr.dataset.nr; delete nr.dataset.nr; }
      }
    });
    if (!t) return;
    inhalt.querySelectorAll(`.track[data-track-id="${t.id}"]`).forEach((z) => {
      z.classList.add('spielt');
      z.classList.toggle('pausiert', !this.player.spielt);
      const nr = z.querySelector('.track-nr > span');
      if (nr && nr.dataset.nr === undefined && !nr.querySelector('img')) { nr.dataset.nr = nr.textContent; nr.innerHTML = spieltAnzeige(); }
    });
  }

  // ---------- Läuft gerade ----------
  // Desktop („Bühne“): Cover mittig im Bild, Mitwirkende links, Als Nächstes rechts; unten Signalweg | Steuerung (mittig) | Qualität + Lautstärke.
  // Handy/Tablet: nur Cover + Steuerung; Als Nächstes, Mitwirkende und Technik liegen in einem Blatt von unten.
  jetztOeffnen(warteschlange = false) {
    if (!this.player.track) return;
    if (this.jetzt) { this.jetztSchliessen(); return; }
    document.querySelectorAll('.jetzt.raus').forEach((x) => x.remove());
    titelFarbe('#21150e', 'jetzt');
    const j = document.createElement('div');
    j.className = 'jetzt';
    j.setAttribute('role', 'dialog');
    j.setAttribute('aria-label', t('Läuft gerade'));
    const knopf = (attr, ico, label, gr = 21, klasse = 'btn-ico') => `<button type="button" class="${klasse}" ${attr} aria-label="${label}">${icon(ico, gr)}</button>`;
    j.innerHTML = `
      <div class="fern-band jetzt-fern-band" data-fern-band hidden></div>
      <div class="jetzt-kopf">
        ${knopf('data-zu', 'runter', t('Schließen'), 26)}
        <div class="jetzt-quelle"><small data-quelle-art>${t('Läuft gerade')}</small><span class="q" data-quelle></span><span class="qk" data-quelle-k></span></div>
        <button type="button" class="btn-ico nur-zwei haelfte-knopf" data-haelfte aria-pressed="false" aria-label="${t('Liste ausblenden')}" title="${t('Liste ausblenden – Plattenkiste groß')}">${icon('haelfte', 20)}</button>
        <button type="button" class="btn-ico fern-knopf nur-handy" data-fern="gross" aria-haspopup="dialog" aria-expanded="false" aria-label="${t('Wiedergabe auf …')}">${icon('geraete', 21)}</button>
        <button type="button" class="btn-ico" data-mehr data-menue-anker aria-label="${t('Mehr')}">${icon('mehr', 22)}</button>
      </div>
      <aside class="jetzt-spalte jetzt-links" aria-label="${t('Wer spielt hier?')}">
        <h2 class="jetzt-spalten-titel">${t('Wer spielt hier?')}</h2>
        <div data-credits><div class="lade" style="padding:12px 0"></div></div>
      </aside>
      <section class="jetzt-mitte">
        <div class="jetzt-bild">
          <div class="pk" data-pk tabindex="0" role="group" aria-roledescription="${t('Plattenkiste')}" aria-label="${t('Warteschlange: wischen zum Blättern, doppelt tippen zum Abspielen')}">
            <div class="jetzt-cover" data-cover aria-hidden="true"></div>

            <div class="pk-buehne"><div class="pk-3d" data-pk-3d></div></div>
          </div>
          <div class="jetzt-titel">
            <div class="jetzt-titel-text"><span class="fern-marke" data-fern-marke hidden></span><div class="pk-rolle" data-pk-rolle></div><h1 data-titel></h1><div class="k" data-kuenstler></div><div class="pk-chips" data-pk-chips></div><div class="pk-tipp" data-pk-tipp>${icon('play', 11)} <span data-pk-tipp-text>${t('doppelt tippen zum Abspielen')}</span></div></div>
          </div>
        </div>
        <div class="jetzt-steuerung">
          <!-- dieselben Knöpfe in derselben Reihenfolge wie in der Player-Leiste, links und rechts die Klang-Symbole (nur PC) -->
          <div class="player-knoepfe">
            <span class="klang-gruppe nur-pc">
              <button type="button" class="klang-w" data-wm-jetzt data-menue-anker>${klangIconKlein('glow', 22)}<span data-wm-text>Glow</span></button>
              <button type="button" class="klang-w" data-tr-jetzt data-menue-anker>${klangIconKlein('iron', 22)}<span data-tr-text>Iron</span></button>
              <button type="button" class="klang-w" data-bd-jetzt data-menue-anker>${klangIconKlein('silk', 22)}<span data-bd-text>Silk</span></button>
              <button type="button" class="klang-w" data-rk-jetzt data-menue-anker>${klangIconKlein('space', 22)}<span data-rk-text>Space</span></button>
              <button type="button" class="klang-w" data-eq-jetzt>${icon('regler', 20)}<span data-eq-text>EQ</span></button>
            </span>
            ${knopf('data-fav aria-pressed="false"', 'herz', t('Titel merken'), 20, 'btn-ico fav-knopf')}
            ${knopf('data-zufall', 'zufall', t('Zufallswiedergabe'), 19)}
            ${knopf('data-zurueck', 'zurueck', t('Vorheriger Titel'), 20)}
            <button type="button" class="play-knopf" data-play aria-label="${t('Abspielen')}">${icon('play', 26)}</button>
            ${knopf('data-weiter', 'weiter', t('Nächster Titel'), 20)}
            ${knopf('data-wdh', 'wiederholen', t('Wiederholen'), 18)}
            ${knopf(`data-stopp title="${t('Stopp')}"`, 'stopp', t('Stopp (an den Anfang)'), 19)}
            <span class="klang-gruppe nur-pc">
              <button type="button" class="klang-w" data-lh data-lang data-menue-anker>${icon('messnadel', 21)}<span data-lh-text>${t('Lautheit')}</span></button>
              <button type="button" class="klang-w" data-nerd>${icon('nerd', 19)}<span>${t('Analyse')}</span></button>
            </span>
          </div>
          <div class="zeitleiste"><span data-zeit>0:00</span><input type="range" class="regler" data-pos min="0" max="1000" value="0" aria-label="${t('Position im Titel')}"><span data-dauer>0:00</span></div>
        </div>
        <div class="jetzt-handy-zeile nur-handy">
          <button type="button" class="qualitaet-chip jetzt-signal-chip" data-blatt-auf="technik"><i></i><span data-signal-kurz></span></button>
          <span>
            ${knopf('data-blatt-auf="mitwirkende"', 'kuenstler', t('Mitwirkende'), 22)}
            ${knopf('data-blatt-auf="naechstes"', 'warteschlange', t('Als Nächstes'), 22)}
          </span>
        </div>
        <button type="button" class="jetzt-vorschau nur-handy" data-blatt-auf="naechstes" data-vorschau></button>
      </section>
      <aside class="jetzt-spalte jetzt-rechts-spalte" aria-label="${t('Als Nächstes und Klang')}">
        <div class="jetzt-spalten-kopf">
          <div class="jetzt-reiter" role="tablist">
            <button type="button" role="tab" data-rechts="naechstes" aria-selected="true">${t('Als Nächstes')}</button>
            <button type="button" role="tab" data-rechts="klang" aria-selected="false">${t('Klang')}</button>
          </div>
          <button type="button" class="pille" data-mischen>${icon('zufall', 14)} ${t('Mischen')}</button></div>
        <div class="warteschlange-liste" data-ws></div>
        <div class="kf-box" data-klang-karten hidden></div>
      </aside>
      <div class="jetzt-fuss">
        <button type="button" class="jetzt-signal" data-signal></button>
        <div class="jetzt-fuss-rechts">
          <canvas class="pegel gross" data-pegel-jetzt hidden aria-hidden="true"></canvas>
          <button type="button" class="qualitaet-chip schlank" data-quali-jetzt data-menue-anker title="${t('Wiedergabe-Qualität')}"><i></i><span></span></button>
          <button type="button" class="btn-ico fern-knopf" data-fern="gross" aria-haspopup="dialog" aria-expanded="false" aria-label="${t('Wiedergabe auf …')}">${icon('geraete', 19)}</button>
          ${knopf('data-stumm-jetzt', 'lautstaerke', t('Stumm schalten'), 18)}
          <input type="range" class="regler" data-vol-jetzt min="0" max="100" step="1" aria-label="${t('Lautstärke')}">
        </div>
      </div>
      <div class="jetzt-blatt" data-blatt hidden>
        <button type="button" class="jetzt-blatt-mini" data-blatt-zu aria-label="${t('Zurück zum Player')}">
          <span class="c" data-blatt-cover></span><span class="tx"><b data-blatt-titel></b><small data-blatt-kuenstler></small></span>${icon('runter', 22)}
        </button>
        <div class="jetzt-blatt-flaeche">
          <span class="jetzt-blatt-griff" aria-hidden="true"></span>
          <div class="jetzt-blatt-reiter" role="tablist">
            <button type="button" role="tab" data-reiter="naechstes">${t('Als Nächstes')}</button>
            <button type="button" role="tab" data-reiter="mitwirkende">${t('Mitwirkende')}</button>
            <button type="button" role="tab" data-reiter="klang" class="nur-symbol" aria-label="${t('Klang')}" title="${t('Klang')}">${icon('regler', 19)}</button>
            <button type="button" role="tab" data-reiter="technik" class="nur-symbol" aria-label="${t('Technik')}" title="${t('Technik')}">${icon('nerd', 19)}</button>
          </div>
          <div class="jetzt-blatt-inhalt" data-blatt-inhalt></div>
        </div>
      </div>`;
    document.body.appendChild(j);
    document.body.style.overflow = 'hidden';
    this.jetzt = j;
    this.blatt = null;
    this.pegel.anmelden(j.querySelector('[data-pegel-jetzt]'));
    this.kiste = new Plattenkiste(j.querySelector('[data-pk]'), {
      liste: () => this.player.liste,
      index: () => this.player.index,
      spielt: () => this.player.spielt,
      gestoppt: () => !this.player.spielt && (this.player.audio?.currentTime || 0) < 0.4,
      spielen: (i) => this.player.springenZu(i),
      zeiger: (info, wink) => this.kisteZeiger(info, wink),
    });
    this.kiste.zustand();
    j.querySelector('[data-pk-chips]').addEventListener('click', (e) => { const c = e.target.closest('[data-pk-ti]'); if (c) this.kiste?.titelTipp(Number(c.dataset.pkTi)); });
    if (document.documentElement.classList.contains('zwei-haelften')) this.haelfteSetzen(this.ohneBlatt());
    j.querySelector('[data-haelfte]').addEventListener('click', () => this.haelfteSetzen(!j.classList.contains('ohne-blatt'), true));
    for (const [sel, art] of [['[data-eq-jetzt]', 'eq'], ['[data-wm-jetzt]', 'glow'], ['[data-bd-jetzt]', 'silk'], ['[data-tr-jetzt]', 'iron']]) {
      j.querySelector(sel).addEventListener('click', (e) => { raumklangMenueSchliessen(); this.rack.flyout(e.currentTarget, art); });
    }
    const $ = (sel) => j.querySelector(sel);
    const alle = (sel, fn) => j.querySelectorAll(sel).forEach((x) => x.addEventListener('click', fn));
    $('[data-zu]').addEventListener('click', () => this.jetztSchliessen());
    j.querySelectorAll('[data-fern]').forEach((b) => b.addEventListener('click', (e) => this.app.fern?.listeOeffnen(e.currentTarget)));
    $('[data-play]').addEventListener('click', () => this.player.umschalten());
    $('[data-weiter]').addEventListener('click', () => this.player.weiter());
    $('[data-zurueck]').addEventListener('click', () => this.player.zurueck());
    $('[data-zufall]').addEventListener('click', () => this.player.zufallUmschalten());
    $('[data-wdh]').addEventListener('click', () => this.player.wiederholenUmschalten());
    $('[data-mischen]').addEventListener('click', () => this.player.mischen());
    $('[data-stopp]').addEventListener('click', () => this.player.stoppen());
    alle('[data-rechts]', (e) => this.rechtsReiter(e.currentTarget.dataset.rechts));
    this.rechtsReiter(this.rechts || 'naechstes');
    alle('[data-fav]', () => this.trackFavorit());
    $('[data-mehr]').addEventListener('click', (e) => this.jetztMenue(e.currentTarget));
    $('[data-quali-jetzt]').addEventListener('click', (e) => this.qualitaetMenue(e.currentTarget));
    $('[data-signal]').addEventListener('click', () => this.nerd.umschalten());
    $('[data-lh]').addEventListener('click', (e) => this.lautheitMenue(e.currentTarget));
    $('[data-rk-jetzt]').addEventListener('click', (e) => { raumklangMenueSchliessen(); this.rack.flyout(e.currentTarget, 'space'); });
    $('[data-nerd]').addEventListener('click', () => this.nerd.umschalten());
    $('[data-stumm-jetzt]').addEventListener('click', () => { this.player.audio.muted = !this.player.audio.muted; this.lautstaerke(); });
    const vol = $('[data-vol-jetzt]');
    vol.addEventListener('input', () => { this.player.audio.muted = false; this.player.lautstaerkeSetzen(vol.value / 100); this.lautstaerke(); });
    alle('[data-blatt-auf]', (e) => this.blattOeffnen(e.currentTarget.dataset.blattAuf));
    $('[data-blatt-zu]').addEventListener('click', () => this.blattSchliessen());
    alle('[data-reiter]', (e) => this.blattOeffnen(e.currentTarget.dataset.reiter));
    this.reglerVerbinden($('[data-pos]'));
    j.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-link]');
      if (a) {   // Navigation schließt die Vollbild-Ansicht; der Verlaufseintrag wird von der neuen Seite ersetzt
        if (this.jetztVerlauf) { this.jetztVerlauf = false; try { const st = { ...(history.state || {}) }; delete st.jetzt; history.replaceState(st, '', location.href); } catch { /* egal */ } }
        this.jetztSchliessen();
      }
      const z = e.target.closest('[data-ws-i]');
      if (z && !e.target.closest('button')) this.player.springenZu(Number(z.dataset.wsI));
      const ent = e.target.closest('[data-ws-weg]');
      if (ent) this.player.entfernen(Number(ent.dataset.wsWeg));
    });
    this.lautstaerke();
    this.jetztTrack();
    this.jetztWarteschlange();
    this.app.fern?.ui();
    if (document.documentElement.classList.contains('zwei-haelften')) this.blattOeffnen(warteschlange ? 'naechstes' : (this.blattZuletzt || 'naechstes'));
    else if (warteschlange) {
      if (matchMedia('(max-width: 1099px)').matches) this.blattOeffnen('naechstes');
      else setTimeout(() => $('.jetzt-rechts-spalte .ws-zeile.aktiv')?.scrollIntoView({ block: 'nearest' }), 250);
    }
    // Eigene Seite im Verlauf: Zurück (Android-Geste, Maus-Taste, Alt+←) schließt „Läuft gerade“ statt die Seite darunter zu wechseln
    try { history.pushState({ ...(history.state || {}), jetzt: true }, '', location.href); this.jetztVerlauf = true; } catch { /* egal */ }
    this.jetztMorph(j, true).then(() => { if (this.jetzt === j) document.documentElement.classList.add('jetzt-voll'); });
    setTimeout(() => { if (this.jetzt === j) document.documentElement.classList.add('jetzt-voll'); }, 520);
  }

  /**
   * Übergang Player-Leiste ⇄ „Läuft gerade“ (PC): Die Ansicht wächst aus der Leiste nach oben, die Bedienelemente der
   * Leiste fahren dabei an ihren neuen Platz (FLIP), Play wird größer, die Klang-Symbole erscheinen gestaffelt.
   * Schließen läuft rückwärts; am Ende liegt alles wieder genau auf der Leiste. Am Handy: einfaches Hochgleiten (CSS).
   */
  jetztMorph(j, rein) {
    const pc = matchMedia('(min-width: 1100px)').matches && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!pc || !j.animate) return Promise.resolve(false);
    j.classList.add('morph');
    const dauer = rein ? 460 : 380;
    const kurve = rein ? 'cubic-bezier(.2,.75,.25,1)' : 'cubic-bezier(.45,0,.7,.25)';
    const leiste = this.el;
    const lr = leiste.getBoundingClientRect();
    const anim = [];
    const los = (el, frames, opt = {}) => { if (el) anim.push(el.animate(rein ? frames : [...frames].reverse(), { duration: dauer, easing: kurve, fill: 'both', ...opt })); };
    // 1. Fläche: von der Höhe der Leiste bis ganz nach oben
    los(j, [{ clipPath: `inset(${Math.round(lr.top)}px 0 0 0)` }, { clipPath: 'inset(0px 0 0 0)' }]);
    // 2. Inhalt oben gleitet mit hoch und blendet ein
    j.querySelectorAll('.jetzt-kopf, .jetzt-spalte, .jetzt-bild').forEach((el) => los(el, [{ transform: 'translateY(90px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { easing: 'cubic-bezier(.2,.7,.2,1)' }));
    // 3. Bedienelemente fahren von ihrem Platz in der Leiste an ihren neuen Platz (FLIP)
    const paare = [['.player-knoepfe', '.jetzt .player-knoepfe [data-zufall]', '[data-zufall]', true], ['.zeitleiste', '.jetzt .zeitleiste', '.zeitleiste'],
      ['quali', '.jetzt [data-quali-jetzt]', '[data-quali]'], ['vol', '.jetzt [data-vol-jetzt]', '[data-vol]'], ['stumm', '.jetzt [data-stumm-jetzt]', '[data-stumm]']];
    for (const [, zielSel, quelleSel, ganzeReihe] of paare) {
      const ziel = j.querySelector(zielSel);
      const quelle = leiste.querySelector(quelleSel);
      if (!ziel || !quelle) continue;
      const a = quelle.getBoundingClientRect();
      const b = ziel.getBoundingClientRect();
      const dx = (a.left + a.width / 2) - (b.left + b.width / 2);
      const dy = (a.top + a.height / 2) - (b.top + b.height / 2);
      const el = ganzeReihe ? j.querySelector('.jetzt .player-knoepfe') : ziel;
      los(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }]);
    }
    const play = j.querySelector('[data-play]');
    const playLeiste = leiste.querySelector('[data-play]');
    if (play && playLeiste) {
      const f = playLeiste.offsetWidth / Math.max(1, play.offsetWidth);
      los(play, [{ transform: `scale(${f.toFixed(3)})` }, { transform: 'none' }]);
    }
    // 4. Klang-Symbole: aus der Mitte heraus nach außen, gestaffelt
    const klang = [...j.querySelectorAll('.klang-w')];
    klang.forEach((el, i) => {
      const links = i < 2;
      const nr = links ? 1 - i : i - 2; // innen zuerst
      const frames = [{ opacity: 0, transform: `translateX(${links ? 26 : -26}px) scale(.6)` }, { opacity: 1, transform: 'none' }];
      anim.push(el.animate(rein ? frames : [...frames].reverse(), {
        duration: rein ? 320 : 180, delay: rein ? 170 + nr * 70 : (1 - nr) * 40, easing: 'cubic-bezier(.2,.8,.3,1.2)', fill: 'both',
      }));
    });
    // 5. Links: Titel der Leiste geht, Signalweg kommt
    const sig = j.querySelector('[data-signal]');
    los(sig, [{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1 }]);
    let geist = null;
    const titel = leiste.querySelector('.player-titel');
    if (titel) {
      const t = titel.getBoundingClientRect();
      geist = titel.cloneNode(true);
      geist.classList.add('jetzt-geist');
      Object.assign(geist.style, { position: 'fixed', left: `${t.left}px`, top: `${t.top}px`, width: `${t.width}px`, height: `${t.height}px`, zIndex: 201, pointerEvents: 'none', margin: 0 });
      document.body.appendChild(geist);
      anim.push(geist.animate(rein ? [{ opacity: 1 }, { opacity: 0, offset: 0.45 }, { opacity: 0 }] : [{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], { duration: dauer, easing: 'linear', fill: 'both' }));
    }
    return Promise.all(anim.map((a) => a.finished.catch(() => {}))).then(() => {
      geist?.remove();
      // Klasse „morph“ bleibt: sonst springt die CSS-Einblendung (Hochgleiten) nachträglich noch einmal an
      if (rein) anim.forEach((a) => a.cancel());
      return true;
    });
  }

  jetztSchliessen(ausVerlauf = false) {
    if (!this.jetzt) return;
    document.documentElement.classList.remove('jetzt-voll');
    if (this.jetztVerlauf) {
      this.jetztVerlauf = false;
      if (!ausVerlauf) { this.popIgnorieren = true; history.back(); }
    }
    titelFarbe(null, 'jetzt');
    const j = this.jetzt;
    this.kiste?.zerstoeren();
    this.kiste = null;
    this.tischAuto = false;
    j.style.pointerEvents = 'none';
    // PC: zurück in die Leiste verwandeln; Handy: nach unten herausgleiten lassen; danach entfernen
    this.jetztMorph(j, false).then((gemorpht) => {
      // Chromium ließ unter dem Overlay manchmal alte Kacheln der Seite stehen (Albumliste doppelt): danach neu zeichnen
      if (gemorpht) { j.remove(); seiteNeuZeichnen(); return; }
      j.classList.add('raus');
      const weg = () => { if (j.isConnected) { j.remove(); seiteNeuZeichnen(); } };
      j.addEventListener('animationend', weg, { once: true });
      setTimeout(weg, 450);
    });
    this.jetzt = null;
    this.blatt = null;
    document.body.style.overflow = '';
  }

  /** Blatt (Handy): Als Nächstes / Mitwirkende / Technik */
  blattOeffnen(reiter) {
    const j = this.jetzt;
    if (!j) return;
    this.blatt = reiter;
    this.blattZuletzt = reiter;
    const b = j.querySelector('[data-blatt]');
    b.hidden = false;
    b.querySelectorAll('[data-reiter]').forEach((x) => { const an = x.dataset.reiter === reiter; x.classList.toggle('an', an); x.setAttribute('aria-selected', an); });
    this.blattFuellen();
  }

  blattSchliessen() {
    if (!this.jetzt) return;
    if (document.documentElement.classList.contains('zwei-haelften')) return;   // Foldable: das Blatt ist die rechte Hälfte
    this.blatt = null;
    this.jetzt.querySelector('[data-blatt]').hidden = true;
  }

  blattFuellen() {
    const j = this.jetzt;
    if (!j || !this.blatt) return;
    const trk = this.player.track;
    const box = j.querySelector('[data-blatt-inhalt]');
    j.querySelector('[data-blatt-cover]').innerHTML = trk?.album?.cover ? `<img src="${h(trk.album.cover)}" alt="">` : '';
    j.querySelector('[data-blatt-titel]').textContent = trk ? trk.titel : '';
    j.querySelector('[data-blatt-kuenstler]').textContent = trk ? kuenstlerText(trk.kuenstler) : '';
    if (this.blatt === 'naechstes') {
      const rest = this.player.liste.length - this.player.index - 1;
      box.innerHTML = `<div class="jetzt-blatt-kopf"><span>${rest > 0 ? tn(rest, 'ein Titel danach', '{n} Titel danach') : t('Danach ist Schluss')}</span>
        <button type="button" class="pille" data-mischen-blatt>${icon('zufall', 14)} ${t('Mischen')}</button></div><div class="warteschlange-liste" data-ws-blatt>${this.wsHtml()}</div>`;
      box.querySelector('[data-mischen-blatt]').addEventListener('click', () => this.player.mischen());
      box.querySelector('.ws-zeile.aktiv')?.scrollIntoView({ block: 'start' });
    } else if (this.blatt === 'mitwirkende') {
      box.innerHTML = this.creditsHtml(true);
    } else if (this.blatt === 'klang') {
      // kompakte Liste: je Gerät Name, Stufe, Schalter – Tippen öffnet das Effektrack beim Gerät
      if (!box.querySelector('.kl-box')) box.innerHTML = '<div class="kf-box kl-box"></div>';
      this.kartenNeu = klangListeEinrichten(box.firstChild, this.player, (art) => this.klangMenue(art));
    } else {
      box.innerHTML = `${this.technikHtml()}
        <details class="tk-details"><summary>${t('Signalweg im Detail')}</summary><div class="jetzt-technik">${this.signalTeile().map((x, i) => `<div class="schritt${x.gut ? ' gut' : ''}"><span class="nr">${i + 1}</span><span>${h(x.text)}</span></div>`).join('')}</div></details>
        <p class="hinweis" style="margin:14px 0 0">${h(this.netzText())}</p>
        <label for="blatt-q" style="margin-top:14px">${this.player.bereich === 'heim' ? t('Qualität zuhause auf diesem Gerät') : t('Qualität unterwegs auf diesem Gerät')}</label>
        <select id="blatt-q" data-blatt-q>${QUALITAETEN.map(([w, text]) => `<option value="${w}" ${this.player.qualitaet === w ? 'selected' : ''}>${h(w === 'auto' ? t('Automatisch – jetzt {q}', { q: QUALI_KURZ[this.player.autoQualitaet().q] || 'Original' }) : text)}</option>`).join('')}</select>`;
      box.querySelector('[data-blatt-q]').addEventListener('change', (e) => { this.player.qualitaetSetzen(e.target.value); this.aktualisieren(); this.blattFuellen(); });
    }
  }

  /** Technik (Handy, Tablet, Foldable): Weg Datei → Übertragung → Gerät, darunter die wichtigsten Werte */
  technikHtml() {
    const p = this.player;
    const trk = p.track;
    if (!trk) return `<p class="hinweis">${t('Nichts läuft.')}</p>`;
    const f = trk.format || {};
    const khz = (r) => (r ? `${(Math.round(r / 100) / 10).toLocaleString(locale)} kHz` : '');
    const komma = (x, n = 1) => zahl(x, n).replace('-', '−');
    const bw = this.bewertung();
    const m = p.modus || {};
    const nf = p.nativ ? p.audio.format : null;
    const ctx = p.raumklang?.ctx;
    const geraetRate = nf ? (nf.geraet_rate || nf.aus_rate) : ctx?.sampleRate || 0;
    const wo = netzweg.erreichbar ? t('Zuhause · direkt') : p.netz?.lokal ? t('Zuhause') : t('Unterwegs');
    const lh = p.lautheitFuer(trk);
    const weg = [
      [t('Datei'), (f.datei || f.codec || t('Datei')).toUpperCase(), [f.bittiefe ? `${f.bittiefe} Bit` : '', khz(f.abtastrate)].filter(Boolean).join(' · ')],
      [t('Übertragung'), m.art === 'original' ? 'Original' : (QUALI_KURZ[m.qualitaet] || m.qualitaet || '–'), `${wo}${m.lueckenlos ? ` · ${t('lückenlos')}` : ''}`],
      [t('Gerät'), nf ? (nf.asio ? 'ASIO' : nf.exklusiv ? t('Exklusiv') : 'Windows') : p.mobil ? t('Handy/Tablet') : 'Browser', geraetRate ? khz(geraetRate) : (nf?.geraet || '')],
    ];
    const werte = [
      [t('Abtastrate'), f.abtastrate && geraetRate && Math.abs(geraetRate - f.abtastrate) > 1 ? `${khz(f.abtastrate).replace(' kHz', '')} → ${khz(geraetRate)}` : khz(f.abtastrate || geraetRate) || '–',
        f.abtastrate && geraetRate && Math.abs(geraetRate - f.abtastrate) > 1 ? (nf ? t('wird umgerechnet') : t('Betriebssystem rechnet um')) : t('wie die Datei')],
      ['Format', nf ? (nf.aus_format || '–') : f.bittiefe ? `${f.bittiefe} Bit` : '–', nf ? (p.audio.bitgenau ? t('bitgenau am Gerät') : t('am Gerät')) : t('Float im Browser')],
      ['Bitrate', f.bitrate ? `${Math.round(f.bitrate / 1000).toLocaleString(locale)} kbit/s` : m.art === 'original' ? '–' : `${QUALI_KURZ[m.qualitaet] || m.qualitaet}`, m.art === 'original' ? t('verlustfrei') : t('umgewandelt')],
      [t('Lautheit'), lh && lh.art !== 'fehlt' ? `${komma(lh.lufs)} LUFS` : '–', lh && lh.art !== 'fehlt' ? `${lh.art === 'album' ? t('Album') : t('Titel')} ${lh.db > 0 ? '+' : ''}${komma(lh.db)} dB` : p.einst.lautheit === 'aus' ? t('Angleich aus') : t('nicht gemessen')],
      [t('Spitze'), lh && lh.tp != null ? `${komma(lh.tp)} dBTP` : '–', lh && lh.tp != null ? (lh.tp > -0.1 ? t('am Limit') : t('kein Clipping')) : ''],
      [t('Wiedergabe'), m.lueckenlos ? t('lückenlos') : t('klassisch'), p.spielt ? t('läuft') : t('pausiert')],
    ];
    const status = [bw.stufe === 'veraendert' ? 'warn' : 'gut', stufeText(bw)];
    return `<div class="tk-kopf"><b>${t('Technik')}</b><span class="tk-status ${status[0]}" title="${h(bw.grund || '')}">${status[1]}</span></div>
      <div class="tk-weg">${weg.map(([k, b, w], i) => `${i ? `<span class="tk-pf" aria-hidden="true">${icon('rechts', 14)}</span>` : ''}<div><small>${k}</small><b>${h(b)}</b><span>${h(w)}</span></div>`).join('')}</div>
      ${bw.grund && bw.stufe !== 'bitgenau' ? `<p class="tk-grund">${h(bw.grund)}</p>` : ''}
      <div class="tk-werte">${werte.map(([a, b, c]) => `<div><small>${a}</small><b>${h(b)}</b><span>${h(c || ' ')}</span></div>`).join('')}</div>`;
  }

  /** Rechte Spalte in „Läuft gerade“: Als Nächstes oder Klang (die drei Amber-Karten) */
  rechtsReiter(welcher) {
    const j = this.jetzt;
    if (!j) return;
    this.rechts = welcher;
    j.querySelectorAll('[data-rechts]').forEach((x) => { const an = x.dataset.rechts === welcher; x.classList.toggle('an', an); x.setAttribute('aria-selected', String(an)); });
    j.querySelector('[data-ws]').hidden = welcher !== 'naechstes';
    j.querySelector('[data-mischen]').hidden = welcher !== 'naechstes';
    const box = j.querySelector('[data-klang-karten]');
    box.hidden = welcher !== 'klang';
    if (welcher === 'klang') this.kartenNeu = klangKartenEinrichten(box, this.player, (art, anker) => this.klangMenue(art, anker));
  }

  /** „Erweitert ›“ an einer Klang-Karte: das große Effektrack beim jeweiligen Gerät */
  klangMenue(art) {
    raumklangMenueSchliessen();
    this.rack.vollbild(art);
  }

  jetztMenue(anker) {
    const trk = this.player.track;
    if (!trk) return;
    const eintraege = [];
    if (trk.album) eintraege.push({ text: t('Zum Album'), icon: 'album', aktion: () => { this.jetztSchliessen(); this.app.navigieren(`/alben/${trk.album.id}`); } });
    (trk.kuenstler || []).slice(0, 3).forEach((k) => eintraege.push({ text: t('Zu {name}', { name: k.name }), icon: 'kuenstler', aktion: () => { this.jetztSchliessen(); this.app.navigieren(`/kuenstler/${k.id}`); } }));
    eintraege.push({ text: t('Zur Playlist hinzufügen …'), icon: 'playlists', aktion: () => zurPlaylist(this.app, [trk]) });
    const ws = this.player.liste;
    if (this.app.ich?.app?.downloads && ws.length > 1) {
      eintraege.push({ text: t('Warteschlange als WAV exportieren …'), icon: 'download', aktion: () => exportDialog(this.app, {
        art: 'tracks', track_ids: ws.map((x) => x.id), quelle: t('Warteschlange'), name: trk.album?.titel && ws.every((x) => x.album?.id === trk.album.id) ? trk.album.titel : t('Warteschlange'),
        anzahl: ws.length, laenge_ms: ws.reduce((s2, x) => s2 + (x.laenge_ms || 0), 0) }) });
    }
    eintraege.push({ text: t('Lautstärke angleichen …'), icon: 'lautstaerke', aktion: () => setTimeout(() => this.lautheitMenue(anker), 0) });
    eintraege.push({ trenner: true }, ...this.qualitaetEintraege());
    menue(anker, eintraege);
  }

  async trackFavorit() {
    const t = this.player.track;
    if (!t) return;
    const an = !t.favorit;
    try {
      await api.post('/favoriten', { art: 'track', id: t.id, an });
      t.favorit = an;
      document.querySelectorAll(`[data-aktion="fav"][data-art="track"][data-id="${t.id}"]`).forEach((b) => { b.classList.toggle('an', an); b.innerHTML = icon(an ? 'herzVoll' : 'herz', 18); });
      this.aktualisieren();
    } catch (e) { /* Hinweis kommt aus api.js */ }
  }

  jetztAktualisieren() {
    const j = this.jetzt;
    const p = this.player;
    const trk = p.track;
    if (!j || !trk) return;
    const $ = (sel) => j.querySelector(sel);
    if (this.kiste && this.kisteSpielt !== p.spielt) { this.kisteSpielt = p.spielt; this.kiste.zustand(); }
    j.querySelectorAll('.klang-w').forEach((k) => { const trk = k.querySelector('span')?.textContent; if (trk && k.title !== trk) k.title = trk; });
    // gleiche Symbole, Größen und Beschriftungen wie in der Player-Leiste
    $('[data-play]').innerHTML = icon(p.spielt ? 'pause' : 'play', 26);
    $('[data-play]').setAttribute('aria-label', p.spielt ? t('Pause') : t('Abspielen'));
    $('[data-zufall]').classList.toggle('an', !!p.einst.zufall);
    $('[data-wdh]').classList.toggle('an', p.einst.wiederholen !== 'aus');
    $('[data-wdh]').innerHTML = icon(p.einst.wiederholen === 'eins' ? 'wiederholen1' : 'wiederholen', 18);
    $('[data-wdh]').setAttribute('aria-label', { aus: t('Wiederholen: aus'), alle: t('Wiederholen: alle'), eins: t('Wiederholen: diesen Titel') }[p.einst.wiederholen]);
    j.querySelectorAll('[data-fav]').forEach((b) => {
      b.innerHTML = icon(trk.favorit ? 'herzVoll' : 'herz', 20);
      b.classList.toggle('an', !!trk.favorit);
      b.setAttribute('aria-pressed', trk.favorit ? 'true' : 'false');
    });
    const q = this.qualitaetText();
    const chip = $('[data-quali-jetzt]');
    chip.querySelector('span').textContent = this.qualitaetKurz();
    const bw = this.stufeSetzen(chip);
    chip.title = t('{text} – {stufe}{grund} · Klick: Qualität wählen · Details: Analyse (A)', { text: q.text, stufe: stufeText(bw), grund: bw.grund ? `: ${bw.grund}` : '' });
    this.lautheitChip();
    const rk = p.raumklang;
    const rkChip = $('[data-rk-jetzt]');
    const layout = layoutFuer(rk.ctx ? rk.ctx.destination.maxChannelCount : ausgabeKanaele());
    // Variante „Name, aktiv mit Wert“: aus = nur der Name, an = was es gerade tut
    const rkName = RAUMKLANG_PRESETS[rk.preset]?.name || rk.preset;
    rkChip.querySelector('[data-rk-text]').textContent = rk.aktiv ? rkName : 'Space';
    rkChip.classList.toggle('an', !!rk.aktiv);
    rkChip.title = rk.aktiv ? t('AmberSpace · {name}: Stereo → {layout} (Taste U)', { name: rkName, layout: rk.layout?.name }) : layout ? t('AmberSpace aus (Taste U)') : t('AmberSpace – dieser Ausgang ist nur Stereo');
    const wmChip = $('[data-wm-jetzt]');
    wmChip.querySelector('[data-wm-text]').textContent = waermeWirksam(p.einst.waerme) ? waermeKurzText(p.einst.waerme) : 'Glow';
    wmChip.classList.toggle('an', waermeWirksam(p.einst.waerme));
    wmChip.title = waermeWirksam(p.einst.waerme) ? t('AmberGlow · {wert}', { wert: waermeKurzText(p.einst.waerme) }) : t('AmberGlow (Röhrensättigung) aus');
    const trChip = $('[data-tr-jetzt]');
    trChip.querySelector('[data-tr-text]').textContent = trafoWirksam(p.einst.trafo) ? trafoKurzText(p.einst.trafo) : 'Iron';
    trChip.classList.toggle('an', trafoWirksam(p.einst.trafo));
    trChip.title = trafoWirksam(p.einst.trafo) ? t('AmberIron · {wert}', { wert: trafoKurzText(p.einst.trafo) }) : t('AmberIron (Übertrager) aus');
    const bdChip = $('[data-bd-jetzt]');
    bdChip.querySelector('[data-bd-text]').textContent = bandWirksam(p.einst.band) ? bandKurzText(p.einst.band) : 'Silk';
    bdChip.classList.toggle('an', bandWirksam(p.einst.band));
    bdChip.title = bandWirksam(p.einst.band) ? t('AmberSilk · {wert}', { wert: bandKurzText(p.einst.band) }) : t('AmberSilk (Bandsättigung) aus');
    // Klang-Karten nachziehen (nicht, solange darin gerade etwas bedient wird)
    if (this.kartenNeu && (this.rechts === 'klang' || this.blatt === 'klang') && !j.querySelector('.kf-box')?.contains(document.activeElement)) this.kartenNeu();
    const eqChip = $('[data-eq-jetzt]');
    eqChip.querySelector('[data-eq-text]').textContent = eqWirksam(p.einst.eq) ? t('EQ an') : 'EQ';
    eqChip.classList.toggle('an', eqWirksam(p.einst.eq));
    eqChip.title = eqWirksam(p.einst.eq) ? t('Equalizer: {wert}', { wert: eqKurzText(p.einst.eq) }) : t('Equalizer (aus)');
    $('[data-nerd]')?.classList.toggle('an', !!this.nerd?.offen);
    this.signalweg();
    this.zeit();
    j.querySelectorAll('[data-ws-i]').forEach((z) => z.classList.toggle('aktiv', Number(z.dataset.wsI) === p.index));
  }

  async jetztTrack() {
    const j = this.jetzt;
    const trk = this.player.track;
    if (!j || !trk) return;
    const $ = (sel) => j.querySelector(sel);
    this.kiste?.neu();
    const grund = this.player.radioGrund(trk);
    const radio = this.player.quelleKontext?.art === 'radio';
    $('[data-quelle]').innerHTML = radio ? h(grund || t('aus deiner Sammlung')) : trk.album ? `<a href="/alben/${trk.album.id}" data-link>${h(trk.album.titel)}</a>` : '';
    $('[data-quelle-k]').textContent = '';
    $('[data-quelle-art]').textContent = radio ? (this.player.quelleKontext.titel || t('Mein Radio')) : t('Läuft gerade');
    this.jetztAktualisieren();
    this.info = null;
    $('[data-credits]').innerHTML = '<div class="lade" style="padding:12px 0"></div>';
    try {
      let info = this.creditsCache.get(trk.id);
      if (!info) {
        info = await api.get(`/tracks/${trk.id}`);
        this.creditsCache.set(trk.id, info);
      }
      if (this.player.track !== trk || !this.jetzt) return;
      this.info = info;
      if (!trk.format && info.datei) trk.format = { datei: info.datei.format, codec: info.datei.codec, abtastrate: info.datei.abtastrate, bittiefe: info.datei.bittiefe, kanaele: info.datei.kanaele, bitrate: info.datei.bitrate };
      const art = typZeile(info.album);
      if (!radio) {
        // „Spielt aus Album“ – darunter Albumname · Jahr, darunter der Albuminterpret
        $('[data-quelle-art]').textContent = t('Spielt aus {art}', { art: art || t('Album') });
        $('[data-quelle]').innerHTML = `<a href="/alben/${info.album.id}" data-link>${h(info.album.titel || trk.album?.titel || '')}</a>${info.album.jahr ? `<span class="jahr"> · ${h(String(info.album.jahr))}</span>` : ''}`;
        const ak = info.album.kuenstler || info.album.albumkuenstler || trk.album?.kuenstler;
        $('[data-quelle-k]').textContent = Array.isArray(ak) ? kuenstlerText(ak) : (ak?.name || ak || '');
      }
      this.signalweg();
    } catch (e) {
      this.info = { credits: [], fehler: true };
    }
    if (this.player.track !== trk || !this.jetzt) return;
    $('[data-credits]').innerHTML = this.creditsHtml(false);
    if (this.blatt) this.blattFuellen();
  }

  /** Mitwirkende: pro Gruppe Personen mit ihrer Rolle (Instrumente, „Gesang“, „Produzent“ …) */
  creditsHtml(gross) {
    const info = this.info;
    if (!info) return '<div class="lade" style="padding:12px 0"></div>';
    if (info.fehler) return `<p class="hinweis" style="margin:0">${t('Mitwirkende konnten nicht geladen werden.')}</p>`;
    if (!info.credits.length) {
      return `<p class="hinweis" style="margin:0">${t('Für diesen Titel sind noch keine Mitwirkenden eingetragen.')}${this.app.ich.user.rolle === 'admin' && info.album ? ` <a href="/verwaltung/abgleich/${info.album.edition_id}" data-link>${t('Mit MusicBrainz abgleichen')}</a>` : ''}</p>`;
    }
    const gruppen = info.credits.map((g) => {
      const personen = new Map();
      for (const e of g.eintraege) {
        const r = e.instrumente?.length ? e.instrumente.join(', ') : e.rolle;
        const p = personen.get(e.kuenstler.id) || { k: e.kuenstler, rollen: [] };
        if (r && !p.rollen.includes(r)) p.rollen.push(r);
        personen.set(e.kuenstler.id, p);
      }
      return `<div class="jetzt-credit-gruppe"><div class="g">${h(g.titel)}</div>${[...personen.values()].map((p) => `<a class="jetzt-person" href="/kuenstler/${p.k.id}" data-link>
        <span class="mini-avatar">${h(initialen(p.k.name))}</span><span class="tx"><b>${h(p.k.name)}</b><small>${h(p.rollen.join(' · '))}</small></span>${gross ? icon('rechts', 18, 'style="opacity:.45"') : ''}</a>`).join('')}</div>`;
    }).join('');
    return gruppen + (info.credits_quelle ? `<p class="hinweis" style="font-size:.78rem;margin:0 0 8px">${h(info.credits_quelle)}</p>` : '') + (info.album ? `<a class="jetzt-mehr-link" href="/alben/${info.album.id}" data-link>${t('Alle Mitwirkenden des Albums →')}</a>` : '');
  }

  /** „Zuhause erkannt · Automatisch: Original“ */
  netzText() {
    const p = this.player;
    const a = p.autoQualitaet();
    const wo = netzweg.erreichbar ? t('Zuhause · direkt ({name})', { name: netzweg.name }) : p.netz?.lokal ? (netzweg.direkt ? t('Zuhause · über Cloudflare') : t('Zuhause im Heimnetz')) : t('Unterwegs');
    const geraet = p.mobil ? ` · ${t('Handy/Tablet')}` : '';
    return p.qualitaet === 'auto' ? `${wo}${geraet} · ${t('Automatisch: {q} ({grund})', { q: QUALI_KURZ[a.q] || 'Original', grund: a.grund })}` : `${wo}${geraet} · ${t('fest eingestellt')}`;
  }

  /** Stationen vom File bis zum Gerät */
  signalTeile() {
    const p = this.player;
    const trk = p.track;
    const teile = [];
    if (!trk) return teile;
    const f = trk.format;
    const kan = f ? (f.kanaele > 2 ? (f.kanaele === 6 ? ' · 5.1' : f.kanaele === 8 ? ' · 7.1' : ` · ${t('{n} Kanäle', { n: f.kanaele })}`) : f.kanaele === 1 ? ' · Mono' : '') : '';
    teile.push({ text: f ? `${formatText(f)}${kan}` : t('Datei'), mittel: f ? `${formatText(f)}${kan}` : t('Datei'), kurz: f ? f.datei?.toUpperCase() || t('Datei') : t('Datei') });
    // Übertragungsweg (nur wenn ein Direktzugang eingerichtet ist)
    if (netzweg.direkt) {
      teile.push(p.direktAktiv
        ? { text: t('direkt im Heimnetz ({name})', { name: netzweg.name }), mittel: t('direkt'), kurz: '' }
        : { text: `${t('über das Internet (Cloudflare)')}${netzweg.erreichbar ? '' : netzweg.letzterFehler ? ` – ${t('Direktadresse: {fehler}', { fehler: netzweg.letzterFehler })}` : ''}`, mittel: 'Internet', kurz: '' });
    }
    const q = p.modus ? (QUALI_KURZ[p.modus.qualitaet] || p.modus.qualitaet) : '';
    const luecke = p.modus?.lueckenlos;
    const bitgenau = luecke ? !!p.motor?.aktuell?.bitgenau : true;
    if (p.modus?.art === 'original') {
      teile.push(bitgenau
        ? { text: luecke ? t('unverändert an den Browser, lückenlos') : t('unverändert an den Browser'), mittel: luecke ? t('bitgenau · lückenlos') : t('bitgenau'), kurz: t('bitgenau'), gut: true }
        : { text: t('verlustfrei dekodiert, lückenlos'), mittel: t('verlustfrei · lückenlos'), kurz: t('verlustfrei'), gut: true });
    } else if (p.modus) {
      const ersatz = p.modus.ersatz ? ` – ${p.lueckenlosGrund === 'fehler' ? t('statt Original, weil der FLAC-Strom hier nicht lief') : t('statt Original, weil dieser Browser FLAC nicht lückenlos kann')}` : '';
      teile.push({ text: `${t('live umgewandelt: {q} kbit/s', { q })}${f && f.kanaele > 2 ? `, ${t('auf Stereo gemischt')}` : ''}${luecke ? `, ${t('lückenlos')}` : ''}${ersatz}`, mittel: `${q} kbit/s${luecke ? ` · ${t('lückenlos')}` : ''}`, kurz: q });
    }
    const lh = p.lautheitFuer(trk);
    if (lh?.art === 'fehlt') {
      teile.push({ text: t('Lautheit: dieser Titel ist noch nicht gemessen – spielt ohne Angleich'), mittel: t('nicht gemessen'), kurz: '' });
    } else if (lh) {
      const komma = (x, n = 1) => zahl(x, n).replace('-', '−');
      const db = `${lh.db > 0 ? '+' : ''}${komma(lh.db)} dB`;
      const art = lh.art === 'album' ? t('Album-Gain') : t('Titel-Gain');
      const wo = p.gainAmServer ? t('im Stream eingerechnet') : p.raumklang?.angeschlossen ? t('über Web Audio')
        : lh.db > 0 ? t('ohne Web Audio nur Absenken möglich – Anheben entfällt') : t('über die Lautstärke des Players');
      const grenze = lh.begrenzt ? `, ${t('Anheben begrenzt (True-Peak {tp} dBTP, Decke {decke} dBTP)', { tp: komma(lh.tp), decke: komma(p.lhDecke) })}` : '';
      const tags = lh.quelle === 'tags' ? ` (${t('vorläufig aus ReplayGain-Tags')})` : '';
      if (Math.abs(lh.db) >= 0.05) teile.forEach((y) => { y.gut = false; });
      teile.push({ text: t('{art} {db}: {lufs} LUFS → Ziel {ziel} LUFS{grenze}, {wo}{tags}', { art, db, lufs: komma(lh.lufs), ziel: komma(lh.ziel, 0), grenze, wo, tags }), mittel: `${art} ${db}`, kurz: db });
    }
    const rk = p.raumklang;
    // Effekte in der eingestellten Reihenfolge (alles umgangen: keine)
    const stufe = {
      glow: () => {
        teile.forEach((y) => { y.gut = false; });
        teile.push({ text: t('AmberGlow „{kurz}“: Röhrensättigung ({detail})', { kurz: waermeKurzText(p.einst.waerme), detail: `${p.einst.waerme.hq ? `HQ: ${t('12AX7-Stufe als Schaltung gelöst, 8× Oversampling')}` : t('4× Oversampling mit Antiderivative-Antialiasing')}${p.einst.waerme.auto ? `, ${t('Auto-Gain gegen die Ansteuerung')}` : ''}` }), mittel: `AmberGlow ${waermeKurzText(p.einst.waerme)}`, kurz: 'Glow' });
      },
      iron: () => {
        teile.forEach((y) => { y.gut = false; });
        teile.push({ text: t('AmberIron „{kurz}“: Übertrager ({detail})', { kurz: trafoKurzText(p.einst.trafo), detail: `${t('Kernmodell mit Quellwiderstand')}${p.einst.trafo.hq ? `, ${t('HQ: Play-Hysterese, Toleranzen, 2× Oversampling')}` : ''}, Auto-Gain` }), mittel: `AmberIron ${trafoKurzText(p.einst.trafo)}`, kurz: 'Iron' });
      },
      silk: () => {
        teile.forEach((y) => { y.gut = false; });
        teile.push({ text: t('AmberSilk „{kurz}“: Bandsättigung {ips} ips, {sorte} {norm} ({detail})', { kurz: bandKurzText(p.einst.band), ips: Number(p.einst.band.ips).toLocaleString(locale), sorte: ({ sm900: 'SM 900', 456: '456', sm468: 'SM 468' })[p.einst.band.sorte] || 'SM 900', norm: (p.einst.band.norm || 'nab').toUpperCase(), detail: `${p.einst.band.hq ? `HQ: ${t('8× Oversampling, Hysterese-Rest, Gleichlauf')}` : t('4× Oversampling mit Antiderivative-Antialiasing')}${p.einst.band.auto ? ', Auto-Gain' : ''}` }), mittel: `AmberSilk ${bandKurzText(p.einst.band)}`, kurz: 'Silk' });
      },
      eq: () => {
        teile.forEach((y) => { y.gut = false; });
        teile.push({ text: `EQ: ${eqKurzText(p.einst.eq)}`, mittel: 'EQ', kurz: 'EQ' });
      },
    };
    const wirksam = { glow: () => waermeWirksam(p.einst.waerme), iron: () => trafoWirksam(p.einst.trafo), silk: () => bandWirksam(p.einst.band), eq: () => eqWirksam(p.einst.eq) };
    if (rk?.angeschlossen && !p.bypass) for (const art of p.einst.reihe) {
      if (wirksam[art]) { if (wirksam[art]()) stufe[art](); }
      else if (vstRack.wirksam(art)) { const n = vstRack.finde(art).name; teile.forEach((y) => { y.gut = false; }); teile.push({ text: `VST3 ${n}`, mittel: n, kurz: n }); }
    }
    if (rk?.aktiv) {
      const x = RAUMKLANG_PRESETS[rk.preset];
      teile.forEach((y) => { y.gut = false; });
      const hallText = rk.graph?.hallName ? `, ${t('Hall: {name}', { name: rk.graph.hallName })}` : '';
      const trenn = rk.graph?.trennung;
      teile.push({ text: t('AmberSpace „{preset}“: Stereo → {layout}, vorne L/C/R per M/S{bass}, hinten Raum/Ambience{hall}', { preset: x.name, layout: rk.layout.name, bass: trenn ? `, ${t('Bass unter {hz} Hz zum LFE (24 dB/Okt.)', { hz: trenn })}` : '', hall: hallText }), mittel: `AmberSpace ${x.name} · ${rk.layout.name}`, kurz: `Space ${rk.layout.name}` });
    } else if (rk?.angeschlossen) {
      teile.forEach((y) => { y.gut = false; });
      teile.push(p.pegelAn
        ? { text: t('über Web Audio für die Pegelanzeige (Lautstärke hinter der Messung; abschaltbar im Profil)'), mittel: 'Web Audio', kurz: '' }
        : { text: t('über Web Audio (bitgenau wieder nach Neuladen der Seite)'), mittel: 'Web Audio', kurz: '' });
    }
    teile.push({ text: t('Browser / Gerät'), mittel: 'Browser', kurz: '' });
    return teile;
  }

  signalweg() {
    const j = this.jetzt;
    if (!j || !this.player.track) return;
    const teile = this.signalTeile();
    const pfeil = '<span class="pfeil" aria-hidden="true">→</span>';
    const gut = teile.some((x) => x.gut);
    const sig = j.querySelector('[data-signal]');
    const p = this.player;
    const m = p.modus || {};
    const lh = p.lautheitFuer(p.track);
    const kurzweg = [
      m.art === 'original' ? 'Original' : (QUALI_KURZ[m.qualitaet] || m.qualitaet || ''),
      m.lueckenlos ? t('lückenlos') : '',
      lh && lh.art !== 'fehlt' && Math.abs(lh.db) >= 0.05 ? `${lh.art === 'album' ? t('Album') : t('Titel')} ${lh.db > 0 ? '+' : ''}${zahl(lh.db, 1).replace('-', '−')} dB` : '',
    ].filter(Boolean).join(' · ');
    const schlecht = this.verschlechterung();
    const bwS = this.bewertung();
    sig.innerHTML = `<i class="${schlecht ? '' : 'gut'}${bwS.stufe === 'bitgenau' ? ' ring' : ''}"></i><span>${h(kurzweg)}</span><span class="jetzt-signal-mehr">${t('Details')}</span>`;
    sig.title = `${bwS.stufe === 'bitgenau' ? t('Bitgenau') : bwS.stufe === 'transparent' ? `${t('Klanglich unverändert')}${bwS.grund ? ` (${bwS.grund})` : ''}` : schlecht}\n${teile.map((x) => x.text).join(' → ')}\n${this.netzText()}\n${t('Klick: Analyse')}`;
    void pfeil; void gut;
    const kurz = teile.map((x) => x.kurz).filter(Boolean);
    // Chip unten: schlicht Format · Zustand (der ganze Weg steht im Titel und unter „Technik“)
    j.querySelector('[data-signal-kurz]').textContent = `${this.qualitaetKurz()} · ${bwS.stufe === 'bitgenau' ? t('bitgenau') : bwS.stufe === 'transparent' ? t('unverändert') : t('verändert')}`;
    j.querySelector('[data-signal-kurz]').parentElement.title = t('{weg} · Tippen: Technik', { weg: kurz.join(' → ') });
    this.stufeSetzen(j.querySelector('.jetzt-signal-chip'));
    if (this.blatt === 'technik') this.blattFuellen();
  }

  /** Plattenkiste zeigt auf Titel i: Titelzeile zeigt diesen Titel, beim Blättern mit Rolle und Doppeltipp-Hinweis */
  /**
   * Plattenkiste zeigt auf eine Gruppe (ein Album, ein oder mehrere Titel am Stück). Titelzeile: einzelner Titel → Titel +
   * Künstler; mehrere → Album + Künstler und darunter die Titel als Leiste (laufender mit Pegel). Beim Blättern Rolle + Hinweis.
   */
  kisteZeiger({ ti, wahl, d }, wink = false) {
    const j = this.jetzt;
    const p = this.player;
    const trk = p.liste[wahl];
    if (!j || !trk) return;
    // Laufendes Album: der laufende Titel; ein anderes Album mit mehreren Titeln: Albumname
    const mehrere = ti.length > 1 && d !== 0;
    const erster = p.liste[ti[0]];
    j.querySelector('[data-titel]').innerHTML = mehrere ? h(erster.album?.titel || erster.titel) : h(trk.titel) + eBadge(trk.explizit);
    j.querySelector('[data-kuenstler]').innerHTML = kuenstlerLinks(mehrere ? erster.kuenstler : trk.kuenstler);
    laufschrift(j.querySelector('[data-titel]'));
    laufschrift(j.querySelector('[data-kuenstler]'));
    const bis = ti[0] - p.index;
    const rolle = d === 0 ? '' : d === 1 ? t('Als Nächstes') : d > 1 ? tn(bis, 'In einem Titel', 'In {n} Titeln') : d === -1 ? t('Gerade gespielt') : tn(-(ti[ti.length - 1] - p.index), 'Vor einem Titel', 'Vor {n} Titeln');
    j.querySelector('[data-pk-rolle]').textContent = rolle;
    const titelZeile = j.querySelector('.jetzt-titel');
    titelZeile.classList.toggle('blaettert', !!rolle);
    titelZeile.classList.toggle('laeuft-rolle', false);
    j.querySelector('[data-pk-chips]').hidden = true;
    const tipp = j.querySelector('[data-pk-tipp]');
    const zeigeTipp = wahl !== p.index;
    tipp.classList.toggle('an', zeigeTipp);
    j.querySelector('[data-pk-tipp-text]').textContent = zeigeTipp ? t('doppelt tippen spielt „{titel}“', { titel: trk.titel }) : t('doppelt tippen zum Abspielen');
    if (wink && zeigeTipp) { tipp.classList.remove('wink'); void tipp.offsetWidth; tipp.classList.add('wink'); }
    const markiert = new Set(d !== 0 || wahl !== p.index ? (wahl !== p.index && ti.includes(p.index) ? [wahl] : ti) : []);
    j.querySelectorAll('[data-ws-i]').forEach((z) => z.classList.toggle('zeiger', markiert.has(Number(z.dataset.wsI))));
  }

  ohneBlatt() { try { return localStorage.getItem('aw_ohne_blatt') === '1'; } catch { return false; } }

  /** Foldable: rechte Hälfte (Blatt) rausschieben – dann ist die Plattenkiste groß wie auf dem Tablet */
  haelfteSetzen(weg, merken = false) {
    const j = this.jetzt;
    if (!j) return;
    const vorher = j.classList.contains('ohne-blatt');
    // Animiert wird nur auf Knopfdruck. Früher lief ein Übergang auf grid-template-columns: der rechnete bei jedem Bild das ganze
    // Layout und die Plattenkiste (Größe, 3D, Bilder) neu – das ruckelte. Jetzt springt das Layout einmal, und nur Transformationen
    // und Deckkraft gleiten (Compositor): die Kiste zoomt von der alten an die neue Stelle, das Blatt fährt aus bzw. ein.
    const anim = merken && vorher !== weg && document.documentElement.classList.contains('zwei-haelften')
      && !matchMedia('(prefers-reduced-motion: reduce)').matches && j.animate;
    const buehne = j.querySelector('.pk-buehne');
    const pk = j.querySelector('.pk');
    const blatt = j.querySelector('.jetzt-blatt');
    const a = anim && buehne ? buehne.getBoundingClientRect() : null;
    const blattAlt = anim && !vorher && blatt ? blatt.getBoundingClientRect() : null;
    if (blatt && !vorher && weg) {
      // Maße fürs Ausblenden merken (das Blatt bleibt so groß, nur außerhalb)
      const jr = j.getBoundingClientRect(), br = blatt.getBoundingClientRect();
      if (br.width) { j.style.setProperty('--blatt-top', `${br.top - jr.top}px`); j.style.setProperty('--blatt-w', `${br.width}px`); j.style.setProperty('--blatt-h', `${br.height}px`); }
    }
    j.classList.toggle('ohne-blatt', weg);
    if (a && a.width) {
      this.kiste?.messen();   // neue Covergröße sofort (der ResizeObserver käme erst ein Bild später)
      const b = buehne.getBoundingClientRect();
      const r = pk.getBoundingClientRect();
      if (b.width) {
        const kurve = 'cubic-bezier(.2,.75,.25,1)';
        const ox = b.left + b.width / 2 - r.left, oy = b.top + b.height / 2 - r.top;
        const dx = a.left + a.width / 2 - (b.left + b.width / 2), dy = a.top + a.height / 2 - (b.top + b.height / 2);
        pk.style.transformOrigin = `${ox}px ${oy}px`;
        pk.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${a.width / b.width})` }, { transform: 'none' }], { duration: 480, easing: kurve })
          .finished.then(() => { pk.style.transformOrigin = ''; }, () => {});
        // Titel, Leiste und Knöpfe stehen im neuen Layout anders: kurz ausblenden und weich wieder einblenden statt zu springen
        for (const el of j.querySelectorAll('.jetzt-titel, .jetzt-steuerung, .jetzt-quelle')) {
          el.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 0, transform: 'translateY(6px)', offset: 0.25 }, { opacity: 1, transform: 'none' }], { duration: 480, easing: 'ease-out' });
        }
      }
    }
    if (blattAlt && blattAlt.width) {
      // Das Blatt hat im neuen Layout keine Spalte mehr: während es hinausfährt, behält es seinen alten Platz
      Object.assign(blatt.style, { position: 'fixed', left: `${blattAlt.left}px`, top: `${blattAlt.top}px`, width: `${blattAlt.width}px`, height: `${blattAlt.height}px` });
      setTimeout(() => { if (j.classList.contains('ohne-blatt')) for (const k of ['position', 'left', 'top', 'width', 'height']) blatt.style[k] = ''; }, 500);
    } else if (blatt) for (const k of ['position', 'left', 'top', 'width', 'height']) blatt.style[k] = '';
    const k = j.querySelector('[data-haelfte]');
    k.setAttribute('aria-pressed', String(weg));
    k.setAttribute('aria-label', weg ? t('Liste einblenden') : t('Liste ausblenden'));
    k.title = weg ? t('Liste einblenden') : t('Liste ausblenden – Plattenkiste groß');
    if (merken) try { localStorage.setItem('aw_ohne_blatt', weg ? '1' : '0'); } catch { /* egal */ }
  }

  async nerdLaden() {
    if (!this.nerdEcht) {
      const { NerdAnsicht } = await import('./nerd.js');
      if (!this.nerdEcht) this.nerdEcht = this.nerd = new NerdAnsicht(this.app, this.player);
    }
    return this.nerdEcht;
  }

  async rackLaden() {
    if (!this.rackEcht) {
      const { Rack } = await import('./rack.js');
      if (!this.rackEcht) this.rackEcht = this.rack = new Rack(this.player, this);
    }
    return this.rackEcht;
  }

  /** letzte Zelle einer Zeile: beim laufenden Titel die Spiel-Anzeige, sonst der Entfernen-Knopf */
  wsEnde(i) {
    return i === this.player.index ? `<span style="color:var(--accent-a)">${spieltAnzeige()}</span>` : `<button type="button" class="btn-ico" data-ws-weg="${i}" aria-label="${t('Entfernen')}" style="width:32px;height:32px">${icon('zu', 16)}</button>`;
  }

  wsHtml() {
    const p = this.player;
    const von = Math.max(0, p.index - 20);
    const bis = Math.min(p.liste.length, p.index + 200);
    // Mehrere Titel desselben Albums am Stück: kleine Album-Zwischenzeile darüber (wie die Plattenkiste gruppiert)
    const gs = gruppenVon(p.liste);
    const kopfVor = new Map(gs.filter((g) => g.ti.length > 1).map((g) => [g.ti[0], g]));
    this.wsBau = { von, bis, ids: p.liste.slice(von, bis).map((x) => x.id).join(',') };
    return p.liste.slice(von, bis).map((trk, n) => {
      const i = von + n;
      const g = kopfVor.get(i);
      const kopf = g ? `<div class="ws-album">${trk.album?.cover ? `<img src="${h(trk.album.cover)}" alt="" loading="lazy">` : ''}<span>${h(trk.album?.titel || '')}</span><small>${h(kuenstlerText(trk.kuenstler))} · ${t('{n} Titel', { n: g.ti.length })}</small></div>` : '';
      return `${kopf}<div class="ws-zeile${i === p.index ? ' aktiv' : ''}${i < p.index ? ' vorbei' : ''}" data-ws-i="${i}">
        ${trk.album?.cover ? `<img src="${h(trk.album.cover)}" alt="" loading="lazy">` : '<span class="mini"></span>'}
        <div style="min-width:0"><div class="t">${h(trk.titel)}${eBadge(trk.explizit)}</div><small>${h(kuenstlerText(trk.kuenstler))}</small></div>
        ${this.wsEnde(i)}
      </div>`;
    }).join('') || `<p class="hinweis">${t('Leer')}</p>`;
  }

  /** Nur der laufende Titel ist weitergerückt (Liste unverändert): Zeilen an Ort und Stelle umstellen statt die ganze Liste neu zu bauen
   *  (bis zu 220 Zeilen mit Bildern – das kostete beim Titelwechsel ein spürbares Ruckeln, mitten im Einfahren der CD) */
  wsNachziehen(box) {
    const p = this.player;
    const b = this.wsBau;
    const alt = box.querySelector('.ws-zeile.aktiv');
    const altI = alt ? Number(alt.dataset.wsI) : -1;
    // Liste in der gebauten Spanne unverändert, neuer Titel liegt darin und es folgen noch genug Zeilen?
    if (!b || !alt || altI === p.index || p.index < b.von || p.index >= b.bis || (b.bis < p.liste.length && b.bis - p.index < 40)
        || p.liste.slice(b.von, b.bis).map((x) => x.id).join(',') !== b.ids) return false;
    const neu = box.querySelector(`.ws-zeile[data-ws-i="${p.index}"]`);
    if (!neu) return false;
    alt.classList.remove('aktiv');
    alt.lastElementChild.outerHTML = this.wsEnde(altI);
    neu.classList.add('aktiv');
    neu.lastElementChild.outerHTML = this.wsEnde(p.index);
    const lo = Math.min(altI, p.index), hi = Math.max(altI, p.index);
    for (const z of box.querySelectorAll('.ws-zeile')) { const i = Number(z.dataset.wsI); if (i >= lo && i <= hi) z.classList.toggle('vorbei', i < p.index); }
    return true;
  }

  jetztWarteschlange() {
    const j = this.jetzt;
    if (!j) return;
    const p = this.player;
    const box = j.querySelector('[data-ws]');
    if (!this.wsNachziehen(box)) box.innerHTML = this.wsHtml();
    this.kiste?.neu(false);
    const akt = box.querySelector('.ws-zeile.aktiv');
    if (akt) box.scrollTop = akt.offsetTop - box.offsetTop;
    const n = p.liste[p.index + 1];
    j.querySelector('[data-vorschau]').innerHTML = n
      ? `${n.album?.cover ? `<img src="${h(n.album.cover)}" alt="">` : '<span class="mini"></span>'}<span class="tx"><small>${t('Als Nächstes')}</small><b>${h(n.titel)} <span>· ${h(kuenstlerText(n.kuenstler))}</span></b></span>${icon('hoch', 20)}`
      : `<span class="tx"><small>${t('Als Nächstes')}</small><b>${t('Nichts mehr in der Warteschlange')}</b></span>${icon('hoch', 20)}`;
    if (this.blatt === 'naechstes') this.blattFuellen();
  }
}
