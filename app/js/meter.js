// Meter für die Analyse: „Digital“ (Peak/RMS je Kanal, Lautheit M/S/I live, Korrelation) oder „VU“ im Vintage-Look
// (träge analoge Nadel: ~0,5 s Anstieg, ~4,6 % Überschwingen). Stereo, Quadro und 5.1.
// Messdaten kommen von den Analysern hinter EQ/Raumklang und vor der Lautstärke (wie die Pegelanzeige in der Leiste).

import { t, zahl } from './i18n.js';

const MONO = '"JetBrains Mono", ui-monospace, "DejaVu Sans Mono", monospace';
const SANS = 'Manrope, system-ui, "DejaVu Sans", sans-serif';
const kz = (x, n = 1) => (x == null || !isFinite(x) ? '–' : zahl(x, n).replace('-', '−'));
const dbVon = (lin) => (lin > 1e-9 ? 20 * Math.log10(lin) : -200);

/**
 * VU-Skala: 'lu' = die Nadel zeigt die K-bewertete Lautheit (400 ms, wie EBU R128 Momentary) relativ zum Zielwert –
 * 0 VU = Ziel (z. B. −16 LUFS), +3 = 3 LU lauter. Die übrigen sind ein klassisches VU (Gleichrichtwert, ungewichtet):
 * 'auto' = 0 VU 3 dB über der integrierten Lautheit des Titels, Zahlen = feste Referenz in dBFS.
 */
export const VU_REFERENZEN = ['lu', 'auto', -14, -18, -20];
const GEWICHT = { L: 1, R: 1, C: 1, LFE: 0, Ls: 1.41, Rs: 1.41 }; // BS.1770 Kanalgewichte
const lufsVon = (p) => (p > 1e-12 ? -0.691 + 10 * Math.log10(p) : -200);

/** Pegel-Skala Digital: oben feiner (0…−12 = 40 %, −12…−30 = 35 %, −30…−60 = 25 %) */
function skala(db) {
  const d = Math.max(-60, Math.min(0, db));
  if (d >= -12) return 0.6 + ((d + 12) / 12) * 0.4;
  if (d >= -30) return 0.25 + ((d + 30) / 18) * 0.35;
  return ((d + 60) / 30) * 0.25;
}

export class Meter {
  constructor() {
    this.halten = [];      // Peak-Hold je Kanal (dB) und Zeit
    this.maxPeak = [];     // höchster Peak seit Titelbeginn bzw. Klick
    this.vu = [];          // Nadel je Kanal { x, v } (linear, 0 VU = 1)
    this.korr = 1;
    this.puffer = null;
    this.zuletzt = 0;
    this.flaechen = [];    // Klickflächen (Referenz umschalten, Peak zurücksetzen)
    this.lautheitNeu();
  }

  /** Spitzenwerte zurücksetzen; alles = auch die laufende Lautheitsmessung (neuer Titel) */
  zuruecksetzen(alles = true) { this.maxPeak = []; this.halten = []; if (alles) this.lautheitNeu(); }

  lautheitNeu() { this.lh = { bloecke: [], blockE: 0, blockN: 0, tore: [] }; }

