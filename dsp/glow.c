// AmberGlow – Röhrensättigung. Übersetzung von app/js/waerme-worklet.js (Stand 2), Rechenweg und Reihenfolge unverändert:
// Standard = statische Trioden-Kennlinie mit ADAA, HQ = 12AX7-Stufe nach Koren (Newton je Takt, inneres 2×), Mitte/Seite,
// Verteilung, Auto-Gain, Tonblende, Färbungsmessung und Delta. Kommentare zur Physik stehen im Worklet.
#include "intern.h"

/* ---------- Kennlinie (Standard) ---------- */

/** Form der Standard-Kennlinie je Röhre: ap = Rundung oben (positive Hälfte), an = unten; pp = Gegentakt, m = Symmetrie (0…1) */
typedef struct { double ap, an, bs, m; int pp; } Kurve;

static double kl_roh(const Kurve *k, double v) { return v >= 0 ? th(v * k->ap) / k->ap : th(v * k->an) / k->an; }
static double bias_eff(const Kurve *k, double bias) { return bias >= 0 ? bias * k->bs : bias; }
static double ruhe_s(const Kurve *k, double bias) { return kl_roh(k, bias_eff(k, bias)); }
/** Eintakt: eine Kennlinie; Gegentakt: ½·(g(u) − m·g(−u)) – gerade Anteile fallen mit wachsendem m heraus, der Rest wird über die Verstärkung ausgeglichen */
static double kennlinie(const Kurve *k, double u, double bias, double s0) {
  double b = bias_eff(k, bias), g = kl_roh(k, u + b) - s0;
  if (!k->pp) return g;
  return 0.5 * (g - k->m * (kl_roh(k, b - u) - s0));
}
static double ln_cosh(double x) { double a = fabs(x); return a > 20 ? a - M_LN2 : log(cosh(a)); }
static double stamm_roh(const Kurve *k, double v) {
  return v >= 0 ? ln_cosh(v * k->ap) / (k->ap * k->ap) : ln_cosh(v * k->an) / (k->an * k->an);
}
static double kennlinie_stamm(const Kurve *k, double u, double bias) {
  double b = bias_eff(k, bias);
  if (!k->pp) return stamm_roh(k, u + b);
  return 0.5 * (stamm_roh(k, u + b) + k->m * stamm_roh(k, b - u));
}
/** Steigung der Roh-Kennlinie am Arbeitspunkt (für die Färbungsmessung) */
static double steigung_b(const Kurve *k, double bias) {
  double b = bias_eff(k, bias), a = b >= 0 ? k->ap : k->an, t = th(a * b), sl = 1 - t * t;
  return k->pp ? 0.5 * (1 + k->m) * sl : sl;
}
typedef struct { double u, F0, F; int gueltig; int bias_gesetzt; double bias, m; } Adaa;
static double kennlinie_adaa(const Kurve *k, Adaa *st, double u, double bias, double s0) {
  double u0 = st->u, d = u - u0;
  st->u = u;
  if (fabs(d) < 1e-5) { st->gueltig = 0; return kennlinie(k, (u + u0) * 0.5, bias, s0); }
  double F1 = st->F = kennlinie_stamm(k, u, bias);
  double F0 = st->gueltig && st->bias_gesetzt && st->bias == bias && st->m == (k->pp ? k->m : -1) ? st->F0 : kennlinie_stamm(k, u0, bias);
  st->F0 = F1; st->gueltig = 1; st->bias = bias; st->m = k->pp ? k->m : -1; st->bias_gesetzt = 1;
  return (F1 - F0) / d - (k->pp ? 0.5 * s0 * (1 - k->m) : s0);
}
#define ADAA_BOOST 0.2

static double statischer_ausgleich(const Kurve *k, double drive, double bias) {
  double d = 1e-4, s0 = ruhe_s(k, bias);
  double steigung = (kennlinie(k, d, bias, s0) - kennlinie(k, -d, bias, s0)) / (2 * d);
  return 1 / max_d(1e-3, drive * steigung);
}
static double seiten_boost(double vert) { return pow(10, (9 * max_d(0, (vert - 0.5) * 2)) / 20); }

/* ---------- HQ: 12AX7 nach Koren ---------- */

/* Röhrentypen: Koren-Parameter, Schaltung (Anodenwiderstand, Versorgung, Kathodenwiderstand für „Charakter“), Ansteuerung in Volt je Vollaussteuerung
   und die Form der Standard-Kennlinie (ap/an) mit Arbeitspunkt-Faktor. Die Werte stehen identisch in waerme-worklet.js. */
typedef struct {
  const char *name;
  double mu, ex, kg1, kp, kvb, rgi, vth, w;   /* Koren (Triode) + Gitterstrom */
  double ra, vb0, rk_heiss, rk_kalt;          /* Schaltung */
  double v_voll;                              /* Volt am Gitter bei 0 dBFS × Ansteuerung 1 */
  double ap, an, b_std;                       /* Standard-Kennlinie: Rundung oben/unten, Faktor auf den Arbeitspunkt */
} Roehre;
#define ROEHREN_N 4
static const Roehre ROEHREN[ROEHREN_N] = {
  { "ax7", 100, 1.4, 1060, 600, 300, 2000, -0.7, 0.12, 100e3, 300, 1000, 2700, 0.5, 0.23345, 0.562948, 4.5442 },
  { "at7", 60, 1.35, 460, 300, 300, 2000, -0.7, 0.12, 47e3, 300, 400, 1000, 0.6, 0.1092, 1.600248, 13.9551 },
  { "au7", 21.5, 1.3, 1180, 84, 300, 2000, -0.7, 0.12, 47e3, 300, 700, 1700, 0.9, 0.0483, 0.57201, 33.4638 },
  { "sn7", 20, 1.4, 1894, 160, 300, 2000, -0.7, 0.12, 47e3, 300, 900, 3900, 1.1, 0.0602, 0.027176, 19.3895 },
};
static const Roehre *roehre_suchen(const char *n) { for (int i = 0; i < ROEHREN_N; i++) if (!strcmp(ROEHREN[i].name, n)) return &ROEHREN[i]; return NULL; }
static const double S_CK = 100e-6, S_RG = 220e3, S_RS = 10e3, S_CC = 330e-9, S_RB = 4700, S_CB = 47e-6;

