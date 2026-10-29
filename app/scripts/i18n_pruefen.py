#!/usr/bin/env python3
"""Prüft die Übersetzungen: (1) t('…')/tn(…)-Texte ohne Eintrag im Wörterbuch, (2) Einträge, die nirgends benutzt werden,
(3) mögliche deutsche Texte, die noch nicht in t() stehen (Heuristik).
Aufruf: python3 scripts/i18n_pruefen.py [Datei …]   (im Ordner app/; ohne Dateien: alles)"""
import json, glob, os, re, sys
a = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
w = {}
for d in glob.glob(a + '/i18n/quelle/*.json'):
    w.update(json.load(open(d, encoding='utf-8')))
dateien = sys.argv[1:] or [f for f in glob.glob(a + '/**/*', recursive=True)
    if f.endswith(('.js', '.php', '.html')) and '/i18n/' not in f and 'i18n_en' not in f and '/scripts/' not in f and 'migrations' not in f and '/js/_b/' not in f]
STR = r"""(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`)"""
RT = re.compile(r'(?<![\w$.>])(?:t|tn)\(\s*(?:[^,()]+,\s*)?' + STR)   # t('…') / tn(n, 'a', 'b')
RTN = re.compile(r'(?<![\w$.>])tn\(\s*[^,()]+,\s*' + STR + r'\s*,\s*' + STR)
def unesc(s):
    return re.sub(r'\\(.)', lambda m: {'n': '\n', 't': '\t'}.get(m.group(1), m.group(1)), s)
def erster(g): return next((x for x in g if x is not None), None)
benutzt, fehlt = set(), {}
DE = re.compile(r'[äöüÄÖÜß]|\b(?:der|die|das|und|nicht|wird|werden|Bitte|bitte|Fehler|Titel|Album|Einstellungen|speichern|löschen|laden|Keine|kein|keine|für|oder|mit|von|zum|zur|noch|kann|alle|neu)\b')
unverpackt = {}
for f in dateien:
    s = open(f, encoding='utf-8', errors='replace').read()
    for m in RTN.finditer(s):
        for g in (m.groups()[:3], m.groups()[3:]):
            k = unesc(erster(g)); benutzt.add(k)
            if k not in w: fehlt.setdefault(k, f)
    for m in RT.finditer(s):
        k = unesc(erster(m.groups()))
        if RTN.match(s, m.start()): continue
        benutzt.add(k)
        if k not in w: fehlt.setdefault(k, f)
    if f.endswith('.js') or f.endswith('.php') or f.endswith('.html'):
        n = 0
        for i, z in enumerate(s.split('\n'), 1):
            if z.lstrip().startswith(('//', '*', '/*', '#')): continue
            if re.search(r'\bt\(|\btn\(', z): continue
            for m in re.finditer(STR, z):
                x = erster(m.groups())
                if len(x) >= 4 and ' ' in x and DE.search(x) and not re.search(r'^[a-z0-9_.:/-]+$', x):
                    n += 1; unverpackt.setdefault(f, []).append((i, x[:70]))
for k, f in sorted(fehlt.items()): print(f'FEHLT {os.path.relpath(f, a)}: {k[:90]}')
unbenutzt = [k for k in w if k not in benutzt]
print(f'\n{len(benutzt)} Texte in t(), {len(fehlt)} ohne Übersetzung, {len(unbenutzt)} Wörterbuch-Einträge ungenutzt, '
      f'{sum(len(v) for v in unverpackt.values())} mögliche unübersetzte deutsche Texte in {len(unverpackt)} Dateien')
if os.environ.get('DETAILS'):
    for f, l in sorted(unverpackt.items()):
        for i, x in l[:200]: print(f'  ? {os.path.relpath(f, a)}:{i}: {x}')
