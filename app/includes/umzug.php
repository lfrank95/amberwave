<?php
// Umzug zwischen Installationen (Docker-Stack, All-in-One, Windows-Server – in jede Richtung):
// Der alte Server packt Datenbank, Schlüssel, Region/Servername, eigene Raumklang-Dateien, Profilbilder und auf Wunsch die
// Cover und Künstlerbilder in eine Datei, verschlüsselt mit einem Passwort, das der Admin wählt. Die neue Installation spielt
// das Paket in der Einrichtung ein – statt ein Konto anzulegen.
//
// Dateiformat .awumzug: "AWUMZUG1" | Salz (16) | Kopf von crypto_secretstream (24) | Blöcke: u32 Länge, verschlüsselter Block
// (je 1 MiB Klartext; der letzte Block trägt TAG_FINAL). Schlüssel: Argon2id (sodium_crypto_pwhash, „interaktiv“).
// Darin ein ZIP: manifest.json, datenbank.sql.gz, schluessel.txt, server.json (optional), cache/<ordner>/… (optional).
declare(strict_types=1);
require_once __DIR__ . '/sicherung.php';
require_once __DIR__ . '/einrichtung.php';

const UMZUG_MAGIC = 'AWUMZUG1';
const UMZUG_BLOCK = 1 << 20;
/** Ordner im Cache, die mitgehen: immer (Daten der Nutzer) bzw. nur mit „Bilder mitnehmen“ (sonst neu geladen) */
const UMZUG_ORDNER_IMMER = ['raumklang', 'profil', 'listenbrainz'];
const UMZUG_ORDNER_BILDER = ['cover', 'bilder', 'mb-cover'];

function umzug_tmp(): string
{
    $d = konfig()['pfade']['cache'] . '/tmp/umzug';
    if (!is_dir($d)) {
        @mkdir($d, 0700, true);
    }
    return $d;
}

/** Alte Reste (abgebrochene Uploads/Exporte) nach einem Tag entfernen */
function umzug_aufraeumen(): void
{
    foreach (glob(umzug_tmp() . '/*') ?: [] as $p) {
        if ((int) @filemtime($p) < time() - 86400) {
            is_dir($p) ? aw_ordner_loeschen($p) : @unlink($p);
        }
    }
}

function umzug_schluessel(string $passwort, string $salz): string
{
    return sodium_crypto_pwhash(SODIUM_CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_KEYBYTES, $passwort, $salz,
        SODIUM_CRYPTO_PWHASH_OPSLIMIT_INTERACTIVE, SODIUM_CRYPTO_PWHASH_MEMLIMIT_INTERACTIVE, SODIUM_CRYPTO_PWHASH_ALG_ARGON2ID13);
}

function umzug_verschluesseln(string $klar, string $ziel, string $passwort): void
{
    $salz = random_bytes(SODIUM_CRYPTO_PWHASH_SALTBYTES);
    $k = umzug_schluessel($passwort, $salz);
    [$zustand, $kopf] = sodium_crypto_secretstream_xchacha20poly1305_init_push($k);
    $ein = fopen($klar, 'rb');
    $aus = fopen($ziel, 'wb');
    if (!$ein || !$aus) {
        throw new RuntimeException(t('Umzugspaket konnte nicht geschrieben werden.'));
    }
    fwrite($aus, UMZUG_MAGIC . $salz . $kopf);
    $groesse = (int) filesize($klar);
    $gelesen = 0;
    do {
        $stueck = (string) fread($ein, UMZUG_BLOCK);
        $gelesen += strlen($stueck);
        $letzter = $gelesen >= $groesse || feof($ein);
        $c = sodium_crypto_secretstream_xchacha20poly1305_push($zustand, $stueck, '',
            $letzter ? SODIUM_CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL : SODIUM_CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_MESSAGE);
        fwrite($aus, pack('V', strlen($c)) . $c);
    } while (!$letzter);
    fclose($ein);
    fclose($aus);
    sodium_memzero($k);
}

