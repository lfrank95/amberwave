// Space im Windows Client: rechnet einen Web-Audio-Graphen nach, den die Web-App mit denselben Funktionen wie im Browser
// gebaut hat (app/js/raumnativ.js schreibt ihn als Text). Unterstützt genau die Knoten, die Space braucht – Gain, Biquad,
// IIR, Delay, Convolver, Splitter, Merger und den Upmix-Worklet – mit den Kanalregeln von Web Audio (channelCount,
// channelCountMode, channelInterpretation: speakers/discrete) und Parameter-Automation (set, linearRamp, setTarget, cancel).
// Gerechnet wird in Quanten zu 128 Frames wie im Browser; der Graph läuft deshalb um 128 Frames verzögert (FIFO).
#include "intern.h"
#include <stdio.h>
#include <ctype.h>

#define Q 128
#define MAXK 8          /* Kanäle je Ausgang */
#define MAXV 64         /* Verbindungen je Knoten-Eingang */

enum { T_GAIN, T_BIQUAD, T_IIR, T_DELAY, T_CONV, T_SPLIT, T_MERGE, T_UPMIX, T_QUELLE };
enum { M_MAX, M_CLAMPED, M_EXPLICIT };
enum { E_SET, E_RAMP, E_ZIEL };

typedef struct { int typ; double t, w, tau; } Ereignis;

typedef struct {
  double v;                 /* aktueller Wert */
  Ereignis *e; int n, kap;  /* anstehende Ereignisse (nach Zeit sortiert) */
  int modus;                /* 0 konstant, 1 Ziel */
  double ziel, tau, t0, v0; /* laufendes setTarget */
  double st, sv;            /* Beginn des Abschnitts (für Rampen) */
} Param;

typedef struct Knoten Knoten;
typedef struct { Knoten *von; int aus; } Verb;

struct Knoten {
  int id, typ;
  int cc, ccm, ci;          /* channelCount, -Mode, -Interpretation (0 speakers, 1 discrete) */
  int n_ein, n_aus;
  Verb *ein[MAXK]; int n_verb[MAXK];
  int aus_kan[MAXK];        /* Kanäle je Ausgang (im aktuellen Quantum) */
  float *aus[MAXK][MAXK];   /* Ausgang × Kanal × Q */
  int fest_aus_kan[MAXK];   /* Upmix: feste Kanalzahl je Ausgang */
  /* Parameter */
  Param p;                  /* gain bzw. delayTime */
  /* Biquad / IIR */
  char btyp[16]; double f, q, g;
  double b[3], a[3];
  double ff[21], fb[21]; int nff, nfb;
  double zx[MAXK][21], zy[MAXK][21];
  /* Delay */
  double maxd; float *dpuf[MAXK]; int dlen, dpos;
  /* Faltung */
  AwFaltung *falt; int falt_ein;
  /* Upmix */
  AwUpmix *up;
  double u_transient, u_ducking, u_effekte, u_breite; int u_center;
  /* Puffer für die Eingänge */
  float *in[MAXK];          /* gemischter Eingang (Kanäle) */
  int in_kan;
  int besucht, grad;
};

struct AwRaum {
  double sr;
  Knoten **k; int n;
  Knoten **ord;            /* Rechenreihenfolge */
  Knoten *quelle, *ziel;
  long frames;             /* gerechnete Frames (Zeitbasis der Parameter) */
  float fifo_ein[MAXK][Q]; int fifo_n, fifo_ein_kan;
  float fifo_aus[MAXK][Q]; int fifo_aus_kan;
  int aus_kan;
};

/* ---------- Parameter ---------- */

static void param_init(Param *p, double v) { memset(p, 0, sizeof *p); p->v = v; p->sv = v; }

