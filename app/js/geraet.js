// Einstellungen › Amberwave OS: das Gerät selbst (nur, wenn Amberwave auf Amberwave OS läuft).
// Name im Netz, Netzwerk (mit Probezeit für eine feste Adresse), Musikquelle, Speicher, Updates, Strom, Protokoll, SSH.
// Die App spricht dafür über /admin/geraet mit dem Gerätedienst auf dem Gerät (os/…/geraet.py).
import { api } from './api.js';
import { h, icon, toast, dialog, bestaetigen, groesse, datumZeit } from './ui.js';
import { t, zahl } from './i18n.js';
import { serverUpdateInstallieren } from './update_hinweis.js';

const karte = (titel, inhalt, rechts = '', attr = '') => `<div class="einst-karte" ${attr}><h2><span>${h(titel)}</span>${rechts}</h2>${inhalt}</div>`;
const zeile = (k, name, hinweis, regler = '', attr = '') => `<div class="einst-zeile" data-k="${k}" ${attr}><div class="einst-text"><span class="einst-name">${name}</span>${hinweis ? `<p>${hinweis}</p>` : ''}</div>${regler ? `<div class="einst-regler">${regler}</div>` : ''}</div>`;
const chip = (text, art = '') => `<span class="einst-chip ${art}">${h(text)}</span>`;
const schalter = (an, attr) => `<button type="button" class="schalter" role="switch" aria-checked="${an ? 'true' : 'false'}" ${attr}></button>`;
const segment = (optionen, wert, attr) => `<div class="segment" role="radiogroup" ${attr}>${optionen.map(([w, tx]) => `<button type="button" role="radio" data-w="${h(w)}" aria-checked="${w === wert}">${h(tx)}</button>`).join('')}</div>`;
const balken = (s) => s && s.gesamt ? `<div class="os-balken"><div class="flac-balken"><i style="width:${Math.max(1, Math.round(s.belegt * 100 / s.gesamt))}%"></i></div><small>${t('{belegt} von {gesamt}', { belegt: groesse(s.belegt), gesamt: groesse(s.gesamt) })}</small></div>` : '';

function dauer(s) {
  const tage = Math.floor(s / 86400), std = Math.floor(s / 3600);
  return tage >= 1 ? (tage === 1 ? t('seit 1 Tag') : t('seit {n} Tagen', { n: tage })) : std >= 1 ? t('seit {n} Std.', { n: std }) : t('seit eben');
}

const FEHLER = {
  name: () => t('Nur Kleinbuchstaben, Ziffern und Bindestriche, höchstens 32 Zeichen.'),
  netz: () => t('Adresse und Router passen nicht zusammen (gleiches Netz? Router nicht dieselbe Adresse?).'),
  adresse: () => t('Das ist keine gültige Adresse.'),
  platte: () => t('Diese Platte ist nicht (mehr) angesteckt.'),
  zugang: () => t('Benutzername oder Passwort stimmen nicht.'),
  nicht_erreichbar: () => t('Die Freigabe ist nicht erreichbar. Stimmt die Adresse, ist das NAS an?'),
  einbinden: () => t('Die Musik ließ sich nicht einbinden.'),
  schluessel: () => t('Das sieht nicht wie ein öffentlicher SSH-Schlüssel aus (ssh-ed25519 …).'),
  kein_schluessel: () => t('Bitte zuerst einen öffentlichen Schlüssel eintragen.'),
};
const fehlerText = (r) => (FEHLER[r?.fehler] || (() => t('Das hat nicht geklappt.')))();

/** Wartet, bis Amberwave wieder antwortet (nach Neustart des Geräts oder des Containers) – dann neu laden */
function wartenBisDa(titel, text, danach = null) {
  const band = document.createElement('div');
  band.className = 'update-warten';
  band.innerHTML = `<div class="update-warten-karte"><span class="update-kreis"></span><b>${h(titel)}</b><p>${text}</p></div>`;
  document.body.appendChild(band);
  let weg = false;
  const beginn = Date.now();
  const runde = async () => {
    let da = false;
    try { da = (await (await fetch('/api/v1/ping', { cache: 'no-store' })).json())?.app === 'amberwave'; } catch (e) { weg = true; }
    if (da && (weg || Date.now() - beginn > 20000)) {
      if (danach) await danach().catch(() => {});
      location.reload();
      return;
    }
    setTimeout(runde, 3000);
  };
  setTimeout(runde, 4000);
}

