#!/usr/bin/env python3
"""Misst API-Endpunkte gegen die große Testbibliothek: Zeit, Antwortgröße, Datenbankabfragen (aus SQL_PROFIL-Log).

Aufruf: messen.py <basis-url> <ausgabe.txt>   (Token in der Umgebungsvariable TOKEN, Log in SQL_PROFIL)
"""
import json, os, sys, time, urllib.request

B, AUS = sys.argv[1], sys.argv[2]
TOK = os.environ['TOKEN']
LOG = os.environ['SQL_PROFIL']


def holen(pfad):
    req = urllib.request.Request(B + '/api/v1' + pfad, headers={'Authorization': 'Bearer ' + TOK})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            daten = r.read()
            status = r.status
    except urllib.error.HTTPError as e:
        daten, status = e.read(), e.code
    return status, time.time() - t, daten


def letzter_log_block(vorher):
    try:
        with open(LOG, encoding='utf-8', errors='replace') as f:
            f.seek(vorher)
            return f.read()
    except FileNotFoundError:
        return ''


# Kennzahlen für dynamische IDs
_, _, j = holen('/kuenstler?sort=alben&seite=1')
try:
    kuenstler = json.loads(j)
    k_id = (kuenstler.get('kuenstler') or kuenstler.get('liste') or [{}])[0].get('id')
except Exception:
    k_id = None
_, _, j = holen('/alben?seite=1')
try:
    alben = json.loads(j)
    a_id = (alben.get('alben') or alben.get('liste') or [{}])[0].get('id')
except Exception:
    a_id = None

PFADE = [
    '/start', '/start',
    '/alben?seite=1', '/alben?seite=5', '/alben?sort=titel&seite=1', '/alben?sort=neu&seite=1', '/alben?sort=zufall&seite=1',
    '/alben?gruppiert=1&seite=1', '/alben?buchstabe=M&seite=1', '/alben?genre=Rock&seite=1',
    '/kuenstler?seite=1', '/kuenstler?sort=alben&seite=1', '/kuenstler?sort=gehoert&seite=1',
    f'/kuenstler/{k_id}', f'/alben/{a_id}',
    '/suche?q=glass', '/suche?q=river%20light', '/suche?q=xqzvb', '/suche?q=glsas', '/suche?q=the',
    '/genres', '/playlists', '/favoriten', '/verlauf',
    '/admin/uebersicht', '/admin/scan', '/admin/alben?filter=alle&seite=1', '/admin/alben?filter=ohne_mb&seite=1',
    '/admin/metadaten-abgleich', '/admin/erkennung', '/admin/aufraeumen', '/admin/dateien', '/admin/klang', '/admin/flac',
]
zeilen = []
for p in PFADE:
    vorher = os.path.getsize(LOG) if os.path.exists(LOG) else 0
    status, dauer, daten = holen(p)
    time.sleep(0.3)
    block = letzter_log_block(vorher)
    kopf = next((z for z in block.splitlines() if 'Abfragen' in z and '/api/v1' in z), '')
    n = kopf.split('Abfragen')[0].split()[-1] if kopf else '?'
    ms_db = kopf.split('Abfragen')[1].strip() if kopf else ''
    langsam = [z.strip() for z in block.splitlines()[1:3] if z.startswith('    ')]
    zeile = f'{p:45s} {status} {dauer * 1000:7.0f} ms  {len(daten) / 1024:7.1f} KB  {n:>5} Abfragen {ms_db:>8}'
    print(zeile, flush=True)
    zeilen.append(zeile)
    for l in langsam:
        zeilen.append('      ' + l[:170])
open(AUS, 'w').write('\n'.join(zeilen) + '\n')
