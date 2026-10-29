// Klangkette der Engine: Glow, Iron, Silk und EQ aus dem C-Kern (../../dsp) in frei wählbarer Reihenfolge, wie das Rack der
// Web-App. Umbauen (Ein/Aus, Reihenfolge, alles umgehen) blendet die alte Kette in 60 ms gleichleistend in die neue über.
// Dazu die Abgriffe für Meter und Analyzer (Eingang, vor/nach EQ, Messpunkt hinter Kette und Angleich) – als 16-Bit-PCM,
// nur solange die Web-App sie anfordert (Rack oder Analyse offen).
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "klang.h"
#include "vstanbindung.h"
#include "../../dsp/aw_dsp.h"
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

void melden(const char *fmt, ...);

#define MAX_K 8
#define BLOCK 128
/* Stufen: 0–3 eingebaut (Glow, Iron, Silk, EQ), 4–11 = VST3-Plug-in-Slots „vst0“ … „vst7“ */
#define N_ART 4
#define MAX_ST (N_ART + VST_SLOTS)
static const char *ARTEN[4] = { "glow", "iron", "silk", "eq" };

/* ---------- gespeicherte Werte je Gerät (wie die letzte Nachricht ans Worklet, zusammengeführt) ---------- */

typedef struct { char name[32]; int typ; double zahl; char text[32]; double *liste; int n; } Wert;   /* typ 0 Zahl, 1 Text, 2 Liste */
typedef struct { Wert w[96]; int n; } Werte;
static Werte werte[4];

static int art_index(const char *a) {
  for (int i = 0; i < 4; i++) if (!strcmp(ARTEN[i], a)) return i;
  if (!strncmp(a, "vst", 3) && a[3] >= '0' && a[3] < '0' + VST_SLOTS && !a[4]) return N_ART + (a[3] - '0');
  return -1;
}
/* Werte gibt es nur für die eingebauten Stufen (VST-Slots speichern ihren Zustand im Host) */
static int art_wert_index(const char *a) { int i = art_index(a); return i >= 0 && i < N_ART ? i : -1; }

static void wert_setzen(Werte *ws, const AwWert *w) {
  Wert *z = NULL;
  for (int i = 0; i < ws->n; i++) if (!strcmp(ws->w[i].name, w->name)) { z = &ws->w[i]; break; }
  if (!z) { if (ws->n >= 96) return; z = &ws->w[ws->n++]; memset(z, 0, sizeof *z); snprintf(z->name, sizeof z->name, "%s", w->name); }
  free(z->liste); z->liste = NULL; z->n = 0;
  if (w->liste) { z->typ = 2; z->liste = malloc(sizeof(double) * (size_t)(w->liste_n ? w->liste_n : 1)); memcpy(z->liste, w->liste, sizeof(double) * (size_t)w->liste_n); z->n = w->liste_n; }
  else if (w->text) { z->typ = 1; snprintf(z->text, sizeof z->text, "%s", w->text); }
  else { z->typ = 0; z->zahl = w->zahl; }
}

/** gespeicherte Werte als AwWert-Liste für ein Gerät bei Abtastrate sr (EQ: Koeffizienten zur Rate) */
static int werte_fuer(int art, double sr, AwWert *aus, int max) {
  Werte *ws = &werte[art];
  int n = 0;
  if (art == 3) {
    // EQ: "k@48000" / "gain@48000" – die zur Rate passenden (sonst die nächstgelegene)
    double best = -1; const Wert *k = NULL, *g = NULL;
    for (int i = 0; i < ws->n; i++) {
      const Wert *w = &ws->w[i];
      if (strncmp(w->name, "k@", 2)) continue;
      double r = atof(w->name + 2), d = fabs(r - sr);
      if (best < 0 || d < best) { best = d; k = w; }
    }
    if (k) {
      char gn[32]; snprintf(gn, sizeof gn, "gain@%s", k->name + 2);
      for (int i = 0; i < ws->n; i++) if (!strcmp(ws->w[i].name, gn)) g = &ws->w[i];
      memset(&aus[n], 0, sizeof aus[n]); aus[n].name = "k"; aus[n].liste = k->liste; aus[n].liste_n = k->n; n++;
      if (g) { memset(&aus[n], 0, sizeof aus[n]); aus[n].name = "gain"; aus[n].zahl = g->zahl; n++; }
    }
    return n;
  }
  for (int i = 0; i < ws->n && n < max; i++) {
    const Wert *w = &ws->w[i];
    memset(&aus[n], 0, sizeof aus[n]);
    aus[n].name = w->name;
    if (w->typ == 1) aus[n].text = w->text;
    else if (w->typ == 2) { aus[n].liste = w->liste; aus[n].liste_n = w->n; }
    else aus[n].zahl = w->zahl;
    n++;
  }
  return n;
}

