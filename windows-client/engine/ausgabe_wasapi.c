// Ausgabe über WASAPI. Exklusiv (bitgenau): das Gerät läuft genau mit Abtastrate und Bittiefe der Datei, Windows mischt
// nichts dazu. Geht das nicht (Gerät belegt, Rate nicht unterstützt), geteilt mit Float und Windows-Umrechnung.
#define INITGUID
#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <ks.h>
#include <ksmedia.h>
#include <avrt.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ausgabe.h"
#include "ausgabe_asio.h"

#ifndef AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
#define AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM 0x80000000
#endif
#ifndef AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
#define AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY 0x08000000
#endif

struct Ausgabe {
  AsioAus *asio;        // ASIO-Gerät (alles Weitere dort)
  IMMDevice *dev;
  IAudioClient *client;
  IAudioRenderClient *render;
  IAudioClock *uhr;
  HANDLE ereignis;
  UINT32 puffer;
  UINT64 frequenz;
  AusInfo info;
  int signal;           // exklusiv: Ereignis kam, ein ganzer Puffer darf geschrieben werden
  int64_t vorlauf;      // Stille vor dem Start (zählt nicht als gespielt)
  int64_t geschrieben;
  int verloren;
};

static __thread int com_an = 0, mmcss_an = 0;

void aus_thread_start(void) {
  if (!com_an && SUCCEEDED(CoInitializeEx(NULL, COINIT_MULTITHREADED))) com_an = 1;
}
void aus_thread_ende(void) {
  if (com_an) { CoUninitialize(); com_an = 0; }
}

static char *utf8(const wchar_t *w) {
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
  char *s = malloc((size_t)(n > 0 ? n : 1));
  if (n > 0) WideCharToMultiByte(CP_UTF8, 0, w, -1, s, n, NULL, NULL); else s[0] = 0;
  return s;
}
static wchar_t *breit(const char *s) {
  int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
  wchar_t *w = malloc(sizeof(wchar_t) * (size_t)(n > 0 ? n : 1));
  if (n > 0) MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n); else w[0] = 0;
  return w;
}

static void json_str(char **o, size_t *len, size_t *kap, const char *s) {
  size_t n = strlen(s) * 6 + 4;
  if (*len + n >= *kap) { *kap = (*len + n) * 2; *o = realloc(*o, *kap); }
  char *p = *o + *len;
  *p++ = '"';
  for (; *s; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') { *p++ = '\\'; *p++ = (char)c; }
    else if (c < 0x20) p += sprintf(p, "\\u%04x", c);
    else *p++ = (char)c;
  }
  *p++ = '"';
  *p = 0;
  *len = (size_t)(p - *o);
}
static void anhaengen(char **o, size_t *len, size_t *kap, const char *s) {
  size_t n = strlen(s);
  if (*len + n + 1 >= *kap) { *kap = (*len + n + 1) * 2; *o = realloc(*o, *kap); }
  memcpy(*o + *len, s, n + 1);
  *len += n;
}

