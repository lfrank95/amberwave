// AmberSilk – Bandmaschine. Übersetzung von app/js/band-worklet.js (Stand 1), Rechenweg und Reihenfolge unverändert:
// Vorentzerrung → Langevin-Kurve mit ADAA (HQ: + Jiles-Atherton-Hysterese im inneren 2×) → Entzerrung → pegelabhängiger
// Höhenverlust → Kopfbump (HQ: Kopfkontur) → DC-Sperre → HQ: Gleichlauf, Kratz-Flutter, Modulations- und Bandrauschen, Azimut.
#include "intern.h"

/* ---------- Langevin und Tabellen ---------- */

static double langevin(double x) {
  double ax = x < 0 ? -x : x;
  if (ax < 1e-3) return x / 3 - x * x * x / 45;
  return 1 / th(x) - 1 / x;
}
static double langevin_abl(double x) {
  double ax = x < 0 ? -x : x;
  if (ax < 1e-3) return 1.0 / 3 - x * x / 15;
  double t = th(x);
  return 1 - 1 / (t * t) + 1 / (x * x);
}
#define LT_MAX 40
#define LT_N 16384
static const double LT_S = (double)LT_N / LT_MAX;
static double LT_L[LT_N + 2], LT_D[LT_N + 2];
static int lt_fertig = 0;
static void lt_bauen(void) {
  if (lt_fertig) return;
  for (int i = 0; i <= LT_N + 1; i++) { LT_L[i] = langevin(i / LT_S); LT_D[i] = langevin_abl(i / LT_S); }
  lt_fertig = 1;
}
static inline double langevin_t(double x) {
  double a = x < 0 ? -x : x, v;
  if (a >= LT_MAX) v = 1 - 1 / a;
  else { double p = a * LT_S; int i = (int)p; double f = p - i; v = LT_L[i] + (LT_L[i + 1] - LT_L[i]) * f; }
  return x < 0 ? -v : v;
}
static inline double langevin_abl_t(double x) {
  double a = x < 0 ? -x : x;
  if (a >= LT_MAX) return 1 / (a * a);
  double p = a * LT_S; int i = (int)p; double f = p - i;
  return LT_D[i] + (LT_D[i + 1] - LT_D[i]) * f;
}

static double band_stamm(double x) {
  double a = x < 0 ? -x : x;
  if (a < 1e-3) return 3 * (a * a / 6 - a * a * a * a / 180);
  return 3 * (a - M_LN2 + log1p(-exp(-2 * a)) - log(a));
}
typedef struct { double u_alt, F_alt; } Adaa;
static double band_adaa(Adaa *z, double u) {
  double d = u - z->u_alt, y;
  if (d > 1e-4 || d < -1e-4) { double F = band_stamm(u); y = (F - z->F_alt) / d; z->F_alt = F; }
  else { y = 3 * langevin(0.5 * (u + z->u_alt)); z->F_alt = band_stamm(u); }
  z->u_alt = u;
  return y;
}

/* ---------- Jiles-Atherton ---------- */

static const double JA_A = 0.33, JA_K = 0.03, JA_C = 0.85, JA_ALPHA = 0.008;
typedef struct { double M, Hv; } Ja;

static double ja_abl(double Hx, double Mx, double delta) {
  double He = Hx + JA_ALPHA * Mx;
  double Man = langevin_t(He / JA_A);
  double dMan = langevin_abl_t(He / JA_A) / JA_A;
  double diff = Man - Mx;
  double dM = diff * delta > 0 ? diff : 0;
  double nenner = JA_K * delta - JA_ALPHA * dM;
  double irr = (nenner > 1e-9 || nenner < -1e-9) ? (1 - JA_C) * dM / nenner : 0;
  return (irr + JA_C * dMan) / (1 - JA_C * JA_ALPHA * dMan);
}
static double ja_schritt(Ja *z, double H) {
  double dH = H - z->Hv;
  double delta = dH >= 0 ? 1 : -1;
  double k1 = ja_abl(z->Hv, z->M, delta);
  double Mm = z->M + 0.5 * dH * k1;
  double k2 = ja_abl(z->Hv + 0.5 * dH, Mm, delta);
  double M = z->M + dH * k2;
  if (M > 1.2) M = 1.2; else if (M < -1.2) M = -1.2;
  if (!isfinite(M)) M = 0;
  z->M = M; z->Hv = H;
  return M;
}

/* ---------- Bänder, Normen ---------- */