/* ---------- Ketten ---------- */

typedef struct { int art[MAX_ST]; AwFx *fx[MAX_ST]; int n; } Kette;

static pthread_mutex_t K = PTHREAD_MUTEX_INITIALIZER;
static Kette *aktiv_k, *alt_k;
static int blende, blende_n;             /* Überblendung alt → aktiv: Position / Länge in Frames */
static char reihe[MAX_ST] = { 0, 1, 2, 3 };   /* Reihenfolge aller Stufen (für den Platz der EQ-Abgriffe) */
static int nreihe = 4;
static int stufe_an[MAX_ST];
static int delta_art = -1, messen_an;
static double rate;
static int kanaele;
static uint32_t saat = 1;
static float *alt_puf[MAX_K];
static float scratch[MAX_K][BLOCK];

/* Abgriffe */
enum { AB_EINGANG = 1, AB_EQ = 2, AB_MESS = 4 };
static int abgriffe;
typedef struct { const char *name; int kan; int16_t *puf; int n, kap; } Abgriff;
static Abgriff ab_ein = { "eingang", 2, 0, 0, 0 }, ab_vor = { "eqvor", 1, 0, 0, 0 }, ab_nach = { "eqnach", 1, 0, 0, 0 }, ab_mess = { "mess", 2, 0, 0, 0 };

/* ---------- Space: Graph aus der Web-App (raumgraph.c), Impulsantworten ---------- */

typedef struct { char id[64]; int kan, n; double rate; float *d[2]; } Ir;
#define MAX_IR 6
static Ir irs[MAX_IR]; static int ir_naechst;
static AwRaum *raum;                 /* läuft (unter K) */
static int raum_kan;                 /* Ausgangskanäle, die der Graph braucht (Layout); 0 = kein Space */

static const float *const *ir_suche(const char *id, int *kan, int *n, void *u) {
  (void)u;
  for (int i = 0; i < MAX_IR; i++) if (irs[i].d[0] && !strcmp(irs[i].id, id)) { *kan = irs[i].kan; *n = irs[i].n; return (const float *const *)irs[i].d; }
  return NULL;
}

static int b64_wert(int c) { return c >= 'A' && c <= 'Z' ? c - 'A' : c >= 'a' && c <= 'z' ? c - 'a' + 26 : c >= '0' && c <= '9' ? c - '0' + 52 : c == '+' ? 62 : c == '/' ? 63 : -1; }
static float *b64_floats(const char *t, int n) {
  float *f = calloc((size_t)n, sizeof(float));
  unsigned char *b = (unsigned char *)f; size_t max = (size_t)n * 4, o = 0;
  unsigned v = 0; int bits = 0;
  for (const char *p = t; *p && o < max; p++) {
    int w = b64_wert((unsigned char)*p); if (w < 0) continue;
    v = v << 6 | (unsigned)w; bits += 6;
    if (bits >= 8) { bits -= 8; b[o++] = (unsigned char)(v >> bits); }
  }
  return f;
}

void klang_raum_ir(const char *id, int kan, int n, double r, const char *d0, const char *d1) {
  if (!id || n <= 0 || !d0) return;
  float *a = b64_floats(d0, n), *b = kan > 1 && d1 ? b64_floats(d1, n) : NULL;
  pthread_mutex_lock(&K);
  int i = ir_naechst; ir_naechst = (ir_naechst + 1) % MAX_IR;
  /* nicht die, die gerade läuft (die Faltung hat ihre Spektren schon – die Daten braucht sie nicht mehr) */
  free(irs[i].d[0]); free(irs[i].d[1]);
  snprintf(irs[i].id, sizeof irs[i].id, "%s", id); irs[i].kan = b ? 2 : 1; irs[i].n = n; irs[i].rate = r; irs[i].d[0] = a; irs[i].d[1] = b;
  pthread_mutex_unlock(&K);
}

