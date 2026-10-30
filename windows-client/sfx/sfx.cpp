// Installationsassistent für den Amberwave Windows Client (zugleich selbstentpackendes Paket) – eigenes, selbst gezeichnetes
// Fenster im Amberwave-Look (GDI+), ohne Windows-Standarddialoge.
//
// Aufbau der exe: [dieses Programm][xz-Strom][Anhang: u64 Beginn des xz-Stroms, u64 Länge, u64 entpackte Größe, "AWSFX002"]
// Im xz-Strom (LZMA2 mit x86-Filter) liegen die Dateien hintereinander: u16 Länge des Pfads, Pfad (UTF-8, mit /),
// u64 Größe, Inhalt; ein Pfad der Länge 0 beendet die Liste.
//
// Seiten: Willkommen → Lizenz (annehmen; deutsch/englisch umschaltbar) → Ort und Optionen → Installieren → Fertig.
// Installiert wird nur für den angemeldeten Benutzer, ohne Admin-Rechte, standardmäßig nach %LOCALAPPDATA%\Programs\Amberwave
// (eine ältere Version dort wird ersetzt; Einstellungen liegen in %APPDATA% und bleiben). Startmenü-Eintrag, auf Wunsch eine
// Desktop-Verknüpfung, Eintrag unter Einstellungen → Apps (deinstallieren über „Amberwave deinstallieren.exe“).
// Mit /portabel: gleicher Assistent, aber nur auspacken (Ordner neben dem Paket, keine Verknüpfungen, kein Eintrag unter Apps).
//
// Gezeichnet wird in logischen Pixeln (Fenster 760 × 480); die Umrechnung auf die Bildschirm-DPI übernimmt die GDI+-Transformation.
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <objidl.h>
#include <gdiplus.h>
#include <commctrl.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <propkey.h>
#include <propvarutil.h>
#include <dwmapi.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>
#include <math.h>
#include <string>
#include <vector>
#include "sfx_kern.h"

using namespace Gdiplus;

#ifdef AW_SERVER   // derselbe Assistent für den Amberwave Windows Server (windows-server/installer.sh)
#define ORDNER L"Amberwave Server"
#define PROGRAMM L"Amberwave Server.exe"
#define DEINSTALLIEREN L"Amberwave Server deinstallieren.exe"
#define TITEL L"Amberwave Server"
#define UNINSTALL_SCHLUESSEL L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AmberwaveServer"
#define APP_ID L"de.amberwave.server"
#define LNK L"\\Amberwave Server.lnk"
#define STANDARD_UNTERORDNER L"\\Programs\\Amberwave Server"
#else
#define ORDNER L"Amberwave Windows Client"
#define PROGRAMM L"Amberwave Client.exe"
#define DEINSTALLIEREN L"Amberwave deinstallieren.exe"
#define TITEL L"Amberwave Windows Client"
#define UNINSTALL_SCHLUESSEL L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AmberwaveClient"
#define APP_ID L"de.amberwave.client"
#define LNK L"\\Amberwave.lnk"
#define STANDARD_UNTERORDNER L"\\Programs\\Amberwave"
#endif
#ifndef AW_VERSION
#define AW_VERSION L"0"
#endif
#define RES_LIZENZ_EN 3   /* RCDATA: Lizenztext englisch (UTF-8) */
#define RES_LIZENZ_DE 4   /* RCDATA: Lizenztext deutsch, inoffizielle Übersetzung (UTF-8) */
#define RES_SCHRIFT_TEXT 10
#define RES_SCHRIFT_FETT 11
#define RES_SCHRIFT_TITEL 12

static int englisch(void) { return (GetUserDefaultUILanguage() & 0x3ff) != LANG_GERMAN; }
#define TX(de, en) (englisch() ? (en) : (de))
#define WM_STAND (WM_APP + 1)
#define WM_FERTIG (WM_APP + 2)

enum { S_WILLKOMMEN, S_LIZENZ, S_OPTIONEN, S_INSTALLIEREN, S_FERTIG };
enum {   // klickbare Flächen
  Z_NICHTS = 0, Z_MIN, Z_ZU, Z_WEITER, Z_ZURUECK, Z_ABBRECHEN, Z_HAKEN, Z_DE, Z_EN, Z_SUCHEN, Z_STARTMENUE, Z_DESKTOP,
  Z_LIZ_DAUMEN, Z_LIZ_SPUR, Z_DLG_JA, Z_DLG_NEIN, Z_STARTEN, Z_ORDNER
};
enum { D_KEIN, D_ABBRECHEN, D_UNTERORDNER, D_INFO };

#define BREITE 760
#define HOEHE 480
#define LEISTE 44
#define FUSS 404

static HINSTANCE inst;
static HWND fenster, pfad_feld;
static HFONT pfad_schrift;
static HBRUSH pfad_pinsel;
static float k = 1.0f;   // DPI-Faktor
static int seite = S_WILLKOMMEN, portabel = 0, laeuft = 0, erfolgreich = 0, akzeptiert = 0, liz_deutsch = 0;
static int mit_startmenue = 1, mit_desktop = 1, prozent = 0, animation = 1;
static DWORD inst_beginn = 0, anim_beginn = 0;
static wchar_t ziel[MAX_PATH * 2], fehler[512], vorhanden_version[64], aktuelle_datei[260];
static CRITICAL_SECTION datei_sperre;
static uint64_t xz_beginn, xz_laenge, roh_groesse;
static HANDLE quelle;

/* Schriften (GDI+, aus den Ressourcen) */
static PrivateFontCollection *schriften;
static FontFamily *fam_text, *fam_fett, *fam_titel, *fam_mono;

/* Dialog im Fenster (statt MessageBox) */
static int dlg = D_KEIN;
static std::wstring dlg_titel, dlg_text;

/* Treffer: in jedem Malvorgang neu gesammelt */
struct Ziel { RectF r; int id; int aktiv; };
static std::vector<Ziel> ziele;
static int ueber = Z_NICHTS, gedrueckt = Z_NICHTS;

/* Lizenz: Zeilen (vorab umbrochen, Monospace) und Bildlauf */
static std::wstring liz_text[2];
static std::vector<std::pair<int, int>> liz_zeilen;
static int liz_zeilen_fuer = -1;
static float liz_pos = 0, liz_zeichen_b = 7.0f;
static const float LIZ_ZH = 18.0f;
static RectF liz_box;
static float ziehen_y0 = 0, ziehen_pos0 = 0;

/* ---------- Dateien ---------- */

/** Beginn des eigentlichen Pfads hinter Laufwerk (C:\) bzw. Freigabe (\\server\freigabe\) */
static wchar_t *hinter_wurzel(wchar_t *p) {
  if (p[0] == L'\\' && p[1] == L'\\') {
    wchar_t *s = wcschr(p + 2, L'\\');
    if (s) s = wcschr(s + 1, L'\\');
    return s ? s + 1 : p + wcslen(p);
  }
  return wcslen(p) >= 3 ? p + 3 : p + wcslen(p);
}

static int ordner_anlegen(const wchar_t *pfad) {
  wchar_t p[MAX_PATH * 2];
  wcsncpy(p, pfad, MAX_PATH * 2 - 1); p[MAX_PATH * 2 - 1] = 0;
  for (wchar_t *s = hinter_wurzel(p); *s; s++) {
    if (*s == L'\\') { *s = 0; CreateDirectoryW(p, NULL); *s = L'\\'; }
  }
  return CreateDirectoryW(p, NULL) || GetLastError() == ERROR_ALREADY_EXISTS;
}

static int datei_da(const wchar_t *ordner, const wchar_t *name) {
  wchar_t p[MAX_PATH * 2];
  _snwprintf(p, MAX_PATH * 2, L"%ls\\%ls", ordner, name);
  return GetFileAttributesW(p) != INVALID_FILE_ATTRIBUTES;
}

static int ordner_leer(const wchar_t *pfad) {
  wchar_t muster[MAX_PATH * 2];
  _snwprintf(muster, MAX_PATH * 2, L"%ls\\*", pfad);
  WIN32_FIND_DATAW fd;
  HANDLE h = FindFirstFileW(muster, &fd);
  if (h == INVALID_HANDLE_VALUE) return GetLastError() == ERROR_FILE_NOT_FOUND;   // kein Zugriff o. Ä.: lieber „nicht leer“
  int leer = 1;
  do { if (wcscmp(fd.cFileName, L".") && wcscmp(fd.cFileName, L"..")) { leer = 0; break; } } while (FindNextFileW(h, &fd));
  FindClose(h);
  return leer;
}

static void ordner_loeschen(const wchar_t *pfad) {
  if (GetFileAttributesW(pfad) == INVALID_FILE_ATTRIBUTES) return;
  wchar_t doppelt[MAX_PATH * 2 + 2] = {0};
  wcsncpy(doppelt, pfad, MAX_PATH * 2);
  SHFILEOPSTRUCTW op = {};
  op.wFunc = FO_DELETE; op.pFrom = doppelt; op.fFlags = FOF_NO_UI;
  SHFileOperationW(&op);
}

/** 1, wenn der Ordner (falls vorhanden) gerade nicht benutzt wird – Probe: einmal umbenennen und zurück */
static int ordner_frei(const wchar_t *pfad) {
  if (GetFileAttributesW(pfad) == INVALID_FILE_ATTRIBUTES) return 1;
  wchar_t probe[MAX_PATH * 2];
  _snwprintf(probe, MAX_PATH * 2, L"%ls.probe-%lu", pfad, GetTickCount());
  if (!MoveFileW(pfad, probe)) return 0;
  MoveFileW(probe, pfad);
  return 1;
}