static char *geraet_name(IMMDevice *d) {
  IPropertyStore *ps = NULL;
  char *name = NULL;
  if (SUCCEEDED(IMMDevice_OpenPropertyStore(d, STGM_READ, &ps))) {
    PROPVARIANT v; PropVariantInit(&v);
    if (SUCCEEDED(IPropertyStore_GetValue(ps, &PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR) name = utf8(v.pwszVal);
    PropVariantClear(&v);
    IPropertyStore_Release(ps);
  }
  return name ? name : strdup("Unbekanntes Gerät");
}

char *aus_geraete_json(void) {
  aus_thread_start();
  IMMDeviceEnumerator *en = NULL;
  size_t len = 0, kap = 1024;
  char *o = malloc(kap); o[0] = 0;
  anhaengen(&o, &len, &kap, "[");
  if (FAILED(CoCreateInstance(&CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL, &IID_IMMDeviceEnumerator, (void **)&en))) { anhaengen(&o, &len, &kap, "]"); return o; }
  wchar_t *std_id = NULL;
  IMMDevice *std = NULL;
  if (SUCCEEDED(IMMDeviceEnumerator_GetDefaultAudioEndpoint(en, eRender, eConsole, &std))) { IMMDevice_GetId(std, &std_id); IMMDevice_Release(std); }
  IMMDeviceCollection *col = NULL;
  if (SUCCEEDED(IMMDeviceEnumerator_EnumAudioEndpoints(en, eRender, DEVICE_STATE_ACTIVE, &col))) {
    UINT n = 0;
    IMMDeviceCollection_GetCount(col, &n);
    for (UINT i = 0; i < n; i++) {
      IMMDevice *d = NULL;
      if (FAILED(IMMDeviceCollection_Item(col, i, &d))) continue;
      wchar_t *wid = NULL;
      IMMDevice_GetId(d, &wid);
      char *id = wid ? utf8(wid) : strdup("");
      char *name = geraet_name(d);
      int kan = 2;
      IAudioClient *c = NULL;
      if (SUCCEEDED(IMMDevice_Activate(d, &IID_IAudioClient, CLSCTX_ALL, NULL, (void **)&c))) {
        WAVEFORMATEX *mix = NULL;
        if (SUCCEEDED(IAudioClient_GetMixFormat(c, &mix)) && mix) { kan = mix->nChannels; CoTaskMemFree(mix); }
        IAudioClient_Release(c);
      }
      char tmp[64];
      anhaengen(&o, &len, &kap, i ? ",{\"id\":" : "{\"id\":");
      json_str(&o, &len, &kap, id);
      anhaengen(&o, &len, &kap, ",\"name\":");
      json_str(&o, &len, &kap, name);
      snprintf(tmp, sizeof tmp, ",\"standard\":%s,\"kanaele\":%d}", (wid && std_id && !wcscmp(wid, std_id)) ? "true" : "false", kan);
      anhaengen(&o, &len, &kap, tmp);
      free(id); free(name);
      if (wid) CoTaskMemFree(wid);
      IMMDevice_Release(d);
    }
    IMMDeviceCollection_Release(col);
  }
  if (std_id) CoTaskMemFree(std_id);
  IMMDeviceEnumerator_Release(en);
  asio_geraete_json(&o, &len, &kap);   // ASIO-Treiber hinten an
  anhaengen(&o, &len, &kap, "]");
  return o;
}

static DWORD kanal_maske(int k) {
  switch (k) {
    case 1: return SPEAKER_FRONT_CENTER;
    case 2: return SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT;
    case 3: return SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_FRONT_CENTER;
    case 4: return SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_BACK_LEFT | SPEAKER_BACK_RIGHT;
    case 5: return SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_FRONT_CENTER | SPEAKER_BACK_LEFT | SPEAKER_BACK_RIGHT;
    case 6: return KSAUDIO_SPEAKER_5POINT1;
    case 7: return SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_FRONT_CENTER | SPEAKER_LOW_FREQUENCY | SPEAKER_BACK_CENTER | SPEAKER_SIDE_LEFT | SPEAKER_SIDE_RIGHT;
    case 8: return KSAUDIO_SPEAKER_7POINT1_SURROUND;
    default: return 0;
  }
}

static void wfx_bauen(WAVEFORMATEXTENSIBLE *w, int rate, int kan, AusFormat f, DWORD maske) {
  memset(w, 0, sizeof *w);
  int cont = f == FMT_S16 ? 16 : f == FMT_S24P ? 24 : 32;
  int gueltig = f == FMT_S16 ? 16 : (f == FMT_S24P || f == FMT_S32_24) ? 24 : 32;
  w->Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
  w->Format.nChannels = (WORD)kan;
  w->Format.nSamplesPerSec = (DWORD)rate;
  w->Format.wBitsPerSample = (WORD)cont;
  w->Format.nBlockAlign = (WORD)(kan * cont / 8);
  w->Format.nAvgBytesPerSec = (DWORD)rate * w->Format.nBlockAlign;
  w->Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
  w->Samples.wValidBitsPerSample = (WORD)gueltig;
  w->dwChannelMask = maske ? maske : kanal_maske(kan);
  w->SubFormat = f == FMT_F32 ? KSDATAFORMAT_SUBTYPE_IEEE_FLOAT : KSDATAFORMAT_SUBTYPE_PCM;
}

static const char *hr_text(HRESULT hr) {
  switch (hr) {
    case AUDCLNT_E_DEVICE_IN_USE: return "Gerät wird gerade von einem anderen Programm exklusiv benutzt";
    case AUDCLNT_E_UNSUPPORTED_FORMAT: return "Format vom Gerät nicht unterstützt";
    case AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED: return "Exklusiver Modus ist in den Windows-Soundeinstellungen gesperrt";
    case AUDCLNT_E_DEVICE_INVALIDATED: return "Gerät nicht mehr vorhanden";
    case E_ACCESSDENIED: return "Zugriff verweigert";
    default: return "Gerät lässt sich nicht öffnen";
  }
}

/** Client neu holen (nach einem fehlgeschlagenen Initialize ist er unbrauchbar) */
static HRESULT client_neu(Ausgabe *a) {
  if (a->client) { IAudioClient_Release(a->client); a->client = NULL; }
  return IMMDevice_Activate(a->dev, &IID_IAudioClient, CLSCTX_ALL, NULL, (void **)&a->client);
}

static HRESULT exklusiv_init(Ausgabe *a, WAVEFORMATEXTENSIBLE *w) {
  REFERENCE_TIME std = 0, min = 0;
  IAudioClient_GetDevicePeriod(a->client, &std, &min);
  REFERENCE_TIME periode = 400000;   // 40 ms: Luft für die Klangkette (HQ bei 192 kHz), Regler reagieren trotzdem schnell
  if (periode < min) periode = min;
  HRESULT hr = IAudioClient_Initialize(a->client, AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, periode, periode, (WAVEFORMATEX *)w, NULL);
  if (hr == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED) {
    UINT32 fr = 0;
    IAudioClient_GetBufferSize(a->client, &fr);
    periode = (REFERENCE_TIME)(10000.0 * 1000 * fr / w->Format.nSamplesPerSec + 0.5);
    if (FAILED(client_neu(a))) return hr;
    hr = IAudioClient_Initialize(a->client, AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, periode, periode, (WAVEFORMATEX *)w, NULL);
  }
  return hr;
}

Ausgabe *aus_oeffnen(const char *geraet, int exklusiv, int rate, int kanaele, int bits, AusInfo *info, char *fehler, size_t fn) {
  if (geraet && !strncmp(geraet, "asio:", 5)) {
    (void)exklusiv;
    AsioAus *x = asio_oeffnen(geraet + 5, rate, kanaele, bits, info, fehler, fn);
    if (!x) return NULL;
    Ausgabe *a = calloc(1, sizeof *a); a->asio = x; a->info = *info;
    return a;
  }
  aus_thread_start();
  if (!mmcss_an) { DWORD idx = 0; if (AvSetMmThreadCharacteristicsW(L"Pro Audio", &idx)) mmcss_an = 1; }
  Ausgabe *a = calloc(1, sizeof *a);
  IMMDeviceEnumerator *en = NULL;
  HRESULT hr = CoCreateInstance(&CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL, &IID_IMMDeviceEnumerator, (void **)&en);
  if (FAILED(hr)) { snprintf(fehler, fn, "Audiosystem nicht verfügbar"); free(a); return NULL; }
  if (geraet && *geraet) {
    wchar_t *w = breit(geraet);
    hr = IMMDeviceEnumerator_GetDevice(en, w, &a->dev);
    free(w);
    if (FAILED(hr)) { snprintf(a->info.hinweis, sizeof a->info.hinweis, "Gewähltes Gerät nicht gefunden – Standardgerät"); a->dev = NULL; }
  }
  if (!a->dev) hr = IMMDeviceEnumerator_GetDefaultAudioEndpoint(en, eRender, eConsole, &a->dev);
  IMMDeviceEnumerator_Release(en);
  if (FAILED(hr) || !a->dev) { snprintf(fehler, fn, "Kein Ausgabegerät gefunden"); free(a); return NULL; }
  char *name = geraet_name(a->dev);
  snprintf(a->info.geraet, sizeof a->info.geraet, "%s", name);
  free(name);
  if (FAILED(client_neu(a))) { snprintf(fehler, fn, "Gerät lässt sich nicht öffnen"); aus_schliessen(a); return NULL; }
  WAVEFORMATEX *mix = NULL;
  IAudioClient_GetMixFormat(a->client, &mix);
  int mix_kan = mix ? mix->nChannels : 2;
  a->info.geraet_rate = mix ? (int)mix->nSamplesPerSec : rate;
  a->info.geraet_kanaele = mix_kan;
  DWORD mix_maske = mix && mix->wFormatTag == WAVE_FORMAT_EXTENSIBLE ? ((WAVEFORMATEXTENSIBLE *)mix)->dwChannelMask : 0;

  int ok = 0;
  HRESULT letzter = S_OK;
  if (exklusiv) {
    AusFormat folge16[] = {FMT_S16, FMT_S32_24, FMT_S24P, FMT_S32};
    AusFormat folge24[] = {FMT_S32_24, FMT_S24P, FMT_S32, FMT_S16};
    AusFormat folge32[] = {FMT_S32, FMT_S32_24, FMT_S24P, FMT_S16};
    AusFormat *folge = bits <= 16 ? folge16 : bits <= 24 ? folge24 : folge32;
    int kans[3] = {kanaele, mix_kan, 2}, nk = 3;
    for (int ki = 0; ki < nk && !ok; ki++) {
      int k = kans[ki];
      if (ki > 0 && (k == kans[0] || (ki == 2 && k == kans[1]))) continue;
      for (int fi = 0; fi < 4 && !ok; fi++) {
        WAVEFORMATEXTENSIBLE w;
        wfx_bauen(&w, rate, k, folge[fi], k == mix_kan ? mix_maske : 0);   // gleiche Kanalzahl: die Lautsprecher-Maske des Geräts (5.1 hinten oder seitlich)
        // Die Vorab-Frage beantworten manche Treiber falsch (USB-Interfaces): nur „Exklusiv gesperrt“ ernst nehmen,
        // sonst Initialize trotzdem versuchen – das sagt verlässlich, ob es geht
        HRESULT fs = IAudioClient_IsFormatSupported(a->client, AUDCLNT_SHAREMODE_EXCLUSIVE, (WAVEFORMATEX *)&w, NULL);
        if (fs == AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED) { letzter = fs; ki = nk; break; }
        hr = exklusiv_init(a, &w);
        if (SUCCEEDED(hr)) { ok = 1; a->info.fmt = folge[fi]; a->info.kanaele = k; a->info.exklusiv = 1; a->info.geraet_rate = rate; break; }
        letzter = hr;
        client_neu(a);
        if (hr == AUDCLNT_E_DEVICE_IN_USE || hr == AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED) { ki = nk; break; }
      }
    }
    if (!ok) {
      if (letzter == AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED)
        snprintf(a->info.hinweis, sizeof a->info.hinweis, "Nicht exklusiv: in Windows gesperrt – Sound-Einstellungen → Gerät → Erweitert → „Anwendungen haben alleinige Kontrolle“ einschalten");
      else if (letzter == AUDCLNT_E_UNSUPPORTED_FORMAT || letzter == S_OK)
        snprintf(a->info.hinweis, sizeof a->info.hinweis, "Nicht exklusiv: %d Hz / %d Bit nimmt das Gerät exklusiv nicht an (Code 0x%08lX)", rate, bits, (unsigned long)letzter);
      else snprintf(a->info.hinweis, sizeof a->info.hinweis, "Nicht exklusiv: %s (Code 0x%08lX)", hr_text(letzter), (unsigned long)letzter);
    }
  }
  if (!ok) {
    // geteilt: Float, Abtastrate der Quelle, Windows rechnet auf die Geräterate um
    WAVEFORMATEXTENSIBLE w;
    wfx_bauen(&w, rate, mix_kan, FMT_F32, mix_maske);
    hr = IAudioClient_Initialize(a->client, AUDCLNT_SHAREMODE_SHARED,
                                 AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                                 500000, 0, (WAVEFORMATEX *)&w, NULL);
    if (FAILED(hr)) {
      snprintf(fehler, fn, "%s", hr_text(hr));
      if (mix) CoTaskMemFree(mix);
      aus_schliessen(a);
      return NULL;
    }
    a->info.fmt = FMT_F32; a->info.kanaele = mix_kan; a->info.exklusiv = 0;
  }
  if (mix) CoTaskMemFree(mix);
  a->info.rate = rate;
  a->ereignis = CreateEventW(NULL, FALSE, FALSE, NULL);
  IAudioClient_SetEventHandle(a->client, a->ereignis);
  IAudioClient_GetBufferSize(a->client, &a->puffer);
  a->info.puffer_frames = (int)a->puffer;
  if (FAILED(IAudioClient_GetService(a->client, &IID_IAudioRenderClient, (void **)&a->render)) ||
      FAILED(IAudioClient_GetService(a->client, &IID_IAudioClock, (void **)&a->uhr))) {
    snprintf(fehler, fn, "Gerät liefert keinen Ausgabepuffer");
    aus_schliessen(a);
    return NULL;
  }
  IAudioClock_GetFrequency(a->uhr, &a->frequenz);
  *info = a->info;
  return a;
}

static void pruefen(Ausgabe *a, HRESULT hr) { if (hr == AUDCLNT_E_DEVICE_INVALIDATED) a->verloren = 1; }

int aus_warten(Ausgabe *a, int ms) {
  if (a->asio) return asio_warten(a->asio, ms);
  if (WaitForSingleObject(a->ereignis, (DWORD)ms) == WAIT_OBJECT_0) { a->signal = 1; return 1; }
  return 0;
}

int aus_frei(Ausgabe *a) {
  if (a->asio) return asio_frei(a->asio);
  if (a->info.exklusiv) return a->signal ? (int)a->puffer : 0;
  UINT32 pad = 0;
  HRESULT hr = IAudioClient_GetCurrentPadding(a->client, &pad);
  pruefen(a, hr);
  if (FAILED(hr)) return 0;
  return (int)(a->puffer - pad);
}

void *aus_puffer(Ausgabe *a, int frames) {
  if (a->asio) return asio_puffer(a->asio, frames);
  BYTE *p = NULL;
  HRESULT hr = IAudioRenderClient_GetBuffer(a->render, (UINT32)frames, &p);
  pruefen(a, hr);
  return SUCCEEDED(hr) ? p : NULL;
}

int aus_puffer_fertig(Ausgabe *a, int frames) {
  if (a->asio) return asio_puffer_fertig(a->asio, frames);
  HRESULT hr = IAudioRenderClient_ReleaseBuffer(a->render, (UINT32)frames, 0);
  pruefen(a, hr);
  a->signal = 0;
  a->geschrieben += frames;
  return SUCCEEDED(hr) ? 0 : -1;
}

int64_t aus_gespielt(Ausgabe *a) {
  if (a->asio) return asio_gespielt(a->asio);
  UINT64 pos = 0;
  HRESULT hr = IAudioClock_GetPosition(a->uhr, &pos, NULL);
  pruefen(a, hr);
  if (FAILED(hr) || !a->frequenz) return 0;
  int64_t f = (int64_t)((double)pos * a->info.rate / (double)a->frequenz) - a->vorlauf;
  if (f < 0) f = 0;
  if (f > a->geschrieben) f = a->geschrieben;
  return f;
}

int aus_start(Ausgabe *a) {
  if (a->asio) return asio_start(a->asio);
  if (a->geschrieben == 0 && a->vorlauf == 0) {
    // vor dem Start einen Puffer Stille vorlegen (sonst knackt es beim Anlaufen)
    BYTE *p = NULL;
    if (SUCCEEDED(IAudioRenderClient_GetBuffer(a->render, a->puffer, &p))) {
      IAudioRenderClient_ReleaseBuffer(a->render, a->puffer, AUDCLNT_BUFFERFLAGS_SILENT);
      a->vorlauf = a->puffer;
    }
  }
  HRESULT hr = IAudioClient_Start(a->client);
  pruefen(a, hr);
  return SUCCEEDED(hr) ? 0 : -1;
}

int aus_stopp(Ausgabe *a) {
  if (a->asio) return asio_stopp(a->asio);
  HRESULT hr = IAudioClient_Stop(a->client);
  pruefen(a, hr);
  return SUCCEEDED(hr) ? 0 : -1;
}

long aus_unterlaeufe(Ausgabe *a) { return a && a->asio ? asio_unterlaeufe(a->asio) : 0; }
int aus_durchlaufend(Ausgabe *a) { return a && a->asio != NULL; }
int64_t aus_weich_leeren(Ausgabe *a, int ms) { return a && a->asio ? asio_weich_leeren(a->asio, ms) : -1; }
int aus_umleiten(Ausgabe *a, const char *geraet) { return a && a->asio && geraet && !strncmp(geraet, "asio:", 5) ? asio_umleiten(a->asio, geraet + 5) : -1; }
int aus_takt(Ausgabe *a) { return a && a->asio ? asio_takt(a->asio) : -1; }
void aus_protokoll(Ausgabe *a, char *buf, size_t n) { if (a && a->asio) asio_protokoll(buf, n); else snprintf(buf, n, "[]"); }
void aus_nachlauf(Ausgabe *a) { if (a && a->asio) asio_nachlauf(a->asio); }
int aus_ausklingen(Ausgabe *a, int ms) {
  if (a && a->asio) return asio_ausklingen(a->asio, ms);
  (void)ms; return 0;   // WASAPI: Geschriebenes liegt schon im Gerät
}
int aus_zuruecksetzen(Ausgabe *a) {
  if (a->asio) return asio_zuruecksetzen(a->asio);
  IAudioClient_Stop(a->client);
  HRESULT hr = IAudioClient_Reset(a->client);
  pruefen(a, hr);
  a->geschrieben = 0; a->vorlauf = 0; a->signal = 0;
  return SUCCEEDED(hr) ? 0 : -1;
}

void aus_schliessen(Ausgabe *a) {
  if (a && a->asio) { asio_schliessen(a->asio); free(a); return; }
  if (!a) return;
  if (a->client) IAudioClient_Stop(a->client);
  if (a->uhr) IAudioClock_Release(a->uhr);
  if (a->render) IAudioRenderClient_Release(a->render);
  if (a->client) IAudioClient_Release(a->client);
  if (a->dev) IMMDevice_Release(a->dev);
  if (a->ereignis) CloseHandle(a->ereignis);
  free(a);
}

int aus_verloren(Ausgabe *a) {
  if (a->asio) return asio_verloren(a->asio);
  return a->verloren; }

int aus_umstellen(Ausgabe *a, int rate, int kanaele, int bits, AusInfo *info, char *fehler, size_t fn) {
  if (!a || !a->asio) return -1;
  int r = asio_umstellen(a->asio, rate, kanaele, bits, info, fehler, fn);
  if (!r) a->info = *info;
  return r;
}
