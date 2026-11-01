#!/usr/bin/env python3
"""Amberwave OS – Gerätedienst (installiertes System, nur 127.0.0.1:7699).

Die Amberwave-App (Container, Netz des Geräts) fragt hier nach Zustand und Einstellungen des Geräts und ändert sie:
Name im Netz, Netzwerk, Musikquelle, Kanal, Sicherheitsupdates, SSH, Neustart/Ausschalten, Protokoll.
Jede Anfrage braucht den Schlüssel aus /daten/appdata/geraet.schluessel (die App liest ihn aus /appdata).
Alles, was bleiben soll, steht unter /daten/system – das System selbst kann jederzeit frisch aufgespielt werden.

  geraet.py               Dienst starten
  geraet.py --netz        Netzwerk-Datei aus den Einstellungen schreiben (beim Start, vor systemd-networkd)

Zum Ausprobieren ohne Gerät: AW_WURZEL=/tmp/x (alle Pfade darunter) und AW_TROCKEN=1 (Befehle nur protokollieren).
"""
import hmac, ipaddress, json, os, re, secrets, shlex, shutil, subprocess, sys, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aw_gemeinsam import platten, kanal_standard, ips, nas_pruefen  # noqa: E402
import wlan  # noqa: E402

W = os.environ.get('AW_WURZEL', '')
TROCKEN = os.environ.get('AW_TROCKEN') == '1'
PORT = int(os.environ.get('AW_GERAET_PORT', '7699'))
P = lambda p: W + p  # noqa: E731
EINST = P('/daten/system/einstellungen')
NAS_ZUGANG = P('/daten/system/nas.zugang')
SSH_ORDNER = P('/daten/system/ssh')
SCHLUESSEL = P('/daten/appdata/geraet.schluessel')
KANAL_DATEI = P('/daten/appdata/geraet-kanal')
NETZ_DATEI = P('/etc/systemd/network/10-amberwave.network')
LIB = os.path.dirname(os.path.abspath(__file__))
sperre = threading.Lock()
netz_probe = {'timer': None, 'bis': 0, 'adresse': ''}
NAME_RE = r'^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$'


# ---------- Hilfen ----------
def tun(cmd, **kw):
    """Befehl, der etwas verändert (im Trockenlauf nur protokolliert)"""
    if TROCKEN:
        with open(P('/tmp-befehle.log'), 'a') as f:
            f.write(' '.join(cmd if isinstance(cmd, list) else [cmd]) + '\n')
        return subprocess.CompletedProcess(cmd, 0, '', '')
    return subprocess.run(cmd, capture_output=True, text=True, timeout=kw.get('timeout', 60))


def lesen(cmd, timeout=10, env=None):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env).stdout
    except Exception:
        return ''


def gelingt(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, timeout=10).returncode == 0
    except Exception:
        return False


def datei(pfad, standard=''):
    try:
        with open(pfad, errors='replace') as f:
            return f.read()
    except OSError:
        return standard


