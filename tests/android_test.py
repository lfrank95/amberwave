#!/usr/bin/env python3
"""Rauchtest der Android-App im Emulator (GitHub Actions): installieren, Server eintragen, anmelden, ein Album offline
speichern (Opus, dann Original), abspielen (Benachrichtigung/Sperrbildschirm), ohne Netz neu starten.

Gesteuert wird die Oberfläche über die Entwicklerwerkzeuge der WebView (nur mit dem Test-Schalter aw_test, nur über adb).
Aufruf: android_test.py <apk>   – Testserver auf 127.0.0.1:8080 (tests/android_server.sh)
"""
import json
import re
import subprocess
import sys
import time
import urllib.request

import websocket  # pip install websocket-client

PAKET = 'io.github.lfrank95.amberwave'
SERVER = 'http://127.0.0.1:8080'
fehler = 0


def ok(t):
    print(f'::notice title=Android-Test::{t}', flush=True)


def schlecht(t):
    global fehler
    fehler = 1
    print(f'::error title=Android-Test::{t}', flush=True)


def adb(*a, pruefen=False):
    r = subprocess.run(['adb', *a], capture_output=True, text=True, timeout=180)
    if pruefen and r.returncode != 0:
        raise RuntimeError(f'adb {" ".join(a)}: {r.stderr.strip()}')
    return r.stdout