typedef struct { const char *name; double mol[3], sol[3], schicht, rauschen[3]; } Band;  /* Index: 7,5 / 15 / 30 ips */
static const Band BAENDER[] = {
  { "sm900", { 11.5, 14.0, 14.0 }, { 4.0, 12.5, 13.0 }, 12, { -63, -62, -66 } },
  { "456", { 9.5, 12.0, 12.5 }, { 2.5, 10.0, 11.5 }, 13.5, { -61, -60, -63 } },
  { "sm468", { 7.5, 12.0, 12.0 }, { 1.0, 12.0, 12.5 }, 14.5, { -64, -62.5, -64.5 } },
};
static const double TAU_NAB[3] = { 50, 50, 17.5 }, TAU_CCIR[3] = { 70, 35, 17.5 };
static int ips_index(double ips) { return ips == 7.5 ? 0 : ips == 30 ? 2 : 1; }
static const Band *band_suchen(const char *n) { for (int i = 0; i < 3; i++) if (!strcmp(BAENDER[i].name, n)) return &BAENDER[i]; return NULL; }
#define SPALT_UM 3.0
#define ABSTAND_UM 0.3
#define WF_VERZ_MS 3
// Gleichlauf-Verzögerung: bandbegrenzt interpoliert (Kaiser-Sinc, 32 Punkte, 512 Phasen, linear zwischen den Phasen).
// Kubisch interpoliert hätte die Höhen je nach Bruchteil des Samples bis −7 dB (16–20 kHz) gedämpft – mit dem Wow
// wandert der Bruchteil ständig, die Höhen „atmeten“. So bleibt es bis 19,8 kHz (bei 44,1 kHz) innerhalb 0,03 dB.
#define WF_N 32
#define WF_P 512
#define WF_BETA 5.0
static double WF_TAB[(WF_P + 1) * WF_N];
static int wf_fertig = 0;
static double wf_i0(double x) {
  double s = 1, t = 1;
  for (int k = 1; k < 60; k++) { double q = x / (2 * k); t *= q * q; s += t; if (t < 1e-20 * s) break; }
  return s;
}
static void wf_bauen(void) {
  if (wf_fertig) return;
  double i0b = wf_i0(WF_BETA);
  for (int p = 0; p <= WF_P; p++) {
    double fr = (double)p / WF_P, sum = 0;
    double *h = WF_TAB + p * WF_N;
    for (int j = 0; j < WF_N; j++) {
      double x = j - (WF_N / 2 - 1) - fr, t = x / (WF_N / 2);
      double si = x == 0 ? 1 : sin(M_PI * x) / (M_PI * x);
      double w = t * t < 1 ? wf_i0(WF_BETA * sqrt(1 - t * t)) / i0b : (t * t == 1 ? 1 / i0b : 0);
      h[j] = si * w; sum += h[j];
    }
    for (int j = 0; j < WF_N; j++) h[j] /= sum;
    // ganze Samples exakt (ohne Gleichlauf bleibt der Weg eine reine Verzögerung)
    if (p == 0 || p == WF_P) for (int j = 0; j < WF_N; j++) h[j] = j == WF_N / 2 - 1 + (p == WF_P) ? 1 : 0;
  }
  wf_fertig = 1;
}

static double wiedergabeverlust(double f, double ips, double schicht_um, int mit_schicht) {
  double v = ips * 25.4e-3;
  double lambda = v / f;
  double k = 2 * M_PI / lambda;
  double g = SPALT_UM * 1e-6, d = ABSTAND_UM * 1e-6, delta = schicht_um * 1e-6;
  double x = M_PI * g / lambda;
  double spalt = x < 1e-6 ? 1 : fabs(sin(x) / x);
  double abstand = exp(-k * d);
  double kd = k * delta;
  double schicht = !mit_schicht || kd < 1e-6 ? 1 : (1 - exp(-kd)) / kd;
  return spalt * abstand * schicht;
}

/* ---------- Zustand ---------- */

typedef struct {
  double drive, ips, bias, gleichlauf, mix, vert, unperfekt; int kopf, auto_, hq, rauschen, ccir; const Band *band;
} Ziel;

typedef struct {
  Ziel z;
  double pre_a, pre_g;
  double post_b0, post_b1, post_a1;
  double fc_basis;
  double kb0, kb1, kb2, ka1, ka2;    /* Kopfbump */
  double sb0, sb1, sb2, sa1, sa2;    /* Kopfkontur */
  double azimut, drive, ausgleich, tiefe, rausch_db, hy_norm;
} Abgel;