def einstellungen():
    """Einstellungen des Geräts (Bash-Datei, von start.sh eingelesen) – mit Bash gelesen, damit jede Schreibweise stimmt"""
    if not os.path.exists(EINST):
        return {}
    roh = lesen(['bash', '-c', '. "$1"; for k in ${!AW_*}; do printf "%s\\0%s\\0" "$k" "${!k}"; done', '_', EINST],
                env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'})   # ohne die eigene Umgebung (AW_… beim Ausprobieren)
    teile = roh.split('\0')
    return {teile[i]: teile[i + 1] for i in range(0, len(teile) - 1, 2)}


def einstellungen_schreiben(neu):
    e = einstellungen()
    e.update(neu)
    zeilen = ['# Amberwave OS – Einstellungen dieses Geräts (werden in der Weboberfläche geändert)']
    zeilen += [f'{k}={shlex.quote(str(v))}' for k, v in e.items() if v not in (None, '')]
    os.makedirs(os.path.dirname(EINST), exist_ok=True)
    with open(EINST + '.neu', 'w') as f:
        f.write('\n'.join(zeilen) + '\n')
    os.replace(EINST + '.neu', EINST)
    return e


def schluessel():
    s = datei(SCHLUESSEL).strip()
    if len(s) < 32:
        s = secrets.token_hex(24)
        os.makedirs(os.path.dirname(SCHLUESSEL), exist_ok=True)
        with open(SCHLUESSEL, 'w') as f:
            f.write(s)
    os.chmod(SCHLUESSEL, 0o644)   # die App läuft im Container nicht als root
    return s


def nas_benutzer():
    m = re.search(r'^username=(.*)$', datei(NAS_ZUGANG), re.M)
    return m.group(1) if m else ''


def nas_passwort():
    m = re.search(r'^password=(.*)$', datei(NAS_ZUGANG), re.M)
    return m.group(1) if m else ''


def speicher(pfad):
    try:
        st = os.statvfs(P(pfad))
        return {'gesamt': st.f_blocks * st.f_frsize, 'belegt': (st.f_blocks - st.f_bfree) * st.f_frsize}
    except OSError:
        return None


_aufteilung = {'zeit': 0, 'daten': None}


def groesse_ordner(pfad):
    """Bytes eines Ordners (nur dieses Dateisystem); 0, wenn es ihn nicht gibt"""
    if not os.path.isdir(P(pfad)):
        return 0
    try:
        r = subprocess.run(['du', '-sxb', P(pfad)], capture_output=True, text=True, timeout=30)
        return int((r.stdout.split() or ['0'])[0])
    except (OSError, ValueError, subprocess.SubprocessError):
        return 0


def aufteilung(musik_intern):
    """Was belegt die Datenpartition: Amberwave selbst, Datenbank, Cover, Sicherungen – der Rest ist (bei interner
    Musik) die Musik. Die großen Musikordner werden nicht gezählt, sondern ergeben sich aus dem Rest (schnell).
    Zwischengespeichert für 5 Minuten."""
    if time.time() - _aufteilung['zeit'] < 300 and _aufteilung['daten'] is not None:
        return _aufteilung['daten']
    t = {
        'programm': groesse_ordner('/daten/docker') + groesse_ordner('/daten/system'),
        'datenbank': groesse_ordner('/daten/appdata/db'),
        'cover': groesse_ordner('/daten/appdata/cache'),
        'sicherungen': groesse_ordner('/daten/appdata/backups'),
    }
    d = speicher('/daten')
    rest = max(0, (d['belegt'] if d else 0) - sum(t.values()))
    t['musik' if musik_intern else 'sonstiges'] = rest
    _aufteilung.update(zeit=time.time(), daten=t)
    return t


def schnittstelle():
    """Kabel-Schnittstelle mit Standardroute (oder die erste mit Kabel)"""
    try:
        for r in json.loads(lesen(['ip', '-j', 'route', 'show', 'default']) or '[]'):
            if r.get('dev'):
                return r['dev'], r.get('gateway', '')
    except ValueError:
        pass
    for n in sorted(os.listdir('/sys/class/net')):
        if os.path.exists(f'/sys/class/net/{n}/device') and not os.path.exists(f'/sys/class/net/{n}/wireless'):
            return n, ''
    return '', ''


def hardware():
    cpu = re.search(r'^model name\s*:\s*(.+)$', datei('/proc/cpuinfo'), re.M)
    ram = re.search(r'^MemTotal:\s*(\d+)', datei('/proc/meminfo'), re.M)
    temps = {}
    for z in sorted(os.listdir('/sys/class/thermal')) if os.path.isdir('/sys/class/thermal') else []:
        wert = datei(f'/sys/class/thermal/{z}/temp').strip()
        if wert.lstrip('-').isdigit() and int(wert) > 0:
            temps.setdefault(datei(f'/sys/class/thermal/{z}/type').strip(), round(int(wert) / 1000))
    temp = temps.get('x86_pkg_temp', next(iter(temps.values()), None))
    laufzeit = float((datei('/proc/uptime') or '0').split()[0] or 0)
    return {'cpu': re.sub(r'\s+', ' ', cpu.group(1)).strip() if cpu else '', 'kerne': os.cpu_count() or 0,
            'ram': int(ram.group(1)) * 1024 if ram else 0, 'temperatur': temp, 'laufzeit': int(laufzeit)}


def netz():
    e = einstellungen()
    dev, router = schnittstelle()
    speed = datei(f'/sys/class/net/{dev}/speed').strip() if dev else ''
    dns = re.findall(r'^nameserver\s+(\S+)', datei('/run/systemd/resolve/resolv.conf'), re.M)
    adr = ''
    for z in lesen(['ip', '-4', '-o', 'addr', 'show', 'dev', dev]).splitlines() if dev else []:
        adr = z.split()[3]
        break
    return {'schnittstelle': dev, 'mac': datei(f'/sys/class/net/{dev}/address').strip() if dev else '',
            'verbunden': datei(f'/sys/class/net/{dev}/carrier').strip() == '1' if dev else False,
            'mbit': int(speed) if speed.lstrip('-').isdigit() and int(speed) > 0 else None,
            'adresse': adr, 'router': router, 'dns': dns[:3],
            'art': e.get('AW_NETZ_ART', 'auto'), 'fest': {'adresse': e.get('AW_NETZ_ADRESSE', ''), 'router': e.get('AW_NETZ_ROUTER', ''), 'dns': e.get('AW_NETZ_DNS', '')},
            'probe': {'bis': int(netz_probe['bis']), 'adresse': netz_probe['adresse']} if netz_probe['timer'] else None}


def system_info():
    os_rel = dict(re.findall(r'^(\w+)="?([^"\n]*)"?$', datei('/etc/os-release'), re.M))
    debian = datei('/etc/debian_version').strip()
    stempel = P('/var/lib/apt/periodic/unattended-upgrades-stamp')
    return {'debian': debian or os_rel.get('VERSION_ID', ''), 'name': os_rel.get('PRETTY_NAME', ''), 'kernel': os.uname().release,
            'geprueft': int(os.path.getmtime(stempel)) if os.path.exists(stempel) else None,
            'neustart_noetig': os.path.exists('/run/reboot-required')}


# ---------- WLAN ----------
wlan_wechsel = {}   # {'ssid', 'stand': laeuft|ok|fehler}


def wlan_karte():
    return os.environ.get('AW_TEST_WLAN', '') if TROCKEN else wlan.schnittstelle()


def wlan_info():
    dev = wlan_karte()
    if not dev:
        return None
    gespeichert = wlan.zugang_lesen(P(wlan.DATEN_DATEI))
    if TROCKEN:
        verb = {'ssid': gespeichert['ssid'], 'signal': -55} if gespeichert else None
        return {'karte': dev, 'verbindung': verb, 'gespeichert': gespeichert['ssid'] if gespeichert else None,
                'adresse': '192.168.178.43' if verb else '', 'wechsel': wlan_wechsel or None}
    return {'karte': dev, 'verbindung': wlan.verbindung(dev), 'gespeichert': gespeichert['ssid'] if gespeichert else None,
            'adresse': wlan.adresse(dev), 'wechsel': wlan_wechsel or None}


def wlan_suchen(_w):
    dev = wlan_karte()
    if not dev:
        return {'ok': False, 'fehler': 'keine_karte'}
    if TROCKEN:
        return {'ok': True, 'netze': [{'ssid': 'FRITZ!Box 7590 KL', 'signal': -48, 'sicher': True}, {'ssid': 'Nachbar', 'signal': -80, 'sicher': True}]}
    return {'ok': True, 'netze': wlan.scannen(dev)}


def wlan_setzen(w):
    """Ins gewählte WLAN wechseln – im Hintergrund (die Verbindung zur App kann dabei abreißen). Klappt es nicht
    innerhalb von 45 s, geht das Gerät zurück ins bisherige WLAN."""
    dev = wlan_karte()
    ssid = (w.get('ssid') or '').strip()
    pw = w.get('passwort') or ''
    if not dev:
        return {'ok': False, 'fehler': 'keine_karte'}
    if not ssid or len(ssid.encode()) > 32 or (pw and not 8 <= len(pw) <= 63):
        return {'ok': False, 'fehler': 'eingabe'}
    alt = wlan.zugang_lesen(P(wlan.DATEN_DATEI))
    if not pw and alt and alt['ssid'] == ssid:
        pw = alt.get('passwort', '')   # gleiches Netz, Passwort leer gelassen = unverändert
    wlan_wechsel.clear()
    wlan_wechsel.update(ssid=ssid, stand='laeuft')

    def lauf():
        time.sleep(1.5)
        if TROCKEN:
            wlan.zugang_speichern(P(wlan.DATEN_DATEI), ssid, pw)
            wlan_wechsel['stand'] = 'ok'
            return
        wlan.verbinden(dev, ssid, pw)
        if wlan.warten_auf_adresse(dev, 45) and (wlan.verbindung(dev) or {}).get('ssid') == ssid:
            wlan.zugang_speichern(wlan.DATEN_DATEI, ssid, pw)
            wlan_wechsel['stand'] = 'ok'
            return
        if alt:
            wlan.verbinden(dev, alt['ssid'], alt.get('passwort', ''))
        else:
            wlan.trennen(dev)
        wlan_wechsel['stand'] = 'fehler'
    threading.Thread(target=lauf, daemon=True).start()
    return {'ok': True}


def wlan_vergessen(_w):
    dev = wlan_karte()
    try:
        os.unlink(P(wlan.DATEN_DATEI))
    except OSError:
        pass
    if dev and not TROCKEN:
        wlan.trennen(dev)
    wlan_wechsel.clear()
    return {'ok': True}


def info():
    e = einstellungen()
    _, musik_teile = platten()
    art = e.get('AW_MUSIK_ART', 'intern')
    eingebunden = gelingt(['mountpoint', '-q', P('/musik')])
    ssh_an = gelingt(['systemctl', 'is-active', '--quiet', 'ssh'])
    return {
        'version': datei('/etc/amberwave-version').strip(), 'name': e.get('AW_NAME', os.uname().nodename),
        'kanal': e.get('AW_KANAL', kanal_standard()), 'zeitzone': e.get('AW_ZEITZONE', 'Europe/Berlin'),
        'ips': ips('-4'), 'ips6': [a for a in ips('-6') if not a.startswith('fe80')][:2],
        'hardware': hardware(), 'netz': netz(),
        'musik': {'art': art, 'eingebunden': eingebunden, 'uuid': e.get('AW_MUSIK_UUID', ''), 'nur_lesen': e.get('AW_MUSIK_OPTIONEN') == 'ro',
                  'pfad': e.get('AW_NAS_PFAD', ''), 'benutzer': nas_benutzer() if art == 'nas' else '', 'platten': musik_teile},
        'speicher': {'system': speicher('/'), 'daten': speicher('/daten'), 'musik': speicher('/musik') if eingebunden and art != 'intern' else None,
                     'aufteilung': aufteilung(art == 'intern')},
        'system': system_info(), 'sicherheitsupdates': e.get('AW_SICHERHEITSUPDATES', '1') == '1',
        'wlan': wlan_info(),
        'ssh': {'an': ssh_an, 'liste': [z.strip() for z in datei(SSH_ORDNER + '/authorized_keys').splitlines() if z.strip() and not z.startswith('#')]},
    }


# ---------- Ändern ----------
def name_setzen(w):
    name = (w.get('name') or '').strip().lower()
    if not re.match(NAME_RE, name):
        return {'ok': False, 'fehler': 'name'}
    einstellungen_schreiben({'AW_NAME': name})
    name_anwenden(name)
    tun(['systemctl', 'restart', 'avahi-daemon'])
    # dem Router den neuen Namen sagen (DHCP) – sonst steht dort weiter der alte (z. B. amberwave.fritz.box)
    for dev in os.listdir('/sys/class/net') if os.path.isdir('/sys/class/net') else []:
        if dev != 'lo' and not re.match(r'^(docker|br-|veth)', dev):
            tun(['networkctl', 'renew', dev])
    return {'ok': True, 'name': name}


def name_frueh_setzen(e):
    """Beim Start, noch vor dem Netzwerk: Gerätename aus den Einstellungen – so meldet sich das Gerät schon bei der
    ersten DHCP-Anfrage mit dem richtigen Namen beim Router (FRITZ!Box & Co. zeigen ihn als Gerätename/Domain)"""
    name = e.get('AW_NAME', '')
    if re.match(NAME_RE, name):
        name_anwenden(name)


def name_anwenden(name):
    """Gerätename direkt setzen (Datei, /etc/hosts, laufendes System) – ohne hostnamectl, das D-Bus braucht"""
    with open(P('/etc/hostname'), 'w') as f:
        f.write(name + '\n')
    hosts = datei(P('/etc/hosts'))
    if re.search(r'^127\.0\.1\.1\s', hosts, re.M):
        hosts = re.sub(r'^127\.0\.1\.1\s.*$', f'127.0.1.1 {name}', hosts, flags=re.M)
    else:
        hosts += f'127.0.1.1 {name}\n'
    with open(P('/etc/hosts'), 'w') as f:
        f.write(hosts)
    tun(['hostname', name])


def netz_datei_schreiben(e=None):
    """10-amberwave.network aus den Einstellungen: feste Adresse für die Kabel-Schnittstelle, sonst weg (→ DHCP aus 20-kabel)"""
    e = e if e is not None else einstellungen()
    if e.get('AW_NETZ_ART') == 'fest' and e.get('AW_NETZ_ADRESSE'):
        dns = ''.join(f'DNS={d}\n' for d in (e.get('AW_NETZ_DNS') or e.get('AW_NETZ_ROUTER', '')).replace(',', ' ').split())
        inhalt = (f'# Amberwave OS: feste Adresse (Einstellungen › Amberwave OS)\n[Match]\nType=ether\n\n[Network]\n'
                  f'Address={e["AW_NETZ_ADRESSE"]}\nGateway={e.get("AW_NETZ_ROUTER", "")}\n{dns}MulticastDNS=no\nLinkLocalAddressing=ipv6\n')
        os.makedirs(os.path.dirname(NETZ_DATEI), exist_ok=True)
        with open(NETZ_DATEI, 'w') as f:
            f.write(inhalt)
    elif os.path.exists(NETZ_DATEI):
        os.unlink(NETZ_DATEI)


def netz_neu_laden():
    dev, _ = schnittstelle()
    tun(['networkctl', 'reload'])
    if dev:
        tun(['networkctl', 'reconfigure', dev])
    threading.Timer(4, lambda: tun(['systemctl', 'restart', 'avahi-daemon'])).start()


def netz_zurueck():
    """Probezeit abgelaufen, ohne dass jemand die neue Adresse bestätigt hat → zurück auf automatisch"""
    with sperre:
        netz_probe.update(timer=None, bis=0, adresse='')
        e = einstellungen_schreiben({'AW_NETZ_ART': 'auto', 'AW_NETZ_PROBE': ''})
        netz_datei_schreiben(e)
        netz_neu_laden()


def netz_setzen(w):
    if netz_probe['timer']:
        netz_probe['timer'].cancel()
        netz_probe.update(timer=None, bis=0, adresse='')
    if w.get('art') == 'auto':
        e = einstellungen_schreiben({'AW_NETZ_ART': 'auto', 'AW_NETZ_PROBE': ''})
        netz_datei_schreiben(e)
        netz_neu_laden()
        return {'ok': True}
    try:
        schnitt = ipaddress.ip_interface(f"{w.get('adresse', '').strip()}/{int(w.get('praefix') or 24)}")
        router = ipaddress.ip_address(w.get('router', '').strip())
        dns = [str(ipaddress.ip_address(d)) for d in re.split(r'[\s,]+', w.get('dns', '').strip()) if d]
    except ValueError:
        return {'ok': False, 'fehler': 'adresse'}
    if schnitt.version != 4 or router not in schnitt.network or schnitt.ip in (schnitt.network.network_address, schnitt.network.broadcast_address) or schnitt.ip == router:
        return {'ok': False, 'fehler': 'netz'}
    e = einstellungen_schreiben({'AW_NETZ_ART': 'fest', 'AW_NETZ_ADRESSE': str(schnitt), 'AW_NETZ_ROUTER': str(router), 'AW_NETZ_DNS': ' '.join(dns), 'AW_NETZ_PROBE': '1'})
    netz_datei_schreiben(e)
    # Probezeit: wer die neue Adresse nicht innerhalb von 3 Minuten bestätigt, bekommt die automatische zurück
    t = threading.Timer(180, netz_zurueck)
    t.daemon = True
    netz_probe.update(timer=t, bis=time.time() + 180, adresse=str(schnitt.ip))
    t.start()
    threading.Timer(1.5, netz_neu_laden).start()   # erst antworten, dann umstellen
    return {'ok': True, 'adresse': str(schnitt.ip), 'bis': int(netz_probe['bis'])}


def netz_bestaetigen(_w):
    if netz_probe['timer']:
        netz_probe['timer'].cancel()
    netz_probe.update(timer=None, bis=0, adresse='')
    einstellungen_schreiben({'AW_NETZ_PROBE': ''})
    return {'ok': True}


def amberwave_neu_starten():
    """Container neu starten (nimmt die neu eingebundene Musik mit) – im Hintergrund, die Antwort geht vorher raus"""
    def lauf():
        time.sleep(1.5)
        tun(['docker', 'restart', '-t', '30', 'amberwave'], timeout=120)
    threading.Thread(target=lauf, daemon=True).start()


def musik_setzen(w):
    art = w.get('art')
    neu = {'AW_MUSIK_ART': art, 'AW_MUSIK_UUID': '', 'AW_MUSIK_OPTIONEN': '', 'AW_NAS_PFAD': ''}
    if art == 'platte':
        _, teile = platten()
        t = next((x for x in teile if x['uuid'] == w.get('uuid')), None)
        if not t:
            return {'ok': False, 'fehler': 'platte'}
        neu.update(AW_MUSIK_UUID=t['uuid'], AW_MUSIK_OPTIONEN='ro' if w.get('nur_lesen') else 'defaults')
    elif art == 'nas':
        pfad = (w.get('pfad') or '').strip().replace('\\', '/')
        benutzer = w.get('benutzer', '') or ''
        passwort = w.get('passwort') if w.get('passwort') else nas_passwort()
        p = nas_pruefen(pfad, benutzer, passwort) if not TROCKEN else {'ok': True}
        if not p['ok']:
            return p
        neu['AW_NAS_PFAD'] = pfad
        alt = os.umask(0o077)
        try:
            with open(NAS_ZUGANG, 'w') as f:
                f.write(f'username={benutzer}\npassword={passwort}\n')
        finally:
            os.umask(alt)
    elif art != 'intern':
        return {'ok': False, 'fehler': 'art'}
    einstellungen_schreiben(neu)
    if gelingt(['mountpoint', '-q', P('/musik')]):
        tun(['umount', '-l', '/musik'])
    r = tun(['bash', '-c', f'. {LIB}/gemeinsam.sh; musik_einbinden'], timeout=150)
    if not TROCKEN and not gelingt(['mountpoint', '-q', '/musik']):
        return {'ok': False, 'fehler': 'einbinden', 'meldung': (r.stdout or '').strip().splitlines()[-1:]}
    amberwave_neu_starten()
    return {'ok': True}


def kanal_setzen(w):
    k = w.get('kanal')
    if k not in ('latest', 'beta'):
        return {'ok': False, 'fehler': 'kanal'}
    einstellungen_schreiben({'AW_KANAL': k})
    kanal_melden(k)
    try:   # die App fragt beim nächsten Blick neu bei GitHub nach – passend zum Kanal
        os.unlink(P('/daten/appdata/cache/update_stand.json'))
    except OSError:
        pass
    return {'ok': True}


def kanal_melden(k=None):
    with open(KANAL_DATEI, 'w') as f:
        f.write(k or einstellungen().get('AW_KANAL', kanal_standard()))
    os.chmod(KANAL_DATEI, 0o644)


def sicherheitsupdates_anwenden(an):
    with open(P('/etc/apt/apt.conf.d/20auto-upgrades'), 'w') as f:
        f.write(f'APT::Periodic::Update-Package-Lists "{1 if an else 0}";\nAPT::Periodic::Unattended-Upgrade "{1 if an else 0}";\n')


def sicherheitsupdates_setzen(w):
    an = bool(w.get('an'))
    einstellungen_schreiben({'AW_SICHERHEITSUPDATES': '1' if an else '0'})
    sicherheitsupdates_anwenden(an)
    return {'ok': True}


def ssh_anwenden(an):
    """SSH nur mit Schlüssel; Schlüssel und Kennung des Geräts liegen unter /daten (bleiben bei einer Neuinstallation)"""
    if an:
        os.makedirs(SSH_ORDNER, mode=0o700, exist_ok=True)
        hk = SSH_ORDNER + '/ssh_host_ed25519_key'
        if not os.path.exists(hk):
            tun(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'amberwave', '-f', hk])
        tun(['systemctl', 'enable', '--now', 'ssh'])
    else:
        tun(['systemctl', 'disable', '--now', 'ssh'])


