// ASIO-Treiber-Attrappe für die Tests unter Linux: verhält sich wie ein Interface mit 8 Ausgängen (Puffer 256, Takt über
// die Uhr, AW_TEMPO beschleunigt) und schreibt, was der Rückruf liefert, verschachtelt in AW_TESTDATEI.
// AW_TESTASIO=1 schaltet ihn ein, AW_ASIOTYP wählt das Sampleformat (Standard 18 = Int32LSB), AW_ASIORATEN die Raten.
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include "asio.h"
#include "ausgabe_asio.h"

typedef struct {
  IASIO o;
  double rate; long typ, bs; int nk;
  ASIOBufferInfo bi[32];
  ASIOCallbacks cb;
  void *puf[32][2];
  pthread_t th; volatile int laeuft;
  FILE *f;
  // AW_ASIOANLAUF=ms: nach einem Ratenwechsel braucht die „Hardware“ so lange – erste Hälfte keine Rückrufe, zweite Hälfte
  // Rückrufe mit halbem Takt, in der ganzen Zeit kommt nichts am Ausgang an (Wandler stumm); die Rate meldet sie erst nach ¼
  volatile double anlauf_ab, anlauf_s; double rate_alt;
  // AW_ASIOFIFO=frames: interner Puffer hinter den ASIO-Hälften (wie bei USB-Interfaces); bleibt beim Anhalten stehen
  // und kommt beim nächsten Start heraus
  unsigned char *fifo; long fifo_n, fifo_kap, fifo_tief;
  // AW_ASIORESET=ms: wie manche echte Treiber (Focusrite) – so lange nach einem Ratenwechsel verlangt er einen Neustart
  // (kAsioResetRequest) und ruft bis zum Neuanlegen der Puffer nicht mehr zurück. Zeitinfo (Sample-Position) wie echte Treiber.
  volatile int reset_aus; int zeitinfo; long long spos;
} Attrappe;

static void ausgeben(Attrappe *a, unsigned char *z, int b);
/** AW_ASIOVOLL=1: alle Ausgänge des „Interfaces“ in die Datei, jeder Puffer an seinem Ausgang (channelNum) – für Routing-Tests */
static int voll(void) { return getenv("AW_ASIOVOLL") != NULL; }
static long ausgaenge(void) { return getenv("AW_ASIOAUS") ? atol(getenv("AW_ASIOAUS")) : 8; }
static int spalten(Attrappe *a) { return voll() ? (int)ausgaenge() : a->nk; }
static unsigned char *haelfte(Attrappe *a, int h, int b) {
  int sp = spalten(a);
  unsigned char *z = calloc((size_t)a->bs * sp, (size_t)b);
  for (long i = 0; i < a->bs; i++) for (int c = 0; c < a->nk; c++) {
    int ziel = voll() ? (int)a->bi[c].channelNum : c;
    if (ziel < sp) memcpy(z + ((size_t)i * sp + ziel) * b, (unsigned char *)a->bi[c].buffers[h] + (size_t)i * b, (size_t)b);
  }
  return z;
}
static double uhr_m(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return ts.tv_sec + ts.tv_nsec * 1e-9; }

static int tb(long t) { return t == ASIOSTInt16LSB ? 2 : t == ASIOSTInt24LSB ? 3 : t == ASIOSTFloat64LSB ? 8 : 4; }
static void logz(const char *t) { const char *p = getenv("AW_TESTLOG"); if (!p) return; FILE *f = fopen(p, "a"); if (f) { fprintf(f, "%s\n", t); fclose(f); } }

