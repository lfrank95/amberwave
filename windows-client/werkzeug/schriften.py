#!/usr/bin/env python3
"""Feste Schriftschnitte für den Installer aus den variablen App-Schriften (woff2) erzeugen.

Aufruf: schriften.py <app/fonts-Ordner> <ausgabeordner>
GDI+ kann bei variablen Schriften nur den Standardschnitt – deshalb je Gewicht eine eigene, „normale“ Familie:
  aw_text.ttf      AWText       (Manrope 500)
  aw_text_fett.ttf AWTextFett   (Manrope 700)
  aw_titel.ttf     AWTitel      (Space Grotesk 700)
Manrope bekommt zusätzlich die Latin-Ext-Zeichen (Ł, Ő, …), damit Pfade und Namen nicht ins Leere laufen.
"""
import os
import sys

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.merge import Merger

quelle, aus = sys.argv[1], sys.argv[2]
os.makedirs(aus, exist_ok=True)


def fest(datei, gewicht):
    f = TTFont(os.path.join(quelle, datei))
    f.flavor = None
    return instancer.instantiateVariableFont(f, {'wght': gewicht}, updateFontNames=False)


def umbenennen(f, familie):
    n = f['name']
    for rec in list(n.names):
        if rec.nameID in (16, 17, 21, 22, 25):
            n.removeNames(nameID=rec.nameID)
    for pid, eid, lid in ((3, 1, 0x409), (1, 0, 0)):
        n.setName(familie, 1, pid, eid, lid)
        n.setName('Regular', 2, pid, eid, lid)
        n.setName(familie, 3, pid, eid, lid)
        n.setName(familie, 4, pid, eid, lid)
        n.setName(familie, 6, pid, eid, lid)
    os2 = f['OS/2']
    os2.fsSelection = (os2.fsSelection & ~0b1100001) | 0b1000000   # nur REGULAR
    os2.usWeightClass = 400
    f['head'].macStyle = 0


def speichern(schnitte, familie, ziel):
    pfade = []
    for i, f in enumerate(schnitte):
        p = os.path.join(aus, f'_{familie}_{i}.ttf')
        f.save(p)
        pfade.append(p)
    if len(pfade) > 1:
        try:
            gesamt = Merger().merge(pfade)
        except Exception:
            gesamt = TTFont(pfade[0])
    else:
        gesamt = TTFont(pfade[0])
    umbenennen(gesamt, familie)
    gesamt.save(os.path.join(aus, ziel))
    for p in pfade:
        os.remove(p)


speichern([fest('manrope-latin-v1.woff2', 500), fest('manrope-latin-ext-v1.woff2', 500)], 'AWText', 'aw_text.ttf')
speichern([fest('manrope-latin-v1.woff2', 700), fest('manrope-latin-ext-v1.woff2', 700)], 'AWTextFett', 'aw_text_fett.ttf')
speichern([fest('spacegrotesk-latin-v1.woff2', 700)], 'AWTitel', 'aw_titel.ttf')
print('Schriften:', ', '.join(sorted(x for x in os.listdir(aus) if x.startswith('aw_'))))