typedef struct { double ip, dip, ig, dig; const Roehre *T; double cc, tol; int iter; double kf_vg; } Kor;

static void koren_ip(Kor *K, double Vgk, double Vpk) {
  if (Vpk < 1e-3) Vpk = 1e-3;
  double s = sqrt(K->T->kvb + Vpk * Vpk);
  double kpa = K->T->kp * (1 / K->T->mu + Vgk / s);
  double L, sig;
  if (kpa > 40) { L = kpa; sig = 1; }
  else if (kpa < -40) { L = exp(kpa); sig = L; }
  else { double e = exp(kpa); L = log1p(e); sig = e / (1 + e); }
  double E1 = (Vpk / K->T->kp) * L;
  if (E1 <= 0) { K->ip = 0; K->dip = 0; return; }
  double p = pow(E1, K->T->ex - 1);
  K->ip = 2 * p * E1 / K->T->kg1;
  K->dip = (2 * K->T->ex * p / K->T->kg1) * (L / K->T->kp - Vpk * sig * Vgk * Vpk / (s * s * s));
}

static void gitterstrom(Kor *K, double Vgk) {
  double xg = (Vgk - K->T->vth) / K->T->w;
  if (xg > 30) { K->ig = (Vgk - K->T->vth) / K->T->rgi; K->dig = 1 / K->T->rgi; return; }
  if (xg < -40) { K->ig = 0; K->dig = 0; return; }
  double e = exp(xg);
  K->ig = K->T->w * log1p(e) / K->T->rgi; K->dig = (e / (1 + e)) / K->T->rgi;
}

static double anode_loesen(Kor *K, double Vgk, double Vk, double Vb, double R, double Vp) {
  for (int n = 0; n < 8; n++) {
    koren_ip(K, Vgk, Vp - Vk);
    double d = (Vp - Vb + R * K->ip) / (1 + R * K->dip);
    Vp -= d;
    if (Vp < Vk + 1) Vp = Vk + 1; else if (Vp > Vb) Vp = Vb;
    if (fabs(d) < 1e-5) break;
  }
  return Vp;
}

typedef struct { double Vk, Vp, Vb, Vg, gain; } Ruhe;

static double gitter_ruhe(Kor *K, double Vk) {
  double Vg = 0;
  for (int i = 0; i < 8; i++) { gitterstrom(K, Vg - Vk); Vg = -S_RG * K->ig; }
  return Vg;
}

static Ruhe ruhepunkt(const Roehre *T, double Rk, double Vb0) {
  Kor K = {0};
  K.T = T;
  double R = T->ra + S_RB;
  double lo = 0, hi = 40, Vp = Vb0 * 0.6, Vg = 0;
  for (int i = 0; i < 60; i++) {
    double Vk = (lo + hi) / 2;
    Vg = gitter_ruhe(&K, Vk);
    Vp = anode_loesen(&K, Vg - Vk, Vk, Vb0, R, Vp);
    double Ip = (Vb0 - Vp) / R;
    if (Ip > Vk / Rk) lo = Vk; else hi = Vk;
  }
  double Vk = (lo + hi) / 2, Ip = (Vb0 - Vp) / R, Vb = Vb0 - S_RB * Ip;
  double d = 1e-3;
  double Vp1 = anode_loesen(&K, Vg - Vk + d, Vk, Vb, T->ra, Vp), Vp2 = anode_loesen(&K, Vg - Vk - d, Vk, Vb, T->ra, Vp);
  Ruhe r = { Vk, Vp, Vb, Vg, fabs(Vp1 - Vp2) / (2 * d) * (S_RG / (S_RG + S_RS)) };
  return r;
}

static double rk_aus_bias(const Roehre *T, double bias) {
  double t = klemmen((bias - 0.04) / 0.4, 0, 1);
  return T->rk_heiss + (T->rk_kalt - T->rk_heiss) * t;
}

/* ---------- Zustand ---------- */

typedef struct { double Vk, Vp, Vp_alt, Vc, Vb, Vg, vpq; } Stufe;
/* Kathodenfolger (Ultra): Kathodenspannung und Spannung am Koppelkondensator zur Last */
typedef struct { double Vk, q; } Kf;

typedef struct {
  double *hoch; int hoch_pos;
  double *runter; int runter_pos;
  double *trocken; int trocken_pos;
  double hb_u[HB_MITTE + 2]; int hb_u_pos;
  double hb_d[HB_L]; int hb_d_pos;
  double dc_x, dc_y, ton;
  Adaa adaa; double adaa_y;
  Stufe st[2];                       /* Röhrenstufen (HQ): 0 = Eintakt bzw. erste Röhre, 1 = zweite Röhre im Gegentakt */
  Kf kf;                             /* Kathodenfolger hinter der Stufe (Ultra) */
  double *delta_runter; double d_dc_x, d_dc_y, d_ton;
  double ot_phi, ot_lp;               /* Ausgangsübertrager (Ultra) */
} Kanal;

