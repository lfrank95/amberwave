// Lückenlose Wiedergabe (gapless) über Media Source Extensions.
// Ein einziges <audio>-Element bekommt einen durchgehenden Zeitstrahl, in den die Titel nacheinander eingefüllt werden:
//  - zuhause/Original: jeder Titel als FLAC (bitgenau bzw. verlustfrei) und auf das Sample genau angesetzt
//  - unterwegs/Opus: zusammenhängende Titel eines Albums als EIN durchgehender Opus-Strom (keine Naht)
//  - offline gespeicherte Titel (Opus aus dem Speicher der App): je Titel angesetzt wie FLAC, auf die exakte Länge
//    beschnitten (appendWindow) – der Encoder-Vorlauf steht im WebM (CodecDelay) und wird vom Browser verworfen
// Sperrbildschirm, Hintergrund und Medientasten funktionieren weiter, weil es dasselbe Medienelement bleibt.

import { netzweg } from './netzweg.js';
import { t } from './i18n.js';

const MS = window.ManagedMediaSource || window.MediaSource;
const TYP = { flac: 'audio/mp4; codecs="flac"', opus: 'audio/webm; codecs="opus"' };
const KETTE_MAX = 40;

const schlafen = (ms) => new Promise((r) => setTimeout(r, ms));

export class LueckenlosMotor extends EventTarget {
  /** Für die Diagnose: welche Media-Source-Variante und welche Formate gehen hier? */
  static diagnose() {
    return {
      mse: window.ManagedMediaSource ? 'ManagedMediaSource' : window.MediaSource ? 'MediaSource' : null,
      flac: LueckenlosMotor.kann('flac'),
      opus: LueckenlosMotor.kann('opus'),
    };
  }

  /** Kann dieser Browser die Art („flac“ oder „opus“) lückenlos? */
  static kann(art) {
    try { return !!MS && !!TYP[art] && MS.isTypeSupported(TYP[art]); } catch (e) { return false; }
  }

  /**
   * quelle: { naechster(track) -> track|null, gain(track) -> dB, lokal(track) -> bool, ton(track) -> Promise<Blob>, dauer(track) -> s }
   */
  constructor(audio, quelle) {
    super();
    this.audio = audio;
    this.quelle = quelle;
    this.sitzung = 0;
    this.abschnitte = []; // [{ track, start, dauer, ab, geladen, kette }]
    this.voraus = 30;     // Sekunden, die vorgeladen werden (bei knappem Speicher weniger)
    this.aktiv = false;
    this.art = null;
    this.aktuell = null;
  }

  stop() {
    this.sitzung++;
    this.format = null;
    this.abbruch?.abort();
    this.aktiv = false;
    this.abschnitte = [];
    this.aktuell = null;
    if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
    this.ms = null;
    this.sb = null;
  }

  /** Wiedergabe ab track (Sekunde ab) neu aufbauen. art: 'flac' | 'opus' */
  async start(track, ab, art, qualitaet) {
    this.stop();
    const sitzung = this.sitzung;
    this.aktiv = true;
    this.art = art;
    this.qualitaet = qualitaet;
    this.fehlerZahl = 0;
    const ms = new MS();
    this.ms = ms;
    if (window.ManagedMediaSource && ms instanceof window.ManagedMediaSource) this.audio.disableRemotePlayback = true;
    this.url = URL.createObjectURL(ms);
    this.audio.src = this.url;
    await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
    if (sitzung !== this.sitzung) return;
    this.sb = ms.addSourceBuffer(TYP[art]);
    this.sb.mode = 'segments';
    this.abschnitte = [];
    this.ersteAb = ab;
    this.startZeit = ab > 0 ? ab : null;
    this.zufuehren(sitzung, track, ab).catch((e) => {
      if (sitzung === this.sitzung && e.name !== 'AbortError') this.dispatchEvent(new CustomEvent('fehler', { detail: e }));
    });
  }

  // ---------- Zeit ----------
  /** Abschnitt (Titel), der gerade spielt */
  abschnittBei(zeit) {
    let a = null;
    for (const x of this.abschnitte) if (x.start <= zeit + 0.0005) a = x;
    return a;
  }

