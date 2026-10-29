// Testgerät für Linux: verhält sich wie ein exklusives Gerät (Puffer 2 × 20 ms, Takt über die Uhr) und schreibt alles,
// was „gespielt“ wird, roh in AW_TESTDATEI. AW_TEMPO beschleunigt die Uhr (z. B. 20 = zwanzigfach), AW_TESTFMT=f32
// erzwingt geteilt/Float, AW_TESTLOG protokolliert Öffnen/Formate.
#include "ausgabe.h"
#include "ausgabe_asio.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

struct Ausgabe {
  AsioAus *asio;        // ASIO-Gerät (alles Weitere dort)
  AusInfo info;
  int bpf, kap;
  unsigned char *puffer;
  int64_t geschrieben, gespielt_basis;
  double start_t, tempo;
  int laeuft;
  FILE *f;
};

static double uhr(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec * 1e-9; }
static void log_(const char *fmt, int a, int b, int c, int d) {
  const char *p = getenv("AW_TESTLOG");
  if (!p) return;
  FILE *f = fopen(p, "a");
  if (!f) return;
  fprintf(f, fmt, a, b, c, d);
  fputc('\n', f);
  fclose(f);
}

void aus_thread_start(void) {}
void aus_thread_ende(void) {}
char *aus_geraete_json(void) {
  size_t kap = 256, len;
  char *o = malloc(kap);
  len = (size_t)snprintf(o, kap, "[{\"id\":\"test\",\"name\":\"Testgerät\",\"standard\":true,\"kanaele\":8}");
  asio_geraete_json(&o, &len, &kap);
  if (len + 2 > kap) { kap = len + 2; o = realloc(o, kap); }
  o[len++] = ']'; o[len] = 0;
  return o;
}

Ausgabe *aus_oeffnen(const char *geraet, int exklusiv, int rate, int kanaele, int bits, AusInfo *info, char *fehler, size_t fn) {
  if (geraet && !strncmp(geraet, "asio:", 5)) {
    (void)exklusiv;
    AsioAus *x = asio_oeffnen(geraet + 5, rate, kanaele, bits, info, fehler, fn);
    if (!x) return NULL;
    Ausgabe *a = calloc(1, sizeof *a); a->asio = x; a->info = *info;
    return a;
  }
  (void)geraet;
  if (getenv("AW_TESTFEHLER")) { snprintf(fehler, fn, "Testfehler"); return NULL; }
  Ausgabe *a = calloc(1, sizeof *a);
  const char *fm = getenv("AW_TESTFMT");
  a->info.rate = rate;
  a->info.geraet_rate = getenv("AW_TESTMIX") ? atoi(getenv("AW_TESTMIX")) : rate;
  a->info.kanaele = kanaele;
  a->info.geraet_kanaele = 8;
  if ((fm && !strcmp(fm, "f32")) || !exklusiv) { a->info.fmt = FMT_F32; a->info.exklusiv = 0; }
  else { a->info.fmt = bits <= 16 ? FMT_S16 : FMT_S32_24; a->info.exklusiv = 1; }
  a->bpf = (a->info.fmt == FMT_S16 ? 2 : 4) * kanaele;
  a->info.puffer_frames = rate / 50;
  a->kap = a->info.puffer_frames * 2;
  snprintf(a->info.geraet, sizeof a->info.geraet, "Testgerät");
  a->puffer = malloc((size_t)a->kap * a->bpf);
  const char *t = getenv("AW_TEMPO");
  a->tempo = t ? atof(t) : 1.0;
  const char *p = getenv("AW_TESTDATEI");
  a->f = p ? fopen(p, "ab") : NULL;
  log_("oeffnen rate=%d kanaele=%d bits=%d fmt=%d", rate, kanaele, bits, a->info.fmt);
  *info = a->info;
  return a;
}

