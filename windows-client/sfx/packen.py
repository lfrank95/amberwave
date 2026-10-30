#!/usr/bin/env python3
"""Selbstentpackendes Paket bauen: packen.py stub.exe ordner ziel.exe
Hängt an die stub.exe einen xz-Strom (LZMA2 9e mit x86-Filter) mit allen Dateien des Ordners und den Anhang an
(u64 Beginn, u64 Länge, u64 entpackte Größe, "AWSFX002" – die Größe zeigt der Assistent als benötigten Platz)."""
import lzma, os, shutil, struct, subprocess, sys

stub, ordner, ziel = sys.argv[1:4]
tmp = ziel + '.xz.tmp'
# Stufe: AW_XZ_STUFE (Standard 9e); ohne xz-Programm (z. B. unter Windows) mit Pythons lzma – gleiches Format
stufe = os.environ.get('AW_XZ_STUFE', '9e')
if shutil.which('xz'):
    xz = subprocess.Popen(['xz', '--format=xz', '--check=crc32', '--x86', f'--lzma2=preset={stufe},dict=64MiB', '-T1', '-c'], stdin=subprocess.PIPE, stdout=open(tmp, 'wb'))
else:
    class _Xz:
        def __init__(self):
            p = int(stufe.rstrip('e')) | (lzma.PRESET_EXTREME if stufe.endswith('e') else 0)
            self.out = open(tmp, 'wb')
            self.c = lzma.LZMACompressor(format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC32,
                                         filters=[{'id': lzma.FILTER_X86}, {'id': lzma.FILTER_LZMA2, 'preset': p, 'dict_size': 64 << 20}])
            self.stdin = self
        def write(self, b):
            self.out.write(self.c.compress(b))
        def close(self):
            self.out.write(self.c.flush()); self.out.close()
        def wait(self):
            return 0
    xz = _Xz()
dateien = []
for wurzel, _, namen in os.walk(ordner):
    for n in sorted(namen):
        dateien.append(os.path.join(wurzel, n))
for p in sorted(dateien):
    rel = os.path.relpath(p, ordner).replace(os.sep, '/').encode('utf-8')
    xz.stdin.write(struct.pack('<H', len(rel)) + rel + struct.pack('<Q', os.path.getsize(p)))
    with open(p, 'rb') as f:
        while True:
            b = f.read(1 << 20)
            if not b:
                break
            xz.stdin.write(b)
xz.stdin.write(struct.pack('<H', 0))
xz.stdin.close()
if xz.wait() != 0:
    sys.exit('xz fehlgeschlagen')
with open(ziel, 'wb') as aus:
    aus.write(open(stub, 'rb').read())
    beginn = aus.tell()
    with open(tmp, 'rb') as f:
        while True:
            b = f.read(1 << 20)
            if not b:
                break
            aus.write(b)
    laenge = aus.tell() - beginn
    roh = sum(os.path.getsize(p) for p in dateien)
    aus.write(struct.pack('<QQQ', beginn, laenge, roh) + b'AWSFX002')
os.remove(tmp)
print(f'{ziel}: {len(dateien)} Dateien, {os.path.getsize(ziel) / 1e6:.1f} MB')