typedef struct { double drive, bias, ton, mix, vert, s_boost, rk, ton_k, ausgleich, ausgleich_s, hq_ausgleich, hq_ausgleich_s, symm; int auto_, hq, pp;
  /* Innenleben (nur Ultra): Kathodenfolger, Anodenlast, Erholung des Koppelkondensators, Röhrenalter, Ausgangsübertrager */
  int ultra, kf, last, erholung, ot; double alter, kf_gain; } Werte;

typedef struct { long rk, vb; Ruhe r; } CacheEintrag;

typedef struct {
  AwFx fx;
  int os, taps, ph, verz, trocken_l, hb_verz;
  double *fir, *poly, *fir_r;
  const double *hb;
  Kanal *kanal[8];
  Werte ziel, ist;
  double ausgleich, ausgleich_s, hq_ausgleich, hq_ausgleich_s, ton_k;
  double dt_os;
  double tol_bias[2], tol_drive[2], tol_ton[2], tol_vb[2];
  double drift_ph1, drift_ph2, drift_walk, drift_wert[2];
  CacheEintrag cache[66]; int n_cache;
  float *ms_ein[2]; int ms_kap;
  Kor K;
  const Roehre *T;
  Roehre Tm;          /* die Röhre, wie sie in der Schaltung sitzt (Alter, Anodenlast) */
  double tol_basis[4][2];
} Glow;

/** Gegentakt (HQ): zwei gleiche Stufen, die zweite mit −u; Ausgang ½·(r1 − m·r2). m = Symmetrie: bei 1 heben sich die geraden Anteile auf, bei 0 bleibt eine Röhre */
static Kurve kurve_von(const Glow *g, const Werte *z) { Kurve k = { g->T->ap, g->T->an, g->T->b_std, z->symm, z->pp }; return k; }

static Ruhe glow_ruhe(Glow *g, double Rk, double Vb0) {
  long krk = lround(Rk), kvb = lround(Vb0 * 10);
  for (int i = 0; i < g->n_cache; i++) if (g->cache[i].rk == krk && g->cache[i].vb == kvb) return g->cache[i].r;
  Ruhe r = ruhepunkt(&g->Tm, Rk, Vb0);
  if (g->n_cache > 64) g->n_cache = 0;
  g->cache[g->n_cache].rk = krk; g->cache[g->n_cache].vb = kvb; g->cache[g->n_cache].r = r;
  g->n_cache++;
  return r;
}

static void kanal_stufen(Glow *g, Kanal *z, int c);

/* ---------- Kathodenfolger (Ultra) ----------
 * Dieselbe Röhre noch einmal, als Kathodenfolger hinter der Stufe: Gitter gleichspannungsgekoppelt an die Anode davor,
 * Rk 100 kΩ nach Masse, Koppelkondensator 22 nF auf eine Last von 220 kΩ (klassische Schaltung vor einer Klangregelung).
 * Je Takt wird die Kathodenspannung gelöst (Newton): Röhrenstrom = Strom durch Rk + Strom in die Last.
 *  • Anode davor schwingt hoch → Gitter will über die Kathode → Gitterstrom belastet die Anode (über Ra) → weiche Rundung
 *  • Anode schwingt schnell herunter → der Strom reißt ab (Cutoff), die Kathode kann nur so schnell fallen, wie Rk und die
 *    Last den Koppelkondensator entladen → harte Kante auf dieser Halbwelle
 * Beides kommt aus der Schaltung, nicht aus einer Kennlinie. */
static const double KF_RK = 100e3, KF_RL = 220e3, KF_C = 220e-9;
static double kf_strom(Kor *K, double Vg, double Vk, double Vb) { koren_ip(K, Vg - Vk, Vb - Vk); return K->ip; }
/** Gitterspannung, die sich einstellt: Anode davor Vp über den Quellwiderstand Rq, Gitterstrom zieht sie herunter */
static double kf_gitter(Kor *K, double Vp, double Vk, double Rq) {
  double Vg = K->kf_vg > 0 && K->kf_vg <= Vp ? K->kf_vg : Vp;   /* Warmstart mit der letzten Lösung */
  for (int it = 0; it < 12; it++) {
    gitterstrom(K, Vg - Vk);
    double f = Vg - Vp + K->ig * Rq, df = 1 + K->dig * Rq;
    double d = f / df; Vg -= d;
    if (Vg > Vp) Vg = Vp;
    if (fabs(d) < 1e-7) break;
  }
  K->kf_vg = Vg;
  return Vg;
}
/** Kathodenspannung lösen: Ip(Vg(Vk) − Vk, Vb − Vk) = Vk/Rk + Laststrom (b = 0: Kondensator offen, Ruhepunkt).
 *  f ist monoton fallend, aber am Knie zwischen Cutoff und Gitterstrom extrem steil – darum Newton mit frischer Ableitung
 *  in jedem Schritt, eingezäunt durch eine Bisektion (sonst meldet ein winziger Schritt Konvergenz, obwohl f ≠ 0). */
