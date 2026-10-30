// Sättigungs-Schwerpunkt (Emphase) für Glow, Iron und Silk: ein EQ vor dem Effekt verschiebt, wo er sättigt, das exakte
// Gegenteil danach hebt die Klangänderung wieder auf (Ausgleich 100 %) – oder nur teilweise (darunter bleibt ein Teil der
// Anhebung hörbar, wie bei einem Enhancer). Glocken und Kuhschwänze nach RBJ: dieselbe Kurve mit −g ist exakt der Kehrwert,
// leise Signale kommen bei 100 % Ausgleich also unverändert heraus. Liegt um den ganzen Effekt (auch Mix, Mitte/Seite,
// Delta), daher bleibt der trockene Weg bei 100 % unberührt.
// Werte: "sp" = Liste mit SP_BAENDER × [typ, frequenz, gain dB, q] (typ 0 aus, 1 Glocke, 2 Tiefen-, 3 Höhen-Kuhschwanz),
//        "sp_ausgleich" = 0 … 1.
#include "intern.h"

static void biquad(double k[5], int typ, double f, double g, double q, double sr) {
  k[0] = 1; k[1] = k[2] = k[3] = k[4] = 0;
  if (typ < 1 || typ > 3 || fabs(g) < 1e-6) return;
  if (f > sr * 0.49) f = sr * 0.49;
  if (f < 10) f = 10;
  if (q < 0.1) q = 0.1;
  if (q > 20) q = 20;
  double A = pow(10, g / 40), w0 = 2 * M_PI * f / sr, c = cos(w0), s = sin(w0), b0, b1, b2, a0, a1, a2;
  if (typ == 1) {
    double al = s / (2 * q);
    b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A;
  } else {
    // Kuhschwanz: q als Steilheit (0,707 = Butterworth-artig ohne Überschwinger)
    double al = s / (2 * q), sA = 2 * sqrt(A) * al;
    if (typ == 2) {
      b0 = A * ((A + 1) - (A - 1) * c + sA); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - sA);
      a0 = (A + 1) + (A - 1) * c + sA; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - sA;
    } else {
      b0 = A * ((A + 1) + (A - 1) * c + sA); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - sA);
      a0 = (A + 1) - (A - 1) * c + sA; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - sA;
    }
  }
  k[0] = b0 / a0; k[1] = b1 / a0; k[2] = b2 / a0; k[3] = a1 / a0; k[4] = a2 / a0;
}

typedef struct Schwerpunkt {
  double band[SP_BAENDER][4], ausgleich;
  double vor[SP_BAENDER][5], nach[SP_BAENDER][5];         // aktuell
  double vor_z[SP_BAENDER][5], nach_z[SP_BAENDER][5];     // Ziel (gleitet über den nächsten Block)
  int ziel_neu, aktiv, aktiv_ziel;
  double *zustand[16];   // je Kanal: vor und nach, je Band 2 Zustände
  float *puffer; int kap;
} Schwerpunkt;

static int sp_rechnen(Schwerpunkt *s, double sr) {
  int an = 0;
  for (int b = 0; b < SP_BAENDER; b++) {
    int typ = (int)s->band[b][0];
    double g = s->band[b][2];
    biquad(s->vor_z[b], typ, s->band[b][1], g, s->band[b][3], sr);
    biquad(s->nach_z[b], typ, s->band[b][1], -g * s->ausgleich, s->band[b][3], sr);
    if (typ >= 1 && typ <= 3 && fabs(g) >= 1e-6) an = 1;
  }
  return an;
}

