// Amberwave VST3-Host (ein Prozess je Plug-in, damit ein abstürzendes Plug-in nur sich selbst mitnimmt).
// Stufe 1: Logger mit Absturzbericht, Scanner (--scan), Probelauf mit Rauschen (--probe) und Editor-Fenster (--editor).
// Nur Effekt-Plug-ins, Stereo, Float32. Das VST3-SDK (MIT) liefert die Schnittstellen (pluginterfaces); Laden, Host-Objekte,
// Fenster und Audiolauf sind eigener Code.
//
//   amberwave-vsthost --scan  <datei.vst3>                     eine JSON-Zeile je Klasse
//   amberwave-vsthost --probe <datei.vst3> <klasse> [sekunden] Rauschen durchschicken, Pegel/Latenz/Parameter melden
//   amberwave-vsthost --editor <datei.vst3> <klasse> [sekunden] Plug-in-Oberfläche in eigenem Fenster
// Alle Meldungen an die App gehen als JSON-Zeilen auf stdout; das Log liegt in %APPDATA%\amberwave-client\log\vsthost.log
// (oder AW_LOGDIR).
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <objbase.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <string>
#include <vector>
#include <map>
#include <atomic>
#include <mutex>
#include "vstshm.h"

#include "pluginterfaces/base/ipluginbase.h"
#include "pluginterfaces/base/ibstream.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/gui/iplugviewcontentscalesupport.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivsthostapplication.h"
#include "pluginterfaces/vst/ivstmessage.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "pluginterfaces/vst/ivstpluginterfacesupport.h"
#include "pluginterfaces/vst/vstspeaker.h"

using namespace Steinberg;

/* ====================================================================== Log ====================================================================== */

static FILE *gLog;
static CRITICAL_SECTION gOutCs;
static CRITICAL_SECTION gLogCs;
static char gSchritt[256] = "Start";   // wo wir gerade sind – steht im Absturzbericht
static char gPlugin[256] = "";

static void logOeffnen() {
  InitializeCriticalSection(&gLogCs);
  InitializeCriticalSection(&gOutCs);
  char dir[MAX_PATH] = "";
  DWORD n = GetEnvironmentVariableA("AW_LOGDIR", dir, sizeof dir);
  if (!n || n >= sizeof dir) {
    char app[MAX_PATH] = "";
    n = GetEnvironmentVariableA("APPDATA", app, sizeof app);
    if (n && n < sizeof app) snprintf(dir, sizeof dir, "%s\\amberwave-client\\log", app);
    else snprintf(dir, sizeof dir, ".");
  }
  // Ordner anlegen (zwei Ebenen)
  std::string d = dir;
  for (size_t i = 3; i < d.size(); i++) if (d[i] == '\\' || d[i] == '/') CreateDirectoryA(d.substr(0, i).c_str(), nullptr);
  CreateDirectoryA(dir, nullptr);
  char pfad[MAX_PATH + 32];
  snprintf(pfad, sizeof pfad, "%s\\vsthost.log", dir);
  WIN32_FILE_ATTRIBUTE_DATA fa;
  if (GetFileAttributesExA(pfad, GetFileExInfoStandard, &fa) && fa.nFileSizeLow > 3u * 1024 * 1024) {   // grob drehen: alt → .1
    char alt[MAX_PATH + 32]; snprintf(alt, sizeof alt, "%s\\vsthost.1.log", dir);
    DeleteFileA(alt); MoveFileA(pfad, alt);
  }
  gLog = fopen(pfad, "ab");
}

static void L(const char *fmt, ...) {
  char t[2048];
  va_list ap; va_start(ap, fmt); vsnprintf(t, sizeof t, fmt, ap); va_end(ap);
  SYSTEMTIME st; GetLocalTime(&st);
  EnterCriticalSection(&gLogCs);
  if (gLog) {
    fprintf(gLog, "%04d-%02d-%02d %02d:%02d:%02d.%03d [%lu:%lu] %s\n", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds,
            GetCurrentProcessId(), GetCurrentThreadId(), t);
    fflush(gLog);
  }
  LeaveCriticalSection(&gLogCs);
}
static void schritt(const char *fmt, ...) {
  va_list ap; va_start(ap, fmt); vsnprintf(gSchritt, sizeof gSchritt, fmt, ap); va_end(ap);
  L("· %s", gSchritt);
}

static std::string jsonText(const std::string &s) {
  std::string o;
  for (unsigned char c : s) {
    if (c == '"') o += "\\\""; else if (c == '\\') o += "\\\\"; else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; } else o += (char)c;
  }
  return o;
}
static void melden(const std::string &json) {   // direkt aufs Pipe-Handle (der Host ist ein Windows-Programm ohne Konsole)
  std::string z = json + "\n";
  EnterCriticalSection(&gOutCs);
  HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
  if (h && h != INVALID_HANDLE_VALUE) { DWORD w; WriteFile(h, z.data(), (DWORD)z.size(), &w, nullptr); }
  LeaveCriticalSection(&gOutCs);
}

static std::string utf8(const char16_t *w) {
  if (!w || !*w) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, (const wchar_t *)w, -1, nullptr, 0, nullptr, nullptr);
  if (n <= 1) return "";
  std::string s((size_t)n - 1, 0);
  WideCharToMultiByte(CP_UTF8, 0, (const wchar_t *)w, -1, &s[0], n, nullptr, nullptr);
  return s;
}
static std::wstring wide(const char *u) {
  int n = MultiByteToWideChar(CP_UTF8, 0, u, -1, nullptr, 0);
  if (n <= 1) return L"";
  std::wstring w((size_t)n - 1, 0);
  MultiByteToWideChar(CP_UTF8, 0, u, -1, &w[0], n);
  return w;
}

static std::string cidHex(const char *tuid) {
  std::string s; char b[4];
  for (int i = 0; i < 16; i++) { snprintf(b, sizeof b, "%02X", (unsigned char)tuid[i]); s += b; }
  return s;
}
static bool cidLesen(const char *hex, TUID out) {
  if (!hex || strlen(hex) != 32) return false;
  for (int i = 0; i < 16; i++) { char b[3] = { hex[i * 2], hex[i * 2 + 1], 0 }; char *e; long v = strtol(b, &e, 16); if (*e) return false; out[i] = (char)v; }
  return true;
}
static bool gleich(const TUID a, const TUID b) { return memcmp(a, b, 16) == 0; }

/** Absturzbericht: Ausnahme, Adresse mit Modul+Offset, Rückverfolgung, letzter Schritt – dann ist die Datei für dich zum Schicken da */
static const char *modulZu(void *adr, char *puf, size_t n, size_t *offset) {
  HMODULE m = nullptr;
  if (GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, (LPCSTR)adr, &m) && m) {
    char voll[MAX_PATH]; GetModuleFileNameA(m, voll, sizeof voll);
    const char *name = strrchr(voll, '\\'); name = name ? name + 1 : voll;
    snprintf(puf, n, "%s", name); *offset = (size_t)((char *)adr - (char *)m); return puf;
  }
  snprintf(puf, n, "?"); *offset = 0; return puf;
}
static LONG WINAPI absturz(EXCEPTION_POINTERS *ep) {
  char mod[MAX_PATH]; size_t off;
  modulZu(ep->ExceptionRecord->ExceptionAddress, mod, sizeof mod, &off);
  L("ABSTURZ: Ausnahme 0x%08lX bei %p (%s+0x%zX) · Plug-in: %s · Schritt: %s", ep->ExceptionRecord->ExceptionCode, ep->ExceptionRecord->ExceptionAddress, mod, off, gPlugin, gSchritt);
  void *bt[40]; USHORT k = CaptureStackBackTrace(0, 40, bt, nullptr);
  for (USHORT i = 0; i < k; i++) { char m2[MAX_PATH]; size_t o2; modulZu(bt[i], m2, sizeof m2, &o2); L("  #%u %p %s+0x%zX", i, bt[i], m2, o2); }
  melden(std::string("{\"e\":\"absturz\",\"code\":\"") + [&] { char b[16]; snprintf(b, sizeof b, "%08lX", ep->ExceptionRecord->ExceptionCode); return std::string(b); }() +
         "\",\"modul\":\"" + jsonText(mod) + "\",\"schritt\":\"" + jsonText(gSchritt) + "\"}");
  if (gLog) fflush(gLog);
  TerminateProcess(GetCurrentProcess(), 3);
  return EXCEPTION_EXECUTE_HANDLER;
}

/* ====================================================================== Laden ====================================================================== */

struct Modul {
  HMODULE dll = nullptr;
  IPluginFactory *fabrik = nullptr;
  std::string pfad;
  typedef bool(__cdecl *InitFn)();
  typedef bool(__cdecl *ExitFn)();
  typedef IPluginFactory *(PLUGIN_API *FabrikFn)();
  ExitFn exitFn = nullptr;
};

/** .vst3 kann eine Datei (DLL) oder ein Ordner (Bundle: Contents\x86_64-win\Name.vst3) sein */
static std::wstring binaerPfad(const std::wstring &p) {
  DWORD a = GetFileAttributesW(p.c_str());
  if (a == INVALID_FILE_ATTRIBUTES || !(a & FILE_ATTRIBUTE_DIRECTORY)) return p;
  size_t s = p.find_last_of(L"\\/");
  std::wstring name = s == std::wstring::npos ? p : p.substr(s + 1);
  return p + L"\\Contents\\x86_64-win\\" + name;
}

