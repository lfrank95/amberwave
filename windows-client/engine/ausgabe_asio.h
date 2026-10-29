// Ausgabe über ASIO (Treiber des Interfaces, an Windows vorbei): bitgenau, Abtastrate der Datei, eigener Puffer zwischen
// Engine und Treiber-Rückruf. Die Funktionen entsprechen aus_* in ausgabe.h; ausgabe_wasapi.c (bzw. ausgabe_test.c)
// leitet Geräte mit der ID „asio:…“ hierher.
#pragma once
#include "ausgabe.h"

typedef struct AsioAus AsioAus;

/** Treiber als JSON-Einträge (je „,{…}“) an buf anhängen */
void asio_geraete_json(char **buf, size_t *len, size_t *kap);
AsioAus *asio_oeffnen(const char *id, int rate, int kanaele, int bits, AusInfo *info, char *fehler, size_t fn);
int asio_warten(AsioAus *a, int ms);
int asio_frei(AsioAus *a);
void *asio_puffer(AsioAus *a, int frames);
int asio_puffer_fertig(AsioAus *a, int frames);
int64_t asio_gespielt(AsioAus *a);
int asio_start(AsioAus *a);
int asio_stopp(AsioAus *a);
int asio_zuruecksetzen(AsioAus *a);
/** die nächsten ms im Puffer sanft ausblenden, Rest verwerfen, warten bis Stille läuft (vor dem Anhalten) */
int asio_ausklingen(AsioAus *a, int ms);
int64_t asio_weich_leeren(AsioAus *a, int ms);
void asio_nachlauf(AsioAus *a);
long asio_unterlaeufe(AsioAus *a);
void asio_schliessen(AsioAus *a);
int asio_verloren(AsioAus *a);
/** neue Rate/Kanäle, ohne den Treiber neu zu laden (0 = gelungen) */
int asio_umstellen(AsioAus *a, int rate, int kanaele, int bits, AusInfo *info, char *fehler, size_t fn);
/** Takt laut Sample-Position des Treibers: 1 = stabil, 0 = noch nicht, −1 = keine Zeitinfo vom Treiber */
int asio_takt(AsioAus *a);
/** was bei der letzten Umstellung geschah, als JSON-Array [{ms, t}] */
void asio_protokoll(char *buf, size_t n);
/** gehören beide Geräte-IDs („asio:{…}#karte“) zum selben Treiber? */
int asio_gleicher_treiber(const char *g1, const char *g2);
/** andere Kanalkarte (gleicher Treiber; wirkt beim nächsten Umstellen). 1 = geändert, 0 = gleich, −1 = anderer Treiber */
int asio_umleiten(AsioAus *a, const char *id);
/** Namen der Ausgänge des Treibers als JSON-Array (lädt ihn kurz, wenn keiner offen ist). 0 = gelungen */
int asio_kanal_namen(const char *id, char *buf, size_t n, char *fehler, size_t fn);
/** Einstellungsfenster des Treibers (Puffergröße usw.) */
int asio_einstellungen(AsioAus *a);
/** dasselbe für den gerade offenen Treiber (0 = keiner offen) */
int asio_einstellungen_aktiv(void);

/* Plattform: Treiber auflisten und laden (Windows: Registry + COM; Test: Attrappe) */
typedef struct IASIO IASIO;
int asio_treiber_liste(char ids[][80], char namen[][128], int max);
IASIO *asio_treiber_laden(const char *id, char *fehler, size_t fn);
