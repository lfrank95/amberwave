#!/usr/bin/env python3
"""WLAN der Einrichtung in einer virtuellen Maschine prüfen (simulierte WLAN-Karten, mac80211_hwsim):
  1. WLAN vom USB-Stick: der Ersteller hat „AW-Test-Heim“ eingetragen → das Gerät bucht sich von selbst ein.
  2. Hotspot: kein Kabel, kein WLAN → „Amberwave-Einrichtung“ geht auf; ein simuliertes Handy verbindet sich, bekommt
     eine Adresse, jede Adresse führt zur Einrichtung (DNS + Captive Portal), es wählt das Heim-WLAN → das Gerät wechselt.
Das Kabel der VM bleibt dran (darüber steuert der Test); mit aw.test=ohne-kabel zählt es für die Einrichtung nicht.
  test_wlan.py <image> <ausgabe>"""
import json, os, re, shutil, subprocess, sys, time, urllib.request

IMG, AUS = sys.argv[1], sys.argv[2]
os.makedirs(AUS, exist_ok=True)
HIER = os.path.dirname(os.path.abspath(__file__))
fehler = 0


def melden(art, titel, text):
    print(f'::{art} title={titel}::{text}', flush=True)


def holen(pfad):
    with urllib.request.urlopen('http://127.0.0.1:8081' + pfad, timeout=10) as r:
        return json.loads(r.read() or b'{}')


def vorbereiten(name, zusatz, wlan=None):
    """Kopie des Images mit Test-Parametern im GRUB-Menü (und ggf. WLAN-Zugang wie vom Ersteller)"""
    ziel = os.path.join(AUS, f'{name}.img')
    shutil.copyfile(IMG, ziel)
    cfg = subprocess.run(['mtype', '-i', f'{ziel}@@1M', '::boot/grub/grub.cfg'], capture_output=True, text=True, check=True).stdout
    cfg = cfg.replace('boot=live toram components quiet', f'boot=live toram components quiet aw.test=wlan aw.wlan=wlan0 {zusatz}'.rstrip(), 1)
    neu = os.path.join(AUS, 'grub.cfg')
    open(neu, 'w').write(cfg)
    subprocess.run(['mcopy', '-o', '-i', f'{ziel}@@1M', neu, '::boot/grub/grub.cfg'], check=True)
    if wlan:
        subprocess.run([sys.executable, os.path.join(HIER, 'wlan_einsetzen.py'), ziel, *wlan], check=True)
    return ziel


def starten(img, name):
    shutil.copyfile('/usr/share/OVMF/OVMF_VARS_4M.ms.fd', os.path.join(AUS, f'{name}-vars.fd'))
    seriell = os.path.join(AUS, f'{name}-seriell.log')
    vm = subprocess.Popen(['qemu-system-x86_64', '-machine', 'q35,accel=kvm,smm=on', '-global', 'driver=cfi.pflash01,property=secure,value=on',
                           '-cpu', 'host', '-m', '3072', '-smp', '2',
                           '-drive', 'if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.secboot.fd',
                           '-drive', f'if=pflash,format=raw,file={AUS}/{name}-vars.fd',
                           '-device', 'qemu-xhci,id=xhci', '-drive', f'if=none,id=stick,file={img},format=raw',
                           '-device', 'usb-storage,drive=stick,bootindex=1',
                           '-netdev', 'user,id=netz,hostfwd=tcp::8081-:80', '-device', 'virtio-net-pci,netdev=netz',
                           '-display', 'none', '-serial', f'file:{seriell}'])
    return vm, seriell


def zeilen(seriell):
    try:
        return re.findall(r'AWTEST (.*?)\r?$', open(seriell, errors='replace').read(), re.M)
    except OSError:
        return []


def warten(bedingung, sekunden):
    ende = time.time() + sekunden
    while time.time() < ende:
        try:
            r = bedingung()
            if r:
                return r
        except Exception:
            pass
        time.sleep(3)
    return None


def heim_adresse(info):
    return next((a for a in info.get('ips', []) if a.startswith('192.168.77.') and a != '192.168.77.1'), None)   # .1 ist der simulierte Router


def lauf(name, titel, zusatz, wlan, pruefen):
    global fehler
    img = vorbereiten(name, zusatz, wlan)
    vm, seriell = starten(img, name)
    t0 = time.time()
    try:
        if not warten(lambda: holen('/api/info'), 300):
            raise RuntimeError('Einrichtung antwortet nicht')
        pruefen(seriell, t0)
    except Exception as x:
        fehler += 1
        log = [z for z in open(seriell, errors='replace').read().splitlines() if re.search(r'AWTEST|wlan|hostapd|wpa|hwsim|amberwave', z, re.I)][-40:]
        melden('error', titel, f'{x} · ' + ' | '.join(zeilen(seriell)) + ' · ' + ' / '.join(log)[-1500:])
    finally:
        vm.terminate()
        try:
            vm.wait(20)
        except subprocess.TimeoutExpired:
            vm.kill()


def stick(seriell, t0):
    info = warten(lambda: (lambda i: i if heim_adresse(i) and i['netz'].get('ssid') else None)(holen('/api/info')), 180)
    if not info:
        raise RuntimeError(f'nicht im Heim-WLAN (Adressen: {holen("/api/info").get("ips")}, Netz: {holen("/api/info").get("netz")})')
    if info['netz'].get('ssid') != 'AW-Test-Heim':
        raise RuntimeError(f'falsches WLAN gemeldet: {info["netz"]}')
    melden('notice', 'WLAN vom Stick', f'eingebucht in „AW-Test-Heim“ als {heim_adresse(info)} nach {int(time.time() - t0)} s')


def hotspot(seriell, t0):
    def fertig():
        z = zeilen(seriell)
        if any(x.startswith('fehler') for x in z):
            raise RuntimeError('Handy meldet: ' + ' | '.join(z))
        i = holen('/api/info')
        return i if heim_adresse(i) and any(x.startswith('wlan-wahl') for x in z) else None
    info = warten(fertig, 360)
    z = zeilen(seriell)
    if not info:
        raise RuntimeError('nicht ins Heim-WLAN gewechselt')
    probleme = []
    if not any(x == 'dns 10.42.0.1' for x in z):
        probleme.append('DNS lenkt nicht um')
    if not any(re.match(r'portal 302 http://10\.42\.0\.1/', x) for x in z):
        probleme.append('Prüfseite leitet nicht zur Einrichtung')
    if not any(x.startswith('info True') and 'AW-Test-Heim' in x for x in z):
        probleme.append('Einrichtung erkennt das Handy nicht als Hotspot-Gast oder kennt das Heim-WLAN nicht')
    if probleme:
        raise RuntimeError(', '.join(probleme))
    melden('notice', 'Hotspot', f'Handy im Hotspot, DNS und Prüfseite → Einrichtung, Heim-WLAN gewählt; Gerät als {heim_adresse(info)} im Heimnetz nach {int(time.time() - t0)} s · ' + ' | '.join(z))


lauf('stick', 'WLAN vom Stick', '', ['AW-Test-Heim', 'testpasswort1'], stick)
lauf('hotspot', 'Hotspot', 'aw.test=ohne-kabel', None, hotspot)
sys.exit(1 if fehler else 0)
