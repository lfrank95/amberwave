#!/usr/bin/env python3
"""Programmsymbol einer Windows-exe ersetzen (RT_ICON/RT_GROUP_ICON) und auf Wunsch die
Versionsinfo (Produktname, Version), ohne Windows-Werkzeuge.

Liest den Ressourcenbaum der .rsrc-Sektion, ersetzt die Symbolgruppe(n) durch die Bilder aus einer .ico-Datei und
schreibt den Baum neu an dieselbe Stelle (passt er nicht hinein, bricht das Skript ab). Alle übrigen Ressourcen
(Version, Manifest …) bleiben unverändert.  Aufruf: pe_symbol.py programm.exe symbol.ico
"""
import struct
import sys

RT_ICON, RT_GROUP_ICON, RT_VERSION = 3, 14, 16


def _block(schluessel, wert=b'', typ=1, kinder=b'', wert_laenge=None):
    """Ein Block der Versionsressource (wLength, wValueLength, wType, Schlüssel, Wert, Kinder – alles auf 4 Byte)"""
    k = (schluessel + '\0').encode('utf-16-le')
    kopf = 6 + len(k)
    pad1 = (4 - kopf % 4) % 4
    w = wert
    pad2 = (4 - len(w) % 4) % 4 if kinder else 0
    roh = k + b'\0' * pad1 + w + b'\0' * pad2 + kinder
    lang = 6 + len(roh)
    if wert_laenge is None:
        wert_laenge = len(w) // 2 if typ == 1 else len(w)
    return struct.pack('<HHH', lang, wert_laenge, typ) + roh + b'\0' * ((4 - lang % 4) % 4)


def versionsinfo(version, name, datei):
    """VS_VERSIONINFO mit Produkt-/Dateiname und Version (statt „Electron“ in Task-Manager, Lautstärkemixer, Explorer)"""
    v = [int(x) for x in (version.split('-')[0].split('.') + ['0', '0', '0'])[:4]]   # Vorabkennung (-beta.1) zählt nicht
    ms, ls = (v[0] << 16) | v[1], (v[2] << 16) | v[3]
    fest = struct.pack('<13I', 0xFEEF04BD, 0x00010000, ms, ls, ms, ls, 0x3F, 0, 0x40004, 1, 0, 0, 0)
    texte = {'CompanyName': 'Amberwave', 'FileDescription': name, 'FileVersion': version, 'InternalName': name,
             'LegalCopyright': '© Amberwave contributors · AGPL-3.0', 'OriginalFilename': datei, 'ProductName': name, 'ProductVersion': version,
             'Comments': 'https://amberwave.app'}
    strings = b''.join(_block(k, (w + '\0').encode('utf-16-le')) for k, w in texte.items())
    tabelle = _block('040904b0', kinder=strings, wert_laenge=0)
    sfi = _block('StringFileInfo', kinder=tabelle, wert_laenge=0)
    var = _block('Translation', struct.pack('<HH', 0x0409, 0x04B0), typ=0)
    vfi = _block('VarFileInfo', kinder=var, wert_laenge=0)
    return _block('VS_VERSION_INFO', fest, typ=0, kinder=sfi + vfi)


def pe_kopf(d):
    pe = struct.unpack_from('<I', d, 0x3c)[0]
    nsec = struct.unpack_from('<H', d, pe + 6)[0]
    opt_groesse = struct.unpack_from('<H', d, pe + 20)[0]
    opt = pe + 24
    magic = struct.unpack_from('<H', d, opt)[0]
    dd = opt + (112 if magic == 0x20b else 96)
    sektionen = []
    for i in range(nsec):
        name, vs, va, rs, rp = struct.unpack_from('<8sIIII', d, opt + opt_groesse + 40 * i)
        sektionen.append({'name': name.rstrip(b'\0'), 'vs': vs, 'va': va, 'rs': rs, 'rp': rp, 'kopf': opt + opt_groesse + 40 * i})
    return opt, dd, sektionen


