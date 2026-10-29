// VST3-Plug-ins im Windows Client: Plug-in-Browser mit Suche, Probelauf und Editor zum Testen, Logs und Diagnosedatei.
// Stufe 1 – die Plug-ins laufen noch nicht in der Klangkette; hier wird geprüft, dass sich jedes laden, rechnen und zeigen lässt.
import { h, toast } from './ui.js';
import { nativ } from './nativ.js';
import { t, tn, zahl, locale } from './i18n.js';
const api = () => nativ?.vst || window.__awVst;

const zeitText = (ms) => (ms ? new Date(ms).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' }) : t('noch nie'));
const dB = (x) => (x <= -170 ? '−∞' : `${zahl(x, 1).replace('-', '−')} dB`);

export function vstKarte(inhalt, signal) {
  if (!nativ?.vst) return;
  const karte = document.createElement('div');
  karte.className = 'einst-karte vst-karte';
  karte.innerHTML = `
    <h2><span>VST3-Plug-ins</span><span class="einst-chip" data-vst-zahl>…</span></h2>
    <p class="einst-karten-hinweis">${t('Eigene Effekt-Plug-ins (Stereo) für den Signalweg. Du bringst sie selbst mit; Amberwave sucht sie in <code>C:\\Program Files\\Common Files\\VST3</code> und in den Ordnern, die du hier ergänzt. Jedes Plug-in läuft in einem eigenen Prozess – stürzt eines ab, läuft die Musik weiter.')}</p>
    <div class="vst-leiste">
      <input type="search" class="einst-feld vst-suche" placeholder="${t('Plug-ins durchsuchen …')}" aria-label="${t('Plug-ins durchsuchen')}" data-vst-suche>
      <button type="button" class="btn btn-zweit btn-klein" data-vst-scan>${t('Neu suchen')}</button>
    </div>
    <div class="vst-status" data-vst-status aria-live="polite"></div>
    <div class="vst-liste" data-vst-liste></div>
    <div class="vst-fuss">
      <label class="vst-ordner"><span>${t('Zusätzliche Ordner (einer pro Zeile)')}</span><textarea class="einst-feld" rows="2" data-vst-ordner spellcheck="false" placeholder="D:\\Plugins\\VST3"></textarea></label>
      <div class="vst-knoepfe">
        <button type="button" class="btn btn-zweit btn-klein" data-vst-ordner-ok>${t('Ordner übernehmen')}</button>
        <button type="button" class="btn btn-zweit btn-klein" data-vst-log>${t('Log-Ordner öffnen')}</button>
        <button type="button" class="btn btn-zweit btn-klein" data-vst-diag>${t('Diagnosedatei erstellen')}</button>
      </div>
      <p class="einst-karten-hinweis">${t('Wenn etwas schiefgeht: „Diagnosedatei erstellen“ legt eine Textdatei mit Systemangaben und den letzten Log-Zeilen auf den Desktop – die schickst du mir.')}</p>
    </div>`;
  inhalt.appendChild(karte);
  const $ = (s) => karte.querySelector(s);
  let stand = { plugins: [], fehler: [], ordner: [], zeit: 0 };
  const proben = new Map();   // pfad|cid → Ergebnis

  const zeichnen = () => {
    const q = $('[data-vst-suche]').value.trim().toLocaleLowerCase(locale);
    const liste = stand.plugins.filter((p) => !q || `${p.name} ${p.anbieter} ${p.unter}`.toLocaleLowerCase(locale).includes(q));
    $('[data-vst-zahl]').textContent = t('{n} gefunden', { n: stand.plugins.length });
    const kopf = `<p class="vst-hinweis">${stand.zeit ? t('Zuletzt gesucht: {zeit}', { zeit: h(zeitText(stand.zeit)) }) : t('Noch nicht gesucht.')}${stand.fehler.length ? ` · ${tn(stand.fehler.length, 'eine Datei nicht ladbar', '{n} Dateien nicht ladbar')}` : ''}</p>`;
    const zeilen = liste.map((p) => {
      const k = `${p.pfad}|${p.cid}`, r = proben.get(k);
      const ergebnis = r === 'laeuft' ? `<span class="vst-erg">${t('Prüfe …')}</span>`
        : r ? (r.ok ? `<span class="vst-erg gut">${t('Läuft · {parameter} Parameter · Latenz {latenz} Samples · {oberflaeche} · Rechenzeit {ms} ms je {block} ms · Rauschen {ein} → {aus}', { parameter: r.parameter, latenz: r.latenz, oberflaeche: r.editor ? t('Oberfläche ja') : t('ohne Oberfläche'), ms: zahl(r.ms_mittel), block: zahl(r.block_ms), ein: dB(r.ein_rms), aus: dB(r.aus_rms) })}${r.ungueltig ? ` · <b>${tn(r.ungueltig, 'ein ungültiger Wert', '{n} ungültige Werte')}</b>` : ''}</span>` : `<span class="vst-erg fehler">${h(r.text || t('Fehler'))}</span>`)
          : '';
      return `<div class="vst-zeile" data-k="${h(k)}">
        <div class="vst-name"><b>${h(p.name)}</b><small>${h(p.anbieter || '')}${p.unter ? ` · ${h(p.unter.replace(/\|/g, ' · '))}` : ''}${p.version ? ` · ${h(p.version)}` : ''}</small>${ergebnis}</div>
        <div class="vst-aktion">
          <button type="button" class="btn btn-zweit btn-klein" data-vst-probe>${t('Prüfen')}</button>
          <button type="button" class="btn btn-zweit btn-klein" data-vst-editor>${t('Oberfläche')}</button>
        </div>
      </div>`;
    }).join('');
    const leer = !stand.plugins.length ? `<p class="einst-leer">${t('Keine Plug-ins gefunden. „Neu suchen“ durchsucht die Ordner; fehlt deines, trag den Ordner unten ein.')}</p>` : (!liste.length ? `<p class="einst-leer">${t('Nichts passt zur Suche.')}</p>` : '');
    const probleme = stand.fehler.length ? `<details class="vst-probleme"><summary>${tn(stand.fehler.length, 'eine Datei nicht ladbar', '{n} Dateien nicht ladbar')}</summary>${stand.fehler.map((f) => `<p><code>${h(f.pfad)}</code><br>${h(f.text)}</p>`).join('')}</details>` : '';
    $('[data-vst-liste]').innerHTML = kopf + zeilen + leer + probleme;
  };

  const laden = async () => {
    stand = (await nativ.vst.liste().catch(() => null)) || stand;
    $('[data-vst-ordner]').value = (stand.ordner || []).filter((o) => !/Common Files|Programs[\\/]Common/i.test(o)).join('\n');
    zeichnen();
  };

  let aus = null;
  const scan = async (komplett) => {
    const b = $('[data-vst-scan]');
    b.disabled = true;
    aus?.();
    aus = nativ.vst.aufFortschritt((f) => { $('[data-vst-status]').textContent = t('Suche {i} von {n} …', { i: f.i, n: f.n }); });
    signal?.addEventListener('abort', () => aus?.());
    try {
      stand = (await nativ.vst.scannen(komplett)) || stand;
      toast(tn(stand.plugins.length, 'ein Plug-in gefunden', '{n} Plug-ins gefunden'), 'gut');
    } catch (e) { toast(t('Suche fehlgeschlagen'), 'fehler'); }
    aus?.(); aus = null;
    $('[data-vst-status]').textContent = '';
    b.disabled = false;
    zeichnen();
  };

  $('[data-vst-suche]').addEventListener('input', zeichnen);
  $('[data-vst-scan]').addEventListener('click', (e) => scan(e.shiftKey));
  $('[data-vst-ordner-ok]').addEventListener('click', async () => {
    const liste = $('[data-vst-ordner]').value.split('\n').map((x) => x.trim()).filter(Boolean);
    const s = await nativ.vst.ordnerSetzen(liste).catch(() => null);
    if (!s) { toast(t('Nicht gespeichert'), 'fehler'); return; }
    stand = s; toast(t('Ordner gespeichert – jetzt „Neu suchen“'), 'gut'); zeichnen();
  });
  $('[data-vst-log]').addEventListener('click', () => nativ.vst.logOeffnen());
  $('[data-vst-diag]').addEventListener('click', async () => {
    const r = await nativ.vst.diagnose().catch(() => null);
    toast(r?.ok ? t('Diagnosedatei liegt auf dem Desktop') : r?.text ? t('Diagnosedatei fehlgeschlagen: {text}', { text: r.text }) : t('Diagnosedatei fehlgeschlagen'), r?.ok ? 'gut' : 'fehler');
  });
  $('[data-vst-liste]').addEventListener('click', async (e) => {
    const zeile = e.target.closest('.vst-zeile');
    if (!zeile) return;
    const k = zeile.dataset.k, [pfad, cid] = [k.slice(0, k.lastIndexOf('|')), k.slice(k.lastIndexOf('|') + 1)];
    if (e.target.closest('[data-vst-probe]')) {
      proben.set(k, 'laeuft'); zeichnen();
      const r = await nativ.vst.probe(pfad, cid).catch((x) => ({ ok: false, text: String(x) }));
      proben.set(k, r || { ok: false, text: t('keine Antwort') }); zeichnen();
    } else if (e.target.closest('[data-vst-editor]')) {
      const b = e.target.closest('button'); b.disabled = true;
      const r = await nativ.vst.editor(pfad, cid).catch((x) => ({ ok: false, text: String(x) }));
      b.disabled = false;
      if (r && r.ok === false) toast(r.text || t('Oberfläche nicht geöffnet'), 'fehler');
    }
  });

  laden().then(() => { if (!stand.zeit) scan(false); });
}

/**
 * Plug-in-Auswahl fürs Rack: Suche + Liste der gefundenen Plug-ins, ein Klick legt es in den nächsten freien Slot.
 * (Wie die anderen Auswahlfenster des Racks unter dem Knopf, am Handy als Blatt.)
 */
export async function vstWaehler(anker) {
  document.querySelector('.fx-wahl.vst-wahl')?.remove();
  document.querySelector('.fx-wahl-grund.vst-wahl-grund')?.remove();
  const blatt = matchMedia('(max-width: 700px)').matches;
  const el = document.createElement('div');
  el.className = `fx-wahl vst-wahl${blatt ? ' blatt' : ''}`;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', t('VST3-Plug-in hinzufügen'));
  const grund = blatt ? document.createElement('div') : null;
  if (grund) { grund.className = 'fx-wahl-grund vst-wahl-grund'; document.body.appendChild(grund); }
  document.body.appendChild(el);
  let liste = [];
  const zu = () => { el.remove(); grund?.remove(); document.removeEventListener('pointerdown', aussen, true); document.removeEventListener('keydown', taste, true); };
  const aussen = (e) => { if (!el.contains(e.target) && !anker.contains(e.target)) { e.stopPropagation(); zu(); } };
  const taste = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); zu(); } };
  document.addEventListener('pointerdown', aussen, true);
  document.addEventListener('keydown', taste, true);
  const platzieren = () => {
    if (blatt) return;
    const r = anker.getBoundingClientRect(), b = el.offsetWidth;
    el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - b - 8))}px`;
    const oben = r.bottom + 6 + Math.min(el.scrollHeight, 420) > window.innerHeight - 8 && r.top > window.innerHeight - r.bottom;
    if (oben) { el.style.top = ''; el.style.bottom = `${Math.round(window.innerHeight - r.top + 6)}px`; el.style.maxHeight = `${Math.round(r.top - 14)}px`; }
    else { el.style.bottom = ''; el.style.top = `${Math.round(r.bottom + 6)}px`; el.style.maxHeight = `${Math.round(window.innerHeight - r.bottom - 14)}px`; }
  };
  el.innerHTML = `${blatt ? '<div class="fx-wahl-zug"></div>' : ''}<div class="fx-wahl-titel"><span>${t('VST3-Plug-in hinzufügen')}</span></div>
    <div class="vst-wahl-kopf"><input type="search" class="einst-feld" placeholder="${t('Plug-ins durchsuchen …')}" aria-label="${t('Plug-ins durchsuchen')}" data-vw-suche></div>
    <div class="vst-wahl-liste" data-vw-liste><div class="lade"></div></div>
    <div class="fx-wahl-trenn"></div>
    <button type="button" class="fx-wahl-pt neu" data-vw-scan><span class="t">${t('Neu suchen')}</span></button>`;
  platzieren();
  const suche = el.querySelector('[data-vw-suche]');
  const zeichnen = () => {
    const q = suche.value.trim().toLocaleLowerCase(locale);
    const treffer = liste.filter((p) => !q || `${p.name} ${p.anbieter} ${p.unter}`.toLocaleLowerCase(locale).includes(q));
    el.querySelector('[data-vw-liste]').innerHTML = treffer.length
      ? treffer.map((p) => `<button type="button" class="fx-wahl-pt" data-vw="${h(`${p.pfad}|${p.cid}`)}"><span class="h"></span><span class="tx"><span class="t">${h(p.name)}</span><small>${h([p.anbieter, (p.unter || '').replace(/\|/g, ' · ')].filter(Boolean).join(' · '))}</small></span></button>`).join('')
      : `<p class="vst-hinweis">${liste.length ? t('Nichts passt zur Suche.') : t('Keine Plug-ins gefunden. „Neu suchen“ durchsucht die VST3-Ordner (weitere Ordner unter Einstellungen → Windows-Ausgabe).')}</p>`;
    platzieren();
  };
  const laden = async () => { const s = await api().liste().catch(() => null); liste = s?.plugins || []; zeichnen(); };
  suche.addEventListener('input', zeichnen);
  el.addEventListener('click', async (e) => {
    const sc = e.target.closest('[data-vw-scan]');
    if (sc) { sc.disabled = true; sc.querySelector('.t').textContent = t('Suche läuft …'); const s = await api().scannen(false).catch(() => null); liste = s?.plugins || liste; sc.disabled = false; sc.querySelector('.t').textContent = t('Neu suchen'); zeichnen(); return; }
    const b = e.target.closest('[data-vw]');
    if (!b) return;
    const k = b.dataset.vw, i = k.lastIndexOf('|');
    const plugin = liste.find((p) => p.pfad === k.slice(0, i) && p.cid === k.slice(i + 1));
    if (!plugin) return;
    zu();
    const { vstRack } = await import('./vstrack.js');
    const id = await vstRack.hinzufuegen(plugin);
    if (id) toast(t('{name} im Rack', { name: plugin.name }), 'gut');
  });
  await laden();
  suche.focus({ preventScroll: true });
}
