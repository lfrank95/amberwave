// Geräteschicht (siehe geraet.h). Ohne feste Rate: reine Durchreiche. Mit fester Rate: die Engine schreibt in der Rate der
// Quelle (Float, bzw. bei gleicher Rate direkt im Format des Geräts – dann bitgenau), hier wird umgerechnet, ins Format des
// Geräts gewandelt (24/16 Bit mit TPDF-Dither) und über einen eigenen Puffer ans Gerät gegeben.
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "geraet.h"
#include "../../dsp/aw_dsp.h"
#include <stdio.h>
#include <pthread.h>

typedef struct { int64_t src0, dev0; double faktor, verz; } Abschnitt_;

struct Geraet {
  Ausgabe *a;
  AusInfo echt, info;
  int fest, direkt;
  int src_rate, src_bits;
  AwSrc *src;
  int kan, fb_dev, fb_ein;          // Kanäle, Bytes je Sample am Gerät / von der Engine
  unsigned char *fifo; int fifo_kap, fifo_r, fifo_n;   // Frames im Geräteformat
  unsigned char *stage; size_t stage_kap;
  float *pin[8], *pout[8]; int p_kap, po_kap;
  int64_t src_geschrieben, dev_erzeugt;
  Abschnitt_ ab[16]; int n_ab;
  uint32_t zufall;
  int64_t basis;                    // Stand von aus_gespielt, ab dem die laufende Zeitrechnung zählt (Durchlaufen)
};

/** gespielte Geräte-Frames seit Zurücksetzen bzw. weichem Neubeginn */
static int64_t geraet_pos(Geraet *g) { int64_t d = aus_gespielt(g->a) - g->basis; return d > 0 ? d : 0; }

static int fmt_bytes(AusFormat f) { return f == FMT_S16 ? 2 : f == FMT_S24P ? 3 : 4; }
static inline double tpdf(Geraet *g) {
  g->zufall = g->zufall * 1664525u + 1013904223u; double a = (g->zufall >> 8) / 16777216.0;
  g->zufall = g->zufall * 1664525u + 1013904223u; double b = (g->zufall >> 8) / 16777216.0;
  return a - b;
}

static void abschnitt_neu(Geraet *g) {
  if (g->n_ab == 16) { memmove(g->ab, g->ab + 1, sizeof g->ab[0] * 15); g->n_ab = 15; }
  Abschnitt_ *x = &g->ab[g->n_ab++];
  x->src0 = g->src_geschrieben; x->dev0 = g->dev_erzeugt;
  x->faktor = g->src ? (double)g->src_rate / g->echt.rate : 1.0;
  x->verz = g->src ? aw_src_verzoegerung(g->src) : 0;
}

static void info_bauen(Geraet *g) {
  g->info = g->echt;
  g->info.rate = g->src_rate;
  g->info.geraet_rate = g->echt.rate;
  g->info.fmt = g->src ? FMT_F32 : g->echt.fmt;
  g->info.umgerechnet = g->src ? 1 : 0;
  g->info.fmt_geraet = g->echt.fmt;
  g->fb_ein = fmt_bytes(g->info.fmt);
}

static int quelle_setzen(Geraet *g, int rate, int bits) {
  g->src_rate = rate; g->src_bits = bits;
  aw_src_frei(g->src); g->src = NULL;
  if (rate != g->echt.rate) { g->src = aw_src_neu(rate, g->echt.rate, g->kan); if (!g->src) return -1; }
  info_bauen(g);
  abschnitt_neu(g);
  return 0;
}

/** Umrechnungsfilter im Hintergrund vorab rechnen: der Filter für z. B. 44,1 → 96 kHz braucht einige 10 ms – im Audio-Weg wäre das ein Aussetzer */
static void *warm_thread(void *arg) {
  int *p = arg; int fest = p[0];
  for (int i = 1; p[i]; i++) aw_src_vorwaermen(p[i], fest);
  free(p);
  return NULL;
}
static void warm_start(int fest, const int *raten) {
  int n = 0; while (raten[n]) n++;
  int *p = malloc(sizeof(int) * (size_t)(n + 2));
  if (!p) return;
  int k = 1; p[0] = fest;
  for (int i = 0; i < n; i++) if (raten[i] != fest) p[k++] = raten[i];
  p[k] = 0;
  pthread_t t;
  if (pthread_create(&t, NULL, warm_thread, p)) { free(p); return; }
  pthread_detach(t);
}
void ger_vorwaermen(int quellrate, int fest) {
  static int letzt_q, letzt_f;   // nur der Engine-Thread ruft das auf
  if (fest <= 0 || quellrate <= 0 || quellrate == fest || (quellrate == letzt_q && fest == letzt_f)) return;
  letzt_q = quellrate; letzt_f = fest;
  int r[2] = { quellrate, 0 };
  warm_start(fest, r);
}