/* Ziel-Rückrufe für den Kern (sfx_kern.c) */
static HANDLE datei = INVALID_HANDLE_VALUE;
static wchar_t auspack[MAX_PATH * 2];   // hierhin wird ausgepackt (Nachbarordner von ziel), erst danach getauscht
static uint64_t geschrieben = 0;
static size_t q_lesen(void *, void *b, size_t n) { DWORD k2 = 0; return ReadFile(quelle, b, (DWORD)n, &k2, NULL) ? k2 : 0; }
static int q_neu(void *, const char *pfad8) {
  wchar_t rel[1024];
  if (MultiByteToWideChar(CP_UTF8, 0, pfad8, -1, rel, 1024) <= 0) return -1;
  for (wchar_t *s = rel; *s; s++) if (*s == L'/') *s = L'\\';
  EnterCriticalSection(&datei_sperre);
  wcsncpy(aktuelle_datei, rel, 259); aktuelle_datei[259] = 0;
  LeaveCriticalSection(&datei_sperre);
  wchar_t voll[MAX_PATH * 2];
  _snwprintf(voll, MAX_PATH * 2, L"%ls\\%ls", auspack, rel);
  wchar_t *schnitt = wcsrchr(voll, L'\\');
  *schnitt = 0; ordner_anlegen(voll); *schnitt = L'\\';
  datei = CreateFileW(voll, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  return datei == INVALID_HANDLE_VALUE ? -1 : 0;
}
static int q_schreiben(void *, const void *b, size_t n) { DWORD k2; geschrieben += n; return WriteFile(datei, b, (DWORD)n, &k2, NULL) && k2 == n ? 0 : -1; }
static void q_zu(void *) { if (datei != INVALID_HANDLE_VALUE) CloseHandle(datei); datei = INVALID_HANDLE_VALUE; }
static void q_stand(void *, int p) { PostMessageW(fenster, WM_STAND, (WPARAM)p, 0); }

/* ---------- Verknüpfungen und „Apps“ ---------- */

static void verknuepfung_anlegen(int csidl) {
  wchar_t lnk[MAX_PATH * 2], exe[MAX_PATH * 2];
  if (FAILED(SHGetFolderPathW(NULL, csidl, NULL, 0, lnk))) return;
  wcsncat(lnk, LNK, MAX_PATH * 2 - wcslen(lnk) - 1);
  _snwprintf(exe, MAX_PATH * 2, L"%ls\\" PROGRAMM, ziel);
  IShellLinkW *sl = NULL;
  if (SUCCEEDED(CoCreateInstance(CLSID_ShellLink, NULL, CLSCTX_INPROC_SERVER, IID_IShellLinkW, (void **)&sl))) {
    sl->SetPath(exe);
    sl->SetWorkingDirectory(ziel);
    sl->SetDescription(TITEL);
    sl->SetIconLocation(exe, 0);
    IPropertyStore *ps = NULL;
    if (SUCCEEDED(sl->QueryInterface(IID_IPropertyStore, (void **)&ps))) {
      // PKEY_AppUserModel_ID – dieselbe Kennung setzt der Client (app.setAppUserModelId)
      PROPVARIANT pv; PropVariantInit(&pv);
      pv.vt = VT_LPWSTR; pv.pwszVal = (LPWSTR)APP_ID;
      ps->SetValue(PKEY_AppUserModel_ID, pv);
      ps->Commit();
      ps->Release();
    }
    IPersistFile *pf = NULL;
    if (SUCCEEDED(sl->QueryInterface(IID_IPersistFile, (void **)&pf))) {
      pf->Save(lnk, TRUE);
      pf->Release();
    }
    sl->Release();
  }
}

static void reg_text(HKEY s, const wchar_t *name, const wchar_t *wert) {
  RegSetValueExW(s, name, 0, REG_SZ, (const BYTE *)wert, (DWORD)((wcslen(wert) + 1) * sizeof(wchar_t)));
}

static void apps_eintragen(void) {
  HKEY s;
  if (RegCreateKeyExW(HKEY_CURRENT_USER, UNINSTALL_SCHLUESSEL, 0, NULL, 0, KEY_WRITE, NULL, &s, NULL) != ERROR_SUCCESS) return;
  wchar_t exe[MAX_PATH * 2], weg[MAX_PATH * 2 + 4];
  _snwprintf(exe, MAX_PATH * 2, L"%ls\\" PROGRAMM, ziel);
  _snwprintf(weg, MAX_PATH * 2 + 4, L"\"%ls\\" DEINSTALLIEREN L"\"", ziel);
  reg_text(s, L"DisplayName", TITEL);
  reg_text(s, L"DisplayVersion", AW_VERSION);
  reg_text(s, L"Publisher", L"Amberwave");
  reg_text(s, L"DisplayIcon", exe);
  reg_text(s, L"InstallLocation", ziel);
  reg_text(s, L"UninstallString", weg);
  DWORD eins = 1, kb = (DWORD)(geschrieben / 1024);
  RegSetValueExW(s, L"NoModify", 0, REG_DWORD, (const BYTE *)&eins, sizeof eins);
  RegSetValueExW(s, L"NoRepair", 0, REG_DWORD, (const BYTE *)&eins, sizeof eins);
  RegSetValueExW(s, L"EstimatedSize", 0, REG_DWORD, (const BYTE *)&kb, sizeof kb);
  RegCloseKey(s);
}

/** Vorhandene Installation (Eintrag unter „Apps“): Ort und Version */
static void vorhandene_lesen(wchar_t *ort, DWORD ortGroesse) {
  HKEY s;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, UNINSTALL_SCHLUESSEL, 0, KEY_READ, &s) != ERROR_SUCCESS) return;
  DWORD typ, n;
  wchar_t puffer[MAX_PATH * 2];
  n = sizeof puffer;
  if (RegQueryValueExW(s, L"InstallLocation", NULL, &typ, (BYTE *)puffer, &n) == ERROR_SUCCESS && typ == REG_SZ && datei_da(puffer, PROGRAMM))
    wcsncpy(ort, puffer, ortGroesse / sizeof(wchar_t) - 1);
  n = sizeof vorhanden_version;
  if (RegQueryValueExW(s, L"DisplayVersion", NULL, &typ, (BYTE *)vorhanden_version, &n) != ERROR_SUCCESS || typ != REG_SZ) vorhanden_version[0] = 0;
  RegCloseKey(s);
}

/* ---------- Installieren (eigener Thread) ---------- */

static DWORD WINAPI installieren(LPVOID) {
  int ok = 0;
  fehler[0] = 0;
  geschrieben = 0;
  LARGE_INTEGER pos; pos.QuadPart = (LONGLONG)xz_beginn;
  SetFilePointerEx(quelle, pos, NULL, FILE_BEGIN);
  {
#ifdef AW_SERVER
    const wchar_t *laeuft_text = TX(L"Amberwave Server läuft noch. Bitte im Infobereich neben der Uhr: Rechtsklick auf das Amberwave-Symbol → „Beenden“, dann noch einmal „Installieren“ wählen.", L"Amberwave Server is still running. Please right-click the Amberwave icon in the notification area → “Quit”, then choose “Install” again.");
#else
    const wchar_t *laeuft_text = TX(L"Amberwave läuft noch (oder eine Datei im Ordner ist geöffnet). Bitte Amberwave schließen – auch im Infobereich neben der Uhr – und dann noch einmal „Installieren“ wählen.", L"Amberwave is still running (or a file in the folder is open). Please quit Amberwave – also in the notification area next to the clock – and then choose “Install” again.");
#endif
    if (!ordner_frei(ziel)) { wcscpy(fehler, laeuft_text); goto ende; }
    DWORD tick = GetTickCount();
    _snwprintf(auspack, MAX_PATH * 2, L"%ls.neu-%lu", ziel, tick);
    if (!ordner_anlegen(auspack)) { _snwprintf(fehler, 512, TX(L"Der Ordner %ls lässt sich nicht anlegen.", L"The folder %ls cannot be created."), ziel); goto ende; }
    SfxZiel z = {};
    z.laenge = xz_laenge; z.lesen = q_lesen; z.datei_neu = q_neu; z.datei_schreiben = q_schreiben; z.datei_zu = q_zu; z.stand = q_stand;
    char f8[300] = "";
    if (sfx_auspacken(&z, f8, sizeof f8) != 0) {
      q_zu(NULL);
      ordner_loeschen(auspack);
      if (englisch()) {
        if (!strncmp(f8, "Zu wenig Speicher", 17)) strcpy(f8, "Not enough memory.");
        else if (!strncmp(f8, "Schreiben fehlgeschlagen", 24)) strcpy(f8, "Writing failed (disk space?).");
        else if (!strncmp(f8, "Das Paket ist besch", 19)) strcpy(f8, "The package is damaged. Please download it again.");
        else { char *pz = strstr(f8, " l\xC3\xA4sst sich nicht schreiben."); if (pz) { char tmp[300]; *pz = 0; snprintf(tmp, sizeof tmp, "%s cannot be written.", f8); strcpy(f8, tmp); } }
      }
      MultiByteToWideChar(CP_UTF8, 0, f8, -1, fehler, 512);
      goto ende;
    }
    // tauschen: alte Version beiseite, neue an ihren Platz, alte löschen (schlägt etwas fehl, bleibt die alte erhalten)
    wchar_t alt[MAX_PATH * 2];
    _snwprintf(alt, MAX_PATH * 2, L"%ls.alt-%lu", ziel, tick);
    int hatte_alt = GetFileAttributesW(ziel) != INVALID_FILE_ATTRIBUTES;
    if (hatte_alt && !MoveFileW(ziel, alt)) { ordner_loeschen(auspack); wcscpy(fehler, laeuft_text); goto ende; }
    if (!MoveFileW(auspack, ziel)) {
      if (hatte_alt) MoveFileW(alt, ziel);
      ordner_loeschen(auspack);
      _snwprintf(fehler, 512, TX(L"Der Ordner %ls lässt sich nicht anlegen.", L"The folder %ls cannot be created."), ziel);
      goto ende;
    }
    if (hatte_alt) ordner_loeschen(alt);
    ok = 1;
    if (!portabel) {
      CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
      if (mit_startmenue) verknuepfung_anlegen(CSIDL_PROGRAMS);
      if (mit_desktop) verknuepfung_anlegen(CSIDL_DESKTOPDIRECTORY);
      CoUninitialize();
      apps_eintragen();
    }
  }
ende:
  PostMessageW(fenster, WM_FERTIG, (WPARAM)ok, 0);
  return 0;
}

/* ---------- Ressourcen ---------- */

static const void *ressource(int id, DWORD *n) {
  HRSRC r = FindResourceW(inst, MAKEINTRESOURCEW(id), (LPCWSTR)RT_RCDATA);
  if (!r) return NULL;
  *n = SizeofResource(inst, r);
  return LockResource(LoadResource(inst, r));
}

static std::wstring utf8_text(int id) {
  DWORD n = 0;
  const char *d = (const char *)ressource(id, &n);
  if (!d || !n) return L"";
  int w = MultiByteToWideChar(CP_UTF8, 0, d, (int)n, NULL, 0);
  std::wstring s((size_t)w, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, d, (int)n, &s[0], w);
  std::wstring o; o.reserve(s.size());
  for (wchar_t c : s) if (c != L'\r' && c != 0xFEFF) o += (c == L'\t' ? L' ' : c);
  return o;
}

static void schriften_laden(void) {
  schriften = new PrivateFontCollection();
  int ids[3] = {RES_SCHRIFT_TEXT, RES_SCHRIFT_FETT, RES_SCHRIFT_TITEL};
  for (int i = 0; i < 3; i++) {
    DWORD n = 0; const void *d = ressource(ids[i], &n);
    if (!d) continue;
    schriften->AddMemoryFont(d, (INT)n);
    DWORD anzahl = 0; AddFontMemResourceEx((PVOID)d, n, NULL, &anzahl);   // auch für GDI (Eingabefeld)
  }
  auto fam = [](const wchar_t *name, const wchar_t *ersatz) {
    FontFamily *f = new FontFamily(name, schriften);
    if (f->GetLastStatus() != Ok) { delete f; f = new FontFamily(ersatz); }
    return f;
  };
  fam_text = fam(L"AWText", L"Segoe UI");
  fam_fett = fam(L"AWTextFett", L"Segoe UI Semibold");
  fam_titel = fam(L"AWTitel", L"Segoe UI");
  fam_mono = new FontFamily(L"Consolas");
  if (fam_mono->GetLastStatus() != Ok) { delete fam_mono; fam_mono = new FontFamily(L"Courier New"); }
}

/* ---------- Zeichnen: Grundbausteine ---------- */

static Color farbe(int a, int r, int g, int b) { return Color((BYTE)a, (BYTE)r, (BYTE)g, (BYTE)b); }
#define TEXTFARBE farbe(255, 246, 239, 231)
#define LEISE farbe(255, 188, 174, 159)
#define WARM farbe(255, 214, 201, 187)
#define AKZENT farbe(255, 255, 201, 118)
#define GRUEN farbe(255, 95, 220, 164)
#define AMBER1 farbe(255, 255, 181, 71)
#define AMBER2 farbe(255, 255, 122, 61)
#define DUNKEL farbe(255, 29, 18, 8)

static Graphics *g;

static void rund(GraphicsPath &p, RectF r, float rad) {
  float d = rad * 2;
  if (d > r.Width) d = r.Width;
  if (d > r.Height) d = r.Height;
  if (d <= 0.5f) { p.AddRectangle(r); return; }
  p.AddArc(r.X, r.Y, d, d, 180, 90);
  p.AddArc(r.X + r.Width - d, r.Y, d, d, 270, 90);
  p.AddArc(r.X + r.Width - d, r.Y + r.Height - d, d, d, 0, 90);
  p.AddArc(r.X, r.Y + r.Height - d, d, d, 90, 90);
  p.CloseFigure();
}

static void flaeche(RectF r, float rad, const Brush &b) { GraphicsPath p; rund(p, r, rad); g->FillPath(&b, &p); }
static void flaeche(RectF r, float rad, Color c) { SolidBrush b(c); flaeche(r, rad, b); }
static void rahmen(RectF r, float rad, Color c, float w = 1.0f) {
  GraphicsPath p; RectF i(r.X + w / 2, r.Y + w / 2, r.Width - w, r.Height - w); rund(p, i, rad);
  Pen pen(c, w); g->DrawPath(&pen, &p);
}
/** Amber-Verlauf (135°) über r; alpha für ausgegraute Knöpfe */
static void amber(RectF r, float rad, int alpha = 255, int vertikal = 0) {
  PointF a(r.X, r.Y), b = vertikal ? PointF(r.X, r.Y + r.Height) : PointF(r.X + r.Width, r.Y + r.Height);
  LinearGradientBrush lb(a, b, farbe(alpha, 255, 181, 71), farbe(alpha, 255, 122, 61));
  flaeche(r, rad, lb);
}

