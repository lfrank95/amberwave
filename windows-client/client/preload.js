// Brücke für die Amberwave-Web-App im Client-Fenster: Wiedergabe über die Engine, Geräte, Medientasten.
// Nur für die Adresse des eingerichteten Servers (main.js prüft die Herkunft jeder Nachricht zusätzlich).
// Auf der eigenen Einrichtungsseite (file:) gibt es stattdessen die Server-Suche.
const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('client-info');
if (info && info.erlaubt) {
  const hoerer = new Set();
  const tasten = new Set();
  ipcRenderer.on('engine', (_e, m) => { for (const f of hoerer) { try { f(m); } catch (x) { console.error(x); } } });
  ipcRenderer.on('taste', (_e, t) => { for (const f of tasten) { try { f(t); } catch (x) { console.error(x); } } });
  contextBridge.exposeInMainWorld('amberwaveNativ', {
    version: info.version,
    plattform: info.plattform,
    sprache: info.sprache,   // Sprache des Clients ('de'|'en')
    senden: (befehl) => ipcRenderer.send('engine-senden', befehl),
    auf: (f) => { hoerer.add(f); return () => hoerer.delete(f); },
    aufTaste: (f) => { tasten.add(f); return () => tasten.delete(f); },
    geraete: () => ipcRenderer.invoke('geraete'),
    ausgabeLesen: () => ipcRenderer.invoke('ausgabe-lesen'),
    ausgabeSetzen: (w) => ipcRenderer.send('ausgabe-setzen', w),
    geraetMerken: (w) => ipcRenderer.send('geraet-merken', w),
    ausgaengeLesen: (treiber) => ipcRenderer.invoke('ausgaenge-lesen', treiber),
    ausgaengeSetzen: (treiber, liste) => ipcRenderer.invoke('ausgaenge-setzen', treiber, liste),
    ausgangBass: (treiber, id, werte) => ipcRenderer.invoke('ausgang-bass', treiber, id, werte),
    ausgangVorschau: (treiber, id, ausgang, neutral) => ipcRenderer.invoke('ausgang-vorschau', treiber, id, ausgang, !!neutral),
    eqPresets: () => ipcRenderer.invoke('eq-presets'),
    eqPresetSetzen: (name, baender) => ipcRenderer.invoke('eq-preset-setzen', name, baender),
    asioKanaele: (treiber) => ipcRenderer.invoke('asio-kanaele', treiber),
    testton: (treiber, ausgang) => ipcRenderer.invoke('testton', treiber, ausgang),
    vst: {
      liste: () => ipcRenderer.invoke('vst-liste'),
      scannen: (komplett) => ipcRenderer.invoke('vst-scannen', !!komplett),
      aufFortschritt: (f) => { const h = (_e, d) => f(d); ipcRenderer.on('vst-fortschritt', h); return () => ipcRenderer.removeListener('vst-fortschritt', h); },
      probe: (pfad, cid) => ipcRenderer.invoke('vst-probe', pfad, cid),
      editor: (pfad, cid) => ipcRenderer.invoke('vst-editor', pfad, cid),
      ordnerSetzen: (liste) => ipcRenderer.invoke('vst-ordner-setzen', liste),
      slotStart: (id, pfad, cid) => ipcRenderer.invoke('vst-slot-start', id, pfad, cid),
      slotWeg: (id, loeschen) => ipcRenderer.invoke('vst-slot-weg', id, !!loeschen),
      slotEditor: (id, auf) => ipcRenderer.invoke('vst-slot-editor', id, auf),
      slotListe: () => ipcRenderer.invoke('vst-slot-liste'),
      aufEreignis: (f) => { const h = (_e, d) => f(d); ipcRenderer.on('vst-ereignis', h); return () => ipcRenderer.removeListener('vst-ereignis', h); },
      presetListe: (cid) => ipcRenderer.invoke('vst-preset-liste', cid),
      presetSpeichern: (id, cid, name) => ipcRenderer.invoke('vst-preset-speichern', id, cid, name),
      presetLaden: (id, cid, name) => ipcRenderer.invoke('vst-preset-laden', id, cid, name),
      presetLoeschen: (cid, name) => ipcRenderer.invoke('vst-preset-loeschen', cid, name),
      logOeffnen: () => ipcRenderer.invoke('log-ordner-oeffnen'),
      diagnose: () => ipcRenderer.invoke('diagnose-erstellen'),
    },
    serverWechseln: () => ipcRenderer.send('server-wechseln'),
    spracheSetzen: (wert) => ipcRenderer.send('sprache-setzen', wert),   // 'de' | 'en' | 'auto'
    clientEinst: () => ipcRenderer.invoke('client-einst'),
    clientEinstSetzen: (w) => ipcRenderer.invoke('client-einst-setzen', w),
  });
}

if (info && info.einrichtung) {
  contextBridge.exposeInMainWorld('einrichtung', {
    sprache: info.sprache,
    spracheSetzen: (wert) => ipcRenderer.send('sprache-setzen', wert),
    info: () => ipcRenderer.invoke('einrichtung-info'),
    suchen: (port) => ipcRenderer.invoke('einrichtung-suchen', port),
    pruefen: (adresse, port) => ipcRenderer.invoke('einrichtung-pruefen', adresse, port),
    verbinden: (server) => ipcRenderer.invoke('einrichtung-verbinden', server),
  });
}
