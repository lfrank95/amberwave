#!/usr/bin/env python3
"""
Amberwave – Klanganalyse (akustische Ähnlichkeit). Wird vom PHP-Teil im Hintergrund aufgerufen, nie vom Browser.

Befehle:
  pruefen [--modell DIR]                         → JSON: was ist verfügbar (numpy, essentia, Modell)
  analyse --verfahren einfach|modell --liste IN.json [--modell DIR] [--budget SEK]
                                                  → je Titel eine JSON-Zeile {"id", "vektor" (base64, float32), "dim"} oder {"id", "fehler"}
  index --verfahren einfach|modell --ein V.bin --anzahl N --dim D --k K --aus N.bin
                                                  → nächste Nachbarn: N×K int32 (Zeilennummern) + N×K float32 (Ähnlichkeit)

Verfahren „einfach“ (eingebaut, ohne Modell, frei von Lizenzfragen): klassische Merkmale aus drei Ausschnitten je Titel –
  Klangfarbe als Form des Spektrums (40 Mel-Bänder je Rahmen ohne Gesamtpegel: Mittel und Streuung – so zählt nicht, wie laut
  gemastert wurde), Helligkeit/Rauheit (Spektralschwerpunkt, Rolloff, Flachheit, Breite),
  Energie und Dynamik, Nulldurchgänge, Rhythmus (Einsatzstärke, Tempo und dessen Deutlichkeit), Tonalität (Dur/Moll, Klarheit).
Verfahren „einfach3“ (ab 0.1.112, Standard): dieselben 95 Merkmale plus 15 weitere, die Pop von Score, Flächen von Beats und
  Gesang von Instrumentalem trennen – Rhythmus-Charakter (Perkussivität, Kick-Anteil, Einsatzdichte, Takt-Regelmäßigkeit),
  Gesangstendenz (Modulation des Mittenbands im Silbentakt 2–8 Hz), Harmonie-Verlauf (Akkordwechselrate, Chroma-Entropie) und
  Verlauf über das ganze Stück (Unterschiede zwischen den Ausschnitten, Tempo-Stabilität, Dynamikumfang, Crest, Spannungsbogen,
  Lage des Höhepunkts – dafür wird der ganze Titel einmal mit 8 kHz gelesen).
Verfahren „modell“ (nur wenn vom Nutzer installiert): Discogs-EffNet der MTG (Essentia), 1280-dimensionale Einbettung,
  gemittelt über einen Ausschnitt. Das Modell steht unter CC BY-NC-SA 4.0 und wird nicht mit Amberwave ausgeliefert.
"""
import argparse
import base64
import json
import math
import os
import subprocess
import sys
import time

SR = 22050
N_FFT = 2048
HOP = 512
N_MEL = 40
MODELL_DATEI = 'discogs-effnet-bs64-1.pb'
STIL_DATEI = 'genre_discogs400-discogs-effnet-1.pb'          # Kopf: 400 Discogs-Stile aus der Einbettung
STIL_LABELS = 'genre_discogs400-discogs-effnet-1.json'
STIL_TOP = 12
FFMPEG = os.environ.get('FFMPEG', 'ffmpeg')