static StringFormat *fmt_eine, *fmt_umbruch;

static void formate(void) {
  fmt_eine = StringFormat::GenericTypographic()->Clone();
  fmt_eine->SetFormatFlags(StringFormatFlagsNoWrap | StringFormatFlagsMeasureTrailingSpaces | StringFormatFlagsNoClip);
  fmt_eine->SetTrimming(StringTrimmingEllipsisCharacter);
  fmt_umbruch = StringFormat::GenericTypographic()->Clone();
  fmt_umbruch->SetFormatFlags(StringFormatFlagsMeasureTrailingSpaces);
  fmt_umbruch->SetTrimming(StringTrimmingWord);
}

static float breite(const wchar_t *s, const Font &f) {
  RectF out; g->MeasureString(s, -1, &f, PointF(0, 0), fmt_eine, &out);
  return out.Width;
}
/** Höhe eines umbrochenen Absatzes */
static float hoehe(const wchar_t *s, const Font &f, float b) {
  RectF out; g->MeasureString(s, -1, &f, RectF(0, 0, b, 2000), fmt_umbruch, &out);
  return out.Height;
}

/** Text in einer Zeile; ausr: 0 links, 1 Mitte, 2 rechts (x ist dann die rechte Kante bzw. Mitte); b = 0: ohne Begrenzung */
static float text(const wchar_t *s, const Font &f, Color c, float x, float y, float b = 0, int ausr = 0) {
  SolidBrush br(c);
  float w = breite(s, f);
  if (b > 0 && w > b) w = b;
  float x0 = ausr == 1 ? x - w / 2 : ausr == 2 ? x - w : x;
  if (b > 0) g->DrawString(s, -1, &f, RectF(x0, y, b, f.GetHeight(g) + 4), fmt_eine, &br);
  else g->DrawString(s, -1, &f, PointF(x0, y), fmt_eine, &br);
  return w;
}
/** umbrochener Absatz; gibt die Höhe zurück */
static float absatz(const wchar_t *s, const Font &f, Color c, float x, float y, float b, float zeilenabstand = 1.0f) {
  SolidBrush br(c);
  if (zeilenabstand == 1.0f) {
    float h = hoehe(s, f, b);
    g->DrawString(s, -1, &f, RectF(x, y, b, h + 4), fmt_umbruch, &br);
    return h;
  }
  // eigener Umbruch mit größerem Zeilenabstand (GDI+ kennt keinen)
  std::wstring rest(s), zeile;
  float zh = f.GetHeight(g) * zeilenabstand, yy = y;
  while (!rest.empty()) {
    size_t n = rest.size(), gut = 0;
    for (size_t i = 1; i <= n; i++) {
      if (i < n && rest[i] != L' ' && rest[i] != L'\n') continue;
      if (breite(rest.substr(0, i).c_str(), f) > b) break;
      gut = i;
      if (i < n && rest[i] == L'\n') break;
    }
    if (!gut) { gut = 1; while (gut < n && breite(rest.substr(0, gut + 1).c_str(), f) <= b) gut++; }
    zeile = rest.substr(0, gut);
    g->DrawString(zeile.c_str(), -1, &f, PointF(x, yy), fmt_eine, &br);
    yy += zh;
    rest = rest.substr(gut);
    while (!rest.empty() && (rest[0] == L' ' || rest[0] == L'\n')) { bool nl = rest[0] == L'\n'; rest.erase(0, 1); if (nl) break; }
  }
  return yy - y;
}
/** Großbuchstaben-Etikett mit Laufweite */
static void etikett(const wchar_t *s, Color c, float x, float y, float sperr = 1.6f) {
  Font f(fam_fett, 12, FontStyleRegular, UnitPixel);
  SolidBrush br(c);
  wchar_t z[2] = {0, 0};
  for (const wchar_t *p = s; *p; p++) {
    z[0] = *p;
    g->DrawString(z, 1, &f, PointF(x, y), fmt_eine, &br);
    x += breite(z, f) + sperr;
  }
}

static void ziel_neu(int id, RectF r, int aktiv = 1) { ziele.push_back({r, id, aktiv}); }
static int ist_ueber(int id) { return ueber == id && !dlg; }

/** Amberwave-Logo: dunkles Quadrat mit fünf Amber-Balken (wie das App-Symbol); wackeln: 0…1 Animationsstärke */
static void logo(float x, float y, float s, float wackeln = 0, float zeit = 0) {
  flaeche(RectF(x, y, s, s), s * 0.235f, farbe(255, 28, 20, 14));
  static const float hoe[5] = {12, 28, 44, 24, 36}, oben[5] = {26, 18, 10, 20, 14}, phase[5] = {0.2f, 0.9f, 1.6f, 0.5f, 1.2f};
  float f = s / 64.0f;
  for (int i = 0; i < 5; i++) {
    float h = hoe[i], y0 = oben[i];
    if (wackeln > 0) {
      float m = 0.55f + 0.45f * (0.5f + 0.5f * sinf((zeit / 2.4f) * 6.2832f + phase[i] * 2.6f));
      float neu = h * (1 - wackeln + wackeln * m);
      y0 = y0 + (h - neu) / 2; h = neu;
    }
    amber(RectF(x + (10 + i * 10) * f, y + y0 * f, 6 * f, h * f), 3 * f, 255, 1);
  }
}

/* ---------- Zeichnen: Fensterteile ---------- */

static void hintergrund(void) {
  // dunkler, warmer Grund mit Amber-Schein oben (Willkommen/Optionen links, Fertig rechts)
  SolidBrush grund(farbe(255, 17, 12, 9));
  g->FillRectangle(&grund, RectF(0, 0, BREITE, HOEHE));
  float cx = seite == S_FERTIG ? BREITE * 0.8f : BREITE * 0.18f, cy = -HOEHE * 0.1f;
  GraphicsPath p; p.AddEllipse(cx - BREITE * 1.2f, cy - HOEHE * 0.95f, BREITE * 2.4f, HOEHE * 1.9f);
  PathGradientBrush pg(&p);
  pg.SetCenterPoint(PointF(cx, cy));
  pg.SetCenterColor(farbe(255, 58, 36, 18));
  Color rand[1] = {farbe(0, 22, 15, 11)};
  int n = 1; pg.SetSurroundColors(rand, &n);
  REAL pos[3] = {0.0f, 0.5f, 1.0f}; Color fa[3] = {farbe(0, 22, 15, 11), farbe(150, 32, 21, 14), farbe(255, 58, 36, 18)};
  pg.SetInterpolationColors(fa, pos, 3);
  g->FillPath(&pg, &p);
}

static void titelleiste(void) {
  logo(16, 12, 20);
  Font f(fam_titel, 13, FontStyleRegular, UnitPixel);
  float w = text(L"Amberwave Setup", f, TEXTFARBE, 46, 14);
  Font fk(fam_text, 11, FontStyleRegular, UnitPixel);
  float vw = breite(AW_VERSION, fk);
  RectF chip(46 + w + 10, 12, vw + 16, 20);
  rahmen(chip, 10, farbe(36, 255, 236, 214));
  text(AW_VERSION, fk, LEISE, chip.X + 8, 15);
  // Minimieren, Schließen
  RectF rm(BREITE - 8 - 34 - 34 - 2, 7, 34, 30), rz(BREITE - 8 - 34, 7, 34, 30);
  int zu_aktiv = !laeuft;
  if (ist_ueber(Z_MIN)) flaeche(rm, 8, farbe(20, 255, 244, 230));
  if (ist_ueber(Z_ZU) && zu_aktiv) flaeche(rz, 8, farbe(200, 196, 43, 28));
  Pen pm(ist_ueber(Z_MIN) ? TEXTFARBE : LEISE, 1.4f); pm.SetStartCap(LineCapRound); pm.SetEndCap(LineCapRound);
  g->DrawLine(&pm, rm.X + 11, rm.Y + 15, rm.X + 23, rm.Y + 15);
  Color zc = !zu_aktiv ? farbe(90, 188, 174, 159) : ist_ueber(Z_ZU) ? farbe(255, 255, 255, 255) : LEISE;
  Pen pz(zc, 1.4f); pz.SetStartCap(LineCapRound); pz.SetEndCap(LineCapRound);
  g->DrawLine(&pz, rz.X + 12, rz.Y + 10, rz.X + 22, rz.Y + 20);
  g->DrawLine(&pz, rz.X + 22, rz.Y + 10, rz.X + 12, rz.Y + 20);
  ziel_neu(Z_MIN, rm);
  ziel_neu(Z_ZU, rz, zu_aktiv);
}

/** Knopf; rechte Kante bei x_rechts, gibt die linke Kante zurück */
static float knopf(int id, const wchar_t *s, float x_rechts, float y, int haupt, int aktiv = 1, int symbol_start = 0) {
  Font f(fam_fett, 14, FontStyleRegular, UnitPixel);
  float tw = breite(s, f), extra = symbol_start ? 22 : 0;
  RectF r(x_rechts - tw - extra - 44, y, tw + extra + 44, 40);
  int hv = ist_ueber(id) && aktiv;
  if (haupt) {
    amber(r, 20, aktiv ? 255 : 97);
    if (hv) flaeche(r, 20, farbe(26, 255, 255, 255));
    if (gedrueckt == id && hv) flaeche(r, 20, farbe(30, 0, 0, 0));
  } else {
    flaeche(r, 20, farbe(hv ? 31 : 18, 255, 244, 230));
    rahmen(r, 20, farbe(41, 255, 236, 214));
  }
  Color tc = haupt ? (aktiv ? DUNKEL : farbe(160, 29, 18, 8)) : (aktiv ? TEXTFARBE : farbe(97, 246, 239, 231));
  if (symbol_start) {
    SolidBrush b(tc);
    PointF dr[3] = {PointF(r.X + 22, r.Y + 13.5f), PointF(r.X + 22, r.Y + 26.5f), PointF(r.X + 32.5f, r.Y + 20)};
    g->FillPolygon(&b, dr, 3);
  }
  text(s, f, tc, r.X + 22 + extra, r.Y + 11.5f);
  ziel_neu(id, r, aktiv);
  return r.X;
}

static void fuss(int schritt) {
  Pen linie(farbe(20, 255, 236, 214), 1);
  g->DrawLine(&linie, 0.0f, (REAL)FUSS, (REAL)BREITE, (REAL)FUSS);
  float x = 56;
  for (int i = 0; i < 5; i++) {
    float w = i == schritt ? 22.0f : 6.0f;
    Color c = i == schritt ? AMBER1 : i < schritt ? farbe(140, 255, 181, 71) : farbe(51, 255, 236, 214);
    flaeche(RectF(x, 439, w, 6), 3, c);
    x += w + 6;
  }
}

static void haken_symbol(float x, float y, float s, Color c, float dicke) {
  Pen p(c, dicke); p.SetStartCap(LineCapRound); p.SetEndCap(LineCapRound); p.SetLineJoin(LineJoinRound);
  PointF pt[3] = {PointF(x + s * 0.21f, y + s * 0.52f), PointF(x + s * 0.40f, y + s * 0.71f), PointF(x + s * 0.79f, y + s * 0.29f)};
  g->DrawLines(&p, pt, 3);
}

/* ---------- Seiten ---------- */

