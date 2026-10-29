// Space-Graph in C (dsp/raumgraph.c) für den Vergleich mit Chromium:
// raum_c <graph.txt> <ir-verzeichnis> <ein.f32 (stereo)> <rate> <ereignisse.txt> <aus.f32 (kanäle verschachtelt)> <kanäle>
// ereignisse.txt: "<sekunde> <knoten> <art> <wert> <tau>"
#include "../aw_dsp.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static char irdir[512];
static float *irs[16][2]; static int ir_k[16], ir_n[16]; static char ir_id[16][64]; static int n_ir;
static void *lesen(const char *d, long *g) { FILE *f = fopen(d, "rb"); if (!f) return NULL; fseek(f, 0, SEEK_END); *g = ftell(f); fseek(f, 0, SEEK_SET); char *p = malloc((size_t)*g + 1); if (fread(p, 1, (size_t)*g, f) != (size_t)*g) exit(3); p[*g] = 0; fclose(f); return p; }
static const float *const *suche(const char *id, int *kan, int *n, void *u) {
  (void)u;
  for (int i = 0; i < n_ir; i++) if (!strcmp(ir_id[i], id)) { *kan = ir_k[i]; *n = ir_n[i]; return (const float *const *)irs[i]; }
  char d[700]; long g; snprintf(d, sizeof d, "%s/%s.f32", irdir, id);
  float *p = lesen(d, &g); if (!p) return NULL;
  int i = n_ir++; snprintf(ir_id[i], 64, "%s", id); ir_k[i] = 2; ir_n[i] = (int)(g / 4 / 2);
  irs[i][0] = p; irs[i][1] = p + ir_n[i];
  *kan = 2; *n = ir_n[i]; return (const float *const *)irs[i];
}
int main(int argc, char **argv) {
  if (argc < 8) return 2;
  long g; char *text = lesen(argv[1], &g); snprintf(irdir, sizeof irdir, "%s", argv[2]);
  float *x = lesen(argv[3], &g); long n = g / 8; double sr = atof(argv[4]);
  int ak = atoi(argv[7]);
  char fehler[200] = "";
  AwRaum *r = aw_raum_neu(text, sr, suche, NULL, fehler, sizeof fehler);
  if (!r) { fprintf(stderr, "Fehler: %s\n", fehler); return 1; }
  if (fehler[0]) fprintf(stderr, "Hinweis: %s\n", fehler);
  long ge; char *ev = lesen(argv[5], &ge);
  double ev_t[256]; int ev_k[256]; char ev_a[256][8]; double ev_w[256], ev_tau[256]; int n_ev = 0;
  for (char *z = ev ? strtok(ev, "\n") : NULL; z && n_ev < 256; z = strtok(NULL, "\n"))
    if (sscanf(z, "%lf %d %7s %lf %lf", &ev_t[n_ev], &ev_k[n_ev], ev_a[n_ev], &ev_w[n_ev], &ev_tau[n_ev]) == 5) n_ev++;
  int L = aw_raum_latenz();
  long gesamt = n + L;
  float *aus = calloc((size_t)gesamt * (size_t)ak, sizeof(float));
  float el[64], er[64], o[8][64]; float *op[8]; for (int c = 0; c < 8; c++) op[c] = o[c];
  int nxt = 0;
  for (long s = 0; s < gesamt; s += 64) {
    // Ereignisse: Zeit der Graph-Uhr = (s - L) / sr (die Uhr läuft um die FIFO-Latenz hinterher)
    // alle Ereignisse vorab (Graph-Uhr beginnt bei 0, Zeiten absolut)
    while (s == 0 && nxt < n_ev) { aw_raum_param(r, ev_k[nxt], ev_a[nxt], ev_w[nxt], ev_t[nxt], ev_tau[nxt]); nxt++; }
    int m = gesamt - s < 64 ? (int)(gesamt - s) : 64;
    for (int i = 0; i < m; i++) { el[i] = s + i < n ? x[2 * (s + i)] : 0; er[i] = s + i < n ? x[2 * (s + i) + 1] : 0; }
    const float *e[2] = { el, er };
    aw_raum_block(r, e, 2, op, m);
    for (int i = 0; i < m; i++) for (int c = 0; c < ak; c++) aus[(s + i) * ak + c] = o[c][i];
  }
  FILE *f = fopen(argv[6], "wb"); fwrite(aus + (size_t)L * ak, sizeof(float), (size_t)n * ak, f); fclose(f);
  aw_raum_frei(r);
  return 0;
}