static bool modulLaden(Modul &m, const char *pfadUtf8) {
  m.pfad = pfadUtf8;
  std::wstring wp = binaerPfad(wide(pfadUtf8));
  schritt("LoadLibrary %s", pfadUtf8);
  // Plug-ins legen ihre Abhängigkeiten oft neben die DLL
  size_t s = wp.find_last_of(L"\\/");
  if (s != std::wstring::npos) SetDllDirectoryW(wp.substr(0, s).c_str());
  m.dll = LoadLibraryExW(wp.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
  if (!m.dll) { L("LoadLibrary fehlgeschlagen: Windows-Fehler %lu", GetLastError()); return false; }
  Modul::InitFn init = (Modul::InitFn)GetProcAddress(m.dll, "InitDll");
  m.exitFn = (Modul::ExitFn)GetProcAddress(m.dll, "ExitDll");
  Modul::FabrikFn fn = (Modul::FabrikFn)GetProcAddress(m.dll, "GetPluginFactory");
  if (!fn) { L("GetPluginFactory fehlt – kein VST3-Modul"); return false; }
  if (init) { schritt("InitDll"); if (!init()) { L("InitDll meldet Fehler"); return false; } }
  schritt("GetPluginFactory");
  m.fabrik = fn();
  if (!m.fabrik) { L("GetPluginFactory lieferte nichts"); return false; }
  return true;
}
static void modulFreigeben(Modul &m) {
  schritt("Modul freigeben");
  if (m.fabrik) { m.fabrik->release(); m.fabrik = nullptr; }
  if (m.exitFn) m.exitFn();
  if (m.dll) FreeLibrary(m.dll);
  m.dll = nullptr;
}

/* ====================================================================== Host-Objekte ====================================================================== */

#define AW_UNKNOWN_BASIS \
  std::atomic<uint32> refs{1}; \
  uint32 PLUGIN_API addRef() override { return ++refs; } \
  uint32 PLUGIN_API release() override { uint32 r = --refs; if (!r) delete this; return r; }
#include <atomic>

// IAttributeList / IMessage: die Plug-ins schicken sich darüber Nachrichten zwischen Komponente und Controller
struct Attribut { int kind = 0; int64 i = 0; double d = 0; std::vector<char16_t> s; std::vector<char> b; };
struct AttrListe : Vst::IAttributeList {
  virtual ~AttrListe() {}
  AW_UNKNOWN_BASIS
  std::map<std::string, Attribut> m;
  tresult PLUGIN_API queryInterface(const TUID iid, void **obj) override {
    if (gleich(iid, FUnknown::iid) || gleich(iid, Vst::IAttributeList::iid)) { *obj = this; addRef(); return kResultOk; }
    *obj = nullptr; return kNoInterface;
  }
  tresult PLUGIN_API setInt(AttrID id, int64 v) override { Attribut a; a.kind = 0; a.i = v; m[id] = a; return kResultOk; }
  tresult PLUGIN_API getInt(AttrID id, int64 &v) override { auto it = m.find(id); if (it == m.end() || it->second.kind != 0) return kResultFalse; v = it->second.i; return kResultOk; }
  tresult PLUGIN_API setFloat(AttrID id, double v) override { Attribut a; a.kind = 1; a.d = v; m[id] = a; return kResultOk; }
  tresult PLUGIN_API getFloat(AttrID id, double &v) override { auto it = m.find(id); if (it == m.end() || it->second.kind != 1) return kResultFalse; v = it->second.d; return kResultOk; }
  tresult PLUGIN_API setString(AttrID id, const Vst::TChar *t) override {
    Attribut a; a.kind = 2; if (t) for (; *t; t++) a.s.push_back((char16_t)*t); a.s.push_back(0); m[id] = a; return kResultOk;
  }
  tresult PLUGIN_API getString(AttrID id, Vst::TChar *t, uint32 bytes) override {
    auto it = m.find(id); if (it == m.end() || it->second.kind != 2) return kResultFalse;
    uint32 n = bytes / 2; if (!n) return kResultFalse;
    uint32 k = 0; for (; k + 1 < n && k < it->second.s.size() && it->second.s[k]; k++) t[k] = (Vst::TChar)it->second.s[k];
    t[k] = 0; return kResultOk;
  }
  tresult PLUGIN_API setBinary(AttrID id, const void *d, uint32 bytes) override {
    Attribut a; a.kind = 3; a.b.assign((const char *)d, (const char *)d + bytes); m[id] = a; return kResultOk;
  }
  tresult PLUGIN_API getBinary(AttrID id, const void *&d, uint32 &bytes) override {
    auto it = m.find(id); if (it == m.end() || it->second.kind != 3) return kResultFalse; d = it->second.b.data(); bytes = (uint32)it->second.b.size(); return kResultOk;
  }
};
struct Nachricht : Vst::IMessage {
  AW_UNKNOWN_BASIS
  std::string id; AttrListe *attr = new AttrListe;
  virtual ~Nachricht() { attr->release(); }
  tresult PLUGIN_API queryInterface(const TUID iid, void **obj) override {
    if (gleich(iid, FUnknown::iid) || gleich(iid, Vst::IMessage::iid)) { *obj = this; addRef(); return kResultOk; }
    *obj = nullptr; return kNoInterface;
  }
  FIDString PLUGIN_API getMessageID() override { return id.c_str(); }
  void PLUGIN_API setMessageID(FIDString i) override { id = i ? i : ""; }
  Vst::IAttributeList *PLUGIN_API getAttributes() override { return attr; }
};

static void editMerken(Vst::ParamID id, Vst::ParamValue v);
struct Host : Vst::IHostApplication, Vst::IComponentHandler, Vst::IPlugInterfaceSupport {
  std::atomic<uint32> refs{1};
  uint32 PLUGIN_API addRef() override { return ++refs; }
  uint32 PLUGIN_API release() override { return --refs; }   // lebt so lange wie der Prozess
  tresult PLUGIN_API queryInterface(const TUID iid, void **obj) override {
    if (gleich(iid, FUnknown::iid) || gleich(iid, Vst::IHostApplication::iid)) { *obj = static_cast<Vst::IHostApplication *>(this); addRef(); return kResultOk; }
    if (gleich(iid, Vst::IComponentHandler::iid)) { *obj = static_cast<Vst::IComponentHandler *>(this); addRef(); return kResultOk; }
    if (gleich(iid, Vst::IPlugInterfaceSupport::iid)) { *obj = static_cast<Vst::IPlugInterfaceSupport *>(this); addRef(); return kResultOk; }
    *obj = nullptr; return kNoInterface;
  }
  tresult PLUGIN_API getName(Vst::String128 name) override {
    const char16_t n[] = u"Amberwave"; for (size_t i = 0; i < sizeof n / 2; i++) name[i] = (Vst::TChar)n[i]; return kResultOk;
  }
  tresult PLUGIN_API createInstance(TUID cid, TUID iid, void **obj) override {
    if (gleich(cid, Vst::IMessage::iid) && gleich(iid, Vst::IMessage::iid)) { *obj = static_cast<Vst::IMessage *>(new Nachricht); return kResultOk; }
    if (gleich(cid, Vst::IAttributeList::iid) && gleich(iid, Vst::IAttributeList::iid)) { *obj = static_cast<Vst::IAttributeList *>(new AttrListe); return kResultOk; }
    *obj = nullptr; return kNoInterface;
  }
  // IComponentHandler: Änderungen an Reglern in der Oberfläche (Stufe 2 reicht sie an den Audio-Teil weiter)
  tresult PLUGIN_API beginEdit(Vst::ParamID) override { return kResultOk; }
  tresult PLUGIN_API performEdit(Vst::ParamID id, Vst::ParamValue v) override { if (logEdits) L("Regler %u = %.4f", id, v); editMerken(id, v); neu = true; return kResultOk; }
  tresult PLUGIN_API endEdit(Vst::ParamID) override { return kResultOk; }
  tresult PLUGIN_API restartComponent(int32 flags) override { L("restartComponent Flags 0x%X", flags); return kResultOk; }
  // IPlugInterfaceSupport
  tresult PLUGIN_API isPlugInterfaceSupported(const TUID iid) override {
    return gleich(iid, Vst::IComponent::iid) || gleich(iid, Vst::IAudioProcessor::iid) || gleich(iid, Vst::IEditController::iid) ||
           gleich(iid, Vst::IConnectionPoint::iid) || gleich(iid, IPlugView::iid) ? kResultTrue : kResultFalse;
  }
  bool logEdits = true;
  bool neu = false;
};
static Host gHost;

/** leere Parameter-/Ereignislisten (manche Plug-ins greifen ohne Prüfung darauf zu) */
struct LeereParameter : Vst::IParameterChanges {
  uint32 PLUGIN_API addRef() override { return 1; }
  uint32 PLUGIN_API release() override { return 1; }
  tresult PLUGIN_API queryInterface(const TUID iid, void **obj) override {
    if (gleich(iid, FUnknown::iid) || gleich(iid, Vst::IParameterChanges::iid)) { *obj = this; return kResultOk; }
    *obj = nullptr; return kNoInterface;
  }
  int32 PLUGIN_API getParameterCount() override { return 0; }
  Vst::IParamValueQueue *PLUGIN_API getParameterData(int32) override { return nullptr; }
  Vst::IParamValueQueue *PLUGIN_API addParameterData(const Vst::ParamID &, int32 &) override { return nullptr; }
};
struct LeereEreignisse : Vst::IEventList {
  uint32 PLUGIN_API addRef() override { return 1; }
  uint32 PLUGIN_API release() override { return 1; }
  tresult PLUGIN_API queryInterface(const TUID iid, void **obj) override {
    if (gleich(iid, FUnknown::iid) || gleich(iid, Vst::IEventList::iid)) { *obj = this; return kResultOk; }
    *obj = nullptr; return kNoInterface;
  }
  int32 PLUGIN_API getEventCount() override { return 0; }
  tresult PLUGIN_API getEvent(int32, Vst::Event &) override { return kResultFalse; }
  tresult PLUGIN_API addEvent(Vst::Event &) override { return kResultTrue; }
};

/* ====================================================================== Plug-in-Instanz ====================================================================== */

struct Plugin {
  Modul modul;
  Vst::IComponent *komp = nullptr;
  Vst::IAudioProcessor *proz = nullptr;
  Vst::IEditController *ctrl = nullptr;
  Vst::IConnectionPoint *kpKomp = nullptr, *kpCtrl = nullptr;
  bool ctrlEigen = false;      // Controller ist ein eigenes Objekt (nicht die Komponente)
  bool aktiv = false, laeuft = false;
  uint32 latenz = 0;
  std::string name;
};

static int klasseSuchen(IPluginFactory *f, const TUID cid, PClassInfo2 *info2, bool *hat2) {
  int32 n = f->countClasses();
  IPluginFactory2 *f2 = nullptr;
  f->queryInterface(IPluginFactory2::iid, (void **)&f2);
  int gefunden = -1;
  for (int32 i = 0; i < n && gefunden < 0; i++) {
    PClassInfo ci;
    if (f->getClassInfo(i, &ci) != kResultOk) continue;
    if (gleich(ci.cid, cid)) {
      gefunden = i;
      memset(info2, 0, sizeof *info2);
      if (f2 && f2->getClassInfo2(i, info2) == kResultOk) *hat2 = true;
      else { *hat2 = false; memcpy(info2->cid, ci.cid, 16); strncpy(info2->name, ci.name, 63); strncpy(info2->category, ci.category, 31); }
    }
  }
  if (f2) f2->release();
  return gefunden;
}

static bool pluginOeffnen(Plugin &p, const char *pfad, const char *cidHexText) {
  TUID cid;
  if (!cidLesen(cidHexText, cid)) { L("Klassen-ID ungültig: %s", cidHexText); return false; }
  if (!modulLaden(p.modul, pfad)) return false;
  PClassInfo2 info; bool hat2;
  if (klasseSuchen(p.modul.fabrik, cid, &info, &hat2) < 0) { L("Klasse %s nicht in %s", cidHexText, pfad); return false; }
  p.name = info.name;
  snprintf(gPlugin, sizeof gPlugin, "%s", info.name);
  L("Plug-in: %s (%s) %s", info.name, hat2 ? info.vendor : "", hat2 ? info.version : "");

  schritt("createInstance Komponente");
  if (p.modul.fabrik->createInstance(cid, Vst::IComponent::iid, (void **)&p.komp) != kResultOk || !p.komp) { L("createInstance(IComponent) schlug fehl"); return false; }
  schritt("Komponente initialize");
  if (p.komp->initialize(static_cast<Vst::IHostApplication *>(&gHost)) != kResultOk) { L("Komponente.initialize schlug fehl"); return false; }
  if (p.komp->queryInterface(Vst::IAudioProcessor::iid, (void **)&p.proz) != kResultOk || !p.proz) { L("kein IAudioProcessor"); return false; }

  // Controller: dieselbe Klasse oder eigene
  schritt("Controller holen");
  if (p.komp->queryInterface(Vst::IEditController::iid, (void **)&p.ctrl) != kResultOk || !p.ctrl) {
    p.ctrl = nullptr;
    TUID ccid;
    if (p.komp->getControllerClassId(ccid) == kResultOk) {
      if (p.modul.fabrik->createInstance(ccid, Vst::IEditController::iid, (void **)&p.ctrl) == kResultOk && p.ctrl) {
        p.ctrlEigen = true;
        schritt("Controller initialize");
        p.ctrl->initialize(static_cast<Vst::IHostApplication *>(&gHost));
      } else L("Controller-Klasse %s ließ sich nicht erzeugen", cidHex(ccid).c_str());
    }
  }
  if (p.ctrl) {
    p.ctrl->setComponentHandler(&gHost);
    if (p.ctrlEigen) {
      p.komp->queryInterface(Vst::IConnectionPoint::iid, (void **)&p.kpKomp);
      p.ctrl->queryInterface(Vst::IConnectionPoint::iid, (void **)&p.kpCtrl);
      if (p.kpKomp && p.kpCtrl) { schritt("Verbinden"); p.kpKomp->connect(p.kpCtrl); p.kpCtrl->connect(p.kpKomp); }
    }
  } else L("Plug-in ohne Controller (keine Oberfläche, keine Parameter)");
  return true;
}

/** Stereo rein, Stereo raus; weitere Busse (Sidechain) aus */
static bool pluginStereo(Plugin &p) {
  int ein = p.komp->getBusCount(Vst::kAudio, Vst::kInput), aus = p.komp->getBusCount(Vst::kAudio, Vst::kOutput);
  L("Busse: %d Eingang, %d Ausgang", ein, aus);
  if (ein < 1 || aus < 1) { L("Plug-in hat keinen Audio-Ein-/Ausgang"); return false; }
  Vst::SpeakerArrangement ia = Vst::SpeakerArr::kStereo, oa = Vst::SpeakerArr::kStereo;
  schritt("setBusArrangements Stereo");
  tresult r = p.proz->setBusArrangements(&ia, 1, &oa, 1);
  Vst::SpeakerArrangement ga = 0, go = 0;
  p.proz->getBusArrangement(Vst::kInput, 0, ga); p.proz->getBusArrangement(Vst::kOutput, 0, go);
  L("setBusArrangements → %d, Haupt-Eingang 0x%llX, Haupt-Ausgang 0x%llX", (int)r, (unsigned long long)ga, (unsigned long long)go);
  if (ga != Vst::SpeakerArr::kStereo || go != Vst::SpeakerArr::kStereo) { L("das Plug-in nimmt Stereo nicht an (nur Stereo-Effekte werden unterstützt)"); return false; }
  for (int i = 0; i < ein; i++) p.komp->activateBus(Vst::kAudio, Vst::kInput, i, i == 0);
  for (int i = 0; i < aus; i++) p.komp->activateBus(Vst::kAudio, Vst::kOutput, i, i == 0);
  return true;
}

static bool pluginStarten(Plugin &p, double rate, int maxBlock) {
  Vst::ProcessSetup s; s.processMode = Vst::kRealtime; s.symbolicSampleSize = Vst::kSample32; s.maxSamplesPerBlock = maxBlock; s.sampleRate = rate;
  if (p.proz->canProcessSampleSize(Vst::kSample32) != kResultTrue) { L("Plug-in kann kein Float32"); return false; }
  schritt("setupProcessing %.0f Hz, Block %d", rate, maxBlock);
  if (p.proz->setupProcessing(s) != kResultOk) { L("setupProcessing schlug fehl"); return false; }
  schritt("setActive(true)");
  if (p.komp->setActive(true) != kResultOk) { L("setActive(true) schlug fehl"); return false; }
  p.aktiv = true;
  schritt("setProcessing(true)");
  p.proz->setProcessing(true);
  p.laeuft = true;
  p.latenz = p.proz->getLatencySamples();
  return true;
}

static void pluginSchliessen(Plugin &p) {
  if (p.laeuft) { schritt("setProcessing(false)"); p.proz->setProcessing(false); p.laeuft = false; }
  if (p.aktiv) { schritt("setActive(false)"); p.komp->setActive(false); p.aktiv = false; }
  if (p.kpKomp && p.kpCtrl) { p.kpKomp->disconnect(p.kpCtrl); p.kpCtrl->disconnect(p.kpKomp); }
  if (p.kpKomp) p.kpKomp->release();
  if (p.kpCtrl) p.kpCtrl->release();
  if (p.ctrl) { p.ctrl->setComponentHandler(nullptr); if (p.ctrlEigen) { schritt("Controller terminate"); p.ctrl->terminate(); } p.ctrl->release(); }
  if (p.proz) p.proz->release();
  if (p.komp) { schritt("Komponente terminate"); p.komp->terminate(); p.komp->release(); }
  p.kpKomp = p.kpCtrl = nullptr; p.ctrl = nullptr; p.proz = nullptr; p.komp = nullptr;
  modulFreigeben(p.modul);
}

/* ====================================================================== Scanner ====================================================================== */

static int scannen(const char *pfad) {
  Modul m;
  if (!modulLaden(m, pfad)) { melden(std::string("{\"e\":\"scan_fehler\",\"pfad\":\"") + jsonText(pfad) + "\",\"text\":\"Modul liess sich nicht laden (Windows-Fehler " + std::to_string(m.dll ? 0 : (long)GetLastError()) + ")\"}"); return 2; }
  PFactoryInfo fi; memset(&fi, 0, sizeof fi);
  m.fabrik->getFactoryInfo(&fi);
  IPluginFactory2 *f2 = nullptr; m.fabrik->queryInterface(IPluginFactory2::iid, (void **)&f2);
  int32 n = m.fabrik->countClasses();
  L("%s: %d Klassen, Anbieter %s", pfad, n, fi.vendor);
  int gemeldet = 0;
  for (int32 i = 0; i < n; i++) {
    PClassInfo ci; if (m.fabrik->getClassInfo(i, &ci) != kResultOk) continue;
    if (strcmp(ci.category, kVstAudioEffectClass) != 0) continue;
    PClassInfo2 c2; memset(&c2, 0, sizeof c2); bool hat2 = f2 && f2->getClassInfo2(i, &c2) == kResultOk;
    std::string unter = hat2 ? c2.subCategories : "";
    bool instrument = unter.find("Instrument") != std::string::npos;
    std::string z = "{\"e\":\"plugin\",\"pfad\":\"" + jsonText(pfad) + "\",\"cid\":\"" + cidHex(ci.cid) + "\",\"name\":\"" + jsonText(ci.name) + "\",\"anbieter\":\"" +
                    jsonText(hat2 && c2.vendor[0] ? c2.vendor : fi.vendor) + "\",\"version\":\"" + jsonText(hat2 ? c2.version : "") + "\",\"unter\":\"" + jsonText(unter) +
                    "\",\"instrument\":" + (instrument ? "true" : "false") + "}";
    melden(z); gemeldet++;
  }
  if (f2) f2->release();
  modulFreigeben(m);
  melden("{\"e\":\"scan_fertig\",\"pfad\":\"" + jsonText(pfad) + "\",\"klassen\":" + std::to_string(gemeldet) + "}");
  return 0;
}

/* ====================================================================== Probelauf ====================================================================== */

static int probe(const char *pfad, const char *cidHexText, double sekunden) {
  Plugin p;
  auto fehler = [&](const char *text) {
    L("PROBE-FEHLER: %s", text);
    melden(std::string("{\"e\":\"probe\",\"ok\":false,\"text\":\"") + jsonText(text) + "\"}");
    return 2;
  };
  if (!pluginOeffnen(p, pfad, cidHexText)) return fehler("Plug-in liess sich nicht öffnen (Einzelheiten im Log)");
  if (!pluginStereo(p)) return fehler("Plug-in unterstützt keinen Stereo-Effektbetrieb");
  const double rate = 48000; const int block = 512;
  if (!pluginStarten(p, rate, 4096)) return fehler("Plug-in liess sich nicht starten");

  int params = p.ctrl ? p.ctrl->getParameterCount() : 0;
  bool editor = false;
  if (p.ctrl) {
    schritt("createView prüfen");
    IPlugView *v = p.ctrl->createView(Vst::ViewType::kEditor);
    if (v) { editor = v->isPlatformTypeSupported(kPlatformTypeHWND) == kResultTrue; v->release(); }
  }
  L("Parameter: %d · Oberfläche: %s · Latenz: %u Samples", params, editor ? "ja" : "nein", p.latenz);

  // Rauschen (rosa, ~ −18 dBFS) durchschicken
  std::vector<float> in[2], out[2];
  for (int c = 0; c < 2; c++) { in[c].assign((size_t)block, 0); out[c].assign((size_t)block, 0); }
  float b0 = 0, b1 = 0, b2 = 0; uint32_t seed = 12345;
  Vst::AudioBusBuffers ib, ob; float *ip[2] = { in[0].data(), in[1].data() }, *op[2] = { out[0].data(), out[1].data() };
  ib.numChannels = 2; ib.silenceFlags = 0; ib.channelBuffers32 = ip;
  ob.numChannels = 2; ob.silenceFlags = 0; ob.channelBuffers32 = op;
  LeereParameter lp; LeereEreignisse le;
  Vst::ProcessContext pc; memset(&pc, 0, sizeof pc);
  pc.sampleRate = rate; pc.tempo = 120; pc.timeSigNumerator = 4; pc.timeSigDenominator = 4; pc.state = Vst::ProcessContext::kPlaying | Vst::ProcessContext::kTempoValid | Vst::ProcessContext::kTimeSigValid;
  Vst::ProcessData pd; memset(&pd, 0, sizeof pd);
  pd.processMode = Vst::kRealtime; pd.symbolicSampleSize = Vst::kSample32; pd.numSamples = block;
  pd.numInputs = 1; pd.numOutputs = 1; pd.inputs = &ib; pd.outputs = &ob;
  pd.inputParameterChanges = &lp; pd.outputParameterChanges = &lp; pd.inputEvents = &le; pd.outputEvents = &le; pd.processContext = &pc;

  int bloecke = (int)(sekunden * rate / block); if (bloecke < 8) bloecke = 8;
  double pegelEin = 0, pegelAus = 0, summeEin = 0, summeAus = 0; long long zaehl = 0; long nan = 0;
  LARGE_INTEGER fr, t0, t1; QueryPerformanceFrequency(&fr);
  double rechenMax = 0, rechenSumme = 0;
  schritt("process-Schleife (%d Blöcke)", bloecke);
  for (int bl = 0; bl < bloecke; bl++) {
    for (int i = 0; i < block; i++) {
      for (int c = 0; c < 2; c++) {
        seed = seed * 1664525u + 1013904223u; float w = ((seed >> 8) / 8388608.0f - 1.0f) * 0.25f;
        b0 = 0.99765f * b0 + w * 0.0990460f; b1 = 0.96300f * b1 + w * 0.2965164f; b2 = 0.57000f * b2 + w * 1.0526913f;
        float s = (b0 + b1 + b2 + w * 0.1848f) * 0.5f;
        in[c][(size_t)i] = s;
        float a = fabsf(s); if (a > pegelEin) pegelEin = a; summeEin += (double)s * s;
      }
    }
    QueryPerformanceCounter(&t0);
    tresult r = p.proz->process(pd);
    QueryPerformanceCounter(&t1);
    double ms = (double)(t1.QuadPart - t0.QuadPart) * 1000.0 / (double)fr.QuadPart;
    rechenSumme += ms; if (ms > rechenMax) rechenMax = ms;
    if (r != kResultOk && bl < 3) L("process → %d", (int)r);
    pc.projectTimeSamples += block;
    if (bl >= 4) for (int c = 0; c < 2; c++) for (int i = 0; i < block; i++) {
      float s = out[c][(size_t)i];
      if (s != s || fabsf(s) > 1e6f) { nan++; continue; }
      float a = fabsf(s); if (a > pegelAus) pegelAus = a; summeAus += (double)s * s; zaehl++;
    }
  }
  double rmsEin = sqrt(summeEin / (2.0 * bloecke * block)), rmsAus = zaehl ? sqrt(summeAus / (double)zaehl) : 0;
  auto dB = [](double x) { return x > 1e-9 ? 20 * log10(x) : -180.0; };
  L("Ergebnis: Eingang Spitze %.1f dB, RMS %.1f dB · Ausgang Spitze %.1f dB, RMS %.1f dB · ungültige Werte %ld · Rechenzeit je Block Ø %.3f ms, max %.3f ms (Block = %.2f ms)",
    dB(pegelEin), dB(rmsEin), dB(pegelAus), dB(rmsAus), nan, rechenSumme / bloecke, rechenMax, block * 1000.0 / rate);
  char z[700];
  snprintf(z, sizeof z, "{\"e\":\"probe\",\"ok\":true,\"name\":\"%s\",\"parameter\":%d,\"editor\":%s,\"latenz\":%u,\"ein_spitze\":%.2f,\"ein_rms\":%.2f,\"aus_spitze\":%.2f,\"aus_rms\":%.2f,\"ungueltig\":%ld,\"ms_mittel\":%.3f,\"ms_max\":%.3f,\"block_ms\":%.2f}",
           jsonText(p.name).c_str(), params, editor ? "true" : "false", p.latenz, dB(pegelEin), dB(rmsEin), dB(pegelAus), dB(rmsAus), nan, rechenSumme / bloecke, rechenMax, block * 1000.0 / rate);
  melden(z);
  pluginSchliessen(p);
  return 0;
}

/* ====================================================================== Editor-Fenster ====================================================================== */

static bool gInGroesse = false, gAngehaengt = false, gSlotModus = false;
static void editorSchliessen();
struct Rahmen : IPlugFrame {
  HWND fenster = nullptr;
  uint32 PLUGIN_API addRef() override { return 1; }
  uint32 PLUGIN_API release() override { return 1; }
  tresult PLUGIN_API queryInterface(const TUID iid, void **obj) override {
    if (gleich(iid, FUnknown::iid) || gleich(iid, IPlugFrame::iid)) { *obj = this; return kResultOk; }
    *obj = nullptr; return kNoInterface;
  }
  tresult PLUGIN_API resizeView(IPlugView *view, ViewRect *r) override {
    if (!fenster || !r) return kInvalidArgument;
    RECT rc = { 0, 0, r->right - r->left, r->bottom - r->top };
    DWORD st = (DWORD)GetWindowLongPtr(fenster, GWL_STYLE);
    AdjustWindowRect(&rc, st, FALSE);
    L("Plug-in will Fenstergröße %dx%d", r->right - r->left, r->bottom - r->top);
    gInGroesse = true;
    SetWindowPos(fenster, nullptr, 0, 0, rc.right - rc.left, rc.bottom - rc.top, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
    gInGroesse = false;
    ViewRect neu = *r; neu.right -= neu.left; neu.bottom -= neu.top; neu.left = neu.top = 0;
    view->onSize(&neu);
    return kResultOk;
  }
};
static Rahmen gRahmen;
static IPlugView *gAnsicht = nullptr;

// (gInGroesse oben) Größenänderung kommt vom Plug-in selbst (resizeView) – dann nicht zurückmelden
/** dunkle Titelleiste (Windows 10/11, falls vorhanden) */
static void dunkleTitelleiste(HWND h) {
  HMODULE dwm = LoadLibraryW(L"dwmapi.dll");
  if (!dwm) return;
  typedef HRESULT (WINAPI *Setzen)(HWND, DWORD, LPCVOID, DWORD);
  Setzen f = (Setzen)GetProcAddress(dwm, "DwmSetWindowAttribute");
  BOOL an = TRUE;
  if (f) { if (FAILED(f(h, 20, &an, sizeof an))) f(h, 19, &an, sizeof an); }
  FreeLibrary(dwm);
}

static LRESULT CALLBACK fensterProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
    case WM_TIMER:
      if (w == 77) { KillTimer(h, 77); ShowWindow(h, SW_SHOW); SetForegroundWindow(h); return 0; }
      break;
    case WM_SIZING:   // beim Ziehen die Grenzen des Plug-ins einhalten (z. B. Seitenverhältnis, Mindestgröße)
      if (gAnsicht && gAnsicht->canResize() == kResultTrue) {
        RECT *r = (RECT *)l, extra = { 0, 0, 0, 0 };
        AdjustWindowRect(&extra, (DWORD)GetWindowLongPtr(h, GWL_STYLE), FALSE);
        ViewRect v; v.left = 0; v.top = 0; v.right = (r->right - r->left) - (extra.right - extra.left); v.bottom = (r->bottom - r->top) - (extra.bottom - extra.top);
        if (gAnsicht->checkSizeConstraint(&v) == kResultTrue || true) {
          int nb = v.right - v.left + (extra.right - extra.left), nh = v.bottom - v.top + (extra.bottom - extra.top);
          bool links = w == WMSZ_LEFT || w == WMSZ_TOPLEFT || w == WMSZ_BOTTOMLEFT, oben = w == WMSZ_TOP || w == WMSZ_TOPLEFT || w == WMSZ_TOPRIGHT;
          if (links) r->left = r->right - nb; else r->right = r->left + nb;
          if (oben) r->top = r->bottom - nh; else r->bottom = r->top + nh;
        }
        return TRUE;
      }
      break;
    case WM_SIZE:
      if (gAnsicht && gAngehaengt && !gInGroesse && w != SIZE_MINIMIZED) {
        RECT c; GetClientRect(h, &c);
        ViewRect v; v.left = 0; v.top = 0; v.right = c.right; v.bottom = c.bottom;
        if (v.right > 0 && v.bottom > 0) { L("Fenstergröße %dx%d → onSize", v.right, v.bottom); gAnsicht->onSize(&v); }
      }
      return 0;
    case WM_CLOSE: if (gSlotModus) { editorSchliessen(); return 0; } DestroyWindow(h); return 0;
    case WM_DESTROY: if (!gSlotModus) PostQuitMessage(0); return 0;
  }
  return DefWindowProcW(h, m, w, l);
}

