// VST3-Plug-ins im Client: suchen (jede Datei in einem eigenen Prozess – ein abstürzendes Plug-in nimmt nur diesen Scan mit),
// Liste merken, Probelauf und Editor-Fenster zum Testen. Das Einbinden in die Klangkette folgt in der Engine (Stufe 2).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const log = require('./log');
const { t, tm, tmMeldung, locale } = require('./i18n');

const SCAN_FRIST = 20000;      // ms je Datei
const PROBE_FRIST = 30000;

function standardOrdner() {
  const l = [];
  const gemeinsam = process.env.CommonProgramFiles || 'C:\\Program Files\\Common Files';
  l.push(path.join(gemeinsam, 'VST3'));
  if (process.env['CommonProgramFiles(x86)']) l.push(path.join(process.env['CommonProgramFiles(x86)'], 'VST3'));
  if (process.env.LOCALAPPDATA) l.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Common', 'VST3'));
  return l;
}

/** alle .vst3 (Datei oder Bundle-Ordner) unterhalb der Ordner; in ein Bundle wird nicht weitergesucht */
function dateienFinden(ordner) {
  const treffer = [];
  const gesehen = new Set();
  const gehe = (dir, tiefe) => {
    if (tiefe > 6 || gesehen.has(dir)) return;
    gesehen.add(dir);
    let eintraege;
    try { eintraege = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of eintraege) {
      const voll = path.join(dir, e.name);
      if (/\.vst3$/i.test(e.name)) { treffer.push(voll); continue; }
      if (e.isDirectory()) gehe(voll, tiefe + 1);
    }
  };
  for (const o of ordner) gehe(o, 0);
  return treffer;
}

function hostPfad() { return process.env.AW_VSTHOST || path.join(__dirname, 'engine', process.platform === 'win32' ? 'amberwave-vsthost.exe' : 'amberwave-vsthost'); }

/** Host-Prozess starten, JSON-Zeilen sammeln; frist in ms (0 = keine) */
function hostLaufen(args, { frist = 0, logOrdner, bei } = {}) {
  return new Promise((resolve) => {
    const meldungen = [];
    let fertig = false, stderr = '';
    let kind;
    try {
      kind = spawn(hostPfad(), args, { windowsHide: false, env: { ...process.env, AW_LOGDIR: logOrdner || log.ordner() || '' } });
    } catch (e) {
      log.schreiben('FEHLER', `vsthost startet nicht: ${e.message}`);
      return resolve({ meldungen, code: -1, fehler: t('Host startet nicht ({grund})', { grund: e.message }) });
    }
    let rest = '';
    kind.stdout.setEncoding('utf8');
    kind.stdout.on('data', (d) => {
      rest += d;
      let i;
      while ((i = rest.indexOf('\n')) >= 0) {
        const z = rest.slice(0, i).trim(); rest = rest.slice(i + 1);
        if (!z) continue;
        try { const m = JSON.parse(z); meldungen.push(m); bei?.(m); } catch (e) { /* kein JSON */ }
      }
    });
    kind.stderr.on('data', (d) => { stderr += String(d); });
    const ende = (code, grund) => {
      if (fertig) return; fertig = true; clearTimeout(uhr);
      resolve({ meldungen, code, fehler: grund || '', stderr: stderr.trim() });
    };
    const uhr = frist ? setTimeout(() => { log.schreiben('WARN', `vsthost ${args.join(' ')}: Zeitüberschreitung, beende`); try { kind.kill(); } catch (e) { /* weg */ } ende(-2, t('Zeitüberschreitung')); }, frist) : null;
    kind.on('error', (e) => ende(-1, t('Host-Fehler: {grund}', { grund: e.message })));
    kind.on('exit', (code) => ende(code, code === 0 ? '' : (code === 3 ? t('Absturz im Plug-in') : t('Host endete mit Code {code}', { code }))));
  });
}

class Vst {
  constructor(userData, einstLesen) {
    this.datei = path.join(userData, 'vst-plugins.json');
    this.einstLesen = einstLesen;   // () => ({ ordner: [] })
    this.stand = { plugins: [], dateien: {}, zeit: 0 };
    this.scannt = false;
    try { this.stand = { ...this.stand, ...JSON.parse(fs.readFileSync(this.datei, 'utf8')) }; } catch (e) { /* noch keine Liste */ }
  }
  liste() {
    return { plugins: this.stand.plugins, fehler: Object.entries(this.stand.dateien).filter(([, d]) => d.fehler).map(([pfad, d]) => ({ pfad, text: tm(d.fehler) })), zeit: this.stand.zeit, scannt: this.scannt, ordner: this.ordner() };
  }
  ordner() { return [...standardOrdner(), ...(this.einstLesen()?.ordner || [])]; }
  speichern() { try { fs.writeFileSync(this.datei, JSON.stringify(this.stand)); } catch (e) { log.schreiben('FEHLER', `Pluginliste nicht gespeichert: ${e.message}`); } }