static void seite_willkommen(float t) {
  float x = 56, b = 358;
  Font h1(fam_titel, 40, FontStyleRegular, UnitPixel), p(fam_text, 15, FontStyleRegular, UnitPixel), klein(fam_text, 13, FontStyleRegular, UnitPixel);
#ifdef AW_SERVER
  const wchar_t *titel1 = TX(L"Deine Musik.", L"Your music."), *titel2 = TX(L"Dein Server.", L"Your server.");
  const wchar_t *txt = TX(L"Amberwave Server macht diesen PC zum Musikserver für die ganze Familie – Browser, Handy und Windows-Client, zu Hause und unterwegs. Läuft im Infobereich, wie Plex.",
                          L"Amberwave Server turns this PC into a music server for the whole family – browser, phone and Windows client, at home and on the go. Runs in the notification area, like Plex.");
#else
  const wchar_t *titel1 = TX(L"Deine Musik.", L"Your music."), *titel2 = TX(L"Bitgenau am PC.", L"Bit-perfect on your PC.");
  const wchar_t *txt = TX(L"Amberwave spielt die Sammlung deines Servers über WASAPI oder ASIO ab – lückenlos, in der Abtastrate der Datei, mit Effekten und deinen VST3-Plug-ins.",
                          L"Amberwave plays your server's collection via WASAPI or ASIO – gapless, at the file's own sample rate, with effects and your VST3 plug-ins.");
#endif
  wchar_t upd[300] = L"";
  int update = vorhanden_version[0] && !portabel;
#ifdef AW_SERVER
  if (update) _snwprintf(upd, 300, TX(L"Version %ls ist installiert und wird aktualisiert. Bibliothek, Konten und Einstellungen bleiben.", L"Version %ls is installed and will be updated. Library, accounts and settings are kept."), vorhanden_version);
#else
  if (update) _snwprintf(upd, 300, TX(L"Version %ls ist installiert und wird aktualisiert. Deine Einstellungen bleiben.", L"Version %ls is installed and will be updated. Your settings are kept."), vorhanden_version);
#endif
  if (portabel) wcscpy(upd, TX(L"Portabel: Amberwave wird nur ausgepackt – ohne Verknüpfungen und ohne Eintrag unter „Apps“.", L"Portable: Amberwave is only unpacked – no shortcuts and no entry under “Apps”."));
  float h_txt = hoehe(txt, p, b) * 1.12f, h_upd = upd[0] ? hoehe(upd, klein, b - 54) + 20 : 0;
  float gesamt = 12 + 18 + 84 + 18 + h_txt + (upd[0] ? 18 + h_upd : 0) + 18 + 16;
  float y = LEISTE + (FUSS - LEISTE - gesamt) / 2;
#ifdef AW_SERVER
  etikett(TX(L"WINDOWS SERVER", L"WINDOWS SERVER"), AKZENT, x, y);
#else
  etikett(TX(L"WINDOWS CLIENT", L"WINDOWS CLIENT"), AKZENT, x, y);
#endif
  y += 12 + 18;
  text(titel1, h1, TEXTFARBE, x - 2, y, b);
  text(titel2, h1, TEXTFARBE, x - 2, y + 42, b);
  y += 84 + 18;
  y += absatz(txt, p, WARM, x, y, b, 1.12f);
  if (upd[0]) {
    y += 18;
    RectF box(x, y, b, h_upd);
    flaeche(box, 12, farbe(26, 255, 181, 71));
    rahmen(box, 12, farbe(71, 255, 181, 71));
    Pen pf(AKZENT, 1.5f); pf.SetStartCap(LineCapRound); pf.SetEndCap(LineCapRound);
    float ix = x + 14, iy = y + h_upd / 2 - 8;
    if (portabel) { g->DrawRectangle(&pf, ix + 2, iy + 3, 12.0f, 10.0f); }
    else { g->DrawLine(&pf, ix + 8, iy + 2, ix + 8, iy + 10); g->DrawLine(&pf, ix + 4.5f, iy + 6.5f, ix + 8, iy + 10); g->DrawLine(&pf, ix + 11.5f, iy + 6.5f, ix + 8, iy + 10); g->DrawLine(&pf, ix + 3, iy + 13, ix + 13, iy + 13); }
    absatz(upd, klein, TEXTFARBE, x + 40, y + 10, b - 54);
    y += h_upd;
  }
  y += 18;
  // Schild mit Haken
  {
    Pen ps(GRUEN, 1.4f); ps.SetLineJoin(LineJoinRound);
    GraphicsPath sp;
    sp.AddLine(x + 8, y + 1.5f, x + 13, y + 3.5f); sp.AddLine(x + 13, y + 3.5f, x + 13, y + 7.5f);
    sp.AddBezier(x + 13, y + 7.5f, x + 13, y + 10.7f, x + 10.8f, y + 13.1f, x + 8, y + 14.5f);
    sp.AddBezier(x + 8, y + 14.5f, x + 5.2f, y + 13.1f, x + 3, y + 10.7f, x + 3, y + 7.5f);
    sp.AddLine(x + 3, y + 7.5f, x + 3, y + 3.5f); sp.CloseFigure();
    g->DrawPath(&ps, &sp);
    haken_symbol(x + 2.5f, y + 2.5f, 11, GRUEN, 1.4f);
    text(portabel ? TX(L"Keine Administratorrechte nötig", L"No administrator rights needed")
                  : TX(L"Nur für dich installiert – keine Administratorrechte nötig", L"Installed just for you – no administrator rights needed"), klein, LEISE, x + 24, y);
  }
  // Bühne rechts: Schein und großes Logo
  float bx = BREITE - 52 - 250, by = LEISTE + (FUSS - LEISTE - 300) / 2;
  {
    GraphicsPath p2; p2.AddEllipse(bx + 20, by + 20, 210.0f, 260.0f);
    PathGradientBrush pg(&p2);
    pg.SetCenterColor(farbe(90, 255, 150, 60));
    Color rr[1] = {farbe(0, 255, 150, 60)}; int n = 1; pg.SetSurroundColors(rr, &n);
    g->FillPath(&pg, &p2);
  }
  // Schatten unter dem Logo
  for (int i = 6; i >= 1; i--) flaeche(RectF(bx + 50 - i * 3.0f, by + 75 + 24 - i * 2.0f, 150 + i * 6.0f, 150 + i * 6.0f), 36 + i * 3.0f, farbe(14, 0, 0, 0));
  logo(bx + 50, by + 75, 150, animation ? 1.0f : 0, t);
}

static void liz_umbrechen(void) {
  int sprache = liz_deutsch ? 1 : 0;
  if (liz_zeilen_fuer == sprache) return;
  liz_zeilen.clear();
  const std::wstring &s = liz_text[sprache];
  Font f(fam_mono, 12, FontStyleRegular, UnitPixel);
  liz_zeichen_b = breite(L"MMMMMMMMMMMMMMMMMMMM", f) / 20.0f;
  int spalten = (int)((liz_box.Width - 36 - 10) / liz_zeichen_b);
  if (spalten < 40) spalten = 40;
  size_t i = 0;
  while (i <= s.size()) {
    size_t ende = s.find(L'\n', i);
    if (ende == std::wstring::npos) ende = s.size();
    size_t a = i;
    if (ende == a) liz_zeilen.push_back({(int)a, 0});
    while (a < ende) {
      size_t n = ende - a;
      if ((int)n > spalten) {
        size_t schnitt = a + spalten;
        while (schnitt > a + spalten / 2 && s[schnitt] != L' ') schnitt--;
        if (schnitt <= a + spalten / 2) schnitt = a + spalten;
        liz_zeilen.push_back({(int)a, (int)(schnitt - a)});
        a = schnitt; while (a < ende && s[a] == L' ') a++;
      } else { liz_zeilen.push_back({(int)a, (int)n}); a = ende; }
    }
    i = ende + 1;
  }
  liz_zeilen_fuer = sprache;
  liz_pos = 0;
}

static float liz_max(void) {
  float inhalt = liz_zeilen.size() * LIZ_ZH + 28, sicht = liz_box.Height;
  return inhalt > sicht ? inhalt - sicht : 0;
}

static void liz_scrollen(float um) {
  liz_pos += um;
  float m = liz_max();
  if (liz_pos < 0) liz_pos = 0;
  if (liz_pos > m) liz_pos = m;
  InvalidateRect(fenster, NULL, FALSE);
}

static void chip(float x, float y, float w, const wchar_t *s, int art) {
  RectF r(x, y, w, 40);
  Color hg = art == 0 ? farbe(18, 95, 220, 164) : art == 1 ? farbe(18, 255, 181, 71) : farbe(10, 255, 244, 230);
  Color rd = art == 0 ? farbe(51, 95, 220, 164) : art == 1 ? farbe(51, 255, 181, 71) : farbe(31, 255, 236, 214);
  flaeche(r, 12, hg); rahmen(r, 12, rd);
  float ix = x + 12, iy = y + 12;
  if (art == 0) haken_symbol(ix, iy, 16, GRUEN, 1.6f);
  else if (art == 1) {
    Pen p(AKZENT, 1.7f); p.SetStartCap(LineCapRound); p.SetEndCap(LineCapRound);
    g->DrawLine(&p, ix + 8, iy + 3.5f, ix + 8, iy + 8.5f); g->DrawLine(&p, ix + 8, iy + 11.6f, ix + 8, iy + 11.8f);
  } else {
    Pen p(LEISE, 1.4f); p.SetStartCap(LineCapRound); p.SetEndCap(LineCapRound);
    g->DrawEllipse(&p, ix + 2.4f, iy + 2.4f, 11.2f, 11.2f); g->DrawLine(&p, ix + 5.2f, iy + 10.8f, ix + 10.8f, iy + 5.2f);
  }
  Font f(fam_text, 12.5f, FontStyleRegular, UnitPixel);
  text(s, f, WARM, x + 38, y + 12, w - 46);
}

static void seite_lizenz(void) {
  Font h(fam_titel, 26, FontStyleRegular, UnitPixel), u(fam_text, 13, FontStyleRegular, UnitPixel), f(fam_fett, 12, FontStyleRegular, UnitPixel);
  float w = text(TX(L"Lizenz", L"License"), h, TEXTFARBE, 56, 58);
  text(L"GNU Affero General Public License v3.0", u, LEISE, 56 + w + 14, 69);
  // Sprachumschalter
  float dw = breite(L"Deutsch", f) + 24, ew = breite(L"English", f) + 24;
  RectF sw(BREITE - 56 - dw - ew - 6, 58, dw + ew + 6, 30);
  flaeche(sw, 15, farbe(15, 255, 244, 230)); rahmen(sw, 15, farbe(31, 255, 236, 214));
  RectF rde(sw.X + 3, sw.Y + 3, dw, 24), ren(sw.X + 3 + dw, sw.Y + 3, ew, 24);
  if (liz_deutsch) flaeche(rde, 12, farbe(46, 255, 181, 71)); else flaeche(ren, 12, farbe(46, 255, 181, 71));
  text(L"Deutsch", f, liz_deutsch ? AKZENT : (ist_ueber(Z_DE) ? TEXTFARBE : LEISE), rde.X + dw / 2, rde.Y + 6, 0, 1);
  text(L"English", f, !liz_deutsch ? AKZENT : (ist_ueber(Z_EN) ? TEXTFARBE : LEISE), ren.X + ew / 2, ren.Y + 6, 0, 1);
  ziel_neu(Z_DE, rde); ziel_neu(Z_EN, ren);
  // drei Kurzinfos
  float cw = (BREITE - 112 - 20) / 3.0f, cy = 102;
  chip(56, cy, cw, TX(L"Frei nutzen und ändern", L"Free to use and change"), 0);
  chip(56 + cw + 10, cy, cw, TX(L"Änderungen bleiben offen", L"Changes stay open"), 1);
  chip(56 + 2 * (cw + 10), cy, cw, TX(L"Ohne Gewährleistung", L"No warranty"), 2);
  // Textfeld
  liz_box = RectF(56, 156, BREITE - 112, 196);
  flaeche(liz_box, 12, farbe(150, 8, 5, 3)); rahmen(liz_box, 12, farbe(26, 255, 236, 214));
  liz_umbrechen();
  {
    GraphicsState st = g->Save();
    GraphicsPath clip; rund(clip, RectF(liz_box.X + 1, liz_box.Y + 1, liz_box.Width - 2, liz_box.Height - 2), 11);
    g->SetClip(&clip);
    Font mono(fam_mono, 12, FontStyleRegular, UnitPixel);
    SolidBrush br(farbe(255, 201, 188, 174));
    const std::wstring &s = liz_text[liz_deutsch ? 1 : 0];
    int erste = (int)((liz_pos - 14) / LIZ_ZH); if (erste < 0) erste = 0;
    for (int i = erste; i < (int)liz_zeilen.size(); i++) {
      float y = liz_box.Y + 14 + i * LIZ_ZH - liz_pos;
      if (y > liz_box.Y + liz_box.Height) break;
      if (liz_zeilen[i].second) g->DrawString(s.c_str() + liz_zeilen[i].first, liz_zeilen[i].second, &mono, PointF(liz_box.X + 18, y), fmt_eine, &br);
    }
    g->Restore(st);
  }
  // Bildlaufleiste
  float m = liz_max();
  if (m > 0) {
    RectF spur(liz_box.X + liz_box.Width - 12, liz_box.Y + 8, 6, liz_box.Height - 16);
    float dh = spur.Height * liz_box.Height / (liz_box.Height + m); if (dh < 30) dh = 30;
    RectF daumen(spur.X, spur.Y + (spur.Height - dh) * (liz_pos / m), 6, dh);
    flaeche(daumen, 3, farbe(ist_ueber(Z_LIZ_DAUMEN) || gedrueckt == Z_LIZ_DAUMEN ? 90 : 46, 255, 236, 214));
    ziel_neu(Z_LIZ_SPUR, RectF(spur.X - 4, spur.Y, 14, spur.Height));
    ziel_neu(Z_LIZ_DAUMEN, RectF(daumen.X - 4, daumen.Y, 14, daumen.Height));
  }
  // Zustimmung
  RectF box(56, 366, 20, 20);
  if (akzeptiert) { amber(box, 6); haken_symbol(box.X + 2, box.Y + 2, 16, DUNKEL, 1.9f); }
  else { flaeche(box, 6, farbe(ist_ueber(Z_HAKEN) ? 20 : 0, 255, 244, 230)); rahmen(box, 6, farbe(ist_ueber(Z_HAKEN) ? 140 : 89, 255, 236, 214), 1.5f); }
  Font t(fam_text, 14, FontStyleRegular, UnitPixel);
  float tw = text(TX(L"Ich habe die Lizenz gelesen und stimme zu", L"I have read and accept the license"), t, TEXTFARBE, 88, 368);
  ziel_neu(Z_HAKEN, RectF(52, 362, tw + 40, 28));
}