typedef struct {
  double *hoch; int hoch_pos;
  double *runter; int runter_pos;
  double *trocken; int trocken_pos, trocken_l;
  double hb_u[HB_MITTE + 2]; int hb_u_pos;
  double hb_d[HB_L]; int hb_d_pos;
  double pre_lp, post_x1, post_y1, env, hf_lp, dc_x, dc_y, k1, k2, s1, s2;
  Ja ja; Adaa adaa; double adaa_y, hy_lp, hy_lp2;
  double *wf, *wft; int wf_pos, wf_len;   // je doppelt lang (gespiegelt), damit 32 Punkte am Stück gelesen werden
  double *delta_runter;
  double dpX, dpY, dhf, dk1, dk2, ds1, ds2, ddX, ddY;
} Kanal;

typedef struct {
  AwFx fx;
  int os, taps, ph, verz;
  double *fir, *poly, *fir_r;
  const double *hb;
  Ziel ziel;
  Abgel abg, ist;
  int ist_da;
  Kanal *kanal[16];
  float *ms_ein[2]; int ms_kap;
  double *wf_mod; int wf_kap;
  double wf_phase[4], wf_rausch, rausch_z[3];
  double tol_bias[2], tol_drive[2], tol_hf[2];
  double drift_ph1, drift_ph2, drift_walk, drift_wert[2];
  double kratz, azimut_z;
} Silk;

static double kleinsignal(double drive, int hq) {
  if (!hq) return drive;
  Ja z = { 0, 0 };
  double ein = 0, aus = 0;
  for (int i = 0; i < 4096; i++) {
    double x = 0.02 * sin(2 * M_PI * i / 256);
    double m = 3 * ja_schritt(&z, x * drive);
    if (i >= 2048) { ein += x * x; aus += m * m; }
  }
  return aus > 1e-18 ? sqrt(aus / ein) : drive;
}

static Abgel ableiten(Silk *s, const Ziel *z) {
  Abgel a; memset(&a, 0, sizeof a);
  a.z = *z;
  double sr = s->fx.sr;
  const Band *band = z->band;
  int ii = ips_index(z->ips);
  double tauUs = (z->ccir ? TAU_CCIR : TAU_NAB)[ii];
  double fE = 1e6 / (2 * M_PI * tauUs);
  double hfDb = max_d(1.0, band->mol[ii] - band->sol[ii]) + 1.0 + (0.5 - z->bias) * 2;
  double aE = 1 - exp(-2 * M_PI * fE / sr);
  double lp10 = 1 / sqrt(1 + pow(10000 / fE, 2));
  double gE = (pow(10, hfDb / 20) - 1) / max_d(0.05, 1 - lp10);
  a.pre_a = aE; a.pre_g = gE;
  double a0 = (1 + gE) - gE * aE;
  a.post_b0 = 1 / a0; a.post_b1 = -(1 - aE) / a0; a.post_a1 = -(1 + gE) * (1 - aE) / a0;
  double v10 = wiedergabeverlust(10000, z->ips, band->schicht, 0), v20 = wiedergabeverlust(20000, z->ips, band->schicht, 0);
  double rest20 = max_d(0.3, min_d(0.999, v20 / v10));
  a.fc_basis = min_d(200000, 20000 / sqrt(1 / (rest20 * rest20) - 1));
  double fK = ii == 0 ? 75 : ii == 1 ? 45 : 28, gK = ii == 0 ? 2.6 : ii == 1 ? 1.8 : 1.2, qK = 0.8;
  double A = pow(10, gK / 40), w0 = 2 * M_PI * fK / sr, al = sin(w0) / (2 * qK);
  double kb0 = 1 + al * A, kb1 = -2 * cos(w0), kb2 = 1 - al * A, ka0 = 1 + al / A, ka1 = kb1, ka2 = 1 - al / A;
  a.kb0 = kb0 / ka0; a.kb1 = kb1 / ka0; a.kb2 = kb2 / ka0; a.ka1 = ka1 / ka0; a.ka2 = ka2 / ka0;
  double fS = fK / 2.2, AS = pow(10, -1.2 / 40), w1 = 2 * M_PI * fS / sr, al1 = sin(w1) / (2 * 1.2);
  double sb0 = 1 + al1 * AS, sb1 = -2 * cos(w1), sb2 = 1 - al1 * AS, sa0 = 1 + al1 / AS, sa2 = 1 - al1 / AS;
  a.sb0 = sb0 / sa0; a.sb1 = sb1 / sa0; a.sb2 = sb2 / sa0; a.sa1 = sb1 / sa0; a.sa2 = sa2 / sa0;
  a.azimut = 7e-6 * sr;
  double kurve = 1.6 - 0.8 * z->bias;
  double molSkala = pow(10, -(band->mol[ii] - 12.0) / 20);
  double drive = z->drive * kurve * molSkala;
  a.ausgleich = z->auto_ ? 1 / drive : 1;
  a.hy_norm = z->hq ? drive / kleinsignal(drive, 1) : 1;
  a.drive = drive;
  a.tiefe = z->gleichlauf * z->gleichlauf * 0.0025 * sr / (2 * M_PI * 0.55);
  a.rausch_db = band->rauschen[ii];
  return a;
}