  /**
   * Live-Lautheit am Messpunkt (K-bewertet, BS.1770): je Kanal und gesamt Momentary (400 ms), Short-term (3 s) und
   * integriert seit Titelbeginn (Absolut-Tor −70, relatives Tor −10 LU). Neue Samples je Bild werden zu 100-ms-Blöcken summiert.
   */
  lautheitMessen(rk, namen, dt, laeuft) {
    const an = rk.lautheitAnalyser();
    const n = an[0].fftSize, sr = rk.ctx.sampleRate;
    if (!this.khPuffer || this.khPuffer.length !== n) this.khPuffer = new Float32Array(n);
    const fenster = Math.min(n, Math.round(sr * 0.4));
    const neu = Math.min(n, Math.max(0, Math.round(dt * sr)));
    const p = this.khPuffer;
    let mSumme = 0, neuE = 0;
    const kanal = namen.map((name, c) => {
      an[c].getFloatTimeDomainData(p);
      let q = 0;
      for (let i = n - fenster; i < n; i++) q += p[i] * p[i];
      const ms = q / fenster;
      const gw = GEWICHT[name] ?? 1;
      mSumme += gw * ms;
      if (laeuft && gw) { let e = 0; for (let i = n - neu; i < n; i++) e += p[i] * p[i]; neuE += gw * e; }
      return lufsVon(2 * ms); // je Kanal so, als läge er auf beiden Seiten (Stereo-Mitte = Gesamtlautheit)
    });
    const lh = this.lh;
    if (laeuft && neu > 0) {
      lh.blockE += neuE; lh.blockN += neu;
      if (lh.blockN >= sr * 0.1) {
        lh.bloecke.push(lh.blockE / lh.blockN);
        if (lh.bloecke.length > 30) lh.bloecke.shift();
        lh.blockE = 0; lh.blockN = 0;
        if (lh.bloecke.length >= 4) {
          const z = lh.bloecke.slice(-4).reduce((a, b) => a + b, 0) / 4;
          if (lufsVon(z) > -70) lh.tore.push(z);
        }
      }
    }
    const sListe = lh.bloecke;
    const sWert = sListe.length >= 10 ? lufsVon(sListe.reduce((a, b) => a + b, 0) / sListe.length) : null;
    let iWert = null;
    if (lh.tore.length) {
      const mittel = lh.tore.reduce((a, b) => a + b, 0) / lh.tore.length;
      const schwelle = lufsVon(mittel) - 10;
      const drin = lh.tore.filter((z) => lufsVon(z) > schwelle);
      if (drin.length) iWert = lufsVon(drin.reduce((a, b) => a + b, 0) / drin.length);
    }
    const m = lufsVon(mSumme);
    return { kanal, m: m > -70 ? m : null, s: sWert != null && sWert > -70 ? sWert : null, i: iWert };
  }

  /** Kanäle messen: Peak, RMS (AES17: Sinus Vollaussteuerung = 0 dBFS) und Gleichrichtwert (für VU) */
  messen(rk) {
    const layout = rk.layout;
    const namen = !layout ? ['L', 'R'] : layout.kanaele === 4 ? ['L', 'R', 'Ls', 'Rs'] : ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'];
    const n = rk.analyser[0].fftSize;
    if (!this.puffer || this.puffer.length !== n) { this.puffer = new Float32Array(n); this.pufferR = new Float32Array(n); }
    const kanaele = namen.map((name, c) => {
      const p = c === 1 ? this.pufferR : this.puffer;
      rk.analyser[c].getFloatTimeDomainData(p);
      let peak = 0, q = 0, betrag = 0;
      for (let i = 0; i < n; i++) { const v = p[i], a = v < 0 ? -v : v; if (a > peak) peak = a; q += v * v; betrag += a; }
      let korr = null;
      if (c === 1) {
        let lr = 0, ll = 0, rr = 0;
        const l = this.puffer, r = this.pufferR;
        // Puffer 0 wurde für Kanal 0 gefüllt und seitdem nicht überschrieben (Kanal 1 nutzt pufferR)
        for (let i = 0; i < n; i++) { lr += l[i] * r[i]; ll += l[i] * l[i]; rr += r[i] * r[i]; }
        korr = ll > 1e-10 && rr > 1e-10 ? lr / Math.sqrt(ll * rr) : null;
      }
      return { name, peak, rms: Math.sqrt((q / n) * 2), gleich: (betrag / n) * 1.1107 * Math.SQRT2, korr };
    });
    return kanaele;
  }

