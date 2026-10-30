// Minimales math.h für den WebAssembly-Build: Grundoperationen als WebAssembly-Befehle, der Rest kommt aus JavaScript
// (Math.*, Modul "m") – dieselben Funktionen, die die bisherigen JS-Worklets benutzt haben.
#pragma once
#define M_PI 3.14159265358979323846
#define M_LN2 0.69314718055994530942
#define M_SQRT2 1.41421356237309504880
#define INFINITY __builtin_inf()
#define NAN __builtin_nan("")
#define isfinite(x) __builtin_isfinite(x)
#define isnan(x) __builtin_isnan(x)
static inline double sqrt(double x) { return __builtin_sqrt(x); }
static inline double fabs(double x) { return __builtin_fabs(x); }
static inline double floor(double x) { return __builtin_floor(x); }
static inline double ceil(double x) { return __builtin_ceil(x); }
static inline double trunc(double x) { return __builtin_trunc(x); }
static inline double fmin(double a, double b) { return __builtin_fmin(a, b); }
static inline double fmax(double a, double b) { return __builtin_fmax(a, b); }
#define AW_M(n) __attribute__((import_module("m"), import_name(#n)))
AW_M(sin) double sin(double);
AW_M(cos) double cos(double);
AW_M(tan) double tan(double);
AW_M(exp) double exp(double);
AW_M(log) double log(double);
AW_M(log10) double log10(double);
AW_M(log1p) double log1p(double);
AW_M(expm1) double expm1(double);
AW_M(pow) double pow(double, double);
AW_M(tanh) double tanh(double);
AW_M(cosh) double cosh(double);
AW_M(sinh) double sinh(double);
AW_M(atan) double atan(double);
AW_M(atan2) double atan2(double, double);
#undef AW_M
static inline double round(double x) { double t = __builtin_trunc(x); if (__builtin_fabs(x - t) >= 0.5) t += __builtin_copysign(1.0, x); return t; }
static inline long lround(double x) { return (long)round(x); }
static inline double copysign(double a, double b) { return __builtin_copysign(a, b); }
