/*
 * aw-render – die Klangkette der Engine (Glow, Iron, Silk, EQ, Space) als Werkzeug für den Server.
 *
 *   ffmpeg -i titel.flac -f f32le -ac 2 -ar 96000 - | aw-render 96000 2 24 kette.jsonl [gain_db] > roh.pcm
 *
 * Liest float32 (interleaved) von stdin, rechnet die Kette aus kette.jsonl (dieselben JSON-Zeilen, die die Web-App an die
 * Engine schickt: {"c":"fx",...}, {"c":"kette",...}, {"c":"raum",...}) und schreibt PCM mit 16 oder 24 Bit (TPDF-Dither,
 * little endian, interleaved) nach stdout. Space kann die Kanalzahl ändern (Stereo → 5.1): die tatsächliche Zahl steht
 * nach dem Lesen der Kette in der ersten stderr-Zeile („kanaele N“), der Server schreibt danach den WAV-Kopf.
 * gain_db: Lautheitsangleich vor der Kette (wie in der Engine). Kein Befehl/keine Stufe an → Daten unverändert (bis aufs
 * Quantisieren auf die Zielbreite).
 */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "klang.h"
#include "befehl_lesen.h"

#include <stdarg.h>

#define BLOCK 4096

/** Meldungen der Klangkette (Fehler, Messwerte) – hier nur Fehler/Hinweise nach stderr */
void melden(const char *fmt, ...) {
  if (!strstr(fmt, "fehler") && !strstr(fmt, "hinweis")) return;
  va_list a; va_start(a, fmt); vfprintf(stderr, fmt, a); va_end(a); fputc('\n', stderr);
}

static uint32_t zz = 0x9e3779b9u;
static inline double zufall(void) { zz ^= zz << 13; zz ^= zz >> 17; zz ^= zz << 5; return zz / 4294967296.0; }
static inline double tpdf(void) { return zufall() - zufall(); }

static void befehl(Befehl *b) {
  const char *c = b->c;
  if (!strcmp(c, "fx") && b->art) klang_fx(b->art, b->w, b->nw);
  else if (!strcmp(c, "kette")) klang_kette(b->reihe, b->an_liste);
  else if (!strcmp(c, "raum")) klang_raum(wt(b, "g"), wz(b, "rate", 0), (int)wz(b, "kan", 0));
  else if (!strcmp(c, "raum_ir")) klang_raum_ir(b->id, (int)wz(b, "kan", 2), (int)wz(b, "n", 0), wz(b, "rate", 0), wt(b, "d0"), wt(b, "d1"));
  else if (!strcmp(c, "raum_p")) klang_raum_param((int)wz(b, "k", -1), wt(b, "a"), wz(b, "w", 0), wz(b, "dt", 0), wz(b, "tau", 0));
  else if (!strcmp(c, "raum_m")) klang_raum_nachricht((int)wz(b, "k", -1), wz(b, "effekte", -1), wz(b, "breite", -1));
}

int main(int argc, char **argv) {
  if (argc < 5) { fprintf(stderr, "aufruf: aw-render RATE KANAELE BITS(16|24) KETTE.jsonl [GAIN_DB]\n"); return 2; }
  int rate = atoi(argv[1]), kan = atoi(argv[2]), bits = atoi(argv[3]);
  double gain_db = argc > 5 ? atof(argv[5]) : 0;
  if (rate < 8000 || rate > 768000 || kan < 1 || kan > 8 || (bits != 16 && bits != 24)) { fprintf(stderr, "ungültige Werte\n"); return 2; }
  klang_format(rate, kan);
  FILE *k = fopen(argv[4], "r");
  if (k) {
    char *zeile = NULL; size_t cap = 0; ssize_t n;
    while ((n = getline(&zeile, &cap, k)) > 0) {
      Befehl b;
      if (befehl_lesen(zeile, &b) == 0) befehl(&b);
      befehl_frei(&b);
    }
    free(zeile);
    fclose(k);
  }
  klang_format(rate, kan);   /* nach der Kette noch einmal: Stufen richten sich auf Rate/Kanäle ein */
  int aus_kan = kan, raum = klang_raum_kanaele();
  if (raum > aus_kan) aus_kan = raum;
  fprintf(stderr, "kanaele %d\n", aus_kan);
  fflush(stderr);

  float *ein = malloc(sizeof(float) * BLOCK * (size_t)kan);
  float *planar[8];
  for (int c = 0; c < 8; c++) planar[c] = calloc(BLOCK, sizeof(float));
  unsigned char *aus = malloc((size_t)BLOCK * 8 * 3);
  double gain_ist = pow(10.0, gain_db / 20.0), gain_ziel = gain_ist;
  int aktiv = klang_aktiv() || raum > 0;
  const int B = bits / 8;
  for (;;) {
    size_t frames = fread(ein, sizeof(float) * (size_t)kan, BLOCK, stdin);
    if (!frames) break;
    for (int c = 0; c < kan; c++) for (size_t f = 0; f < frames; f++) planar[c][f] = ein[f * (size_t)kan + (size_t)c];
    int ak = kan;
    if (aktiv) ak = klang_rechnen(planar, kan, (int)frames, &gain_ist, gain_ziel, 1.0 - exp(-1.0 / (0.01 * rate)));
    else if (gain_ziel != 1.0) for (int c = 0; c < kan; c++) for (size_t f = 0; f < frames; f++) planar[c][f] *= (float)gain_ziel;
    for (size_t f = 0; f < frames; f++) {
      for (int c = 0; c < aus_kan; c++) {
        double x = c < ak ? planar[c][f] : 0.0;
        unsigned char *d = aus + (f * (size_t)aus_kan + (size_t)c) * (size_t)B;
        if (B == 3) {
          double v = floor(x * 8388608.0 + tpdf() + 0.5);
          int32_t s = v > 8388607.0 ? 8388607 : v < -8388608.0 ? -8388608 : (int32_t)v;
          d[0] = (unsigned char)s; d[1] = (unsigned char)(s >> 8); d[2] = (unsigned char)(s >> 16);
        } else {
          double v = floor(x * 32768.0 + tpdf() + 0.5);
          int16_t s = (int16_t)(v > 32767.0 ? 32767 : v < -32768.0 ? -32768 : (int)v);
          d[0] = (unsigned char)s; d[1] = (unsigned char)((uint16_t)s >> 8);
        }
      }
    }
    if (fwrite(aus, (size_t)B * (size_t)aus_kan, frames, stdout) != frames) break;   /* Empfänger weg */
  }
  return 0;
}
