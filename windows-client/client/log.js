// Log des Clients: %APPDATA%\…\log\client.log (Electron-Teil, Engine-Ausgaben, Absturzberichte). Die VST-Hosts schreiben daneben
// ihr eigenes vsthost.log in denselben Ordner. Beim Schicken von Fehlern: Einstellungen → Plug-ins → „Diagnosedatei“.
const fs = require('fs');
const path = require('path');
const os = require('os');

let ordner = null, datei = null;

function starten(userData) {
  ordner = path.join(userData, 'log');
  try { fs.mkdirSync(ordner, { recursive: true }); } catch (e) { /* ohne Log weiter */ }
  datei = path.join(ordner, 'client.log');
  try {
    if (fs.existsSync(datei) && fs.statSync(datei).size > 3 * 1024 * 1024) {
      try { fs.unlinkSync(path.join(ordner, 'client.1.log')); } catch (e) { /* war nicht da */ }
      fs.renameSync(datei, path.join(ordner, 'client.1.log'));
    }
  } catch (e) { /* egal */ }
  // console.* mitschreiben (und weiter an die Konsole)
  for (const art of ['log', 'warn', 'error']) {
    const alt = console[art].bind(console);
    console[art] = (...a) => { alt(...a); schreiben(art === 'error' ? 'FEHLER' : art === 'warn' ? 'WARN' : 'INFO', a.map((x) => (x instanceof Error ? x.stack || x.message : typeof x === 'string' ? x : safeJson(x))).join(' ')); };
  }
  process.on('uncaughtException', (e) => { schreiben('ABSTURZ', e && e.stack ? e.stack : String(e)); });
  process.on('unhandledRejection', (e) => { schreiben('FEHLER', 'unhandledRejection: ' + (e && e.stack ? e.stack : String(e))); });
  return ordner;
}
function safeJson(x) { try { return JSON.stringify(x); } catch (e) { return String(x); } }

function schreiben(stufe, text) {
  if (!datei) return;
  const d = new Date(), p = (n, l = 2) => String(n).padStart(l, '0');
  const zeit = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  try { fs.appendFileSync(datei, `${zeit} [${process.pid}] ${stufe} ${String(text).replace(/\r?\n/g, '\n    ')}\n`); } catch (e) { /* egal */ }
}

/** Diagnosedatei: Systemangaben + Ende der Logs in einer Textdatei */
function diagnose(ziel, kopf) {
  const teile = [`Amberwave Diagnose ${new Date().toISOString()}`, kopf || '', `System: ${os.type()} ${os.release()} ${os.arch()} · ${os.cpus()[0]?.model || ''} · ${Math.round(os.totalmem() / 1048576)} MB RAM`, ''];
  let namen = [];
  try { namen = fs.readdirSync(ordner).filter((n) => /\.log$/.test(n) && !/\.1\.log$/.test(n)); } catch (e) { /* leer */ }
  for (const n of namen) {
    let t = '';
    try { t = fs.readFileSync(path.join(ordner, n), 'utf8'); } catch (e) { t = String(e); }
    const z = t.split('\n');
    teile.push(`===== ${n} (letzte ${Math.min(z.length, 1500)} von ${z.length} Zeilen) =====`, z.slice(-1500).join('\n'), '');
  }
  fs.writeFileSync(ziel, teile.join('\n'));
  return ziel;
}

module.exports = { starten, schreiben, diagnose, ordner: () => ordner };
