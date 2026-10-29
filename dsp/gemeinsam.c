// Gemeinsame Bausteine: Filterentwurf, Färbungsmessung, Delta, Zufall, Parameter, Verteiler auf die Effekte
#include "intern.h"

double aw_zufall(uint32_t *a) {
  // mulberry32 – im Vergleichstest ersetzt genau diese Folge Math.random
  *a += 0x6D2B79F5u;
  uint32_t t = *a;
  t = (t ^ (t >> 15)) * (1u | t);
  t = (t + ((t ^ (t >> 7)) * (61u | t))) ^ t;
  return (double)(t ^ (t >> 14)) / 4294967296.0;
}

double bessel_i0(double x) {
  double s = 1, t = 1;
  for (int k = 1; k < 30; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; }
  return s;
}

double *fir_entwurf(int os, int taps, int ph, double beta) {
  double *h = calloc((size_t)(ph * os), sizeof(double));
  double m = (taps - 1) / 2.0, fc = 0.5 / os, i0b = bessel_i0(beta), summe = 0;
  for (int i = 0; i < taps; i++) {
    double n = i - m;
    double sinc = n == 0 ? 2 * fc : sin(2 * M_PI * fc * n) / (M_PI * n);
    double r = taps > 1 ? (2.0 * i) / (taps - 1) - 1 : 0;
    h[i] = sinc * bessel_i0(beta * sqrt(max_d(0, 1 - r * r))) / i0b;
    summe += h[i];
  }
  for (int i = 0; i < taps; i++) h[i] /= summe;
  return h;
}

double *polyphase(const double *fir, int os, int ph) {
  double *p = malloc(sizeof(double) * (size_t)(os * ph));
  for (int k = 0; k < os; k++) for (int m = 0; m < ph; m++) p[k * ph + m] = fir[k + os * (ph - 1 - m)];
  return p;
}
double *rueckwaerts(const double *fir, int taps) {
  double *r = malloc(sizeof(double) * (size_t)taps);
  for (int t = 0; t < taps; t++) r[t] = fir[taps - 1 - t];
  return r;
}

const double *halbband(void) {
  static double h[HB_L];
  static int fertig = 0;
  if (fertig) return h;
  double m = (HB_L - 1) / 2.0, beta = 10, summe = 0;
  for (int i = 0; i < HB_L; i++) {
    double n = i - m;
    int ni = (int)n;
    double sinc = n == 0 ? 0.5 : (ni % 2 == 0 ? 0 : sin(M_PI * n / 2) / (M_PI * n));
    double r = (2.0 * i) / (HB_L - 1) - 1;
    h[i] = sinc * bessel_i0(beta * sqrt(max_d(0, 1 - r * r))) / bessel_i0(beta);
    summe += h[i];
  }
  for (int i = 0; i < HB_L; i++) h[i] /= summe;
  fertig = 1;
  return h;
}

/* ---------- Färbungsmessung ---------- */

Faerb *faerb_neu(void) {
  Faerb *m = calloc(1, sizeof *m);
  return m;
}
void faerb_frei(Faerb *m) {
  if (!m) return;
  for (int c = 0; c < 2; c++) { free(m->abw[c]); free(m->lin[c]); }
  free(m);
}
void faerb_leeren(Faerb *m) {
  for (int c = 0; c < 2; c++) m->r[c] = m->rs[c] = m->s[c] = m->rl[c] = 0;
  m->n = 0;
}
void faerb_start(Faerb *m, int n) {
  if (m->kap < n) {
    for (int c = 0; c < 2; c++) {
      free(m->abw[c]); free(m->lin[c]);
      m->abw[c] = malloc(sizeof(float) * (size_t)n);
      m->lin[c] = malloc(sizeof(float) * (size_t)n);
    }
    m->kap = n;
  }
  for (int c = 0; c < 2; c++) { memset(m->abw[c], 0, sizeof(float) * (size_t)n); memset(m->lin[c], 0, sizeof(float) * (size_t)n); }
}
void faerb_sammeln(Faerb *m, int n, int ms, double sr) {
  const float *a0 = m->abw[0], *a1 = m->abw[1], *l0 = m->lin[0], *l1 = m->lin[1];
  for (int i = 0; i < n; i++) {
    double ra = a0[i], rb = a1[i], sa = l0[i], sb = l1[i];
    if (ms) { double x = ra + rb; rb = ra - rb; ra = x; double u = sa + sb; sb = sa - sb; sa = u; }
    m->r[0] += ra * ra; m->rs[0] += ra; m->s[0] += sa * sa; m->rl[0] += ra * sa;
    m->r[1] += rb * rb; m->rs[1] += rb; m->s[1] += sb * sb; m->rl[1] += rb * sb;
  }
  m->n += n;
  if (m->n >= sr * 0.05) {
    for (int c = 0; c < 2; c++) {
      double w = 0;
      if (m->s[c] > 1e-9 * m->n) {
        double e = m->r[c] - m->rs[c] * m->rs[c] / m->n - m->rl[c] * m->rl[c] / m->s[c];
        w = min_d(1, sqrt(max_d(0, e) / m->s[c]));
      }
      m->wert[c] = (float)w;
    }
    m->neu = 1;
    faerb_leeren(m);
  }
}

