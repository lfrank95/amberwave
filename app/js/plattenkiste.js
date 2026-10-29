// Plattenkiste: die Warteschlange als Cover zum Durchblättern („Läuft gerade“).
// Ein Cover je Album (aufeinanderfolgende Titel desselben Albums), links gespielte, rechts kommende.
// Das laufende Album ist leicht angehoben, aus seiner Hülle gleitet rechts die CD und dreht sich. Blättern (Wischen, Mausrad, Pfeiltasten, Antippen) ändert nichts an der
// Wiedergabe – erst ein Doppeltipp aufs Cover (bzw. Enter) springt. Nach 6 s ohne Berührung schnappt die Kiste zurück.
//
// Bewegung: EIN Zeitgeber (requestAnimationFrame) treibt alles – Fahrt der Kiste, CD ein/aus, Hub des laufenden Albums,
// Anlaufen/Auslaufen der Drehung und die Zeitleiste beim Albumwechsel. Jedes Bild wird genau einmal angeordnet (setzen()).
// Es gibt keine CSS-Übergänge auf den Transformationen mehr (die liefen den Skriptwerten hinterher und sprangen beim Umschalten).
// Die gleichmäßige Drehung der CD läuft nicht im Skript, sondern als Web-Animation auf dem Compositor (kostet keine Rechenzeit).
import { h } from './ui.js';
import { t } from './i18n.js';

const FENSTER_MAX = 7;      // so viele Cover je Seite liegen höchstens im DOM (tatsächlich nur so viele, wie der Rahmen zeigt, plus Reserve)
const ZURUECK_MS = 6000;
const DOPPEL_MS = 380;
// Bewegung: alle Cover hängen an einer Position (Bruchteil von Alben). Beim Loslassen oder Mausrad gleitet sie mit
// Schwung aus (REIBUNG), danach zieht eine leicht gedämpfte Feder auf das nächste Cover; Sprünge über mehrere Alben
// fahren mit derselben Feder.
const REIBUNG = 3.4;        // Auslaufen: je kleiner, desto länger gleitet es
const FEDER = 80;           // Zug zum Zielcover
const DAEMPFUNG = 0.86;     // 1 = kein Überschwingen
const MAX_V = 24;           // Alben pro Sekunde, höchstens
const MIN_V = 1.4;          // darunter schnappt es aufs nächste Cover
// Anordnung „Türen“: jedes Cover hängt an der Innenkante und klappt nach hinten weg, das laufende steht vorn.
// Die Werte sind so gewählt, dass sich beim Blättern nie zwei Cover (auch nicht die herausgleitende CD) im Raum durchdringen.
const TUER_WINKEL = 55;     // Grad, mit dem die Nachbarn nach hinten wegklappen
const TUER_ABSTAND = 0.3;   // Cover-Breiten zwischen weiter außen liegenden Nachbarn
const TUER_MITTE = 0.1;     // zusätzlicher Abstand zwischen Mitte und erstem Nachbarn
const TUER_TIEFE = 0.5;     // das Mittelcover steht so viele Cover-Breiten vor den Nachbarn
const HUB = 0.03;           // das laufende Album steht so viel tiefer (Cover-Breiten) – nur, wenn die Kiste steht
const CD_RAUS = 0.45;       // CD schaut so weit aus der Hülle (Cover-Breiten), beim Spielen
const CD_RAUS_PAUSE = 0.32; // … bei Pause
const CD_FENSTER = 0.2;     // erst wenn das Cover so nah an der Mitte ist, gleitet die CD heraus
const CD_V = 20;            // Grad pro Sekunde beim Spielen (eine Umdrehung in 18 s)
// Zeitleiste, wenn die Kiste vom laufenden Album wegfährt (nächster Titel, Blättern) – Millisekunden ab Start
const W_CD_EIN = 380;       // die CD gleitet in die Hülle
const W_HUB_AB = 220;       // ab hier senkt sich das laufende Album …
const W_HUB_AB_DAUER = 300; // … und ist hier unten
const W_FAHRT = 520;        // ab hier fährt die Kiste
const W_HUB_AUF_VERZ = 120; // steht das Cover, hebt sich das laufende Album nach dieser Pause …
const W_HUB_AUF_DAUER = 420;
const W_CD_AUS_VERZ = 100;  // … und die CD kommt heraus
const W_CD_AUS = 600;
const ANSICHT_KEY = 'amberwave.pk.ansicht';

const LEICHT = window.matchMedia ? window.matchMedia('(max-width: 700px), (pointer: coarse)') : { matches: false };   // Handy/Tablet: kleinere Bilder, weniger Effekte
const RUHIG = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
const glatt = (u) => u * u * (3 - 2 * u);               // sanft an und ab
const ausKubisch = (u) => 1 - (1 - u) * (1 - u) * (1 - u);   // schnell los, sanft an
const klemm = (u) => (u < 0 ? 0 : u > 1 ? 1 : u);
const DREH_MS = 360000 / CD_V;
const bald = window.requestIdleCallback ? (f) => requestIdleCallback(f, { timeout: 800 }) : (f) => setTimeout(f, 250);   // wenn der Browser Luft hat

// Spiegelbild: einmal pro Cover sauber weichgezeichnet (Canvas, gaußsch) statt CSS-Filter auf dem 3D-Körper –
// der würde grob gerastert und kostet bei jedem Bild der Animation Rechenzeit.
const weichCache = new Map();
function weichBild(url) {
  if (!url) return Promise.resolve(null);
  if (!weichCache.has(url)) {
    weichCache.set(url, new Promise((fertig) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        try {
          const g = LEICHT.matches ? 112 : 320;
          const r = LEICHT.matches ? 2 : 5;
          const pd = r * 3;
          // Bild deckungsgleich (nicht vergrößert – sonst passte die Spiegelung an der Kante nicht zum Cover und wirkte wie eine Lücke),
          // die Ränder nach außen verlängert, damit das Weichzeichnen sie nicht aufhellt
          const a = document.createElement('canvas');
          a.width = a.height = g + 2 * pd;
          const ax = a.getContext('2d');
          if (!('filter' in ax)) { fertig(url); return; }
          ax.drawImage(img, pd, pd, g, g);
          const iw = img.naturalWidth, ih = img.naturalHeight;
          ax.drawImage(img, 0, 0, iw, 1, pd, 0, g, pd);            // oben
          ax.drawImage(img, 0, ih - 1, iw, 1, pd, pd + g, g, pd);  // unten
          ax.drawImage(img, 0, 0, 1, ih, 0, pd, pd, g);            // links
          ax.drawImage(img, iw - 1, 0, 1, ih, pd + g, pd, pd, g);  // rechts
          const c = document.createElement('canvas');
          c.width = c.height = g;
          const x = c.getContext('2d');
          x.filter = `blur(${r}px)`;
          x.drawImage(a, -pd, -pd);
          c.toBlob((b) => fertig(b ? URL.createObjectURL(b) : url), 'image/jpeg', 0.82);
        } catch { fertig(url); }
      };
      img.onerror = () => fertig(null);
      img.src = url;
    }));
  }
  return weichCache.get(url);
}

