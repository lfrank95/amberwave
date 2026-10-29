// Kleine Pegelmeter für die Player-Leiste und „Läuft gerade“: 2 Kanäle, bei aktivem Raumklang 5.1 bzw. Quadro.
// Spitzenpegel in dBFS (vor der Lautstärke), schneller Anstieg, Rücklauf 20 dB/s, Spitzenhalter 1,5 s.
import { t } from './i18n.js';

const UNTEN = -48;          // dBFS am unteren Rand
const RUECKLAUF = 20;       // dB pro Sekunde
const HALTEN = 1500;        // ms
const NAMEN = { 2: ['L', 'R'], 4: ['L', 'R', 'Ls', 'Rs'], 6: ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'] };

export class Pegel {
  constructor(player) {
    this.p = player;
    this.flaechen = new Set();
    this.wert = new Float32Array(6).fill(-120);
    this.spitze = new Float32Array(6).fill(-120);
    this.gehalten = new Float64Array(6);
    this.puffer = new Float32Array(2048);
    this.laeuft = false;
    this.letzt = 0;
    this.farben = null;
    player.audio.addEventListener('play', () => this.starten());
    player.addEventListener('pegel', () => { this.sichtbarkeit(); this.starten(); });
    player.addEventListener('zustand', () => this.sichtbarkeit());
  }

  /** Canvas anmelden (wird automatisch vergessen, wenn es nicht mehr im Dokument ist) */
  anmelden(cv) {
    this.flaechen.add(cv);
    this.sichtbarkeit();
    this.starten();
  }

  get kanaele() { return this.p.raumklang.layout ? this.p.raumklang.layout.kanaele : 2; }
  get bereit() { return this.p.pegelAn && this.p.raumklang.angeschlossen; }

  sichtbarkeit() {
    const n = this.kanaele;
    for (const cv of this.flaechen) {
      if (!cv.isConnected) { this.flaechen.delete(cv); continue; }
      cv.hidden = !this.bereit;
      cv.classList.toggle('mehrkanal', n > 2);
      cv.title = t('Pegel (dBFS) · {kanaele}', { kanaele: NAMEN[n].join(' ') });
    }
  }

  starten() {
    if (this.laeuft || !this.bereit || !this.flaechen.size) return;
    this.laeuft = true;
    this.letzt = performance.now();
    requestAnimationFrame((t) => this.schritt(t));
  }

  schritt(t) {
    const dt = Math.min(0.1, (t - this.letzt) / 1000);
    this.letzt = t;
    const n = this.kanaele;
    const sp = this.p.raumklang.spitzen(this.puffer) || [];
    let ruhig = true;
    for (let c = 0; c < 6; c++) {
      const db = c < n && sp[c] > 0 ? 20 * Math.log10(sp[c]) : -120;
      if (db >= this.wert[c]) this.wert[c] = db;
      else this.wert[c] = Math.max(db, this.wert[c] - RUECKLAUF * dt);
      if (db >= this.spitze[c]) { this.spitze[c] = db; this.gehalten[c] = t; }
      else if (t - this.gehalten[c] > HALTEN) this.spitze[c] = Math.max(this.wert[c], this.spitze[c] - RUECKLAUF * 1.5 * dt);
      if (this.wert[c] > UNTEN - 1 || this.spitze[c] > UNTEN - 1) ruhig = false;
    }
    for (const cv of this.flaechen) {
      if (!cv.isConnected) { this.flaechen.delete(cv); continue; }
      if (!cv.hidden) this.zeichnen(cv, n);
    }
    if (!this.bereit || !this.flaechen.size || (ruhig && this.p.audio.paused)) { this.laeuft = false; return; }
    requestAnimationFrame((x) => this.schritt(x));
  }

  zeichnen(cv, n) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    if (!this.farben) {
      const st = getComputedStyle(document.documentElement);
      this.farben = {
        unten: st.getPropertyValue('--accent-b').trim() || '#ff7a3d',
        akzent: st.getPropertyValue('--accent-a').trim() || '#ffb547',
        hell: st.getPropertyValue('--accent-text').trim() || '#ffc976',
      };
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    // Gruppen: L R | C LFE | Ls Rs (bei 5.1), L R | Ls Rs (Quadro)
    const lueckeKlein = n > 2 ? 2 : 3, lueckeGross = 5;
    const gruppen = n === 6 ? [2, 4] : n === 4 ? [2] : [];
    const breite = (w - lueckeKlein * (n - 1 - gruppen.length) - lueckeGross * gruppen.length) / n;
    const y = (db) => h - Math.max(0, Math.min(1, (db - UNTEN) / -UNTEN)) * h;
    const verlauf = g.createLinearGradient(0, h, 0, 0);
    verlauf.addColorStop(0, this.farben.unten);
    verlauf.addColorStop(0.6, this.farben.akzent);
    verlauf.addColorStop(0.75, this.farben.akzent);              // -12 dBFS
    verlauf.addColorStop(0.875, this.farben.hell);               // -6 dBFS
    verlauf.addColorStop(0.98, '#ff5a4f');                       // gegen 0 dBFS rot
    let x = 0;
    for (let c = 0; c < n; c++) {
      g.fillStyle = 'rgba(255,255,255,0.09)';
      g.fillRect(x, 0, breite, h);
      const oben = y(this.wert[c]);
      g.fillStyle = verlauf;
      g.fillRect(x, oben, breite, h - oben);
      if (this.spitze[c] > UNTEN) {
        g.fillStyle = this.spitze[c] > -0.5 ? '#ff5a4f' : 'rgba(255,255,255,0.85)';
        g.fillRect(x, Math.max(0, y(this.spitze[c]) - 1), breite, 1.5);
      }
      x += breite + (gruppen.includes(c + 1) ? lueckeGross : lueckeKlein);
    }
    // Skalenstriche bei -6 und -18 dBFS
    g.fillStyle = 'rgba(0,0,0,0.35)';
    for (const db of [-6, -18]) g.fillRect(0, Math.round(y(db)), w, 1);
  }
}