/* ---------- Delta ---------- */

const float *delta_verlauf(AwFx *p, int n) {
  int ziel = p->delta_ziel;
  if (!p->dz && !ziel) return NULL;
  if (p->dz_kap < n) { free(p->dz_puffer); p->dz_puffer = malloc(sizeof(float) * (size_t)n); p->dz_kap = n; }
  double schritt = 1 / (0.02 * p->sr);
  double d = p->dz;
  for (int i = 0; i < n; i++) { d += max_d(-schritt, min_d(schritt, ziel - d)); p->dz_puffer[i] = (float)d; }
  p->dz = d < 1e-6 && !ziel ? 0 : d;
  return p->dz_puffer;
}

/* ---------- Parameter ---------- */

int wert_zahl(const AwWert *w, int n, const char *name, double *aus) {
  for (int i = 0; i < n; i++) if (!strcmp(w[i].name, name) && !w[i].text && !w[i].liste) { *aus = w[i].zahl; return 1; }
  return 0;
}
const char *wert_text(const AwWert *w, int n, const char *name) {
  for (int i = 0; i < n; i++) if (!strcmp(w[i].name, name) && w[i].text) return w[i].text;
  return NULL;
}
const AwWert *wert_liste(const AwWert *w, int n, const char *name) {
  for (int i = 0; i < n; i++) if (!strcmp(w[i].name, name) && w[i].liste) return &w[i];
  return NULL;
}

/* ---------- Verteiler ---------- */

AwFx *aw_fx_neu(const char *art, double sr, uint32_t seed) {
  AwFx *fx = NULL;
  if (!strcmp(art, "glow")) fx = glow_neu(sr);
  else if (!strcmp(art, "iron")) fx = iron_neu(sr);
  else if (!strcmp(art, "silk")) fx = silk_neu(sr);
  else if (!strcmp(art, "eq")) fx = eq_neu(sr);
  if (fx) {
    fx->zufall = seed;
    fx->messer = faerb_neu();
  }
  return fx;
}
void aw_fx_setzen(AwFx *fx, const AwWert *w, int n) { if (fx) fx->setzen(fx, w, n); }
void aw_fx_steuern(AwFx *fx, const char *was, int an) {
  if (!fx) return;
  if (!strcmp(was, "messen")) { fx->messen = !!an; faerb_leeren(fx->messer); fx->messer->neu = 0; }
  else if (!strcmp(was, "delta")) fx->delta_ziel = an ? 1 : 0;
}
void aw_fx_block(AwFx *fx, const float *const *ein, float *const *aus, int kan, int n) { if (fx && n > 0) fx->block(fx, ein, aus, kan, n); }
int aw_fx_faerbung(AwFx *fx, float w[2]) {
  if (!fx || !fx->messer->neu) return 0;
  w[0] = fx->messer->wert[0]; w[1] = fx->messer->wert[1];
  fx->messer->neu = 0;
  return 1;
}
int aw_fx_latenz(AwFx *fx) { return fx ? fx->latenz : 0; }
void aw_fx_frei(AwFx *fx) {
  if (!fx) return;
  faerb_frei(fx->messer);
  free(fx->dz_puffer);
  fx->frei(fx);
}
