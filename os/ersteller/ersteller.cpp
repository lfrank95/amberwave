// Amberwave USB-Ersteller – schreibt Amberwave OS auf einen USB-Stick (Windows, eigenes Fenster im Amberwave-Look).
//
// Ablauf: Stick wählen → „Stick erstellen“ → das neueste Image wird von GitHub geladen (oder eine .img-Datei von Hand
// gewählt) → auf den Stick geschrieben → zurückgelesen und verglichen → „Fertig: in den PC stecken und davon starten“.
//
// Sicherheit: angezeigt werden nur USB-Datenträger (und SD-Karten), nie die Platte mit Windows. Vor dem Schreiben
// fragt ein Dialog mit Name und Größe des Sticks nach. Zum Schreiben braucht Windows Admin-Rechte (Manifest).
//
// Für den automatischen Test (GitHub Actions, virtuelle Platte statt Stick):
//   ersteller.exe --test <image> <laufwerksnummer> <protokoll>   schreibt, prüft und beendet sich (Exit 0 = gut)
//   ersteller.exe --liste <protokoll>                             listet die erkannten Laufwerke
//   --alle-laufwerke                                              zeigt auch virtuelle Platten (nur für Tests)
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <winioctl.h>
#include <objidl.h>
#include <gdiplus.h>
#include <shellapi.h>
#include <commdlg.h>
#include <dwmapi.h>
#include <winhttp.h>
#include <stdint.h>
#include <stdio.h>
#include <math.h>
#include <string>
#include <vector>

using namespace Gdiplus;

#ifndef AW_VERSION
#define AW_VERSION L"0"
#endif
#define RES_SCHRIFT_TEXT 10
#define RES_SCHRIFT_FETT 11
#define RES_SCHRIFT_TITEL 12
#define REPO L"/repos/lfrank95/amberwave/releases?per_page=20"

static int englisch(void) { return (GetUserDefaultUILanguage() & 0x3ff) != LANG_GERMAN; }
#define TX(de, en) (englisch() ? (en) : (de))
#define WM_STAND (WM_APP + 1)
#define WM_FERTIG (WM_APP + 2)
#define WM_QUELLE (WM_APP + 3)

enum { S_WAHL, S_LAEUFT, S_FERTIG };
enum { Z_NICHTS = 0, Z_MIN, Z_ZU, Z_LOS, Z_DATEI, Z_GITHUB, Z_BETA, Z_DLG_JA, Z_DLG_NEIN, Z_SCHLIESSEN, Z_STICK = 100 };
enum { D_KEIN, D_LOESCHEN, D_INFO, D_ABBRECHEN };

#define BREITE 720
#define HOEHE 480
#define LEISTE 44

static HINSTANCE inst;
static HWND fenster;
static float k = 1.0f;
static int seite = S_WAHL, alle_laufwerke = 0;
static PrivateFontCollection *schriften;
static FontFamily *fam_text, *fam_fett, *fam_titel;
static Graphics *g;

/* ---------- Laufwerke ---------- */

struct Laufwerk { int nr; uint64_t groesse; std::wstring name, buchstaben; int bus; };
static std::vector<Laufwerk> laufwerke;
static int gewaehlt = -1;   // Laufwerksnummer
static CRITICAL_SECTION sperre;

static std::wstring breit8(const char *s) {
  int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
  std::wstring w(n > 0 ? n - 1 : 0, L'\0');
  if (n > 1) MultiByteToWideChar(CP_UTF8, 0, s, -1, &w[0], n);
  return w;
}
static std::wstring trimmen(std::wstring s) {
  while (!s.empty() && (s.back() == L' ' || s.back() == L'\t')) s.pop_back();
  while (!s.empty() && s[0] == L' ') s.erase(0, 1);
  return s;
}