static void param_ereignis(Param *p, int typ, double t, double w, double tau) {
  if (p->n == p->kap) { p->kap = p->kap ? p->kap * 2 : 8; p->e = realloc(p->e, sizeof(Ereignis) * (size_t)p->kap); }
  int i = p->n;
  while (i > 0 && p->e[i - 1].t > t) { p->e[i] = p->e[i - 1]; i--; }   /* gleiche Zeit: in Reihenfolge des Eintreffens */
  p->e[i].typ = typ; p->e[i].t = t; p->e[i].w = w; p->e[i].tau = tau;
  p->n++;
}

static void param_stopp(Param *p, double t) {
  int m = 0;
  for (int i = 0; i < p->n; i++) if (p->e[i].t < t) p->e[m++] = p->e[i];
  p->n = m;
  /* laufende Bewegung anhalten: der Wert bleibt, wo er gerade ist */
  p->modus = 0;
}

/** Wert zur Zeit T (Sekunden), fortschreitend */
static double param_wert(Param *p, double T) {
  while (p->n > 0) {
    Ereignis *e = &p->e[0];
    if (e->t > T) break;
    if (e->typ == E_SET) { p->v = e->w; p->modus = 0; }
    else if (e->typ == E_RAMP) { p->v = e->w; p->modus = 0; }
    else { p->modus = 1; p->ziel = e->w; p->tau = e->tau > 1e-9 ? e->tau : 1e-9; p->t0 = e->t; p->v0 = p->v; }
    p->st = e->t; p->sv = p->modus ? p->v0 : p->v;
    memmove(p->e, p->e + 1, sizeof(Ereignis) * (size_t)(--p->n));
  }
  if (p->n > 0 && p->e[0].typ == E_RAMP) {
    Ereignis *e = &p->e[0];
    double st = p->st, sv = p->modus ? p->v : p->sv;
    if (p->modus) { st = T; }   /* Rampe nach setTarget: ab dem aktuellen Wert */
    double d = e->t - st;
    double x = d > 0 ? (T - st) / d : 1; if (x < 0) x = 0; if (x > 1) x = 1;
    if (!p->modus) p->v = sv + (e->w - sv) * x;
    else { p->v = p->ziel + (p->v0 - p->ziel) * exp(-(T - p->t0) / p->tau); }
    return p->v;
  }
  if (p->modus) p->v = p->ziel + (p->v0 - p->ziel) * exp(-(T - p->t0) / p->tau);
  return p->v;
}

static int param_ruhig(const Param *p) { return p->n == 0 && !p->modus; }

/* ---------- Kanalregeln (Web Audio: speakers / discrete) ---------- */

static void mischen(float *const *dst, int dk, float *const *src, int sk, int discrete) {
  const double r = M_SQRT1_2;
  if (dk == sk) { for (int c = 0; c < dk; c++) for (int i = 0; i < Q; i++) dst[c][i] += src[c][i]; return; }
  if (!discrete) {
    if (sk == 1 && dk == 2) { for (int i = 0; i < Q; i++) { dst[0][i] += src[0][i]; dst[1][i] += src[0][i]; } return; }
    if (sk == 1 && dk == 4) { for (int i = 0; i < Q; i++) { dst[0][i] += src[0][i]; dst[1][i] += src[0][i]; } return; }
    if (sk == 1 && dk == 6) { for (int i = 0; i < Q; i++) dst[2][i] += src[0][i]; return; }
    if (sk == 2 && (dk == 4 || dk == 6)) { for (int i = 0; i < Q; i++) { dst[0][i] += src[0][i]; dst[1][i] += src[1][i]; } return; }
    if (sk == 4 && dk == 6) { for (int i = 0; i < Q; i++) { dst[0][i] += src[0][i]; dst[1][i] += src[1][i]; dst[4][i] += src[2][i]; dst[5][i] += src[3][i]; } return; }
    if (sk == 2 && dk == 1) { for (int i = 0; i < Q; i++) dst[0][i] += (float)(0.5 * ((double)src[0][i] + src[1][i])); return; }
    if (sk == 4 && dk == 1) { for (int i = 0; i < Q; i++) dst[0][i] += (float)(0.25 * ((double)src[0][i] + src[1][i] + src[2][i] + src[3][i])); return; }
    if (sk == 6 && dk == 1) { for (int i = 0; i < Q; i++) dst[0][i] += (float)(r * ((double)src[0][i] + src[1][i]) + src[2][i] + 0.5 * ((double)src[4][i] + src[5][i])); return; }
    if (sk == 4 && dk == 2) { for (int i = 0; i < Q; i++) { dst[0][i] += (float)(0.5 * ((double)src[0][i] + src[2][i])); dst[1][i] += (float)(0.5 * ((double)src[1][i] + src[3][i])); } return; }
    if (sk == 6 && dk == 2) { for (int i = 0; i < Q; i++) { dst[0][i] += (float)(src[0][i] + r * ((double)src[2][i] + src[4][i])); dst[1][i] += (float)(src[1][i] + r * ((double)src[2][i] + src[5][i])); } return; }
    if (sk == 6 && dk == 4) { for (int i = 0; i < Q; i++) { dst[0][i] += (float)(src[0][i] + r * src[2][i]); dst[1][i] += (float)(src[1][i] + r * src[2][i]); dst[2][i] += src[4][i]; dst[3][i] += src[5][i]; } return; }
  }
  int m = dk < sk ? dk : sk;
  for (int c = 0; c < m; c++) for (int i = 0; i < Q; i++) dst[c][i] += src[c][i];
}

