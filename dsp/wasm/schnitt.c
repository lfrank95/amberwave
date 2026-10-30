// Schnittstelle der Effekte für JavaScript (AudioWorklet). Zeichenketten und Werte gehen über einen gemeinsamen
// Puffer: JS schreibt Text an aw_w_text(), sammelt Werte mit aw_w_zahl/aw_w_textwert/aw_w_liste und ruft aw_w_setzen.
// Audio: je Kanal 128 float an aw_w_ein(c) bzw. aw_w_aus(c), dann aw_w_block(fx, kanäle, n).
#include <string.h>
#include <stdlib.h>
#include "../aw_dsp.h"

#define EXPORT(n) __attribute__((export_name(#n)))
#define MAX_KAN 16
#define BLOCK 128
static float ein_p[MAX_KAN][BLOCK], aus_p[MAX_KAN][BLOCK];
static char text[4096];               // von JS beschrieben
static char ablage[8192]; static int ablage_n;   // Kopien der Namen/Texte für die gesammelten Werte
static double listen[64 * 64]; static int listen_n;
static AwWert werte[64]; static int werte_n;
static float faerb[2];

EXPORT(aw_w_text) char *aw_w_text(void) { return text; }
EXPORT(aw_w_ein) float *aw_w_ein(int c) { return ein_p[c]; }
EXPORT(aw_w_aus) float *aw_w_aus(int c) { return aus_p[c]; }
EXPORT(aw_w_faerb) float *aw_w_faerb(void) { return faerb; }
EXPORT(aw_w_listenpuffer) double *aw_w_listenpuffer(void) { return listen + listen_n; }

static const char *kopie(const char *s) {
  int n = (int)strlen(s) + 1;
  if (ablage_n + n > (int)sizeof ablage) return "";
  char *p = ablage + ablage_n; memcpy(p, s, (size_t)n); ablage_n += n;
  return p;
}
/** Name steht in text (bis zum ersten Nullbyte), ein Textwert direkt dahinter */
EXPORT(aw_w_zahl) void aw_w_zahl(double v) {
  if (werte_n >= 64) return;
  AwWert *w = &werte[werte_n++]; memset(w, 0, sizeof *w);
  w->name = kopie(text); w->zahl = v;
}
EXPORT(aw_w_textwert) void aw_w_textwert(void) {
  if (werte_n >= 64) return;
  AwWert *w = &werte[werte_n++]; memset(w, 0, sizeof *w);
  w->name = kopie(text); w->text = kopie(text + strlen(text) + 1);
}
/** n Werte liegen schon an aw_w_listenpuffer() */
EXPORT(aw_w_liste) void aw_w_liste(int n) {
  if (werte_n >= 64 || listen_n + n > 64 * 64) return;
  AwWert *w = &werte[werte_n++]; memset(w, 0, sizeof *w);
  w->name = kopie(text); w->liste = listen + listen_n; w->liste_n = n; listen_n += n;
}
EXPORT(aw_w_setzen) void aw_w_setzen(AwFx *fx) {
  aw_fx_setzen(fx, werte, werte_n);
  werte_n = 0; ablage_n = 0; listen_n = 0;
}
/** Art steht in text */
EXPORT(aw_w_neu) AwFx *aw_w_neu(double sr, unsigned seed) { return aw_fx_neu(text, sr, seed); }
/** Was steht in text ("messen"/"delta") */
EXPORT(aw_w_steuern) void aw_w_steuern(AwFx *fx, int an) { aw_fx_steuern(fx, text, an); }
EXPORT(aw_w_block) void aw_w_block(AwFx *fx, int kan, int n, unsigned eingang) {
  const float *e[MAX_KAN]; float *a[MAX_KAN];
  if (kan > MAX_KAN) kan = MAX_KAN;
  if (n > BLOCK) n = BLOCK;
  for (int c = 0; c < kan; c++) { e[c] = (eingang >> c) & 1 ? ein_p[c] : NULL; a[c] = aus_p[c]; }
  aw_fx_block(fx, e, a, kan, n);
}
EXPORT(aw_w_faerbung) int aw_w_faerbung(AwFx *fx) { return aw_fx_faerbung(fx, faerb); }
EXPORT(aw_w_latenz) int aw_w_latenz(AwFx *fx) { return aw_fx_latenz(fx); }
EXPORT(aw_w_frei) void aw_w_frei(AwFx *fx) { aw_fx_frei(fx); }