static double kf_f(Kor *K, double Vp, double Vk, double Vb, double Rq, double q, double b, double dq, double h) {
  return kf_strom(K, kf_gitter(K, Vp, Vk, Rq), Vk, Vb) - Vk / KF_RK - (Vk - q + dq * h) * b;
}
static double kf_loesen(Kor *K, double Vp, double Vk, double Vb, double Rq, double q, double b, double dq) {
  double lo = 0, hi = Vb;
  if (Vk < lo) Vk = lo; else if (Vk > hi) Vk = hi;
  for (int it = 0; it < 30; it++) {
    double f0 = kf_f(K, Vp, Vk, Vb, Rq, q, b, dq, 0);
    if (fabs(f0) < 2e-8) break;                 /* 0,02 µA – weit unter dem, was 1 mV am Ausgang ausmacht */
    if (f0 > 0) lo = Vk; else hi = Vk;
    const double h = 1e-2;   /* Ableitung numerisch – analytisch ist sie am Knie zu grob */
    double df = (kf_f(K, Vp, Vk + h, Vb, Rq, q, b, dq, h) - f0) / h;
    double neu = df < -1e-12 ? Vk - f0 / df : 0.5 * (lo + hi);
    if (!(neu > lo && neu < hi)) neu = 0.5 * (lo + hi);   /* Newton verlässt den Zaun → Bisektion */
    if (fabs(neu - Vk) < 1e-4 && hi - lo < 1e-3) { Vk = neu; break; }
    Vk = neu;
  }
  return Vk;
}
/** Quellwiderstand der Anode davor: Ra ∥ rp (rp = µ/gm am Ruhepunkt der Stufe) */
static double kf_rq(Glow *g, const Ruhe *r) {
  Ruhe rr = r ? *r : glow_ruhe(g, g->ziel.rk, g->Tm.vb0);
  Kor K = g->K; koren_ip(&K, rr.Vg - rr.Vk, rr.Vp - rr.Vk);
  double gm = K.dip > 1e-6 ? K.dip : 1e-6, rp = g->Tm.mu / gm;
  return g->Tm.ra * rp / (g->Tm.ra + rp);
}
/** Ruhepunkt: Kondensator offen, Ip = Vk/Rk */
static void kf_ruhe(Kor *K, Kf *z, double Vp, double Vb, double Rq) {
  z->Vk = kf_loesen(K, Vp, Vp + 2, Vb, Rq, 0, 0, 0);
  z->q = z->Vk;
}
/** Verstärkung am Ruhepunkt (Kondensator offen, ±0,1 V am Gitter) */
static double kf_gain_von(Kor *K, const Kf *z, double Vp, double Vb, double Rq) {
  double a = kf_loesen(K, Vp + 0.1, z->Vk, Vb, Rq, 0, 0, 0), b = kf_loesen(K, Vp - 0.1, z->Vk, Vb, Rq, 0, 0, 0);
  return klemmen((a - b) / 0.2, 0.3, 1);
}
/** ein Takt: Anode davor (Vp, Quellwiderstand Rq) → Ausgangsspannung an der Last (um 0 in Ruhe) */
static double kf_takt(Kor *K, Kf *z, double Vp, double Vb, double Rq, double dt) {
  const double a = KF_C / dt, b = 1 / KF_RL, dq = b / (a + b);
  double Vk = kf_loesen(K, Vp, z->Vk, Vb, Rq, z->q, b, dq);
  double q = (a * z->q + Vk * b) / (a + b);
  z->Vk = Vk; z->q = q;
  return Vk - q;
}

/** Röhre in der Schaltung: Alter (weniger Emission, etwas weniger µ) und Anodenlast (Drossel/Übertrager: gleiche Ruhe,
 *  steilere Wechselstrom-Lastgerade) – ohne Ultra genau die Röhre aus der Tabelle. 1 = hat sich geändert */
static int tm_bauen(Glow *g, const Werte *z) {
  Roehre m = *g->T;
  if (z->ultra) {
    m.kg1 *= 1 + 0.6 * z->alter; m.mu *= 1 - 0.08 * z->alter;
    if (z->last == 1 || z->last == 2) {
      Ruhe r0 = ruhepunkt(&m, rk_aus_bias(g->T, 0.12), m.vb0);   /* fester Bezug: Charakter-Knopf verschiebt die Last nicht */
      double Iq = (m.vb0 - r0.Vp) / (m.ra + S_RB), Rn = m.ra * (z->last == 1 ? 4 : 2.5);
      m.vb0 = r0.Vp + (Rn + S_RB) * Iq; m.ra = Rn;
    }
  }
  int neu = m.mu != g->Tm.mu || m.kg1 != g->Tm.kg1 || m.ra != g->Tm.ra || m.vb0 != g->Tm.vb0 || strcmp(m.name, g->Tm.name) != 0;
  g->Tm = m; g->K.T = &g->Tm;
  return neu;
}

