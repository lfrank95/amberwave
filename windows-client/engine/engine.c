// Amberwave-Engine: spielt Titel vom Amberwave-Server bitgenau ab (WASAPI exklusiv), lückenlos, mit Lautstärke und Dither
// nur wenn nötig. Gesteuert vom Windows-Client über stdin (eine JSON-Zeile je Befehl), Meldungen gehen als JSON-Zeilen
// nach stdout.
//
// Aufbau: je Titel ein Download-Thread (ganze Datei in den Speicher), ein Dekoder-Thread (FLAC → Ring aus int32,
// linksbündig) und ein Ausgabe-Thread (Ring → Gerät). Marken im Ring sagen dem Ausgabe-Thread, wo ein Titel beginnt,
// wo sich das Format ändert und wo die Warteschlange endet. Gleiches Format hintereinander = sample-genau ohne Lücke.
//
// Befehle (Feld "c"):
//   geraete                                    → {"e":"geraete","liste":[{id,name,standard}]}
//   ausgabe   geraet, exklusiv(bool)            Gerät wählen (leer = Standardgerät). ASIO: „asio:{CLSID}#0,1,…“ = Ausgang
//                                              (Kanal c der Engine → Treiber-Ausgang c-ter Eintrag); gleicher Treiber,
//                                              anderer Ausgang: umleiten ohne Neuladen
//   asio_kanaele geraet                        → {"e":"asio_kanaele","geraet","namen":[…]} bzw. fehler
//   testton   geraet, w.ms                      rosa Rauschen (−20 dBFS) auf dem Ausgang → {"e":"testton","ok"|"fehler"}
//   laden     id, url, kopf, pos, spielen       Titel sofort laden (alles andere verwerfen), ab pos Sekunden
//   vormerken id, url, kopf                    nächsten Titel vormerken (lückenloser Übergang); url leer = keiner
//   spielen / pause                            w.fade = Ein-/Ausblenden in ms (Pause: erst ausblenden, dann anhalten)
//   springen  id, pos                          im laufenden Titel spulen
//   lautstaerke wert (0…1, linear)
//   stopp                                      alles anhalten und verwerfen
//   beenden
// Meldungen (Feld "e"): bereit, geraete, format, start, zeit, ende, fehler, aussetzer, geladen
#define DR_FLAC_IMPLEMENTATION
#define DR_FLAC_NO_STDIO
#define DR_FLAC_NO_OGG
#include "dr_flac.h"
#define DR_WAV_IMPLEMENTATION
#define DR_WAV_NO_STDIO
#include "dr_wav.h"

#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>
#include <errno.h>
#include "ausgabe.h"
#include "netz.h"
#include "klang.h"
#include "ausgabe_asio.h"
#include "geraet.h"

#ifdef _WIN32
#include <windows.h>
#include <io.h>
#include <fcntl.h>
#else
#include <unistd.h>
#endif

#define ENGINE_VERSION "0.8.7"

/* ------------------------------------------------------------------------------------------------------------ */
/* Ausgabe der Meldungen                                                                                         */

static pthread_mutex_t aus_m = PTHREAD_MUTEX_INITIALIZER;

void melden(const char *fmt, ...) {
  va_list ap;
  pthread_mutex_lock(&aus_m);
  va_start(ap, fmt);
  vfprintf(stdout, fmt, ap);
  va_end(ap);
  fputc('\n', stdout);
  fflush(stdout);
  pthread_mutex_unlock(&aus_m);
}

/** Text als JSON-String (mit Anführungszeichen) in buf */
static const char *js(char *buf, size_t n, const char *s) {
  size_t o = 0;
  if (n < 3) return "\"\"";
  buf[o++] = '"';
  for (; s && *s && o + 8 < n; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') { buf[o++] = '\\'; buf[o++] = (char)c; }
    else if (c == '\n') { buf[o++] = '\\'; buf[o++] = 'n'; }
    else if (c == '\r') { buf[o++] = '\\'; buf[o++] = 'r'; }
    else if (c == '\t') { buf[o++] = '\\'; buf[o++] = 't'; }
    else if (c < 0x20) o += (size_t)snprintf(buf + o, n - o, "\\u%04x", c);
    else buf[o++] = (char)c;
  }
  buf[o++] = '"';
  buf[o] = 0;
  return buf;
}

static double jetzt_s(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec + ts.tv_nsec * 1e-9;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Titel: Download in den Speicher (große Dateien in eine Temp-Datei), dr_flac liest blockierend daraus          */

typedef struct Titel {
  char id[64];
  char *url, *kopf;
  pthread_mutex_t m;
  pthread_cond_t c;
  unsigned char *daten;
  FILE *datei;            // große Titel (Hi-Res, lange Werke): Daten in einer Temp-Datei statt im Arbeitsspeicher
  size_t groesse, kap, lesepos;
  int64_t gesamt;         // Content-Length, -1 unbekannt
  int fertig, fehler, abbruch, dl_laeuft;
  char fehlertext[256];
  Netz *netz;
  pthread_t dl;
  drflac *flac;
  drwav *wav;              // WAV/AIFF-Original (statt FLAC; der Server liefert es unverändert)
  int rate, kanaele, bits;
  uint64_t frames_gesamt;  // 0 = unbekannt
  uint64_t frame_pos;      // nächster zu dekodierender Frame
  double start;            // gewünschte Startposition (s)
  double gain;             // Lautheits-Angleich (linear), wechselt sample-genau an der Titelgrenze
} Titel;

/** Ab dieser Größe landet ein Titel in einer Temp-Datei (sonst halten Titel davor/jetzt/danach leicht Gigabytes im RAM).
 *  AW_SPEICHER_MB setzt die Grenze (Tests). */
static size_t speicher_grenze(void) {
  static size_t g = 0;
  if (!g) {
    const char *e = getenv("AW_SPEICHER_MB");
    long mb = e && *e ? atol(e) : 48;
    g = (size_t)(mb > 0 ? mb : 48) << 20;
  }
  return g;
}

/** Temp-Datei, die beim Schließen (auch bei Absturz) wieder verschwindet */
static FILE *temp_datei(void) {
#ifdef _WIN32
  wchar_t ordner[MAX_PATH + 1], name[MAX_PATH + 1];
  if (!GetTempPathW(MAX_PATH, ordner) || !GetTempFileNameW(ordner, L"awp", 0, name)) return NULL;
  HANDLE h = CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                         FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE, NULL);
  if (h == INVALID_HANDLE_VALUE) { DeleteFileW(name); return NULL; }
  int fd = _open_osfhandle((intptr_t)h, _O_RDWR | _O_BINARY);
  if (fd < 0) { CloseHandle(h); return NULL; }
  FILE *f = _fdopen(fd, "w+b");
  if (!f) _close(fd);
  return f;
#else
  return tmpfile();
#endif
}

static int datei_an(FILE *f, int64_t pos) {
#ifdef _WIN32
  return _fseeki64(f, pos, SEEK_SET);
#else
  return fseeko(f, (off_t)pos, SEEK_SET);
#endif
}

/** k Bytes anhängen (unter t->m). 0 = ok */
static int titel_anhaengen(Titel *t, const unsigned char *src, size_t k) {
  if (!t->datei && t->groesse + k > speicher_grenze()) {
    FILE *f = temp_datei();
    if (f) {
      // bisherige Daten in die Datei, Speicher freigeben
      if (t->groesse && fwrite(t->daten, 1, t->groesse, f) != t->groesse) { fclose(f); f = NULL; }
      if (f) { t->datei = f; free(t->daten); t->daten = NULL; t->kap = 0; }
    }
    // ohne Temp-Datei (voller Datenträger, keine Rechte): weiter im Speicher wie bisher
  }
  if (t->datei) {
    if (datei_an(t->datei, (int64_t)t->groesse) != 0 || fwrite(src, 1, k, t->datei) != k) return -1;
    t->groesse += k;
    return 0;
  }
  if (t->groesse + k > t->kap) {
    size_t neu = t->kap ? t->kap : 1 << 20;
    while (neu < t->groesse + k) neu = neu + neu / 2;
    unsigned char *d = realloc(t->daten, neu);
    if (!d) return -1;
    t->daten = d; t->kap = neu;
  }
  memcpy(t->daten + t->groesse, src, k);
  t->groesse += k;
  return 0;
}

/** k Bytes ab pos lesen (unter t->m, pos + k <= groesse) */
static size_t titel_holen(Titel *t, void *buf, size_t pos, size_t k) {
  if (!k) return 0;
  if (t->datei) {
    if (datei_an(t->datei, (int64_t)pos) != 0) return 0;
    return fread(buf, 1, k, t->datei);
  }
  memcpy(buf, t->daten + pos, k);
  return k;
}

static void *download_thread(void *arg) {
  Titel *t = arg;
  int status = 0;
  int64_t gesamt = -1;
  char fehler[200] = "";
  Netz *n = netz_oeffnen(t->url, t->kopf, &status, &gesamt, fehler, sizeof fehler);
  pthread_mutex_lock(&t->m);
  if (!n || t->abbruch == 1) {
    if (n) { pthread_mutex_unlock(&t->m); netz_schliessen(n); pthread_mutex_lock(&t->m); }
    t->fehler = 1;
    snprintf(t->fehlertext, sizeof t->fehlertext, "%s", t->abbruch == 1 ? "abgebrochen" : (fehler[0] ? fehler : "Verbindung fehlgeschlagen"));
    pthread_cond_broadcast(&t->c);
    pthread_mutex_unlock(&t->m);
    return NULL;
  }
  if (status != 200 && status != 206) {
    t->fehler = 1;
    snprintf(t->fehlertext, sizeof t->fehlertext, "Server antwortet mit %d%s", status, status == 401 ? " (nicht angemeldet)" : "");
    pthread_cond_broadcast(&t->c);
    pthread_mutex_unlock(&t->m);
    netz_schliessen(n);
    return NULL;
  }
  t->netz = n;
  t->gesamt = gesamt;
  // Größe bekannt und klein: gleich passend reservieren; große Titel gehen beim ersten Block in die Temp-Datei
  size_t start_kap = gesamt > 0 && (size_t)gesamt <= speicher_grenze() ? (size_t)gesamt : (size_t)8 << 20;
  if (gesamt > 0 && (size_t)gesamt > speicher_grenze()) start_kap = 0;
  t->daten = start_kap ? malloc(start_kap) : NULL;
  t->kap = t->daten ? start_kap : 0;
  pthread_mutex_unlock(&t->m);
  unsigned char *tmp = malloc(256 * 1024);
  for (;;) {
    long k = tmp ? netz_lesen(n, tmp, 256 * 1024) : -1;
    pthread_mutex_lock(&t->m);
    if (t->abbruch == 1) { pthread_mutex_unlock(&t->m); break; }   // 2 = nur das Lesen des Dekoders unterbrochen
    if (k < 0) { t->fehler = 1; snprintf(t->fehlertext, sizeof t->fehlertext, "Verbindung abgebrochen"); pthread_cond_broadcast(&t->c); pthread_mutex_unlock(&t->m); break; }
    if (k == 0) { t->fertig = 1; pthread_cond_broadcast(&t->c); pthread_mutex_unlock(&t->m); break; }
    if (titel_anhaengen(t, tmp, (size_t)k) != 0) {
      t->fehler = 1;
      snprintf(t->fehlertext, sizeof t->fehlertext, t->datei ? "Zwischenspeichern fehlgeschlagen (Datenträger voll?)" : "zu wenig Speicher");
      pthread_cond_broadcast(&t->c); pthread_mutex_unlock(&t->m); break;
    }
    pthread_cond_broadcast(&t->c);
    pthread_mutex_unlock(&t->m);
  }
  free(tmp);
  pthread_mutex_lock(&t->m);
  t->netz = NULL;
  pthread_mutex_unlock(&t->m);
  netz_schliessen(n);
  return NULL;
}

static Titel *titel_neu(const char *id, const char *url, const char *kopf, double start) {
  Titel *t = calloc(1, sizeof *t);
  if (!t) return NULL;
  t->gain = 1;
  snprintf(t->id, sizeof t->id, "%s", id ? id : "");
  t->url = strdup(url ? url : "");
  t->kopf = kopf && *kopf ? strdup(kopf) : NULL;
  t->gesamt = -1;
  t->start = start > 0 ? start : 0;
  pthread_mutex_init(&t->m, NULL);
  pthread_cond_init(&t->c, NULL);
  if (pthread_create(&t->dl, NULL, download_thread, t) == 0) t->dl_laeuft = 1;
  else { t->fehler = 1; snprintf(t->fehlertext, sizeof t->fehlertext, "Download konnte nicht starten"); }
  return t;
}

/** laufendes Lesen des Dekoders sofort beenden (Lesen liefert dann 0) */
static void titel_unterbrechen(Titel *t) {
  if (!t) return;
  pthread_mutex_lock(&t->m);
  t->abbruch = 2;
  pthread_cond_broadcast(&t->c);
  pthread_mutex_unlock(&t->m);
}

static void titel_weiter(Titel *t) {
  if (!t) return;
  pthread_mutex_lock(&t->m);
  if (t->abbruch == 2) t->abbruch = 0;
  pthread_mutex_unlock(&t->m);
}

static void titel_frei(Titel *t) {
  if (!t) return;
  pthread_mutex_lock(&t->m);
  t->abbruch = 1;
  if (t->netz) netz_abbrechen(t->netz);
  pthread_cond_broadcast(&t->c);
  pthread_mutex_unlock(&t->m);
  if (t->dl_laeuft) pthread_join(t->dl, NULL);
  if (t->flac) drflac_close(t->flac);
  if (t->wav) { drwav_uninit(t->wav); free(t->wav); }
  free(t->daten);
  if (t->datei) fclose(t->datei);
  free(t->url);
  free(t->kopf);
  pthread_mutex_destroy(&t->m);
  pthread_cond_destroy(&t->c);
  free(t);
}

static size_t flac_lesen(void *u, void *buf, size_t n) {
  Titel *t = u;
  pthread_mutex_lock(&t->m);
  while (t->groesse - t->lesepos < n && !t->fertig && !t->fehler && !t->abbruch) pthread_cond_wait(&t->c, &t->m);
  size_t k = 0;
  if (!t->abbruch) {
    k = t->groesse - t->lesepos;
    if (k > n) k = n;
    k = titel_holen(t, buf, t->lesepos, k);
    t->lesepos += k;
  }
  pthread_mutex_unlock(&t->m);
  return k;
}

static drflac_bool32 flac_spulen(void *u, int off, drflac_seek_origin herkunft) {
  Titel *t = u;
  pthread_mutex_lock(&t->m);
  int64_t ziel;
  if (herkunft == DRFLAC_SEEK_SET) ziel = off;
  else if (herkunft == DRFLAC_SEEK_CUR) ziel = (int64_t)t->lesepos + off;
  else {
    // vom Ende: nur wenn die Länge bekannt ist oder alles da ist
    while (t->gesamt < 0 && !t->fertig && !t->fehler && !t->abbruch) pthread_cond_wait(&t->c, &t->m);
    int64_t ende = t->gesamt >= 0 ? t->gesamt : (int64_t)t->groesse;
    ziel = ende + off;
  }
  if (ziel < 0 || (t->gesamt >= 0 && ziel > t->gesamt)) { pthread_mutex_unlock(&t->m); return DRFLAC_FALSE; }
  while ((int64_t)t->groesse < ziel && !t->fertig && !t->fehler && !t->abbruch) pthread_cond_wait(&t->c, &t->m);
  drflac_bool32 ok = !t->abbruch && (int64_t)t->groesse >= ziel;
  if (ok) t->lesepos = (size_t)ziel;
  pthread_mutex_unlock(&t->m);
  return ok;
}

