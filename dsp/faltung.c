// Faltung (Hall von Space): partitioniert im Frequenzbereich, ohne zusätzliche Latenz bei 128er-Blöcken (wie ConvolverNode).
// Vier Stufen mit wachsender Blockgröße: 128 für die ersten 1024 Samples der IR, 1024 bis 8192, 8192 bis 32768, danach 32768. Die erste Stufe
// rechnet den laufenden Block sofort; die größeren decken erst spätere Teile der IR ab und dürfen deshalb einen Block
// nachlaufen – so bleibt die Rechenlast gering (auch 3 s IR bei 192 kHz) und es entsteht keine Verzögerung.
// Zwei reelle Signale teilen sich jeweils eine komplexe FFT (Eingang L+iR bzw. Ausgang L+iR).
#include "intern.h"

typedef struct { double re, im; } Kz;

typedef struct {
  int B, M, P;           // Blockgröße, FFT-Länge (2B), Partitionen
  int sofort;            // 1 = Stufe 0: laufender Block zählt mit
  Kz *w;                 // Drehfaktoren (M/2)
  int *rev;
  double *Hr[2], *Hi[2];  // je IR-Kanal: P × (B+1), Real- und Imaginärteil getrennt (vektorisierbar)
  double *Xr[2], *Xi[2];  // Eingangsspektren (Ring aus P Einträgen) je Eingangskanal: P × (B+1)
  double *Yr[2], *Yi[2];  // Summen (B+1)
  int xNeu;              // Index des neuesten Spektrums
  double *ein[2];        // Ring der letzten M Eingangssamples je Kanal
  int einPos;
  double *aus[2];        // Ausgabe des laufenden Blocks (B)
  Kz *tmp;               // M
  long t;                // verarbeitete Samples
} Stufe;

struct AwFaltung {
  int ein_kan, ir_kan;
  int n_st;
  Stufe st[4];
};

static void fft_tab(Stufe *s) {
  int M = s->M, bits = 0; while ((1 << bits) < M) bits++;
  s->rev = malloc(sizeof(int) * (size_t)M);
  for (int i = 0; i < M; i++) { int r = 0; for (int b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); s->rev[i] = r; }
  s->w = malloc(sizeof(Kz) * (size_t)(M / 2));
  for (int i = 0; i < M / 2; i++) { s->w[i].re = cos(2 * M_PI * i / M); s->w[i].im = -sin(2 * M_PI * i / M); }
}

/** komplexe FFT in place (inv: ohne Normierung) */
static void fft(const Stufe *s, Kz *a, int inv) {
  int M = s->M;
  for (int i = 0; i < M; i++) { int j = s->rev[i]; if (j > i) { Kz t = a[i]; a[i] = a[j]; a[j] = t; } }
  for (int size = 2; size <= M; size <<= 1) {
    int half = size >> 1, step = M / size;
    for (int b = 0; b < M; b += size) {
      for (int j = 0; j < half; j++) {
        Kz w = s->w[j * step]; if (inv) w.im = -w.im;
        Kz *x = &a[b + j], *y = &a[b + j + half];
        double tr = y->re * w.re - y->im * w.im, ti = y->re * w.im + y->im * w.re;
        y->re = x->re - tr; y->im = x->im - ti;
        x->re += tr; x->im += ti;
      }
    }
  }
}

/** zwei reelle Folgen (a, b; je M) → ihre halben Spektren (B+1); b == NULL → nur a */
static void spektren(const Stufe *s, const double *a, const double *b, double *Ar, double *Ai, double *Br, double *Bi) {
  int M = s->M, Bn = s->B;
  Kz *z = s->tmp;
  for (int i = 0; i < M; i++) { z[i].re = a[i]; z[i].im = b ? b[i] : 0; }
  fft(s, z, 0);
  if (!b) { for (int k = 0; k <= Bn; k++) { Ar[k] = z[k].re; Ai[k] = z[k].im; } return; }
  for (int k = 0; k <= Bn; k++) {
    Kz p = z[k], q = z[(M - k) % M];   // q* = conj
    Ar[k] = 0.5 * (p.re + q.re); Ai[k] = 0.5 * (p.im - q.im);
    Br[k] = 0.5 * (p.im + q.im); Bi[k] = -0.5 * (p.re - q.re);
  }
}