void klang_raum(const char *text, double r, int kan) {
  char fehler[200] = "";
  AwRaum *neu = text && *text ? aw_raum_neu(text, r > 0 ? r : (rate ? rate : 48000), ir_suche, NULL, fehler, sizeof fehler) : NULL;
  if (text && *text && !neu) melden("{\"e\":\"fehler\",\"id\":\"\",\"text\":\"Space: %s\"}", fehler);
  else if (fehler[0]) melden("{\"e\":\"hinweis\",\"text\":\"Space: %s\"}", fehler);
  pthread_mutex_lock(&K);
  AwRaum *alt = raum;
  raum = neu;
  raum_kan = neu && !aw_raum_trivial(neu) ? (kan > 0 ? kan : 6) : 0;
  pthread_mutex_unlock(&K);
  aw_raum_frei(alt);
}

void klang_raum_param(int knoten, const char *art, double w, double dt, double tau) {
  pthread_mutex_lock(&K);
  if (raum && art) aw_raum_param(raum, knoten, art, w, dt, tau);
  pthread_mutex_unlock(&K);
}

void klang_raum_nachricht(int knoten, double effekte, double breite) {
  pthread_mutex_lock(&K);
  if (raum) aw_raum_nachricht(raum, knoten, effekte, breite);
  pthread_mutex_unlock(&K);
}

int klang_raum_kanaele(void) {
  pthread_mutex_lock(&K);
  int k = raum_kan;
  pthread_mutex_unlock(&K);
  return k;
}

static Kette *kette_bauen(void) {
  Kette *k = calloc(1, sizeof *k);
  if (!rate) return k;
  for (int i = 0; i < nreihe; i++) {
    int a = reihe[i];
    if (!stufe_an[a]) continue;
    if (a >= N_ART) { k->art[k->n] = a; k->fx[k->n] = NULL; k->n++; continue; }   /* VST-Slot: läuft im Host-Prozess */
    AwFx *fx = aw_fx_neu(ARTEN[a], rate, saat++);
    AwWert w[96]; int n = werte_fuer(a, rate, w, 96);
    aw_fx_setzen(fx, w, n);
    if (a != 3) { if (messen_an) aw_fx_steuern(fx, "messen", 1); if (delta_art == a) aw_fx_steuern(fx, "delta", 1); }
    k->art[k->n] = a; k->fx[k->n] = fx; k->n++;
  }
  return k;
}
static void kette_frei(Kette *k) { if (!k) return; for (int i = 0; i < k->n; i++) if (k->fx[i]) aw_fx_frei(k->fx[i]); free(k); }

static void neu_bauen(int blenden) {
  Kette *neu = kette_bauen();
  if (blenden && aktiv_k && rate) {
    kette_frei(alt_k);
    alt_k = aktiv_k;
    blende = 0; blende_n = (int)(rate * 0.06);
  } else {
    kette_frei(aktiv_k);
    kette_frei(alt_k); alt_k = NULL; blende_n = 0;
  }
  aktiv_k = neu;
}

void klang_fx(const char *art, const AwWert *w, int n) {
  int a = art_wert_index(art);
  if (a < 0) return;
  pthread_mutex_lock(&K);
  for (int i = 0; i < n; i++) wert_setzen(&werte[a], &w[i]);
  // laufende Instanzen: nur die neuen Werte weitergeben (gleiten über den nächsten Block)
  for (Kette *k = aktiv_k; k; k = k == aktiv_k ? alt_k : NULL)
    for (int i = 0; i < k->n; i++) if (k->art[i] == a) {
      if (a == 3) { AwWert e[4]; int m = werte_fuer(3, rate, e, 4); aw_fx_setzen(k->fx[i], e, m); }
      else aw_fx_setzen(k->fx[i], w, n);
    }
  pthread_mutex_unlock(&K);
}