static int editor(const char *pfad, const char *cidHexText, double sekunden) {
  Plugin p;
  if (!pluginOeffnen(p, pfad, cidHexText)) { melden("{\"e\":\"editor\",\"ok\":false,\"text\":\"Plug-in liess sich nicht öffnen\"}"); return 2; }
  if (!p.ctrl) { melden("{\"e\":\"editor\",\"ok\":false,\"text\":\"Plug-in hat keinen Controller\"}"); return 2; }
  schritt("createView");
  IPlugView *v = p.ctrl->createView(Vst::ViewType::kEditor);
  if (!v) { melden("{\"e\":\"editor\",\"ok\":false,\"text\":\"Plug-in hat keine Oberfläche\"}"); pluginSchliessen(p); return 2; }
  if (v->isPlatformTypeSupported(kPlatformTypeHWND) != kResultTrue) { melden("{\"e\":\"editor\",\"ok\":false,\"text\":\"Oberfläche ist nicht für Windows (HWND)\"}"); v->release(); pluginSchliessen(p); return 2; }
  ViewRect r; memset(&r, 0, sizeof r);
  v->getSize(&r);
  int bw = r.right - r.left, bh = r.bottom - r.top;
  if (bw < 50) bw = 600; if (bh < 50) bh = 400;
  bool skaliert = v->canResize() == kResultTrue;
  L("Oberfläche %dx%d, Größe änderbar: %s", bw, bh, skaliert ? "ja" : "nein");

  HINSTANCE hi = GetModuleHandleW(nullptr);
  WNDCLASSW wc; memset(&wc, 0, sizeof wc);
  wc.lpfnWndProc = fensterProc; wc.hInstance = hi; wc.lpszClassName = L"AmberwaveVstFenster"; wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = CreateSolidBrush(RGB(17, 12, 9));   // dunkel wie das Rack (WS_CLIPCHILDREN: das Plug-in zeichnet seine Fläche selbst, kein Flackern)
  RegisterClassW(&wc);
  DWORD stil = WS_CLIPCHILDREN | WS_CLIPSIBLINGS | WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | (skaliert ? (WS_THICKFRAME | WS_MAXIMIZEBOX) : 0);
  // Plug-in-Größen sind in 96-dpi-Einheiten; bei hoher Skalierung entsprechend größer, das Plug-in bekommt den Faktor gesagt
  UINT dpi = 96; { typedef UINT(WINAPI * GdFn)(void); GdFn g = (GdFn)GetProcAddress(GetModuleHandleA("user32.dll"), "GetDpiForSystem"); if (g) dpi = g(); }
  double faktor = dpi / 96.0;
  L("Bildschirm-Skalierung %.2f (%u dpi)", faktor, dpi);
  { IPlugViewContentScaleSupport *cs = nullptr;
    if (v->queryInterface(IPlugViewContentScaleSupport::iid, (void **)&cs) == kResultOk && cs) { cs->setContentScaleFactor((IPlugViewContentScaleSupport::ScaleFactor)faktor); cs->release(); L("setContentScaleFactor %.2f", faktor); } }
  ViewRect r2 = r; v->getSize(&r2); bw = r2.right - r2.left; bh = r2.bottom - r2.top; if (bw < 50) bw = 600; if (bh < 50) bh = 400;
  L("Größe nach Skalierung: %dx%d", bw, bh);
  RECT rc = { 0, 0, bw, bh }; AdjustWindowRect(&rc, stil, FALSE);
  std::wstring titel = wide(("Amberwave · " + p.name).c_str());
  HWND h = CreateWindowExW(0, wc.lpszClassName, titel.c_str(), stil, CW_USEDEFAULT, CW_USEDEFAULT, rc.right - rc.left, rc.bottom - rc.top, nullptr, nullptr, hi, nullptr);
  if (!h) { L("CreateWindow schlug fehl: %lu", GetLastError()); v->release(); pluginSchliessen(p); return 2; }
  gRahmen.fenster = h; gAnsicht = v;
  v->setFrame(&gRahmen);
  ShowWindow(h, SW_SHOW);
  schritt("IPlugView::attached");
  if (v->attached(h, kPlatformTypeHWND) != kResultOk) { L("attached schlug fehl"); melden("{\"e\":\"editor\",\"ok\":false,\"text\":\"attached schlug fehl\"}"); DestroyWindow(h); v->setFrame(nullptr); v->release(); pluginSchliessen(p); return 2; }
  gAngehaengt = true;
  melden("{\"e\":\"editor\",\"ok\":true}");
  schritt("Nachrichtenschleife");
  UINT_PTR frist = sekunden > 0 ? SetTimer(h, 1, (UINT)(sekunden * 1000), nullptr) : 0; (void)frist;
  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    if (msg.message == WM_TIMER && msg.hwnd == h && msg.wParam == 1) { PostMessageW(h, WM_CLOSE, 0, 0); continue; }
    TranslateMessage(&msg); DispatchMessageW(&msg);
  }
  schritt("Oberfläche schließen");
  gAngehaengt = false;
  v->removed(); v->setFrame(nullptr); v->release(); gAnsicht = nullptr;
  pluginSchliessen(p);
  melden("{\"e\":\"editor_zu\"}");
  return 0;
}

