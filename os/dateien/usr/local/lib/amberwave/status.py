#!/usr/bin/env python3
"""Amberwave OS – Statusseite auf Port 80, solange Amberwave selbst noch nicht läuft (erster Start: Laden des Containers).

Wer die Adresse vom Bildschirm schon öffnet, sieht so „Amberwave wird geladen … 63 %“ statt „Seite nicht erreichbar“.
Die Seite lädt sich alle paar Sekunden neu und landet von selbst bei Amberwave, sobald es antwortet. start.sh beendet
diesen Dienst, bevor Amberwave Port 80 übernimmt."""
import html, json
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

SEITE = '''<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="4"><title>Amberwave</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#120d0a;color:#f6efe7;font:16px/1.5 system-ui,sans-serif;padding:16px}
.k{max-width:440px;text-align:center}.r{width:38px;height:38px;border-radius:50%;border:3px solid rgba(255,181,71,.25);border-top-color:#ffb547;
margin:0 auto 18px;animation:d 1s linear infinite}@keyframes d{to{transform:rotate(360deg)}}h1{font-size:1.4rem;margin:0 0 8px}p{color:#b8a898;margin:0}
.f{color:#ff7a5c}</style></head><body><div class="k"><div class="r"></div><h1>Amberwave</h1><p class="{klasse}">{stand}</p></div></body></html>'''


def stand():
    try:
        with open('/run/amberwave/stand') as f:
            return f.read().strip()
    except OSError:
        return 'Amberwave startet …'


class Anfrage(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        s = stand()
        if self.path.startswith('/api/v1/ping'):
            roh = json.dumps({'ok': True, 'app': 'amberwave-os', 'stand': s}).encode()
            typ = 'application/json'
        else:
            fehler = s.startswith('fehler:')
            roh = SEITE.replace('{klasse}', 'f' if fehler else '').replace('{stand}', html.escape(s.removeprefix('fehler:'))).encode()
            typ = 'text/html; charset=utf-8'
        self.send_response(200)
        self.send_header('Content-Type', typ)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(roh)))
        self.end_headers()
        self.wfile.write(roh)


if __name__ == '__main__':
    ThreadingHTTPServer(('', 80), Anfrage).serve_forever()