/* ---------- Filter (Formeln der Web-Audio-Spezifikation) ---------- */

static void biquad_koeff(Knoten *k, double sr) {
  double f0 = k->f, nyq = sr / 2; if (f0 < 0) f0 = 0; if (f0 > nyq) f0 = nyq;
  double A = pow(10, k->g / 40), w0 = 2 * M_PI * f0 / sr, cw = cos(w0), sw = sin(w0);
  double aQ = sw / (2 * k->q), aQdB = sw / (2 * pow(10, k->q / 20)), aS = sw / 2 * sqrt(2.0), sA = sqrt(A);
  double b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  if (!strcmp(k->btyp, "lowpass")) { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; a0 = 1 + aQdB; a1 = -2 * cw; a2 = 1 - aQdB; }
  else if (!strcmp(k->btyp, "highpass")) { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; a0 = 1 + aQdB; a1 = -2 * cw; a2 = 1 - aQdB; }
  else if (!strcmp(k->btyp, "bandpass")) { b0 = aQ; b1 = 0; b2 = -aQ; a0 = 1 + aQ; a1 = -2 * cw; a2 = 1 - aQ; }
  else if (!strcmp(k->btyp, "notch")) { b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + aQ; a1 = -2 * cw; a2 = 1 - aQ; }
  else if (!strcmp(k->btyp, "allpass")) { b0 = 1 - aQ; b1 = -2 * cw; b2 = 1 + aQ; a0 = 1 + aQ; a1 = -2 * cw; a2 = 1 - aQ; }
  else if (!strcmp(k->btyp, "peaking")) { b0 = 1 + aQ * A; b1 = -2 * cw; b2 = 1 - aQ * A; a0 = 1 + aQ / A; a1 = -2 * cw; a2 = 1 - aQ / A; }
  else if (!strcmp(k->btyp, "lowshelf")) {
    b0 = A * ((A + 1) - (A - 1) * cw + 2 * aS * sA); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - 2 * aS * sA);
    a0 = (A + 1) + (A - 1) * cw + 2 * aS * sA; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - 2 * aS * sA;
  } else if (!strcmp(k->btyp, "highshelf")) {
    b0 = A * ((A + 1) + (A - 1) * cw + 2 * aS * sA); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - 2 * aS * sA);
    a0 = (A + 1) - (A - 1) * cw + 2 * aS * sA; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - 2 * aS * sA;
  }
  k->b[0] = b0 / a0; k->b[1] = b1 / a0; k->b[2] = b2 / a0; k->a[1] = a1 / a0; k->a[2] = a2 / a0;
}

/* ---------- Aufbau aus dem Text ---------- */

