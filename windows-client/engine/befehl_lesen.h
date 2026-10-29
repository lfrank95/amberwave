// JSON-Befehle der Engine lesen (eine Zeile = ein Objekt; "w.<name>" = Effektwert als Zahl, Text oder Zahlenliste).
// Gemeinsam für die Engine (engine.c) und den Server-Renderer (aw_render.c).
#pragma once
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../../dsp/aw_dsp.h"

typedef struct {
  char *c, *id, *url, *kopf, *geraet, *art, *reihe, *an_liste, *liste;
  double pos, wert, gain; int spielen, exklusiv, an, hat_pos, hat_wert, hat_spielen, hat_exklusiv, hat_gain, hat_an;
  /* Effektwerte: Schlüssel "w.<name>" → Zahl, Text oder Zahlenliste */
  AwWert w[96]; char *w_namen[96]; char *w_texte[96]; double *w_listen[96]; int nw;
} Befehl;

static void utf8_anhaengen(char **o, unsigned cp) {
  char *p = *o;
  if (cp < 0x80) *p++ = (char)cp;
  else if (cp < 0x800) { *p++ = (char)(0xC0 | (cp >> 6)); *p++ = (char)(0x80 | (cp & 0x3F)); }
  else if (cp < 0x10000) { *p++ = (char)(0xE0 | (cp >> 12)); *p++ = (char)(0x80 | ((cp >> 6) & 0x3F)); *p++ = (char)(0x80 | (cp & 0x3F)); }
  else { *p++ = (char)(0xF0 | (cp >> 18)); *p++ = (char)(0x80 | ((cp >> 12) & 0x3F)); *p++ = (char)(0x80 | ((cp >> 6) & 0x3F)); *p++ = (char)(0x80 | (cp & 0x3F)); }
  *o = p;
}

static const char *ws(const char *p) { while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++; return p; }

static const char *str_lesen(const char *p, char **aus) {
  // p zeigt auf '"'
  size_t n = strlen(p);
  char *o = malloc(n + 1), *q = o;
  p++;
  while (*p && *p != '"') {
    if (*p == '\\') {
      p++;
      switch (*p) {
        case 'n': *q++ = '\n'; p++; break;
        case 'r': *q++ = '\r'; p++; break;
        case 't': *q++ = '\t'; p++; break;
        case 'b': *q++ = '\b'; p++; break;
        case 'f': *q++ = '\f'; p++; break;
        case 'u': {
          unsigned cp = 0;
          if (sscanf(p + 1, "%4x", &cp) != 1) { p++; break; }
          p += 5;
          if (cp >= 0xD800 && cp < 0xDC00 && p[0] == '\\' && p[1] == 'u') {
            unsigned lo = 0;
            if (sscanf(p + 2, "%4x", &lo) == 1 && lo >= 0xDC00 && lo < 0xE000) { cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); p += 6; }
          }
          utf8_anhaengen(&q, cp);
          break;
        }
        default: if (*p) *q++ = *p++; break;
      }
    } else *q++ = *p++;
  }
  *q = 0;
  if (*p == '"') p++;
  *aus = o;
  return p;
}

