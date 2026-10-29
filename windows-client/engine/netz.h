// HTTP(S)-Abruf für die Engine: Windows über WinHTTP (HTTPS, Proxy, Zertifikate des Systems), Linux nur HTTP (Tests).
#pragma once
#include <stdint.h>
#include <stddef.h>

typedef struct Netz Netz;

/** Anfrage starten (GET). kopf: zusätzliche Kopfzeilen "Name: Wert\r\n…" oder NULL. status/gesamt (-1 = unbekannt) */
Netz *netz_oeffnen(const char *url, const char *kopf, int *status, int64_t *gesamt, char *fehler, size_t fn);
/** bis zu n Bytes lesen: >0 gelesen, 0 Ende, <0 Fehler */
long netz_lesen(Netz *n, void *puffer, size_t groesse);
/** aus einem anderen Thread: laufendes Lesen sofort beenden */
void netz_abbrechen(Netz *n);
void netz_schliessen(Netz *n);