static Knoten *suchen(AwRaum *r, int id) { for (int i = 0; i < r->n; i++) if (r->k[i]->id == id) return r->k[i]; return NULL; }

static const char *wert_von(const char *zeile, const char *schl, char *puf, size_t pn) {
  size_t l = strlen(schl);
  const char *p = zeile;
  while ((p = strstr(p, schl))) {
    if ((p == zeile || p[-1] == ' ') && p[l] == '=') {
      p += l + 1; size_t i = 0;
      while (*p && *p != ' ' && *p != '\n' && i + 1 < pn) puf[i++] = *p++;
      puf[i] = 0; return puf;
    }
    p += l;
  }
  return NULL;
}
static double zahl_von(const char *z, const char *s, double std) { char b[64]; const char *v = wert_von(z, s, b, sizeof b); return v ? atof(v) : std; }
static int liste_von(const char *z, const char *s, double *aus, int max) {
  char b[1024]; const char *v = wert_von(z, s, b, sizeof b); int n = 0;
  if (!v) return 0;
  while (*v && n < max) { char *e; aus[n++] = strtod(v, &e); if (e == v) break; v = e; if (*v == ',') v++; }
  return n;
}

static void ausgaenge_anlegen(Knoten *k) {
  for (int o = 0; o < k->n_aus; o++) for (int c = 0; c < MAXK; c++) k->aus[o][c] = calloc(Q, sizeof(float));
  for (int c = 0; c < MAXK; c++) k->in[c] = calloc(Q, sizeof(float));
}

