// Einstellungen: eine Stelle für alles, was man einmal festlegt.
// Links die Bereiche (Persönlich für jedes Konto, Server nur für Admins), rechts je Einstellung eine Zeile:
// Name und kurze Erklärung links, Regler rechts. Persönliches wirkt sofort; Serverwerte sammeln sich in einer Leiste unten
// („2 Änderungen · Verwerfen · Speichern“) – auch über mehrere Bereiche hinweg. Am Handy: erst die Liste, dann der Bereich.
import { api, versuche } from './api.js';
import { h, icon, toast, dialog, bestaetigen, datum, datumZeit, groesse, initialen } from './ui.js';
import { t, tn, zahl, locale } from './i18n.js';
import { QUALITAETEN, LAUTHEIT_ZIELE } from './player.js';
import { LueckenlosMotor } from './lueckenlos.js';
import { exportListe } from './export.js';
import { nativ } from './nativ.js';
import { netzweg } from './netzweg.js';
import { direktEinrichten, tunnelEinrichten, lautheitPanel, raeumePanel, sicherungWiederherstellen } from './verwaltung.js';
import { symbolSvg, symbolVon, ausgangName, ausgangUnter, layoutKurz } from './ausgaenge.js';
import { ausgaengeFenster } from './ausgaenge_fenster.js';
import { heimnetzZeichnen } from './heimnetz.js';
import { falzStatus, falzBericht, falzWahl, falzWahlSetzen } from './falz.js';
import { vstKarte } from './vstbrowser.js';
import { downloadAnbieterPanel } from './dl_anbieter.js';

const BEREICHE = [
  { id: 'konto', gruppe: 'persoenlich', titel: t('Konto'), icon: 'profil', text: t('Name, Bild, Passwort und die Geräte, auf denen du angemeldet bist.') },
  { id: 'wiedergabe', gruppe: 'persoenlich', titel: t('Wiedergabe'), icon: 'play', text: '' },
  { id: 'ausgabe', gruppe: 'persoenlich', titel: t('Windows-Ausgabe'), icon: 'computer', zusatz: t('dieser PC'), text: t('Nur im Windows Client · gilt für diesen PC.') },
  { id: 'bibliothek', gruppe: 'server', titel: t('Bibliothek & Automatik'), icon: 'alben', text: t('Wann Amberwave selbst einliest, abgleicht und misst. Von Hand ausführen geht weiter unter Verwaltung › Bibliothek.') },
  { id: 'dienste', gruppe: 'server', titel: t('Dienste & Schlüssel'), icon: 'schluessel', text: t('Zugänge zu Diensten für Metadaten, Bilder und Übersetzungen. Schlüssel werden verschlüsselt gespeichert und nie wieder angezeigt.') },
  { id: 'downloads', gruppe: 'server', titel: t('Downloads'), icon: 'download', text: t('Prowlarr oder Newznab-Indexer suchen, SABnzbd lädt, Amberwave übernimmt das Fertige in die Bibliothek.') },
  { id: 'mail', gruppe: 'server', titel: t('E-Mail'), icon: 'mail', text: t('Für Freischaltungen, Ablauf-Erinnerungen und „Passwort vergessen“.') },
  { id: 'zugang', gruppe: 'server', titel: t('Zugang & Netz'), icon: 'start', text: t('Wie Geräte den Server erreichen – zuhause und unterwegs.') },
  { id: 'heimnetz', gruppe: 'server', titel: t('Geräte im Heimnetz'), icon: 'anlage', text: t('AV-Receiver, Fernseher und Streamer, die per DLNA abspielen. Sie erscheinen unter „Wiedergabe auf“ – Ein, Eingang und Lautstärke steuert Amberwave bei Denon/Marantz, Yamaha und Onkyo/Pioneer selbst.') },
  { id: 'raeume', gruppe: 'server', titel: t('Räume'), icon: 'surround', text: t('Impulsantworten für den Hall im Raumklang. Sie liegen auf dem Server und gelten für alle.') },
  { id: 'system', gruppe: 'server', titel: t('System & Ordner'), icon: 'anlage', text: t('Was Amberwave beim Start festgelegt hat – Benutzer, Ordner, Datenbank – und woher jeder Wert kommt. Geändert wird in der .env, danach den Stack neu starten.') },
  { id: 'sicherung', gruppe: 'server', titel: t('Sicherung & Update'), icon: 'schild', text: t('Gesichert werden Datenbank und Einstellungen. Musik, Cover und .env werden nie angefasst.') },
];
const bereichVon = (id) => BEREICHE.find((b) => b.id === id);
const GERAETE_SICHTBAR = 6;
const AUFSCHLAG_STUFEN = [[0, t('Keine')], [100, '100 ms'], [250, t('250 ms (Standard)')], [500, '500 ms'], [750, '750 ms'], [1000, '1 s'], [1500, `${zahl(1.5)} s`], [2000, '2 s'], [2500, `${zahl(2.5)} s`], [3000, '3 s'], [4000, '4 s'], [5000, '5 s']];

// ---------- Serverwerte: Beschreibung je Schlüssel (Bereich, Karte, Regler) ----------
const an1 = (w) => w === '1';
const nicht0 = (w) => w !== '0';
const STUNDEN = (aus = t('Aus')) => [['-1', aus], ...Array.from({ length: 24 }, (_, i) => [String(i), `${String(i).padStart(2, '0')}:00`])];
const SERVER = {
  bibliothek: [
    { karte: t('Musikordner'), hinweis: t('Aus: Amberwave liest deine Sammlung nur. Tags schreiben, Aufräumen, Download-Import, „Aus anderem Album übernehmen“ und der Papierkorb sind dann gesperrt. Für einen harten Schutz zusätzlich MUSIK_MOUNT_MODUS=ro in der .env.'), felder: [
      { k: 'musik_schreiben', name: t('Amberwave darf im Musikordner schreiben'), hinweis: t('Neu eingerichtet: aus. Vorher eine Sicherung deiner Sammlung ist eine gute Idee.'), typ: 'schalter', an: an1 },
    ] },
    { karte: t('Einlesen'), felder: [
      { k: 'scan_auto_stunden', name: t('Automatisch einlesen alle'), hinweis: t('0 heißt nur von Hand.'), typ: 'zahl', einheit: t('Stunden'), min: 0, max: 720 },
      { k: 'nachtlauf_stunde', name: t('Nachtlauf'), hinweis: t('Dieselbe Kette einmal täglich, fängt Liegengebliebenes auf.'), typ: 'auswahl', optionen: STUNDEN() },
    ] },
    { karte: t('Erkennung'), hinweis: t('Amberwave ordnet Alben zuerst über ihre Tags zu (Interpret, Titel, MusicBrainz-ID, Titelzahl und Laufzeiten) – das fragt AcoustID nicht. Der Klang kommt nur zum Einsatz, wo es keinen Anhaltspunkt gibt.'), felder: [
      { k: 'erkennung_modus', name: t('Am Klang erkennen (AcoustID)'), hinweis: t('Standard: nur bei Alben ohne brauchbare Tags. Alles Unsichere wartet auf deinen Knopf unter Verwaltung › Bibliothek. „Gründlich“ fragt den Klang auch dann, wenn die Tags nicht gereicht haben – mehr Anfragen an AcoustID.'), typ: 'auswahl', optionen: [['anhalt', t('Nur ohne Anhaltspunkt (Standard)')], ['gruendlich', t('Gründlich – auch wenn die Tags nicht reichen')]] },
    ] },
    { karte: t('Nach dem Einlesen'), hinweis: t('Läuft der Reihe nach, sobald etwas neu oder geändert war: erst die Erkennung am Klang, dann diese Schritte. Von Hand angehaltene Aufträge werden nicht überstimmt.'), felder: [
      { k: 'auto_metadaten', name: t('Metadaten vervollständigen'), hinweis: t('Alben, Künstler und Künstlerbilder von MusicBrainz und fanart.tv.'), typ: 'schalter', an: nicht0 },
      { k: 'auto_vorschau', name: t('Aufräum-Vorschau berechnen'), hinweis: t('Nur Vorschau – umbenannt wird erst nach deiner Freigabe.'), typ: 'schalter', an: nicht0 },
      { k: 'klang_aktiv', name: t('Klanganalyse im Hintergrund'), hinweis: t('Für Klangradio und als Signal im Radio.'), typ: 'schalter', an: nicht0 },
    ] },
    { karte: t('Namen in den Dateien'), felder: [
      { k: 'kuenstler_standardnamen', name: t('Standardnamen statt stilisierter Schreibweisen'), hinweis: t('Beim Aufräumen in Tags und Ordnern, z. B. „JAŸ-Z“ → „JAY-Z“. Nachteil: auch gewollte wie „P!nk“ werden vereinheitlicht. In Amberwave bleibt die Schreibweise wie bei MusicBrainz.'), typ: 'schalter', an: an1 },
    ] },
  ],
  dienste: [
    { karte: t('Metadaten'), felder: [
      { k: 'musicbrainz_user_agent', name: t('MusicBrainz-Kennung'), hinweis: t('Nur für MusicBrainz, ersetzt die gemeinsame Amberwave-Kennung (siehe „Anfragen an Dienste“). Normalerweise leer lassen.'), typ: 'text', platzhalter: t('Amberwave/0.2 ( deine Adresse )'), breit: true },
      { k: 'fanart_api_key', name: 'fanart.tv', hinweis: t('Künstlerbilder.'), typ: 'geheim' },
      { k: 'acoustid_api_key', name: 'AcoustID', hinweis: t('Alben am Klang erkennen. Kostenlos: acoustid.org → „Register an application“.'), typ: 'geheim' },
    ] },
    { karte: t('Weitere'), felder: [
      { k: 'claude_api_key', name: 'Claude', hinweis: t('Übersetzt Albumbeschreibungen ins Deutsche.'), typ: 'geheim' },
      { k: 'lidarr_url', name: t('Lidarr-Adresse'), typ: 'url', platzhalter: 'http://192.168.1.10:8686' },
      { k: 'lidarr_api_key', name: t('Lidarr API-Schlüssel'), typ: 'geheim' },
    ] },
  ],
  downloads: [
    { karte: t('Usenet-Downloads'), hinweis: t('Suche bei Indexern und Laden über SABnzbd. Aus: kein Downloads-Bereich, keine Suche, nichts wird geholt. Du bist selbst dafür verantwortlich, was du lädst.'), felder: [
      { k: 'usenet_aktiv', name: t('Usenet-Downloads verwenden'), typ: 'schalter', an: an1 },
    ] },
    { karte: t('Nach dem Laden'), felder: [
      { k: 'download_ziel', name: t('Zielordner im Musikordner'), typ: 'text', platzhalter: 'Downloads' },
      { k: 'download_einsortieren', name: t('Abgeglichene Alben einsortieren'), hinweis: t('Nach Schema /Künstler/Jahr - Album. Aus: alles bleibt im Zielordner, bis du es unter „Dateien aufräumen“ freigibst. Nicht erkannte Alben bleiben immer liegen.'), typ: 'schalter', an: nicht0 },
      { k: 'download_wav_flac', name: t('WAV und AIFF als FLAC übernehmen'), hinweis: t('Verlustfrei, per Prüfsumme kontrolliert – kleiner und vollständig taggbar.'), typ: 'schalter', an: nicht0 },
      { k: 'download_nach_import', name: t('Original im Download-Ordner löschen'), hinweis: t('Erst nach geprüfter Kopie.'), typ: 'schalter', an: (w) => w !== 'behalten', werte: ['loeschen', 'behalten'] },
    ] },
    { karte: t('Wächter & Anzeige'), hinweis: t('Ändert sich ein Download in SABnzbd so lange gar nicht, gilt er als gescheitert. Stand er schon bei 100 %, schaut Amberwave im Download-Ordner nach und übernimmt, was da ist. Pausen und Warten in der Schlange zählen nicht.'), felder: [
      { k: 'download_haengt_min', name: t('Hängt – abbrechen nach'), typ: 'zahl', einheit: t('min'), min: 5, max: 1440 },
      { k: 'download_weg_min', name: t('Verschwunden – aufgeben nach'), typ: 'zahl', einheit: t('min'), min: 5, max: 1440 },
      { k: 'download_reiter', name: t('Eigener Punkt im Hauptmenü'), hinweis: t('Neben Playlists (am Handy unter „Mehr“), mit der Zahl der laufenden Downloads. Nur für Admins.'), typ: 'schalter', an: an1 },
    ] },
  ],
  mail: [
    { karte: t('Server'), test: 'mail', hinweis: t('Bei web.de: smtp.web.de, Port 587, STARTTLS – in web.de „POP3/IMAP/SMTP“ erlauben.'), felder: [
      { k: 'smtp_host', name: t('Server'), typ: 'text', platzhalter: 'smtp.example.de' },
      { k: 'smtp_port', name: 'Port', typ: 'zahl', min: 1, max: 65535 },
      { k: 'smtp_verschluesselung', name: t('Verschlüsselung'), typ: 'segment', optionen: [['tls', 'STARTTLS'], ['ssl', 'SSL/TLS'], ['keine', t('Keine')]] },
      { k: 'smtp_benutzer', name: t('Benutzername'), typ: 'text' },
      { k: 'smtp_passwort', name: t('Passwort'), typ: 'geheim' },
      { k: 'smtp_tls_pruefen', name: t('Zertifikat prüfen'), hinweis: t('Nur für Server im eigenen Netz abschalten.'), typ: 'schalter', an: nicht0 },
    ] },
    { karte: t('Absender und Erinnerungen'), felder: [
      { k: 'smtp_absender', name: t('Absender-Adresse'), typ: 'email', platzhalter: 'musik@example.de' },
      { k: 'smtp_absender_name', name: t('Absender-Name'), typ: 'text' },
      { k: 'mail_ablauf_tage', name: t('Ablauf-Erinnerung'), hinweis: t('So viele Tage, bevor ein Konto abläuft.'), typ: 'zahl', einheit: t('Tage vorher'), min: 1, max: 120 },
    ] },
  ],
  sicherung: [
    { karte: t('Updates'), felder: [
      { k: 'update_hinweis', name: t('Auf neue Versionen hinweisen'), hinweis: t('Schaut zweimal täglich bei GitHub nach, ob es eine neuere Version gibt, und zeigt sie in der Verwaltung an. Lädt und installiert nichts.'), typ: 'schalter', an: nicht0 },
    ] },
    { karte: t('Zeitplan'), felder: [
      { k: 'sicherung_stunde', name: t('Täglich sichern um'), hinweis: t('Von Hand angelegte Sicherungen bleiben, bis du sie löschst.'), typ: 'auswahl', optionen: STUNDEN(t('Aus – keine nächtliche Sicherung')) },
      { k: 'sicherung_tage', name: t('Tägliche Sicherungen behalten'), typ: 'zahl', einheit: t('Tage'), min: 1, max: 365 },
      { k: 'sicherung_wochen', name: t('Wöchentliche Sicherungen behalten'), hinweis: t('Zusätzlich je Woche eine. Überzähliges entfernt die nächste Sicherung.'), typ: 'zahl', einheit: t('Wochen'), min: 0, max: 104 },
    ] },
  ],
};
const FELD = {};
for (const [b, karten] of Object.entries(SERVER)) for (const k of karten) for (const f of k.felder) FELD[f.k] = { ...f, bereich: b };