static void stufe_neu(Stufe *s, int B, int sofort, const float *const *ir, int ir_kan, int von, int bis, int ein_kan) {
  s->B = B; s->M = 2 * B; s->sofort = sofort;
  s->P = (bis - von + B - 1) / B;
  fft_tab(s);
  s->tmp = malloc(sizeof(Kz) * (size_t)s->M);
  double *seg[2] = { calloc((size_t)s->M, sizeof(double)), calloc((size_t)s->M, sizeof(double)) };
  size_t L = (size_t)s->P * (size_t)(B + 1);
  for (int c = 0; c < 2; c++) { s->Hr[c] = calloc(L, sizeof(double)); s->Hi[c] = calloc(L, sizeof(double)); s->Yr[c] = calloc((size_t)B + 1, sizeof(double)); s->Yi[c] = calloc((size_t)B + 1, sizeof(double)); }
  for (int p = 0; p < s->P; p++) {
    for (int c = 0; c < 2; c++) {
      const float *h = ir[c < ir_kan ? c : 0];
      for (int i = 0; i < s->M; i++) { int k = von + p * B + i; seg[c][i] = i < B && k < bis ? h[k] : 0; }
    }
    size_t o = (size_t)p * (B + 1);
    spektren(s, seg[0], seg[1], s->Hr[0] + o, s->Hi[0] + o, s->Hr[1] + o, s->Hi[1] + o);
  }
  free(seg[0]); free(seg[1]);
  for (int c = 0; c < ein_kan; c++) {
    s->Xr[c] = calloc(L, sizeof(double)); s->Xi[c] = calloc(L, sizeof(double));
    s->ein[c] = calloc((size_t)s->M, sizeof(double));
  }
  for (int c = 0; c < 2; c++) s->aus[c] = calloc((size_t)B, sizeof(double));
}

AwFaltung *aw_faltung_neu(const float *const *ir, int ir_kan, int ir_n, int ein_kan) {
  AwFaltung *f = calloc(1, sizeof *f);
  f->ein_kan = ein_kan == 2 ? 2 : 1; f->ir_kan = ir_kan;
  if (ir_n < 1) ir_n = 1;
  int g1 = ir_n < 1024 ? ir_n : 1024, g2 = ir_n < 8192 ? ir_n : 8192, g3 = ir_n < 32768 ? ir_n : 32768;
  stufe_neu(&f->st[f->n_st++], 128, 1, ir, ir_kan, 0, g1, f->ein_kan);
  if (ir_n > 1024) stufe_neu(&f->st[f->n_st++], 1024, 0, ir, ir_kan, 1024, g2, f->ein_kan);
  if (ir_n > 8192) stufe_neu(&f->st[f->n_st++], 8192, 0, ir, ir_kan, 8192, g3, f->ein_kan);
  if (ir_n > 32768) stufe_neu(&f->st[f->n_st++], 32768, 0, ir, ir_kan, 32768, ir_n, f->ein_kan);
  return f;
}

