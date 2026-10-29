// Kern des selbstentpackenden Pakets (plattformunabhängig, auch unter Linux testbar): xz-Strom lesen, Dateien anlegen.
#pragma once
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  void *u;
  uint64_t laenge;                                                   // Länge des xz-Stroms
  size_t (*lesen)(void *u, void *buf, size_t n);                      // aus dem xz-Strom lesen (0 = Ende/Fehler)
  int (*datei_neu)(void *u, const char *pfad);                        // relativer Pfad (UTF-8, '/'); 0 = ok
  int (*datei_schreiben)(void *u, const void *b, size_t n);           // 0 = ok
  void (*datei_zu)(void *u);
  void (*stand)(void *u, int prozent);
} SfxZiel;

/** 0 = alles ausgepackt; sonst Fehlertext in fehler */
int sfx_auspacken(SfxZiel *z, char *fehler, size_t fn);

#ifdef __cplusplus
}
#endif