static void silk_setzen(AwFx *fx, const AwWert *w, int n) {
  Silk *s = (Silk *)fx;
  Ziel *z = &s->ziel;
  double v; const char *t;
  if (wert_zahl(w, n, "drive", &v)) z->drive = klemmen(v, 0.05, 30);
  if (wert_zahl(w, n, "ips", &v)) z->ips = (v == 7.5 || v == 15 || v == 30) ? v : 15;
  if (wert_zahl(w, n, "bias", &v)) z->bias = klemmen(v, 0, 1);
  if (wert_zahl(w, n, "gleichlauf", &v)) z->gleichlauf = klemmen(v, 0, 1);
  if (wert_zahl(w, n, "kopf", &v)) z->kopf = v != 0;
  if (wert_zahl(w, n, "mix", &v)) z->mix = klemmen(v, 0, 1);
  if (wert_zahl(w, n, "vert", &v)) z->vert = klemmen(v, 0, 1);
  if (wert_zahl(w, n, "auto", &v)) z->auto_ = v != 0;
  if (wert_zahl(w, n, "hq", &v)) z->hq = v != 0;
  if (wert_zahl(w, n, "rauschen", &v)) z->rauschen = v != 0;
  if ((t = wert_text(w, n, "norm")) && (!strcmp(t, "nab") || !strcmp(t, "ccir"))) z->ccir = !strcmp(t, "ccir");
  if (wert_zahl(w, n, "unperfekt", &v)) z->unperfekt = klemmen(v, 0, 1);
  if ((t = wert_text(w, n, "band")) && band_suchen(t)) z->band = band_suchen(t);
  s->abg = ableiten(s, z);
  if (s->ist_da && s->ist.z.hq != z->hq) for (int c = 0; c < 16; c++) if (s->kanal[c]) { s->kanal[c]->ja.M = 0; s->kanal[c]->ja.Hv = 0; }
  fx->initial = 1;
  fx->latenz = s->verz + (z->hq ? HB_VERZ + (int)floor(fx->sr * WF_VERZ_MS / 1000 + 0.5) : 0);
  if (!fx->gestartet) { s->ist = ableiten(s, z); s->ist_da = 1; }
}

static Kanal *silk_kanal(Silk *s, int c) {
  if (s->kanal[c]) return s->kanal[c];
  double sr = s->fx.sr;
  Kanal *z = calloc(1, sizeof *z);
  int wf = (int)ceil(sr * WF_VERZ_MS / 1000 * 2.5) + 4;
  z->hoch = calloc((size_t)s->ph * 2, sizeof(double));
  z->runter = calloc((size_t)s->taps * 2, sizeof(double));
  z->trocken_l = s->verz + HB_VERZ + (int)ceil(sr * WF_VERZ_MS / 1000) + 2;
  z->trocken = calloc((size_t)z->trocken_l, sizeof(double));
  z->wf = calloc((size_t)wf * 2, sizeof(double)); z->wft = calloc((size_t)wf * 2, sizeof(double)); z->wf_len = wf;
  z->delta_runter = calloc((size_t)s->taps * 2, sizeof(double));
  s->kanal[c] = z;
  return z;
}

static double rausch(Silk *s) {
  double w = aw_zufall(&s->fx.zufall) * 2 - 1;
  double *r = s->rausch_z;
  r[0] = 0.99765 * r[0] + w * 0.0990460;
  r[1] = 0.96300 * r[1] + w * 0.2965164;
  r[2] = 0.57000 * r[2] + w * 1.0526913;
  return (r[0] + r[1] + r[2] + w * 0.1848) * 0.11;
}

