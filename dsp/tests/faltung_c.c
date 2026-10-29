// faltung_c <ir.f32 (2 Kan., verschachtelt)> <ein.f32 (2 Kan.)> <ein_kan> <aus.f32 (2 Kan.)>
#include "../aw_dsp.h"
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
static float *lesen(const char *d, long *n) { FILE *f = fopen(d, "rb"); fseek(f, 0, SEEK_END); long g = ftell(f); fseek(f, 0, SEEK_SET); float *p = malloc((size_t)g); if (fread(p, 1, (size_t)g, f) != (size_t)g) exit(3); fclose(f); *n = g / 4; return p; }
int main(int argc, char **argv) {
  long ni, nx; float *ir = lesen(argv[1], &ni), *x = lesen(argv[2], &nx);
  int ek = atoi(argv[3]); ni /= 2; nx /= 2;
  float *irk[2] = { malloc(sizeof(float) * (size_t)ni), malloc(sizeof(float) * (size_t)ni) };
  for (long i = 0; i < ni; i++) { irk[0][i] = ir[2 * i]; irk[1][i] = ir[2 * i + 1]; }
  AwFaltung *f = aw_faltung_neu((const float *const *)irk, 2, (int)ni, ek);
  long n = (nx + 127) / 128 * 128;
  float *a = calloc((size_t)n * 2, sizeof(float));
  float el[128], er[128], al[128], ar[128]; const float *e[2] = { el, er }; float *o[2] = { al, ar };
  clock_t t0 = clock();
  for (long b = 0; b < n; b += 128) {
    for (int i = 0; i < 128; i++) { el[i] = b + i < nx ? x[2 * (b + i)] : 0; er[i] = b + i < nx ? x[2 * (b + i) + 1] : 0; }
    aw_faltung_block(f, e, o, 128);
    for (int i = 0; i < 128; i++) { a[2 * (b + i)] = al[i]; a[2 * (b + i) + 1] = ar[i]; }
  }
  fprintf(stderr, "%.3f s\n", (double)(clock() - t0) / CLOCKS_PER_SEC);
  FILE *fo = fopen(argv[4], "wb"); fwrite(a, sizeof(float), (size_t)nx * 2, fo); fclose(fo);
  return 0;
}