  /** neu suchen; unveränderte Dateien (Größe/Zeit) werden nicht noch einmal geladen, außer komplett=true */
  async scannen(komplett, fortschritt) {
    if (this.scannt) return this.liste();
    this.scannt = true;
    try {
      const dateien = dateienFinden(this.ordner());
      log.schreiben('INFO', `VST-Scan: ${dateien.length} Dateien in ${this.ordner().join('; ')}`);
      const neu = {};
      let i = 0;
      for (const pfad of dateien) {
        i++;
        let sig = '';
        try { const s = fs.statSync(pfad); sig = `${s.size}:${Math.round(s.mtimeMs)}`; } catch (e) { /* weg */ }
        const alt = this.stand.dateien[pfad];
        fortschritt?.({ i, n: dateien.length, pfad });
        if (alt && alt.sig === sig && !alt.fehler && !komplett) { neu[pfad] = alt; continue; }
        const r = await hostLaufen(['--scan', pfad], { frist: SCAN_FRIST });
        const eintraege = r.meldungen.filter((m) => m.e === 'plugin');
        const fehler = r.meldungen.find((m) => m.e === 'scan_fehler' || m.e === 'absturz');
        let text = '';
        if (r.code !== 0 || fehler) text = fehler?.text || (fehler?.e === 'absturz' ? `Absturz beim Laden (${fehler.modul}, ${fehler.schritt})` : r.fehler || 'unbekannter Fehler');
        if (text) log.schreiben('WARN', `VST-Scan ${pfad}: ${text}`);
        neu[pfad] = { sig, plugins: eintraege, fehler: text };
      }
      this.stand.dateien = neu;
      this.stand.plugins = Object.values(neu).flatMap((d) => d.plugins || []).filter((p) => !p.instrument).sort((a, b) => a.name.localeCompare(b.name, locale()));
      this.stand.zeit = Date.now();
      this.speichern();
    } finally { this.scannt = false; }
    return this.liste();
  }

  pruefen(pfad, cid) {
    const bekannt = this.stand.plugins.find((p) => p.pfad === pfad && p.cid === cid);
    return !!bekannt && /^[0-9A-F]{32}$/.test(cid);
  }
  async probe(pfad, cid) {
    if (!this.pruefen(pfad, cid)) return { ok: false, text: t('Unbekanntes Plug-in') };
    const r = await hostLaufen(['--probe', pfad, cid, '3'], { frist: PROBE_FRIST });
    const m = r.meldungen.find((x) => x.e === 'probe');
    const abs = r.meldungen.find((x) => x.e === 'absturz');
    if (abs) return { ok: false, text: t('Das Plug-in ist abgestürzt ({modul}, bei „{schritt}“). Das steht im Log.', { modul: abs.modul, schritt: abs.schritt }) };
    if (m) return tmMeldung(m);
    return { ok: false, text: r.fehler || t('Keine Antwort vom Host') };
  }
  /** Editor-Fenster zum Ausprobieren (läuft, bis es geschlossen wird) */
  async editor(pfad, cid) {
    if (!this.pruefen(pfad, cid)) return { ok: false, text: t('Unbekanntes Plug-in') };
    const r = await hostLaufen(['--editor', pfad, cid], { frist: 0 });
    const m = r.meldungen.find((x) => x.e === 'editor');
    const abs = r.meldungen.find((x) => x.e === 'absturz');
    if (abs) return { ok: false, text: t('Das Plug-in ist abgestürzt ({modul}, bei „{schritt}“).', { modul: abs.modul, schritt: abs.schritt }) };
    return m ? tmMeldung(m) : { ok: false, text: r.fehler || t('Keine Antwort vom Host') };
  }
}

/* ---------- Slots: Plug-ins in der Klangkette (ein Host-Prozess je Slot) ---------- */
const sauber = (t) => String(t || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);

