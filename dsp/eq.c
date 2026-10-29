// EQ-Sektionen: bis zu 8 Biquads (transponierte Direktform II, double) + Gain. Übersetzung von app/js/eq-worklet.js.
// Die Koeffizienten rechnet die Web-App (Digital: eq-design.js, Analog: eq-passiv.js) und schickt sie fertig – neue Werte
// werden über einen Block linear übergeblendet, der Gain gleitet.
#include "intern.h"

typedef struct {
  AwFx fx;
  double k[40], ziel[40];
  int ziel_neu;
  double gain, gain_ziel;
  double *zustand[16];
} Eq;

static void leer(double *k) { memset(k, 0, sizeof(double) * 40); for (int b = 0; b < 8; b++) k[b * 5] = 1; }

static void eq_setzen(AwFx *fx, const AwWert *w, int n) {
  Eq *e = (Eq *)fx;
  const AwWert *l = wert_liste(w, n, "k");
  double g;
  if (!fx->initial) {
    // Konstruktor: processorOptions {k, gain}
    if (l) { leer(e->k); for (int i = 0; i < l->liste_n && i < 40; i++) e->k[i] = l->liste[i]; }
    if (wert_zahl(w, n, "gain", &g)) e->gain = g;
    e->gain_ziel = e->gain;
    fx->initial = 1;
    return;
  }
  if (l) { leer(e->ziel); for (int i = 0; i < l->liste_n && i < 40; i++) e->ziel[i] = l->liste[i]; e->ziel_neu = 1; }
  if (wert_zahl(w, n, "gain", &g)) e->gain_ziel = g;
}

static void eq_block(AwFx *fx, const float *const *ein, float *const *aus, int kan, int n) {
  Eq *e = (Eq *)fx;
  fx->initial = 1;
  const double *alt = e->k, *neu = e->ziel_neu ? e->ziel : NULL;
  double g0 = e->gain, g1 = e->gain_ziel;
  for (int c = 0; c < kan; c++) {
    const float *x = ein ? ein[c] : NULL;
    float *y = aus[c];
    if (!x || c >= 16) { memset(y, 0, sizeof(float) * (size_t)n); continue; }
    double *z = e->zustand[c];
    if (!z) z = e->zustand[c] = calloc(16, sizeof(double));
    for (int i = 0; i < n; i++) {
      double t = neu ? (double)(i + 1) / n : 0;
      double v = x[i];
      for (int b = 0; b < 8; b++) {
        int o = b * 5;
        double b0 = neu ? alt[o] + (neu[o] - alt[o]) * t : alt[o];
        if (!neu && b0 == 1 && alt[o + 1] == 0 && alt[o + 2] == 0 && alt[o + 3] == 0 && alt[o + 4] == 0) continue;
        double b1 = neu ? alt[o + 1] + (neu[o + 1] - alt[o + 1]) * t : alt[o + 1];
        double b2 = neu ? alt[o + 2] + (neu[o + 2] - alt[o + 2]) * t : alt[o + 2];
        double a1 = neu ? alt[o + 3] + (neu[o + 3] - alt[o + 3]) * t : alt[o + 3];
        double a2 = neu ? alt[o + 4] + (neu[o + 4] - alt[o + 4]) * t : alt[o + 4];
        int s = b * 2;
        double w = b0 * v + z[s];
        z[s] = b1 * v - a1 * w + z[s + 1];
        z[s + 1] = b2 * v - a2 * w;
        v = w;
      }
      y[i] = (float)(v * (g0 + (g1 - g0) * ((double)(i + 1) / n)));
    }
  }
  if (neu) { memcpy(e->k, e->ziel, sizeof e->k); e->ziel_neu = 0; }
  e->gain = g1;
  for (int c = 0; c < 16; c++) if (e->zustand[c]) for (int i = 0; i < 16; i++) if (fabs(e->zustand[c][i]) < 1e-30) e->zustand[c][i] = 0;
}

static void eq_frei(AwFx *fx) {
  Eq *e = (Eq *)fx;
  for (int c = 0; c < 16; c++) free(e->zustand[c]);
  free(e);
}

AwFx *eq_neu(double sr) {
  Eq *e = calloc(1, sizeof *e);
  e->fx.setzen = eq_setzen; e->fx.block = eq_block; e->fx.frei = eq_frei; e->fx.sr = sr;
  leer(e->k); leer(e->ziel);
  e->gain = e->gain_ziel = 1;
  return &e->fx;
}