  /**
   * Zeichnet ins Canvas. art: 'digital' | 'vu'; lufs: {i (integriert aus der Titelmessung), ziel} oder null;
   * referenz: {art: 'lu', ziel} oder {db: dBFS für 0 VU, auto}; laeuft: spielt gerade (sonst keine Lautheit sammeln)
   */
  zeichnen(c, rk, art, lufs, referenz, dpr, laeuft = true) {
    const g = c.getContext('2d');
    const w = c.width, hh = c.height;
    g.clearRect(0, 0, w, hh);
    this.flaechen = [];
    if (!rk?.ctx || !rk.analyser) return;
    const jetzt = performance.now() / 1000;
    const dt = Math.min(0.1, this.zuletzt ? jetzt - this.zuletzt : 0.016);
    this.zuletzt = jetzt;
    const kanaele = this.messen(rk);
    const k1 = kanaele[1]?.korr;
    this.korr += ((k1 ?? this.korr) - this.korr) * Math.min(1, dt * 4);
    if (k1 == null && kanaele[0].peak < 1e-6) this.korr += (1 - this.korr) * Math.min(1, dt * 2);
    const live = this.lautheitMessen(rk, kanaele.map((k) => k.name), dt, laeuft);
    this.letzteLive = live;
    if (art === 'vu') this.vuZeichnen(g, w, hh, dpr, kanaele, referenz, dt, live);
    else {
      // M und S live gemessen; integriert aus der Titelmessung (ganzer Titel), sonst live seit Titelbeginn
      const anzeige = { m: live.m, s: live.s, i: lufs?.i ?? live.i, ziel: lufs?.ziel ?? null };
      this.digitalZeichnen(g, w, hh, dpr, kanaele, anzeige, dt, jetzt);
    }
  }

