// AmberIron – Übertrager. Übersetzung von app/js/trafo-worklet.js (Stand 3), Rechenweg und Reihenfolge unverändert:
// Kern mit H(B) = B / (1 − (B/Bs)²), impliziter Integrator (Newton), Quelle/Wicklung als Widerstand, Kuhschwanz oben,
// HQ mit Preisach-Hysterese (Play-Operatoren), 2× Oversampling, Toleranzen und Drift; Verteilung Mitte/Seite beim Mischen.
#include "intern.h"

#define PLAYS 6

typedef struct { const char *name; double bs, fRef, rCu, hfF, hfDb, hyst, hystW; } Kern;
static const Kern KERNE[] = {
  { "nickel", 2.6, 20, 1.0, 14000, 0.3, 0.012, 0.25 },
  { "stahl", 2.0, 24, 2.0, 11000, 0.5, 0.03, 0.35 },
  { "eisen", 1.5, 30, 3.5, 8000, -1.2, 0.07, 0.45 },
};
typedef struct { const char *name; double f; } Quelle;
static const Quelle QUELLEN[] = { { "nieder", 0.6 }, { "studio", 3.0 }, { "roehre", 9.0 } };

static const Kern *kern_suchen(const char *n) { for (int i = 0; i < 3; i++) if (!strcmp(KERNE[i].name, n)) return &KERNE[i]; return NULL; }
static const Quelle *quelle_suchen(const char *n) { for (int i = 0; i < 3; i++) if (!strcmp(QUELLEN[i].name, n)) return &QUELLEN[i]; return NULL; }

typedef struct {
  double drive, glanz, mix, vert; int auto_, hq;
  const Kern *k; const Quelle *q;
  double sb0, sb1, sb2, sa1, sa2;   /* Kuhschwanz */
  double rho, w_ref;
  double play_r[PLAYS], play_w[PLAYS];
} Abgel;

typedef struct {
  double phi, s1, s2, play[PLAYS];
  double *hoch; int hoch_pos;
  double *runter; int runter_pos;
  double *trocken; int trocken_pos;
  double *delta_runter; double d_s1, d_s2;
} Kanal;

typedef struct {
  AwFx fx;
  int os, taps, ph, verz;
  double *fir, *poly, *fir_r;
  double drive, glanz, mix, vert; int auto_, hq; const Kern *kern; const Quelle *quelle;   /* Ziel */
  Abgel abg, ist;
  int abg_da;
  Kanal *kanal[16];
  double tol_f[2], tol_d[2], tol_r[2];
  double drift_ph, drift_wert[2];
  float *trocken_p[2], *rest_p[2]; int puf_kap;
} Iron;

static Abgel ableiten(Iron *t) {
  Abgel a;
  memset(&a, 0, sizeof a);
  a.drive = t->drive; a.glanz = t->glanz; a.mix = t->mix; a.vert = t->vert; a.auto_ = t->auto_; a.hq = t->hq; a.k = t->kern; a.q = t->quelle;
  const Kern *k = t->kern;
  double sr = t->fx.sr;
  double gDb = k->hfDb + (t->glanz - 0.5) * 2;
  double A = pow(10, gDb / 40), w0 = 2 * M_PI * min_d(k->hfF, sr * 0.45) / sr, cw = cos(w0), sw = sin(w0);
  double al = sw / 2 * M_SQRT2;
  double sq = 2 * sqrt(A) * al;
  double a0 = (A + 1) - (A - 1) * cw + sq;
  a.sb0 = A * ((A + 1) + (A - 1) * cw + sq) / a0; a.sb1 = -2 * A * ((A - 1) + (A + 1) * cw) / a0; a.sb2 = A * ((A + 1) + (A - 1) * cw - sq) / a0;
  a.sa1 = 2 * ((A - 1) - (A + 1) * cw) / a0; a.sa2 = ((A + 1) - (A - 1) * cw - sq) / a0;
  double fHP = k->rCu + t->quelle->f;
  a.rho = fHP / k->fRef;
  double ws = 0;
  for (int j = 1; j <= PLAYS; j++) { a.play_r[j - 1] = k->hyst * j / PLAYS; a.play_w[j - 1] = j; ws += j; }
  for (int j = 0; j < PLAYS; j++) a.play_w[j] /= ws;
  a.w_ref = 2 * M_PI * k->fRef;
  return a;
}

