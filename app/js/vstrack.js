// VST3-Plug-ins im Effektrack (Windows Client, Pro): jedes Plug-in belegt einen Slot „vst0“ … „vst7“ und steht wie Glow, Iron, Silk
// und EQ in der frei verschiebbaren Reihenfolge. Die Slot-Liste liegt in localStorage dieses PCs (Plug-ins gehören zum Rechner);
// Einstellungen und Presets der Plug-ins verwaltet der Host-Prozess (Dateien im Benutzerordner des Clients).
import { nativ } from './nativ.js';
import { toast } from './ui.js';
import { t } from './i18n.js';

const KEY = 'amberwave.vst.slots.v1';
/** Schnittstelle zum Client (Prüfhaken window.__awVst: Oberflächentests im Browser ohne Client) */
const API = nativ?.vst || (typeof window !== 'undefined' && window.__awVst) || null;
export const VST_MAX = 8;
export const istVstId = (id) => /^vst[0-7]$/.test(String(id));

function lesen() {
  try {
    const l = JSON.parse(localStorage.getItem(KEY) || '[]');
    return (Array.isArray(l) ? l : []).filter((s) => istVstId(s.id) && s.pfad && /^[0-9A-F]{32}$/.test(s.cid)).slice(0, VST_MAX)
      .map((s) => ({ id: s.id, pfad: s.pfad, cid: s.cid, name: String(s.name || 'Plug-in'), anbieter: String(s.anbieter || ''), an: s.an !== false, preset: String(s.preset || '') }));
  } catch (e) { return []; }
}

class VstRack extends EventTarget {
  constructor() {
    super();
    this.verfuegbar = !!(API && API.slotStart);
    this.slots = this.verfuegbar ? lesen().map((s) => ({ ...s, status: 'start', text: '', latenz: 0, editor: false, editorAuf: false, pegel: { i: [0, 0], a: [0, 0], t: 0 } })) : [];
    if (!this.verfuegbar) return;
    (nativ?.auf || API.auf)((m) => {
      if (m.e === 'vstpegel') { const s = this.slotNr(m.s); if (s) s.pegel = { i: m.i || [0, 0], a: m.a || [0, 0], t: performance.now() }; }
      else if (m.e === 'vstfehler') { const s = this.slotNr(m.s); if (s) { s.status = 'fehler'; s.text = m.text; this.aenderung(); toast(`${s.name}: ${m.text}`, 'fehler'); } }
    });
    API.aufEreignis((m) => {
      const s = this.finde(m.id);
      if (!s) return;
      if (m.e === 'abgestuerzt') { s.status = 'fehler'; s.text = m.text; s.editorAuf = false; this.aenderung(); toast(`${s.name}: ${m.text}`, 'fehler'); }
      else if (m.e === 'editor') { s.editorAuf = !!m.auf; if (m.ok === false) toast(m.text || t('Oberfläche nicht geöffnet'), 'fehler'); this.aenderung(true); }
      else if (m.e === 'latenz') { s.latenz = m.samples; this.aenderung(true); }
    });
    setTimeout(() => this.starten(), 1200);
  }

  slotNr(n) { return this.finde(`vst${n}`); }
  finde(id) { return this.slots.find((s) => s.id === id) || null; }
  ids() { return this.slots.map((s) => s.id); }
  /** läuft das Plug-in und ist es eingeschaltet? (dann steht es im Signalweg) */
  wirksam(id) { const s = this.finde(id); return !!s && s.an && s.status === 'bereit'; }

  speichern() {
    try { localStorage.setItem(KEY, JSON.stringify(this.slots.map(({ id, pfad, cid, name, anbieter, an, preset }) => ({ id, pfad, cid, name, anbieter, an, preset })))); } catch (e) { /* ohne Speicher weiter */ }
  }
  /** nurAnzeige: nur Rack neu zeichnen, die Kette der Engine bleibt */
  aenderung(nurAnzeige = false) { this.dispatchEvent(new CustomEvent('aenderung', { detail: { nurAnzeige } })); }

  async slotStarten(s) {
    s.status = 'start'; s.text = ''; this.aenderung(true);
    const r = await API.slotStart(s.id, s.pfad, s.cid).catch((e) => ({ ok: false, text: String(e) }));
    if (!this.finde(s.id)) { API.slotWeg(s.id, false); return; }   // inzwischen entfernt
    if (r && r.ok) { s.status = 'bereit'; s.text = ''; s.latenz = r.latenz || 0; s.editor = !!r.editor; if (r.name) s.name = r.name; }
    else { s.status = 'fehler'; s.text = (r && r.text) || t('Plug-in startet nicht'); toast(`${s.name}: ${s.text}`, 'fehler'); }
    this.aenderung();
  }
  async starten() { await Promise.all(this.slots.filter((s) => s.status === 'start').map((s) => this.slotStarten(s))); }

  /** Plug-in aus dem Browser in den ersten freien Slot; liefert die neue Slot-ID oder null */
  async hinzufuegen(plugin) {
    if (!this.verfuegbar) return null;
    const frei = Array.from({ length: VST_MAX }, (_, i) => `vst${i}`).find((id) => !this.finde(id));
    if (!frei) { toast(t('Höchstens {n} Plug-ins', { n: VST_MAX }), 'fehler'); return null; }
    const s = { id: frei, pfad: plugin.pfad, cid: plugin.cid, name: plugin.name, anbieter: plugin.anbieter || '', an: true, preset: '', status: 'start', text: '', latenz: 0, editor: false, editorAuf: false, pegel: { i: [0, 0], a: [0, 0], t: 0 } };
    this.slots.push(s); this.speichern(); this.aenderung();
    await this.slotStarten(s);
    return frei;
  }
  async entfernen(id) {
    const i = this.slots.findIndex((s) => s.id === id);
    if (i < 0) return;
    this.slots.splice(i, 1); this.speichern();
    this.aenderung();
    await API.slotWeg(id, true).catch(() => {});
  }
  anSetzen(id, an) { const s = this.finde(id); if (!s || s.an === !!an) return; s.an = !!an; this.speichern(); this.aenderung(); }
  async neuStarten(id) { const s = this.finde(id); if (s) await this.slotStarten(s); }
  editor(id) { const s = this.finde(id); if (!s) return; API.slotEditor(id, !s.editorAuf).catch(() => {}); }

  // Presets
  presetListe(s) { return API.presetListe(s.cid).catch(() => []); }
  async presetSpeichern(s, name) {
    const r = await API.presetSpeichern(s.id, s.cid, name).catch(() => null);
    if (r?.ok) { s.preset = r.name; this.speichern(); this.aenderung(true); } else toast(r?.text || t('Preset nicht gespeichert'), 'fehler');
    return !!r?.ok;
  }
  async presetLaden(s, name) {
    const r = await API.presetLaden(s.id, s.cid, name).catch(() => null);
    if (r?.ok) { s.preset = name; this.speichern(); this.aenderung(true); } else toast(r?.text || t('Preset nicht geladen'), 'fehler');
    return !!r?.ok;
  }
  presetLoeschen(s, name) { return API.presetLoeschen(s.cid, name).catch(() => false); }
}

export const vstRack = new VstRack();