static drflac_bool32 flac_wo(void *u, drflac_int64 *pos) {
  Titel *t = u;
  pthread_mutex_lock(&t->m);
  *pos = (drflac_int64)t->lesepos;
  pthread_mutex_unlock(&t->m);
  return DRFLAC_TRUE;
}

/**
 * Auf Frame f spulen. Vom Server umgewandelte Ströme (AIFF, WAV, MP3 … → FLAC über ffmpeg) haben keine Seektable und keine
 * Gesamtlänge im Kopf – dr_flac würde dann auf den Anfang „spulen“. Dort vom Anfang (rückwärts) bzw. von hier (vorwärts)
 * dekodierend vorlaufen; das ist sample-genau und schnell (nur Dekodieren, keine Ausgabe). Blockiert, bis die Daten da sind.
 */
static int titel_offen(const Titel *t) { return t && (t->flac || t->wav); }

static int titel_spulen(Titel *t, uint64_t f) {
  if (t && t->wav) {
    if (!drwav_seek_to_pcm_frame(t->wav, f)) return 0;
    t->frame_pos = f;
    return 1;
  }
  if (!t || !t->flac) return 0;
  if (t->flac->totalPCMFrameCount > 0) {
    if (!drflac_seek_to_pcm_frame(t->flac, f)) return 0;
    t->frame_pos = f;
    return 1;
  }
  if (f < t->flac->currentPCMFrame && !drflac_seek_to_pcm_frame(t->flac, 0)) return 0;
  while (t->flac->currentPCMFrame < f) {
    drflac_uint64 n = f - t->flac->currentPCMFrame;
    if (n > 65536) n = 65536;
    if (drflac_read_pcm_frames_s32(t->flac, n, NULL) == 0) break;   // Ende oder unterbrochen
  }
  t->frame_pos = t->flac->currentPCMFrame;
  return t->frame_pos == f;
}

/** Datei öffnen (blockiert, bis der Kopf da ist). 0 = ok */
static drwav_bool32 wav_spulen(void *u, int off, drwav_seek_origin h) { return flac_spulen(u, off, (drflac_seek_origin)h); }
static drwav_bool32 wav_wo(void *u, drwav_int64 *pos) { return flac_wo(u, (drflac_int64 *)pos); }

