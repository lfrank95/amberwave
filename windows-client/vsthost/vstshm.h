// Gemeinsamer Speicher zwischen Engine und VST-Host (ein Block je Plug-in): die Engine schreibt `ein`, setzt das Ereignis „ein“,
// wartet auf „aus“ und liest `aus`. Struktur und Namen müssen in Engine (C) und Host (C++) übereinstimmen.
#pragma once
#include <stdint.h>
#define VST_MAXN 512      /* Frames je Aufruf (die Engine rechnet in Blöcken zu 128) */
typedef struct {
  int32_t rate;           /* Abtastrate der Engine (der Host stellt das Plug-in bei Änderung um) */
  int32_t n;              /* Frames in diesem Aufruf */
  int32_t zaehler;        /* vom Host hochgezählt (Lebenszeichen) */
  int32_t reserve;
  float ein[2][VST_MAXN];
  float aus[2][VST_MAXN];
} VstShm;
