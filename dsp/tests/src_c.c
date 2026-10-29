// src_c <ein.f32 mono> <rate_ein> <rate_aus> <aus.f32> [stück]  – rechnet in Stücken (prüft das Streaming)
#include "../aw_dsp.h"
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
int main(int argc, char **argv) {
  FILE *f = fopen(argv[1], "rb"); fseek(f, 0, SEEK_END); long g = ftell(f); fseek(f, 0, SEEK_SET);
  float *x = malloc((size_t)g); if (fread(x, 1, (size_t)g, f) != (size_t)g) return 3; fclose(f);
  long n = g / 4; int re = atoi(argv[2]), ra = atoi(argv[3]); int st = argc > 5 ? atoi(argv[5]) : 1000;
  AwSrc *s = aw_src_neu(re, ra, 1);
  long cap = n * (long)ra / re + 100000; float *y = malloc(sizeof(float) * (size_t)cap); long m = 0;
  clock_t t0 = clock();
  for (long i = 0; i < n; i += st) {
    int k = n - i < st ? (int)(n - i) : st;
    const float *e[1] = { x + i }; float *a[1] = { y + m };
    m += aw_src_rechnen(s, e, k, a, (int)(cap - m));
  }
  float *a[1] = { y + m }; m += aw_src_nachlauf(s, a, (int)(cap - m));
  fprintf(stderr, "%ld %.12f %d %.3f\n", m, aw_src_verzoegerung(s), aw_src_taps(s), (double)(clock() - t0) / CLOCKS_PER_SEC);
  f = fopen(argv[4], "wb"); fwrite(y, sizeof(float), (size_t)m, f); fclose(f);
  return 0;
}