/* ====================================================================== Slot-Betrieb (läuft in der Klangkette) ====================================================================== */

// Parameter-Änderungen aus der Oberfläche → beim nächsten Block ans Plug-in (Controller und Prozessor sind getrennte Objekte)
struct PWarte { Vst::ParamID id; Vst::ParamValue v; };
static std::vector<PWarte> gEdits;                 // von der UI geschrieben, vom Audio-Thread geleert
static std::mutex gEditMx;
static std::vector<PWarte> gZurueck;               // Ausgangs-Parameter des Plug-ins → Controller (UI-Thread)
static std::mutex gZurueckMx;
static long gEditZahl = 0;

static HWND gMsgWnd = nullptr;
#define WM_AW_UMSTELLEN (WM_APP + 1)
#define WM_AW_ZURUECK (WM_APP + 2)
#define WM_AW_BEFEHL (WM_APP + 3)
#define WM_AW_ELTERN_WEG (WM_APP + 4)

static void editMerken(Vst::ParamID id, Vst::ParamValue v) {
  if (!gSlotModus) return;
  { std::lock_guard<std::mutex> lk(gEditMx);
    bool da = false; for (auto &e : gEdits) if (e.id == id) { e.v = v; da = true; break; }
    if (!da) gEdits.push_back({ id, v }); }
  gEditZahl++;
  if (gMsgWnd) SetTimer(gMsgWnd, 2, 1500, nullptr);   // Zustand kurz nach der letzten Änderung sichern
}

