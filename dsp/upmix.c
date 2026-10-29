// Space: Upmix „Zwei Ebenen“ – exakte Portierung von app/js/raumklang-worklet.js (UpmixEbenen), Sample für Sample gegen
// das Worklet getestet (tests/upmix_vergleich.py). Kommentare zum Verfahren stehen im Worklet.
// Felder, die dort Float32Array sind, sind hier float (gleiche Rundung); gerechnet wird in double wie in JavaScript.
#include "intern.h"

#define NE 2048
#define HOPE 512
#define LATE (NE - HOPE)
#define LATENZ_E NE
#define H (NE / 2 + 1)

static double glatt(double x) { return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x); }
static double jsrunden(double x) { return floor(x + 0.5); }

struct AwUpmix {
  double sr;
  double tMin, dMin, fA, fR, sA, sR, dA, dR, lK, gA, gR;
  double fast, slow, duck, lang, g;
  int vor;
  float gRing[4096]; int gPos;
  double effekte, effG, breite, breiteG;
  int mitCenter;
  float win[NE], inL[NE], inR[NE];
  float out[7][NE], acc[7][2 * NE];
  int rover;
  double re[NE], im[NE], zr0[NE], zi0[NE];
  double aLL[H], aRR[H], aXr[H], aXi[H], wa[H], cm[H], gf[H], gr[H];
  double sLL[H], sRR[H], sXr[H], sXi[H], waG[H], praefix[H + 1];
  int16_t gw[H];
  int nB;
  int16_t binBand[H];
  uint16_t ip0[H], ip1[H];
  double ipW[H];
  double *tLL, *tRR, *tXr, *bLL, *bRR, *bXr, *bE, *bC, *bW, *bLang, *bP, *sE, *sW;
  double bandW[H];
  double lamA, lamB, gAuf, gAb, gAufW, gAbW, lamL, mAuf;
  uint16_t rev[NE];
  double cosT[NE / 2], sinT[NE / 2];
};

