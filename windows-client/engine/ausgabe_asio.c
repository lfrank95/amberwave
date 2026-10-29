// Ausgabe über ASIO. Der Treiber läuft in einem eigenen Thread (unter Windows mit COM als STA – viele Treiber erwarten,
// dass alle Aufrufe aus demselben Thread kommen); die Engine schreibt in einen Ring, der Rückruf des Treibers (bufferSwitch)
// holt daraus und schreibt in die Puffer des Treibers – je Kanal, im Format des Treibers. Die Engine schreibt bereits
// im passenden Format (16/24/32 Bit, Float), so bleibt der Weg bitgenau.
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <errno.h>
#include <math.h>
#include <stdarg.h>
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#else
#include <unistd.h>
#endif
#include "asio.h"
#include "ausgabe_asio.h"

enum { B_NICHTS, B_START, B_STOPP, B_PANEL, B_ENDE, B_UMSTELLEN, B_RESET, B_NAMEN };

struct AsioAus {
  IASIO *drv;
  AusInfo info;
  ASIOSampleType typ;
  int fbytes;                 // Bytes je Sample im Engine-Format
  long bufsize;
  long rueckrufe;             // gezählte bufferSwitch-Aufrufe (für das Ausklingen vor dem Anhalten)
  long latenz;                // vom Treiber gemeldete Ausgabelatenz (Frames)
  long unterlaeufe;           // Rückrufe, in denen die Musik mitten im Puffer ausging (Aussetzer)
  ASIOBufferInfo bi[32];
  int kan;
  int ziel;                   // so viele Frames hält die Engine im Ring (Puffer des Treibers × 3, mindestens 100 ms)
  // Ring (Engine-Format, verschachtelt)
  unsigned char *ring; int kap;     // Frames
  int rpos, n;                      // Lesestelle, Füllstand (Frames)
  unsigned char *stage; int stage_kap;
  int64_t gespielt;
  int laeuft, verloren;
  int kan_ring;               // Kanäle, mit denen der Ring angelegt ist (bleibt über disposeBuffers hinweg)
  pthread_mutex_t m, bm; pthread_cond_t c_daten, c_befehl;   // bm: ein Befehl an den Treiber-Thread zur Zeit
  // Treiber-Thread
  pthread_t th; int befehl, befehl_erg, befehl_fertig;
  int bereit; char fehler[300];
  // Öffnen-Parameter
  char id[80]; int rate, kanaele_wunsch, bits;
  char name[128]; long aus_kan;
  // Ausgang (Bus): Kanal c der Engine → Ausgang karte[c] des Treibers. Ohne Karte: Kanal c → Ausgang c, alle Ausgänge
  int karte[32], n_karte;
  char *namen; size_t namen_n;   // B_NAMEN: Ziel für die Kanalnamen
  volatile int stellt_um;     // eigene Ratenumstellung läuft: Reset-Wünsche des Treibers dabei nicht als Verlust werten
  // Nach einer eigenen Ratenumstellung verlangen viele Treiber (z. B. Focusrite) etwas später noch einen Neustart
  // (kAsioResetRequest) oder melden die neue Rate. Innerhalb dieser Schonfrist gilt das als Teil der Umstellung: Puffer im
  // Treiber-Thread neu anlegen statt das Gerät als verloren zu melden (das hieße Treiber komplett neu laden – Sekunden).
  volatile double schonfrist_bis;
  volatile int reset_wunsch;   // Treiber-Thread soll die Puffer neu anlegen (leichter Neustart)
  int resets_in_frist;         // zweiter Wunsch in derselben Frist: Treiber ganz neu laden (im Thread, Ring bleibt)
  // Takt aus der Zeitinfo des Treibers (Sample-Position gegen unsere Uhr): stimmt er über zwei Fenster, läuft das Gerät
  volatile int takt_gueltig, takt_n; double takt_t0; int64_t takt_p0;
  volatile int erster_rueckruf;
};

