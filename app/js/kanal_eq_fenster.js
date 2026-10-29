// EQ-Fenster eines Lautsprecher-Kanals (Lautsprecher-Manager, Windows Client): 8 voll parametrische Bänder (Bell, Low-/High-Shelf,
// Hoch-/Tiefpass mit 6–48 dB/Okt.), Kurve zum Ziehen, Kanalpaare koppeln (L/R, Ls/Rs), Presets, Einstellungen an andere Kanäle
// schicken. Das Fenster ändert direkt die Werte des Ausgangs im Manager (gespeichert wird erst mit „Übernehmen“ dort);
// jede Änderung ist bei laufender Musik auf diesem Ausgang sofort zu hören.
import { h, icon, toast, bestaetigen } from './ui.js';
import { nativ } from './nativ.js';
import { t, tn, zahl, locale } from './i18n.js';
import {
  ANZAHL, TYPEN, FLANKEN, bandFarbe, neuesBand, kopie, bandNormal, partnerVon, paarSchluessel, kanalDb, bandDb, reserveVon, kanalAktiv, aktivAnzahl, STD_F,
} from './kanal_eq.js';

const B = 900, H = 300, F0 = 20, F1 = 20000;
const fx = (f) => Math.log(f / F0) / Math.log(F1 / F0) * B;
const xf = (px) => F0 * Math.pow(F1 / F0, Math.max(0, Math.min(1, px / B)));
const de = (v, n = 1) => zahl(v, n);
const hzText = (f) => (f >= 1000 ? `${de(f / 1000, f >= 10000 ? 1 : 2)} k` : `${de(f, f < 100 ? 1 : 0)}`);
const rund = (f) => { const e = Math.pow(10, Math.floor(Math.log10(f)) - 2); return Math.round(f / e) * e; };   // 3 gültige Stellen

/**
 * x = Ausgang im Manager (wird direkt geändert), kanal = geöffneter Lautsprecher, ls = alle Lautsprecher des Ausgangs (Reihenfolge),
 * kname(k) = Anzeigename, geaendert() = Manager merken lassen und live hörbar machen
 */
