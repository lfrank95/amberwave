// Geräteschicht der Engine: reicht an die Ausgabe (WASAPI, ASIO, Testgerät) durch – oder rechnet bei fester Ausgaberate
// die Abtastrate um (dsp/umrechner.c), mit eigenem Puffer zwischen Engine und Gerät. Die Engine sieht dabei immer die Rate
// der Quelle; Wechsel der Quellrate gehen nahtlos (das Gerät läuft weiter).
#pragma once
#include "ausgabe.h"

typedef struct Geraet Geraet;

/** fest: Ausgaberate des Geräts (0 = folgt der Quelle, alles wird direkt durchgereicht) */
Geraet *ger_oeffnen(const char *geraet, int exklusiv, int rate, int kanaele, int bits, int fest, AusInfo *info, char *fehler, size_t fn);
/** neue Quellrate bei fester Ausgaberate, ohne Pause (0 = gelungen) */
int ger_nahtlos(Geraet *g, int rate, int bits, AusInfo *info);
/** Gerät auf neue Rate/Kanäle umstellen ohne Schließen (ASIO, nur ohne feste Rate) */
int ger_umstellen(Geraet *g, int rate, int kanaele, int bits, AusInfo *info, char *fehler, size_t fn);
/** Umrechnungsfilter für diese Quellrate bei fester Ausgaberate vorab im Hintergrund rechnen (billig, wenn schon da) */
void ger_vorwaermen(int quellrate, int fest);
int ger_fest(const Geraet *g);
/** feste Ausgaberate, mit der das Gerät offen ist (0 = folgt der Quelle) */
int ger_fest_rate(const Geraet *g);
/** anderer Ausgang desselben ASIO-Treibers (wirkt beim nächsten ger_umstellen): 1 = geändert, 0 = gleich, −1 = geht nicht */
int ger_umleiten(Geraet *g, const char *geraet);
int ger_warten(Geraet *g, int ms);
int ger_frei(Geraet *g);
void *ger_puffer(Geraet *g, int frames);
int ger_puffer_fertig(Geraet *g, int frames);
int64_t ger_gespielt(Geraet *g);
int ger_start(Geraet *g);
int ger_stopp(Geraet *g);
int ger_zuruecksetzen(Geraet *g);
int ger_ausklingen(Geraet *g, int ms);
/** läuft das Gerät bei Titelwechsel, Spulen und Pause durch (ASIO)? */
int ger_durchlaufend(Geraet *g);
/** durchlaufend: kurz ausblenden, Rest verwerfen, Zeitrechnung neu ab 0 (wie zurücksetzen, ohne Anhalten). 0 = gelungen */
int ger_weich_neu(Geraet *g, int ms);
/** vor echtem Anhalten: ausspielen + Stille in Länge der Treiberlatenz */
void ger_nachlauf(Geraet *g);
long ger_unterlaeufe(Geraet *g);
void ger_schliessen(Geraet *g);
int ger_verloren(Geraet *g);
int ger_takt(Geraet *g);
void ger_protokoll(Geraet *g, char *buf, size_t n);