def baum_lesen(d, basis, rva0, off=0, tiefe=0):
    """Ressourcenverzeichnis → {schluessel: unterbaum | (daten, codepage)}"""
    _, _, _, _, n_name, n_id = struct.unpack_from('<IIHHHH', d, basis + off)
    aus = {}
    for i in range(n_name + n_id):
        name, ziel = struct.unpack_from('<II', d, basis + off + 16 + 8 * i)
        if name & 0x80000000:
            p = basis + (name & 0x7fffffff)
            n = struct.unpack_from('<H', d, p)[0]
            schluessel = d[p + 2:p + 2 + 2 * n].decode('utf-16-le')
        else:
            schluessel = name
        if ziel & 0x80000000:
            aus[schluessel] = baum_lesen(d, basis, rva0, ziel & 0x7fffffff, tiefe + 1)
        else:
            rva, groesse, cp, _ = struct.unpack_from('<IIII', d, basis + ziel)
            aus[schluessel] = (d[basis + rva - rva0:basis + rva - rva0 + groesse], cp)
    return aus


def sortiert(baum):
    # Windows erwartet zuerst benannte Einträge (alphabetisch), dann IDs (aufsteigend)
    namen = sorted(k for k in baum if isinstance(k, str))
    ids = sorted(k for k in baum if isinstance(k, int))
    return namen, ids


def baum_schreiben(baum, rva0):
    """Ressourcenbaum → Bytes für die .rsrc-Sektion (Verzeichnisse, Datenköpfe, Namen, Daten)"""
    verz, datenkoepfe, namen, daten = bytearray(), [], [], []
    # 1. Verzeichnisse breitenweise anlegen; Platzhalter merken
    teile = []   # (offset_im_verz, baum)

    def groesse_verz(b):
        return 16 + 8 * len(b)

    reihenfolge = [baum]
    i = 0
    offsets = {}
    pos = 0
    while i < len(reihenfolge):
        b = reihenfolge[i]
        offsets[id(b)] = pos
        pos += groesse_verz(b)
        n, ids = sortiert(b)
        for k in n + ids:
            if isinstance(b[k], dict):
                reihenfolge.append(b[k])
        i += 1
    verz_groesse = pos
    # Datenköpfe (16 Byte je Blatt) nach den Verzeichnissen, dann Namen, dann Daten
    blaetter = []
    for b in reihenfolge:
        n, ids = sortiert(b)
        for k in n + ids:
            if not isinstance(b[k], dict):
                blaetter.append((id(b), k))
    kopf_pos = {}
    p = verz_groesse
    for bl in blaetter:
        kopf_pos[bl] = p
        p += 16
    namen_pos = {}
    for b in reihenfolge:
        for k in b:
            if isinstance(k, str) and k not in namen_pos:
                namen_pos[k] = p
                p += 2 + 2 * len(k)
    p = (p + 7) & ~7
    daten_pos = {}
    for b in reihenfolge:
        n, ids = sortiert(b)
        for k in n + ids:
            if not isinstance(b[k], dict):
                daten_pos[(id(b), k)] = p
                p += len(b[k][0])
                p = (p + 7) & ~7
    aus = bytearray(p)
    for b in reihenfolge:
        o = offsets[id(b)]
        n, ids = sortiert(b)
        struct.pack_into('<IIHHHH', aus, o, 0, 0, 4, 0, len(n), len(ids))
        for j, k in enumerate(n + ids):
            name = (namen_pos[k] | 0x80000000) if isinstance(k, str) else k
            if isinstance(b[k], dict):
                ziel = offsets[id(b[k])] | 0x80000000
            else:
                ziel = kopf_pos[(id(b), k)]
                daten, cp = b[k]
                struct.pack_into('<IIII', aus, ziel, rva0 + daten_pos[(id(b), k)], len(daten), cp, 0)
                aus[daten_pos[(id(b), k)]:daten_pos[(id(b), k)] + len(daten)] = daten
            struct.pack_into('<II', aus, o + 16 + 8 * j, name, ziel)
    for k, q in namen_pos.items():
        s = k.encode('utf-16-le')
        struct.pack_into('<H', aus, q, len(k))
        aus[q + 2:q + 2 + len(s)] = s
    return bytes(aus)


