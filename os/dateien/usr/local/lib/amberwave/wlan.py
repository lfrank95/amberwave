#!/usr/bin/env python3
"""Amberwave OS – WLAN: ins Heimnetz einbuchen, Netze suchen und (nur bei der Einrichtung) ein eigener Hotspot.

Zugangsdaten kommen
  • vom USB-Stick (/run/live/medium/amberwave/wlan.txt – der USB-Ersteller trägt dort das WLAN des PCs ein),
  • aus der Einrichtung (Hotspot → Netz wählen) bzw. später aus Einstellungen › Amberwave OS,
  • im installierten System aus /daten/system/wlan.json (bleibt bei jeder Neuinstallation).
Der Hotspot „Amberwave-Einrichtung“ ist offen und lenkt jede Adresse auf die Einrichtungsseite (wie bei Smart-Home-
Geräten springt sie am Handy von selbst auf). Er läuft nur im Live-System und nur, solange es kein Netz gibt.

  wlan.py --verbinden     installiertes System, beim Start: mit dem gespeicherten WLAN verbinden
"""
import binascii, hashlib, json, os, re, socket, subprocess, threading, time

HOTSPOT_SSID = 'Amberwave-Einrichtung'
HOTSPOT_IP = '10.42.0.1'
LAND = os.environ.get('AW_WLAN_LAND', 'DE')
STICK_DATEI = '/run/live/medium/amberwave/wlan.txt'
DATEN_DATEI = '/daten/system/wlan.json'
LIVE_DATEI = '/run/amberwave/wlan.json'
NETZ_DATEI = '/etc/systemd/network/25-wlan.network'
HOTSPOT_NETZ = '/run/systemd/network/05-aw-hotspot.network'


def _aus(cmd, timeout=20):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except Exception:
        return ''


def _tun(cmd, timeout=30):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).returncode == 0
    except Exception:
        return False


def live():
    try:
        return 'boot=live' in open('/proc/cmdline').read().split()
    except OSError:
        return False


def schnittstelle():
    """Erste WLAN-Schnittstelle (oder '') – im Test lassen sich weitere simulierte Karten mit aw.wlan=<name> festlegen"""
    try:
        wahl = re.search(r'\baw\.wlan=(\S+)', open('/proc/cmdline').read())
        if wahl and os.path.isdir(f'/sys/class/net/{wahl.group(1)}'):
            return wahl.group(1)
    except OSError:
        pass
    for n in sorted(os.listdir('/sys/class/net')) if os.path.isdir('/sys/class/net') else []:
        if os.path.isdir(f'/sys/class/net/{n}/wireless') or os.path.exists(f'/sys/class/net/{n}/phy80211'):
            return n
    return ''


def hotspot_moeglich(dev):
    """Kann die Karte einen Zugangspunkt aufmachen? („AP“ unter den unterstützten Betriebsarten)"""
    try:
        phy = open(f'/sys/class/net/{dev}/phy80211/name').read().strip()
    except OSError:
        return False
    zeilen = _aus(['iw', 'phy', phy, 'info']).splitlines()
    for i, z in enumerate(zeilen):
        if 'Supported interface modes:' in z:
            for w in zeilen[i + 1:]:
                m = re.match(r'^\s*\*\s*(\S+)\s*$', w)
                if not m:
                    break
                if m.group(1) == 'AP':
                    return True
    return False


def _ssid_lesen(roh):
    """SSID aus der Ausgabe von iw (\\xNN-Schreibweise für Sonderzeichen)"""
    try:
        return re.sub(rb'\\x([0-9a-fA-F]{2})', lambda m: bytes([int(m.group(1), 16)]), roh.encode('latin-1', 'replace')).decode('utf-8', 'replace')
    except Exception:
        return roh


