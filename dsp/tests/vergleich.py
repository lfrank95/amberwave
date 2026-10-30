#!/usr/bin/env python3
"""DSP-Vergleich: jedes Gerät mit denselben Signalen und Abläufen durch zwei Umsetzungen.
Aufruf: vergleich.py [art …]  (ohne Angabe: alle). VERGLEICH=c-wasm (Standard): C-Bibliothek (Windows-Client) gegen das
WebAssembly-Worklet, so wie es im Browser läuft (app/js/dsp-worklet.js + aw-dsp.wasm). VERGLEICH=js-c: die alten JS-Worklets
gegen C (nur noch für Glow, Iron und EQ gleich – Silk rechnet seit 0.9.1-beta.3 mit 8× statt 4× und exakter Kennlinie). Grenze: Abweichung < −140 dB (die Übersetzung liegt bei −165 … −190 dB, Float-Rundung) (bezogen auf das Ausgangssignal)."""
import os, subprocess, sys, numpy as np
HIER = os.path.dirname(os.path.abspath(__file__))
W = '/tmp/dspv'
os.makedirs(W, exist_ok=True)
C_PROG = f'{W}/c_ref'
QUELLEN = [f'{HIER}/../{d}' for d in ('gemeinsam.c', 'glow.c', 'iron.c', 'silk.c', 'eq.c', 'schwerpunkt.c')]
subprocess.run(['gcc', '-O2', '-o', C_PROG, f'{HIER}/c_ref.c', *[q for q in QUELLEN if os.path.exists(q)], '-lm'], check=True)

MODUS = os.environ.get('VERGLEICH', 'c-wasm')

ABLAEUFE = {
  'glow': {
    'std': "0 set drive 3\n0 set bias 0.2\n0 set ton 0.5\n0 set mix 0.85\n0 set vert 0.5\n0 messen 1\n250 set drive 8\n250 set vert 0.8\n500 set bias -0.1\n600 delta 1\n800 delta 0\n900 set ton 0.05\n1000 set auto 0\n",
    'hq': "0 set drive 4\n0 set bias 0.3\n0 set hq 1\n0 set mix 1\n0 messen 1\n300 set drive 12\n500 set vert 0.2\n650 delta 1\n850 delta 0\n950 set bias 0.05\n",
    'roehre': "0 set drive 3\n0 set bias 0.2\n0 set ton 0.5\n0 set mix 0.9\n0 set roehre au7\n0 messen 1\n200 set roehre at7\n350 set gegentakt 1\n350 set symm 0.8\n500 set symm 0.3\n600 delta 1\n750 delta 0\n800 set roehre sn7\n900 set gegentakt 0\n1000 set roehre ax7\n",
    'roehre_hq': "0 set drive 4\n0 set bias 0.3\n0 set hq 1\n0 set mix 1\n0 set roehre at7\n0 messen 1\n250 set gegentakt 1\n250 set symm 0.85\n400 set roehre au7\n550 set symm 0.4\n650 delta 1\n800 delta 0\n900 set roehre sn7\n950 set gegentakt 0\n",
  },
  'iron': {
    'std': "0 set drive 2\n0 set kern stahl\n0 set quelle studio\n0 set glanz 0.6\n0 set mix 1\n0 messen 1\n300 set drive 6\n400 set kern eisen\n500 set vert 0.2\n600 delta 1\n800 delta 0\n900 set auto 0\n1000 set mix 0.6\n",
    'hq': "0 set drive 3\n0 set kern nickel\n0 set quelle roehre\n0 set hq 1\n0 messen 1\n300 set drive 9\n450 set vert 0.85\n600 delta 1\n800 delta 0\n900 set kern stahl\n",
  },
  'silk': {
    'std': "0 set drive 1.5\n0 set ips 15\n0 set bias 0.5\n0 set band sm900\n0 set norm nab\n0 set mix 1\n0 messen 1\n300 set drive 4\n400 set ips 7.5\n500 set vert 0.8\n600 delta 1\n800 delta 0\n900 set band sm468\n1000 set kopf 0\n",
    'hq': "0 set drive 2\n0 set ips 15\n0 set hq 1\n0 set gleichlauf 0.5\n0 set rauschen 1\n0 set unperfekt 1\n0 messen 1\n200 set mix 0.6\n300 set drive 5\n400 set norm ccir\n500 set vert 0.3\n600 delta 1\n800 delta 0\n900 set bias 0.2\n1000 set ips 30\n",
  },
  'eq': {
    'std': "0 set k 1.02,-1.9,0.89,-1.9,0.91,0.98,-1.5,0.6,-1.5,0.58\n0 set gain 0.9\n300 set k 1.1,-1.7,0.7,-1.72,0.79,1,0,0,0,0,0.95,-1.2,0.5,-1.21,0.46\n300 set gain 1.2\n700 set k 1,0,0,0,0\n",
  },
}

def lauf(art, sr, kan, name, ablauf, seed=12345):
    sig = f'{W}/sig_{sr}_{kan}.f32'
    if not os.path.exists(sig):
        subprocess.run([sys.executable, f'{HIER}/testsignal.py', str(sr), str(kan), sig], check=True, capture_output=True)
    ab = f'{W}/{art}_{name}.txt'
    open(ab, 'w').write(ablauf)
    erg = {}
    progs = {'js': ['node', f'{HIER}/js_ref.mjs'], 'c': [C_PROG], 'wasm': ['node', f'{HIER}/wasm_ref.mjs']}
    ref, kand = MODUS.split('-')
    for wer, prog in (('js', progs[ref]), ('c', progs[kand])):
        aus, mess = f'{W}/{art}_{name}_{sr}_{kan}_{wer}.f32', f'{W}/{art}_{name}_{sr}_{kan}_{wer}.txt'
        subprocess.run([*prog, art, str(sr), str(kan), sig, ab, aus, mess, str(seed)], check=True)
        erg[wer] = (np.fromfile(aus, dtype=np.float32).astype(np.float64), open(mess).read().split('\n'))
    a, b = erg['js'][0], erg['c'][0]
    rms = np.sqrt(np.mean(a * a)) or 1e-30
    diff = np.sqrt(np.mean((a - b) ** 2))
    db = 20 * np.log10(max(diff, 1e-30) / rms)
    spitze = np.max(np.abs(a - b))
    mj = [z for z in erg['js'][1] if z]; mc = [z for z in erg['c'][1] if z]
    m_ok = len(mj) == len(mc) and all(abs(float(x.split()[1]) - float(y.split()[1])) < 1e-4 + 1e-3 * abs(float(x.split()[1])) and x.split()[0] == y.split()[0] for x, y in zip(mj, mc))
    ok = db < -140 and m_ok and np.all(np.isfinite(b))
    print(f"  {'✓' if ok else '✗'} {art:4} {name:4} {sr:6} Hz {kan} Kan.: Abweichung {db:7.1f} dB (Spitze {spitze:.2e}), Messungen {len(mc)}/{len(mj)} {'gleich' if m_ok else 'ABWEICHEND'}")
    return ok

arten = sys.argv[1:] or [a for a in ABLAEUFE if not ('wasm' in MODUS and a == 'eq')]
fehler = 0
for art in arten:
    for name, ablauf in ABLAEUFE[art].items():
        for sr in (44100, 48000, 96000, 192000):
            fehler += not lauf(art, sr, 2, name, ablauf)
        if name == 'std':
            for kan in (1, 6):
                fehler += not lauf(art, 48000, kan, name, ablauf)
print('\n' + ('✓ alles gleich' if not fehler else f'✗ {fehler} Abweichungen'))
sys.exit(1 if fehler else 0)