def ssh_setzen(w):
    an = bool(w.get('an'))
    if 'schluessel' in w:
        zeilen = [z.strip() for z in (w.get('schluessel') or '').splitlines() if z.strip()]
        if any(not re.match(r'^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]+( .*)?$', z) for z in zeilen):
            return {'ok': False, 'fehler': 'schluessel'}
        os.makedirs(SSH_ORDNER, mode=0o700, exist_ok=True)
        with open(SSH_ORDNER + '/authorized_keys', 'w') as f:
            f.write('\n'.join(zeilen) + ('\n' if zeilen else ''))
        os.chmod(SSH_ORDNER + '/authorized_keys', 0o600)
    if an and not datei(SSH_ORDNER + '/authorized_keys').strip():
        return {'ok': False, 'fehler': 'kein_schluessel'}
    einstellungen_schreiben({'AW_SSH': '1' if an else '0'})
    ssh_anwenden(an)
    return {'ok': True}


def strom(w):
    aktion = w.get('aktion')
    if aktion not in ('neustart', 'aus'):
        return {'ok': False, 'fehler': 'aktion'}
    def lauf():
        time.sleep(1.5)
        tun(['sync'])
        tun(['systemctl', 'reboot' if aktion == 'neustart' else 'poweroff'])
    threading.Thread(target=lauf, daemon=True).start()
    return {'ok': True}


