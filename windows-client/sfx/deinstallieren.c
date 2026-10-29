// „Amberwave deinstallieren.exe“ – liegt im Programmordner (%LOCALAPPDATA%\Programs\Amberwave) und wird über
// Einstellungen → Apps aufgerufen. Entfernt Programmordner, Startmenü-Eintrag und den Eintrag unter „Apps“.
// Die Einstellungen in %APPDATA%\amberwave-client bleiben, außer man wählt „Auch Einstellungen löschen“.
//
// Ein laufendes Programm kann seinen eigenen Ordner nicht löschen: Der erste Aufruf kopiert sich nach %TEMP% und startet
// die Kopie mit /weiter "<Ordner>"; die Kopie räumt auf und lässt sich danach von cmd.exe löschen.
#define WIN32_LEAN_AND_MEAN
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <wchar.h>

#define TITEL L"Amberwave Windows Client"
#define UNINSTALL_SCHLUESSEL L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AmberwaveClient"

static int englisch(void) { return (GetUserDefaultUILanguage() & 0x3ff) != LANG_GERMAN; }
#define TX(de, en) (englisch() ? (en) : (de))

static int baum_loeschen(const wchar_t *pfad) {
  if (GetFileAttributesW(pfad) == INVALID_FILE_ATTRIBUTES) return 1;
  wchar_t doppelt[MAX_PATH * 2 + 2] = {0};
  wcsncpy(doppelt, pfad, MAX_PATH * 2);
  SHFILEOPSTRUCTW op = {0};
  op.wFunc = FO_DELETE; op.pFrom = doppelt; op.fFlags = FOF_NO_UI;
  return SHFileOperationW(&op) == 0;
}

/* Ist Amberwave noch offen? Dann lässt sich der Ordner nicht umbenennen. */
static int laeuft_noch(const wchar_t *ordner) {
  wchar_t probe[MAX_PATH * 2];
  _snwprintf(probe, MAX_PATH * 2, L"%ls.pruefen", ordner);
  if (!MoveFileW(ordner, probe)) return 1;
  MoveFileW(probe, ordner);
  return 0;
}

static void zweiter_schritt(const wchar_t *ordner) {
  // Sicherung: nur einen Ordner löschen, in dem wirklich Amberwave liegt
  wchar_t pruef[MAX_PATH * 2];
  _snwprintf(pruef, MAX_PATH * 2, L"%ls\\Amberwave Client.exe", ordner);
  if (GetFileAttributesW(pruef) == INVALID_FILE_ATTRIBUTES) {
    MessageBoxW(NULL, TX(L"In diesem Ordner ist kein Amberwave installiert – es wird nichts gelöscht.",
                         L"Amberwave is not installed in this folder – nothing is deleted."), TITEL, MB_OK | MB_ICONWARNING);
    return;
  }
  if (laeuft_noch(ordner)) {
    MessageBoxW(NULL, TX(L"Amberwave läuft noch. Bitte Amberwave schließen und noch einmal deinstallieren.",
                         L"Amberwave is still running. Please close Amberwave and uninstall again."), TITEL, MB_OK | MB_ICONWARNING);
    return;
  }
  int r = MessageBoxW(NULL, TX(L"Amberwave Windows Client deinstallieren?\n\nAuch deine Einstellungen (Server, Ausgabe, VST-Plug-ins) löschen?\nJa = alles löschen · Nein = Einstellungen behalten",
                               L"Uninstall Amberwave Windows Client?\n\nAlso delete your settings (server, output, VST plug-ins)?\nYes = delete everything · No = keep settings"),
                      TITEL, MB_YESNOCANCEL | MB_ICONQUESTION | MB_DEFBUTTON2);
  if (r == IDCANCEL) return;
  baum_loeschen(ordner);
  wchar_t lnk[MAX_PATH * 2];
  int orte[] = {CSIDL_PROGRAMS, CSIDL_DESKTOPDIRECTORY};
  for (int i = 0; i < 2; i++) {
    if (SUCCEEDED(SHGetFolderPathW(NULL, orte[i], NULL, 0, lnk))) {
      wcsncat(lnk, L"\\Amberwave.lnk", MAX_PATH * 2 - wcslen(lnk) - 1);
      DeleteFileW(lnk);
    }
  }
  RegDeleteKeyW(HKEY_CURRENT_USER, UNINSTALL_SCHLUESSEL);
  if (r == IDYES) {
    wchar_t daten[MAX_PATH * 2];
    if (SUCCEEDED(SHGetFolderPathW(NULL, CSIDL_APPDATA, NULL, 0, daten))) {
      wcsncat(daten, L"\\amberwave-client", MAX_PATH * 2 - wcslen(daten) - 1);
      baum_loeschen(daten);
    }
  }
  MessageBoxW(NULL, TX(L"Amberwave wurde deinstalliert.", L"Amberwave has been uninstalled."), TITEL, MB_OK | MB_ICONINFORMATION);
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE vorher, PWSTR cmd, int zeigen) {
  (void)inst; (void)vorher; (void)zeigen;
  wchar_t selbst[MAX_PATH * 2];
  GetModuleFileNameW(NULL, selbst, MAX_PATH * 2);
  int argc = 0;
  wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (argv && argc >= 3 && !wcscmp(argv[1], L"/weiter")) {
    // Kopie aus %TEMP%: aufräumen, dann sich selbst löschen lassen
    zweiter_schritt(argv[2]);
    wchar_t befehl[MAX_PATH * 3];
    _snwprintf(befehl, MAX_PATH * 3, L"/c ping -n 3 127.0.0.1 >nul & del /f /q \"%ls\"", selbst);
    ShellExecuteW(NULL, L"open", L"cmd.exe", befehl, NULL, SW_HIDE);
    LocalFree(argv);
    return 0;
  }
  (void)cmd;
  // erster Aufruf aus dem Programmordner: Ordner merken, Kopie nach %TEMP% starten
  wchar_t ordner[MAX_PATH * 2];
  wcscpy(ordner, selbst);
  wchar_t *schnitt = wcsrchr(ordner, L'\\');
  if (schnitt) *schnitt = 0;
  wchar_t temp[MAX_PATH], kopie[MAX_PATH * 2], param[MAX_PATH * 2 + 16];
  GetTempPathW(MAX_PATH, temp);
  _snwprintf(kopie, MAX_PATH * 2, L"%lsamberwave-deinstallieren-%lu.exe", temp, GetTickCount());
  if (!CopyFileW(selbst, kopie, FALSE)) {
    MessageBoxW(NULL, TX(L"Die Deinstallation ließ sich nicht starten.", L"Could not start the uninstaller."), TITEL, MB_OK | MB_ICONERROR);
    return 1;
  }
  _snwprintf(param, MAX_PATH * 2 + 16, L"/weiter \"%ls\"", ordner);
  ShellExecuteW(NULL, L"open", kopie, param, temp, SW_SHOWNORMAL);
  if (argv) LocalFree(argv);
  return 0;
}