static long qi(IASIO *s, const void *r, void **o) { (void)s; (void)r; (void)o; return -1; }
static unsigned long ar(IASIO *s) { (void)s; return 1; }
static unsigned long rel(IASIO *s) { Attrappe *a = (Attrappe *)s; if (a->f) fclose(a->f); free(a->fifo); free(a); logz("asio frei"); return 0; }
static ASIOBool ini(IASIO *s, void *h) { (void)s; (void)h; return 1; }
static void name(IASIO *s, char *n) { (void)s; strcpy(n, "Testinterface"); }
static long ver(IASIO *s) { (void)s; return 1; }
static void err(IASIO *s, char *t) { (void)s; strcpy(t, ""); }
static void *takt(void *arg) {
  Attrappe *a = arg;
  const char *t = getenv("AW_TEMPO"); double tempo = t ? atof(t) : 1;
  long idx = 0;
  struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
  double naechst = ts.tv_sec + ts.tv_nsec * 1e-9;
  // wie manche echte Treiber: beim Start läuft sofort die eine Hälfte so, wie sie gerade im Puffer steht
  if (a->f && a->nk > 0) {
    int b = tb(a->typ);
    unsigned char *z = haelfte(a, 1, b);
    ausgeben(a, z, b); free(z);
  }
  a->zeitinfo = a->cb.asioMessage && a->cb.asioMessage(kAsioSelectorSupported, kAsioSupportsTimeInfo, NULL, NULL) && a->cb.asioMessage(kAsioSupportsTimeInfo, 0, NULL, NULL);
  while (a->laeuft) {
    if (a->reset_aus) { usleep(2000); clock_gettime(CLOCK_MONOTONIC, &ts); naechst = ts.tv_sec + ts.tv_nsec * 1e-9; continue; }
    double im = uhr_m() - a->anlauf_ab;
    if (a->anlauf_s > 0 && im < a->anlauf_s / 2) { usleep(2000); clock_gettime(CLOCK_MONOTONIC, &ts); naechst = ts.tv_sec + ts.tv_nsec * 1e-9; continue; }
    int stumm = a->anlauf_s > 0 && im < a->anlauf_s;
    if (a->zeitinfo && a->cb.bufferSwitchTimeInfo) {
      ASIOTime zt; memset(&zt, 0, sizeof zt);
      zt.timeInfo.samplePosition.hi = (unsigned long)((unsigned long long)a->spos >> 32); zt.timeInfo.samplePosition.lo = (unsigned long)(a->spos & 0xffffffffULL);
      zt.timeInfo.sampleRate = a->rate; zt.timeInfo.flags = 3;
      a->cb.bufferSwitchTimeInfo(&zt, idx, 1);
    } else a->cb.bufferSwitch(idx, 1);
    a->spos += a->bs;
    if (a->f && !stumm) {
      int b = tb(a->typ);
      unsigned char *z = haelfte(a, (int)idx, b);
      ausgeben(a, z, b); free(z);
    }
    idx ^= 1;
    naechst += a->bs / a->rate / tempo * (stumm ? 2 : 1);
    clock_gettime(CLOCK_MONOTONIC, &ts);
    double jetzt = ts.tv_sec + ts.tv_nsec * 1e-9;
    if (naechst > jetzt) usleep((useconds_t)((naechst - jetzt) * 1e6));
  }
  return NULL;
}
static ASIOError start(IASIO *s) { Attrappe *a = (Attrappe *)s; if (a->laeuft) return ASE_OK; a->laeuft = 1; pthread_create(&a->th, NULL, takt, a); logz("asio start"); return ASE_OK; }
static ASIOError stop(IASIO *s) { Attrappe *a = (Attrappe *)s; if (a->laeuft) { a->laeuft = 0; pthread_join(a->th, NULL); } logz("asio stopp"); return ASE_OK; }
static ASIOError kan(IASIO *s, long *e, long *o) { (void)s; *e = 2; *o = ausgaenge(); return ASE_OK; }
static ASIOError lat(IASIO *s, long *e, long *o) { Attrappe *a = (Attrappe *)s; *e = a->bs; *o = a->bs + a->fifo_tief; return ASE_OK; }

/** gespielte Hälfte (verschachtelt, b Bytes/Sample) durch den internen Puffer an den „Ausgang“ (Datei) */
static void ausgeben(Attrappe *a, unsigned char *z, int b) {
  size_t bpf = (size_t)b * spalten(a);
  if (a->fifo_tief <= 0) { fwrite(z, bpf, (size_t)a->bs, a->f); fflush(a->f); return; }
  if (!a->fifo || a->fifo_kap < a->fifo_tief + a->bs) { a->fifo_kap = a->fifo_tief + a->bs; a->fifo = realloc(a->fifo, (size_t)a->fifo_kap * bpf); }
  memcpy(a->fifo + (size_t)a->fifo_n * bpf, z, (size_t)a->bs * bpf); a->fifo_n += a->bs;
  long raus = a->fifo_n - a->fifo_tief;
  if (raus > 0) {
    fwrite(a->fifo, bpf, (size_t)raus, a->f); fflush(a->f);
    memmove(a->fifo, a->fifo + (size_t)raus * bpf, (size_t)(a->fifo_n - raus) * bpf); a->fifo_n -= raus;
  }
}
static ASIOError bsz(IASIO *s, long *mn, long *mx, long *pr, long *g) { Attrappe *a = (Attrappe *)s; *mn = 64; *mx = 2048; *pr = a->bs; *g = -1; return ASE_OK; }
static ASIOError kann(IASIO *s, ASIOSampleRate r) {
  (void)s; const char *l = getenv("AW_ASIORATEN"); char b[200]; snprintf(b, sizeof b, "%s", l ? l : "44100,48000,88200,96000,176400,192000");
  for (char *t = strtok(b, ","); t; t = strtok(NULL, ",")) if ((int)r == atoi(t)) return ASE_OK;
  return ASE_NoClock;
}
static ASIOError gsr(IASIO *s, ASIOSampleRate *r) {
  Attrappe *a = (Attrappe *)s;
  *r = a->anlauf_s > 0 && uhr_m() - a->anlauf_ab < a->anlauf_s / 4 ? a->rate_alt : a->rate;
  return ASE_OK;
}
static void *reset_spaeter(void *arg) {
  Attrappe *a = arg;
  usleep((useconds_t)(atof(getenv("AW_ASIORESET")) * 1000));
  if (!a->cb.asioMessage) return NULL;
  a->reset_aus = 1; logz("asio reset-wunsch");
  a->cb.asioMessage(kAsioResetRequest, 0, NULL, NULL);
  return NULL;
}
static ASIOError ssr(IASIO *s, ASIOSampleRate r) {
  Attrappe *a = (Attrappe *)s;
  if (kann(s, r) != ASE_OK) return ASE_NoClock;
  const char *an = getenv("AW_ASIOANLAUF");
  if (an) { a->rate_alt = a->rate; a->anlauf_s = atof(an) / 1000.0; a->anlauf_ab = uhr_m(); logz("asio anlauf"); }
  a->rate = r;
  const char *rs = getenv("AW_ASIORESET");
  if (rs) { pthread_t t; pthread_create(&t, NULL, reset_spaeter, a); pthread_detach(t); }
  return ASE_OK;
}
static ASIOError gcs(IASIO *s, ASIOClockSource *c, long *n) { (void)s; (void)c; *n = 0; return ASE_OK; }
static ASIOError scs(IASIO *s, long r) { (void)s; (void)r; return ASE_OK; }
static ASIOError pos(IASIO *s, ASIOSamples *p, ASIOTimeStamp *t) { (void)s; memset(p, 0, sizeof *p); memset(t, 0, sizeof *t); return ASE_OK; }
static ASIOError cinfo(IASIO *s, ASIOChannelInfo *i) { i->type = ((Attrappe *)s)->typ; i->isActive = 0; i->channelGroup = 0; if (i->channel >= ausgaenge()) return ASE_InvalidParameter;
  if (i->channel < 2) snprintf(i->name, sizeof i->name, "Monitor %s", i->channel ? "R" : "L");
  else snprintf(i->name, sizeof i->name, "%s %ld", i->channel < 8 ? "Line" : "ADAT", i->channel + 1);
  return ASE_OK; }