// Persönliches für die Suche (Server-Felder kommen aus SERVER)
const SUCHE_PERSOENLICH = [
  ['konto', 'bild', t('Profilbild'), t('foto avatar')], ['konto', 'name', t('Name'), t('vorname nachname')], ['konto', 'passwort', t('Passwort ändern'), t('kennwort')],
  ['konto', 'mail_info', t('E-Mails zu meinem Konto'), t('erinnerung ablauf')], ['konto', 'sprache', 'Sprache / Language', 'language sprache deutsch english englisch german'], ['konto', 'geraete', t('Angemeldete Geräte'), t('abmelden umbenennen gerätename')],
  ['wiedergabe', 'qualitaet_heim', t('Qualität zuhause'), t('original flac opus heimnetz')], ['wiedergabe', 'qualitaet_unterwegs', t('Qualität unterwegs'), t('opus mobilfunk datensparen')],
  ['wiedergabe', 'lueckenlos', t('Lückenlose Wiedergabe'), t('gapless pause')], ['wiedergabe', 'lautheit', t('Lautstärke angleichen'), t('ebu r128 replaygain lufs normalisieren')],
  ['wiedergabe', 'lautheit_ziel', t('Zielwert Lautheit'), t('lufs')], ['wiedergabe', 'pegel', t('Pegelanzeige im Player'), t('meter dbfs')],
  ['wiedergabe', 'klang', t('Raumklang und Effekte'), t('upmix space hall glow iron silk eq rack')],
  ['ausgabe', 'geraet', t('Ausgabegerät'), t('asio wasapi soundkarte interface')], ['ausgabe', 'modus', t('Exklusiv oder geteilt'), t('bitgenau wasapi')],
  ['ausgabe', 'rate', t('Abtastrate am Gerät'), t('samplerate khz')], ['ausgabe', 'aufschlag', t('Pause nach dem Umschalten'), t('ratenwechsel anlauf')],
  ['bibliothek', 'lautheit_analyse', t('Lautheitsanalyse'), t('ebu r128 messen')], ['zugang', 'direkt', t('Direktzugang im Heimnetz'), t('cloudflare zertifikat lets encrypt dns')], ['zugang', 'tunnel', t('Cloudflare Tunnel'), t('unterwegs cloudflared von außen erreichbar')],
  ['zugang', 'apps', t('Für Apps'), t('token api windows')], ['downloads', 'suchanbieter', t('Suchanbieter'), t('prowlarr newznab indexer usenet suche')], ['downloads', 'downloadclients', t('Downloadclients'), t('sabnzbd nzb client kategorie import ordner')], ['raeume', 'raeume', t('Impulsantworten'), t('hall voxengo ir')],
  ['heimnetz', 'geraete', t('Geräte im Heimnetz'), t('dlna upnp receiver avr denon marantz yamaha onkyo pioneer fernseher tv streamer')],
  ['system', 'festgelegt', t('Was Amberwave festgelegt hat'), t('benutzer puid pgid ordner pfad appdata datenbank zeitzone schluessel')], ['sicherung', 'liste', t('Vorhandene Sicherungen'), t('backup wiederherstellen')], ['sicherung', 'update', t('Update einspielen'), t('version zip')],
];

// ---------- Zustand über Bereichswechsel hinweg ----------
const offen = new Map();     // Schlüssel → neuer Wert (null = auf .env/Standard zurücksetzen)
const entsperrt = new Set(); // .env-Werte, die man in der App überschreiben will
let springen = null;         // Zeile, zu der nach dem Zeichnen gesprungen wird (aus der Suche)
let serverStand = null;      // letzte Antwort von /admin/einstellungen

// ---------- Bausteine ----------
const schalter = (an, attr = '') => `<button type="button" class="schalter" role="switch" aria-checked="${an ? 'true' : 'false'}" ${attr}></button>`;
const segment = (optionen, wert, attr = '') => `<div class="segment" role="radiogroup" ${attr}>${optionen.map(([w, tx]) => `<button type="button" role="radio" data-w="${h(w)}" aria-checked="${String(w) === String(wert)}">${h(tx)}</button>`).join('')}</div>`;
const zeile = (k, name, hinweis, regler, extra = '') => `<div class="einst-zeile" data-k="${h(k)}" ${extra}><div class="einst-text"><span class="einst-name">${name}</span>${hinweis ? `<p>${hinweis}</p>` : ''}</div><div class="einst-regler">${regler}</div></div>`;
const karte = (titel, inhalt, rechts = '', attr = '') => `<div class="einst-karte" ${attr}>${titel ? `<h2><span>${h(titel)}</span>${rechts}</h2>` : ''}${inhalt}</div>`;
const chip = (text, art = '') => `<span class="einst-chip ${art}">${h(text)}</span>`;

function herkunft(k) {
  const x = serverStand?.einstellungen?.[k];
  if (offen.has(k)) return `<span class="herkunft geaendert">${offen.get(k) === null ? t('wird zurückgesetzt') : t('geändert')}</span>`;
  if (!x) return '';
  if (x.quelle === 'db') return `<span class="herkunft">${t('in der App')}</span><button type="button" class="herkunft-knopf" data-zuruecksetzen="${h(k)}" title="${h(x.env ? t('Auf den Wert aus der .env ({env}) bzw. den Standard zurücksetzen', { env: x.env }) : t('Auf den Standard zurücksetzen'))}">${t('zurücksetzen')}</button>`;
  if (x.quelle === 'env' && !entsperrt.has(k)) return `<span class="herkunft env" title="${h(x.env)}">${icon('schild', 11)}${t('aus der .env')}</span><button type="button" class="herkunft-knopf" data-entsperren="${h(k)}">${t('In der App festlegen')}</button>`;
  if (x.quelle === 'env') return `<span class="herkunft geaendert">${t('wird in der App festgelegt')}</span>`;
  if (x.quelle === 'standard') return `<span class="herkunft">${t('Standard')}</span>`;
  return `<span class="herkunft">${t('nicht gesetzt')}</span>`;
}

function serverWert(k) {
  if (offen.has(k) && offen.get(k) !== null) return offen.get(k);
  return serverStand?.einstellungen?.[k]?.wert ?? '';
}

function serverFeld(f) {
  const x = serverStand?.einstellungen?.[f.k] || {};
  const gesperrt = x.quelle === 'env' && !entsperrt.has(f.k) && !offen.has(f.k);
  const w = serverWert(f.k);
  const dis = gesperrt ? 'disabled' : '';
  const id = `es-${f.k}`;
  let regler;
  if (f.typ === 'schalter') regler = schalter(f.an(w), `data-s="${f.k}" aria-label="${h(f.name)}" ${dis}`);
  else if (f.typ === 'segment') regler = segment(f.optionen, w || f.optionen[0][0], `data-s="${f.k}" aria-label="${h(f.name)}" ${gesperrt ? 'data-gesperrt' : ''}`);
  else if (f.typ === 'auswahl') regler = `<select id="${id}" class="einst-feld" data-s="${f.k}" ${dis}>${f.optionen.map(([v, tx]) => `<option value="${h(v)}" ${String(v) === String(w) ? 'selected' : ''}>${h(tx)}</option>`).join('')}</select>`;
  else if (f.typ === 'zahl') regler = `<input id="${id}" class="einst-feld zahl" type="number" inputmode="numeric" data-s="${f.k}" value="${h(w)}" ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''} ${dis}>${f.einheit ? `<span class="einheit">${h(f.einheit)}</span>` : ''}`;
  else if (f.typ === 'geheim') regler = `<input id="${id}" class="einst-feld" type="password" autocomplete="new-password" data-s="${f.k}" value="${offen.has(f.k) && offen.get(f.k) ? h(offen.get(f.k)) : ''}" placeholder="${h(x.gesetzt ? t('•••••••• gesetzt – leer lassen = unverändert') : t('Schlüssel eintragen'))}" ${dis}>`;
  else regler = `<input id="${id}" class="einst-feld" type="${f.typ === 'url' ? 'url' : f.typ === 'email' ? 'email' : 'text'}" data-s="${f.k}" value="${h(w)}" placeholder="${h(f.platzhalter || '')}" ${dis}>`;
  const breit = ['text', 'url', 'email', 'geheim', 'auswahl'].includes(f.typ);
  const name = ['schalter', 'segment'].includes(f.typ) ? h(f.name) : `<label for="${id}">${h(f.name)}</label>`;
  return `<div class="einst-zeile" data-k="${f.k}"><div class="einst-text"><span class="einst-name">${name}<span class="herkunft-box">${herkunft(f.k)}</span></span>${f.hinweis ? `<p>${h(f.hinweis)}</p>` : ''}</div><div class="einst-regler${breit ? ' breit' : ''}">${regler}</div></div>`;
}

function serverKarten(bereich, extraKopf = {}, auswahl = null) {
  return (SERVER[bereich] || []).filter((k, i) => !auswahl || auswahl(k, i)).map((k) => {
    const rechts = k.test ? `<button type="button" class="btn btn-zweit btn-klein" data-test="${k.test}">${k.test === 'mail' ? t('Testmail senden') : t('Verbindung testen')}</button>` : (extraKopf[k.karte] || '');
    return karte(k.karte, (k.hinweis ? `<p class="einst-karten-hinweis">${h(k.hinweis)}</p>` : '') + k.felder.map(serverFeld).join('') + (k.test ? '<pre class="log einst-log" data-test-log hidden></pre>' : ''), rechts);
  }).join('');
}

// ---------- Speicherleiste ----------
function leisteZeichnen(app) {
  let l = document.querySelector('[data-einst-leiste]');
  const n = offen.size;
  document.body.classList.toggle('einst-ungespeichert', n > 0);
  if (!n) { l?.remove(); markierungen(); return; }
  if (!l) {
    l = document.createElement('div');
    l.className = 'einst-leiste';
    l.setAttribute('data-einst-leiste', '');
    l.setAttribute('role', 'region');
    l.setAttribute('aria-label', t('Ungespeicherte Änderungen'));
    document.body.appendChild(l);
  }
  const bereiche = [...new Set([...offen.keys()].map((k) => FELD[k]?.bereich).filter(Boolean))].map((b) => bereichVon(b).titel);
  l.innerHTML = `<div class="einst-leiste-text"><b>${tn(n, '{n} Änderung nicht gespeichert', '{n} Änderungen nicht gespeichert')}</b><small>${h(bereiche.join(' · '))}</small></div>
    <button type="button" class="btn btn-zweit" data-verwerfen>${t('Verwerfen')}</button><button type="button" class="btn" data-speichern>${t('Speichern')}</button>`;
  l.querySelector('[data-verwerfen]').addEventListener('click', () => { offen.clear(); entsperrt.clear(); leisteZeichnen(app); neuZeichnen(app); toast(t('Änderungen verworfen')); });
  l.querySelector('[data-speichern]').addEventListener('click', () => speichern(app));
  markierungen();
}

function markierungen() {
  const bereiche = new Set([...offen.keys()].map((k) => FELD[k]?.bereich));
  document.querySelectorAll('.einst-punkt[data-b]').forEach((a) => a.classList.toggle('ungespeichert', bereiche.has(a.dataset.b)));
}

async function speichern(app) {
  const werte = Object.fromEntries(offen);
  const n = offen.size;
  const knopf = document.querySelector('[data-einst-leiste] [data-speichern]');
  if (knopf) knopf.disabled = true;
  const r = await versuche(() => api.put('/admin/einstellungen', { einstellungen: werte }));
  if (knopf) knopf.disabled = false;
  if (!r) return;
  const dl = Object.keys(werte).some((k) => k.startsWith('download_') || k.startsWith('prowlarr') || k.startsWith('sabnzbd') || k === 'usenet_aktiv' || k === 'musik_schreiben');
  offen.clear(); entsperrt.clear();
  leisteZeichnen(app);
  toast(tn(n, '{n} Einstellung gespeichert', '{n} Einstellungen gespeichert'), 'gut');
  if (dl) app.zaehlerAktualisieren(); // Menüpunkt „Downloads“ ein-/ausblenden
  neuZeichnen(app);
}

function neuZeichnen(app) {
  if (location.pathname.startsWith('/einstellungen')) app.navigieren(location.pathname, false, true);
}

/** Regler eines Server-Bereichs: Änderungen sammeln, Herkunft mitziehen */
function serverVerbinden(app, ziel) {
  const merken = (k, w) => {
    const x = serverStand?.einstellungen?.[k] || {};
    if (FELD[k]?.typ === 'geheim') { if (w === '') offen.delete(k); else offen.set(k, w); }
    else if (String(w) === String(x.wert ?? '') && !(x.quelle === 'env' && entsperrt.has(k))) offen.delete(k);
    else offen.set(k, w);
    const box = ziel.querySelector(`.einst-zeile[data-k="${k}"] .herkunft-box`);
    if (box) { box.innerHTML = herkunft(k); herkunftVerbinden(app, box); }
    leisteZeichnen(app);
  };
  ziel.querySelectorAll('.schalter[data-s]').forEach((b) => b.addEventListener('click', () => {
    if (b.disabled) return;
    const f = FELD[b.dataset.s];
    const an = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(an));
    merken(f.k, an ? (f.werte?.[0] ?? '1') : (f.werte?.[1] ?? '0'));
  }));
  ziel.querySelectorAll('.segment[data-s]').forEach((g) => g.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    if (g.hasAttribute('data-gesperrt')) return;
    g.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    merken(g.dataset.s, b.dataset.w);
  })));
  ziel.querySelectorAll('.einst-feld[data-s]').forEach((f) => {
    f.addEventListener(f.tagName === 'SELECT' ? 'change' : 'input', () => merken(f.dataset.s, f.value));
  });
  ziel.querySelectorAll('.herkunft-box').forEach((box) => herkunftVerbinden(app, box));
  // Verbindung testen / Testmail
  ziel.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', async () => {
    const log = b.closest('.einst-karte').querySelector('[data-test-log]');
    log.hidden = false;
    if (offen.size) { log.textContent = t('Erst speichern – getestet wird mit den gespeicherten Werten.'); return; }
    b.disabled = true;
    log.textContent = b.dataset.test === 'mail' ? t('Sende …') : t('Prüfe …');
    try {
      if (b.dataset.test === 'mail') {
        const res = await api.post('/admin/mailtest', {});
        log.textContent = (res.ok ? t('✓ Testmail verschickt an deine Adresse.') + '\n\n' : `✗ ${res.fehler || t('Fehlgeschlagen')}\n\n`) + (res.schritte || []).join('\n');
      } else {
        const res = await api.post('/admin/downloads/test', {});
        log.textContent = Object.values(res.pruefungen || {}).map((x) => `${x.ok === null ? '?' : x.ok ? '✓' : '✗'} ${x.text}${x.ok !== true && x.tipp ? `\n    → ${x.tipp}` : ''}`).join('\n') + (res.ok ? '\n\n' + t('Alles in Ordnung.') : '');
      }
    } catch (e) { log.textContent = e.message; }
    b.disabled = false;
  }));
}