static void glow_setzen(AwFx *fx, const AwWert *w, int n) {
  Glow *g = (Glow *)fx;
  Werte *z = &g->ziel;
  double v;
  if (wert_zahl(w, n, "drive", &v)) z->drive = klemmen(v, 0.1, 160);
  if (wert_zahl(w, n, "bias", &v)) z->bias = klemmen(v, -0.6, 0.6);
  if (wert_zahl(w, n, "ton", &v)) z->ton = klemmen(v, 0, 1);
  if (wert_zahl(w, n, "mix", &v)) z->mix = klemmen(v, 0, 1);
  if (wert_zahl(w, n, "auto", &v)) z->auto_ = v != 0;
  if (wert_zahl(w, n, "vert", &v)) z->vert = klemmen(v, 0, 1);
  if (wert_zahl(w, n, "hq", &v)) z->hq = v != 0;
  if (wert_zahl(w, n, "gegentakt", &v)) z->pp = v != 0;
  if (wert_zahl(w, n, "symm", &v)) z->symm = klemmen(v, 0, 1);
  if (wert_zahl(w, n, "q", &v)) { z->hq = v >= 1; z->ultra = v >= 2; }
  const char *tx;
  if ((tx = wert_text(w, n, "stufen"))) z->kf = !strcmp(tx, "kathodenfolger");
  if ((tx = wert_text(w, n, "anodenlast"))) z->last = !strcmp(tx, "drossel") ? 1 : !strcmp(tx, "uebertrager") ? 2 : 0;
  if ((tx = wert_text(w, n, "erholung"))) z->erholung = !strcmp(tx, "kurz") ? 0 : !strcmp(tx, "lang") ? 2 : 1;
  if (wert_zahl(w, n, "alter", &v)) z->alter = klemmen(v, 0, 1);
  if (wert_zahl(w, n, "ausgangsuebertrager", &v)) z->ot = v != 0;
  for (int i = 0; i < 2; i++) {
    g->tol_bias[i] = exemplar_faktor(fx->exemplar, 20 + i, g->tol_basis[0][i], 0.03);
    g->tol_drive[i] = exemplar_faktor(fx->exemplar, 22 + i, g->tol_basis[1][i], 0.035);
    g->tol_ton[i] = exemplar_faktor(fx->exemplar, 24 + i, g->tol_basis[2][i], 0.04);
    g->tol_vb[i] = exemplar_faktor(fx->exemplar, 26 + i, g->tol_basis[3][i], 0.02);
  }
  const char *rt = wert_text(w, n, "roehre");
  int stufen_neu = 0;
  if (rt && roehre_suchen(rt) && roehre_suchen(rt) != g->T) { g->T = roehre_suchen(rt); stufen_neu = 1; }
  z->rk = rk_aus_bias(g->T, z->bias);
  if (tm_bauen(g, z)) { g->n_cache = 0; stufen_neu = 1; }
  if (stufen_neu) for (int c = 0; c < 8; c++) if (g->kanal[c]) kanal_stufen(g, g->kanal[c], c);
  g->K.cc = !z->ultra ? S_CC : z->erholung == 0 ? 100e-9 : z->erholung == 2 ? 1e-6 : S_CC;
  g->K.tol = z->ultra ? 0.002 : 0.03; g->K.iter = z->ultra ? 12 : 8;
  const Roehre *T = &g->Tm;
  Kurve kz = kurve_von(g, z);
  g->ausgleich = z->auto_ ? statischer_ausgleich(&kz, z->drive, z->bias) : 1;
  z->s_boost = seiten_boost(z->vert);
  g->ausgleich_s = z->auto_ ? statischer_ausgleich(&kz, z->drive * z->s_boost, z->bias) : 1;
  Ruhe rp = glow_ruhe(g, z->rk, T->vb0);
  double dr = z->auto_ ? z->drive * T->v_voll : T->v_voll;
  if (z->ultra && z->kf) { Kf k0; double rq = kf_rq(g, &rp), vb = g->T->vb0; kf_ruhe(&g->K, &k0, rp.Vp, vb, rq); z->kf_gain = kf_gain_von(&g->K, &k0, rp.Vp, vb, rq); } else z->kf_gain = 1;   /* echte Versorgung, nicht die für die Drossel-Lastgerade angehobene */
  double pg = (z->pp ? 0.5 * (1 + z->symm) : 1) * z->kf_gain;   /* Gegentakt: ½·(1 + m); Kathodenfolger ≈ 0,95 */
  g->hq_ausgleich = 1 / (rp.gain * dr * pg);
  g->hq_ausgleich_s = 1 / (rp.gain * dr * pg * (z->auto_ ? z->s_boost : 1));
  double t = z->ton;
  double fc = 20000 * pow(6000.0 / 20000.0, t);
  double k = 1 - exp(-2 * M_PI * min_d(fc, g->fx.sr * 0.45) / g->fx.sr);
  g->ton_k = t >= 0.1 ? k : 1 + (k - 1) * (t / 0.1);
  z->ton_k = g->ton_k;
  g->fx.initial = 1;
  g->fx.latenz = g->verz + (z->hq ? g->hb_verz : 0);
  if (!g->fx.gestartet) {
    // wie processorOptions im Konstruktor: Startwerte ohne Gleiten
    g->ist = g->ziel;
    g->ist.ausgleich = g->ausgleich; g->ist.ausgleich_s = g->ausgleich_s; g->ist.hq_ausgleich = g->hq_ausgleich; g->ist.hq_ausgleich_s = g->hq_ausgleich_s;
  }
}

static void kanal_stufen(Glow *g, Kanal *z, int c) {
  int t = c & 1;
  Ruhe r1 = glow_ruhe(g, g->ziel.rk * g->tol_bias[t], g->Tm.vb0 * g->tol_vb[t]);
  Ruhe rr[2] = { r1, r1 };
  for (int i = 0; i < 2; i++) { Ruhe *p = &rr[i]; Stufe *s = &z->st[i]; s->Vk = p->Vk; s->Vp = p->Vp; s->Vp_alt = p->Vp; s->Vc = -p->Vg; s->Vb = p->Vb; s->Vg = p->Vg; s->vpq = p->Vp; }
  kf_ruhe(&g->K, &z->kf, r1.Vp, g->T->vb0 * g->tol_vb[t], kf_rq(g, &r1));
}

static Kanal *glow_kanal(Glow *g, int c) {
  if (g->kanal[c]) return g->kanal[c];
  Kanal *z = calloc(1, sizeof *z);
  z->hoch = calloc((size_t)g->ph * 2, sizeof(double));
  z->runter = calloc((size_t)g->taps * 2, sizeof(double));
  z->trocken = calloc((size_t)g->trocken_l, sizeof(double));
  z->delta_runter = calloc((size_t)g->taps * 2, sizeof(double));
  kanal_stufen(g, z, c);
  g->kanal[c] = z;
  return z;
}