struct PQueue : Vst::IParamValueQueue {
  Vst::ParamID id = 0; std::vector<std::pair<int32, double>> pts;
  uint32 PLUGIN_API addRef() override { return 1; }
  uint32 PLUGIN_API release() override { return 1; }
  tresult PLUGIN_API queryInterface(const TUID iid, void **obj) override {
    if (gleich(iid, FUnknown::iid) || gleich(iid, Vst::IParamValueQueue::iid)) { *obj = this; return kResultOk; }
    *obj = nullptr; return kNoInterface;
  }
  Vst::ParamID PLUGIN_API getParameterId() override { return id; }
  int32 PLUGIN_API getPointCount() override { return (int32)pts.size(); }
  tresult PLUGIN_API getPoint(int32 i, int32 &off, Vst::ParamValue &v) override { if (i < 0 || i >= (int32)pts.size()) return kResultFalse; off = pts[(size_t)i].first; v = pts[(size_t)i].second; return kResultTrue; }
  tresult PLUGIN_API addPoint(int32 off, Vst::ParamValue v, int32 &index) override { pts.push_back({ off, v }); index = (int32)pts.size() - 1; return kResultTrue; }
};
struct PAenderungen : Vst::IParameterChanges {
  std::vector<PQueue> q; int benutzt = 0;
  PAenderungen() : q(256) {}
  void leeren() { for (int i = 0; i < benutzt; i++) q[(size_t)i].pts.clear(); benutzt = 0; }
  uint32 PLUGIN_API addRef() override { return 1; }
  uint32 PLUGIN_API release() override { return 1; }
  tresult PLUGIN_API queryInterface(const TUID iid, void **obj) override {
    if (gleich(iid, FUnknown::iid) || gleich(iid, Vst::IParameterChanges::iid)) { *obj = this; return kResultOk; }
    *obj = nullptr; return kNoInterface;
  }
  int32 PLUGIN_API getParameterCount() override { return benutzt; }
  Vst::IParamValueQueue *PLUGIN_API getParameterData(int32 i) override { return i >= 0 && i < benutzt ? &q[(size_t)i] : nullptr; }
  Vst::IParamValueQueue *PLUGIN_API addParameterData(const Vst::ParamID &id, int32 &index) override {
    for (int i = 0; i < benutzt; i++) if (q[(size_t)i].id == id) { index = i; return &q[(size_t)i]; }
    if (benutzt >= (int)q.size()) return nullptr;
    q[(size_t)benutzt].id = id; q[(size_t)benutzt].pts.clear(); index = benutzt; return &q[(size_t)benutzt++];
  }
};

