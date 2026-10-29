#!/usr/bin/env python3
"""Große synthetische Musiksammlung für Lasttests (schnell, ohne ffmpeg pro Datei).

Aufruf: erzeugen.py <ziel> <anzahl_titel> [seed]
Struktur: Künstler/Album (Jahr)/[CD1/]NN - Titel.flac, dazu cover.jpg je Album.
Mischung: ~85 % FLAC 16/44.1, ~10 % FLAC 24/96 (nur STREAMINFO), ~5 % MP3; ~8 % Sampler (Various Artists),
~5 % Mehr-CD-Alben, Sonderzeichen/Umlaute/Emoji in Namen, wenige Dateien ohne Tags.
"""
import os, random, struct, sys, io
from PIL import Image

ziel, anzahl = sys.argv[1], int(sys.argv[2])
rnd = random.Random(int(sys.argv[3]) if len(sys.argv) > 3 else 7)
H = os.path.dirname(os.path.abspath(__file__))

flac = open(os.path.join(H, 'vorlage.flac'), 'rb').read()
streaminfo = bytearray(flac[8:8 + 34])
audio = flac[8288:]
mp3_audio = open(os.path.join(H, 'vorlage.mp3'), 'rb').read()

SILBEN = ['ka', 'lo', 'mer', 'tin', 'sa', 'vel', 'ra', 'don', 'el', 'mi', 'tor', 'na', 'bel', 'cor', 'wyn', 'ast', 'or', 'lin', 'phe', 'qua', 'zen', 'dro', 'ly', 'sk']
WORTE = ['Glass', 'River', 'Lanterns', 'Static', 'Echo', 'Harbor', 'Golden', 'Hours', 'Tide', 'Paper', 'Copper', 'Silent', 'Summer', 'Signal', 'Velvet', 'Lines', 'North', 'Ember', 'Afterglow', 'Drift', 'Orbit', 'Ashes', 'Porch', 'Rain', 'Wires', 'Satellite', 'Morning', 'Coast', 'Fever', 'Bloom', 'Hollow', 'Parade', 'Letters', 'Window', 'Neon', 'Compass', 'Ghost', 'Highway', 'Cathedral', 'Mirror', 'Season', 'Thunder', 'Velour', 'Kingdom', 'Garden', 'Shadow', 'Heart', 'Night', 'Light', 'Fire', 'Stone', 'Water', 'Sky', 'Dust', 'Gold', 'Blue', 'Red', 'Wild', 'Lost', 'Last', 'First', 'Song', 'Dance', 'Dream', 'Road', 'Home', 'Love', 'Time', 'Ocean', 'Mountain', 'Sun', 'Moon', 'Star', 'City', 'Street', 'Train', 'Radio', 'Machine', 'Fields']
EXTRA = ['Ä', 'ö', 'ü', 'ß', 'é', 'ñ', 'ø', '&', '!', "'", '★', '♪', '日本', '–', '(Live)', '[Remastered]', 'pt. 2', 'feat.']
GENRES = ['Rock', 'Pop', 'Jazz', 'Electronic', 'Folk', 'Classical', 'Hip-Hop', 'Soul', 'Metal', 'Ambient', 'Blues', 'Country', 'Reggae', 'Funk', 'Punk', 'Indie', 'Latin', 'Soundtrack']


def name_person():
    w = lambda: ''.join(rnd.choice(SILBEN) for _ in range(rnd.randint(2, 3))).capitalize()
    return f'{w()} {w()}'


def name_band():
    n = ' '.join(rnd.sample(WORTE, rnd.choice([1, 2, 2, 3])))
    return ('The ' + n) if rnd.random() < .3 else n


def titel():
    t = ' '.join(rnd.sample(WORTE, rnd.choice([1, 2, 2, 3, 4])))
    if rnd.random() < .06:
        t += ' ' + rnd.choice(EXTRA)
    return t


def sicher(s):
    return ''.join('_' if c in '/\\:*?"<>|' else c for c in s).strip(' .')[:120] or '_'


def vorbis(kommentare):
    v = b'Amberwave Lasttest'
    b = struct.pack('<I', len(v)) + v + struct.pack('<I', len(kommentare))
    for k, w in kommentare:
        e = f'{k}={w}'.encode('utf-8')
        b += struct.pack('<I', len(e)) + e
    return b


