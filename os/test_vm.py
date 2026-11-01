#!/usr/bin/env python3
"""Amberwave OS in einer virtuellen Maschine durchspielen (GitHub Actions, QEMU mit KVM):
Stick starten → Einrichtung im Browser per API → auf die leere virtuelle SSD installieren → Stick „abziehen“ →
Neustart von der SSD → Amberwave antwortet. Bildschirmfotos der Konsole landen in <ausgabe>.
  test_vm.py <image> <ausgabe> [kanal]"""
import json, os, socket, subprocess, sys, time, urllib.request

IMG, AUS = sys.argv[1], sys.argv[2]
KANAL = sys.argv[3] if len(sys.argv) > 3 else 'main'
os.makedirs(AUS, exist_ok=True)
QMP = os.path.join(AUS, 'qmp.sock')
BASIS = 'http://127.0.0.1:8080'
ergebnis = []


def melden(art, titel, text):
    print(f'::{art} title={titel}::{text}', flush=True)
    ergebnis.append(f'{titel}: {text}')


def holen(pfad, daten=None, zeit=10):
    req = urllib.request.Request(BASIS + pfad, data=json.dumps(daten).encode() if daten is not None else None,
                                 headers={'Content-Type': 'application/json'} if daten is not None else {})
    with urllib.request.urlopen(req, timeout=zeit) as r:
        return json.loads(r.read() or b'{}')


class Qmp:
    def __init__(self):
        for _ in range(50):
            try:
                self.s = socket.socket(socket.AF_UNIX); self.s.connect(QMP); break
            except OSError:
                time.sleep(0.2)
        self.f = self.s.makefile('rw')
        self.f.readline(); self.rufen('qmp_capabilities')

    def rufen(self, befehl, **arg):
        self.f.write(json.dumps({'execute': befehl, 'arguments': arg} if arg else {'execute': befehl}) + '\n'); self.f.flush()
        while True:
            z = json.loads(self.f.readline())
            if 'return' in z or 'error' in z:
                return z


def foto(q, name):
    q.rufen('screendump', filename=os.path.join(AUS, name + '.png'), format='png')


def warten(bedingung, sekunden, was):
    ende = time.time() + sekunden
    while time.time() < ende:
        try:
            r = bedingung()
            if r:
                return r
        except RuntimeError:
            raise
        except Exception:
            pass
        time.sleep(3)
    raise TimeoutError(was)


subprocess.run(['qemu-img', 'create', '-f', 'qcow2', os.path.join(AUS, 'ssd.qcow2'), '32G'], check=True, capture_output=True)
subprocess.run(['cp', '/usr/share/OVMF/OVMF_VARS_4M.fd', os.path.join(AUS, 'vars.fd')], check=True)
vm = subprocess.Popen(['qemu-system-x86_64', '-machine', 'q35,accel=kvm', '-cpu', 'host', '-m', '4096', '-smp', '2',
    '-drive', 'if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd', '-drive', f'if=pflash,format=raw,file={AUS}/vars.fd',
    '-drive', f'if=none,id=ssd,file={AUS}/ssd.qcow2,format=qcow2', '-device', 'virtio-blk-pci,drive=ssd,bootindex=2',
    '-device', 'qemu-xhci,id=xhci', '-drive', f'if=none,id=stick,file={IMG},format=raw,snapshot=on', '-device', 'usb-storage,drive=stick,id=stickgeraet,bootindex=1',
    '-netdev', 'user,id=netz,hostfwd=tcp::8080-:80', '-device', 'virtio-net-pci,netdev=netz',
    '-display', 'none', '-vga', 'std', '-serial', f'file:{AUS}/seriell.log', '-qmp', f'unix:{QMP},server,nowait'])
q = Qmp()
t0 = time.time()
try:
    info = warten(lambda: holen('/api/info'), 300, 'Einrichtung antwortet nicht')
    melden('notice', 'Live-System', f'Einrichtung nach {int(time.time() - t0)} s erreichbar · Platten: ' + ', '.join(f"{p['name']} {p['groesse'] // 2**30} GB {p['art']}" for p in info['platten']))
    time.sleep(3); foto(q, '1-live-konsole')
    ziel = next(p for p in info['platten'] if p['name'].startswith('vd'))
    r = holen('/api/installieren', {'platte': ziel['name'], 'name': 'amberwave', 'kanal': KANAL, 'musik': {'art': 'intern'}, 'zeitzone': 'Europe/Berlin'})
    if not r.get('ok'):
        raise RuntimeError('Installation abgelehnt: ' + json.dumps(r))
    t1 = time.time()
    def fertig():
        s = holen('/api/stand')
        if s.get('fehler'):
            raise SystemExit('Installation fehlgeschlagen: ' + s['fehler'])
        return s if s.get('fertig') else None
    try:
        warten(fertig, 900, 'Installation wird nicht fertig')
    except SystemExit as e:
        melden('error', 'Installation', str(e))
        try:
            z = holen('/api/protokoll').get('zeilen', [])[-25:]
            print('::error title=Protokoll der Installation::' + '%0A'.join(x.replace('%', '%25')[:200] for x in z), flush=True)
        except Exception:
            pass
        raise
    melden('notice', 'Installation', f'fertig nach {int(time.time() - t1)} s')
    foto(q, '2-installiert')
    q.rufen('device_del', id='stickgeraet')   # Stick abziehen → das Gerät startet von selbst neu
    t2 = time.time()
    def weg():
        try:
            holen('/api/info', zeit=3); return None
        except Exception:
            return True
    warten(weg, 120, 'Das Gerät startet nach dem Abziehen des Sticks nicht neu')
    melden('notice', 'Neustart', f'{int(time.time() - t2)} s nach dem Abziehen des Sticks')
    def bereit():
        log = open(os.path.join(AUS, 'seriell.log'), errors='replace').read()
        if log.count('Docker startet') > 120:
            raise RuntimeError('Docker kommt nicht hoch')
        x = holen('/api/v1/ping')
        return x if x.get('app') == 'amberwave' else None
    j = warten(bereit, 1500, 'Amberwave antwortet nach dem Neustart nicht')
    melden('notice', 'Erster Start', f"Amberwave {j.get('version')} antwortet {int(time.time() - t2)} s nach dem Abziehen des Sticks (inkl. Laden des Containers)")
    time.sleep(5); foto(q, '3-amberwave-laeuft')
    with urllib.request.urlopen(BASIS + '/', timeout=10) as r:
        melden('notice', 'Weboberfläche', f'{r.status} {r.geturl().replace(BASIS, "")}')
except Exception as e:
    melden('error', 'VM-Test', f'{type(e).__name__}: {e}')
    try:   # die letzten Zeilen der seriellen Konsole als Anmerkung (Logs des Laufs sind sonst nur im Browser zu sehen)
        alle = [z for z in open(os.path.join(AUS, 'seriell.log'), errors='replace').read().replace('\r', '').splitlines() if z.strip()]
        wichtig = [z for z in alle if 'Docker startet' not in z and any(w in z for w in ('docker', 'Docker', 'containerd', 'FAILED', 'level=', 'error', 'Error', 'amberwave]'))]
        zeilen = (wichtig[-40:] or alle[-45:])
        print('::error title=Konsole des Geräts::' + '%0A'.join(z.replace('%', '%25')[:180] for z in zeilen), flush=True)
    except Exception:
        pass
    try: foto(q, '9-fehler')
    except Exception: pass
    vm.kill()
    sys.exit(1)
finally:
    try: q.rufen('quit')
    except Exception: pass
    vm.wait(timeout=30)