  // ---------- Digital ----------
  digitalZeichnen(g, w, hh, dpr, kanaele, lufs, dt, jetzt) {
    const oben = 30 * dpr, unten = hh - 78 * dpr;
    const y = (db) => unten - skala(db) * (unten - oben);
    const n = kanaele.length;
    // Lautheits-Bereich immer zeigen (beim Titelwechsel / ohne Messung als leerer Platzhalter), damit nichts springt
    const mitLufs = true;
    lufs = lufs || { m: null, s: null, i: null, ziel: null };
    const skalaB = 26 * dpr;
    const lw = 24 * dpr;                                  // LUFS-Balken schmal – L/R sind die Hauptsache
    const lufsB = mitLufs ? 3 * lw + 2 * 8 * dpr + 30 * dpr : 0;
    const frei = w - skalaB - lufsB - 12 * dpr;
    const lueck = (n > 2 ? 5 : 12) * dpr;
    // L und R breiter als die übrigen Kanäle (Quadro/5.1)
    const gewicht = kanaele.map((k, i) => (n > 2 && i < 2 ? 1.5 : 1));
    const summeG = gewicht.reduce((a, b) => a + b, 0);
    const einheit = Math.max(8 * dpr, Math.min((n > 2 ? 24 : 46) * dpr, (frei - (n - 1) * lueck) / summeG));
    const breiten = gewicht.map((x) => x * einheit);
    const gesamtB = breiten.reduce((a, b) => a + b, 0) + (n - 1) * lueck;
    const x0 = skalaB + 4 * dpr + Math.max(0, (frei - gesamtB) / 2); // Kanalgruppe mittig, Skala direkt daneben
    const lagen = [];
    breiten.reduce((x, b) => { lagen.push(x); return x + b + lueck; }, x0);
    // Skala
    g.font = `${9.5 * dpr}px ${MONO}`; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (const d of [0, -3, -6, -9, -12, -18, -24, -30, -40, -50, -60]) {
      g.fillStyle = 'rgba(156,143,130,.85)'; g.fillText(String(d).replace('-', '−'), x0 - 6 * dpr, y(d));
      g.fillStyle = 'rgba(255,236,214,.05)'; g.fillRect(x0 - 2 * dpr, Math.round(y(d)), gesamtB + 4 * dpr, dpr);
    }
    const segH = 3 * dpr;
    kanaele.forEach((k, i) => {
      const bx = lagen[i], bw = breiten[i], gross = i < 2;
      const pdb = dbVon(k.peak), rdb = dbVon(k.rms);
      const hl = this.halten[i] || { db: -200, t: 0 };
      if (pdb >= hl.db) { hl.db = pdb; hl.t = jetzt; } else if (jetzt - hl.t > 1.5) hl.db -= 20 * dt; // 1,5 s halten, dann 20 dB/s
      this.halten[i] = hl;
      if (pdb > (this.maxPeak[i] ?? -200)) this.maxPeak[i] = pdb;
      for (let yy = unten; yy > oben; yy -= segH + dpr) {
        const anteil = (unten - yy) / (unten - oben);
        // dB am Segment (Umkehrung der Skala, grob reicht für die Farbe)
        const d = anteil >= 0.6 ? -12 + ((anteil - 0.6) / 0.4) * 12 : anteil >= 0.25 ? -30 + ((anteil - 0.25) / 0.35) * 18 : -60 + (anteil / 0.25) * 30;
        const farbe = d >= -3 ? '255,107,107' : d >= -12 ? '255,181,71' : '95,220,164';
        const an = yy - segH >= y(pdb) - 0.5;
        g.fillStyle = an ? `rgba(${farbe},${yy - segH >= y(rdb) ? 1 : 0.5})` : `rgba(${farbe},.07)`;
        g.fillRect(bx, yy - segH, bw, segH);
      }
      if (hl.db > -60) { g.fillStyle = hl.db > -0.1 ? '#ff6b6b' : '#f6efe7'; g.fillRect(bx, y(hl.db) - dpr, bw, 2 * dpr); }
      g.textAlign = 'center'; g.textBaseline = 'alphabetic';
      g.fillStyle = gross ? '#f6efe7' : 'rgba(188,174,159,.95)'; g.font = `${gross ? '600 ' : ''}${(gross ? 12 : 10) * dpr}px ${MONO}`;
      g.fillText(k.name, bx + bw / 2, oben - 8 * dpr);
      const mp = this.maxPeak[i] ?? -200;
      g.fillStyle = mp > -0.1 ? '#ff6b6b' : '#f6efe7';
      const txt = mp > -100 ? kz(mp) : '–';
      const fs = gross ? 14 : 11;
      g.font = `600 ${fs * dpr}px ${MONO}`;
      const tw = g.measureText(txt).width;
      if (tw > bw + lueck - 2 * dpr) g.font = `600 ${Math.max(7, fs * (bw + lueck - 2 * dpr) / tw) * dpr}px ${MONO}`;
      g.fillText(txt, bx + bw / 2, unten + (gross ? 17 : 15) * dpr);
    });
    this.flaechen.push({ x0: x0, x1: x0 + gesamtB, y0: unten, y1: unten + 20 * dpr, aktion: 'peak', titel: t('Klick: Spitzenwerte zurücksetzen') });
    g.fillStyle = 'rgba(156,143,130,.7)'; g.font = `${9 * dpr}px ${SANS}`; g.textAlign = 'center';
    g.fillText(t('dBFS · Peak / RMS · Klick: Spitzen zurücksetzen'), x0 + gesamtB / 2, unten + 32 * dpr);
    // Lautheit M / S / I (aus der Messung des Titels, an der Abspielposition)
    if (mitLufs) {
      const lx = w - lufsB + 22 * dpr;
      const MIN = -36, MAX = -6;
      const ly = (v) => unten - ((Math.max(MIN, Math.min(MAX, v)) - MIN) / (MAX - MIN)) * (unten - oben);
      [['M', lufs.m], ['S', lufs.s], ['I', lufs.i]].forEach(([name, v], i) => {
        const bx = lx + i * (lw + 8 * dpr);
        g.fillStyle = 'rgba(255,236,214,.05)'; g.fillRect(bx, oben, lw, unten - oben);
        if (v != null) {
          const verlauf = g.createLinearGradient(0, unten, 0, oben);
          verlauf.addColorStop(0, 'rgba(255,181,71,.22)'); verlauf.addColorStop(1, 'rgba(255,181,71,.9)');
          g.fillStyle = verlauf; g.fillRect(bx, ly(v), lw, unten - ly(v));
        }
        g.fillStyle = 'rgba(188,174,159,.95)'; g.font = `${10 * dpr}px ${MONO}`; g.textAlign = 'center';
        g.fillText(name, bx + lw / 2, oben - 8 * dpr);
        g.fillStyle = '#f6efe7'; g.font = `600 ${9 * dpr}px ${MONO}`;
        const tw = g.measureText(kz(v)).width;
        if (tw > lw + 6 * dpr) g.font = `600 ${Math.max(7, (9 * (lw + 6 * dpr)) / tw) * dpr}px ${MONO}`;
        g.fillText(kz(v), bx + lw / 2, unten + 15 * dpr);
      });
      g.textAlign = 'right'; g.font = `${8.5 * dpr}px ${MONO}`; g.fillStyle = 'rgba(156,143,130,.8)';
      for (const v of [-6, -12, -18, -24, -30, -36]) g.fillText(String(v).replace('-', '−'), lx - 3 * dpr, ly(v) + 3 * dpr);
      if (lufs.ziel != null) {
        g.strokeStyle = 'rgba(95,220,164,.85)'; g.lineWidth = dpr; g.setLineDash([3 * dpr, 3 * dpr]);
        g.beginPath(); g.moveTo(lx - 2 * dpr, ly(lufs.ziel)); g.lineTo(lx + 3 * lw + 20 * dpr, ly(lufs.ziel)); g.stroke(); g.setLineDash([]);
      }
      g.fillStyle = 'rgba(156,143,130,.7)'; g.font = `${9 * dpr}px ${SANS}`; g.textAlign = 'center';
      g.fillText('LUFS', lx + (3 * lw + 16 * dpr) / 2, unten + 32 * dpr);
    }
    this.korrelationZeichnen(g, w, hh, dpr);
  }

