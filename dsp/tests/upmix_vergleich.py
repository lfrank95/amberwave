#!/usr/bin/env python3
"""Upmix „Zwei Ebenen“: C (dsp/upmix.c) gegen das Worklet (app/js/raumklang-worklet.js), je Ausgang."""
import os, subprocess, sys, numpy as np
HIER = os.path.dirname(os.path.abspath(__file__))
W = os.environ.get('AW_TESTDIR', '/tmp/aw_dsp_test'); os.makedirs(W, exist_ok=True)
PROG = f'{W}/upmix_c'
subprocess.run(['gcc', '-O2', '-o', PROG, f'{HIER}/upmix_c.c', f'{HIER}/../upmix.c', '-lm'], check=True)
NAMEN = ['Raum L', 'Raum R', 'Eff. L', 'Eff. R', 'Front L', 'Front R', 'Center']
fehler = 0
for sr in (44100, 48000, 96000, 192000):
    sig = f'{W}/sig_{sr}_2.f32'
    if not os.path.exists(sig): subprocess.run([sys.executable, f'{HIER}/testsignal.py', str(sr), '2', sig], check=True, capture_output=True)
    for center in (0, 1):
        a_d, b_d = f'{W}/up_{sr}_{center}_js.f32', f'{W}/up_{sr}_{center}_c.f32'
        subprocess.run(['node', f'{HIER}/upmix_ref.mjs', str(sr), sig, a_d, str(center)], check=True)
        subprocess.run([PROG, str(sr), sig, b_d, str(center)], check=True)
        a = np.fromfile(a_d, np.float32).astype(float).reshape(-1, 7); b = np.fromfile(b_d, np.float32).astype(float).reshape(-1, 7)
        werte = []
        ok = a.shape == b.shape and np.all(np.isfinite(b))
        for c in range(7):
            rms = np.sqrt(np.mean(a[:, c] ** 2))
            if rms < 1e-12: werte.append('—'); ok &= np.max(np.abs(b[:, c])) < 1e-9; continue
            d = 20 * np.log10(max(np.sqrt(np.mean((a[:, c] - b[:, c]) ** 2)), 1e-30) / rms)
            werte.append(f'{d:.0f}'); ok &= d < -130
        fehler += not ok
        print(f"  {'✓' if ok else '✗'} {sr:6} Hz Center {center}: " + ', '.join(f'{n} {w}' for n, w in zip(NAMEN, werte)) + ' dB')
print('\n' + ('✓ alles gleich' if not fehler else f'✗ {fehler} Abweichungen'))
sys.exit(1 if fehler else 0)