/** Entschlüsselt nach $ziel; falsches Passwort oder beschädigte Datei → RuntimeException */
function umzug_entschluesseln(string $datei, string $ziel, string $passwort): void
{
    $ein = fopen($datei, 'rb');
    if (!$ein) {
        throw new RuntimeException(t('Umzugspaket nicht lesbar.'));
    }
    $kopflaenge = strlen(UMZUG_MAGIC) + SODIUM_CRYPTO_PWHASH_SALTBYTES + SODIUM_CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_HEADERBYTES;
    $kopf = (string) fread($ein, $kopflaenge);
    if (strlen($kopf) !== $kopflaenge || !str_starts_with($kopf, UMZUG_MAGIC)) {
        fclose($ein);
        throw new RuntimeException(t('Das ist kein Amberwave-Umzugspaket (.awumzug).'));
    }
    $salz = substr($kopf, strlen(UMZUG_MAGIC), SODIUM_CRYPTO_PWHASH_SALTBYTES);
    $k = umzug_schluessel($passwort, $salz);
    $zustand = sodium_crypto_secretstream_xchacha20poly1305_init_pull(substr($kopf, -SODIUM_CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_HEADERBYTES), $k);
    sodium_memzero($k);
    $aus = fopen($ziel, 'wb');
    $fertig = false;
    $erster = true;
    while (!$fertig) {
        $l = fread($ein, 4);
        if ($l === false || strlen($l) !== 4) {
            break;
        }
        $n = unpack('V', $l)[1];
        if ($n <= 0 || $n > UMZUG_BLOCK + 64) {
            break;
        }
        $c = (string) fread($ein, $n);
        $r = sodium_crypto_secretstream_xchacha20poly1305_pull($zustand, $c);
        if ($r === false) {
            fclose($ein);
            fclose($aus);
            @unlink($ziel);
            throw new RuntimeException($erster ? t('Das Passwort passt nicht zu diesem Umzugspaket.') : t('Das Umzugspaket ist beschädigt.'));
        }
        $erster = false;
        fwrite($aus, $r[0]);
        $fertig = $r[1] === SODIUM_CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL;
    }
    fclose($ein);
    fclose($aus);
    if (!$fertig) {
        @unlink($ziel);
        throw new RuntimeException(t('Das Umzugspaket ist unvollständig – bitte noch einmal herunterladen bzw. hochladen.'));
    }
}

