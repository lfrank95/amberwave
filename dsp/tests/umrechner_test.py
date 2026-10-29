#!/usr/bin/env python3
"""Abtastraten-Umrechnung (dsp/umrechner.c): Sinus in Stücken durch den Umrechner, Rest gegen den idealen Sinus (mit der
Filterlaufzeit), Spiegel/Alias neben einem Ton knapp unter der Nyquist-Grenze. Grenze −140 dB."""
import os
W = os.environ.get('AW_TESTDIR', '/tmp/aw_dsp_test'); os.makedirs(W, exist_ok=True)
HIER = os.path.dirname(os.path.abspath(__file__))
import subprocess as _sp
_sp.run(['gcc', '-O2', '-o', f'{W}/src_c', f'{HIER}/src_c.c', f'{HIER}/../umrechner.c', '-lm'], check=True)
os.chdir(W)
import numpy as np, subprocess, sys
def lauf(x, re, ra, st):
    x.astype(np.float32).tofile('s_in.f32')
    r=subprocess.run(['./src_c','s_in.f32',str(re),str(ra),'s_out.f32',str(st)],capture_output=True,text=True)
    m,verz,T,zeit=r.stderr.split()
    return np.fromfile('s_out.f32',np.float32).astype(float), float(verz)*ra/re, int(T), float(zeit)
fehler=0
for re,ra in ((44100,96000),(44100,192000),(48000,96000),(88200,96000),(96000,44100),(192000,48000),(44100,48000),(48000,44100),(176400,96000)):
    zeilen=[]; tmax=0
    for f0 in (1000, 10000, 0.45*min(re,ra)):
        for st in (777, 4096):
            n=int(re*2); t=np.arange(n)/re; x=0.5*np.sin(2*np.pi*f0*t)
            y,d,T,zeit=lauf(x,re,ra,st); tmax=max(tmax,zeit/2)
            idx=np.arange(int(ra*0.5),int(ra*1.5)); ref=0.5*np.sin(2*np.pi*f0*(idx-d)/ra)
            rest=20*np.log10(np.sqrt(np.mean((y[idx]-ref)**2))/(0.5/np.sqrt(2)))
            if st==777: zeilen.append(f'{f0/1000:.1f} kHz {rest:.0f} dB')
            fehler += rest > -140
    # Spiegel/Alias: Ton knapp unter der kleineren Nyquist-Grenze, Störungen außerhalb seiner Frequenz
    f0=0.44*min(re,ra); n=int(re*2); x=0.5*np.sin(2*np.pi*f0*np.arange(n)/re)
    y,d,T,_=lauf(x,re,ra,4096); seg=y[int(ra*0.5):int(ra*0.5)+65536]*np.kaiser(65536,20); S=np.abs(np.fft.rfft(seg)); fr=np.fft.rfftfreq(65536,1/ra)
    k=np.argmax(S); maske=np.abs(fr-fr[k])>200; stoer=20*np.log10(S[maske].max()/S[k])
    fehler += stoer > -140
    print(f'{re:6}→{ra:6} (T={T}): ' + ' | '.join(zeilen) + f' | Spiegel/Alias {stoer:.0f} dB | {tmax*100:.1f} % Echtzeit (mono)')
print('✓ alles sauber' if not fehler else f'✗ {fehler}')

sys.exit(1 if fehler else 0)