static uint64_t frei_auf(const wchar_t *pfad) {
  // nächster vorhandener Ordner auf dem Weg nach oben (auch \\server\freigabe)
  wchar_t p[MAX_PATH * 2];
  wcsncpy(p, pfad, MAX_PATH * 2 - 1); p[MAX_PATH * 2 - 1] = 0;
  wchar_t *grenze = hinter_wurzel(p);
  for (;;) {
    DWORD at = GetFileAttributesW(p);
    if (at != INVALID_FILE_ATTRIBUTES && (at & FILE_ATTRIBUTE_DIRECTORY)) break;
    wchar_t *s = wcsrchr(p, L'\\');
    if (!s || s < grenze - 1) { if (grenze > p) { *grenze = 0; } break; }
    *s = 0;
    if (s == grenze - 1) { *grenze = 0; break; }   // nur noch die Wurzel (C: → C:\)
  }
  size_t n = wcslen(p);
  if (n && p[n - 1] != L'\\') wcsncat(p, L"\\", MAX_PATH * 2 - n - 1);
  ULARGE_INTEGER frei; frei.QuadPart = 0;
  if (!GetDiskFreeSpaceExW(p, &frei, NULL, NULL)) return 0;
  return frei.QuadPart;
}

static void schalter_zeile(int id, float y, const wchar_t *titel, int an, int symbol) {
  RectF r(56, y, BREITE - 112, 48);
  flaeche(r, 12, farbe(ist_ueber(id) ? 16 : 9, 255, 244, 230)); rahmen(r, 12, farbe(23, 255, 236, 214));
  Pen p(AKZENT, 1.3f); p.SetLineJoin(LineJoinRound); p.SetStartCap(LineCapRound); p.SetEndCap(LineCapRound);
  float ix = r.X + 15, iy = r.Y + 15;
  if (symbol == 0) {   // Startmenü: vier Kacheln
    for (int i = 0; i < 4; i++) { GraphicsPath q; rund(q, RectF(ix + 2 + (i % 2) * 8, iy + 2 + (i / 2) * 8, 6, 6), 1.4f); g->DrawPath(&p, &q); }
  } else {             // Desktop: Bildschirm
    GraphicsPath q; rund(q, RectF(ix + 2, iy + 3, 14, 9.5f), 1.6f); g->DrawPath(&p, &q);
    g->DrawLine(&p, ix + 6.5f, iy + 15.5f, ix + 11.5f, iy + 15.5f); g->DrawLine(&p, ix + 9, iy + 12.5f, ix + 9, iy + 15.5f);
  }
  Font f(fam_fett, 14, FontStyleRegular, UnitPixel);
  text(titel, f, TEXTFARBE, r.X + 46, r.Y + 15);
  RectF sw(r.X + r.Width - 14 - 38, r.Y + 13, 38, 22);
  if (an) amber(sw, 11); else flaeche(sw, 11, farbe(46, 255, 236, 214));
  SolidBrush knauf(farbe(255, 255, 246, 236));
  g->FillEllipse(&knauf, sw.X + (an ? 19 : 3), sw.Y + 3, 16.0f, 16.0f);
  ziel_neu(id, r);
}

static RectF pfad_rect(void) { return RectF(56, 118, BREITE - 112 - 160, 40); }

static void seite_optionen(void) {
  Font h(fam_titel, 26, FontStyleRegular, UnitPixel), klein(fam_text, 12, FontStyleRegular, UnitPixel), kf(fam_fett, 12, FontStyleRegular, UnitPixel);
  text(portabel ? TX(L"Wohin soll Amberwave ausgepackt werden?", L"Where should Amberwave be unpacked?") : TX(L"Wohin soll Amberwave?", L"Where should Amberwave go?"), h, TEXTFARBE, 56, 58);
  etikett(TX(L"ZIELORDNER", L"DESTINATION FOLDER"), LEISE, 56, 99, 1.4f);
  RectF pf = pfad_rect();
  flaeche(pf, 10, farbe(255, 13, 9, 7)); rahmen(pf, 10, farbe(GetFocus() == pfad_feld ? 110 : 36, 255, 236, 214));
  {   // Ordnersymbol
    Pen p(AKZENT, 1.3f); p.SetLineJoin(LineJoinRound);
    float ix = pf.X + 13, iy = pf.Y + 12;
    PointF o[7] = {PointF(ix + 1.8f, iy + 13.2f), PointF(ix + 1.8f, iy + 3), PointF(ix + 6, iy + 3), PointF(ix + 7.5f, iy + 4.6f),
                   PointF(ix + 14.2f, iy + 4.6f), PointF(ix + 14.2f, iy + 13.2f), PointF(ix + 1.8f, iy + 13.2f)};
    g->DrawLines(&p, o, 7);
  }
  knopf(Z_SUCHEN, TX(L"Durchsuchen …", L"Browse …"), BREITE - 56, pf.Y, 0);
  // Platz
  wchar_t pfad[MAX_PATH * 2] = L"";
  if (pfad_feld) GetWindowTextW(pfad_feld, pfad, MAX_PATH * 2);
  wchar_t z1[80], z2[80];
  _snwprintf(z1, 80, L"%u MB", (unsigned)((roh_groesse + 1048575) / 1048576));
  uint64_t frei = frei_auf(pfad);
  if (frei >= 10ull * 1073741824ull) _snwprintf(z2, 80, L"%u GB", (unsigned)(frei / 1073741824ull));
  else _snwprintf(z2, 80, L"%.1f GB", frei / 1073741824.0);
  float x = 58;
  x += text(TX(L"Benötigt ", L"Needs "), klein, LEISE, x, 168);
  x += text(z1, kf, TEXTFARBE, x, 168) + 22;
  wchar_t lw[40];
  if (pfad[0] && pfad[1] == L':') _snwprintf(lw, 40, TX(L"Frei auf %lc: ", L"Free on %lc: "), towupper(pfad[0]));
  else wcscpy(lw, TX(L"Frei: ", L"Free: "));
  x += text(lw, klein, LEISE, x, 168);
  int knapp = frei && frei < roh_groesse + 50ull * 1048576ull;
  text(frei ? z2 : L"–", kf, knapp ? farbe(255, 255, 120, 90) : TEXTFARBE, x, 168);
  float y = 198;
  if (!portabel) {
    schalter_zeile(Z_STARTMENUE, y, TX(L"Eintrag im Startmenü", L"Start menu entry"), mit_startmenue, 0);
    schalter_zeile(Z_DESKTOP, y + 56, TX(L"Verknüpfung auf dem Desktop", L"Desktop shortcut"), mit_desktop, 1);
    y += 56 + 48 + 18;
  }
  Font t(fam_text, 12.5f, FontStyleRegular, UnitPixel);
  absatz(portabel ? TX(L"Ohne Verknüpfungen und ohne Eintrag unter „Apps“ – zum Entfernen genügt es, den Ordner zu löschen.", L"No shortcuts and no entry under “Apps” – to remove it, just delete the folder.")
                  : TX(L"Nur für dich, ohne Administratorrechte. Eine ältere Version am selben Ort wird ersetzt, deine Einstellungen bleiben erhalten.", L"Just for you, no administrator rights. An older version in the same place is replaced; your settings are kept."),
         t, LEISE, 58, y, BREITE - 116);
}

static void seite_installieren(float t) {
  Font h(fam_titel, 26, FontStyleRegular, UnitPixel), gross(fam_titel, 44, FontStyleRegular, UnitPixel), gp(fam_titel, 22, FontStyleRegular, UnitPixel);
  etikett(portabel ? TX(L"WIRD AUSGEPACKT", L"UNPACKING") : TX(L"WIRD INSTALLIERT", L"INSTALLING"), AKZENT, 56, 96);
  text(TX(L"Einen Moment, gleich spielt’s.", L"One moment – almost ready to play."), h, TEXTFARBE, 56, 118);
  wchar_t pz[8]; _snwprintf(pz, 8, L"%d", prozent);
  float pw = breite(L"%", gp);
  text(L"%", gp, LEISE, BREITE - 56, 125, 0, 2);
  text(pz, gross, TEXTFARBE, BREITE - 56 - pw - 2, 106, 0, 2);
  // Welle als Fortschritt
  const int n = 80;
  float bw = (BREITE - 112 - (n - 1) * 4.0f) / n, mitte = 214;
  int voll = (int)(n * prozent / 100.0f + 0.5f);
  for (int i = 0; i < n; i++) {
    float hh = 14 + 66 * fabsf(sinf(i * 0.37f)) * (0.5f + 0.5f * fabsf(sinf(i * 0.11f + 1.3f)));
    float x = 56 + i * (bw + 4);
    if (i < voll) {
      float m = animation ? 0.35f + 0.65f * (0.5f + 0.5f * sinf((t / 1.6f) * 6.2832f + (i % 16) * 0.39f)) : 1.0f;
      float a = hh * m;
      amber(RectF(x, mitte - a / 2, bw, a), bw / 2, 255, 1);
    } else {
      float a = hh * 0.6f;
      flaeche(RectF(x, mitte - a / 2, bw, a), bw / 2, farbe(36, 255, 236, 214));
    }
  }
  // Balken, Datei, Restzeit
  RectF spur(56, 284, BREITE - 112, 6);
  flaeche(spur, 3, farbe(26, 255, 236, 214));
  if (prozent > 0) {
    RectF voll_r(56, 284, (BREITE - 112) * prozent / 100.0f, 6);
    LinearGradientBrush lb(PointF(56, 0), PointF(BREITE - 56, 0), AMBER1, AMBER2);
    flaeche(voll_r, 3, lb);
  }
  Font k1(fam_mono, 12, FontStyleRegular, UnitPixel), k2(fam_text, 12, FontStyleRegular, UnitPixel);
  wchar_t d[300], rest[80] = L"";
  EnterCriticalSection(&datei_sperre);
  if (prozent >= 100) wcscpy(d, portabel ? TX(L"Fast fertig …", L"Almost done …") : TX(L"Verknüpfungen werden angelegt …", L"Creating shortcuts …"));
  else if (aktuelle_datei[0]) _snwprintf(d, 300, TX(L"Entpacke %ls", L"Unpacking %ls"), aktuelle_datei);
  else wcscpy(d, TX(L"Vorbereiten …", L"Preparing …"));
  LeaveCriticalSection(&datei_sperre);
  DWORD vergangen = GetTickCount() - inst_beginn;
  if (prozent >= 100) wcscpy(rest, TX(L"gleich fertig", L"almost done"));
  else if (prozent >= 4 && vergangen > 1500) {
    unsigned s = (unsigned)(vergangen / 1000.0 * (100 - prozent) / prozent + 0.5);
    _snwprintf(rest, 80, TX(L"noch ca. %u s", L"about %u s left"), s < 1 ? 1 : s);
  }
  float rw = text(rest, k2, LEISE, BREITE - 56, 300, 0, 2);
  text(d, k1, LEISE, 56, 300, BREITE - 112 - rw - 24);
}