/** Ausgangsübertrager (Ultra): Kern wie bei Iron, explizit (Bass-Ecke ≈ 14 Hz, sättigt sanft im Tiefbass), Streuung 28 kHz */
static inline double ausgangsuebertrager(Kanal *z, double v, double wdt, double lpk) {
  const double rho = 0.6, bs2 = 4.0;
  double q = min_d(0.96, z->ot_phi * z->ot_phi / bs2), H = z->ot_phi / (1 - q);
  double y = v - rho * H;
  z->ot_phi += wdt * y;
  z->ot_lp += lpk * (y - z->ot_lp);
  return z->ot_lp;
}

/** ein Takt (8×) der Röhrenstufe */
static double roehren_takt(Kor *K, Stufe *z, double u, double Rk, double Vb0, double dt) {
  double Vg = z->Vg, Vk = z->Vk, Vp = z->Vp, Vb = z->Vb;
  double Vs = u - z->Vc;
  Vg = Vs * (S_RG / (S_RG + S_RS));
  if (Vg - Vk > K->T->vth - 12 * K->T->w) {
    for (int it = 0; it < K->iter / 2; it++) {
      gitterstrom(K, Vg - Vk);
      double f = (Vs - Vg) / S_RS - Vg / S_RG - K->ig;
      double dstep = f / (-1 / S_RS - 1 / S_RG - K->dig);
      Vg -= dstep;
      if (fabs(dstep) < 2e-4) break;
    }
  }
  z->Vc += dt * ((Vs - Vg) / S_RS) / K->cc;
  double Vgk = Vg - Vk;
  double VpNeu = 2 * Vp - z->Vp_alt; z->Vp_alt = Vp; Vp = VpNeu;
  if (Vp < Vk + 1) Vp = Vk + 1; else if (Vp > Vb) Vp = Vb;
  for (int it = 0; it < K->iter; it++) {
    koren_ip(K, Vgk, Vp - Vk);
    double dstep = (Vp - Vb + K->T->ra * K->ip) / (1 + K->T->ra * K->dip);
    Vp -= dstep;
    if (Vp < Vk + 1) Vp = Vk + 1; else if (Vp > Vb) Vp = Vb;
    if (fabs(dstep) < K->tol) break;
  }
  double Ip = (Vb - Vp) / K->T->ra;
  z->Vk = Vk + dt * (Ip - Vk / Rk) / S_CK;
  z->Vb = Vb + dt * ((Vb0 - Vb) / S_RB - Ip) / S_CB;
  z->Vg = Vg; z->Vp = Vp;
  return z->vpq - Vp;
}