static void silk_block(AwFx *fx, const float *const *ein, float *const *aus, int kan, int n) {
  Silk *S = (Silk *)fx;
  if (!fx->initial) silk_setzen(fx, NULL, 0);
  fx->gestartet = 1;
  const int OS = S->os, TAPS = S->taps, PH = S->ph, VERZ = S->verz;
  const float *dzA = delta_verlauf(fx, n);
  const double *HB = S->hb;
  Abgel *z0 = &S->ist, *z1 = &S->abg;
  const double sr = fx->sr;
  double drive = z0->drive, dDrive = (z1->drive - z0->drive) / n;
  double mix = z0->z.mix, dMix = (z1->z.mix - z0->z.mix) / n;
  double vert = z0->z.vert, dVert = (z1->z.vert - z0->z.vert) / n;
  double ausg = z0->ausgleich, dAusg = (z1->ausgleich - z0->ausgleich) / n;
  double tiefe = z0->tiefe, dTiefe = (z1->tiefe - z0->tiefe) / n;
  int hq = z1->z.hq, kopfAn = z1->z.kopf, rauschAn = hq && z1->z.rauschen;
  double hyW = hq ? 0.06 + 0.14 * (1 - z1->z.bias) : 0;
  double hyK = 1 - exp(-2 * M_PI * 3000 / (sr * OS * 2));
  double hyNorm = z1->hy_norm ? z1->hy_norm : 1;
  if (hq) {
    S->drift_ph1 += 2 * M_PI * n / (sr * 83); S->drift_ph2 += 2 * M_PI * n / (sr * 127);
    S->drift_walk += 0.02 * ((aw_zufall(&fx->zufall) * 2 - 1) - S->drift_walk);
    double w = 0.01 * sin(S->drift_ph1) + 0.005 * sin(S->drift_ph2) + 0.006 * S->drift_walk;
    S->drift_wert[0] = 1 + w; S->drift_wert[1] = 1 - 0.8 * w;
  }
  double fcBasis = z1->fc_basis, cw20 = 2 * (1 - cos(2 * M_PI * min_d(20000, sr * 0.45) / sr));
  double dcR = 1 - 2 * M_PI * 6 / sr;
  double envA = 1 - exp(-1 / (sr * 0.003)), envR = 1 - exp(-1 / (sr * 0.08));
  double wfNominal = floor(sr * WF_VERZ_MS / 1000 + 0.5);
  // HQ: der trockene Weg läuft durch dieselbe modulierte Verzögerung (sonst kämmt Mix < 1 wie ein Flanger)
  int trockenVerz = VERZ + (hq ? HB_VERZ : 0);
  int ms = kan == 2 && ein && ein[0] && ein[1];
  if (ms) {
    if (S->ms_kap < n) { for (int c = 0; c < 2; c++) { free(S->ms_ein[c]); S->ms_ein[c] = malloc(sizeof(float) * (size_t)n); } S->ms_kap = n; }
    const float *l = ein[0], *r = ein[1];
    for (int i = 0; i < n; i++) { S->ms_ein[0][i] = (float)(((double)l[i] + r[i]) * 0.5); S->ms_ein[1][i] = (float)(((double)l[i] - r[i]) * 0.5); }
  }
  const double *wfMod = NULL;
  if (hq && (tiefe > 0 || dTiefe != 0)) {
    if (S->wf_kap < n) { free(S->wf_mod); S->wf_mod = malloc(sizeof(double) * (size_t)n); S->wf_kap = n; }
    double *wm = S->wf_mod, *ph = S->wf_phase;
    const double fq[4] = { 0.55, 5.3, 8.9, 13.1 };
    double inc[4]; for (int k = 0; k < 4; k++) inc[k] = 2 * M_PI * fq[k] / sr;
    const double fl[4] = { 1, 0.4 * fq[0] / fq[1], 0.3 * fq[0] / fq[2], 0.2 * fq[0] / fq[3] };
    for (int i = 0; i < n; i++) {
      double t = tiefe + dTiefe * i;
      S->wf_rausch += 0.0015 * ((aw_zufall(&fx->zufall) * 2 - 1) - S->wf_rausch);
      wm[i] = t * (fl[0] * sin(ph[0]) + fl[1] * sin(ph[1]) + fl[2] * sin(ph[2]) + fl[3] * sin(ph[3]) + 0.3 * S->wf_rausch);
      for (int k = 0; k < 4; k++) { ph[k] += inc[k]; if (ph[k] > 2 * M_PI) ph[k] -= 2 * M_PI; }
    }
    wfMod = wm;
  }
  double rauschPegel = rauschAn ? pow(10, z1->rausch_db / 20) : 0;
  Faerb *mess = fx->messen ? fx->messer : NULL;
  if (mess) faerb_start(mess, n);
  for (int c = 0; c < kan; c++) {
    const float *x = ms ? S->ms_ein[c] : (ein ? ein[c] : NULL);
    float *y = aus[c];
    if (!x || c >= 16) { memset(y, 0, sizeof(float) * (size_t)n); continue; }
    int seite = ms && c == 1;
    Kanal *z = silk_kanal(S, c);
    float *mA = mess ? mess->abw[c & 1] : NULL, *mL = mess ? mess->lin[c & 1] : NULL;
    double *hoch = z->hoch, *runter = z->runter, *trk = z->trocken;
    int tLen = z->trocken_l;
    int hp = z->hoch_pos, rp = z->runter_pos, tp = z->trocken_pos;
    double preLP = z->pre_lp, postX1 = z->post_x1, postY1 = z->post_y1, env = z->env, hfLP = z->hf_lp, dcX = z->dc_x, dcY = z->dc_y, k1 = z->k1, k2 = z->k2;
    double *wf = z->wf, *wft = z->wft; int wfLen = z->wf_len, wfPos = z->wf_pos;
    double wk[WF_N];
    double s1 = z->s1, s2 = z->s2;
    double unp = hq ? z1->z.unperfekt : 0;
    int t1 = c & 1;
    double tolDrive = hq ? 1 + (S->tol_drive[t1] - 1) * unp : 1, tolHf = hq ? 1 + (S->tol_hf[t1] - 1) * unp : 1;
    double dft = hq ? 1 + (S->drift_wert[t1] - 1) * unp : 1;
    double fcB = hq ? fcBasis * tolHf : fcBasis;
    for (int i = 0; i < n; i++) {
      double vt = vert + dVert * i;
      double dr = (drive + dDrive * i) * (hq ? tolDrive * dft : 1), ag = ausg + dAusg * i;
      double mx = (mix + dMix * i) * (!ms ? 1 : seite ? min_d(1, 2 * vt) : min_d(1, 2 * (1 - vt)));
      double ein_i = x[i];
      trk[tp] = ein_i;
      int lesePos = tp - trockenVerz; if (lesePos < 0) lesePos += tLen;
      double trocken = trk[lesePos];
      tp = tp == tLen - 1 ? 0 : tp + 1;
      preLP += z1->pre_a * (ein_i - preLP);
      double vorband = ein_i + z1->pre_g * (ein_i - preLP);
      hoch[hp] = vorband; hoch[hp + PH] = vorband;
      int basis = hp + PH;
      for (int k = 0; k < OS; k++) {
        double u = skalar(S->poly + k * PH, hoch + basis - PH + 1, PH);
        u *= OS * dr;
        if (k == 0 && mA) { mA[i] = (float)((3 * langevin_t(u) - u) * mx); mL[i] = (float)u; }
        double v;
        if (!hq) {
          double ya = band_adaa(&z->adaa, u);
          v = ya + 0.2 * (ya - z->adaa_y); z->adaa_y = ya;
        } else {
          double *hu = z->hb_u, *hd = z->hb_d;
          const int hl = HB_MITTE + 2;
          int up = z->hb_u_pos; hu[up] = u; z->hb_u_pos = up = up == hl - 1 ? 0 : up + 1;
#define ALT(j) (hu[((up - 1 - (j)) % hl + hl) % hl])
          double gerade = ALT(HB_MITTE / 2);
          double ungerade = 0;
          for (int ii = 1; ii < HB_L; ii += 2) ungerade += HB[ii] * ALT((ii - 1) / 2);
          ungerade *= 2;
#undef ALT
          int dp = z->hb_d_pos;
          double uu, abw;
          /* Schritt mit dem geraden Wert */
          uu = gerade; abw = 0;
          if (hyW > 0) {
            z->hy_lp += hyK * (uu - z->hy_lp); z->hy_lp2 += hyK * (z->hy_lp - z->hy_lp2);
            abw = hyW * (hyNorm * 3 * ja_schritt(&z->ja, z->hy_lp2) - 3 * langevin(z->hy_lp2));
          }
          hd[dp] = band_adaa(&z->adaa, uu) + abw; dp = dp == HB_L - 1 ? 0 : dp + 1;
          double sm = 0;
          for (int t = 0; t < HB_L; t++) { int q = dp - 1 - t; if (q < 0) q += HB_L; sm += HB[t] * hd[q]; }
          /* Schritt mit dem ungeraden Wert */
          uu = ungerade; abw = 0;
          if (hyW > 0) {
            z->hy_lp += hyK * (uu - z->hy_lp); z->hy_lp2 += hyK * (z->hy_lp - z->hy_lp2);
            abw = hyW * (hyNorm * 3 * ja_schritt(&z->ja, z->hy_lp2) - 3 * langevin(z->hy_lp2));
          }
          hd[dp] = band_adaa(&z->adaa, uu) + abw; dp = dp == HB_L - 1 ? 0 : dp + 1;
          z->hb_d_pos = dp;
          v = sm;
        }
        if (dzA) { double rr = 3 * langevin_t(u) - u; z->delta_runter[rp] = rr; z->delta_runter[rp + TAPS] = rr; }
        runter[rp] = v; runter[rp + TAPS] = v;
        rp = rp == TAPS - 1 ? 0 : rp + 1;
      }
      hp = hp == PH - 1 ? 0 : hp + 1;
      int b2 = (rp == 0 ? TAPS - 1 : rp - 1) + TAPS;
      double band = skalar(S->fir_r, runter + b2 - TAPS + 1, TAPS);
      band *= ag;
      double ent = z1->post_b0 * band + z1->post_b1 * postX1 - z1->post_a1 * postY1; postX1 = band; postY1 = ent; band = ent;
      double betrag = fabs(vorband * dr);
      env += (betrag > env ? envA : envR) * (betrag - env);
      double ueber = max_d(0, min_d(1, (env - 0.8) / 1.2));
      double fc = fcB * (1 - 0.5 * ueber);
      double cq = cw20 * (fc / 20000) * (fc / 20000);
      double hfK = min_d(1, (-cq + sqrt(cq * cq + 4 * cq)) / 2);
      hfLP += hfK * (band - hfLP); band = hfLP;
      if (kopfAn) {
        double o = z1->kb0 * band + k1;
        k1 = z1->kb1 * band - z1->ka1 * o + k2;
        k2 = z1->kb2 * band - z1->ka2 * o;
        band = o;
        if (hq) { double o2 = z1->sb0 * band + s1; s1 = z1->sb1 * band - z1->sa1 * o2 + s2; s2 = z1->sb2 * band - z1->sa2 * o2; band = o2; }
      }
      double w = band - dcX + dcR * dcY; dcX = band; dcY = w; band = w;
      double rest = 0;
      if (dzA) {
        double r = skalar(S->fir_r, z->delta_runter + b2 - TAPS + 1, TAPS);
        r *= ag;
        double e2 = z1->post_b0 * r + z1->post_b1 * z->dpX - z1->post_a1 * z->dpY; z->dpX = r; z->dpY = e2; r = e2;
        z->dhf += hfK * (r - z->dhf); r = z->dhf;
        if (kopfAn) {
          double o = z1->kb0 * r + z->dk1; z->dk1 = z1->kb1 * r - z1->ka1 * o + z->dk2; z->dk2 = z1->kb2 * r - z1->ka2 * o; r = o;
          if (hq) { double o2 = z1->sb0 * r + z->ds1; z->ds1 = z1->sb1 * r - z1->sa1 * o2 + z->ds2; z->ds2 = z1->sb2 * r - z1->sa2 * o2; r = o2; }
        }
        double rw = r - z->ddX + dcR * z->ddY; z->ddX = r; z->ddY = rw;
        rest = rw;
      }
      if (hq) {
        wf[wfPos] = band; wf[wfPos + wfLen] = band;
        wft[wfPos] = trocken; wft[wfPos + wfLen] = trocken;
        if (c == 0 || !ms) S->kratz += 0.02 * ((aw_zufall(&fx->zufall) * 2 - 1) - S->kratz);
        double d = wfNominal + (wfMod ? wfMod[i] : 0) + S->kratz * 0.015 * sr / 48000 * (0.3 + z1->z.gleichlauf) * unp;
        double lp = wfPos - d; while (lp < 0) lp += wfLen;
        int i0 = (int)floor(lp); double fr = lp - i0;
        double pf = fr * WF_P; int p = (int)floor(pf); double a = pf - p;
        const double *h0 = WF_TAB + p * WF_N, *h1 = h0 + WF_N;
        for (int j = 0; j < WF_N; j++) wk[j] = h0[j] + a * (h1[j] - h0[j]);
        int st = i0 - (WF_N / 2 - 1); if (st < 0) st += wfLen;
        band = skalar(wk, wf + st, WF_N);
        if (mx != 1) trocken = skalar(wk, wft + st, WF_N);
        wfPos = wfPos == wfLen - 1 ? 0 : wfPos + 1;
        band += rausch(S) * (min_d(1, env) * 0.0025 * unp + (rauschAn ? rauschPegel * (seite ? 0.7 : 1) : 0));
      }
      double normal = trocken + (band - trocken) * mx;
      y[i] = (float)(dzA ? normal * (1 - dzA[i]) + rest * mx * dzA[i] : normal);
    }
    z->hoch_pos = hp; z->runter_pos = rp; z->trocken_pos = tp; z->pre_lp = preLP; z->post_x1 = postX1; z->post_y1 = postY1;
    z->env = env; z->hf_lp = hfLP; z->dc_x = dcX; z->dc_y = dcY; z->k1 = k1; z->k2 = k2; z->wf_pos = wfPos; z->s1 = s1; z->s2 = s2;
  }
  if (ms) {
    float *yM = aus[0], *yS = aus[1];
    for (int i = 0; i < n; i++) { double m = yM[i], sd = yS[i]; yM[i] = (float)(m + sd); yS[i] = (float)(m - sd); }
  }
  if (mess) faerb_sammeln(mess, n, ms, sr);
  if (ms && hq) {
    double dAz = z1->azimut * max_d(0, min_d(1, z1->z.mix));
    double eta = (1 - dAz) / (1 + dAz);
    float *r = aus[1];
    double zz = S->azimut_z;
    for (int i = 0; i < n; i++) { double xin = r[i]; double yo = eta * xin + zz; zz = xin - eta * yo; r[i] = (float)yo; }
    S->azimut_z = zz;
  }
  S->ist = *z1;
}

