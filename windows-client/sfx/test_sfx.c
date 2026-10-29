// Test des Paket-Kerns unter Linux: test_sfx paket.exe zielordner
#include "sfx_kern.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
static FILE *ein, *aus;
static const char *wurzel;
static size_t l(void *u, void *b, size_t n) { (void)u; return fread(b, 1, n, ein); }
static int neu(void *u, const char *p) {
  (void)u; char v[4096]; snprintf(v, sizeof v, "%s/%s", wurzel, p);
  for (char *s = v + strlen(wurzel) + 1; *s; s++) if (*s == '/') { *s = 0; mkdir(v, 0755); *s = '/'; }
  aus = fopen(v, "wb"); return aus ? 0 : -1;
}
static int schr(void *u, const void *b, size_t n) { (void)u; return fwrite(b, 1, n, aus) == n ? 0 : -1; }
static void zu(void *u) { (void)u; if (aus) fclose(aus); aus = NULL; }
int main(int argc, char **argv) {
  if (argc < 3) return 2;
  ein = fopen(argv[1], "rb"); wurzel = argv[2]; mkdir(wurzel, 0755);
  fseek(ein, -32, SEEK_END); unsigned char a[32]; if (fread(a, 1, 32, ein) != 32 || memcmp(a + 24, "AWSFX002", 8)) { puts("kein Paket"); return 1; }
  uint64_t b, n; memcpy(&b, a, 8); memcpy(&n, a + 8, 8); fseek(ein, (long)b, SEEK_SET);
  SfxZiel z = {0}; z.laenge = n; z.lesen = l; z.datei_neu = neu; z.datei_schreiben = schr; z.datei_zu = zu;
  char f[300] = "";
  int r = sfx_auspacken(&z, f, sizeof f);
  printf("%s\n", r ? f : "ok");
  return r;
}
