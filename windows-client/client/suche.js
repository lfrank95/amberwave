// Amberwave im Heimnetz finden: alle Adressen der eigenen Netze (je /24) auf dem Amberwave-Port fragen (/api/v1/ping).
// Virtuelle Adapter (VPN, Hyper-V, WSL, VirtualBox, Docker …) werden übersprungen, damit nicht in fremden Netzen gesucht wird.
const os = require('os');
const net = require('net');
const { locale } = require('./i18n');

const VIRTUELL = /(vethernet|hyper-v|virtualbox|vmware|vbox|wsl|docker|vpn|tap|tun|wireguard|tailscale|zerotier|hamachi|npcap|loopback|bluetooth|teredo|isatap)/i;

/** eigene IPv4-Netze: [{adresse, basis:'192.168.1', adapter}] */
function netze() {
  const aus = [];
  const gesehen = new Set();
  for (const [name, liste] of Object.entries(os.networkInterfaces())) {
    if (VIRTUELL.test(name)) continue;
    for (const a of liste || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      const basis = a.address.split('.').slice(0, 3).join('.');
      if (gesehen.has(basis)) continue;
      gesehen.add(basis);
      aus.push({ adresse: a.address, basis, adapter: name });
    }
  }
  return aus;
}

/** /api/v1/ping einer Basisadresse (http://host:port oder https://…) – Antwort oder null */
async function pingen(basis, ms = 1500) {
  try {
    const r = await fetch(`${basis.replace(/\/+$/, '')}/api/v1/ping`, { signal: AbortSignal.timeout(ms), redirect: 'follow', cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.app === 'amberwave' ? j : null;
  } catch (e) {
    return null;
  }
}

/** Ist der TCP-Port offen? (schnell: geschlossene Ports antworten sofort, stumme Adressen nach ms) */
function portOffen(host, port, ms = 700) {
  return new Promise((fertig) => {
    const s = net.connect({ host, port });
    let erledigt = false;
    const ende = (ok) => { if (erledigt) return; erledigt = true; s.destroy(); fertig(ok); };
    s.setTimeout(ms, () => ende(false));
    s.once('connect', () => ende(true));
    s.once('error', () => ende(false));
  });
}

/** Alle Amberwave-Server in den eigenen Netzen auf den angegebenen Ports */
async function suchen(ports = [9950], parallel = 256) {
  const ziele = [];
  for (const n of netze()) {
    for (let i = 1; i < 255; i++) {
      const ip = `${n.basis}.${i}`;
      for (const p of ports) ziele.push([ip, p]);
    }
  }
  const funde = [];
  let next = 0;
  const arbeiter = async () => {
    while (next < ziele.length) {
      const [ip, port] = ziele[next++];
      if (!await portOffen(ip, port)) continue;
      const basis = `http://${ip}:${port}`;
      const j = await pingen(basis, 2500);
      if (j) funde.push({ lan: basis, url: j.url || '', name: j.name || 'Amberwave', version: j.version || '' });
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, ziele.length) }, arbeiter));
  // gleicher Server über mehrere Netze/Ports nur einmal
  const eindeutig = new Map();
  for (const f of funde) {
    const k = `${f.name}|${f.url}`;
    if (!eindeutig.has(k)) eindeutig.set(k, f);
  }
  return [...eindeutig.values()].sort((a, b) => a.lan.localeCompare(b.lan, locale(), { numeric: true }));
}

/** Eingabe wie „192.168.1.10“, „nas:9950“ oder „https://musik.example.de“ zu einer Basisadresse */
function adresseNormal(text, port = 9950) {
  let t = String(text || '').trim();
  if (!t) return '';
  if (!/^https?:\/\//i.test(t)) t = `http://${t}`;
  try {
    const u = new URL(t);
    if (u.protocol === 'http:' && !u.port && /^\d+\.\d+\.\d+\.\d+$|^[a-z0-9-]+$/i.test(u.hostname)) u.port = String(port);
    return `${u.protocol}//${u.host}`;
  } catch (e) {
    return '';
  }
}

module.exports = { netze, pingen, suchen, adresseNormal };