/* ---------- Protokoll (für das Nerd-Panel): was der Treiber bei einer Umstellung wann tut ---------- */
static pthread_mutex_t proto_m = PTHREAD_MUTEX_INITIALIZER;
static char proto[3000]; static size_t proto_len; static double proto_t0;
static double uhr(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return ts.tv_sec + ts.tv_nsec * 1e-9; }
static void proto_beginnen(void) { pthread_mutex_lock(&proto_m); proto_len = 0; proto[0] = 0; proto_t0 = uhr(); pthread_mutex_unlock(&proto_m); }
static void proto_text(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void proto_text(const char *fmt, ...) {
  char t[200]; va_list ap; va_start(ap, fmt); vsnprintf(t, sizeof t, fmt, ap); va_end(ap);
  pthread_mutex_lock(&proto_m);
  int ms = (int)((uhr() - proto_t0) * 1000 + 0.5);
  if (proto_len + strlen(t) + 40 < sizeof proto) {
    char e[260]; size_t o = 0;
    o += (size_t)snprintf(e, sizeof e, "%s{\"ms\":%d,\"t\":\"", proto_len ? "," : "", ms);
    for (const char *p = t; *p && o + 3 < sizeof e; p++) { if (*p == '"' || *p == '\\') e[o++] = '\\'; e[o++] = *p; }
    o += (size_t)snprintf(e + o, sizeof e - o, "\"}");
    memcpy(proto + proto_len, e, o); proto_len += o; proto[proto_len] = 0;
  }
  pthread_mutex_unlock(&proto_m);
}
/** Protokoll seit der letzten Umstellung als JSON-Array */
void asio_protokoll(char *buf, size_t n) { pthread_mutex_lock(&proto_m); snprintf(buf, n, "[%s]", proto); pthread_mutex_unlock(&proto_m); }

static AsioAus *aktiv;   // ASIO kennt nur einen Treiber je Programm; die Rückrufe haben keinen Zeiger
static int nachlauf_ms;  // Dauer des letzten Nachlaufs (kommt vor dem Umstellen, steht im Protokoll an erster Stelle)

static void zeit_in(struct timespec *ts, int ms) {
  clock_gettime(CLOCK_REALTIME, ts);
  ts->tv_sec += ms / 1000; ts->tv_nsec += (long)(ms % 1000) * 1000000L;
  if (ts->tv_nsec >= 1000000000L) { ts->tv_sec++; ts->tv_nsec -= 1000000000L; }
}

/**
 * Geräte-ID „{CLSID}#0,1,4,5“ zerlegen: Treiber-ID nach id (ohne Karte), Ausgänge (ab 0) nach karte. Rückgabe: Zahl der
 * Kanäle in der Karte (0 = keine Karte → alle Ausgänge der Reihe nach)
 */
static int karte_lesen(const char *geraet, char *id, size_t idn, int *karte) {
  const char *h = strchr(geraet, '#');
  size_t l = h ? (size_t)(h - geraet) : strlen(geraet);
  if (l >= idn) l = idn - 1;
  memcpy(id, geraet, l); id[l] = 0;
  int n = 0;
  if (h) for (const char *p = h + 1; *p && n < 32; ) {
    char *e; long v = strtol(p, &e, 10);
    if (e == p) break;
    if (v >= 0 && v < 256) karte[n++] = (int)v;
    p = *e == ',' ? e + 1 : e;
    if (e == p) break;
  }
  return n;
}

/** Namen aller Ausgänge des Treibers als JSON-Array (aus getChannelInfo) */
static void namen_json(IASIO *drv, long aus, char *buf, size_t n) {
  size_t o = 0; buf[o++] = '[';
  for (long c = 0; c < aus && c < 256 && o + 300 < n; c++) {
    ASIOChannelInfo ci; memset(&ci, 0, sizeof ci); ci.channel = c; ci.isInput = 0;
    char nm[64] = "";
    if (drv->lpVtbl->getChannelInfo(drv, &ci) == ASE_OK) snprintf(nm, sizeof nm, "%s", ci.name);
    if (!nm[0]) snprintf(nm, sizeof nm, "Ausgang %ld", c + 1);
    if (c) buf[o++] = ',';
    buf[o++] = '"';
    for (const char *p = nm; *p && o + 4 < n; p++) {
      unsigned char z = (unsigned char)*p;
      if (z < 0x20) continue;
      if (z == '"' || z == '\\') buf[o++] = '\\';
      buf[o++] = (char)z;
    }
    buf[o++] = '"';
  }
  buf[o++] = ']'; buf[o] = 0;
}

/* ---------- Format ---------- */

static int format_waehlen(ASIOSampleType t, AusFormat *f, int *bytes) {
  switch (t) {
    case ASIOSTInt16LSB: *f = FMT_S16; *bytes = 2; return 1;
    case ASIOSTInt24LSB: *f = FMT_S24P; *bytes = 3; return 1;
    case ASIOSTInt32LSB: case ASIOSTInt32LSB16: case ASIOSTInt32LSB18: case ASIOSTInt32LSB20: *f = FMT_S32; *bytes = 4; return 1;
    case ASIOSTInt32LSB24: *f = FMT_S32_24; *bytes = 4; return 1;
    case ASIOSTFloat32LSB: case ASIOSTFloat64LSB: *f = FMT_F32; *bytes = 4; return 1;
    default: return 0;
  }
}

/** frames aus dem Ring (ab Frame-Index ri, Kanal c) in den Treiberpuffer d (Format des Treibers) */
static void kanal_kopieren(AsioAus *a, unsigned char *d, int c, int ri, int frames) {
  int fb = a->fbytes, bpf = fb * a->kan;
  for (int i = 0; i < frames; i++) {
    const unsigned char *s = a->ring + (size_t)((ri + i) % a->kap) * bpf + (size_t)c * fb;
    switch (a->typ) {
      case ASIOSTInt16LSB: memcpy(d + i * 2, s, 2); break;
      case ASIOSTInt24LSB: memcpy(d + i * 3, s, 3); break;
      case ASIOSTInt32LSB: case ASIOSTFloat32LSB: memcpy(d + i * 4, s, 4); break;
      case ASIOSTInt32LSB24: case ASIOSTInt32LSB20: case ASIOSTInt32LSB18: case ASIOSTInt32LSB16: {
        int32_t v; memcpy(&v, s, 4);
        int sh = a->typ == ASIOSTInt32LSB24 ? 8 : a->typ == ASIOSTInt32LSB20 ? 12 : a->typ == ASIOSTInt32LSB18 ? 14 : 16;
        v >>= sh; memcpy(d + i * 4, &v, 4); break;
      }
      case ASIOSTFloat64LSB: { float v; memcpy(&v, s, 4); double w = v; memcpy(d + i * 8, &w, 8); break; }
    }
  }
}

static int typ_bytes(ASIOSampleType t) { return t == ASIOSTInt16LSB ? 2 : t == ASIOSTInt24LSB ? 3 : t == ASIOSTFloat64LSB ? 8 : 4; }

/**
 * Beide Hälften der Treiberpuffer mit Stille füllen. Viele Treiber geben beim Start sofort die aktuelle Hälfte aus, noch
 * bevor sie nach Daten fragen – ohne das liefe dort ein Rest vom letzten Mal (oder Zufall nach dem Anlegen): ein kurzes
 * Knacksen am Anfang eines Titels.
 */
static void treiber_puffer_leeren(AsioAus *a) {
  int tb = typ_bytes(a->typ);
  for (int c = 0; c < a->kan; c++)
    for (int h = 0; h < 2; h++)
      if (a->bi[c].buffers[h]) memset(a->bi[c].buffers[h], 0, (size_t)a->bufsize * (size_t)tb);
}

/** ein Sample im Ring (Format der Engine) mit g multiplizieren */
static void sample_skalieren(unsigned char *p, AusFormat f, double g) {
  switch (f) {
    case FMT_S16: { int16_t v; memcpy(&v, p, 2); v = (int16_t)lrint(v * g); memcpy(p, &v, 2); break; }
    case FMT_S24P: { int32_t v = (int32_t)((uint32_t)p[0] << 8 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 24) >> 8; v = (int32_t)lrint(v * g); p[0] = (unsigned char)v; p[1] = (unsigned char)(v >> 8); p[2] = (unsigned char)(v >> 16); break; }
    case FMT_S32: case FMT_S32_24: { int32_t v; memcpy(&v, p, 4); v = (int32_t)llrint(v * g); if (f == FMT_S32_24) v &= ~0xff; memcpy(p, &v, 4); break; }
    default: { float v; memcpy(&v, p, 4); v = (float)(v * g); memcpy(p, &v, 4); break; }
  }
}

/* ---------- Rückrufe des Treibers ---------- */

static void puffer_wechsel(long index, ASIOBool direkt) {
  (void)direkt;
  AsioAus *a = aktiv;
  if (!a) return;
  long bs = a->bufsize;
  if (!a->erster_rueckruf) { a->erster_rueckruf = 1; proto_text("erster Rückruf des Treibers"); }
  pthread_mutex_lock(&a->m);
  int da = a->n < bs ? a->n : (int)bs;
  if (da > 0 && da < bs) a->unterlaeufe++;   // Musik ging mitten im Puffer aus (reine Stille-Rückrufe zählen nicht)
  int tb = typ_bytes(a->typ);
  for (int c = 0; c < a->kan; c++) {
    unsigned char *d = a->bi[c].buffers[index];
    if (!d) continue;
    if (da > 0) kanal_kopieren(a, d, c, a->rpos, da);
    if (da < bs) memset(d + (size_t)da * tb, 0, (size_t)(bs - da) * tb);   // zu wenig da: Stille (zählt nicht als gespielt)
  }
  a->rpos = (a->rpos + da) % a->kap; a->n -= da;
  a->gespielt += da;
  a->rueckrufe++;
  pthread_cond_broadcast(&a->c_daten);
  pthread_mutex_unlock(&a->m);
  a->drv->lpVtbl->outputReady(a->drv);
}

static int in_schonfrist(AsioAus *a) { return a->stellt_um || uhr() < a->schonfrist_bis; }

/** Treiber verlangt einen Neustart: in der Schonfrist leicht (Puffer neu), sonst als verloren melden (Engine öffnet neu) */
static void neustart_wunsch(AsioAus *a, const char *grund) {
  if (in_schonfrist(a)) {
    proto_text("Treiber: %s – Puffer werden neu angelegt", grund);
    if (!a->stellt_um) { a->reset_wunsch = 1; pthread_cond_broadcast(&a->c_befehl); }
    else a->reset_wunsch = 1;   // nach dem Umstellen gleich erledigen
  } else {
    proto_text("Treiber: %s – Gerät wird neu geöffnet", grund);
    a->verloren = 1; pthread_cond_broadcast(&a->c_daten);
  }
}

static void rate_geaendert(ASIOSampleRate r) {
  AsioAus *a = aktiv;
  if (!a) return;
  // die eigene Umstellung kommt hier oft noch einmal an: das ist keine Änderung von außen
  if (in_schonfrist(a) && (int)(r + 0.5) == a->rate) { proto_text("Treiber: Rate %d Hz bestätigt", (int)(r + 0.5)); return; }
  char g[60]; snprintf(g, sizeof g, "Rate auf %d Hz geändert", (int)(r + 0.5));
  neustart_wunsch(a, g);
}

static long nachricht(long sel, long wert, void *msg, double *opt) {
  (void)msg; (void)opt;
  switch (sel) {
    case kAsioSelectorSupported:
      return wert == kAsioResetRequest || wert == kAsioEngineVersion || wert == kAsioResyncRequest || wert == kAsioLatenciesChanged || wert == kAsioBufferSizeChange || wert == kAsioSupportsTimeInfo;
    case kAsioEngineVersion: return 2;
    case kAsioResetRequest: case kAsioBufferSizeChange:
      // Treiber will neu starten (nach eigener Umstellung oft verspätet; sonst Puffergröße/Rate im Treiberfenster geändert)
      if (aktiv) neustart_wunsch(aktiv, sel == kAsioResetRequest ? "Neustart gewünscht" : "Puffergröße geändert");
      return 1;
    case kAsioResyncRequest: if (aktiv) proto_text("Treiber: Neusynchronisation"); return 1;
    case kAsioLatenciesChanged: if (aktiv) proto_text("Treiber: Latenz geändert"); return 1;
    case kAsioSupportsTimeInfo: return 1;   // dann kommt bufferSwitchTimeInfo mit der Sample-Position
    default: return 0;
  }
}

/** Takt prüfen: Sample-Position des Treibers über Fenster von 60 ms gegen unsere Uhr – stimmt sie zweimal auf 2 %, läuft er */
static void takt_messen(AsioAus *a, const ASIOTime *p) {
  if (!p || !(p->timeInfo.flags & 2)) return;   // kSamplePositionValid
  int64_t pos = (int64_t)(((uint64_t)(uint32_t)p->timeInfo.samplePosition.hi << 32) | (uint32_t)p->timeInfo.samplePosition.lo);
  double t = uhr();
  if (!a->takt_gueltig || a->takt_t0 <= 0 || pos < a->takt_p0) { a->takt_t0 = t; a->takt_p0 = pos; a->takt_gueltig = 1; return; }
  double dt = t - a->takt_t0;
  if (dt < 0.06) return;
  const char *e = getenv("AW_TEMPO");
  double soll = a->rate * (e && atof(e) > 1 ? atof(e) : 1);
  double r = (double)(pos - a->takt_p0) / dt;
  double tol = 0.02 + 2.0 * a->bufsize / (dt * soll);   // Körnung: zwei Puffer je Fenster
  if (fabs(r / soll - 1) <= tol) { if (++a->takt_n == 2) proto_text("Takt stabil (%.0f Hz laut Treiber-Position)", r); }
  else a->takt_n = 0;
  a->takt_t0 = t; a->takt_p0 = pos;
}

static ASIOTime *puffer_wechsel_zeit(ASIOTime *p, long index, ASIOBool direkt) {
  if (aktiv) takt_messen(aktiv, p);
  puffer_wechsel(index, direkt);
  return NULL;
}

static void takt_zuruecksetzen(AsioAus *a) { a->takt_gueltig = 0; a->takt_n = 0; a->takt_t0 = 0; a->erster_rueckruf = 0; }

static ASIOCallbacks RUECKRUFE = { puffer_wechsel, rate_geaendert, nachricht, puffer_wechsel_zeit };

/* ---------- Treiber-Thread ---------- */

static int einrichten(AsioAus *a, int behalten);
static int oeffnen_im_thread(AsioAus *a, int behalten) {
  char f[200] = "";
  a->drv = asio_treiber_laden(a->id, f, sizeof f);
  if (!a->drv) { snprintf(a->fehler, sizeof a->fehler, "%s", f[0] ? f : "ASIO-Treiber lässt sich nicht laden"); return 0; }
  const IASIOVtbl *v = a->drv->lpVtbl;
#ifdef _WIN32
  void *fenster = GetDesktopWindow();
#else
  void *fenster = NULL;
#endif
  if (!v->init(a->drv, fenster)) {
    char m[128] = ""; v->getErrorMessage(a->drv, m);
    snprintf(a->fehler, sizeof a->fehler, "ASIO-Treiber startet nicht%s%s", m[0] ? ": " : "", m);
    return 0;
  }
  char *name = a->name; v->getDriverName(a->drv, name);
  long ein = 0, aus = 0;
  if (v->getChannels(a->drv, &ein, &aus) != ASE_OK || aus < 1) { snprintf(a->fehler, sizeof a->fehler, "ASIO-Treiber „%s“ hat keine Ausgänge", name); return 0; }
  a->aus_kan = aus;
  return einrichten(a, behalten);
}

/**
 * Rate einstellen, Puffer anlegen, Ring – beim Öffnen und beim Umstellen (Treiber bleibt geladen). behalten = 1: leichter
 * Neustart auf Wunsch des Treibers – was im Ring steht und der gespielt-Zähler bleiben (sonst stimmt die Position nicht).
 */
static int einrichten(AsioAus *a, int behalten) {
  const IASIOVtbl *v = a->drv->lpVtbl;
  const char *name = a->name; long aus = a->aus_kan;
  ASIOSampleRate ist = 0;
  v->getSampleRate(a->drv, &ist);
  int gestellt = (int)(ist + 0.5) != a->rate;
  if (gestellt) {
    if (v->canSampleRate(a->drv, a->rate) != ASE_OK) { snprintf(a->fehler, sizeof a->fehler, "ASIO-Treiber „%s“ kann %d Hz nicht", name, a->rate); return 0; }
    double t0 = uhr();
    if (v->setSampleRate(a->drv, a->rate) != ASE_OK) { snprintf(a->fehler, sizeof a->fehler, "ASIO-Treiber „%s“ lässt sich nicht auf %d Hz stellen", name, a->rate); return 0; }
    proto_text("Rate %d → %d Hz gesetzt (%d ms)", (int)(ist + 0.5), a->rate, (int)((uhr() - t0) * 1000 + 0.5));
    a->schonfrist_bis = uhr() + 3.0; a->resets_in_frist = 0;
    // warten, bis der Treiber die neue Rate auch meldet (manche stellen erst im Hintergrund um), höchstens 2 s
    int i;
    for (i = 0; i < 200; i++) {
      ist = 0; v->getSampleRate(a->drv, &ist);
      if ((int)(ist + 0.5) == a->rate) break;
#ifdef _WIN32
      Sleep(10);
#else
      usleep(10000);
#endif
    }
    if (i) proto_text("Treiber meldet die neue Rate nach %d ms", i * 10);
  }
  long mn = 0, mx = 0, pref = 0, gr = 0;
  if (v->getBufferSize(a->drv, &mn, &mx, &pref, &gr) != ASE_OK || pref <= 0) { snprintf(a->fehler, sizeof a->fehler, "ASIO-Treiber „%s“ nennt keine Puffergröße", name); return 0; }
  // Ausgang mit Karte: so viele Kanäle hat er (Stereo 2, Quadro 4, 5.1 6); die Treiber-Ausgänge müssen da sein
  long zahl = a->n_karte ? a->n_karte : aus;
  for (int c = 0; c < a->n_karte; c++)
    if (a->karte[c] >= aus) { snprintf(a->fehler, sizeof a->fehler, "ASIO-Treiber „%s“ hat keinen Ausgang %d (nur %ld)", name, a->karte[c] + 1, aus); return 0; }
  int k = a->kanaele_wunsch < 2 ? 2 : a->kanaele_wunsch;   // Mono auf beide Seiten
  if (k > zahl) k = (int)zahl;
  if (k > 32) k = 32;
  ASIOChannelInfo ci; memset(&ci, 0, sizeof ci); ci.channel = a->n_karte ? a->karte[0] : 0; ci.isInput = 0;
  if (v->getChannelInfo(a->drv, &ci) != ASE_OK) { snprintf(a->fehler, sizeof a->fehler, "ASIO-Treiber „%s“: Kanalinfo fehlt", name); return 0; }
  AusFormat fmt;
  if (!format_waehlen(ci.type, &fmt, &a->fbytes)) { snprintf(a->fehler, sizeof a->fehler, "ASIO-Treiber „%s“: Sampleformat %ld wird nicht unterstützt", name, (long)ci.type); return 0; }
  a->typ = ci.type;
  // Kanal c der Engine → Ausgang karte[c] des Treibers (ohne Karte: Ausgang c). Kanalfolge der Engine wie Web Audio/WAV:
  // Stereo L, R; Quadro L, R, Ls, Rs; 5.1 L, R, C, LFE, Ls, Rs. Spielt Stereo auf einem 5.1-Ausgang, bekommen nur L/R Puffer
  for (int c = 0; c < k; c++) { a->bi[c].isInput = 0; a->bi[c].channelNum = a->n_karte ? a->karte[c] : c; a->bi[c].buffers[0] = a->bi[c].buffers[1] = NULL; }
  aktiv = a;
  if (v->createBuffers(a->drv, a->bi, k, pref, &RUECKRUFE) != ASE_OK) { aktiv = NULL; snprintf(a->fehler, sizeof a->fehler, "ASIO-Treiber „%s“: Puffer lassen sich nicht anlegen", name); return 0; }
  int kan_alt = a->kan_ring;
  a->kan = k; a->bufsize = pref;
  treiber_puffer_leeren(a);
  // Ausgabelatenz: laut ASIO alles, was nach der Übergabe noch kommt (interne Puffer, Wandler)
  long l_ein = 0, l_aus = 0;
  a->latenz = v->getLatencies(a->drv, &l_ein, &l_aus) == ASE_OK && l_aus > 0 ? l_aus : 0;
  // eigener Puffer vor dem Treiber: drei Treiberpuffer, mindestens 50 ms (kurz = schnelles Spulen)
  // (Tests: die Attrappe läuft mit AW_TEMPO schneller als Echtzeit – dann entsprechend mehr, sonst reißt es ab)
  double tempo = getenv("AW_TEMPO") && atof(getenv("AW_TEMPO")) > 1 ? atof(getenv("AW_TEMPO")) : 1;
  a->ziel = (int)pref * 3; if (a->ziel < (int)(a->rate / 20 * tempo)) a->ziel = (int)(a->rate / 20 * tempo);
  int kap_neu = a->ziel * 2;
  pthread_mutex_lock(&a->m);
  unsigned char *ring_neu = calloc((size_t)kap_neu, (size_t)a->fbytes * (size_t)k);
  if (behalten && a->ring && kan_alt == k && a->n > 0) {
    // Inhalt mitnehmen (gleiches Format, gleiche Kanäle): was noch nicht gespielt ist, kommt nach dem Neustart heraus
    int bpf = a->fbytes * k, nimm = a->n < kap_neu ? a->n : kap_neu;
    for (int i = 0; i < nimm; i++) memcpy(ring_neu + (size_t)i * bpf, a->ring + (size_t)((a->rpos + i) % a->kap) * bpf, (size_t)bpf);
    a->n = nimm;
  } else { a->n = 0; if (!behalten) a->gespielt = 0; }
  free(a->ring);
  a->ring = ring_neu; a->kap = kap_neu; a->rpos = 0; a->kan_ring = k;
  pthread_mutex_unlock(&a->m);
  takt_zuruecksetzen(a);
  proto_text("Puffer angelegt: %ld Frames, Latenz %ld Frames", pref, a->latenz);
  memset(&a->info, 0, sizeof a->info);
  a->info.rate = a->rate; a->info.geraet_rate = a->rate; a->info.kanaele = k; a->info.geraet_kanaele = (int)zahl;
  a->info.fmt = fmt; a->info.exklusiv = 1; a->info.asio = 1; a->info.puffer_frames = (int)pref; a->info.latenz = (int)a->latenz;
  a->info.rate_gestellt = gestellt;
  snprintf(a->info.geraet, sizeof a->info.geraet, "ASIO · %s", name);
  return 1;
}

static void schliessen_im_thread(AsioAus *a) {
  if (!a->drv) return;
  const IASIOVtbl *v = a->drv->lpVtbl;
  if (a->laeuft) { v->stop(a->drv); a->laeuft = 0; }
  if (a->kan) v->disposeBuffers(a->drv);
  if (aktiv == a) aktiv = NULL;
  v->Release(a->drv);
  a->drv = NULL;
}

static void *treiber_thread(void *arg) {
  AsioAus *a = arg;
#ifdef _WIN32
  CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
#endif
  int ok = oeffnen_im_thread(a, 0);
  pthread_mutex_lock(&a->m);
  a->bereit = ok ? 1 : -1;
  pthread_cond_broadcast(&a->c_befehl);
  pthread_mutex_unlock(&a->m);
  if (ok) {
    for (;;) {
      pthread_mutex_lock(&a->m);
      int b = a->befehl;
      if (b == B_NICHTS && a->reset_wunsch) b = B_RESET;
      if (b == B_NICHTS) {
        struct timespec ts; zeit_in(&ts, 10);
        pthread_cond_timedwait(&a->c_befehl, &a->m, &ts);
        b = a->befehl;
      }
      if (b != B_RESET) a->befehl = B_NICHTS;
      pthread_mutex_unlock(&a->m);
      int erg = 0;
      if (b == B_START) { treiber_puffer_leeren(a); takt_zuruecksetzen(a); erg = a->drv->lpVtbl->start(a->drv) == ASE_OK; if (erg) { a->laeuft = 1; proto_text("gestartet"); } }
      else if (b == B_STOPP) { if (a->laeuft) a->drv->lpVtbl->stop(a->drv); a->laeuft = 0; treiber_puffer_leeren(a); erg = 1; }
      else if (b == B_PANEL) erg = a->drv->lpVtbl->controlPanel(a->drv) == ASE_OK;
      else if (b == B_NAMEN) { if (a->namen) namen_json(a->drv, a->aus_kan, a->namen, a->namen_n); erg = 1; }
      else if (b == B_ENDE) schliessen_im_thread(a);
      else if (b == B_UMSTELLEN) {
        // Treiber bleibt geladen: anhalten, Puffer weg, neue Rate, neue Puffer (viel schneller als neu laden)
        a->stellt_um = 1; a->reset_wunsch = 0;
        if (a->laeuft) { a->drv->lpVtbl->stop(a->drv); a->laeuft = 0; proto_text("angehalten"); }
        a->drv->lpVtbl->disposeBuffers(a->drv); a->kan = 0;
        a->fehler[0] = 0;
        erg = einrichten(a, 0);
        a->stellt_um = 0;
      }
      else if (b == B_RESET) {
        // Neustart-Wunsch des Treibers in der Schonfrist: anhalten, Puffer neu, weiterlaufen – Ring und Position bleiben.
        // Kommt in derselben Frist ein zweiter Wunsch, den Treiber im Thread ganz neu laden (immer noch ohne Engine-Neuöffnen).
        a->reset_wunsch = 0;
        double t0 = uhr();
        int lief = a->laeuft;
        a->stellt_um = 1;
        if (a->laeuft) { a->drv->lpVtbl->stop(a->drv); a->laeuft = 0; }
        if (a->kan) { a->drv->lpVtbl->disposeBuffers(a->drv); a->kan = 0; }
        int ok2;
        if (++a->resets_in_frist >= 2) {
          a->drv->lpVtbl->Release(a->drv); a->drv = NULL;
          ok2 = oeffnen_im_thread(a, 1);
          proto_text("Treiber neu geladen (%d ms)", (int)((uhr() - t0) * 1000 + 0.5));
        } else ok2 = einrichten(a, 1);
        if (ok2 && lief) { treiber_puffer_leeren(a); ok2 = a->drv->lpVtbl->start(a->drv) == ASE_OK; if (ok2) a->laeuft = 1; }
        a->stellt_um = 0;
        if (ok2) proto_text("Puffer neu angelegt und weiter (%d ms)", (int)((uhr() - t0) * 1000 + 0.5));
        else { proto_text("Neustart misslungen – Gerät wird neu geöffnet"); a->verloren = 1; pthread_mutex_lock(&a->m); pthread_cond_broadcast(&a->c_daten); pthread_mutex_unlock(&a->m); }
        b = B_NICHTS;   // kein Befehl der Engine: keine Antwort
      }
      if (b != B_NICHTS) {
        pthread_mutex_lock(&a->m);
        a->befehl_erg = erg; a->befehl_fertig = 1;
        pthread_cond_broadcast(&a->c_befehl);
        pthread_mutex_unlock(&a->m);
        if (b == B_ENDE) break;
      }
#ifdef _WIN32
      MSG msg;   // STA: Nachrichten des Treibers (manche brauchen das für ihr Fenster oder Timer)
      while (PeekMessageW(&msg, NULL, 0, 0, PM_REMOVE)) { TranslateMessage(&msg); DispatchMessageW(&msg); }
#endif
    }
  } else {
    schliessen_im_thread(a);
  }
#ifdef _WIN32
  CoUninitialize();
#endif
  return NULL;
}

static AsioAus *asio_oeffnen_frei(const char *id, int rate, int kanaele, int bits, AusInfo *info, char *fehler, size_t fn);
static int befehl(AsioAus *a, int b, int warten_ms) {
  pthread_mutex_lock(&a->bm);
  pthread_mutex_lock(&a->m);
  a->befehl = b; a->befehl_fertig = 0;
  pthread_cond_broadcast(&a->c_befehl);
  struct timespec ts; zeit_in(&ts, warten_ms);
  while (!a->befehl_fertig) if (pthread_cond_timedwait(&a->c_befehl, &a->m, &ts) == ETIMEDOUT) break;
  int erg = a->befehl_fertig ? a->befehl_erg : 0;
  pthread_mutex_unlock(&a->m);
  pthread_mutex_unlock(&a->bm);
  return erg;
}

/* ---------- Schnittstelle ---------- */

static pthread_mutex_t laden_m = PTHREAD_MUTEX_INITIALIZER;   // Öffnen und kurzes Laden (Kanalnamen) nicht gleichzeitig

AsioAus *asio_oeffnen(const char *id, int rate, int kanaele, int bits, AusInfo *info, char *fehler, size_t fn) {
  pthread_mutex_lock(&laden_m);
  AsioAus *a = asio_oeffnen_frei(id, rate, kanaele, bits, info, fehler, fn);
  pthread_mutex_unlock(&laden_m);
  return a;
}

static AsioAus *asio_oeffnen_frei(const char *id, int rate, int kanaele, int bits, AusInfo *info, char *fehler, size_t fn) {
  if (aktiv) { snprintf(fehler, fn, "Ein ASIO-Treiber ist schon offen"); return NULL; }
  AsioAus *a = calloc(1, sizeof *a);
  proto_beginnen(); proto_text("Treiber laden, %d Hz", rate);
  a->n_karte = karte_lesen(id, a->id, sizeof a->id, a->karte);
  a->rate = rate; a->kanaele_wunsch = kanaele; a->bits = bits;
  pthread_mutex_init(&a->m, NULL); pthread_mutex_init(&a->bm, NULL); pthread_cond_init(&a->c_daten, NULL); pthread_cond_init(&a->c_befehl, NULL);
  if (pthread_create(&a->th, NULL, treiber_thread, a)) { free(a); snprintf(fehler, fn, "ASIO: Thread fehlt"); return NULL; }
  pthread_mutex_lock(&a->m);
  struct timespec ts; zeit_in(&ts, 8000);
  while (!a->bereit) if (pthread_cond_timedwait(&a->c_befehl, &a->m, &ts) == ETIMEDOUT) break;
  int ok = a->bereit == 1;
  pthread_mutex_unlock(&a->m);
  if (!ok) {
    snprintf(fehler, fn, "%s", a->fehler[0] ? a->fehler : "ASIO-Treiber antwortet nicht");
    if (a->bereit) pthread_join(a->th, NULL); else pthread_detach(a->th);   // hängt der Treiber, den Thread laufen lassen
    if (a->bereit) { free(a->ring); free(a); }
    return NULL;
  }
  *info = a->info;
  return a;
}

int asio_warten(AsioAus *a, int ms) {
  pthread_mutex_lock(&a->m);
  int ziel = a->ziel;
  if (a->n >= ziel && !a->verloren) {
    struct timespec ts; zeit_in(&ts, ms);
    pthread_cond_timedwait(&a->c_daten, &a->m, &ts);
  }
  int frei = a->n < ziel;
  pthread_mutex_unlock(&a->m);
  return frei;
}

int asio_frei(AsioAus *a) {
  pthread_mutex_lock(&a->m);
  int f = a->ziel - a->n;
  pthread_mutex_unlock(&a->m);
  return f > 0 ? f : 0;
}

void *asio_puffer(AsioAus *a, int frames) {
  size_t b = (size_t)frames * (size_t)a->fbytes * (size_t)a->kan;
  if ((size_t)a->stage_kap < b) { free(a->stage); a->stage = malloc(b); a->stage_kap = (int)b; }
  return a->stage;
}

int asio_puffer_fertig(AsioAus *a, int frames) {
  int bpf = a->fbytes * a->kan;
  pthread_mutex_lock(&a->m);
  if (frames > a->kap - a->n) frames = a->kap - a->n;
  int w = (a->rpos + a->n) % a->kap;
  for (int i = 0; i < frames; ) {
    int stueck = frames - i, bis = a->kap - w;
    if (stueck > bis) stueck = bis;
    memcpy(a->ring + (size_t)w * bpf, a->stage + (size_t)i * bpf, (size_t)stueck * bpf);
    i += stueck; w = (w + stueck) % a->kap;
  }
  a->n += frames;
  pthread_mutex_unlock(&a->m);
  return 0;
}

int64_t asio_gespielt(AsioAus *a) { pthread_mutex_lock(&a->m); int64_t g = a->gespielt; pthread_mutex_unlock(&a->m); return g; }
int asio_start(AsioAus *a) { return a->laeuft ? 0 : (befehl(a, B_START, 3000) ? 0 : -1); }
int asio_stopp(AsioAus *a) { return a->laeuft ? (befehl(a, B_STOPP, 3000) ? 0 : -1) : 0; }
/** Kopf des Rings über k Frames auf null ziehen (unter a->m) */
static int kopf_ausblenden(AsioAus *a, int ms) {
  int bpf = a->fbytes * a->kan;
  int k = (int)((long)a->rate * ms / 1000);
  if (k > a->n) k = a->n;
  for (int i = 0; i < k; i++) {
    double g = 0.5 * (1.0 + cos(M_PI * (i + 1) / (double)k));
    unsigned char *f = a->ring + (size_t)((a->rpos + i) % a->kap) * bpf;
    for (int c = 0; c < a->kan; c++) sample_skalieren(f + (size_t)c * a->fbytes, a->info.fmt, g);
  }
  a->n = k;
  return k;
}

/**
 * Vor einem harten Anhalten (anderer Titel, Spulen, Stopp): statt mitten in der Welle abzureißen, die nächsten ms im Ring
 * sanft auf null ziehen, den Rest verwerfen und warten, bis der Treiber nur noch Stille ausgibt. Höchstens ~300 ms.
 */
int asio_ausklingen(AsioAus *a, int ms) {
  if (!a || !a->laeuft) return 0;
  pthread_mutex_lock(&a->m);
  int k = kopf_ausblenden(a, ms);
  // bis der Ring leer ist und danach zwei Hälften Stille gespielt sind
  long r0 = -1;
  for (int versuch = 0; versuch < 60; versuch++) {
    if (a->n == 0 && r0 < 0) r0 = a->rueckrufe;
    if (r0 >= 0 && a->rueckrufe >= r0 + 2) break;
    if (a->verloren || !a->laeuft) break;
    struct timespec ts; zeit_in(&ts, 5);
    pthread_cond_timedwait(&a->c_daten, &a->m, &ts);
  }
  pthread_mutex_unlock(&a->m);
  return k;
}

/**
 * Durchlaufen statt Anhalten (Titelwechsel, Spulen): die nächsten ms ausblenden, den Rest verwerfen – der Treiber läuft
 * weiter, Neues wird direkt dahinter geschrieben. Rückgabe: gespielt-Stand, ab dem das nächste Geschriebene hörbar wird.
 */
int64_t asio_weich_leeren(AsioAus *a, int ms) {
  pthread_mutex_lock(&a->m);
  int k = a->laeuft ? kopf_ausblenden(a, ms) : (a->n = 0);
  int64_t ab = a->gespielt + k;
  pthread_mutex_unlock(&a->m);
  return ab;
}

/**
 * Vor einem echten Anhalten (Ratenwechsel): alles ausspielen lassen, dann so lange Stille, wie der Treiber an Latenz
 * meldet – plus zwei Treiberpuffer Rand, mindestens drei Puffer, höchstens 500 ms. Danach steckt im Interface nichts mehr.
 */
void asio_nachlauf(AsioAus *a) {
  if (!a || !a->laeuft) return;
  double t0 = uhr();
  long frames = a->latenz + 2 * a->bufsize;
  if (frames < 3 * a->bufsize) frames = 3 * a->bufsize;
  if (frames > a->rate / 2) frames = a->rate / 2;
  long bs = a->bufsize > 0 ? a->bufsize : 256;
  long noetig = (frames + bs - 1) / bs;
  pthread_mutex_lock(&a->m);
  long r0 = -1;
  for (int versuch = 0; versuch < 400; versuch++) {   // höchstens ~2 s
    if (a->n == 0 && r0 < 0) r0 = a->rueckrufe;
    if (r0 >= 0 && a->rueckrufe >= r0 + noetig + 1) break;
    if (a->verloren || !a->laeuft) break;
    struct timespec ts; zeit_in(&ts, 5);
    pthread_cond_timedwait(&a->c_daten, &a->m, &ts);
  }
  pthread_mutex_unlock(&a->m);
  nachlauf_ms = (int)((uhr() - t0) * 1000 + 0.5);
}

long asio_unterlaeufe(AsioAus *a) { pthread_mutex_lock(&a->m); long u = a->unterlaeufe; pthread_mutex_unlock(&a->m); return u; }

int asio_zuruecksetzen(AsioAus *a) {
  pthread_mutex_lock(&a->m);
  a->n = 0; a->rpos = 0; a->gespielt = 0;
  pthread_mutex_unlock(&a->m);
  return 0;
}
void asio_schliessen(AsioAus *a) {
  if (!a) return;
  pthread_mutex_lock(&laden_m);   // nicht, während jemand die Kanalnamen erfragt
  befehl(a, B_ENDE, 5000);
  pthread_join(a->th, NULL);
  pthread_mutex_unlock(&laden_m);
  pthread_mutex_destroy(&a->m); pthread_cond_destroy(&a->c_daten); pthread_cond_destroy(&a->c_befehl);
  free(a->ring); free(a->stage); free(a);
}
int asio_verloren(AsioAus *a) { return a->verloren; }
/** Takt laut Sample-Position des Treibers: 1 = stabil, 0 = noch nicht, −1 = Treiber liefert keine Zeitinfo */
int asio_takt(AsioAus *a) { if (!a || a->reset_wunsch || a->stellt_um) return a ? 0 : -1; return !a->takt_gueltig ? -1 : a->takt_n >= 2; }

int asio_umstellen(AsioAus *a, int rate, int kanaele, int bits, AusInfo *info, char *fehler, size_t fn) {
  proto_beginnen(); proto_text("Stille ausgespielt (%d ms), umstellen auf %d Hz, %d Kanäle", nachlauf_ms, rate, kanaele);
  a->rate = rate; a->kanaele_wunsch = kanaele; a->bits = bits;
  if (!befehl(a, B_UMSTELLEN, 8000)) { snprintf(fehler, fn, "%s", a->fehler[0] ? a->fehler : "ASIO-Treiber lässt sich nicht umstellen"); return -1; }
  *info = a->info;
  return 0;
}
int asio_gleicher_treiber(const char *g1, const char *g2) {
  if (!g1 || !g2 || strncmp(g1, "asio:", 5) || strncmp(g2, "asio:", 5)) return 0;
  size_t l1 = strcspn(g1, "#"), l2 = strcspn(g2, "#");
  return l1 == l2 && !strncmp(g1, g2, l1);
}

int asio_umleiten(AsioAus *a, const char *id) {
  char t[80]; int k[32];
  int n = karte_lesen(id, t, sizeof t, k);
  if (strcmp(t, a->id)) return -1;
  if (n == a->n_karte && !memcmp(k, a->karte, sizeof(int) * (size_t)n)) return 0;
  memcpy(a->karte, k, sizeof k); a->n_karte = n;
  return 1;
}

int asio_kanal_namen(const char *id, char *buf, size_t n, char *fehler, size_t fn) {
  char t[80]; int k[32];
  karte_lesen(id, t, sizeof t, k);
  pthread_mutex_lock(&laden_m);
  int erg = -1;
  if (aktiv) {
    if (!strcmp(aktiv->id, t)) {
      aktiv->namen = buf; aktiv->namen_n = n;
      erg = befehl(aktiv, B_NAMEN, 3000) ? 0 : -1;
      aktiv->namen = NULL;
      if (erg) snprintf(fehler, fn, "ASIO-Treiber antwortet nicht");
    } else snprintf(fehler, fn, "Ein anderer ASIO-Treiber ist gerade offen");
  } else {
    // kurz laden, fragen, freigeben (ohne Puffer – stört nichts)
#ifdef _WIN32
    CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
#endif
    IASIO *d = asio_treiber_laden(t, fehler, fn);
    if (d) {
#ifdef _WIN32
      void *fenster = GetDesktopWindow();
#else
      void *fenster = NULL;
#endif
      long ein = 0, aus = 0;
      if (d->lpVtbl->init(d, fenster) && d->lpVtbl->getChannels(d, &ein, &aus) == ASE_OK && aus > 0) { namen_json(d, aus, buf, n); erg = 0; }
      else snprintf(fehler, fn, "ASIO-Treiber startet nicht");
      d->lpVtbl->Release(d);
    }
#ifdef _WIN32
    CoUninitialize();
#endif
  }
  pthread_mutex_unlock(&laden_m);
  return erg;
}

int asio_einstellungen(AsioAus *a) { return a ? befehl(a, B_PANEL, 60000) : 0; }
int asio_einstellungen_aktiv(void) { return aktiv ? asio_einstellungen(aktiv) : 0; }

void asio_geraete_json(char **buf, size_t *len, size_t *kap) {
  char ids[16][80], namen[16][128];
  int n = asio_treiber_liste(ids, namen, 16);
  for (int i = 0; i < n; i++) {
    char e[512], nm[300]; size_t o = 0;
    for (const char *p = namen[i]; *p && o + 2 < sizeof nm; p++) { if (*p == '"' || *p == '\\') nm[o++] = '\\'; nm[o++] = *p; }
    nm[o] = 0;
    int l = snprintf(e, sizeof e, "%s{\"id\":\"asio:%s\",\"name\":\"ASIO · %s\",\"standard\":false,\"kanaele\":0,\"asio\":true}", *len > 0 && (*buf)[*len - 1] != '[' ? "," : "", ids[i], nm);
    if (*len + (size_t)l + 2 > *kap) { *kap = (*len + (size_t)l + 2) * 2; *buf = realloc(*buf, *kap); }
    memcpy(*buf + *len, e, (size_t)l); *len += (size_t)l; (*buf)[*len] = 0;
  }
}

/* ---------- Windows: Treiber aus der Registry ---------- */
#if defined(_WIN32) && !defined(ASIO_ATTRAPPE)
int asio_treiber_liste(char ids[][80], char namen[][128], int max) {
  HKEY h; int n = 0;
  if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\ASIO", 0, KEY_READ, &h) != ERROR_SUCCESS) return 0;
  for (DWORD i = 0; n < max; i++) {
    wchar_t sub[256]; DWORD sl = 256;
    if (RegEnumKeyExW(h, i, sub, &sl, NULL, NULL, NULL, NULL) != ERROR_SUCCESS) break;
    HKEY hs;
    if (RegOpenKeyExW(h, sub, 0, KEY_READ, &hs) != ERROR_SUCCESS) continue;
    wchar_t clsid[80]; DWORD cl = sizeof clsid, typ = 0;
    if (RegQueryValueExW(hs, L"CLSID", NULL, &typ, (BYTE *)clsid, &cl) == ERROR_SUCCESS && typ == REG_SZ) {
      WideCharToMultiByte(CP_UTF8, 0, clsid, -1, ids[n], 80, NULL, NULL);
      wchar_t beschr[256]; DWORD bl = sizeof beschr;
      if (RegQueryValueExW(hs, L"Description", NULL, &typ, (BYTE *)beschr, &bl) != ERROR_SUCCESS || typ != REG_SZ) wcscpy(beschr, sub);
      WideCharToMultiByte(CP_UTF8, 0, beschr, -1, namen[n], 128, NULL, NULL);
      n++;
    }
    RegCloseKey(hs);
  }
  RegCloseKey(h);
  return n;
}

IASIO *asio_treiber_laden(const char *id, char *fehler, size_t fn) {
  wchar_t w[80]; CLSID clsid;
  MultiByteToWideChar(CP_UTF8, 0, id, -1, w, 80);
  if (CLSIDFromString(w, &clsid) != S_OK) { snprintf(fehler, fn, "ASIO: ungültige Treiber-ID"); return NULL; }
  void *p = NULL;
  // ASIO-Eigenheit: die Schnittstellen-ID ist die Klassen-ID des Treibers
  HRESULT hr = CoCreateInstance(&clsid, NULL, CLSCTX_INPROC_SERVER, &clsid, &p);
  if (FAILED(hr) || !p) { snprintf(fehler, fn, "ASIO-Treiber lässt sich nicht laden (Code 0x%08lX) – ist er installiert (64 Bit)?", (unsigned long)hr); return NULL; }
  return (IASIO *)p;
}
#endif
