"""Amberwave OS – gemeinsame Helfer für den Installer (Live-System) und den Gerätedienst (installiertes System)."""
import json, os, re, shutil, subprocess, tempfile


def _aus(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=15).stdout
    except Exception:
        return ''


def lsblk():
    return json.loads(_aus(['lsblk', '-J', '-b', '-o', 'NAME,TYPE,SIZE,MODEL,TRAN,RM,ROTA,PARTLABEL,LABEL,FSTYPE,UUID,MOUNTPOINT']) or '{"blockdevices":[]}').get('blockdevices', [])


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
                              'label': t.get('label') or '', 'fstype': t['fstype'], 'modell': (d.get('model') or '').strip(), 'art': art})
    return [z for z in ziele if z['groesse'] >= 16 * 1024**3], musik


def kanal_standard():
    """Kanal, mit dem dieses Image gebaut wurde (stabiles Release → latest, Beta → beta)"""
    try:
        with open('/etc/amberwave-kanal') as f:
            k = f.read().strip()
            return k if k in ('beta', 'latest', 'main') else 'beta'
    except OSError:
        return 'beta'


def ips(familie='-4'):
    return [z.split()[3].split('/')[0] for z in _aus(['ip', familie, '-o', 'addr', 'show', 'scope', 'global']).splitlines() if len(z.split()) > 3
            and not re.match(r'^(docker|br-|veth)', z.split()[1])]


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
