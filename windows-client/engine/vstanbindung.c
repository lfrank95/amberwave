// VST3-Anbindung (Engine-Seite): gemeinsamer Speicher + Ereignisse zum Host-Prozess, Pegelmeldung für die Rack-Module.
#ifdef _WIN32
#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <math.h>
#include "vstanbindung.h"
#include "../vsthost/vstshm.h"

void melden(const char *fmt, ...);

typedef struct {
  int an;
  HANDLE map, ein, aus;
  VstShm *shm;
  int folge;          /* Zeitüberschreitungen hintereinander */
  int tot;            /* ausgefallen: Durchlauf, bis neu angebunden */
  float pegel_ein[2], pegel_aus[2];   /* Spitzen je Kanal seit der letzten Meldung */
  long frames;        /* seit der letzten Pegelmeldung */
  long aufrufe, zu_spaet;
} Slot;
static Slot slots[VST_SLOTS];

#define FRIST_MS 40
#define FOLGE_MAX 8

void vst_ab(int s) {
  if (s < 0 || s >= VST_SLOTS) return;
  Slot *z = &slots[s];
  if (!z->an) return;
  z->an = 0;
  if (z->shm) UnmapViewOfFile(z->shm);
  if (z->map) CloseHandle(z->map);
  if (z->ein) CloseHandle(z->ein);
  if (z->aus) CloseHandle(z->aus);
  memset(z, 0, sizeof *z);
  melden("{\"e\":\"vstab\",\"s\":%d}", s);
}

int vst_an(int s, const char *shm, const char *ein, const char *aus) {
  if (s < 0 || s >= VST_SLOTS || !shm || !ein || !aus) return 0;
  vst_ab(s);
  Slot *z = &slots[s];
  z->map = OpenFileMappingA(FILE_MAP_ALL_ACCESS, FALSE, shm);
  z->ein = OpenEventA(EVENT_ALL_ACCESS, FALSE, ein);
  z->aus = OpenEventA(EVENT_ALL_ACCESS, FALSE, aus);
  if (z->map) z->shm = (VstShm *)MapViewOfFile(z->map, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(VstShm));
  if (!z->map || !z->ein || !z->aus || !z->shm) {
    DWORD e = GetLastError();
    melden("{\"e\":\"vstfehler\",\"s\":%d,\"text\":\"Anbinden an den Host fehlgeschlagen (Windows-Fehler %lu)\"}", s, (unsigned long)e);
    if (z->shm) UnmapViewOfFile(z->shm);
    if (z->map) CloseHandle(z->map);
    if (z->ein) CloseHandle(z->ein);
    if (z->aus) CloseHandle(z->aus);
    memset(z, 0, sizeof *z);
    return 0;
  }
  z->an = 1;
  melden("{\"e\":\"vstan\",\"s\":%d}", s);
  return 1;
}

int vst_block(int s, float *const *x, int kan, int n, double rate) {
  if (s < 0 || s >= VST_SLOTS) return 0;
  Slot *z = &slots[s];
  if (!z->an || z->tot || kan != 2 || n <= 0 || n > VST_MAXN) return 0;
  VstShm *m = z->shm;
  m->rate = (int32_t)(rate + 0.5);
  m->n = n;
  float pe[2] = { 0, 0 };
  for (int c = 0; c < 2; c++) {
    memcpy(m->ein[c], x[c], sizeof(float) * (size_t)n);
    for (int i = 0; i < n; i++) { float a = fabsf(x[c][i]); if (a > pe[c]) pe[c] = a; }
  }
  ResetEvent(z->aus);
  z->aufrufe++;
  DWORD w = SignalObjectAndWait(z->ein, z->aus, FRIST_MS, FALSE);
  if (w != WAIT_OBJECT_0) {
    z->zu_spaet++;
    if (++z->folge >= FOLGE_MAX) {
      z->tot = 1;
      melden("{\"e\":\"vstfehler\",\"s\":%d,\"text\":\"Der Plug-in-Prozess antwortet nicht mehr – das Signal läuft ohne ihn weiter\"}", s);
    }
    return 0;
  }
  z->folge = 0;
  float pa[2] = { 0, 0 };
  for (int c = 0; c < 2; c++) {
    memcpy(x[c], m->aus[c], sizeof(float) * (size_t)n);
    for (int i = 0; i < n; i++) { float a = fabsf(x[c][i]); if (a > pa[c]) pa[c] = a; }
  }
  for (int c = 0; c < 2; c++) {
    if (pe[c] > z->pegel_ein[c]) z->pegel_ein[c] = pe[c];
    if (pa[c] > z->pegel_aus[c]) z->pegel_aus[c] = pa[c];
  }
  z->frames += n;
  if (z->frames >= rate / 40) {   /* 40 Meldungen/s: Spitzen genau an dieser Stelle der Kette (vor/hinter dem Plug-in, vor dem Lautheits-Angleich) */
    melden("{\"e\":\"vstpegel\",\"s\":%d,\"i\":[%.5f,%.5f],\"a\":[%.5f,%.5f]}", s, z->pegel_ein[0], z->pegel_ein[1], z->pegel_aus[0], z->pegel_aus[1]);
    z->pegel_ein[0] = z->pegel_ein[1] = z->pegel_aus[0] = z->pegel_aus[1] = 0; z->frames = 0;
  }
  return 1;
}
#endif