static int titel_oeffnen(Titel *t, char *fehler, size_t fn) {
  // WAV/AIFF (RIFF, RF64, Wave64, FORM) direkt, alles andere als FLAC
  unsigned char kopf[4] = {0};
  size_t k = flac_lesen(t, kopf, 4);
  pthread_mutex_lock(&t->m); t->lesepos = 0; pthread_mutex_unlock(&t->m);
  if (k == 4 && (!memcmp(kopf, "RIFF", 4) || !memcmp(kopf, "RF64", 4) || !memcmp(kopf, "riff", 4) || !memcmp(kopf, "FORM", 4))) {
    t->wav = calloc(1, sizeof(drwav));
    if (!t->wav || !drwav_init(t->wav, flac_lesen, wav_spulen, wav_wo, t, NULL)) {
      free(t->wav); t->wav = NULL;
      snprintf(fehler, fn, "WAV/AIFF lässt sich nicht lesen");
      return -1;
    }
    t->rate = (int)t->wav->sampleRate;
    t->kanaele = t->wav->channels;
    t->bits = t->wav->bitsPerSample;
    t->frames_gesamt = t->wav->totalPCMFrameCount;
    t->frame_pos = 0;
    if (t->start > 0) titel_spulen(t, (uint64_t)(t->start * t->rate));
    return 0;
  }
  t->flac = drflac_open(flac_lesen, flac_spulen, flac_wo, t, NULL);
  if (!t->flac) {
    pthread_mutex_lock(&t->m);
    if (t->abbruch) snprintf(fehler, fn, "abgebrochen");
    else if (t->fehler) snprintf(fehler, fn, "%s", t->fehlertext);
    else snprintf(fehler, fn, "keine gültige FLAC-Datei");
    pthread_mutex_unlock(&t->m);
    return -1;
  }
  t->rate = (int)t->flac->sampleRate;
  t->kanaele = t->flac->channels;
  t->bits = t->flac->bitsPerSample;
  t->frames_gesamt = t->flac->totalPCMFrameCount;
  t->frame_pos = 0;
  if (t->start > 0) {
    uint64_t f = (uint64_t)(t->start * t->rate);
    if (t->frames_gesamt && f >= t->frames_gesamt) f = t->frames_gesamt ? t->frames_gesamt - 1 : 0;
    titel_spulen(t, f);
  }
  return 0;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Ring mit Marken                                                                                                 */

enum { M_FORMAT = 1, M_TITEL, M_ENDE };
typedef struct {
  uint64_t pos;          // Sample-Index (absolut) im Ring
  int typ;
  char id[64];
  int rate, kanaele, bits;
  uint64_t start_frame;
  double dauer;
  double gain;
} Marke;

#define MAX_MARKEN 64
#define RING_KAP ((size_t)1 << 23)     // 8 Mi Samples (32 MiB)

static pthread_mutex_t G = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t G_dek = PTHREAD_COND_INITIALIZER, G_aus = PTHREAD_COND_INITIALIZER;
static int32_t *ring;
static uint64_t w_pos, r_pos;          // geschrieben / gelesen (Samples, absolut)
static Marke marken[MAX_MARKEN];
static int n_marken;
static unsigned gen;                   // Zähler für Verwerfen (Laden/Spulen/Stopp)
static int beenden;
static unsigned neustart;               // Laden/Stopp: Start-Meldung auch für denselben Titel

// Wiedergabe-Zustand
static int spielen;
static double lautstaerke = 1.0;
static double gain_ziel = 1.0, gain_ist = 1.0;   // Angleich des Titels, der gerade in die Ausgabe geht
static char gain_id[64];
static int gain_sprung;                          // Titelgrenze: Gain springt (nächster Titel ab Sample 0 bitgenau)
static char geraet_wahl[512];
static int exklusiv_wahl = 0;
static int fest_rate = 0;               // feste Ausgaberate (0 = folgt der Datei)
static int anlauf_aufschlag = 250;      // ms Stille zusätzlich, nachdem das Gerät nach einem Ratenwechsel stabil läuft
static int hw_rate_letzt;               // Rate, mit der das Gerät zuletzt (exklusiv/ASIO) geöffnet wurde
static char hw_geraet_letzt[512];
static double test_tempo = 1.0;         // nur Tests: Testgerät läuft schneller als Echtzeit (AW_TEMPO)
static double ruhe_pause_s = 300, ruhe_ende_s = 10;   // durchlaufendes Gerät nach so langer Pause bzw. nach dem Ende freigeben
static int geraet_neu;                 // Gerät neu öffnen (Auswahl geändert)
static int raum_versucht;
static char geraet_offen[512];          // Auswahl, mit der das offene Gerät geöffnet wurde
// Testton (Lautsprecher prüfen): rosa Rauschen auf einem Ausgang des ASIO-Treibers
static int ton_anf; static char ton_geraet[512]; static int ton_ms = 2000;
/** dasselbe Gerät? Bei ASIO zählt nur der Treiber (der Ausgang – die Kanalkarte hinter „#“ – lässt sich umstellen) */
static int gleiches_geraet(const char *a, const char *b) { return !strcmp(a, b) || asio_gleicher_treiber(a, b); }
static int exklusiv_offen;               // so viele Kanäle hat Space beim letzten Öffnen verlangt

// Dekoder-Zustand (nur unter G)
static Titel *dek;                     // wird gerade dekodiert
static Titel *naechst;                 // vorgemerkt
static Titel *vorher;                  // davor gespielt (hörbar, solange der Übergang noch im Puffer ist)
static int dek_offen;
static int dek_vorgemerkt;             // dek ist ein vorgemerkter Titel, dessen Marke noch nicht ausgegeben wurde
static uint64_t dek_marke;             // Ring-Position seiner Titel-Marke
static int letzte_rate, letzte_kan, letzte_bits; // Format des zuletzt in den Ring geschriebenen Titels
static int ende_geschrieben;           // Ende-Marke steht im Ring

// Anfragen an den Dekoder
static Titel *anf_laden;
static int anf_vormerken; static Titel *anf_vormerken_t;
static int anf_springen; static double anf_springen_pos; static char anf_springen_id[64];
static int anf_stopp;

static void marke_setzen(int typ, Titel *t) {
  if (n_marken >= MAX_MARKEN) return;
  Marke *m = &marken[n_marken++];
  memset(m, 0, sizeof *m);
  m->pos = w_pos;
  m->typ = typ;
  if (t) {
    snprintf(m->id, sizeof m->id, "%s", t->id);
    m->rate = t->rate; m->kanaele = t->kanaele; m->bits = t->bits;
    if (typ == M_FORMAT) ger_vorwaermen(t->rate, fest_rate);   // Umrechnungsfilter schon jetzt im Hintergrund rechnen, nicht erst beim Wechsel
    m->start_frame = t->frame_pos;
    m->dauer = t->frames_gesamt && t->rate ? (double)t->frames_gesamt / t->rate : 0;
    m->gain = t->gain;
  }
}

/** alles im Ring verwerfen (unter G) */
static void verwerfen(void) {
  gen++;
  r_pos = w_pos;
  n_marken = 0;
  ende_geschrieben = 0;
  letzte_rate = 0;
  pthread_cond_broadcast(&G_aus);
}

/** Ring ab Position p kürzen (Marken dahinter fallen weg) */
static void kuerzen(uint64_t p) {
  if (p < r_pos) p = r_pos;
  w_pos = p;
  int k = 0;
  for (int i = 0; i < n_marken; i++) if (marken[i].pos < p) marken[k++] = marken[i];
  n_marken = k;
  ende_geschrieben = 0;
}

static void frei_ohne_G(Titel *a, Titel *b, Titel *c) {
  pthread_mutex_unlock(&G);
  titel_frei(a); titel_frei(b); titel_frei(c);
  pthread_mutex_lock(&G);
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Dekoder-Thread                                                                                                 */

#define BLOCK_FRAMES 4096

static void *dekoder_thread(void *arg) {
  (void)arg;
  int32_t *tmp = malloc(sizeof(int32_t) * BLOCK_FRAMES * 8);
  char fehler[256], j1[300], j2[300];
  pthread_mutex_lock(&G);
  while (!beenden) {
    if (anf_stopp) {
      anf_stopp = 0;
      Titel *a = dek, *b = naechst, *c = vorher;
      dek = naechst = vorher = NULL; dek_offen = 0; dek_vorgemerkt = 0;
      verwerfen();
      frei_ohne_G(a, b, c);
      continue;
    }
    if (anf_laden) {
      Titel *n = anf_laden; anf_laden = NULL;
      Titel *a = dek, *b = naechst, *c = vorher;
      // vorgemerkter Titel ist genau der gewünschte (Sprung zum nächsten)? Dann den schon geladenen nehmen
      if (b && strcmp(b->id, n->id) == 0 && !b->fehler) { double st = n->start, gn = n->gain; Titel *x = n; n = b; b = x; n->start = st; n->gain = gn; if (titel_offen(n) && st > 0) { /* wird unten gespult */ } }
      else if (a && strcmp(a->id, n->id) == 0 && !a->fehler && titel_offen(a)) { double st = n->start, gn = n->gain; Titel *x = n; n = a; a = x; n->start = st; n->gain = gn; }
      dek = n; naechst = vorher = NULL; dek_vorgemerkt = 0;
      verwerfen();
      if (titel_offen(n)) {
        // schon offen: nur an die Startstelle
        uint64_t f = (uint64_t)(n->start * n->rate);
        titel_weiter(n);
        pthread_mutex_unlock(&G);
        titel_spulen(n, f);
        pthread_mutex_lock(&G);
        dek_offen = 1;
        marke_setzen(M_FORMAT, n); marke_setzen(M_TITEL, n);
        letzte_rate = n->rate; letzte_kan = n->kanaele; letzte_bits = n->bits;
        dek_marke = w_pos;
      } else dek_offen = 0;
      frei_ohne_G(a, b, c);
      continue;
    }
    if (anf_vormerken) {
      Titel *n = anf_vormerken_t; anf_vormerken = 0; anf_vormerken_t = NULL;
      Titel *weg = NULL, *weg2 = NULL;
      if (dek && dek_vorgemerkt && (!dek_offen || dek_marke > r_pos)) {
        // der vorgemerkte Titel wird schon dekodiert, ist aber noch nicht zu hören: ersetzen
        if (n && strcmp(n->id, dek->id) == 0) weg = n;
        else {
          weg = dek;
          titel_unterbrechen(dek);
          if (dek_offen) kuerzen(dek_marke);
          // Format wieder das des Vorgängers (der neue bekommt nur bei Bedarf eine Format-Marke)
          if (vorher) { letzte_rate = vorher->rate; letzte_kan = vorher->kanaele; letzte_bits = vorher->bits; }
          dek = n; dek_offen = 0; dek_vorgemerkt = n != NULL;
          if (!n) { marke_setzen(M_ENDE, vorher); ende_geschrieben = 1; }
          naechst = NULL;
        }
      } else if (!dek && ende_geschrieben && n && n_marken > 0 && marken[n_marken - 1].typ == M_ENDE && marken[n_marken - 1].pos >= r_pos) {
        // Ende steht im Ring, ist aber noch nicht erreicht: Ende weg, nahtlos weiter
        n_marken--; ende_geschrieben = 0;
        dek = n; dek_offen = 0; dek_vorgemerkt = 1;
      } else {
        if (naechst && n && strcmp(naechst->id, n->id) == 0) weg = n;
        else { weg = naechst; naechst = n; }
      }
      frei_ohne_G(weg, weg2, NULL);
      continue;
    }
    if (anf_springen) {
      anf_springen = 0;
      Titel *t = NULL;
      Titel *weg = NULL;
      if (dek && strcmp(dek->id, anf_springen_id) == 0 && titel_offen(dek)) t = dek;
      else if (vorher && strcmp(vorher->id, anf_springen_id) == 0 && titel_offen(vorher)) {
        // Spulen im noch hörbaren Vorgänger: der vorgemerkte (schon dekodierte) wird wieder „nächster“
        t = vorher; vorher = NULL;
        if (dek) { titel_unterbrechen(dek); if (naechst) weg = naechst; naechst = dek; }
        dek = t;
      }
      if (!t) continue;
      verwerfen();
      dek_vorgemerkt = 0;
      titel_unterbrechen(t);
      uint64_t f = (uint64_t)(anf_springen_pos * t->rate);
      if (t->frames_gesamt && f >= t->frames_gesamt) f = t->frames_gesamt - 1;
      pthread_mutex_unlock(&G);
      titel_frei(weg);
      if (naechst) { titel_weiter(naechst); if (titel_offen(naechst)) titel_spulen(naechst, 0); }
      titel_weiter(t);
      titel_spulen(t, f);
      pthread_mutex_lock(&G);
      if (anf_laden || anf_stopp) continue;
      marke_setzen(M_FORMAT, t); marke_setzen(M_TITEL, t);
      letzte_rate = t->rate; letzte_kan = t->kanaele; letzte_bits = t->bits;
      dek_marke = w_pos; dek_offen = 1;
      continue;
    }
    if (!dek) { pthread_cond_wait(&G_dek, &G); continue; }

    if (!dek_offen) {
      Titel *t = dek;
      unsigned g = gen;
      pthread_mutex_unlock(&G);
      titel_weiter(t);
      int r = titel_oeffnen(t, fehler, sizeof fehler);
      pthread_mutex_lock(&G);
      if (g != gen || dek != t || anf_laden || anf_stopp || anf_springen) continue;
      if (r != 0) {
        if (strcmp(fehler, "abgebrochen") == 0) continue;
        melden("{\"e\":\"fehler\",\"id\":%s,\"text\":%s}", js(j1, sizeof j1, t->id), js(j2, sizeof j2, fehler));
        // weiter mit dem nächsten (falls vorgemerkt), sonst Ende
        Titel *weg = dek; dek = naechst; naechst = NULL; dek_offen = 0; dek_vorgemerkt = dek != NULL;
        if (!dek) { marke_setzen(M_ENDE, weg); ende_geschrieben = 1; }
        frei_ohne_G(weg, NULL, NULL);
        continue;
      }
      dek_offen = 1;
      melden("{\"e\":\"geladen\",\"id\":%s,\"dauer\":%.6f,\"rate\":%d,\"bits\":%d,\"kanaele\":%d}", js(j1, sizeof j1, t->id),
             t->frames_gesamt ? (double)t->frames_gesamt / t->rate : 0.0, t->rate, t->bits, t->kanaele);
      if (t->rate != letzte_rate || t->kanaele != letzte_kan || t->bits != letzte_bits) marke_setzen(M_FORMAT, t);
      dek_marke = w_pos;
      marke_setzen(M_TITEL, t);
      letzte_rate = t->rate; letzte_kan = t->kanaele; letzte_bits = t->bits;
      continue;
    }

    // Platz im Ring? Höchstens ~3 s vorausdekodieren
    size_t kan = (size_t)dek->kanaele;
    uint64_t grenze = (uint64_t)dek->rate * kan * 3;
    if (grenze > RING_KAP - BLOCK_FRAMES * 8) grenze = RING_KAP - BLOCK_FRAMES * 8;
    if (w_pos - r_pos > grenze || n_marken >= MAX_MARKEN - 4) { pthread_cond_wait(&G_dek, &G); continue; }

    Titel *t = dek;
    unsigned g = gen;
    pthread_mutex_unlock(&G);
    uint64_t k = t->wav ? drwav_read_pcm_frames_s32(t->wav, BLOCK_FRAMES, tmp) : drflac_read_pcm_frames_s32(t->flac, BLOCK_FRAMES, tmp);
    int unterbrochen, fehlerhaft;
    pthread_mutex_lock(&t->m);
    unterbrochen = t->abbruch != 0;
    fehlerhaft = t->fehler && !t->fertig;
    snprintf(fehler, sizeof fehler, "%s", t->fehlertext);
    pthread_mutex_unlock(&t->m);
    pthread_mutex_lock(&G);
    if (g != gen || dek != t) continue;            // inzwischen verworfen/ersetzt
    if (unterbrochen && (anf_laden || anf_springen || anf_stopp || anf_vormerken)) continue;
    if (k > 0) {
      size_t n = (size_t)k * kan;
      size_t a = (size_t)(w_pos % RING_KAP), erst = n < RING_KAP - a ? n : RING_KAP - a;
      memcpy(ring + a, tmp, erst * sizeof(int32_t));
      if (n > erst) memcpy(ring, tmp + erst, (n - erst) * sizeof(int32_t));
      w_pos += n;
      t->frame_pos += k;
      pthread_cond_broadcast(&G_aus);
    }
    if (k < BLOCK_FRAMES) {
      if (unterbrochen) continue;
      if (fehlerhaft) melden("{\"e\":\"fehler\",\"id\":%s,\"text\":%s}", js(j1, sizeof j1, t->id), js(j2, sizeof j2, fehler[0] ? fehler : "Download abgebrochen"));
      // Titel zu Ende dekodiert: nahtlos zum vorgemerkten, sonst Ende-Marke
      Titel *weg = vorher;
      vorher = dek;
      if (naechst) { dek = naechst; naechst = NULL; dek_offen = 0; dek_vorgemerkt = 1; }
      else { dek = NULL; dek_offen = 0; dek_vorgemerkt = 0; marke_setzen(M_ENDE, vorher); ende_geschrieben = 1; }
      frei_ohne_G(weg, NULL, NULL);
    }
  }
  pthread_mutex_unlock(&G);
  free(tmp);
  return NULL;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Umwandlung Ring → Geräteformat (Lautstärke, Dither nur wenn nötig)                                              */

static uint32_t zufall = 0x12345678u;
static inline double tpdf(void) {
  zufall ^= zufall << 13; zufall ^= zufall >> 17; zufall ^= zufall << 5;
  double a = (zufall & 0xffff) / 65536.0, b = (zufall >> 16) / 65536.0;
  return a - b;
}

static double vol_ist = 1.0;

// Ein-/Ausblenden bei Start, Pause und Fortsetzen (sample-genau hier, statt Lautstärke-Schritten vom Client):
// Phase 0…1, Faktor = sin(Phase·π/2). Bei Phase 1 ist der Faktor genau 1 → bitgenau bleibt möglich.
static double fade_p = 1.0, fade_s = 0.15;
static int fade_r;                      // +1 einblenden, −1 ausblenden, 0 ruht
static int pause_fade;                  // Pause wird gerade ausgeblendet (spielen bleibt 1, bis das Ausgeblendete gespielt ist)
static int sprung_einblenden;           // nach Spulen/Laden mitten im Titel: die ersten 5 ms einblenden (sonst Knacks)
static double fade_faktor(int rate) {
  if (fade_r) {
    fade_p += fade_r / (fade_s * (rate > 0 ? rate : 48000));
    if (fade_p >= 1) { fade_p = 1; fade_r = 0; } else if (fade_p <= 0) { fade_p = 0; fade_r = 0; }
  }
  return fade_p >= 1 ? 1.0 : fade_p <= 0 ? 0.0 : sin(fade_p * M_PI / 2);
}
/** so viele Frames dauert das Ausblenden noch */
static int fade_rest(int rate) { return (int)ceil(fade_p * fade_s * (rate > 0 ? rate : 48000)); }
static void fade_ein(double ms, int von_null) {
  if (ms <= 0) { fade_p = 1; fade_r = 0; return; }
  if (von_null) fade_p = 0;
  fade_s = ms / 1000.0; fade_r = fade_p < 1 ? 1 : 0;
}

static volatile int korr_an, eq_an;   // eq_an: mindestens ein Kanal-EQ-Band aktiv
#define KORR_AKTIV (korr_an || eq_an)
static void korr_vorbereiten(int rate);
static inline void korr_frame(double *y, int ak);
/** frames aus src (src_kan Kanäle, int32 linksbündig) nach dst im Geräteformat. Rückgabe 1 = bitgenau gewesen */
static int umwandeln(void *dst, const AusInfo *ai, const int32_t *src, int src_kan, int src_bits, int frames, double vol_ziel) {
  int ok_bitgenau = 1;
  int ak = ai->kanaele;
  if (KORR_AKTIV) korr_vorbereiten(ai->rate ? ai->rate : 48000);
  for (int f = 0; f < frames; f++) {
    // Lautstärke gleitet (~5 ms), bei Ziel 1,0 exakt 1,0 → bitgenau
    if (vol_ist != vol_ziel) {
      vol_ist += (vol_ziel - vol_ist) * (1.0 - exp(-1.0 / (0.005 * ai->rate)));
      if (fabs(vol_ist - vol_ziel) < 1e-7) vol_ist = vol_ziel;
    }
    double ff = fade_faktor(ai->rate);
    const int32_t *s = src + (size_t)f * src_kan;
    double x[8];
    // unverändert durchreichen möglich? Auch auf mehr Gerätekanäle (die übrigen bleiben still, Mono auf beide Seiten)
    int roh = vol_ist == 1.0 && ff == 1.0 && ak >= src_kan && !KORR_AKTIV;
    int32_t rohw[8];
    if (roh) for (int c = 0; c < ak; c++) rohw[c] = c < src_kan ? s[c] : (src_kan == 1 && c == 1 ? s[0] : 0);
    else {
      ok_bitgenau = 0;
      // Kanäle zuordnen
      if (src_kan == ak) for (int c = 0; c < ak; c++) x[c] = s[c] / 2147483648.0;
      else if (src_kan == 1) { for (int c = 0; c < ak; c++) x[c] = c < 2 ? s[0] / 2147483648.0 : 0; }
      else if (ak > src_kan) { for (int c = 0; c < ak; c++) x[c] = c < src_kan ? s[c] / 2147483648.0 : 0; }
      else if (ak == 1) { double m = 0; for (int c = 0; c < src_kan; c++) m += s[c]; x[0] = m / src_kan / 2147483648.0; }
      else {
        // Mehrkanal auf Stereo (FL FR FC LFE BL BR SL SR): L = FL + 0,707·(FC + BL + SL), normiert
        double fl = s[0] / 2147483648.0, fr = s[1] / 2147483648.0;
        double fc = src_kan > 2 ? s[2] / 2147483648.0 : 0;
        double bl = src_kan > 4 ? s[4] / 2147483648.0 : 0, br = src_kan > 5 ? s[5] / 2147483648.0 : 0;
        double sl = src_kan > 6 ? s[6] / 2147483648.0 : 0, sr = src_kan > 7 ? s[7] / 2147483648.0 : 0;
        double norm = 1.0 / (1.0 + 0.7071 * (src_kan > 2) + 0.7071 * (src_kan > 4) + 0.7071 * (src_kan > 6));
        x[0] = (fl + 0.7071 * (fc + bl + sl)) * norm;
        x[1] = (fr + 0.7071 * (fc + br + sr)) * norm;
        for (int c = 2; c < ak; c++) x[c] = 0;
      }
      for (int c = 0; c < ak; c++) x[c] *= vol_ist * ff;
      if (KORR_AKTIV) korr_frame(x, ak);
    }
    for (int c = 0; c < ak; c++) {
      switch (ai->fmt) {
        case FMT_F32: {
          float *d = dst;
          d[(size_t)f * ak + c] = roh ? (float)(rohw[c] / 2147483648.0) : (float)x[c];
          if (!roh || src_bits > 24) ok_bitgenau = 0;
          break;
        }
        case FMT_S32: {
          int32_t *d = dst;
          if (roh) d[(size_t)f * ak + c] = rohw[c];
          else { double v = floor(x[c] * 2147483648.0 + 0.5); d[(size_t)f * ak + c] = v > 2147483647.0 ? 2147483647 : v < -2147483648.0 ? (int32_t)-2147483647 - 1 : (int32_t)v; }
          break;
        }
        case FMT_S32_24: case FMT_S24P: {
          int32_t v24;
          if (roh && src_bits <= 24) v24 = rohw[c] >> 8;
          else {
            if (roh) { x[c] = rohw[c] / 2147483648.0; ok_bitgenau = 0; }
            double v = floor(x[c] * 8388608.0 + tpdf() + 0.5);
            v24 = v > 8388607.0 ? 8388607 : v < -8388608.0 ? -8388608 : (int32_t)v;
          }
          if (ai->fmt == FMT_S32_24) ((int32_t *)dst)[(size_t)f * ak + c] = (int32_t)((uint32_t)v24 << 8);
          else { unsigned char *d = (unsigned char *)dst + ((size_t)f * ak + c) * 3; d[0] = (unsigned char)v24; d[1] = (unsigned char)(v24 >> 8); d[2] = (unsigned char)(v24 >> 16); }
          break;
        }
        case FMT_S16: {
          int16_t *d = dst;
          if (roh && src_bits <= 16) d[(size_t)f * ak + c] = (int16_t)(rohw[c] >> 16);
          else {
            if (roh) { x[c] = rohw[c] / 2147483648.0; ok_bitgenau = 0; }
            double v = floor(x[c] * 32768.0 + tpdf() + 0.5);
            d[(size_t)f * ak + c] = (int16_t)(v > 32767.0 ? 32767 : v < -32768.0 ? -32768 : (int)v);
          }
          break;
        }
      }
    }
  }
  return ok_bitgenau;
}

/** float planar (Klangkette) → Geräteformat, mit Lautstärke und Dither (nie bitgenau) */
static void umwandeln_float(void *dst, const AusInfo *ai, float *const *src, int src_kan, int frames, double vol_ziel) {
  int ak = ai->kanaele;
  if (KORR_AKTIV) korr_vorbereiten(ai->rate ? ai->rate : 48000);
  double k = 1.0 - exp(-1.0 / (0.005 * ai->rate));
  for (int f = 0; f < frames; f++) {
    if (vol_ist != vol_ziel) { vol_ist += (vol_ziel - vol_ist) * k; if (fabs(vol_ist - vol_ziel) < 1e-7) vol_ist = vol_ziel; }
    double ff = fade_faktor(ai->rate);
    double x[8];
    if (src_kan == ak) for (int c = 0; c < ak; c++) x[c] = src[c][f];
    else if (src_kan == 1) for (int c = 0; c < ak; c++) x[c] = c < 2 ? src[0][f] : 0;
    else if (ak > src_kan) for (int c = 0; c < ak; c++) x[c] = c < src_kan ? src[c][f] : 0;
    else if (ak == 1) { double m = 0; for (int c = 0; c < src_kan; c++) m += src[c][f]; x[0] = m / src_kan; }
    else {
      double fl = src[0][f], fr = src[1][f], fc = src_kan > 2 ? src[2][f] : 0;
      double bl = src_kan > 4 ? src[4][f] : 0, br = src_kan > 5 ? src[5][f] : 0, sl = src_kan > 6 ? src[6][f] : 0, sr = src_kan > 7 ? src[7][f] : 0;
      double norm = 1.0 / (1.0 + 0.7071 * (src_kan > 2) + 0.7071 * (src_kan > 4) + 0.7071 * (src_kan > 6));
      x[0] = (fl + 0.7071 * (fc + bl + sl)) * norm; x[1] = (fr + 0.7071 * (fc + br + sr)) * norm;
      for (int c = 2; c < ak; c++) x[c] = 0;
    }
    for (int c = 0; c < ak; c++) x[c] *= vol_ist * ff;
    if (KORR_AKTIV) korr_frame(x, ak);
    for (int c = 0; c < ak; c++) {
      double v0 = x[c];
      switch (ai->fmt) {
        case FMT_F32: ((float *)dst)[(size_t)f * ak + c] = (float)v0; break;
        case FMT_S32: { double v = floor(v0 * 2147483648.0 + 0.5); ((int32_t *)dst)[(size_t)f * ak + c] = v > 2147483647.0 ? 2147483647 : v < -2147483648.0 ? (int32_t)-2147483647 - 1 : (int32_t)v; break; }
        case FMT_S32_24: case FMT_S24P: {
          double v = floor(v0 * 8388608.0 + tpdf() + 0.5);
          int32_t v24 = v > 8388607.0 ? 8388607 : v < -8388608.0 ? -8388608 : (int32_t)v;
          if (ai->fmt == FMT_S32_24) ((int32_t *)dst)[(size_t)f * ak + c] = (int32_t)((uint32_t)v24 << 8);
          else { unsigned char *d = (unsigned char *)dst + ((size_t)f * ak + c) * 3; d[0] = (unsigned char)v24; d[1] = (unsigned char)(v24 >> 8); d[2] = (unsigned char)(v24 >> 16); }
          break;
        }
        case FMT_S16: { double v = floor(v0 * 32768.0 + tpdf() + 0.5); ((int16_t *)dst)[(size_t)f * ak + c] = (int16_t)(v > 32767.0 ? 32767 : v < -32768.0 ? -32768 : (int)v); break; }
      }
    }
  }
}

static float *planar[8];
static int planar_kap;
static void planar_fuellen(const int32_t *src, int kan, int frames) {
  if (planar_kap < frames) { for (int c = 0; c < 8; c++) { free(planar[c]); planar[c] = malloc(sizeof(float) * (size_t)frames); } planar_kap = frames; }
  for (int c = 0; c < kan && c < 8; c++) for (int f = 0; f < frames; f++) planar[c][f] = (float)(src[(size_t)f * kan + c] / 2147483648.0);
}


/* ---------- Ausgangs-Korrektur: Delay und Pegel je Kanal (Lautsprecher-Manager), Crossfeed (Kopfhörer) ----------
 * Kanäle in Engine-Reihenfolge (Stereo L R, Quadro L R Ls Rs, 5.1 L R C LFE Ls Rs; mit Sub hinten LFE). Delay gleicht
 * unterschiedliche Abstände zum Hörplatz aus (der weiteste Lautsprecher 0 ms), Pegel in dB (vom Client schon so
 * gesenkt, dass keiner über 0 dB liegt). Crossfeed mischt dem anderen Ohr die Tiefen leicht verzögert bei (wie bei
 * Lautsprechern) – Mono bleibt dabei unverändert. Ist alles neutral, bleibt der Weg bitgenau. */
#define KORR_RING 16384
static volatile int korr_gen, korr_cf;
static double korr_delay_ms[8], korr_gain_db[8];
static struct {
  int gen, rate, d[8], cf, cf_d; double g[8], cf_a, cf_g, lp[2];
  float *ring[8], *cfr[2]; int pos;
} KS;
/* ---------- Kanal-EQ (Lautsprecher-Manager) ----------
 * Je Ausgangskanal (Engine-Reihenfolge, hinter Bassmanagement) bis zu 8 Bänder: Bell, Low-/High-Shelf,
 * Hoch-/Tiefpass (Butterworth 6–48 dB/Okt.). Biquads in double (RBJ-Cookbook, Direktform II transponiert). Änderungen laufen
 * über ~20 ms geglättete Koeffizienten, damit beim Ziehen nichts knackt. Parameter je Kanal (Liste): [Kanal an, dann je Band:
 * an, Typ (0 Bell, 1 Low-Shelf, 2 High-Shelf, 3 Hochpass, 4 Tiefpass), Frequenz Hz, Gain dB, Q, Flanke dB/Okt.]. */
#define EQ_B 8
#define EQ_S 4
#define EQ_N (1 + 6 * EQ_B)
typedef struct { double c[5], t[5], s[5], z1, z2; int ramp; } EqSek;   /* c = b0 b1 b2 a1 a2 (a0 = 1) */
static double eq_ziel[8][EQ_N];
static volatile unsigned eq_seq;
static volatile int eq_gen;
static struct { int gen, rate; EqSek sek[8][EQ_B * EQ_S]; unsigned char liste[8][EQ_B * EQ_S]; int n[8]; } ES;

static void eq_setzen(int k, const double *l, int n) {
  if (k < 0 || k >= 8) return;
  eq_seq++; __sync_synchronize();
  for (int i = 0; i < EQ_N; i++) eq_ziel[k][i] = (l && i < n) ? l[i] : 0;
  __sync_synchronize(); eq_seq++;
  int an = 0;
  for (int c = 0; c < 8; c++) if (eq_ziel[c][0] != 0) for (int b = 0; b < EQ_B; b++) if (eq_ziel[c][1 + 6 * b] != 0) an = 1;
  eq_an = an;
  eq_gen++;
}
static const double EQ_ID[5] = { 1, 0, 0, 0, 0 };
static void eq_norm(double *o, double b0, double b1, double b2, double a0, double a1, double a2) { o[0] = b0 / a0; o[1] = b1 / a0; o[2] = b2 / a0; o[3] = a1 / a0; o[4] = a2 / a0; }
/** Koeffizienten eines Bandes: bis zu EQ_S Sektionen in o[s][5], Rückgabe = Anzahl (0 = neutral) */
static int eq_band(double o[EQ_S][5], int typ, double f, double g, double q, int flanke, int rate) {
  double fmax = rate * 0.49; if (f > fmax) f = fmax; if (f < 10) f = 10;
  if (q < 0.1) q = 0.1; if (q > 30) q = 30;
  double w0 = 2 * M_PI * f / rate, cs = cos(w0), sn = sin(w0);
  if (typ == 0) {
    if (fabs(g) < 0.005) return 0;
    double A = pow(10.0, g / 40.0), al = sn / (2 * q);
    eq_norm(o[0], 1 + al * A, -2 * cs, 1 - al * A, 1 + al / A, -2 * cs, 1 - al / A); return 1;
  }
  if (typ == 1 || typ == 2) {
    if (fabs(g) < 0.005) return 0;
    double A = pow(10.0, g / 40.0), al = sn / (2 * q), sa = 2 * sqrt(A) * al;
    if (typ == 1) eq_norm(o[0], A * ((A + 1) - (A - 1) * cs + sa), 2 * A * ((A - 1) - (A + 1) * cs), A * ((A + 1) - (A - 1) * cs - sa),
                          (A + 1) + (A - 1) * cs + sa, -2 * ((A - 1) + (A + 1) * cs), (A + 1) + (A - 1) * cs - sa);
    else eq_norm(o[0], A * ((A + 1) + (A - 1) * cs + sa), -2 * A * ((A - 1) + (A + 1) * cs), A * ((A + 1) + (A - 1) * cs - sa),
                 (A + 1) - (A - 1) * cs + sa, 2 * ((A - 1) - (A + 1) * cs), (A + 1) - (A - 1) * cs - sa);
    return 1;
  }
  if (typ == 3 || typ == 4) {
    int hoch = typ == 3, n = flanke / 6; if (n < 1) n = 1; if (n > 8) n = 8;
    int ns = 0;
    for (int k = 1; k <= n / 2 && ns < EQ_S; k++) {
      double qk = n == 2 ? q : 1.0 / (2 * sin(M_PI * (2 * k - 1) / (2.0 * n))), al = sn / (2 * qk);
      if (hoch) eq_norm(o[ns], (1 + cs) / 2, -(1 + cs), (1 + cs) / 2, 1 + al, -2 * cs, 1 - al);
      else eq_norm(o[ns], (1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + al, -2 * cs, 1 - al);
      ns++;
    }
    if ((n & 1) && ns < EQ_S) {   /* ungerade Ordnung: eine Sektion 1. Ordnung (bilinear) */
      double K = tan(w0 / 2);
      if (hoch) { o[ns][0] = 1 / (1 + K); o[ns][1] = -1 / (1 + K); } else { o[ns][0] = K / (1 + K); o[ns][1] = K / (1 + K); }
      o[ns][2] = 0; o[ns][3] = (K - 1) / (1 + K); o[ns][4] = 0; ns++;
    }
    return ns;
  }
  return 0;
}
static void eq_vorbereiten(int rate) {
  if (ES.gen == eq_gen && ES.rate == rate) return;
  int gen = eq_gen;
  double z[8][EQ_N]; unsigned sq;
  do { sq = eq_seq; __sync_synchronize(); memcpy(z, eq_ziel, sizeof z); __sync_synchronize(); } while ((sq & 1) || sq != eq_seq);
  int snap = ES.rate != rate;
  int ramp = (int)(0.02 * rate); if (ramp < 1) ramp = 1;
  for (int c = 0; c < 8; c++) {
    int n = 0;
    for (int b = 0; b < EQ_B; b++) {
      double o[EQ_S][5]; int ns = 0;
      const double *p = &z[c][1 + 6 * b];
      if (z[c][0] != 0 && p[0] != 0) ns = eq_band(o, (int)p[1], p[2], p[3], p[4], (int)p[5], rate);
      for (int s = 0; s < EQ_S; s++) {
        EqSek *e = &ES.sek[c][b * EQ_S + s];
        memcpy(e->t, s < ns ? o[s] : EQ_ID, sizeof e->t);
        if (snap) { memcpy(e->c, e->t, sizeof e->c); e->ramp = 0; e->z1 = e->z2 = 0; }
        else { for (int i = 0; i < 5; i++) e->s[i] = (e->t[i] - e->c[i]) / ramp; e->ramp = memcmp(e->c, e->t, sizeof e->c) ? ramp : 0; }
        if (memcmp(e->c, EQ_ID, sizeof e->c) || memcmp(e->t, EQ_ID, sizeof e->t)) ES.liste[c][n++] = (unsigned char)(b * EQ_S + s);
      }
    }
    ES.n[c] = n;
  }
  ES.rate = rate; ES.gen = gen;
}
static inline double eq_kanal(int c, double x) {
  for (int i = 0; i < ES.n[c]; i++) {
    EqSek *e = &ES.sek[c][ES.liste[c][i]];
    if (e->ramp > 0) { for (int k = 0; k < 5; k++) e->c[k] += e->s[k]; if (--e->ramp == 0) memcpy(e->c, e->t, sizeof e->c); }
    double y = e->c[0] * x + e->z1;
    e->z1 = e->c[1] * x - e->c[3] * y + e->z2;
    e->z2 = e->c[2] * x - e->c[4] * y;
    if (fabs(e->z1) < 1e-20) e->z1 = 0;
    if (fabs(e->z2) < 1e-20) e->z2 = 0;
    x = y;
  }
  return x;
}

static void korr_vorbereiten(int rate) {
  eq_vorbereiten(rate);
  if (KS.gen == korr_gen && KS.rate == rate) return;
  KS.gen = korr_gen; KS.rate = rate;
  for (int c = 0; c < 8; c++) {
    if (!KS.ring[c]) KS.ring[c] = calloc(KORR_RING, sizeof(float));
    double ms = korr_delay_ms[c] < 0 ? 0 : korr_delay_ms[c] > 60 ? 60 : korr_delay_ms[c];
    int d = (int)lround(ms / 1000.0 * rate);
    KS.d[c] = d > KORR_RING - 1 ? KORR_RING - 1 : d;
    double db = korr_gain_db[c] < -60 ? -60 : korr_gain_db[c] > 12 ? 12 : korr_gain_db[c];
    KS.g[c] = korr_gain_db[c] <= -60 ? 0.0 : pow(10.0, db / 20.0);
  }
  for (int i = 0; i < 2; i++) if (!KS.cfr[i]) KS.cfr[i] = calloc(KORR_RING, sizeof(float));
  /* Crossfeed: 1 leicht (−6 dB, 700 Hz), 2 mittel (−4,5 dB, 700 Hz), 3 stark (−3 dB, 650 Hz); 0,3 ms Laufzeit ums Kopf */
  KS.cf = korr_cf;
  double fc = korr_cf == 3 ? 650 : 700, db = korr_cf == 1 ? -6 : korr_cf == 2 ? -4.5 : -3;
  KS.cf_a = exp(-2 * M_PI * fc / rate);
  KS.cf_g = pow(10.0, db / 20.0);
  KS.cf_d = (int)lround(0.0003 * rate);
}
/** y: ak Kanäle eines Frames (float, nach Lautstärke) – Korrektur an Ort und Stelle */
static inline void korr_frame(double *y, int ak) {
  int p = KS.pos, m = KORR_RING - 1;
  if (KS.cf && ak >= 2) {
    double l = y[0], r = y[1];
    KS.lp[0] = l + (KS.lp[0] - l) * KS.cf_a;
    KS.lp[1] = r + (KS.lp[1] - r) * KS.cf_a;
    KS.cfr[0][p] = (float)KS.lp[0]; KS.cfr[1][p] = (float)KS.lp[1];
    double vl = KS.cfr[0][(p - KS.cf_d) & m], vr = KS.cfr[1][(p - KS.cf_d) & m];
    /* eigene Tiefen etwas raus, die des anderen Ohrs (verzögert) rein: Mitte bleibt, harte Stereo-Seiten werden weicher */
    y[0] = l + KS.cf_g * (vr - KS.lp[0]);
    y[1] = r + KS.cf_g * (vl - KS.lp[1]);
  }
  if (eq_an) for (int c = 0; c < ak && c < 8; c++) if (ES.n[c]) y[c] = eq_kanal(c, y[c]);
  for (int c = 0; c < ak && c < 8; c++) {
    if (!KS.d[c] && KS.g[c] == 1.0) continue;
    KS.ring[c][p] = (float)y[c];
    y[c] = (KS.d[c] ? KS.ring[c][(p - KS.d[c]) & m] : y[c]) * KS.g[c];
  }
  KS.pos = (p + 1) & m;
}

/* ---------- Bassmanagement (Subwoofer): Linkwitz-Riley 24 dB/Okt., Hauptlautsprecher Hochpass, Sub Tiefpass + Delay ----------
 * Layout: 2 = Stereo + Sub (L R LFE), 4 = Quadro + Sub (L R Ls Rs LFE), 6 = 5.1 (L R C LFE Ls Rs, LFE der Quelle bleibt)
 * Delay > 0 verzögert den Sub, < 0 die Hauptlautsprecher. Gesetzt vom Befehlsfaden, gerechnet im Ausgabefaden. */
static volatile int bass_an, bass_layout = 2, bass_gen, bass_phase;
static volatile double bass_hz = 80, bass_delay_ms = 0;
typedef struct { double b0, b1, b2, a1, a2; } BqK;
typedef struct { double z1, z2; } BqZ;
#define BASS_RING 65536
static struct {
  int gen, rate;
  BqK hp, lp;
  BqZ hz[6][2], lz[2];
  float *ring[7]; int pos, d_sub, d_main;
} BS;
static void bq_rechnen(BqK *k, int hoch, double f, double rate) {
  double w = 2 * M_PI * f / rate, cw = cos(w), al = sin(w) / (2 * 0.7071067811865476), a0 = 1 + al;
  if (hoch) { k->b0 = (1 + cw) / 2; k->b1 = -(1 + cw); k->b2 = (1 + cw) / 2; }
  else { k->b0 = (1 - cw) / 2; k->b1 = 1 - cw; k->b2 = (1 - cw) / 2; }
  k->a1 = -2 * cw; k->a2 = 1 - al;
  k->b0 /= a0; k->b1 /= a0; k->b2 /= a0; k->a1 /= a0; k->a2 /= a0;
}
static inline double bq(const BqK *k, BqZ *z, double x) {   /* transponierte Direktform II */
  double y = k->b0 * x + z->z1;
  z->z1 = k->b1 * x - k->a1 * y + z->z2;
  z->z2 = k->b2 * x - k->a2 * y;
  return y;
}
/** Ausgangskanäle, die das Bassmanagement braucht (0 = aus) */
static int bass_kanaele(void) { return bass_an ? (bass_layout == 2 ? 3 : bass_layout == 4 ? 5 : 6) : 0; }
static void bass_vorbereiten(int rate) {
  if (BS.gen == bass_gen && BS.rate == rate) return;
  int neu_rate = BS.rate != rate;
  BS.gen = bass_gen; BS.rate = rate;
  double f = bass_hz < 20 ? 20 : bass_hz > 300 ? 300 : bass_hz;
  bq_rechnen(&BS.hp, 1, f, rate); bq_rechnen(&BS.lp, 0, f, rate);
  if (neu_rate) memset(BS.hz, 0, sizeof BS.hz), memset(BS.lz, 0, sizeof BS.lz);
  for (int c = 0; c < 7; c++) if (!BS.ring[c]) BS.ring[c] = calloc(BASS_RING, sizeof(float));
  int d = (int)lround(fabs(bass_delay_ms) / 1000.0 * rate);
  if (d > BASS_RING - 1) d = BASS_RING - 1;
  BS.d_sub = bass_delay_ms > 0 ? d : 0; BS.d_main = bass_delay_ms < 0 ? d : 0;
}
/** x: Kanäle im Layout ohne eigenen Sub (Stereo 2, Quadro 4) bzw. 5.1 (6); y: ak Gerätekanäle */
static void bass_frame(const double *x, double *y, int ak) {
  int L = bass_layout, nm = L == 6 ? 5 : L, sub_i = L == 6 ? 3 : L;
  double m[6], summe = 0;
  for (int i = 0, j = 0; i < (L == 6 ? 6 : L); i++) { if (L == 6 && i == 3) continue; m[j] = x[i]; summe += x[i]; j++; }
  double s = bq(&BS.lp, &BS.lz[1], bq(&BS.lp, &BS.lz[0], summe / sqrt((double)nm)));
  if (L == 6) s += x[3];   /* LFE der Quelle: kommt schon tief gefiltert */
  if (bass_phase) s = -s;   /* Phase invertiert (180°) */
  int p = BS.pos;
  BS.ring[6][p] = (float)s;
  double sub = BS.ring[6][(p - BS.d_sub + BASS_RING) % BASS_RING];
  for (int c = 0; c < ak; c++) y[c] = 0;
  for (int i = 0, j = 0; i < 6 && j < nm; i++) {
    if (L == 6 && i == 3) continue;
    double h = bq(&BS.hp, &BS.hz[j][1], bq(&BS.hp, &BS.hz[j][0], m[j]));
    BS.ring[j][p] = (float)h;
    double v = BS.ring[j][(p - BS.d_main + BASS_RING) % BASS_RING];
    int ziel = L == 6 ? i : j;
    if (ziel < ak) y[ziel] = v;
    j++;
  }
  if (sub_i < ak) y[sub_i] = sub;
  BS.pos = (p + 1) % BASS_RING;
}

/** float planar → Geräteformat mit Bassmanagement (Haupt-Layout zuordnen wie sonst, dann Weiche + Delay) */
static void umwandeln_bass(void *dst, const AusInfo *ai, float *const *src, int src_kan, int frames, double vol_ziel) {
  int ak = ai->kanaele, L = bass_layout, am = L == 6 ? 6 : L;
  bass_vorbereiten(ai->rate ? ai->rate : 48000);
  if (KORR_AKTIV) korr_vorbereiten(ai->rate ? ai->rate : 48000);
  double k = 1.0 - exp(-1.0 / (0.005 * ai->rate));
  for (int f = 0; f < frames; f++) {
    if (vol_ist != vol_ziel) { vol_ist += (vol_ziel - vol_ist) * k; if (fabs(vol_ist - vol_ziel) < 1e-7) vol_ist = vol_ziel; }
    double ff = fade_faktor(ai->rate);
    double x[8] = {0}, y[8];
    if (src_kan == am) for (int c = 0; c < am; c++) x[c] = src[c][f];
    else if (src_kan == 1) { x[0] = x[1] = src[0][f]; }
    else if (src_kan == 2) { x[0] = src[0][f]; x[1] = src[1][f]; }
    else if (L == 2 || (L == 4 && src_kan > 4)) {
      double fl = src[0][f], fr = src[1][f], fc = src_kan > 2 ? src[2][f] : 0, lfe = src_kan > 3 ? src[3][f] : 0;
      double bl = src_kan > 4 ? src[4][f] : 0, br = src_kan > 5 ? src[5][f] : 0, sl = src_kan > 6 ? src[6][f] : 0, sr = src_kan > 7 ? src[7][f] : 0;
      if (L == 2) {
        double norm = 1.0 / (1.0 + 0.7071 * (src_kan > 2) + 0.7071 * (src_kan > 4) + 0.7071 * (src_kan > 6));
        x[0] = (fl + 0.7071 * (fc + bl + sl) + 0.5 * lfe) * norm; x[1] = (fr + 0.7071 * (fc + br + sr) + 0.5 * lfe) * norm;
      } else { x[0] = fl + 0.7071 * fc + 0.5 * lfe; x[1] = fr + 0.7071 * fc + 0.5 * lfe; x[2] = bl + sl; x[3] = br + sr; }
    } else for (int c = 0; c < am && c < src_kan; c++) x[c] = src[c][f];
    bass_frame(x, y, ak);
    for (int c = 0; c < ak; c++) y[c] *= vol_ist * ff;
    if (KORR_AKTIV) korr_frame(y, ak);
    for (int c = 0; c < ak; c++) {
      double v0 = y[c];
      switch (ai->fmt) {
        case FMT_F32: ((float *)dst)[(size_t)f * ak + c] = (float)v0; break;
        case FMT_S32: { double v = floor(v0 * 2147483648.0 + 0.5); ((int32_t *)dst)[(size_t)f * ak + c] = v > 2147483647.0 ? 2147483647 : v < -2147483648.0 ? (int32_t)-2147483647 - 1 : (int32_t)v; break; }
        case FMT_S32_24: case FMT_S24P: {
          double v = floor(v0 * 8388608.0 + tpdf() + 0.5);
          int32_t v24 = v > 8388607.0 ? 8388607 : v < -8388608.0 ? -8388608 : (int32_t)v;
          if (ai->fmt == FMT_S32_24) ((int32_t *)dst)[(size_t)f * ak + c] = (int32_t)((uint32_t)v24 << 8);
          else { unsigned char *d = (unsigned char *)dst + ((size_t)f * ak + c) * 3; d[0] = (unsigned char)v24; d[1] = (unsigned char)(v24 >> 8); d[2] = (unsigned char)(v24 >> 16); }
          break;
        }
        case FMT_S16: { double v = floor(v0 * 32768.0 + tpdf() + 0.5); ((int16_t *)dst)[(size_t)f * ak + c] = (int16_t)(v > 32767.0 ? 32767 : v < -32768.0 ? -32768 : (int)v); break; }
      }
    }
  }
}

/**
 * Ein Stück Ring ins Gerät: Klangkette an → float (Kette, Angleich, Lautstärke, Dither); sonst der ganzzahlige Weg
 * (bitgenau, solange Lautstärke × Angleich = 1). Abgriffe für Meter laufen in beiden Fällen mit. Rückgabe: bitgenau?
 */
static int stueck_ausgeben(void *dst, const AusInfo *ai, const int32_t *src, int kan, int bits, int frames) {
  int kk = kan > 8 ? 8 : kan;
  if (gain_sprung) { gain_sprung = 0; gain_ist = gain_ziel; vol_ist = lautstaerke * gain_ziel; }
  // Subwoofer/Bassmanagement an und das Gerät hat die Kanäle dafür: immer der float-Weg
  if (bass_an && ai->kanaele >= bass_kanaele()) {
    planar_fuellen(src, kan, frames);
    int ak = kk;
    if (klang_aktiv()) ak = klang_rechnen(planar, kk, frames, &gain_ist, gain_ziel, 1.0 - exp(-1.0 / (0.01 * (ai->rate ? ai->rate : 48000))));
    else { gain_ist = gain_ziel; if (klang_abgriffe_an()) klang_nur_abgreifen(planar, kk, frames, gain_ziel); }
    umwandeln_bass(dst, ai, planar, ak, frames, lautstaerke * (klang_aktiv() ? 1.0 : gain_ziel));
    return 0;
  }
  if (klang_aktiv()) {
    planar_fuellen(src, kan, frames);
    int ak = klang_rechnen(planar, kk, frames, &gain_ist, gain_ziel, 1.0 - exp(-1.0 / (0.01 * (ai->rate ? ai->rate : 48000))));
    umwandeln_float(dst, ai, planar, ak, frames, lautstaerke);
    return 0;
  }
  gain_ist = gain_ziel;
  if (klang_abgriffe_an()) { planar_fuellen(src, kan, frames); klang_nur_abgreifen(planar, kk, frames, gain_ziel); }
  return umwandeln(dst, ai, src, kan, bits, frames, lautstaerke * gain_ziel);
}

static int fmt_bytes(AusFormat f) { return f == FMT_S16 ? 2 : f == FMT_S24P ? 3 : 4; }
static const char *fmt_name(AusFormat f) {
  switch (f) { case FMT_S16: return "16 Bit"; case FMT_S24P: return "24 Bit"; case FMT_S32_24: return "24 Bit (in 32)"; case FMT_S32: return "32 Bit"; default: return "32 Bit Float"; }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Ausgabe-Thread                                                                                                 */

typedef struct { uint64_t dev_frame; char id[64]; uint64_t start_frame; int rate; double dauer; uint64_t stille; } Abschnitt;

typedef struct {
  Abschnitt ab[16]; int n_ab;
  int ende_offen; uint64_t ende_frame; char ende_id[64];
  int format_wartet; Marke format_m; uint64_t format_ende;
  // feste Ausgaberate: Formatwechsel gehen nahtlos (Gerät und Ausgabe laufen weiter)
  Geraet *dev; AusInfo *ai; int *q_rate, *q_bits, *q_kan; int *bitgenau_gemeldet;
} AusZustand;

static void format_melden(const AusInfo *ai, int q_rate, int q_bits, int q_kan) {
  char j1[300], j2[600], j3[300];
  melden("{\"e\":\"format\",\"rate\":%d,\"bits\":%d,\"kanaele\":%d,\"aus_rate\":%d,\"geraet_rate\":%d,\"aus_kanaele\":%d,\"geraet_kanaele\":%d,\"aus_format\":%s,\"exklusiv\":%s,\"asio\":%s,\"umgerechnet\":%s,\"latenz\":%d,\"geraet\":%s,\"hinweis\":%s}",
         q_rate, q_bits, q_kan, ai->umgerechnet ? ai->geraet_rate : ai->rate, ai->geraet_rate ? ai->geraet_rate : ai->rate, ai->kanaele, ai->geraet_kanaele ? ai->geraet_kanaele : ai->kanaele,
         js(j3, sizeof j3, fmt_name(ai->umgerechnet ? ai->fmt_geraet : ai->fmt)), ai->exklusiv ? "true" : "false", ai->asio ? "true" : "false", ai->umgerechnet ? "true" : "false", ai->latenz,
         js(j1, sizeof j1, ai->geraet), js(j2, sizeof j2, ai->hinweis));
}

/** Marken an der Leseposition abarbeiten (unter G); dev_frame = Geräte-Frame, an dem r_pos landet. 1 = hier anhalten */
static int marken_abarbeiten(AusZustand *z, uint64_t dev_frame, int hat_geraet, int q_rate, int q_kan, int q_bits) {
  while (!z->format_wartet && n_marken > 0 && marken[0].pos <= r_pos) {
    Marke m = marken[0];
    memmove(marken, marken + 1, sizeof(Marke) * (size_t)(--n_marken));
    if (m.typ == M_FORMAT) {
      if (!hat_geraet || m.rate != q_rate || m.kanaele != q_kan || m.bits != q_bits) {
        // feste Ausgaberate und gleiche Kanäle: nur die Umrechnung wechseln, ohne Pause
        double t_nahtlos = jetzt_s();
        if (hat_geraet && z->dev && ger_fest(z->dev) && m.kanaele == q_kan && ger_nahtlos(z->dev, m.rate, m.bits, z->ai) == 0) {
          melden("{\"e\":\"formatwechsel\",\"art\":\"nahtlos\",\"von\":%d,\"nach\":%d,\"bits\":%d,\"ms\":%.1f}", q_rate, m.rate, m.bits, (jetzt_s() - t_nahtlos) * 1000.0);
          *z->q_rate = q_rate = m.rate; *z->q_bits = q_bits = m.bits;
          klang_format(m.rate, q_kan > 8 ? 8 : q_kan);
          *z->bitgenau_gemeldet = -1;
          format_melden(z->ai, m.rate, m.bits, q_kan);
          continue;
        }
        z->format_wartet = 1; z->format_m = m; z->format_ende = dev_frame; return 1;
      }
    } else if (m.typ == M_TITEL) {
      if (z->n_ab == 16) { memmove(z->ab, z->ab + 1, sizeof(Abschnitt) * 15); z->n_ab = 15; }
      Abschnitt *a = &z->ab[z->n_ab++];
      a->dev_frame = dev_frame; snprintf(a->id, sizeof a->id, "%s", m.id); a->start_frame = m.start_frame; a->rate = m.rate; a->dauer = m.dauer; a->stille = 0;
      gain_ziel = m.gain > 0 ? m.gain : 1; snprintf(gain_id, sizeof gain_id, "%s", m.id); gain_sprung = 1;
    } else if (m.typ == M_ENDE) {
      z->ende_offen = 1; z->ende_frame = dev_frame; snprintf(z->ende_id, sizeof z->ende_id, "%s", m.id);
      return 1;
    }
  }
  return z->format_wartet;
}

/** Gerät neu: der laufende Abschnitt beginnt auf dem neuen Gerät bei Frame 0 an der Stelle, bis zu der geschrieben war */
static void abschnitte_neu_basieren(Abschnitt *ab, int *n_ab, uint64_t dev_w, int *ende_offen, uint64_t *ende_frame) {
  if (*n_ab > 0) {
    Abschnitt a = ab[*n_ab - 1];
    uint64_t im = dev_w > a.dev_frame + a.stille ? dev_w - a.dev_frame - a.stille : 0;
    a.start_frame += im; a.dev_frame = 0; a.stille = 0;
    ab[0] = a; *n_ab = 1;
  }
  if (*ende_offen) *ende_frame = 0;
}

static void *kanaele_thread(void *arg) {
  char *g = arg;
  char *buf = malloc(16384), fehler[300] = "", j1[600], j2[400];
  int ok = asio_kanal_namen(g + 5, buf, 16384, fehler, sizeof fehler) == 0;
  if (ok) melden("{\"e\":\"asio_kanaele\",\"geraet\":%s,\"namen\":%s}", js(j1, sizeof j1, g), buf);
  else melden("{\"e\":\"asio_kanaele\",\"geraet\":%s,\"fehler\":%s}", js(j1, sizeof j1, g), js(j2, sizeof j2, fehler[0] ? fehler : "geht nicht"));
  free(buf); free(g);
  return NULL;
}

/** ein Sample (−1…1) im Format f schreiben */
static void sample_setzen(unsigned char *p, AusFormat f, double v) {
  switch (f) {
    case FMT_S16: { int16_t s = (int16_t)lrint(v * 32767.0); memcpy(p, &s, 2); break; }
    case FMT_S24P: { int32_t s = (int32_t)lrint(v * 8388607.0); p[0] = (unsigned char)s; p[1] = (unsigned char)(s >> 8); p[2] = (unsigned char)(s >> 16); break; }
    case FMT_S32_24: { int32_t s = (int32_t)((uint32_t)(int32_t)lrint(v * 8388607.0) << 8); memcpy(p, &s, 4); break; }
    case FMT_S32: { int32_t s = (int32_t)llrint(v * 2147483647.0); memcpy(p, &s, 4); break; }
    default: { float x = (float)v; memcpy(p, &x, 4); break; }
  }
}
static int fmt_groesse(AusFormat f) { return f == FMT_S16 ? 2 : f == FMT_S24P ? 3 : 4; }

/**
 * Testton: rosa Rauschen, −20 dBFS (RMS), ms lang mit 20 ms Rampen, auf allen Kanälen des Geräts d (beim Testton ist das
 * genau ein Ausgang des Treibers). Bricht ab, sobald wieder gespielt wird. Läuft ohne G.
 */
static void testton_spielen(Geraet *d, const AusInfo *ti, int ms) {
  ger_zuruecksetzen(d);
  int rate = ti->rate > 0 ? ti->rate : 48000, kan = ti->kanaele > 0 ? ti->kanaele : 1, fb = fmt_groesse(ti->fmt);
  int64_t gesamt = (int64_t)rate * ms / 1000, rampe = rate / 50, ende = gesamt + rate / 10, w = 0;
  double b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  uint32_t z = 0x1234567u;
  int gestartet = 0;
  double bis = jetzt_s() + ms / 1000.0 + 3;
  while (w < ende && jetzt_s() < bis) {
    if (spielen || beenden) break;
    ger_warten(d, 20);
    int f = ger_frei(d);
    if (f <= 0) { if (!gestartet) { ger_start(d); gestartet = 1; } continue; }
    if (f > 4096) f = 4096;
    unsigned char *p = ger_puffer(d, f);
    if (!p) break;
    for (int i = 0; i < f; i++, w++) {
      double v = 0;
      if (w < gesamt) {
        // weißes Rauschen (gleichverteilt) durch Paul Kellets Filter → rosa; Faktor so, dass RMS ≈ 0,1 (−20 dBFS)
        z = z * 1664525u + 1013904223u;
        double x = ((z >> 8) / 8388608.0 - 1.0);
        b0 = 0.99886 * b0 + x * 0.0555179; b1 = 0.99332 * b1 + x * 0.0750759; b2 = 0.96900 * b2 + x * 0.1538520;
        b3 = 0.86650 * b3 + x * 0.3104856; b4 = 0.55000 * b4 + x * 0.5329522; b5 = -0.7616 * b5 - x * 0.0168980;
        double rosa = b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362; b6 = x * 0.115926;
        double g = 1;
        if (w < rampe) g = (double)w / rampe; else if (gesamt - w < rampe) g = (double)(gesamt - w) / rampe;
        v = rosa * 0.0526 * g;
        if (v > 0.99) v = 0.99; else if (v < -0.99) v = -0.99;
      }
      for (int c = 0; c < kan; c++) sample_setzen(p + ((size_t)i * kan + c) * fb, ti->fmt, v);
    }
    ger_puffer_fertig(d, f);
    if (!gestartet) { ger_start(d); gestartet = 1; }
  }
  while (gestartet && !spielen && !beenden && ger_gespielt(d) < gesamt && jetzt_s() < bis) ger_warten(d, 20);
  ger_ausklingen(d, 10);
  ger_stopp(d);
  ger_zuruecksetzen(d);
}

/** Testton-Anfrage abarbeiten (unter G aufgerufen, gibt G zwischendurch frei). Danach öffnet die Wiedergabe neu bzw. leitet um */
static void testton_ablauf(Geraet **devp, int *laeuft, int *anlauf, AusInfo *ai, AusZustand *Z, uint64_t *dev_w) {
  ton_anf = 0;
  char tg[512], j1[300], j2[400]; snprintf(tg, sizeof tg, "%s", ton_geraet);
  int ms = ton_ms;
  if (strncmp(tg, "asio:", 5)) { melden("{\"e\":\"testton\",\"geraet\":%s,\"fehler\":\"Testton gibt es nur für ASIO\"}", js(j1, sizeof j1, tg)); return; }
  if (spielen) { melden("{\"e\":\"testton\",\"geraet\":%s,\"fehler\":\"Erst die Wiedergabe anhalten\"}", js(j1, sizeof j1, tg)); return; }
  Geraet *alt = *devp; int lief = *laeuft;
  int q_rate = *Z->q_rate, q_bits = *Z->q_bits;
  int rate = alt && ai->rate ? ai->rate : q_rate ? q_rate : 48000;
  *devp = NULL; *laeuft = 0; *anlauf = 0;
  int gleich = alt && asio_gleicher_treiber(tg, geraet_offen) && ger_fest_rate(alt) == fest_rate;
  pthread_mutex_unlock(&G);
  char fehler[300] = ""; AusInfo ti; memset(&ti, 0, sizeof ti);
  Geraet *d = NULL;
  if (alt) { if (lief) ger_ausklingen(alt, 10); ger_stopp(alt); }
  if (gleich && ger_umleiten(alt, tg) >= 0 && ger_umstellen(alt, rate, 1, 24, &ti, fehler, sizeof fehler) == 0) { d = alt; alt = NULL; }
  if (alt) ger_schliessen(alt);
  fehler[0] = 0;
  if (!d) d = ger_oeffnen(tg, 1, rate, 1, 24, fest_rate, &ti, fehler, sizeof fehler);
  if (d) testton_spielen(d, &ti, ms);
  pthread_mutex_lock(&G);
  if (d) {
    melden("{\"e\":\"testton\",\"geraet\":%s,\"ok\":true}", js(j1, sizeof j1, tg));
    snprintf(geraet_offen, sizeof geraet_offen, "%s", tg); exklusiv_offen = exklusiv_wahl;
    hw_rate_letzt = ti.geraet_rate ? ti.geraet_rate : ti.rate; snprintf(hw_geraet_letzt, sizeof hw_geraet_letzt, "%s", tg);
  } else melden("{\"e\":\"testton\",\"geraet\":%s,\"fehler\":%s}", js(j1, sizeof j1, tg), js(j2, sizeof j2, fehler[0] ? fehler : "Gerät lässt sich nicht öffnen"));
  if (q_rate) {
    // ein Titel ist geladen (pausiert): beim Weiterspielen auf den gewählten Ausgang zurück – derselbe Treiber wird nur umgeleitet
    *devp = d;
    Z->format_wartet = 1; memset(&Z->format_m, 0, sizeof Z->format_m);
    Z->format_m.rate = q_rate; Z->format_m.kanaele = *Z->q_kan; Z->format_m.bits = q_bits; Z->format_ende = 0;
    abschnitte_neu_basieren(Z->ab, &Z->n_ab, *dev_w, &Z->ende_offen, &Z->ende_frame);
    *dev_w = 0;
  } else if (d) { pthread_mutex_unlock(&G); ger_schliessen(d); pthread_mutex_lock(&G); }
}

static void *ausgabe_thread(void *arg) {
  (void)arg;
  aus_thread_start();
  Geraet *dev = NULL;
  AusInfo ai; memset(&ai, 0, sizeof ai);
  int q_rate = 0, q_kan = 0, q_bits = 0;      // Format der Quelle am Gerät
  unsigned lgen = gen, lneu = neustart;
  uint64_t dev_w = 0;                          // geschriebene Frames seit Zurücksetzen
  AusZustand Z; memset(&Z, 0, sizeof Z);
  Z.ai = &ai; Z.q_rate = &q_rate; Z.q_bits = &q_bits; Z.q_kan = &q_kan;
#define ab Z.ab
#define n_ab Z.n_ab
#define ende_offen Z.ende_offen
#define ende_frame Z.ende_frame
#define ende_id Z.ende_id
#define format_wartet Z.format_wartet
#define format_m Z.format_m
#define format_ende Z.format_ende
  int laeuft = 0;
  uint64_t pause_ende = UINT64_MAX;            // ausgeblendete Pause: bis hierher (Gerät-Frames) ist Musik geschrieben
  // Anlauf nach Ratenwechsel (exklusiv/ASIO): Stille schreiben, bis das Gerät nachweislich gleichmäßig mit der neuen Rate
  // läuft, dann noch den Aufschlag – erst danach Musik
  int anlauf = 0, an_stabil_n = 0;
  double an_tstart = 0; int an_stabil_war = 0;   // Start des Geräts im Anlauf (ASIO: Zeitlimit ab hier)
  double ruhe_seit = 0;                        // durchlaufendes Gerät spielt seitdem nur Stille (Pause/Ende/Stopp)
  uint64_t an_null = 0;                        // so viele Frames Stille liegen schon im Gerät
  double an_t0 = 0, an_tw = 0, an_tb = 0, an_bereit = 0, an_stabil = 0;
  int64_t an_gw = -1, an_gb = -1;
  char hoerbar[64] = "";
  double letzte_zeit = 0;
  int bitgenau_gemeldet = -1;
  Z.bitgenau_gemeldet = &bitgenau_gemeldet;
  char j1[300], j3[300];

  pthread_mutex_lock(&G);
  while (!beenden) {
    if (lgen != gen) {
      lgen = gen;
      klang_leeren();   // kein Rest des Alten in den Effekten
      int weich = dev && laeuft && ger_durchlaufend(dev) && ger_weich_neu(dev, 10) == 0;
      // weich: Gerät läuft durch – kurz ausgeblendet, Rest verworfen, Neues kommt direkt dahinter (kein Anhalten/Neustart)
      if (!weich && dev && laeuft) { pthread_mutex_unlock(&G); ger_ausklingen(dev, 10); pthread_mutex_lock(&G); }   // nicht mitten in der Welle abreißen
      if (sprung_einblenden) {
        // neue Stelle beginnt mitten in der Welle: kurz einblenden (außer es läuft schon eine längere Blende)
        sprung_einblenden = 0;
        if (!fade_r && fade_p >= 1) { fade_p = 0; fade_s = 0.005; fade_r = 1; }
      }
      if (!weich) { if (dev) { ger_stopp(dev); ger_zuruecksetzen(dev); } laeuft = 0; }
      dev_w = 0; n_ab = 0; ende_offen = 0; format_wartet = 0; pause_ende = UINT64_MAX; an_null = 0;
      if (lneu != neustart) { lneu = neustart; hoerbar[0] = 0; }
    }
    // Space eingeschaltet, Gerät hat zu wenige Kanäle offen (exklusiv mit den Kanälen der Datei): neu öffnen
    if (dev && q_rate && !format_wartet) {
      int rk = klang_raum_kanaele(), bk = bass_kanaele();
      if (bk > rk) rk = bk;
      if (rk > ai.kanaele && rk > raum_versucht) geraet_neu = 1;
    }
    if (ton_anf) { testton_ablauf(&dev, &laeuft, &anlauf, &ai, &Z, &dev_w); continue; }
    if (geraet_neu && dev) {
      // anderes Gerät gewählt: sofort neu öffnen (Rest im Gerätepuffer geht verloren). Anderer Ausgang desselben
      // ASIO-Treibers: kurz ausblenden, Gerät offen lassen – es wird gleich nur umgeleitet (keine Pause, kein Neuladen)
      geraet_neu = 0;
      int umleiten = q_rate && asio_gleicher_treiber(geraet_wahl, geraet_offen);
      Geraet *alt = dev; int lief = laeuft; dev = NULL; laeuft = 0;
      pthread_mutex_unlock(&G);
      if (lief) ger_ausklingen(alt, umleiten ? 20 : 10);
      ger_stopp(alt);
      if (umleiten) dev = alt; else ger_schliessen(alt);
      pthread_mutex_lock(&G);
      if (lief && spielen) { fade_p = 0; fade_s = 0.02; fade_r = 1; }   // danach weich wieder einblenden
      if (q_rate) { format_wartet = 1; memset(&format_m, 0, sizeof format_m); format_m.rate = q_rate; format_m.kanaele = q_kan; format_m.bits = q_bits; format_ende = 0; }
      abschnitte_neu_basieren(ab, &n_ab, dev_w, &ende_offen, &ende_frame);
      dev_w = 0;
      continue;
    }
    // Marken an der Leseposition abarbeiten
    Z.dev = dev;
    marken_abarbeiten(&Z, dev_w, dev != NULL, q_rate, q_kan, q_bits);
    if (format_wartet) {
      // erst alles Alte hörbar zu Ende spielen
      int leer = !dev || !laeuft || ger_gespielt(dev) >= (int64_t)format_ende;
      if (!leer && spielen) goto schreiben;
      if (!spielen) {
        // pausiert: Gerät erst beim Abspielen öffnen (exklusiv soll es niemandem wegnehmen, solange nichts läuft)
        if (dev && laeuft) { ger_stopp(dev); laeuft = 0; }
        if (dev) goto pause_warten;
        struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts); ts.tv_nsec += 200000000; if (ts.tv_nsec >= 1000000000) { ts.tv_sec++; ts.tv_nsec -= 1000000000; }
        pthread_cond_timedwait(&G_aus, &G, &ts);
        continue;
      }
      int lief_alt = laeuft;
      Geraet *alt = dev; dev = NULL; laeuft = 0; anlauf = 0;
      char g[512]; snprintf(g, sizeof g, "%s", geraet_wahl);
      int ex = exklusiv_wahl;
      Marke fm = format_m;
      unsigned g0 = gen;
      geraet_neu = 0;
      pthread_mutex_unlock(&G);
      char fehler[300] = "";
      AusInfo neu; memset(&neu, 0, sizeof neu);
      // Space braucht mehr Kanäle (5.1/Quadro) als die Datei: das Gerät gleich so öffnen (Stereo bleibt darauf bitgenau)
      int rk = klang_raum_kanaele(), bk = bass_kanaele();
      if (bk > rk) rk = bk;
      int dk = fm.kanaele > rk ? fm.kanaele : rk;
      raum_versucht = rk;
      Geraet *d = NULL;
      double t_auf = jetzt_s();   // für die Anlaufzeit: ab Beginn des Umstellens
      // dasselbe Gerät (ASIO): nur Rate/Kanäle umstellen statt schließen und neu laden – spart den Großteil der Pause
      if (alt && lief_alt) ger_nachlauf(alt);   // ASIO: erst Stille in Länge der Treiberlatenz, dann anhalten
      int asio_gleich = asio_gleicher_treiber(g, geraet_offen);
      if (alt && (asio_gleich || (!strcmp(g, geraet_offen) && ex == exklusiv_offen)) && ger_fest_rate(alt) == fest_rate) {
        ger_stopp(alt);
        if ((!asio_gleich || ger_umleiten(alt, g) >= 0) && ger_umstellen(alt, fm.rate, dk, fm.bits, &neu, fehler, sizeof fehler) == 0) { d = alt; alt = NULL; }
        fehler[0] = 0;
      }
      if (alt) { ger_stopp(alt); ger_schliessen(alt); }
      if (!d) d = ger_oeffnen(g, ex, fm.rate, dk, fm.bits, fest_rate, &neu, fehler, sizeof fehler);
      if (d) { snprintf(geraet_offen, sizeof geraet_offen, "%s", g); exklusiv_offen = ex; }
      pthread_mutex_lock(&G);
      format_wartet = 0;
      if (!d) {
        melden("{\"e\":\"fehler\",\"id\":\"\",\"text\":%s}", js(j1, sizeof j1, fehler[0] ? fehler : "Ausgabegerät lässt sich nicht öffnen"));
        // ohne Gerät nichts abspielen: verwerfen und anhalten
        spielen = 0;
        verwerfen();
        pthread_cond_broadcast(&G_dek);
        continue;
      }
      dev = d; ai = neu; q_rate = fm.rate; q_kan = fm.kanaele; q_bits = fm.bits;
      {
        int hw = ai.geraet_rate ? ai.geraet_rate : ai.rate;
        // ASIO weiß, ob der Treiber eben wirklich umgestellt wurde – lief er schon mit dieser Rate (z. B. feste 96 kHz),
        // geht es sofort los, auch beim ersten Titel nach dem Start. Windows exklusiv: nach Ratenwechsel bzw. erstem Öffnen.
        if ((ai.exklusiv || ai.asio) && (ai.asio ? ai.rate_gestellt : (hw != hw_rate_letzt || !gleiches_geraet(g, hw_geraet_letzt)))) {
          anlauf = 1; an_null = 0; an_t0 = t_auf; an_gw = an_gb = -1; an_stabil = 0; an_stabil_n = 0; an_bereit = 0; an_tstart = 0;
        } else anlauf = 0;
        hw_rate_letzt = hw; snprintf(hw_geraet_letzt, sizeof hw_geraet_letzt, "%s", g);
      }
      klang_format(q_rate, q_kan > 8 ? 8 : q_kan);
      // Abschnitte gelten jetzt ab Frame 0 des neuen Geräts
      if (g0 == gen) {
        uint64_t versatz = format_ende;
        for (int i = 0; i < n_ab; i++) ab[i].dev_frame = ab[i].dev_frame >= versatz ? ab[i].dev_frame - versatz : 0;
        if (ende_offen) ende_frame = ende_frame >= versatz ? ende_frame - versatz : 0;
      }
      dev_w = 0;
      bitgenau_gemeldet = -1;
      format_melden(&ai, q_rate, q_bits, q_kan);
      continue;
    }
    if (!dev) { pthread_cond_wait(&G_aus, &G); continue; }
    if (spielen) ruhe_seit = 0;
    if (pause_fade && (!laeuft || anlauf)) { spielen = 0; pause_fade = 0; fade_p = 1; fade_r = 0; }   // es klingt noch nichts: sofort
    if (!spielen) {
    pause_warten:
      if (laeuft && ger_durchlaufend(dev)) {
        // läuft mit Stille weiter; nach längerer Ruhe freigeben (Windows soll schlafen dürfen) – bis dahin ist so lange
        // Stille gelaufen, dass im Interface garantiert nichts Altes mehr steckt
        double t = jetzt_s();
        if (!ruhe_seit) ruhe_seit = t;
        if (t - ruhe_seit > (n_ab > 0 ? ruhe_pause_s : ruhe_ende_s)) {
          Geraet *alt = dev; dev = NULL; laeuft = 0; anlauf = 0; ruhe_seit = 0;
          pthread_mutex_unlock(&G); ger_stopp(alt); ger_schliessen(alt); pthread_mutex_lock(&G);
          if (n_ab > 0 && q_rate) {
            // mitten im Titel pausiert: beim Fortsetzen neu öffnen, dort weiter, wo die Blende endete
            format_wartet = 1; memset(&format_m, 0, sizeof format_m); format_m.rate = q_rate; format_m.kanaele = q_kan; format_m.bits = q_bits; format_ende = 0;
            abschnitte_neu_basieren(ab, &n_ab, dev_w, &ende_offen, &ende_frame);
          } else { q_rate = q_kan = q_bits = 0; n_ab = 0; }
          dev_w = 0;
          continue;
        }
      } else if (laeuft) { ger_stopp(dev); laeuft = 0; }
      struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts); ts.tv_nsec += 200000000; if (ts.tv_nsec >= 1000000000) { ts.tv_sec++; ts.tv_nsec -= 1000000000; }
      pthread_cond_timedwait(&G_aus, &G, &ts);
      continue;
    }
    if (anlauf) {
      if (!laeuft) { laeuft = 1; ger_start(dev); an_gw = an_gb = -1; an_stabil = 0; an_stabil_n = 0; an_bereit = 0; an_tstart = jetzt_s(); }
      unsigned g0 = gen;
      Geraet *d = dev;
      pthread_mutex_unlock(&G);
      ger_warten(d, 20);
      pthread_mutex_lock(&G);
      if (g0 != gen || beenden || d != dev) continue;
      if (ger_verloren(dev)) { anlauf = 0; continue; }   // der normale Weg öffnet neu
      int frei = ger_frei(dev);
      void *p = frei > 0 ? ger_puffer(dev, frei) : NULL;
      if (p) {
        memset(p, 0, (size_t)frei * (size_t)(fmt_bytes(ai.fmt) * ai.kanaele));
        ger_puffer_fertig(dev, frei);
        an_null += (uint64_t)frei;
      }
      double t = jetzt_s();
      int64_t gs = ger_gespielt(dev);
      double soll = (double)q_rate * test_tempo;
      double pf = ai.puffer_frames > 0 ? ai.puffer_frames : q_rate / 100.0;
      double fenster = 4 * pf / (ai.rate > 0 ? ai.rate : q_rate) / test_tempo;
      if (fenster < 0.04) fenster = 0.04;
      if (an_gb < 0 || gs != an_gb) { an_gb = gs; an_tb = t; }
      if (an_gw < 0) { if (gs > 0) { an_gw = gs; an_tw = t; } }
      else if (t - an_tw >= fenster) {
        // Takt über das Fenster: muss zur Rate passen (Toleranz: 3 % + Körnung von zwei Gerätepuffern)
        double r = (double)(gs - an_gw) / (t - an_tw);
        double tol = 0.03 + 2.0 * pf * test_tempo / ((t - an_tw) * soll);
        if (fabs(r / soll - 1) <= tol) { an_stabil += t - an_tw; an_stabil_n++; } else { an_stabil = 0; an_stabil_n = 0; }
        an_gw = gs; an_tw = t;
      }
      // Stillstand (keine Rückrufe) setzt die Messung zurück
      if (t - an_tb > 3 * pf / (ai.rate > 0 ? ai.rate : q_rate) / test_tempo + 0.03) { an_stabil = 0; an_stabil_n = 0; an_gw = -1; }
      // ASIO: Zeitinfo des Treibers (Sample-Position) sagt direkt, ob der Takt steht; Limit 1,5 s ab Start (die Musik wartet
      // danach im Ring, bis der Treiber wirklich abholt – verloren geht nichts). Sonst wie bisher höchstens 3 s.
      int takt = ger_takt(dev);
      int zeitueber = ai.asio ? (an_tstart > 0 && t - an_tstart > 1.5 / test_tempo) : t - an_t0 > 3.0;
      int stabil = (an_stabil_n >= 2 && an_stabil >= 0.08) || takt == 1;
      if (!an_bereit && (stabil || zeitueber)) { an_bereit = t; an_stabil_war = stabil; }
      if (an_bereit && t - an_bereit >= anlauf_aufschlag / 1000.0) {
        anlauf = 0;
        // die Stille liegt vor der Musik im Gerät: alle Abschnitte dahinter
        for (int i = 0; i < n_ab; i++) ab[i].dev_frame += an_null;
        if (ende_offen) ende_frame += an_null;
        dev_w += an_null;
        static char proto[3200];
        ger_protokoll(dev, proto, sizeof proto);
        melden("{\"e\":\"anlauf\",\"ms\":%d,\"aufschlag\":%d,\"zeitueber\":%s,\"stille\":%llu,\"asio\":%s,\"protokoll\":%s}", (int)((an_bereit - an_t0) * 1000 + 0.5), anlauf_aufschlag,
               an_stabil_war ? "false" : "true", (unsigned long long)an_null, ai.asio ? "true" : "false", proto);
      }
      continue;
    }
    if (!laeuft) {
      // Vorpuffern: 250 ms oder bis eine Marke bzw. das Ende kommt
      uint64_t da = (w_pos - r_pos) / (uint64_t)q_kan;
      int genug = da >= (uint64_t)q_rate / 4 || (n_marken > 0) || (dek == NULL && anf_laden == NULL) || ende_offen || (dev_w > 0 && ger_gespielt(dev) < (int64_t)dev_w);
      if (!genug) {
        struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts); ts.tv_nsec += 20000000; if (ts.tv_nsec >= 1000000000) { ts.tv_sec++; ts.tv_nsec -= 1000000000; }
        pthread_cond_timedwait(&G_aus, &G, &ts);
        continue;
      }
      if (ende_offen && da == 0 && ger_gespielt(dev) >= (int64_t)dev_w) goto ende_pruefen;
    }

  schreiben: {
      if (!laeuft) {
        // ersten Puffer vor dem Start füllen
        laeuft = 1;
        ger_start(dev);
      }
      unsigned g0 = gen;
      Geraet *d = dev;
      pthread_mutex_unlock(&G);
      ger_warten(d, 200);
      pthread_mutex_lock(&G);
      if (g0 != gen || beenden || d != dev) continue;
      if (pause_ende != UINT64_MAX && !pause_fade) {
        // Fortsetzen, während schon Stille hinter dem Ausblenden lag: die gilt als Pause im Titel
        if (n_ab > 0 && dev_w > pause_ende) ab[n_ab - 1].stille += dev_w - pause_ende;
        pause_ende = UINT64_MAX;
      }
      if (pause_fade && fade_p <= 0 && !ger_verloren(dev)) {
        // ausgeblendet: warten, bis das Gerät alles Ausgeblendete gespielt hat (solange Stille nachschieben), dann anhalten
        // und die Stille im Gerätepuffer verwerfen – beim Fortsetzen geht es genau dort weiter, wo die Blende endete
        if (pause_ende == UINT64_MAX) pause_ende = dev_w;
        if (ger_durchlaufend(dev)) {
          // Gerät läuft durch: nichts mehr schreiben, der Treiber spielt Stille, sobald alles Ausgeblendete durch ist
          if (ger_gespielt(dev) >= (int64_t)pause_ende) { spielen = 0; pause_fade = 0; pause_ende = UINT64_MAX; ruhe_seit = jetzt_s(); continue; }
          goto ende_pruefen;
        }
        if (ger_gespielt(dev) >= (int64_t)pause_ende) {
          spielen = 0; pause_fade = 0; laeuft = 0;
          Geraet *dd = dev;
          pthread_mutex_unlock(&G); ger_stopp(dd); ger_zuruecksetzen(dd); pthread_mutex_lock(&G);
          if (dd != dev) continue;
          abschnitte_neu_basieren(ab, &n_ab, pause_ende, &ende_offen, &ende_frame);
          dev_w = 0; pause_ende = UINT64_MAX;
          continue;
        }
        int frei = ger_frei(dev);
        void *p = frei > 0 ? ger_puffer(dev, frei) : NULL;
        if (p) {
          memset(p, 0, (size_t)frei * (size_t)(fmt_bytes(ai.fmt) * ai.kanaele));
          ger_puffer_fertig(dev, frei);
          dev_w += (uint64_t)frei;
        }
        goto ende_pruefen;
      }
      if (ger_verloren(dev)) {
        melden("{\"e\":\"fehler\",\"id\":\"\",\"text\":\"Ausgabegerät ist nicht mehr da\"}");
        Geraet *alt = dev; dev = NULL; laeuft = 0; spielen = 0;
        pthread_mutex_unlock(&G); ger_schliessen(alt); pthread_mutex_lock(&G);
        if (q_rate) { format_wartet = 1; memset(&format_m, 0, sizeof format_m); format_m.rate = q_rate; format_m.kanaele = q_kan; format_m.bits = q_bits; format_ende = 0; }
        abschnitte_neu_basieren(ab, &n_ab, dev_w, &ende_offen, &ende_frame);
        dev_w = 0;
        continue;
      }
      int frei = ger_frei(dev);
      if (pause_fade && frei > 0) { int r = fade_rest(q_rate); if (r < 1) r = 1; if (frei > r) frei = r; }   // nur bis zum Ende der Blende
      if (frei > 0) {
        void *p = ger_puffer(dev, frei);
        if (p) {
          int bpf = fmt_bytes(ai.fmt) * ai.kanaele;
          int bg = 1;
          int blende = fade_r || fade_p < 1;   // Blenden zählen nicht für „bitgenau“
          int gemacht = 0, k = 0;
          for (;;) {
            // Titel-Marken mitten im Puffer: nahtlos weiter; Format-/Ende-Marken: hier aufhören
            Z.dev = dev;
            if (marken_abarbeiten(&Z, dev_w + (uint64_t)gemacht, 1, q_rate, q_kan, q_bits) || ende_offen) break;
            uint64_t bis = w_pos;
            if (n_marken > 0 && marken[0].pos < bis) bis = marken[0].pos;
            uint64_t da = (bis - r_pos) / (uint64_t)q_kan;
            if (da == 0 || gemacht >= frei) break;
            k = gemacht + (int)(da < (uint64_t)(frei - gemacht) ? da : (uint64_t)(frei - gemacht));
          while (gemacht < k) {
            // Ring kann umbrechen: in zusammenhängenden Stücken
            size_t a = (size_t)(r_pos % RING_KAP);
            size_t stueck = (size_t)(k - gemacht);
            size_t bis_ende = (RING_KAP - a) / (size_t)q_kan;
            if (bis_ende == 0) {
              // Frame liegt über der Ringgrenze: einzeln umkopieren
              int32_t f8[8];
              for (int c = 0; c < q_kan; c++) f8[c] = ring[(a + (size_t)c) % RING_KAP];
              bg &= stueck_ausgeben((unsigned char *)p + (size_t)gemacht * bpf, &ai, f8, q_kan, q_bits, 1);
              r_pos += (uint64_t)q_kan; gemacht++;
              continue;
            }
            if (stueck > bis_ende) stueck = bis_ende;
            bg &= stueck_ausgeben((unsigned char *)p + (size_t)gemacht * bpf, &ai, ring + a, q_kan, q_bits, (int)stueck);
            r_pos += (uint64_t)stueck * (uint64_t)q_kan;
            gemacht += (int)stueck;
          }
          }
          k = gemacht;
          if (k < frei) {
            memset((unsigned char *)p + (size_t)k * bpf, 0, (size_t)(frei - k) * bpf);
            // Aussetzer nur, wenn wirklich noch Musik kommen soll
            int erwartet = !pause_fade && !ende_offen && !format_wartet && (n_marken == 0 || marken[0].pos > r_pos) && (dek != NULL);
            if (erwartet && n_ab > 0) {
              ab[n_ab - 1].stille += (uint64_t)(frei - k);
              melden("{\"e\":\"aussetzer\"}");
            }
          }
          ger_puffer_fertig(dev, frei);
          dev_w += (uint64_t)frei;
          if (k > 0 && bg != bitgenau_gemeldet && !blende && !fade_r && fade_p >= 1) {
            bitgenau_gemeldet = bg;
            melden("{\"e\":\"bitgenau\",\"wert\":%s}", bg && ai.exklusiv && !ai.umgerechnet ? "true" : "false");
          }
          pthread_cond_broadcast(&G_dek);
        }
      }
    }

  ende_pruefen: {
      int64_t gespielt = ger_gespielt(dev);
      // hörbarer Abschnitt
      int ai_ = -1;
      for (int i = n_ab - 1; i >= 0; i--) if ((int64_t)ab[i].dev_frame <= gespielt) { ai_ = i; break; }
      if (ai_ >= 0 && strcmp(ab[ai_].id, hoerbar) != 0) {
        melden("{\"e\":\"start\",\"id\":%s,\"vorher\":%s}", js(j1, sizeof j1, ab[ai_].id), js(j3, sizeof j3, hoerbar));
        snprintf(hoerbar, sizeof hoerbar, "%s", ab[ai_].id);
        // ältere Abschnitte und den Vorgänger-Titel aufräumen
        if (ai_ > 0) { memmove(ab, ab + ai_, sizeof(Abschnitt) * (size_t)(n_ab - ai_)); n_ab -= ai_; ai_ = 0; }
        if (vorher && strcmp(vorher->id, hoerbar) != 0 && dek && strcmp(dek->id, hoerbar) == 0) {
          // Vorgänger nicht mehr hörbar → freigeben (im Dekoder-Thread nicht nötig: hier ohne Lesezugriff)
          Titel *weg = vorher; vorher = NULL;
          pthread_mutex_unlock(&G); titel_frei(weg); pthread_mutex_lock(&G);
          if (lgen != gen) continue;
        }
        if (dek_vorgemerkt && dek && strcmp(dek->id, hoerbar) == 0) dek_vorgemerkt = 0;
      }
      if (ende_offen && gespielt >= (int64_t)ende_frame) {
        melden("{\"e\":\"ende\",\"id\":%s}", js(j1, sizeof j1, ende_id));
        ende_offen = 0; hoerbar[0] = 0; n_ab = 0;
        if (ger_durchlaufend(dev)) { spielen = 0; ruhe_seit = jetzt_s(); continue; }   // läuft noch 10 s mit Stille, dann frei
        // Gerät freigeben (exklusiv: andere Programme dürfen wieder)
        Geraet *alt = dev; dev = NULL; laeuft = 0; q_rate = q_kan = q_bits = 0;
        spielen = 0;
        pthread_mutex_unlock(&G); ger_stopp(alt); ger_schliessen(alt); pthread_mutex_lock(&G);
        continue;
      }
      double t = jetzt_s();
      if (ai_ >= 0 && t - letzte_zeit > 0.1) {
        letzte_zeit = t;
        Abschnitt *a = &ab[ai_];
        int64_t im = gespielt - (int64_t)a->dev_frame - (int64_t)a->stille;
        if (im < 0) im = 0;
        double pos = ((double)a->start_frame + (double)im) / (a->rate ? a->rate : 1);
        melden("{\"e\":\"zeit\",\"id\":%s,\"pos\":%.4f,\"dauer\":%.4f,\"puffer\":%.2f}", js(j1, sizeof j1, a->id), pos, a->dauer,
               q_rate && q_kan ? (double)(w_pos - r_pos) / q_kan / q_rate : 0.0);
      }
    }
  }
  if (dev) { pthread_mutex_unlock(&G); ger_stopp(dev); ger_schliessen(dev); pthread_mutex_lock(&G); }
  pthread_mutex_unlock(&G);
  aus_thread_ende();
  return NULL;
}
#undef ab
#undef n_ab
#undef ende_offen
#undef ende_frame
#undef ende_id
#undef format_wartet
#undef format_m
#undef format_ende

/* ------------------------------------------------------------------------------------------------------------ */
/* Befehle (kleiner JSON-Leser für flache Objekte)                                                                 */

#include "befehl_lesen.h"

/** Angleich eines Titels ändern (Titel im Speicher, Marken im Ring, laufende Ausgabe) – unter G */
static void gain_setzen(const char *id, double g) {
  if (!id || g <= 0) return;
  Titel *ts[3] = { dek, naechst, vorher };
  for (int i = 0; i < 3; i++) if (ts[i] && !strcmp(ts[i]->id, id)) ts[i]->gain = g;
  if (anf_laden && !strcmp(anf_laden->id, id)) anf_laden->gain = g;
  if (anf_vormerken_t && !strcmp(anf_vormerken_t->id, id)) anf_vormerken_t->gain = g;
  for (int i = 0; i < n_marken; i++) if (marken[i].typ == M_TITEL && !strcmp(marken[i].id, id)) marken[i].gain = g;
  if (!strcmp(gain_id, id)) gain_ziel = g;
}

static void ausfuehren(Befehl *b) {
  const char *c = b->c;
  // Space (eigene Sperre der Klangkette)
  if (!strcmp(c, "raum")) { klang_raum(wt(b, "g"), wz(b, "rate", 0), (int)wz(b, "kan", 0)); pthread_mutex_lock(&G); pthread_cond_broadcast(&G_aus); pthread_mutex_unlock(&G); return; }
  if (!strcmp(c, "raum_ir")) { klang_raum_ir(b->id, (int)wz(b, "kan", 2), (int)wz(b, "n", 0), wz(b, "rate", 0), wt(b, "d0"), wt(b, "d1")); return; }
  if (!strcmp(c, "raum_p")) { klang_raum_param((int)wz(b, "k", -1), wt(b, "a"), wz(b, "w", 0), wz(b, "dt", 0), wz(b, "tau", 0)); return; }
  if (!strcmp(c, "raum_m")) { klang_raum_nachricht((int)wz(b, "k", -1), wz(b, "effekte", -1), wz(b, "breite", -1)); return; }
  // Subwoofer: an, Trennfrequenz (Hz), Delay (ms, + = Sub später), Layout (2/4/6)
  if (!strcmp(c, "korrektur")) {
    const AwWert *dl = wv(b, "delays"), *gl = wv(b, "gains");
    pthread_mutex_lock(&G);
    for (int i = 0; i < 8; i++) {
      korr_delay_ms[i] = dl && dl->liste && i < dl->liste_n ? dl->liste[i] : 0;
      korr_gain_db[i] = gl && gl->liste && i < gl->liste_n ? gl->liste[i] : 0;
    }
    int cf = (int)wz(b, "cf", 0);
    korr_cf = cf >= 0 && cf <= 3 ? cf : 0;
    korr_an = wz(b, "an", 0) != 0;
    korr_gen++;
    pthread_cond_broadcast(&G_aus);
    pthread_mutex_unlock(&G);
    melden("{\"e\":\"korrektur\",\"an\":%s,\"cf\":%d}", korr_an ? "true" : "false", korr_cf);
    return;
  }
  // Kanal-EQ: k = Kanal (Engine-Reihenfolge), p = [Kanal an, 8 × (an, Typ, Hz, dB, Q, dB/Okt.)]
  if (!strcmp(c, "kanal_eq")) {
    const AwWert *pl = wv(b, "p");
    eq_setzen((int)wz(b, "k", -1), pl && pl->liste ? pl->liste : NULL, pl && pl->liste ? pl->liste_n : 0);
    return;
  }
  if (!strcmp(c, "bass")) {
    int an = wz(b, "an", 0) != 0, lay = (int)wz(b, "layout", 2);
    pthread_mutex_lock(&G);
    bass_hz = wz(b, "hz", 80); bass_delay_ms = wz(b, "delay", 0);
    bass_layout = lay == 4 || lay == 6 ? lay : 2;
    bass_phase = wz(b, "phase", 0) != 0;
    if (an != bass_an) raum_versucht = 0;
    bass_an = an; bass_gen++;
    pthread_cond_broadcast(&G_aus);
    pthread_mutex_unlock(&G);
    return;
  }
  // Klangkette (eigene Sperre, nicht unter G)
  if (!strcmp(c, "fx") && b->art) { klang_fx(b->art, b->w, b->nw); return; }
  if (!strcmp(c, "kette")) { klang_kette(b->reihe, b->an_liste); return; }
  if (!strcmp(c, "vst_an")) { klang_vst_an(b->art && !strncmp(b->art, "vst", 3) ? b->art[3] - '0' : -1, wt(b, "shm"), wt(b, "ein"), wt(b, "aus")); return; }
  if (!strcmp(c, "vst_ab")) { klang_vst_ab(b->art && !strncmp(b->art, "vst", 3) ? b->art[3] - '0' : -1); return; }
  if (!strcmp(c, "delta")) { klang_delta(b->art && *b->art ? b->art : NULL); return; }
  if (!strcmp(c, "messen")) { klang_messen(b->hat_an ? b->an : 0); return; }
  if (!strcmp(c, "abgriffe")) { klang_abgriffe(b->liste); return; }
  if (!strcmp(c, "asio_einstellungen")) {
    melden("{\"e\":\"asio_einstellungen\",\"ok\":%s}", asio_einstellungen_aktiv() ? "true" : "false");
    return;
  }
  if (!strcmp(c, "asio_kanaele")) {
    // Namen der Ausgänge eines ASIO-Treibers (lädt ihn kurz, wenn keiner offen ist) – im eigenen Thread, das dauert
    const char *g = b->geraet;
    if (!g || strncmp(g, "asio:", 5)) { melden("{\"e\":\"asio_kanaele\",\"geraet\":\"\",\"fehler\":\"kein ASIO-Gerät\"}"); return; }
    char *kopie = strdup(g);
    pthread_t t;
    if (pthread_create(&t, NULL, kanaele_thread, kopie) == 0) pthread_detach(t); else free(kopie);
    return;
  }
  if (!strcmp(c, "testton")) {
    const char *g = b->geraet;
    pthread_mutex_lock(&G);
    snprintf(ton_geraet, sizeof ton_geraet, "%s", g ? g : "");
    { int ms = (int)wz(b, "ms", 2000); ton_ms = ms < 200 ? 200 : ms > 10000 ? 10000 : ms; }
    ton_anf = 1;
    pthread_cond_broadcast(&G_aus);
    pthread_mutex_unlock(&G);
    return;
  }
  if (!strcmp(c, "geraete")) {
    char *l = aus_geraete_json();
    melden("{\"e\":\"geraete\",\"liste\":%s}", l ? l : "[]");
    free(l);
    return;
  }
  pthread_mutex_lock(&G);
  if (!strcmp(c, "laden") && b->url && *b->url) {
    Titel *t = titel_neu(b->id, b->url, b->kopf, b->hat_pos ? b->pos : 0);
    if (t && b->hat_gain && b->gain > 0) t->gain = b->gain;
    if (t) {
      if (anf_laden) { Titel *alt = anf_laden; anf_laden = NULL; pthread_mutex_unlock(&G); titel_frei(alt); pthread_mutex_lock(&G); }
      anf_laden = t;
      if (anf_vormerken) { Titel *alt = anf_vormerken_t; anf_vormerken = 0; anf_vormerken_t = NULL; pthread_mutex_unlock(&G); titel_frei(alt); pthread_mutex_lock(&G); }
      anf_springen = 0;
      neustart++;
      spielen = b->hat_spielen ? b->spielen : 1;
      pause_fade = 0;
      fade_ein(wz(b, "fade", 0), 1);
      if (b->hat_pos && b->pos > 0) sprung_einblenden = 1;
      titel_unterbrechen(dek);
      gen++;   // Ausgabe sofort leeren
      r_pos = w_pos; n_marken = 0;
    }
  } else if (!strcmp(c, "vormerken")) {
    Titel *t = b->url && *b->url ? titel_neu(b->id, b->url, b->kopf, 0) : NULL;
    if (t && b->hat_gain && b->gain > 0) t->gain = b->gain;
    if (anf_vormerken) { Titel *alt = anf_vormerken_t; anf_vormerken_t = NULL; pthread_mutex_unlock(&G); titel_frei(alt); pthread_mutex_lock(&G); }
    anf_vormerken = 1; anf_vormerken_t = t;
    // wird der bisher vorgemerkte gerade geöffnet (wartet auf Daten)? Dann das Öffnen abbrechen
    if (dek && dek_vorgemerkt && !dek_offen && (!t || strcmp(t->id, dek->id) != 0)) titel_unterbrechen(dek);
  } else if (!strcmp(c, "spielen")) {
    // aus einer ausgeblendeten Pause (auch mitten im Ausblenden): von der aktuellen Stelle wieder hoch
    double ms = wz(b, "fade", 0);
    fade_ein(ms, !spielen && !pause_fade);
    if (ms <= 0) fade_p = 1;
    pause_fade = 0;
    spielen = 1;
  } else if (!strcmp(c, "pause")) {
    double ms = wz(b, "fade", 0);
    // ohne Angabe trotzdem kurz (10 ms) ausblenden: sonst reißt die Musik mitten in der Welle ab
    if (ms <= 0) ms = 10;
    if (spielen && !pause_fade) { fade_s = ms / 1000.0; fade_r = -1; pause_fade = 1; }
  } else if (!strcmp(c, "springen")) {
    anf_springen = 1; anf_springen_pos = b->hat_pos && b->pos > 0 ? b->pos : 0;
    sprung_einblenden = 1;
    snprintf(anf_springen_id, sizeof anf_springen_id, "%s", b->id ? b->id : "");
    titel_unterbrechen(dek);
    if (vorher) titel_unterbrechen(vorher);
  } else if (!strcmp(c, "gain") && b->hat_wert) {
    gain_setzen(b->id, b->wert);
  } else if (!strcmp(c, "lautstaerke") && b->hat_wert) {
    double v = b->wert;
    lautstaerke = v < 0 ? 0 : v > 4 ? 4 : v;
  } else if (!strcmp(c, "ausgabe")) {
    snprintf(geraet_wahl, sizeof geraet_wahl, "%s", b->geraet ? b->geraet : "");
    if (b->hat_exklusiv) exklusiv_wahl = b->exklusiv;
    { int r = (int)wz(b, "rate", fest_rate); fest_rate = r >= 8000 && r <= 768000 ? r : 0; }
    { int a = (int)wz(b, "aufschlag", anlauf_aufschlag); anlauf_aufschlag = a < 0 ? 0 : a > 5000 ? 5000 : a; }
    geraet_neu = 1;
  } else if (!strcmp(c, "stopp")) {
    anf_stopp = 1; spielen = 0; neustart++; pause_fade = 0; fade_p = 1; fade_r = 0;
    titel_unterbrechen(dek);
    gen++; r_pos = w_pos; n_marken = 0;
  } else if (!strcmp(c, "beenden")) {
    beenden = 1;
    titel_unterbrechen(dek); titel_unterbrechen(naechst); titel_unterbrechen(vorher);
  }
  pthread_cond_broadcast(&G_dek);
  pthread_cond_broadcast(&G_aus);
  pthread_mutex_unlock(&G);
}

int main(int argc, char **argv) {
  (void)argc; (void)argv;
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
  if (getenv("AW_RUHE_PAUSE")) ruhe_pause_s = atof(getenv("AW_RUHE_PAUSE"));   // nur Tests
  if (getenv("AW_RUHE_ENDE")) ruhe_ende_s = atof(getenv("AW_RUHE_ENDE"));
  if (getenv("AW_TEMPO")) test_tempo = atof(getenv("AW_TEMPO")) > 0 ? atof(getenv("AW_TEMPO")) : 1.0;
  ring = calloc(RING_KAP, sizeof(int32_t));
  if (!ring) { melden("{\"e\":\"fehler\",\"id\":\"\",\"text\":\"zu wenig Speicher\"}"); return 1; }
  aus_thread_start();
  pthread_t td, ta;
  pthread_create(&td, NULL, dekoder_thread, NULL);
  pthread_create(&ta, NULL, ausgabe_thread, NULL);
  melden("{\"e\":\"bereit\",\"version\":\"" ENGINE_VERSION "\"}");
  size_t kap = 1 << 16;
  char *zeile = malloc(kap);
  size_t len = 0;
  int c;
  while ((c = fgetc(stdin)) != EOF) {
    if (c == '\n') {
      zeile[len] = 0;
      Befehl b;
      if (len > 0 && befehl_lesen(zeile, &b) == 0) {
        int ende = !strcmp(b.c, "beenden");
        ausfuehren(&b);
        befehl_frei(&b);
        if (ende) break;
      } else if (len > 0) {
        befehl_frei(&b);
        melden("{\"e\":\"fehler\",\"id\":\"\",\"text\":\"Befehl nicht verstanden\"}");
      }
      len = 0;
      continue;
    }
    if (len + 2 >= kap) { kap *= 2; char *z = realloc(zeile, kap); if (!z) break; zeile = z; }
    zeile[len++] = (char)c;
  }
  pthread_mutex_lock(&G);
  beenden = 1;
  titel_unterbrechen(dek); titel_unterbrechen(naechst); titel_unterbrechen(vorher);
  pthread_cond_broadcast(&G_dek);
  pthread_cond_broadcast(&G_aus);
  pthread_mutex_unlock(&G);
  pthread_join(td, NULL);
  pthread_join(ta, NULL);
  titel_frei(dek); titel_frei(naechst); titel_frei(vorher); titel_frei(anf_laden); titel_frei(anf_vormerken_t);
  free(zeile);
  aus_thread_ende();
  return 0;
}
