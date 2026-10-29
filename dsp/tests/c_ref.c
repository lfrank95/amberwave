// Gegenstück zu js_ref.mjs mit der C-Bibliothek. c_ref <art> <rate> <kanäle> <ein.f32> <ablauf.txt> <aus.f32> <messung.txt> [seed]
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../aw_dsp.h"

typedef struct { int block; char befehl[16], k[32], w[4096]; } Zeile;

int main(int argc, char **argv) {
  if (argc < 8) return 2;
  const char *art = argv[1];
  double sr = atof(argv[2]);
  int kan = atoi(argv[3]);
  uint32_t seed = argc > 8 ? (uint32_t)strtoul(argv[8], NULL, 10) : 12345u;
  FILE *f = fopen(argv[4], "rb");
  fseek(f, 0, SEEK_END); long bytes = ftell(f); fseek(f, 0, SEEK_SET);
  float *roh = malloc((size_t)bytes); if (fread(roh, 1, (size_t)bytes, f) != (size_t)bytes) return 3; fclose(f);
  long n = bytes / 4 / kan;
  Zeile *z = calloc(4096, sizeof *z); int nz = 0;
  FILE *a = fopen(argv[5], "r"); char buf[8192];
  while (fgets(buf, sizeof buf, a)) {
    if (buf[0] == '#' || buf[0] == '\n') continue;
    if (sscanf(buf, "%d %15s %31s %4095s", &z[nz].block, z[nz].befehl, z[nz].k, z[nz].w) >= 3) nz++;
  }
  fclose(a);
  AwFx *fx = aw_fx_neu(art, sr, seed);
  float *aus = calloc((size_t)(n * kan), sizeof(float));
  enum { B = 128 };
  float ein_b[16][B], aus_b[16][B];
  const float *ein_p[16]; float *aus_p[16];
  for (int c = 0; c < kan; c++) { ein_p[c] = ein_b[c]; aus_p[c] = aus_b[c]; }
  FILE *m = fopen(argv[7], "w");
  AwWert werte[64]; double listen[64][64]; int nw = 0;
  for (long b = 0; b * B < n; b++) {
    // Befehle dieses Blocks: aufeinanderfolgende set-Zeilen werden eine Nachricht (wie im JS-Gegenstück)
    for (int i = 0; i < nz; i++) {
      if (z[i].block != b) continue;
      if (!strcmp(z[i].befehl, "set")) {
        AwWert *w = &werte[nw]; memset(w, 0, sizeof *w);
        w->name = z[i].k;
        char *e; double d = strtod(z[i].w, &e);
        if (strchr(z[i].w, ',')) { int k = 0; char *s = z[i].w; while (*s && k < 64) { listen[nw][k++] = strtod(s, &s); if (*s == ',') s++; } w->liste = listen[nw]; w->liste_n = k; }
        else if (*e == 0 && e != z[i].w) w->zahl = d;
        else w->text = z[i].w;
        nw++;
        if (i + 1 >= nz || z[i + 1].block != b || strcmp(z[i + 1].befehl, "set")) { aw_fx_setzen(fx, werte, nw); nw = 0; }
      } else aw_fx_steuern(fx, z[i].befehl, z[i].k[0] == '1' || !strcmp(z[i].k, "1"));
    }
    int len = n - b * B < B ? (int)(n - b * B) : B;
    for (int c = 0; c < kan; c++) { memset(ein_b[c], 0, sizeof ein_b[c]); for (int i = 0; i < len; i++) ein_b[c][i] = roh[(b * B + i) * kan + c]; }
    aw_fx_block(fx, ein_p, aus_p, kan, B);
    float w[2];
    if (aw_fx_faerbung(fx, w)) fprintf(m, "%ld %.9g %.9g\n", b, w[0], w[1]);
    for (int c = 0; c < kan; c++) for (int i = 0; i < len; i++) aus[(b * B + i) * kan + c] = aus_b[c][i];
  }
  fclose(m);
  FILE *o = fopen(argv[6], "wb"); fwrite(aus, sizeof(float), (size_t)(n * kan), o); fclose(o);
  aw_fx_frei(fx);
  free(roh); free(aus); free(z);
  return 0;
}
