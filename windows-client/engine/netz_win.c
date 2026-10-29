// HTTP(S) über WinHTTP: Proxy und Zertifikate kommen vom System, Abbrechen über Schließen des Anfrage-Handles.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winhttp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "netz.h"

#ifndef WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY
#define WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY 4
#endif

struct Netz { HINTERNET s, c; HINTERNET volatile r; };

static wchar_t *breit(const char *s) {
  int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
  wchar_t *w = malloc(sizeof(wchar_t) * (size_t)(n > 0 ? n : 1));
  if (n > 0) MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n); else w[0] = 0;
  return w;
}

static void fehler_text(DWORD e, char *f, size_t fn) {
  const char *t = "Netzwerkfehler";
  switch (e) {
    case ERROR_WINHTTP_NAME_NOT_RESOLVED: t = "Serveradresse nicht gefunden"; break;
    case ERROR_WINHTTP_CANNOT_CONNECT: t = "Server nicht erreichbar"; break;
    case ERROR_WINHTTP_TIMEOUT: t = "Zeitüberschreitung"; break;
    case ERROR_WINHTTP_SECURE_FAILURE: t = "Zertifikat des Servers ungültig"; break;
    case ERROR_WINHTTP_CONNECTION_ERROR: t = "Verbindung unterbrochen"; break;
    case ERROR_WINHTTP_OPERATION_CANCELLED: t = "abgebrochen"; break;
  }
  snprintf(f, fn, "%s (%lu)", t, (unsigned long)e);
}

Netz *netz_oeffnen(const char *url, const char *kopf, int *status, int64_t *gesamt, char *fehler, size_t fn) {
  *status = 0; *gesamt = -1;
  wchar_t *wurl = breit(url);
  URL_COMPONENTS uc; memset(&uc, 0, sizeof uc);
  uc.dwStructSize = sizeof uc;
  uc.dwHostNameLength = (DWORD)-1; uc.dwUrlPathLength = (DWORD)-1; uc.dwExtraInfoLength = (DWORD)-1; uc.dwSchemeLength = (DWORD)-1;
  if (!WinHttpCrackUrl(wurl, 0, 0, &uc)) { free(wurl); snprintf(fehler, fn, "ungültige Adresse"); return NULL; }
  wchar_t host[512];
  size_t hl = uc.dwHostNameLength < 511 ? uc.dwHostNameLength : 511;
  memcpy(host, uc.lpszHostName, hl * sizeof(wchar_t)); host[hl] = 0;
  size_t pl = uc.dwUrlPathLength + uc.dwExtraInfoLength;
  wchar_t *pfad = malloc(sizeof(wchar_t) * (pl + 2));
  memcpy(pfad, uc.lpszUrlPath, uc.dwUrlPathLength * sizeof(wchar_t));
  if (uc.dwExtraInfoLength) memcpy(pfad + uc.dwUrlPathLength, uc.lpszExtraInfo, uc.dwExtraInfoLength * sizeof(wchar_t));
  pfad[pl] = 0;
  if (pl == 0) { pfad[0] = L'/'; pfad[1] = 0; }
  int sicher = uc.nScheme == INTERNET_SCHEME_HTTPS;
  INTERNET_PORT port = uc.nPort;
  free(wurl);

  Netz *n = calloc(1, sizeof *n);
  n->s = WinHttpOpen(L"Amberwave-Engine/0.1", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!n->s) n->s = WinHttpOpen(L"Amberwave-Engine/0.1", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!n->s) { fehler_text(GetLastError(), fehler, fn); free(pfad); free(n); return NULL; }
  WinHttpSetTimeouts(n->s, 8000, 8000, 20000, 30000);
  n->c = WinHttpConnect(n->s, host, port, 0);
  HINTERNET r = n->c ? WinHttpOpenRequest(n->c, L"GET", pfad, NULL, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, sicher ? WINHTTP_FLAG_SECURE : 0) : NULL;
  free(pfad);
  if (!r) { fehler_text(GetLastError(), fehler, fn); netz_schliessen(n); return NULL; }
  n->r = r;
  if (kopf && *kopf) {
    wchar_t *wk = breit(kopf);
    WinHttpAddRequestHeaders(r, wk, (DWORD)-1, WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE);
    free(wk);
  }
  if (!WinHttpSendRequest(r, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) || !WinHttpReceiveResponse(r, NULL)) {
    fehler_text(GetLastError(), fehler, fn);
    netz_schliessen(n);
    return NULL;
  }
  DWORD st = 0, len = sizeof st;
  WinHttpQueryHeaders(r, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &st, &len, WINHTTP_NO_HEADER_INDEX);
  *status = (int)st;
  wchar_t cl[64]; DWORD cll = sizeof cl;
  if (WinHttpQueryHeaders(r, WINHTTP_QUERY_CONTENT_LENGTH, WINHTTP_HEADER_NAME_BY_INDEX, cl, &cll, WINHTTP_NO_HEADER_INDEX)) *gesamt = _wtoi64(cl);
  return n;
}

long netz_lesen(Netz *n, void *puffer, size_t groesse) {
  HINTERNET r = n->r;
  if (!r) return -1;
  DWORD k = 0;
  if (!WinHttpReadData(r, puffer, (DWORD)(groesse > 0x7fffffff ? 0x7fffffff : groesse), &k)) return -1;
  return (long)k;
}

void netz_abbrechen(Netz *n) {
  HINTERNET r = InterlockedExchangePointer((PVOID volatile *)&n->r, NULL);
  if (r) WinHttpCloseHandle(r);
}

void netz_schliessen(Netz *n) {
  if (!n) return;
  netz_abbrechen(n);
  if (n->c) WinHttpCloseHandle(n->c);
  if (n->s) WinHttpCloseHandle(n->s);
  free(n);
}
