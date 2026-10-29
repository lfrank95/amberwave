// Rechenzeit je Gerät: 20 s Stereo-Rauschen in 128er-Blöcken, Ergebnis als Anteil an Echtzeit (1 % = 100× schneller als nötig)
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include "../aw_dsp.h"
static double jetzt(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec * 1e-9; }
int main(void) {
  const char *arten[] = { "eq", "glow", "iron", "silk" };
  double raten[] = { 44100, 96000, 192000 };
  for (int hq = 0; hq < 2; hq++)
    for (int a = 0; a < 4; a++) {
      if (hq && a == 0) continue;
      printf("%-4s %-3s", arten[a], hq ? "HQ" : "std");
      for (int r = 0; r < 3; r++) {
        double sr = raten[r];
        AwFx *fx = aw_fx_neu(arten[a], sr, 1);
        double k[10] = { 1.02, -1.9, 0.89, -1.9, 0.91, 0.98, -1.5, 0.6, -1.5, 0.58 };
        AwWert w[4] = { { "drive", 4, 0, 0, 0 }, { "hq", hq, 0, 0, 0 }, { "mix", 1, 0, 0, 0 }, { "k", 0, 0, k, 10 } };
        aw_fx_setzen(fx, w, 4);
        float l[128], rr[128];
        const float *ein[2] = { l, rr }; float *aus[2] = { l, rr };
        uint32_t s = 7;
        long bloecke = (long)(20 * sr / 128);
        double t0 = jetzt();
        for (long b = 0; b < bloecke; b++) {
          for (int i = 0; i < 128; i++) { l[i] = (float)(aw_zufall(&s) - 0.5); rr[i] = (float)(aw_zufall(&s) - 0.5); }
          aw_fx_block(fx, ein, aus, 2, 128);
        }
        double t = jetzt() - t0;
        printf("  %6.0f Hz: %5.2f %%", sr, 100 * t / 20);
        aw_fx_frei(fx);
      }
      printf("\n");
    }
  return 0;
}
