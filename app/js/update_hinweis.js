// Updates aus der App heraus:
//  • Windows Client: neue Version gefunden → Karte unten rechts „Jetzt aktualisieren“. Der Client lädt den Installer, startet
//    ihn ohne Klicks und geht in der neuen Version wieder auf (main.js, Installer mit /aktualisieren).
//  • Windows Server und Amberwave OS (Admins, Verwaltung › Übersicht): „Update installieren“ sagt dem Programm im Infobereich Bescheid; die
//    Seite wartet, bis der Server in der neuen Version antwortet, und lädt dann neu.
import { api } from './api.js';
import { t } from './i18n.js';
import { h, icon, toast } from './ui.js';
import { nativ } from './nativ.js';

let karte = null;
const SPAETER = 'aw-update-spaeter';

function spaeter(version) { try { return sessionStorage.getItem(SPAETER) === version; } catch (e) { return false; } }

function zeigen(info) {
  if (!info || !info.version || (spaeter(info.version) && !info.stand)) { karte?.remove(); karte = null; return; }
  if (!karte) {
    karte = document.createElement('div');
    karte.className = 'update-karte';
    karte.setAttribute('role', 'status');
    document.body.appendChild(karte);
    karte.addEventListener('click', async (e) => {
      if (e.target.closest('[data-upd-los]')) {
        e.target.closest('button').disabled = true;
        await nativ.update.installieren().catch(() => false);
      } else if (e.target.closest('[data-upd-spaeter]')) {
        try { sessionStorage.setItem(SPAETER, karte.dataset.version); } catch (x) { /* egal */ }
        karte.remove(); karte = null;
      }
    });
  }
  karte.dataset.version = info.version;
  const titel = t('Amberwave {version} ist da', { version: h(info.version) });
  let text, knoepfe = '', balken = '';
  if (info.stand === 'laedt') {
    text = t('Wird geladen … {p} %', { p: info.prozent || 0 });
    balken = `<div class="update-balken"><i style="width:${Math.max(3, info.prozent || 0)}%"></i></div>`;
  } else if (info.stand === 'startet') {
    text = t('Wird installiert – Amberwave startet gleich in der neuen Version.');
    balken = '<div class="update-balken"><i style="width:100%"></i></div>';
  } else {
    text = info.stand === 'fehler' ? `<span class="update-fehler">${h(info.fehler || t('Das hat nicht geklappt.'))}</span>`
      : t('Ein Klick genügt: laden, installieren, neu starten – deine Einstellungen bleiben.');
    knoepfe = `<div class="update-knoepfe">${info.installierbar
      ? `<button type="button" class="btn btn-klein" data-upd-los>${info.stand === 'fehler' ? t('Erneut versuchen') : t('Jetzt aktualisieren')}</button>`
      : ''}<a class="btn btn-zweit btn-klein" href="${h(info.notizen || 'https://github.com/lfrank95/amberwave/releases')}" target="_blank" rel="noopener">${t('Was ist neu?')}</a>
      <button type="button" class="btn-ico" data-upd-spaeter aria-label="${h(t('Später'))}" title="${h(t('Später'))}">${icon('zu', 16)}</button></div>`;
  }
  karte.innerHTML = `<div class="update-kopf">${icon('download', 18)}<b>${titel}</b></div><p>${text}</p>${balken}${knoepfe}`;
}

/** Windows Client: Hinweis im Fenster, sobald der Client eine neue Version kennt */
export function clientUpdateBeobachten() {
  if (!nativ?.update) return;
  nativ.update.info().then(zeigen).catch(() => {});
  nativ.update.auf(zeigen);
}

/** Windows Server: Update über das Programm im Infobereich anstoßen und auf die neue Version warten */
export async function serverUpdateInstallieren(version, vorher, os = false) {
  await api.post('/admin/update/windows', {});
  const band = document.createElement('div');
  band.className = 'update-warten';
  band.innerHTML = `<div class="update-warten-karte"><span class="update-kreis"></span><b>${t('Amberwave wird aktualisiert')}</b>
    <p data-upd-text>${t('Der Server lädt Version {version} und startet neu. Das dauert meist ein bis zwei Minuten – diese Seite lädt danach von selbst.', { version: h(version) })}</p></div>`;
  document.body.appendChild(band);
  const text = band.querySelector('[data-upd-text]');
  const beginn = Date.now();
  let warWeg = false;
  for (;;) {
    await new Promise((ok) => setTimeout(ok, 3000));
    let j = null;
    try { j = await (await fetch('/api/v1/ping', { cache: 'no-store' })).json(); } catch (e) { warWeg = true; }
    if (j?.version && j.version !== vorher) { location.reload(); return; }
    if (j && !warWeg) {
      const s = await api.get('/admin/update/windows').catch(() => null);
      if (s?.fehler) { band.remove(); toast(s.fehler, 'fehler', 9000); return; }
    }
    if (Date.now() - beginn > 10 * 60 * 1000) {
      text.textContent = os ? t('Das dauert ungewöhnlich lange. Ist das Gerät mit dem Internet verbunden?')
        : t('Das dauert ungewöhnlich lange. Sieh am Server-PC nach dem Amberwave-Symbol im Infobereich.');
    }
  }
}
