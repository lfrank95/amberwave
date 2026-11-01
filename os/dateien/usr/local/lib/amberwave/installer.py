#!/usr/bin/env python3
"""Amberwave OS – Einrichtung im Browser (läuft nur im Live-System vom USB-Stick, Port 80).

Zeigt die Platten des Geräts, nimmt Zielplatte, Musikquelle und Namen entgegen und startet installieren.sh. Nach der
Installation wartet es, bis der Stick abgezogen ist, und startet das Gerät neu (ins installierte System).
Nur Standardbibliothek – im Live-System gibt es nichts anderes.
"""
import json, os, re, subprocess, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from aw_gemeinsam import platten, kanal_standard, ips, nas_pruefen
import wlan

SEITE = '/usr/local/share/amberwave/installer'
STAND = '/run/amberwave/installation.json'
SKRIPT = '/usr/local/lib/amberwave/installieren.sh'
TYPEN = {'.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.js': 'text/javascript', '.css': 'text/css'}
laeuft = threading.Lock()
gestartet = False
# Netz für die Einrichtung: Kabel, WLAN vom Stick oder – wenn es nichts davon gibt – der eigene Hotspot
NETZ = {'wlan': False, 'hotspot': False, 'hotspot_ssid': wlan.HOTSPOT_SSID, 'ssid': None, 'netze': [], 'fehler': None, 'wechselt': False}
hotspot = None


def test_ohne_kabel():
    """Nur im automatischen Test (aw.test=ohne-kabel): so tun, als gäbe es kein Kabel – der Test steuert über das Kabel"""
    try:
        return 'aw.test=ohne-kabel' in open('/proc/cmdline').read()
    except OSError:
        return False


def netz_einrichten():
    """Beim Start: WLAN vom Stick versuchen, dann bis zu 45 s auf irgendein Netz warten, sonst Hotspot"""
    global hotspot
    dev = wlan.schnittstelle()
    NETZ['wlan'] = bool(dev)
    if not dev:
        return
    ohne = tuple(n for n in os.listdir('/sys/class/net') if n != dev) if test_ohne_kabel() else ()
    z = wlan.stick_zugang()
    if z:
        wlan.verbinden(dev, z['ssid'], z['passwort'])
        if wlan.warten_auf_adresse(dev, 45):
            NETZ['ssid'] = z['ssid']
            wlan.zugang_speichern(wlan.LIVE_DATEI, z['ssid'], z['passwort'])
            return
        wlan.trennen(dev)
        NETZ['fehler'] = 'stick'
    else:
        ende = time.time() + 45
        while time.time() < ende and not wlan.irgendein_netz(ohne):
            time.sleep(1)
    if wlan.irgendein_netz(ohne) or not wlan.hotspot_moeglich(dev):
        return
    NETZ['netze'] = wlan.scannen(dev)
    hotspot = wlan.Hotspot(dev)
    NETZ['hotspot'] = hotspot.starten()


def wlan_wechseln(ssid, passwort):
    """Hotspot aus, ins gewählte WLAN; klappt es nicht, kommt der Hotspot mit Fehlermeldung zurück"""
    dev = wlan.schnittstelle()
    time.sleep(3)   # die Antwort muss erst beim Handy ankommen
    if hotspot:
        hotspot.stoppen()
    NETZ['hotspot'] = False
    wlan.verbinden(dev, ssid, passwort)
    if wlan.warten_auf_adresse(dev, 45):
        wlan.zugang_speichern(wlan.LIVE_DATEI, ssid, passwort)
        NETZ.update(ssid=ssid, fehler=None, wechselt=False)
        return
    wlan.trennen(dev)
    NETZ['netze'] = wlan.scannen(dev) or NETZ['netze']
    NETZ.update(fehler='verbindung', wechselt=False, hotspot=hotspot.starten() if hotspot else False)


def secure_boot():
    try:
        with open('/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c', 'rb') as f:
            return f.read()[-1] == 1
    except OSError:
        return False


def stand_lesen():
    try:
        with open(STAND) as f:
            return json.load(f)
    except Exception:
        return {'schritt': '', 'prozent': 0, 'fertig': False, 'fehler': None}


def neu_starten():
    """Neustart, der garantiert passiert: erst sauber, nach 15 s erzwungen (die Installation ist fertig und
    geschrieben, im Live-System gibt es nichts zu verlieren – ein hängender Dienst darf den Neustart nicht aufhalten)"""
    subprocess.run(['sync'])
    subprocess.Popen(['systemctl', 'reboot'])
    time.sleep(15)
    subprocess.run(['sync'])
    subprocess.run(['systemctl', 'reboot', '--force', '--force'])
    time.sleep(5)
    try:
        with open('/proc/sysrq-trigger', 'w') as f:
            f.write('b')
    except OSError:
        pass


def stick_beobachten():
    """Nach der Installation: Stick abgezogen → neu starten (ins installierte System)"""
    while os.path.exists('/dev/disk/by-partlabel/aw-stick'):
        time.sleep(1)
    time.sleep(1)
    neu_starten()


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
    z = wlan.zugang_lesen(wlan.LIVE_DATEI)
    if z:
        env.update(AW_WLAN_SSID=z['ssid'], AW_WLAN_PASSWORT=z.get('passwort', ''))
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

    def ueber_hotspot(self):
        return bool(NETZ['hotspot']) and self.client_address[0].startswith('10.42.0.')

    def umleiten(self):
        """Hotspot: jede fremde Adresse (Prüfseiten von Android/iOS/Windows) → Einrichtung; so springt sie am Handy auf"""
        host = (self.headers.get('Host') or '').split(':')[0].lower()
        if not self.ueber_hotspot() or host in (wlan.HOTSPOT_IP, 'amberwave.local', os.uname().nodename + '.local'):
            return False
        self.send_response(302)
        self.send_header('Location', f'http://{wlan.HOTSPOT_IP}/')
        self.send_header('Content-Length', '0')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        return True

    def do_GET(self):
        if self.umleiten():
            return
        p = self.path.split('?')[0]
        if p == '/api/info':
            ziele, musik = platten()
            return self.senden(200, {'version': open('/etc/amberwave-version').read().strip(), 'name': os.uname().nodename,
                                     'ips': ips(), 'secure_boot': secure_boot(), 'platten': ziele, 'musik': musik, 'stand': stand_lesen() if gestartet else None,
                                     'netz': NETZ, 'ueber_hotspot': self.ueber_hotspot()})
        if p == '/api/wlan':
            return self.senden(200, NETZ)
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
        if self.umleiten():
            return
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
            threading.Timer(1, neu_starten).start()
            return self.senden(200, {'ok': True})
        if self.path == '/api/wlan':
            ssid = (w.get('ssid') or '').strip()
            pw = w.get('passwort') or ''
            if not ssid or len(ssid.encode()) > 32 or (pw and not 8 <= len(pw) <= 63):
                return self.senden(200, {'ok': False, 'fehler': 'eingabe'})
            if NETZ['wechselt']:
                return self.senden(200, {'ok': False, 'fehler': 'laeuft'})
            NETZ['wechselt'] = True
            threading.Thread(target=wlan_wechseln, args=(ssid, pw), daemon=True).start()
            return self.senden(200, {'ok': True})
        self.senden(404, {'fehler': 'nicht gefunden'})


if __name__ == '__main__':
    threading.Thread(target=netz_einrichten, daemon=True).start()
    ThreadingHTTPServer(('', 80), Anfrage).serve_forever()
