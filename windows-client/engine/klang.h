// Klangkette der Engine (siehe klang.c)
#pragma once
#include "../../dsp/aw_dsp.h"

void klang_fx(const char *art, const AwWert *w, int n);
void klang_kette(const char *reihe, const char *an);
void klang_delta(const char *art);
void klang_messen(int an);
void klang_abgriffe(const char *liste);
int klang_aktiv(void);
int klang_abgriffe_an(void);
void klang_format(double rate, int kanaele);
/** Kette + Angleich-Gain (gleitet mit gain_k je Sample) über planare float-Kanäle, in Blöcken zu 128 */
int klang_rechnen(float *const *x, int kan, int n, double *gain_ist, double gain_ziel, double gain_k);
/* Space: Graph (Text aus raumnativ.js; leer = aus), Impulsantworten, Automation, Upmix-Nachrichten */
void klang_raum(const char *text, double rate, int kanaele);
void klang_raum_ir(const char *id, int kan, int n, double rate, const char *d0, const char *d1);
void klang_raum_param(int knoten, const char *art, double wert, double dt, double tau);
void klang_raum_nachricht(int knoten, double effekte, double breite);
/** Kanäle, die Space am Gerät braucht (0 = kein Space) */
int klang_raum_kanaele(void);
void klang_nur_abgreifen(float *const *x, int kan, int n, double gain);
/** Zustände der Effekte verwerfen (Titelwechsel von Hand, Spulen): kein Rest des Alten im Neuen */
void klang_leeren(void);
/** VST3-Plug-in-Slots (Host-Prozess, gemeinsamer Speicher und Ereignisse) anbinden/lösen */
void klang_vst_an(int slot, const char *shm, const char *ein, const char *aus);
void klang_vst_ab(int slot);
