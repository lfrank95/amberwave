// Schöne Auswahlfelder: Jedes <select> bekommt einen Knopf im App-Stil und eine eigene Liste (Glas, Bernstein-Haken).
// Das echte <select> bleibt im Formular und ist die Wahrheit (FormData, change-Events, Labels funktionieren weiter).
// Auf Touch-Geräten bleibt die Liste nativ (die Auswahl-Räder von iOS/Android sind dort besser), nur der Knopf ist gestaltet.
import { h, icon } from './ui.js';

const GROB = matchMedia('(pointer: coarse)');
let offen = null; // { liste, select, knopf }

function textVon(select) {
  const o = select.options[select.selectedIndex];
  return o ? o.textContent.trim() : '';
}

function schliessen(fokus = false) {
  if (!offen) return;
  const { liste, knopf } = offen;
  liste.remove();
  knopf.setAttribute('aria-expanded', 'false');
  knopf.closest('.auswahl')?.classList.remove('offen');
  if (fokus) knopf.focus({ preventScroll: true });
  offen = null;
}

function waehlen(select, wert) {
  if (select.value !== wert) {
    select.value = wert;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  aktualisieren(select);
}

function aktualisieren(select) {
  const w = select._auswahl;
  if (!w) return;
  w.text.textContent = textVon(select);
  w.knopf.disabled = select.disabled;
}

function oeffnen(select) {
  schliessen();
  const w = select._auswahl;
  if (!w || select.disabled) return;
  const liste = document.createElement('div');
  liste.className = 'auswahl-liste';
  liste.setAttribute('role', 'listbox');
  liste.id = `auswahl-${Math.random().toString(36).slice(2, 9)}`;
  const zeilen = [];
  for (const kind of select.children) {
    if (kind.tagName === 'OPTGROUP') {
      zeilen.push(`<div class="auswahl-gruppe">${h(kind.label)}</div>`);
      for (const o of kind.children) zeilen.push(optionHtml(o));
    } else if (kind.tagName === 'OPTION') zeilen.push(optionHtml(kind));
  }
  liste.innerHTML = zeilen.join('');
  (w.knopf.closest('dialog') || document.body).appendChild(liste);
  // Unter (oder über) dem Knopf, mindestens so breit
  const r = w.knopf.getBoundingClientRect();
  liste.style.minWidth = `${Math.max(r.width, 180)}px`;
  const hoehe = Math.min(liste.scrollHeight, 360);
  let y = r.bottom + 6;
  if (y + hoehe > window.innerHeight - 8 && r.top - hoehe - 6 > 8) y = r.top - hoehe - 6;
  liste.style.top = `${Math.max(8, y)}px`;
  liste.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - liste.offsetWidth - 8))}px`;
  w.knopf.setAttribute('aria-expanded', 'true');
  w.knopf.setAttribute('aria-controls', liste.id);
  w.knopf.closest('.auswahl')?.classList.add('offen');
  offen = { liste, select, knopf: w.knopf };
  const aktiv = liste.querySelector('[aria-selected="true"]') || liste.querySelector('[role="option"]:not([aria-disabled="true"])');
  markieren(aktiv);
  aktiv?.scrollIntoView({ block: 'nearest' });
  liste.addEventListener('mousedown', (e) => e.preventDefault()); // Fokus bleibt am Knopf
  liste.addEventListener('click', (e) => {
    const o = e.target.closest('[role="option"]');
    if (!o || o.getAttribute('aria-disabled') === 'true') return;
    waehlen(select, o.dataset.wert);
    schliessen(true);
  });
  liste.addEventListener('mousemove', (e) => { const o = e.target.closest('[role="option"]'); if (o) markieren(o); });
}

function optionHtml(o) {
  const an = o.selected;
  return `<div role="option" class="auswahl-option${an ? ' an' : ''}" data-wert="${h(o.value)}" aria-selected="${an}" ${o.disabled ? 'aria-disabled="true"' : ''}>
    <span>${h(o.textContent.trim())}</span>${an ? icon('haken', 16) : ''}</div>`;
}

function markieren(o) {
  if (!offen || !o) return;
  offen.liste.querySelectorAll('.markiert').forEach((x) => x.classList.remove('markiert'));
  o.classList.add('markiert');
  offen.knopf.setAttribute('aria-activedescendant', '');
  o.scrollIntoView({ block: 'nearest' });
}

function tasten(e, select) {
  const w = select._auswahl;
  const optionen = offen ? [...offen.liste.querySelectorAll('[role="option"]:not([aria-disabled="true"])')] : [];
  const i = optionen.findIndex((o) => o.classList.contains('markiert'));
  if (!offen) {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); oeffnen(select); }
    return;
  }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); schliessen(true); }
  else if (e.key === 'Tab') schliessen();
  else if (e.key === 'ArrowDown') { e.preventDefault(); markieren(optionen[Math.min(optionen.length - 1, i + 1)]); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); markieren(optionen[Math.max(0, i - 1)]); }
  else if (e.key === 'Home') { e.preventDefault(); markieren(optionen[0]); }
  else if (e.key === 'End') { e.preventDefault(); markieren(optionen[optionen.length - 1]); }
  else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (optionen[i]) waehlen(select, optionen[i].dataset.wert);
    schliessen(true);
  } else if (e.key.length === 1 && /\S/.test(e.key)) {
    // Tippen springt zum ersten passenden Eintrag
    const z = e.key.toLowerCase();
    const treffer = optionen.slice(i + 1).concat(optionen.slice(0, i + 1)).find((o) => o.textContent.trim().toLowerCase().startsWith(z));
    if (treffer) markieren(treffer);
  }
  void w;
}

/** Ein <select> verschönern (einmalig) */
export function auswahlVerschoenern(select) {
  if (select._auswahl || select.multiple || select.size > 1 || select.closest('[data-nativ]')) return;
  const huelle = document.createElement('span');
  huelle.className = 'auswahl';
  if (select.closest('.filterleiste')) huelle.classList.add('auswahl-pille');
  select.parentNode.insertBefore(huelle, select);
  huelle.appendChild(select);
  select.classList.add('auswahl-nativ');
  const knopf = document.createElement('button');
  knopf.type = 'button';
  knopf.className = 'auswahl-knopf';
  knopf.setAttribute('aria-haspopup', 'listbox');
  knopf.setAttribute('aria-expanded', 'false');
  const label = select.getAttribute('aria-label') || (select.id && document.querySelector(`label[for="${CSS.escape(select.id)}"]`)?.textContent.trim()) || '';
  if (label) knopf.setAttribute('aria-label', label);
  knopf.innerHTML = `<span class="auswahl-text"></span>${icon('runter', 16)}`;
  huelle.appendChild(knopf);
  select._auswahl = { knopf, text: knopf.querySelector('.auswahl-text') };
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  aktualisieren(select);
  // Touch: native Liste über dem Knopf (unsichtbar) – Tippen öffnet die System-Auswahl
  if (GROB.matches) {
    huelle.classList.add('auswahl-touch');
    select.tabIndex = 0;
    select.removeAttribute('aria-hidden');
  } else {
    knopf.addEventListener('click', () => (offen?.select === select ? schliessen(true) : oeffnen(select)));
    knopf.addEventListener('keydown', (e) => tasten(e, select));
    knopf.addEventListener('blur', () => setTimeout(() => { if (offen?.select === select && document.activeElement !== knopf) schliessen(); }, 120));
    // Klick auf ein <label for> soll den Knopf treffen
    select.addEventListener('focus', () => knopf.focus());
  }
  select.addEventListener('change', () => aktualisieren(select));
  // Optionen oder Wert werden manchmal per Code geändert
  new MutationObserver(() => aktualisieren(select)).observe(select, { childList: true, subtree: true, attributes: true });
}

/** Alle vorhandenen und künftigen <select> der Seite verschönern */
export function auswahlStarten() {
  document.querySelectorAll('select').forEach(auswahlVerschoenern);
  new MutationObserver((liste) => {
    for (const m of liste) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'SELECT') auswahlVerschoenern(n);
        else n.querySelectorAll?.('select').forEach(auswahlVerschoenern);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('mousedown', (e) => { if (offen && !offen.liste.contains(e.target) && !offen.knopf.contains(e.target)) schliessen(); }, true);
  window.addEventListener('resize', () => schliessen());
  window.addEventListener('scroll', (e) => { if (offen && !offen.liste.contains(e.target)) schliessen(); }, { passive: true, capture: true });
}

// Programmatische Wertänderungen (select.value = …) sollen den Knopf mitziehen
const beschreibung = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
if (beschreibung?.set) {
  Object.defineProperty(HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() { return beschreibung.get.call(this); },
    set(v) { beschreibung.set.call(this, v); if (this._auswahl) aktualisieren(this); },
  });
}