Geraet *ger_oeffnen(const char *geraet, int exklusiv, int rate, int kanaele, int bits, int fest, AusInfo *info, char *fehler, size_t fn) {
  Geraet *g = calloc(1, sizeof *g);
  g->fest = fest; g->direkt = fest <= 0;
  g->zufall = 0x2545F491u;
  // feste Rate: Gerät in dieser Rate und möglichst hoher Auflösung öffnen
  g->a = aus_oeffnen(geraet, exklusiv, g->direkt ? rate : fest, kanaele, g->direkt ? bits : 32, &g->echt, fehler, fn);
  if (!g->a) { free(g); return NULL; }
  if (g->direkt) { g->info = g->echt; *info = g->info; return g; }
  g->kan = g->echt.kanaele > 8 ? 8 : g->echt.kanaele;
  g->fb_dev = fmt_bytes(g->echt.fmt);
  int ziel = g->echt.puffer_frames * 2; if (ziel < g->echt.rate / 25) ziel = g->echt.rate / 25;
  g->fifo_kap = ziel * 4 + 65536;
  g->fifo = malloc((size_t)g->fifo_kap * (size_t)g->fb_dev * (size_t)g->kan);
  { static const int ueblich[] = { 44100, 48000, 88200, 96000, 176400, 192000, 0 }; warm_start(fest, ueblich); }   // übliche Quellraten vorab
  if (quelle_setzen(g, rate, bits)) { ger_schliessen(g); return NULL; }
  *info = g->info;
  return g;
}

int ger_fest(const Geraet *g) { return g && !g->direkt; }

/** Füllstand, den der eigene Puffer halten soll (Geräte-Frames) */
static int ziel(const Geraet *g) { int z = g->echt.puffer_frames * 2; if (z < g->echt.rate / 25) z = g->echt.rate / 25; return z; }

/** aus dem eigenen Puffer ans Gerät, so viel es nimmt */
static void abgeben(Geraet *g) {
  int rf = aus_frei(g->a);
  if (rf <= 0 || g->fifo_n <= 0) return;
  // WASAPI exklusiv will immer den ganzen Puffer – dann erst, wenn genug da ist
  if (g->echt.exklusiv && !g->echt.asio && g->fifo_n < rf) return;
  int n = g->fifo_n < rf ? g->fifo_n : rf;
  unsigned char *p = aus_puffer(g->a, n);
  if (!p) return;
  size_t bpf = (size_t)g->fb_dev * g->kan;
  for (int i = 0; i < n; ) {
    int st = n - i, bis = g->fifo_kap - g->fifo_r; if (st > bis) st = bis;
    memcpy(p + (size_t)i * bpf, g->fifo + (size_t)g->fifo_r * bpf, (size_t)st * bpf);
    i += st; g->fifo_r = (g->fifo_r + st) % g->fifo_kap;
  }
  g->fifo_n -= n;
  aus_puffer_fertig(g->a, n);
}

/** Geräte-Frames (planar float) gewandelt in den eigenen Puffer */
static void in_fifo_float(Geraet *g, float *const *x, int m) {
  size_t bpf = (size_t)g->fb_dev * g->kan;
  if (m > g->fifo_kap - g->fifo_n) m = g->fifo_kap - g->fifo_n;
  int w = (g->fifo_r + g->fifo_n) % g->fifo_kap;
  for (int i = 0; i < m; i++) {
    unsigned char *d = g->fifo + (size_t)w * bpf;
    for (int c = 0; c < g->kan; c++) {
      double v = x[c][i];
      switch (g->echt.fmt) {
        case FMT_F32: { float f = (float)v; memcpy(d + (size_t)c * 4, &f, 4); break; }
        case FMT_S32: { double q = floor(v * 2147483648.0 + 0.5); int32_t s = q > 2147483647.0 ? 2147483647 : q < -2147483648.0 ? (int32_t)-2147483647 - 1 : (int32_t)q; memcpy(d + (size_t)c * 4, &s, 4); break; }
        case FMT_S32_24: case FMT_S24P: {
          double q = floor(v * 8388608.0 + tpdf(g) + 0.5);
          int32_t s = q > 8388607.0 ? 8388607 : q < -8388608.0 ? -8388608 : (int32_t)q;
          if (g->echt.fmt == FMT_S32_24) { int32_t t = (int32_t)((uint32_t)s << 8); memcpy(d + (size_t)c * 4, &t, 4); }
          else { d[c * 3] = (unsigned char)s; d[c * 3 + 1] = (unsigned char)(s >> 8); d[c * 3 + 2] = (unsigned char)(s >> 16); }
          break;
        }
        case FMT_S16: { double q = floor(v * 32768.0 + tpdf(g) + 0.5); int16_t s = (int16_t)(q > 32767 ? 32767 : q < -32768 ? -32768 : q); memcpy(d + (size_t)c * 2, &s, 2); break; }
      }
    }
    w = w + 1 == g->fifo_kap ? 0 : w + 1;
  }
  g->fifo_n += m; g->dev_erzeugt += m;
}