AwRaum *aw_raum_neu(const char *text, double sr, AwIrSuche ir_suche, void *u, char *fehler, int fn) {
  AwRaum *r = calloc(1, sizeof *r);
  r->sr = sr;
  int kap = 64; r->k = malloc(sizeof(Knoten *) * (size_t)kap);
  int quelle = -1, ziel = -1;
  const char *p = text;
  char zeile[4096];
  while (*p) {
    size_t l = 0; while (p[l] && p[l] != '\n') l++;
    if (l >= sizeof zeile) l = sizeof zeile - 1;
    memcpy(zeile, p, l); zeile[l] = 0;
    p += l; if (*p == '\n') p++;
    if (zeile[0] == 'N') {
      int id, cc, ccm, ci; char typ[16];
      if (sscanf(zeile, "N %d %15s %d %d %d", &id, typ, &cc, &ccm, &ci) != 5) continue;
      Knoten *k = calloc(1, sizeof *k);
      k->id = id; k->cc = cc < 1 ? 1 : cc > MAXK ? MAXK : cc; k->ccm = ccm; k->ci = ci;
      k->n_ein = 1; k->n_aus = 1;
      if (!strcmp(typ, "gain") || !strcmp(typ, "quelle")) { k->typ = !strcmp(typ, "quelle") ? T_QUELLE : T_GAIN; param_init(&k->p, zahl_von(zeile, "v", 1)); }
      else if (!strcmp(typ, "biquad")) {
        k->typ = T_BIQUAD; char b[16]; snprintf(k->btyp, sizeof k->btyp, "%s", wert_von(zeile, "typ", b, sizeof b) ? b : "lowpass");
        k->f = zahl_von(zeile, "f", 350); k->q = zahl_von(zeile, "q", 1); k->g = zahl_von(zeile, "g", 0);
        biquad_koeff(k, sr);
      } else if (!strcmp(typ, "iir")) {
        k->typ = T_IIR; k->nff = liste_von(zeile, "ff", k->ff, 20); k->nfb = liste_von(zeile, "fb", k->fb, 20);
        double a0 = k->nfb ? k->fb[0] : 1;
        for (int i = 0; i < k->nff; i++) k->ff[i] /= a0;
        for (int i = 0; i < k->nfb; i++) k->fb[i] /= a0;
      } else if (!strcmp(typ, "delay")) {
        k->typ = T_DELAY; k->maxd = zahl_von(zeile, "max", 1); param_init(&k->p, zahl_von(zeile, "v", 0));
        k->dlen = (int)ceil(k->maxd * sr) + 2 * Q + 4;
        for (int c = 0; c < MAXK; c++) k->dpuf[c] = calloc((size_t)k->dlen, sizeof(float));
      } else if (!strcmp(typ, "conv")) {
        k->typ = T_CONV; k->n_aus = 1;
        char b[128];
        const char *irid = wert_von(zeile, "ir", b, sizeof b);
        int ik = 0, in = 0;
        const float *const *ir = irid && ir_suche ? ir_suche(irid, &ik, &in, u) : NULL;
        k->falt_ein = k->ccm == M_EXPLICIT && k->cc == 1 ? 1 : 2;
        if (ir && ik > 0 && in > 0) k->falt = aw_faltung_neu(ir, ik, in, k->falt_ein);
        else if (irid) { if (fehler) snprintf(fehler, (size_t)fn, "Impulsantwort %s fehlt", irid); }
      } else if (!strcmp(typ, "split")) { k->typ = T_SPLIT; k->n_aus = k->cc; }
      else if (!strcmp(typ, "merge")) { k->typ = T_MERGE; k->n_ein = (int)zahl_von(zeile, "n", 2); if (k->n_ein > MAXK) k->n_ein = MAXK; }
      else if (!strcmp(typ, "upmix")) {
        k->typ = T_UPMIX; k->n_aus = 4;
        k->fest_aus_kan[0] = 2; k->fest_aus_kan[1] = 2; k->fest_aus_kan[2] = 2; k->fest_aus_kan[3] = 1;
        k->up = aw_upmix_neu(sr, zahl_von(zeile, "transient", -8), zahl_von(zeile, "ducking", -5), zahl_von(zeile, "effekte", 0.5), zahl_von(zeile, "breite", 0.35), (int)zahl_von(zeile, "center", 0));
      } else { free(k); if (fehler) snprintf(fehler, (size_t)fn, "unbekannter Knoten %s", typ); continue; }
      ausgaenge_anlegen(k);
      if (r->n == kap) { kap *= 2; r->k = realloc(r->k, sizeof(Knoten *) * (size_t)kap); }
      r->k[r->n++] = k;
    } else if (zeile[0] == 'E') sscanf(zeile, "E %d", &quelle);
    else if (zeile[0] == 'A') sscanf(zeile, "A %d", &ziel);
    else if (zeile[0] == 'V') {
      int a, ao, b, bi;
      if (sscanf(zeile, "V %d %d %d %d", &a, &ao, &b, &bi) != 4) continue;
      Knoten *ka = suchen(r, a), *kb = suchen(r, b);
      if (!ka || !kb || ao < 0 || ao >= ka->n_aus || bi < 0 || bi >= kb->n_ein) continue;
      if (!kb->ein[bi]) kb->ein[bi] = calloc(MAXV, sizeof(Verb));
      if (kb->n_verb[bi] < MAXV) { kb->ein[bi][kb->n_verb[bi]].von = ka; kb->ein[bi][kb->n_verb[bi]].aus = ao; kb->n_verb[bi]++; }
    }
  }
  r->quelle = suchen(r, quelle); r->ziel = suchen(r, ziel);
  if (!r->quelle || !r->ziel) { if (fehler) snprintf(fehler, (size_t)fn, "Graph ohne Ein- oder Ausgang"); aw_raum_frei(r); return NULL; }
  r->quelle->typ = T_QUELLE;
  /* Reihenfolge: Kahn über die Verbindungen */
  for (int i = 0; i < r->n; i++) { Knoten *k = r->k[i]; k->grad = 0; for (int e = 0; e < k->n_ein; e++) k->grad += k->n_verb[e]; }
  r->ord = malloc(sizeof(Knoten *) * (size_t)r->n);
  int n_ord = 0, kopf = 0;
  for (int i = 0; i < r->n; i++) if (r->k[i]->grad == 0) r->ord[n_ord++] = r->k[i];
  while (kopf < n_ord) {
    Knoten *a = r->ord[kopf++];
    for (int i = 0; i < r->n; i++) {
      Knoten *b = r->k[i];
      for (int e = 0; e < b->n_ein; e++) for (int v = 0; v < b->n_verb[e]; v++) if (b->ein[e][v].von == a && --b->grad == 0) r->ord[n_ord++] = b;
    }
  }
  if (n_ord != r->n) { if (fehler) snprintf(fehler, (size_t)fn, "Graph hat einen Kreis"); aw_raum_frei(r); return NULL; }
  return r;
}

