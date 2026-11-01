#!/usr/bin/env python3
"""Amberwave OS – Einrichtung im Browser (läuft nur im Live-System vom USB-Stick, Port 80).

Zeigt die Platten des Geräts, nimmt Zielplatte, Musikquelle und Namen entgegen und startet installieren.sh. Nach der
Installation wartet es, bis der Stick abgezogen ist, und startet das Gerät neu (ins installierte System).
Nur Standardbibliothek – im Live-System gibt es nichts anderes.
"""
import json, os, re, shutil, subprocess, tempfile, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

SEITE = '/usr/local/share/amberwave/installer'
STAND = '/run/amberwave/installation.json'
SKRIPT = '/usr/local/lib/amberwave/installieren.sh'
TYPEN = {'.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.js': 'text/javascript', '.css': 'text/css'}
laeuft = threading.Lock()
gestartet = False


def lsblk():
    r = subprocess.run(['lsblk', '-J', '-b', '-o', 'NAME,TYPE,SIZE,MODEL,TRAN,RM,ROTA,PARTLABEL,LABEL,FSTYPE,UUID,MOUNTPOINT'],
                       capture_output=True, text=True)
    return json.loads(r.stdout or '{"blockdevices":[]}').get('blockdevices', [])


def platten():
    """Platten für die Installation und Partitionen, auf denen Musik liegen kann"""
    ziele, musik = [], []
    for d in lsblk():
        if d.get('type') != 'disk' or re.match(r'^(loop|zram|sr|ram)', d['name']):
            continue
        teile = d.get('children') or []
        if any(t.get('partlabel') == 'aw-stick' for t in teile):
            continue   # der Stick, von dem gerade gestartet wurde
        art = 'usb' if d.get('tran') == 'usb' else 'nvme' if d.get('tran') == 'nvme' or d['name'].startswith('nvme') else 'hdd' if d.get('rota') else 'ssd'
        labels = {t.get('partlabel') for t in teile}
        ziele.append({'name': d['name'], 'groesse': int(d.get('size') or 0), 'modell': (d.get('model') or '').strip(), 'art': art,
                      'entfernbar': bool(d.get('rm')) or art == 'usb', 'amberwave': {'aw-efi', 'aw-system', 'aw-daten'} <= labels})
        for t in (teile or [d]):
            if t.get('fstype') in ('ext4', 'exfat', 'ntfs', 'vfat', 'xfs', 'btrfs') and t.get('uuid') and t.get('partlabel') not in ('aw-efi', 'aw-system', 'aw-daten'):
                musik.append({'platte': d['name'], 'name': t['name'], 'uuid': t['uuid'], 'groesse': int(t.get('size') or 0),
                              'label': t.get('label') or '', 'fstype': t['fstype'], 'modell': (d.get('model') or '').strip()})
    return [z for z in ziele if z['groesse'] >= 16 * 1024**3], musik


def kanal_standard():
    """Kanal, mit dem dieses Image gebaut wurde (stabiles Release → latest, Beta → beta)"""
    try:
        with open('/etc/amberwave-kanal') as f:
            k = f.read().strip()
            return k if k in ('beta', 'latest', 'main') else 'beta'
    except OSError:
        return 'beta'


def secure_boot():
    try:
        with open('/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c', 'rb') as f:
            return f.read()[-1] == 1
    except OSError:
        return False


def ips():
    r = subprocess.run(['ip', '-4', '-o', 'addr', 'show', 'scope', 'global'], capture_output=True, text=True)
    return [z.split()[3].split('/')[0] for z in r.stdout.splitlines() if len(z.split()) > 3]


def stand_lesen():
    try:
        with open(STAND) as f:
            return json.load(f)
    except Exception:
        return {'schritt': '', 'prozent': 0, 'fertig': False, 'fehler': None}


def nas_pruefen(pfad, benutzer, passwort):
    """Freigabe testweise einbinden: erreichbar, Zugang richtig, wie viel liegt drin?"""
    if not re.match(r'^//[^/\s]+/[^\s].*$', pfad or ''):
        return {'ok': False, 'fehler': 'adresse'}
    ort = tempfile.mkdtemp(prefix='aw-nas-')
    zugang = tempfile.NamedTemporaryFile('w', delete=False)
    zugang.write(f'username={benutzer}\npassword={passwort}\n'); zugang.close()
    try:
        r = subprocess.run(['mount', '-t', 'cifs', pfad, ort, '-o', f'credentials={zugang.name},ro,vers=3.0'], capture_output=True, text=True, timeout=20)
        if r.returncode != 0:
            return {'ok': False, 'fehler': 'zugang' if 'Permission' in r.stderr or '13' in r.stderr else 'nicht_erreichbar'}
        n = len(os.listdir(ort))
        subprocess.run(['umount', ort])
        return {'ok': True, 'eintraege': n}
    except subprocess.TimeoutExpired:
        return {'ok': False, 'fehler': 'nicht_erreichbar'}
    finally:
        os.unlink(zugang.name)
        shutil.rmtree(ort, ignore_errors=True)


def stick_beobachten():
    """Nach der Installation: Stick abgezogen → neu starten (ins installierte System)"""
    while os.path.exists('/dev/disk/by-partlabel/aw-stick'):
        time.sleep(1)
    time.sleep(1)
    subprocess.run(['systemctl', 'reboot'])