static void iron_setzen(AwFx *fx, const AwWert *w, int n) {
  Iron *t = (Iron *)fx;
  double v; const char *s;
  if (wert_zahl(w, n, "drive", &v)) t->drive = klemmen(v, 0.05, 160);
  if ((s = wert_text(w, n, "kern")) && kern_suchen(s)) t->kern = kern_suchen(s);
  if ((s = wert_text(w, n, "quelle")) && quelle_suchen(s)) t->quelle = quelle_suchen(s);
  if (wert_zahl(w, n, "glanz", &v)) t->glanz = klemmen(v, 0, 1);
  if (wert_zahl(w, n, "mix", &v)) t->mix = klemmen(v, 0, 1);
  if (wert_zahl(w, n, "vert", &v)) t->vert = klemmen(v, 0, 1);
  if (wert_zahl(w, n, "auto", &v)) t->auto_ = v != 0;
  if (wert_zahl(w, n, "hq", &v)) t->hq = v != 0;
  fx->latenz = t->hq ? t->verz : 0;
  int neu_start = t->abg_da && (t->abg.k != t->kern || t->abg.hq != t->hq);
  t->abg = ableiten(t);
  t->abg_da = 1;
  if (neu_start) for (int c = 0; c < 16; c++) if (t->kanal[c]) { t->kanal[c]->phi = 0; memset(t->kanal[c]->play, 0, sizeof t->kanal[c]->play); }
  fx->initial = 1;
  if (!fx->gestartet) t->ist = t->abg;
}

static Kanal *iron_kanal(Iron *t, int c) {
  if (t->kanal[c]) return t->kanal[c];
  Kanal *z = calloc(1, sizeof *z);
  z->hoch = calloc((size_t)t->ph * 2, sizeof(double));
  z->runter = calloc((size_t)t->taps * 2, sizeof(double));
  z->trocken = calloc((size_t)t->verz + 2, sizeof(double));
  z->delta_runter = calloc((size_t)t->taps * 2, sizeof(double));
  t->kanal[c] = z;
  return z;
}

typedef struct { double *phi, *play; double rho, cI, bs, bs2, hystW; const double *playR, *playW; double kAbw, kLin; } KernZ;

/** ein Takt des Kerns: Spannung u → neuer Fluss (implizit, Newton), Magnetisierungsstrom, Wicklungsspannung */
static double kern_takt(KernZ *k, double u) {
  double phi = *k->phi, p = phi;
  const double hystW = k->hystW, bs = k->bs, bs2 = k->bs2, rho = k->rho, cI = k->cI;
  for (int it = 0; it < 3; it++) {
    double b = p, dbdp = 1;
    if (hystW > 0) {
      double bh = 0, dh = 0;
      for (int j = 0; j < PLAYS; j++) {
        double r = k->playR[j], yj = k->play[j];
        if (p - yj > r) { yj = p - r; dh += k->playW[j]; } else if (yj - p > r) { yj = p + r; dh += k->playW[j]; }
        bh += k->playW[j] * yj;
      }
      b = (1 - hystW) * p + hystW * bh; dbdp = (1 - hystW) + hystW * dh;
    }
    double q = min_d(0.96, b * b / bs2);
    double H = b / (1 - q);
    double dH = (1 + q) / ((1 - q) * (1 - q)) * dbdp;
    double f = p - phi - cI * (u - rho * H);
    double df = 1 + cI * rho * dH;
    p -= f / df;
    if (p > bs * 0.98) p = bs * 0.98; else if (p < -bs * 0.98) p = -bs * 0.98;
  }
  double bh = 0;
  if (hystW > 0) {
    for (int j = 0; j < PLAYS; j++) {
      double r = k->playR[j], yj = k->play[j];
      if (p - yj > r) yj = p - r; else if (yj - p > r) yj = p + r;
      k->play[j] = yj; bh += k->playW[j] * yj;
    }
  }
  double b = hystW > 0 ? (1 - hystW) * p + hystW * bh : p;
  double q = min_d(0.96, b * b / bs2);
  double H = b / (1 - q);
  *k->phi = p;
  k->kAbw = rho * (H - b); k->kLin = u - rho * b;
  return u - rho * H;
}