export function eqFenster({ x, kanal, ls, kname, geaendert }) {
  return new Promise((fertig) => {
    let k = kanal;
    let sel = Math.max(0, x.eq[k].baender.findIndex((b) => b.an));
    let bereich = 18;
    let pop = '';   // offenes Menü: '', 'preset', 'senden'
    let presets = [];
    let ziel = new Set();
    let zug = null;
    const d = document.createElement('dialog');
    d.className = 'dialog eqf';
    d.setAttribute('aria-labelledby', 'eqf-titel');
    document.body.appendChild(d);

    const e = () => x.eq[k];
    const paarOffen = () => { const p = partnerVon(k); return p && ls.includes(p) ? p : null; };
    const gekoppelt = () => { const p = paarOffen(); return !!(p && x.eq_link[paarSchluessel(k)]); };
    /** gekoppelte Kanäle haben immer dieselben Werte */
    const spiegeln = (von = k) => {
      const p = partnerVon(von), pk = paarSchluessel(von);
      if (p && ls.includes(p) && x.eq_link[pk]) x.eq[p] = kopie(x.eq[von]);
    };
    const aend = () => { spiegeln(); geaendert(); };

    /* ---------- Kurve ---------- */
    const y = (db) => H / 2 - db / bereich * (H / 2 - 14);
    const pfad = (fn, n = 220) => Array.from({ length: n + 1 }, (_, i) => { const f = F0 * Math.pow(F1 / F0, i / n); return `${i ? 'L' : 'M'}${fx(f).toFixed(1)} ${Math.max(-6, Math.min(H + 6, y(fn(f)))).toFixed(1)}`; }).join('');
    function kurveInnen() {
      const eq = e();
      let g = '';
      for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) g += `<line class="eqf-gitter" x1="${fx(f).toFixed(1)}" x2="${fx(f).toFixed(1)}" y1="0" y2="${H}"/><text class="eqf-txt" x="${(fx(f) + 3).toFixed(1)}" y="${H - 4}">${f >= 1000 ? `${f / 1000}k` : f}</text>`;
      const schritt = bereich <= 12 ? 3 : 6;
      for (let db = -bereich; db <= bereich; db += schritt) g += `<line class="eqf-gitter${db === 0 ? ' null' : ''}" x1="0" x2="${B}" y1="${y(db).toFixed(1)}" y2="${y(db).toFixed(1)}"/><text class="eqf-txt" x="3" y="${(y(db) - 3).toFixed(1)}">${db > 0 ? '+' : ''}${db}</text>`;
      const baender = eq.baender.map((b, i) => [b, i]).filter(([b]) => b.an);
      const einzel = baender.map(([b, i]) => `<path class="eqf-band${i === sel ? ' sel' : ''}" d="${pfad((f) => bandDb(b, f))}" stroke="${bandFarbe(i)}"/>`).join('');
      const summe = pfad((f) => kanalDb(eq, f));
      const griffe = baender.map(([b, i]) => {
        const gy = b.typ >= 3 ? 0 : b.g;
        return `<g class="eqf-griff${i === sel ? ' sel' : ''}" data-griff="${i}" tabindex="0" role="slider" aria-label="${t('Band {n}', { n: i + 1 })}, ${hzText(b.f)} Hz${b.typ < 3 ? `, ${de(b.g)} dB` : ''}" transform="translate(${fx(b.f).toFixed(1)} ${Math.max(8, Math.min(H - 8, y(gy))).toFixed(1)})">
          <circle r="${i === sel ? 11 : 9}" fill="${bandFarbe(i)}"/><text y="4" class="eqf-nr">${i + 1}</text></g>`;
      }).join('');
      return `${g}${einzel}<path class="eqf-flaeche" d="${summe} L${B} ${y(0).toFixed(1)} L0 ${y(0).toFixed(1)} Z"/><path class="eqf-summe" d="${summe}"/>${griffe}`;
    }
    const kurveHtml = () => `<svg class="eqf-kurve${e().an ? '' : ' aus'}" viewBox="0 0 ${B} ${H}" data-kurve role="group" aria-label="${t('Frequenzgang')}">${kurveInnen()}</svg>`;

    /* ---------- Bänder ---------- */
    function zeileHtml(b, i) {
      const hp = b.typ >= 3, q12 = hp && b.flanke === 12;
      return `<div class="eqf-z${b.an ? ' an' : ''}${i === sel ? ' sel' : ''}" data-zeile="${i}" style="--bf:${bandFarbe(i)}">
        <button type="button" class="eqf-nrk" data-an="${i}" role="switch" aria-checked="${b.an}" aria-label="${b.an ? t('Band {n} ausschalten', { n: i + 1 }) : t('Band {n} einschalten', { n: i + 1 })}"><b>${i + 1}</b></button>
        <select data-f="typ" data-i="${i}" aria-label="${t('Typ, Band {n}', { n: i + 1 })}">${TYPEN.map(([typName], ti) => `<option value="${ti}"${b.typ === ti ? ' selected' : ''}>${typName}</option>`).join('')}</select>
        <label class="eqf-feld"><input type="number" data-f="f" data-i="${i}" min="10" max="24000" step="any" value="${b.f}" aria-label="${t('Frequenz, Band {n}', { n: i + 1 })}"><span>Hz</span></label>
        <label class="eqf-feld"><input type="number" data-f="g" data-i="${i}" min="-24" max="24" step="0.1" value="${b.g}" ${hp ? 'disabled' : ''} aria-label="${t('Gain, Band {n}', { n: i + 1 })}"><span>dB</span></label>
        <label class="eqf-feld"><input type="number" data-f="q" data-i="${i}" min="0.1" max="18" step="0.05" value="${b.q}" ${hp && !q12 ? 'disabled' : ''} aria-label="${t('Güte, Band {n}', { n: i + 1 })}"><span>Q</span></label>
        <select data-f="flanke" data-i="${i}" ${hp ? '' : 'disabled'} aria-label="${t('Flanke, Band {n}', { n: i + 1 })}">${FLANKEN.map((fl) => `<option value="${fl}"${b.flanke === fl ? ' selected' : ''}>${t('{fl} dB/Okt.', { fl })}</option>`).join('')}</select></div>`;
    }

    /* ---------- Kopf, Fuß, Menüs ---------- */
    function popHtml() {
      if (pop === 'preset') {
        return `<div class="eqf-pop" role="dialog" aria-label="${t('Presets')}"><div class="eqf-pop-k"><b>${t('Presets')}</b><button type="button" class="eqf-x" data-pop="" aria-label="${t('Schließen')}">${icon('zu', 14)}</button></div>
          <form class="eqf-speichern" data-speichern><input type="text" maxlength="60" placeholder="${t('Name für den aktuellen EQ')}" data-pname aria-label="${t('Name des Presets')}"><button type="submit" class="lm-mini">${t('Speichern')}</button></form>
          <div class="eqf-liste">${presets.length ? presets.map((p, i) => `<div class="eqf-pz"><button type="button" class="eqf-pl" data-laden="${i}"><b>${h(p.name)}</b><small>${tn(p.baender.filter((b) => b.an).length, 'ein Band', '{n} Bänder')}</small></button><button type="button" class="eqf-x" data-loeschen="${i}" aria-label="${t('{name} löschen', { name: h(p.name) })}">${icon('zu', 14)}</button></div>`).join('') : `<span class="eqf-leer">${t('Noch keine Presets. Gib oben einen Namen ein und speichere den aktuellen EQ.')}</span>`}</div>
          <span class="eqf-hinweis">${gekoppelt() ? t('Laden ersetzt die 8 Bänder von „{a}“ und „{b}“ (gekoppelt).', { a: h(kname(k)), b: h(kname(paarOffen())) }) : t('Laden ersetzt die 8 Bänder von „{a}“.', { a: h(kname(k)) })}</span></div>`;
      }
      if (pop === 'senden') {
        const andere = ls.filter((l) => l !== k);
        return `<div class="eqf-pop" role="dialog" aria-label="${t('Senden an')}"><div class="eqf-pop-k"><b>${t('EQ von „{name}“ senden an', { name: h(kname(k)) })}</b><button type="button" class="eqf-x" data-pop="" aria-label="${t('Schließen')}">${icon('zu', 14)}</button></div>
          <div class="eqf-liste">${andere.map((l) => `<label class="eqf-cb"><input type="checkbox" data-ziel="${l}" ${ziel.has(l) ? 'checked' : ''}><span class="eqf-kz">${l}</span><span>${h(kname(l))}</span>${kanalAktiv(x.eq[l]) ? `<em>${t('hat schon einen EQ')}</em>` : ''}</label>`).join('')}</div>
          <div class="eqf-pop-f"><button type="button" class="lm-mini" data-alle>${t('Alle anderen')}</button><button type="button" class="lm-btn haupt" data-senden ${ziel.size ? '' : 'disabled'}>${t('Senden')}</button></div>
          <span class="eqf-hinweis">${t('Ersetzt den EQ der gewählten Kanäle durch diesen.')}</span></div>`;
      }
      return '';
    }
    const statusText = () => {
      const n = aktivAnzahl(e()), p = paarOffen();
      return gekoppelt() ? t('{n} von {max} Bändern aktiv · gekoppelt mit {name}', { n, max: ANZAHL, name: kname(p) }) : t('{n} von {max} Bändern aktiv', { n, max: ANZAHL });
    };
    const reserveHtml = (r) => (r > 0 ? t('Reserve −{r} dB <small>(höchste Anhebung +{r} dB)</small>', { r: de(r) }) : t('Keine Anhebung – volle Reserve'));
    function kopfHtml() {
      const p = paarOffen(), r = reserveVon(x, ls);
      return `<header class="eqf-kopf"><div class="eqf-titel"><h3 id="eqf-titel">EQ · ${h(kname(k))}</h3><span>${h(statusText())}</span></div>
        <div class="eqf-tabs" role="tablist" aria-label="${t('Lautsprecher')}">${ls.map((l) => `<button type="button" role="tab" aria-selected="${l === k}" class="${kanalAktiv(x.eq[l]) ? 'hat' : ''}" data-kanal="${l}" title="${h(kname(l))}">${l}</button>`).join('')}</div>
        <button type="button" class="lm-schalter eqf-bypass${e().an ? ' an' : ''}" data-bypass role="switch" aria-checked="${e().an}"><span class="lm-sw"></span><span><b>${e().an ? t('EQ an') : t('EQ aus')}</b></span></button>
        <button type="button" class="btn-ico" data-zu aria-label="${t('Schließen')}">${icon('zu')}</button></header>
        <div class="eqf-zeile2">
          ${p ? `<button type="button" class="lm-schalter eqf-koppeln${gekoppelt() ? ' an' : ''}" data-koppeln role="switch" aria-checked="${gekoppelt()}"><span class="lm-sw"></span><span><b>${t('{a} ⇄ {b} koppeln', { a: h(kname(k)), b: h(kname(p)) })}</b><small>${gekoppelt() ? t('beide haben immer dieselben Werte') : t('jeder Kanal einzeln')}</small></span></button>` : '<span></span>'}
          <div class="eqf-reserve ${r > 0 ? 'warn' : ''}" title="${t('Anhebungen können übersteuern: der Ausgang wird so weit abgesenkt, wie der EQ am stärksten anhebt (alle Kanäle gleich, die Balance bleibt)')}">${reserveHtml(r)}</div>
          <div class="lm-seg" role="group" aria-label="${t('Darstellungsbereich')}">${[12, 18, 24].map((b2) => `<button type="button" data-bereich="${b2}" aria-pressed="${bereich === b2}">±${b2}</button>`).join('')}</div></div>`;
    }
    function zeichnen() {
      d.innerHTML = `${kopfHtml()}<div class="eqf-mitte"><div class="eqf-graph" data-graph>${kurveHtml()}</div>
        <span class="eqf-tipp">${t('Punkt ziehen: Frequenz und Gain · Mausrad: Güte (Q) · Doppelklick ins Leere: neues Band · Doppelklick auf Punkt: Band aus')}</span>
        <div class="eqf-baender"><div class="eqf-z eqf-kopfz"><span></span><span>${t('Typ')}</span><span>${t('Frequenz')}</span><span>${t('Gain')}</span><span>${t('Güte')}</span><span>${t('Flanke')}</span></div>${e().baender.map(zeileHtml).join('')}</div></div>
        <footer class="eqf-fuss"><div class="eqf-menue"><button type="button" class="lm-btn" data-pop="preset" aria-haspopup="dialog" aria-expanded="${pop === 'preset'}">${t('Presets')} ▾</button><button type="button" class="lm-btn" data-pop="senden" aria-haspopup="dialog" aria-expanded="${pop === 'senden'}">${t('An anderen Kanal senden')} ▾</button><button type="button" class="lm-btn" data-reset>${t('Zurücksetzen')}</button>${popHtml()}</div>
        <span class="eqf-fusstext">${t('Gerechnet in 64 Bit, geglättet beim Ziehen. Bitgenau ist die Wiedergabe mit aktivem EQ nicht.')}</span><button type="button" class="lm-btn haupt" data-zu>${t('Fertig')}</button></footer>`;
      verbinden();
    }
    /** nur Kurve, Kopf-Anzeigen und die Werte der Bänder auffrischen (beim Ziehen, ohne Eingabefelder neu zu bauen) */
    function leicht() {
      const svg = d.querySelector('[data-kurve]');   // das svg-Element bleibt (Zeiger-Erfassung beim Ziehen), nur der Inhalt wechselt
      svg.innerHTML = kurveInnen(); svg.classList.toggle('aus', !e().an);
      d.querySelectorAll('[data-zeile]').forEach((z) => {
        const i = +z.dataset.zeile, b = e().baender[i];
        z.classList.toggle('an', b.an); z.classList.toggle('sel', i === sel);
        z.querySelector('[data-an]').setAttribute('aria-checked', b.an);
        for (const f of ['f', 'g', 'q']) { const inp = z.querySelector(`[data-f="${f}"]`); if (inp && document.activeElement !== inp) inp.value = b[f]; }
      });
      const r = reserveVon(x, ls);
      d.querySelector('.eqf-titel span').textContent = statusText();
      const rs = d.querySelector('.eqf-reserve');
      rs.classList.toggle('warn', r > 0);
      rs.innerHTML = reserveHtml(r);
      verbindeKurve();
    }

    /* ---------- Bedienung ---------- */
    const setze = (i, teil) => { e().baender[i] = bandNormal({ ...e().baender[i], ...teil }, i); aend(); };
    function zeigerPos(ev) {
      const svg = d.querySelector('[data-kurve]'), r = svg.getBoundingClientRect();
      return { px: (ev.clientX - r.left) / r.width * B, py: (ev.clientY - r.top) / r.height * H };
    }
    const dbVon = (py) => Math.round(Math.max(-24, Math.min(24, (H / 2 - py) / (H / 2 - 14) * bereich)) * 10) / 10;
    function verbindeKurve() {
      const svg = d.querySelector('[data-kurve]');
      svg.querySelectorAll('[data-griff]').forEach((gr) => {
        const i = +gr.dataset.griff;
        gr.addEventListener('pointerdown', (ev) => { ev.preventDefault(); ev.stopPropagation(); sel = i; zug = i; svg.setPointerCapture(ev.pointerId); leicht(); });
        gr.addEventListener('dblclick', (ev) => { ev.stopPropagation(); setze(i, { an: false }); leicht(); });
        gr.addEventListener('wheel', (ev) => { ev.preventDefault(); sel = i; setze(i, { q: e().baender[i].q * (ev.deltaY < 0 ? 1.1 : 1 / 1.1) }); leicht(); }, { passive: false });
        gr.addEventListener('keydown', (ev) => {
          const b = e().baender[i], s2 = ev.shiftKey ? 5 : 1;
          const t = ev.key === 'ArrowLeft' ? { f: b.f / Math.pow(1.02, s2) } : ev.key === 'ArrowRight' ? { f: b.f * Math.pow(1.02, s2) } : ev.key === 'ArrowUp' && b.typ < 3 ? { g: b.g + 0.5 * s2 } : ev.key === 'ArrowDown' && b.typ < 3 ? { g: b.g - 0.5 * s2 } : ev.key === 'Delete' ? { an: false } : null;
          if (!t) return;
          ev.preventDefault(); sel = i; setze(i, t); leicht(); d.querySelector(`[data-griff="${i}"]`)?.focus();
        });
      });
      svg.onpointermove = (ev) => {
        if (zug == null) return;
        const { px, py } = zeigerPos(ev), b = e().baender[zug];
        setze(zug, { f: rund(xf(px)), ...(b.typ < 3 ? { g: dbVon(py) } : {}) });
        leicht();
      };
      svg.onpointerup = svg.onpointercancel = () => { zug = null; };
      svg.ondblclick = (ev) => {   // freies Band an dieser Stelle einschalten
        const i = e().baender.findIndex((b) => !b.an);
        if (i < 0) { toast(t('Alle 8 Bänder sind in Benutzung'), 'info'); return; }
        const { px, py } = zeigerPos(ev);
        sel = i; setze(i, { an: true, typ: 0, f: rund(xf(px)), g: dbVon(py) || 3, q: 1 });
        leicht();
      };
    }
    async function koppeln() {
      const p = paarOffen(); if (!p) return;
      const pk = paarSchluessel(k);
      if (x.eq_link[pk]) { x.eq_link[pk] = false; geaendert(); zeichnen(); return; }
      if (kanalAktiv(x.eq[p]) && JSON.stringify(x.eq[p].baender) !== JSON.stringify(x.eq[k].baender)
        && !(await bestaetigen(t('Kanäle koppeln'), t('Der EQ von „{a}“ wird durch den von „{b}“ ersetzt.', { a: kname(p), b: kname(k) }), t('Koppeln')))) return;
      x.eq_link[pk] = true; x.eq[p] = kopie(x.eq[k]);
      geaendert(); zeichnen();
    }
    async function presetsLaden() { presets = (await nativ?.eqPresets?.().catch(() => [])) || []; presets.sort((a, b) => a.name.localeCompare(b.name, locale)); }
    function senden() {
      const namen = [...ziel].map(kname);
      for (const z of ziel) { x.eq[z] = kopie(x.eq[k]); spiegeln(z); }
      geaendert(); ziel = new Set(); pop = ''; zeichnen();
      toast(t('EQ gesendet an {namen}', { namen: namen.join(', ') }), 'erfolg');
    }

    function verbinden() {
      d.querySelectorAll('[data-zu]').forEach((b) => b.addEventListener('click', () => d.close()));
      d.querySelector('[data-bypass]').addEventListener('click', () => { e().an = !e().an; aend(); zeichnen(); });
      d.querySelector('[data-koppeln]')?.addEventListener('click', koppeln);
      d.querySelectorAll('[data-kanal]').forEach((b) => b.addEventListener('click', () => { k = b.dataset.kanal; sel = Math.max(0, e().baender.findIndex((bb) => bb.an)); pop = ''; zeichnen(); }));
      d.querySelectorAll('[data-bereich]').forEach((b) => b.addEventListener('click', () => { bereich = +b.dataset.bereich; zeichnen(); }));
      d.querySelectorAll('[data-an]').forEach((b) => b.addEventListener('click', () => { const i = +b.dataset.an; sel = i; setze(i, { an: !e().baender[i].an }); zeichnen(); }));
      d.querySelectorAll('[data-zeile]').forEach((z) => z.addEventListener('pointerdown', () => { const i = +z.dataset.zeile; if (sel !== i) { sel = i; leicht(); } }));
      d.querySelectorAll('[data-f]').forEach((inp) => inp.addEventListener('change', () => {
        const i = +inp.dataset.i, f = inp.dataset.f;
        const v = inp.tagName === 'SELECT' ? Number(inp.value) : Number(String(inp.value).replace(',', '.'));
        if (!Number.isFinite(v)) { zeichnen(); return; }
        sel = i; setze(i, { [f]: v });
        if (f === 'typ' || f === 'flanke') zeichnen(); else leicht();
      }));
      d.querySelector('[data-reset]').addEventListener('click', async () => {
        if (!(await bestaetigen(t('EQ zurücksetzen'), gekoppelt() ? t('Alle 8 Bänder von „{a}“ und „{b}“ auf neutral setzen?', { a: kname(k), b: kname(paarOffen()) }) : t('Alle 8 Bänder von „{a}“ auf neutral setzen?', { a: kname(k) }), t('Zurücksetzen'), true))) return;
        e().baender = Array.from({ length: ANZAHL }, (_, i) => neuesBand(i)); sel = 0; aend(); zeichnen();
      });
      d.querySelectorAll('[data-pop]').forEach((b) => b.addEventListener('click', async () => {
        const neu = b.dataset.pop === pop ? '' : b.dataset.pop;
        if (neu === 'preset') await presetsLaden();
        pop = neu; zeichnen();
        if (neu === 'preset') d.querySelector('[data-pname]')?.focus();
      }));
      d.querySelector('[data-speichern]')?.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const n = d.querySelector('[data-pname]').value.trim();
        if (!n) { d.querySelector('[data-pname]').focus(); return; }
        if (presets.some((p) => p.name === n) && !(await bestaetigen(t('Preset ersetzen'), t('„{n}“ gibt es schon. Überschreiben?', { n }), t('Überschreiben')))) return;
        const l = await nativ?.eqPresetSetzen?.(n, kopie(e().baender));
        if (!l) { toast(t('Preset lässt sich nicht speichern'), 'fehler'); return; }
        presets = l.sort((a, b) => a.name.localeCompare(b.name, locale)); toast(t('Preset „{n}“ gespeichert', { n }), 'erfolg'); zeichnen();
      });
      d.querySelectorAll('[data-laden]').forEach((b) => b.addEventListener('click', () => {
        const p = presets[+b.dataset.laden]; if (!p) return;
        e().baender = p.baender.map((bb, i) => bandNormal(bb, i)); sel = Math.max(0, e().baender.findIndex((bb) => bb.an));
        aend(); pop = ''; zeichnen(); toast(t('Preset „{name}“ geladen', { name: p.name }), 'info');
      }));
      d.querySelectorAll('[data-loeschen]').forEach((b) => b.addEventListener('click', async () => {
        const p = presets[+b.dataset.loeschen]; if (!p) return;
        if (!(await bestaetigen(t('Preset löschen'), t('„{name}“ löschen?', { name: p.name }), t('Löschen'), true))) return;
        const l = await nativ?.eqPresetSetzen?.(p.name, null);
        if (l) presets = l.sort((a, b2) => a.name.localeCompare(b2.name, locale));
        zeichnen();
      }));
      d.querySelectorAll('[data-ziel]').forEach((c) => c.addEventListener('change', () => { if (c.checked) ziel.add(c.dataset.ziel); else ziel.delete(c.dataset.ziel); const s = d.querySelector('[data-senden]'); if (s) s.disabled = !ziel.size; }));
      d.querySelector('[data-alle]')?.addEventListener('click', () => { ziel = new Set(ls.filter((l) => l !== k)); zeichnen(); });
      d.querySelector('[data-senden]')?.addEventListener('click', senden);
      verbindeKurve();
    }

    d.addEventListener('close', () => { d.remove(); fertig(); });
    d.addEventListener('cancel', (ev) => { if (pop) { ev.preventDefault(); pop = ''; zeichnen(); } });
    zeichnen();
    d.showModal();
  });
}
