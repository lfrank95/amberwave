// ASIO-Schnittstelle (Treiber-ABI), eigene Beschreibung ohne das Steinberg-SDK: Typen, Konstanten und die Methodentabelle
// eines ASIO-Treibers (COM-Objekt, x64). ASIO ist eine Marke der Steinberg Media Technologies GmbH.
#pragma once
#include <stdint.h>

typedef long ASIOBool;
typedef long ASIOError;
typedef long ASIOSampleType;
typedef double ASIOSampleRate;
typedef struct { unsigned long hi, lo; } ASIOSamples;
typedef struct { unsigned long hi, lo; } ASIOTimeStamp;

enum {
  ASE_OK = 0, ASE_SUCCESS = 0x3f4847a0, ASE_NotPresent = -1000, ASE_HWMalfunction = -999, ASE_InvalidParameter = -998,
  ASE_InvalidMode = -997, ASE_SPNotAdvancing = -996, ASE_NoClock = -995, ASE_NoMemory = -994
};

enum {
  ASIOSTInt16MSB = 0, ASIOSTInt24MSB = 1, ASIOSTInt32MSB = 2, ASIOSTFloat32MSB = 3, ASIOSTFloat64MSB = 4,
  ASIOSTInt32MSB16 = 8, ASIOSTInt32MSB18 = 9, ASIOSTInt32MSB20 = 10, ASIOSTInt32MSB24 = 11,
  ASIOSTInt16LSB = 16, ASIOSTInt24LSB = 17, ASIOSTInt32LSB = 18, ASIOSTFloat32LSB = 19, ASIOSTFloat64LSB = 20,
  ASIOSTInt32LSB16 = 24, ASIOSTInt32LSB18 = 25, ASIOSTInt32LSB20 = 26, ASIOSTInt32LSB24 = 27
};

enum {
  kAsioSelectorSupported = 1, kAsioEngineVersion, kAsioResetRequest, kAsioBufferSizeChange, kAsioResyncRequest,
  kAsioLatenciesChanged, kAsioSupportsTimeInfo, kAsioSupportsTimeCode, kAsioMMCCommand, kAsioSupportsInputMonitor,
  kAsioSupportsInputGain, kAsioSupportsInputMeter, kAsioSupportsOutputGain, kAsioSupportsOutputMeter, kAsioOverload
};

typedef struct {
  long channel;
  ASIOBool isInput;
  ASIOBool isActive;
  long channelGroup;
  ASIOSampleType type;
  char name[32];
} ASIOChannelInfo;

typedef struct {
  ASIOBool isInput;
  long channelNum;
  void *buffers[2];
} ASIOBufferInfo;

typedef struct {
  double speed;
  ASIOTimeStamp systemTime;
  ASIOSamples samplePosition;
  ASIOSampleRate sampleRate;
  unsigned long flags;
  char reserved[12];
} AsioTimeInfo;

typedef struct {
  double speed;
  ASIOSamples timeCodeSamples;
  unsigned long flags;
  char future[64];
} ASIOTimeCode;

typedef struct {
  long reserved[4];
  AsioTimeInfo timeInfo;
  ASIOTimeCode timeCode;
} ASIOTime;

typedef struct {
  long index;
  long associatedChannel;
  long associatedGroup;
  ASIOBool isCurrentSource;
  char name[32];
} ASIOClockSource;

typedef struct {
  void (*bufferSwitch)(long doubleBufferIndex, ASIOBool directProcess);
  void (*sampleRateDidChange)(ASIOSampleRate sRate);
  long (*asioMessage)(long selector, long value, void *message, double *opt);
  ASIOTime *(*bufferSwitchTimeInfo)(ASIOTime *params, long doubleBufferIndex, ASIOBool directProcess);
} ASIOCallbacks;

typedef struct IASIO IASIO;
/* Reihenfolge der virtuellen Methoden: IUnknown, dann die ASIO-Methoden */
typedef struct {
  long (*QueryInterface)(IASIO *, const void *riid, void **obj);
  unsigned long (*AddRef)(IASIO *);
  unsigned long (*Release)(IASIO *);
  ASIOBool (*init)(IASIO *, void *sysHandle);
  void (*getDriverName)(IASIO *, char *name);
  long (*getDriverVersion)(IASIO *);
  void (*getErrorMessage)(IASIO *, char *string);
  ASIOError (*start)(IASIO *);
  ASIOError (*stop)(IASIO *);
  ASIOError (*getChannels)(IASIO *, long *numInputChannels, long *numOutputChannels);
  ASIOError (*getLatencies)(IASIO *, long *inputLatency, long *outputLatency);
  ASIOError (*getBufferSize)(IASIO *, long *minSize, long *maxSize, long *preferredSize, long *granularity);
  ASIOError (*canSampleRate)(IASIO *, ASIOSampleRate sampleRate);
  ASIOError (*getSampleRate)(IASIO *, ASIOSampleRate *sampleRate);
  ASIOError (*setSampleRate)(IASIO *, ASIOSampleRate sampleRate);
  ASIOError (*getClockSources)(IASIO *, ASIOClockSource *clocks, long *numSources);
  ASIOError (*setClockSource)(IASIO *, long reference);
  ASIOError (*getSamplePosition)(IASIO *, ASIOSamples *sPos, ASIOTimeStamp *tStamp);
  ASIOError (*getChannelInfo)(IASIO *, ASIOChannelInfo *info);
  ASIOError (*createBuffers)(IASIO *, ASIOBufferInfo *bufferInfos, long numChannels, long bufferSize, ASIOCallbacks *callbacks);
  ASIOError (*disposeBuffers)(IASIO *);
  ASIOError (*controlPanel)(IASIO *);
  ASIOError (*future)(IASIO *, long selector, void *opt);
  ASIOError (*outputReady)(IASIO *);
} IASIOVtbl;
struct IASIO { const IASIOVtbl *lpVtbl; };