  zeitImTitel() {
    const a = this.aktuell || this.abschnittBei(this.audio.currentTime);
    return a ? Math.max(0, this.audio.currentTime - a.start) : this.audio.currentTime;
  }

  dauerTitel() {
    const a = this.aktuell;
    return a?.dauer || 0;
  }

  /** Bei jedem timeupdate aufrufen: meldet Titelwechsel am Übergang */
  pruefen() {
    if (!this.aktiv) return;
    const a = this.abschnittBei(this.audio.currentTime);
    if (a && a !== this.aktuell) {
      const vorher = this.aktuell;
      this.aktuell = a;
      if (vorher) this.dispatchEvent(new CustomEvent('wechsel', { detail: { track: a.track, vorher: vorher.track } }));
    }
    // Gespieltes freigeben, damit der Puffer nicht voll läuft
    this.aufraeumen();
  }

  gepuffertBis(zeit) {
    const b = this.sb?.buffered;
    if (!b) return zeit;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= zeit + 0.1 && b.end(i) > zeit) return b.end(i);
    return zeit;
  }

  /** Spulen im laufenden Titel. Liegt die Stelle schon im Puffer: direkt; sonst ab dort neu laden. */
  springen(sek) {
    const a = this.aktuell || this.abschnitte[0];
    if (!a) return false;
    const ziel = a.start + Math.max(0, Math.min(sek, a.dauer - 0.05));
    const b = this.sb?.buffered;
    if (b) {
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= ziel && ziel < b.end(i) - 0.2) { this.audio.currentTime = ziel; return true; }
      }
    }
    return false; // Player startet neu ab dieser Stelle
  }

  /** Manuell zu einem Titel springen, der schon vorgeladen ist (z. B. „Weiter“) – ohne neu zu laden */
  springeZuTitel(track) {
    const a = this.abschnitte.find((x) => x.track === track && x !== this.aktuell);
    if (!a) return false;
    const b = this.sb?.buffered;
    if (!b) return false;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= a.start + 0.01 && a.start + 0.5 < b.end(i)) {
        this.aktuell = a;
        this.audio.currentTime = a.start + 0.0001;
        return true;
      }
    }
    return false;
  }

  // ---------- Einfüllen ----------
  async warten(sitzung) {
    // Erst weiter laden, wenn der Vorlauf unter die Grenze fällt (und bei ManagedMediaSource, wenn das System es erlaubt)
    for (;;) {
      if (sitzung !== this.sitzung) throw new DOMException('abgebrochen', 'AbortError');
      const vorlauf = this.gepuffertBis(this.audio.currentTime) - this.audio.currentTime;
      const darf = !this.ms || this.ms.streaming === undefined || this.ms.streaming;
      if (vorlauf < this.voraus && darf) return;
      await schlafen(400);
    }
  }

  async anhaengen(sitzung, daten) {
    for (let versuch = 0; ; versuch++) {
      if (sitzung !== this.sitzung) throw new DOMException('abgebrochen', 'AbortError');
      if (this.sb.updating) await new Promise((r) => this.sb.addEventListener('updateend', r, { once: true }));
      try {
        this.sb.appendBuffer(daten);
        await new Promise((r, f) => {
          this.sb.addEventListener('updateend', r, { once: true });
          this.sb.addEventListener('error', () => f(new Error('MSE-Fehler')), { once: true });
        });
        if (this.startZeit !== null && this.startZeit !== undefined) {
          // Start mitten im Titel: sobald die ersten Daten da sind, dorthin springen
          this.audio.currentTime = this.startZeit;
          this.startZeit = null;
        }
        return;
      } catch (e) {
        if (e.name !== 'QuotaExceededError' || versuch > 30) throw e;
        // Speicher voll: Gespieltes freigeben, Vorlauf verkleinern, kurz warten
        this.voraus = Math.max(10, this.voraus - 5);
        await this.aufraeumen(true);
        await schlafen(800);
      }
    }
  }

  async aufraeumen(sofort = false) {
    const sb = this.sb;
    if (!sb || sb.updating || !sb.buffered.length) return;
    const jetzt = this.audio.currentTime;
    const anfang = sb.buffered.start(0);
    if (jetzt - anfang > (sofort ? 4 : 20)) {
      // remove() öffnet einen schon abgeschlossenen Strom wieder (MSE-Standard) – dann „ended“ nie käme: danach erneut abschließen
      const warZu = this.ms?.readyState === 'ended';
      try {
        sb.remove(anfang, jetzt - 3);
        await new Promise((r) => sb.addEventListener('updateend', r, { once: true }));
        if (warZu && this.ms?.readyState === 'open' && !sb.updating) this.ms.endOfStream();
      } catch (e) { /* egal */ }
    }
  }

  fensterSetzen(von, bis, versatz) {
    this.sb.appendWindowEnd = Infinity;
    this.sb.appendWindowStart = Math.max(0, von);
    this.sb.appendWindowEnd = bis;
    this.sb.timestampOffset = versatz;
  }

  async holen(sitzung, url) {
    this.abbruch = new AbortController();
    // Direkt im Heimnetz, wenn erreichbar – sonst (oder wenn das scheitert) über den normalen Weg
    const voll = netzweg.url(url);
    const direkt = voll !== url;
    try {
      const r = await fetch(voll, { signal: this.abbruch.signal, credentials: direkt ? 'omit' : 'same-origin', mode: direkt ? 'cors' : 'same-origin' });
      if (!r.ok) {
        if (direkt) {
          if (r.status === 401) netzweg.tokenErneuern();
          netzweg.ausfall();
          return this.holen(sitzung, url);
        }
        throw new Error(`Stream ${r.status}`);
      }
      this.direkt = direkt;
      return r;
    } catch (e) {
      if (direkt && e.name !== 'AbortError' && sitzung === this.sitzung) {
        netzweg.ausfall();
        return this.holen(sitzung, url);
      }
      throw e;
    }
  }

  /** Körper einer Antwort stückweise in den Puffer; gibt bei Abriss false zurück */
  async pumpen(sitzung, antwort) {
    const leser = antwort.body.getReader();
    let puffer = [];
    let groesse = 0;
    try {
      for (;;) {
        const { done, value } = await leser.read();
        if (value) { puffer.push(value); groesse += value.length; }
        // in Blöcken von ~256 KB anhängen (weniger Aufrufe, trotzdem früh hörbar)
        if (groesse >= 256 * 1024 || (done && groesse)) {
          const block = new Uint8Array(groesse);
          let o = 0;
          for (const p of puffer) { block.set(p, o); o += p.length; }
          puffer = []; groesse = 0;
          await this.warten(sitzung);
          await this.anhaengen(sitzung, block);
        }
        if (done) return true;
      }
    } catch (e) {
      if (e.name === 'AbortError' || sitzung !== this.sitzung) throw e;
      return false; // Verbindung abgerissen (z. B. Tunnel-Timeout in einer langen Pause) – Aufrufer setzt fort
    }
  }

  /** Haupt-Schleife: ab track (Startpunkt start im Zeitstrahl, Sekunde ab im Titel) Titel für Titel bzw. Kette für Kette einfüllen */
  async zufuehren(sitzung, track, ab, start = 0) {
    let t = track;
    let s = start;
    let pos = ab;
    while (t) {
      if (sitzung !== this.sitzung) return;
      if (this.art === 'flac') {
        if (await this.titelEinfuellen(sitzung, t, s, pos) === 'formatwechsel') break; // Rest kommt nach „ended“ frisch

        const a = this.abschnitte[this.abschnitte.length - 1];
        s = a.start + a.dauer;
        t = this.quelle.naechster(t);
      } else if (this.quelle.lokal?.(t)) {
        await this.lokalEinfuellen(sitzung, t, s, pos);
        const a = this.abschnitte[this.abschnitte.length - 1];
        s = a.start + a.dauer;
        t = this.quelle.naechster(t);
      } else {
        // Kette: aufeinanderfolgende Titel derselben Edition am Stück kodiert
        const kette = [t];
        let x = t;
        while (kette.length < KETTE_MAX) {
          const n = this.quelle.naechster(x);
          if (!n || !n.album || !t.album || n.album.edition_id !== t.album.edition_id || kette.includes(n) || this.quelle.lokal?.(n)) break;
          kette.push(n);
          x = n;
        }
        await this.ketteEinfuellen(sitzung, kette, s, pos);
        const a = this.abschnitte[this.abschnitte.length - 1];
        s = a.start + a.dauer;
        t = this.quelle.naechster(kette[kette.length - 1]);
      }
      pos = 0;
      if (t) await this.warten(sitzung);
    }
    // Ende der Warteschlange: Strom abschließen, damit „ended“ kommt
    if (sitzung !== this.sitzung) return;
    if (this.sb.updating) await new Promise((r) => this.sb.addEventListener('updateend', r, { once: true }));
    if (this.ms.readyState === 'open') { try { this.ms.endOfStream(); } catch (e) { /* egal */ } }
  }

  async titelEinfuellen(sitzung, track, start, ab) {
    let abschnitt = null;
    let pos = ab;
    for (let versuch = 0; versuch < 6; versuch++) {
      const r = await this.holen(sitzung, `/api/v1/stream/${track.id}?q=original&art=luecken${pos > 0 ? `&t=${pos.toFixed(3)}` : ''}`);
      const samples = Number(r.headers.get('X-Samples')) || 0;
      const rate = Number(r.headers.get('X-Rate')) || 0;
      // Anderes Format (Abtastrate, Kanäle, Bittiefe) als bisher in diesem Puffer? Dann nicht anhängen: Der Strom endet
      // hier, und der Player startet den Titel in einem frischen Puffer (Formatwechsel mitten im Puffer verursacht in
      // manchen Browsern Pfeifen/Störgeräusche, die bis zum Neuladen bleiben)
      const format = r.headers.get('X-Format') || String(rate || '');
      if (!abschnitt && this.abschnitte.length && this.format && format && format !== this.format) {
        try { await r.body?.cancel(); } catch (e) { /* egal */ }
        return 'formatwechsel';
      }
      if (!this.abschnitte.length || !this.format) this.format = format;
      const dauer = samples && rate ? samples / rate : (track.laenge_ms || 0) / 1000;
      if (!abschnitt) {
        abschnitt = { track, start, dauer, ab, geladen: false, bitgenau: r.headers.get('X-Bitgenau') === '1' };
        this.abschnitte.push(abschnitt);
        if (this.abschnitte.length === 1) this.aktuell = abschnitt;
      }
      this.fensterSetzen(start, start + dauer, start + pos);
      const ok = await this.pumpen(sitzung, r);
      if (ok) { abschnitt.geladen = true; return; }
      if (this.direkt) netzweg.ausfall();
      // Abriss: ab dem, was schon im Puffer liegt, weiterladen
      pos = Math.max(pos, this.gepuffertBis(Math.max(start + pos, this.audio.currentTime)) - start - 0.05);
      await schlafen(500 * (versuch + 1));
    }
    throw new Error(t('Verbindung zum Server immer wieder abgerissen'));
  }

  /** Offline gespeicherter Titel (WebM/Opus aus dem Speicher der App): ganz anhängen, auf die exakte Länge beschnitten */
  async lokalEinfuellen(sitzung, track, start, ab) {
    const blob = await this.quelle.ton(track);
    if (sitzung !== this.sitzung) throw new DOMException('abgebrochen', 'AbortError');
    if (!blob) throw new Error(t('Gespeicherter Titel fehlt'));
    const dauer = this.quelle.dauer?.(track) || (track.laenge_ms || 0) / 1000;
    const abschnitt = { track, start, dauer, ab, geladen: false, lokal: true };
    this.abschnitte.push(abschnitt);
    if (this.abschnitte.length === 1) this.aktuell = abschnitt;
    this.fensterSetzen(start, start + dauer, start);
    await this.pumpen(sitzung, new Response(blob));
    abschnitt.geladen = true;
  }

  async ketteEinfuellen(sitzung, kette, start, ab) {
    let erste = 0;
    let pos = ab;
    let angelegt = false;
    for (let versuch = 0; versuch < 6; versuch++) {
      const ids = kette.slice(erste).map((t) => t.id).join(',');
      // Lautheitsangleich je Titel (dB) – der Server rechnet ihn vor dem Kodieren ein
      const gains = kette.slice(erste).map((t) => Number(this.quelle.gain?.(t)) || 0);
      const g = gains.some((x) => x) ? `&g=${gains.map((x) => (x ? x.toFixed(2) : '')).join(',')}` : '';
      const r = await this.holen(sitzung, `/api/v1/stream/kette?ids=${ids}&q=${encodeURIComponent(this.qualitaet)}${pos > 0 ? `&t=${pos.toFixed(3)}` : ''}${g}`);
      const dauern = (r.headers.get('X-Dauern') || '').split(',').map(Number);
      let s = start;
      if (!angelegt) {
        kette.forEach((t, i) => {
          const d = dauern[i] || (t.laenge_ms || 0) / 1000;
          this.abschnitte.push({ track: t, start: s, dauer: d, ab: i === 0 ? ab : 0, geladen: false, kette: true });
          s += d;
        });
        if (this.abschnitte.length === kette.length && !this.aktuell) this.aktuell = this.abschnitte[0];
        angelegt = true;
      }
      const meine = this.abschnitte.slice(this.abschnitte.length - kette.length);
      const basis = meine[erste];
      const ende = meine[meine.length - 1].start + meine[meine.length - 1].dauer;
      this.fensterSetzen(basis.start, ende, basis.start + pos);
      const ok = await this.pumpen(sitzung, r);
      if (ok) { meine.forEach((x) => { x.geladen = true; }); return; }
      if (this.direkt) netzweg.ausfall();
      // Abriss: beim Titel weitermachen, in dem der Puffer endet
      const bis = this.gepuffertBis(Math.max(basis.start + pos, this.audio.currentTime));
      const idx = meine.findIndex((x) => bis < x.start + x.dauer);
      erste = Math.max(erste, idx < 0 ? meine.length - 1 : idx);
      pos = Math.max(0, bis - meine[erste].start - 0.05);
      await schlafen(500 * (versuch + 1));
    }
    throw new Error(t('Verbindung zum Server immer wieder abgerissen'));
  }

  /**
   * Die Warteschlange hat sich geändert (Titel eingefügt, entfernt, gemischt …).
   * Stimmt das Vorgeladene nicht mehr, wird ab dem nächsten Titel neu geladen. Gibt false zurück,
   * wenn der Player neu starten muss (Änderung mitten in einer laufenden Kette).
   */
  planPruefen() {
    if (!this.aktiv || !this.aktuell) return true;
    const i = this.abschnitte.indexOf(this.aktuell);
    let erwartet = this.quelle.naechster(this.aktuell.track);
    for (let k = i + 1; k < this.abschnitte.length; k++) {
      if (this.abschnitte[k].track !== erwartet) {
        if (this.abschnitte[k].kette && this.abschnitte[k - 1].kette && !this.abschnitte[k - 1].geladen) return false;
        this.abschneiden(k);
        return true;
      }
      erwartet = this.quelle.naechster(this.abschnitte[k].track);
    }
    // Alles stimmt; hängt hinten noch etwas an, das bisher fehlte (Strom war schon abgeschlossen)?
    if (this.ms?.readyState === 'ended' && erwartet) this.abschneiden(this.abschnitte.length);
    return true;
  }

  /** Ab Abschnitt k alles verwerfen und dort neu einfüllen */
  async abschneiden(k) {
    const sitzung = ++this.sitzung;
    this.abbruch?.abort();
    const sb = this.sb;
    const ab = k < this.abschnitte.length ? this.abschnitte[k].start : (this.abschnitte.at(-1).start + this.abschnitte.at(-1).dauer);
    const vorher = this.abschnitte[k - 1];
    this.abschnitte = this.abschnitte.slice(0, k);
    try {
      if (sb.updating) await new Promise((r) => sb.addEventListener('updateend', r, { once: true }));
      sb.remove(ab, Infinity); // öffnet einen abgeschlossenen Strom wieder
      await new Promise((r) => sb.addEventListener('updateend', r, { once: true }));
    } catch (e) { /* egal */ }
    if (sitzung !== this.sitzung) return;
    const naechster = vorher ? this.quelle.naechster(vorher.track) : null;
    if (!naechster) {
      if (this.ms.readyState === 'open') { try { this.ms.endOfStream(); } catch (e) { /* egal */ } }
      return;
    }
    this.zufuehren(sitzung, naechster, 0, ab).catch((e) => {
      if (sitzung === this.sitzung && e.name !== 'AbortError') this.dispatchEvent(new CustomEvent('fehler', { detail: e }));
    });
  }
}
