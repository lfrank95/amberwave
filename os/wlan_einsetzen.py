#!/usr/bin/env python3
"""WLAN-Zugang in ein Amberwave-OS-Image eintragen – dasselbe, was der USB-Ersteller beim Schreiben macht.

  wlan_einsetzen.py <image> --pruefen          nur nachsehen: genau ein Platzhalter, auf einer Sektorgrenze?
  wlan_einsetzen.py <image> <ssid> <passwort>  eintragen (für Tests)
Der Platzhalter ist der Anfang von /amberwave/wlan.txt auf dem Stick; ersetzt wird genau dieser eine Sektor (512 Byte).
"""
import sys

MARKE = b'#AMBERWAVE-WLAN-PLATZHALTER-7f3a9c#\n'


def sektor(ssid, passwort):
    text = f'# Amberwave: WLAN vom USB-Ersteller\nssid_hex={ssid.encode().hex()}\npsk_hex={passwort.encode().hex()}\n'.encode()
    return text + b'\n' * (512 - len(text))


def finden(roh):
    funde, pos = [], roh.find(MARKE)
    while pos >= 0:
        funde.append(pos)
        pos = roh.find(MARKE, pos + 1)
    return funde


if __name__ == '__main__':
    pfad = sys.argv[1]
    with open(pfad, 'r+b') as f:
        roh = f.read()
        funde = finden(roh)
        if len(funde) != 1 or funde[0] % 512:
            sys.exit(f'Platzhalter: {len(funde)} Fund(e) {funde[:3]} – erwartet genau einer auf einer Sektorgrenze')
        if sys.argv[2:3] == ['--pruefen']:
            print(f'WLAN-Platzhalter bei Byte {funde[0]} (Sektor {funde[0] // 512})')
            sys.exit(0)
        f.seek(funde[0])
        f.write(sektor(sys.argv[2], sys.argv[3]))
        print(f'WLAN „{sys.argv[2]}“ eingetragen (Sektor {funde[0] // 512})')
