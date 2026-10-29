#!/usr/bin/env python3
"""Bilder für den Installationsassistenten und das Programmsymbol.

Aufruf: assistent_bilder.py <icon-256.png> <ausgabeordner> [schrift.ttf|woff2]
Erzeugt:
  symbol.ico           – alle Größen 16…256; 16, 24, 32, 48 px als klassisches BMP (DIB mit Maske), sonst PNG – so zeigen
                         Explorer, Taskleiste und ältere Dialoge das Symbol überall zuverlässig
  assistent_seite.bmp  – Seitenbild für Willkommen/Fertig (164 × 314 bei 100 %, hier doppelt: 328 × 628), 24 Bit
"""
import io
import os
import struct
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

quelle, aus = sys.argv[1], sys.argv[2]
schrift_pfad = sys.argv[3] if len(sys.argv) > 3 else ''
os.makedirs(aus, exist_ok=True)
icon = Image.open(quelle).convert('RGBA')


# ---------- ICO ----------
def dib(bild):
    """32-Bit-BGRA-DIB mit AND-Maske, wie es im ICO steht (Höhe doppelt, Zeilen von unten)"""
    w, h = bild.size
    kopf = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    px = bild.load()
    farben = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = px[x, y]
            farben += bytes((b, g, r, a))
    zeile = ((w + 31) // 32) * 4
    maske = bytearray()
    for y in range(h - 1, -1, -1):
        bits = bytearray(zeile)
        for x in range(w):
            if px[x, y][3] < 128:
                bits[x // 8] |= 0x80 >> (x % 8)
        maske += bits
    return kopf + bytes(farben) + bytes(maske)


groessen = [16, 20, 24, 32, 40, 48, 64, 128, 256]
eintraege = []
for g in groessen:
    b = icon.resize((g, g), Image.LANCZOS)
    if g in (16, 24, 32, 48):   # klassische Größen als BMP; 20/40 als PNG (die Ressourcen-Sektion der Electron-exe ist knapp)
        daten = dib(b)
    else:
        puffer = io.BytesIO()
        b.save(puffer, 'PNG')
        daten = puffer.getvalue()
    eintraege.append((g, daten))
kopf = struct.pack('<HHH', 0, 1, len(eintraege))
versatz = 6 + 16 * len(eintraege)
verzeichnis = b''
inhalt = b''
for g, daten in eintraege:
    verzeichnis += struct.pack('<BBBBHHII', g % 256, g % 256, 0, 0, 1, 32, len(daten), versatz + len(inhalt))
    inhalt += daten
with open(os.path.join(aus, 'symbol.ico'), 'wb') as f:
    f.write(kopf + verzeichnis + inhalt)


# ---------- Seitenbild ----------
def schrift(groesse, gewicht=700):
    for p in (schrift_pfad, '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'):
        if p and os.path.exists(p):
            try:
                f = ImageFont.truetype(p, groesse)
                try:
                    f.set_variation_by_axes([gewicht])
                except Exception:
                    pass
                return f
            except Exception:
                continue
    return ImageFont.load_default()


W, H = 328, 628
seite = Image.new('RGB', (W, H), (18, 13, 10))
px = seite.load()
# warmer Verlauf von oben nach unten, dazu ein Lichtschein hinter dem Symbol
for y in range(H):
    t = y / (H - 1)
    for x in range(W):
        dx, dy = (x - W * 0.5) / W, (y - 210) / H
        schein = max(0.0, 1.0 - (dx * dx * 3.2 + dy * dy * 6.0) ** 0.5)
        r = 18 + 30 * (1 - t) + 70 * schein ** 2
        g = 13 + 14 * (1 - t) + 34 * schein ** 2
        b = 10 + 6 * (1 - t) + 6 * schein ** 2
        px[x, y] = (int(min(255, r)), int(min(255, g)), int(min(255, b)))
# Wellenlinie unten (wie die Balken im Logo, ganz leise)
lage = Image.new('RGBA', (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(lage)
import math
for i in range(26):
    x = 14 + i * 12
    hoehe = 18 + 46 * abs(math.sin(i * 0.55)) * (0.55 + 0.45 * math.sin(i * 0.23 + 1))
    d.rounded_rectangle((x, 560 - hoehe, x + 6, 560 + hoehe * 0.25), radius=3, fill=(255, 150, 70, 38))
seite.paste(lage, (0, 0), lage)
# Symbol mit weichem Schatten
s = 168
sym = icon.resize((s, s), Image.LANCZOS)
schatten = Image.new('RGBA', (W, H), (0, 0, 0, 0))
schatten.paste((0, 0, 0, 150), ((W - s) // 2, 132), sym.split()[3])
schatten = schatten.filter(ImageFilter.GaussianBlur(14))
seite.paste(schatten, (0, 10), schatten)
seite.paste(sym, ((W - s) // 2, 126), sym)
# Name
d = ImageDraw.Draw(seite)
f = schrift(46)
text = 'Amberwave'
bw = d.textlength(text, font=f)
d.text(((W - bw) / 2, 330), text, font=f, fill=(246, 239, 231))
f2 = schrift(22, 500)
unter = 'Windows Client'
bw = d.textlength(unter, font=f2)
d.text(((W - bw) / 2, 392), unter, font=f2, fill=(255, 201, 118))
seite.save(os.path.join(aus, 'assistent_seite.bmp'), 'BMP')
print('Bilder:', os.path.join(aus, 'symbol.ico'), os.path.join(aus, 'assistent_seite.bmp'))