static void planar_platz(Geraet *g, int n, int m) {
  if (g->p_kap < n) { for (int c = 0; c < 8; c++) { free(g->pin[c]); g->pin[c] = malloc(sizeof(float) * (size_t)n); } g->p_kap = n; }
  if (g->po_kap < m) { for (int c = 0; c < 8; c++) { free(g->pout[c]); g->pout[c] = malloc(sizeof(float) * (size_t)m); } g->po_kap = m; }
}

int ger_nahtlos(Geraet *g, int rate, int bits, AusInfo *info) {
  if (g->direkt) return -1;
  if (g->src) {
    // Nachlauf des alten Filters gehört noch zum alten Titel
    int m = aw_src_aus_max(g->src, aw_src_taps(g->src)) + 8;
    planar_platz(g, 1, m);
    int k = aw_src_nachlauf(g->src, g->pout, m);
    in_fifo_float(g, g->pout, k);
  }
  if (quelle_setzen(g, rate, bits)) return -1;
  *info = g->info;
  return 0;
}

int ger_umstellen(Geraet *g, int rate, int kanaele, int bits, AusInfo *info, char *fehler, size_t fn) {
  if (g->direkt) {
    int r = aus_umstellen(g->a, rate, kanaele, bits, &g->echt, fehler, fn);
    if (!r) { g->info = g->echt; *info = g->info; g->basis = 0; }
    return r;
  }
  // feste Rate: das Gerät bleibt auf ihr, nur Kanäle/Ausgang neu (ASIO) – eigener Puffer und Umrechner frisch
  if (aus_umstellen(g->a, g->fest, kanaele, 32, &g->echt, fehler, fn)) return -1;
  int kan = g->echt.kanaele > 8 ? 8 : g->echt.kanaele;
  g->fb_dev = fmt_bytes(g->echt.fmt);
  int z = ziel(g);
  int kap = z * 4 + 65536;
  if (kan != g->kan || kap != g->fifo_kap) { free(g->fifo); g->fifo_kap = kap; g->fifo = malloc((size_t)kap * (size_t)g->fb_dev * (size_t)kan); }
  g->kan = kan;
  g->fifo_n = 0; g->fifo_r = 0; g->src_geschrieben = 0; g->dev_erzeugt = 0; g->n_ab = 0; g->basis = 0;
  if (quelle_setzen(g, rate, bits)) return -1;
  *info = g->info;
  return 0;
}

int ger_fest_rate(const Geraet *g) { return g && !g->direkt ? g->fest : 0; }
int ger_umleiten(Geraet *g, const char *geraet) { return aus_umleiten(g->a, geraet); }

int ger_warten(Geraet *g, int ms) {
  if (g->direkt) return aus_warten(g->a, ms);
  if (g->fifo_n < ziel(g)) return 1;
  int r = aus_warten(g->a, ms);
  abgeben(g);
  return r;
}

int ger_frei(Geraet *g) {
  if (g->direkt) return aus_frei(g->a);
  abgeben(g);
  int fehlt = ziel(g) - g->fifo_n;
  if (fehlt <= 0) return 0;
  int n = g->src ? aw_src_ein_fuer(g->src, fehlt) : fehlt;
  return n > 0 ? n : 0;
}

void *ger_puffer(Geraet *g, int frames) {
  if (g->direkt) return aus_puffer(g->a, frames);
  size_t b = (size_t)frames * (size_t)g->fb_ein * (size_t)g->kan;
  if (g->stage_kap < b) { free(g->stage); g->stage = malloc(b); g->stage_kap = b; }
  return g->stage;
}