def drucke(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()


# ---------------------------------------------------------------- Prüfen
def pruefen(args):
    aus = {'python': sys.version.split()[0], 'numpy': False, 'essentia': False, 'modell': False, 'stile': False}
    try:
        import numpy  # noqa: F401
        aus['numpy'] = True
    except Exception:
        pass
    if args.modell:
        pfad = os.path.join(args.modell, MODELL_DATEI)
        aus['modell'] = os.path.isfile(pfad) and os.path.getsize(pfad) > 1_000_000
        sp = os.path.join(args.modell, STIL_DATEI)
        aus['stile'] = os.path.isfile(sp) and os.path.getsize(sp) > 100_000 and os.path.isfile(os.path.join(args.modell, STIL_LABELS))
        try:
            import essentia.standard as es  # noqa: F401
            aus['essentia'] = True
            if aus['modell'] and args.laden:
                es.TensorflowPredictEffnetDiscogs(graphFilename=pfad, output='PartitionedCall:1')
                aus['geladen'] = True
                if aus['stile']:
                    stil_kopf(args.modell)
                    aus['stile_geladen'] = True
        except Exception as e:  # pragma: no cover – nur mit installiertem Modell
            aus['fehler'] = str(e)[:300]
    drucke(aus)


# ---------------------------------------------------------------- Audio laden
def ausschnitte(dauer_s):
    """Bis 50 s: alles; sonst drei Ausschnitte à 20 s bei 20 %, 50 % und 75 % (Intro/Outro zählen weniger)."""
    if dauer_s <= 50:
        return [(0.0, max(5.0, dauer_s))]
    return [(max(0.0, dauer_s * p - 10.0), 20.0) for p in (0.2, 0.5, 0.75)]


def lade(pfad, start, dauer, sr=SR):
    import numpy as np
    befehl = [FFMPEG, '-nostdin', '-v', 'error', '-ss', f'{start:.2f}', '-t', f'{dauer:.2f}', '-i', pfad,
              '-map', '0:a:0', '-ac', '1', '-ar', str(sr), '-f', 'f32le', '-']
    r = subprocess.run(befehl, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode('utf-8', 'replace').strip()[:200] or 'ffmpeg-Fehler')
    return np.frombuffer(r.stdout, dtype=np.float32).astype(np.float64)


# ---------------------------------------------------------------- Verfahren „einfach“
_FB = None
_CHROMA = None
_MELM = None


def mel_filter():
    import numpy as np
    global _FB
    if _FB is None:
        f = np.linspace(0, SR / 2, N_FFT // 2 + 1)
        mel = lambda hz: 2595 * np.log10(1 + hz / 700)  # noqa: E731
        hz = lambda m: 700 * (10 ** (m / 2595) - 1)  # noqa: E731
        punkte = hz(np.linspace(mel(40), mel(SR / 2 * 0.95), N_MEL + 2))
        fb = np.zeros((N_MEL, f.size))
        for i in range(N_MEL):
            l, m, r = punkte[i], punkte[i + 1], punkte[i + 2]
            fb[i] = np.clip(np.minimum((f - l) / (m - l), (r - f) / (r - m)), 0, None)
        fb /= np.maximum(fb.sum(axis=1, keepdims=True), 1e-12)
        _FB = fb
    return _FB


def chroma_matrix():
    import numpy as np
    global _CHROMA
    if _CHROMA is None:
        f = np.linspace(0, SR / 2, N_FFT // 2 + 1)
        c = np.zeros((f.size, 12))
        gueltig = (f >= 60) & (f <= 5000)
        pc = np.round(12 * np.log2(f[gueltig] / 440.0) + 69).astype(int) % 12
        c[np.where(gueltig)[0], pc] = 1.0
        _CHROMA = c
    return _CHROMA


# Krumhansl-Schmuckler-Profile (Dur/Moll)
DUR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MOLL = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


def merkmale_ausschnitt(x):
    import numpy as np
    if x.size < N_FFT * 8:
        return None
    fenster = np.hanning(N_FFT)
    rahmen = np.lib.stride_tricks.sliding_window_view(x, N_FFT)[::HOP]
    spek = np.abs(np.fft.rfft(rahmen * fenster, axis=1)) ** 2 + 1e-12
    f = np.linspace(0, SR / 2, spek.shape[1])
    logmel = 10 * np.log10(spek @ mel_filter().T + 1e-10)
    leistung = spek.sum(axis=1)
    rms_db = 10 * np.log10((rahmen ** 2).mean(axis=1) + 1e-10)
    laut = rms_db > (rms_db.max() - 45)            # Stille (Pausen, Ausklang) nicht mitzählen
    if laut.sum() < 8:
        return None
    s = spek[laut]
    lm = logmel[laut]
    lm = lm - lm.mean(axis=1, keepdims=True)       # Spektralform: Gesamtpegel je Rahmen heraus (Mastering-Lautheit zählt nicht)
    schwer = (s * f).sum(axis=1) / s.sum(axis=1)
    kum = np.cumsum(s, axis=1)
    rolloff = f[np.argmax(kum >= 0.85 * kum[:, -1:], axis=1)]
    flach = np.exp(np.log(s[:, 1:]).mean(axis=1)) / s[:, 1:].mean(axis=1)
    breite = np.sqrt((s * (f - schwer[:, None]) ** 2).sum(axis=1) / s.sum(axis=1))
    zcr = (np.abs(np.diff(np.sign(rahmen[laut]), axis=1)) > 0).mean(axis=1)
    # Rhythmus: Einsatzstärke (positiver Fluss der Mel-Bänder) und Tempo aus ihrer Autokorrelation
    fluss = np.maximum(np.diff(logmel, axis=0), 0).sum(axis=1)
    fz = fluss - fluss.mean()
    ak = np.correlate(fz, fz, mode='full')[fz.size - 1:]
    tempo, deutlich = 120.0, 0.0
    if ak[0] > 0:
        bpm = np.arange(60, 201)
        lags = 60.0 * SR / (HOP * bpm)
        werte = np.interp(lags, np.arange(ak.size), ak) / ak[0]
        i = int(np.argmax(werte))
        tempo, deutlich = float(bpm[i]), float(max(0.0, werte[i]))
    # Tonalität: Chroma → Korrelation mit Dur-/Moll-Profilen (beste Tonart)
    chroma = (s @ chroma_matrix()).mean(axis=0)
    chroma = chroma / (chroma.sum() + 1e-12)
    bestD = max(np.corrcoef(np.roll(DUR, k), chroma)[0, 1] for k in range(12))
    bestM = max(np.corrcoef(np.roll(MOLL, k), chroma)[0, 1] for k in range(12))
    v = np.concatenate([
        lm.mean(axis=0), lm.std(axis=0),                                                    # 80 Klangfarbe
        [np.log(schwer.mean() + 1), np.log(schwer.std() + 1), np.log(rolloff.mean() + 1),
         flach.mean(), np.log(breite.mean() + 1)],                                           # 5 Spektrum
        [rms_db[laut].mean(), rms_db[laut].std(), np.percentile(rms_db[laut], 95) - np.percentile(rms_db[laut], 10)],  # 3 Energie
        [zcr.mean()],                                                                        # 1 Rauheit
        [np.log(fluss.mean() + 1), np.log(fluss.std() + 1)],                                 # 2 Einsätze
        [math.log2(tempo), deutlich],                                                        # 2 Tempo
        [bestD - bestM, max(bestD, bestM)],                                                  # 2 Tonalität
    ])
    return v, int(laut.sum()), {'lm_mittel': lm.mean(axis=0), 'rms': float(rms_db[laut].mean()), 'tempo': math.log2(tempo),
                                'extra': merkmale_extra(spek, logmel, fluss, ak, tempo, laut)}


def merkmale_extra(spek, logmel, fluss, ak, tempo, laut):
    """Die 8 Zusatzmerkmale je Ausschnitt für „einfach3“: Rhythmus (4), Gesangstendenz (2), Harmonie (2)."""
    import numpy as np
    fps = SR / HOP
    melp = 10 ** (logmel / 10)                                    # Mel-Leistung je Rahmen
    # Perkussivität: Medianfilter über die Zeit (harmonisch, ~0,4 s) und über die Bänder (perkussiv), weiche Maske
    def median_zeit(a, k):
        pad = np.pad(a, ((k // 2, k // 2), (0, 0)), mode='edge')
        return np.median(np.lib.stride_tricks.sliding_window_view(pad, k, axis=0), axis=-1)
    def median_band(a, k):
        pad = np.pad(a, ((0, 0), (k // 2, k // 2)), mode='edge')
        return np.median(np.lib.stride_tricks.sliding_window_view(pad, k, axis=1), axis=-1)
    hm = median_zeit(melp, 21) ** 2
    pm = median_band(melp, 5) ** 2
    perk = float((melp * pm / (hm + pm + 1e-12)).sum() / (melp.sum() + 1e-12))
    # Kick-Anteil: Einsätze in den tiefen Bändern (< 150 Hz) am gesamten Einsatzfluss
    tief = mel_mitten() < 150
    dlm = np.maximum(np.diff(logmel, axis=0), 0)
    kick = float(dlm[:, tief].sum() / (dlm.sum() + 1e-12))
    # Einsatzdichte: Spitzen des Flusses (über Mittel + Streuung, Mindestabstand 100 ms) je Sekunde
    schwelle = fluss.mean() + fluss.std()
    kandidaten = np.where((fluss[1:-1] > fluss[:-2]) & (fluss[1:-1] >= fluss[2:]) & (fluss[1:-1] > schwelle))[0] + 1
    letzte, n_ein = -1e9, 0
    for i in kandidaten:
        if i - letzte >= 0.1 * fps:
            n_ein += 1
            letzte = i
    dichte = n_ein / (fluss.size / fps)
    # Takt-Regelmäßigkeit: aus den Einsätzen der tiefen Bänder (< 1 kHz: Kick, Snare, Bass – Gesang stört hier nicht) das
    # Tempo bestimmen und prüfen, wie gut die Autokorrelation bei 1, 2 und 4 Schlägen hält (gleichmäßiger Beat über den Takt)
    ft = np.maximum(np.diff(logmel[:, mel_mitten() < 1000], axis=0), 0).sum(axis=1)
    ft = ft - ft.mean()
    akt = np.correlate(ft, ft, mode='full')[ft.size - 1:]
    reg = 0.0
    if akt[0] > 0:
        bpm = np.arange(60, 201)
        lags = 60.0 * SR / (HOP * bpm)
        werte = np.interp(lags, np.arange(akt.size), akt) / akt[0]
        lag = float(lags[int(np.argmax(werte))])
        reg = float(np.mean([np.interp(m * lag, np.arange(akt.size), akt) for m in (1, 2, 4)]) / akt[0])
        reg = max(0.0, reg)
    # Gesangstendenz: Modulationsspektrum der Mittenbänder (300 Hz–3 kHz). Gesang moduliert im Silbentakt 2–8 Hz;
    # Flächen kaum, Arpeggios/Beats schneller oder sehr regelmäßig
    mitte = (mel_mitten() >= 300) & (mel_mitten() <= 3000)
    env = logmel[:, mitte] - logmel[:, mitte].mean(axis=0)
    env = env * np.hanning(env.shape[0])[:, None]
    ms = np.abs(np.fft.rfft(env, axis=0)) ** 2
    mf = np.fft.rfftfreq(env.shape[0], 1 / fps)
    band = lambda a, b: ms[(mf >= a) & (mf < b)].sum()  # noqa: E731
    gesamt = band(0.5, 20) + 1e-12
    mod_silbe = float(band(2, 8) / gesamt)
    ms_ges = ms[(mf >= 0.5) & (mf < 20)].sum(axis=1)
    mod_spitze = float(math.log2(mf[(mf >= 0.5) & (mf < 20)][int(np.argmax(ms_ges))] + 1e-9)) if ms_ges.size else 0.0
    # Harmonie-Verlauf: Chroma je Rahmen → Wechselrate (L1-Unterschied im Sekundenabstand) und mittlere Entropie
    chroma = spek[laut] @ chroma_matrix()
    chroma = chroma / (chroma.sum(axis=1, keepdims=True) + 1e-12)
    schritt = max(1, int(round(fps)))
    wechsel = float(np.abs(chroma[schritt:] - chroma[:-schritt]).sum(axis=1).mean()) if chroma.shape[0] > schritt else 0.0
    entropie = float((-(chroma * np.log(chroma + 1e-12)).sum(axis=1)).mean() / math.log(12))
    return [perk, kick, math.log(dichte + 1), reg, mod_silbe, mod_spitze, wechsel, entropie]


def mel_mitten():
    import numpy as np
    global _MELM
    if _MELM is None:
        f = np.linspace(0, SR / 2, N_FFT // 2 + 1)
        fb = mel_filter()
        _MELM = (fb * f).sum(axis=1) / (fb.sum(axis=1) + 1e-12)
    return _MELM


def dynamik_ganz(pfad):
    """Der ganze Titel mit 8 kHz mono: Kurzzeit-Pegel (3 s, 1 s Schritt) → Dynamikumfang (P95−P10 der lauten Fenster),
    Crest (Spitze − Effektivwert), Spannungsbogen (lauteste 10 % − erste 15 %), Lage des Höhepunkts (0…1)."""
    import numpy as np
    x = lade(pfad, 0.0, 3600.0, sr=8000)
    if x.size < 8000 * 4:
        return [0.0, 0.0, 0.0, 0.5]
    n = x.size // 8000
    sek = x[:n * 8000].reshape(n, 8000)
    e = (sek ** 2).mean(axis=1)
    kurz = np.convolve(e, np.ones(3) / 3, mode='valid') if n >= 3 else e
    db = 10 * np.log10(kurz + 1e-10)
    laut = db[db > db.max() - 40]
    umfang = float(np.percentile(laut, 95) - np.percentile(laut, 10)) if laut.size > 2 else 0.0
    crest = float(20 * math.log10(np.abs(x).max() + 1e-9) - 10 * math.log10((x ** 2).mean() + 1e-10))
    k = max(1, int(round(db.size * 0.1)))
    anfang = db[:max(1, int(round(db.size * 0.15)))].mean()
    bogen = float(np.sort(db)[-k:].mean() - anfang)
    lage = float(np.argmax(db) / max(1, db.size - 1))
    return [umfang, crest, bogen, lage]


def analyse_einfach3(pfad, dauer_s):
    import numpy as np
    teile = []
    for start, dauer in ausschnitte(dauer_s):
        r = merkmale_ausschnitt(lade(pfad, start, dauer))
        if r is not None:
            teile.append(r)
    if not teile:
        raise RuntimeError('zu kurz oder still')
    gew = np.array([t[1] for t in teile], dtype=np.float64)
    basis = sum(t[0] * t[1] for t in teile) / gew.sum()
    extra = sum(np.array(t[2]['extra']) * t[1] for t in teile) / gew.sum()
    lmm = np.array([t[2]['lm_mittel'] for t in teile])
    verlauf = [float(lmm.std(axis=0).mean()) if len(teile) > 1 else 0.0,
               float(np.std([t[2]['rms'] for t in teile])) if len(teile) > 1 else 0.0,
               float(np.std([t[2]['tempo'] for t in teile])) if len(teile) > 1 else 0.0]
    return np.concatenate([basis, extra, verlauf, dynamik_ganz(pfad)]).astype(np.float32)


def analyse_einfach(pfad, dauer_s):
    import numpy as np
    summe, gewicht = None, 0
    for start, dauer in ausschnitte(dauer_s):
        r = merkmale_ausschnitt(lade(pfad, start, dauer))
        if r is None:
            continue
        v, n, _ = r
        summe = v * n if summe is None else summe + v * n
        gewicht += n
    if summe is None:
        raise RuntimeError('zu kurz oder still')
    return (summe / gewicht).astype(np.float32)


# Gruppen für den Abstand (Index „einfach“): Startindex, Länge, Gewicht
GRUPPEN = [(0, 40, 1.0), (40, 40, 0.6), (80, 5, 0.8), (85, 3, 0.8), (88, 1, 0.3), (89, 2, 0.8), (91, 2, 0.5), (93, 2, 0.4)]
DIM_EINFACH = 95
# einfach3: dazu Rhythmus-Charakter (4), Gesangstendenz (2), Harmonie-Verlauf (2), Verlauf (3) und Dynamik des ganzen Titels (4)
GRUPPEN3 = GRUPPEN + [(95, 4, 1.0), (99, 2, 1.0), (101, 2, 0.6), (103, 3, 0.7), (106, 4, 1.0)]
DIM_EINFACH3 = 110


# ---------------------------------------------------------------- Verfahren „modell“ (Essentia + Discogs-EffNet)
_MODELL = None
_KOPF = None


def stil_kopf(modell_dir):  # pragma: no cover – nur mit installiertem Modell
    """Kopf „genre_discogs400“ (400 Discogs-Stile) laden; None, wenn Datei oder Beschriftung fehlen."""
    global _KOPF
    if _KOPF is None:
        import essentia.standard as es
        pb = os.path.join(modell_dir, STIL_DATEI)
        js = os.path.join(modell_dir, STIL_LABELS)
        if not (os.path.isfile(pb) and os.path.isfile(js)):
            return None
        with open(js, 'r', encoding='utf-8') as f:
            klassen = json.load(f)['classes']
        modell = es.TensorflowPredict2D(graphFilename=pb, input='serving_default_model_Placeholder', output='PartitionedCall:0')
        _KOPF = (modell, klassen)
    return _KOPF


def analyse_modell(pfad, dauer_s, modell_dir):  # pragma: no cover – nur mit installiertem Modell
    """Gibt (Einbettung, Stile) zurück; Stile = Liste der STIL_TOP stärksten [Name, Wert] oder None ohne Stil-Kopf."""
    import numpy as np
    import essentia.standard as es
    global _MODELL
    if _MODELL is None:
        _MODELL = es.TensorflowPredictEffnetDiscogs(graphFilename=os.path.join(modell_dir, MODELL_DATEI), output='PartitionedCall:1')
    # Ausschnitt: bis 90 s aus der Mitte (das Netz rechnet in Fenstern von ~2 s und wird gemittelt)
    start = max(0.0, dauer_s / 2 - 45) if dauer_s > 90 else 0.0
    audio = lade(pfad, start, min(90.0, max(5.0, dauer_s)), sr=16000).astype(np.float32)
    if audio.size < 16000 * 3:
        raise RuntimeError('zu kurz')
    emb = np.asarray(_MODELL(audio))
    if emb.ndim != 2 or emb.shape[0] == 0:
        raise RuntimeError('keine Einbettung')
    stile = None
    try:
        kopf = stil_kopf(modell_dir)
        if kopf:
            pred = np.asarray(kopf[0](emb)).mean(axis=0)
            top = np.argsort(-pred)[:STIL_TOP]
            stile = [[kopf[1][int(i)], round(float(pred[int(i)]), 4)] for i in top]
    except Exception:
        stile = None   # Einbettung bleibt gültig; Stile werden beim nächsten Lauf nachgeholt
    return emb.mean(axis=0).astype(np.float32), stile


def analyse(args):
    with open(args.liste, 'r', encoding='utf-8') as f:
        liste = json.load(f)
    ende = time.time() + args.budget
    for e in liste:
        if time.time() > ende:
            break
        try:
            stile = None
            if args.verfahren == 'modell':
                v, stile = analyse_modell(e['pfad'], float(e.get('dauer', 0)) or 180.0, args.modell)
            elif args.verfahren == 'einfach3':
                v = analyse_einfach3(e['pfad'], float(e.get('dauer', 0)) or 180.0)
            else:
                v = analyse_einfach(e['pfad'], float(e.get('dauer', 0)) or 180.0)
            if not all(math.isfinite(float(x)) for x in v):
                raise RuntimeError('ungültige Werte')
            zeile = {'id': e['id'], 'dim': int(v.size), 'vektor': base64.b64encode(v.tobytes()).decode('ascii')}
            if stile:
                zeile['stile'] = stile
            drucke(zeile)
        except Exception as ex:
            drucke({'id': e['id'], 'fehler': str(ex)[:250]})


# ---------------------------------------------------------------- Index der nächsten Nachbarn
def index(args):
    import numpy as np
    n, d, k = args.anzahl, args.dim, args.k
    v = np.fromfile(args.ein, dtype=np.float32).reshape(n, d).astype(np.float64)
    if args.verfahren.startswith('einfach'):
        # Jede Dimension über die Sammlung standardisieren, dann Gruppen gewichten (jede Gruppe zählt nach Gewicht, nicht nach Größe)
        v = (v - v.mean(axis=0)) / (v.std(axis=0) + 1e-9)
        for start, laenge, gewicht in (GRUPPEN3 if d == DIM_EINFACH3 else GRUPPEN):
            v[:, start:start + laenge] *= gewicht / math.sqrt(laenge)
    else:
        v = v - v.mean(axis=0)   # Zentrieren macht den Kosinus aussagekräftiger
    v /= np.linalg.norm(v, axis=1, keepdims=True) + 1e-12
    v = v.astype(np.float32)
    k = max(1, min(k, n - 1))
    idx = np.zeros((n, k), dtype=np.int32)
    sim = np.zeros((n, k), dtype=np.float32)
    block = 512
    for a in range(0, n, block):
        b = min(n, a + block)
        s = v[a:b] @ v.T
        s[np.arange(b - a), np.arange(a, b)] = -np.inf          # sich selbst ausschließen
        teil = np.argpartition(-s, k - 1, axis=1)[:, :k] if n - 1 > k else np.argsort(-s, axis=1)[:, :k]
        werte = np.take_along_axis(s, teil, axis=1)
        ordnung = np.argsort(-werte, axis=1)
        idx[a:b] = np.take_along_axis(teil, ordnung, axis=1)
        sim[a:b] = np.take_along_axis(werte, ordnung, axis=1)
    with open(args.aus, 'wb') as f:
        f.write(idx.tobytes())
        f.write(np.clip(sim, -1, 1).astype(np.float32).tobytes())
    drucke({'ok': True, 'anzahl': n, 'k': k})


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='befehl', required=True)
    a = sub.add_parser('pruefen'); a.add_argument('--modell'); a.add_argument('--laden', action='store_true')
    a = sub.add_parser('analyse'); a.add_argument('--verfahren', default='einfach'); a.add_argument('--liste', required=True)
    a.add_argument('--modell'); a.add_argument('--budget', type=float, default=45.0)
    a = sub.add_parser('index'); a.add_argument('--verfahren', default='einfach'); a.add_argument('--ein', required=True)
    a.add_argument('--anzahl', type=int, required=True); a.add_argument('--dim', type=int, required=True)
    a.add_argument('--k', type=int, default=40); a.add_argument('--aus', required=True)
    args = p.parse_args()
    {'pruefen': pruefen, 'analyse': analyse, 'index': index}[args.befehl](args)


if __name__ == '__main__':
    main()