/** neuestes Eingangsspektrum aus den letzten M Samples, dann Y = Σ H·X, zurück in den Zeitbereich (letzte B Samples) */
static void stufe_rechnen(Stufe *s, int ein_kan) {
  int M = s->M, B = s->B, P = s->P;
  s->xNeu = (s->xNeu + 1) % P;
  double *lin[2] = { NULL, NULL };
  static __thread double *puffer; static __thread int puffer_n;
  if (puffer_n < 2 * M) { free(puffer); puffer = malloc(sizeof(double) * 2 * (size_t)M); puffer_n = 2 * M; }
  for (int c = 0; c < ein_kan; c++) {
    lin[c] = puffer + (size_t)c * M;
    for (int i = 0; i < M; i++) lin[c][i] = s->ein[c][(s->einPos + i) % M];
  }
  size_t on = (size_t)s->xNeu * (B + 1);
  if (ein_kan == 2) spektren(s, lin[0], lin[1], s->Xr[0] + on, s->Xi[0] + on, s->Xr[1] + on, s->Xi[1] + on);
  else spektren(s, lin[0], NULL, s->Xr[0] + on, s->Xi[0] + on, NULL, NULL);
  // Summe je Ausgang über die Partitionen
  Kz *z = s->tmp;
  int n1 = B + 1;
  for (int c = 0; c < 2; c++) { memset(s->Yr[c], 0, sizeof(double) * (size_t)n1); memset(s->Yi[c], 0, sizeof(double) * (size_t)n1); }
  for (int c = 0; c < 2; c++) {
    double *restrict yr = s->Yr[c], *restrict yi = s->Yi[c];
    int xc = ein_kan == 2 ? c : 0;
    for (int p = 0; p < P; p++) {
      size_t xo = (size_t)((s->xNeu - p + P) % P) * (size_t)n1, ho = (size_t)p * (size_t)n1;
      const double *restrict xr = s->Xr[xc] + xo, *restrict xi = s->Xi[xc] + xo, *restrict hr = s->Hr[c] + ho, *restrict hi = s->Hi[c] + ho;
      for (int k = 0; k < n1; k++) { yr[k] += hr[k] * xr[k] - hi[k] * xi[k]; yi[k] += hr[k] * xi[k] + hi[k] * xr[k]; }
    }
  }
  // W = Y0 + i·Y1 über das volle Spektrum (Y0, Y1 hermitesch)
  for (int k = 0; k < M; k++) {
    Kz a, b;
    if (k <= B) { a.re = s->Yr[0][k]; a.im = s->Yi[0][k]; b.re = s->Yr[1][k]; b.im = s->Yi[1][k]; }
    else { a.re = s->Yr[0][M - k]; a.im = -s->Yi[0][M - k]; b.re = s->Yr[1][M - k]; b.im = -s->Yi[1][M - k]; }
    z[k].re = a.re - b.im; z[k].im = a.im + b.re;
  }
  fft(s, z, 1);
  double norm = 1.0 / M;
  for (int i = 0; i < B; i++) { s->aus[0][i] = z[B + i].re * norm; s->aus[1][i] = z[B + i].im * norm; }
}

void aw_faltung_block(AwFaltung *f, const float *const *ein, float *const *aus, int n) {
  for (int o = 0; o < n; o += 128) {
    double acc[2][128];
    memset(acc, 0, sizeof acc);
    for (int si = 0; si < f->n_st; si++) {
      Stufe *s = &f->st[si];
      int M = s->M;
      if (s->sofort) {
        // laufenden Block zuerst in den Eingangsring, dann rechnen
        for (int c = 0; c < f->ein_kan; c++) for (int i = 0; i < 128; i++) s->ein[c][(s->einPos + i) % M] = ein[c] ? ein[c][o + i] : 0;
        s->einPos = (s->einPos + 128) % M;
        stufe_rechnen(s, f->ein_kan);
        for (int c = 0; c < 2; c++) for (int i = 0; i < 128; i++) acc[c][i] += s->aus[c][i];
      } else {
        int im = (int)(s->t % s->B);
        if (im == 0) stufe_rechnen(s, f->ein_kan);   // Eingang bis vor diesen Block reicht (die Stufe deckt erst spätere IR-Teile ab)
        for (int c = 0; c < 2; c++) for (int i = 0; i < 128; i++) acc[c][i] += s->aus[c][im + i];
        for (int c = 0; c < f->ein_kan; c++) for (int i = 0; i < 128; i++) s->ein[c][(s->einPos + i) % M] = ein[c] ? ein[c][o + i] : 0;
        s->einPos = (s->einPos + 128) % M;
      }
      s->t += 128;
    }
    for (int c = 0; c < 2; c++) if (aus[c]) for (int i = 0; i < 128; i++) aus[c][o + i] = (float)acc[c][i];
  }
}

void aw_faltung_frei(AwFaltung *f) {
  if (!f) return;
  for (int si = 0; si < f->n_st; si++) {
    Stufe *s = &f->st[si];
    free(s->w); free(s->rev); free(s->tmp);
    for (int c = 0; c < 2; c++) { free(s->Hr[c]); free(s->Hi[c]); free(s->Xr[c]); free(s->Xi[c]); free(s->Yr[c]); free(s->Yi[c]); free(s->ein[c]); free(s->aus[c]); }
  }
  free(f);
}