function herkunftVerbinden(app, box) {
  box.querySelector('[data-zuruecksetzen]')?.addEventListener('click', (e) => {
    const k = e.currentTarget.dataset.zuruecksetzen;
    offen.set(k, null);
    leisteZeichnen(app);
    box.innerHTML = herkunft(k);
  });
  box.querySelector('[data-entsperren]')?.addEventListener('click', (e) => {
    const k = e.currentTarget.dataset.entsperren;
    entsperrt.add(k);
    const z = box.closest('.einst-zeile');
    z.querySelectorAll('[disabled]').forEach((x) => { x.disabled = false; });
    z.querySelector('[data-gesperrt]')?.removeAttribute('data-gesperrt');
    box.innerHTML = herkunft(k);
    const feld = z.querySelector('input, select');
    if (feld) { if (FELD[k]?.typ === 'geheim') feld.placeholder = t('neuen Schlüssel eintragen'); feld.focus(); }
  });
}

// ---------- Persönlich ----------
async function kontoZeichnen(app, inhalt, signal) {
  const p = await api.get('/profil', { signal });
  const u = app.ich.user;
  const bild = (url, gross = true) => `<span class="einst-bild${gross ? ' gross' : ''}${url ? ' mit-bild' : ''}" ${url ? `style="background-image:url('${h(url)}')"` : ''}><span>${h(initialen(`${p.vorname} ${p.nachname}`))}</span></span>`;
  const geraetIcon = (g) => icon(g.art === 'app' ? 'computer' : /android|iphone|handy|mobil/i.test(g.erkannt || '') ? 'handy' : /ipad|tablet/i.test(g.erkannt || '') ? 'handy' : 'computer', 18);
  inhalt.innerHTML = `
    ${karte(t('Persönliches'), `
      ${zeile('bild', t('Profilbild'), t('Erscheint oben rechts und in „Wer hört gerade“. JPG, PNG oder WebP – wird quadratisch zugeschnitten.'),
        `<label class="btn btn-zweit btn-klein" for="einst-bild-datei">${t('Bild ändern')}</label><input id="einst-bild-datei" type="file" accept="image/jpeg,image/png,image/webp" hidden data-bild-datei>${p.bild ? `<button type="button" class="btn btn-zweit btn-klein btn-rot-text" data-bild-weg>${t('Entfernen')}</button>` : ''}`, 'data-bild-zeile').replace('<div class="einst-text">', `${bild(p.bild)}<div class="einst-text">`)}
      ${zeile('name', t('Name'), `${h(`${p.vorname} ${p.nachname}`.trim())} · @${h(p.benutzername)}`, `<button type="button" class="btn btn-zweit btn-klein" data-name-aendern>${t('Ändern')}</button>`)}
      ${zeile('email', t('E-Mail-Adresse'), `${h(p.email)} · ${t('ändern kann sie ein Admin unter Verwaltung › Konten')}`, '')}
      ${zeile('passwort', t('Passwort'), t('Andere Geräte werden danach abgemeldet.'), `<button type="button" class="btn btn-zweit btn-klein" data-pw-aendern>${t('Ändern')}</button>`)}
      ${zeile('mail_info', t('E-Mails zu meinem Konto'), t('Zum Beispiel die Erinnerung, bevor das Konto abläuft.'), schalter(p.mail_info, `data-mail-info aria-label="${h(t('E-Mails zu meinem Konto'))}"`))}
      ${zeile('sprache', '<label for="einst-sprache">Sprache / Language</label>', t('Gilt für die ganze App und die Anmeldeseiten. „Automatisch“ folgt der Sprache deines Browsers.'),
        `<select id="einst-sprache" class="einst-feld" data-sprache>${[['', t('Automatisch (Browser)')], ['de', 'Deutsch'], ['en', 'English']].map(([v, tx]) => `<option value="${v}" ${(p.sprache || '') === v ? 'selected' : ''}>${h(tx)}</option>`).join('')}</select>`)}
    `)}
    ${karte(t('Angemeldete Geräte'), `${p.geraete.map((g, i) => `<div class="einst-zeile einst-geraet" data-k="geraete" data-g="${g.id}" ${i >= GERAETE_SICHTBAR ? 'data-mehr hidden' : ''}>
        <span class="einst-mini">${geraetIcon(g)}</span>
        <div class="einst-text"><span class="einst-name geraet-name"><span data-g-name>${h(g.name)}</span><button type="button" class="stift" data-umbenennen aria-label="${h(t('Gerät umbenennen'))}" title="${h(t('Umbenennen'))}">${icon('stift', 15)}</button></span>
          <p>${g.dieses ? `<b class="einst-dieses">${t('dieses Gerät')}</b> · ` : ''}${g.eigener_name ? `${t('erkannt als {name}', { name: h(g.erkannt) })} · ` : ''}${t('zuletzt {zeit}', { zeit: datumZeit(g.zuletzt) })}</p></div>
        <div class="einst-regler">${g.dieses ? '' : `<button type="button" class="btn btn-zweit btn-klein btn-rot-text" data-abmelden="${g.id}">${t('Abmelden')}</button>`}</div></div>`).join('')}
      ${p.geraete.length > GERAETE_SICHTBAR ? `<div class="einst-knopfzeile"><button type="button" class="btn btn-zweit btn-klein" data-alle-geraete>${t('Alle {n} Geräte zeigen', { n: zahl(p.geraete.length) })}</button></div>` : ''}
      <p class="einst-fuss">${t('Den Stift antippen, um ein Gerät zu benennen – der Name erscheint auch in „Wer hört gerade“. Leer lassen = automatisch.')}</p>`,
      p.max_geraete ? chip(t('höchstens {n} gleichzeitig', { n: p.max_geraete })) : '')}
    ${karte(t('Dein Konto'), `
      ${zeile('art', t('Kontoart'), '', `<span class="einst-wert">${p.rolle === 'admin' ? t('Administrator') : t('Familie')}</span>`)}
      ${zeile('gueltig', t('Gültig bis'), '', `<span class="einst-wert">${p.gueltig_bis ? datum(p.gueltig_bis) : t('unbegrenzt')}</span>`)}
      ${p.aktiviert_am ? zeile('seit', t('Freigeschaltet am'), '', `<span class="einst-wert">${datum(p.aktiviert_am)}</span>`) : ''}
      ${zeile('gehoert', t('Gehört'), '', `<span class="einst-wert">${tn(p.statistik.gehoert, 'ein Titel · {std} Stunden', '{n} Titel · {std} Stunden', { std: Number(p.statistik.stunden).toLocaleString(locale, { maximumFractionDigits: 1 }) })}</span>`)}
    `)}
    ${karte(t('Dieses Gerät'), `
      ${zeile('fern_erlaubt', t('Fernsteuerung erlauben'), t('Deine anderen Geräte dürfen die Wiedergabe hier steuern (Knopf „Wiedergabe auf …“ im Player). Admins können es immer.'),
        schalter(true, `data-fern-erlaubt aria-label="${h(t('Fernsteuerung erlauben'))}"`))}
      ${zeile('fern_max', t('Höchste Lautstärke per Fernsteuerung'), t('Schutz für nachts oder fürs Kinderzimmer – gilt nur für Befehle von anderen Geräten, hier selbst geht alles.'),
        `<select class="einst-feld" data-fern-max aria-label="${h(t('Höchste Lautstärke per Fernsteuerung'))}">${[100, 90, 80, 70, 60, 50, 40, 30].map((v) => `<option value="${v}">${v === 100 ? t('keine Grenze') : `${v} %`}</option>`).join('')}</select>`)}
      ${nativ?.clientEinst ? zeile('tray', t('Im Infobereich weiterlaufen'), t('Fenster schließen beendet Amberwave nicht – der PC bleibt per Fernsteuerung erreichbar. Ganz beenden: Rechtsklick aufs Symbol im Infobereich › Beenden.'),
        schalter(true, `data-client-einst="tray" aria-label="${h(t('Im Infobereich weiterlaufen'))}"`)) : ''}
      ${nativ?.clientEinst ? zeile('autostart', t('Mit Windows starten'), t('Startet unsichtbar im Infobereich – so lässt sich der PC gleich nach dem Anmelden fernsteuern.'),
        schalter(false, `data-client-einst="autostart" aria-label="${h(t('Mit Windows starten'))}"`)) : ''}
      ${zeile('haelften', t('Zwei Hälften (Faltgeräte)'), t('Kopf, Player und „Läuft gerade“ links/rechts der Falz. Automatisch: wenn der Browser eine Falz meldet oder das Gerät wie ein aufgeklapptes Fold aussieht.'),
        `<select class="einst-feld" data-haelften-wahl aria-label="${h(t('Zwei Hälften'))}"><option value="">${t('Automatisch')}</option><option value="an">${t('Immer')}</option><option value="aus">${t('Nie')}</option></select>`)}
      <details class="falz-bericht"><summary>${t('Was meldet dieses Gerät?')} <span data-falz-kurz></span></summary><dl data-falz-liste></dl>
        <p class="einst-fuss">${t('Tipp: Fold halb zuklappen – die Liste aktualisiert sich von selbst. Steht bei „Falz-Schnittstelle“ „fehlt“, kann dieser Browser die Falz nicht melden; Chrome, Edge und Samsung Internet können es.')}</p></details>
    `)}
    <div class="einst-karte einst-frei" data-exporte hidden></div>`;
  exportListe(inhalt.querySelector('[data-exporte]'));
  // Fernsteuerung: erlauben und Lautstärke-Grenze (am Gerät auf dem Server gemerkt – der Server prüft beides)
  api.get('/geraet/einstellungen').then((r) => {
    const e = r?.einstellungen || {};
    inhalt.querySelector('[data-fern-erlaubt]')?.setAttribute('aria-checked', String(e.fern_erlaubt !== false));
    const m = inhalt.querySelector('[data-fern-max]');
    if (m) m.value = String([100, 90, 80, 70, 60, 50, 40, 30].includes(Number(e.fern_max_lautstaerke)) ? Number(e.fern_max_lautstaerke) : 100);
  }).catch(() => {});
  inhalt.querySelector('[data-fern-erlaubt]')?.addEventListener('click', async (e) => {
    const b = e.currentTarget, an = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(an));
    if (!(await versuche(() => api.put('/geraet/einstellungen', { einstellungen: { fern_erlaubt: an } }), an ? t('Fernsteuerung erlaubt') : t('Fernsteuerung aus')))) b.setAttribute('aria-checked', String(!an));
  });
  inhalt.querySelector('[data-fern-max]')?.addEventListener('change', async (e) => {
    const v = Number(e.target.value);
    if (await versuche(() => api.put('/geraet/einstellungen', { einstellungen: { fern_max_lautstaerke: v } }), v === 100 ? t('Keine Grenze') : t('Fernsteuerung höchstens {v} %', { v })) && app.fern) app.fern.maxVol = v / 100;
  });
  // Windows Client: im Infobereich weiterlaufen, mit Windows starten
  if (nativ?.clientEinst) {
    nativ.clientEinst().then((w) => {
      inhalt.querySelectorAll('[data-client-einst]').forEach((b) => b.setAttribute('aria-checked', String(!!w?.[b.dataset.clientEinst])));
    }).catch(() => {});
    inhalt.querySelectorAll('[data-client-einst]').forEach((b) => b.addEventListener('click', async () => {
      const an = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', String(an));
      const w = await nativ.clientEinstSetzen({ [b.dataset.clientEinst]: an }).catch(() => null);
      if (!w) { b.setAttribute('aria-checked', String(!an)); toast(t('Nicht gespeichert'), 'fehler'); return; }
      toast(b.dataset.clientEinst === 'tray' ? (an ? t('Läuft beim Schließen im Infobereich weiter') : t('Schließen beendet Amberwave')) : (an ? t('Startet mit Windows') : t('Startet nicht mehr mit Windows')), 'gut');
    }));
  }
  // Faltgerät: Wahl + Live-Bericht
  const hw = inhalt.querySelector('[data-haelften-wahl]');
  hw.value = falzWahl();
  hw.addEventListener('change', () => falzWahlSetzen(hw.value));
  const falzZeigen = () => {
    if (!inhalt.isConnected) { window.removeEventListener('aw-falz', falzZeigen); return; }
    const st = falzStatus();
    inhalt.querySelector('[data-falz-liste]').innerHTML = falzBericht(st).map(([k, w]) => `<dt>${h(k)}</dt><dd>${h(w)}</dd>`).join('');
    inhalt.querySelector('[data-falz-kurz]').textContent = st.buch ? t('· halb geklappt (Buch)') : st.tisch ? t('· aufgestellt (Laptop)') : '';
  };
  falzZeigen();
  window.addEventListener('aw-falz', falzZeigen);

  inhalt.querySelector('[data-alle-geraete]')?.addEventListener('click', (e) => {
    inhalt.querySelectorAll('[data-mehr]').forEach((z) => { z.hidden = false; });
    e.currentTarget.parentElement.remove();
  });
  // Profilbild
  const bildDatei = inhalt.querySelector('[data-bild-datei]');
  bildDatei.addEventListener('change', async () => {
    const d = bildDatei.files[0];
    if (!d) return;
    const fd = new FormData(); fd.append('bild', d);
    const r = await versuche(() => api.post('/profil/bild', fd));
    if (r) { app.profilAktualisieren?.({ bild: r.bild }); toast(t('Profilbild geändert'), 'gut'); neuZeichnen(app); }
  });
  inhalt.querySelector('[data-bild-weg]')?.addEventListener('click', async () => {
    const r = await versuche(() => api.del('/profil/bild'));
    if (r) { app.profilAktualisieren?.({ bild: null }); toast(t('Profilbild entfernt')); neuZeichnen(app); }
  });
  // Name
  inhalt.querySelector('[data-name-aendern]').addEventListener('click', async () => {
    const d = await dialog({ titel: t('Name ändern'), inhalt: `<label for="dn-vor">${t('Vorname')}</label><input id="dn-vor" name="vorname" value="${h(p.vorname)}" required maxlength="100" autocomplete="given-name">
        <label for="dn-nach">${t('Nachname')}</label><input id="dn-nach" name="nachname" value="${h(p.nachname)}" maxlength="100" autocomplete="family-name">`,
      knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Speichern'), wert: 'ok' }] });
    if (!d) return;
    const r = await versuche(() => api.put('/profil', { vorname: d.form.get('vorname'), nachname: d.form.get('nachname') }));
    if (r) { app.profilAktualisieren?.({ vorname: r.vorname, nachname: r.nachname }); toast(t('Name geändert'), 'gut'); neuZeichnen(app); }
  });
  // Passwort
  inhalt.querySelector('[data-pw-aendern]').addEventListener('click', async () => {
    const d = await dialog({ titel: t('Passwort ändern'), inhalt: `<label for="dp-alt">${t('Bisheriges Passwort')}</label><input id="dp-alt" type="password" name="alt" required autocomplete="current-password">
        <label for="dp-neu">${t('Neues Passwort')} <small>${t('(mind. 8 Zeichen)')}</small></label><input id="dp-neu" type="password" name="neu" required minlength="8" autocomplete="new-password">
        <label for="dp-neu2">${t('Wiederholen')}</label><input id="dp-neu2" type="password" name="neu2" required minlength="8" autocomplete="new-password">
        <p class="hinweis" style="margin:12px 0 0">${t('Andere Geräte werden danach abgemeldet; dieses bleibt angemeldet.')}</p>`,
      knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Passwort ändern'), wert: 'ok' }] });
    if (!d) return;
    if (d.form.get('neu') !== d.form.get('neu2')) { toast(t('Die beiden neuen Passwörter stimmen nicht überein.'), 'fehler'); return; }
    if (await versuche(() => api.post('/profil/passwort', { alt: d.form.get('alt'), neu: d.form.get('neu') }))) { toast(t('Passwort geändert – andere Geräte sind abgemeldet'), 'gut'); neuZeichnen(app); }
  });
  // E-Mails
  inhalt.querySelector('[data-mail-info]').addEventListener('click', async (e) => {
    const b = e.currentTarget, an = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(an));
    if (!(await versuche(() => api.put('/profil', { mail_info: an }), an ? t('E-Mails an') : t('E-Mails aus')))) b.setAttribute('aria-checked', String(!an));
  });
  // Sprache: im Profil speichern, Cookie für die Anmeldeseiten setzen, neu laden
  const sprachWahl = inhalt.querySelector('[data-sprache]');
  sprachWahl?.addEventListener('change', async () => {
    const v = sprachWahl.value;
    sprachWahl.disabled = true;
    const r = await versuche(() => api.put('/profil', { sprache: v }));
    if (!r) { sprachWahl.value = p.sprache || ''; sprachWahl.disabled = false; return; }
    try {
      const sicher = location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = v ? `aw_sprache=${v}; path=/; max-age=31536000; SameSite=Lax${sicher}` : `aw_sprache=; path=/; max-age=0; SameSite=Lax${sicher}`;
    } catch (e) { /* Cookie nicht möglich – der Server kennt die Wahl ohnehin */ }
    location.reload();
  });
  // Geräte
  inhalt.querySelectorAll('[data-abmelden]').forEach((b) => b.addEventListener('click', async () => {
    const z = b.closest('[data-g]');
    if (!(await bestaetigen(t('Gerät abmelden?'), t('„{name}“ muss sich danach neu anmelden.', { name: z.querySelector('[data-g-name]').textContent }), t('Abmelden')))) return;
    if (await versuche(() => api.del(`/profil/geraete/${b.dataset.abmelden}`), t('Gerät abgemeldet'))) z.remove();
  }));
  inhalt.querySelectorAll('[data-umbenennen]').forEach((b) => b.addEventListener('click', () => {
    const z = b.closest('[data-g]');
    const box = b.closest('.geraet-name');
    const name = box.querySelector('[data-g-name]');
    const g = p.geraete.find((x) => String(x.id) === z.dataset.g);
    const f = document.createElement('input');
    f.className = 'einst-feld geraet-feld'; f.maxLength = 80; f.value = g.eigener_name || g.name; f.placeholder = g.erkannt; f.setAttribute('aria-label', t('Gerätename'));
    name.hidden = true; b.hidden = true; box.prepend(f); f.focus(); f.select();
    let fertig = false;
    const ende = async (ok) => {
      if (fertig) return; fertig = true;
      const neu = f.value.trim();
      f.remove(); name.hidden = false; b.hidden = false;
      if (!ok || neu === (g.eigener_name || g.name)) return;
      const r = await versuche(() => api.put(`/profil/geraete/${g.id}`, { name: neu }));
      if (r) {
        const n = r.geraete.find((x) => x.id === g.id);
        Object.assign(g, n);
        name.textContent = n.name;
        if (n.id === app.ich.geraet_id) app.ich.geraet_name = n.name;
        toast(neu ? t('Gerätename gespeichert') : t('Gerätename wieder automatisch'), 'gut');
      }
    };
    f.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ende(true); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ende(false); } });
    f.addEventListener('blur', () => ende(true));
  }));
}