export async function geraetZeichnen(app, inhalt, signal) {
  const g = await api.get('/admin/geraet', { signal });
  const n = g.netz, m = g.musik, sys = g.system, wl = g.wlan;
  // Subnetzmaske statt Präfix (255.255.255.0 statt /24) – so steht es auch im Router
  const maske = (p) => [0, 1, 2, 3].map((i) => (0xffffffff << (32 - p) >>> (24 - i * 8)) & 255).join('.');
  const praefixJetzt = parseInt((n.fest.adresse || n.adresse || '/24').split('/')[1], 10) || 24;
  const signalText = (d) => (d == null ? '' : d >= -60 ? t('starkes Signal') : d >= -72 ? t('mittleres Signal') : t('schwaches Signal'));
  const adresse = `${g.name}.local`;
  const platten = m.platten || [];
  const plattenName = (p) => `${p.label || p.modell || p.name} · ${groesse(p.groesse)} · ${p.fstype}`;
  const hw = g.hardware;

  inhalt.innerHTML = `
    ${n.probe ? `<div class="hinweis-box os-probe" data-probe><b>${t('Neue Adresse {adresse} behalten?', { adresse: h(n.probe.adresse) })}</b>
      <span data-probe-rest></span>
      <div class="os-knoepfe"><button type="button" class="btn btn-klein" data-probe-ja>${t('Behalten')}</button>
      <button type="button" class="btn btn-zweit btn-klein" data-probe-nein>${t('Zurück auf automatisch')}</button></div></div>` : ''}
    <div class="einst-teil"><span>${h(t('Amberwave OS {version}', { version: g.version }))}</span>${chip(t('läuft {dauer}', { dauer: dauer(hw.laufzeit) }), 'gut')}</div>

    ${karte(t('Gerät'), `
      ${zeile('name', t('Name im Netz'), t('Darunter ist Amberwave im Browser erreichbar: {adresse}', { adresse: `<code>http://${h(adresse)}</code>` }),
        `<span class="os-gruppe"><input type="text" class="einst-feld os-name" data-name value="${h(g.name)}" maxlength="32" autocomplete="off" spellcheck="false" aria-label="${h(t('Name im Netz'))}"><span class="einheit">.local</span></span>
         <button type="button" class="btn btn-klein" data-name-los hidden>${t('Übernehmen')}</button>`)}
      ${zeile('adressen', t('Adressen'), t('Für Geräte, die {local} nicht kennen (manche Android-Handys, Smart-TVs)', { local: '<code>.local</code>' }),
        `<div class="os-chips">${[...g.ips, ...g.ips6].map((a) => chip(a)).join('') || chip(t('keine'), 'warn')}</div>`)}
      ${zeile('hardware', t('Hardware'), [hw.cpu, hw.kerne ? t('{n} Kerne', { n: hw.kerne }) : '', hw.ram ? t('{g} Arbeitsspeicher', { g: groesse(hw.ram) }) : '', hw.temperatur != null ? `${hw.temperatur} °C` : ''].filter(Boolean).map(h).join(' · '))}`)}

    ${karte(t('Netzwerk'), `
      ${g.wlan ? zeile('wlan', t('WLAN'), wl?.wechsel?.stand === 'laeuft' ? t('Wechselt zu „{ssid}“ …', { ssid: h(wl.wechsel.ssid) })
        : wl?.verbindung ? t('Verbunden mit „{ssid}“', { ssid: h(wl.verbindung.ssid) }) + (wl.adresse ? ` · <code>${h(wl.adresse)}</code>` : '') + (wl.verbindung.signal != null ? ` · ${signalText(wl.verbindung.signal)}` : '')
        : wl?.gespeichert ? t('„{ssid}“ ist gespeichert, aber gerade nicht erreichbar.', { ssid: h(wl.gespeichert) })
        : t('Nicht verbunden. Mit Kabel braucht es kein WLAN.'),
        `<button type="button" class="btn btn-zweit btn-klein" data-wlan-waehlen>${wl?.gespeichert ? t('Anderes WLAN …') : t('WLAN wählen …')}</button>${wl?.gespeichert ? `<button type="button" class="btn-ico" data-wlan-vergessen aria-label="${h(t('WLAN vergessen'))}" title="${h(t('WLAN vergessen'))}">${icon('muell', 17)}</button>` : ''}`) : ''}
      ${wl?.wechsel?.stand === 'fehler' ? `<p class="einst-karten-hinweis fehler-text">${t('Mit „{ssid}“ hat es nicht geklappt – das Gerät ist im bisherigen Netz geblieben. Stimmt das Passwort?', { ssid: h(wl.wechsel.ssid) })}</p>` : ''}
      ${zeile('netz', t('Adresse beziehen'), t('Automatisch passt fast immer. Eine feste Adresse nur, wenn dein Router keine Adresse reservieren kann.'),
        segment([['auto', t('Automatisch')], ['fest', t('Fest')]], n.art, 'data-netz-art'))}
      <div class="os-fest" data-fest ${n.art === 'fest' ? '' : 'hidden'}>
        ${zeile('netz-adresse', t('Adresse'), t('z. B. {beispiel}', { beispiel: '<code>192.168.178.50</code>' }),
          `<input type="text" class="einst-feld" data-f="adresse" inputmode="decimal" value="${h((n.fest.adresse || n.adresse || '').split('/')[0])}" placeholder="192.168.178.50">`)}
        ${zeile('netz-maske', t('Subnetzmaske'), t('Fast immer 255.255.255.0 – steht sonst in den Einstellungen deines Routers.'),
          `<select class="einst-feld" data-f="praefix">${[24, 16, 8, 25, 26, 27, 28, 29, 30, 23, 22, 21, 20].map((p) => `<option value="${p}" ${p === praefixJetzt ? 'selected' : ''}>${maske(p)}</option>`).join('')}</select>`)}
        ${zeile('netz-router', t('Router'), '', `<input type="text" class="einst-feld" data-f="router" inputmode="decimal" value="${h(n.fest.router || n.router)}" placeholder="192.168.178.1">`)}
        ${zeile('netz-dns', t('DNS-Server'), t('Leer = der Router'), `<input type="text" class="einst-feld" data-f="dns" value="${h(n.fest.dns)}" placeholder="${h(n.router || '192.168.178.1')}">`)}
      </div>
      <div class="einst-zeile os-los" data-netz-los hidden><div class="einst-text"><p>${t('Nach dem Übernehmen hast du 3 Minuten, um die neue Adresse zu bestätigen – sonst stellt sich das Gerät von selbst zurück.')}</p></div>
        <div class="einst-regler"><button type="button" class="btn btn-klein" data-netz-uebernehmen>${t('Übernehmen')}</button></div></div>
      <p class="einst-fuss">${[n.schnittstelle && `${t('Schnittstelle')} <code>${h(n.schnittstelle)}</code>`, n.mac && `MAC <code>${h(n.mac)}</code>`, n.router && `${t('Router')} <code>${h(n.router)}</code>`, n.dns.length ? `DNS <code>${n.dns.map(h).join(', ')}</code>` : ''].filter(Boolean).join(' · ')}</p>`,
      wl?.verbindung && n.schnittstelle === wl.karte ? chip(t('WLAN · {signal}', { signal: signalText(wl.verbindung.signal) }), 'gut')
        : n.verbunden ? chip(n.mbit ? t('Kabel · {g}', { g: n.mbit >= 1000 ? `${zahl(n.mbit / 1000)} Gbit/s` : `${n.mbit} Mbit/s` }) : t('Kabel verbunden'), 'gut') : chip(t('kein Kabel'), 'warn'))}

    ${karte(t('Musik'), `
      ${zeile('musik', t('Wo liegt deine Musik?'), t('Nach einer Änderung startet Amberwave kurz neu und liest die Bibliothek ein – Wiedergabelisten und Verlauf bleiben.'),
        `<select class="einst-feld" data-musik-art>
          <option value="intern" ${m.art === 'intern' ? 'selected' : ''}>${t('Auf diesem Gerät')}</option>
          <option value="platte" ${m.art === 'platte' ? 'selected' : ''}>${t('USB-Platte')}</option>
          <option value="nas" ${m.art === 'nas' ? 'selected' : ''}>${t('Netzwerkfreigabe (NAS)')}</option></select>`)}
      <div data-musik-teil="intern" ${m.art === 'intern' ? '' : 'hidden'}>${zeile('musik-intern', t('Ordner'), t('Auf der Daten-Partition dieses Geräts. Bis Amberwave hier selbst Musik annimmt, ist eine USB-Platte oder ein NAS der bequemere Weg.'))}</div>
      <div data-musik-teil="platte" ${m.art === 'platte' ? '' : 'hidden'}>
        ${zeile('musik-platte', t('Platte'), platten.length ? '' : t('Keine passende Platte gefunden – ist sie angesteckt?'),
          platten.length ? `<select class="einst-feld" data-musik-uuid>${platten.map((p) => `<option value="${h(p.uuid)}" ${p.uuid === m.uuid ? 'selected' : ''}>${h(plattenName(p))}</option>`).join('')}</select>` : '')}
        ${zeile('musik-lesen', t('Nur lesen'), t('Amberwave verändert nichts auf der Platte (Cover und Tags schreiben geht dann nicht).'), schalter(m.nur_lesen, 'data-musik-lesen'))}
      </div>
      <div data-musik-teil="nas" ${m.art === 'nas' ? '' : 'hidden'}>
        ${zeile('musik-pfad', t('Freigabe'), t('z. B. {beispiel} – SMB, wie bei Windows-Freigaben', { beispiel: '<code>//nas/musik</code>' }), `<input type="text" class="einst-feld" data-musik-pfad value="${h(m.pfad)}" placeholder="//nas/musik" spellcheck="false">`)}
        ${zeile('musik-benutzer', t('Benutzer'), '', `<input type="text" class="einst-feld" data-musik-benutzer value="${h(m.benutzer)}" autocomplete="off" spellcheck="false">`)}
        ${zeile('musik-passwort', t('Passwort'), '', `<input type="password" class="einst-feld" data-musik-passwort autocomplete="new-password" placeholder="${h(m.art === 'nas' ? t('gespeichert') : '')}">`)}
      </div>
      <div class="einst-zeile os-los" data-musik-los hidden><div class="einst-text"><p data-musik-meldung></p></div>
        <div class="einst-regler"><button type="button" class="btn btn-zweit btn-klein" data-musik-pruefen>${t('Verbindung prüfen')}</button><button type="button" class="btn btn-klein" data-musik-uebernehmen>${t('Übernehmen')}</button></div></div>`,
      m.eingebunden ? chip(t('eingebunden'), 'gut') : chip(t('nicht eingebunden'), 'warn'))}

    ${karte(t('Speicher'), `
      ${zeile('speicher-system', t('System'), t('Amberwave OS selbst – wird bei großen Updates frisch aufgespielt') + balken(g.speicher.system))}
      ${zeile('speicher-daten', t('Daten'), t('Datenbank, Cover, Sicherungen und das Amberwave-Paket – bleibt bei jedem Update') + balken(g.speicher.daten))}
      ${g.speicher.musik ? zeile('speicher-musik', t('Musik'), h(m.art === 'nas' ? m.pfad : m.art === 'platte' ? t('USB-Platte') : t('Auf diesem Gerät')) + balken(g.speicher.musik)) : ''}`)}

    ${karte(t('Updates'), `
      ${zeile('update', 'Amberwave', g.update
        ? t('Installiert {alt} · neu: {neu}', { alt: h(g.app_version), neu: `<b>${h(g.update.version)}</b>` }) + (g.update.url ? ` · <a href="${h(g.update.url)}" target="_blank" rel="noopener">${t('Was ist neu?')}</a>` : '')
        : t('{version} – auf dem neuesten Stand', { version: h(g.app_version) }) + (g.update_gesucht ? ` · ${t('zuletzt gesucht {datum}', { datum: h(datumZeit(g.update_gesucht)) })}` : ''),
        `<div class="os-knoepfe" style="margin:0"><button type="button" class="btn btn-zweit btn-klein" data-update-suchen>${icon('suche', 16)}<span>${t('Jetzt suchen')}</span></button>
         ${g.update ? `<button type="button" class="btn btn-klein" data-update-los>${icon('download', 16)}<span>${t('Update installieren')}</span></button>` : ''}</div>`)}
      ${zeile('kanal', t('Welche Versionen?'), t('Stabil ist erprobt. Beta bringt Neues früher – und ab und zu einen Fehler. Zurück auf eine ältere Version geht es dabei nie.'),
        segment([['latest', t('Stabil')], ['beta', t('Beta')]], g.kanal, 'data-kanal'))}
      ${zeile('sicherheitsupdates', t('Sicherheitsupdates des Systems'), t('Nachts automatisch installieren. Braucht eines einen Neustart, steht das hier.'), schalter(g.sicherheitsupdates, 'data-sicherheit'))}
      <p class="einst-fuss">${[sys.geprueft ? t('System zuletzt geprüft {zeit}', { zeit: new Date(sys.geprueft * 1000).toLocaleString() }) : '', sys.debian && `Debian ${h(sys.debian)}`, `Kernel ${h(sys.kernel)}`].filter(Boolean).join(' · ')}</p>`,
      sys.neustart_noetig ? chip(t('Neustart nötig'), 'warn') : '')}

    ${karte(t('Ein, aus, Hilfe'), `
      ${zeile('strom', t('Gerät'), t('Laufende Wiedergaben brechen ab. Nach dem Neustart ist Amberwave in etwa einer Minute wieder da.'),
        `<button type="button" class="btn btn-zweit btn-klein" data-strom="neustart">${t('Neu starten')}</button><button type="button" class="btn btn-zweit btn-klein" data-strom="aus">${t('Ausschalten')}</button>`)}
      ${zeile('protokoll', t('Protokoll für die Fehlersuche'), t('Was das System und Amberwave zuletzt gemeldet haben – als Datei, zum Weitergeben. Passwörter sind nicht enthalten.'),
        `<a class="btn btn-zweit btn-klein" href="/api/v1/admin/geraet/protokoll" download>${t('Herunterladen')}</a>`)}
      ${zeile('ssh', t('Fernzugang per SSH'), t('Nur für Fachleute. Anmeldung als root, ausschließlich mit Schlüssel – nie mit Passwort.') + (g.ssh.an ? ` <code>ssh root@${h(adresse)}</code>` : ''),
        schalter(g.ssh.an, 'data-ssh'))}
      <div data-ssh-teil ${g.ssh.an ? '' : 'hidden'}>${zeile('ssh-schluessel', t('Öffentliche Schlüssel'), t('Einer pro Zeile ({n} hinterlegt)', { n: g.ssh.liste.length }),
        `<button type="button" class="btn btn-zweit btn-klein" data-ssh-schluessel>${t('Bearbeiten …')}</button>`)}</div>`)}`;

  if (wl?.wechsel?.stand === 'laeuft') { const u = setTimeout(() => location.reload(), 4000); signal?.addEventListener('abort', () => clearTimeout(u)); }
  const $ = (s) => inhalt.querySelector(s);
  const $$ = (s) => inhalt.querySelectorAll(s);
  const senden = async (aktion, daten = {}) => api.post(`/admin/geraet/${aktion}`, daten);

  // Probezeit einer festen Adresse
  if (n.probe) {
    const rest = $('[data-probe-rest]');
    const zaehlen = () => { const s = Math.max(0, n.probe.bis - Math.floor(Date.now() / 1000)); rest.textContent = t('Sonst stellt sich das Gerät in {s} s von selbst zurück.', { s }); };
    zaehlen();
    const uhr = setInterval(zaehlen, 1000);
    signal?.addEventListener('abort', () => clearInterval(uhr));
    $('[data-probe-ja]').addEventListener('click', async () => { await senden('netz-bestaetigen'); toast(t('Neue Adresse behalten.'), 'gut'); $('[data-probe]').remove(); clearInterval(uhr); });
    $('[data-probe-nein]').addEventListener('click', async () => {
      await senden('netz', { art: 'auto' });
      wartenBisDa(t('Zurück auf automatisch'), t('Das Gerät holt sich wieder eine Adresse vom Router. Diese Seite lädt danach von selbst – falls nicht, öffne {adresse}.', { adresse: `<code>http://${h(adresse)}</code>` }));
    });
  }

  // Name
  const nameFeld = $('[data-name]');
  nameFeld.addEventListener('input', () => { $('[data-name-los]').hidden = nameFeld.value.trim().toLowerCase() === g.name; });
  $('[data-name-los]').addEventListener('click', async (e) => {
    e.target.closest('button').disabled = true;
    try {
      const r = await senden('name', { name: nameFeld.value.trim().toLowerCase() });
      if (!r.ok) { toast(fehlerText(r), 'fehler'); return; }
      const neu = `${r.name}.local`;
      toast(t('Amberwave heißt jetzt {adresse}.', { adresse: neu }), 'gut');
      if (location.hostname === adresse) setTimeout(() => { location.href = `${location.protocol}//${neu}${location.port ? ':' + location.port : ''}${location.pathname}`; }, 2500);
      else setTimeout(() => location.reload(), 1200);
    } catch (x) { toast(x.message, 'fehler'); } finally { e.target.closest('button').disabled = false; }
  });

  // WLAN
  $('[data-wlan-waehlen]')?.addEventListener('click', async (e) => {
    const knopf = e.currentTarget;
    knopf.disabled = true;
    let netze = [];
    try { netze = (await senden('wlan-suchen')).netze || []; } catch (x) { toast(x.message, 'fehler'); } finally { knopf.disabled = false; }
    const r = await dialog({
      titel: t('WLAN wählen'),
      inhalt: `<label class="os-feld">${t('Netz')}<select name="ssid" class="einst-feld" data-wahl>${netze.map((x) => `<option value="${h(x.ssid)}" ${x.ssid === wl?.gespeichert ? 'selected' : ''}>${h(x.ssid)} · ${signalText(x.signal)}${x.sicher ? '' : ` · ${t('offen')}`}</option>`).join('')}
          <option value="">${t('Anderes WLAN …')}</option></select></label>
        <label class="os-feld" data-anders ${netze.length ? 'hidden' : ''}>${t('Name des WLANs')}<input type="text" name="anders" class="einst-feld" maxlength="32" spellcheck="false" autocomplete="off"></label>
        <label class="os-feld">${t('WLAN-Passwort')}<input type="password" name="passwort" class="einst-feld" autocomplete="off" placeholder="${h(t('leer lassen bei offenem oder schon gespeichertem Netz'))}"></label>
        <p class="hinweis">${t('Hängst du gerade selbst über dieses WLAN dran, reißt die Verbindung kurz ab. Klappt der Wechsel nicht, geht das Gerät nach etwa einer Minute ins bisherige Netz zurück.')}</p>`,
      knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Verbinden'), wert: 'ja' }],
      beimOeffnen: (d) => {
        const wahl = d.querySelector('[data-wahl]');
        const zeigen = () => { d.querySelector('[data-anders]').hidden = wahl.value !== ''; };
        wahl.addEventListener('change', zeigen); zeigen();
      },
    });
    if (!r) return;
    const ssid = (r.form.get('ssid') || r.form.get('anders') || '').trim();
    if (!ssid) return;
    try {
      const a = await senden('wlan', { ssid, passwort: r.form.get('passwort') || '' });
      if (!a.ok) { toast(a.fehler === 'eingabe' ? t('Das WLAN-Passwort hat 8 bis 63 Zeichen.') : fehlerText(a), 'fehler'); return; }
      wartenBisDa(t('Wechsle ins WLAN „{ssid}“', { ssid }), t('Das dauert bis zu einer Minute. Hängst du selbst an diesem WLAN, lädt die Seite danach von selbst – sonst öffne {adresse}.', { adresse: `<code>http://${h(adresse)}</code>` }));
    } catch (x) { toast(x.message, 'fehler'); }
  });
  $('[data-wlan-vergessen]')?.addEventListener('click', async () => {
    const ohneKabel = !n.verbunden || n.schnittstelle === wl.karte;
    if (!await bestaetigen(t('WLAN vergessen?'), ohneKabel ? t('Das Gerät hat kein Netzwerkkabel – ohne WLAN ist es danach nicht mehr erreichbar, bis ein Kabel steckt.') : t('Das Gerät trennt sich vom WLAN und bleibt über das Kabel erreichbar.'), t('Vergessen'), ohneKabel)) return;
    try { await senden('wlan-vergessen'); toast(t('WLAN vergessen.'), 'gut'); setTimeout(() => location.reload(), 800); } catch (x) { toast(x.message, 'fehler'); }
  });

  // Netzwerk
  let netzArt = n.art;
  const netzGeaendert = () => { $('[data-netz-los]').hidden = netzArt === n.art && (netzArt === 'auto' || !inhalt.querySelector('[data-fest] [data-geaendert]')); };
  $$('[data-netz-art] button').forEach((b) => b.addEventListener('click', () => {
    netzArt = b.dataset.w;
    $$('[data-netz-art] button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    $('[data-fest]').hidden = netzArt !== 'fest';
    netzGeaendert();
  }));
  $$('[data-fest] input').forEach((f) => f.addEventListener('input', () => { f.dataset.geaendert = '1'; netzGeaendert(); }));
  $('[data-netz-uebernehmen]').addEventListener('click', async (e) => {
    const daten = { art: netzArt };
    if (netzArt === 'fest') $$('[data-fest] [data-f]').forEach((f) => { daten[f.dataset.f] = f.value.trim(); });
    if (netzArt === 'fest' && !await bestaetigen(t('Feste Adresse {adresse} übernehmen?', { adresse: daten.adresse }),
      t('Das Gerät wechselt gleich auf die neue Adresse. Öffne Amberwave danach unter der neuen Adresse und bestätige sie innerhalb von 3 Minuten – sonst stellt es sich von selbst zurück.'), t('Übernehmen'))) return;
    e.target.disabled = true;
    try {
      const r = await senden('netz', daten);
      if (!r.ok) { toast(fehlerText(r), 'fehler'); e.target.disabled = false; return; }
      if (netzArt === 'auto') {
        wartenBisDa(t('Adresse vom Router'), t('Das Gerät holt sich eine Adresse vom Router. Diese Seite lädt danach von selbst – falls nicht, öffne {adresse}.', { adresse: `<code>http://${h(adresse)}</code>` }));
        return;
      }
      const ziel = (host) => `http://${host}/einstellungen/geraet`;
      const band = document.createElement('div');
      band.className = 'update-warten';
      band.innerHTML = `<div class="update-warten-karte"><b>${t('Jetzt unter der neuen Adresse öffnen')}</b>
        <p>${t('Melde dich dort an und tippe auf „Behalten“. Ohne Bestätigung stellt sich das Gerät nach 3 Minuten zurück.')}</p>
        <p class="os-knoepfe" style="justify-content:center"><a class="btn" href="${h(ziel(r.adresse))}">${h(r.adresse)}</a><a class="btn btn-zweit" href="${h(ziel(adresse))}">${h(adresse)}</a></p></div>`;
      document.body.appendChild(band);
    } catch (x) { toast(x.message, 'fehler'); e.target.disabled = false; }
  });

  // Musik
  const musikArt = $('[data-musik-art]');
  const musikDaten = () => {
    const art = musikArt.value;
    if (art === 'platte') return { art, uuid: $('[data-musik-uuid]')?.value || '', nur_lesen: $('[data-musik-lesen]').getAttribute('aria-checked') === 'true' };
    if (art === 'nas') return { art, pfad: $('[data-musik-pfad]').value.trim(), benutzer: $('[data-musik-benutzer]').value.trim(), passwort: $('[data-musik-passwort]').value };
    return { art };
  };
  const musikZeigen = () => {
    $$('[data-musik-teil]').forEach((x) => { x.hidden = x.dataset.musikTeil !== musikArt.value; });
    $('[data-musik-los]').hidden = false;
    $('[data-musik-pruefen]').hidden = musikArt.value !== 'nas';
    $('[data-musik-meldung]').textContent = '';
  };
  musikArt.addEventListener('change', musikZeigen);
  $$('[data-musik-teil] input, [data-musik-teil] select').forEach((f) => f.addEventListener('input', musikZeigen));
  $('[data-musik-lesen]').addEventListener('click', (e) => { const s = e.currentTarget; s.setAttribute('aria-checked', String(s.getAttribute('aria-checked') !== 'true')); musikZeigen(); });
  $('[data-musik-pruefen]').addEventListener('click', async (e) => {
    const knopf = e.currentTarget, meldung = $('[data-musik-meldung]');
    knopf.disabled = true; meldung.textContent = t('Prüfe …');
    try {
      const r = await senden('musik-pruefen', musikDaten());
      meldung.textContent = r.ok ? t('Verbindung steht · {n} Einträge in der Freigabe', { n: zahl(r.eintraege) }) : fehlerText(r);
      meldung.className = r.ok ? '' : 'fehler-text';
    } catch (x) { meldung.textContent = x.message; } finally { knopf.disabled = false; }
  });
  $('[data-musik-uebernehmen]').addEventListener('click', async (e) => {
    const knopf = e.currentTarget;
    if (!await bestaetigen(t('Musikquelle wechseln?'), t('Amberwave startet dafür kurz neu und liest die Bibliothek danach neu ein. Titel, die es in der neuen Quelle nicht gibt, verschwinden aus der Bibliothek.'), t('Wechseln'))) return;
    knopf.disabled = true;
    $('[data-musik-meldung]').textContent = t('Binde ein …');
    try {
      const r = await senden('musik', musikDaten());
      if (!r.ok) { $('[data-musik-meldung]').textContent = fehlerText(r); $('[data-musik-meldung]').className = 'fehler-text'; knopf.disabled = false; return; }
      wartenBisDa(t('Musikquelle gewechselt'), t('Amberwave startet neu und liest danach die Bibliothek ein. Diese Seite lädt von selbst.'),
        () => api.post('/admin/scan', { art: 'neu' }));
    } catch (x) { toast(x.message, 'fehler'); knopf.disabled = false; }
  });

  // Updates
  $('[data-update-suchen]')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.querySelector('span').textContent = t('Suche …');
    try {
      const r = await api.post('/admin/update/suchen');
      if (!r.ok) toast(t('GitHub ist gerade nicht erreichbar – später noch einmal versuchen.'), 'fehler');
      else if (r.update) toast(t('Neue Version {version} gefunden.', { version: r.update.version }));
      else toast(t('Auf dem neuesten Stand ({version}).', { version: r.version }));
      geraetZeichnen(app, inhalt, signal);
    } catch (x) { toast(x.message, 'fehler'); b.disabled = false; b.querySelector('span').textContent = t('Jetzt suchen'); }
  });
  $('[data-update-los]')?.addEventListener('click', async (e) => {
    const ok = await dialog({
      titel: t('Update auf {version} installieren?', { version: h(g.update.version) }),
      inhalt: `<p>${t('Das Gerät lädt die neue Version, startet Amberwave darin neu und geht von selbst zurück, falls sie nicht startet. Laufende Wiedergaben brechen ab, Bibliothek, Konten und Einstellungen bleiben.')}</p>`,
      knoepfe: [{ text: t('Abbrechen'), wert: 'nein', art: 'zweit' }, { text: t('Jetzt installieren'), wert: 'ja' }],
    });
    if (ok?.wert !== 'ja') return;
    e.target.closest('button').disabled = true;
    try { await serverUpdateInstallieren(g.update.version, g.app_version, true); } catch (x) { toast(x.message, 'fehler'); e.target.closest('button').disabled = false; }
  });
  $$('[data-kanal] button').forEach((b) => b.addEventListener('click', async () => {
    if (b.getAttribute('aria-checked') === 'true') return;
    try {
      await senden('kanal', { kanal: b.dataset.w });
      $$('[data-kanal] button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      toast(b.dataset.w === 'beta' ? t('Ab jetzt auch Beta-Versionen.') : t('Ab jetzt nur stabile Versionen.'), 'gut');
    } catch (x) { toast(x.message, 'fehler'); }
  }));
  $('[data-sicherheit]').addEventListener('click', async (e) => {
    const s = e.currentTarget, an = s.getAttribute('aria-checked') !== 'true';
    try { await senden('sicherheitsupdates', { an }); s.setAttribute('aria-checked', String(an)); } catch (x) { toast(x.message, 'fehler'); }
  });

  // Strom
  $$('[data-strom]').forEach((b) => b.addEventListener('click', async () => {
    const aus = b.dataset.strom === 'aus';
    if (!await bestaetigen(aus ? t('Gerät ausschalten?') : t('Gerät neu starten?'),
      aus ? t('Wieder an geht es nur am Gerät selbst (Einschaltknopf).') : t('Laufende Wiedergaben brechen ab. Nach etwa einer Minute ist Amberwave wieder da.'),
      aus ? t('Ausschalten') : t('Neu starten'), aus)) return;
    try {
      await senden('strom', { aktion: b.dataset.strom });
      if (aus) {
        const band = document.createElement('div');
        band.className = 'update-warten';
        band.innerHTML = `<div class="update-warten-karte"><b>${t('Das Gerät schaltet sich aus')}</b><p>${t('Du kannst es vom Strom nehmen, sobald es still ist. Einschalten am Gerät selbst.')}</p></div>`;
        document.body.appendChild(band);
      } else {
        wartenBisDa(t('Gerät startet neu'), t('Das dauert etwa eine Minute – diese Seite lädt danach von selbst.'));
      }
    } catch (x) { toast(x.message, 'fehler'); }
  }));

  // SSH
  const sshSchluesselDialog = async (einschalten) => {
    const r = await dialog({
      titel: t('Fernzugang per SSH'),
      inhalt: `<p>${t('Öffentliche Schlüssel, einer pro Zeile (Inhalt von {datei}). Ein Passwort-Zugang ist nie möglich.', { datei: '<code>~/.ssh/id_ed25519.pub</code>' })}</p>
        <textarea name="schluessel" rows="5" class="einst-feld" style="width:100%;height:auto;font-family:var(--font-mono,monospace);font-size:.8rem" placeholder="ssh-ed25519 AAAA… name@pc" spellcheck="false">${h(g.ssh.liste.join('\n'))}</textarea>
        <p style="margin-top:14px">${t('Zur Sicherheit: dein Amberwave-Passwort')}</p>
        <input type="password" name="passwort" class="einst-feld" style="width:100%" autocomplete="current-password" required>`,
      knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: einschalten ? t('Einschalten') : t('Speichern'), wert: 'ja' }],
    });
    if (!r) return false;
    const antwort = await senden('ssh', { an: true, schluessel: r.form.get('schluessel'), passwort: r.form.get('passwort') });
    if (!antwort.ok) { toast(fehlerText(antwort), 'fehler'); return false; }
    return true;
  };
  $('[data-ssh]').addEventListener('click', async (e) => {
    const s = e.currentTarget, an = s.getAttribute('aria-checked') !== 'true';
    try {
      if (an ? await sshSchluesselDialog(true) : (await senden('ssh', { an: false })).ok) {
        s.setAttribute('aria-checked', String(an));
        $('[data-ssh-teil]').hidden = !an;
        toast(an ? t('SSH ist an.') : t('SSH ist aus.'), 'gut');
      }
    } catch (x) { toast(x.message, 'fehler'); }
  });
  $('[data-ssh-schluessel]').addEventListener('click', async () => {
    try { if (await sshSchluesselDialog(false)) toast(t('Schlüssel gespeichert.'), 'gut'); } catch (x) { toast(x.message, 'fehler'); }
  });
}