AwUpmix *aw_upmix_neu(double sampleRate, double transient, double ducking, double effekte, double breite, int center) {
  AwUpmix *u = calloc(1, sizeof *u);
  if (!u) return NULL;
  u->sr = sampleRate;
#define K(ms) exp(-1 / (sampleRate * (ms) / 1000))
  u->tMin = pow(10, transient / 20);
  double d1 = pow(10, ducking / 20), d2 = pow(10, -3.0 / 20);
  u->dMin = d1 > d2 ? d1 : d2;
  u->fA = K(0.5); u->fR = K(40); u->sA = K(25); u->sR = K(250); u->dA = K(60); u->dR = K(400);
  u->lK = K(2000); u->gA = K(3); u->gR = K(40);
#undef K
  u->g = 1;
  u->vor = (int)jsrunden(sampleRate * 0.004);
  for (int i = 0; i < 4096; i++) u->gRing[i] = 1;
  u->effekte = effekte < 0 ? 0 : effekte > 1.5 ? 1.5 : effekte; u->effG = u->effekte;
  u->breite = breite < 0 ? 0 : breite > 1 ? 1 : breite; u->breiteG = u->breite;
  u->mitCenter = !!center;
  for (int i = 0; i < NE; i++) u->win[i] = (float)sqrt(0.5 - 0.5 * cos(2 * M_PI * i / NE));
  u->rover = LATE;
  for (int kk = 0; kk < H; kk++) { double w = jsrunden(kk * 0.03); u->gw[kk] = (int16_t)(w < 1 ? 1 : w > 12 ? 12 : w); }
  // Terzbänder ab 150 Hz
  double kanten[64]; int nk = 0;
  double grenze = 20000 < sampleRate / 2 ? 20000 : sampleRate / 2;
  for (double fr = 150; fr < grenze; fr *= pow(2, 1.0 / 3)) kanten[nk++] = fr;
  kanten[nk++] = sampleRate / 2;
  int nB = u->nB = nk - 1;
  double mitten[64];
  for (int i = 0; i < nB; i++) { double ob = kanten[i + 1] < 18000 ? kanten[i + 1] : 18000; mitten[i] = sqrt(kanten[i] * ob); }
  for (int kk = 0; kk < H; kk++) {
    double fr = kk * sampleRate / NE;
    u->binBand[kk] = -1;
    for (int b = 0; b < nB; b++) if (fr >= kanten[b] && (fr < kanten[b + 1] || b == nB - 1)) { u->binBand[kk] = (int16_t)b; break; }
    if (fr <= mitten[0]) { u->ip0[kk] = u->ip1[kk] = 0; }
    else if (fr >= mitten[nB - 1]) { u->ip0[kk] = u->ip1[kk] = (uint16_t)(nB - 1); }
    else {
      int b = 0; while (fr >= mitten[b + 1]) b++;
      double x = log(fr / mitten[b]) / log(mitten[b + 1] / mitten[b]);
      u->ip0[kk] = (uint16_t)b; u->ip1[kk] = (uint16_t)(b + 1); u->ipW[kk] = 0.5 - 0.5 * cos(M_PI * x);
    }
  }
  double *bd = calloc((size_t)nB * 13, sizeof(double));
  u->tLL = bd; u->tRR = bd + nB; u->tXr = bd + 2 * nB; u->bLL = bd + 3 * nB; u->bRR = bd + 4 * nB; u->bXr = bd + 5 * nB;
  u->bE = bd + 6 * nB; u->bC = bd + 7 * nB; u->bW = bd + 8 * nB; u->bLang = bd + 9 * nB; u->bP = bd + 10 * nB; u->sE = bd + 11 * nB; u->sW = bd + 12 * nB;
  for (int kk = 0; kk < H; kk++) { double fr = kk * sampleRate / NE; u->bandW[kk] = fr <= 150 ? 0 : fr >= 250 ? 1 : (fr - 150) / 100; }
#define BLK(s) exp(-((double)HOPE / sampleRate) / (s))
  u->lamA = BLK(0.05); u->lamB = BLK(0.15); u->gAuf = BLK(0.2); u->gAb = BLK(1.0); u->gAufW = BLK(0.35); u->gAbW = BLK(2.5); u->lamL = BLK(3);
  u->mAuf = BLK(0.08);
#undef BLK
  int bits = 11;
  for (int i = 0; i < NE; i++) { int r = 0; for (int b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); u->rev[i] = (uint16_t)r; }
  for (int i = 0; i < NE / 2; i++) { u->cosT[i] = cos(2 * M_PI * i / NE); u->sinT[i] = sin(2 * M_PI * i / NE); }
  return u;
}

void aw_upmix_setzen(AwUpmix *u, double effekte, double breite) {
  if (effekte >= 0) u->effekte = effekte > 1.5 ? 1.5 : effekte;
  if (breite >= 0) u->breite = breite > 1 ? 1 : breite;
}

void aw_upmix_frei(AwUpmix *u) { if (!u) return; free(u->tLL); free(u); }

int aw_upmix_latenz(void) { return LATENZ_E; }