function wiedergabeZeichnen(app, inhalt) {
  const pl = app.player;
  const e = pl.einst;
  const dg = LueckenlosMotor.diagnose();
  const jn = (x) => (x ? t('ja') : t('nein'));
  const qOpt = (feld, auto) => QUALITAETEN.map(([w, tx]) => `<option value="${w}" ${e[feld] === w ? 'selected' : ''}>${h(w === 'auto' ? auto : tx)}</option>`).join('');
  inhalt.innerHTML = `
    ${karte(t('Qualität'), `
      ${zeile('qualitaet_heim', `<label for="ew-qh">${t('Zuhause')}</label>`, t('Im Heimnetz – auch über die öffentliche Adresse. „Original“ spielt die Datei unverändert; was hier nicht abspielbar ist (z. B. DSD, APE), wird umgewandelt.'), `<select id="ew-qh" class="einst-feld" data-qualitaet="heim">${qOpt('qualitaet_heim', t('Automatisch (Original, wenn möglich)'))}</select>`)}
      ${zeile('qualitaet_unterwegs', `<label for="ew-qu">${t('Unterwegs')}</label>`, t('Über das Internet und Mobilfunk. Original braucht viel Datenvolumen.'), `<select id="ew-qu" class="einst-feld" data-qualitaet="unterwegs">${qOpt('qualitaet_unterwegs', t('Automatisch ({was})', { was: pl.mobil ? t('Handy/Tablet: Opus 160, im Mobilfunk 128') : 'Opus 256' }))}</select>`)}
    `, chip(pl.netz?.lokal ? t('gerade zuhause') : t('gerade unterwegs'), pl.netz?.lokal ? 'gut' : ''))}
    ${karte(t('Lückenlos'), `
      ${zeile('lueckenlos', t('Titel ohne Pause aneinanderhängen'), t('Live-Alben und durchgehende Alben laufen auf das Sample genau durch. Nur ausschalten, wenn ein Gerät Probleme macht.'), schalter(e.lueckenlos !== false, `data-lueckenlos aria-label="${h(t('Lückenlose Wiedergabe'))}"`))}
      ${zeile('lueckenlos_vorrang', `<label for="ew-lv">${t('Wenn „Original“ hier nicht lückenlos geht')}</label>`, h(t('Dieses Gerät: {mse} · FLAC-Strom: {flac} · Opus-Strom: {opus}', { mse: dg.mse || t('keine Media Source Extensions'), flac: jn(dg.flac), opus: jn(dg.opus) }) + (pl.motorFehlerText ? ' · ' + t('zuletzt gestört: {fehler}', { fehler: pl.motorFehlerText }) : '')),
        `<select id="ew-lv" class="einst-feld" data-lueckenlos-vorrang><option value="ja" ${e.lueckenlos_vorrang !== false ? 'selected' : ''}>${t('Lückenlos mit Opus 256 (empfohlen)')}</option><option value="nein" ${e.lueckenlos_vorrang === false ? 'selected' : ''}>${t('Original, dafür mit kurzen Pausen')}</option></select>`)}
    `)}
    ${karte(t('Lautstärke angleichen'), `
      ${zeile('lautheit', t('Verfahren'), t('EBU R128. Albumweise, wenn Titel eines Albums in Reihenfolge laufen – leise Intros bleiben leise; sonst je Titel. Kein Limiter, keine Kompression. „Aus“ hält die Wiedergabe bitgenau.'), segment([['aus', t('Aus')], ['auto', t('Automatisch')]], e.lautheit === 'aus' ? 'aus' : 'auto', `data-lautheit aria-label="${h(t('Lautstärke angleichen'))}"`))}
      ${zeile('lautheit_ziel', `<label for="ew-lz">${t('Zielwert')}</label>`, t('Angehoben wird nur so weit, dass der True-Peak unter −1 dBTP bleibt.'), `<select id="ew-lz" class="einst-feld" data-lautheit-ziel ${e.lautheit === 'aus' ? 'disabled' : ''}>${LAUTHEIT_ZIELE.map(([w, tx]) => `<option value="${w}" ${Number(e.lautheit_ziel) === w ? 'selected' : ''}>${h(tx)}</option>`).join('')}</select>`)}
    `)}
    ${karte(t('Anzeige und Klang'), `
      ${zeile('pegel', t('Pegelanzeige im Player'), t('Kleine Spitzenpegel-Meter (dBFS) neben der Qualität. Läuft im Browser über Web Audio; an Handy/Tablet standardmäßig aus.'), schalter(pl.pegelAn, `data-pegel aria-label="${h(t('Pegelanzeige'))}"`))}
      ${zeile('klang', t('Raumklang und Effekte'), t('Upmix, Hall, Glow, Iron, Silk und EQ stellst du direkt im Player ein – über die Klang-Knöpfe und das Effektrack. Gemerkt wird pro Gerät.'), `<button type="button" class="btn btn-zweit btn-klein" data-rack-oeffnen>${t('Effektrack öffnen')}</button>`)}
    `)}`;
  inhalt.querySelectorAll('[data-qualitaet]').forEach((s) => s.addEventListener('change', () => { pl.qualitaetSetzen(s.value, s.dataset.qualitaet); toast(t('Übernommen')); app.leiste?.aktualisieren?.(); }));
  const persoenlich = (feld, wert, neuLaden = false) => {
    pl.einst[feld] = wert;
    pl.einstSpeichern();
    api.put('/geraet/einstellungen', { einstellungen: { [feld]: wert } }).catch(() => {});
    if (neuLaden && pl.track && pl.audio.src) pl.laden(pl.zeit, !pl.audio.paused);
    toast(t('Übernommen'));
  };
  inhalt.querySelector('[data-lueckenlos]').addEventListener('click', (ev) => { const b = ev.currentTarget, an = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(an)); persoenlich('lueckenlos', an, true); });
  inhalt.querySelector('[data-lueckenlos-vorrang]').addEventListener('change', (ev) => persoenlich('lueckenlos_vorrang', ev.target.value === 'ja', true));
  inhalt.querySelectorAll('[data-lautheit] button').forEach((b) => b.addEventListener('click', async () => {
    inhalt.querySelectorAll('[data-lautheit] button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    inhalt.querySelector('[data-lautheit-ziel]').disabled = b.dataset.w === 'aus';
    await pl.lautheitSetzen({ lautheit: b.dataset.w });
    toast(b.dataset.w === 'aus' ? t('Lautstärke-Angleich aus') : t('Lautstärke-Angleich an'));
  }));
  inhalt.querySelector('[data-lautheit-ziel]').addEventListener('change', async (ev) => { await pl.lautheitSetzen({ lautheit_ziel: Number(ev.target.value) }); toast(t('Übernommen')); });
  inhalt.querySelector('[data-pegel]').addEventListener('click', (ev) => {
    const b = ev.currentTarget, an = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(an));
    pl.pegelSetzen(an);
    toast(an ? t('Pegelanzeige an') : t('Pegelanzeige aus – bitgenau wieder nach Neuladen der Seite'));
  });
  inhalt.querySelector('[data-rack-oeffnen]').addEventListener('click', () => {
    const k = document.querySelector('[data-rack-leiste]');
    if (k && getComputedStyle(k).display !== 'none') k.click(); else document.querySelector('[data-rk-leiste]')?.click();
  });
}

// ---------- Windows-Ausgabe: Signalweg als Bühne, Geräte gruppiert, Einstellungen darunter ----------
const khz = (r) => `${(Math.round(r / 100) / 10).toLocaleString(locale, { maximumFractionDigits: 1 })} kHz`;
const istAsioId = (id) => String(id || '').startsWith('asio:');
const kanalText = (k) => (k >= 8 ? '7.1' : k >= 6 ? '5.1' : k === 4 ? t('Quadro') : t('{n} Kanäle', { n: k || 2 }));
const BUEHNE_ICON = {
  datei: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><circle cx="10" cy="15" r="2"/><path d="M12 15V9.5l3 1"/>',
  engine: '<path d="M3 12h3l2-5 4 10 3-7 2 2h4"/>',
  treiber: '<rect x="2" y="7" width="20" height="10" rx="2.5"/><circle cx="12" cy="12" r="2.4"/><circle cx="17" cy="12" r="1.6"/><path d="M5 10.5h3M5 13.5h3"/>',
  mixer: '<path d="M6 4v16M12 4v16M18 4v16"/><rect x="4" y="13" width="4" height="3" rx="1"/><rect x="10" y="7" width="4" height="3" rx="1"/><rect x="16" y="11" width="4" height="3" rx="1"/>',
  schild: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z"/><path d="m8.8 12.2 2.2 2.2 4.3-4.6"/>',
  pfeil: '<path d="m9 6 6 6-6 6"/>',
};
const ICON_GERAET = {
  interface: '<rect x="2" y="7" width="20" height="10" rx="2.5"/><circle cx="12" cy="12" r="2.4"/><circle cx="17" cy="12" r="1.6"/><path d="M5 10.5h3M5 13.5h3"/>',
  lautsprecher: '<rect x="5" y="2.5" width="14" height="19" rx="2.5"/><circle cx="12" cy="14.5" r="3.6"/><circle cx="12" cy="7" r="1.6"/>',
  receiver: '<rect x="2" y="6" width="20" height="11" rx="2"/><path d="M6 20h12M8 9.5h8M8 12.5h5"/>',
  kopfhoerer: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
  windows: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
};
const AUGE_ZU = '<path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A9.6 9.6 0 0 1 12 5c5 0 9 4.5 10 7a12.6 12.6 0 0 1-3 4M6.2 6.6C4.2 8 2.8 10 2 12c1 2.5 5 7 10 7a9.4 9.4 0 0 0 4.2-1"/>';
const AUGE = '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>';
function geraetArt(g) {
  if (!g || g.id === '') return 'windows';
  if (istAsioId(g.id)) return 'interface';
  const n = `${g.name || ''}`.toLowerCase();
  if (/hdmi|receiver|\bav\b|displayport|nvidia|amd high definition|intel.*display/.test(n)) return 'receiver';
  if (/kopfh|headphone|headset|dac|usb audio/.test(n)) return 'kopfhoerer';
  return 'lautsprecher';
}
const treiberName = (g) => (g ? g.eigener_name || String(g.name || '').replace(/^ASIO · /, '') || t('Windows-Standardgerät') : t('Windows-Standardgerät'));
/** Anzeigename: ASIO-Ausgang „Treiber · Ausgang“ nur, wo der Treiber nicht schon dasteht */
const geraetName = (g, mitTreiber = true) => (g?.ausgang ? (mitTreiber ? `${ausgangName(g.ausgang)} · ${treiberName(g)}` : ausgangName(g.ausgang)) : treiberName(g));

