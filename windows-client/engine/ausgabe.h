// Ausgabe-Schnittstelle der Engine: Windows (WASAPI exklusiv/geteilt) oder Testgerät (Linux, schreibt in eine Datei).
#pragma once
#include <stdint.h>
#include <stddef.h>

typedef enum { FMT_S16 = 1, FMT_S24P, FMT_S32_24, FMT_S32, FMT_F32 } AusFormat;

typedef struct {
  int rate, kanaele;
  AusFormat fmt;
  int exklusiv;          // 1 = exklusiv (bitgenau möglich), 0 = geteilt (Windows mischt und wandelt)
  int puffer_frames;     // Größe eines Gerätepuffers
  int geraet_rate;       // Rate, mit der das Gerät wirklich läuft (geteilt: Mischrate von Windows)
  int geraet_kanaele;    // Kanäle des Geräts (Lautsprecher-Einstellung in Windows)
  int asio;              // 1 = über einen ASIO-Treiber
  int umgerechnet;       // 1 = feste Ausgaberate, die Quelle wird umgerechnet (geraet.c)
  int latenz;            // vom Treiber gemeldete Ausgabelatenz in Frames (ASIO; 0 = unbekannt)
  int rate_gestellt;     // ASIO: der Treiber wurde eben auf eine andere Rate umgestellt (nur dann Anlauf abwarten)
  AusFormat fmt_geraet;  // dabei: Format am Gerät (fmt ist dann das, was die Engine schreibt)
  char geraet[256];      // Anzeigename
  char hinweis[200];     // warum z. B. nicht exklusiv
} AusInfo;

typedef struct Ausgabe Ausgabe;

/** Je Thread einmal (COM) */
void aus_thread_start(void);
void aus_thread_ende(void);
/** Geräteliste als JSON-Array (malloc) */
char *aus_geraete_json(void);
/** Gerät öffnen: rate/kanaele/bits der Quelle; exklusiv wird versucht, sonst geteilt (wenn erlaubt) */
Ausgabe *aus_oeffnen(const char *geraet, int exklusiv, int rate, int kanaele, int bits, AusInfo *info, char *fehler, size_t fn);
/** auf den nächsten Puffer warten (ms), 1 = Gerät will Daten */
int aus_warten(Ausgabe *a, int ms);
/** so viele Frames dürfen jetzt geschrieben werden */
int aus_frei(Ausgabe *a);
void *aus_puffer(Ausgabe *a, int frames);
int aus_puffer_fertig(Ausgabe *a, int frames);
/** wirklich gespielte Frames seit Öffnen bzw. letztem Zurücksetzen */
int64_t aus_gespielt(Ausgabe *a);
int aus_start(Ausgabe *a);
int aus_stopp(Ausgabe *a);
int aus_zuruecksetzen(Ausgabe *a);
/** vor dem Anhalten mitten in der Musik: kurz ausblenden statt abreißen (nur wo der Puffer noch änderbar ist, z. B. ASIO) */
int aus_ausklingen(Ausgabe *a, int ms);
/** Kann das Gerät durchlaufen (Titelwechsel/Spulen/Pause ohne Anhalten)? Bisher: ASIO */
int aus_durchlaufend(Ausgabe *a);
/** durchlaufend: die nächsten ms im Puffer ausblenden, Rest verwerfen; Rückgabe: Stand von aus_gespielt, an dem das
 *  nächste geschriebene Frame hörbar wird (−1 = geht nicht) */
int64_t aus_weich_leeren(Ausgabe *a, int ms);
/** vor einem echten Anhalten: alles ausspielen und dann so lange Stille, wie der Treiber an Latenz meldet (+ Rand) */
void aus_nachlauf(Ausgabe *a);
/** so oft ging dem Gerät bisher mitten im Puffer die Musik aus (ASIO; sonst 0) */
long aus_unterlaeufe(Ausgabe *a);
void aus_schliessen(Ausgabe *a);
/** dasselbe Gerät auf eine neue Rate/Kanalzahl umstellen, ohne es zu schließen (ASIO); −1 = geht nicht → neu öffnen */
int aus_umstellen(Ausgabe *a, int rate, int kanaele, int bits, AusInfo *info, char *fehler, size_t fn);
/** anderer Ausgang (Kanalkarte) desselben ASIO-Treibers, wirkt beim nächsten aus_umstellen; −1 = geht nicht */
int aus_umleiten(Ausgabe *a, const char *geraet);
/** Takt des Geräts laut Treiber (ASIO-Zeitinfo): 1 = stabil, 0 = noch nicht, −1 = unbekannt (dann misst die Engine selbst) */
int aus_takt(Ausgabe *a);
/** Protokoll der letzten Umstellung (ASIO) als JSON-Array; sonst „[]“ */
void aus_protokoll(Ausgabe *a, char *buf, size_t n);
/** 1 = Gerät verschwunden (abgesteckt) */
int aus_verloren(Ausgabe *a);