void klang_kette(const char *reihe_text, const char *an_text) {
  pthread_mutex_lock(&K);
  char r[MAX_ST]; int nr = 0;
  const char *p = reihe_text ? reihe_text : "";
  while (*p && nr < MAX_ST) {
    char t[8]; int l = 0;
    while (*p && *p != ',' && l < 7) t[l++] = *p++;
    t[l] = 0; if (*p == ',') p++;
    int a = art_index(t);
    if (a >= 0) { int dop = 0; for (int i = 0; i < nr; i++) dop |= r[i] == a; if (!dop) r[nr++] = (char)a; }
  }
  /* eingebaute Stufen, die fehlen, hinten an; VST-Slots nur, wenn genannt */
  for (int a = 0; a < N_ART; a++) { int da = 0; for (int i = 0; i < nr; i++) da |= r[i] == a; if (!da) r[nr++] = (char)a; }
  int an[MAX_ST]; memset(an, 0, sizeof an);
  p = an_text ? an_text : "";
  while (*p) {
    char t[8]; int l = 0;
    while (*p && *p != ',' && l < 7) t[l++] = *p++;
    t[l] = 0; if (*p == ',') p++;
    int a = art_index(t);
    if (a >= 0) an[a] = 1;
  }
  int gleich = nr == nreihe && !memcmp(r, reihe, (size_t)nr);
  for (int a = 0; a < MAX_ST; a++) gleich &= an[a] == stufe_an[a];
  if (!gleich) {
    memcpy(reihe, r, (size_t)nr); nreihe = nr;
    memcpy(stufe_an, an, sizeof an);
    neu_bauen(1);
  }
  pthread_mutex_unlock(&K);
}

/* VST-Slots anbinden/lösen (unter der Sperre der Kette, der Audio-Thread greift darauf zu) */
void klang_vst_an(int slot, const char *shm, const char *ein, const char *aus) { pthread_mutex_lock(&K); vst_an(slot, shm, ein, aus); pthread_mutex_unlock(&K); }
void klang_vst_ab(int slot) { pthread_mutex_lock(&K); vst_ab(slot); pthread_mutex_unlock(&K); }

void klang_delta(const char *art) {
  pthread_mutex_lock(&K);
  delta_art = art ? art_wert_index(art) : -1;
  if (delta_art == 3) delta_art = -1;
  for (Kette *k = aktiv_k; k; k = k == aktiv_k ? alt_k : NULL)
    for (int i = 0; i < k->n; i++) if (k->art[i] < 3) aw_fx_steuern(k->fx[i], "delta", k->art[i] == delta_art);
  pthread_mutex_unlock(&K);
}

void klang_messen(int an) {
  pthread_mutex_lock(&K);
  messen_an = !!an;
  for (Kette *k = aktiv_k; k; k = k == aktiv_k ? alt_k : NULL)
    for (int i = 0; i < k->n; i++) if (k->art[i] < 3) aw_fx_steuern(k->fx[i], "messen", messen_an);
  pthread_mutex_unlock(&K);
}

void klang_abgriffe(const char *liste) {
  pthread_mutex_lock(&K);
  int m = 0;
  if (liste && strstr(liste, "eingang")) m |= AB_EINGANG;
  if (liste && strstr(liste, "eq")) m |= AB_EQ;
  if (liste && strstr(liste, "mess")) m |= AB_MESS;
  abgriffe = m;
  ab_ein.n = ab_vor.n = ab_nach.n = ab_mess.n = 0;
  pthread_mutex_unlock(&K);
}

int klang_aktiv(void) {
  pthread_mutex_lock(&K);
  // Space: ausgeschaltet und ausgeblendet (Gain wieder genau 1) → Graph weg, der bitgenaue Weg darf wieder
  if (raum && aw_raum_trivial(raum) && aw_raum_ruhig(raum)) { aw_raum_frei(raum); raum = NULL; raum_kan = 0; }
  int a = (aktiv_k && aktiv_k->n) || blende_n || raum;
  pthread_mutex_unlock(&K);
  return a;
}
int klang_abgriffe_an(void) { return abgriffe != 0; }

void klang_format(double sr, int kan) {
  pthread_mutex_lock(&K);
  if (sr != rate || kan != kanaele) {
    rate = sr; kanaele = kan;
    neu_bauen(0);
    for (int c = 0; c < MAX_K; c++) { free(alt_puf[c]); alt_puf[c] = calloc(BLOCK, sizeof(float)); }
    ab_ein.n = ab_vor.n = ab_nach.n = ab_mess.n = 0;
  }
  pthread_mutex_unlock(&K);
}