function ausgabeZeichnen(app, inhalt, signal) {
  if (!nativ) {
    inhalt.innerHTML = karte('', `<p class="einst-leer">${icon('computer', 22)}${t('Diese Einstellungen gibt es nur im Amberwave Windows Client – dort wählst du Ausgabegerät, Exklusiv-Modus, ASIO und Abtastrate für diesen PC.')}</p>`);
    return;
  }
  const pl = app.player;
  const merkenGeht = typeof nativ.geraetMerken === 'function';
  let geraete = [], wahl = { geraet: '', exklusiv: false, rate: 0, aufschlag: 250 }, ausgeblendetZeigen = false, bearbeitet = null;
  inhalt.innerHTML = `
    <section class="aus-buehne" data-k="geraet" data-buehne aria-label="${h(t('Signalweg'))}"></section>
    <div class="einst-karte" data-k="geraete"><h2><span>${t('Ausgabegerät')}</span><span class="einst-chip" data-geraete-zahl></span></h2><div class="aus-geraete" data-geraete><div class="lade"></div></div></div>
    ${karte('', `
      ${zeile('modus', t('Modus'), '<span data-modus-text></span>', segment([['geteilt', t('Geteilt')], ['exklusiv', t('Exklusiv')]], 'geteilt', `data-modus aria-label="${h(t('Modus'))}"`))}
      ${zeile('rate', `<label for="en-rate">${t('Abtastrate am Gerät')}</label>`, t('„Folgt der Datei“ bleibt bitgenau, das Interface schaltet bei jedem Wechsel um. Fest: anderes wird linearphasig umgerechnet (Störungen unter −150 dB), Übergänge bleiben lückenlos.'), `<select id="en-rate" class="einst-feld" data-n-rate><option value="0">${t('Folgt der Datei')}</option>${[44100, 48000, 88200, 96000, 176400, 192000].map((r) => `<option value="${r}">${t('Fest {rate}', { rate: khz(r) })}</option>`).join('')}</select>`)}
      ${zeile('aufschlag', `<label for="en-aufschlag">${t('Pause nach dem Umschalten')}</label>`, t('Wie beim CD-Wechsel: lieber kurz Stille als ein abgeschnittener Anfang. Manche Interfaces geben ihren Ausgang nach einem Ratenwechsel erst spät frei. Gemerkt für dieses Gerät.') + ' <span class="aus-zeitleiste" data-zeitleiste></span>', `<select id="en-aufschlag" class="einst-feld" data-n-aufschlag>${AUFSCHLAG_STUFEN.map(([w, tx]) => `<option value="${w}">${tx}</option>`).join('')}</select>`)}
      ${zeile('asio', t('ASIO-Treiber'), t('Puffergröße und Taktquelle stellt das Treiberfenster des Herstellers ein.'), `<button type="button" class="btn btn-zweit btn-klein" data-n-asio>${t('Treiber-Einstellungen …')}</button>`, 'data-asio-zeile hidden')}
    `)}
    <p class="einst-fuss aus-fuss">${t('Bitgenau (exklusiv oder ASIO) heißt: Lautstärke 100 %, Lautstärke-Angleich aus und keine Effekte – sonst rechnet die Engine (64 Bit, mit Dither).')} Amberwave Windows Client ${h(nativ.version || '')}.</p>`;
  const $ = (s) => inhalt.querySelector(s);
  const aktuell = () => geraete.find((g) => g.id === wahl.geraet) || (wahl.geraet === '' ? { id: '', name: t('Windows-Standardgerät') } : null);

  // ----- Bühne: Datei → Engine → Treiber/Windows → Ausgang (feste Maße; Umbruch je nach Platz macht das CSS) -----
  const buehne = () => {
    const f = pl.audio.format;
    const g = aktuell();
    const asio = f ? f.asio : istAsioId(wahl.geraet);
    const exkl = f ? f.exklusiv && !f.asio : wahl.exklusiv && !asio;
    const weg = asio ? 'asio' : exkl ? 'exklusiv' : 'geteilt';
    const bw = app.leiste?.bewertung?.() || { stufe: 'transparent', grund: '' };
    const tr = pl.track;
    const codec = (tr?.format?.codec || tr?.format?.datei || '').replace(/^pcm_.*/, 'PCM').toUpperCase();
    const gr = f ? f.geraet_rate || f.aus_rate : 0;
    const ms = f && f.latenz && gr ? `${zahl(Math.round(f.latenz / gr * 10000) / 10)} ms` : '';
    const status = !f ? { klasse: '', text: t('noch nichts abgespielt') }
      : bw.stufe === 'bitgenau' ? { klasse: 'gut', text: t('bitgenau') } : bw.stufe === 'transparent' ? { klasse: 'gut leise', text: t('klanglich unverändert') } : { klasse: 'warn', text: t('verändert') };
    const kopf = weg === 'asio'
      ? ['', 'ASIO', t('Direkt zum Treiber.'), t('Kein Windows-Mixer, kein Umrechnen, keine Systemklänge – jedes Sample kommt so am Wandler an, wie es in der Datei steht.')]
      : weg === 'exklusiv'
        ? ['klein', t('Exklusiv'), t('Amberwave hat das Gerät für sich.'), t('An der Windows-Mischung vorbei, die Abtastrate folgt der Datei. Andere Programme sind solange stumm.')]
        : ['klein leise', t('Geteilt'), t('Windows mischt mit.'), t('Andere Programme bleiben hörbar – dafür mischt und rechnet Windows. Für bitgenau „Exklusiv“ wählen oder ein ASIO-Gerät.')];
    const ic = (n, gr2 = 15) => `<svg width="${gr2}" height="${gr2}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${BUEHNE_ICON[n] || n}</svg>`;
    const st = (art, titel, symbol, name, wert, det, extra = '') => `<div class="aus-st ${art}" ${extra}><span class="aus-st-zeile"><span class="aus-klein">${titel}</span>${symbol}</span><b title="${h(name)}">${h(name)}</b><span class="aus-st-wert">${wert ? h(wert) : ''}</span><span class="aus-st-det">${det}</span></div>`;
    const ver = (k, chip = '') => `<div class="aus-ver ${k}" aria-hidden="true">${ic('pfeil', 16)}${chip ? `<span class="aus-ver-chip">${h(chip)}</span>` : ''}</div>`;
    // Treiber bzw. Windows-Mixer
    const treiber = weg === 'asio'
      ? st('treiber', t('ASIO-Treiber'), ic('treiber'), g?.eigener_name || (f?.geraet || treiberName(g)).replace(/^ASIO · /, ''), ms ? t('Latenz {ms}', { ms }) : '', f ? '<i></i>' + t('läuft') : t('bereit'))
      : weg === 'exklusiv'
        ? st('treiber', t('WASAPI exklusiv'), ic('treiber'), t('Windows-Treiber'), '', t('direkt, ohne Mischung'))
        : st('mixer', t('Windows-Audio'), ic('mixer'), t('Mixer'), f && gr && Math.abs(gr - f.rate) > 1 ? `${khz(f.rate)} → ${khz(gr)}` : '', t('mischt Programme und Systemklänge dazu'));
    // Ausgang: ASIO-Ausgang mit Symbol und Kanälen, sonst das Windows-Gerät
    const ausgang = g?.ausgang
      ? st('ausgang', t('Ausgang'), `<span class="aus-st-sym">${symbolSvg(symbolVon(g.ausgang), 18)}</span>`, ausgangName(g.ausgang), gr ? khz(gr) : '', h(ausgangUnter(g.ausgang)))
      : st('ausgang', t('Ausgang'), `<span class="aus-st-sym">${ic(ICON_GERAET[geraetArt(g)], 18)}</span>`, geraetName(g, false), gr ? khz(gr) : '', g && g.id !== '' ? h(`${g.kanaele ? `${kanalText(g.kanaele)} · ` : ''}${asio ? 'ASIO' : 'WASAPI'}`) : t('folgt der Einstellung in Windows'));
    const format = f ? f.aus_format || '' : '';
    const genau = !!f && bw.stufe === 'bitgenau';
    const engineWert = !f ? '' : genau ? t('bitgenau') : format;
    const engineText = !f ? t('wartet auf den ersten Titel') : genau ? t('reicht unverändert durch') : h(bw.grund || t('rechnet in 64 Bit'));
    const umweg = weg !== 'geteilt'
      ? `<div class="aus-umweg">${ic('schild', 22)}<div><span><s>${t('Windows-Audio')}</s> <em>${t('umgangen')}</em></span><span>${t('kein Mixer, kein Umrechnen')}</span></div></div>`
      : `<div class="aus-umweg">${ic('mixer', 22)}<div><span><em>${t('Windows mischt')}</em></span><span>${t('für bitgenau: Exklusiv oder ASIO')}</span></div></div>`;
    const b = $('[data-buehne]');
    b.className = `aus-buehne ${weg}${f ? '' : ' ruhe'}${f && pl.audio.aussetzerZahl ? ' mit-aussetzern' : ''}`;
    b.innerHTML = `
      <div class="aus-kopf"><div class="aus-wort ${kopf[0]}">${kopf[1]}</div><div class="aus-kopf-tx"><b>${kopf[2]}</b><span>${kopf[3]}</span></div><span class="aus-status ${status.klasse}" title="${h(bw.grund || '')}"><i></i>${status.text}</span></div>
      <div class="aus-kette">
        ${st('datei', t('Datei'), ic('datei'), codec || (f ? 'PCM' : '—'), f ? `${f.bits} Bit · ${khz(f.rate)}` : '', f ? kanalText(f.kanaele) : t('noch nichts abgespielt'))}${ver('v1')}
        ${st('engine', 'Engine', ic('engine'), 'Amberwave', engineWert, engineText, genau && format ? `data-nach=" → ${h(format)}"` : '')}${ver('v2', f ? format : '—')}
        ${treiber}${ver('v3')}
        ${ausgang}
      </div>
      <div class="aus-leiste">${umweg}<div class="aus-werte">
        <div><small>${t('Abtastrate')}</small><b>${gr ? khz(gr) : '—'}</b><span>${!f ? '&nbsp;' : f.umgerechnet ? t('fest, umgerechnet') : weg === 'geteilt' ? t('Mischrate von Windows') : t('folgt der Datei')}</span></div>
        <div><small>${t('Format am Gerät')}</small><b>${f ? h(format || '—') : '—'}</b><span>${f ? `${kanalText(f.aus_kanaele)}${f.geraet_kanaele > f.aus_kanaele ? ` ${t('von {kanaele}', { kanaele: kanalText(f.geraet_kanaele) })}` : ''}` : '&nbsp;'}</span></div>
        <div><small>${t('Latenz')}</small><b>${ms || '—'}</b><span>${f?.asio ? t('laut Treiber') : t('nur bei ASIO')}</span></div>
        <div><small>${t('Aussetzer')}</small><b class="${(pl.audio.aussetzerZahl || 0) ? 'warn' : 'gut'}">${f ? pl.audio.aussetzerZahl || 0 : '—'}</b><span>${t('seit dem Öffnen')}</span></div>
      </div></div>`;
  };

  // ----- Geräteliste: ASIO zuerst, ausgeblendete gesammelt -----
  const liste = () => {
    const box = $('[data-geraete]');
    const alle = [{ id: '', name: t('Windows-Standardgerät'), standard: false, virtuell: true }, ...geraete];
    const sichtbar = (g) => !g.aus || g.id === wahl.geraet || (g.treiber && g.treiber === String(wahl.geraet || '').split('#')[0]) || ausgeblendetZeigen;
    const gewTreiber = String(wahl.geraet || '').split('#')[0];
    const aus = alle.filter((g) => g.aus && g.id !== wahl.geraet && !(g.treiber && g.treiber === gewTreiber));
    const zahlG = new Set(geraete.map((g) => g.treiber || g.id)).size;
    const zahlAus = new Set(aus.map((g) => g.treiber || g.id)).size;
    $('[data-geraete-zahl]').textContent = tn(zahlG, '{n} Gerät', '{n} Geräte') + (zahlAus ? ` · ${t('{n} ausgeblendet', { n: zahlAus })}` : '');
    const zeileG = (g) => {
      const an = g.id === wahl.geraet;
      const asio = istAsioId(g.id);
      const marken = [asio ? '<span class="aus-marke asio">ASIO</span>' : '', asio ? `<span class="aus-marke gut">${t('bitgenau')}</span>` : '', g.standard ? `<span class="aus-marke">${t('Windows-Standard')}</span>` : '', !asio && g.kanaele > 2 ? `<span class="aus-marke">${kanalText(g.kanaele)}</span>` : ''].join('');
      const unter = g.virtuell ? t('folgt der Einstellung in Windows') : g.eigener_name ? t('erkannt als „{name}“', { name: h(g.name) }) : asio ? t('an Windows vorbei · immer exklusiv') : g.kanaele ? `${kanalText(g.kanaele)} · WASAPI` : 'WASAPI';
      const name = bearbeitet === g.id
        ? `<div class="aus-g-name"><input class="einst-feld aus-g-feld" data-name-feld value="${h(g.eigener_name || g.name)}" maxlength="80" aria-label="${h(t('Gerätename'))}" placeholder="${h(g.name)}"><span>${t('Enter speichert · leer = wieder „{name}“', { name: h(g.name) })}</span></div>`
        : `<button type="button" class="aus-g-name" data-waehlen aria-pressed="${an}"><b>${h(geraetName(g))}</b><span>${unter}</span></button>`;
      const werkzeug = merkenGeht && !g.virtuell ? `<span class="aus-g-wz">
          <button type="button" class="stift" data-umbenennen aria-label="${h(t('Umbenennen'))}" title="${h(t('Umbenennen'))}">${icon('stift', 15)}</button>
          <button type="button" class="stift" data-ausblenden aria-label="${g.aus ? t('Einblenden') : t('Ausblenden')}" title="${an ? t('Das gewählte Gerät bleibt sichtbar') : g.aus ? t('Einblenden') : t('Ausblenden')}" ${an && !g.aus ? 'disabled' : ''}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${g.aus ? AUGE : AUGE_ZU}</svg></button></span>` : '';
      return `<div class="aus-g${an ? ' an' : ''}${g.aus ? ' aus' : ''}" data-geraet-id="${h(g.id)}">
        <svg class="aus-g-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${ICON_GERAET[geraetArt(g)]}</svg>
        ${name}${marken ? `<span class="aus-marken">${marken}</span>` : ''}${werkzeug}${an ? `<span class="aus-haken">${icon('haken', 13)}</span>` : ''}</div>`;
    };
    // ASIO: je Treiber eine Karte mit seinen Ausgängen (ältere Clients liefern nur den Treiber – dann eine Zeile wie bisher)
    const treiberKarte = (gs) => {
      const tk = gs[0];
      const an = gs.some((g) => g.id === wahl.geraet);
      const n = gs.length;
      const name = bearbeitet === tk.treiber
        ? `<div class="aus-g-name"><input class="einst-feld aus-g-feld" data-name-feld value="${h(tk.eigener_name || tk.name.replace(/^ASIO · /, ''))}" maxlength="80" aria-label="${h(t('Gerätename'))}" placeholder="${h(tk.name.replace(/^ASIO · /, ''))}"><span>${t('Enter speichert · leer = wieder „{name}“', { name: h(tk.name.replace(/^ASIO · /, '')) })}</span></div>`
        : `<div class="aus-g-name"><b>${h(treiberName(tk))}</b><span>${tk.eigener_name ? `${t('erkannt als „{name}“', { name: h(tk.name.replace(/^ASIO · /, '')) })} · ` : ''}${tn(n, '{n} Ausgang eingerichtet', '{n} Ausgänge eingerichtet')}</span></div>`;
      const werkzeug = merkenGeht ? `<span class="aus-g-wz">
          <button type="button" class="stift" data-umbenennen aria-label="${h(t('Umbenennen'))}" title="${h(t('Umbenennen'))}">${icon('stift', 15)}</button>
          <button type="button" class="stift" data-ausblenden aria-label="${tk.aus ? t('Einblenden') : t('Ausblenden')}" title="${an ? t('Das gewählte Gerät bleibt sichtbar') : tk.aus ? t('Einblenden') : t('Ausblenden')}" ${an && !tk.aus ? 'disabled' : ''}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${tk.aus ? AUGE : AUGE_ZU}</svg></button></span>` : '';
      const busse = gs.map((g) => {
        const gw = g.id === wahl.geraet;
        return `<div class="aus-bus${gw ? ' an' : ''}" data-geraet-id="${h(g.id)}">
          <span class="aus-bus-sym">${symbolSvg(symbolVon(g.ausgang), 24)}</span>
          <button type="button" class="aus-g-name" data-waehlen aria-pressed="${gw}"><b>${h(ausgangName(g.ausgang))}</b><span>${h(ausgangUnter(g.ausgang))}</span></button>
          ${gw ? `<span class="aus-haken">${icon('haken', 13)}</span>` : ''}</div>`;
      }).join('');
      return `<div class="aus-treiber${an ? ' an' : ''}${tk.aus ? ' aus' : ''}" data-geraet-id="${h(tk.treiber)}">
        <div class="aus-treiber-kopf">
          <svg class="aus-g-icon" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${ICON_GERAET.interface}</svg>
          ${name}<span class="aus-marken"><span class="aus-marke asio">ASIO</span><span class="aus-marke gut">${t('bitgenau')}</span></span>${werkzeug}
          ${nativ.ausgaengeLesen ? `<button type="button" class="btn btn-zweit btn-klein aus-routing" data-routing><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>${t('Ausgänge & Lautsprecher …')}</button>` : ''}
        </div>
        <div class="aus-busse">${busse}</div></div>`;
    };
    const asioAlle = alle.filter((g) => istAsioId(g.id) && sichtbar(g));
    const gruppen = [];
    for (const g of asioAlle) {
      if (!g.treiber) { gruppen.push({ alt: g }); continue; }
      const gr = gruppen.find((x) => x.treiber === g.treiber);
      if (gr) gr.gs.push(g); else gruppen.push({ treiber: g.treiber, gs: [g] });
    }
    // alle Ausgänge eines Treibers bleiben sichtbar, wenn einer davon gewählt ist
    for (const gr of gruppen) if (gr.treiber) gr.gs = alle.filter((g) => g.treiber === gr.treiber);
    const asioHtml = gruppen.map((gr) => (gr.alt ? `<div class="aus-raster">${zeileG(gr.alt)}</div>` : treiberKarte(gr.gs))).join('');
    const winG = alle.filter((g) => !istAsioId(g.id) && sichtbar(g));
    box.innerHTML = `${gruppen.length ? `<div class="aus-gruppe asio">${t('ASIO · an Windows vorbei')}</div>${asioHtml}` : ''}
      <div class="aus-gruppe">${t('Windows (WASAPI)')}</div><div class="aus-raster">${winG.map(zeileG).join('')}</div>
      ${zahlAus ? `<button type="button" class="aus-ausgeblendet" data-ausgeblendet-zeigen><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${ausgeblendetZeigen ? AUGE : AUGE_ZU}</svg>${tn(zahlAus, '{n} Gerät ausgeblendet', '{n} Geräte ausgeblendet')} · <b>${ausgeblendetZeigen ? t('wieder verbergen') : t('anzeigen')}</b></button>` : ''}`;
    box.querySelectorAll('[data-waehlen]').forEach((b) => b.addEventListener('click', () => geraetWaehlen(b.closest('[data-geraet-id]').dataset.geraetId)));
    box.querySelectorAll('[data-routing]').forEach((b) => b.addEventListener('click', () => {
      const t = b.closest('[data-geraet-id]').dataset.geraetId;
      const g = geraete.find((x) => x.treiber === t);
      ausgaengeFenster({ treiber: t, name: treiberName(g), aktiv: istAsioId(wahl.geraet) && wahl.geraet.split('#')[0] === t ? wahl.geraet.split('#')[1] : '', player: pl, nachher: () => { pl?.ausgangBassLaden?.(); neuLaden(); } });
    }));
    box.querySelector('[data-ausgeblendet-zeigen]')?.addEventListener('click', () => { ausgeblendetZeigen = !ausgeblendetZeigen; liste(); });
    box.querySelectorAll('[data-ausblenden]').forEach((b) => b.addEventListener('click', () => {
      const id = b.closest('[data-geraet-id]').dataset.geraetId;
      const gs = geraete.filter((x) => x.id === id || x.treiber === id);
      if (!gs.length) return;
      const aus = !gs[0].aus;
      for (const g of gs) g.aus = aus;
      nativ.geraetMerken({ id, aus });
      toast(aus ? t('„{name}“ ausgeblendet', { name: treiberName(gs[0]) }) : t('„{name}“ wieder eingeblendet', { name: treiberName(gs[0]) }));
      liste();
    }));
    box.querySelectorAll('[data-umbenennen]').forEach((b) => b.addEventListener('click', () => { bearbeitet = b.closest('[data-geraet-id]').dataset.geraetId; liste(); }));
    const feld = box.querySelector('[data-name-feld]');
    if (feld) {
      feld.focus(); feld.select();
      let fertig = false;
      const ende = (ok) => {
        if (fertig) return; fertig = true;
        const id = bearbeitet;
        const gs = geraete.filter((x) => x.id === id || x.treiber === id);
        const g = gs[0];
        bearbeitet = null;
        if (ok && g) {
          const neu = feld.value.trim();
          const erkannt = String(g.name || '').replace(/^ASIO · /, '');
          const name = neu === g.name || neu === erkannt ? '' : neu;
          if (name !== (g.eigener_name || '')) { for (const x of gs) x.eigener_name = name; nativ.geraetMerken({ id, name }); toast(name ? t('Gerätename gespeichert') : t('Gerätename wieder automatisch'), 'gut'); }
        }
        liste(); buehne();
      };
      feld.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ende(true); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ende(false); } });
      feld.addEventListener('blur', () => ende(true));
    }
  };

  // ----- Einstellungen -----
  const modus = $('[data-modus]');
  const rate = $('[data-n-rate]');
  const aufschlag = $('[data-n-aufschlag]');
  const reglerZeigen = () => {
    const asio = istAsioId(wahl.geraet);
    modus.querySelectorAll('button').forEach((b) => { b.setAttribute('aria-checked', String(b.dataset.w === (wahl.exklusiv || asio ? 'exklusiv' : 'geteilt'))); b.disabled = asio; });
    $('[data-modus-text]').textContent = asio ? t('ASIO geht an Windows vorbei und ist immer exklusiv.') : t('Exklusiv: bitgenau, Amberwave belegt das Gerät allein. Geteilt: andere Programme bleiben hörbar.');
    $('[data-asio-zeile]').hidden = !asio;
    rate.value = String(wahl.rate || 0);
    aufschlag.value = String(wahl.aufschlag ?? 250);
    if (!aufschlag.value) aufschlag.value = '250';
  };
  const zeitleiste = () => {
    const a = pl.audio.anlaufLetzt;
    const el = $('[data-zeitleiste]');
    if (!a) { el.innerHTML = ''; return; }
    const gesamt = Math.max(1, a.ms + a.aufschlag);
    el.innerHTML = `<span class="aus-balken" role="img" aria-label="${h(t('Zuletzt {ms} ms bis bereit, dann {pause} ms Pause', { ms: a.ms, pause: a.aufschlag }))}"><i style="width:${Math.round(a.ms / gesamt * 100)}%"></i><i style="width:${Math.round(a.aufschlag / gesamt * 100)}%"></i></span><span>${t('zuletzt <b>{ms} ms</b> bis bereit ({art}) + <b class="akzent">{pause}</b> Pause', { ms: a.ms, art: a.zeitueber ? t('kein stabiler Takt gemeldet') : t('gemessen'), pause: a.aufschlag >= 1000 ? `${zahl(a.aufschlag / 1000)} s` : `${a.aufschlag} ms` })}</span>`;
  };
  const speichern = (werte, meldung = t('Übernommen')) => {
    wahl = { ...wahl, ...werte };
    pl.nativAusgabeSetzen({ geraet: wahl.geraet, exklusiv: wahl.exklusiv, rate: wahl.rate, aufschlag: wahl.aufschlag });
    reglerZeigen(); buehne();
    if (meldung) toast(meldung);
  };
  const geraetWaehlen = async (id) => {
    if (id === wahl.geraet) return;
    wahl = { ...wahl, geraet: id };
    pl.nativAusgabeSetzen({ geraet: id, exklusiv: wahl.exklusiv, rate: wahl.rate });   // Pause: die gemerkte des Geräts
    await new Promise((r) => setTimeout(r, 150));
    try { const w = await nativ.ausgabeLesen(); wahl = { ...wahl, ...w }; pl.nativAusgabe = { ...pl.nativAusgabe, ...w }; } catch (e) { /* egal */ }
    reglerZeigen(); liste(); buehne();
    toast(t('Ausgabe: {name}', { name: geraetName(aktuell()) }));
  };
  modus.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { if (!b.disabled) speichern({ exklusiv: b.dataset.w === 'exklusiv' }); }));
  rate.addEventListener('change', () => speichern({ rate: Number(rate.value) || 0 }));
  aufschlag.addEventListener('change', () => speichern({ aufschlag: Number(aufschlag.value) }));
  $('[data-n-asio]').addEventListener('click', () => nativ.senden({ c: 'asio_einstellungen' }));
  pl.audio.addEventListener('nativformat', () => { buehne(); zeitleiste(); }, { signal });
  const auffrischen = setInterval(() => { if (!inhalt.isConnected) { clearInterval(auffrischen); return; } buehne(); }, 2000);
  signal?.addEventListener('abort', () => clearInterval(auffrischen));

  const neuLaden = () => Promise.all([nativ.geraete(), nativ.ausgabeLesen()]).then(([l, w]) => {
    geraete = l || []; wahl = { ...wahl, ...(w || {}) };
    // gemerkt noch ohne Ausgang (älterer Client-Stand): gilt als erster Ausgang des Treibers
    if (istAsioId(wahl.geraet) && !wahl.geraet.includes('#')) { const b = geraete.find((g) => g.treiber === wahl.geraet); if (b) wahl.geraet = b.id; }
    pl.nativAusgabe = { ...pl.nativAusgabe, ...(w || {}) };
    pl.nativGeraete = geraete;
    // ASIO zuerst (Ausgänge eines Treibers in ihrer Reihenfolge), dann Windows-Standard, dann nach Name
    geraete.sort((a, b) => (istAsioId(b.id) - istAsioId(a.id)) || (a.treiber && a.treiber === b.treiber ? 0 : (b.standard - a.standard) || treiberName(a).localeCompare(treiberName(b), locale)));
    reglerZeigen(); liste(); buehne();
  }).catch(() => { $('[data-geraete]').innerHTML = `<p class="einst-karten-hinweis">${t('Geräteliste nicht verfügbar.')}</p>`; });
  buehne(); zeitleiste();
  neuLaden();
  vstKarte(inhalt, signal);
}

