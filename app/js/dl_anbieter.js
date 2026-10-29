// Einstellungen › Downloads: Suchanbieter (Prowlarr, Newznab-Indexer) und Downloadclients (SABnzbd-kompatibel) verwalten.
// Der erste Eintrag jeder Liste ist der „Standard“ aus den bisherigen Einstellungen (bzw. der .env) – er bleibt immer da.
// Schlüssel kommen nie zurück an den Browser: leeres Feld beim Bearbeiten = gespeicherter Schlüssel bleibt.
import { api, versuche } from './api.js';
import { h, icon, dialog, bestaetigen } from './ui.js';
import { t } from './i18n.js';

const ARTEN = {
  prowlarr: { name: 'Prowlarr', text: () => t('Sucht über alle in Prowlarr eingerichteten Indexer (JSON-API).') },
  newznab: { name: 'Newznab', text: () => t('Ein Indexer direkt über seine Newznab-Schnittstelle (XML) – ohne Prowlarr.') },
  sabnzbd: { name: 'SABnzbd', text: () => t('SABnzbd oder ein Dienst mit derselben Schnittstelle.') },
};

const pruefZeilen = (res) => Object.values(res.pruefungen || {}).map((x) => `${x.ok === null ? '?' : x.ok ? '✓' : '✗'} ${x.text}${x.ok !== true && x.tipp ? `\n    → ${x.tipp}` : ''}`).join('\n');

/**
 * Panel zeichnen. box: leeres Element; signal: Abbruch beim Verlassen der Seite.
 */