static void glow_block(AwFx *fx, const float *const *ein, float *const *aus, int kan, int n) {
  Glow *g = (Glow *)fx;
  if (!fx->initial) glow_setzen(fx, NULL, 0);
  fx->gestartet = 1;
  const double sr = fx->sr;
  const int OS = g->os, TAPS = g->taps, PH = g->ph, VERZ = g->verz, TL = g->trocken_l;
  const float *dzA = delta_verlauf(fx, n);
  const double *HB = g->hb;
  Werte *z0 = &g->ist, *z1 = &g->ziel;
  double drive = z0->drive, dDrive = (z1->drive - z0->drive) / n;
  double bias = z0->bias, dBias = (z1->bias - z0->bias) / n;
  double mix = z0->mix, dMix = (z1->mix - z0->mix) / n;
  double vert = z0->vert, dVert = (z1->vert - z0->vert) / n;
  int ms = kan == 2 && ein && ein[0] && ein[1];
  if (ms) {
    if (g->ms_kap < n) { for (int c = 0; c < 2; c++) { free(g->ms_ein[c]); g->ms_ein[c] = malloc(sizeof(float) * (size_t)n); } g->ms_kap = n; }
    const float *l = ein[0], *r = ein[1];
    float *m = g->ms_ein[0], *sd = g->ms_ein[1];
    for (int i = 0; i < n; i++) { m[i] = (float)(((double)l[i] + r[i]) * 0.5); sd[i] = (float)(((double)l[i] - r[i]) * 0.5); }
  }
  int hq = z1->hq;
  double ausgS = hq ? z0->hq_ausgleich_s : z0->ausgleich_s, dAusgS = ((hq ? g->hq_ausgleich_s : g->ausgleich_s) - ausgS) / n;
  double ausg = hq ? z0->hq_ausgleich : z0->ausgleich, dAusg = ((hq ? g->hq_ausgleich : g->ausgleich) - ausg) / n;
  double boost = z0->s_boost, dBoost = (z1->s_boost - boost) / n;
  double tonK = z0->ton_k, dTon = (z1->ton_k - tonK) / n;
  double rkA = z0->rk, dRk = (z1->rk - rkA) / n;
  const Roehre *T = &g->Tm;
  Kurve kz = kurve_von(g, z1);
  int kf = z1->ultra && z1->kf, ot = z1->ultra && z1->ot;
  double kfRq = kf ? kf_rq(g, NULL) : 0;
  double kfVb = g->T->vb0;   /* Kathodenfolger an der echten Versorgung */
  double otW = 2 * M_PI * 24 / sr, otL = 1 - exp(-2 * M_PI * min_d(28000, sr * 0.45) / sr);
  double s0a = ruhe_s(&kz, z0->bias), s0b = ruhe_s(&kz, z1->bias), dS0 = (s0b - s0a) / n;
  double dcR = 1 - 2 * M_PI * 4 / sr;
  double dt = g->dt_os;
  Faerb *mess = fx->messen ? fx->messer : NULL;
  if (mess) faerb_start(mess, n);
  double slB = steigung_b(&kz, bias);
  // innere Ausgabepuffer (float, wie die Ausgänge im Browser) – nötig, weil Mitte/Seite erst am Ende zurückgerechnet wird
  for (int c = 0; c < kan; c++) {
    const float *x = ms ? g->ms_ein[c] : (ein ? ein[c] : NULL);
    float *y = aus[c];
    if (!x) { memset(y, 0, sizeof(float) * (size_t)n); continue; }
    if (c >= 8) { memset(y, 0, sizeof(float) * (size_t)n); continue; }
    int seite = ms && c == 1;
    Kanal *z = glow_kanal(g, c);
    float *mA = mess ? mess->abw[c & 1] : NULL, *mL = mess ? mess->lin[c & 1] : NULL;
    double *hoch = z->hoch, *runter = z->runter, *trk = z->trocken;
    int hp = z->hoch_pos, rp = z->runter_pos, tp = z->trocken_pos;
    double dcX = z->dc_x, dcY = z->dc_y, ton = z->ton;
    if (hq && c == 0) {
      g->drift_ph1 += 2 * M_PI * n / (sr * 71); g->drift_ph2 += 2 * M_PI * n / (sr * 113);
      g->drift_walk += 0.002 * ((aw_zufall(&fx->zufall) * 2 - 1) - g->drift_walk);
      double w = 0.01 * sin(g->drift_ph1) + 0.005 * sin(g->drift_ph2) + 0.006 * g->drift_walk;
      g->drift_wert[0] = 1 + w; g->drift_wert[1] = 1 - 0.8 * w;
    }
    int t1 = c & 1;
    double dft = hq ? g->drift_wert[t1] : 1;
    double Vb0 = hq ? T->vb0 * g->tol_vb[t1] : T->vb0;
    for (int i = 0; i < n; i++) {
      double vt = vert + dVert * i;
      double dr = (drive + dDrive * i) * (seite ? boost + dBoost * i : 1), bi = bias + dBias * i, tk = tonK + dTon * i, s0 = s0a + dS0 * i;
      double drBasis = dr;
      double Rk = rkA + dRk * i;
      if (hq) {
        dr *= g->tol_drive[t1] * dft * T->v_voll; Rk *= g->tol_bias[t1];
        if (tk < 0.999) tk = 1 - pow(1 - tk, g->tol_ton[t1]);
      }
      double ag = seite ? ausgS + dAusgS * i : ausg + dAusg * i;
      if (hq && z1->auto_) ag /= g->tol_drive[t1];   /* jeder Kanal auf Verstärkung 1 eingemessen: Streuung wirkt im Klirr, nicht im Pegel */
      double mx = (mix + dMix * i) * (!ms ? 1 : seite ? min_d(1, 2 * vt) : min_d(1, 2 * (1 - vt)));
      double ein_i = x[i];
      trk[tp] = ein_i;
      int tq = tp - (hq ? VERZ + g->hb_verz : VERZ); if (tq < 0) tq += TL;
      double trocken = trk[tq]; tp = tp == TL - 1 ? 0 : tp + 1;
      if (hq) {
        for (int sn = 0; sn < (z1->pp ? 2 : 1); sn++) {
          Stufe *sp = &z->st[sn];
          double VgQ = -sp->Vc * (S_RG / (S_RG + S_RS));
          sp->vpq = anode_loesen(&g->K, VgQ - sp->Vk, sp->Vk, sp->Vb, T->ra, sp->vpq);
        }
      }
      hoch[hp] = ein_i; hoch[hp + PH] = ein_i;
      int basis = hp + PH;
      double ausgang = 0, rest_roh = 0;
      for (int k = 0; k < OS; k++) {
        double u = skalar(g->poly + k * PH, hoch + basis - PH + 1, PH);
        u *= OS * dr;
        if (k == 0 && mA) { double uu = hq ? u / T->v_voll : u, lin = slB * uu; mA[i] = (float)((kennlinie(&kz, uu, bi, s0) - lin) * mx); mL[i] = (float)lin; }
        double v;
        if (!hq) {
          double ya = kennlinie_adaa(&kz, &z->adaa, u, bi, s0);
          v = ya + ADAA_BOOST * (ya - z->adaa_y); z->adaa_y = ya;
        } else {
          double *hu = z->hb_u, *hd = z->hb_d;
          const int hl = HB_MITTE + 2;
          int up = z->hb_u_pos; hu[up] = u; z->hb_u_pos = up = up == hl - 1 ? 0 : up + 1;
          int q = up - 1 - HB_MITTE / 2; if (q < 0) q += hl;
          double gerade = hu[q];
          double ungerade = 0;
          for (int ii = 1; ii < HB_L; ii += 2) { int qq = up - 1 - (ii - 1) / 2; if (qq < 0) qq += hl; ungerade += HB[ii] * hu[qq]; }
          ungerade *= 2;
          int dp = z->hb_d_pos;
          double r1 = roehren_takt(&g->K, &z->st[0], gerade, Rk, Vb0, dt);
          if (z1->pp) r1 = 0.5 * (r1 - z1->symm * roehren_takt(&g->K, &z->st[1], -gerade, Rk, Vb0, dt));
          if (kf) r1 = -kf_takt(&g->K, &z->kf, z->st[0].vpq - r1, kfVb * g->tol_vb[t1], kfRq, dt);   /* Anode davor = vpq − r1 */
          hd[dp] = r1; dp = dp == HB_L - 1 ? 0 : dp + 1;
          double sum = 0;
          for (int t = 0; t < HB_L; t++) { int q2 = dp - 1 - t; if (q2 < 0) q2 += HB_L; sum += HB[t] * hd[q2]; }
          double r2 = roehren_takt(&g->K, &z->st[0], ungerade, Rk, Vb0, dt);
          if (z1->pp) r2 = 0.5 * (r2 - z1->symm * roehren_takt(&g->K, &z->st[1], -ungerade, Rk, Vb0, dt));
          if (kf) r2 = -kf_takt(&g->K, &z->kf, z->st[0].vpq - r2, kfVb * g->tol_vb[t1], kfRq, dt);
          hd[dp] = r2; dp = dp == HB_L - 1 ? 0 : dp + 1;
          z->hb_d_pos = dp;
          v = sum;
        }
        if (dzA) {
          double uu = hq ? u / T->v_voll : u, rr = kennlinie(&kz, uu, bi, s0) - slB * uu;
          z->delta_runter[rp] = rr; z->delta_runter[rp + TAPS] = rr;
        }
        runter[rp] = v; runter[rp + TAPS] = v;
        // Abwärtstasten am Takt der Phase 0 (Zeitpunkt n), nicht am letzten Takt des Blocks – sonst käme der nasse Weg
        // (OS−1)/OS Sample zu früh und der Anteil-Regler kämmte die Höhen (−4 dB bei 20 kHz und 50 %)
        if (k == 0) { ausgang = skalar(g->fir_r, runter + rp + 1, TAPS); if (dzA) rest_roh = skalar(g->fir_r, z->delta_runter + rp + 1, TAPS); }
        rp = rp == TAPS - 1 ? 0 : rp + 1;
      }
      hp = hp == PH - 1 ? 0 : hp + 1;
      double v = ausgang * ag;
      if (ot) v = ausgangsuebertrager(z, v, otW, otL);
      double w = v - dcX + dcR * dcY; dcX = v; dcY = w;
      ton += tk * (w - ton);
      double rest = 0;
      if (dzA) {
        double r = rest_roh;
        r /= max_d(1e-6, drBasis * slB);
        double rw = r - z->d_dc_x + dcR * z->d_dc_y; z->d_dc_x = r; z->d_dc_y = rw;
        z->d_ton = z->d_ton + tk * (rw - z->d_ton);
        rest = z->d_ton;
      }
      double normal = trocken + (ton - trocken) * mx;
      y[i] = (float)(dzA ? normal * (1 - dzA[i]) + rest * mx * dzA[i] : normal);
    }
    z->hoch_pos = hp; z->runter_pos = rp; z->trocken_pos = tp; z->dc_x = dcX; z->dc_y = dcY; z->ton = ton;
  }
  if (ms) {
    float *yM = aus[0], *yS = aus[1];
    for (int i = 0; i < n; i++) { double m = yM[i], sd = yS[i]; yM[i] = (float)(m + sd); yS[i] = (float)(m - sd); }
  }
  if (mess) faerb_sammeln(mess, n, ms, sr);
  g->ist = *z1;
  g->ist.ausgleich = g->ausgleich; g->ist.ausgleich_s = g->ausgleich_s; g->ist.hq_ausgleich = g->hq_ausgleich; g->ist.hq_ausgleich_s = g->hq_ausgleich_s;
  g->ist.ton_k = z1->ton_k;
  for (int c = 0; c < 8; c++) if (g->kanal[c] && fabs(g->kanal[c]->ton) < 1e-30) g->kanal[c]->ton = 0;
}