def installieren(w):
    global gestartet
    ziele, musik = platten()
    ziel = next((z for z in ziele if z['name'] == w.get('platte')), None)
    if not ziel:
        return {'ok': False, 'fehler': 'platte'}
    name = (w.get('name') or 'amberwave').strip().lower()
    if not re.match(r'^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$', name):
        return {'ok': False, 'fehler': 'name'}
    m = w.get('musik') or {}
    env = dict(os.environ, AW_PLATTE=ziel['name'], AW_BEHALTEN='1' if w.get('behalten') and ziel['amberwave'] else '0', AW_NAME=name,
               AW_KANAL=w.get('kanal') if w.get('kanal') in ('beta', 'latest', 'main') else kanal_standard(),
               AW_ZEITZONE=w.get('zeitzone') if re.match(r'^[A-Za-z_]+(/[A-Za-z_+-]+)*$', w.get('zeitzone') or '') else 'Europe/Berlin',
               AW_MUSIK_ART='intern')
    if m.get('art') == 'platte':
        t = next((x for x in musik if x['uuid'] == m.get('uuid') and x['platte'] != ziel['name']), None)
        if not t:
            return {'ok': False, 'fehler': 'musik'}
        env.update(AW_MUSIK_ART='platte', AW_MUSIK_UUID=t['uuid'], AW_MUSIK_OPTIONEN='ro' if m.get('nur_lesen') else 'defaults')
    elif m.get('art') == 'nas':
        env.update(AW_MUSIK_ART='nas', AW_NAS_PFAD=m.get('pfad', ''), AW_NAS_BENUTZER=m.get('benutzer', ''), AW_NAS_PASSWORT=m.get('passwort', ''))
    with laeuft:
        if gestartet and not stand_lesen().get('fehler'):
            return {'ok': False, 'fehler': 'laeuft'}
        gestartet = True
        os.makedirs('/run/amberwave', exist_ok=True)
        with open(STAND, 'w') as f:
            json.dump({'schritt': 'Start', 'prozent': 1, 'fertig': False, 'fehler': None}, f)

    def lauf():
        with open('/run/amberwave/installation.log', 'w') as log:
            subprocess.run(['/bin/bash', '-x', SKRIPT], env=env, stdout=log, stderr=subprocess.STDOUT)
        if stand_lesen().get('fertig'):
            stick_beobachten()
    threading.Thread(target=lauf, daemon=True).start()
    return {'ok': True}


class Anfrage(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def senden(self, code, daten, typ='application/json'):
        roh = json.dumps(daten).encode() if typ == 'application/json' else daten
        self.send_response(code)
        self.send_header('Content-Type', typ)
        self.send_header('Content-Length', str(len(roh)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(roh)

    def do_GET(self):
        p = self.path.split('?')[0]
        if p == '/api/info':
            ziele, musik = platten()
            return self.senden(200, {'version': open('/etc/amberwave-version').read().strip(), 'name': os.uname().nodename,
                                     'ips': ips(), 'secure_boot': secure_boot(), 'platten': ziele, 'musik': musik, 'stand': stand_lesen() if gestartet else None})
        if p == '/api/stand':
            return self.senden(200, stand_lesen())
        if p == '/api/protokoll':   # „Details“ bei einem Fehler: die letzten Zeilen der Installation
            try:
                with open('/run/amberwave/installation.log', errors='replace') as f:
                    return self.senden(200, {'zeilen': [z for z in f.read().splitlines() if 'PASSWORT' not in z][-60:]})
            except OSError:
                return self.senden(200, {'zeilen': []})
        if p in ('/api/v1/ping',):   # damit die Amberwave-Apps das Gerät schon jetzt finden und hierher leiten
            return self.senden(200, {'ok': True, 'app': 'amberwave-os', 'einrichtung': True})
        datei = 'index.html' if p in ('/', '/index.html') or not os.path.splitext(p)[1] else p.lstrip('/')
        pfad = os.path.realpath(os.path.join(SEITE, datei))
        if not pfad.startswith(SEITE + '/') or not os.path.isfile(pfad):
            return self.senden(404, {'fehler': 'nicht gefunden'})
        with open(pfad, 'rb') as f:
            self.senden(200, f.read(), TYPEN.get(os.path.splitext(pfad)[1], 'application/octet-stream'))

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        try:
            w = json.loads(self.rfile.read(min(n, 65536)) or b'{}')
        except Exception:
            return self.senden(400, {'ok': False, 'fehler': 'json'})
        if self.path == '/api/installieren':
            return self.senden(200, installieren(w))
        if self.path == '/api/nas-pruefen':
            return self.senden(200, nas_pruefen(w.get('pfad'), w.get('benutzer', ''), w.get('passwort', '')))
        if self.path == '/api/neustart':
            threading.Timer(1, lambda: subprocess.run(['systemctl', 'reboot'])).start()
            return self.senden(200, {'ok': True})
        self.senden(404, {'fehler': 'nicht gefunden'})


if __name__ == '__main__':
    ThreadingHTTPServer(('', 80), Anfrage).serve_forever()