static void seite_fertig(void) {
  // großer Haken mit Schein
  float cx = 56 + 85, cy = LEISTE + (FUSS - LEISTE) / 2.0f;
  {
    GraphicsPath p; p.AddEllipse(cx - 105, cy - 105, 210.0f, 210.0f);
    PathGradientBrush pg(&p);
    pg.SetCenterColor(farbe(82, 255, 150, 60));
    Color rr[1] = {farbe(0, 255, 150, 60)}; int n = 1; pg.SetSurroundColors(rr, &n);
    g->FillPath(&pg, &p);
  }
  if (erfolgreich) {
    RectF kreis(cx - 59, cy - 59, 118, 118);
    LinearGradientBrush lb(PointF(kreis.X, kreis.Y), PointF(kreis.X + 118, kreis.Y + 118), AMBER1, AMBER2);
    g->FillEllipse(&lb, kreis);
    Pen p(DUNKEL, 5); p.SetStartCap(LineCapRound); p.SetEndCap(LineCapRound); p.SetLineJoin(LineJoinRound);
    PointF pt[3] = {PointF(cx - 13, cy + 1.5f), PointF(cx - 4, cy + 10.5f), PointF(cx + 14, cy - 9.5f)};
    g->DrawLines(&p, pt, 3);
  }
  float x = 56 + 170 + 48, b = BREITE - 56 - x;
  Font h(fam_titel, 32, FontStyleRegular, UnitPixel), t(fam_text, 13.5f, FontStyleRegular, UnitPixel), nr(fam_titel, 11, FontStyleRegular, UnitPixel),
      kl(fam_text, 12.5f, FontStyleRegular, UnitPixel), fett(fam_fett, 13.5f, FontStyleRegular, UnitPixel);
  const wchar_t *s1, *s2, *s3;
#ifdef AW_SERVER
  if (portabel) {
    s1 = TX(L"Ordner öffnen und „Amberwave Server.exe“ starten", L"Open the folder and start “Amberwave Server.exe”");
    s2 = TX(L"Musikordner wählen – Amberwave liest ihn nur", L"Pick your music folder – Amberwave only reads it");
    s3 = TX(L"Im Browser einrichten – die Seite öffnet sich von selbst", L"Finish setup in the browser – the page opens by itself");
  } else {
    s1 = TX(L"Amberwave Server starten – das Symbol erscheint unten rechts im Infobereich", L"Start Amberwave Server – its icon appears in the notification area");
    s2 = TX(L"Musikordner wählen – Amberwave liest ihn nur", L"Pick your music folder – Amberwave only reads it");
    s3 = TX(L"Im Browser einrichten; die Firewall-Frage für private Netzwerke erlauben", L"Finish setup in the browser; allow the firewall prompt for private networks");
  }
#else
  if (portabel) {
    s1 = TX(L"Ordner öffnen und „Amberwave Client.exe“ starten", L"Open the folder and start “Amberwave Client.exe”");
    s2 = TX(L"Der Server im Heimnetz wird automatisch gesucht", L"Your server is found automatically on your home network");
    s3 = TX(L"Ausgabegerät wählen – WASAPI exklusiv für bitgenaue Wiedergabe", L"Pick an output device – WASAPI exclusive for bit-perfect playback");
  } else {
    s1 = TX(L"Amberwave starten – der Server im Heimnetz wird automatisch gesucht", L"Start Amberwave – your server is found automatically on your home network");
    s2 = TX(L"Mit deinem Amberwave-Konto anmelden", L"Sign in with your Amberwave account");
    s3 = TX(L"Ausgabegerät wählen – WASAPI exklusiv für bitgenaue Wiedergabe", L"Pick an output device – WASAPI exclusive for bit-perfect playback");
  }
#endif
  float hs = 0;
  const wchar_t *sch[3] = {s1, s2, s3};
  for (int i = 0; i < 3; i++) hs += hoehe(sch[i], t, b - 34) + 10;
  const wchar_t *unten = portabel ? ziel : TX(L"Deinstallieren jederzeit über Einstellungen › Apps", L"Uninstall any time under Settings › Apps");
  float gesamt = 12 + 10 + 36 + 16 + hs + 6 + 16;
  float y = cy - gesamt / 2;
  etikett(portabel ? TX(L"AUSGEPACKT", L"UNPACKED") : TX(L"INSTALLIERT", L"INSTALLED"), GRUEN, x, y);
  y += 22;
  text(TX(L"Amberwave ist bereit.", L"Amberwave is ready."), h, TEXTFARBE, x - 1, y);
  y += 36 + 16;
  for (int i = 0; i < 3; i++) {
    RectF kr(x, y - 2, 22, 22);
    rahmen(kr, 11, farbe(102, 255, 181, 71));
    wchar_t z[2] = {(wchar_t)(L'1' + i), 0};
    text(z, nr, AKZENT, kr.X + 11, kr.Y + 5, 0, 1);
    y += absatz(sch[i], t, WARM, x + 34, y, b - 34) + 10;
  }
  y += 6;
  text(unten, kl, LEISE, x, y, b);
}

static void dialog_malen(void) {
  if (!dlg) return;
  SolidBrush dunkel(farbe(150, 6, 4, 3));
  g->FillRectangle(&dunkel, RectF(0, LEISTE, BREITE, HOEHE - LEISTE));
  Font h(fam_titel, 19, FontStyleRegular, UnitPixel), t(fam_text, 13.5f, FontStyleRegular, UnitPixel);
  float b = 440, th = hoehe(dlg_text.c_str(), t, b - 56) * 1.1f;
  float hh = 26 + 26 + 12 + th + 24 + 40 + 22;
  RectF r((BREITE - b) / 2, LEISTE + (HOEHE - LEISTE - hh) / 2, b, hh);
  for (int i = 5; i >= 1; i--) flaeche(RectF(r.X - i * 2.0f, r.Y - i * 1.0f + 8, r.Width + i * 4.0f, r.Height + i * 2.0f), 16 + i * 2.0f, farbe(16, 0, 0, 0));
  flaeche(r, 16, farbe(255, 30, 22, 17)); rahmen(r, 16, farbe(36, 255, 236, 214));
  text(dlg_titel.c_str(), h, TEXTFARBE, r.X + 28, r.Y + 26);
  absatz(dlg_text.c_str(), t, WARM, r.X + 28, r.Y + 64, b - 56, 1.1f);
  float ky = r.Y + r.Height - 22 - 40;
  // im Dialog sind nur seine Knöpfe aktiv
  int alt = ueber; ueber = ueber == Z_DLG_JA || ueber == Z_DLG_NEIN ? ueber : 0;
  int d_alt = dlg; dlg = 0;
  float links = r.X + r.Width - 24;
  if (d_alt == D_INFO) knopf(Z_DLG_JA, L"OK", links, ky, 1);
  else if (d_alt == D_ABBRECHEN) {
    links = knopf(Z_DLG_NEIN, TX(L"Weiter installieren", L"Keep installing"), links, ky, 1) - 10;
    knopf(Z_DLG_JA, TX(L"Abbrechen", L"Cancel setup"), links, ky, 0);
  } else {
    links = knopf(Z_DLG_JA, TX(L"Unterordner nehmen", L"Use subfolder"), links, ky, 1) - 10;
    knopf(Z_DLG_NEIN, TX(L"Anderen wählen", L"Choose another"), links, ky, 0);
  }
  dlg = d_alt; ueber = alt;
}

static void malen(HDC dc) {
  RECT rc; GetClientRect(fenster, &rc);
  int w = rc.right, h = rc.bottom;
  HDC m = CreateCompatibleDC(dc);
  HBITMAP bm = CreateCompatibleBitmap(dc, w, h);
  HGDIOBJ alt = SelectObject(m, bm);
  {
    Graphics gr(m);
    g = &gr;
    gr.SetSmoothingMode(SmoothingModeAntiAlias);
    gr.SetPixelOffsetMode(PixelOffsetModeHalf);
    gr.SetTextRenderingHint(TextRenderingHintClearTypeGridFit);
    gr.SetCompositingQuality(CompositingQualityHighQuality);
    gr.ScaleTransform(k, k);
    ziele.clear();
    float t = (GetTickCount() - anim_beginn) / 1000.0f;
    // Hintergrund (Verläufe) zwischenspeichern – bei Animationen wird 30-mal in der Sekunde gezeichnet
    static Bitmap *hg_bild = NULL;
    static int hg_schluessel = -1;
    int schluessel = (seite == S_FERTIG) * 1000000 + w * 1000 + h;
    if (!hg_bild || hg_schluessel != schluessel) {
      delete hg_bild;
      hg_bild = new Bitmap(w, h, PixelFormat32bppPARGB);
      Graphics hb(hg_bild);
      hb.SetSmoothingMode(SmoothingModeAntiAlias);
      hb.ScaleTransform(k, k);
      g = &hb;
      hintergrund();
      g = &gr;
      hg_schluessel = schluessel;
    }
    gr.ResetTransform();
    gr.DrawImage(hg_bild, Rect(0, 0, w, h), 0, 0, w, h, UnitPixel);
    gr.ScaleTransform(k, k);
    titelleiste();
    switch (seite) {
      case S_WILLKOMMEN:
        seite_willkommen(t);
        fuss(0);
        { float l = knopf(Z_WEITER, TX(L"Los geht’s", L"Let’s go"), BREITE - 24, 422, 1); knopf(Z_ABBRECHEN, TX(L"Abbrechen", L"Cancel"), l - 12, 422, 0); }
        break;
      case S_LIZENZ:
        seite_lizenz();
        fuss(1);
        { float l = knopf(Z_WEITER, TX(L"Weiter", L"Next"), BREITE - 24, 422, 1, akzeptiert); knopf(Z_ZURUECK, TX(L"Zurück", L"Back"), l - 12, 422, 0); }
        break;
      case S_OPTIONEN:
        seite_optionen();
        fuss(2);
        { float l = knopf(Z_WEITER, portabel ? TX(L"Auspacken", L"Unpack") : TX(L"Installieren", L"Install"), BREITE - 24, 422, 1); knopf(Z_ZURUECK, TX(L"Zurück", L"Back"), l - 12, 422, 0); }
        break;
      case S_INSTALLIEREN:
        seite_installieren(t);
        fuss(3);
        break;
      case S_FERTIG:
        seite_fertig();
        fuss(4);
        if (portabel) { float l = knopf(Z_ORDNER, TX(L"Ordner öffnen", L"Open folder"), BREITE - 24, 422, 1); knopf(Z_ABBRECHEN, TX(L"Schließen", L"Close"), l - 12, 422, 0); }
        else { float l = knopf(Z_STARTEN, TX(L"Amberwave starten", L"Start Amberwave"), BREITE - 24, 422, 1, 1, 1); knopf(Z_ABBRECHEN, TX(L"Schließen", L"Close"), l - 12, 422, 0); }
        break;
    }
    dialog_malen();
    // feiner Rand ums Fenster
    Pen rand(farbe(31, 255, 236, 214), 1.0f);
    gr.ResetTransform();
    gr.DrawRectangle(&rand, 0.5f, 0.5f, w - 1.0f, h - 1.0f);
    g = NULL;
  }
  BitBlt(dc, 0, 0, w, h, m, 0, 0, SRCCOPY);
  SelectObject(m, alt); DeleteObject(bm); DeleteDC(m);
}

/* ---------- Ablauf ---------- */