static int befehl_lesen(const char *zeile, Befehl *b) {
  memset(b, 0, sizeof *b);
  const char *p = ws(zeile);
  if (*p != '{') return -1;
  p++;
  for (;;) {
    p = ws(p);
    if (*p == '}') break;
    if (*p != '"') return -1;
    char *k = NULL;
    p = str_lesen(p, &k);
    p = ws(p);
    if (*p != ':') { free(k); return -1; }
    p = ws(p + 1);
    int wk = !strncmp(k, "w.", 2) && b->nw < 96;
    if (*p == '[') {
      // Zahlenliste (EQ-Koeffizienten)
      double *l = malloc(sizeof(double) * 512); int n = 0;
      p = ws(p + 1);
      while (*p && *p != ']') {
        char *e; double d = strtod(p, &e);
        if (e == p) break;
        if (n < 512) l[n++] = d;
        p = ws(e);
        if (*p == ',') p = ws(p + 1);
      }
      if (*p == ']') p++;
      if (wk) { int i = b->nw++; b->w_namen[i] = strdup(k + 2); b->w_listen[i] = l; memset(&b->w[i], 0, sizeof b->w[i]); b->w[i].name = b->w_namen[i]; b->w[i].liste = l; b->w[i].liste_n = n; }
      else free(l);
    } else if (*p == '"') {
      char *v = NULL;
      p = str_lesen(p, &v);
      char **ziel = !strcmp(k, "c") ? &b->c : !strcmp(k, "id") ? &b->id : !strcmp(k, "url") ? &b->url : !strcmp(k, "kopf") ? &b->kopf : !strcmp(k, "geraet") ? &b->geraet
        : !strcmp(k, "art") ? &b->art : !strcmp(k, "reihe") ? &b->reihe : !strcmp(k, "stufen") ? &b->an_liste : !strcmp(k, "liste") ? &b->liste : NULL;
      if (wk) { int i = b->nw++; b->w_namen[i] = strdup(k + 2); b->w_texte[i] = v; memset(&b->w[i], 0, sizeof b->w[i]); b->w[i].name = b->w_namen[i]; b->w[i].text = v; }
      else if (ziel) { free(*ziel); *ziel = v; } else free(v);
    } else if (!strncmp(p, "true", 4) || !strncmp(p, "false", 5)) {
      int w = *p == 't';
      p += w ? 4 : 5;
      if (!strcmp(k, "spielen")) { b->spielen = w; b->hat_spielen = 1; }
      else if (!strcmp(k, "exklusiv")) { b->exklusiv = w; b->hat_exklusiv = 1; }
      else if (!strcmp(k, "an")) { b->an = w; b->hat_an = 1; }
      else if (wk) { int i = b->nw++; b->w_namen[i] = strdup(k + 2); memset(&b->w[i], 0, sizeof b->w[i]); b->w[i].name = b->w_namen[i]; b->w[i].zahl = w; }
    } else if (!strncmp(p, "null", 4)) p += 4;
    else {
      char *e;
      double d = strtod(p, &e);
      if (e == p) { free(k); return -1; }
      p = e;
      if (!strcmp(k, "pos")) { b->pos = d; b->hat_pos = 1; }
      else if (!strcmp(k, "wert")) { b->wert = d; b->hat_wert = 1; }
      else if (!strcmp(k, "gain")) { b->gain = d; b->hat_gain = 1; }
      else if (wk) { int i = b->nw++; b->w_namen[i] = strdup(k + 2); memset(&b->w[i], 0, sizeof b->w[i]); b->w[i].name = b->w_namen[i]; b->w[i].zahl = d; }
    }
    free(k);
    p = ws(p);
    if (*p == ',') { p++; continue; }
    if (*p == '}') break;
    return -1;
  }
  return b->c ? 0 : -1;
}

static void befehl_frei(Befehl *b) {
  free(b->c); free(b->id); free(b->url); free(b->kopf); free(b->geraet); free(b->art); free(b->reihe); free(b->an_liste); free(b->liste);
  for (int i = 0; i < b->nw; i++) { free(b->w_namen[i]); free(b->w_texte[i]); free(b->w_listen[i]); }
}

static const AwWert *wv(const Befehl *b, const char *n) { for (int i = 0; i < b->nw; i++) if (!strcmp(b->w[i].name, n)) return &b->w[i]; return NULL; }
static double wz(const Befehl *b, const char *n, double std) { const AwWert *w = wv(b, n); return w && !w->text && !w->liste ? w->zahl : std; }
static const char *wt(const Befehl *b, const char *n) { const AwWert *w = wv(b, n); return w ? w->text : NULL; }