class VstSlots {
  constructor(userData, engineSenden, ereignis) {
    this.dir = userData;
    this.zustandDir = path.join(userData, 'vst-zustand');
    this.presetDir = path.join(userData, 'vst-presets');
    this.engineSenden = engineSenden;
    this.ereignis = ereignis;       // (id, meldung) → Web-App
    this.slots = new Map();         // id → { kind, pfad, cid, bereit, shm, ein, aus, absicht, antworten }
    for (const d of [this.zustandDir, this.presetDir]) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* egal */ } }
  }
  gueltigeId(id) { return /^vst[0-7]$/.test(String(id)); }
  zustandsDatei(id, cid) { return path.join(this.zustandDir, `${id}-${sauber(cid)}.bin`); }

  /** Host für einen Slot starten und an die Engine hängen; löst auf, sobald das Plug-in läuft */
  starten(id, pfad, cid, plugins) {
    if (!this.gueltigeId(id)) return Promise.resolve({ ok: false, text: t('Ungültiger Slot') });
    if (!plugins.pruefen(pfad, cid)) return Promise.resolve({ ok: false, text: t('Unbekanntes Plug-in') });
    this.beenden(id, false);
    return new Promise((resolve) => {
      const zustand = this.zustandsDatei(id, cid);
      let kind;
      try {
        kind = spawn(hostPfad(), ['--slot', pfad, cid, id, zustand], { windowsHide: false, env: { ...process.env, AW_LOGDIR: log.ordner() || '' } });
      } catch (e) { log.schreiben('FEHLER', `Slot ${id}: Host startet nicht: ${e.message}`); return resolve({ ok: false, text: t('Host startet nicht ({grund})', { grund: e.message }) }); }
      const slot = { kind, pfad, cid, bereit: false, absicht: false, antworten: [] };
      this.slots.set(id, slot);
      log.schreiben('INFO', `Slot ${id}: Host gestartet (pid ${kind.pid}) für ${pfad}`);
      let erledigt = false;
      const fertig = (r) => { if (erledigt) return; erledigt = true; clearTimeout(uhr); resolve(r); };
      const uhr = setTimeout(() => {
        log.schreiben('WARN', `Slot ${id}: Host meldet sich nicht (15 s) – beende`);
        slot.absicht = true; try { kind.kill(); } catch (e) { /* weg */ }
        fertig({ ok: false, text: t('Das Plug-in startet nicht (Zeitüberschreitung)') });
      }, 15000);
      let rest = '';
      kind.stdout.setEncoding('utf8');
      kind.stdout.on('data', (d) => {
        rest += d; let i;
        while ((i = rest.indexOf('\n')) >= 0) {
          const z = rest.slice(0, i).trim(); rest = rest.slice(i + 1);
          if (!z) continue;
          let m; try { m = JSON.parse(z); } catch (e) { continue; }
          if (m.e === 'bereit') {
            slot.bereit = true; slot.shm = m.shm; slot.ein = m.ein; slot.aus = m.aus; slot.info = m;
            this.anEngine(id, slot);
            fertig({ ok: true, name: m.name, latenz: m.latenz, editor: m.editor, parameter: m.parameter, zustand: m.zustand });
          } else if (m.e === 'fehler') {
            log.schreiben('WARN', `Slot ${id}: ${m.text}`);
            fertig({ ok: false, text: tm(m.text) });
          } else if (m.e === 'zustand') {
            const w = slot.antworten.shift(); if (w) w(m);
          } else this.ereignis(id, tmMeldung(m));
        }
      });
      kind.stderr.on('data', (d) => log.schreiben('INFO', `Slot ${id} stderr: ${String(d).trim()}`));
      kind.on('error', (e) => { log.schreiben('FEHLER', `Slot ${id}: ${e.message}`); fertig({ ok: false, text: e.message }); });
      kind.on('exit', (code) => {
        log.schreiben(slot.absicht ? 'INFO' : 'WARN', `Slot ${id}: Host beendet (Code ${code})${slot.absicht ? '' : ' – unerwartet'}`);
        if (this.slots.get(id) === slot) this.slots.delete(id);
        this.engineSenden({ c: 'vst_ab', art: id });
        if (!slot.absicht) {
          const text = code === 3 ? t('Das Plug-in ist abgestürzt (Einzelheiten im Log)') : t('Der Plug-in-Prozess wurde beendet (Code {code})', { code });
          this.ereignis(id, { e: 'abgestuerzt', code, text });
        }
        fertig({ ok: false, text: code === 3 ? t('Das Plug-in ist beim Start abgestürzt') : t('Host beendet (Code {code})', { code }) });
      });
    });
  }
  anEngine(id, slot) { if (slot.bereit) this.engineSenden({ c: 'vst_an', art: id, 'w.shm': slot.shm, 'w.ein': slot.ein, 'w.aus': slot.aus }); }
  /** Engine wurde neu gestartet: alle laufenden Slots wieder anbinden */
  engineNeu() { for (const [id, s] of this.slots) this.anEngine(id, s); }

  beenden(id, zustandLoeschen) {
    const s = this.slots.get(id);
    if (s) {
      s.absicht = true;
      this.slots.delete(id);
      this.engineSenden({ c: 'vst_ab', art: id });
      try { s.kind.stdin.write(JSON.stringify({ c: 'ende' }) + '\n'); } catch (e) { /* weg */ }
      setTimeout(() => { try { s.kind.kill(); } catch (e) { /* schon weg */ } }, 3000);
    }
    if (zustandLoeschen) {
      try { for (const f of fs.readdirSync(this.zustandDir)) if (f.startsWith(`${id}-`)) fs.unlinkSync(path.join(this.zustandDir, f)); } catch (e) { /* egal */ }
    }
  }
  alleBeenden() { for (const id of [...this.slots.keys()]) this.beenden(id, false); }

  befehl(id, b) { const s = this.slots.get(id); if (!s || !s.bereit) return false; try { s.kind.stdin.write(JSON.stringify(b) + '\n'); return true; } catch (e) { return false; } }
  editor(id) { return this.befehl(id, { c: 'editor_auf' }); }
  editorZu(id) { return this.befehl(id, { c: 'editor_zu' }); }
  liste() { return [...this.slots.entries()].map(([id, s]) => ({ id, bereit: s.bereit, pfad: s.pfad, cid: s.cid, name: s.info?.name, latenz: s.info?.latenz, editor: s.info?.editor })); }

  /* ----- Presets: Zustandsdateien je Plug-in (Klasse) ----- */
  presetOrdner(cid) { return path.join(this.presetDir, sauber(cid)); }
  presetListe(cid) {
    try { return fs.readdirSync(this.presetOrdner(cid)).filter((f) => f.endsWith('.awv')).map((f) => f.slice(0, -4)).sort((a, b) => a.localeCompare(b, locale())); } catch (e) { return []; }
  }
  presetDatei(cid, name) { return path.join(this.presetOrdner(cid), `${String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 80) || 'Preset'}.awv`); }
  _antwort(id, ms) {
    const s = this.slots.get(id);
    return new Promise((r) => { if (!s) return r(null); const w = (m) => { clearTimeout(t); r(m); }; const t = setTimeout(() => { s.antworten = s.antworten.filter((x) => x !== w); r(null); }, ms); s.antworten.push(w); });
  }
  async presetSpeichern(id, cid, name) {
    const s = this.slots.get(id);
    if (!s || s.cid !== cid) return { ok: false, text: t('Plug-in läuft nicht') };
    const datei = this.presetDatei(cid, name);
    try { fs.mkdirSync(path.dirname(datei), { recursive: true }); } catch (e) { /* egal */ }
    const a = this._antwort(id, 8000);
    if (!this.befehl(id, { c: 'zustand_speichern', datei })) return { ok: false, text: t('Plug-in antwortet nicht') };
    const m = await a;
    return m && m.ok ? { ok: true, name: path.basename(datei, '.awv') } : { ok: false, text: t('Das Plug-in lieferte keinen Zustand') };
  }
  async presetLaden(id, cid, name) {
    const s = this.slots.get(id);
    if (!s || s.cid !== cid) return { ok: false, text: t('Plug-in läuft nicht') };
    const datei = this.presetDatei(cid, name);
    if (!fs.existsSync(datei)) return { ok: false, text: t('Preset nicht gefunden') };
    const a = this._antwort(id, 8000);
    if (!this.befehl(id, { c: 'zustand_laden', datei })) return { ok: false, text: t('Plug-in antwortet nicht') };
    const m = await a;
    return m && m.ok ? { ok: true } : { ok: false, text: t('Das Plug-in nahm das Preset nicht an') };
  }
  presetLoeschen(cid, name) { try { fs.unlinkSync(this.presetDatei(cid, name)); return true; } catch (e) { return false; } }
}

module.exports = { Vst, VstSlots, standardOrdner, dateienFinden };