/** Laufwerksnummer eines Volumes (C:, D:, …), -1 = unbekannt */
static int volume_laufwerk(wchar_t b) {
  wchar_t p[8]; _snwprintf(p, 8, L"\\\\.\\%c:", b);
  HANDLE h = CreateFileW(p, 0, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
  if (h == INVALID_HANDLE_VALUE) return -1;
  STORAGE_DEVICE_NUMBER dn; DWORD n = 0; int r = -1;
  if (DeviceIoControl(h, IOCTL_STORAGE_GET_DEVICE_NUMBER, NULL, 0, &dn, sizeof dn, &n, NULL)) r = (int)dn.DeviceNumber;
  CloseHandle(h);
  return r;
}

static std::vector<Laufwerk> laufwerke_suchen(void) {
  std::vector<Laufwerk> l;
  wchar_t win[MAX_PATH]; GetWindowsDirectoryW(win, MAX_PATH);
  int system_nr = volume_laufwerk(win[0]);
  DWORD masken = GetLogicalDrives();
  for (int nr = 0; nr < 32; nr++) {
    if (nr == system_nr) continue;   // nie die Platte mit Windows
    wchar_t p[32]; _snwprintf(p, 32, L"\\\\.\\PhysicalDrive%d", nr);
    HANDLE h = CreateFileW(p, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
    if (h == INVALID_HANDLE_VALUE) continue;
    STORAGE_PROPERTY_QUERY q = {}; q.PropertyId = StorageDeviceProperty; q.QueryType = PropertyStandardQuery;
    BYTE puffer[1024] = {}; DWORD n = 0;
    GET_LENGTH_INFORMATION li = {};
    if (DeviceIoControl(h, IOCTL_STORAGE_QUERY_PROPERTY, &q, sizeof q, puffer, sizeof puffer, &n, NULL) &&
        DeviceIoControl(h, IOCTL_DISK_GET_LENGTH_INFO, NULL, 0, &li, sizeof li, &n, NULL) && li.Length.QuadPart > 0) {
      STORAGE_DEVICE_DESCRIPTOR *d = (STORAGE_DEVICE_DESCRIPTOR *)puffer;
      int bus = (int)d->BusType;
      int passt = bus == BusTypeUsb || bus == BusTypeSd || bus == BusTypeMmc || (alle_laufwerke && bus == 15 /* FileBackedVirtual */);
      if (passt) {
        Laufwerk w; w.nr = nr; w.groesse = (uint64_t)li.Length.QuadPart; w.bus = bus;
        std::string name;
        if (d->VendorIdOffset) name += (const char *)puffer + d->VendorIdOffset;
        if (d->ProductIdOffset) { if (!name.empty()) name += " "; name += (const char *)puffer + d->ProductIdOffset; }
        w.name = trimmen(breit8(name.c_str()));
        while (w.name.find(L"  ") != std::wstring::npos) w.name.erase(w.name.find(L"  "), 1);
        if (w.name.empty()) w.name = TX(L"USB-Stick", L"USB stick");
        for (wchar_t b = L'A'; b <= L'Z'; b++)
          if ((masken >> (b - L'A')) & 1 && volume_laufwerk(b) == nr) { if (!w.buchstaben.empty()) w.buchstaben += L" "; w.buchstaben += b; w.buchstaben += L":"; }
        l.push_back(w);
      }
    }
    CloseHandle(h);
  }
  return l;
}

static std::wstring groesse_text(uint64_t b) {
  wchar_t s[32];
  if (b >= 1000ull * 1000 * 1000 * 1000) _snwprintf(s, 32, L"%.1f TB", b / 1e12);
  else if (b >= 1000ull * 1000 * 1000) _snwprintf(s, 32, L"%.0f GB", b / 1e9);
  else _snwprintf(s, 32, L"%.0f MB", b / 1e6);
  return s;
}

/* ---------- Quelle: GitHub oder Datei ---------- */

static std::wstring quelle_version, quelle_url, quelle_datei, quelle_fehler;
static uint64_t quelle_groesse = 0;
static int quelle_laedt = 1;

static std::string http(const wchar_t *host, const wchar_t *pfad, HANDLE ziel = INVALID_HANDLE_VALUE, uint64_t erwartet = 0, int phase = 0) {
  std::string aus;
  HINTERNET s = WinHttpOpen(L"AmberwaveUSB/" AW_VERSION, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!s) return aus;
  HINTERNET c = WinHttpConnect(s, host, INTERNET_DEFAULT_HTTPS_PORT, 0);
  HINTERNET r = c ? WinHttpOpenRequest(c, L"GET", pfad, NULL, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE) : NULL;
  if (r && WinHttpSendRequest(r, L"Accept: application/vnd.github+json, application/octet-stream\r\n", (DWORD)-1L, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) && WinHttpReceiveResponse(r, NULL)) {
    DWORD status = 0, sl = sizeof status;
    WinHttpQueryHeaders(r, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, NULL, &status, &sl, NULL);
    if (status == 200) {
      std::vector<char> b(1 << 20);
      uint64_t gesamt = 0; DWORD n = 0;
      while (WinHttpQueryDataAvailable(r, &n) && n > 0) {
        if (n > b.size()) n = (DWORD)b.size();
        DWORD gelesen = 0;
        if (!WinHttpReadData(r, b.data(), n, &gelesen) || !gelesen) break;
        if (ziel != INVALID_HANDLE_VALUE) {
          DWORD w = 0; if (!WriteFile(ziel, b.data(), gelesen, &w, NULL) || w != gelesen) { aus = "!"; break; }
          gesamt += gelesen;
          if (erwartet) PostMessageW(fenster, WM_STAND, (WPARAM)phase, (LPARAM)(gesamt * 1000 / erwartet));
          aus = "ok";
        } else if (aus.size() < 8000000) aus.append(b.data(), gelesen);
      }
      if (ziel != INVALID_HANDLE_VALUE && erwartet && gesamt != erwartet) aus = "!";
    }
  }
  if (r) WinHttpCloseHandle(r);
  if (c) WinHttpCloseHandle(c);
  WinHttpCloseHandle(s);
  return aus;
}

/** Release-Liste von GitHub: je Release Version, Beta ja/nein und das Image (falls angehängt) – neueste zuerst */
struct Angebot { std::wstring version, url; uint64_t groesse; int beta; };
static Angebot stabil = {}, beta_neuer = {};   // neueste stabile; neueste Beta, falls neuer als die stabile
static int nimm_beta = 0;

static DWORD WINAPI quelle_suchen(LPVOID) {
  std::string j = http(L"api.github.com", REPO);
  std::vector<Angebot> liste;
  size_t p = 0;
  while ((p = j.find("\"tag_name\":\"", p)) != std::string::npos) {
    size_t naechstes = j.find("\"tag_name\":\"", p + 12);
    std::string block = j.substr(p, (naechstes == std::string::npos ? j.size() : naechstes) - p);
    p += 12;
    if (block.find("\"draft\":true") != std::string::npos) continue;
    size_t a = block.find("\"name\":\"amberwave-os-");
    while (a != std::string::npos) {
      size_t e = block.find('"', a + 8); std::string name = block.substr(a + 8, e - a - 8);
      if (name.size() > 4 && name.compare(name.size() - 4, 4, ".img") == 0) {
        size_t u = block.find("\"browser_download_url\":\"", e), gpos = block.find("\"size\":", e);
        if (u != std::string::npos) {
          u += 24;
          Angebot x;
          x.version = breit8(name.substr(13, name.size() - 13 - 4).c_str());
          x.url = breit8(block.substr(u, block.find('"', u) - u).c_str());
          x.groesse = gpos != std::string::npos ? _strtoui64(block.c_str() + gpos + 7, NULL, 10) : 0;
          x.beta = block.find("\"prerelease\":true") != std::string::npos;
          liste.push_back(x);
          break;
        }
      }
      a = block.find("\"name\":\"amberwave-os-", e);
    }
  }
  EnterCriticalSection(&sperre);
  stabil = {}; beta_neuer = {};
  for (auto &x : liste) if (!x.beta) { stabil = x; break; }   // neueste stabile
  for (auto &x : liste) {                                     // Beta nur, wenn sie vor der stabilen kommt (= neuer)
    if (!x.beta) break;
    beta_neuer = x; break;
  }
  // Gibt es noch keine stabile Version, ist die neueste Beta das Richtige
  if (stabil.version.empty() && !beta_neuer.version.empty()) { stabil = beta_neuer; beta_neuer = {}; }
  const Angebot &w = nimm_beta && !beta_neuer.version.empty() ? beta_neuer : stabil;
  if (!w.version.empty()) { quelle_version = w.version; quelle_url = w.url; quelle_groesse = w.groesse; quelle_fehler.clear(); }
  else quelle_fehler = j.empty() ? TX(L"GitHub ist nicht erreichbar – Internet verbunden?", L"GitHub can't be reached – are you online?")
                                 : TX(L"Noch kein Amberwave-OS-Image veröffentlicht. Eine .img-Datei kannst du von Hand wählen.", L"No Amberwave OS image published yet. You can pick an .img file by hand.");
  quelle_laedt = 0;
  LeaveCriticalSection(&sperre);
  PostMessageW(fenster, WM_QUELLE, 0, 0);
  return 0;
}

/** zwischen stabiler Version und neuerer Beta umschalten */
static void beta_umschalten(void) {
  EnterCriticalSection(&sperre);
  nimm_beta = !nimm_beta;
  const Angebot &w = nimm_beta && !beta_neuer.version.empty() ? beta_neuer : stabil;
  quelle_version = w.version; quelle_url = w.url; quelle_groesse = w.groesse;
  LeaveCriticalSection(&sperre);
}

/* ---------- Schreiben ---------- */

static int phase = 0, promille = 0;   // phase: 0 laden, 1 schreiben, 2 prüfen
static std::wstring fehler_text;
static int laeuft = 0, abbrechen = 0;

static void fehler_setzen(const wchar_t *s, DWORD code = 0) {
  wchar_t t[600];
  if (code) _snwprintf(t, 600, L"%ls (%lu)", s, code); else _snwprintf(t, 600, L"%ls", s);
  fehler_text = t;
}

/** Image (Datei) auf das Laufwerk nr schreiben und zurücklesen; 1 = gut */
static int schreiben(const wchar_t *img, int nr) {
  HANDLE q = CreateFileW(img, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, NULL);
  if (q == INVALID_HANDLE_VALUE) { fehler_setzen(TX(L"Das Image lässt sich nicht öffnen.", L"The image can't be opened."), GetLastError()); return 0; }
  LARGE_INTEGER gr; GetFileSizeEx(q, &gr);
  uint64_t groesse = (uint64_t)gr.QuadPart;
  // Volumes des Sticks sperren und aushängen, damit Windows nicht dazwischenschreibt
  std::vector<HANDLE> volumes;
  for (wchar_t b = L'A'; b <= L'Z'; b++) {
    if (volume_laufwerk(b) != nr) continue;
    wchar_t p[8]; _snwprintf(p, 8, L"\\\\.\\%c:", b);
    HANDLE v = CreateFileW(p, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
    if (v == INVALID_HANDLE_VALUE) continue;
    DWORD n = 0; int ok = 0;
    for (int i = 0; i < 20 && !ok; i++) { ok = DeviceIoControl(v, FSCTL_LOCK_VOLUME, NULL, 0, NULL, 0, &n, NULL); if (!ok) Sleep(250); }
    if (!ok) {
      CloseHandle(v); for (HANDLE x : volumes) CloseHandle(x); CloseHandle(q);
      fehler_setzen(TX(L"Der Stick wird gerade benutzt (Explorer-Fenster oder Programm offen?). Bitte schließen und noch einmal versuchen.", L"The stick is in use (an Explorer window or program open?). Please close it and try again."));
      return 0;
    }
    DeviceIoControl(v, FSCTL_DISMOUNT_VOLUME, NULL, 0, NULL, 0, &n, NULL);
    volumes.push_back(v);
  }
  wchar_t p[32]; _snwprintf(p, 32, L"\\\\.\\PhysicalDrive%d", nr);
  HANDLE d = CreateFileW(p, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, FILE_FLAG_NO_BUFFERING | FILE_FLAG_WRITE_THROUGH, NULL);
  int ok = 0;
  const DWORD BLOCK = 4 << 20;
  BYTE *b1 = (BYTE *)VirtualAlloc(NULL, BLOCK, MEM_COMMIT, PAGE_READWRITE), *b2 = (BYTE *)VirtualAlloc(NULL, BLOCK, MEM_COMMIT, PAGE_READWRITE);
  GET_LENGTH_INFORMATION li = {}; DWORD n = 0;
  if (d == INVALID_HANDLE_VALUE) { fehler_setzen(GetLastError() == ERROR_ACCESS_DENIED ? TX(L"Kein Zugriff auf den Stick – bitte den USB-Ersteller als Administrator starten.", L"No access to the stick – please run the USB creator as administrator.") : TX(L"Der Stick lässt sich nicht öffnen.", L"The stick can't be opened."), GetLastError()); goto ende; }
  DeviceIoControl(d, IOCTL_DISK_GET_LENGTH_INFO, NULL, 0, &li, sizeof li, &n, NULL);
  if ((uint64_t)li.Length.QuadPart < groesse) { fehler_setzen(TX(L"Der Stick ist zu klein für das Image.", L"The stick is too small for the image.")); goto ende; }
  {
    // alte Partitionstabellen löschen (vorne und die GPT-Kopie am Ende), dann schreiben
    memset(b1, 0, BLOCK);
    LARGE_INTEGER pos; DWORD w = 0;
    pos.QuadPart = li.Length.QuadPart - (1 << 20); SetFilePointerEx(d, pos, NULL, FILE_BEGIN); WriteFile(d, b1, 1 << 20, &w, NULL);
    pos.QuadPart = 0; SetFilePointerEx(d, pos, NULL, FILE_BEGIN);
    uint64_t fertig = 0;
    phase = 1;
    while (fertig < groesse) {
      if (abbrechen) { fehler_setzen(TX(L"Abgebrochen.", L"Cancelled.")); goto ende; }
      DWORD soll = (DWORD)((groesse - fertig) < BLOCK ? (groesse - fertig) : BLOCK), gelesen = 0;
      if (!ReadFile(q, b1, soll, &gelesen, NULL) || gelesen != soll) { fehler_setzen(TX(L"Das Image lässt sich nicht lesen.", L"The image can't be read."), GetLastError()); goto ende; }
      DWORD schreib = (soll + 4095) & ~4095u;   // auf ganze Sektoren auffüllen
      if (schreib > soll) memset(b1 + soll, 0, schreib - soll);
      if (!WriteFile(d, b1, schreib, &w, NULL) || w != schreib) { fehler_setzen(TX(L"Schreiben auf den Stick fehlgeschlagen. Ein anderer Stick oder USB-Anschluss hilft oft.", L"Writing to the stick failed. Another stick or USB port often helps."), GetLastError()); goto ende; }
      fertig += soll;
      PostMessageW(fenster, WM_STAND, 1, (LPARAM)(fertig * 1000 / groesse));
    }
    FlushFileBuffers(d);
    // prüfen: zurücklesen und vergleichen
    phase = 2;
    pos.QuadPart = 0; SetFilePointerEx(d, pos, NULL, FILE_BEGIN); SetFilePointerEx(q, pos, NULL, FILE_BEGIN);
    fertig = 0;
    while (fertig < groesse) {
      if (abbrechen) { fehler_setzen(TX(L"Abgebrochen.", L"Cancelled.")); goto ende; }
      DWORD soll = (DWORD)((groesse - fertig) < BLOCK ? (groesse - fertig) : BLOCK), gelesen = 0, lesen = (soll + 4095) & ~4095u;
      if (!ReadFile(q, b1, soll, &gelesen, NULL) || gelesen != soll || !ReadFile(d, b2, lesen, &w, NULL) || w != lesen || memcmp(b1, b2, soll) != 0) {
        fehler_setzen(TX(L"Die Prüfung hat Fehler gefunden – der Stick ist vermutlich defekt. Bitte einen anderen nehmen.", L"Verification found errors – the stick is probably faulty. Please use another one."));
        goto ende;
      }
      fertig += soll;
      PostMessageW(fenster, WM_STAND, 2, (LPARAM)(fertig * 1000 / groesse));
    }
    ok = 1;
  }
ende:
  if (d != INVALID_HANDLE_VALUE) { DeviceIoControl(d, IOCTL_DISK_UPDATE_PROPERTIES, NULL, 0, NULL, 0, &n, NULL); CloseHandle(d); }
  for (HANDLE v : volumes) { DeviceIoControl(v, FSCTL_UNLOCK_VOLUME, NULL, 0, NULL, 0, &n, NULL); CloseHandle(v); }
  CloseHandle(q);
  if (b1) VirtualFree(b1, 0, MEM_RELEASE);
  if (b2) VirtualFree(b2, 0, MEM_RELEASE);
  return ok;
}

static std::wstring zieldatei;
static DWORD WINAPI erstellen(LPVOID arg) {
  int nr = (int)(intptr_t)arg, ok = 0;
  std::wstring img;
  EnterCriticalSection(&sperre);
  std::wstring datei = quelle_datei, url = quelle_url, v = quelle_version; uint64_t gr = quelle_groesse;
  LeaveCriticalSection(&sperre);
  if (!datei.empty()) img = datei;
  else {
    // laden nach %TEMP% (bleibt liegen, falls man gleich noch einen Stick macht)
    wchar_t tmp[MAX_PATH]; GetTempPathW(MAX_PATH, tmp);
    img = std::wstring(tmp) + L"amberwave-os-" + v + L".img";
    WIN32_FILE_ATTRIBUTE_DATA fa;
    int schon = GetFileAttributesExW(img.c_str(), GetFileExInfoStandard, &fa) && (((uint64_t)fa.nFileSizeHigh << 32) | fa.nFileSizeLow) == gr && gr;
    if (!schon) {
      phase = 0;
      std::wstring teil = img + L".teil";
      HANDLE h = CreateFileW(teil.c_str(), GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, 0, NULL);
      URL_COMPONENTS uc = {sizeof uc}; wchar_t host[256], pfad[2048];
      uc.lpszHostName = host; uc.dwHostNameLength = 256; uc.lpszUrlPath = pfad; uc.dwUrlPathLength = 2048;
      int geladen = h != INVALID_HANDLE_VALUE && WinHttpCrackUrl(url.c_str(), 0, 0, &uc) && http(host, pfad, h, gr, 0) == "ok";
      if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
      if (!geladen) { DeleteFileW(teil.c_str()); fehler_setzen(TX(L"Das Image ließ sich nicht von GitHub laden. Internet verbunden? Noch einmal versuchen.", L"The image couldn't be downloaded from GitHub. Online? Try again.")); goto ende; }
      DeleteFileW(img.c_str()); MoveFileW(teil.c_str(), img.c_str());
    }
  }
  ok = schreiben(img.c_str(), nr);
ende:
  PostMessageW(fenster, WM_FERTIG, ok, 0);
  return 0;
}

/* ---------- Zeichnen ---------- */

static Color farbe(int a, int r, int gg, int b) { return Color((BYTE)a, (BYTE)r, (BYTE)gg, (BYTE)b); }
#define TEXTFARBE farbe(255, 246, 239, 231)
#define LEISE farbe(255, 188, 174, 159)
#define WARM farbe(255, 214, 201, 187)
#define AMBER1 farbe(255, 255, 181, 71)
#define GRUEN farbe(255, 95, 220, 164)
#define ROT farbe(255, 255, 122, 92)
#define DUNKEL farbe(255, 29, 18, 8)

struct Ziel { RectF r; int id; int aktiv; };
static std::vector<Ziel> ziele;
static int ueber = Z_NICHTS, gedrueckt = Z_NICHTS, dlg = D_KEIN;
static std::wstring dlg_titel, dlg_text;
static StringFormat *fmt_eine, *fmt_umbruch;

static void rund(GraphicsPath &p, RectF r, float rad) {
  float d = rad * 2; if (d > r.Width) d = r.Width; if (d > r.Height) d = r.Height;
  if (d <= 0.5f) { p.AddRectangle(r); return; }
  p.AddArc(r.X, r.Y, d, d, 180, 90); p.AddArc(r.X + r.Width - d, r.Y, d, d, 270, 90);
  p.AddArc(r.X + r.Width - d, r.Y + r.Height - d, d, d, 0, 90); p.AddArc(r.X, r.Y + r.Height - d, d, d, 90, 90); p.CloseFigure();
}
static void flaeche(RectF r, float rad, const Brush &b) { GraphicsPath p; rund(p, r, rad); g->FillPath(&b, &p); }
static void flaeche(RectF r, float rad, Color c) { SolidBrush b(c); flaeche(r, rad, b); }
static void rahmen(RectF r, float rad, Color c, float w = 1.0f) { GraphicsPath p; rund(p, RectF(r.X + w / 2, r.Y + w / 2, r.Width - w, r.Height - w), rad); Pen pen(c, w); g->DrawPath(&pen, &p); }
static void amber(RectF r, float rad, int alpha = 255, int vertikal = 0) {
  LinearGradientBrush lb(PointF(r.X, r.Y), vertikal ? PointF(r.X, r.Y + r.Height) : PointF(r.X + r.Width, r.Y + r.Height), farbe(alpha, 255, 181, 71), farbe(alpha, 255, 122, 61));
  flaeche(r, rad, lb);
}
static float breite(const wchar_t *s, const Font &f) { RectF o; g->MeasureString(s, -1, &f, PointF(0, 0), fmt_eine, &o); return o.Width; }
static float text(const wchar_t *s, const Font &f, Color c, float x, float y, float b = 0, int ausr = 0) {
  SolidBrush br(c); float w = breite(s, f); if (b > 0 && w > b) w = b;
  float x0 = ausr == 1 ? x - w / 2 : ausr == 2 ? x - w : x;
  if (b > 0) g->DrawString(s, -1, &f, RectF(x0, y, b, f.GetHeight(g) + 4), fmt_eine, &br); else g->DrawString(s, -1, &f, PointF(x0, y), fmt_eine, &br);
  return w;
}
static float absatz(const wchar_t *s, const Font &f, Color c, float x, float y, float b) {
  RectF o; g->MeasureString(s, -1, &f, RectF(0, 0, b, 2000), fmt_umbruch, &o);
  SolidBrush br(c); g->DrawString(s, -1, &f, RectF(x, y, b, o.Height + 4), fmt_umbruch, &br);
  return o.Height;
}
static void etikett(const wchar_t *s, Color c, float x, float y) {
  Font f(fam_fett, 11.5f, FontStyleRegular, UnitPixel); SolidBrush br(c); wchar_t z[2] = {0, 0};
  for (const wchar_t *p = s; *p; p++) { z[0] = *p; g->DrawString(z, 1, &f, PointF(x, y), fmt_eine, &br); x += breite(z, f) + 1.6f; }
}
static void ziel_neu(int id, RectF r, int aktiv = 1) { ziele.push_back({r, id, aktiv}); }
static int ist_ueber(int id) { return ueber == id && !dlg; }

static void logo(float x, float y, float s) {
  flaeche(RectF(x, y, s, s), s * 0.235f, farbe(255, 28, 20, 14));
  static const float hoe[5] = {12, 28, 44, 24, 36}, oben[5] = {26, 18, 10, 20, 14};
  float f = s / 64.0f;
  for (int i = 0; i < 5; i++) amber(RectF(x + (10 + i * 10) * f, y + oben[i] * f, 6 * f, hoe[i] * f), 3 * f, 255, 1);
}

static float knopf(int id, const wchar_t *s, float x_rechts, float y, int haupt, int aktiv = 1) {
  Font f(fam_fett, 14, FontStyleRegular, UnitPixel);
  float tw = breite(s, f);
  RectF r(x_rechts - tw - 44, y, tw + 44, 40);
  int hv = ist_ueber(id) && aktiv;
  if (haupt) { amber(r, 20, aktiv ? 255 : 97); if (hv) flaeche(r, 20, farbe(26, 255, 255, 255)); }
  else { flaeche(r, 20, farbe(hv ? 31 : 18, 255, 244, 230)); rahmen(r, 20, farbe(41, 255, 236, 214)); }
  text(s, f, haupt ? (aktiv ? DUNKEL : farbe(160, 29, 18, 8)) : (aktiv ? TEXTFARBE : farbe(97, 246, 239, 231)), r.X + 22, r.Y + 11.5f);
  ziel_neu(id, r, aktiv);
  return r.X;
}

static void hintergrund(void) {
  SolidBrush grund(farbe(255, 17, 12, 9)); g->FillRectangle(&grund, RectF(0, 0, BREITE, HOEHE));
  GraphicsPath p; float cx = BREITE * 0.2f, cy = -HOEHE * 0.1f;
  p.AddEllipse(cx - BREITE * 1.2f, cy - HOEHE * 0.95f, BREITE * 2.4f, HOEHE * 1.9f);
  PathGradientBrush pg(&p); pg.SetCenterPoint(PointF(cx, cy));
  REAL pos[3] = {0.0f, 0.5f, 1.0f}; Color fa[3] = {farbe(0, 22, 15, 11), farbe(150, 32, 21, 14), farbe(255, 58, 36, 18)};
  pg.SetInterpolationColors(fa, pos, 3); g->FillPath(&pg, &p);
}

static void titelleiste(void) {
  logo(16, 12, 20);
  Font f(fam_titel, 13, FontStyleRegular, UnitPixel);
  text(TX(L"Amberwave USB-Ersteller", L"Amberwave USB Creator"), f, TEXTFARBE, 46, 14);
  RectF rm(BREITE - 8 - 34 - 34 - 2, 7, 34, 30), rz(BREITE - 8 - 34, 7, 34, 30);
  if (ist_ueber(Z_MIN)) flaeche(rm, 8, farbe(20, 255, 244, 230));
  if (ist_ueber(Z_ZU)) flaeche(rz, 8, farbe(200, 196, 43, 28));
  Pen pm(ist_ueber(Z_MIN) ? TEXTFARBE : LEISE, 1.4f); g->DrawLine(&pm, rm.X + 11, rm.Y + 15, rm.X + 23, rm.Y + 15);
  Pen pz(ist_ueber(Z_ZU) ? farbe(255, 255, 255, 255) : LEISE, 1.4f);
  g->DrawLine(&pz, rz.X + 12, rz.Y + 10, rz.X + 22, rz.Y + 20); g->DrawLine(&pz, rz.X + 22, rz.Y + 10, rz.X + 12, rz.Y + 20);
  ziel_neu(Z_MIN, rm); ziel_neu(Z_ZU, rz);
}

static void stick_symbol(float x, float y, Color c) {
  Pen p(c, 1.6f); p.SetLineJoin(LineJoinRound);
  GraphicsPath a; rund(a, RectF(x + 4, y + 9, 16, 22), 3); g->DrawPath(&p, &a);
  g->DrawRectangle(&p, RectF(x + 8, y + 2, 8, 7));
}

static void seite_wahl(void) {
  Font h(fam_titel, 26, FontStyleRegular, UnitPixel), t(fam_text, 13.5f, FontStyleRegular, UnitPixel), tf(fam_fett, 14, FontStyleRegular, UnitPixel), tk(fam_text, 12, FontStyleRegular, UnitPixel);
  text(TX(L"Amberwave-Stick erstellen", L"Create an Amberwave stick"), h, TEXTFARBE, 40, 70);
  absatz(TX(L"Davon startest du den PC, auf dem Amberwave laufen soll – eingerichtet wird dann im Browser.", L"You boot the PC that should run Amberwave from it – setup then happens in the browser."), t, LEISE, 40, 108, BREITE - 80);
  etikett(TX(L"USB-STICK", L"USB STICK"), AMBER1, 40, 152);
  EnterCriticalSection(&sperre);
  std::vector<Laufwerk> l = laufwerke;
  LeaveCriticalSection(&sperre);
  float y = 174;
  if (l.empty()) {
    RectF r(40, y, BREITE - 80, 64); flaeche(r, 14, farbe(14, 255, 244, 230)); rahmen(r, 14, farbe(31, 255, 236, 214));
    stick_symbol(56, y + 16, LEISE);
    text(TX(L"Steck einen USB-Stick ein (mindestens 2 GB)", L"Plug in a USB stick (at least 2 GB)"), tf, TEXTFARBE, 92, y + 14);
    text(TX(L"Er erscheint hier von selbst. Alles darauf wird gelöscht.", L"It shows up here by itself. Everything on it will be erased."), tk, LEISE, 92, y + 36);
    y += 74;
  }
  for (size_t i = 0; i < l.size() && i < 3; i++) {
    RectF r(40, y, BREITE - 80, 58);
    int an = l[i].nr == gewaehlt, hv = ist_ueber(Z_STICK + l[i].nr);
    if (an) { LinearGradientBrush lb(PointF(r.X, r.Y), PointF(r.X + r.Width, r.Y + r.Height), farbe(30, 255, 195, 90), farbe(15, 255, 106, 61)); flaeche(r, 14, lb); rahmen(r, 14, farbe(150, 255, 169, 77), 1.4f); }
    else { flaeche(r, 14, farbe(hv ? 22 : 12, 255, 244, 230)); rahmen(r, 14, farbe(31, 255, 236, 214)); }
    stick_symbol(56, y + 14, an ? AMBER1 : LEISE);
    text(l[i].name.c_str(), tf, TEXTFARBE, 92, y + 11, BREITE - 260);
    std::wstring u = groesse_text(l[i].groesse) + (l[i].buchstaben.empty() ? L"" : L"  ·  " + l[i].buchstaben);
    text(u.c_str(), tk, LEISE, 92, y + 33);
    if (an) {   // Haken
      Pen p(AMBER1, 2.2f); p.SetStartCap(LineCapRound); p.SetEndCap(LineCapRound);
      PointF pt[3] = {PointF(r.X + r.Width - 40, y + 29), PointF(r.X + r.Width - 34, y + 35), PointF(r.X + r.Width - 24, y + 23)}; g->DrawLines(&p, pt, 3);
    }
    ziel_neu(Z_STICK + l[i].nr, r);
    y += 66;
  }
  // Quelle
  etikett(TX(L"AMBERWAVE OS", L"AMBERWAVE OS"), AMBER1, 40, 380);
  EnterCriticalSection(&sperre);
  std::wstring qv = quelle_version, qd = quelle_datei, qf = quelle_fehler; int ql = quelle_laedt; uint64_t qg = quelle_groesse;
  LeaveCriticalSection(&sperre);
  std::wstring q;
  Color qc = WARM;
  if (!qd.empty()) { const wchar_t *n = wcsrchr(qd.c_str(), L'\\'); q = std::wstring(TX(L"Datei: ", L"File: ")) + (n ? n + 1 : qd.c_str()); }
  else if (ql) q = TX(L"Suche die neueste Version auf GitHub …", L"Looking for the latest version on GitHub …");
  else if (!qv.empty()) q = std::wstring(TX(L"Version ", L"Version ")) + qv + (nimm_beta || qv.find(L'-') != std::wstring::npos ? TX(L" (Beta)", L" (beta)") : TX(L" (stabil)", L" (stable)")) + L" · " + groesse_text(qg) + TX(L" · wird von GitHub geladen", L" · downloaded from GitHub");
  else { q = qf; qc = ROT; }
  text(q.c_str(), tk, qc, 40, 400, BREITE - 300);
  Font tl(fam_fett, 12, FontStyleRegular, UnitPixel);
  const wchar_t *dl = qd.empty() ? TX(L"Image-Datei wählen …", L"Choose image file …") : TX(L"Neueste von GitHub", L"Latest from GitHub");
  float dw = breite(dl, tl);
  RectF dr(40, 420, dw, 18);
  text(dl, tl, ist_ueber(qd.empty() ? Z_DATEI : Z_GITHUB) ? TEXTFARBE : AMBER1, 40, 420);
  ziel_neu(qd.empty() ? Z_DATEI : Z_GITHUB, dr);
  // neuere Beta vorhanden: umschaltbar (standardmäßig die stabile Version)
  EnterCriticalSection(&sperre);
  std::wstring bv = beta_neuer.version;
  LeaveCriticalSection(&sperre);
  if (qd.empty() && !bv.empty()) {
    std::wstring bt = nimm_beta ? std::wstring(TX(L"Stabile Version nehmen", L"Use the stable version")) : std::wstring(TX(L"Neuere Beta ", L"Newer beta ")) + bv + TX(L" nehmen", L" instead");
    float bx = 40 + dw + 18;
    text(L"·", tl, LEISE, bx - 10, 420);
    text(bt.c_str(), tl, ist_ueber(Z_BETA) ? TEXTFARBE : AMBER1, bx, 420);
    ziel_neu(Z_BETA, RectF(bx, 420, breite(bt.c_str(), tl), 18));
  }
  int bereit = gewaehlt >= 0 && (!qd.empty() || !qv.empty());
  knopf(Z_LOS, TX(L"Stick erstellen", L"Create stick"), BREITE - 40, 410, 1, bereit);
}

static void seite_laeuft(void) {
  Font h(fam_titel, 26, FontStyleRegular, UnitPixel), t(fam_text, 13.5f, FontStyleRegular, UnitPixel), tf(fam_fett, 14, FontStyleRegular, UnitPixel);
  text(TX(L"Stick wird erstellt", L"Creating the stick"), h, TEXTFARBE, 40, 70);
  absatz(TX(L"Bitte den Stick nicht abziehen. Das dauert je nach Stick ein paar Minuten.", L"Please don't unplug the stick. Depending on the stick this takes a few minutes."), t, LEISE, 40, 108, BREITE - 80);
  const wchar_t *namen[3] = {TX(L"Von GitHub laden", L"Download from GitHub"), TX(L"Auf den Stick schreiben", L"Write to the stick"), TX(L"Prüfen", L"Verify")};
  int mit_laden = quelle_datei.empty();
  float y = 170;
  for (int i = mit_laden ? 0 : 1; i < 3; i++) {
    int fertig = i < phase, jetzt = i == phase;
    Color c = fertig ? GRUEN : jetzt ? TEXTFARBE : LEISE;
    flaeche(RectF(40, y + 4, 12, 12), 6, fertig ? GRUEN : jetzt ? AMBER1 : farbe(51, 255, 236, 214));
    text(namen[i], tf, c, 64, y);
    if (jetzt) {
      wchar_t pz[16]; _snwprintf(pz, 16, L"%d %%", promille / 10);
      text(pz, tf, AMBER1, BREITE - 40, y, 0, 2);
      RectF spur(64, y + 28, BREITE - 104, 8); flaeche(spur, 4, farbe(26, 255, 244, 230));
      amber(RectF(64, y + 28, (BREITE - 104) * (promille > 10 ? promille : 10) / 1000.0f, 8), 4);
      y += 22;
    }
    y += 40;
  }
  knopf(Z_ZU, TX(L"Abbrechen", L"Cancel"), BREITE - 40, 410, 0);
}

static void seite_fertig(void) {
  Font h(fam_titel, 26, FontStyleRegular, UnitPixel), t(fam_text, 14, FontStyleRegular, UnitPixel), tf(fam_fett, 14, FontStyleRegular, UnitPixel);
  flaeche(RectF(40, 66, 40, 40), 20, farbe(36, 95, 220, 164));
  Pen p(GRUEN, 2.6f); p.SetStartCap(LineCapRound); p.SetEndCap(LineCapRound);
  PointF pt[3] = {PointF(51, 86), PointF(57, 92), PointF(70, 79)}; g->DrawLines(&p, pt, 3);
  text(TX(L"Der Stick ist fertig", L"The stick is ready"), h, TEXTFARBE, 96, 72);
  const wchar_t *schritte[4] = {
    TX(L"Stick in den PC stecken, auf dem Amberwave laufen soll – mit Netzwerkkabel am Router.", L"Plug the stick into the PC that should run Amberwave – with a network cable to your router."),
    TX(L"Beim Einschalten das Startmenü öffnen (meist F11, F12, F8 oder Esc) und den Stick wählen.", L"When switching on, open the boot menu (usually F11, F12, F8 or Esc) and pick the stick."),
    TX(L"Am Bildschirm erscheint eine Adresse – auf Handy oder PC öffnen, Platte wählen, installieren.", L"An address appears on screen – open it on your phone or PC, pick the drive, install."),
    TX(L"Danach den Stick abziehen. Amberwave ist dann unter http://amberwave.local erreichbar.", L"Then unplug the stick. Amberwave is then at http://amberwave.local."),
  };
  float y = 136;
  for (int i = 0; i < 4; i++) {
    wchar_t n[4]; _snwprintf(n, 4, L"%d", i + 1);
    flaeche(RectF(40, y, 26, 26), 13, farbe(30, 255, 181, 71)); text(n, tf, AMBER1, 53, y + 4, 0, 1);
    y += absatz(schritte[i], t, WARM, 80, y + 3, BREITE - 120) + 20;
  }
  knopf(Z_SCHLIESSEN, TX(L"Schließen", L"Close"), BREITE - 40, 410, 1);
}

static void dialog_malen(void) {
  if (!dlg) return;
  SolidBrush dk(farbe(160, 6, 4, 3)); g->FillRectangle(&dk, RectF(0, LEISTE, BREITE, HOEHE - LEISTE));
  Font h(fam_titel, 19, FontStyleRegular, UnitPixel), t(fam_text, 13.5f, FontStyleRegular, UnitPixel);
  float b = 460;
  RectF mess; g->MeasureString(dlg_text.c_str(), -1, &t, RectF(0, 0, b - 56, 2000), fmt_umbruch, &mess);
  float hh = 26 + 30 + mess.Height + 28 + 40 + 22;
  RectF r((BREITE - b) / 2, LEISTE + (HOEHE - LEISTE - hh) / 2, b, hh);
  flaeche(r, 16, farbe(255, 30, 22, 17)); rahmen(r, 16, dlg == D_LOESCHEN ? farbe(120, 255, 122, 92) : farbe(36, 255, 236, 214));
  text(dlg_titel.c_str(), h, TEXTFARBE, r.X + 28, r.Y + 26);
  absatz(dlg_text.c_str(), t, WARM, r.X + 28, r.Y + 62, b - 56);
  float ky = r.Y + r.Height - 22 - 40;
  int alt = dlg; dlg = 0;
  if (alt == D_INFO) knopf(Z_DLG_JA, L"OK", r.X + r.Width - 24, ky, 1);
  else if (alt == D_ABBRECHEN) { float l = knopf(Z_DLG_NEIN, TX(L"Weitermachen", L"Keep going"), r.X + r.Width - 24, ky, 1); knopf(Z_DLG_JA, TX(L"Abbrechen", L"Cancel"), l - 10, ky, 0); }
  else { float l = knopf(Z_DLG_JA, TX(L"Löschen und erstellen", L"Erase and create"), r.X + r.Width - 24, ky, 1); knopf(Z_DLG_NEIN, TX(L"Zurück", L"Back"), l - 10, ky, 0); }
  dlg = alt;
}

static void malen(HDC dc) {
  RECT rc; GetClientRect(fenster, &rc);
  HDC m = CreateCompatibleDC(dc); HBITMAP bm = CreateCompatibleBitmap(dc, rc.right, rc.bottom); HGDIOBJ alt = SelectObject(m, bm);
  {
    Graphics gr(m); g = &gr;
    gr.SetSmoothingMode(SmoothingModeAntiAlias); gr.SetPixelOffsetMode(PixelOffsetModeHalf);
    gr.SetTextRenderingHint(TextRenderingHintClearTypeGridFit); gr.ScaleTransform(k, k);
    ziele.clear();
    hintergrund(); titelleiste();
    if (seite == S_WAHL) seite_wahl(); else if (seite == S_LAEUFT) seite_laeuft(); else seite_fertig();
    dialog_malen();
    gr.ResetTransform(); Pen rand(farbe(31, 255, 236, 214), 1.0f); gr.DrawRectangle(&rand, 0.5f, 0.5f, rc.right - 1.0f, rc.bottom - 1.0f);
    g = NULL;
  }
  BitBlt(dc, 0, 0, rc.right, rc.bottom, m, 0, 0, SRCCOPY);
  SelectObject(m, alt); DeleteObject(bm); DeleteDC(m);
}

/* ---------- Ablauf ---------- */

static void neu_malen(void) { InvalidateRect(fenster, NULL, FALSE); }
static void dialog(int art, const std::wstring &titel, const std::wstring &txt) { dlg = art; dlg_titel = titel; dlg_text = txt; ueber = Z_NICHTS; neu_malen(); }

static void laufwerke_aktualisieren(void) {
  std::vector<Laufwerk> l = laufwerke_suchen();
  EnterCriticalSection(&sperre);
  laufwerke = l;
  int da = 0; for (auto &w : l) if (w.nr == gewaehlt) da = 1;
  if (!da) gewaehlt = l.size() == 1 ? l[0].nr : -1;   // genau einer: gleich gewählt
  LeaveCriticalSection(&sperre);
  neu_malen();
}

static void datei_waehlen(void) {
  wchar_t p[MAX_PATH] = L"";
  OPENFILENAMEW of = {sizeof of};
  of.hwndOwner = fenster; of.lpstrFile = p; of.nMaxFile = MAX_PATH;
  of.lpstrFilter = L"Amberwave OS (*.img)\0*.img\0\0";
  of.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST;
  if (GetOpenFileNameW(&of)) { EnterCriticalSection(&sperre); quelle_datei = p; LeaveCriticalSection(&sperre); neu_malen(); }
}

static const Laufwerk *auswahl(void) { for (auto &w : laufwerke) if (w.nr == gewaehlt) return &w; return NULL; }

static void klick(int id) {
  if (dlg) {
    int art = dlg; dlg = D_KEIN;
    if (id == Z_DLG_JA && art == D_LOESCHEN) {
      seite = S_LAEUFT; phase = quelle_datei.empty() ? 0 : 1; promille = 0; laeuft = 1; abbrechen = 0;
      HANDLE th = CreateThread(NULL, 0, erstellen, (LPVOID)(intptr_t)gewaehlt, 0, NULL); if (th) CloseHandle(th);
    } else if (id == Z_DLG_JA && art == D_ABBRECHEN) abbrechen = 1;
    neu_malen(); return;
  }
  if (id >= Z_STICK) { gewaehlt = id - Z_STICK; neu_malen(); return; }
  switch (id) {
    case Z_MIN: ShowWindow(fenster, SW_MINIMIZE); break;
    case Z_ZU: if (laeuft) dialog(D_ABBRECHEN, TX(L"Abbrechen?", L"Cancel?"), TX(L"Der Stick ist dann nicht benutzbar, bis du ihn noch einmal erstellst.", L"The stick won't be usable until you create it again.")); else DestroyWindow(fenster); break;
    case Z_SCHLIESSEN: DestroyWindow(fenster); break;
    case Z_DATEI: datei_waehlen(); break;
    case Z_GITHUB: EnterCriticalSection(&sperre); quelle_datei.clear(); LeaveCriticalSection(&sperre); neu_malen(); break;
    case Z_BETA: beta_umschalten(); break;
    case Z_LOS: {
      const Laufwerk *w = auswahl(); if (!w) break;
      wchar_t t[600];
      _snwprintf(t, 600, TX(L"Alles auf „%ls“ (%ls%ls%ls) wird gelöscht. Ist darauf noch etwas Wichtiges, jetzt zurück.", L"Everything on “%ls” (%ls%ls%ls) will be erased. If anything important is on it, go back now."),
                 w->name.c_str(), groesse_text(w->groesse).c_str(), w->buchstaben.empty() ? L"" : L", ", w->buchstaben.c_str());
      std::wstring txt = t;
      if (w->groesse > 260ull * 1000 * 1000 * 1000) txt += TX(L"\n\nAchtung: Das ist ungewöhnlich groß für einen Stick – ist es vielleicht eine externe Festplatte?", L"\n\nCareful: that's unusually large for a stick – is it maybe an external hard drive?");
      dialog(D_LOESCHEN, TX(L"Stick löschen?", L"Erase the stick?"), txt);
      break;
    }
  }
  neu_malen();
}

static int treffer(LPARAM l) {
  float x = (short)LOWORD(l) / k, y = (short)HIWORD(l) / k;
  for (int i = (int)ziele.size() - 1; i >= 0; i--) {
    const Ziel &z = ziele[i];
    if (x >= z.r.X && x < z.r.X + z.r.Width && y >= z.r.Y && y < z.r.Y + z.r.Height) {
      if (dlg && z.id != Z_DLG_JA && z.id != Z_DLG_NEIN) return Z_NICHTS;
      return z.aktiv ? z.id : Z_NICHTS;
    }
  }
  return Z_NICHTS;
}

static LRESULT CALLBACK fensterproc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
    case WM_PAINT: { PAINTSTRUCT ps; HDC dc = BeginPaint(h, &ps); malen(dc); EndPaint(h, &ps); return 0; }
    case WM_ERASEBKGND: return 1;
    case WM_NCHITTEST: { POINT p = {(short)LOWORD(l), (short)HIWORD(l)}; ScreenToClient(h, &p); if (p.y / k < LEISTE && p.x / k < BREITE - 80) return HTCAPTION; return HTCLIENT; }
    case WM_SETCURSOR: if (LOWORD(l) == HTCLIENT && ueber) { SetCursor(LoadCursor(NULL, IDC_HAND)); return TRUE; } break;
    case WM_MOUSEMOVE: { int z = treffer(l); if (z != ueber) { ueber = z; neu_malen(); } TRACKMOUSEEVENT tm = {sizeof tm, TME_LEAVE, h, 0}; TrackMouseEvent(&tm); return 0; }
    case WM_MOUSELEAVE: if (ueber) { ueber = 0; neu_malen(); } return 0;
    case WM_LBUTTONDOWN: gedrueckt = treffer(l); return 0;
    case WM_LBUTTONUP: { int war = gedrueckt; gedrueckt = 0; if (war && treffer(l) == war) klick(war); return 0; }
    case WM_KEYDOWN: if (w == VK_ESCAPE) { if (dlg) klick(dlg == D_INFO ? Z_DLG_JA : Z_DLG_NEIN); } else if (w == VK_RETURN && dlg) klick(Z_DLG_JA); return 0;
    case WM_TIMER: if (seite == S_WAHL && !dlg) laufwerke_aktualisieren(); return 0;
    case WM_DEVICECHANGE: if (seite == S_WAHL) SetTimer(h, 1, 700, NULL); return TRUE;
    case WM_QUELLE: neu_malen(); return 0;
    case WM_STAND: phase = (int)w; promille = (int)l; neu_malen(); return 0;
    case WM_FERTIG:
      laeuft = 0;
      if (w) seite = S_FERTIG;
      else { seite = S_WAHL; laufwerke_aktualisieren(); dialog(D_INFO, TX(L"Das hat nicht geklappt", L"That didn't work"), fehler_text); }
      neu_malen(); return 0;
    case WM_DPICHANGED: { k = HIWORD(w) / 96.0f; RECT *r = (RECT *)l; SetWindowPos(h, NULL, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE); neu_malen(); return 0; }
    case WM_CLOSE: klick(Z_ZU); return 0;
    case WM_DESTROY: abbrechen = 1; PostQuitMessage(0); return 0;
  }
  return DefWindowProcW(h, m, w, l);
}

static const void *ressource(int id, DWORD *n) {
  HRSRC r = FindResourceW(inst, MAKEINTRESOURCEW(id), (LPCWSTR)RT_RCDATA);
  if (!r) return NULL;
  *n = SizeofResource(inst, r); return LockResource(LoadResource(inst, r));
}

static void schriften_laden(void) {
  schriften = new PrivateFontCollection();
  int ids[3] = {RES_SCHRIFT_TEXT, RES_SCHRIFT_FETT, RES_SCHRIFT_TITEL};
  for (int i = 0; i < 3; i++) { DWORD n = 0; const void *d = ressource(ids[i], &n); if (d) schriften->AddMemoryFont(d, (INT)n); }
  auto fam = [](const wchar_t *name, const wchar_t *ersatz) { FontFamily *f = new FontFamily(name, schriften); if (f->GetLastStatus() != Ok) { delete f; f = new FontFamily(ersatz); } return f; };
  fam_text = fam(L"AWText", L"Segoe UI"); fam_fett = fam(L"AWTextFett", L"Segoe UI Semibold"); fam_titel = fam(L"AWTitel", L"Segoe UI");
}

/* ---------- Testbetrieb (ohne Fenster) ---------- */

static void protokoll(const wchar_t *datei, const std::wstring &s) {
  FILE *f = _wfopen(datei, L"a, ccs=UTF-8"); if (!f) return;
  fwprintf(f, L"%ls\n", s.c_str()); fclose(f);
}

int WINAPI wWinMain(HINSTANCE hi, HINSTANCE, PWSTR, int) {
  inst = hi;
  InitializeCriticalSection(&sperre);
  int argc = 0; wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  for (int i = 1; i < argc; i++) if (!wcscmp(argv[i], L"--alle-laufwerke")) alle_laufwerke = 1;
  if (argc >= 3 && !wcscmp(argv[1], L"--liste")) {
    for (auto &w : laufwerke_suchen()) { wchar_t z[400]; _snwprintf(z, 400, L"%d\t%ls\t%llu\t%ls\tbus=%d", w.nr, w.name.c_str(), (unsigned long long)w.groesse, w.buchstaben.c_str(), w.bus); protokoll(argv[2], z); }
    return 0;
  }
  if (argc >= 5 && !wcscmp(argv[1], L"--test")) {
    int nr = _wtoi(argv[3]), da = 0;
    for (auto &w : laufwerke_suchen()) if (w.nr == nr) da = 1;
    if (!da) { protokoll(argv[4], L"FEHLER: Laufwerk ist kein erlaubtes Ziel (USB/SD) oder nicht vorhanden"); return 2; }
    DWORD t0 = GetTickCount();
    int ok = schreiben(argv[2], nr);
    wchar_t z[700]; _snwprintf(z, 700, ok ? L"OK: geschrieben und geprüft in %lu ms" : L"FEHLER: %ls", ok ? (GetTickCount() - t0) : 0, fehler_text.c_str());
    if (!ok) _snwprintf(z, 700, L"FEHLER: %ls", fehler_text.c_str());
    protokoll(argv[4], z);
    return ok ? 0 : 1;
  }

  GdiplusStartupInput gsi; ULONG_PTR gtoken; GdiplusStartup(&gtoken, &gsi, NULL);
  schriften_laden();
  fmt_eine = StringFormat::GenericTypographic()->Clone();
  fmt_eine->SetFormatFlags(StringFormatFlagsNoWrap | StringFormatFlagsMeasureTrailingSpaces | StringFormatFlagsNoClip);
  fmt_eine->SetTrimming(StringTrimmingEllipsisCharacter);
  fmt_umbruch = StringFormat::GenericTypographic()->Clone();
  fmt_umbruch->SetTrimming(StringTrimmingWord);

  HMODULE u32 = GetModuleHandleW(L"user32.dll");
  typedef UINT(WINAPI * DpiFn)(void);
  DpiFn fdpi = u32 ? (DpiFn)(void *)GetProcAddress(u32, "GetDpiForSystem") : NULL;
  k = (fdpi ? fdpi() : 96) / 96.0f;
  WNDCLASSW wc = {}; wc.style = CS_DROPSHADOW; wc.lpfnWndProc = fensterproc; wc.hInstance = inst; wc.lpszClassName = L"AmberwaveUSB";
  wc.hCursor = LoadCursor(NULL, IDC_ARROW); wc.hIcon = LoadIconW(inst, MAKEINTRESOURCEW(1));
  RegisterClassW(&wc);
  int fb = (int)(BREITE * k + 0.5f), fh = (int)(HOEHE * k + 0.5f);
  RECT a; SystemParametersInfoW(SPI_GETWORKAREA, 0, &a, 0);
  fenster = CreateWindowExW(WS_EX_APPWINDOW, wc.lpszClassName, TX(L"Amberwave USB-Ersteller", L"Amberwave USB Creator"), WS_POPUP | WS_SYSMENU | WS_MINIMIZEBOX,
                            a.left + (a.right - a.left - fb) / 2, a.top + (a.bottom - a.top - fh) / 2, fb, fh, NULL, NULL, inst, NULL);
  DWORD ecken = 2; DwmSetWindowAttribute(fenster, 33, &ecken, sizeof ecken);
  BOOL dunkel = TRUE; DwmSetWindowAttribute(fenster, 20, &dunkel, sizeof dunkel);
  laufwerke_aktualisieren();
  SetTimer(fenster, 1, 2000, NULL);   // Sticks ein- und ausstecken
  HANDLE th = CreateThread(NULL, 0, quelle_suchen, NULL, 0, NULL); if (th) CloseHandle(th);
  ShowWindow(fenster, SW_SHOW); UpdateWindow(fenster);
  MSG msg;
  while (GetMessageW(&msg, NULL, 0, 0) > 0) { TranslateMessage(&msg); DispatchMessageW(&msg); }
  GdiplusShutdown(gtoken);
  return 0;
}