/** Umzugspaket erstellen; liefert den Pfad der fertigen .awumzug-Datei (im Umzugs-Ordner, wird nach einem Tag gelöscht) */
function umzug_erstellen(string $passwort, bool $bilder): string
{
    if (!function_exists('sodium_crypto_secretstream_xchacha20poly1305_init_push') || !class_exists('ZipArchive')) {
        throw new RuntimeException(t('Diesem Server fehlen PHP-Erweiterungen (sodium, zip) für das Umzugspaket.'));
    }
    if (mb_strlen($passwort) < 8) {
        throw new RuntimeException(t('Bitte ein Passwort mit mindestens 8 Zeichen wählen.'));
    }
    umzug_aufraeumen();
    $id = date('Y-m-d_H-i-s') . '_' . bin2hex(random_bytes(3));
    $dump = umzug_tmp() . "/{$id}.sql.gz";
    $zipPfad = umzug_tmp() . "/{$id}.zip";
    $ziel = umzug_tmp() . "/amberwave-umzug_{$id}.awumzug";
    try {
        datenbank_dump($dump);
        $zip = new ZipArchive();
        if ($zip->open($zipPfad, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
            throw new RuntimeException(t('Umzugspaket konnte nicht geschrieben werden.'));
        }
        $k = konfig();
        $zip->addFromString('manifest.json', (string) json_encode([
            'format' => 1, 'app_version' => app_version(), 'schema' => migrationen_code_version(), 'erstellt' => date('c'),
            'servername' => $k['server_name'], 'plattform' => aw_windows() ? 'windows' : (getenv('AMBERWAVE_AIO') === '1' ? 'aio' : 'docker'),
            'bilder' => $bilder,
        ], JSON_UNESCAPED_UNICODE));
        $zip->addFile($dump, 'datenbank.sql.gz');
        $zip->setCompressionName('datenbank.sql.gz', ZipArchive::CM_STORE);
        $zip->addFromString('schluessel.txt', (string) $k['app_secret_key']);
        $server = geheimnis_lesen('server.json');
        if ($server !== '') {
            $zip->addFromString('server.json', $server);
        }
        $cache = $k['pfade']['cache'];
        foreach (array_merge(UMZUG_ORDNER_IMMER, $bilder ? UMZUG_ORDNER_BILDER : []) as $o) {
            $wurzel = $cache . '/' . $o;
            if (!is_dir($wurzel)) {
                continue;
            }
            foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($wurzel, FilesystemIterator::SKIP_DOTS)) as $f) {
                if (!$f->isFile()) {
                    continue;
                }
                $rel = substr(aw_pfad($f->getPathname()), strlen(aw_pfad($wurzel)) + 1);
                $name = 'cache/' . $o . '/' . $rel;
                $zip->addFile($f->getPathname(), $name);
                if (preg_match('/\.(jpe?g|png|webp|gz|zip)$/i', $rel)) {
                    $zip->setCompressionName($name, ZipArchive::CM_STORE);   // schon gepackt
                }
            }
        }
        if (!$zip->close()) {
            throw new RuntimeException(t('Umzugspaket konnte nicht geschrieben werden.'));
        }
        umzug_verschluesseln($zipPfad, $ziel, $passwort);
    } finally {
        @unlink($dump);
        @unlink($zipPfad);
    }
    return $ziel;
}

/** Werte, die mit dem Schlüssel der alten Installation verschlüsselt sind, mit dem eigenen neu verschlüsseln */
function umzug_umschluesseln(string $alterSchluessel): int
{
    $neu = (string) konfig()['app_secret_key'];
    if ($alterSchluessel === '' || hash_equals($neu, $alterSchluessel)) {
        return 0;
    }
    require_once __DIR__ . '/crypto.php';
    $alt = hash('sha256', $alterSchluessel, true);
    $entschluesseln = static function (string $v) use ($alt): ?string {
        $d = base64_decode($v, true);
        if ($d === false || strlen($d) < 17) {
            return null;
        }
        $k = openssl_decrypt(substr($d, 16), 'aes-256-cbc', $alt, OPENSSL_RAW_DATA, substr($d, 0, 16));
        return $k === false ? null : $k;
    };
    $n = 0;
    foreach (db_alle("SELECT schluessel, wert_verschluesselt FROM einstellungen WHERE wert_verschluesselt <> '' AND wert_verschluesselt NOT LIKE 'p:%'") as $z) {
        $klar = $entschluesseln((string) $z['wert_verschluesselt']);
        db_tun('UPDATE einstellungen SET wert_verschluesselt = :w WHERE schluessel = :s', ['w' => $klar === null ? '' : verschluessle($klar), 's' => $z['schluessel']]);
        $n++;
    }
    try {
        foreach (db_alle("SELECT id, api_key FROM download_dienste WHERE api_key <> ''") as $z) {
            $klar = $entschluesseln((string) $z['api_key']);
            db_tun('UPDATE download_dienste SET api_key = :w WHERE id = :id', ['w' => $klar === null ? '' : verschluessle($klar), 'id' => $z['id']]);
            $n++;
        }
    } catch (Throwable $e) {
        // ältere Sicherung ohne Download-Dienste
    }
    try {
        db_tun('DELETE FROM mail_warteschlange');   // ausstehende Mails der alten Installation (mit altem Schlüssel)
    } catch (Throwable $e) {
    }
    return $n;
}

/**
 * Umzugspaket einspielen – nur in eine leere Installation (Einrichtung, noch kein Konto). Liefert eine kurze Zusammenfassung.
 * Nutzt dieselbe Prüfung und dasselbe Einspielen wie „Wiederherstellen“ (Format, Vollständigkeit, Schema nicht neuer als die App).
 */