/* ---------- Abgriffe senden ---------- */

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static void abgriff_senden(Abgriff *a) {
  if (!a->n) return;
  size_t bytes = (size_t)a->n * (size_t)a->kan * 2, len = (bytes + 2) / 3 * 4;
  char *t = malloc(len + 1);
  const unsigned char *s = (const unsigned char *)a->puf;
  size_t o = 0;
  for (size_t i = 0; i < bytes; i += 3) {
    unsigned v = (unsigned)s[i] << 16 | (i + 1 < bytes ? (unsigned)s[i + 1] << 8 : 0) | (i + 2 < bytes ? s[i + 2] : 0);
    t[o++] = B64[(v >> 18) & 63]; t[o++] = B64[(v >> 12) & 63];
    t[o++] = i + 1 < bytes ? B64[(v >> 6) & 63] : '=';
    t[o++] = i + 2 < bytes ? B64[v & 63] : '=';
  }
  t[o] = 0;
  melden("{\"e\":\"pcm\",\"t\":\"%s\",\"k\":%d,\"r\":%d,\"d\":\"%s\"}", a->name, a->kan, (int)rate, t);
  free(t);
  a->n = 0;
}

static inline int16_t i16(float x) { float v = x * 32767.0f; return (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : lrintf(v)); }

static void abgriff_rein(Abgriff *a, float *const *x, int kan, int n, int mono) {
  int ak = a->kan;
  /* kap zählt Samples (Frames × Kanäle) – die Kanalzahl kann wechseln (Space) */
  if (a->kap < (a->n + n) * ak) { a->kap = ((a->n + n) * 2 + 1024) * ak; a->puf = realloc(a->puf, sizeof(int16_t) * (size_t)a->kap); }
  int16_t *d = a->puf + (size_t)a->n * ak;
  for (int i = 0; i < n; i++) {
    if (mono) { float s = kan > 1 ? (x[0][i] + x[1][i]) * 0.5f : x[0][i]; d[i] = i16(s); }
    else for (int c = 0; c < ak; c++) d[(size_t)i * ak + c] = i16(x[c < kan ? c : 0][i]);
  }
  a->n += n;
  if (a->n >= (int)(rate / 25)) abgriff_senden(a);
}

/* ---------- Rechnen ---------- */

static void kette_rechnen(Kette *k, float *const *x, int kan, int n, int abgreifen, int alt) {
  // Stufen in Reihenfolge; die EQ-Abgriffe sitzen an seinem Platz, auch wenn er gerade nichts tut
  int j = 0;
  for (int i = 0; i < nreihe; i++) {
    int a = reihe[i];
    if (a == 3 && abgreifen) abgriff_rein(&ab_vor, x, kan, n, 1);
    if (j < k->n && k->art[j] == a) {
      /* VST-Slot: nur in der führenden Kette (in der auslaufenden Kette bleibt das Signal während der Blende unverändert) */
      if (a >= N_ART) { if (!alt) vst_block(a - N_ART, x, kan, n, rate); }
      else aw_fx_block(k->fx[j], (const float *const *)x, x, kan, n);
      if (a < 3) {
        float w[2];
        if (aw_fx_faerbung(k->fx[j], w)) melden("{\"e\":\"faerb\",\"art\":\"%s\",\"w\":[%.6f,%.6f]}", ARTEN[a], w[0], w[1]);
      }
      j++;
    }
    if (a == 3 && abgreifen) abgriff_rein(&ab_nach, x, kan, n, 1);
  }
}