void aw_raum_param(AwRaum *r, int knoten, const char *art, double w, double dt, double tau) {
  Knoten *k = suchen(r, knoten);
  if (!k || (k->typ != T_GAIN && k->typ != T_DELAY && k->typ != T_QUELLE)) return;
  double t = (double)r->frames / r->sr + (dt > 0 ? dt : 0);
  if (!strcmp(art, "stopp")) param_stopp(&k->p, t);
  else if (!strcmp(art, "set")) param_ereignis(&k->p, E_SET, t, w, 0);
  else if (!strcmp(art, "ramp")) param_ereignis(&k->p, E_RAMP, t, w, 0);
  else if (!strcmp(art, "ziel")) param_ereignis(&k->p, E_ZIEL, t, w, tau);
}

void aw_raum_nachricht(AwRaum *r, int knoten, double effekte, double breite) {
  Knoten *k = suchen(r, knoten);
  if (k && k->up) aw_upmix_setzen(k->up, effekte, breite);
}

/* ---------- Rechnen ---------- */

static int kanaele_ein(Knoten *k, int e) {
  int m = 0;
  for (int v = 0; v < k->n_verb[e]; v++) { int c = k->ein[e][v].von->aus_kan[k->ein[e][v].aus]; if (c > m) m = c; }
  if (k->ccm == M_EXPLICIT) return k->cc;
  if (!k->n_verb[e]) return 1;
  if (k->ccm == M_CLAMPED && m > k->cc) return k->cc;
  return m;
}

static void eingang_mischen(Knoten *k, int e, int kan) {
  for (int c = 0; c < kan; c++) memset(k->in[c], 0, sizeof(float) * Q);
  for (int v = 0; v < k->n_verb[e]; v++) {
    Knoten *q = k->ein[e][v].von; int o = k->ein[e][v].aus;
    mischen(k->in, kan, q->aus[o], q->aus_kan[o], k->ci == 1);
  }
  k->in_kan = kan;
}