static void silk_frei(AwFx *fx) {
  Silk *s = (Silk *)fx;
  for (int c = 0; c < 16; c++) {
    Kanal *z = s->kanal[c];
    if (!z) continue;
    free(z->hoch); free(z->runter); free(z->trocken); free(z->wf); free(z->wft); free(z->delta_runter); free(z);
  }
  free(s->ms_ein[0]); free(s->ms_ein[1]); free(s->wf_mod); free(s->fir); free(s->poly); free(s->fir_r);
  free(s);
}

AwFx *silk_neu(double sr) {
  lt_bauen();
  wf_bauen();
  Silk *s = calloc(1, sizeof *s);
  s->fx.setzen = silk_setzen; s->fx.block = silk_block; s->fx.frei = silk_frei; s->fx.sr = sr;
  s->os = sr >= 150000 ? 1 : sr >= 75000 ? 2 : 4;
  s->taps = s->os == 1 ? 1 : 40 * s->os + 1;
  s->ph = (s->taps + s->os - 1) / s->os;
  s->verz = (s->taps - 1) / s->os;
  s->fir = fir_entwurf(s->os, s->taps, s->ph, 8);
  s->poly = polyphase(s->fir, s->os, s->ph);
  s->fir_r = rueckwaerts(s->fir, s->taps);
  s->hb = halbband();
  s->fx.latenz = s->verz;
  Ziel z = { .drive = 1, .ips = 15, .bias = 0.5, .gleichlauf = 0.3, .kopf = 1, .mix = 1, .vert = 0.5, .auto_ = 1, .hq = 0, .rauschen = 0, .ccir = 0, .band = &BAENDER[0], .unperfekt = 1 };
  s->ziel = z;
  double tb[2] = {1.03, 0.97}, td[2] = {1.035, 0.966}, th_[2] = {0.97, 1.03};
  for (int i = 0; i < 2; i++) { s->tol_bias[i] = tb[i]; s->tol_drive[i] = td[i]; s->tol_hf[i] = th_[i]; }
  s->drift_ph1 = 1.3; s->drift_ph2 = 0.4; s->drift_wert[0] = s->drift_wert[1] = 1;
  return &s->fx;
}