int klang_rechnen(float *const *x, int kan, int n, double *gain_ist, double gain_ziel, double gain_k) {
  pthread_mutex_lock(&K);
  if (kan > MAX_K) kan = MAX_K;
  int ein_kan = kan;
  for (int s = 0; s < n; s += BLOCK) {
    kan = ein_kan;
    int m = n - s < BLOCK ? n - s : BLOCK;
    float *xs[MAX_K];
    for (int c = 0; c < kan; c++) xs[c] = x[c] + s;
    // Reihenfolge: Titel → Lautheits-Angleich (gleitet) → Eingangs-Meter → Kette/Plug-ins → Space → Ausgangs-Meter
    for (int i = 0; i < m; i++) {
      if (*gain_ist != gain_ziel) { *gain_ist += (gain_ziel - *gain_ist) * gain_k; if (fabs(*gain_ist - gain_ziel) < 1e-7) *gain_ist = gain_ziel; }
      float g = (float)*gain_ist;
      if (g != 1.0f) for (int c = 0; c < kan; c++) xs[c][i] *= g;
    }
    if (abgriffe & AB_EINGANG) abgriff_rein(&ab_ein, xs, kan, m, 0);
    if (blende_n && alt_k) {
      // alte Kette parallel weiterrechnen und gleichleistend überblenden
      float *as[MAX_K];
      for (int c = 0; c < kan; c++) { as[c] = scratch[c]; memcpy(as[c], xs[c], sizeof(float) * (size_t)m); }
      kette_rechnen(alt_k, as, kan, m, 0, 1);
      kette_rechnen(aktiv_k, xs, kan, m, (abgriffe & AB_EQ) != 0, 0);
      for (int i = 0; i < m; i++) {
        double t = (double)(blende + i) / blende_n; if (t > 1) t = 1;
        float ga = (float)cos(t * M_PI / 2), gn = (float)sin(t * M_PI / 2);
        for (int c = 0; c < kan; c++) xs[c][i] = as[c][i] * ga + xs[c][i] * gn;
      }
      blende += m;
      if (blende >= blende_n) { kette_frei(alt_k); alt_k = NULL; blende_n = 0; }
    } else if (aktiv_k) kette_rechnen(aktiv_k, xs, kan, m, (abgriffe & AB_EQ) != 0, 0);
    // Space (hinter der Kette); in place, danach ggf. mehr Kanäle
    if (raum) {
      if (aw_raum_trivial(raum)) aw_raum_direkt(raum, xs, kan, m);
      else {
        float *x8[MAX_K];
        for (int c = 0; c < MAX_K; c++) x8[c] = x[c] + s;
        kan = aw_raum_block(raum, (const float *const *)x8, kan, x8, m);
        if (kan > MAX_K) kan = MAX_K;
        for (int c = 0; c < kan; c++) xs[c] = x8[c];
      }
    }
    { int mk = kan > 6 ? 6 : kan; if (mk != ab_mess.kan) { abgriff_senden(&ab_mess); ab_mess.kan = mk; } }
    if (abgriffe & AB_MESS) abgriff_rein(&ab_mess, xs, kan, m, 0);
  }
  pthread_mutex_unlock(&K);
  return kan;
}

/** nur Abgriffe (Kette aus, bitgenauer Weg läuft weiter): Eingang, EQ-Platz (unverändert) und Messpunkt mit Gain */
void klang_nur_abgreifen(float *const *x, int kan, int n, double gain) {
  pthread_mutex_lock(&K);
  if (kan > MAX_K) kan = MAX_K;
  { int mk = kan > 6 ? 6 : kan; if (mk != ab_mess.kan) { abgriff_senden(&ab_mess); ab_mess.kan = mk; } }
  if (abgriffe & AB_EINGANG) {   // Eingangs-Meter hinter dem Angleich (wie in der Kettenreihenfolge)
    for (int s0 = 0; s0 < n; s0 += BLOCK) {
      int m = n - s0 < BLOCK ? n - s0 : BLOCK;
      float *xs[MAX_K];
      for (int c = 0; c < kan; c++) { memcpy(scratch[c], x[c] + s0, sizeof(float) * (size_t)m); if (gain != 1) for (int i = 0; i < m; i++) scratch[c][i] *= (float)gain; xs[c] = scratch[c]; }
      abgriff_rein(&ab_ein, xs, kan, m, 0);
    }
  }
  if (abgriffe & AB_EQ) { abgriff_rein(&ab_vor, x, kan, n, 1); abgriff_rein(&ab_nach, x, kan, n, 1); }
  if (abgriffe & AB_MESS) {
    if (gain != 1) for (int c = 0; c < kan; c++) for (int i = 0; i < n; i++) x[c][i] *= (float)gain;
    abgriff_rein(&ab_mess, x, kan, n, 0);
  }
  pthread_mutex_unlock(&K);
}

void klang_leeren(void) {
  pthread_mutex_lock(&K);
  if (aktiv_k || alt_k) neu_bauen(0);   /* frische Instanzen: Verzögerungen, Filter und Bandlauf ohne Altes */
  pthread_mutex_unlock(&K);
}