def protokoll():
    """Alles für die Fehlersuche in einer Datei – ohne Passwörter"""
    teile = [('Amberwave OS', json.dumps({k: v for k, v in info().items() if k != 'musik'} | {'musik_art': einstellungen().get('AW_MUSIK_ART')}, indent=1, ensure_ascii=False)),
             ('Einstellungen', re.sub(r'(PASSWORT|PASSWORD)=.*', r'\1=***', datei(EINST))),
             ('Dienste', lesen(['systemctl', '--no-pager', '--failed'])),
             ('Container', lesen(['docker', 'ps', '-a', '--format', '{{.Names}}  {{.Image}}  {{.Status}}'])),
             ('Amberwave (letzte 400 Zeilen)', lesen(['docker', 'logs', '--tail', '400', 'amberwave'], 20)),
             ('System (letzte 600 Zeilen seit dem Start)', lesen(['journalctl', '-b', '--no-pager', '-n', '600', '-o', 'short-iso'], 20)),
             ('Platten', lesen(['lsblk', '-o', 'NAME,SIZE,TYPE,FSTYPE,LABEL,PARTLABEL,MOUNTPOINT'])),
             ('Netz', lesen(['ip', 'addr']) + lesen(['ip', 'route']))]
    text = ''.join(f'===== {t} =====\n{x.rstrip()}\n\n' for t, x in teile)
    return re.sub(r'(password=)\S+', r'\1***', text)