  korrelationZeichnen(g, w, hh, dpr) {
    const ky = hh - 20 * dpr, kx = 14 * dpr, kw = w - 28 * dpr, mitte = kx + kw / 2;
    g.fillStyle = 'rgba(255,236,214,.06)'; g.fillRect(kx, ky, kw, 5 * dpr);
    const k = Math.max(-1, Math.min(1, this.korr));
    g.fillStyle = k < 0 ? '#ff6b6b' : k < 0.3 ? '#ffb547' : '#5fdca4';
    g.fillRect(Math.min(mitte, mitte + (k * kw) / 2), ky, Math.abs((k * kw) / 2), 5 * dpr);
    g.fillStyle = 'rgba(246,239,231,.5)'; g.fillRect(mitte, ky - 3 * dpr, dpr, 11 * dpr);
    g.font = `${8.5 * dpr}px ${MONO}`; g.fillStyle = 'rgba(156,143,130,.85)';
    g.textAlign = 'left'; g.fillText('−1', kx, ky - 4 * dpr);
    g.textAlign = 'right'; g.fillText('+1', kx + kw, ky - 4 * dpr);
    g.textAlign = 'center'; g.fillText(t('Korrelation L/R {wert}', { wert: kz(k, 2) }), mitte, ky - 4 * dpr);
  }