static void iron_block(AwFx *fx, const float *const *ein, float *const *aus, int kan, int n) {
  Iron *t = (Iron *)fx;
  if (!fx->initial) iron_setzen(fx, NULL, 0);
  fx->gestartet = 1;
  const double sr = fx->sr;
  const int OS = t->os, TAPS = t->taps, PH = t->ph, VERZ = t->verz;
  const float *dzA = delta_verlauf(fx, n);
  Abgel *z0 = &t->ist, *z1 = &t->abg;
  double drive = z0->drive, dDrive = (z1->drive - z0->drive) / n;
  double mix = z0->mix, dMix = (z1->mix - z0->mix) / n;
  double vert = z0->vert, dVert = (z1->vert - vert) / n;
  int ms = kan == 2 && ein && ein[0] && ein[1];
  if (ms && t->puf_kap < n) {
    for (int c = 0; c < 2; c++) { free(t->trocken_p[c]); free(t->rest_p[c]); t->trocken_p[c] = calloc((size_t)n, sizeof(float)); t->rest_p[c] = calloc((size_t)n, sizeof(float)); }
    t->puf_kap = n;
  }
  int hq = z1->hq, auto_ = z1->auto_;
  const Kern *k = z1->k;
  double bs = k->bs, bs2 = bs * bs, rhoBasis = z1->rho;
  double hystW = hq ? k->hystW : 0;
  if (hq) {
    t->drift_ph += 2 * M_PI * n / (sr * 97);
    t->drift_wert[0] = 1 + 0.006 * sin(t->drift_ph); t->drift_wert[1] = 1 - 0.005 * sin(t->drift_ph * 1.3 + 1);
  }
  Faerb *mess = fx->messen ? fx->messer : NULL;
  if (mess) faerb_start(mess, n);
  for (int c = 0; c < kan; c++) {
    const float *x = ein ? ein[c] : NULL;
    float *y = aus[c];
    if (!x || c >= 16) { memset(y, 0, sizeof(float) * (size_t)n); continue; }
    Kanal *z = iron_kanal(t, c);
    float *mA = mess ? mess->abw[c & 1] : NULL, *mL = mess ? mess->lin[c & 1] : NULL;
    int t1 = c & 1;
    double tf = hq ? t->tol_f[t1] : 1, td = hq ? t->tol_d[t1] : 1, tr = hq ? t->tol_r[t1] : 1;
    double dft = hq ? t->drift_wert[t1] : 1;
    double fsK = hq ? sr * OS : sr;
    KernZ kz = { &z->phi, z->play, rhoBasis * tr, z1->w_ref * tf * dft / fsK, bs, bs2, hystW, z1->play_r, z1->play_w, 0, 0 };
    double s1 = z->s1, s2 = z->s2;
    double *hoch = z->hoch, *runter = z->runter, *trk = z->trocken;
    int tLen = VERZ + 2;
    int hpP = z->hoch_pos, rp = z->runter_pos, tp = z->trocken_pos;
    for (int i = 0; i < n; i++) {
      double dr = (drive + dDrive * i) * td;
      double mx = mix + dMix * i;
      double e = x[i];
      double v, trocken = e, rest = 0;
      if (!hq) {
        v = kern_takt(&kz, e * dr);
        if (mA) { mA[i] = (float)(kz.kAbw * mx); mL[i] = (float)kz.kLin; }
        if (dzA) rest = -kz.kAbw;
      } else {
        trk[tp] = e;
        int lp = tp - VERZ; if (lp < 0) lp += tLen;
        trocken = trk[lp];
        tp = tp == tLen - 1 ? 0 : tp + 1;
        hoch[hpP] = e; hoch[hpP + PH] = e;
        int basis = hpP + PH;
        for (int s = 0; s < OS; s++) {
          double u = skalar(t->poly + s * PH, hoch + basis - PH + 1, PH);
          double w = kern_takt(&kz, u * OS * dr);
          if (s == 0 && mA) { mA[i] = (float)(kz.kAbw * mx); mL[i] = (float)kz.kLin; }
          if (dzA) { z->delta_runter[rp] = -kz.kAbw; z->delta_runter[rp + TAPS] = -kz.kAbw; }
          runter[rp] = w; runter[rp + TAPS] = w;
          rp = rp == TAPS - 1 ? 0 : rp + 1;
        }
        hpP = hpP == PH - 1 ? 0 : hpP + 1;
        int b2 = (rp == 0 ? TAPS - 1 : rp - 1) + TAPS;
        v = skalar(t->fir_r, runter + b2 - TAPS + 1, TAPS);
        if (dzA) rest = skalar(t->fir_r, z->delta_runter + b2 - TAPS + 1, TAPS);
      }
      if (auto_) v /= dr;
      double o = z1->sb0 * v + s1;
      s1 = z1->sb1 * v - z1->sa1 * o + s2;
      s2 = z1->sb2 * v - z1->sa2 * o;
      v = o;
      if (dzA) {
        if (auto_) rest /= dr;
        double od = z1->sb0 * rest + z->d_s1; z->d_s1 = z1->sb1 * rest - z1->sa1 * od + z->d_s2; z->d_s2 = z1->sb2 * rest - z1->sa2 * od; rest = od;
      }
      if (ms) { y[i] = (float)v; t->trocken_p[c][i] = (float)trocken; t->rest_p[c][i] = (float)rest; }
      else { double normal = trocken + (v - trocken) * mx; y[i] = (float)(dzA ? normal * (1 - dzA[i]) + rest * mx * dzA[i] : normal); }
    }
    z->hoch_pos = hpP; z->runter_pos = rp; z->trocken_pos = tp;
    z->s1 = s1; z->s2 = s2;
  }
  if (ms) {
    float *yl = aus[0], *yr = aus[1];
    const float *tl = t->trocken_p[0], *tr = t->trocken_p[1];
    for (int i = 0; i < n; i++) {
      double mx = mix + dMix * i, vt = vert + dVert * i;
      double mxM = mx * min_d(1, 2 * (1 - vt)), mxS = mx * min_d(1, 2 * vt);
      double dM = ((double)tl[i] + tr[i]) * 0.5, dS = ((double)tl[i] - tr[i]) * 0.5, wM = ((double)yl[i] + yr[i]) * 0.5, wS = ((double)yl[i] - yr[i]) * 0.5;
      double nM = dM + (wM - dM) * mxM, nS = dS + (wS - dS) * mxS;
      double oM = nM, oS = nS;
      if (dzA) {
        double dz = dzA[i], rl = t->rest_p[0][i], rr = t->rest_p[1][i];
        oM = nM * (1 - dz) + (rl + rr) * 0.5 * mxM * dz; oS = nS * (1 - dz) + (rl - rr) * 0.5 * mxS * dz;
      }
      yl[i] = (float)(oM + oS); yr[i] = (float)(oM - oS);
    }
  }
  if (mess) faerb_sammeln(mess, n, 0, sr);
  t->ist = *z1;
}

