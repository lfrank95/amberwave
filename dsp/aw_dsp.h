// Amberwave-DSP in C: Glow (Röhre), Iron (Übertrager), Silk (Band) und die EQ-Sektionen – dieselben Rechnungen wie die
// Audio-Worklets der Web-App (app/js/*-worklet.js), Sample für Sample gegen sie getestet (tests/dsp_vergleich).
// Plattformunabhängig (Windows-Client, später Windows Server und WebAssembly im Browser), ohne Abhängigkeiten außer libm.
//
// Verwendung:
//   AwFx *fx = aw_fx_neu("glow", 48000, seed);
//   aw_fx_setzen(fx, werte, n);                 // wie port.postMessage({drive: …, bias: …}) bzw. processorOptions
//   aw_fx_steuern(fx, "delta", 1);              // {delta:true}, {messen:true}
//   aw_fx_block(fx, ein, aus, kanaele, 128);    // wie process(): Parameter gleiten über genau diesen Block
//   if (aw_fx_faerbung(fx, w)) …                // neue Färbungsmessung (THD) für L/R, wie {faerb:[l,r]}
//   aw_fx_frei(fx);
// Blockgröße: wie im Browser 128 (Parameter gleiten je Block linear – andere Größen gehen, gleiten dann über diese).
// ein/aus: je Kanal ein Zeiger (float), dürfen identisch sein (in-place). ein[c] == NULL → Stille.
#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct AwFx AwFx;

/** ein Parameter: Zahl, Text (z. B. kern="eisen") oder Liste (EQ-Koeffizienten "k") */
typedef struct {
  const char *name;
  double zahl;
  const char *text;          /* gesetzt → Textwert */
  const double *liste;       /* gesetzt → Liste mit liste_n Werten */
  int liste_n;
} AwWert;

/** art: "glow", "iron", "silk", "eq". seed: Startwert der Zufallsquelle (Toleranz-Drift, Rauschen; 0 = fest) */
AwFx *aw_fx_neu(const char *art, double abtastrate, uint32_t seed);
void aw_fx_setzen(AwFx *fx, const AwWert *werte, int n);
/** was: "messen" (Färbungsmessung) oder "delta" (nur die Veränderung hören) */
void aw_fx_steuern(AwFx *fx, const char *was, int an);
void aw_fx_block(AwFx *fx, const float *const *ein, float *const *aus, int kanaele, int n);
/** 1 = neue Messung in w[0] (L) und w[1] (R), Bruchteil (0,01 = 1 %) */
int aw_fx_faerbung(AwFx *fx, float w[2]);
/** Verzögerung des nassen Wegs in Samples (für die Laufzeitanzeige) */
int aw_fx_latenz(AwFx *fx);
void aw_fx_frei(AwFx *fx);

/* ---------- Space: Upmix „Zwei Ebenen“ (wie raumklang-worklet.js) ---------- */
typedef struct AwUpmix AwUpmix;
/** transient/ducking in dB (Preset), effekte 0…1,5, breite 0…1, center 0/1 */
AwUpmix *aw_upmix_neu(double abtastrate, double transient, double ducking, double effekte, double breite, int center);
/** neue Stärken (wie port.postMessage({effekte, breite})); negativ = unverändert */
void aw_upmix_setzen(AwUpmix *u, double effekte, double breite);
/** ein Stereo-Stück; aus[0..6] = Raum L/R, Effekte L/R, Front L/R, Center (NULL = verwerfen); alles um aw_upmix_latenz() verzögert */
void aw_upmix_block(AwUpmix *u, const float *l, const float *r, float *const *aus, int n);
int aw_upmix_latenz(void);
void aw_upmix_frei(AwUpmix *u);

/* ---------- Faltung (Hall), partitioniert, ohne zusätzliche Latenz bei 128er-Blöcken ---------- */
typedef struct AwFaltung AwFaltung;
/** ir[0..ir_kan-1] je ir_n Samples; ein_kan 1 (mono → je IR-Kanal) oder 2 (L*IR0, R*IR1). Ausgabe immer 2 Kanäle */
AwFaltung *aw_faltung_neu(const float *const *ir, int ir_kan, int ir_n, int ein_kan);
/** n muss ein Vielfaches von 128 sein (wie Web Audio); ein[1] wird bei ein_kan 1 nicht gelesen */
void aw_faltung_block(AwFaltung *f, const float *const *ein, float *const *aus, int n);
void aw_faltung_frei(AwFaltung *f);

/* ---------- Space-Graph (Web-Audio-Graph als Text, siehe raumgraph.c und app/js/raumnativ.js) ---------- */
typedef struct AwRaum AwRaum;
/** Impulsantwort zu einer ID: Kanäle (je ir_n Samples) oder NULL */
typedef const float *const *(*AwIrSuche)(const char *id, int *kan, int *n, void *u);
AwRaum *aw_raum_neu(const char *text, double abtastrate, AwIrSuche ir, void *u, char *fehler, int fn);
/** Automation eines Parameters (gain bzw. delayTime): art "set", "ramp", "ziel" (tau), "stopp"; dt = Sekunden ab jetzt */
void aw_raum_param(AwRaum *r, int knoten, const char *art, double wert, double dt, double tau);
/** Nachricht an den Upmix (effekte/breite, negativ = unverändert) */
void aw_raum_nachricht(AwRaum *r, int knoten, double effekte, double breite);
/** ein Stück (beliebige Länge, aus[0..7] je n Frames); läuft um aw_raum_latenz() verzögert. Rückgabe: Ausgangskanäle */
int aw_raum_block(AwRaum *r, const float *const *ein, int ein_kan, float *const *aus, int n);
int aw_raum_kanaele(AwRaum *r);
/** trivialer Graph: nur die Gains von Ein- und Ausgang anwenden, ohne Verzögerung (in place) */
void aw_raum_direkt(AwRaum *r, float *const *x, int kan, int n);
/** nur Eingang → Ausgang (Space aus) */
int aw_raum_trivial(AwRaum *r);
/** keine Automation mehr offen, Ein- und Ausgang auf genau 1 */
int aw_raum_ruhig(AwRaum *r);
int aw_raum_latenz(void);
void aw_raum_frei(AwRaum *r);

/* ---------- Abtastraten-Umrechnung (feste Ausgaberate im Windows Client) ---------- */
typedef struct AwSrc AwSrc;
AwSrc *aw_src_neu(int rate_ein, int rate_aus, int kanaele);
/** Filter für ein Ratenpaar vorab rechnen (Hintergrund-Thread); spätere aw_src_neu-Aufrufe sind dann sofort fertig */
void aw_src_vorwaermen(int rate_ein, int rate_aus);
/** n Eingangs-Frames (planar; ein == NULL → Stille) → höchstens max Ausgangs-Frames; Rückgabe: erzeugte Frames */
int aw_src_rechnen(AwSrc *s, const float *const *ein, int n, float *const *aus, int max);
/** Nachlauf des Filters ausgeben (am Ende einer Folge mit dieser Rate) */
int aw_src_nachlauf(AwSrc *s, float *const *aus, int max);
int aw_src_aus_max(const AwSrc *s, int n);
int aw_src_ein_fuer(const AwSrc *s, int m);
double aw_src_verzoegerung(const AwSrc *s);
int aw_src_taps(const AwSrc *s);
void aw_src_frei(AwSrc *s);

/** Zufallszahl 0 … 1 (mulberry32 – dieselbe Folge wie im Test-Ersatz für Math.random) */
double aw_zufall(uint32_t *zustand);

#ifdef __cplusplus
}
#endif