  // ---------- VU ----------
  vuZeichnen(g, w, hh, dpr, kanaele, referenz, dt, live) {
    const fuenf = kanaele.length === 6;
    const kopf = kanaele.length > 2 ? 6 : 3;              // Surround: Skala bis +6 (Headroom), Stereo bis +3
    const fussH = 34 * dpr;
    const rand = 8 * dpr, lueck = 10 * dpr;
    // Anordnung: Stereo untereinander; Quadro 2×2; 5.1 alle sechs – 2 Spalten (L R / C LFE / Ls Rs) oder
    // 3 Spalten wie die Lautsprecher (L C R / Ls LFE Rs), je nachdem, was größere Instrumente ergibt
    const varianten = kanaele.length === 2 ? [[1, [0, 1]]] : fuenf ? [[2, [0, 1, 2, 3, 4, 5]], [3, [0, 2, 1, 4, 3, 5]]] : [[2, [0, 1, 2, 3]]];
    const masse = varianten.map(([sp, liste]) => {
      const zl = Math.ceil(liste.length / sp);
      const breite = (w - 2 * rand - (sp - 1) * lueck) / sp;
      const hoehe = Math.min((hh - fussH - rand - (zl - 1) * lueck) / zl, breite * 0.5);
      return { raster: sp, anzeigen: liste, zeilen: zl, zw: hoehe * 2 < breite ? Math.min(breite, hoehe * 2.2) : breite, zh: hoehe };
    }).sort((a, b) => b.zh - a.zh)[0];
    const { raster, anzeigen, zeilen, zw, zh } = masse;
    const x0r = rand + Math.max(0, (w - 2 * rand - (raster * zw + (raster - 1) * lueck)) / 2);
    const gesamtH = zeilen * zh + (zeilen - 1) * lueck;
    const y0 = rand + Math.max(0, (hh - fussH - rand - gesamtH) / 2);
    // Ballistik je Kanal (Feder-Masse: ω = 6/s, ζ = 0,7 → Endwert nach ~0,5 s, ~4,6 % Überschwingen – etwas träger und
    // schwerer als die Norm-VU mit 300 ms, wirkt wie ein großes analoges Instrument)
    const luModus = referenz.art === 'lu';
    const ref = Math.pow(10, (referenz.db ?? -18) / 20);
    kanaele.forEach((k, i) => {
      const s = this.vu[i] || { x: 0, v: 0 };
      // LU: Lautheit des Kanals relativ zum Ziel als Spannung (0 VU = Ziel); klassisch: Gleichrichtwert zur Referenz
      const ziel = luModus ? Math.pow(10, (live.kanal[i] - referenz.ziel) / 20) : k.gleich / ref;
      const om = 6, ze = 0.7;
      for (let t = 0; t < dt; t += 0.002) {
        const a = om * om * (ziel - s.x) - 2 * ze * om * s.v;
        s.v += a * 0.002; s.x += s.v * 0.002;
      }
      s.x = Math.max(0, Math.min(2.3, s.x));
      this.vu[i] = s;
    });
    anzeigen.forEach((kanal, j) => {
      const sp = j % raster, ze = Math.floor(j / raster);
      const px = x0r + sp * (zw + lueck), py = y0 + ze * (zh + lueck);
      this.vuInstrument(g, px, py, zw, zh, dpr, kanaele[kanal], this.vu[kanal].x, kanaele[kanal].peak, kopf);
    });
    const fy = hh - fussH + 8 * dpr;
    g.textBaseline = 'alphabetic'; g.textAlign = 'center';
    g.fillStyle = 'rgba(156,143,130,.9)'; g.font = `${9.5 * dpr}px ${MONO}`;
    const text = luModus ? t('0 VU = {ziel} LUFS (Ziel) · K-bewertet', { ziel: kz(referenz.ziel, 0) })
      : referenz.auto ? t('klassisch · 0 VU = Auto ({db} dBFS)', { db: kz(referenz.db) }) : t('klassisch · 0 VU = {db} dBFS', { db: kz(referenz.db, 0) });
    g.fillText(text, w / 2, fy + 10 * dpr);
    const tb = g.measureText(text).width;
    this.flaechen.push({ x0: w / 2 - tb / 2, x1: w / 2 + tb / 2, y0: fy - 2 * dpr, y1: fy + 14 * dpr, aktion: 'referenz', titel: t('Klick: Skala umschalten – Lautheit (0 VU = Ziel) / klassisch Auto / −14 / −18 / −20 dBFS') });
  }

