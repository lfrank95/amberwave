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
    fx->mit_sp = strcmp(art, "eq") != 0;
  }
  return fx;
}
double exemplar_faktor(int ex, int idx, double basis, double streu) {
  if (ex <= 1) return basis;
  uint32_t a = (uint32_t)(ex * 7919 + idx * 104729);
  aw_zufall(&a);
  return 1 + (aw_zufall(&a) * 2 - 1) * streu;
}

/* ---------- Innenleben: Netzteil, Übersprechen, Brumm (hinter dem Gerät, sehr leise) ---------- */

static void innen_setzen(AwFx *fx, const AwWert *w, int n) {
  double v; const char *t;
  if (wert_zahl(w, n, "exemplar", &v)) fx->exemplar = (int)klemmen(v, 1, 4);
  if ((t = wert_text(w, n, "netzteil"))) fx->netz = !strcmp(t, "gemeinsam") ? 2 : !strcmp(t, "getrennt") ? 1 : 0;
  if (wert_zahl(w, n, "uebersprechen", &v)) fx->ueber = v <= -120 || v >= 0 ? 0 : pow(10, klemmen(v, -100, -30) / 20);
  if (wert_zahl(w, n, "brumm", &v)) fx->brumm = v != 0;
  if (wert_zahl(w, n, "netzfrequenz", &v)) fx->brumm_hz = v == 60 ? 60 : 50;
  // Verteilung 0…1: Richtung Seiten fahren die Seiten bis +9 dB heißer ins Gerät und die Mitte bis −9 dB sanfter (Richtung Mitte
  // umgekehrt); hinter dem Gerät wird beides genau zurückgenommen – Lautheit und Anteil bleiben, nur die Sättigung wandert
  if (wert_zahl(w, n, "vert", &v)) { fx->vt_ziel = pow(10, 9 * (klemmen(v, 0, 1) - 0.5) * 2 / 20); if (!fx->gestartet || fx->vt_ist <= 0) fx->vt_ist = fx->vt_ziel; }
}

/** Effekt-Block mit Verteilung: M/S gewichtet → Schwerpunkt/Effekt → zurückgewichtet. Bei „gleich“ direkt (bitgleich wie bisher). */
static void vt_block(AwFx *fx, const float *const *ein, float *const *aus, int kan, int n) {
  double g0 = fx->vt_ist > 0 ? fx->vt_ist : 1, g1 = fx->vt_ziel > 0 ? fx->vt_ziel : 1;
  if (kan != 2 || !ein || !ein[0] || !ein[1] || (g0 == 1 && g1 == 1)) { sp_block(fx, ein, aus, kan, n); fx->vt_ist = g1; return; }
  if (fx->vt_kap < n) { for (int c = 0; c < 2; c++) { free(fx->vt_puf[c]); fx->vt_puf[c] = malloc(sizeof(float) * (size_t)n); } fx->vt_kap = n; }
  float *l2 = fx->vt_puf[0], *r2 = fx->vt_puf[1];
  const double dg = (g1 - g0) / n;
  for (int i = 0; i < n; i++) {
    double gs = g0 + dg * (i + 1), gm = 1 / gs;
    double m = ((double)ein[0][i] + ein[1][i]) * 0.5, s = ((double)ein[0][i] - ein[1][i]) * 0.5;
    l2[i] = (float)(m * gm + s * gs); r2[i] = (float)(m * gm - s * gs);
  }
  const float *e2[2] = { l2, r2 };
  sp_block(fx, e2, aus, kan, n);
  for (int i = 0; i < n; i++) {
    double gs = g0 + dg * (i + 1), gm = 1 / gs;
    double m = ((double)aus[0][i] + aus[1][i]) * 0.5 / gm, s = ((double)aus[0][i] - aus[1][i]) * 0.5 / gs;
    aus[0][i] = (float)(m + s); aus[1][i] = (float)(m - s);
  }
  fx->vt_ist = g1;
}