def beim_start():
    """Beim Start des Dienstes: Schlüssel, Kanal für die App, Sicherheitsupdates und SSH nach den Einstellungen"""
    schluessel()
    e = einstellungen()
    try:
        kanal_melden()
    except OSError:
        pass
    try:
        sicherheitsupdates_anwenden(e.get('AW_SICHERHEITSUPDATES', '1') == '1')
    except OSError:
        pass
    if e.get('AW_SSH') == '1':
        ssh_anwenden(True)


AKTIONEN = {'/wlan': wlan_setzen, '/wlan/suchen': wlan_suchen, '/wlan/vergessen': wlan_vergessen, '/name': name_setzen, '/netz': netz_setzen, '/netz/bestaetigen': netz_bestaetigen, '/musik': musik_setzen,
            '/kanal': kanal_setzen, '/sicherheitsupdates': sicherheitsupdates_setzen, '/ssh': ssh_setzen, '/strom': strom,
            '/musik/pruefen': lambda w: nas_pruefen((w.get('pfad') or '').replace('\\', '/'), w.get('benutzer', ''), w.get('passwort') or nas_passwort())}


class Anfrage(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def senden(self, code, daten, typ='application/json'):
        roh = json.dumps(daten, ensure_ascii=False).encode() if typ == 'application/json' else daten.encode()
        self.send_response(code)
        self.send_header('Content-Type', typ + ('' if typ == 'application/json' else '; charset=utf-8'))
        self.send_header('Content-Length', str(len(roh)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(roh)

    def erlaubt(self):
        if hmac.compare_digest(self.headers.get('X-Amberwave-Geraet', ''), schluessel()):
            return True
        self.senden(403, {'ok': False, 'fehler': 'schluessel'})
        return False

    def do_GET(self):
        if not self.erlaubt():
            return
        p = self.path.split('?')[0]
        try:
            if p == '/info':
                return self.senden(200, info())
            if p == '/protokoll':
                return self.senden(200, protokoll(), 'text/plain')
        except Exception as x:
            return self.senden(500, {'ok': False, 'fehler': 'intern', 'meldung': str(x)})
        self.senden(404, {'ok': False, 'fehler': 'unbekannt'})

    def do_POST(self):
        if not self.erlaubt():
            return
        n = int(self.headers.get('Content-Length') or 0)
        try:
            w = json.loads(self.rfile.read(min(n, 65536)) or b'{}')
        except ValueError:
            return self.senden(400, {'ok': False, 'fehler': 'json'})
        f = AKTIONEN.get(self.path.split('?')[0])
        if not f:
            return self.senden(404, {'ok': False, 'fehler': 'unbekannt'})
        try:
            with sperre:
                return self.senden(200, f(w if isinstance(w, dict) else {}))
        except Exception as x:
            return self.senden(500, {'ok': False, 'fehler': 'intern', 'meldung': str(x)})


if __name__ == '__main__':
    if '--netz' in sys.argv:
        e = einstellungen()
        # Neustart, bevor jemand die neue feste Adresse bestätigt hat → sicherheitshalber wieder automatisch
        if e.get('AW_NETZ_PROBE') == '1':
            e = einstellungen_schreiben({'AW_NETZ_ART': 'auto', 'AW_NETZ_PROBE': ''})
        netz_datei_schreiben(e)
        name_frueh_setzen(e)
        sys.exit(0)
    beim_start()
    ThreadingHTTPServer(('127.0.0.1', PORT), Anfrage).serve_forever()
