#pragma once
#include <stddef.h>
void *malloc(size_t n);
void *calloc(size_t n, size_t g);
void *realloc(void *p, size_t n);
void free(void *p);
static inline int abs(int x) { return x < 0 ? -x : x; }
