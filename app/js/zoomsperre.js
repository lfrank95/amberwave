// Oberfläche gegen Zoomen sperren (ZOOM_SPERREN in der .env, Standard an): sie sitzt dann immer passend im Fenster.
// Abgefangen: Strg/⌘ + Mausrad bzw. Touchpad-Pinch, Strg/⌘ + Plus/Minus/0, Safari-Gesten, Zwei-Finger-Zoom und Doppeltipp.
// Nicht abfangbar: Zoom über das Browser-Menü (im Windows Client gibt es keins).
export function zoomSperren() {
  if (document.querySelector('meta[name="aw-zoom-sperre"]')?.content === '0') return;
  document.documentElement.classList.add('zoom-gesperrt');
  window.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) e.preventDefault(); }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (['+', '-', '=', '0', 'Add', 'Subtract'].includes(e.key) || ['Equal', 'Minus', 'Digit0', 'NumpadAdd', 'NumpadSubtract', 'Numpad0'].includes(e.code)) e.preventDefault();
  }, true);
  for (const art of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(art, (e) => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1 || (e.scale !== undefined && e.scale !== 1)) e.preventDefault(); }, { passive: false });
}
