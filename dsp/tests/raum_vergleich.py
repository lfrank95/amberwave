#!/usr/bin/env python3
"""Space im Windows Client gegen Chromium: derselbe Graph (raumklangGraph aus der Web-App) einmal in einem
OfflineAudioContext gerendert, einmal über raumnativ.js als Text an dsp/raumgraph.c. Braucht den Test-Server
(AW_TEST_URL, Standard http://127.0.0.1:8095) und Playwright mit Chromium."""
import os, sys, json, base64, asyncio, subprocess, numpy as np
from playwright.async_api import async_playwright
HIER = os.path.dirname(os.path.abspath(__file__))
W = os.environ.get('AW_TESTDIR', '/tmp/aw_dsp_test'); os.makedirs(W, exist_ok=True)
URL = os.environ.get('AW_TEST_URL', 'http://127.0.0.1:8095')
PROG = f'{W}/raum_c'
subprocess.run(['gcc', '-O2', '-o', PROG, f'{HIER}/raum_c.c', f'{HIER}/../raumgraph.c', f'{HIER}/../faltung.c', f'{HIER}/../upmix.c', '-lm'], check=True)

SEITE = r'''
async ({ sr, dauer, preset, kan, mitEreignissen }) => {
  const rk = await import('/js/raumklang.js');
  const { NativKontext } = await import('/js/raumnativ.js');
  const N = Math.round(sr * dauer);
  let a = 7;
  const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), 1 | t); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const L = new Float32Array(N), R = new Float32Array(N);
  let n1 = 0, n2 = 0;
  for (let i = 0; i < N; i++) {
    const t = i / sr, env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.7 * t);
    const mitte = 0.25 * Math.sin(2 * Math.PI * 220 * t) * env + 0.1 * Math.sin(2 * Math.PI * 3300 * t);
    const gegen = 0.12 * Math.sin(2 * Math.PI * 1500 * t + 0.3 * Math.sin(2 * Math.PI * 2 * t));     // gegenphasig → Effekte
    n1 = 0.97 * n1 + 0.03 * (rnd() * 2 - 1); n2 = 0.97 * n2 + 0.03 * (rnd() * 2 - 1);                 // unkorreliert → Raum
    const schlag = (i % Math.round(sr * 0.5)) < 200 ? 0.6 * (rnd() * 2 - 1) : 0;                       // Transienten
    L[i] = mitte + gegen + 2 * n1 + schlag; R[i] = mitte - gegen + 2 * n2 + 0.7 * schlag;
  }
  const layout = rk.layoutFuer(kan), fein = rk.FEIN_STANDARD;
  const ereignisse = (g, aus) => mitEreignissen ? [
    [g.hinten[0].gain, 'ziel', 1.0, 0.2, 0.05], [aus.gain, 'set', 1.5, 1, 0], [aus.gain, 'ramp', 1.6, 0.3, 0], [g.hinten[1].gain, 'ziel', 1.2, 0.5, 0.02],
  ] : [];
  // Chromium
  const ctx = new OfflineAudioContext(layout.kanaele, N, sr);
  await ctx.audioWorklet.addModule('/js/raumklang-worklet.js');
  const buf = ctx.createBuffer(2, N, sr); buf.copyToChannel(L, 0); buf.copyToChannel(R, 1);
  const src = ctx.createBufferSource(); src.buffer = buf;
  const vorne = ctx.createGain(); src.connect(vorne);
  ctx.destination.channelCount = layout.kanaele; ctx.destination.channelCountMode = 'explicit'; ctx.destination.channelInterpretation = 'discrete';
  const zufallAlt = Math.random;
  a = 99; Math.random = rnd;
  const g = rk.raumklangGraph(ctx, vorne, preset, layout, null, fein);
  const aus = ctx.createGain(); g.ausgang.connect(aus); aus.connect(ctx.destination);
  for (const [p, art, t, w, tau] of ereignisse(g, aus)) { if (art === 'ziel') p.setTargetAtTime(w, t, tau); else if (art === 'set') p.setValueAtTime(w, t); else p.linearRampToValueAtTime(w, t); }
  src.start();
  const erg = await ctx.startRendering();
  // Windows Client
  const msgs = [];
  const nk = new NativKontext({ senden: (m) => msgs.push(m), rate: () => sr, kanaele: () => kan });
  const v2 = nk.createGain();
  a = 99;
  const g2 = rk.raumklangGraph(nk, v2, preset, layout, null, fein);
  const aus2 = nk.createGain(); g2.ausgang.connect(aus2);
  const text = nk.graphSenden(v2, aus2);
  Math.random = zufallAlt;
  const ev = ereignisse(g2, aus2).map(([p, art, t, w, tau]) => `${t} ${p.k.id} ${art} ${w} ${tau}`);
  const b64 = (f) => { const b = new Uint8Array(f.buffer, f.byteOffset, f.byteLength); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
  const ausK = []; for (let c = 0; c < erg.numberOfChannels; c++) ausK.push(b64(erg.getChannelData(c)));
  return { text, ev: ev.join('\n'), ir: msgs.filter((m) => m.c === 'raum_ir'), ein: [b64(L), b64(R)], aus: ausK };
}
'''