def ico_lesen(pfad):
    d = open(pfad, 'rb').read()
    _, typ, n = struct.unpack_from('<HHH', d, 0)
    assert typ == 1, 'keine .ico-Datei'
    bilder = []
    for i in range(n):
        w, h, farben, _, ebenen, bits, groesse, off = struct.unpack_from('<BBBBHHII', d, 6 + 16 * i)
        bilder.append({'w': w, 'h': h, 'farben': farben, 'ebenen': ebenen, 'bits': bits, 'daten': d[off:off + groesse]})
    return bilder


def main(exe, ico, version=None, name=None, datei=None):
    d = bytearray(open(exe, 'rb').read())
    opt, dd, sektionen = pe_kopf(d)
    rsrc_rva, rsrc_groesse = struct.unpack_from('<II', d, dd + 2 * 8)
    s = next(x for x in sektionen if x['va'] <= rsrc_rva < x['va'] + max(x['vs'], x['rs']))
    basis = s['rp'] + (rsrc_rva - s['va'])
    baum = baum_lesen(bytes(d), basis, rsrc_rva)
    sprache = 1033
    gruppe_name = 1
    if RT_GROUP_ICON in baum and baum[RT_GROUP_ICON]:
        n, ids = sortiert(baum[RT_GROUP_ICON])
        gruppe_name = (n + ids)[0]
        sprache = sorted(baum[RT_GROUP_ICON][gruppe_name].keys())[0]
    bilder = ico_lesen(ico)
    baum[RT_ICON] = {i + 1: {sprache: (b['daten'], 0)} for i, b in enumerate(bilder)}
    gruppe = struct.pack('<HHH', 0, 1, len(bilder)) + b''.join(
        struct.pack('<BBBBHHIH', b['w'], b['h'], b['farben'], 0, b['ebenen'], b['bits'], len(b['daten']), i + 1) for i, b in enumerate(bilder))
    baum[RT_GROUP_ICON] = {gruppe_name: {sprache: (gruppe, 0)}}
    if version and name:
        sprache_v = 1033
        if RT_VERSION in baum and baum[RT_VERSION]:
            n, ids = sortiert(baum[RT_VERSION])
            sprache_v = sorted(baum[RT_VERSION][(n + ids)[0]].keys())[0]
        baum[RT_VERSION] = {1: {sprache_v: (versionsinfo(version, name, datei or name + '.exe'), 0)}}
    neu = baum_schreiben(baum, rsrc_rva)
    platz = max(s['rs'], s['vs']) - (rsrc_rva - s['va'])
    platz = min(platz, s['rs'] - (rsrc_rva - s['va']))
    if len(neu) > platz:
        sys.exit(f'Ressourcen passen nicht in die Sektion ({len(neu)} > {platz} Bytes) – kleineres Symbol nehmen')
    d[basis:basis + platz] = neu + bytes(platz - len(neu))
    struct.pack_into('<II', d, dd + 2 * 8, rsrc_rva, len(neu))
    # virtuelle Größe der Sektion nicht verkleinern (Loader mappt sie ohnehin ganz); Prüfsumme 0 = nicht geprüft
    struct.pack_into('<I', d, opt + 64, 0)
    open(exe, 'wb').write(d)
    print(f'{exe}: {len(bilder)} Symbolbilder, Ressourcen {len(neu)} von {platz} Bytes')


if __name__ == '__main__':
    # pe_symbol.py programm.exe symbol.ico [version name dateiname]
    main(*sys.argv[1:6])