// Zustand (Komponente + Controller) in eine Datei: ['AWV1'][u32 n1][Komponente][u32 n2][Controller]
struct MemStream : IBStream {
  std::vector<char> d; int64 pos = 0;
  uint32 PLUGIN_API addRef() override { return 1; }
  uint32 PLUGIN_API release() override { return 1; }
  tresult PLUGIN_API queryInterface(const TUID iid, void **obj) override {
    if (gleich(iid, FUnknown::iid) || gleich(iid, IBStream::iid)) { *obj = this; return kResultOk; }
    *obj = nullptr; return kNoInterface;
  }
  tresult PLUGIN_API read(void *buf, int32 n, int32 *got) override {
    int64 rest = (int64)d.size() - pos; int32 k = (int32)(n < rest ? n : (rest < 0 ? 0 : rest));
    if (k > 0) memcpy(buf, d.data() + pos, (size_t)k);
    pos += k; if (got) *got = k; return kResultOk;
  }
  tresult PLUGIN_API write(void *buf, int32 n, int32 *wr) override {
    if (pos + n > (int64)d.size()) d.resize((size_t)(pos + n));
    memcpy(d.data() + pos, buf, (size_t)n); pos += n; if (wr) *wr = n; return kResultOk;
  }
  tresult PLUGIN_API seek(int64 p, int32 mode, int64 *res) override {
    int64 np = mode == 0 ? p : mode == 1 ? pos + p : (int64)d.size() + p;
    if (np < 0) return kResultFalse; pos = np; if (res) *res = pos; return kResultOk;
  }
  tresult PLUGIN_API tell(int64 *p) override { if (p) *p = pos; return kResultOk; }
};

static Plugin *gP = nullptr;
static std::string gZustandDatei;
static VstShm *gShm = nullptr;
static HANDLE gEvEin = nullptr, gEvAus = nullptr, gMap = nullptr;
static std::atomic<bool> gStopp{false}, gUmstellen{false};
static int gRate = 0;
static int gNeueRate = 0;
static CRITICAL_SECTION gProcCs;
static std::string gKey;

static bool zustandSpeichern(const std::string &datei) {
  if (!gP || !gP->komp || datei.empty()) return false;
  MemStream k, c;
  schritt("Zustand speichern");
  bool okK = gP->komp->getState(&k) == kResultOk;
  bool okC = gP->ctrl && gP->ctrlEigen && gP->ctrl->getState(&c) == kResultOk;
  if (!okK && !okC) { L("Zustand: das Plug-in lieferte nichts"); return false; }
  std::string tmp = datei + ".tmp";
  FILE *f = fopen(tmp.c_str(), "wb");
  if (!f) { L("Zustand: %s nicht schreibbar", tmp.c_str()); return false; }
  uint32_t kopf = 0x31575641, n1 = okK ? (uint32_t)k.d.size() : 0, n2 = okC ? (uint32_t)c.d.size() : 0;
  fwrite(&kopf, 4, 1, f); fwrite(&n1, 4, 1, f); if (n1) fwrite(k.d.data(), 1, n1, f); fwrite(&n2, 4, 1, f); if (n2) fwrite(c.d.data(), 1, n2, f);
  fclose(f);
  MoveFileExA(tmp.c_str(), datei.c_str(), MOVEFILE_REPLACE_EXISTING);
  L("Zustand gesichert (%u + %u Bytes) → %s", n1, n2, datei.c_str());
  return true;
}
static bool zustandLaden(const std::string &datei) {
  if (!gP || !gP->komp || datei.empty()) return false;
  FILE *f = fopen(datei.c_str(), "rb");
  if (!f) return false;
  uint32_t kopf = 0, n1 = 0, n2 = 0;
  MemStream k, c;
  bool ok = fread(&kopf, 4, 1, f) == 1 && kopf == 0x31575641 && fread(&n1, 4, 1, f) == 1 && n1 < (64u << 20);
  if (ok) { k.d.resize(n1); ok = n1 == 0 || fread(k.d.data(), 1, n1, f) == n1; }
  if (ok) { ok = fread(&n2, 4, 1, f) == 1 && n2 < (64u << 20); if (ok) { c.d.resize(n2); ok = n2 == 0 || fread(c.d.data(), 1, n2, f) == n2; } }
  fclose(f);
  if (!ok) { L("Zustandsdatei %s ist beschädigt", datei.c_str()); return false; }
  schritt("Zustand laden (%u + %u Bytes)", n1, n2);
  EnterCriticalSection(&gProcCs);
  if (n1) { k.pos = 0; gP->komp->setState(&k); }
  if (gP->ctrl) {
    if (n1) { k.pos = 0; gP->ctrl->setComponentState(&k); }
    if (n2 && gP->ctrlEigen) { c.pos = 0; gP->ctrl->setState(&c); }
  }
  LeaveCriticalSection(&gProcCs);
  L("Zustand geladen aus %s", datei.c_str());
  return true;
}