static void pfad_feld_legen(void) {
  if (!pfad_feld) return;
  RectF r = pfad_rect();
  int fh = (int)(18 * k + 0.5f);
  SetWindowPos(pfad_feld, NULL, (int)((r.X + 38) * k), (int)((r.Y + r.Height / 2) * k) - fh / 2, (int)((r.Width - 50) * k), fh, SWP_NOZORDER | SWP_NOACTIVATE);
}

static void pfad_schrift_neu(void) {
  if (pfad_schrift) DeleteObject(pfad_schrift);
  pfad_schrift = CreateFontW(-(int)(12.5f * k + 0.5f), 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, FIXED_PITCH, L"Consolas");
  if (pfad_feld) SendMessageW(pfad_feld, WM_SETFONT, (WPARAM)pfad_schrift, TRUE);
}

static void timer_pruefen(void) {
  int braucht = animation && (seite == S_WILLKOMMEN || seite == S_INSTALLIEREN);
  if (braucht) SetTimer(fenster, 1, 33, NULL); else KillTimer(fenster, 1);
}

static DWORD seite_seit = 0;
static void seite_setzen(int neu) {
  if (neu != seite) seite_seit = GetTickCount();
  seite = neu;
  ShowWindow(pfad_feld, seite == S_OPTIONEN && !dlg ? SW_SHOW : SW_HIDE);
  if (seite == S_OPTIONEN && !dlg) SetFocus(pfad_feld); else SetFocus(fenster);
  ueber = Z_NICHTS;
  timer_pruefen();
  InvalidateRect(fenster, NULL, FALSE);
}

static void dialog(int art, const wchar_t *titel, const wchar_t *txt) {
  dlg = art; dlg_titel = titel; dlg_text = txt;
  ShowWindow(pfad_feld, SW_HIDE);
  SetFocus(fenster);
  ueber = Z_NICHTS;
  InvalidateRect(fenster, NULL, FALSE);
}

static void dialog_zu(void) {
  dlg = D_KEIN;
  seite_setzen(seite);
}

static void installation_starten(void) {
  prozent = 0; aktuelle_datei[0] = 0;
  inst_beginn = GetTickCount();
  laeuft = 1;
  seite_setzen(S_INSTALLIEREN);
  HANDLE th = CreateThread(NULL, 0, installieren, NULL, 0, NULL);
  if (th) CloseHandle(th); else PostMessageW(fenster, WM_FERTIG, 0, 0);
}

static wchar_t gewaehlt[MAX_PATH * 2];

/** 1 = Ziel in Ordnung (in gewaehlt), 0 = Meldung gezeigt; Dialog D_UNTERORDNER fragt nach dem Unterordner */
static int ziel_pruefen(void) {
  wchar_t p[MAX_PATH * 2];
  GetWindowTextW(pfad_feld, p, MAX_PATH * 2);
  size_t n = wcslen(p);
  while (n && (p[n - 1] == L' ' || p[n - 1] == L'\\')) p[--n] = 0;
  wchar_t *a = p; while (*a == L' ') a++;
  int unc = a[0] == L'\\' && a[1] == L'\\' && *hinter_wurzel(a);
  if (!unc && (wcslen(a) < 4 || a[1] != L':' || a[2] != L'\\')) {
    dialog(D_INFO, TX(L"Ordner unvollständig", L"Incomplete folder"), TX(L"Bitte einen vollständigen Ordner angeben, z. B. C:\\Users\\Name\\AppData\\Local\\Programs\\Amberwave.", L"Please enter a full folder path, e.g. C:\\Users\\Name\\AppData\\Local\\Programs\\Amberwave."));
    return 0;
  }
  wcsncpy(gewaehlt, a, MAX_PATH * 2 - 1);
  DWORD at = GetFileAttributesW(a);
  if (at != INVALID_FILE_ATTRIBUTES && !(at & FILE_ATTRIBUTE_DIRECTORY)) {
    dialog(D_INFO, TX(L"Das ist eine Datei", L"That's a file"), TX(L"An diesem Ort liegt eine Datei, kein Ordner. Bitte einen Ordner angeben.", L"There is a file at that location, not a folder. Please enter a folder."));
    return 0;
  }
  // Sicherung: einen vorhandenen Ordner nur ersetzen, wenn darin Amberwave liegt – oder wenn er leer ist
  if (GetFileAttributesW(a) != INVALID_FILE_ATTRIBUTES && !datei_da(a, PROGRAMM) && !ordner_leer(a)) {
    wchar_t m[MAX_PATH * 2 + 300];
    _snwprintf(m, MAX_PATH * 2 + 300, TX(L"In %ls liegen schon andere Dateien. Amberwave braucht einen eigenen Ordner – soll stattdessen der Unterordner „Amberwave“ verwendet werden?", L"%ls already contains other files. Amberwave needs a folder of its own – use the subfolder “Amberwave” instead?"), a);
    dialog(D_UNTERORDNER, TX(L"Ordner ist nicht leer", L"Folder isn't empty"), m);
    return 0;
  }
  return 1;
}

static void durchsuchen(void) {
  IFileOpenDialog *d = NULL;
  if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, NULL, CLSCTX_INPROC_SERVER, IID_IFileOpenDialog, (void **)&d))) return;
  DWORD o = 0; d->GetOptions(&o);
  d->SetOptions(o | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
  d->SetTitle(TX(L"Ordner für Amberwave wählen", L"Choose a folder for Amberwave"));
  if (SUCCEEDED(d->Show(fenster))) {
    IShellItem *it = NULL;
    if (SUCCEEDED(d->GetResult(&it))) {
      PWSTR s = NULL;
      if (SUCCEEDED(it->GetDisplayName(SIGDN_FILESYSPATH, &s))) {
        wchar_t p[MAX_PATH * 2];
        wcsncpy(p, s, MAX_PATH * 2 - 12); p[MAX_PATH * 2 - 12] = 0;
        size_t n = wcslen(p);
        if (n && p[n - 1] == L'\\') p[n - 1] = 0;
        const wchar_t *letzter = wcsrchr(p, L'\\');
        if (!letzter || _wcsicmp(letzter + 1, L"Amberwave")) wcsncat(p, L"\\Amberwave", MAX_PATH * 2 - wcslen(p) - 1);
        SetWindowTextW(pfad_feld, p);
        CoTaskMemFree(s);
      }
      it->Release();
    }
  }
  d->Release();
}

static void abbrechen_fragen(void) {
  if (laeuft || dlg) return;
  if (seite == S_FERTIG) { DestroyWindow(fenster); return; }
  dialog(D_ABBRECHEN, TX(L"Installation abbrechen?", L"Cancel setup?"), TX(L"Amberwave wird dann nicht installiert. Du kannst das Paket später jederzeit wieder starten.", L"Amberwave won't be installed. You can run the package again any time."));
}

static void amberwave_starten(void) {
  wchar_t exe[MAX_PATH * 2]; _snwprintf(exe, MAX_PATH * 2, L"%ls\\" PROGRAMM, ziel);
  ShellExecuteW(NULL, L"open", exe, NULL, ziel, SW_SHOWNORMAL);
}

static void weiter(void) {
  if (seite == S_WILLKOMMEN) seite_setzen(S_LIZENZ);
  else if (seite == S_LIZENZ && akzeptiert) seite_setzen(S_OPTIONEN);
  else if (seite == S_OPTIONEN && ziel_pruefen()) { wcsncpy(ziel, gewaehlt, MAX_PATH * 2 - 1); installation_starten(); }
  else if (seite == S_FERTIG) {
    if (portabel) ShellExecuteW(NULL, L"open", ziel, NULL, NULL, SW_SHOWNORMAL);
    else amberwave_starten();
    DestroyWindow(fenster);
  }
}

static void klick(int id) {
  if (dlg) {
    int art = dlg;
    if (id == Z_DLG_JA) {
      dialog_zu();
      if (art == D_ABBRECHEN) DestroyWindow(fenster);
      else if (art == D_UNTERORDNER) {
        wchar_t p[MAX_PATH * 2];
        _snwprintf(p, MAX_PATH * 2, L"%ls\\Amberwave", gewaehlt);
        SetWindowTextW(pfad_feld, p);
        if (GetFileAttributesW(p) != INVALID_FILE_ATTRIBUTES && !datei_da(p, PROGRAMM) && !ordner_leer(p))
          dialog(D_INFO, TX(L"Auch nicht leer", L"Not empty either"), TX(L"Auch dieser Ordner ist nicht leer. Bitte einen anderen wählen.", L"That folder isn't empty either. Please choose another one."));
        else { wcsncpy(ziel, p, MAX_PATH * 2 - 1); installation_starten(); }
      }
    } else if (id == Z_DLG_NEIN) dialog_zu();
    return;
  }
  switch (id) {
    case Z_MIN: ShowWindow(fenster, SW_MINIMIZE); break;
    case Z_ZU: case Z_ABBRECHEN: abbrechen_fragen(); break;
    case Z_WEITER: case Z_STARTEN: case Z_ORDNER: if (GetTickCount() - seite_seit >= GetDoubleClickTime()) weiter(); break;
    case Z_ZURUECK: if (!laeuft && seite > S_WILLKOMMEN && seite < S_INSTALLIEREN) seite_setzen(seite - 1); break;
    case Z_HAKEN: akzeptiert = !akzeptiert; break;
    case Z_DE: liz_deutsch = 1; break;
    case Z_EN: liz_deutsch = 0; break;
    case Z_SUCHEN: durchsuchen(); break;
    case Z_STARTMENUE: mit_startmenue = !mit_startmenue; break;
    case Z_DESKTOP: mit_desktop = !mit_desktop; break;
  }
  InvalidateRect(fenster, NULL, FALSE);
}

static int treffer(LPARAM l, int nur_aktiv = 1) {
  float x = (short)LOWORD(l) / k, y = (short)HIWORD(l) / k;
  for (int i = (int)ziele.size() - 1; i >= 0; i--) {
    const Ziel &z = ziele[i];
    if (x >= z.r.X && x < z.r.X + z.r.Width && y >= z.r.Y && y < z.r.Y + z.r.Height) {
      if (dlg && z.id != Z_DLG_JA && z.id != Z_DLG_NEIN) return Z_NICHTS;
      if (nur_aktiv && !z.aktiv) return Z_NICHTS;
      return z.id;
    }
  }
  return Z_NICHTS;
}

static void tasten(WPARAM w) {
  if (w == VK_ESCAPE) { if (dlg) klick(dlg == D_INFO ? Z_DLG_JA : Z_DLG_NEIN); else abbrechen_fragen(); }
  else if (w == VK_RETURN) { if (dlg) klick(dlg == D_ABBRECHEN ? Z_DLG_NEIN : Z_DLG_JA); else if (!laeuft) weiter(); }
  else if (seite == S_LIZENZ && !dlg) {
    if (w == VK_SPACE) { akzeptiert = !akzeptiert; InvalidateRect(fenster, NULL, FALSE); }
    else if (w == VK_DOWN) liz_scrollen(LIZ_ZH * 2);
    else if (w == VK_UP) liz_scrollen(-LIZ_ZH * 2);
    else if (w == VK_NEXT) liz_scrollen(liz_box.Height - LIZ_ZH);
    else if (w == VK_PRIOR) liz_scrollen(-(liz_box.Height - LIZ_ZH));
    else if (w == VK_HOME) liz_scrollen(-1e9f);
    else if (w == VK_END) liz_scrollen(1e9f);
  }
}

