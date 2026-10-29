// Gemeinsame Bausteine der Effekte (nur intern)
#pragma once
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include "aw_dsp.h"

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif
#ifndef M_LN2
#define M_LN2 0.69314718055994530942
#endif
#ifndef M_SQRT2
#define M_SQRT2 1.41421356237309504880
#endif

/** Grundgerüst jedes Effekts: Funktionstabelle + gemeinsamer Zustand */
struct AwFx {
  void (*setzen)(AwFx *, const AwWert *, int);
  void (*block)(AwFx *, const float *const *, float *const *, int, int);
  void (*frei)(AwFx *);
  int latenz;
  int initial;      /* erste Werte gesetzt (entspricht processorOptions im Konstruktor) */
  int gestartet;    /* erster Block gelaufen – danach gleiten neue Werte über den nächsten Block */
  double sr;
  uint32_t zufall;
  /* Färbungsmessung */
  int messen;
  struct Faerb *messer;
  /* Delta-Hören */
  int delta_ziel;
  double dz;
  float *dz_puffer;
  int dz_kap;
};

/** Färbungsmessung (wie FaerbMesser in den Worklets) */
typedef struct Faerb {
  float *abw[2], *lin[2];
  int kap;
  double r[2], rs[2], s[2], rl[2];
  long n;
  int neu;
  float wert[2];
} Faerb;

Faerb *faerb_neu(void);
void faerb_frei(Faerb *m);
void faerb_leeren(Faerb *m);
void faerb_start(Faerb *m, int n);
void faerb_sammeln(Faerb *m, int n, int ms, double sr);

/** Delta-Verlauf (0 → 1 in 20 ms); NULL = Delta aus und ausgeklungen */
const float *delta_verlauf(AwFx *p, int n);

double bessel_i0(double x);
/** Kaiser-Tiefpass für OS-faches Hoch-/Abwärtstasten: Länge ph*os, gefüllt bis taps (Rest 0) */
double *fir_entwurf(int os, int taps, int ph, double beta);
/** Halbband-Filter (25 Taps, Kaiser β = 10) für das innere 2× im HQ-Modus */
const double *halbband(void);
#define HB_L 25
#define HB_VERZ 3
#define HB_MITTE 12

/** tanh als Padé-Näherung (wie th() in den Worklets) */
static inline double th(double x) {
  if (x > 4.97) return 1;
  if (x < -4.97) return -1;
  double x2 = x * x;
  return x * (135135 + x2 * (17325 + x2 * (378 + x2))) / (135135 + x2 * (62370 + x2 * (3150 + 28 * x2)));
}

/** Skalarprodukt mit vier Teilsummen (vektorisierbar; Summationsreihenfolge weicht nur in der letzten Stelle ab) */
static inline double skalar(const double *a, const double *b, int n) {
  double s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  int i = 0;
  for (; i + 4 <= n; i += 4) { s0 += a[i] * b[i]; s1 += a[i + 1] * b[i + 1]; s2 += a[i + 2] * b[i + 2]; s3 += a[i + 3] * b[i + 3]; }
  for (; i < n; i++) s0 += a[i] * b[i];
  return (s0 + s1) + (s2 + s3);
}
/** Polyphasen-Tabelle für das Hochtasten: je Phase k die Koeffizienten rückwärts, passend zu einem vorwärts gelesenen Ring */
double *polyphase(const double *fir, int os, int ph);
/** FIR rückwärts (Abwärtstasten mit vorwärts gelesenem Ring) */
double *rueckwaerts(const double *fir, int taps);

static inline double klemmen(double x, double lo, double hi) { return x < lo ? lo : x > hi ? hi : x; }
static inline double min_d(double a, double b) { return a < b ? a : b; }
static inline double max_d(double a, double b) { return a > b ? a : b; }

/** Wert aus einer Parameterliste holen: 1 = gefunden */
int wert_zahl(const AwWert *w, int n, const char *name, double *aus);
const char *wert_text(const AwWert *w, int n, const char *name);
const AwWert *wert_liste(const AwWert *w, int n, const char *name);

AwFx *glow_neu(double sr);
AwFx *iron_neu(double sr);
AwFx *silk_neu(double sr);
AwFx *eq_neu(double sr);