static void quantum(AwRaum *r, float *const *ein, int ein_kan) {
  double T0 = (double)r->frames / r->sr, dT = 1 / r->sr;
  for (int oi = 0; oi < r->n; oi++) {
    Knoten *k = r->ord[oi];
    switch (k->typ) {
      case T_QUELLE: {
        /* „vorne“: Eingang des Graphen (Gain mit dem Signal der Kette) */
        k->aus_kan[0] = ein_kan;
        for (int c = 0; c < ein_kan; c++) {
          for (int i = 0; i < Q; i++) k->aus[0][c][i] = ein[c][i];
        }
        if (!param_ruhig(&k->p) || k->p.v != 1) {
          for (int i = 0; i < Q; i++) { float g = (float)param_wert(&k->p, T0 + i * dT); for (int c = 0; c < ein_kan; c++) k->aus[0][c][i] *= g; }
        }
        break;
      }
      case T_GAIN: {
        int kan = kanaele_ein(k, 0); eingang_mischen(k, 0, kan);
        k->aus_kan[0] = kan;
        if (param_ruhig(&k->p)) { float g = (float)k->p.v; for (int c = 0; c < kan; c++) for (int i = 0; i < Q; i++) k->aus[0][c][i] = k->in[c][i] * g; }
        else for (int i = 0; i < Q; i++) { float g = (float)param_wert(&k->p, T0 + i * dT); for (int c = 0; c < kan; c++) k->aus[0][c][i] = k->in[c][i] * g; }
        break;
      }
      case T_BIQUAD: {
        int kan = kanaele_ein(k, 0); eingang_mischen(k, 0, kan);
        k->aus_kan[0] = kan;
        for (int c = 0; c < kan; c++) {
          double *x = k->zx[c], *y = k->zy[c];
          for (int i = 0; i < Q; i++) {
            double xi = k->in[c][i];
            double yi = k->b[0] * xi + k->b[1] * x[0] + k->b[2] * x[1] - k->a[1] * y[0] - k->a[2] * y[1];
            x[1] = x[0]; x[0] = xi; y[1] = y[0]; y[0] = yi;
            k->aus[0][c][i] = (float)yi;
          }
        }
        break;
      }
      case T_IIR: {
        int kan = kanaele_ein(k, 0); eingang_mischen(k, 0, kan);
        k->aus_kan[0] = kan;
        for (int c = 0; c < kan; c++) {
          double *x = k->zx[c], *y = k->zy[c];
          for (int i = 0; i < Q; i++) {
            double xi = k->in[c][i], yi = k->ff[0] * xi;
            for (int j = 1; j < k->nff; j++) yi += k->ff[j] * x[j - 1];
            for (int j = 1; j < k->nfb; j++) yi -= k->fb[j] * y[j - 1];
            for (int j = 19; j > 0; j--) { x[j] = x[j - 1]; y[j] = y[j - 1]; }
            x[0] = xi; y[0] = yi;
            k->aus[0][c][i] = (float)yi;
          }
        }
        break;
      }
      case T_DELAY: {
        int kan = kanaele_ein(k, 0); eingang_mischen(k, 0, kan);
        k->aus_kan[0] = kan;
        for (int i = 0; i < Q; i++) {
          double d = param_wert(&k->p, T0 + i * dT);
          if (d < 0) d = 0;
          if (d > k->maxd) d = k->maxd;
          double lp = k->dpos - d * r->sr;
          while (lp < 0) lp += k->dlen;
          int i0 = (int)lp; double fr = lp - i0;
          if (i0 >= k->dlen) { i0 -= k->dlen; fr = 0; }   /* knapp unter 0 + Länge rundet auf die Länge */
          int i1 = i0 + 1 >= k->dlen ? 0 : i0 + 1;
          for (int c = 0; c < kan; c++) {
            k->dpuf[c][k->dpos] = k->in[c][i];
            /* Web Audio liest nach dem Schreiben: bei 0 s Verzögerung kommt der aktuelle Wert */
            k->aus[0][c][i] = (float)(k->dpuf[c][i0] * (1 - fr) + k->dpuf[c][i1] * fr);
          }
          k->dpos = k->dpos + 1 >= k->dlen ? 0 : k->dpos + 1;
        }
        break;
      }
      case T_CONV: {
        int kan = kanaele_ein(k, 0); eingang_mischen(k, 0, kan);
        k->aus_kan[0] = 2;
        if (k->falt) {
          const float *e2[2] = { k->in[0], kan > 1 ? k->in[1] : k->in[0] };
          float *a2[2] = { k->aus[0][0], k->aus[0][1] };
          aw_faltung_block(k->falt, e2, a2, Q);
        } else { memset(k->aus[0][0], 0, sizeof(float) * Q); memset(k->aus[0][1], 0, sizeof(float) * Q); }
        break;
      }
      case T_SPLIT: {
        int kan = kanaele_ein(k, 0); eingang_mischen(k, 0, kan);
        for (int o = 0; o < k->n_aus; o++) { k->aus_kan[o] = 1; if (o < kan) memcpy(k->aus[o][0], k->in[o], sizeof(float) * Q); else memset(k->aus[o][0], 0, sizeof(float) * Q); }
        break;
      }
      case T_MERGE: {
        k->aus_kan[0] = k->n_ein;
        for (int e = 0; e < k->n_ein; e++) {
          float *z[1] = { k->aus[0][e] };
          memset(z[0], 0, sizeof(float) * Q);
          for (int v = 0; v < k->n_verb[e]; v++) { Knoten *q = k->ein[e][v].von; int o = k->ein[e][v].aus; mischen(z, 1, q->aus[o], q->aus_kan[o], 0); }
        }
        break;
      }
      case T_UPMIX: {
        int kan = kanaele_ein(k, 0); eingang_mischen(k, 0, kan);
        float *o7[7] = { k->aus[0][0], k->aus[0][1], k->aus[1][0], k->aus[1][1], k->aus[2][0], k->aus[2][1], k->aus[3][0] };
        aw_upmix_block(k->up, k->in[0], kan > 1 ? k->in[1] : k->in[0], o7, Q);
        for (int o = 0; o < 4; o++) k->aus_kan[o] = k->fest_aus_kan[o];
        break;
      }
    }
  }
  r->frames += Q;
}