static void iron_frei(AwFx *fx) {
  Iron *t = (Iron *)fx;
  for (int c = 0; c < 16; c++) {
    Kanal *z = t->kanal[c];
    if (!z) continue;
    free(z->hoch); free(z->runter); free(z->trocken); free(z->delta_runter); free(z);
  }
  for (int c = 0; c < 2; c++) { free(t->trocken_p[c]); free(t->rest_p[c]); }
  free(t->fir); free(t->poly); free(t->fir_r);
  free(t);
}

AwFx *iron_neu(double sr) {
  Iron *t = calloc(1, sizeof *t);
  t->fx.setzen = iron_setzen; t->fx.block = iron_block; t->fx.frei = iron_frei; t->fx.sr = sr;
  t->os = sr >= 75000 ? 1 : 2;
  t->taps = t->os == 1 ? 1 : 47 * t->os + 1;
  t->ph = (t->taps + t->os - 1) / t->os;
  t->verz = (t->taps - 1) / t->os;
  t->fir = fir_entwurf(t->os, t->taps, t->ph, 8.6);
  t->poly = polyphase(t->fir, t->os, t->ph);
  t->fir_r = rueckwaerts(t->fir, t->taps);
  t->fx.latenz = 0; /* Standard ohne Oversampling; HQ: verz (trockener Weg wird gleich verzögert) */
  t->drive = 1; t->kern = kern_suchen("stahl"); t->glanz = 0.5; t->mix = 1; t->vert = 0.5; t->auto_ = 1; t->hq = 0; t->quelle = quelle_suchen("studio");
  double tf[2] = {1.03, 0.97}, td[2] = {1.02, 0.98}, tr[2] = {1.06, 0.95};
  for (int i = 0; i < 2; i++) { t->tol_f[i] = tf[i]; t->tol_d[i] = td[i]; t->tol_r[i] = tr[i]; }
  t->drift_ph = 0.7; t->drift_wert[0] = t->drift_wert[1] = 1;
  return &t->fx;
}