void sp_setzen(AwFx *fx, const AwWert *w, int n) {
  const AwWert *l = wert_liste(w, n, "sp");
  double a;
  int ausg = wert_zahl(w, n, "sp_ausgleich", &a);
  if (!l && !ausg) return;
  Schwerpunkt *s = fx->sp;
  if (!s) {
    s = fx->sp = calloc(1, sizeof *s);
    s->ausgleich = 1;
    for (int b = 0; b < SP_BAENDER; b++) { s->vor[b][0] = s->nach[b][0] = 1; }
  }
  if (l) for (int b = 0; b < SP_BAENDER; b++) for (int i = 0; i < 4; i++) s->band[b][i] = b * 4 + i < l->liste_n ? l->liste[b * 4 + i] : 0;
  if (ausg) s->ausgleich = klemmen(a, 0, 1);
  int an = sp_rechnen(s, fx->sr);
  if (!fx->gestartet || !s->aktiv) {
    // vor dem ersten Block oder aus dem Aus: sofort übernehmen (Zustände sind leer)
    memcpy(s->vor, s->vor_z, sizeof s->vor); memcpy(s->nach, s->nach_z, sizeof s->nach);
    s->ziel_neu = 0;
    if (an && !s->aktiv) for (int c = 0; c < 16; c++) if (s->zustand[c]) memset(s->zustand[c], 0, sizeof(double) * SP_BAENDER * 4);
    s->aktiv = an;
  } else s->ziel_neu = 1;
  s->aktiv_ziel = an;
}

static void filtern(double *z, double (*alt)[5], double (*neu)[5], const float *x, float *y, int n) {
  for (int b = 0; b < SP_BAENDER; b++) {
    const double *k0 = alt[b], *k1 = neu ? neu[b] : NULL;
    if (!k1 && k0[0] == 1 && k0[1] == 0 && k0[2] == 0 && k0[3] == 0 && k0[4] == 0) { if (x != y) memcpy(y, x, sizeof(float) * (size_t)n); x = y; continue; }
    double *s = z + b * 2;
    for (int i = 0; i < n; i++) {
      double t = k1 ? (double)(i + 1) / n : 0;
      double b0 = k1 ? k0[0] + (k1[0] - k0[0]) * t : k0[0], b1 = k1 ? k0[1] + (k1[1] - k0[1]) * t : k0[1], b2 = k1 ? k0[2] + (k1[2] - k0[2]) * t : k0[2];
      double a1 = k1 ? k0[3] + (k1[3] - k0[3]) * t : k0[3], a2 = k1 ? k0[4] + (k1[4] - k0[4]) * t : k0[4];
      double v = x[i];
      double w = b0 * v + s[0];
      s[0] = b1 * v - a1 * w + s[1];
      s[1] = b2 * v - a2 * w;
      y[i] = (float)w;
    }
    if (fabs(s[0]) < 1e-30) s[0] = 0;
    if (fabs(s[1]) < 1e-30) s[1] = 0;
    x = y;
  }
}

/** Effekt-Block mit Schwerpunkt: vor → Effekt → nach. Ohne aktive Bänder direkt der Effekt (bitgleich wie bisher). */
void sp_block(AwFx *fx, const float *const *ein, float *const *aus, int kan, int n) {
  Schwerpunkt *s = fx->sp;
  if (!s || (!s->aktiv && !s->aktiv_ziel)) { fx->block(fx, ein, aus, kan, n); return; }
  if (kan > 16) kan = 16;
  if (s->kap < n * kan) { free(s->puffer); s->puffer = malloc(sizeof(float) * (size_t)(n * kan)); s->kap = n * kan; }
  const float *e2[16];
  for (int c = 0; c < kan; c++) {
    if (!s->zustand[c]) s->zustand[c] = calloc(SP_BAENDER * 4, sizeof(double));
    if (!ein || !ein[c]) { e2[c] = NULL; continue; }
    float *p = s->puffer + c * n;
    filtern(s->zustand[c], s->vor, s->ziel_neu ? s->vor_z : NULL, ein[c], p, n);
    e2[c] = p;
  }
  fx->block(fx, ein ? e2 : NULL, aus, kan, n);
  for (int c = 0; c < kan; c++) filtern(s->zustand[c] + SP_BAENDER * 2, s->nach, s->ziel_neu ? s->nach_z : NULL, aus[c], aus[c], n);
  if (s->ziel_neu) { memcpy(s->vor, s->vor_z, sizeof s->vor); memcpy(s->nach, s->nach_z, sizeof s->nach); s->ziel_neu = 0; }
  s->aktiv = s->aktiv_ziel;
}

void sp_frei(AwFx *fx) {
  Schwerpunkt *s = fx->sp;
  if (!s) return;
  for (int c = 0; c < 16; c++) free(s->zustand[c]);
  free(s->puffer);
  free(s);
  fx->sp = NULL;
}
