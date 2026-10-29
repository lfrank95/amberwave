// Abtastraten-Umrechnung (für eine feste Ausgaberate): rationales Verhältnis L/M, Polyphasen-FIR aus einem Kaiser-
// gefensterten Sinc. Durchlass bis 90,7 % der kleineren Nyquist-Frequenz (20 kHz bei 44,1 kHz), Sperrdämpfung 150 dB,
// linearphasig. Gerechnet wird in double; Ein- und Ausgabe planar float.
#include "intern.h"
#include <stdatomic.h>

#define SPERR_DB 150.0
#define DURCHLASS 0.907

struct AwSrc {
  int L, M, T, kan;          // Verhältnis aus/ein = L/M, Taps je Phase
  double *tab;               // L × T (Phase p: Koeffizient k gehört zu x[i − k]); gehört dem Zwischenspeicher (eigen = 0) oder dem Umrechner
  double *hist[8];           // je Kanal: letzte T−1 Eingangswerte + Platz für ein Stück
  int hist_kap;
  int eigen;                 // 1: tab gehört diesem Umrechner
  int64_t t;                 // Zeit des nächsten Ausgangswerts in Prototyp-Takten, relativ zum ältesten Wert in hist
  int fuell;                 // gültige Werte in hist (T−1 Vorlauf + neue)
};

static long ggt(long a, long b) { while (b) { long t = a % b; a = b; b = t; } return a; }
static double i0(double x) { double s = 1, t = 1; for (int k = 1; k < 200; k++) { double q = x / (2 * k); t *= q * q; s += t; if (t < 1e-21 * s) break; } return s; }

// Der Filter ist groß (44,1 → 96 kHz: rund 70 000 Koeffizienten mit Kaiser-Fenster, einige 10 ms Rechenzeit). Beim Titelwechsel
// mit anderer Rate darf das nicht im Audio-Weg passieren: fertige Tabellen bleiben im Zwischenspeicher (unveränderlich, geteilt),
// aw_src_vorwaermen() rechnet sie vorab in einem Hintergrund-Thread.
typedef struct { int ein, aus, L, M, T; double *tab; } Tabelle;
#define TAB_MAX 24
static Tabelle tabellen[TAB_MAX];
static int n_tabellen;
static atomic_flag tab_sperre = ATOMIC_FLAG_INIT;
static void sperre(void) { while (atomic_flag_test_and_set_explicit(&tab_sperre, memory_order_acquire)) {} }
static void freigeben(void) { atomic_flag_clear_explicit(&tab_sperre, memory_order_release); }

static int tabelle_suchen(int ein, int aus, Tabelle *t) {
  int r = 0;
  sperre();
  for (int i = 0; i < n_tabellen; i++) if (tabellen[i].ein == ein && tabellen[i].aus == aus) { *t = tabellen[i]; r = 1; break; }
  freigeben();
  return r;
}

static Tabelle tabelle_rechnen(int rate_ein, int rate_aus) {
  Tabelle t = { rate_ein, rate_aus, 0, 0, 0, NULL };
  long g = ggt(rate_aus, rate_ein);
  t.L = (int)(rate_aus / g); t.M = (int)(rate_ein / g);
  double fs_proto = (double)rate_ein * t.L;
  double nyq = (rate_ein < rate_aus ? rate_ein : rate_aus) / 2.0;
  double fp = nyq * DURCHLASS, fsp = nyq, fc = (fp + fsp) / 2;
  double beta = 0.1102 * (SPERR_DB - 8.7);
  long N = (long)ceil((SPERR_DB - 7.95) / (14.36 * (fsp - fp) / fs_proto)) + 1;
  t.T = (int)((N + t.L - 1) / t.L);
  if (t.T < 8) t.T = 8;
  N = (long)t.T * t.L;
  t.tab = calloc((size_t)N, sizeof(double));
  double mitte = (N - 1) / 2.0, i0b = i0(beta), w = fc / fs_proto;
  double *h = malloc(sizeof(double) * (size_t)N);
  if (!t.tab || !h) { free(t.tab); free(h); t.tab = NULL; return t; }
  for (long n = 0; n < N; n++) {
    double x = n - mitte, r = x / mitte;
    double si = fabs(x) < 1e-12 ? 2 * w : sin(2 * M_PI * w * x) / (M_PI * x);
    h[n] = si * i0(beta * sqrt(r * r < 1 ? 1 - r * r : 0)) / i0b * t.L;
  }
  // insgesamt auf Verstärkung 1 normieren (Summe = L); je Phase normiert verschöbe es die Phasen leicht gegeneinander
  double sum = 0;
  for (long n = 0; n < N; n++) sum += h[n];
  for (int p = 0; p < t.L; p++)
    for (int k = 0; k < t.T; k++) t.tab[(size_t)p * t.T + k] = h[p + (long)k * t.L] * t.L / sum;
  free(h);
  return t;
}