  vuInstrument(g, px, py, pw, ph, dpr, kanal, x, peak, kopf = 3) {
    // Skala linear in der Spannung wie beim echten VU; mit +6 dB Headroom leicht gespreizt (Exponent 0,7), damit der
    // Minusbereich nicht zusammengedrückt wird
    const e = kopf > 3 ? 0.7 : 1;
    const aMin = Math.pow(0.1, e), aMax = Math.pow(10, (kopf / 20) * e);
    const winkel = (lin) => -Math.PI / 2 + ((Math.pow(Math.max(0, Math.min(Math.pow(10, kopf / 20) * 1.06, lin)), e) - aMin) / (aMax - aMin) - 0.5) * (Math.PI / 2);
    const A = (vu) => winkel(Math.pow(10, vu / 20));
    g.save();
    g.fillStyle = '#0b0806';
    g.beginPath(); g.roundRect(px - 4 * dpr, py - 4 * dpr, pw + 8 * dpr, ph + 8 * dpr, 8 * dpr); g.fill();
    g.beginPath(); g.roundRect(px, py, pw, ph, 6 * dpr); g.clip();
    const cx = px + pw / 2, R = Math.min(ph * 1.15, pw * 0.5), cy = py + ph * 0.22 + R;
    const licht = g.createRadialGradient(cx, py + ph * 0.95, 4 * dpr, cx, py + ph * 0.5, pw * 0.72);
    licht.addColorStop(0, '#fff0c4'); licht.addColorStop(0.5, '#f6d38a'); licht.addColorStop(1, '#b98236');
    g.fillStyle = licht; g.fillRect(px, py, pw, ph);
    const klein = pw < 200 * dpr;
    g.lineWidth = 1.3 * dpr; g.strokeStyle = '#2b1d10';
    g.beginPath(); g.arc(cx, cy, R, A(-20), A(0)); g.stroke();
    g.strokeStyle = '#b8261b'; g.lineWidth = 4 * dpr;
    g.beginPath(); g.arc(cx, cy, R + 3 * dpr, A(0), A(kopf)); g.stroke();
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const striche = kopf > 3 ? [-20, -10, -7, -5, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6] : [-20, -10, -7, -5, -3, -2, -1, 0, 1, 2, 3];
    const marken = kopf > 3
      ? (klein ? [-20, -10, -5, 0, 3, 6] : [-20, -10, -5, -3, 0, 2, 4, 6])
      : (klein ? [-20, -10, -5, -3, -1, 0, 1, 3] : [-20, -10, -7, -5, -3, -2, -1, 0, 1, 2, 3]);
    for (const v of striche) {
      const a = A(v), co = Math.cos(a), si = Math.sin(a);
      g.strokeStyle = v > 0 ? '#b8261b' : '#2b1d10'; g.lineWidth = (v % 5 === 0 ? 1.8 : 1.2) * dpr;
      g.beginPath(); g.moveTo(cx + co * R, cy + si * R); g.lineTo(cx + co * (R + 8 * dpr), cy + si * (R + 8 * dpr)); g.stroke();
      if (!marken.includes(v)) continue;
      g.font = `600 ${(klein ? 8 : 10) * dpr}px ${SANS}`; g.fillStyle = v > 0 ? '#b8261b' : '#2b1d10';
      g.fillText(v > 0 ? `+${v}` : String(v).replace('-', '−'), cx + co * (R + (klein ? 15 : 18) * dpr), cy + si * (R + (klein ? 15 : 18) * dpr));
    }
    for (let v = -19; v < kopf; v += 0.5) {
      if (Number.isInteger(v) && striche.includes(v)) continue;
      if (kopf > 3 && v > 0 && !Number.isInteger(v)) continue;
      if (v < -10 && !Number.isInteger(v)) continue;
      const a = A(v);
      g.strokeStyle = v > 0 ? '#b8261b' : 'rgba(43,29,16,.55)'; g.lineWidth = 0.8 * dpr;
      g.beginPath(); g.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.lineTo(cx + Math.cos(a) * (R + 4 * dpr), cy + Math.sin(a) * (R + 4 * dpr)); g.stroke();
    }
    g.font = `italic 700 ${(klein ? 14 : 20) * dpr}px Georgia, "DejaVu Serif", serif`; g.fillStyle = '#2b1d10';
    g.fillText('VU', cx, py + ph * 0.72);
    g.font = `600 ${7 * dpr}px ${SANS}`; g.fillStyle = 'rgba(43,29,16,.7)'; g.textBaseline = 'alphabetic';
    g.textAlign = 'left'; g.fillText('AMBERWAVE', px + 8 * dpr, py + ph - 7 * dpr);
    g.textAlign = 'right'; g.font = `700 ${9 * dpr}px ${SANS}`; g.fillText(kanal.name, px + pw - 8 * dpr, py + ph - 7 * dpr);
    // Nadel mit Schatten
    const a = winkel(x);
    g.strokeStyle = '#14100c'; g.lineWidth = 1.5 * dpr; g.lineCap = 'round';
    g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 3 * dpr; g.shadowOffsetX = 4 * dpr; g.shadowOffsetY = 2 * dpr;
    g.beginPath(); g.moveTo(cx + Math.cos(a) * R * 0.42, cy + Math.sin(a) * R * 0.42); g.lineTo(cx + Math.cos(a) * (R + 12 * dpr), cy + Math.sin(a) * (R + 12 * dpr)); g.stroke();
    g.shadowBlur = 0; g.shadowOffsetX = 0; g.shadowOffsetY = 0;
    // Peak-LED ab −2 dBFS (Sample-Peak)
    const led = peak > 0.794;
    g.fillStyle = led ? '#ff3b2f' : '#5a1d15'; g.shadowColor = '#ff3b2f'; g.shadowBlur = led ? 12 * dpr : 0;
    g.beginPath(); g.arc(px + pw - 12 * dpr, py + 11 * dpr, 3.5 * dpr, 0, 7); g.fill(); g.shadowBlur = 0;
    // Glas und Vignette
    const glas = g.createLinearGradient(px, py, px + pw * 0.5, py + ph);
    glas.addColorStop(0, 'rgba(255,255,255,.28)'); glas.addColorStop(0.45, 'rgba(255,255,255,0)');
    g.fillStyle = glas; g.fillRect(px, py, pw, ph);
    const vg = g.createRadialGradient(cx, py + ph / 2, pw * 0.25, cx, py + ph / 2, pw * 0.62);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(60,30,5,.35)');
    g.fillStyle = vg; g.fillRect(px, py, pw, ph);
    g.restore();
    g.strokeStyle = 'rgba(0,0,0,.7)'; g.lineWidth = 2 * dpr;
    g.beginPath(); g.roundRect(px, py, pw, ph, 6 * dpr); g.stroke();
    g.fillStyle = '#4d3f33';
    for (const [sx, sy] of [[px + 2 * dpr, py + 2 * dpr], [px + pw - 2 * dpr, py + 2 * dpr], [px + 2 * dpr, py + ph - 2 * dpr], [px + pw - 2 * dpr, py + ph - 2 * dpr]]) {
      g.beginPath(); g.arc(sx, sy, 2.2 * dpr, 0, 7); g.fill();
    }
  }

  /** Klick ins Meter: welche Fläche? (Koordinaten in Canvas-Pixeln) */
  treffer(x, y) { return this.flaechen.find((f) => x >= f.x0 && x <= f.x1 && y >= f.y0 && y <= f.y1) || null; }
}
