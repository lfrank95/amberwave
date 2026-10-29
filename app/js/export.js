// WAV-Export: Playlist/Warteschlange als EINE lange WAV-Datei (z. B. für den USB-Player eines Mischpults wie dem X32)
import { api, versuche } from './api.js';
import { h, icon, dialog, toast, dauerText, groesse, datumZeit, bestaetigen } from './ui.js';
import { LAUTHEIT_ZIELE } from './player.js';
import { netzweg } from './netzweg.js';
import { t, tn, zahl } from './i18n.js';

const UEBERGAENGE = [
  ['nahtlos', t('Nahtlos – Titel direkt aneinander')],
  ['p1', t('Pause 1 s')], ['p2', t('Pause 2 s')], ['p3', t('Pause 3 s')],
  ['b2', t('Überblenden 2 s')], ['b4', t('Überblenden 4 s')], ['b6', t('Überblenden 6 s')],
];

const komma = (x) => zahl(x);

/** Grobe Größe: 16 Bit Stereo = 4 Byte je Sample */
function schaetzung(laengeMs, rate) {
  const bytes = (laengeMs / 1000) * rate * 4;
  const teile = Math.max(1, Math.ceil(bytes / 4.0e9));
  return { bytes, teile };
}

/**
 * Export-Dialog. quelle: { art: 'playlist', id } oder { art: 'tracks', track_ids }, dazu name, anzahl, laenge_ms
 */
export async function exportDialog(app, quelle) {
  const pl = app.player;
  const ziel = Number(pl.einst.lautheit_ziel) || -16;
  const d = await dialog({
    titel: t('Als WAV exportieren'),
    inhalt: `<p class="hinweis" style="margin-top:0">${t('Alle {n} Titel ({dauer}) als <b>eine</b> WAV-Datei, 16 Bit Stereo – z. B. für den USB-Player am Mischpult (X32 & Co. spielen zwischen einzelnen Dateien mit Lücke). Läuft auf dem Server im Hintergrund.', { n: quelle.anzahl, dauer: dauerText(quelle.laenge_ms) })}</p>
      <label for="ex-name">${t('Name')}</label><input id="ex-name" type="text" name="name" value="${h(quelle.name)}" maxlength="120" required>
      <div class="zweispaltig-klein">
        <div><label for="ex-rate">${t('Abtastrate')}</label>
          <select id="ex-rate" name="rate"><option value="44100" selected>${zahl(44.1)} kHz</option><option value="48000">48 kHz</option></select></div>
        <div><label for="ex-ue">${t('Übergang')}</label>
          <select id="ex-ue" name="uebergang">${UEBERGAENGE.map(([w, tx]) => `<option value="${w}">${h(tx)}</option>`).join('')}</select></div>
      </div>
      <div class="zweispaltig-klein">
        <div><label for="ex-lh">${t('Lautstärke')}</label>
          <select id="ex-lh" name="lautheit">
            <option value="auto" selected>${t('Angleichen – Alben als Ganzes')}</option>
            <option value="titel">${t('Angleichen – jeder Titel einzeln')}</option>
            <option value="aus">${t('Unverändert (wie gemastert)')}</option>
          </select></div>
        <div><label for="ex-ziel">${t('Zielwert')}</label>
          <select id="ex-ziel" name="ziel">${LAUTHEIT_ZIELE.map(([w, tx]) => `<option value="${w}" ${w === ziel ? 'selected' : ''}>${h(tx)}</option>`).join('')}</select></div>
      </div>
      <label class="checkbox-zeile" style="margin-top:14px;align-items:flex-start"><input type="checkbox" name="stille" value="1" checked style="margin-top:3px">
        <span>${t('Stille am Anfang und Ende der Titel entfernen')}<br><small style="color:var(--text-muted)">${t('Unter −60 dBFS. Titel, die im Album direkt aufeinander folgen (Live-Alben, DJ-Mixe), bleiben immer nahtlos – dort gibt es auch keine Pause und keine Überblendung.')}</small></span></label>
      <p class="hinweis" data-ex-groesse style="margin:14px 0 0"></p>`,
    knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Export starten'), wert: 'ok' }],
    beimOeffnen: (dlg) => {
      const zeigen = () => {
        const rate = Number(dlg.querySelector('[name=rate]').value);
        const s = schaetzung(quelle.laenge_ms, rate);
        dlg.querySelector('[data-ex-groesse]').textContent = s.teile > 1
          ? t('Ungefähr {groesse} – wird in {n} Dateien unter 4 GB geteilt (Grenze von FAT32-USB-Sticks und WAV), jeweils an einer Titelgrenze.', { groesse: groesse(s.bytes), n: s.teile })
          : t('Ungefähr {groesse}.', { groesse: groesse(s.bytes) });
        dlg.querySelector('[name=ziel]').disabled = dlg.querySelector('[name=lautheit]').value === 'aus';
      };
      dlg.querySelectorAll('select').forEach((s) => s.addEventListener('change', zeigen));
      zeigen();
    },
  });
  if (!d) return;
  const f = d.form;
  const ue = String(f.get('uebergang') || 'nahtlos');
  const optionen = {
    rate: Number(f.get('rate')), lautheit: f.get('lautheit'), ziel: Number(f.get('ziel') || ziel),
    pause: ue.startsWith('p') ? Number(ue.slice(1)) : 0, ueberblenden: ue.startsWith('b') ? Number(ue.slice(1)) : 0,
    stille: f.get('stille') === '1',
  };
  const r = await versuche(() => api.post('/export', { ...quelle, name: f.get('name'), optionen }));
  if (r) exportVerfolgen(r);
}