// ---------- Server ----------
async function serverLaden(signal) {
  serverStand = await api.get('/admin/einstellungen', { signal });
  return serverStand;
}

async function bibliothekZeichnen(app, inhalt, signal) {
  await serverLaden(signal);
  inhalt.innerHTML = serverKarten('bibliothek') + '<div class="einst-karte einst-frei" data-k="lautheit_analyse" data-lh><div class="lade"></div></div>';
  serverVerbinden(app, inhalt);
  lautheitPanel(inhalt.querySelector('[data-lh]'), signal);
}

async function zugangZeichnen(app, inhalt, signal) {
  inhalt.innerHTML = `<section class="einst-karte einst-frei direkt-panel" data-k="direkt" data-direkt><div class="lade"></div></section>
    <section class="einst-karte einst-frei direkt-panel" data-k="tunnel" data-tunnel><div class="lade"></div></section>
    ${karte(t('Für Apps'), zeile('apps', t('Windows Client und andere Apps'), t('Melden sich mit Benutzername und Passwort an und erhalten einen Geräteschlüssel. Jedes Gerät erscheint unter Konto › Angemeldete Geräte und lässt sich dort abmelden. Die Schnittstellen beschreibt docs/API.md im Paket.'), ''))}`;
  direktEinrichten(inhalt.querySelector('[data-direkt]'), signal);
  tunnelEinrichten(inhalt.querySelector('[data-tunnel]'), signal);
}

async function downloadsZeichnen(app, inhalt, signal) {
  await serverLaden(signal);
  // Schalter „Usenet-Downloads verwenden“ zuerst, dann Anbieter und Clients, dann der Rest
  inhalt.innerHTML = serverKarten('downloads', {}, (k, i) => i === 0) + '<div class="dla" data-dla-panel><div class="lade"></div></div>' + serverKarten('downloads', {}, (k, i) => i > 0);
  serverVerbinden(app, inhalt);
  downloadAnbieterPanel(inhalt.querySelector('[data-dla-panel]'), signal);
}

