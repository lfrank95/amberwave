// Einfacher HTTP-Abruf über Sockets (nur http://, nur für Tests unter Linux)
#include "netz.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
#include <netdb.h>
#include <sys/socket.h>

struct Netz { int fd; unsigned char *rest; size_t rest_n, rest_pos; int64_t offen; int chunked; };

Netz *netz_oeffnen(const char *url, const char *kopf, int *status, int64_t *gesamt, char *fehler, size_t fn) {
  *status = 0; *gesamt = -1;
  if (strncmp(url, "http://", 7) != 0) { snprintf(fehler, fn, "nur http:// im Test"); return NULL; }
  char host[256], port[16] = "80";
  const char *h = url + 7, *pfad = strchr(h, '/');
  if (!pfad) pfad = "/";
  size_t hl = (size_t)(pfad - h);
  if (hl >= sizeof host) hl = sizeof host - 1;
  memcpy(host, h, hl); host[hl] = 0;
  char *dp = strchr(host, ':');
  if (dp) { snprintf(port, sizeof port, "%s", dp + 1); *dp = 0; }
  struct addrinfo hint = {0}, *ai;
  hint.ai_socktype = SOCK_STREAM;
  if (getaddrinfo(host, port, &hint, &ai) != 0) { snprintf(fehler, fn, "Adresse unbekannt"); return NULL; }
  int fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
  if (fd < 0 || connect(fd, ai->ai_addr, ai->ai_addrlen) != 0) { freeaddrinfo(ai); if (fd >= 0) close(fd); snprintf(fehler, fn, "keine Verbindung"); return NULL; }
  freeaddrinfo(ai);
  char anf[8192];
  int n = snprintf(anf, sizeof anf, "GET %s HTTP/1.0\r\nHost: %s:%s\r\nConnection: close\r\n%s\r\n", pfad, host, port, kopf ? kopf : "");
  if (write(fd, anf, (size_t)n) != n) { close(fd); snprintf(fehler, fn, "Senden fehlgeschlagen"); return NULL; }
  // Kopf lesen
  size_t kap = 65536, len = 0;
  unsigned char *b = malloc(kap);
  char *ende = NULL;
  while (!ende) {
    ssize_t k = read(fd, b + len, kap - len - 1);
    if (k <= 0) { free(b); close(fd); snprintf(fehler, fn, "keine Antwort"); return NULL; }
    len += (size_t)k; b[len] = 0;
    ende = strstr((char *)b, "\r\n\r\n");
    if (!ende && len + 1 >= kap) { free(b); close(fd); snprintf(fehler, fn, "Kopf zu groß"); return NULL; }
  }
  sscanf((char *)b, "HTTP/%*s %d", status);
  Netz *nz = calloc(1, sizeof *nz);
  nz->fd = fd; nz->offen = -1;
  for (char *z = strstr((char *)b, "\r\n") + 2; z < ende; ) {
    char *e = strstr(z, "\r\n");
    if (!strncasecmp(z, "Content-Length:", 15)) { *gesamt = atoll(z + 15); nz->offen = *gesamt; }
    if (!strncasecmp(z, "Transfer-Encoding:", 18) && strstr(z, "chunked") && strstr(z, "chunked") < e) nz->chunked = 1;
    z = e + 2;
  }
  size_t kopf_n = (size_t)(ende + 4 - (char *)b);
  nz->rest = b; nz->rest_pos = kopf_n; nz->rest_n = len;
  if (nz->chunked) { snprintf(fehler, fn, "chunked nicht unterstützt (Test)"); free(b); close(fd); free(nz); return NULL; }
  return nz;
}

long netz_lesen(Netz *n, void *puffer, size_t groesse) {
  if (n->offen == 0) return 0;
  if (n->offen > 0 && (int64_t)groesse > n->offen) groesse = (size_t)n->offen;
  long k;
  if (n->rest && n->rest_pos < n->rest_n) {
    k = (long)(n->rest_n - n->rest_pos);
    if ((size_t)k > groesse) k = (long)groesse;
    memcpy(puffer, n->rest + n->rest_pos, (size_t)k);
    n->rest_pos += (size_t)k;
  } else {
    k = (long)read(n->fd, puffer, groesse);
    if (k < 0) return -1;
  }
  if (n->offen > 0) n->offen -= k;
  return k;
}

void netz_abbrechen(Netz *n) { shutdown(n->fd, SHUT_RDWR); }
void netz_schliessen(Netz *n) { if (!n) return; close(n->fd); free(n->rest); free(n); }