int aw_raum_block(AwRaum *r, const float *const *ein, int ein_kan, float *const *aus, int n) {
  if (ein_kan > MAXK) ein_kan = MAXK;
  int ak = r->fifo_aus_kan;
  for (int i = 0; i < n; i++) {
    for (int c = 0; c < ein_kan; c++) r->fifo_ein[c][r->fifo_n] = ein[c][i];
    for (int c = 0; c < MAXK; c++) if (aus[c]) aus[c][i] = c < ak ? r->fifo_aus[c][r->fifo_n] : 0;
    if (++r->fifo_n == Q) {
      float *e[MAXK]; for (int c = 0; c < MAXK; c++) e[c] = r->fifo_ein[c];
      quantum(r, e, ein_kan);
      Knoten *z = r->ziel;
      ak = r->fifo_aus_kan = z->aus_kan[0];
      for (int c = 0; c < ak; c++) memcpy(r->fifo_aus[c], z->aus[0][c], sizeof(float) * Q);
      r->fifo_n = 0;
    }
  }
  return r->aus_kan = (r->fifo_aus_kan ? r->fifo_aus_kan : ein_kan);
}

int aw_raum_kanaele(AwRaum *r) { return r->fifo_aus_kan; }

void aw_raum_direkt(AwRaum *r, float *const *x, int kan, int n) {
  /* nur Ein- und Ausgangs-Gain, ohne FIFO (Space aus, Blende läuft noch) */
  double T0 = (double)r->frames / r->sr, dT = 1 / r->sr;
  for (int i = 0; i < n; i++) {
    double g = param_wert(&r->quelle->p, T0 + i * dT) * param_wert(&r->ziel->p, T0 + i * dT);
    if (g != 1) for (int c = 0; c < kan; c++) x[c][i] = (float)(x[c][i] * g);
  }
  r->frames += n;
}

int aw_raum_trivial(AwRaum *r) {
  if (r->n != 2) return 0;
  Knoten *z = r->ziel;
  return z->typ == T_GAIN && z->n_verb[0] == 1 && z->ein[0][0].von == r->quelle;
}

int aw_raum_ruhig(AwRaum *r) { return param_ruhig(&r->ziel->p) && r->ziel->p.v == 1 && param_ruhig(&r->quelle->p) && r->quelle->p.v == 1; }

int aw_raum_latenz(void) { return Q; }

void aw_raum_frei(AwRaum *r) {
  if (!r) return;
  for (int i = 0; i < r->n; i++) {
    Knoten *k = r->k[i];
    for (int o = 0; o < k->n_aus; o++) for (int c = 0; c < MAXK; c++) free(k->aus[o][c]);
    for (int c = 0; c < MAXK; c++) { free(k->in[c]); free(k->dpuf[c]); }
    for (int e = 0; e < MAXK; e++) free(k->ein[e]);
    free(k->p.e);
    aw_faltung_frei(k->falt); aw_upmix_frei(k->up);
    free(k);
  }
  free(r->k); free(r->ord); free(r);
}
