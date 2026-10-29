#!/usr/bin/env python3
"""Fügt i18n/quelle/*.json (Deutsch → Englisch) zu js/i18n_en.js und includes/i18n_en.php zusammen.
Aufruf: python3 scripts/i18n_bauen.py   (im Ordner app/)"""
import json, glob, os, sys
a = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
w = {}
for d in sorted(glob.glob(a + '/i18n/quelle/*.json')):
    for k, v in json.load(open(d, encoding='utf-8')).items():
        if k in w and w[k] != v:
            print(f'Widerspruch für „{k}“: „{w[k]}“ ↔ „{v}“ ({os.path.basename(d)})', file=sys.stderr)
        w[k] = v
w = {k: v for k, v in sorted(w.items()) if k != v or True}
open(a + '/js/i18n_en.js', 'w', encoding='utf-8').write('// erzeugt von scripts/i18n_bauen.py – nicht von Hand ändern\nexport default ' + json.dumps(w, ensure_ascii=False, indent=0) + ';\n')
def php(s): return "'" + s.replace('\\', '\\\\').replace("'", "\\'") + "'"
open(a + '/includes/i18n_en.php', 'w', encoding='utf-8').write('<?php\n// erzeugt von scripts/i18n_bauen.py – nicht von Hand ändern\nreturn [\n' + ''.join(f'    {php(k)} => {php(v)},\n' for k, v in w.items()) + '];\n')
print(len(w), 'Einträge')