/* ---- Editor im Slot ---- */
static void editorAuf() {
  if (gAnsicht) { SetForegroundWindow(gRahmen.fenster); ShowWindow(gRahmen.fenster, SW_RESTORE); return; }
  if (!gP || !gP->ctrl) { melden("{\"e\":\"editor\",\"ok\":false,\"text\":\"Plug-in hat keinen Controller\"}"); return; }
  schritt("createView");
  IPlugView *v = gP->ctrl->createView(Vst::ViewType::kEditor);
  if (!v) { melden("{\"e\":\"editor\",\"ok\":false,\"text\":\"Plug-in hat keine Oberfläche\"}"); return; }
  if (v->isPlatformTypeSupported(kPlatformTypeHWND) != kResultTrue) { melden("{\"e\":\"editor\",\"ok\":false,\"text\":\"Oberfläche ist nicht für Windows (HWND)\"}"); v->release(); return; }
  bool skaliert = v->canResize() == kResultTrue;
  UINT dpi = 96; { typedef UINT(WINAPI * GdFn)(void); GdFn g = (GdFn)GetProcAddress(GetModuleHandleA("user32.dll"), "GetDpiForSystem"); if (g) dpi = g(); }
  double faktor = dpi / 96.0;
  { IPlugViewContentScaleSupport *cs = nullptr;
    if (v->queryInterface(IPlugViewContentScaleSupport::iid, (void **)&cs) == kResultOk && cs) { cs->setContentScaleFactor((IPlugViewContentScaleSupport::ScaleFactor)faktor); cs->release(); } }
  ViewRect r; memset(&r, 0, sizeof r); v->getSize(&r);
  int bw = r.right - r.left, bh = r.bottom - r.top; if (bw < 50) bw = 600; if (bh < 50) bh = 400;
  L("Oberfläche %dx%d, Skalierung %.2f, Größe änderbar: %s", bw, bh, faktor, skaliert ? "ja" : "nein");
  HINSTANCE hi = GetModuleHandleW(nullptr);
  static bool registriert = false;
  if (!registriert) {
    WNDCLASSW wc; memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = fensterProc; wc.hInstance = hi; wc.lpszClassName = L"AmberwaveVstFenster"; wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.hbrBackground = CreateSolidBrush(RGB(17, 12, 9));
    RegisterClassW(&wc); registriert = true;
  }
  DWORD stil = WS_CLIPCHILDREN | WS_CLIPSIBLINGS | WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | (skaliert ? (WS_THICKFRAME | WS_MAXIMIZEBOX) : 0);
  RECT rc = { 0, 0, bw, bh }; AdjustWindowRect(&rc, stil, FALSE);
  std::wstring titel = wide(("Amberwave · " + gP->name).c_str());
  HWND h = CreateWindowExW(WS_EX_TOPMOST, L"AmberwaveVstFenster", titel.c_str(), stil, CW_USEDEFAULT, CW_USEDEFAULT, rc.right - rc.left, rc.bottom - rc.top, nullptr, nullptr, hi, nullptr);
  if (!h) { L("CreateWindow schlug fehl: %lu", GetLastError()); v->release(); melden("{\"e\":\"editor\",\"ok\":false,\"text\":\"Fenster nicht erzeugt\"}"); return; }
  gRahmen.fenster = h; gAnsicht = v;
  v->setFrame(&gRahmen);
  dunkleTitelleiste(h);
  // Fenster zunächst unsichtbar lassen: das Plug-in baut seine Oberfläche auf, gezeigt wird erst nach einem kurzen Moment
  // (WM_TIMER) – sonst blitzt kurz ein leeres Fenster auf
  schritt("IPlugView::attached");
  if (v->attached(h, kPlatformTypeHWND) != kResultOk) {
    L("attached schlug fehl"); melden("{\"e\":\"editor\",\"ok\":false,\"text\":\"attached schlug fehl\"}");
    gAnsicht = nullptr; DestroyWindow(h); v->setFrame(nullptr); v->release(); return;
  }
  gAngehaengt = true;
  SetTimer(h, 77, 90, nullptr);
  melden("{\"e\":\"editor\",\"ok\":true,\"auf\":true}");
}
static void editorSchliessen() {
  if (!gAnsicht) return;
  schritt("Oberfläche schließen");
  IPlugView *v = gAnsicht; HWND h = gRahmen.fenster;
  gAngehaengt = false; gAnsicht = nullptr;
  v->removed(); v->setFrame(nullptr); v->release();
  if (h) DestroyWindow(h);
  gRahmen.fenster = nullptr;
  melden("{\"e\":\"editor\",\"ok\":true,\"auf\":false}");
  zustandSpeichern(gZustandDatei);
}

/* ---- Audio-Thread ---- */
static PAenderungen gParEin, gParAus;
static LeereEreignisse gEreig;
static double gRechenMax = 0, gRechenSumme = 0; static long gRechenZahl = 0, gZu = 0;

static bool rechneBlock(int n) {
  Plugin &p = *gP;
  if (!p.laeuft) return false;
  // Änderungen aus der Oberfläche einsammeln
  gParEin.leeren(); gParAus.leeren();
  { std::lock_guard<std::mutex> lk(gEditMx);
    for (auto &e : gEdits) { int32 idx; Vst::IParamValueQueue *q = gParEin.addParameterData(e.id, idx); int32 pi; if (q) q->addPoint(0, e.v, pi); }
    gEdits.clear(); }
  float *ip[2] = { gShm->ein[0], gShm->ein[1] }, *op[2] = { gShm->aus[0], gShm->aus[1] };
  Vst::AudioBusBuffers ib, ob;
  ib.numChannels = 2; ib.silenceFlags = 0; ib.channelBuffers32 = ip;
  ob.numChannels = 2; ob.silenceFlags = 0; ob.channelBuffers32 = op;
  static Vst::ProcessContext pc; static bool pcInit = false;
  if (!pcInit) { memset(&pc, 0, sizeof pc); pc.tempo = 120; pc.timeSigNumerator = 4; pc.timeSigDenominator = 4; pc.state = Vst::ProcessContext::kPlaying | Vst::ProcessContext::kTempoValid | Vst::ProcessContext::kTimeSigValid; pcInit = true; }
  pc.sampleRate = gRate;
  Vst::ProcessData pd; memset(&pd, 0, sizeof pd);
  pd.processMode = Vst::kRealtime; pd.symbolicSampleSize = Vst::kSample32; pd.numSamples = n;
  pd.numInputs = 1; pd.numOutputs = 1; pd.inputs = &ib; pd.outputs = &ob;
  pd.inputParameterChanges = &gParEin; pd.outputParameterChanges = &gParAus; pd.inputEvents = &gEreig; pd.outputEvents = &gEreig; pd.processContext = &pc;
  LARGE_INTEGER fr, t0, t1; QueryPerformanceFrequency(&fr); QueryPerformanceCounter(&t0);
  tresult r = p.proz->process(pd);
  QueryPerformanceCounter(&t1);
  pc.projectTimeSamples += n;
  double ms = (double)(t1.QuadPart - t0.QuadPart) * 1000.0 / (double)fr.QuadPart;
  gRechenSumme += ms; gRechenZahl++; if (ms > gRechenMax) gRechenMax = ms;
  double blockMs = n * 1000.0 / (gRate ? gRate : 48000);
  if (ms > blockMs * 0.8) gZu++;
  if (gRechenZahl >= 2000) {
    L("Rechenzeit (2000 Blöcke): Ø %.3f ms, max %.3f ms, Block %.2f ms, zu langsam: %ld", gRechenSumme / gRechenZahl, gRechenMax, blockMs, gZu);
    gRechenSumme = 0; gRechenMax = 0; gRechenZahl = 0; gZu = 0;
  }
  if (r != kResultOk) { static int w = 0; if (w++ < 5) L("process → %d", (int)r); }
  // Parameter, die das Plug-in selbst ausgibt (Anzeigewerte, Automation) → Controller
  if (gParAus.benutzt > 0) {
    std::lock_guard<std::mutex> lk(gZurueckMx);
    for (int i = 0; i < gParAus.benutzt; i++) { PQueue &q = gParAus.q[(size_t)i]; if (!q.pts.empty()) gZurueck.push_back({ q.id, q.pts.back().second }); }
    if (gZurueck.size() > 4096) gZurueck.erase(gZurueck.begin(), gZurueck.end() - 1024);
    if (gMsgWnd) PostMessageW(gMsgWnd, WM_AW_ZURUECK, 0, 0);
  }
  return true;
}

static DWORD WINAPI audioThread(LPVOID) {
  SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
  // MMCSS „Pro Audio“: Windows gibt dem Thread bevorzugt und regelmäßig Rechenzeit (wie bei DAWs). avrt.dll wird erst zur Laufzeit geladen.
  {
    typedef HANDLE (WINAPI *FnAvSet)(LPCWSTR, LPDWORD);
    HMODULE av = LoadLibraryW(L"avrt.dll");
    FnAvSet f = av ? (FnAvSet)GetProcAddress(av, "AvSetMmThreadCharacteristicsW") : nullptr;
    DWORD idx = 0; HANDLE h = f ? f(L"Pro Audio", &idx) : nullptr;
    L("MMCSS Pro Audio: %s", h ? "ja" : "nein");
  }
  L("Audio-Thread läuft");
  long lauf = 0;
  while (!gStopp) {
    DWORD w = WaitForSingleObject(gEvEin, 1000);
    if (gStopp) break;
    if (w != WAIT_OBJECT_0) continue;
    int n = gShm->n; if (n < 0) n = 0; if (n > VST_MAXN) n = VST_MAXN;
    int rate = gShm->rate; if (rate < 8000 || rate > 768000) rate = gRate;
    bool ok = false;
    if (rate != gRate && !gUmstellen.load()) { gNeueRate = rate; gUmstellen = true; PostMessageW(gMsgWnd, WM_AW_UMSTELLEN, 0, 0); }
    if (!gUmstellen.load() && TryEnterCriticalSection(&gProcCs)) { ok = rechneBlock(n); LeaveCriticalSection(&gProcCs); }
    if (!ok) { memcpy(gShm->aus[0], gShm->ein[0], sizeof(float) * (size_t)n); memcpy(gShm->aus[1], gShm->ein[1], sizeof(float) * (size_t)n); }
    gShm->zaehler = (int32_t)++lauf;
    SetEvent(gEvAus);
  }
  L("Audio-Thread beendet");
  return 0;
}

/* ---- Befehle der App (stdin, JSON-Zeilen) ---- */
static std::string jsonFeld(const std::string &z, const char *key) {
  std::string suche = std::string("\"") + key + "\"";
  size_t i = z.find(suche); if (i == std::string::npos) return "";
  i = z.find(':', i + suche.size()); if (i == std::string::npos) return "";
  i++; while (i < z.size() && z[i] == ' ') i++;
  if (i >= z.size()) return "";
  std::string o;
  if (z[i] == '"') {
    for (i++; i < z.size() && z[i] != '"'; i++) {
      if (z[i] == '\\' && i + 1 < z.size()) { i++; char c = z[i]; o += c == 'n' ? '\n' : c == 't' ? '\t' : c; } else o += z[i];
    }
  } else { while (i < z.size() && z[i] != ',' && z[i] != '}') o += z[i++]; }
  return o;
}
static DWORD WINAPI stdinThread(LPVOID) {
  char buf[4096]; std::string rest; HANDLE h = GetStdHandle(STD_INPUT_HANDLE); DWORD got;
  while (ReadFile(h, buf, sizeof buf, &got, nullptr) && got) {
    rest.append(buf, got);
    size_t i;
    while ((i = rest.find('\n')) != std::string::npos) {
      std::string z = rest.substr(0, i); rest.erase(0, i + 1);
      if (!z.empty()) PostMessageW(gMsgWnd, WM_AW_BEFEHL, 0, (LPARAM) new std::string(z));
    }
  }
  PostMessageW(gMsgWnd, WM_AW_ELTERN_WEG, 0, 0);
  return 0;
}

