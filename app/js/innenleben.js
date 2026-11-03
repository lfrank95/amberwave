// Innenleben der Klanggeräte: was bei echter Hardware hinter der Frontplatte sitzt (Einmessung, Bauteile, Netzteil, Exemplar).
// Eine Tabelle je Gerät beschreibt Feld, Werte, Standard, ab welcher Qualität es wirkt (0 = immer, 1 = ab HQ, 2 = nur Ultra),
// ob es ins Geräte-Preset gehört (klangbestimmend) oder beim Gerät bleibt (Exemplar, Netzteil, Übersprechen, Brumm, Alter,
// Einpegeln) – und wie es an den DSP-Kern geht (dsp/glow.c, iron.c, silk.c, gemeinsam.c).
// Qualität: q 0 = Standard, 1 = HQ, 2 = Ultra; das alte hq (true/false) wird zu q 1/0.
import { t, region } from './i18n.js';

export const QUALITAET = [
  { k: 0, kurz: 'STD', name: t('Standard'), text: t('Klingt gut, kaum Rechenlast – auf jedem Gerät.') },
  { k: 1, kurz: 'HQ', name: 'HQ', text: t('Klingt besser: Hysterese, Bauteilstreuung, Drift, mehr Oversampling – hier sitzt die Rechenlast.') },
  { k: 2, kurz: 'ULTRA', name: 'Ultra', text: t('Bildet die Schaltung Bauteil für Bauteil nach – mit allem aus dem Innenleben. Kostet nur wenig mehr als HQ.') },
];

/** Netzfrequenz der Region (Brumm): 60 Hz in Nord- und Teilen Südamerikas, Korea, Taiwan, Philippinen, Saudi-Arabien */
const NETZ_60 = new Set(['US', 'CA', 'MX', 'BR', 'CO', 'VE', 'PE', 'EC', 'CU', 'KR', 'TW', 'PH', 'SA']);
export const netzfrequenz = () => (NETZ_60.has(String(region.land || '').toUpperCase()) ? 60 : 50);

const UEBER = (std) => ({ k: 'uebersprechen', n: t('Übersprechen'), art: 'stufen', werte: [['aus', t('aus')], [-80, '−80'], [-70, '−70'], [-62, '−62'], [-54, '−54 dB']], std, q: 0, preset: false,
  tipp: t('Ein Hauch des anderen Kanals, kapazitiv – steigt zu den Höhen hin. Angabe bei 10 kHz. Echte Geräte liegen bei −60 bis −80 dB.') });
const NETZ = (std) => ({ k: 'netzteil', n: t('Netzteil'), art: 'seg', werte: [['getrennt', t('Getrennt')], ['gemeinsam', t('Gemeinsam')]], std, q: 0, preset: false,
  tipp: t('Gemeinsam: beide Kanäle hängen an einem Netzteil – lauter Bass links lässt die Spannung auch rechts etwas nachgeben (ein paar Zehntel dB, wie ein sanftes Atmen). Getrennt: jeder Kanal für sich.') });
const BRUMM = { k: 'brumm', n: t('Brumm'), art: 'sch', std: false, q: 0, preset: false,
  tipp: t('Netzbrumm mit Gleichrichter-Oberwelle, sehr leise (um −85 dBFS), unter Last etwas mehr. Standard: aus.') };
const EXEMPLAR = { k: 'exemplar', n: t('Exemplar'), art: 'seg', werte: [[1, '1'], [2, '2'], [3, '3'], [4, '4']], std: 1, q: 1, preset: false,
  tipp: t('Vier Geräte derselben Serie – jedes mit eigener Bauteilstreuung (Arbeitspunkt, Ansteuerung, Höhen je Kanal). Dein Exemplar bleibt beim Gerät. Wirkt ab HQ.') };
const EINPEGELN = { k: 'bezug', n: t('Einpegeln'), art: 'seg', werte: [[false, t('aus')], [true, t('nach Lautheit')]], std: true, q: 0, preset: false, breit: true,
  tipp: t('Wie im Studio: jeder Titel wird vor dem Gerät auf 0 VU (−18 LUFS) gebracht und danach genau zurück – laut gemasterte Alben treffen das Gerät nicht härter als leise, die Lautheit bleibt gleich.') };

