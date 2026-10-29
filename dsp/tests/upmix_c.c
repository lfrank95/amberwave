// Gegenstück zu upmix_ref.mjs: upmix_c <rate> <ein.f32> <aus.f32> <center>
#include "../aw_dsp.h"
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  if (argc < 5) return 2;
  double sr = atof(argv[1]);
  FILE *f = fopen(argv[2], "rb"); fseek(f, 0, SEEK_END); long g = ftell(f); fseek(f, 0, SEEK_SET);
  float *roh = malloc((size_t)g); if (fread(roh, 1, (size_t)g, f) != (size_t)g) return 3; fclose(f);
  long n = g / 8;
  AwUpmix *u = aw_upmix_neu(sr, -8, -5, 0.6, 0.35, atoi(argv[4]));
  float *aus = calloc((size_t)n * 7, sizeof(float));
  float l[128], r[128], o[7][128]; float *op[7]; for (int c = 0; c < 7; c++) op[c] = o[c];
  for (long b = 0; b * 128 < n; b++) {
    if (b == 300) aw_upmix_setzen(u, 1.2, 0.8);
    int len = (int)(n - b * 128 < 128 ? n - b * 128 : 128);
    for (int i = 0; i < 128; i++) { l[i] = i < len ? roh[(b * 128 + i) * 2] : 0; r[i] = i < len ? roh[(b * 128 + i) * 2 + 1] : 0; }
    aw_upmix_block(u, l, r, op, 128);
    for (int c = 0; c < 7; c++) for (int i = 0; i < len; i++) aus[(b * 128 + i) * 7 + c] = o[c][i];
  }
  f = fopen(argv[3], "wb"); fwrite(aus, sizeof(float), (size_t)n * 7, f); fclose(f);
  return 0;
}