def scannen(dev):
    """Netze in der Umgebung, stärkstes zuerst: [{ssid, signal (dBm), sicher}]"""
    _tun(['ip', 'link', 'set', dev, 'up'])
    netze = {}
    for _ in range(3):
        roh = _aus(['iw', 'dev', dev, 'scan'], 30)
        for block in re.split(r'^BSS ', roh, flags=re.M)[1:]:
            m = re.search(r'^\s*SSID: (.*)$', block, re.M)
            if not m or not m.group(1).strip():
                continue
            ssid = _ssid_lesen(m.group(1).strip())
            s = re.search(r'signal: (-?[\d.]+) dBm', block)
            signal = float(s.group(1)) if s else -100.0
            sicher = bool(re.search(r'^\s*(RSN|WPA):', block, re.M))
            if ssid not in netze or netze[ssid]['signal'] < signal:
                netze[ssid] = {'ssid': ssid, 'signal': round(signal), 'sicher': sicher}
        if netze:
            break
        time.sleep(1.5)
    return sorted(netze.values(), key=lambda n: -n['signal'])


def _psk(ssid, passwort):
    return hashlib.pbkdf2_hmac('sha1', passwort.encode(), ssid.encode(), 4096, 32).hex()


def verbinden(dev, ssid, passwort):
    """WLAN-Zugang einrichten (wpa_supplicant + DHCP über systemd-networkd) und Verbindung starten"""
    zeilen = [f'ctrl_interface=/run/wpa_supplicant', 'update_config=0', f'country={LAND}', '', 'network={',
              f'  ssid={binascii.hexlify(ssid.encode()).decode()}', '  scan_ssid=1']
    if passwort:
        zeilen += ['  key_mgmt=WPA-PSK WPA-PSK-SHA256 SAE', f'  psk={_psk(ssid, passwort)}', '  ieee80211w=1']
        if '"' not in passwort and '\n' not in passwort:
            zeilen.append(f'  sae_password="{passwort}"')   # WPA3 braucht das Passwort selbst
    else:
        zeilen.append('  key_mgmt=NONE')
    zeilen.append('}')
    os.makedirs('/etc/wpa_supplicant', exist_ok=True)
    pfad = f'/etc/wpa_supplicant/wpa_supplicant-{dev}.conf'
    alt = os.umask(0o077)
    try:
        with open(pfad, 'w') as f:
            f.write('\n'.join(zeilen) + '\n')
    finally:
        os.umask(alt)
    if not os.path.exists(NETZ_DATEI):
        with open(NETZ_DATEI, 'w') as f:
            f.write('# Amberwave OS: WLAN holt sich seine Adresse per DHCP (Kabel hat Vorrang)\n[Match]\nType=wlan\n\n[Network]\n'
                    'DHCP=yes\nMulticastDNS=no\nLinkLocalAddressing=ipv6\nIgnoreCarrierLoss=3s\n\n[DHCPv4]\nUseHostname=no\nRouteMetric=600\n\n[IPv6AcceptRA]\nRouteMetric=600\n')
    _tun(['networkctl', 'reload'])
    _tun(['systemctl', 'restart', f'wpa_supplicant@{dev}'])
    _tun(['networkctl', 'reconfigure', dev])


def trennen(dev):
    _tun(['systemctl', 'stop', f'wpa_supplicant@{dev}'])
    try:
        os.unlink(f'/etc/wpa_supplicant/wpa_supplicant-{dev}.conf')
    except OSError:
        pass


def adresse(dev):
    for z in _aus(['ip', '-4', '-o', 'addr', 'show', 'dev', dev, 'scope', 'global']).splitlines():
        a = z.split()[3].split('/')[0]
        if a != HOTSPOT_IP:
            return a
    return ''


def warten_auf_adresse(dev, sekunden):
    ende = time.time() + sekunden
    while time.time() < ende:
        if adresse(dev):
            return True
        time.sleep(1)
    return False