int64_t aus_gespielt(Ausgabe *a) {
  if (a->asio) return asio_gespielt(a->asio);
  int64_t g = a->gespielt_basis;
  if (a->laeuft) g += (int64_t)((uhr() - a->start_t) * a->info.rate * a->tempo);
  return g > a->geschrieben ? a->geschrieben : g;
}
int aus_frei(Ausgabe *a) {
  if (a->asio) return asio_frei(a->asio);
  int64_t im = a->geschrieben - aus_gespielt(a); return a->kap - (int)im; }
int aus_warten(Ausgabe *a, int ms) {
  if (a->asio) return asio_warten(a->asio, ms);
  double bis = uhr() + ms / 1000.0;
  while (uhr() < bis) {
    if (!a->laeuft || aus_frei(a) >= a->info.puffer_frames) return 1;
    usleep(1000);
  }
  return 0;
}
void *aus_puffer(Ausgabe *a, int frames) {
  if (a->asio) return asio_puffer(a->asio, frames);
  return frames <= a->kap ? a->puffer : NULL; }
int aus_puffer_fertig(Ausgabe *a, int frames) {
  if (a->asio) return asio_puffer_fertig(a->asio, frames);
  if (a->f) fwrite(a->puffer, (size_t)a->bpf, (size_t)frames, a->f), fflush(a->f);
  a->geschrieben += frames;
  return 0;
}
int aus_start(Ausgabe *a) {
  if (a->asio) return asio_start(a->asio);
  if (!a->laeuft) { a->laeuft = 1; a->start_t = uhr(); } return 0; }
int aus_stopp(Ausgabe *a) {
  if (a->asio) return asio_stopp(a->asio);
  if (a->laeuft) { a->gespielt_basis = aus_gespielt(a); a->laeuft = 0; } return 0; }
long aus_unterlaeufe(Ausgabe *a) { return a && a->asio ? asio_unterlaeufe(a->asio) : 0; }
int aus_durchlaufend(Ausgabe *a) { return a && a->asio != NULL; }
int64_t aus_weich_leeren(Ausgabe *a, int ms) { return a && a->asio ? asio_weich_leeren(a->asio, ms) : -1; }
int aus_umleiten(Ausgabe *a, const char *geraet) { return a && a->asio && geraet && !strncmp(geraet, "asio:", 5) ? asio_umleiten(a->asio, geraet + 5) : -1; }
int aus_takt(Ausgabe *a) { return a && a->asio ? asio_takt(a->asio) : -1; }
void aus_protokoll(Ausgabe *a, char *buf, size_t n) { if (a && a->asio) asio_protokoll(buf, n); else snprintf(buf, n, "[]"); }
void aus_nachlauf(Ausgabe *a) { if (a && a->asio) asio_nachlauf(a->asio); }
int aus_ausklingen(Ausgabe *a, int ms) {
  if (a && a->asio) return asio_ausklingen(a->asio, ms);
  (void)ms; return 0;   // WASAPI: Geschriebenes liegt schon im Gerät
}
int aus_zuruecksetzen(Ausgabe *a) {
  if (a->asio) return asio_zuruecksetzen(a->asio);
  a->geschrieben = a->gespielt_basis = 0; if (a->laeuft) a->start_t = uhr(); log_("zuruecksetzen", 0, 0, 0, 0); return 0; }
void aus_schliessen(Ausgabe *a) {
  if (a && a->asio) { asio_schliessen(a->asio); free(a); return; }
  if (!a) return;
  if (a->f) fclose(a->f);
  free(a->puffer); free(a); log_("schliessen", 0, 0, 0, 0);
}
int aus_verloren(Ausgabe *a) {
  if (a->asio) return asio_verloren(a->asio);
  (void)a; return 0; }

int aus_umstellen(Ausgabe *a, int rate, int kanaele, int bits, AusInfo *info, char *fehler, size_t fn) {
  if (!a || !a->asio) return -1;
  int r = asio_umstellen(a->asio, rate, kanaele, bits, info, fehler, fn);
  if (!r) a->info = *info;
  return r;
}
