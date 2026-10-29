#include "sfx_kern.h"
#include <stdio.h>
#include <string.h>
#include "xz/xz.h"

typedef struct {
  SfxZiel *z;
  struct xz_dec *dek;
  struct xz_buf xb;
  uint8_t ein[1 << 16], aus[1 << 16];
  size_t aus_lese;
  uint64_t gelesen;
  int ende;
} Strom;

static int nachfuellen(Strom *s) {
  if (s->ende) return 0;
  s->xb.out = s->aus; s->xb.out_pos = 0; s->xb.out_size = sizeof s->aus;
  s->aus_lese = 0;
  while (s->xb.out_pos == 0) {
    if (s->xb.in_pos == s->xb.in_size) {
      uint64_t rest = s->z->laenge - s->gelesen;
      size_t wunsch = rest < sizeof s->ein ? (size_t)rest : sizeof s->ein;
      size_t n = wunsch ? s->z->lesen(s->z->u, s->ein, wunsch) : 0;
      s->gelesen += n;
      s->xb.in = s->ein; s->xb.in_pos = 0; s->xb.in_size = n;
    }
    enum xz_ret r = xz_dec_run(s->dek, &s->xb);
    if (r == XZ_STREAM_END) { s->ende = 1; break; }
    if (r != XZ_OK) return -1;
    if (s->xb.in_size == 0 && s->xb.out_pos == 0) return -1;   // abgeschnitten
  }
  return (int)s->xb.out_pos;
}

static int lesen(Strom *s, void *ziel, size_t n) {
  uint8_t *p = ziel;
  while (n) {
    if (s->aus_lese == s->xb.out_pos && nachfuellen(s) <= 0) return -1;
    size_t k = s->xb.out_pos - s->aus_lese; if (k > n) k = n;
    memcpy(p, s->aus + s->aus_lese, k);
    s->aus_lese += k; p += k; n -= k;
  }
  return 0;
}

int sfx_auspacken(SfxZiel *z, char *fehler, size_t fn) {
  static Strom s;
  static uint8_t puffer[1 << 16];
  memset(&s, 0, sizeof s);
  s.z = z;
  xz_crc32_init();
  s.dek = xz_dec_init(XZ_DYNALLOC, 1u << 26);
  if (!s.dek) { snprintf(fehler, fn, "Zu wenig Speicher."); return -1; }
  int letzter = -1, erg = -1;
  for (;;) {
    uint16_t n;
    if (lesen(&s, &n, 2)) goto kaputt;
    if (n == 0) break;
    char pfad[1024];
    if (n >= sizeof pfad || lesen(&s, pfad, n)) goto kaputt;
    pfad[n] = 0;
    if (strstr(pfad, "..") || pfad[0] == '/' || strchr(pfad, '\\') || strchr(pfad, ':')) goto kaputt;
    uint64_t groesse;
    if (lesen(&s, &groesse, 8)) goto kaputt;
    if (z->datei_neu(z->u, pfad)) { snprintf(fehler, fn, "%s lässt sich nicht schreiben.", pfad); goto ende; }
    while (groesse) {
      size_t k = groesse < sizeof puffer ? (size_t)groesse : sizeof puffer;
      if (lesen(&s, puffer, k)) { z->datei_zu(z->u); goto kaputt; }
      if (z->datei_schreiben(z->u, puffer, k)) { z->datei_zu(z->u); snprintf(fehler, fn, "Schreiben fehlgeschlagen (Platz auf dem Laufwerk?)."); goto ende; }
      groesse -= k;
      int pr = (int)(s.gelesen * 100 / (z->laenge ? z->laenge : 1));
      if (pr != letzter) { letzter = pr; if (z->stand) z->stand(z->u, pr); }
    }
    z->datei_zu(z->u);
  }
  erg = 0;
  goto ende;
kaputt:
  snprintf(fehler, fn, "Das Paket ist beschädigt. Bitte noch einmal herunterladen.");
ende:
  xz_dec_end(s.dek);
  return erg;
}