function teileHtml(e) {
  if (e.status !== 'fertig') return '';
  return `<div class="export-dateien">${e.teile.map((tl) => `<a class="btn" href="${h(netzweg.url(tl.url))}" download>${icon('download', 18)}<span>${h(tl.name)}</span><small>${groesse(tl.groesse)} · ${dauerText(tl.dauer * 1000)}</small></a>`).join('')}
    ${e.titelliste_url ? `<a class="btn btn-zweit" href="${h(netzweg.url(e.titelliste_url))}" download>${icon('download', 18)}<span>${t('Titelliste (.txt)')}</span></a>` : ''}</div>`;
}

function zustandHtml(e) {
  if (e.status === 'fertig') {
    return `<p style="margin-top:0">${t('✓ Fertig: {dateien}, {dauer} · {rate} kHz / 16 Bit.', { dateien: tn(e.teile.length, 'eine Datei', '{n} Dateien'), dauer: dauerText(e.dauer * 1000), rate: komma(e.optionen.rate / 1000) })}</p>
      ${teileHtml(e)}
      <p class="hinweis" style="margin:12px 0 0">${netzweg.erreichbar ? t('Lädt direkt im Heimnetz (volle Geschwindigkeit).') + ' ' : ''}${t('Liegt bis {zeit} bereit (auch unter Profil → WAV-Exporte). Für den X32: Datei auf einen FAT32-formatierten Stick kopieren.', { zeit: datumZeit(e.loeschen_am) })}</p>`;
  }
  if (e.status === 'fehler') return `<p style="color:var(--accent-text);margin-top:0">✗ ${h(e.fehler || t('Fehler'))}</p>`;
  if (e.status === 'abgebrochen') return `<p style="margin-top:0">${t('Abgebrochen.')}</p>`;
  return `<p style="margin-top:0">${h(e.schritt || t('läuft …'))}</p>
    <div class="fortschritt" role="progressbar" aria-valuenow="${Math.round(e.fortschritt)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${e.fortschritt}%"></i></div>
    <p class="hinweis" style="margin:0">${Math.round(e.fortschritt)} % · ${t('Du kannst dieses Fenster schließen – der Export läuft weiter.')}</p>`;
}

/** Fortschritt anzeigen, bis der Export fertig ist; danach die Download-Knöpfe */
export function exportVerfolgen(e) {
  let timer = null;
  dialog({
    titel: t('WAV-Export: {name}', { name: e.name }),
    inhalt: `<div data-ex-zustand>${zustandHtml(e)}</div>`,
    knoepfe: [{ text: t('Schließen'), wert: 'abbrechen', art: 'zweit' }],
    beimOeffnen: (dlg) => {
      const box = dlg.querySelector('[data-ex-zustand]');
      const holen = async () => {
        if (!dlg.isConnected) return;
        try {
          const n = await api.get(`/export/${e.id}`);
          box.innerHTML = zustandHtml(n);
          if (n.status === 'wartet' || n.status === 'laeuft') timer = setTimeout(holen, 1000);
          else if (n.status === 'fertig') toast(t('WAV-Export fertig'));
        } catch (x) { timer = setTimeout(holen, 3000); }
      };
      if (e.status === 'wartet' || e.status === 'laeuft') timer = setTimeout(holen, 800);
      dlg.addEventListener('close', () => clearTimeout(timer));
    },
  });
}

/** Liste der eigenen Exporte (Profilseite) */
export async function exportListe(box) {
  let r;
  try { r = await api.get('/export'); } catch (x) { box.hidden = true; return; }
  if (!r.exporte.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<h2 style="font-size:1.2rem;margin-bottom:4px">${t('WAV-Exporte')}</h2>
    <p class="hinweis" style="margin:0 0 10px">${t('Playlists als eine lange WAV-Datei. Werden nach einiger Zeit automatisch gelöscht.')}</p>
    ${r.exporte.map((e) => `<div class="export-zeile">
      <div style="min-width:0;flex:1"><b>${h(e.name)}</b><small style="display:block;color:var(--text-muted)">${h(e.quelle)} · ${tn(e.titel, 'ein Titel', '{n} Titel')} · ${
        e.status === 'fertig' ? `${dauerText(e.dauer * 1000)} · ${groesse(e.teile.reduce((s, tl) => s + tl.groesse, 0))}` : e.status === 'fehler' ? t('Fehler') : e.status === 'abgebrochen' ? t('abgebrochen') : t('läuft · {fortschritt} %', { fortschritt: Math.round(e.fortschritt) })}</small></div>
      ${e.status === 'fertig' || e.status === 'wartet' || e.status === 'laeuft' ? `<button type="button" class="btn btn-zweit btn-klein" data-ex-oeffnen="${e.id}">${e.status === 'fertig' ? t('Herunterladen') : t('Fortschritt')}</button>` : ''}
      <button type="button" class="btn-ico" data-ex-weg="${e.id}" aria-label="${h(t('Export löschen'))}">${icon('muell', 18)}</button>
    </div>`).join('')}`;
  box.querySelectorAll('[data-ex-oeffnen]').forEach((b) => b.addEventListener('click', () => {
    exportVerfolgen(r.exporte.find((x) => x.id === Number(b.dataset.exOeffnen)));
  }));
  box.querySelectorAll('[data-ex-weg]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await bestaetigen(t('Export löschen?'), t('Die WAV-Datei wird auf dem Server gelöscht.'), t('Löschen'), true))) return;
    if (await versuche(() => api.del(`/export/${b.dataset.exWeg}`))) exportListe(box);
  }));
}
