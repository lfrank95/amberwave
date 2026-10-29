#!/usr/bin/env python3
"""Testsignal für den DSP-Vergleich: float32, verschachtelt, kanäle × samples. Aufruf: signal.py <rate> <kanäle> <datei>"""
import sys, numpy as np
sr, kan, datei = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
rng = np.random.default_rng(7)
t = lambda s: np.arange(int(s * sr)) / sr
teile = []
def stereo(l, r): return np.stack([l, r])
x = t(0.5); teile.append(stereo(0.5 * np.sin(2*np.pi*100*x), 0.5 * np.sin(2*np.pi*1000*x)))           # Sinus −6 dBFS
x = t(0.5); f = 20 * (1000 ** (x / 0.5)); ph = 2*np.pi*np.cumsum(f)/sr                                     # Sweep 20 Hz … 20 kHz
teile.append(stereo(0.7 * np.sin(ph), 0.7 * np.sin(ph + 0.3)))
x = t(0.5); teile.append(stereo(0.25 * rng.standard_normal(len(x)), 0.25 * rng.standard_normal(len(x))))  # Rauschen
teile.append(np.zeros((2, int(0.3 * sr))))                                                                # Stille
x = t(0.4); b = np.sign(np.sin(2*np.pi*3*x)) * (np.sin(2*np.pi*60*x) > 0.2)                               # harte Spitzen 0 dBFS
teile.append(stereo(0.98 * b, -0.9 * b))
x = t(1.8)                                                                                                # „Musik“: Akkorde mit Hüllkurve
env = np.abs(np.sin(2*np.pi*1.7*x)) ** 0.5
l = sum(a * np.sin(2*np.pi*f0*x) for a, f0 in [(0.3, 110), (0.2, 220), (0.15, 330), (0.1, 1760), (0.05, 7040), (0.02, 14000)])
r = sum(a * np.sin(2*np.pi*f0*x + 1) for a, f0 in [(0.3, 82.4), (0.2, 247), (0.15, 659), (0.1, 2637), (0.05, 9000)])
teile.append(stereo(l * env, r * env * 0.8))
sig = np.concatenate(teile, axis=1)
if kan == 1: sig = sig[:1]
elif kan > 2:
    extra = [0.3 * sig[0] + 0.2 * sig[1], 0.1 * np.sin(2*np.pi*45*np.arange(sig.shape[1])/sr), 0.5 * sig[1], 0.4 * sig[0]]
    sig = np.concatenate([sig, np.array(extra[:kan-2])])
sig.T.astype(np.float32).tofile(datei)
print(sig.shape[1])