/** Tabelle holen (aus dem Zwischenspeicher, sonst rechnen). eigen = 1, wenn der Speicher voll ist und der Aufrufer sie behält */
static int tabelle_holen(int ein, int aus, Tabelle *t, int *eigen) {
  *eigen = 0;
  if (tabelle_suchen(ein, aus, t)) return 1;
  Tabelle n = tabelle_rechnen(ein, aus);
  if (!n.tab) return 0;
  sperre();
  int vorhanden = 0;
  for (int i = 0; i < n_tabellen; i++) if (tabellen[i].ein == ein && tabellen[i].aus == aus) { *t = tabellen[i]; vorhanden = 1; break; }
  if (!vorhanden) {
    if (n_tabellen < TAB_MAX) { tabellen[n_tabellen++] = n; *t = n; }
    else { *t = n; *eigen = 1; }
  }
  freigeben();
  if (vorhanden) free(n.tab);
  return 1;
}

/** Filter für ein Ratenpaar vorab rechnen (im Hintergrund aufrufen), damit der Wechsel später ohne Rechenpause geht */
void aw_src_vorwaermen(int rate_ein, int rate_aus) {
  if (rate_ein <= 0 || rate_aus <= 0 || rate_ein == rate_aus) return;
  Tabelle t; int eigen;
  if (tabelle_holen(rate_ein, rate_aus, &t, &eigen) && eigen) free(t.tab);
}

AwSrc *aw_src_neu(int rate_ein, int rate_aus, int kanaele) {
  if (rate_ein <= 0 || rate_aus <= 0 || kanaele < 1 || kanaele > 8) return NULL;
  Tabelle t; int eigen;
  if (!tabelle_holen(rate_ein, rate_aus, &t, &eigen)) return NULL;
  AwSrc *s = calloc(1, sizeof *s);
  s->L = t.L; s->M = t.M; s->T = t.T; s->kan = kanaele; s->tab = t.tab; s->eigen = eigen;
  s->fuell = s->T - 1;   // Vorlauf aus Stille
  s->hist_kap = s->T + 4096;
  for (int c = 0; c < kanaele; c++) s->hist[c] = calloc((size_t)s->hist_kap, sizeof(double));
  return s;
}

int aw_src_taps(const AwSrc *s) { return s->T; }

/** Verzögerung in Eingangs-Frames (Gruppenlaufzeit des Filters) */
double aw_src_verzoegerung(const AwSrc *s) { return ((double)s->T * s->L - 1) / 2.0 / s->L; }

/** höchstens so viele Ausgangs-Frames entstehen aus n Eingangs-Frames */
int aw_src_aus_max(const AwSrc *s, int n) { return (int)(((int64_t)n * s->L) / s->M) + 2; }

/** so viele Eingangs-Frames reichen sicher für m Ausgangs-Frames */
int aw_src_ein_fuer(const AwSrc *s, int m) { return (int)(((int64_t)m * s->M + s->L - 1) / s->L) + 1; }

int aw_src_rechnen(AwSrc *s, const float *const *ein, int n, float *const *aus, int max) {
  int T = s->T, L = s->L, M = s->M;
  if (s->hist_kap < s->fuell + n) {
    s->hist_kap = s->fuell + n + 4096;
    for (int c = 0; c < s->kan; c++) s->hist[c] = realloc(s->hist[c], sizeof(double) * (size_t)s->hist_kap);
    if (!s->hist[0]) return 0;
  }
  for (int c = 0; c < s->kan; c++) for (int i = 0; i < n; i++) s->hist[c][s->fuell + i] = ein ? (ein[c] ? ein[c][i] : 0) : 0;
  s->fuell += n;
  int m = 0;
  // Ausgang bei Prototyp-Zeit t braucht Eingang i = t / L (Index in hist, ≥ T−1) und die T−1 davor
  for (;;) {
    int64_t i = s->t / L + (T - 1);
    if (i >= s->fuell || m >= max) break;
    int p = (int)(s->t % L);
    const double *k = s->tab + (size_t)p * T;
    for (int c = 0; c < s->kan; c++) {
      const double *x = s->hist[c] + i;
      double acc = 0;
      for (int j = 0; j < T; j++) acc += k[j] * x[-j];
      aus[c][m] = (float)acc;
    }
    m++;
    s->t += M;
  }
  // verbrauchte Werte vorne entfernen (die letzten T−1 vor der nächsten Position bleiben)
  int64_t naechst = s->t / L;            // Index (ohne Vorlauf) des nächsten benötigten Werts
  int weg = (int)naechst;
  if (weg > s->fuell - (T - 1)) weg = s->fuell - (T - 1);
  if (weg > 0) {
    for (int c = 0; c < s->kan; c++) memmove(s->hist[c], s->hist[c] + weg, sizeof(double) * (size_t)(s->fuell - weg));
    s->fuell -= weg;
    s->t -= (int64_t)weg * L;
  }
  return m;
}

/** Rest ausgeben (Nachlauf des Filters mit Stille füllen) */
int aw_src_nachlauf(AwSrc *s, float *const *aus, int max) {
  int n = (s->T + 1) / 2 + 1;
  return aw_src_rechnen(s, NULL, n, aus, max);
}

void aw_src_frei(AwSrc *s) {
  if (!s) return;
  for (int c = 0; c < 8; c++) free(s->hist[c]);
  if (s->eigen) free(s->tab);
  free(s);
}