static ASIOError cb(IASIO *s, ASIOBufferInfo *b, long n, long size, ASIOCallbacks *c) {
  Attrappe *a = (Attrappe *)s;
  a->bs = size; a->nk = (int)n; a->cb = *c;
  for (long i = 0; i < n; i++) if (b[i].channelNum >= ausgaenge()) return ASE_InvalidParameter;
  for (long i = 0; i < n; i++) { for (int k = 0; k < 2; k++) b[i].buffers[k] = calloc((size_t)size, (size_t)tb(a->typ)); a->bi[i] = b[i]; }
  const char *d = getenv("AW_TESTDATEI");
  a->f = d ? fopen(d, "ab") : NULL;
  char t[300]; int o = snprintf(t, sizeof t, "asio oeffnen rate=%d kanaele=%ld typ=%ld ausg=", (int)a->rate, n, a->typ);
  for (long i = 0; i < n && o < 280; i++) o += snprintf(t + o, sizeof t - o, "%s%ld", i ? "," : "", b[i].channelNum);
  logz(t);
  return ASE_OK;
}
static ASIOError disp(IASIO *s) { Attrappe *a = (Attrappe *)s; a->reset_aus = 0; for (int i = 0; i < a->nk; i++) for (int k = 0; k < 2; k++) free(a->bi[i].buffers[k]); a->nk = 0; return ASE_OK; }
static ASIOError panel(IASIO *s) { (void)s; logz("asio panel"); return ASE_OK; }
static ASIOError fut(IASIO *s, long sel, void *o) { (void)s; (void)sel; (void)o; return ASE_InvalidParameter; }
static ASIOError ready(IASIO *s) { (void)s; return ASE_OK; }

static const IASIOVtbl VT = { qi, ar, rel, ini, name, ver, err, start, stop, kan, lat, bsz, kann, gsr, ssr, gcs, scs, pos, cinfo, cb, disp, panel, fut, ready };

int asio_treiber_liste(char ids[][80], char namen[][128], int max) {
  if (!getenv("AW_TESTASIO") || max < 1) return 0;
  strcpy(ids[0], "{TEST-ASIO}"); strcpy(namen[0], "Testinterface");
  return 1;
}

IASIO *asio_treiber_laden(const char *id, char *fehler, size_t fn) {
  if (strcmp(id, "{TEST-ASIO}")) { snprintf(fehler, fn, "ASIO-Treiber nicht gefunden"); return NULL; }
  Attrappe *a = calloc(1, sizeof *a);
  a->o.lpVtbl = &VT; a->rate = 48000; a->bs = 256;
  a->fifo_tief = getenv("AW_ASIOFIFO") ? atol(getenv("AW_ASIOFIFO")) : 0;
  a->typ = getenv("AW_ASIOTYP") ? atol(getenv("AW_ASIOTYP")) : ASIOSTInt32LSB;
  return &a->o;
}