def irgendein_netz(ohne=()):
    """Hat das Gerät schon eine Adresse (Kabel oder WLAN)? ohne: Schnittstellen, die nicht zählen"""
    for z in _aus(['ip', '-4', '-o', 'addr', 'show', 'scope', 'global']).splitlines():
        teile = z.split()
        if len(teile) > 3 and teile[1] not in ohne and not re.match(r'^(docker|br-|veth)', teile[1]) and teile[3].split('/')[0] != HOTSPOT_IP:
            return True
    return False


def verbindung(dev):
    """Aktuelle WLAN-Verbindung: {ssid, signal} oder None"""
    roh = _aus(['iw', 'dev', dev, 'link'])
    m = re.search(r'^\s*SSID: (.*)$', roh, re.M)
    if not m:
        return None
    s = re.search(r'signal: (-?\d+) dBm', roh)
    return {'ssid': _ssid_lesen(m.group(1).strip()), 'signal': int(s.group(1)) if s else None}


# ---------- Zugangsdaten ----------
def _stick_datei_lesen():
    """wlan.txt vom Stick: das Live-System läuft mit „toram“ aus dem Arbeitsspeicher, der Stick ist also nicht
    eingehängt – kurz nur lesend einhängen, lesen, wieder aushängen"""
    try:
        return open(STICK_DATEI, errors='replace').read()
    except OSError:
        pass
    for geraet in ('/dev/disk/by-partlabel/aw-stick', '/dev/disk/by-label/AMBERWAVE'):
        if not os.path.exists(geraet):
            continue
        ort = '/run/amberwave/stick'
        os.makedirs(ort, exist_ok=True)
        if not _tun(['mount', '-o', 'ro', geraet, ort]):
            continue
        try:
            return open(os.path.join(ort, 'amberwave', 'wlan.txt'), errors='replace').read()
        except OSError:
            return ''
        finally:
            _tun(['umount', ort])
    return ''


def stick_zugang():
    """Vom USB-Ersteller eingetragen: ssid_hex=…, psk_hex=… (Hex, damit jedes Zeichen sicher ankommt)"""
    roh = _stick_datei_lesen()
    w = dict(re.findall(r'^(\w+)=([0-9a-fA-F]*)\s*$', roh, re.M))
    try:
        ssid = bytes.fromhex(w.get('ssid_hex', '')).decode('utf-8')
        pw = bytes.fromhex(w.get('psk_hex', '')).decode('utf-8')
    except ValueError:
        return None
    return {'ssid': ssid, 'passwort': pw} if ssid else None


def zugang_lesen(pfad):
    try:
        z = json.load(open(pfad))
        return z if z.get('ssid') else None
    except (OSError, ValueError):
        return None


def zugang_speichern(pfad, ssid, passwort):
    os.makedirs(os.path.dirname(pfad), exist_ok=True)
    alt = os.umask(0o077)
    try:
        with open(pfad + '.neu', 'w') as f:
            json.dump({'ssid': ssid, 'passwort': passwort}, f)
        os.replace(pfad + '.neu', pfad)
    finally:
        os.umask(alt)