async function raeumeZeichnen(app, inhalt, signal) {
  inhalt.innerHTML = '<div class="einst-karte einst-frei" data-k="raeume" data-raeume><div class="lade"></div></div>';
  raeumePanel(inhalt.querySelector('[data-raeume]'), signal);
}

async function systemZeichnen(app, inhalt, signal) {
  const s = await api.get('/admin/system', { signal });
  const b = s.benutzer;
  const ordnerZeile = (o) => {
    const gut = o.nur_anzeige || (o.vorhanden && o.ok);
    const besitz = o.besitzer ? `${h(o.besitzer.name)}:${h(o.besitzer.gruppe)} (${o.besitzer.uid}:${o.besitzer.gid})` : '';
    return `<div class="einst-zeile" data-k="ordner-${h(o.schluessel)}"><div class="einst-text"><div class="einst-name">${h(o.name)}</div>
      <p>${o.host ? `<code>${h(o.host)}</code> → ` : ''}<code>${h(o.pfad)}</code></p>
      <p>${t('Quelle: {quelle}', { quelle: h(o.quelle) })}${besitz ? ` · ${t('Besitzer {besitzer}', { besitzer: besitz })}` : ''}${o.schreiben === false && !o.optional ? ` · ${t('nur lesbar')}` : ''}</p>
      ${o.fehler ? `<p class="fehler-text">${h(o.fehler)}${o.befehl ? ` ${t('Auf dem Server:')} <code>${h(o.befehl)}</code>` : ''}</p>` : ''}</div>
      <div class="einst-wert">${o.nur_anzeige ? chip(t('vom Datenbank-Container')) : chip(gut ? t('in Ordnung') : t('Problem'), gut ? 'gut' : 'warn')}</div></div>`;
  };
  inhalt.innerHTML = `
    <div class="einst-teil"><span>${t('Version {version}', { version: h(s.version) })}</span></div>
    <div class="einst-karte einst-frei" data-k="region" data-region><div class="lade"></div></div>
    ${karte(t('Läuft als'), `<div class="einst-zeile" data-k="benutzer"><div class="einst-text"><div class="einst-name">${h(b.name)} (${b.uid}) · ${t('Gruppe {gruppe}', { gruppe: h(b.gruppe) })} (${b.gid})</div>
      <p>${t('Quelle: {quelle}', { quelle: h(b.quelle) })}. ${t('Amberwave läuft nie als root.')}</p>${b.hinweis ? `<p>${h(b.hinweis)}</p>` : ''}</div></div>`)}
    ${karte(t('Ordner'), s.ordner.map(ordnerZeile).join('') + `<p class="einst-fuss">${t('Ändern: in der <code>.env</code> <code>APPDATA_PFAD</code> (ein Ordner für Datenbank, App-Daten und Sicherungen) und bei Bedarf <code>SICHERUNG_PFAD</code> auf ein anderes Laufwerk setzen. Eigene Variablen wie <code>CACHE_PFAD</code> haben Vorrang. Bestehende Ordner umziehen: <code>scripts/pfade-migrieren.sh</code>.')}</p>`)}
    ${karte(t('Server'), s.server.map((x) => `<div class="einst-zeile" data-k="server-${h(x.name)}"><div class="einst-text"><div class="einst-name">${h(x.name)}: ${h(x.wert)}</div><p>${t('Quelle: {quelle}', { quelle: h(x.quelle) })}</p></div></div>`).join(''))}`;
  regionKarte(inhalt.querySelector('[data-region]'), signal);
}

async function sicherungZeichnen(app, inhalt, signal) {
  const [, s] = await Promise.all([serverLaden(signal), api.get('/admin/sicherungen', { signal })]);
  const fehler = (s.meldung || '').startsWith('FEHLER');
  const letzte = s.liste[0];
  inhalt.innerHTML = `
    <div class="einst-teil"><span>${t('Sicherung')}</span>${letzte ? chip(t('letzte: {zeit}', { zeit: datumZeit(letzte.zeit) }), 'gut') : chip(t('noch keine Sicherung'), 'warn')}</div>
    ${serverKarten('sicherung')}
    ${karte(t('Vorhandene Sicherungen'), `
      ${s.meldung ? `<p class="einst-karten-hinweis${fehler ? ' fehler-text' : ''}">${h(s.meldung)}</p>` : ''}
      ${s.laeuft ? `<p class="einst-karten-hinweis fehler-text">${t('Gerade läuft eine Wiederherstellung …')}</p>` : ''}
      ${s.liste.length ? s.liste.map((x) => `<div class="einst-zeile" data-k="liste">
          <div class="einst-text"><span class="einst-name">${datumZeit(x.zeit)}</span><p>${h(x.art_text)}${x.woche ? ` · ${t('Wochensicherung')}` : ''} · ${groesse(x.groesse)}</p></div>
          <div class="einst-regler">
            <a class="btn btn-zweit btn-klein" href="${h('/api/v1/admin/sicherungen/datei?name=' + encodeURIComponent(x.name))}" download>${t('Herunterladen')}</a>
            <button type="button" class="btn btn-zweit btn-klein" data-s-zurueck="${h(x.name)}" data-s-zeit="${h(x.zeit)}">${t('Wiederherstellen')}</button>
            ${x.art !== 'update' ? `<button type="button" class="btn-ico" data-s-weg="${h(x.name)}" aria-label="${h(t('Sicherung löschen'))}" title="${h(t('Löschen'))}">${icon('muell', 17)}</button>` : ''}
          </div></div>`).join('') : `<p class="einst-karten-hinweis">${t('Noch keine Sicherung vorhanden.')}</p>`}
      <p class="einst-fuss">${t('Ordner:')} <code>${h(s.ordner)}</code></p>`,
      `<button type="button" class="btn btn-zweit btn-klein" data-s-jetzt>${t('Jetzt sichern')}</button>`)}
    <div class="einst-teil einst-teil-update"><span>${t('Update')}</span>${chip(t('installiert: {version}', { version: app.ich.app.version }))}</div>
    ${app.ich.app.image ? `<div class="einst-karte" data-k="update"><h2><span>${t('Neue Version einspielen')}</span></h2>
      <p class="einst-karten-hinweis">${t('Diese Installation läuft als fertiges Docker-Image. Update auf dem Server:')}</p><pre class="log">docker compose pull &amp;&amp; docker compose up -d</pre>
      <p class="einst-karten-hinweis">${t('Daten, Einstellungen und Musik bleiben erhalten; Datenbank-Änderungen laufen beim Start automatisch.')}</p></div>` : ''}
    <form class="einst-karte einst-update" data-k="update" data-update ${app.ich.app.image ? 'hidden' : ''}>
      <h2><span>${t('Neue Version einspielen')}</span></h2>
      ${zeile('update', t('Update-Paket (.zip)'), t('Vorher wird automatisch gesichert (Datenbank und Code – es bleibt immer die letzte). Danach werden ausstehende Datenbank-Änderungen angewendet. Die App ist dabei kurz nicht erreichbar.'),
        `<label class="einst-ablage" for="einst-update-zip" data-ablage>${t('Paket auswählen …')}</label><input id="einst-update-zip" type="file" name="archiv" accept=".zip,application/zip" hidden>`)}
      <div class="einst-knopfzeile"><button type="submit" class="btn" data-einspielen disabled>${t('Sichern und einspielen')}</button></div>
      <pre class="log einst-log" data-log hidden></pre>
    </form>`;
  serverVerbinden(app, inhalt);
  inhalt.querySelector('[data-s-jetzt]').addEventListener('click', async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = t('Sichere …');
    const r = await versuche(() => api.post('/admin/sicherungen', {}));
    b.disabled = false; b.textContent = t('Jetzt sichern');
    if (r) { toast(t('Sicherung angelegt'), 'gut'); neuZeichnen(app); }
  });
  inhalt.querySelectorAll('[data-s-weg]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await bestaetigen(t('Sicherung löschen?'), t('Die Datei wird endgültig aus dem Backup-Ordner entfernt.'), t('Löschen'), true))) return;
    if (await versuche(() => api.del('/admin/sicherungen?name=' + encodeURIComponent(b.dataset.sWeg)), t('Sicherung gelöscht'))) neuZeichnen(app);
  }));
  inhalt.querySelectorAll('[data-s-zurueck]').forEach((b) => b.addEventListener('click', async () => {
    if (await sicherungWiederherstellen(b.dataset.sZurueck, b.dataset.sZeit)) neuZeichnen(app);
  }));
  const form = inhalt.querySelector('[data-update]');
  const zip = form.querySelector('[name=archiv]');
  zip.addEventListener('change', () => {
    const d = zip.files[0];
    const a = form.querySelector('[data-ablage]');
    a.textContent = d ? d.name : t('Paket auswählen …');
    a.classList.toggle('gewaehlt', !!d);
    form.querySelector('[data-einspielen]').disabled = !d;
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!zip.files[0]) return;
    const ok = await dialog({ titel: t('Update einspielen?'), inhalt: `<p>${h(t('{name} – vorher wird gesichert, die App ist kurz nicht erreichbar.', { name: zip.files[0].name }))}</p>
      <label for="upd-pw">${t('Zur Sicherheit: dein Anmelde-Passwort')}</label><input id="upd-pw" type="password" name="passwort" required autocomplete="current-password">`,
      knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Einspielen'), wert: 'ok' }] });
    if (!ok) return;
    const daten = new FormData(form);
    daten.set('passwort', ok.form.get('passwort') || '');
    const out = form.querySelector('[data-log]');
    out.hidden = false;
    out.textContent = t('Lade hoch, sichere und spiele ein …');
    form.querySelector('[data-einspielen]').disabled = true;
    try {
      const r = await api.post('/admin/update', daten);
      out.textContent = (r.ok ? t('✓ Update erfolgreich.') + '\n\n' : t('✗ Update fehlgeschlagen.') + '\n\n') + r.log.join('\n') + (r.ok ? '\n\n' + t('Die Seite lädt in 3 Sekunden neu.') : '');
      if (r.ok) setTimeout(() => location.reload(), 3000);
    } catch (err) { out.textContent = err.message; }
  });
}

async function serverBereichZeichnen(app, inhalt, bereich, signal) {
  await serverLaden(signal);
  inhalt.innerHTML = serverKarten(bereich);
  serverVerbinden(app, inhalt);
  if (bereich === 'dienste') { datenbankKarte(inhalt, signal); anfragenKarte(inhalt, signal); }
}

// Datenbank & Schlüssel: woher die Zugangsdaten kommen, Anzeige (nach Passwort-Bestätigung) und Ändern des Datenbank-Passworts
async function datenbankKarte(inhalt, signal) {
  const platz = document.createElement('div');
  inhalt.appendChild(platz);
  let d;
  try { d = await api.get('/admin/datenbank', { signal }); } catch { return; }
  if (!platz.isConnected) return;
  const quelle = d.quelle === 'datei' ? t('aus der Einrichtung (Cache-Ordner, geheimnisse/)') : t('aus deiner .env (DB_PASSWORD)');
  const schluessel = d.schluessel_erzeugt
    ? `${t('Der Schlüssel für gespeicherte Zugangsdaten (Mail, API-Schlüssel, Cloudflare) wurde von Amberwave erzeugt.')} ${d.schluessel_gesichert ? t('Eine Kopie liegt als app_secret_key.txt neben deinen Sicherungen.') : t('Lege eine Kopie an einen sicheren Ort – ohne ihn sind diese Angaben nach einem Neuaufbau unlesbar.')}`
    : t('Der Schlüssel für gespeicherte Zugangsdaten steht in deiner .env (APP_SECRET_KEY).');
  platz.outerHTML = karte(t('Datenbank & Schlüssel'), `
    <p class="einst-karten-hinweis">${h(schluessel)}</p>
    ${zeile('datenbank', t('Datenbank'), `${h(d.name)} · ${t('Benutzer {name}', { name: h(d.user) })} · ${t('Passwort {quelle}', { quelle: h(quelle) })}`, `<button type="button" class="btn btn-zweit btn-klein" data-db-zeigen>${t('Zugangsdaten anzeigen')}</button>${d.passwort_aenderbar ? ` <button type="button" class="btn btn-zweit btn-klein" data-db-aendern>${t('Passwort ändern')}</button>` : ''}`)}`,
  d.root_notfall ? chip(t('Notfallzugang vorhanden'), 'gut') : '');
  const wurzel = inhalt.querySelector('[data-db-zeigen]')?.closest('.einst-karte');
  if (!wurzel) return;
  const abfrage = (titel, extra, knopf) => dialog({ titel, inhalt: `<p class="hinweis" style="margin:0 0 10px">${t('Zur Sicherheit bitte mit deinem Anmelde-Passwort bestätigen.')}</p>
      <label for="dbd-pw">${t('Dein Passwort')}</label><input id="dbd-pw" type="password" name="passwort" required autocomplete="current-password">${extra}`,
    knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: knopf, wert: 'ok' }] });
  const wertZeile = (name, wert) => wert ? `<label>${h(name)}</label><div class="einst-ua" style="user-select:all;padding:8px 10px;background:rgba(0,0,0,.28);border-radius:8px">${h(wert)}</div>` : '';
  wurzel.querySelector('[data-db-zeigen]').addEventListener('click', async () => {
    const a = await abfrage(t('Zugangsdaten anzeigen'), '', t('Anzeigen'));
    if (!a) return;
    const r = await versuche(() => api.post('/admin/datenbank/zeigen', { passwort: a.form.get('passwort') }));
    if (!r) return;
    await dialog({ titel: t('Zugangsdaten'), inhalt: `${wertZeile(t('Datenbank-Passwort'), r.db_passwort) || `<p class="hinweis">${t('Das Datenbank-Passwort steht in deiner .env.')}</p>`}
      ${wertZeile(t('Notfallzugang Datenbank (root)'), r.root_passwort)}${wertZeile(t('Schlüssel (APP_SECRET_KEY)'), r.schluessel)}
      <p class="hinweis" style="margin:12px 0 0">${t('Nicht weitergeben. Der Notfallzugang ist nur für die Verwaltung der Datenbank von außen gedacht (z. B. ein Backup-Werkzeug).')}</p>` });
  });
  wurzel.querySelector('[data-db-aendern]')?.addEventListener('click', async () => {
    const a = await abfrage(t('Datenbank-Passwort ändern'), `<label for="dbd-neu">${t('Neues Datenbank-Passwort')} <small>${t('(leer = zufällig erzeugen, mind. 16 Zeichen)')}</small></label>
      <input id="dbd-neu" type="text" name="neu" autocomplete="off" spellcheck="false" autocapitalize="none">`, t('Ändern'));
    if (!a) return;
    const r = await versuche(() => api.post('/admin/datenbank/passwort', { passwort: a.form.get('passwort'), neu: a.form.get('neu') }));
    if (!r) return;
    toast(t('Datenbank-Passwort geändert'), 'gut');
    await dialog({ titel: t('Neues Datenbank-Passwort'), inhalt: `${wertZeile(t('Datenbank-Passwort'), r.db_passwort)}<p class="hinweis" style="margin:12px 0 0">${t('Amberwave verwendet es ab sofort selbst – du musst nichts weiter tun.')}</p>` });
  });
}

