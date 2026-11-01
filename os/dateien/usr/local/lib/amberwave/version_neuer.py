#!/usr/bin/env python3
"""version_neuer.py A B → Exit 0, wenn Version A neuer ist als B (oder eine davon keine Versionsnummer ist) (0.9.1 > 0.9.1-beta.6 > 0.9.1-beta.5 > 0.9.0)"""
import re, sys


def schluessel(v):
    m = re.match(r'^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?', v.strip())
    if not m:
        return None
    vor = m.group(4)
    teile = [(0, int(x)) if x.isdigit() else (1, x) for x in vor.split('.')] if vor else []
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)), 0 if vor else 1, teile)


a, b = schluessel(sys.argv[1]), schluessel(sys.argv[2])
sys.exit(1 if a and b and a <= b else 0)   # unbekannte Schreibweise (z. B. „main“): nicht blockieren