export const INNEN = {
  silk: [
    { k: 'maschine', n: t('Maschine'), art: 'seg', breit: true, werte: [['a80', 'Studer A80'], ['atr102', 'Ampex ATR-102'], ['b77', 'Revox B77'], ['neutral', t('Neutral')]], std: 'a80', q: 2, preset: true,
      tipp: t('Kopfbuckel (Lage, Höhe, Güte), Höhen der Wiedergabe und Gleichlauf der Maschine. A80: kräftiger Buckel, Studio-Laufwerk · ATR-102: breiter Kopf, sehr ruhiges Laufwerk · B77: kleine Maschine, Buckel höher, etwas mehr Wow · Neutral: wie in HQ.') },
    { k: 'einmesspegel', n: t('Einmesspegel'), art: 'seg', breit: true, werte: [[185, '185'], [250, '250'], [320, '320'], [355, '355 nWb/m']], std: 250, q: 0, preset: true,
      tipp: t('Wie heiß das Band eingemessen ist (Fluss bei 0 VU). 185 = NAB-Referenz, 250 = Studio-Standard, 320/355 = „+6“-Einmessung moderner Bänder: mehr Sättigung, weniger Rauschen, weniger Reserve.') },
    { k: 'kopfwahl', n: t('Kopf'), art: 'seg', werte: [['wiedergabe', t('Wiedergabe')], ['sync', 'Sync']], std: 'wiedergabe', q: 0, preset: true,
      tipp: t('Sync: der Aufnahmekopf liest mit (wie bei Overdubs) – breiterer Spalt, die obersten Höhen fallen früher ab.') },
    { k: 'vormag', n: t('Vormagnetisierung'), art: 'trim', min: -2, max: 4, step: 0.5, std: 1.5, q: 2, preset: true, fmt: (v) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${String(Math.abs(v)).replace('.', ',')} dB ${t('über')}`,
      tipp: t('Einmessung des Bias als „Überbias bei 10 kHz“. Weniger: mehr Klirr, offenere Höhen · mehr: sauberer, dumpfer. Der Bias-Regler vorne verschiebt um diesen Punkt.') },
    { k: 'selbstloeschung', n: t('Selbstlöschung'), art: 'sch', std: true, q: 2, preset: true,
      tipp: t('Laute Höhen löschen sich beim Aufnehmen teils selbst – der Bias wirkt am Kopfspalt wie ein kleiner Löschkopf. Nimmt bei hohen Pegeln Glanz aus Becken und Zischlauten.') },
    { k: 'nab_bass', n: t('NAB-Bass'), zusatz: '3180 µs', art: 'sch', std: true, q: 0, preset: true,
      tipp: t('Nur bei NAB: der Tiefbass wird bei der Aufnahme angehoben und bei der Wiedergabe genau zurückgenommen – das Band sättigt im Bass früher, der Frequenzgang bleibt gerade.') },
    { k: 'kopiereffekt', n: t('Kopiereffekt'), art: 'stufen', werte: [['aus', t('aus')], [-62, '−62'], [-58, '−58'], [-54, '−54'], [-48, '−48 dB']], std: 'aus', q: 2, preset: true,
      tipp: t('Die Lage darüber im Wickel magnetisiert mit: ein sehr leises Echo eine Umdrehung später (bei 15 ips etwa 1,6 s). Nur Mitten, nur hörbar in leisen Stellen. Standard: aus.') },
    NETZ('gemeinsam'), UEBER(-62), BRUMM, EXEMPLAR, EINPEGELN,
  ],
  glow: [
    { k: 'stufen', n: t('Stufen'), art: 'seg', werte: [['triode', t('Triode')], ['kathodenfolger', t('+ Kathodenfolger')]], std: 'triode', q: 2, preset: true,
      tipp: t('Kathodenfolger hinter der Röhre, gleichspannungsgekoppelt (Rk 100 kΩ, 220 nF auf 220 kΩ Last) – als Schaltung gelöst: Er zieht schon in Ruhe etwas Gitterstrom und belastet die Anode davor. Beim Hochschwingen rundet das weich ab, beim schnellen Fallen reißt der Strom ab und die Kathode sackt nur so schnell nach, wie Rk und Last es zulassen. Kräftiger, rauer, mehr H2 – wie in vielen Gitarrenverstärkern. Kostet etwa dreimal so viel Rechenzeit wie die Triode allein.') },
    { k: 'anodenlast', n: t('Anodenlast'), art: 'seg', werte: [['widerstand', t('Widerstand')], ['drossel', t('Drossel')], ['uebertrager', t('Übertrager')]], std: 'widerstand', q: 2, preset: true,
      tipp: t('Widerstand: die übliche Stufe. Drossel: gleiche Ruhe, viel steilere Lastgerade – mehr Hub, deutlich weniger Klirr. Übertrager: dazwischen.') },
    { k: 'erholung', n: t('Erholung'), art: 'seg', werte: [['kurz', t('kurz')], ['mittel', t('mittel')], ['lang', t('lang')]], std: 'mittel', q: 2, preset: true,
      tipp: t('Koppelkondensator vor dem Gitter (100 nF · 330 nF · 1 µF): treibt ein Impuls das Gitter in den Strom, lädt er sich auf und die Stufe braucht eine Weile, bis sie wieder im Arbeitspunkt ist („Blocking“). Lang = mehr Nachatmen nach Spitzen.') },
    { k: 'alter', n: t('Röhrenalter'), art: 'trim', min: 0, max: 100, step: 5, std: 15, q: 2, preset: false, fmt: (v) => (v < 5 ? t('neu') : v < 40 ? t('eingespielt ({n} %)', { n: v }) : v < 75 ? t('gebraucht ({n} %)', { n: v }) : t('müde ({n} %)', { n: v })),
      tipp: t('Mit den Jahren lässt die Emission nach: weniger Strom, etwas weniger Verstärkung, frühere und weichere Sättigung. Bleibt bei deinem Gerät.') },
    { k: 'ausgangsuebertrager', n: t('Ausgangsübertrager'), art: 'sch', std: false, q: 2, preset: true,
      tipp: t('Übertrager am Ausgang: Kern sättigt sanft im Tiefbass, Bass-Ecke um 14 Hz, ein Hauch weniger oberste Oktave.') },
    NETZ('gemeinsam'), UEBER(-70), BRUMM, EXEMPLAR, EINPEGELN,
  ],
  iron: [
    { k: 'last', n: t('Last'), art: 'seg', werte: [['600ohm', '600 Ω'], ['10k', '10 kΩ'], ['offen', t('offen')]], std: '10k', q: 0, preset: true,
      tipp: t('Was hinter dem Übertrager hängt. 600 Ω: alte Studio-Norm – mehr Strom, etwas mehr Klirr im Bass, Höhen gedämpft · 10 kΩ: heute üblich, neutral · offen (hochohmig): die Streuresonanz bleibt stehen, oben etwas mehr Glanz.') },
    { k: 'uebersetzung', n: t('Übersetzung'), art: 'seg', werte: [[1, '1:1'], [2, '1:2'], [4, '1:4']], std: 1, q: 0, preset: true,
      tipp: t('Mehr Windungen auf der Ausgangsseite heben den Pegel (wird ausgeglichen) – mit der Wicklungskapazität rückt die Höhen-Eigenheit des Kerns tiefer, der Kern wird etwas härter angefasst.') },
    { k: 'remanenz', n: t('Remanenz'), art: 'trim', min: 0, max: 100, step: 5, std: 50, q: 2, preset: true, fmt: (v) => `${v} %`,
      tipp: t('Wie stark sich der Kern an das Vorherige erinnert (Breite der Hystereseschleife). Mehr: mehr leiser Klirr nach lauten Stellen, Bass „klebt“ etwas.') },
    { k: 'wirbelstrom', n: t('Wirbelstrom'), art: 'sch', std: true, q: 2, preset: true,
      tipp: t('Wirbelströme im Blech: Kernverluste, die mit der Frequenz steigen – dämpfen die Höhenresonanz bei offener Last und nehmen einen Hauch der obersten Oktave.') },
    NETZ('getrennt'), UEBER(-80), BRUMM, EXEMPLAR, EINPEGELN,
  ],
};

/** Qualität aus einer Einstellung: q, sonst das alte hq (gespeicherte Einstellungen von vor 0.9.1-beta.19) */
export function qualitaet(x) {
  return [0, 1, 2].includes(x?.q) ? x.q : (x?.hq === true ? 1 : 0);
}

/** Innenleben-Felder einer Einstellung prüfen (unbekannt/fehlt → Standard) */
export function innenNormal(art, x) {
  const aus = {};
  for (const f of INNEN[art] || []) {
    if (f.k === 'bezug') continue;   // gehört dem Gerät selbst (waerme/trafo/band.js)
    const v = x?.[f.k];
    if (f.art === 'sch') aus[f.k] = typeof v === 'boolean' ? v : f.std;
    else if (f.art === 'trim') aus[f.k] = Number.isFinite(+v) && v !== null && v !== '' ? Math.max(f.min, Math.min(f.max, Math.round(+v / f.step) * f.step)) : f.std;
    else aus[f.k] = f.werte.some(([w]) => w === v) ? v : f.std;
  }
  return aus;
}

/** Innenleben → Parameter für den DSP-Kern */
export function innenParameter(art, x) {
  const p = { q: qualitaet(x) };
  for (const f of INNEN[art] || []) {
    if (f.k === 'bezug') continue;
    const v = x[f.k] ?? f.std;
    if (f.k === 'uebersprechen') p.uebersprechen = v === 'aus' ? -200 : v;
    else if (f.k === 'kopiereffekt') p.kopiereffekt = v === 'aus' ? 0 : v;
    else if (f.k === 'remanenz' || f.k === 'alter') p[f.k] = v / 100;
    else if (f.art === 'sch') p[f.k] = v ? 1 : 0;
    else p[f.k] = v;
  }
  if (p.brumm) p.netzfrequenz = netzfrequenz();
  return p;
}

/** Felder, die ins Geräte-Preset gehören (klangbestimmend) */
export const innenPresetFelder = (art) => (INNEN[art] || []).filter((f) => f.preset).map((f) => f.k);

/** Felder, die beim Gerät bleiben (nicht aus Gesamt-Presets übernommen): Exemplar, Netzteil, Übersprechen, Brumm, Alter, Einpegeln */
export const GERAET_FELDER = ['exemplar', 'netzteil', 'uebersprechen', 'brumm', 'alter', 'bezug'];
export const geraetFelder = (o) => Object.fromEntries(GERAET_FELDER.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));