def flac_datei(pfad, tags, dauer, hires):
    si = bytearray(streaminfo)
    rate, bits = (96000, 24) if hires else (44100, 16)
    samples = int(dauer * rate)
    # Bytes 10..17: 20 Bit Rate, 3 Bit Kanäle-1, 5 Bit Bittiefe-1, 36 Bit Samples
    wert = (rate << 44) | (1 << 41) | ((bits - 1) << 36) | samples
    si[10:18] = wert.to_bytes(8, 'big')
    blocke = b'\x00' + len(si).to_bytes(3, 'big') + bytes(si)
    vc = vorbis(tags) if tags else b''
    if vc:
        blocke += bytes([0x84]) + len(vc).to_bytes(3, 'big') + vc
    else:
        blocke = bytes([0x80]) + blocke[1:]
    with open(pfad, 'wb') as f:
        f.write(b'fLaC' + blocke + audio)


def id3_frame(fid, text):
    d = b'\x03' + text.encode('utf-8')
    return fid.encode() + struct.pack('>I', len(d)) + b'\x00\x00' + d


def syncsafe(n):
    return bytes([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127])


def mp3_datei(pfad, tags):
    m = {'TITLE': 'TIT2', 'ARTIST': 'TPE1', 'ALBUM': 'TALB', 'ALBUMARTIST': 'TPE2', 'TRACKNUMBER': 'TRCK', 'DATE': 'TDRC', 'GENRE': 'TCON', 'DISCNUMBER': 'TPOS'}
    fr = b''.join(id3_frame(m[k], w) for k, w in tags if k in m)
    with open(pfad, 'wb') as f:
        f.write(b'ID3\x04\x00\x00' + syncsafe(len(fr)) + fr + mp3_audio)


cover_cache = {}


def cover(pfad, farbe):
    if farbe not in cover_cache:
        b = io.BytesIO()
        Image.new('RGB', (300, 300), farbe).save(b, 'JPEG', quality=70)
        cover_cache[farbe] = b.getvalue()
    with open(pfad, 'wb') as f:
        f.write(cover_cache[farbe])


os.makedirs(ziel, exist_ok=True)
anzahl_kuenstler = max(20, anzahl // 40)
kuenstler = [(name_person() if rnd.random() < .45 else name_band()) for _ in range(anzahl_kuenstler)]
# Zipf-artig: wenige Künstler mit vielen Alben
gewichte = [1 / (i + 1) ** .8 for i in range(anzahl_kuenstler)]
erzeugt = 0
alben = 0
while erzeugt < anzahl:
    sampler = rnd.random() < .08
    ak = 'Various Artists' if sampler else rnd.choices(kuenstler, gewichte)[0]
    jahr = rnd.randint(1955, 2025)
    at = titel()
    genre = rnd.choice(GENRES)
    ordner = os.path.join(ziel, sicher(ak), sicher(f'{at} ({jahr})'))
    if os.path.exists(ordner):
        continue
    os.makedirs(ordner)
    cover(os.path.join(ordner, 'cover.jpg'), (rnd.randint(20, 235), rnd.randint(20, 235), rnd.randint(20, 235)))
    cds = 2 if rnd.random() < .05 else 1
    hires = rnd.random() < .10
    mp3 = not hires and rnd.random() < .05
    for cd in range(1, cds + 1):
        n = rnd.randint(6, 16)
        unter = os.path.join(ordner, f'CD{cd}') if cds > 1 else ordner
        os.makedirs(unter, exist_ok=True)
        for t in range(1, n + 1):
            tt = titel()
            ka = rnd.choice(kuenstler) if sampler else ak
            if not sampler and rnd.random() < .07:
                ka = f'{ak} feat. {rnd.choice(kuenstler)}'
            tags = [('TITLE', tt), ('ARTIST', ka), ('ALBUM', at), ('ALBUMARTIST', ak), ('TRACKNUMBER', f'{t}/{n}'),
                    ('DATE', str(jahr)), ('GENRE', genre)]
            if cds > 1:
                tags.append(('DISCNUMBER', f'{cd}/{cds}'))
            if rnd.random() < .01:
                tags = []   # Datei ohne Tags
            dauer = rnd.randint(120, 420)
            name = sicher(f'{t:02d} - {tt}') + ('.mp3' if mp3 else '.flac')
            pfad = os.path.join(unter, name)
            if mp3:
                mp3_datei(pfad, tags)
            else:
                flac_datei(pfad, tags, dauer, hires)
            erzeugt += 1
    alben += 1
print(f'{erzeugt} Titel in {alben} Alben, {anzahl_kuenstler} Künstler → {ziel}')