const groesse = (url, g) => (url ? url.replace(/g=\d+/, `g=${g}`) : null);

function farbe(text) {
  let x = 0;
  for (const c of String(text || '')) x = (x * 31 + c.codePointAt(0)) >>> 0;
  const hue = x % 360;
  return `linear-gradient(140deg, hsl(${hue} 42% 34%), hsl(${(hue + 25) % 360} 45% 11%))`;
}

/** Aufeinanderfolgende Titel desselben Albums bilden eine Gruppe – ein Cover in der Kiste (liegt ja auf derselben CD). */
export function gruppenVon(liste) {
  const gs = [];
  liste.forEach((t, i) => {
    // Album erkennen: ID, sonst Edition, sonst Titel + Cover (falls eine Quelle die ID nicht mitliefert)
    const a = t.album || {};
    const key = a.id ? `a${a.id}` : a.edition_id ? `e${a.edition_id}` : a.titel ? `n${a.titel}|${a.cover || ''}` : t.album_id ? `a${t.album_id}` : `t${t.id}`;
    const l = gs[gs.length - 1];
    if (l && l.key === key) l.ti.push(i);
    else gs.push({ key, ti: [i] });
  });
  return gs;
}

export class Plattenkiste {
  /**
   * @param {HTMLElement} el   Rahmen (.pk) – enthält .jetzt-cover (gibt die Größe vor) und [data-pk-3d]
   * @param {object} o         { liste(), index(), spielt(), spielen(i), zeiger({ ti, wahl, d }, wink) }
   */
  constructor(el, o) {
    this.el = el;
    el.__kiste = this;   // für Tests
    this.o = o;
    this.mass = el.querySelector('.jetzt-cover');
    this.b3d = el.querySelector('[data-pk-3d]');
    this.platten = new Map();      // Schlüssel der Gruppe → Element
    this.gs = [];
    this.giVon = new Map();        // Schlüssel → Index der Gruppe
    this.gvon = [];                // Titelindex → Index der Gruppe
    this.zeiger = 0;               // Index der Gruppe in der Mitte (Ziel, auch während der Fahrt)
    this.pos = 0;                  // gezeigte Position (Bruchteil), läuft dem Zeiger hinterher
    this.vel = 0;                  // Geschwindigkeit in Alben pro Sekunde
    this.ziel = null;              // Feder aktiv: Ziel-Gruppe, sonst gleitet es nur aus
    this.faehrt = false;           // die Kiste bewegt sich (Schwung oder Feder)
    this.wz = null;                // Zeitleiste „erst CD rein, Album senken, dann fahren“: { t0 }
    this.gjFixKey = null;          // während der Zeitleiste bleibt dieses Album das laufende
    this.gjSichtKey = null;        // zuletzt gezeigtes laufendes Album (erkennt den Wechsel, egal wer ihn zuerst meldet)
    this.raf = 0;
    this.tL = 0;
    this.hand = false;             // Finger oder Maus halten die Kiste
    this.still = false;
    this.wahl = null;              // gewählter Titel innerhalb der Gruppe (Titel-Leiste)
    this.g = 0;
    this.sicht = 1;
    this.timer = null;
    this.letzterTipp = null;
    this.cdO = { v: 0, von: 0, ziel: 0, t0: 0, dauer: 1 };   // 0 = CD ganz in der Hülle, 1 = so weit wie die Position erlaubt (zeitgesteuert)
    this.cdAmp = o.spielt() ? CD_RAUS : CD_RAUS_PAUSE;        // wie weit die CD gerade herausschaut (gleitet bei Pause/Weiter)
    this.cdEl = null;
    this.cds = new Map();          // Drehzustand je Scheibe: { ang, w, m, anim }
    this.hubAktiv = false;
    this.tick = this.tick.bind(this);
    try { this.modus = localStorage.getItem(ANSICHT_KEY) === 'cd' ? 'cd' : 'huelle'; } catch { this.modus = 'huelle'; }
    el.classList.toggle('cd-modus', this.modus === 'cd');
    el.classList.toggle('leicht', LEICHT.matches);
    this.knopfBauen();
    this.gruppieren();
    this.zeiger = this.gruppeVon(o.index());
    this.pos = this.zeiger;
    this.gjSichtKey = this.gs[this.zeiger]?.schluessel ?? null;
    this.ro = new ResizeObserver(() => this.messen());
    this.ro.observe(this.mass);
    this.ro.observe(el);
    this.verdrahten();
    this.messen();
  }

  /** für Tests und Kompatibilität */
  get cdOpen() { return this.cdO.v; }