export function downloadAnbieterPanel(box, signal) {
  let stand = null;
  const zustand = new Map();   // "art:id" → letzte Prüfung { ok, text }

  const clientName = (id) => stand?.clients.find((c) => c.id === id)?.name || t('Standard');
  const chipFuer = (d) => {
    const z = zustand.get(`${d.art}:${d.id}`);
    if (!d.aktiv) return `<span class="einst-chip">${t('aus')}</span>`;
    if (!d.url || !d.key_gesetzt) return `<span class="einst-chip warn">${t('nicht eingerichtet')}</span>`;
    if (z) return `<span class="einst-chip ${z.ok ? 'gut' : z.ok === null ? '' : 'warn'}" title="${h(z.text)}">${z.ok ? t('verbunden') : z.ok === null ? t('prüfen') : t('Fehler')}</span>`;
    return `<span class="einst-chip">${t('eingerichtet')}</span>`;
  };
  const zeileHtml = (d) => {
    const z = zustand.get(`${d.art}:${d.id}`);
    const unter = d.art === 'sabnzbd'
      ? [d.url ? d.url + (d.api_pfad && d.api_pfad !== '/api' ? d.api_pfad : '') : t('keine Adresse'), t('Kategorie „{k}“', { k: d.kategorie }), t('Import aus {pfad}', { pfad: d.import_pfad })]
      : [d.url || t('keine Adresse'), t('Kategorien {k}', { k: d.kategorien }), t('→ lädt mit {client}', { client: clientName(d.client_id) }),
        ...(d.art === 'newznab' && d.caps ? [d.caps.music?.an ? t('Musiksuche') : t('nur allgemeine Suche')] : [])];
    return `<div class="dla-zeile${d.aktiv ? '' : ' aus'}" data-dla="${d.art}:${d.id}">
      <div class="dla-text"><span class="dla-name">${h(d.name)} <small>${[d.name !== ARTEN[d.art].name ? ARTEN[d.art].name : '', d.standard ? t('Standard') : ''].filter(Boolean).map(h).join(' · ')}${d.env?.url || d.env?.key ? ` · ${t('aus der .env')}` : ''}</small></span>
        <small>${unter.map(h).join(' · ')}</small>${z && z.ok !== true ? `<small class="dla-fehler">${h(z.text)}</small>` : ''}</div>
      ${chipFuer(d)}
      <span class="dla-knoepfe">
        <button type="button" class="btn btn-zweit btn-klein" data-dla-test>${t('Testen')}</button>
        <button type="button" class="btn btn-zweit btn-klein" data-dla-bearbeiten>${t('Bearbeiten')}</button>
        ${d.standard ? '' : `<button type="button" class="btn-ico" data-dla-weg title="${h(t('Entfernen'))}" aria-label="${h(t('Entfernen'))}">${icon('muell', 16)}</button>`}
      </span>
    </div>`;
  };

  const zeichnen = () => {
    if (!box.isConnected || !stand) return;
    const mehrereClients = stand.clients.length > 1;
    box.innerHTML = `<div class="einst-karte" data-k="suchanbieter"><h2><span>${t('Suchanbieter')}</span>
        <span class="dla-neu"><button type="button" class="btn btn-zweit btn-klein" data-dla-neu="newznab">${t('+ Newznab-Indexer')}</button><button type="button" class="btn btn-zweit btn-klein" data-dla-neu="prowlarr">${t('+ Prowlarr')}</button></span></h2>
        <p class="einst-karten-hinweis">${t('Gesucht wird bei allen eingeschalteten Anbietern gleichzeitig; gleiche Releases werden zusammengefasst. Jeder Anbieter lädt mit dem Downloadclient, der ihm zugeordnet ist.')}</p>
        <div class="dla-liste">${stand.indexer.map(zeileHtml).join('')}</div></div>
      <div class="einst-karte" data-k="downloadclients"><h2><span>${t('Downloadclients')}</span>
        <span class="dla-neu"><button type="button" class="btn btn-zweit btn-klein" data-dla-neu="sabnzbd">${t('+ SABnzbd')}</button></span></h2>
        <p class="einst-karten-hinweis">${mehrereClients
          ? t('Jeder Client hat seinen eigenen Import-Ordner – ein Unterordner des Download-Ordners ({pfad}), in dem seine fertigen Downloads liegen.', { pfad: stand.download_pfad })
          : t('Fertige Downloads liest Amberwave aus {pfad} (DOWNLOAD_PFAD). Weitere Clients bekommen je einen Unterordner davon.', { pfad: stand.download_pfad })}</p>
        <div class="dla-liste">${stand.clients.map(zeileHtml).join('')}</div></div>
      <div class="einst-karte" data-k="downloads_pruefen"><h2><span>${t('Gesamtprüfung')}</span><button type="button" class="btn btn-zweit btn-klein" data-dla-alles>${t('Alles prüfen')}</button></h2>
        <p class="einst-karten-hinweis">${t('Prüft jeden Anbieter und Client, ihre Ordner und ob sie zusammenpassen.')}</p><pre class="log einst-log" data-dla-log hidden></pre></div>`;
    box.querySelectorAll('[data-dla-neu]').forEach((b) => b.addEventListener('click', () => bearbeiten({ art: b.dataset.dlaNeu, id: null })));
    box.querySelectorAll('[data-dla]').forEach((z) => {
      const [art, id] = z.dataset.dla.split(':');
      const d = finden(art, Number(id));
      z.querySelector('[data-dla-bearbeiten]').addEventListener('click', () => bearbeiten(d));
      z.querySelector('[data-dla-test]').addEventListener('click', (e) => testen(d, e.currentTarget));
      z.querySelector('[data-dla-weg]')?.addEventListener('click', () => loeschen(d));
    });
    box.querySelector('[data-dla-alles]').addEventListener('click', async (e) => {
      const knopf = e.currentTarget;
      const log = box.querySelector('[data-dla-log]');
      log.hidden = false; log.textContent = t('Prüfe …'); knopf.disabled = true;
      try { const res = await api.post('/admin/downloads/test', {}); log.textContent = pruefZeilen(res) + (res.ok ? '\n\n' + t('Alles in Ordnung.') : ''); } catch (err) { log.textContent = err.message; }
      knopf.disabled = false;
    });
  };
  const finden = (art, id) => (art === 'sabnzbd' ? stand.clients : stand.indexer).find((x) => x.art === art && x.id === id);

  const testen = async (d, knopf) => {
    if (knopf) { knopf.disabled = true; knopf.textContent = t('Prüfe …'); }
    try {
      const res = await api.post('/admin/downloads/dienste/test', { dienst: { id: d.id, art: d.art, name: d.name, url: d.url, api_pfad: d.api_pfad, kategorien: d.kategorien, kategorie: d.kategorie, import_ordner: d.import_ordner, client_id: d.client_id, musiksuche: d.musiksuche } });
      const p = Object.values(res.pruefungen || {});
      const schlecht = p.find((x) => x.ok === false) || p.find((x) => x.ok === null);
      zustand.set(`${d.art}:${d.id}`, { ok: res.ok ? true : schlecht?.ok ?? false, text: (schlecht || p[0])?.text || '' });
    } catch (e) { zustand.set(`${d.art}:${d.id}`, { ok: false, text: e.message }); }
    zeichnen();
  };

  const loeschen = async (d) => {
    if (!(await bestaetigen(t('„{name}“ entfernen?', { name: d.name }), d.art === 'sabnzbd' ? t('Suchanbieter, die diesen Client nutzen, laden danach mit dem Standard-Client. Fertige Aufträge bleiben in der Liste.') : t('Der Anbieter wird nicht mehr durchsucht.'), t('Entfernen'), true))) return;
    const r = await versuche(() => api.post('/admin/downloads/dienste/loeschen', { art: d.art, id: d.id }), t('Entfernt'));
    if (r) { stand = r; zeichnen(); }
  };

  const bearbeiten = async (d0) => {
    const neu = d0.id == null;
    const art = d0.art;
    const d = neu ? { art, name: '', url: '', api_pfad: art === 'prowlarr' ? '' : '/api', kategorien: '3000', kategorie: 'music', import_ordner: '', client_id: 0, musiksuche: true, aktiv: true, key_gesetzt: false } : d0;
    const clients = stand.clients.map((c) => `<option value="${c.id}" ${c.id === d.client_id ? 'selected' : ''}>${h(c.name)}${c.aktiv ? '' : ` (${t('aus')})`}</option>`).join('');
    const feld = (id, label, html, hinweis = '') => `<label for="dla-${id}">${label}</label>${html}${hinweis ? `<p class="hinweis" style="margin:4px 0 10px">${hinweis}</p>` : ''}`;
    const envHinweis = d.standard && (d.env?.url || d.env?.key) ? `<p class="hinweis" style="margin:0 0 10px">${t('Adresse oder Schlüssel kommen aus der .env – was du hier speicherst, gilt dann statt der .env.')}</p>` : '';
    const inhalt = `${envHinweis}<p class="hinweis" style="margin:0 0 12px">${h(ARTEN[art].text())}</p>
      ${feld('name', t('Name'), `<input id="dla-name" name="name" value="${h(d.name)}" maxlength="80" placeholder="${h(ARTEN[art].name)}">`)}
      ${feld('url', t('Adresse'), `<input id="dla-url" name="url" type="url" value="${h(d.url)}" placeholder="${art === 'prowlarr' ? 'http://192.168.1.10:9696' : art === 'sabnzbd' ? 'http://192.168.1.10:8080' : 'https://indexer.example'}" ${d.standard ? '' : 'required'}>`)}
      ${art !== 'prowlarr' ? feld('pfad', t('API-Pfad'), `<input id="dla-pfad" name="api_pfad" value="${h(d.api_pfad || '/api')}" placeholder="/api">`,
        art === 'sabnzbd' ? t('Meist /api. Läuft SABnzbd hinter einem Proxy mit Basis-URL: z. B. /sabnzbd/api. SABnzbd-kompatible Dienste nennen ihren Pfad, z. B. /api/sabnzbd.') : t('Meist /api – die Adresse wird zu Adresse + API-Pfad + ?t=…')) : ''}
      ${feld('key', t('API-Schlüssel'), `<input id="dla-key" name="key" type="password" autocomplete="off" placeholder="${d.key_gesetzt ? h(t('gespeichert – leer lassen, um ihn zu behalten')) : ''}" ${neu ? 'required' : ''}>`,
        art === 'prowlarr' ? t('Settings → General → API Key.') : art === 'sabnzbd' ? t('Config → General → Security → API Key.') : t('Im Profil des Indexers.'))}
      ${art === 'sabnzbd'
        ? feld('kat', t('Kategorie'), `<input id="dla-kat" name="kategorie" value="${h(d.kategorie || 'music')}" maxlength="60">`, t('Muss es im Client geben.'))
          + feld('ordner', t('Import-Ordner'), `<input id="dla-ordner" name="import_ordner" value="${h(d.import_ordner || '')}" placeholder="${h(t('leer = der Download-Ordner selbst'))}">`,
            t('Unterordner im Download-Ordner ({pfad}), in dem dieser Client die Kategorie ablegt – z. B. „sab2“, wenn du dessen Ordner dort eingebunden hast.', { pfad: stand.download_pfad }))
        : feld('kats', t('Kategorien (Newznab)'), `<input id="dla-kats" name="kategorien" value="${h(d.kategorien || '3000')}" placeholder="3000">`, t('3000 = Audio, 3010 = MP3, 3040 = Lossless – mehrere mit Komma.'))
          + feld('client', t('Lädt mit'), `<select id="dla-client" name="client_id">${clients}</select>`, t('An diesen Downloadclient gehen die NZB-Dateien dieses Anbieters.'))
          + (art === 'newznab' ? `<label class="checkbox-zeile"><input type="checkbox" name="musiksuche" value="1" ${d.musiksuche !== false ? 'checked' : ''}><span>${t('Musiksuche nutzen (t=music mit Künstler und Album), wenn der Indexer sie anbietet')}</span></label>` : '')}
      <label class="checkbox-zeile"><input type="checkbox" name="aktiv" value="1" ${d.aktiv !== false ? 'checked' : ''}><span>${t('Eingeschaltet')}</span></label>
      <div class="dla-test"><button type="button" class="btn btn-zweit btn-klein" data-dla-dialog-test>${t('Verbindung testen')}</button><pre class="log einst-log" data-dla-dialog-log hidden></pre></div>`;
    const werte = (form) => ({
      id: neu ? null : d.id, art, name: form.get('name') || '', url: form.get('url') || '', api_pfad: form.get('api_pfad') || '', key: form.get('key') || '',
      kategorien: form.get('kategorien') || '', kategorie: form.get('kategorie') || '', import_ordner: form.get('import_ordner') || '',
      client_id: Number(form.get('client_id') || 0), musiksuche: form.get('musiksuche') === '1', aktiv: form.get('aktiv') === '1',
    });
    const r = await dialog({
      titel: neu ? t('{art} hinzufügen', { art: ARTEN[art].name }) : t('{name} bearbeiten', { name: d.name }), inhalt, breit: true,
      knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: t('Speichern'), wert: 'ok' }],
      beimOeffnen: (el) => {
        const form = el.querySelector('form');
        el.querySelector('[data-dla-dialog-test]').addEventListener('click', async (e) => {
          const knopf = e.currentTarget;
          const log = el.querySelector('[data-dla-dialog-log]');
          log.hidden = false; log.textContent = t('Prüfe …'); knopf.disabled = true;
          const w = werte(new FormData(form));
          try { const res = await api.post('/admin/downloads/dienste/test', { dienst: { ...w, id: neu ? -1 : d.id } }); log.textContent = pruefZeilen(res) + (res.ok ? '\n\n' + t('Alles in Ordnung.') : ''); } catch (err) { log.textContent = err.message; }
          knopf.disabled = false;
        });
      },
    });
    if (!r) return;
    const w = werte(r.form);
    const neuStand = await versuche(() => api.post('/admin/downloads/dienste', { dienst: w }), t('Gespeichert'));
    if (!neuStand) return;
    stand = neuStand;
    zeichnen();
    const id = neu ? neuStand.gespeichert : d.id;
    const x = finden(art, id);
    if (x && x.aktiv && x.url && x.key_gesetzt) testen(x, box.querySelector(`[data-dla="${art}:${id}"] [data-dla-test]`));
  };

  api.get('/admin/downloads/dienste', { signal }).then((r) => { stand = r; zeichnen(); }).catch((e) => { if (!signal?.aborted) box.innerHTML = `<p class="hinweis">${h(e.message)}</p>`; });
}