static void glow_frei(AwFx *fx) {
  Glow *g = (Glow *)fx;
  for (int c = 0; c < 8; c++) {
    Kanal *z = g->kanal[c];
    if (!z) continue;
    free(z->hoch); free(z->runter); free(z->trocken); free(z->delta_runter); free(z);
  }
  free(g->ms_ein[0]); free(g->ms_ein[1]);
  free(g->fir); free(g->poly); free(g->fir_r);
  free(g);
}

AwFx *glow_neu(double sr) {
  Glow *g = calloc(1, sizeof *g);
  g->fx.setzen = glow_setzen; g->fx.block = glow_block; g->fx.frei = glow_frei; g->fx.sr = sr;
  g->os = sr >= 150000 ? 1 : sr >= 75000 ? 2 : 4;
  g->taps = g->os == 1 ? 1 : 40 * g->os + 1;
  g->ph = (g->taps + g->os - 1) / g->os;
  g->verz = (g->taps - 1) / g->os;
  g->hb_verz = HB_MITTE / g->os;   /* inneres 2×: zwei Halbband-Filter, 12 Takte bei OS-Rate */
  g->trocken_l = g->verz + g->hb_verz + 1;
  g->fir = fir_entwurf(g->os, g->taps, g->ph, 8);
  g->poly = polyphase(g->fir, g->os, g->ph);
  g->fir_r = rueckwaerts(g->fir, g->taps);
  g->hb = halbband();
  g->T = &ROEHREN[0]; g->Tm = ROEHREN[0]; g->K.T = &g->Tm;
  g->fx.latenz = g->verz;
  g->dt_os = 1 / (sr * g->os * 2);
  double tb[2] = {1.03, 0.975}, td[2] = {1.035, 0.968}, tt[2] = {0.96, 1.04}, tv[2] = {1.02, 0.985};
  for (int i = 0; i < 2; i++) { g->tol_bias[i] = g->tol_basis[0][i] = tb[i]; g->tol_drive[i] = g->tol_basis[1][i] = td[i]; g->tol_ton[i] = g->tol_basis[2][i] = tt[i]; g->tol_vb[i] = g->tol_basis[3][i] = tv[i]; }
  g->Tm = *g->T; g->K.cc = S_CC; g->K.tol = 0.03; g->K.iter = 8;
  g->drift_ph1 = 0.7; g->drift_ph2 = 2.1; g->drift_walk = 0; g->drift_wert[0] = g->drift_wert[1] = 0;
  Werte z = { .drive = 2, .bias = 0.12, .ton = 0.4, .mix = 0.8, .auto_ = 1, .vert = 0.5, .hq = 0, .pp = 0, .symm = 0.9 };
  g->ziel = z;
  return &g->fx;
}