// Anfragen an fremde Dienste: Zähler je Dienst (Free/Pro) und die Kennung, die Amberwave mitschickt
async function anfragenKarte(inhalt, signal) {
  const platz = document.createElement('div');
  inhalt.appendChild(platz);
  let d;
  try { d = await api.get('/admin/dienste/anfragen', { signal }); } catch { return; }
  if (!platz.isConnected) return;
  const z = (n) => zahl(n || 0);
  const zeilen = d.dienste.length
    ? d.dienste.map((x) => `<tr><th scope="row">${h(x.dienst)}</th><td>${z(x.heute)}</td><td>${z(x.woche)}</td><td>${z(x.monat)}${x.monat_pro ? `<small> ${t('davon {n} Pro', { n: z(x.monat_pro) })}</small>` : ''}${x.fehler_monat ? `<small class="fehler-text"> · ${t('{n} fehlgeschlagen', { n: z(x.fehler_monat) })}</small>` : ''}</td><td>${z(x.vormonat)}</td></tr>`).join('')
    : `<tr><td colspan="5" class="einst-anfragen-leer">${t('Noch keine Anfragen gezählt.')}</td></tr>`;
  platz.outerHTML = karte(t('Anfragen an Dienste'), `
    <p class="einst-karten-hinweis">${t('Jede Anfrage trägt diese Kennung – nur Name, Version und Projektadresse, wie MusicBrainz und andere Dienste es verlangen. Keine Installations-Nummer, nichts über dich. Die Zählung unten bleibt auf deinem Server.')}</p>
    <div class="einst-zeile"><code class="einst-ua">${h(d.user_agent)}</code></div>
    <div class="einst-anfragen"><table><thead><tr><th scope="col">${t('Dienst')}</th><th scope="col">${t('Heute')}</th><th scope="col">${t('7 Tage')}</th><th scope="col">${t('Dieser Monat')}</th><th scope="col">${t('Vormonat')}</th></tr></thead><tbody>${zeilen}</tbody></table></div>`,
  '');
}

// ---------- Kopfchips je Bereich ----------
function kopfChips(id) {
  const e = serverStand?.einstellungen || {};
  const ges = (k) => !!e[k]?.gesetzt;
  if (id === 'dienste') {
    const ks = ['fanart_api_key', 'acoustid_api_key', 'claude_api_key', 'lidarr_api_key'];
    const n = ks.filter(ges).length;
    return chip(t('{n} von {gesamt} Schlüsseln gesetzt', { n, gesamt: ks.length }), n === ks.length ? 'gut' : '');
  }
  if (id === 'mail') return ges('smtp_host') ? chip(t('Versand eingerichtet'), 'gut') : chip(t('noch nicht eingerichtet'), 'warn');
  if (id === 'downloads') return serverStand?.einstellungen?.usenet_aktiv?.wert !== '1' ? chip(t('aus'), '') : serverStand?.downloads_bereit ? chip(t('eingerichtet'), 'gut') : chip(t('noch nicht eingerichtet'), 'warn');
  return '';
}

// ---------- Suche ----------
function suchIndex(admin) {
  const liste = SUCHE_PERSOENLICH.filter(([b]) => (b !== 'ausgabe' || nativ) && (admin || bereichVon(b).gruppe === 'persoenlich'))
    .map(([b, k, t, w]) => ({ b, k, t, w: `${t} ${w}`.toLowerCase() }));
  if (admin) for (const f of Object.values(FELD)) liste.push({ b: f.bereich, k: f.k, t: f.name, w: `${f.name} ${f.hinweis || ''} ${f.k.replace(/_/g, ' ')}`.toLowerCase() });
  return liste;
}

function sucheVerbinden(app, wurzel, admin) {
  const feld = wurzel.querySelector('[data-einst-suche]');
  const box = wurzel.querySelector('[data-einst-treffer]');
  const nav = wurzel.querySelector('[data-einst-nav]');
  const index = suchIndex(admin);
  feld.addEventListener('input', () => {
    const q = feld.value.trim().toLowerCase();
    nav.hidden = !!q; box.hidden = !q;
    if (!q) return;
    const woerter = q.split(/\s+/);
    const funde = index.filter((x) => woerter.every((w) => x.w.includes(w) || bereichVon(x.b).titel.toLowerCase().includes(w))).slice(0, 14);
    box.innerHTML = funde.length
      ? funde.map((f, i) => `<button type="button" class="einst-treffer-zeile" data-i="${i}"><span>${h(f.t)}</span><small>${h(bereichVon(f.b).titel)}</small></button>`).join('')
      : `<p class="einst-leer-treffer">${t('Nichts gefunden.')}</p>`;
    box.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => {
      const f = funde[Number(b.dataset.i)];
      springen = f.k;
      feld.value = '';
      app.navigieren(`/einstellungen/${f.b}`);
    }));
  });
  feld.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); box.querySelector('[data-i]')?.click(); }
    if (e.key === 'Escape') { feld.value = ''; feld.dispatchEvent(new Event('input')); }
  });
}

function zuZeileSpringen(inhalt) {
  if (!springen) return;
  const k = springen;
  springen = null;
  const versuch = (n) => {
    const z = inhalt.querySelector(`[data-k="${CSS.escape(k)}"]`);
    if (!z) { if (n > 0) setTimeout(() => versuch(n - 1), 250); return; }
    z.scrollIntoView({ block: 'center', behavior: 'smooth' });
    z.classList.remove('einst-blitz'); void z.offsetWidth; z.classList.add('einst-blitz');
    z.querySelector('input:not([type=hidden]):not([disabled]), select:not([disabled])')?.focus({ preventScroll: true });
  };
  versuch(8);
}

// ---------- Ansicht ----------
export async function einstellungenAnsicht({ app, ziel, param, signal }) {
  const admin = app.ich.user.rolle === 'admin';
  const sichtbar = BEREICHE.filter((b) => (b.gruppe === 'persoenlich' || admin) && (b.id !== 'ausgabe' || nativ));
  const gewaehlt = param?.[0] || '';
  const b = bereichVon(gewaehlt) && sichtbar.includes(bereichVon(gewaehlt)) ? bereichVon(gewaehlt) : bereichVon('wiedergabe');
  const punkt = (x) => `<a href="/einstellungen/${x.id}" data-link class="einst-punkt" data-b="${x.id}" ${x === b && gewaehlt ? 'aria-current="page"' : x === b ? 'data-standard' : ''}>${icon(x.icon, 18)}<span>${h(x.titel)}</span>${x.zusatz ? `<small>${h(x.zusatz)}</small>` : ''}<i class="einst-pfeil">${icon('rechts', 16)}</i></a>`;
  const gruppe = (g, titel) => { const xs = sichtbar.filter((x) => x.gruppe === g); return xs.length ? `<div class="einst-gruppe">${titel}</div>${xs.map(punkt).join('')}` : ''; };
  const text = b.id === 'wiedergabe'
    ? (app.ich.geraet_name ? t('Gilt nur auf diesem Gerät („{name}“) · wird sofort übernommen.', { name: h(app.ich.geraet_name) }) : t('Gilt nur auf diesem Gerät · wird sofort übernommen.'))
    : h(b.text) + (SERVER[b.id] ? ' ' + t('Änderungen sammeln sich unten in einer Leiste, bis du speicherst.') : '');
  ziel.innerHTML = `<div class="einst ${gewaehlt ? 'mit-bereich' : 'ohne-bereich'}">
    <aside class="einst-seite" aria-label="${h(t('Bereiche der Einstellungen'))}">
      <h1 class="einst-titel">${t('Einstellungen')}</h1>
      <div class="einst-suche">${icon('suche', 17)}<input type="search" data-einst-suche placeholder="${h(t('Einstellung suchen …'))}" aria-label="${h(t('Einstellung suchen'))}" autocomplete="off" enterkeyhint="search"></div>
      <div class="einst-treffer" data-einst-treffer hidden></div>
      <nav data-einst-nav>${gruppe('persoenlich', t('Persönlich'))}${gruppe('server', t('Server · nur Admins'))}</nav>
    </aside>
    <section class="einst-inhalt">
      <a href="/einstellungen" data-link class="einst-zurueck">${icon('zurueckPfeil', 16)} ${t('Einstellungen')}</a>
      <div class="einst-kopf"><div><h1>${h(b.titel)}</h1><p>${text}</p></div><div class="einst-chips" data-einst-chips></div></div>
      <div class="einst-karten" data-einst-karten><div class="lade"></div></div>
    </section>
  </div>`;
  sucheVerbinden(app, ziel, admin);
  const inhalt = ziel.querySelector('[data-einst-karten]');
  const zeichner = { konto: kontoZeichnen, wiedergabe: wiedergabeZeichnen, ausgabe: ausgabeZeichnen, bibliothek: bibliothekZeichnen, zugang: zugangZeichnen, raeume: raeumeZeichnen, downloads: downloadsZeichnen, heimnetz: heimnetzZeichnen, sicherung: sicherungZeichnen, system: systemZeichnen }[b.id]
    || ((a, i, s) => serverBereichZeichnen(a, i, b.id, s));
  await zeichner(app, inhalt, signal);
  if (signal?.aborted) return;
  ziel.querySelector('[data-einst-chips]').innerHTML = kopfChips(b.id);
  leisteZeichnen(app);
  zuZeileSpringen(inhalt);
}

/** Beim Verlassen der Einstellungen mit ungespeicherten Serverwerten: Leiste bleibt sichtbar, damit nichts verloren geht */
export function einstellungenOffen() { return offen.size; }


/** Region des Servers (Land, Sprache, Zeitzone, Formate, Währung, Einheiten) – gilt für alle; jedes Konto kann seine Sprache selbst wählen */
async function regionKarte(wurzel, signal) {
  let d;
  try { d = await api.get('/admin/region', { signal }); } catch { wurzel.innerHTML = ''; return; }
  const l = d.laender;
  const r = { ...d.aktuell };
  const nachCode = (c) => l.find((x) => x.code === c);
  const opt = (liste, wahl) => liste.map(([v, tx]) => `<option value="${h(v)}"${v === wahl ? ' selected' : ''}>${h(tx)}</option>`).join('');
  const zeichnen = () => {
    const ld = nachCode(r.land);
    const zonen = ld && ld.zeitzonen.length ? ld.zeitzonen : d.alle_zonen;
    if (!zonen.includes(r.zeitzone)) r.zeitzone = (ld && zonen.includes(ld.zone) ? ld.zone : zonen[0]) || '';
    const dBsp = { dmy: '31.12.2026', mdy: '12/31/2026', ymd: '2026-12-31' };
    const auto = (bsp) => t('Automatisch ({beispiel})', { beispiel: bsp });
    wurzel.innerHTML = `<h2><span>${t('Region')}</span></h2>
      <p class="einst-karten-hinweis">${t('Land, Sprache und Zeitzone legen fest, wie {app} Texte, Datum, Uhrzeit und Preise zeigt. Jede Person kann ihre Sprache später selbst ändern.', { app: 'Amberwave' })}</p>
      <div class="einst-zeile"><div class="einst-text"><div class="einst-name">${t('Land')}</div></div><div class="einst-wert"><select data-r="land"><option value="">–</option>${opt(l.map((x) => [x.code, x.name]), r.land)}</select></div></div>
      <div class="einst-zeile"><div class="einst-text"><div class="einst-name">${t('Sprache / Language')}</div></div><div class="einst-wert"><select data-r="sprache">${opt(Object.entries(d.sprachen), r.sprache || 'en')}</select></div></div>
      <div class="einst-zeile"><div class="einst-text"><div class="einst-name">${t('Zeitzone')}</div></div><div class="einst-wert"><select data-r="zeitzone">${opt(zonen.map((z) => [z, z.replace(/_/g, ' ')]), r.zeitzone)}</select></div></div>
      <div class="einst-zeile"><div class="einst-text"><div class="einst-name">${t('Währung')}</div></div><div class="einst-wert"><select data-r="waehrung">${opt(Object.entries(d.waehrungen).map(([c, n]) => [c, `${c} – ${n}`]), r.waehrung)}</select></div></div>
      <div class="einst-zeile"><div class="einst-text"><div class="einst-name">${t('Datumsformat')}</div></div><div class="einst-wert"><select data-r="datumsformat">${opt([['auto', auto(dBsp[ld ? ld.datumsformat : 'dmy'])], ['dmy', t('Tag Monat Jahr ({beispiel})', { beispiel: dBsp.dmy })], ['mdy', t('Monat Tag Jahr ({beispiel})', { beispiel: dBsp.mdy })], ['ymd', t('Jahr Monat Tag ({beispiel})', { beispiel: dBsp.ymd })]], r.datumsformat)}</select></div></div>
      <div class="einst-zeile"><div class="einst-text"><div class="einst-name">${t('Uhrzeit')}</div></div><div class="einst-wert"><select data-r="zeitformat">${opt([['auto', auto(ld && ld.zeitformat === '12' ? '2:30 PM' : '14:30')], ['24', t('24 Stunden ({beispiel})', { beispiel: '14:30' })], ['12', t('12 Stunden ({beispiel})', { beispiel: '2:30 PM' })]], r.zeitformat)}</select></div></div>
      <div class="einst-zeile"><div class="einst-text"><div class="einst-name">${t('Einheiten')}</div></div><div class="einst-wert"><select data-r="einheiten">${opt([['auto', auto(ld && ld.einheiten === 'imperial' ? t('Fuß, Zoll') : t('Meter, Zentimeter'))], ['metric', t('Meter, Zentimeter')], ['imperial', t('Fuß, Zoll')]], r.einheiten)}</select></div></div>
      <p class="einst-fuss"><button type="button" class="btn" data-r-speichern>${t('Region speichern')}</button> <small>${t('Wirkt nach dem Neuladen der Seite.')}</small></p>`;
    wurzel.querySelectorAll('[data-r]').forEach((el) => el.addEventListener('change', () => {
      const f = el.dataset.r;
      r[f] = el.value;
      if (f === 'land') { const n = nachCode(r.land); r.zeitzone = ''; r.waehrung = n ? n.waehrung : r.waehrung; r.datumsformat = 'auto'; r.zeitformat = 'auto'; r.einheiten = 'auto'; if (n) r.sprache = n.sprache; }
      zeichnen();
    }));
    wurzel.querySelector('[data-r-speichern]').onclick = async () => {
      if (await versuche(() => api.put('/admin/region', { region: r }), t('Region gespeichert'))) setTimeout(() => location.reload(), 600);
    };
  };
  zeichnen();
}