static void fft(AwUpmix *u, double *re, double *im, int inv) {
  for (int i = 0; i < NE; i++) { int j = u->rev[i]; if (j > i) { double t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (int size = 2; size <= NE; size <<= 1) {
    int half = size >> 1, step = NE / size;
    for (int s = 0; s < NE; s += size) {
      for (int j = 0; j < half; j++) {
        double wr = u->cosT[j * step], wi = inv ? u->sinT[j * step] : -u->sinT[j * step];
        int a = s + j, b = a + half;
        double xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

static void glaetten(AwUpmix *u, double *a) {
  const int HH = NE / 2;
  double *P = u->praefix;
  for (int d = 0; d < 2; d++) {
    P[0] = 0;
    for (int kk = 0; kk <= HH; kk++) P[kk + 1] = P[kk] + a[kk];
    for (int kk = 0; kk <= HH; kk++) {
      int w = u->gw[kk];
      int lo = kk - w, hi = kk + w;
      if (lo < 0) lo = 0;
      if (hi > HH) hi = HH;
      a[kk] = (P[hi + 1] - P[lo]) / (hi - lo + 1);
    }
  }
}

static void ola(AwUpmix *u, int a, int b) {
  double *re = u->re, *im = u->im;
  fft(u, re, im, 1);
  const double s = 0.5 / NE;
  float *A = u->acc[a], *O = u->out[a];
  if (b >= 0) {
    float *B = u->acc[b], *P = u->out[b];
    for (int i = 0; i < NE; i++) { A[i] = (float)((double)A[i] + re[i] * (double)u->win[i] * s); B[i] = (float)((double)B[i] + im[i] * (double)u->win[i] * s); }
    for (int i = 0; i < HOPE; i++) { O[i] = A[i]; P[i] = B[i]; }
    memmove(B, B + HOPE, sizeof(float) * (2 * NE - HOPE)); memset(B + 2 * NE - HOPE, 0, sizeof(float) * HOPE);
  } else {
    for (int i = 0; i < NE; i++) A[i] = (float)((double)A[i] + re[i] * (double)u->win[i] * s);
    for (int i = 0; i < HOPE; i++) O[i] = A[i];
  }
  memmove(A, A + HOPE, sizeof(float) * (2 * NE - HOPE)); memset(A + 2 * NE - HOPE, 0, sizeof(float) * HOPE);
}

static void ausgabe(AwUpmix *u, const double *gain, int oi) {
  const int HH = NE / 2;
  for (int kk = 0; kk < NE; kk++) { double w = gain[kk <= HH ? kk : NE - kk]; u->re[kk] = u->zr0[kk] * w; u->im[kk] = u->zi0[kk] * w; }
  ola(u, oi, oi + 1);
}

static void block(AwUpmix *u) {
  const int HH = NE / 2, nB = u->nB;
  double *re = u->re, *im = u->im;
  for (int i = 0; i < NE; i++) { re[i] = (double)u->inL[i] * (double)u->win[i]; im[i] = (double)u->inR[i] * (double)u->win[i]; }
  fft(u, re, im, 0);
  memcpy(u->zr0, re, sizeof u->zr0); memcpy(u->zi0, im, sizeof u->zi0);
  for (int b = 0; b < nB; b++) { u->tLL[b] = 0; u->tRR[b] = 0; u->tXr[b] = 0; }
  const double lamA = u->lamA, lamB = u->lamB;
  for (int kk = 0; kk <= HH; kk++) {
    int nk = (NE - kk) % NE;
    double lr = 0.5 * (re[kk] + re[nk]), li = 0.5 * (im[kk] - im[nk]);
    double rr = 0.5 * (im[kk] + im[nk]), ri = -0.5 * (re[kk] - re[nk]);
    double pl = lr * lr + li * li, pr = rr * rr + ri * ri, xr = lr * rr + li * ri, xi = li * rr - lr * ri;
    u->aLL[kk] = lamA * u->aLL[kk] + (1 - lamA) * pl; u->aRR[kk] = lamA * u->aRR[kk] + (1 - lamA) * pr;
    u->aXr[kk] = lamA * u->aXr[kk] + (1 - lamA) * xr; u->aXi[kk] = lamA * u->aXi[kk] + (1 - lamA) * xi;
    int bb = kk < HH ? u->binBand[kk] : nB - 1;
    if (bb >= 0) { u->tLL[bb] += pl; u->tRR[bb] += pr; u->tXr[bb] += xr; }
  }
  memcpy(u->sLL, u->aLL, sizeof u->sLL); memcpy(u->sRR, u->aRR, sizeof u->sRR); memcpy(u->sXr, u->aXr, sizeof u->sXr); memcpy(u->sXi, u->aXi, sizeof u->sXi);
  glaetten(u, u->sLL); glaetten(u, u->sRR); glaetten(u, u->sXr); glaetten(u, u->sXi);
  for (int kk = 0; kk <= HH; kk++) {
    double pa = u->sLL[kk] * u->sRR[kk];
    double koh = sqrt(u->sXr[kk] * u->sXr[kk] + u->sXi[kk] * u->sXi[kk]) / sqrt(pa + 1e-24);
    double balA = 2 * sqrt(pa) / (u->sLL[kk] + u->sRR[kk] + 1e-24);
    double z = 0.65 * glatt(((1 - (koh < 1 ? koh : 1)) * sqrt(balA) - 0.08) / 0.92);
    u->waG[kk] = z >= u->waG[kk] ? u->mAuf * u->waG[kk] + (1 - u->mAuf) * z : z;
    u->wa[kk] = u->waG[kk];
  }
  for (int b = 0; b < nB; b++) {
    u->bLL[b] = lamB * u->bLL[b] + (1 - lamB) * u->tLL[b]; u->bRR[b] = lamB * u->bRR[b] + (1 - lamB) * u->tRR[b]; u->bXr[b] = lamB * u->bXr[b] + (1 - lamB) * u->tXr[b];
    double pe = u->bLL[b] * u->bRR[b], summe = u->bLL[b] + u->bRR[b] + 1e-24;
    double c = u->bXr[b] / (sqrt(pe) + 1e-24); c = c < -1 ? -1 : c > 1 ? 1 : c;
    double pan = (u->bLL[b] - u->bRR[b]) / summe, apan = pan < 0 ? -pan : pan;
    double balE = 2 * sqrt(pe) / summe;
    double anti = glatt((-c - 0.15) / 0.5) * sqrt(balE);
    double hart = glatt((apan - 0.8) / 0.18) * 0.3;
    double zE = anti > hart ? anti : hart;
    double zC = u->mitCenter ? glatt((c - 0.8) / 0.15) * glatt((0.25 - apan) / 0.2) : 0;
    double pegel = summe * 0.5;
    u->bLang[b] = u->bLang[b] > 0 ? u->lamL * u->bLang[b] + (1 - u->lamL) * pegel : pegel;
    double vorn = glatt((10 * log10((pegel + 1e-24) / (u->bLang[b] + 1e-24)) + 18) / 10);
    u->bP[b] = pegel;
    double zW = glatt((0.45 - c) / 0.45) * balE * balE * vorn * (1 - anti);
    double kw = zW > u->bW[b] ? u->gAufW : u->gAbW;
    u->bW[b] = kw * u->bW[b] + (1 - kw) * zW;
    double ke = zE > u->bE[b] ? u->gAuf : u->gAb;
    u->bE[b] = ke * u->bE[b] + (1 - ke) * zE;
    double kc = zC > u->bC[b] ? u->gAuf : u->gAb;
    u->bC[b] = kc * u->bC[b] + (1 - kc) * zC;
  }
  double pSum = 0, mE = 0, mW = 0;
  for (int b = 0; b < nB; b++) { pSum += u->bP[b]; mE += u->bE[b] * u->bP[b]; mW += u->bW[b] * u->bP[b]; }
  mE /= pSum + 1e-24; mW /= pSum + 1e-24;
  static const double KERN[5] = { 1, 2, 3, 2, 1 };
  for (int b = 0; b < nB; b++) {
    double se = 0, sw = 0, ks = 0;
    for (int o = -2; o <= 2; o++) { int q = b + o; if (q < 0 || q >= nB) continue; double k2 = KERN[o + 2]; se += u->bE[q] * k2; sw += u->bW[q] * k2; ks += k2; }
    u->sE[b] = 0.7 * (se / ks) + 0.3 * mE;
    u->sW[b] = 0.6 * (sw / ks) + 0.4 * mW;
  }
  u->effG += (u->effekte - u->effG) * 0.3;
  u->breiteG += (u->breite - u->breiteG) * 0.3;
  double amt = u->effG, amtW = u->breiteG;
  for (int kk = 0; kk <= HH; kk++) {
    int j = kk < HH ? kk : HH - 1; double w = u->ipW[j];
    double e = (u->sE[u->ip0[j]] * (1 - w) + u->sE[u->ip1[j]] * w) * u->bandW[kk];
    u->cm[kk] = (u->bC[u->ip0[j]] * (1 - w) + u->bC[u->ip1[j]] * w) * u->bandW[kk];
    double wb = (u->sW[u->ip0[j]] * (1 - w) + u->sW[u->ip1[j]] * w) * u->bandW[kk];
    double m = e * amt + wb * amtW; if (m > 0.92) m = 0.92;
    double th = m * M_PI / 2;
    u->gf[kk] = cos(th); u->gr[kk] = sin(th);
  }
  if (!(u->bE[0] == u->bE[0]) || !(u->wa[HH >> 1] == u->wa[HH >> 1]) || !(u->bC[0] == u->bC[0]) || !(u->bW[0] == u->bW[0])) {
    double *alle[] = { u->aLL, u->aRR, u->aXr, u->aXi, u->sLL, u->sRR, u->sXr, u->sXi, u->waG, u->cm };
    for (int i = 0; i < 10; i++) memset(alle[i], 0, sizeof(double) * H);
    double *band[] = { u->bLL, u->bRR, u->bXr, u->bE, u->bC, u->bW, u->bLang, u->bP, u->sE, u->sW };
    for (int i = 0; i < 10; i++) memset(band[i], 0, sizeof(double) * (size_t)nB);
    for (int kk = 0; kk < H; kk++) { u->wa[kk] = 0; u->gf[kk] = 1; u->gr[kk] = 0; }
  }
  ausgabe(u, u->wa, 0);
  ausgabe(u, u->gr, 2);
  ausgabe(u, u->gf, 4);
  if (u->mitCenter) {
    for (int kk = 0; kk <= HH; kk++) {
      int nk = (NE - kk) % NE;
      double lr = 0.5 * (u->zr0[kk] + u->zr0[nk]), li = 0.5 * (u->zi0[kk] - u->zi0[nk]);
      double rr = 0.5 * (u->zi0[kk] + u->zi0[nk]), ri = -0.5 * (u->zr0[kk] - u->zr0[nk]);
      double w = 0.5 * u->cm[kk];
      double cr = w * (lr + rr), ci = w * (li + ri);
      re[kk] = cr; im[kk] = ci;
      if (kk > 0 && kk < HH) { re[nk] = cr; im[nk] = -ci; }
    }
    ola(u, 6, -1);
  }
  memmove(u->inL, u->inL + HOPE, sizeof(float) * (NE - HOPE));
  memmove(u->inR, u->inR + HOPE, sizeof(float) * (NE - HOPE));
}

void aw_upmix_block(AwUpmix *u, const float *xL, const float *xR, float *const *o, int len) {
  if (!xR) xR = xL;
  const int verz = LATENZ_E - u->vor;
  double fast = u->fast, slow = u->slow, duck = u->duck, lang = u->lang, g = u->g;
  int gPos = u->gPos, rover = u->rover;
  for (int i = 0; i < len; i++) {
    double l = xL ? xL[i] : 0, r = xR ? xR[i] : 0;
    double sd = 0.5 * (l - r), a = sd < 0 ? -sd : sd;
    fast = a > fast ? u->fA * fast + (1 - u->fA) * a : u->fR * fast + (1 - u->fR) * a;
    slow = a > slow ? u->sA * slow + (1 - u->sA) * a : u->sR * slow + (1 - u->sR) * a;
    double gt = 1;
    if (fast > slow * 1.6 && fast > 1e-6) { double q = slow * 1.6 / fast; gt = q * q; if (gt < u->tMin) gt = u->tMin; }
    double sc = sqrt((l * l + r * r) * 0.5);
    duck = sc > duck ? u->dA * duck + (1 - u->dA) * sc : u->dR * duck + (1 - u->dR) * sc;
    lang = u->lK * lang + (1 - u->lK) * duck;
    double gd = 1;
    if (duck > lang && duck > 1e-6) { gd = pow(lang / duck, 0.8); if (gd < u->dMin) gd = u->dMin; }
    u->gRing[gPos] = (float)(gt * gd);
    double ziel = u->gRing[(gPos - verz + 4096) & 4095];
    gPos = (gPos + 1) & 4095;
    g = ziel < g ? u->gA * g + (1 - u->gA) * ziel : u->gR * g + (1 - u->gR) * ziel;
    u->inL[rover] = (float)l; u->inR[rover] = (float)r;
    int j = rover - LATE;
    if (o[0]) o[0][i] = (float)((double)u->out[0][j] * g);
    if (o[1]) o[1][i] = (float)((double)u->out[1][j] * g);
    if (o[2]) o[2][i] = u->out[2][j];
    if (o[3]) o[3][i] = u->out[3][j];
    if (o[4]) o[4][i] = u->out[4][j];
    if (o[5]) o[5][i] = u->out[5][j];
    if (o[6]) o[6][i] = u->mitCenter ? u->out[6][j] : 0;
    rover++;
    if (rover >= NE) { rover = LATE; block(u); }
  }
  u->fast = fast; u->slow = slow; u->duck = duck; u->lang = lang; u->g = g; u->gPos = gPos; u->rover = rover;
}