static void innen_block(AwFx *fx, float *const *aus, int kan, int n) {
  const double sr = fx->sr;
  int st = kan >= 2 && aus[0] && aus[1];
  if (fx->netz) {
    // Netzteil gibt unter Last nach: etwa −0,2 dB bei einem Dauerton mit −6 dBFS, höchstens −0,6 dB; gemeinsam zieht jeder Kanal beide herunter
    const double ka = 1 - exp(-1 / (sr * 0.02)), kr = 1 - exp(-1 / (sr * 0.25)), k = 0.07;
    for (int i = 0; i < n; i++) {
      double e[2];
      for (int c = 0; c < (st ? 2 : 1); c++) { double a = fabs(aus[c][i]); fx->netz_env[c] += (a > fx->netz_env[c] ? ka : kr) * (a - fx->netz_env[c]); e[c] = fx->netz_env[c]; }
      if (!st) { aus[0][i] = (float)(aus[0][i] * (1 - k * min_d(1, e[0]))); continue; }
      double gl = fx->netz == 2 ? 0.5 * (e[0] + e[1]) : e[0], gr = fx->netz == 2 ? gl : e[1];
      aus[0][i] = (float)(aus[0][i] * (1 - k * min_d(1, gl)));
      aus[1][i] = (float)(aus[1][i] * (1 - k * min_d(1, gr)));
    }
  }
  if (fx->ueber > 0 && st) {
    // kapazitives Übersprechen: Hochpass 1. Ordnung bei 10 kHz – steigt mit 6 dB/Okt. zu den Höhen
    double a = exp(-2 * M_PI * 10000 / sr), g = fx->ueber * M_SQRT2;
    for (int i = 0; i < n; i++) {
      double l = aus[0][i], r = aus[1][i];
      fx->ueber_z[0] = a * (fx->ueber_z[0] + l - fx->ueber_x[0]); fx->ueber_x[0] = l;
      fx->ueber_z[1] = a * (fx->ueber_z[1] + r - fx->ueber_x[1]); fx->ueber_x[1] = r;
      aus[0][i] = (float)(l + g * fx->ueber_z[1]);
      aus[1][i] = (float)(r + g * fx->ueber_z[0]);
    }
  }
  if (fx->brumm) {
    // Netzbrumm: Grundton und Gleichrichter-Oberwelle, −88 dBFS im Leerlauf, unter Last bis −80 dBFS
    double f = fx->brumm_hz > 0 ? fx->brumm_hz : 50, inc = 2 * M_PI * f / sr, kr = 1 - exp(-1 / (sr * 0.3));
    for (int i = 0; i < n; i++) {
      double a = st ? 0.5 * (fabs(aus[0][i]) + fabs(aus[1][i])) : fabs(aus[0][i]);
      fx->brumm_env += kr * (a - fx->brumm_env);
      double p = fx->brumm_ph, b = (sin(p) + 0.6 * sin(2 * p + 0.4) + 0.25 * sin(3 * p + 1.1)) * 4e-5 * (1 + 1.5 * min_d(1, fx->brumm_env));
      fx->brumm_ph = p + inc > 2 * M_PI ? p + inc - 2 * M_PI : p + inc;
      for (int c = 0; c < kan; c++) if (aus[c]) aus[c][i] = (float)(aus[c][i] + (c & 1 ? 0.92 : 1) * b);
    }
  }
}

void aw_fx_setzen(AwFx *fx, const AwWert *w, int n) {
  if (!fx) return;
  if (fx->mit_sp) innen_setzen(fx, w, n);
  fx->setzen(fx, w, n);
  if (fx->mit_sp) sp_setzen(fx, w, n);
}
void aw_fx_steuern(AwFx *fx, const char *was, int an) {
  if (!fx) return;
  if (!strcmp(was, "messen")) { fx->messen = !!an; faerb_leeren(fx->messer); fx->messer->neu = 0; }
  else if (!strcmp(was, "delta")) fx->delta_ziel = an ? 1 : 0;
}
void aw_fx_block(AwFx *fx, const float *const *ein, float *const *aus, int kan, int n) {
  if (!fx || n <= 0) return;
  if (fx->mit_sp) vt_block(fx, ein, aus, kan, n); else sp_block(fx, ein, aus, kan, n);
  if (fx->netz || fx->ueber > 0 || fx->brumm) innen_block(fx, aus, kan, n);
}
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
  free(fx->vt_puf[0]); free(fx->vt_puf[1]);
  sp_frei(fx);
  fx->frei(fx);
}
