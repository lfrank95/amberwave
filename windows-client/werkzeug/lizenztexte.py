#!/usr/bin/env python3
"""Lizenztexte für die Lizenzseite des Installers.

Aufruf: lizenztexte.py <LICENSE> <THIRD_PARTY_NOTICES.md> <AGPL deutsch> <ausgabeordner>
Erzeugt lizenz.txt (englisch, rechtlich maßgeblich) und lizenz_de.txt (deutscher Kopf, inoffizielle Übersetzung der AGPL,
Fremdkomponenten). Ein Hinweisblock für den Betreuer in LICENSE („NOTE FOR THE MAINTAINER“ bis zur ====-Linie) wird ausgelassen.
"""
import re
import sys

lizenz, dritte, agpl_de, aus = sys.argv[1:5]
en = open(lizenz, encoding='utf-8').read()
en = re.sub(r'-{20,}\nNOTE FOR THE MAINTAINER.*?(?=={20,})', '', en, flags=re.S)
notices = open(dritte, encoding='utf-8').read()
with open(f'{aus}/lizenz.txt', 'w', encoding='utf-8') as f:
    f.write(en.rstrip() + '\n\n\n' + notices)

m = re.search(r'^Copyright \(C\) (.+)$', en, flags=re.M)
copyright_zeile = 'Copyright (C) ' + (m.group(1).strip() if m else '2026')
kopf = f"""Amberwave
{copyright_zeile}

Dieses Programm ist freie Software: Sie dürfen es unter den Bedingungen
der GNU Affero General Public License, wie von der Free Software
Foundation veröffentlicht, Version 3 der Lizenz (AGPL-3.0-only),
weitergeben und/oder verändern.

Dieses Programm wird in der Hoffnung verbreitet, dass es nützlich ist,
aber OHNE JEDE GEWÄHRLEISTUNG – sogar ohne die implizite Gewährleistung
der MARKTREIFE oder der EIGNUNG FÜR EINEN BESTIMMTEN ZWECK. Einzelheiten
stehen in der GNU Affero General Public License.

Sie sollten eine Kopie der GNU Affero General Public License zusammen
mit diesem Programm erhalten haben. Falls nicht, siehe
<https://www.gnu.org/licenses/>.

-----------------------------------------------------------------------------
Geltungsbereich

Diese Lizenz gilt für den Kern von Amberwave: den Server (app/, docker/,
dsp/) und den Windows Client (windows-client/). Komponenten von
Drittanbietern behalten ihre eigenen Lizenzen, siehe unten. Künftige
„Pro“-Erweiterungen, die nicht in diesem Repository liegen, fallen nicht
unter diese Lizenz.

=============================================================================

"""
de = open(agpl_de, encoding='utf-8').read()
with open(f'{aus}/lizenz_de.txt', 'w', encoding='utf-8') as f:
    f.write(kopf + de.rstrip() + '\n\n\n'
            + '=============================================================================\n'
            + 'Komponenten von Drittanbietern (Originaltext, englisch)\n\n' + notices)
print('Lizenztexte:', f'{aus}/lizenz.txt', f'{aus}/lizenz_de.txt')