int ger_puffer_fertig(Geraet *g, int n) {
  if (g->direkt) return aus_puffer_fertig(g->a, n);
  if (g->src) {
    int m = aw_src_aus_max(g->src, n) + 8;
    planar_platz(g, n, m);
    const float *s = (const float *)g->stage;
    for (int i = 0; i < n; i++) for (int c = 0; c < g->kan; c++) g->pin[c][i] = s[(size_t)i * g->kan + c];
    int k = aw_src_rechnen(g->src, (const float *const *)g->pin, n, g->pout, m);
    in_fifo_float(g, g->pout, k);
  } else {
    // gleiche Rate: unverändert (bitgenau) in den Puffer
    size_t bpf = (size_t)g->fb_dev * g->kan;
    int m = n; if (m > g->fifo_kap - g->fifo_n) m = g->fifo_kap - g->fifo_n;
    int w = (g->fifo_r + g->fifo_n) % g->fifo_kap;
    for (int i = 0; i < m; ) {
      int st = m - i, bis = g->fifo_kap - w; if (st > bis) st = bis;
      memcpy(g->fifo + (size_t)w * bpf, g->stage + (size_t)i * bpf, (size_t)st * bpf);
      i += st; w = (w + st) % g->fifo_kap;
    }
    g->fifo_n += m; g->dev_erzeugt += m;
  }
  g->src_geschrieben += n;
  abgeben(g);
  return 0;
}

int64_t ger_gespielt(Geraet *g) {
  if (g->direkt) return geraet_pos(g);
  int64_t d = geraet_pos(g);
  int i = g->n_ab - 1;
  while (i > 0 && g->ab[i].dev0 > d) i--;
  const Abschnitt_ *x = &g->ab[i];
  double s = x->src0 + (double)(d - x->dev0) * x->faktor - x->verz;
  if (s < x->src0) s = (double)x->src0;
  int64_t r = (int64_t)s;
  if (r > g->src_geschrieben) r = g->src_geschrieben;
  return r < 0 ? 0 : r;
}

int ger_start(Geraet *g) { return aus_start(g->a); }
int ger_stopp(Geraet *g) { return aus_stopp(g->a); }
int ger_verloren(Geraet *g) { return aus_verloren(g->a); }
int ger_takt(Geraet *g) { return g ? aus_takt(g->a) : -1; }
void ger_protokoll(Geraet *g, char *buf, size_t n) { if (g) aus_protokoll(g->a, buf, n); else snprintf(buf, n, "[]"); }

int ger_ausklingen(Geraet *g, int ms) { return aus_ausklingen(g->a, ms); }
long ger_unterlaeufe(Geraet *g) { return g ? aus_unterlaeufe(g->a) : 0; }
int ger_durchlaufend(Geraet *g) { return g && aus_durchlaufend(g->a); }
void ger_nachlauf(Geraet *g) { if (g) aus_nachlauf(g->a); }

/**
 * Weicher Neubeginn (Titelwechsel/Spulen) bei durchlaufendem Gerät: kurz ausblenden, Rest verwerfen, die Zeitrechnung
 * beginnt neu bei 0 – wie nach ger_zuruecksetzen, nur ohne Anhalten. 0 = gelungen
 */
int ger_weich_neu(Geraet *g, int ms) {
  int64_t ab = aus_weich_leeren(g->a, ms);
  if (ab < 0) return -1;
  g->basis = ab;
  if (!g->direkt) {
    g->fifo_n = 0; g->fifo_r = 0; g->src_geschrieben = 0; g->dev_erzeugt = 0; g->n_ab = 0;
    quelle_setzen(g, g->src_rate, g->src_bits);
  }
  return 0;
}

int ger_zuruecksetzen(Geraet *g) {
  int r = aus_zuruecksetzen(g->a);
  g->basis = 0;
  if (!g->direkt) {
    g->fifo_n = 0; g->fifo_r = 0; g->src_geschrieben = 0; g->dev_erzeugt = 0; g->n_ab = 0;
    quelle_setzen(g, g->src_rate, g->src_bits);   // frischer Filter, ein Abschnitt ab 0
  }
  return r;
}

void ger_schliessen(Geraet *g) {
  if (!g) return;
  aus_schliessen(g->a);
  aw_src_frei(g->src);
  for (int c = 0; c < 8; c++) { free(g->pin[c]); free(g->pout[c]); }
  free(g->fifo); free(g->stage); free(g);
}