static LRESULT CALLBACK fensterproc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
    case WM_PAINT: {
      PAINTSTRUCT ps; HDC dc = BeginPaint(h, &ps);
      malen(dc);
      EndPaint(h, &ps);
      return 0;
    }
    case WM_ERASEBKGND: return 1;
    case WM_TIMER: InvalidateRect(h, NULL, FALSE); return 0;
    case WM_NCHITTEST: {
      POINT p = {(short)LOWORD(l), (short)HIWORD(l)};
      ScreenToClient(h, &p);
      float y = p.y / k, x = p.x / k;
      if (y < LEISTE && x < BREITE - 8 - 34 - 34 - 2) return HTCAPTION;
      return HTCLIENT;
    }
    case WM_SETCURSOR:
      if (LOWORD(l) == HTCLIENT && ueber != Z_NICHTS) { SetCursor(LoadCursor(NULL, IDC_HAND)); return TRUE; }
      break;
    case WM_MOUSEMOVE: {
      if (gedrueckt == Z_LIZ_DAUMEN) {
        float y = (short)HIWORD(l) / k, mx = liz_max();
        float spur = liz_box.Height - 16, dh = spur * liz_box.Height / (liz_box.Height + mx); if (dh < 30) dh = 30;
        if (spur > dh) { liz_pos = ziehen_pos0 + (y - ziehen_y0) * mx / (spur - dh); liz_scrollen(0); }
        return 0;
      }
      int z = treffer(l);
      if (z != ueber) { ueber = z; InvalidateRect(h, NULL, FALSE); }
      TRACKMOUSEEVENT tm = {sizeof tm, TME_LEAVE, h, 0};
      TrackMouseEvent(&tm);
      return 0;
    }
    case WM_MOUSELEAVE: if (ueber) { ueber = Z_NICHTS; InvalidateRect(h, NULL, FALSE); } return 0;
    case WM_LBUTTONDOWN: {
      int z = treffer(l);
      gedrueckt = z;
      if (z == Z_LIZ_DAUMEN) { ziehen_y0 = (short)HIWORD(l) / k; ziehen_pos0 = liz_pos; }
      else if (z == Z_LIZ_SPUR) {
        float y = (short)HIWORD(l) / k, mx = liz_max();
        float anteil = (y - liz_box.Y - 8) / (liz_box.Height - 16);
        liz_pos = anteil * mx; liz_scrollen(0); gedrueckt = Z_NICHTS;
      }
      if (gedrueckt) SetCapture(h);
      if (seite == S_OPTIONEN && GetFocus() == pfad_feld) { SetFocus(h); }
      InvalidateRect(h, NULL, FALSE);
      return 0;
    }
    case WM_LBUTTONUP: {
      int war = gedrueckt;
      gedrueckt = Z_NICHTS;
      ReleaseCapture();
      if (war && war != Z_LIZ_DAUMEN && treffer(l) == war) klick(war);
      InvalidateRect(h, NULL, FALSE);
      return 0;
    }
    case WM_CAPTURECHANGED:
    case WM_CANCELMODE:
      if (gedrueckt) { gedrueckt = Z_NICHTS; InvalidateRect(h, NULL, FALSE); }
      break;
    case WM_MOUSEWHEEL:
      if (seite == S_LIZENZ && !dlg) liz_scrollen(-(short)HIWORD(w) / 120.0f * LIZ_ZH * 3);
      return 0;
    case WM_COMMAND:
      if ((HWND)l == pfad_feld && HIWORD(w) == EN_CHANGE) InvalidateRect(h, NULL, FALSE);
      if ((HWND)l == pfad_feld && (HIWORD(w) == EN_SETFOCUS || HIWORD(w) == EN_KILLFOCUS)) InvalidateRect(h, NULL, FALSE);
      return 0;
    case WM_CTLCOLOREDIT: {
      HDC dc = (HDC)w;
      SetTextColor(dc, RGB(233, 221, 208));
      SetBkColor(dc, RGB(13, 9, 7));
      return (LRESULT)pfad_pinsel;
    }
    case WM_STAND: if ((int)w != prozent) { prozent = (int)w; if (!animation) InvalidateRect(h, NULL, FALSE); } return 0;
    case WM_FERTIG: {
      laeuft = 0;
      if (w) { erfolgreich = 1; prozent = 100; seite_setzen(S_FERTIG); }
      else {
        seite_setzen(S_OPTIONEN);
        dialog(D_INFO, TX(L"Das hat nicht geklappt", L"That didn't work"), fehler[0] ? fehler : TX(L"Die Installation ist fehlgeschlagen.", L"Setup failed."));
      }
      return 0;
    }
    case WM_DPICHANGED: {
      k = HIWORD(w) / 96.0f;
      RECT *r = (RECT *)l;
      SetWindowPos(h, NULL, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE);
      pfad_schrift_neu(); pfad_feld_legen();
      InvalidateRect(h, NULL, FALSE);
      return 0;
    }
    case WM_CLOSE: abbrechen_fragen(); return 0;
    case WM_DESTROY: PostQuitMessage(0); return 0;
  }
  return DefWindowProcW(h, m, w, l);
}

int WINAPI wWinMain(HINSTANCE hi, HINSTANCE, PWSTR cmd, int) {
  inst = hi;
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX);   // keine „Kein Datenträger“-Meldungen beim Prüfen von Pfaden
  portabel = cmd && (wcsstr(cmd, L"/portabel") || wcsstr(cmd, L"/portable"));
  InitializeCriticalSection(&datei_sperre);
  wchar_t selbst[MAX_PATH * 2];
  GetModuleFileNameW(NULL, selbst, MAX_PATH * 2);
  quelle = CreateFileW(selbst, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
  if (quelle == INVALID_HANDLE_VALUE) { MessageBoxW(NULL, TX(L"Das Paket lässt sich nicht lesen.", L"The package cannot be read."), TITEL, MB_OK | MB_ICONERROR); return 1; }
  LARGE_INTEGER groesse; GetFileSizeEx(quelle, &groesse);
  uint8_t anhang[32]; DWORD n = 0;
  LARGE_INTEGER p; p.QuadPart = groesse.QuadPart - 32;
  SetFilePointerEx(quelle, p, NULL, FILE_BEGIN);
  if (!ReadFile(quelle, anhang, 32, &n, NULL) || n != 32 || memcmp(anhang + 24, "AWSFX002", 8)) {
    MessageBoxW(NULL, TX(L"Das Paket ist beschädigt. Bitte noch einmal herunterladen.", L"The package is damaged. Please download it again."), TITEL, MB_OK | MB_ICONERROR);
    return 1;
  }
  memcpy(&xz_beginn, anhang, 8); memcpy(&xz_laenge, anhang + 8, 8); memcpy(&roh_groesse, anhang + 16, 8);

  // Ziel: vorhandene Installation – sonst %LOCALAPPDATA%\Programs\Amberwave; portabel: Ordner neben dem Paket
  wchar_t lokal[MAX_PATH];
  if (portabel) {
    wcscpy(ziel, selbst);
    wchar_t *schnitt = wcsrchr(ziel, L'\\');
    if (schnitt) *schnitt = 0;
    wcsncat(ziel, L"\\" ORDNER, MAX_PATH * 2 - wcslen(ziel) - 1);
  } else {
    if (SUCCEEDED(SHGetFolderPathW(NULL, CSIDL_LOCAL_APPDATA, NULL, 0, lokal))) _snwprintf(ziel, MAX_PATH * 2, L"%ls" STANDARD_UNTERORDNER, lokal);
    vorhandene_lesen(ziel, sizeof ziel);
  }

  CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
  GdiplusStartupInput gsi; ULONG_PTR gtoken;
  GdiplusStartup(&gtoken, &gsi, NULL);
  schriften_laden();
  formate();
  liz_text[0] = utf8_text(RES_LIZENZ_EN);
  liz_text[1] = utf8_text(RES_LIZENZ_DE);
  if (liz_text[0].empty()) liz_text[0] = L"GNU Affero General Public License v3.0 – https://www.gnu.org/licenses/agpl-3.0.txt";
  if (liz_text[1].empty()) liz_text[1] = liz_text[0];
  liz_deutsch = !englisch();
  BOOL anim = TRUE; SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &anim, 0);
  animation = anim ? 1 : 0;
  anim_beginn = GetTickCount();

  // DPI des Bildschirms, auf dem das Fenster erscheint (Manifest: PerMonitorV2)
  UINT dpi = 96;
  HMODULE u32 = GetModuleHandleW(L"user32.dll");
  typedef UINT(WINAPI * DpiFn)(void);
  DpiFn fdpi = u32 ? (DpiFn)(void *)GetProcAddress(u32, "GetDpiForSystem") : NULL;
  if (fdpi) dpi = fdpi(); else { HDC sdc = GetDC(NULL); if (sdc) { dpi = GetDeviceCaps(sdc, LOGPIXELSX); ReleaseDC(NULL, sdc); } }
  k = dpi / 96.0f;

  INITCOMMONCONTROLSEX icc = {sizeof icc, ICC_STANDARD_CLASSES};
  InitCommonControlsEx(&icc);
  pfad_pinsel = CreateSolidBrush(RGB(13, 9, 7));

  WNDCLASSW wc = {};
  wc.style = CS_DROPSHADOW;
  wc.lpfnWndProc = fensterproc; wc.hInstance = inst; wc.lpszClassName = L"AmberwaveSetup";
  wc.hCursor = LoadCursor(NULL, IDC_ARROW);
  wc.hIcon = LoadIconW(inst, MAKEINTRESOURCEW(1));
  RegisterClassW(&wc);
  int fb = (int)(BREITE * k + 0.5f), fh = (int)(HOEHE * k + 0.5f);
  RECT arbeit; SystemParametersInfoW(SPI_GETWORKAREA, 0, &arbeit, 0);
  wchar_t titel[128];
  _snwprintf(titel, 128, L"%ls %ls – %ls", TITEL, AW_VERSION, portabel ? TX(L"Auspacken", L"Unpack") : TX(L"Installation", L"Setup"));
  fenster = CreateWindowExW(WS_EX_APPWINDOW, wc.lpszClassName, titel, WS_POPUP | WS_SYSMENU | WS_MINIMIZEBOX | WS_CLIPCHILDREN,
                            arbeit.left + (arbeit.right - arbeit.left - fb) / 2, arbeit.top + (arbeit.bottom - arbeit.top - fh) / 2, fb, fh, NULL, NULL, inst, NULL);
  // tatsächliche DPI des Bildschirms, auf dem das Fenster liegt
  typedef UINT(WINAPI * DpiFensterFn)(HWND);
  DpiFensterFn fdw = u32 ? (DpiFensterFn)(void *)GetProcAddress(u32, "GetDpiForWindow") : NULL;
  if (fdw) {
    UINT d2 = fdw(fenster);
    if (d2 && d2 != dpi) {
      k = d2 / 96.0f;
      HMONITOR mon = MonitorFromWindow(fenster, MONITOR_DEFAULTTONEAREST);
      MONITORINFO mi = {sizeof mi}; GetMonitorInfoW(mon, &mi);
      fb = (int)(BREITE * k + 0.5f); fh = (int)(HOEHE * k + 0.5f);
      SetWindowPos(fenster, NULL, mi.rcWork.left + (mi.rcWork.right - mi.rcWork.left - fb) / 2, mi.rcWork.top + (mi.rcWork.bottom - mi.rcWork.top - fh) / 2, fb, fh, SWP_NOZORDER | SWP_NOACTIVATE);
    }
  }
  // Windows 11: runde Ecken
  DWORD ecken = 2; DwmSetWindowAttribute(fenster, 33 /* DWMWA_WINDOW_CORNER_PREFERENCE */, &ecken, sizeof ecken);
  BOOL dunkel = TRUE; DwmSetWindowAttribute(fenster, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, &dunkel, sizeof dunkel);

  pfad_feld = CreateWindowExW(0, L"EDIT", ziel, WS_CHILD | ES_AUTOHSCROLL | WS_TABSTOP, 0, 0, 10, 10, fenster, NULL, inst, NULL);
  pfad_schrift_neu();
  pfad_feld_legen();
  seite_setzen(S_WILLKOMMEN);
  ShowWindow(fenster, SW_SHOW);
  UpdateWindow(fenster);
  MSG m;
  while (GetMessageW(&m, NULL, 0, 0) > 0) {
    if (m.message == WM_KEYDOWN && m.wParam == VK_RETURN && (m.lParam & (1 << 30))) continue;   // gehaltenes Enter springt nicht durch alle Seiten
    if (m.message == WM_KEYDOWN && (m.wParam == VK_RETURN || m.wParam == VK_ESCAPE || (m.hwnd == fenster))) { tasten(m.wParam); if (m.hwnd != pfad_feld || m.wParam == VK_RETURN || m.wParam == VK_ESCAPE) continue; }
    TranslateMessage(&m); DispatchMessageW(&m);
  }
  CloseHandle(quelle);
  GdiplusShutdown(gtoken);
  return 0;
}