# ---------- Hotspot (nur Einrichtung) ----------
class Hotspot:
    """Offenes WLAN „Amberwave-Einrichtung“ mit DHCP (systemd-networkd) und einem DNS, das jede Frage mit der eigenen
    Adresse beantwortet – so landet das Handy auf der Einrichtungsseite (Captive Portal)."""

    def __init__(self, dev):
        self.dev = dev
        self.hostapd = None
        self.dns = None
        self.an = False

    def starten(self):
        trennen(self.dev)
        os.makedirs(os.path.dirname(HOTSPOT_NETZ), exist_ok=True)
        with open(HOTSPOT_NETZ, 'w') as f:
            f.write(f'[Match]\nName={self.dev}\n\n[Network]\nAddress={HOTSPOT_IP}/24\nDHCPServer=yes\nLinkLocalAddressing=no\nIPv6AcceptRA=no\n\n'
                    f'[DHCPServer]\nPoolOffset=20\nPoolSize=100\nEmitDNS=yes\nDNS={HOTSPOT_IP}\nEmitRouter=yes\nDefaultLeaseTimeSec=600\n')
        conf = '/run/amberwave/hostapd.conf'
        os.makedirs('/run/amberwave', exist_ok=True)
        with open(conf, 'w') as f:
            f.write(f'interface={self.dev}\ndriver=nl80211\nssid={HOTSPOT_SSID}\ncountry_code={LAND}\nieee80211d=1\n'
                    'hw_mode=g\nchannel=6\nieee80211n=1\nwmm_enabled=1\nauth_algs=1\nignore_broadcast_ssid=0\n')
        _tun(['ip', 'link', 'set', self.dev, 'down'])
        self.hostapd = subprocess.Popen(['hostapd', conf], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(2)
        if self.hostapd.poll() is not None:
            self.aufraeumen()
            return False
        _tun(['networkctl', 'reload'])
        _tun(['networkctl', 'reconfigure', self.dev])
        self.an = True
        with open('/run/amberwave/hotspot', 'w') as f:   # für die Anzeige am Bildschirm
            f.write(HOTSPOT_SSID)
        self.dns = threading.Thread(target=self._dns, daemon=True)
        self.dns.start()
        return True

    def _dns(self):
        s = None
        while self.an and s is None:   # die Adresse ist erst da, wenn networkd die Schnittstelle eingerichtet hat
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind((HOTSPOT_IP, 53))
            except OSError:
                s = None
                time.sleep(1)
        if s is None:
            return
        s.settimeout(1)
        ip = socket.inet_aton(HOTSPOT_IP)
        while self.an:
            try:
                frage, von = s.recvfrom(512)
            except socket.timeout:
                continue
            except OSError:
                break
            antwort = dns_antwort(frage, ip)
            if antwort:
                try:
                    s.sendto(antwort, von)
                except OSError:
                    pass
        s.close()

    def stoppen(self):
        self.an = False
        self.aufraeumen()

    def aufraeumen(self):
        try:
            os.unlink('/run/amberwave/hotspot')
        except OSError:
            pass
        if self.hostapd and self.hostapd.poll() is None:
            self.hostapd.terminate()
            try:
                self.hostapd.wait(5)
            except subprocess.TimeoutExpired:
                self.hostapd.kill()
        self.hostapd = None
        try:
            os.unlink(HOTSPOT_NETZ)
        except OSError:
            pass
        _tun(['ip', 'addr', 'flush', 'dev', self.dev])
        _tun(['networkctl', 'reload'])


def dns_antwort(frage, ip):
    """Antwort auf eine DNS-Frage: A → unsere Adresse, alles andere → leer (aber ohne Fehler)"""
    if len(frage) < 12:
        return None
    pos = 12
    while pos < len(frage) and frage[pos] != 0:
        pos += frage[pos] + 1
    pos += 1
    if pos + 4 > len(frage):
        return None
    qtyp = int.from_bytes(frage[pos:pos + 2], 'big')
    fragen_teil = frage[12:pos + 4]
    a = qtyp == 1
    kopf = frage[:2] + b'\x81\x80' + b'\x00\x01' + (b'\x00\x01' if a else b'\x00\x00') + b'\x00\x00\x00\x00'
    rumpf = fragen_teil + ((b'\xc0\x0c' + b'\x00\x01\x00\x01' + (30).to_bytes(4, 'big') + b'\x00\x04' + ip) if a else b'')
    return kopf + rumpf


# ---------- installiertes System ----------
def beim_start():
    """Installiertes System: mit dem gespeicherten WLAN verbinden (wenn es eine Karte und Zugangsdaten gibt)"""
    dev = schnittstelle()
    z = zugang_lesen(DATEN_DATEI)
    if dev and z:
        verbinden(dev, z['ssid'], z.get('passwort', ''))


if __name__ == '__main__':
    import sys
    if '--verbinden' in sys.argv:
        beim_start()