class Seite:
    """Verbindung zu den Entwicklerwerkzeugen der WebView"""

    def __init__(self):
        self.ws = None
        self.n = 0

    def verbinden(self, zeit=60):
        ende = time.time() + zeit
        while time.time() < ende:
            pid = adb('shell', 'pidof', PAKET).strip()
            sockel = [z.split('@')[-1] for z in adb('shell', 'cat', '/proc/net/unix').splitlines() if 'webview_devtools_remote' in z]
            sockel = [s for s in sockel if s.endswith('_' + pid)] or sockel
            if pid and sockel:
                adb('forward', '--remove-all')
                adb('forward', 'tcp:9333', f'localabstract:{sockel[0].strip()}')
                try:
                    ziele = json.load(urllib.request.urlopen('http://127.0.0.1:9333/json', timeout=5))
                    seiten = [z for z in ziele if z.get('type') == 'page' and z.get('webSocketDebuggerUrl')]
                    if seiten:
                        self.ws = websocket.create_connection(seiten[0]['webSocketDebuggerUrl'], timeout=30, suppress_origin=True)
                        return True
                except Exception as e:  # noqa: BLE001
                    print('warte auf WebView:', e)
            time.sleep(2)
        return False

    def js(self, ausdruck, warten=True):
        self.n += 1
        nr = self.n
        self.ws.send(json.dumps({'id': nr, 'method': 'Runtime.evaluate', 'params': {'expression': ausdruck, 'awaitPromise': warten, 'returnByValue': True}}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get('id') == nr:
                r = m.get('result', {})
                if 'exceptionDetails' in r:
                    raise RuntimeError(r['exceptionDetails'].get('exception', {}).get('description') or r['exceptionDetails'].get('text'))
                return r.get('result', {}).get('value')

    def bis(self, ausdruck, zeit=60, schritt=1.0):
        ende = time.time() + zeit
        letzt = None
        while time.time() < ende:
            try:
                letzt = self.js(ausdruck)
                if letzt:
                    return letzt
            except Exception as e:  # noqa: BLE001 – Seite wechselt gerade
                letzt = str(e)
            time.sleep(schritt)
        print('zuletzt:', letzt)
        return None


def starten(s, test=True):
    adb('shell', 'am', 'start', '-W', '-n', f'{PAKET}/.MainActivity', '--ez', 'aw_test', 'true' if test else 'false')
    if not s.verbinden():
        schlecht('Entwicklerwerkzeuge der WebView nicht erreichbar')
        sys.exit(1)


def main():
    apk = sys.argv[1]
    adb('install', '-r', apk, pruefen=True)
    ok('APK installiert')
    adb('shell', 'pm', 'grant', PAKET, 'android.permission.POST_NOTIFICATIONS')
    adb('reverse', 'tcp:8080', 'tcp:8080')
    s = Seite()
    starten(s)

    # 1. Startseite: Server eintragen
    if s.bis("location.href.includes('start.html') && !!window.AwAndroid", 30):
        ok('Startseite mit Brücke')
    else:
        schlecht('Startseite fehlt')
    s.js("document.getElementById('adresse').value = '127.0.0.1:8080'; document.querySelector('[data-form]').requestSubmit(); true")
    # https geht hier nicht – die App versucht danach http
    if s.bis("location.pathname.includes('login.php')", 60):
        ok('Server gefunden (http), Anmeldeseite')
    else:
        schlecht('Server nicht gefunden: ' + str(s.js("document.querySelector('[data-fehler]')?.textContent || location.href")))
        sys.exit(1)
    if s.js("document.querySelector('input[name=geraet_merken]').checked"):
        ok('„Gerät merken“ in der App vorausgewählt')
    else:
        schlecht('„Gerät merken“ nicht vorausgewählt')
    s.js("document.getElementById('f-name').value='testadmin'; document.getElementById('f-pw').value='Test-Passwort-2026'; document.querySelector('form.formular').submit(); true")
    if s.bis("document.documentElement.classList.contains('aw-android') && !!document.querySelector('.kopf')", 60):
        ok('angemeldet, Oberfläche läuft mit Android-Brücke')
    else:
        schlecht('Oberfläche startet nicht: ' + str(s.js('location.href')))
        sys.exit(1)

    # 2. Album offline speichern (Opus)
    alben = s.js("fetch('/api/v1/alben').then(r => r.json())")
    liste = alben.get('alben') if isinstance(alben, dict) else alben
    album = next(a for a in liste if 'Unterwegs' in json.dumps(a))
    aid = album['id']
    s.js(f"history.pushState({{}}, '', '/alben/{aid}'); dispatchEvent(new PopStateEvent('popstate')); true")
    if not s.bis(f"!!document.querySelector('[data-offline=\"album:{aid}\"]')", 30):
        schlecht('Offline-Knopf am Album fehlt')
        sys.exit(1)
    s.js(f"document.querySelector('[data-offline=\"album:{aid}\"]').click(); true")
    d = s.bis("(() => { const d = JSON.parse(AwAndroid.dateien()); return Object.keys(d).length >= 3 ? d : null })()", 120, 2)
    if d:
        formate = sorted({v['format'] for v in d.values()})
        ok(f'3 Titel offline gespeichert ({formate}, {sum(v["bytes"] for v in d.values()) // 1024} KB)')
        if formate != ['opus']:
            schlecht(f'erwartet Opus, bekommen {formate}')
    else:
        schlecht('Offline-Speichern läuft nicht durch')
    if s.bis(f"document.querySelector('[data-offline=\"album:{aid}\"]')?.classList.contains('an')", 20):
        ok('Knopf zeigt „gespeichert“')
    else:
        schlecht('Knopf zeigt nicht „gespeichert“')
    tid = int(next(iter(d))) if d else 0
    groesse = s.js(f"fetch('/__aw/offline/{tid}').then(r => r.blob()).then(b => b.size)")
    if groesse and groesse > 1000:
        ok(f'Ton aus dem Speicher der App lesbar ({groesse} Bytes)')
    else:
        schlecht(f'Ton aus dem Speicher nicht lesbar ({groesse})')

    # 3. Qualität Original wählen und neu laden
    s.js("history.pushState({}, '', '/einstellungen/wiedergabe'); dispatchEvent(new PopStateEvent('popstate')); true")
    if s.bis("!!document.querySelector('[data-offline-q] option[value=original]')", 30):
        ok('Einstellung „Qualität beim Speichern“ bietet Original an')
        s.js("const e = document.querySelector('[data-offline-q]'); e.value = 'original'; e.dispatchEvent(new Event('change')); true")
        s.js("history.pushState({}, '', '/offline'); dispatchEvent(new PopStateEvent('popstate')); true")
        if s.bis("!!document.querySelector('[data-off-qualitaet]')", 20):
            s.js("document.querySelector('[data-off-qualitaet]').click(); true")
            d2 = s.bis("(() => { const d = JSON.parse(AwAndroid.dateien()); const f = Object.values(d).map((x) => x.format).sort().join(','); return f === 'flac,flac,mp3' ? f : null })()", 120, 2)
            if d2:
                ok(f'in Originalqualität neu geladen ({d2})')
            else:
                schlecht('Original neu laden: ' + str(s.js('AwAndroid.dateien()')))
        else:
            schlecht('„Neu laden“ für andere Qualität fehlt')
    else:
        schlecht('Qualitätswahl fehlt in den Einstellungen')

    # 4. Abspielen: Benachrichtigung und Sperrbildschirm
    s.js(f"history.pushState({{}}, '', '/alben/{aid}'); dispatchEvent(new PopStateEvent('popstate')); true")
    s.bis("!!document.querySelector('[data-aktion=\"track-play\"]')", 20)
    s.js("document.querySelector('[data-aktion=\"track-play\"]').click(); true")
    sitzung = ''
    for _ in range(20):
        time.sleep(1.5)
        sitzung = adb('shell', 'dumpsys', 'media_session')
        if PAKET in sitzung and re.search(r'state=PlaybackState \{state=(3|PLAYING)', sitzung):
            break
    if PAKET in sitzung and 'Erster Titel' in sitzung:
        ok('Mediensitzung mit Titel (Sperrbildschirm, Kopfhörertasten)')
    else:
        schlecht('Mediensitzung fehlt oder ohne Titel')
    if re.search(r'state=PlaybackState \{state=(3|PLAYING)', sitzung):
        ok('Wiedergabe läuft (Zustand „spielt“)')
    else:
        print('::warning title=Android-Test::Zustand „spielt“ nicht erreicht (Emulator ohne Ton?)')
    if PAKET in adb('shell', 'dumpsys', 'notification', '--noredact'):
        ok('Benachrichtigung da')
    # Taste „Pause“ wie vom Kopfhörer
    adb('shell', 'input', 'keyevent', 'KEYCODE_MEDIA_PAUSE')
    time.sleep(2)
    if s.js("navigator.mediaSession.playbackState") == 'paused':
        ok('Medientaste Pause kommt im Player an')
    else:
        print('::warning title=Android-Test::Medientaste Pause: Zustand ' + str(s.js('navigator.mediaSession.playbackState')))

    # 5. Ohne Netz neu starten
    adb('reverse', '--remove-all')
    adb('shell', 'svc', 'wifi', 'disable')
    adb('shell', 'svc', 'data', 'disable')
    time.sleep(3)
    adb('shell', 'am', 'force-stop', PAKET)
    time.sleep(1)
    starten(s)
    if s.bis("document.documentElement.classList.contains('app-offline')", 60):
        ok('ohne Netz gestartet (Offline-Modus)')
    else:
        schlecht('Start ohne Netz: ' + str(s.js("location.href + ' ' + document.documentElement.className")))
    s.js("history.pushState({}, '', '/offline'); dispatchEvent(new PopStateEvent('popstate')); true")
    if s.bis("document.querySelectorAll('.offline-zeile').length >= 1", 20):
        ok('„Auf diesem Gerät“ zeigt das Album ohne Netz')
    else:
        schlecht('„Auf diesem Gerät“ leer ohne Netz')
    groesse = s.js(f"fetch('/__aw/offline/{tid}').then(r => r.blob()).then(b => b.size)") if tid else 0
    if groesse and groesse > 1000:
        ok('Ton ohne Netz lesbar')
    else:
        schlecht('Ton ohne Netz nicht lesbar')
    adb('shell', 'svc', 'wifi', 'enable')
    adb('shell', 'svc', 'data', 'enable')
    sys.exit(fehler)


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001 – als Anmerkung sichtbar machen
        import traceback
        z = traceback.format_exc().strip().splitlines()
        print(f'::error title=Android-Test (Abbruch)::{type(e).__name__}: {e} | ' + ' | '.join(x.strip() for x in z[-6:]), flush=True)
        sys.exit(1)
