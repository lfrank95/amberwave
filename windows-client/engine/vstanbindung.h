// Anbindung der VST3-Plug-ins an die Klangkette: je Plug-in ein eigener Host-Prozess (amberwave-vsthost.exe), Audio über gemeinsamen
// Speicher und zwei Ereignisse (siehe ../vsthost/vstshm.h). Fällt ein Host aus oder antwortet nicht, läuft das Signal an dieser
// Stelle unverändert weiter (und die Web-App erfährt es).
#pragma once
#define VST_SLOTS 8
#ifdef _WIN32
int vst_an(int slot, const char *shm, const char *ein, const char *aus);
void vst_ab(int slot);
/** Block in place durch das Plug-in; 0 = nicht bearbeitet (Slot leer, kein Stereo, ausgefallen) */
int vst_block(int slot, float *const *x, int kan, int n, double rate);
#else
static inline int vst_an(int s, const char *a, const char *b, const char *c) { (void)s; (void)a; (void)b; (void)c; return 0; }
static inline void vst_ab(int s) { (void)s; }
static inline int vst_block(int s, float *const *x, int kan, int n, double rate) { (void)s; (void)x; (void)kan; (void)n; (void)rate; return 0; }
#endif
