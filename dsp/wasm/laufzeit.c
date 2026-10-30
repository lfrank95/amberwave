// Laufzeit für den WebAssembly-Build ohne C-Bibliothek: Speicherverwaltung und die paar Zeichenketten-/Speicherfunktionen.
// Speicher: Blöcke mit Größenkopf, freie Blöcke in einer Liste (erste passende, Nachbarn werden zusammengelegt).
// Die Effekte reservieren fast nur beim Anlegen und bei Blockgrößen-Änderungen – das reicht dafür völlig.
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>

extern unsigned char __heap_base;
typedef struct Kopf { size_t groesse; struct Kopf *naechster; } Kopf;   // groesse inkl. Kopf, Vielfaches von 16
#define KOPF ((sizeof(Kopf) + 15) & ~(size_t)15)
static Kopf *frei_liste = NULL;
static uintptr_t ende = 0;

static void *mehr(size_t n) {
  if (!ende) ende = ((uintptr_t)&__heap_base + 15) & ~(uintptr_t)15;
  uintptr_t neu = ende + n;
  size_t seiten = __builtin_wasm_memory_size(0);
  if (neu > seiten * 65536) {
    size_t brauche = (neu - seiten * 65536 + 65535) / 65536;
    if (__builtin_wasm_memory_grow(0, brauche) == (size_t)-1) return NULL;
  }
  void *p = (void *)ende;
  ende = neu;
  return p;
}

void *malloc(size_t n) {
  if (n == 0) n = 1;
  size_t g = (n + KOPF + 15) & ~(size_t)15;
  Kopf **vor = &frei_liste;
  for (Kopf *k = frei_liste; k; vor = &k->naechster, k = k->naechster) {
    if (k->groesse >= g) {
      if (k->groesse - g >= 64) {   // teilen
        Kopf *rest = (Kopf *)((unsigned char *)k + g);
        rest->groesse = k->groesse - g; rest->naechster = k->naechster;
        *vor = rest; k->groesse = g;
      } else *vor = k->naechster;
      return (unsigned char *)k + KOPF;
    }
  }
  Kopf *k = mehr(g);
  if (!k) return NULL;
  k->groesse = g;
  return (unsigned char *)k + KOPF;
}

void free(void *p) {
  if (!p) return;
  Kopf *k = (Kopf *)((unsigned char *)p - KOPF);
  // nach Adresse sortiert einfügen und mit Nachbarn verschmelzen
  Kopf **vor = &frei_liste;
  while (*vor && *vor < k) vor = &(*vor)->naechster;
  k->naechster = *vor; *vor = k;
  if (k->naechster && (unsigned char *)k + k->groesse == (unsigned char *)k->naechster) { k->groesse += k->naechster->groesse; k->naechster = k->naechster->naechster; }
  if (vor != &frei_liste) {
    Kopf *v = (Kopf *)((unsigned char *)vor - offsetof(Kopf, naechster));
    if ((unsigned char *)v + v->groesse == (unsigned char *)k) { v->groesse += k->groesse; v->naechster = k->naechster; }
  }
}

void *calloc(size_t n, size_t g) {
  size_t s = n * g;
  void *p = malloc(s);
  if (p) memset(p, 0, s);
  return p;
}

void *realloc(void *p, size_t n) {
  if (!p) return malloc(n);
  Kopf *k = (Kopf *)((unsigned char *)p - KOPF);
  size_t alt = k->groesse - KOPF;
  if (alt >= n) return p;
  void *q = malloc(n);
  if (!q) return NULL;
  memcpy(q, p, alt);
  free(p);
  return q;
}

void *memset(void *d, int c, size_t n) { __builtin_memset(d, c, n); return d; }
void *memcpy(void *d, const void *s, size_t n) { __builtin_memcpy(d, s, n); return d; }
void *memmove(void *d, const void *s, size_t n) { __builtin_memmove(d, s, n); return d; }
int strcmp(const char *a, const char *b) { while (*a && *a == *b) { a++; b++; } return (unsigned char)*a - (unsigned char)*b; }
size_t strlen(const char *s) { size_t n = 0; while (s[n]) n++; return n; }