def f32(s): return np.frombuffer(base64.b64decode(s), dtype=np.float32)

async def main():
    fehler = 0
    env = {k: v for k, v in os.environ.items() if 'proxy' not in k.lower()}
    async with async_playwright() as p:
        br = await p.chromium.launch(env=env, args=['--no-proxy-server'])
        s = await br.new_page()
        await s.goto(URL + '/login.php')
        faelle = [tuple(x) for x in json.loads(os.environ['AW_FAELLE'])] if os.environ.get('AW_FAELLE') else [(48000, 'raum', 6, True), (44100, 'halle', 6, False), (96000, 'live', 6, False), (48000, 'dezent', 4, False), (44100, 'raum', 4, True)]
        for sr, preset, kan, mitEv in faelle:
            d = await s.evaluate(SEITE, {'sr': sr, 'dauer': 3.0, 'preset': preset, 'kan': kan, 'mitEreignissen': mitEv})
            open(f'{W}/raum.txt', 'w').write(d['text']); open(f'{W}/raum_ev.txt', 'w').write(d['ev'])
            for m in d['ir']:
                np.concatenate([f32(m['w.d0']), f32(m['w.d1'])]).tofile(f"{W}/{m['id']}.f32")
            np.stack([f32(d['ein'][0]), f32(d['ein'][1])], 1).tofile(f'{W}/raum_ein.f32')
            ref = np.stack([f32(x) for x in d['aus']], 1).astype(float)
            r = subprocess.run([PROG, f'{W}/raum.txt', W, f'{W}/raum_ein.f32', str(sr), f'{W}/raum_ev.txt', f'{W}/raum_aus.f32', str(ref.shape[1])], capture_output=True, text=True)
            if r.returncode: print(r.stderr); fehler += 1; continue
            c = np.fromfile(f'{W}/raum_aus.f32', np.float32).reshape(-1, ref.shape[1]).astype(float)
            werte, ok = [], True
            for k in range(ref.shape[1]):
                rms = np.sqrt(np.mean(ref[:, k] ** 2))
                if rms < 1e-9: werte.append('—'); ok &= np.max(np.abs(c[:, k])) < 1e-6; continue
                db = 20 * np.log10(max(np.sqrt(np.mean((ref[:, k] - c[:, k]) ** 2)), 1e-30) / rms)
                werte.append(f'{db:.0f}'); ok &= db < -80
            fehler += not ok
            np.save(f'{W}/raum_ref.npy', ref); np.save(f'{W}/raum_c.npy', c)
            print(f"  {'✓' if ok else '✗'} {sr:6} Hz {preset:7} {kan} Kan.{' +Automation' if mitEv else ''}: Abweichung je Kanal " + ', '.join(werte) + ' dB')
        await br.close()
    print('\n' + ('✓ alles gleich' if not fehler else f'✗ {fehler} Abweichungen'))
    return fehler
sys.exit(1 if asyncio.run(main()) else 0)