function umzug_einspielen(string $datei, string $passwort): array
{
    if ((int) (db_wert("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'users'") ?: 0) > 0
        && (int) db_wert('SELECT COUNT(*) FROM users') > 0) {
        throw new RuntimeException(t('Diese Installation hat schon Konten – ein Umzug geht nur in eine neue, leere Installation.'));
    }
    $id = bin2hex(random_bytes(4));
    $zipPfad = umzug_tmp() . "/ein_{$id}.zip";
    $ordner = umzug_tmp() . "/ein_{$id}";
    try {
        umzug_entschluesseln($datei, $zipPfad, $passwort);
        $zip = new ZipArchive();
        if ($zip->open($zipPfad) !== true) {
            throw new RuntimeException(t('Das Umzugspaket ist beschädigt.'));
        }
        $manifest = json_decode((string) $zip->getFromName('manifest.json'), true);
        if (!is_array($manifest) || (int) ($manifest['format'] ?? 0) !== 1) {
            throw new RuntimeException(t('Dieses Umzugspaket stammt von einer neueren Amberwave-Version – bitte zuerst diese Installation aktualisieren.'));
        }
        // nur erwartete Namen auspacken (kein ../, keine absoluten Pfade)
        @mkdir($ordner, 0700, true);
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $name = (string) $zip->getNameIndex($i);
            if (str_contains($name, '..') || str_starts_with($name, '/') || str_contains($name, '\\') || str_contains($name, ':')
                || !preg_match('#^(manifest\.json|datenbank\.sql\.gz|schluessel\.txt|server\.json|cache/(' . implode('|', array_merge(UMZUG_ORDNER_IMMER, UMZUG_ORDNER_BILDER)) . ')/.+)$#', $name)) {
                continue;
            }
            $ziel = $ordner . '/' . $name;
            @mkdir(dirname($ziel), 0775, true);
            $q = $zip->getStream($name);
            $a = fopen($ziel, 'wb');
            if ($q && $a) {
                stream_copy_to_stream($q, $a);
            }
            if ($q) {
                fclose($q);
            }
            if ($a) {
                fclose($a);
            }
        }
        $zip->close();
        @unlink($zipPfad);

        $dump = $ordner . '/datenbank.sql.gz';
        $inhalt = sicherung_pruefen($dump);
        sicherung_einspielen($dump, $inhalt['tabellen']);
        migrationen_ausfuehren();
        $umgeschluesselt = umzug_umschluesseln(trim((string) @file_get_contents($ordner . '/schluessel.txt')));
        if (is_file($ordner . '/server.json')) {
            geheimnis_schreiben('server.json', trim((string) file_get_contents($ordner . '/server.json')));
        }
        $cache = konfig()['pfade']['cache'];
        $kopiert = 0;
        if (is_dir($ordner . '/cache')) {
            foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($ordner . '/cache', FilesystemIterator::SKIP_DOTS)) as $f) {
                if ($f->isFile()) {
                    $rel = substr(aw_pfad($f->getPathname()), strlen(aw_pfad($ordner . '/cache')) + 1);
                    @mkdir(dirname($cache . '/' . $rel), 0775, true);
                    if (@copy($f->getPathname(), $cache . '/' . $rel)) {
                        $kopiert++;
                    }
                }
            }
        }
        return [
            'konten' => (int) db_wert('SELECT COUNT(*) FROM users'),
            'titel' => (int) (db_wert('SELECT COUNT(*) FROM tracks') ?: 0),
            'dateien' => $kopiert,
            'umgeschluesselt' => $umgeschluesselt,
            'von' => (string) ($manifest['plattform'] ?? ''),
            'version' => (string) ($manifest['app_version'] ?? ''),
            'servername' => (string) ($manifest['servername'] ?? ''),
        ];
    } finally {
        @unlink($zipPfad);
        aw_ordner_loeschen($ordner);
    }
}