  zerstoeren() {
    this.ro.disconnect();
    clearTimeout(this.timer);
    clearTimeout(this.wechselTimer);
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const [k, c] of this.cds) if (c.anim) { for (const a of c.anim) a.cancel(); c.anim = null; }
  }

  gruppieren() {
    const liste = this.o.liste();
    this.gs = gruppenVon(liste).map((g) => ({ ...g, schluessel: `${g.key}:${liste[g.ti[0]].id}:${g.ti[0]}` }));
    this.giVon = new Map();
    this.gvon = new Array(liste.length);
    this.gs.forEach((g, gi) => { this.giVon.set(g.schluessel, gi); for (const i of g.ti) this.gvon[i] = gi; });
  }

  gruppeVon(i) { return this.gvon[i] ?? 0; }

  // ---- Zeitgeber ----
  start() {
    if (this.raf) return;
    this.tL = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  tick(t) {
    const dt = Math.min(0.04, Math.max(0.001, (t - this.tL) / 1000));
    this.tL = t;
    if (this.wz && t - this.wz.t0 >= W_FAHRT) {
      // Zeitleiste abgelaufen: ab jetzt gilt das neue Album, die Kiste fährt los
      this.wz = null;
      this.gjFixKey = null;
      this.gjSichtKey = this.gs[this.gruppeVon(this.o.index())]?.schluessel ?? null;
      this.faehrt = true;
    }
    if (this.faehrt) this.fahrtSchritt(dt);
    this.cdOpenSchritt(t);
    this.ampSchritt(dt);
    this.setzen(t);
    const dreht = this.drehSchritt(dt);
    const ampZiel = this.o.spielt() ? CD_RAUS : CD_RAUS_PAUSE;
    const aktiv = this.wz || this.faehrt || this.hubAktiv || dreht || this.cdO.v !== this.cdO.ziel || this.cdAmp !== ampZiel;
    this.raf = aktiv ? requestAnimationFrame(this.tick) : 0;
    if (!aktiv) this.vorbauen();
  }

  /** Steht die Kiste, werden die nächsten Nachbarn außerhalb des Sichtfensters schon gebaut – dann muss beim Wischen nichts mitten in der Fahrt entstehen */
  vorbauen() {
    if (this.vorbau) return;
    this.vorbau = bald(() => {
      this.vorbau = 0;
      if (this.raf || this.hand || !this.g || !this.gs.length) return;
      const n = this.gs.length - 1;
      const c = Math.max(0, Math.min(n, Math.round(this.pos)));
      const F = Math.min(FENSTER_MAX, Math.ceil(this.sicht + 1.2) + 1) + 3;
      let gebaut = 0;
      for (let i = Math.max(0, c - F); i <= Math.min(n, c + F) && gebaut < 2; i++) {
        const gr = this.gs[i];
        if (this.platten.has(gr.schluessel)) continue;
        const p = this.platteBauen(gr);
        this.platten.set(gr.schluessel, p);
        this.b3d.appendChild(p);
        gebaut++;
      }
      if (gebaut) { this.setzen(); this.vorbauen(); }   // anordnen (sonst stünden sie unplatziert) und ggf. weitere
    });
  }

  /** Welches Album gilt für Anzeige und CD als „läuft“? Beim Albumwechsel bleibt es das alte, bis die CD eingefahren ist und die Kiste fährt */
  gjAnz() {
    if (this.gjFixKey != null) {
      const i = this.giVon.get(this.gjFixKey);
      if (i != null) return i;
      this.gjFixKey = null;
    }
    const jetzt = this.gruppeVon(this.o.index());
    const key = this.gs[jetzt]?.schluessel ?? null;
    // Das laufende Album hat gewechselt (egal, welcher Aufruf es zuerst merkt): erst die CD einfahren, dann umschalten und gleiten
    if (this.gjSichtKey != null && key !== this.gjSichtKey && !this.wz && this.cdO.v > 0.04 && !this.hand && !RUHIG.matches && this.giVon.has(this.gjSichtKey)) {
      this.wechselStart(this.gjSichtKey);
      return this.giVon.get(this.gjSichtKey);
    }
    this.gjSichtKey = key;
    return jetzt;
  }

  /** Erst die CD in die Hülle, das Album senken, dann fahren (siehe Zeitleiste W_…) */
  wechselStart(altKey) {
    if (this.wz) return;
    this.wz = { t0: performance.now() };
    this.gjFixKey = altKey;
    this.cdOffenZiel(0);
    this.start();
  }

  messen() {
    const g = this.mass.offsetWidth;
    if (!g) return;
    const halb0 = this.el.clientWidth / 2;
    if (g === this.g && halb0 === this.halb) return;   // nichts geändert: nicht neu anordnen (kostet die ganze Kiste)
    this.halb = halb0;
    this.g = g;
    this.el.style.setProperty('--g', `${g}px`);
    const halb = this.el.clientWidth / 2;
    this.el.classList.toggle('leicht', LEICHT.matches);
    // Beim Wechsel Hülle ↔ CD fährt die gespielte Scheibe immer ganz heraus – am Handy ruhig über den Rand hinaus (der Rahmen schneidet sie ab);
    // ein kurzer Ruck bis zum Rand sah albern aus
    this.el.style.setProperty('--w-aus', '1.1');
    // so viele Nachbarn je Seite passen ganz in den Rahmen
    this.sicht = Math.max(1, Math.min(6, (halb - g * 1.15) / (g * 0.3) + 1));
    this.setzen();
    this.start();   // Nachbarn blenden zeitgesteuert ein oder aus
  }

  /** Warteschlange oder laufender Titel haben sich geändert */
  neu(zurMitte = true) {
    const mitteKey = this.gs[Math.round(this.pos)]?.schluessel;   // was gerade sichtbar in der Mitte liegt
    const zielKey = this.gs[this.zeiger]?.schluessel;
    const bruch = this.pos - Math.round(this.pos);
    this.gruppieren();
    const letzte = Math.max(0, this.gs.length - 1);
    const j = this.giVon.get(mitteKey) ?? -1;
    if (zurMitte) {
      clearTimeout(this.timer);
      this.wahl = null;
      const ziel = this.gruppeVon(this.o.index());
      if (j < 0 || this.hand) { this.anhalten(); this.vel = 0; this.ziel = null; this.pos = ziel; this.zeiger = ziel; this.setzen(); }
      else {
        // von der gezeigten Stelle aus hinfahren: wer in der Liste mehrere Titel überspringt, sieht die Cover vorbeiziehen
        this.pos = j + bruch;
        this.still = true;
        this.fahrt(ziel);
      }
    } else {
      const k = this.giVon.get(zielKey) ?? -1;
      this.zeiger = k >= 0 ? k : Math.min(this.zeiger, letzte);
      if ((this.faehrt || this.wz) && !this.hand) { this.pos = (j >= 0 ? j : this.zeiger) + bruch; if (this.ziel != null) this.ziel = this.zeiger; }
      else if (!this.hand) { this.pos = this.zeiger; this.ziel = null; this.vel = 0; }
      this.setzen();
    }
    this.melden();
    this.start();
  }

  /** Wiedergabe gestartet/pausiert: CD dreht bzw. steht und rutscht ein Stück zurück */
  zustand() {
    this.el.classList.toggle('pausiert', !this.o.spielt());
    this.start();
  }

  /** Welcher Titel ist in der Mitte „gemeint“: der gewählte, sonst der laufende, sonst der erste der Gruppe */
  gemeint() {
    const gr = this.gs[this.zeiger];
    if (!gr) return null;
    if (this.wahl != null && gr.ti.includes(this.wahl)) return this.wahl;
    return gr.ti.includes(this.o.index()) ? this.o.index() : gr.ti[0];
  }

  melden(wink = false) {
    const gr = this.gs[this.zeiger];
    if (!gr) return;
    this.o.zeiger({ ti: gr.ti, wahl: this.gemeint(), d: this.zeiger - this.gruppeVon(this.o.index()) }, wink);
  }

  platteBauen(gr) {
    const t = this.o.liste()[gr.ti[0]];
    const p = document.createElement('div');
    p.className = 'pk-platte';
    p.dataset.s = gr.schluessel;
    const bild = t.album?.cover;
    const mittel = groesse(bild, LEICHT.matches ? 400 : 600);
    const ersatz = `<span class="pk-ersatz">${h(t.album?.titel || t.titel)}</span>`;
    if (mittel) p.style.setProperty('--bild', `url("${mittel.replace(/"/g, '%22')}")`);
    p.style.setProperty('--cv', farbe(t.album?.titel || t.titel));
    const dim = '<i class="pk-dim"></i>';
    // Keine Rückseite: bei höchstens 55° Drehung ist sie nie zu sehen (sparte eine volle Ebene je Cover).
    // „Gespielt“ wird nicht mehr per Filter abgedunkelt, sondern mit einer Schattierungsebene (.pk-dim) je Fläche – nur Deckkraft, kein Neuzeichnen.
    p.innerHTML = `<span class="pk-kante l">${dim}</span><span class="pk-kante r">${dim}</span><span class="pk-kante o">${dim}</span>
      <span class="pk-sk"><span class="pk-kante l">${dim}</span><span class="pk-kante r">${dim}</span></span>
      <span class="pk-spiegel">${mittel ? '' : ersatz}${dim}</span>
      <span class="pk-cv">${mittel ? `<img src="${h(mittel)}" alt="" draggable="false" decoding="async">` : ersatz}${dim}</span>`;
    p.__mittel = mittel;
    if (this.modus === 'cd') this.scheibeNachruesten(p);   // in der Hüllen-Ansicht erst beim Wechsel (halbiert die Knoten je Platte)
    if (mittel) {
      // Weichzeichnen erst, wenn der Browser Luft hat (nicht mitten in einer Fahrt, in der die Platte gerade gebaut wurde)
      bald(() => p.isConnected && weichBild(groesse(bild, LEICHT.matches ? 200 : 300)).then((u) => {
        if (!u || !p.isConnected) return;
        for (const sp of p.querySelectorAll('.pk-spiegel')) sp.insertAdjacentHTML('afterbegin', `<img class="pk-ein" src="${h(u)}" alt="" draggable="false">`);
        p.style.setProperty('--bild', `url("${u}")`);   // Hüllenkanten: weichgezeichnete Füllung, der Rand selbst bleibt scharf
      }));
    }
    return p;
  }

  /** Die nackte Scheibe (Ansicht „Nur CDs“) samt Rändern und runder Spiegelung – nur gebaut, wenn sie gebraucht wird */
  scheibeNachruesten(p) {
    if (p.__sch) return;
    p.__sch = true;
    const mittel = p.__mittel;
    const dim = '<i class="pk-dim"></i>';
    const scharf = [...p.querySelectorAll('.pk-cv img')].pop();
    const bild = scharf ? scharf.src : mittel;
    p.insertAdjacentHTML('beforeend', `<span class="pk-skd"><i style="--k:0"></i><i style="--k:2"></i><i style="--k:4"></i><i style="--k:5"></i></span><span class="pk-spiegel pk-spiegel-d">${dim}</span>
      ${[0, 1, 2, 3, 4, 5].map((k) => `<span class="pk-sch pk-sch-d" style="--k:${k}"></span>`).join('')}<span class="pk-sch pk-sch-hinten"></span>
      <span class="pk-sch pk-sch-vorn"><span class="pk-sch-rand"></span><span class="pk-sch-druck">${bild ? `<img src="${h(bild)}" alt="" draggable="false" decoding="async">` : ''}</span><span class="pk-sch-lack pk-sch-nabe"></span><span class="pk-sch-lack pk-sch-licht"></span><span class="pk-sch-lack pk-sch-regen"></span>${dim}</span>`);
    const weich = p.querySelector('.pk-spiegel > img');
    if (weich) p.querySelector('.pk-spiegel-d').insertAdjacentHTML('afterbegin', `<img src="${h(weich.src)}" alt="" draggable="false">`);
    p.__dreh = null;
    const c = this.cds.get(p.dataset.s);
    if (c?.anim) this.drehAnhaengen(p, c); else if (c) { p.__ang = null; this.winkelSetzen(p, c.ang); }
  }

  /** Das Cover nahe der Mitte bekommt das große Bild: vorab laden und entschlüsseln, dann über das kleine blenden (kein Tausch, kein Flackern) */
  scharfMachen(p, t, stufe) {
    if (!t?.album?.cover || Number(p.dataset.scharf || 0) >= stufe) return;
    p.dataset.scharf = String(stufe);
    const url = groesse(t.album.cover, stufe);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    const rein = () => {
      if (!p.isConnected) return;
      for (const ziel of p.querySelectorAll('.pk-cv, .pk-sch-druck')) {
        const alte = [...ziel.querySelectorAll('img')];
        if (!alte.length) continue;
        const n = document.createElement('img');
        n.className = 'pk-scharf pk-ein'; n.alt = ''; n.draggable = false; n.decoding = 'async'; n.src = url;
        alte[alte.length - 1].after(n);
        setTimeout(() => { if (n.isConnected) for (const a of alte) a.remove(); }, 600);
      }
    };
    (img.decode ? img.decode() : Promise.resolve()).then(rein, () => { img.onload = rein; });
  }

  // ---- CD in der Hülle ----
  /** CD: liegt in der Hülle des laufenden Albums und gleitet rechts heraus, solange dieses Album in der Mitte steht */
  cdSetzen() {
    const gj = this.gjAnz();
    const gr = this.gs[gj];
    let cd = this.cdEl;
    if (cd && !cd.isConnected) cd = this.cdEl = null;
    const p = gr && this.platten.get(gr.schluessel);
    if (!p) { if (cd) { cd.remove(); this.cdEl = null; } return; }
    if (!cd || cd.parentElement !== p) {
      if (cd) this.cdWeg(cd);
      cd = this.cdEl = document.createElement('span');
      cd.className = 'pk-cd drin';
      cd.innerHTML = '<span class="pk-cd-schatten"></span><span class="pk-cd-sp"><i></i></span><i></i><span class="pk-cd-nabe"></span><span class="pk-cd-licht"><span class="pk-cd-ks"></span></span>';
      const t = this.o.liste()[gr.ti[0]];
      cd.style.setProperty('--cv', farbe(t.album?.titel || t.titel));
      const druck = groesse(t.album?.cover, LEICHT.matches ? 400 : 600);
      if (druck) cd.style.setProperty('--druck', `url("${druck.replace(/"/g, '%22')}")`);
      cd.style.setProperty('--raus', '0px');
      cd.style.setProperty('--kante', '105.6%');
      p.insertBefore(cd, p.firstChild);
      p.__dreh = null; p.__ang = null;
      this.drehAnhaengen(p);
      const c = this.cds.get(p.dataset.s);
      if (c && !c.anim) this.winkelSetzen(p, c.ang);   // dreht die Scheibe schon, läuft die neue sofort im selben Takt mit
    }
    // Heraus-Weite folgt der Position stufenlos (kein Zeitversatz): so kreuzt die CD nie ein Nachbarcover, das gerade vorbeizieht
    const t1 = klemm(1 - Math.abs(this.pos - gj) / CD_FENSTER);
    const ph = glatt(t1);
    // Die CD kommt erst heraus, wenn das Album steht, und fährt ein, bevor die Kiste weiterblättert
    const steht = !this.faehrt && !this.wz && !this.hand && Math.abs(this.pos - gj) < 0.02;
    this.cdOffenZiel(steht ? 1 : 0);
    const f = ph * this.cdAmp * this.cdO.v;
    cd.classList.toggle('drin', f < 0.002);
    const rs = `${(f * this.g).toFixed(1)}px`, ks = `${((0.95 - f) / 0.9 * 100).toFixed(1)}%`;
    if (cd.__rs !== rs) { cd.__rs = rs; cd.style.setProperty('--raus', rs); }
    if (cd.__ks !== ks) { cd.__ks = ks; cd.style.setProperty('--kante', ks); }
  }

  /** CD sanft ein- (0) oder ausfahren (1): zeitgesteuert, unabhängig von der Kistenposition */
  cdOffenZiel(z) {
    const c = this.cdO;
    if (c.ziel === z) return;
    c.ziel = z;
    c.von = c.v;
    c.t0 = performance.now() + (z ? W_CD_AUS_VERZ : 0);
    c.dauer = z ? W_CD_AUS : W_CD_EIN;
    if (RUHIG.matches) { c.v = z; return; }
    this.start();
  }

  cdOpenSchritt(t) {
    const c = this.cdO;
    if (c.v === c.ziel) return;
    const u = klemm((t - c.t0) / c.dauer);
    c.v = u >= 1 ? c.ziel : c.von + (c.ziel - c.von) * (c.ziel ? ausKubisch(u) : glatt(u));
  }

  /** Pause/Weiter: die CD gleitet ein Stück zurück bzw. wieder heraus */
  ampSchritt(dt) {
    const ziel = this.o.spielt() ? CD_RAUS : CD_RAUS_PAUSE;
    if (this.cdAmp === ziel) return;
    this.cdAmp += (ziel - this.cdAmp) * Math.min(1, dt * 5);
    if (Math.abs(ziel - this.cdAmp) < 0.002) this.cdAmp = ziel;
  }

  /** Eine CD, die zu einem anderen Album gehörte: erst zurück in die Hülle gleiten, dann entfernen (kein Verschwinden) */
  cdWeg(cd) {
    cd.classList.add('geht', 'drin');
    cd.style.setProperty('--raus', '0px');
    cd.style.setProperty('--kante', '105.6%');
    setTimeout(() => cd.remove(), 800);
  }

  // ---- Ansicht „Nur CDs“ ----
  knopfBauen() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pk-modus';
    b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.6"/></svg>';
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => { e.stopPropagation(); this.ansichtWechseln(); });
    this.el.appendChild(b);
    this.knopf = b;
    this.knopfText();
  }

  knopfText() {
    const cd = this.modus === 'cd';
    this.knopf.title = cd ? t('Ansicht: nur CDs – zur Hülle wechseln') : t('Ansicht: Hülle – zu nackten CDs wechseln');
    this.knopf.setAttribute('aria-label', this.knopf.title);
    this.knopf.setAttribute('aria-pressed', cd ? 'true' : 'false');
  }

  ansichtWechseln() {
    this.modus = this.modus === 'cd' ? 'huelle' : 'cd';
    try { localStorage.setItem(ANSICHT_KEY, this.modus); } catch { /* egal */ }
    for (const p of this.platten.values()) this.scheibeNachruesten(p);
    this.el.classList.toggle('cd-modus', this.modus === 'cd');
    this.knopfText();
    this.setzen();
    // Verwandlung: Startpunkt der gespielten CD merken (so weit schaut sie gerade aus der Hülle), dann läuft alles per CSS
    const cd = this.cdEl;
    const raus = cd ? parseFloat(cd.style.getPropertyValue('--raus')) || 0 : 0;
    for (const p of this.platten.values()) {
      p.style.setProperty('--x0', p.classList.contains('laeuft') ? `${raus.toFixed(1)}px` : '0px');
      p.style.setProperty('--n', Math.min(Math.abs(p.__gi - this.pos), 4).toFixed(2));   // Staffel von der Mitte nach außen (nur hier gebraucht)
    }
    clearTimeout(this.wechselTimer);
    this.el.classList.remove('wechsel-cd', 'wechsel-huelle');
    void this.el.offsetWidth;
    this.el.classList.add(this.modus === 'cd' ? 'wechsel-cd' : 'wechsel-huelle');
    this.wechselTimer = setTimeout(() => this.el.classList.remove('wechsel-cd', 'wechsel-huelle'), 1500);
    this.start();
  }

  // ---- Drehung der gespielten Scheibe ----
  /** Gleichmäßige Drehung als Web-Animation (Compositor): Startwinkel = aktueller Winkel, danach kein Skript mehr */
  drehAnhaengen(p, c = this.cds.get(p.dataset.s)) {
    if (!c || c.m !== 'dreh' || c.w !== CD_V) return;
    const a0 = c.anim ? this.drehWinkel(c) : c.ang;
    if (c.anim) for (const a of c.anim) a.cancel();
    c.ang = a0;
    c.anim = [];
    for (const [el, r] of this.drehTeile(p)) {   // r = -1: die Spiegelung ist gekippt und läuft im Bild gegenläufig
      c.anim.push(el.animate([{ transform: `rotate(${r * a0}deg)` }, { transform: `rotate(${r * (a0 + 360)}deg)` }], { duration: DREH_MS, iterations: Infinity }));
    }
  }

  /** die drehenden Teile einer Platte (CD, ihre Spiegelung, Scheibendruck, Scheibenspiegel) – gemerkt, bis eine neue CD eingesetzt wird */
  drehTeile(p) {
    if (!p.__dreh) p.__dreh = [...p.querySelectorAll('.pk-cd i, .pk-sch-druck, .pk-spiegel-d img')].map((el) => [el, el.parentElement.classList.contains('pk-cd-sp') ? -1 : 1]);
    return p.__dreh;
  }

  /** Winkel setzen – an den drehenden Teilen selbst, nicht an der Platte (sonst rechnet der Browser bei jedem Bild die ganze Platte neu) */
  winkelSetzen(p, ang) {
    const s = ang.toFixed(2);
    if (p.__ang === s) return;
    p.__ang = s;
    for (const [el, r] of this.drehTeile(p)) el.style.setProperty('--ang', `${r < 0 ? -ang : ang}deg`);
  }

  drehWinkel(c) {
    const a = c.anim?.[0];
    if (!a) return c.ang;
    const ct = Number(a.currentTime) || 0;
    return (c.ang + (ct % DREH_MS) / DREH_MS * 360) % 360;
  }

  /** Zurück ins Skript (Pause, Stopp, Wechsel): Winkel übernehmen, Web-Animation beenden – ohne Sprung */
  drehLoesen(p, c) {
    c.ang = this.drehWinkel(c);
    this.winkelSetzen(p, c.ang);
    for (const a of c.anim) a.cancel();
    c.anim = null;
  }

  /** Anlaufen, Auslaufen und Geraderücken laufen im Skript; die gleichmäßige Drehung übernimmt der Compositor. Liefert true, solange etwas zu tun ist. */
  drehSchritt(dt) {
    const gj = this.gjAnz();
    const tr = this.o.gestoppt?.() ? 'stop' : this.o.spielt() ? 'spielt' : 'pause';
    let aktiv = false;
    for (const [k, p] of this.platten) {
      const c = this.cds.get(k);
      if (!c) continue;
      const ziel = p.__gi === gj ? tr : 'stop';
      if (RUHIG.matches) { if (c.anim) this.drehLoesen(p, c); c.ang = 0; c.w = 0; c.m = 'ruhe'; }
      else if (ziel === 'spielt') {
        if (c.anim) continue;
        c.m = 'dreh';
        c.w += (CD_V - c.w) * Math.min(1, dt * 2.2);
        c.ang = (c.ang + c.w * dt) % 360;
        if (Math.abs(CD_V - c.w) < 0.08) { c.w = CD_V; this.drehAnhaengen(p, c); }
        else aktiv = true;
      } else if (ziel === 'pause') {
        if (c.anim) this.drehLoesen(p, c);
        c.m = 'halt';
        c.w *= Math.exp(-dt * 8);
        if (Math.abs(c.w) < 0.05) c.w = 0; else aktiv = true;
        c.ang = (c.ang + c.w * dt) % 360;
      } else {
        if (c.anim) this.drehLoesen(p, c);
        if (c.m !== 'aus' && c.m !== 'ruhe') {
          const rest = (360 - (c.ang % 360)) % 360;
          c.D = rest < 15 && c.w > 1 ? rest + 360 : rest;
          c.a0 = c.ang; c.v0 = c.w;
          c.T = Math.min(1, 0.5 + 0.5 * c.D / 360);   // gerade rücken: eine halbe bis eine Sekunde
          c.t = 0; c.m = 'aus';
        }
        if (c.m === 'aus') {
          c.t += dt;
          const u = Math.min(1, c.t / c.T);
          const h10 = u * u * u - 2 * u * u + u, h01 = -2 * u * u * u + 3 * u * u;
          c.ang = (c.a0 + h10 * c.v0 * c.T + h01 * c.D) % 360;
          c.w = u < 1 ? ((3 * u * u - 4 * u + 1) * c.v0 * c.T + (-6 * u * u + 6 * u) * c.D) / c.T : 0;
          if (u >= 1) { c.ang = 0; c.w = 0; c.m = 'ruhe'; } else aktiv = true;
        }
      }
      if (!c.anim) this.winkelSetzen(p, c.ang);
    }
    return aktiv;
  }

  // ---- Anordnen ----
  /** Cover anordnen: Mitte flach, Nachbarn leicht gedreht und gestaffelt; alles hängt an this.pos. Treibt auch den Hub (zeitgesteuert) und die CD. */
  setzen(t = performance.now()) {
    const liste = this.o.liste();
    const g = this.g;
    if (!g) return;
    const n = this.gs.length - 1;
    if (n < 0) { for (const p of this.platten.values()) p.remove(); this.platten.clear(); this.cds.clear(); return; }
    const gj = this.gjAnz();
    const c = Math.max(0, Math.min(n, Math.round(this.pos)));
    // nur so viele Cover im DOM, wie der Rahmen zeigt (plus Reserve); beim Hinausgleiten etwas länger behalten, damit beim Zurückwischen nichts neu gebaut wird
    const F = Math.min(FENSTER_MAX, Math.ceil(this.sicht + 1.2) + 1);
    for (let i = Math.max(0, c - F); i <= Math.min(n, c + F); i++) {
      const gr = this.gs[i];
      if (!this.platten.has(gr.schluessel)) {
        const p = this.platteBauen(gr);
        this.platten.set(gr.schluessel, p);
        this.b3d.appendChild(p);
      }
    }
    // Hub: nur wenn die Kiste steht, steht das laufende Album tiefer; vor dem Fahren senkt es sich (W_HUB_AB), nach der Ankunft hebt es sich (W_HUB_AUF_…)
    const steht = !this.faehrt && !this.hand && !(this.wz && t - this.wz.t0 >= W_HUB_AB);
    let hubAktiv = false;
    for (const [k, p] of this.platten) {
      const i = this.giVon.get(k);
      if (i == null || Math.abs(i - this.pos) > F + 4) { p.remove(); this.platten.delete(k); this.cds.delete(k); continue; }
      const d = i - this.pos;
      const ad = Math.abs(d);
      const sg = Math.sign(d);
      const s1 = Math.min(ad, 1);
      const ang = TUER_WINKEL * Math.sqrt(s1);
      const w = ang * Math.PI / 180;
      const xin = (s1 - 0.5) + TUER_MITTE * s1 + Math.max(ad - 1, 0) * TUER_ABSTAND;
      const x = sg * (xin + Math.cos(w) / 2) * g;
      const z = (TUER_TIEFE * (1 - s1) - Math.sin(w) / 2) * g;
      const rot = sg * ang;
      const hz = i === gj && steht ? 1 : 0;
      let hh = p.__h;
      if (!hh) hh = p.__h = { v: hz, ziel: hz, von: hz, t0: 0, dauer: 1 };
      if (hh.ziel !== hz) {
        hh.ziel = hz; hh.von = hh.v;
        hh.t0 = t + (hz ? W_HUB_AUF_VERZ : 0);
        hh.dauer = hz ? W_HUB_AUF_DAUER : W_HUB_AB_DAUER;
        if (RUHIG.matches) { hh.t0 = t; hh.dauer = 1; }
      }
      if (hh.v !== hh.ziel) {
        const u = klemm((t - hh.t0) / hh.dauer);
        hh.v = u >= 1 ? hh.ziel : hh.von + (hh.ziel - hh.von) * glatt(u);
        if (u < 1) hubAktiv = true;
      }
      const hub = -g * HUB * hh.v;
      // Nachbarn, die nicht mehr ganz in den Rahmen passen, blenden zeitgesteuert aus (und wieder ein), statt halb durchsichtig am Rand zu stehen –
      // auch wenn das Fenster schmaler oder breiter wird. (Deckkraft an den Teilen, nicht am 3D-Körper – sonst wird er flach)
      let bl = p.__b;
      if (!bl) { const z0 = ad < this.sicht + 0.25 ? 1 : 0; bl = p.__b = { v: z0, ziel: z0, von: z0, t0: 0, dauer: 1 }; }
      const bz = ad < this.sicht + (bl.ziel ? 0.4 : 0.25) ? 1 : 0;   // mit etwas Spiel, damit nichts am Rand flattert
      if (bl.ziel !== bz) { bl.ziel = bz; bl.von = bl.v; bl.t0 = t; bl.dauer = RUHIG.matches ? 1 : 360; }
      if (bl.v !== bl.ziel) {
        const u = klemm((t - bl.t0) / bl.dauer);
        bl.v = u >= 1 ? bl.ziel : bl.von + (bl.ziel - bl.von) * glatt(u);
        if (u < 1) hubAktiv = true;
      }
      const a = bl.v;
      const tf = `translateX(${x.toFixed(1)}px) translateY(${hub.toFixed(1)}px) translateZ(${z.toFixed(1)}px) rotateY(${rot.toFixed(1)}deg)`;
      if (p.__tf !== tf) { p.__tf = tf; p.style.transform = tf; }
      // --a wird von allen Teilen der Platte geerbt: jede Änderung lässt den Browser die ganze Platte neu berechnen –
      // deshalb in Stufen von 0,05 (unsichtbar) und nur am Rand, wo wirklich geblendet wird
      const as = (Math.round(a * 20) / 20).toFixed(2);
      if (p.__a !== as) { p.__a = as; p.style.setProperty('--a', as); p.style.visibility = a <= 0 ? 'hidden' : ''; p.classList.toggle('unsichtbar', a <= 0); }
      if (p.__gi !== i) { p.__gi = i; p.dataset.gi = i; }
      if (!this.cds.has(k)) this.cds.set(k, { ang: 0, w: 0, m: 'ruhe', anim: null });
      // Größe nach echten Gerätepixeln: ein 360-px-Cover auf einem 3x-Handy braucht 1080 px, sonst wirkt es pixelig. Am Handy bekommen
      // aber nur das Cover in der Mitte die 1200 px – die Nachbarn (schräg, kleiner) begnügen sich mit 600 (weniger zu entschlüsseln und hochzuladen)
      if (ad < 1.6) {
        const gross = this.g * (window.devicePixelRatio || 1) > 620;
        this.scharfMachen(p, liste[this.gs[i].ti[0]], gross && (ad < 0.6 || !LEICHT.matches) ? 1200 : 600);
      }
      p.classList.toggle('vorbei', i < gj);
      p.classList.toggle('laeuft', i === gj);
    }
    this.hubAktiv = hubAktiv;
    this.cdSetzen();
  }

  begrenzen(gi) { return Math.max(0, Math.min(this.gs.length - 1, gi)); }

  /** Zu einem Cover blättern (Pfeiltasten, Antippen, Rückschnappen): fährt sanft hin und meldet das Ziel sofort */
  gehe(gi, still = false) {
    if (!this.gs.length) return;
    this.still = still;
    this.hand = false;
    this.zeiger = this.begrenzen(gi);
    this.wahl = null;
    this.fahrt(this.zeiger);
    this.melden();
    this.zurueckPlanen(still);
  }

  /** Mit der Feder zur Gruppe fahren; ein neuer Auftrag mitten in der Fahrt nimmt die Geschwindigkeit mit */
  fahrt(gi) {
    if (!this.gs.length) return;
    this.zeiger = this.begrenzen(gi);
    this.ziel = this.zeiger;
    if (RUHIG.matches) { this.anhalten(); this.pos = this.zeiger; this.vel = 0; this.ziel = null; this.setzen(); this.start(); return; }
    this.anwerfen();
  }

  /** Losfahren – steht die CD heraus, zuerst die Zeitleiste (CD rein, Album senken), dann die Fahrt */
  anwerfen() {
    if (this.faehrt || this.wz) return;
    this.gjAnz();   // merkt einen Albumwechsel und startet die Zeitleiste
    if (this.wz) return;
    // schon am Ziel (z. B. nächster Titel desselben Albums): nichts fährt, die CD bleibt draußen
    if (this.ziel != null && Math.abs(this.ziel - this.pos) < 0.003 && Math.abs(this.vel) < 0.05) { this.pos = this.ziel; this.vel = 0; this.ziel = null; this.setzen(); this.start(); return; }
    if (this.cdO.v > 0.04 && !this.hand && !RUHIG.matches && this.cdEl?.isConnected && !this.cdEl.classList.contains('drin')) {
      this.wechselStart(this.gs[this.gjAnz()]?.schluessel ?? null);
      return;
    }
    this.faehrt = true;
    this.start();
  }

  /** Die Kiste in die Hand nehmen bzw. hart stoppen: Fahrt und Zeitleiste enden sofort */
  anhalten() {
    this.faehrt = false;
    this.wz = null;
    this.gjFixKey = null;
  }

  /** Ein Bild der Bewegung: erst Auslaufen mit Reibung, dann die Feder aufs Ziel */
  fahrtSchritt(dt) {
    const n = this.gs.length - 1;
    if (n < 0) { this.anhalten(); return; }
    if (this.ziel == null) {
      this.vel *= Math.exp(-REIBUNG * dt);
      this.pos += this.vel * dt;
      this.zeiger = this.begrenzen(Math.round(this.pos));
      if (this.pos < 0 || this.pos > n || Math.abs(this.vel) < MIN_V) {
        this.zeiger = this.begrenzen(Math.round(this.pos));
        this.ziel = this.zeiger;
        this.wahl = null;
        this.melden();
        this.zurueckPlanen(false);
      }
    }
    if (this.ziel != null) {
      const c = 2 * Math.sqrt(FEDER) * DAEMPFUNG;
      const h2 = dt / 2;
      for (let k = 0; k < 2; k++) {
        this.vel += (FEDER * (this.ziel - this.pos) - c * this.vel) * h2;
        this.vel = Math.max(-MAX_V, Math.min(MAX_V, this.vel));
        this.pos += this.vel * h2;
      }
      if (Math.abs(this.ziel - this.pos) < 0.003 && Math.abs(this.vel) < 0.05) { this.pos = this.ziel; this.vel = 0; this.ziel = null; this.faehrt = false; }
    }
  }

  zurueckPlanen(still = false) {
    clearTimeout(this.timer);
    const gj = this.gruppeVon(this.o.index());
    const abweichend = this.zeiger !== gj || (this.wahl != null && this.wahl !== this.o.index());
    if (!still && abweichend) this.timer = setTimeout(() => this.gehe(this.gruppeVon(this.o.index()), true), ZURUECK_MS);
  }

  /** Titel in der Leiste unter dem Cover angetippt: einmal wählt, zweimal spielt */
  titelTipp(i) {
    if (this.doppel(`t${i}`)) { if (i !== this.o.index()) this.starten(i); return; }
    const gi = this.gruppeVon(i);
    if (gi !== this.zeiger) this.fahrt(gi);
    this.wahl = i;
    this.melden();
    this.zurueckPlanen();
  }

  doppel(schluessel) {
    const t = performance.now();
    const ja = this.letzterTipp && this.letzterTipp.s === schluessel && t - this.letzterTipp.t < DOPPEL_MS;
    this.letzterTipp = ja ? null : { s: schluessel, t };
    return ja;
  }

  starten(i) {
    clearTimeout(this.timer);
    const p = this.platten.get(this.gs[this.gruppeVon(i)]?.schluessel);
    const anderesAlbum = this.gruppeVon(i) !== this.gruppeVon(this.o.index());
    if (p && anderesAlbum && !RUHIG.matches) p.classList.add('startet');
    this.wahl = null;
    setTimeout(() => this.o.spielen(i), p && anderesAlbum ? 300 : 0);
  }

  /** Welches Cover liegt unter dem Finger? (Rechteck-Test, das vorderste gewinnt) */
  treffer(e) {
    let best = null;
    let bestD = 99;
    for (const p of this.platten.values()) {
      if (p.style.visibility === 'hidden' || Number(p.__a) < 0.3) continue;
      const r = p.querySelector('.pk-cv').getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) continue;
      const gi = p.__gi;
      const d = Math.abs(gi - this.zeiger);
      if (d < bestD) { bestD = d; best = gi; }
    }
    return best;
  }

  verdrahten() {
    const el = this.el;
    let start = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY, p: this.pos, gi: this.treffer(e), bewegt: false, id: e.pointerId, spur: [] };
    });
    el.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return;
      if (!start.bewegt) {
        const dx0 = e.clientX - start.x;
        if (Math.abs(dx0) < 6) return;
        if (Math.abs(e.clientY - start.y) > Math.abs(dx0)) { start = null; return; }   // senkrecht: nicht unser Wisch
        start.bewegt = true;
        el.setPointerCapture(e.pointerId);
        el.classList.add('zieht');
        // Die Kiste in die Hand nehmen: laufende Fahrt anhalten und ab hier dem Finger folgen
        this.hand = true;
        this.anhalten();
        this.ziel = null;
        this.vel = 0;
        clearTimeout(this.timer);
        start.p = this.pos;
        start.x = e.clientX;
      }
      const roh = start.p - (e.clientX - start.x) / (this.g * 0.45);
      const n = this.gs.length - 1;
      // am Ende gibt sie nur zäh nach
      this.pos = roh < 0 ? roh * 0.35 : roh > n ? n + (roh - n) * 0.35 : roh;
      this.zeiger = this.begrenzen(Math.round(this.pos));
      const t = performance.now();
      start.spur.push({ t, p: this.pos });
      while (start.spur.length > 2 && t - start.spur[0].t > 100) start.spur.shift();
      this.setzen();
      this.start();
    });
    const ende = (e) => {
      if (!start || e.pointerId !== start.id) return;
      const s = start;
      start = null;
      el.classList.remove('zieht');
      if (s.bewegt) {
        // Schwung aus den letzten ~100 ms mitnehmen (ruhte der Finger vor dem Loslassen, bleibt es ohne)
        const jetzt = performance.now();
        const a = s.spur[0];
        const z = s.spur[s.spur.length - 1];
        let v = 0;
        if (a && z && z !== a && jetzt - z.t < 80 && z.t > a.t) v = (z.p - a.p) / ((z.t - a.t) / 1000);
        this.vel = Math.max(-MAX_V, Math.min(MAX_V, v));
        this.hand = false;
        this.ziel = null;
        this.still = false;
        this.letzterTipp = null;
        this.anwerfen();
        return;
      }
      if (s.gi == null || e.type === 'pointercancel') return;
      if (this.doppel(`g${s.gi}`)) {
        if (s.gi !== this.zeiger) { this.wahl = null; this.fahrt(s.gi); }
        const z = this.gemeint();
        if (z != null && z !== this.o.index()) this.starten(z);
        return;
      }
      if (s.gi === this.zeiger) this.melden(true); else this.gehe(s.gi);
    };
    el.addEventListener('pointerup', ende);
    el.addEventListener('pointercancel', ende);
    // Mausrad und Touchpad: jeder Impuls schiebt die Kiste an, sie gleitet aus und rastet auf einem Cover ein
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.hand || !this.gs.length) return;
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const px = e.deltaMode === 1 ? d * 16 : d;
      clearTimeout(this.timer);
      this.still = false;
      if (this.ziel != null) this.ziel = null;      // Feder lösen, der Impuls gleitet weiter
      this.vel = Math.max(-MAX_V, Math.min(MAX_V, this.vel + REIBUNG * px / 100));
      this.anwerfen();
    }, { passive: false });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' && !e.altKey) { e.preventDefault(); e.stopPropagation(); this.gehe(this.zeiger + 1); }
      else if (e.key === 'ArrowLeft' && !e.altKey) { e.preventDefault(); e.stopPropagation(); this.gehe(this.zeiger - 1); }
      else if (e.key === 'Home') { e.preventDefault(); this.gehe(this.gruppeVon(this.o.index())); }
      else if (e.key === 'Enter') { e.preventDefault(); const z = this.gemeint(); if (z != null && z !== this.o.index()) this.starten(z); }
      else if (e.key === 'Escape' && (this.zeiger !== this.gruppeVon(this.o.index()) || this.wahl != null)) { e.stopPropagation(); this.gehe(this.gruppeVon(this.o.index()), true); }
    });
  }
}
