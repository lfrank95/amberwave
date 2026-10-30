// Einrichtungs-Assistent (/einrichtung.php): Start → (Code) → Ordner → Konto → Einrichten → Fertig → erstes Einlesen.
// Jeder Serverschritt ist wiederholbar – nach einem Fehler macht „Nochmal versuchen“ dort weiter.
// Wird als Modul geladen (<script type="module">), damit i18n.js eingebunden werden kann.
import { t, tn, locale } from './i18n.js';

(function () {
  'use strict';
  const wurzel = document.getElementById('einr');
  const b = document.getElementById('b');
  if (!wurzel || !b) return;
  const $ = (id) => document.getElementById(id);
  const csrf = wurzel.dataset.csrf;
  const codeNoetig = wurzel.dataset.code === '1';
  const zeigeDb = wurzel.dataset.db === '1';
  // Nachholen: schon eingerichtet (Admin aus der Vorlage des All-in-One-Images) – Region, Ordner, Servername, Fertig
  const nach = wurzel.dataset.nach === '1';
  const minLaenge = parseInt(wurzel.dataset.minlaenge || '8', 10);
  const appName = wurzel.dataset.app || 'Amberwave';
  const reduz = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fmt = (n) => Math.round(n).toLocaleString(locale);
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let code = '';
  let daten = {};
  let sys = null;
  let fertigDaten = null;
  let restEnde = parseInt(wurzel.dataset.rest || '0', 10) > 0 ? Date.now() + parseInt(wurzel.dataset.rest, 10) * 1000 : 0;

  // Code aus dem Link im Log (?code=…) übernehmen und aus der Adresszeile entfernen
  try {
    const u = new URL(location.href);
    const c = u.searchParams.get('code');
    if (c) { code = c; u.searchParams.delete('code'); history.replaceState(null, '', u.pathname + u.search); }
  } catch (e) { /* egal */ }

  async function senden(schritt, body) {
    const r = await fetch('/einrichtung.php?schritt=' + encodeURIComponent(schritt), {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify(Object.assign({ code }, body || {})),
    });
    let d = null;
    try { d = await r.json(); } catch (e) { d = { ok: false, fehler: t('Unerwartete Antwort vom Server ({status}).', { status: r.status }) }; }
    d.status = r.status;
    return d;
  }

  // ---------- Seitenwechsel mit Übergang ----------
  const REIHE = ['start', 'region', 'code', 'check', 'konto', 'umzug', 'server', 'lauf', 'fertig', 'scan', 'scanfertig'];
  let umzug = false;   // „Von einer anderen Installation übernehmen“ statt Konto anlegen
  const OHNE_KOPF = ['start', 'fertig', 'scan', 'scanfertig'];
  const KURZ = ['code', 'lauf'];
  const ICON = {
    code: '🔑',
    lauf: '<svg class="logo2 eqs" viewBox="0 0 64 64" width="84" height="84"><defs><linearGradient id="g4" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffc35a"/><stop offset="1" stop-color="#ff6a3d"/></linearGradient></defs><g fill="url(#g4)"><rect class="st" x="11" y="27" width="5" height="10" rx="2.5"/><rect class="st" x="19.5" y="20" width="5" height="24" rx="2.5"/><rect class="st" x="28" y="13" width="5" height="38" rx="2.5"/><rect class="st" x="36.5" y="22" width="5" height="20" rx="2.5"/><rect class="st" x="45" y="17" width="5" height="30" rx="2.5"/></g></svg>',
  };
  let wechsel = 0;
  let aktuell = null;
  let timer = null;
  let anim = null;

  function stoppen() {
    if (timer) { clearInterval(timer); timer = null; }
    if (anim) { cancelAnimationFrame(anim); anim = null; }
  }

  function fussText(name) {
    const min = restEnde ? Math.max(0, Math.ceil((restEnde - Date.now()) / 60000)) : 0;
    let txt = restEnde && ['start', 'region', 'code', 'check', 'konto'].includes(name) ? tn(min, 'Das Einrichtungsfenster schließt in einer Minute.', 'Das Einrichtungsfenster schließt in {n} Minuten.') : '';
    if (name === 'konto' && !codeNoetig) txt += ' ' + t('Diese Seite ist nur im Heimnetz ohne Code erreichbar und verschwindet nach der Einrichtung.');
    return txt.trim();
  }

  function aufbauen(name) {
    stoppen();
    b.innerHTML = '';
    if (!OHNE_KOPF.includes(name)) {
      b.insertAdjacentHTML('beforeend', '<div class="kopf"><img src="' + esc(wurzel.dataset.logo) + '" alt="" width="30" height="30">' + esc(appName) + '</div>');
    }
    b.appendChild(document.getElementById('t-' + name).content.cloneNode(true));
    if (nach || umzug) {
      // Schrittleiste: „Konto“ gibt es schon (Nachholen) bzw. kommt aus dem Paket (Umzug)
      b.querySelectorAll('.schritte>div').forEach((d) => { if (d.textContent === t('Konto')) d.textContent = nach ? t('Server') : t('Übernehmen'); });
    }
    const f = fussText(name);
    if (f) b.insertAdjacentHTML('beforeend', '<p class="fuss">' + esc(f) + '</p>');
    const k = b.querySelector('.karte');
    if (k) {
      if (KURZ.includes(name)) {
        k.classList.add('kurz');
        const kb = document.createElement('div'); kb.className = 'kb';
        const ill = document.createElement('div'); ill.className = 'ill'; ill.innerHTML = ICON[name] || '';
        const kc = document.createElement('div'); kc.className = 'kc';
        [...k.children].filter((c) => !c.classList.contains('schritte')).forEach((c) => kc.appendChild(c));
        kb.append(ill, kc); k.appendChild(kb);
      }
      if (!k.querySelector('.ani')) k.classList.add('stuf');
      SETUP[name] && SETUP[name](k);
      // Hauptknöpfe an den unteren Rand schieben
      if (!KURZ.includes(name)) {
        const u = k.querySelector(':scope>.unten,:scope>button.btn:first-of-type,:scope>.zweig');
        if (u) { const sp = document.createElement('div'); sp.className = 'sp0'; k.insertBefore(sp, u); }
      }
      [...(k.querySelector(':scope>.kb>.kc') || k).children].forEach((c, n) => c.style.setProperty('--k', Math.min(n, 12)));
    }
    aktuell = name;
  }

  async function seite(name) {
    const mein = ++wechsel;
    const r = aktuell === null ? 1 : (REIHE.indexOf(name) >= REIHE.indexOf(aktuell) ? 1 : -1);
    if (aktuell !== null && !reduz) {
      b.style.setProperty('--r', r); b.classList.remove('rein'); b.classList.add('raus');
      await new Promise((x) => setTimeout(x, 210));
      if (mein !== wechsel) return;
    }
    b.classList.remove('raus');
    aufbauen(name);
    b.style.setProperty('--r', r); b.classList.remove('rein'); void b.offsetWidth; b.classList.add('rein');
    window.scrollTo({ top: 0 });
  }

  wurzel.removeAttribute('hidden');

  function ersterSchritt() { return !nach && codeNoetig && !code ? 'code' : 'check'; }

  // ---------- Region (Land, Sprache, Zeitzone, Formate, Währung) ----------
  const RD = (() => { try { return JSON.parse(wurzel.dataset.region || '{}'); } catch (e) { return {}; } })();
  const seitenSprache = wurzel.dataset.sprache || 'en';
  let region = {};
  try { region = JSON.parse(sessionStorage.getItem('awRegion') || '{}') || {}; } catch (e) { region = {}; }
  const regionMerken = () => { try { sessionStorage.setItem('awRegion', JSON.stringify(region)); } catch (e) { /* egal */ } };
  // Sprache wechseln: Cookie setzen, Seite neu laden und danach wieder bei „Region“ weitermachen
  function spracheWechseln(neu) {
    regionMerken();
    try { sessionStorage.setItem('awWeiter', 'region'); } catch (e) { /* egal */ }
    document.cookie = 'aw_sprache=' + neu + '; path=/; max-age=31536000; samesite=lax' + (location.protocol === 'https:' ? '; secure' : '');
    location.reload();
  }

  // ---------- Seiten ----------
  const SETUP = {};

  SETUP.start = (k) => {
    $('los').onclick = () => seite('region');
    if (!nach) {
      const u = document.createElement('button');
      u.className = 'btn gross zweit'; u.type = 'button'; u.style.marginTop = '10px'; u.textContent = t('Von einer anderen Installation übernehmen');
      u.onclick = () => { umzug = true; seite(ersterSchritt()); };
      $('los').onclick = () => { umzug = false; seite('region'); };
      $('los').insertAdjacentElement('afterend', u);
    }
    if (nach) {
      k.querySelector('.text').textContent = t('Dein Konto steht schon. Jetzt noch kurz Region und Ordner prüfen und deinem Server einen Namen geben – dann liest {app} deine Musik ein.', { app: appName });
      const w = k.querySelectorAll('.weg li');
      [t('Region'), t('Ordner prüfen'), t('Loshören')].forEach((x, i) => { if (w[i]) w[i].lastChild.textContent = x; });
      const sp = document.createElement('button');
      sp.className = 'btn gross zweit'; sp.type = 'button'; sp.style.marginTop = '10px'; sp.textContent = t('Später – zur Bibliothek');
      sp.onclick = async () => { await senden('spaeter'); location.href = '/'; };
      $('los').insertAdjacentElement('afterend', sp);
    }
  };

  SETUP.region = (k) => {
    const sel = (n) => k.querySelector('[name="' + n + '"]');
    const laender = RD.laender || [];
    const optionen = (liste, wahl) => liste.map(([v, text]) => '<option value="' + esc(v) + '"' + (v === wahl ? ' selected' : '') + '>' + esc(text) + '</option>').join('');
    const nachCode = (c) => laender.find((l) => l.code === c);
    // Vorbelegung: gemerkte Wahl → Browser (Zeitzone/Sprache) → leer
    let zone = '', browserLand = '';
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* egal */ }
    try { browserLand = (navigator.language || '').split('-')[1] || ''; } catch (e) { /* egal */ }
    browserLand = browserLand.toUpperCase();
    if (!region.land) {
      const nachZone = laender.find((l) => l.zeitzonen.includes(zone));
      region.land = nachCode(browserLand) ? browserLand : (nachZone ? nachZone.code : '');
      region.zeitzone = zone;
    }
    region.sprache = seitenSprache;   // gilt, was die Seite gerade anzeigt
    const vor = () => nachCode(region.land);
    const zonenListe = () => { const l = vor(); return l && l.zeitzonen.length ? l.zeitzonen : ((RD.alle_zonen) || [region.zeitzone || 'UTC']); };

    sel('land').innerHTML = '<option value="">' + esc(t('Bitte wählen')) + '</option>' + optionen(laender.map((l) => [l.code, l.name]), region.land);
    sel('sprache').innerHTML = optionen(Object.entries(RD.sprachen || { en: 'English', de: 'Deutsch' }), seitenSprache);

    function bauen() {
      const l = vor();
      const zonen = zonenListe();
      if (!zonen.includes(region.zeitzone)) region.zeitzone = (l && zonen.includes(l.zone) ? l.zone : zonen[0]) || '';
      sel('zeitzone').innerHTML = optionen(zonen.map((z) => [z, z.replace(/_/g, ' ')]), region.zeitzone);
      const wl = Object.entries(RD.waehrungen || {}).map(([c, n]) => [c, c + ' – ' + n]);
      if (!region.waehrung) region.waehrung = l ? l.waehrung : 'EUR';
      sel('waehrung').innerHTML = optionen(wl, region.waehrung);
      const dfAuto = l ? l.datumsformat : 'dmy', zfAuto = l ? l.zeitformat : '24';
      const dBsp = { dmy: seitenSprache === 'de' ? '31.12.2026' : '31/12/2026', mdy: '12/31/2026', ymd: '2026-12-31' };
      const zBsp = { 24: '14:30', 12: '2:30 PM' };
      region.datumsformat = region.datumsformat || 'auto'; region.zeitformat = region.zeitformat || 'auto';
      sel('datumsformat').innerHTML = optionen([['auto', t('Automatisch ({beispiel})', { beispiel: dBsp[dfAuto] })], ['dmy', t('Tag Monat Jahr ({beispiel})', { beispiel: dBsp.dmy })], ['mdy', t('Monat Tag Jahr ({beispiel})', { beispiel: dBsp.mdy })], ['ymd', t('Jahr Monat Tag ({beispiel})', { beispiel: dBsp.ymd })]], region.datumsformat);
      sel('zeitformat').innerHTML = optionen([['auto', t('Automatisch ({beispiel})', { beispiel: zBsp[zfAuto] })], ['24', t('24 Stunden ({beispiel})', { beispiel: zBsp[24] })], ['12', t('12 Stunden ({beispiel})', { beispiel: zBsp[12] })]], region.zeitformat);
      const eiAuto = l ? l.einheiten : 'metric';
      region.einheiten = region.einheiten || 'auto';
      sel('einheiten').innerHTML = optionen([['auto', t('Automatisch ({beispiel})', { beispiel: eiAuto === 'imperial' ? t('Fuß, Zoll') : t('Meter, Zentimeter') })], ['metric', t('Meter, Zentimeter')], ['imperial', t('Fuß, Zoll')]], region.einheiten);
      vorschau(dfAuto, zfAuto);
    }
    function vorschau(dfAuto, zfAuto) {
      const df = region.datumsformat === 'auto' ? dfAuto : region.datumsformat, zf = region.zeitformat === 'auto' ? zfAuto : region.zeitformat;
      const d = { dmy: '31.12.2026', mdy: '12/31/2026', ymd: '2026-12-31' }[df];
      const z = zf === '12' ? '2:30 PM' : '14:30';
      let preis = '';
      try { preis = new Intl.NumberFormat(seitenSprache + (region.land ? '-' + region.land : ''), { style: 'currency', currency: region.waehrung }).format(1234.5); } catch (e) { preis = region.waehrung; }
      $('r-vorschau').textContent = t('So sieht es aus: {datum}, {zeit}, {preis}', { datum: d, zeit: z, preis });
    }
    sel('land').onchange = () => {
      region.land = sel('land').value; region.zeitzone = zone; region.waehrung = ''; region.datumsformat = 'auto'; region.zeitformat = 'auto'; region.einheiten = 'auto';
      const l = vor();
      if (l && l.sprache !== seitenSprache) { region.sprache = l.sprache; spracheWechseln(l.sprache); return; }
      bauen();
    };
    sel('sprache').onchange = () => { region.sprache = sel('sprache').value; if (region.sprache !== seitenSprache) spracheWechseln(region.sprache); };
    for (const [n, f] of [['zeitzone', 'zeitzone'], ['waehrung', 'waehrung'], ['datumsformat', 'datumsformat'], ['zeitformat', 'zeitformat'], ['einheiten', 'einheiten']]) {
      sel(n).onchange = () => { region[f] = sel(n).value; bauen(); };
    }
    bauen();
    $('region-weiter').onclick = () => {
      if (!region.land) { sel('land').classList.add('fehler'); sel('land').focus(); return; }
      region.sprache = seitenSprache;
      regionMerken();
      seite(ersterSchritt());
    };
  };

  SETUP.code = () => {
    const eingabe = $('f-code');
    eingabe.focus();
    const weiter = async () => {
      const v = eingabe.value.trim();
      if (!v) { zeigeCodeFehler(t('Bitte den Einrichtungscode eintragen.')); return; }
      code = v;
      $('code-weiter').disabled = true;
      const d = await senden('code');
      $('code-weiter').disabled = false;
      if (!d.ok) {
        if (d.zugang === 'fenster') { location.reload(); return; }
        code = '';
        eingabe.classList.add('fehler');
        zeigeCodeFehler(d.fehler || t('Der Code stimmt nicht.'));
        return;
      }
      seite('check');
    };
    function zeigeCodeFehler(t) { $('code-fehler').hidden = false; $('code-fehler-text').textContent = t; }
    $('code-weiter').onclick = weiter;
    eingabe.addEventListener('keydown', (e) => { if (e.key === 'Enter') weiter(); });
  };

  // --- Ordner und Rechte ---
  let musikSchreiben = false;   // Musikordner: standardmäßig nur lesen
  const MINI = {
    musik: t('Liest deine Sammlung. Ob {app} dort auch schreiben darf (Tags, Aufräumen, Download-Import), entscheidest du unten – standardmäßig nicht. Harter Schutz zusätzlich mit <code>MUSIK_MOUNT_MODUS=ro</code>.', { app: appName }),
    daten: t('Ein Ordner für alles, was {app} selbst erzeugt: Cover, Vorschaubilder und deine Geheimnisse (Datenbank-Passwort, Schlüssel).', { app: appName }),
    sicherungen: t('Datenbank-Sicherung vor jedem Update und eine Kopie deines Schlüssels.'),
    downloads: t('Fertige Downloads von SABnzbd. Nach dem Import löscht {app} das Original – verhindern mit <code>DOWNLOAD_MOUNT_MODUS=ro</code>.', { app: appName }),
  };

  function herkunftText(bn) {
    if (bn.herkunft === 'env') return t('Aus deiner .env (<code>PUID</code>/<code>PGID</code>).');
    if (bn.herkunft === 'erkannt') return t('Automatisch erkannt: dem Benutzer gehört {quelle} – so passt es zu dem, was Lidarr &amp; Co. angelegt haben. Wird gemerkt. Festlegen mit <code>PUID</code>/<code>PGID</code> in der .env.', { quelle: bn.quelle ? '<code>' + esc(bn.quelle) + '</code>' : t('der Ordner') });
    if (bn.herkunft === 'gemerkt') return t('Beim ersten Start automatisch erkannt und gemerkt. <code>PUID</code>/<code>PGID</code> in der .env überschreiben das.');
    if (bn.herkunft === 'standard') return t('Standard des Stacks (nobody:users, wie bei Lidarr &amp; Co. auf Unraid). <code>PUID</code>/<code>PGID</code> in der .env überschreiben das.');
    return t('Vom Container vorgegeben. <code>PUID</code>/<code>PGID</code> in der .env überschreiben das.');
  }

  function ordnerZeile(o, hinweise) {
    const klasse = !o.vorhanden || !o.ok ? 'nein' : (o.warnung || hinweise.some((h) => h.ordner === o.schluessel)) ? 'warn' : (o.optional ? 'opt' : 'ok');
    const zeichen = klasse === 'ok' ? '✓' : klasse === 'opt' ? '+' : '!';
    const pfad = (o.host ? '<i>' + esc(o.host) + '</i> → ' : '<i>') + esc(o.pfad) + (o.host ? '' : '</i>');
    const chips = [];
    if (o.schluessel === 'musik' && o.vorhanden) {
      if (o.dateien > 0) chips.push(['g', o.mehr ? t('über {n} Dateien gefunden', { n: fmt(o.dateien) }) : tn(o.dateien, '1 Datei gefunden', '{n} Dateien gefunden')]);
      else if (o.lesen) chips.push(['w', t('noch keine Musik gefunden')]);
      if (o.probe > 0) chips.push([o.probe_lesbar === o.probe ? 'g' : 'r', t('Stichprobe: {a} von {b} lesbar', { a: o.probe_lesbar, b: o.probe })]);
    }
    if (o.vorhanden) {
      chips.push([o.lesen ? 'g' : 'r', o.lesen ? t('lesen') : t('lesen nicht möglich')]);
      if (o.schreiben) chips.push(['g', t('schreiben')]);
      else if (o.schluessel !== 'musik') chips.push(['r', t('schreiben nicht möglich')]);
      if (o.besitzer) chips.push([o.ok ? '' : 'r', t('Besitzer {besitzer}', { besitzer: o.besitzer.name + ':' + o.besitzer.gruppe + (o.ok ? '' : ' (' + o.besitzer.uid + ':' + o.besitzer.gid + ')') })]);
    }
    if (o.warnung) chips.push(['w', o.warnung]);
    let html = '<li class="' + klasse + '"><span class="pk">' + zeichen + '</span><div class="pt"><strong>' + esc(o.name) + (o.optional ? ' <span class="leise">(' + t('optional') + ')</span>' : '') + '</strong>'
      + '<div class="pfad">' + pfad + '</div>'
      + '<div class="rechte">' + chips.map((c) => '<span class="chip ' + c[0] + '">' + esc(c[1]) + '</span>').join('') + '</div>';
    if (!o.vorhanden || !o.ok) {
      html += '<div class="hinweis rot" style="margin-top:10px"><span>🛠</span><span><b>' + esc(o.fehler || t('Das geht noch nicht')) + '</b>'
        + (o.befehl ? t('{app} läuft nie als root, sondern als {benutzer}. Auf dem Server (Terminal):', { app: appName, benutzer: sys.benutzer.uid + ':' + sys.benutzer.gid }) + '<pre>' + esc(o.befehl) + '</pre>' : t('Prüfe den Pfad in der .env und starte den Stack neu.')) + '</span></div>';
      if (o.falscher_benutzer) {
        const fb = o.falscher_benutzer;
        html += '<details class="fall"><summary>' + t('Falscher Benutzer?') + '</summary>'
          + '<p class="mini" style="margin-top:0">' + t('Dieser Ordner gehört „{name}“, {app} läuft aber als „{lauf}“. Zwei Wege:', { name: esc(fb.name), app: appName, lauf: esc(sys.benutzer.name) }) + '</p>'
          + '<p class="mini">' + t('<b>A) Ordner anpassen</b> (Terminal):') + '</p><div class="kopierzeile"><pre>' + esc(o.befehl) + '</pre><button class="btn2 kopieren" type="button">' + t('Kopieren') + '</button></div>'
          + '<p class="mini">' + t('<b>B) {app} als „{name}“ laufen lassen</b> – dann gehören alle Ordner demselben Benutzer. Diese Zeilen in die .env, Stack neu starten:', { app: esc(appName), name: esc(fb.name) }) + '</p>'
          + '<div class="kopierzeile"><pre>PUID=' + fb.uid + '\nPGID=' + fb.gid + '</pre><button class="btn2 kopieren" type="button">' + t('Kopieren') + '</button></div>'
          + '<p class="mini">' + t('Dann auch prüfen, ob die Musiksammlung für „{name}“ lesbar ist – diese Seite macht das automatisch.', { name: esc(fb.name) }) + '</p></details>';
      }
    }
    hinweise.filter((h) => h.ordner === o.schluessel).forEach((h) => {
      html += '<div class="hinweis gelb" style="margin-top:10px"><span>💡</span><span><b>' + esc(h.titel) + '</b>' + esc(h.text) + '</span></div>';
    });
    if (o.hinweis) html += '<div class="hinweis gelb" style="margin-top:10px"><span>💡</span><span>' + esc(o.hinweis) + '</span></div>';
    if (MINI[o.schluessel]) html += '<p class="mini">' + MINI[o.schluessel] + '</p>';
    return html + '</div></li>';
  }

  function checkZeichnen() {
    const warn = sys.hinweise.length > 0 || sys.ordner.some((o) => o.warnung || o.hinweis);
    const sub = $('ck-sub');
    sub.textContent = !sys.bereit ? t('Ein Ordner passt noch nicht – das lässt sich in einer Minute beheben.')
      : warn ? t('Alles funktioniert – ein paar Dinge würde ich an deiner Stelle ändern.') : t('Alles, was {app} auf deinem Server anfasst – und als wer.', { app: appName });
    const bn = sys.benutzer;
    let html = '<div class="nutzerbox"><div class="av">' + esc(bn.uid) + '</div><div><b>' + t('{app} greift als „{name}“ ({uid}) zu, Gruppe „{gruppe}“ ({gid})', { app: esc(appName), name: esc(bn.name), uid: bn.uid, gruppe: esc(bn.gruppe), gid: bn.gid }) + '</b><span>' + herkunftText(bn) + '</span></div></div>';
    html += '<ul class="pruef">' + sys.ordner.map((o) => ordnerZeile(o, sys.hinweise)).join('') + '</ul>';
    html += '<label class="haken" style="margin:4px 0 18px"><input type="checkbox" id="ck-schreiben"' + (musikSchreiben ? ' checked' : '') + '> <span><b>' + t('{app} darf im Musikordner schreiben', { app: esc(appName) }) + '</b><br>'
      + t('Für Tags, „Dateien aufräumen“, Download-Import und Papierkorb. Aus lassen, wenn du erst einmal nur hören willst – einschalten geht jederzeit unter Einstellungen → Bibliothek & Automatik.') + '</span></label>';
    html += '<h2>' + t('Werkzeuge') + '</h2><ul class="pruef">' + sys.werkzeuge.map((w) => '<li class="' + (w.ok ? 'ok' : 'warn') + '"><span class="pk">' + (w.ok ? '✓' : '!') + '</span><div class="pt"><strong>' + esc(w.name) + '</strong><div class="pfad">' + esc(w.text) + '</div></div></li>').join('') + '</ul>';
    html += '<div class="zweig unten">';
    if (sys.bereit) {
      html += '<button class="btn" id="ck-weiter" type="button">' + (warn ? t('Trotzdem weiter') : t('Weiter')) + '</button><button class="btn zweit" id="ck-nochmal" type="button">' + t('Nochmal prüfen') + '</button>';
    } else {
      html += '<button class="btn" id="ck-nochmal" type="button">' + t('Nochmal prüfen') + '</button><button class="btn zweit aus" disabled type="button">' + t('Weiter (erst wenn alles grün ist)') + '</button>';
    }
    html += '</div>';
    const ziel = $('ck-inhalt');
    ziel.innerHTML = html;
    ziel.querySelectorAll('.pruef .pt>.mini').forEach((m) => {
      const d = document.createElement('details'); d.className = 'mehr'; d.innerHTML = '<summary>ⓘ ' + t('Mehr dazu') + '</summary>';
      m.replaceWith(d); d.appendChild(m);
    });
    ziel.querySelectorAll('.kopieren').forEach((k) => {
      k.onclick = async () => {
        try { await navigator.clipboard.writeText(k.previousElementSibling.textContent); k.textContent = t('Kopiert ✓'); } catch (e) { k.textContent = t('Bitte markieren'); }
      };
    });
    $('ck-schreiben').onchange = (e) => { musikSchreiben = e.target.checked; };
    if ($('ck-weiter')) $('ck-weiter').onclick = () => seite(nach ? 'server' : umzug ? 'umzug' : 'konto');
    $('ck-nochmal').onclick = () => pruefen();
  }

  async function pruefen() {
    const ziel = $('ck-inhalt');
    ziel.innerHTML = '<p class="mini mitte" style="margin:40px 0">' + t('Einen Moment, ich schaue nach …') + '</p>';
    const d = await senden('system');
    if (!d.ok) {
      if (d.zugang === 'fenster') { location.reload(); return; }
      if (d.zugang) { code = ''; seite('code'); return; }
      ziel.innerHTML = '<div class="hinweis rot"><span>⚠️</span><span>' + esc(d.fehler || t('Die Prüfung ist fehlgeschlagen.')) + '</span></div><button class="btn" id="ck-nochmal" type="button">' + t('Nochmal prüfen') + '</button>';
      $('ck-nochmal').onclick = () => pruefen();
      return;
    }
    sys = d;
    checkZeichnen();
  }
  SETUP.check = () => { pruefen(); };

  // --- Konto ---
  SETUP.konto = (k) => {
    const feld = (n) => k.querySelector('[name="' + n + '"]');
    feld('servername').value = wurzel.dataset.servername || '';
    // Werte beim Zurückkommen wiederherstellen
    for (const n of ['vorname', 'nachname', 'benutzername', 'email', 'passwort', 'passwort2', 'servername', 'db_name', 'db_user', 'db_passwort']) {
      if (daten[n] != null && feld(n)) feld(n).value = daten[n];
    }
    $('pw-hinweis').textContent = t('Mindestens {n} Zeichen. Gut: ein Satz, den nur du kennst.', { n: minLaenge });
    if (zeigeDb) {
      $('k-db').hidden = false;
      if (!feld('db_passwort').value) feld('db_passwort').value = wurzel.dataset.dbpw;
      $('wuerfeln').onclick = () => {
        const z = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const r = new Uint32Array(20); crypto.getRandomValues(r);
        let s = ''; for (let i = 0; i < 20; i++) { s += z[r[i] % z.length]; if (i % 4 === 3 && i < 19) s += '-'; }
        feld('db_passwort').value = s;
      };
    } else {
      const n = $('k-dbnotiz'); n.hidden = false;
      n.textContent = wurzel.dataset.db === '0' ? t('Die Datenbank ist schon vorhanden oder wird mit den Werten aus deiner .env angelegt.') : '';
    }
    // Benutzername aus dem Vornamen vorschlagen, solange er nicht von Hand geändert wurde
    let hand = !!feld('benutzername').value;
    feld('benutzername').oninput = () => { hand = true; };
    feld('vorname').oninput = () => {
      if (!hand) feld('benutzername').value = feld('vorname').value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9._-]/g, '');
    };
    // Passwortstärke + Auge
    feld('passwort').addEventListener('input', () => {
      const p = feld('passwort').value;
      let s = Math.min(p.length, 16) * 4;
      if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s += 12;
      if (/\d/.test(p)) s += 10;
      if (/[^A-Za-z0-9]/.test(p)) s += 14;
      $('staerke').style.width = Math.min(100, s) + '%';
    });
    $('auge').onclick = () => {
      const p = feld('passwort'); const an = p.type === 'password';
      p.type = an ? 'text' : 'password'; $('auge').textContent = an ? t('verbergen') : t('anzeigen');
      $('pw2zeile').hidden = an;
    };
    k.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); einrichten(k); } });
    $('einrichten').onclick = () => einrichten(k);
  };

  function feldFehler(k, felder) {
    k.querySelectorAll('.feldfehler').forEach((e) => e.remove());
    k.querySelectorAll('.fehler').forEach((e) => e.classList.remove('fehler'));
    let erstes = null;
    for (const [name, text] of Object.entries(felder || {})) {
      const el = k.querySelector('[name="' + name + '"]');
      if (!el) continue;
      el.classList.add('fehler');
      const p = document.createElement('p'); p.className = 'feldfehler'; p.textContent = text;
      (el.parentElement.classList.contains('feld') || el.parentElement.classList.contains('pwzeile') ? el.parentElement : el).insertAdjacentElement('afterend', p);
      erstes = erstes || el;
    }
    if (erstes) { if (erstes.closest('details')) erstes.closest('details').open = true; erstes.focus(); }
  }

  async function einrichten(k) {
    const meldung = $('k-meldung'); meldung.hidden = true;
    feldFehler(k, {});
    daten = {};
    k.querySelectorAll('input[name],select[name]').forEach((el) => { daten[el.name] = el.value; });
    Object.assign(daten, { musik_schreiben: musikSchreiben ? '1' : '0', sprache: region.sprache || seitenSprache, land: region.land || '', zeitzone: region.zeitzone || '', zeitformat: region.zeitformat || 'auto', einheiten: region.einheiten || 'auto', datumsformat: region.datumsformat || 'auto', waehrung: region.waehrung || '' });
    const lokal = {};
    for (const [n, bez] of [['vorname', t('Vorname')], ['nachname', t('Nachname')], ['benutzername', t('Benutzername')], ['email', t('E-Mail-Adresse')], ['passwort', t('Passwort')]]) {
      if (!String(daten[n] || '').trim()) lokal[n] = t('{feld} fehlt.', { feld: bez });
    }
    if (!lokal.passwort && daten.passwort !== daten.passwort2 && !$('pw2zeile').hidden) lokal.passwort2 = t('Die Passwörter stimmen nicht überein.');
    if ($('pw2zeile').hidden) daten.passwort2 = daten.passwort;
    if (Object.keys(lokal).length) { feldFehler(k, lokal); meldung.hidden = false; meldung.innerHTML = '<span>⚠️</span><span>' + t('Bitte die markierten Angaben prüfen.') + '</span>'; return; }
    $('einrichten').disabled = true;
    const d = await senden('pruefen', daten);
    $('einrichten').disabled = false;
    if (!d.ok) {
      if (d.zugang === 'fenster') { location.reload(); return; }
      if (d.zugang) { code = ''; seite('code'); return; }
      feldFehler(k, d.felder);
      meldung.hidden = false; meldung.innerHTML = '<span>⚠️</span><span>' + esc(d.fehler || t('Das hat nicht geklappt.')) + '</span>';
      return;
    }
    laufStart = 0;
    seite('lauf');
  }

  // --- Nachholen: Servername speichern, dann Fertig (ohne Datenbank- und Kontoschritte) ---
  SETUP.server = (k) => {
    const feld = k.querySelector('[name="servername"]');
    feld.value = daten.servername != null ? daten.servername : (wurzel.dataset.servername || '');
    const fertig = async () => {
      const meldung = $('s-meldung'); meldung.hidden = true; feldFehler(k, {});
      daten = { servername: feld.value, musik_schreiben: musikSchreiben ? '1' : '0', sprache: region.sprache || seitenSprache, land: region.land || '', zeitzone: region.zeitzone || '', zeitformat: region.zeitformat || 'auto', einheiten: region.einheiten || 'auto', datumsformat: region.datumsformat || 'auto', waehrung: region.waehrung || '' };
      $('s-fertig').disabled = true;
      const d = await senden('nachholen', daten);
      $('s-fertig').disabled = false;
      if (!d.ok) {
        feldFehler(k, d.felder);
        meldung.hidden = false; meldung.innerHTML = '<span>⚠️</span><span>' + esc(d.fehler || t('Das hat nicht geklappt.')) + '</span>';
        return;
      }
      fertigDaten = d;
      seite('fertig');
    };
    k.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); fertig(); } });
    $('s-fertig').onclick = fertig;
  };

  // --- Umzug: Paket hochladen (in Stücken), dann Datenbank anlegen und einspielen ---
  SETUP.umzug = (k) => {
    const los = $('u-los'), meldung = $('u-meldung');
    const fehler = (text) => { meldung.hidden = false; meldung.innerHTML = '<span>⚠️</span><span>' + esc(text) + '</span>'; };
    los.onclick = async () => {
      meldung.hidden = true; feldFehler(k, {});
      const datei = $('u-datei').files[0], pw = $('u-pw').value;
      if (!datei) { fehler(t('Bitte zuerst das Umzugspaket auswählen.')); return; }
      if (pw.length < 8) { feldFehler(k, { paket_passwort: t('Bitte das Passwort des Pakets eingeben.') }); return; }
      los.disabled = true; $('u-fort').hidden = false;
      const STUECK = 8 * 1024 * 1024;
      for (let i = 0, nr = 0; i < datei.size; i += STUECK, nr++) {
        let ok = false;
        for (let versuch = 0; versuch < 3 && !ok; versuch++) {
          try {
            const r = await fetch('/einrichtung.php?schritt=umzug_teil', { method: 'POST', credentials: 'same-origin',
              headers: { 'X-CSRF-Token': csrf, 'X-Teil': String(nr), 'X-Einrichtung-Code': code, 'Content-Type': 'application/octet-stream' }, body: datei.slice(i, i + STUECK) });
            const d = await r.json().catch(() => ({}));
            ok = r.ok && d.ok;
            if (!ok && d.zugang === 'fenster') { location.reload(); return; }
            if (!ok && d.fehler && versuch === 2) fehler(d.fehler);
          } catch (e) { if (versuch === 2) fehler(t('Hochladen unterbrochen – bitte noch einmal versuchen.')); }
        }
        if (!ok) { los.disabled = false; return; }
        const p = Math.min(100, Math.round(((i + STUECK) / datei.size) * 100));
        $('u-bar').style.width = p + '%'; $('u-stand').textContent = t('Hochgeladen: {p} %', { p });
      }
      daten = { umzug: '1', paket_passwort: pw, db_name: 'amberwave', db_user: 'amberwave', db_passwort: wurzel.dataset.dbpw };
      laufStart = 0;
      seite('lauf');
    };
  };

  // --- Einrichten (Serverschritte) ---
  const SCHRITTE_UMZUG = [['db', t('Datenbank und Benutzer anlegen')], ['umzug', t('Paket entschlüsseln und einspielen')], ['abschluss', t('Zugänge absichern')]];
  const SCHRITTE = [['db', t('Datenbank und Benutzer anlegen')], ['tabellen', t('Tabellen erstellen')], ['admin', t('Administrator-Konto anlegen, Zeitzone und Servername speichern')], ['abschluss', t('Zugänge absichern und anmelden')]];
  let laufStart = 0;

  let umzugErgebnis = null;
  const schritte = () => (umzug ? SCHRITTE_UMZUG : SCHRITTE);
  function liste(z) {
    $('l-liste').innerHTML = schritte().map(([, bez], i) => '<li class="' + (z[i] || '') + '"><span class="punkt">' + (z[i] === 'ok' ? '✓' : z[i] === 'nein' ? '!' : '') + '</span>' + esc(bez) + '</li>').join('');
  }

  SETUP.lauf = () => {
    $('l-nochmal').onclick = () => laufen();
    laufen();
  };

  async function laufen() {
    $('l-fehler').hidden = true; $('l-nochmal').hidden = true;
    $('l-titel').textContent = t('Wird eingerichtet …');
    $('l-sub').textContent = t('Das dauert etwa eine halbe Minute. Bitte die Seite offen lassen.');
    const z = schritte().map((_, i) => (i < laufStart ? 'ok' : ''));
    for (; laufStart < schritte().length; laufStart++) {
      z[laufStart] = 'lauf'; liste(z);
      const d = await senden(schritte()[laufStart][0], daten);
      if (!d.ok) {
        if (d.fertig && laufStart < 3) { location.href = '/login.php'; return; }
        if (d.zugang === 'fenster') { location.reload(); return; }
        z[laufStart] = 'nein'; liste(z);
        $('l-titel').textContent = t('Das hat nicht geklappt');
        $('l-sub').textContent = t('Nichts ist verloren – „Nochmal versuchen“ macht an dieser Stelle weiter.');
        $('l-fehler').hidden = false; $('l-fehler-text').textContent = d.fehler || t('Unbekannter Fehler.');
        $('l-nochmal').hidden = false;
        if (d.felder) { $('l-nochmal').textContent = t('Zurück zu den Angaben'); $('l-nochmal').onclick = () => seite(umzug ? 'umzug' : 'konto'); }
        return;
      }
      z[laufStart] = 'ok';
      if (schritte()[laufStart][0] === 'umzug') umzugErgebnis = d;
      if (schritte()[laufStart][0] === 'abschluss') { fertigDaten = d; liste(z); laufStart++; await new Promise((x) => setTimeout(x, 450)); seite('fertig'); return; }
    }
  }

  // --- Fertig ---
  SETUP.fertig = (k) => {
    const d = fertigDaten || {};
    $('f-titel').textContent = d.name ? t('Fertig, {name}!', { name: d.name }) : t('Fertig!');
    $('f-sub').textContent = d.angemeldet ? t('Du bist angemeldet – {app} ist bereit.', { app: appName }) : t('{app} ist bereit – bitte melde dich jetzt an.', { app: appName });
    $('f-db').textContent = t('MariaDB, Benutzer „{user}“', { user: d.db_user || 'amberwave' });
    $('f-konto').innerHTML = t('Konto „{name}“', { name: esc(d.benutzername || daten.benutzername || '') }) + '<small>' + t('Administrator') + '</small>';
    $('f-root').textContent = d.root_abgesichert ? t('Root-Zugang gesperrt') : t('Zugangsdaten aus der .env');
    if (umzug && umzugErgebnis) {
      $('f-titel').textContent = t('Umzug geschafft!');
      $('f-sub').textContent = t('Melde dich jetzt mit deinem bisherigen Konto an.');
      $('f-konto').innerHTML = tn(umzugErgebnis.konten, '1 Konto übernommen', '{n} Konten übernommen') + '<small>' + esc(tn(umzugErgebnis.titel, '1 Titel in der Bibliothek', '{n} Titel in der Bibliothek', { n: fmt(umzugErgebnis.titel) })) + '</small>';
    }
    if (d.nachgeholt) $('f-db').textContent = 'MariaDB';
    const musik = sys && sys.ordner.find((o) => o.schluessel === 'musik');
    const dateien = musik ? musik.dateien || 0 : 0;
    const scan = $('f-scan'), spaeter = $('f-spaeter');
    const bib = d.angemeldet ? '/' : '/login.php';
    spaeter.onclick = () => { location.href = bib; };
    if (dateien > 0 && d.angemeldet) {
      $('zz').dataset.ziel = String(dateien);
      $('f-zahltext').textContent = musik.mehr ? t('Mindestens Titel warten darauf, eingelesen zu werden') : t('Titel warten darauf, eingelesen zu werden');
      $('f-dauer').textContent = t('Einlesen läuft im Hintergrund; du kannst schon stöbern.') + ' ' + tn(Math.max(1, Math.round(dateien / 1200)), '{dateien} Dateien dauern ungefähr eine Minute.', '{dateien} Dateien dauern ungefähr {n} Minuten.', { dateien: fmt(dateien) + (musik.mehr ? '+' : '') });
      scan.onclick = () => seite('scan');
    } else {
      $('f-zahl').hidden = true; scan.hidden = true; spaeter.classList.remove('zweit'); spaeter.textContent = d.angemeldet ? t('Zur Bibliothek') : t('Zur Anmeldung');
      $('f-dauer').textContent = dateien === 0 ? t('Im Musikordner liegen noch keine Dateien. Sobald du welche hinzufügst, liest {app} sie unter Verwaltung › Bibliothek ein.', { app: appName }) : '';
    }
    // Schlüssel
    const knoepfe = [scan, spaeter].filter((e) => !e.hidden);
    if (d.schluessel) {
      $('f-schluesselbox').hidden = false;
      $('f-schluessel').textContent = d.schluessel.replace(/(.{32})/, '$1\n');
      $('f-ort').textContent = d.schluessel_gesichert ? t('Eine Kopie liegt außerdem als app_secret_key.txt in deinen Sicherungen.') : t('Er liegt im App-Daten-Ordner (geheimnisse/). Lege eine Kopie an einen sicheren Ort.');
      const sperren = (an) => knoepfe.forEach((e) => { e.disabled = an; e.classList.toggle('aus', an); });
      sperren(true);
      $('f-haken').onchange = () => sperren(!$('f-haken').checked);
      $('f-kopieren').onclick = async () => {
        try { await navigator.clipboard.writeText(d.schluessel); $('f-kopieren').textContent = t('Kopiert ✓'); } catch (e) {
          const r = document.createRange(); r.selectNodeContents($('f-schluessel')); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
          $('f-kopieren').textContent = t('Markiert – bitte kopieren');
        }
      };
      $('f-datei').onclick = () => {
        const blob = new Blob(['Amberwave APP_SECRET_KEY\n' + d.schluessel + '\n'], { type: 'text/plain' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'amberwave-schluessel.txt'; document.body.appendChild(a); a.click(); a.remove();
        $('f-datei').textContent = t('Gespeichert ✓');
      };
    } else if (!d.nachgeholt) {
      $('f-envschluessel').hidden = false;
    }
    konfetti(k, 2700, 950);
  };

  // ---------- Konfetti + Zähler ----------
  function konfetti(k, zaehlStart, burstStart) {
    const t0 = performance.now() + zaehlStart;
    const ziele = [...b.querySelectorAll('[data-zu],#zz')];
    const lauf = (t) => {
      const p = Math.min(1, Math.max(0, (t - t0) / 1400)); const e = 1 - Math.pow(1 - p, 3);
      ziele.forEach((x) => { const z = parseInt(x.dataset.zu || x.dataset.ziel || '0', 10); x.textContent = fmt(z * e); });
    };
    if (reduz) { ziele.forEach((x) => { x.textContent = fmt(parseInt(x.dataset.zu || x.dataset.ziel || '0', 10)); }); return; }
    const cv = $('konf'); if (!cv) return;
    const cx = cv.getContext('2d'); const dpr = Math.min(2, devicePixelRatio || 1);
    const w = cv.width = k.clientWidth * dpr, h = cv.height = k.clientHeight * dpr;
    const farben = ['#ffc35a', '#ff7a3d', '#ffb547', '#f6efe7', '#5fdca4', '#ff9d5c'];
    const bu = k.querySelector('.buehne'); const ox = w / 2, oy = (bu ? bu.offsetTop + 75 : 90) * dpr; const start = performance.now() + burstStart;
    const ps = [];
    for (let i = 0; i < 110; i++) {
      const a = Math.random() * Math.PI * 2, v = (4 + Math.random() * 9) * dpr;
      ps.push({ x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 5 * dpr, r: (3 + Math.random() * 4) * dpr, rot: Math.random() * 6, vr: (Math.random() - .5) * .4, c: farben[i % farben.length], f: Math.random() < .4, l: 1 });
    }
    const bild = (t) => {
      lauf(t);
      cx.clearRect(0, 0, w, h);
      if (t > start) {
        let leb = 0;
        for (const p of ps) {
          p.vy += .28 * dpr; p.vx *= .985; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.l -= .0065;
          if (p.l <= 0) continue; leb++;
          cx.save(); cx.globalAlpha = Math.min(1, p.l * 2); cx.translate(p.x, p.y); cx.rotate(p.rot); cx.fillStyle = p.c;
          if (p.f) cx.fillRect(-p.r, -p.r / 3, p.r * 2, p.r * .7); else { cx.beginPath(); cx.arc(0, 0, p.r * .6, 0, 7); cx.fill(); }
          cx.restore();
        }
        if (!leb && t > t0 + 1500) { lauf(t0 + 2000); return; }
      }
      anim = requestAnimationFrame(bild);
    };
    anim = requestAnimationFrame(bild);
  }

  // ---------- Erstes Einlesen ----------
  function cover(i, url) {
    const h = (i * 47 + 20) % 360, h2 = (h + 40) % 360;
    const d = document.createElement('div'); d.className = 'cov';
    d.style.background = 'linear-gradient(135deg,hsl(' + h + ' 62% 46%),hsl(' + h2 + ' 58% 26%))';
    d.innerHTML = '<svg viewBox="0 0 64 64"><g fill="#fff"><rect x="11" y="27" width="5" height="10" rx="2.5"/><rect x="19.5" y="20" width="5" height="24" rx="2.5"/><rect x="28" y="13" width="5" height="38" rx="2.5"/><rect x="36.5" y="22" width="5" height="20" rx="2.5"/><rect x="45" y="17" width="5" height="30" rx="2.5"/></g></svg>';
    if (url) {
      const img = new Image(); img.alt = ''; img.loading = 'lazy';
      img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1';
      img.onload = () => { d.querySelector('svg').remove(); };
      img.onerror = () => img.remove();
      img.src = url; d.appendChild(img);
    }
    return d;
  }

  SETUP.scan = (k) => {
    const sp = $('spek');
    for (let i = 0; i < 26; i++) { const e = document.createElement('i'); e.style.setProperty('--dur', (.6 + Math.random() * .9) + 's'); e.style.animationDelay = (-Math.random()) + 's'; sp.appendChild(e); }
    const wand = $('wand');
    let n = 0, erst = false, beendet = false, fehlerZaehler = 0;
    const raus = () => { try { sessionStorage.setItem('aw_einlesen', '1'); } catch (e) { /* egal */ } location.href = '/'; };
    $('sc-bib').onclick = raus;
    $('sc-hinten').onclick = raus;
    const zeigen = (s) => {
      const p = s.prozent || 0;
      $('sc-bar').style.width = p + '%';
      $('sc-text').textContent = s.gesamt > 0 ? t('{p} % · {a} von {b} Dateien', { p, a: fmt(s.geprueft), b: fmt(s.gesamt) }) : t('Zähle Dateien …');
      $('z-t').textContent = fmt(s.titel); $('z-a').textContent = fmt(s.alben); $('z-k').textContent = fmt(s.kuenstler);
      sp.style.setProperty('--p', Math.min(1, p / 100 * 1.4 + (s.alben > 0 ? .15 : 0)));
      while (n < Math.min(s.alben, 90)) { wand.prepend(cover(n, (s.covers || [])[Math.min(n, (s.covers || []).length - 1)] || null)); n++; if (wand.children.length > 60) wand.lastChild.remove(); }
      if (s.alben > 0 && !erst) {
        erst = true;
        $('erstes').innerHTML = '<div class="erstes"><div class="cov" style="background:linear-gradient(135deg,hsl(20 62% 46%),hsl(60 58% 26%))"></div><span>' + t('<b>Das erste Album ist da.</b><br>Du kannst schon reinhören – der Rest kommt von allein dazu.') + '</span></div>';
        $('sc-bib').disabled = false; $('sc-bib').classList.remove('aus');
      }
    };
    const abfragen = async () => {
      if (beendet) return;
      const s = await senden('scan_status');
      if (!s.ok) {
        if (++fehlerZaehler > 5) { $('sc-fehler').hidden = false; $('sc-fehler-text').textContent = s.fehler || t('Der Fortschritt lässt sich nicht abfragen. Das Einlesen läuft trotzdem weiter.'); }
        return;
      }
      fehlerZaehler = 0;
      zeigen(s);
      if (s.fertig && !s.laeuft) {
        beendet = true; stoppen();
        $('sc-titel').textContent = t('Fertig eingelesen!');
        setTimeout(() => { if (aktuell === 'scan') seite('scanfertig'); }, 1200);
      } else if (s.fehler && !s.laeuft) {
        beendet = true; stoppen();
        $('sc-titel').textContent = t('Das Einlesen wurde unterbrochen');
        $('sc-fehler').hidden = false; $('sc-fehler-text').textContent = t('{meldung} Du kannst es unter Verwaltung › Bibliothek erneut starten.', { meldung: s.meldung || t('Unbekannter Fehler.') });
        $('sc-bib').disabled = false; $('sc-bib').classList.remove('aus');
      }
    };
    (async () => {
      const st = wurzel.dataset.start === 'scan' ? { ok: true } : await senden('scan_start');
      if (!st.ok) { $('sc-fehler').hidden = false; $('sc-fehler-text').textContent = st.fehler || t('Das Einlesen ließ sich nicht starten.'); $('sc-bib').disabled = false; $('sc-bib').classList.remove('aus'); return; }
      abfragen();
      timer = setInterval(abfragen, 1000);
    })();
  };

  function dauerText(ms) {
    const min = Math.round(ms / 60000);
    const tage = Math.floor(min / 1440), std = Math.floor((min % 1440) / 60);
    const bez = t('Spielzeit am Stück');
    if (tage >= 1) return { b: tn(tage, '1 Tag', '{n} Tage') + (std ? ' ' + t('{n} Std.', { n: std }) : ''), t: bez };
    if (std >= 1) return { b: t('{h} Std. {m} Min.', { h: std, m: min % 60 }), t: bez };
    return { b: t('{n} Min.', { n: min }), t: bez };
  }

  SETUP.scanfertig = (k) => {
    try { sessionStorage.removeItem('aw_einlesen'); } catch (e) { /* egal */ }
    $('sf-bib').onclick = () => { location.href = '/'; };
    $('sf-aufraeumen').onclick = () => { location.href = '/verwaltung'; };
    (async () => {
      const s = await senden('zusammenfassung');
      if (!s.ok) { location.href = '/'; return; }
      const dz = dauerText(s.spielzeit_ms || 0);
      const kacheln = [
        ['<b data-zu="' + s.titel + '">0</b>', t('Titel{pl}', { pl: '' })], ['<b data-zu="' + s.alben + '">0</b>', t('Alben')], ['<b data-zu="' + s.kuenstler + '">0</b>', t('Künstler{pl}', { pl: '' })],
        ['<b>' + esc(dz.b) + '</b>', dz.t], ['<b>' + (s.aeltestes || '–') + '</b>', t('ältestes Album')], ['<b>' + (s.neuestes || '–') + '</b>', t('neuestes Album')],
      ];
      $('sf-kacheln').innerHTML = kacheln.map((c, i) => '<div class="ani" style="--d:' + (.6 + i * .1) + 's">' + c[0] + '<span>' + c[1] + '</span></div>').join('');
      const maxN = Math.max(1, ...(s.top || []).map((t) => t.n));
      $('sf-top').innerHTML = (s.top && s.top.length)
        ? '<h2>' + t('Die meisten Titel in deiner Sammlung') + '</h2><div class="balken">' + s.top.map((t, i) => '<div><span>' + esc(t.name) + '</span><i style="--w:' + Math.round(t.n / maxN * 100) + '%;--d:' + (1.8 + i * .15) + 's"></i><em>' + t.n + '</em></div>').join('') + '</div>' : '';
      $('sf-hinweis').innerHTML = s.fehler_anzahl > 0
        ? '<div class="hinweis gelb" style="margin-top:30px"><span>🧹</span><span><b>' + tn(s.fehler_anzahl, '1 Datei braucht einen Blick', '{n} Dateien brauchen einen Blick') + '</b>' + t('Fehlende Tags, Cover oder unlesbare Dateien. Du findest sie unter Verwaltung › Bibliothek – nichts davon eilt.') + '</span></div>'
        : '<div class="hinweis gruen" style="margin-top:30px"><span>✅</span><span><b>' + t('Alles sauber eingelesen') + '</b>' + t('Keine Datei hat Probleme gemacht.') + '</span></div>';
      konfetti(k, 600, 300);
    })();
  };

  // ---------- Start ----------
  let weiter = '';
  try { weiter = sessionStorage.getItem('awWeiter') || ''; sessionStorage.removeItem('awWeiter'); } catch (e) { /* egal */ }
  seite(wurzel.dataset.start || (weiter === 'region' ? 'region' : 'start'));
})();