static void umstellen() {
  int rate = gNeueRate;
  Plugin &p = *gP;
  L("Abtastrate %d → %d: Plug-in neu einrichten", gRate, rate);
  EnterCriticalSection(&gProcCs);
  schritt("Umstellen: setProcessing(false)"); p.proz->setProcessing(false);
  schritt("Umstellen: setActive(false)"); p.komp->setActive(false);
  Vst::ProcessSetup s; s.processMode = Vst::kRealtime; s.symbolicSampleSize = Vst::kSample32; s.maxSamplesPerBlock = 4096; s.sampleRate = rate;
  schritt("Umstellen: setupProcessing %d", rate);
  bool ok = p.proz->setupProcessing(s) == kResultOk;
  p.komp->setActive(true); p.proz->setProcessing(true);
  p.latenz = p.proz->getLatencySamples();
  if (ok) gRate = rate; else { L("setupProcessing für %d Hz schlug fehl – Plug-in bleibt im Durchlauf", rate); p.laeuft = false; gRate = rate; }
  LeaveCriticalSection(&gProcCs);
  gUmstellen = false;
  melden("{\"e\":\"latenz\",\"samples\":" + std::to_string(p.latenz) + ",\"rate\":" + std::to_string(rate) + "}");
}

static void beenden(int code) {
  schritt("Beenden");
  gStopp = true; if (gEvEin) SetEvent(gEvEin);
  editorSchliessen();
  zustandSpeichern(gZustandDatei);
  PostQuitMessage(code);
}

static LRESULT CALLBACK msgProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
    case WM_AW_UMSTELLEN: umstellen(); return 0;
    case WM_AW_ZURUECK: {
      std::vector<PWarte> v; { std::lock_guard<std::mutex> lk(gZurueckMx); v.swap(gZurueck); }
      if (gP && gP->ctrl) for (auto &e : v) gP->ctrl->setParamNormalized(e.id, e.v);
      return 0;
    }
    case WM_TIMER:
      if (w == 2) { KillTimer(h, 2); zustandSpeichern(gZustandDatei); return 0; }
      break;
    case WM_AW_BEFEHL: {
      std::string *z = (std::string *)l; std::string c = jsonFeld(*z, "c");
      L("Befehl: %s", c.c_str());
      if (c == "editor_auf") editorAuf();
      else if (c == "editor_zu") editorSchliessen();
      else if (c == "zustand_speichern") { bool ok = zustandSpeichern(jsonFeld(*z, "datei")); melden(std::string("{\"e\":\"zustand\",\"was\":\"gespeichert\",\"ok\":") + (ok ? "true" : "false") + ",\"datei\":\"" + jsonText(jsonFeld(*z, "datei")) + "\"}"); }
      else if (c == "zustand_laden") { bool ok = zustandLaden(jsonFeld(*z, "datei")); melden(std::string("{\"e\":\"zustand\",\"was\":\"geladen\",\"ok\":") + (ok ? "true" : "false") + "}"); }
      else if (c == "ende") beenden(0);
      delete z; return 0;
    }
    case WM_AW_ELTERN_WEG: L("Eltern-Prozess weg (stdin zu) – beende"); beenden(0); return 0;
  }
  return DefWindowProcW(h, m, w, l);
}

/** --slot <datei> <klasse> <id> <zustandsdatei> */
static int slot(const char *pfad, const char *cidHexText, const char *id, const char *zustand) {
  gSlotModus = true; gZustandDatei = zustand ? zustand : "";
  gHost.logEdits = false;
  InitializeCriticalSection(&gProcCs);
  Plugin p; gP = &p;
  auto fehler = [&](const char *text) {
    L("SLOT-FEHLER: %s", text);
    melden(std::string("{\"e\":\"fehler\",\"text\":\"") + jsonText(text) + "\"}");
    return 2;
  };
  if (!pluginOeffnen(p, pfad, cidHexText)) return fehler("Plug-in liess sich nicht öffnen (Einzelheiten im Log)");
  if (!pluginStereo(p)) return fehler("Plug-in unterstützt keinen Stereo-Effektbetrieb");
  gRate = 48000;
  if (!pluginStarten(p, gRate, 4096)) return fehler("Plug-in liess sich nicht starten");

  // Nachrichtenfenster (UI-Thread: Befehle, Editor, Umstellen)
  HINSTANCE hi = GetModuleHandleW(nullptr);
  WNDCLASSW wc; memset(&wc, 0, sizeof wc); wc.lpfnWndProc = msgProc; wc.hInstance = hi; wc.lpszClassName = L"AmberwaveVstSteuerung";
  RegisterClassW(&wc);
  gMsgWnd = CreateWindowExW(0, wc.lpszClassName, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, hi, nullptr);

  // gespeicherten Zustand zurückholen
  bool zustandDa = zustandLaden(gZustandDatei);
  bool editor = false;
  if (p.ctrl) { IPlugView *v = p.ctrl->createView(Vst::ViewType::kEditor); if (v) { editor = v->isPlatformTypeSupported(kPlatformTypeHWND) == kResultTrue; v->release(); } }

  // gemeinsamer Speicher + Ereignisse
  char key[96]; snprintf(key, sizeof key, "awvst_%lu_%s", GetCurrentProcessId(), id ? id : "0"); gKey = key;
  std::string nm = gKey + "_m", ne = gKey + "_e", na = gKey + "_a";
  gMap = CreateFileMappingA(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, sizeof(VstShm), nm.c_str());
  if (!gMap) return fehler("Speicher nicht anlegbar");
  gShm = (VstShm *)MapViewOfFile(gMap, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(VstShm));
  if (!gShm) return fehler("Speicher nicht abbildbar");
  memset(gShm, 0, sizeof(VstShm)); gShm->rate = gRate;
  gEvEin = CreateEventA(nullptr, FALSE, FALSE, ne.c_str());
  gEvAus = CreateEventA(nullptr, FALSE, FALSE, na.c_str());
  if (!gEvEin || !gEvAus) return fehler("Ereignisse nicht anlegbar");
  HANDLE at = CreateThread(nullptr, 0, audioThread, nullptr, 0, nullptr);
  CreateThread(nullptr, 0, stdinThread, nullptr, 0, nullptr);

  melden("{\"e\":\"bereit\",\"name\":\"" + jsonText(p.name) + "\",\"latenz\":" + std::to_string(p.latenz) + ",\"editor\":" + (editor ? "true" : "false") +
         ",\"zustand\":" + (zustandDa ? "true" : "false") + ",\"parameter\":" + std::to_string(p.ctrl ? p.ctrl->getParameterCount() : 0) +
         ",\"shm\":\"" + jsonText(nm) + "\",\"ein\":\"" + jsonText(ne) + "\",\"aus\":\"" + jsonText(na) + "\"}");
  L("Slot %s bereit: %s", id, p.name.c_str());

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) { TranslateMessage(&msg); DispatchMessageW(&msg); }
  gStopp = true; SetEvent(gEvEin);
  WaitForSingleObject(at, 2000);
  pluginSchliessen(p);
  L("Slot beendet, %ld Reglerbewegungen", gEditZahl);
  return 0;
}

/* ====================================================================== main ====================================================================== */

int main(int argc, char **argv) {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
  logOeffnen();
  SetUnhandledExceptionFilter(absturz);
  // Schärfe und Flüssigkeit der Plug-in-Oberfläche: DPI-bewusst (sonst skaliert Windows das Fenster als Bild) und 1-ms-Zeitgeber
  // (ohne ihn laufen WM_TIMER-Animationen der Plug-ins in 15,6-ms-Schritten ruckelig)
  { typedef BOOL(WINAPI * DpiFn)(HANDLE); DpiFn f = (DpiFn)GetProcAddress(GetModuleHandleA("user32.dll"), "SetProcessDpiAwarenessContext");
    if (f) L("DPI-Modus: %s", f((HANDLE)-4) ? "Per-Monitor v2" : "nicht gesetzt"); }
  { typedef UINT(WINAPI * TbFn)(UINT); HMODULE wm = LoadLibraryA("winmm.dll"); TbFn tb = wm ? (TbFn)GetProcAddress(wm, "timeBeginPeriod") : nullptr; if (tb) tb(1); }
  CoInitializeEx(nullptr, 0x2);   // viele Plug-ins (und ihre Oberflächen) erwarten COM im Hauptthread
  L("=== amberwave-vsthost gestartet: %s %s %s", argc > 1 ? argv[1] : "", argc > 2 ? argv[2] : "", argc > 3 ? argv[3] : "");
  if (argc >= 3 && !strcmp(argv[1], "--scan")) return scannen(argv[2]);
  if (argc >= 4 && !strcmp(argv[1], "--probe")) return probe(argv[2], argv[3], argc > 4 ? atof(argv[4]) : 3.0);
  if (argc >= 5 && !strcmp(argv[1], "--slot")) return slot(argv[2], argv[3], argv[4], argc > 5 ? argv[5] : "");
  if (argc >= 4 && !strcmp(argv[1], "--editor")) return editor(argv[2], argv[3], argc > 4 ? atof(argv[4]) : 0.0);
  fprintf(stderr, "Aufruf: --scan <datei> | --probe <datei> <klasse> [sek] | --editor <datei> <klasse> [sek]\n");
  return 1;
}
