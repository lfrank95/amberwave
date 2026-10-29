<?php
declare(strict_types=1);

require_once __DIR__ . '/i18n.php';

/**
 * Eigene Presets (pro Konto, auf allen Geräten gleich): je Effektgerät (glow, iron, silk, space, eq) und fürs ganze Rack
 * (rack: Reihenfolge, an/aus, HQ und alle Werte). Welche Werte darin stehen, entscheidet die App – hier wird nur geprüft,
 * dass es ein überschaubares JSON-Objekt ist. Grenzen aus der .env: PRESETS_MAX (je Art und Konto).
 */

const PRESET_ARTEN = ['glow', 'iron', 'silk', 'space', 'eq', 'rack'];

function preset_objekt(array $z): array
{
    return [
        'id' => (int) $z['id'], 'art' => $z['art'], 'name' => $z['name'],
        'werte' => json_decode((string) $z['werte'], true) ?: new stdClass(),
        'geaendert' => iso($z['geaendert_am']),
    ];
}

function api_presets(array $user): array
{
    $zeilen = db_alle('SELECT * FROM effekt_presets WHERE user_id = :u ORDER BY art, name', ['u' => $user['id']]);
    return ['presets' => array_map('preset_objekt', $zeilen)];
}

function preset_name_pruefen(mixed $name): string
{
    $name = trim(preg_replace('/\s+/u', ' ', (string) $name) ?? '');
    if ($name === '' || mb_strlen($name) > 60) {
        throw new ApiFehler(t('Bitte einen Namen mit 1 bis 60 Zeichen angeben.'));
    }
    return $name;
}

function preset_werte_pruefen(mixed $werte): string
{
    if (!is_array($werte)) {
        throw new ApiFehler(t('Ungültige Preset-Werte.'));
    }
    $json = json_encode($werte, JSON_UNESCAPED_UNICODE);
    if ($json === false || strlen($json) > 50000) {
        throw new ApiFehler(t('Preset-Werte zu groß oder ungültig.'));
    }
    return $json;
}

function preset_laden(array $user, int $id): array
{
    $z = db_zeile('SELECT * FROM effekt_presets WHERE id = :id AND user_id = :u', ['id' => $id, 'u' => $user['id']]);
    if (!$z) {
        throw new ApiFehler(t('Preset nicht gefunden.'), 404);
    }
    return $z;
}

/** Neues Preset; gibt es den Namen schon, wird es nur mit ersetzen=true überschrieben */
function api_preset_anlegen(array $user): array
{
    $art = (string) api_wert('art', '');
    if (!in_array($art, PRESET_ARTEN, true)) {
        throw new ApiFehler(t('Unbekannte Preset-Art.'));
    }
    $name = preset_name_pruefen(api_wert('name', ''));
    $json = preset_werte_pruefen(api_wert('werte', null));
    $vorhanden = db_zeile('SELECT id FROM effekt_presets WHERE user_id = :u AND art = :a AND name = :n', ['u' => $user['id'], 'a' => $art, 'n' => $name]);
    if ($vorhanden) {
        if (!api_wert('ersetzen', false)) {
            throw new ApiFehler(t('Ein Preset mit diesem Namen gibt es schon.'), 409, ['vorhanden' => (int) $vorhanden['id']]);
        }
        db_tun('UPDATE effekt_presets SET werte = :w, geaendert_am = NOW() WHERE id = :id', ['w' => $json, 'id' => $vorhanden['id']]);
        return ['preset' => preset_objekt(preset_laden($user, (int) $vorhanden['id']))];
    }
    $max = max(1, (int) (konfig()['presets']['max'] ?? 100));
    if ((int) db_wert('SELECT COUNT(*) FROM effekt_presets WHERE user_id = :u AND art = :a', ['u' => $user['id'], 'a' => $art]) >= $max) {
        throw new ApiFehler(t('Höchstens {max} eigene Presets je Gerät – bitte erst eines löschen.', ['max' => $max]));
    }
    $id = db_einfuegen('INSERT INTO effekt_presets (user_id, art, name, werte) VALUES (:u, :a, :n, :w)', ['u' => $user['id'], 'a' => $art, 'n' => $name, 'w' => $json]);
    return ['preset' => preset_objekt(preset_laden($user, $id))];
}

/** Umbenennen und/oder Werte überschreiben */
function api_preset_aendern(array $user, int $id): array
{
    $z = preset_laden($user, $id);
    $felder = [];
    $p = ['id' => $id];
    $name = api_wert('name', null);
    if ($name !== null) {
        $name = preset_name_pruefen($name);
        if ($name !== $z['name'] && db_wert('SELECT id FROM effekt_presets WHERE user_id = :u AND art = :a AND name = :n', ['u' => $user['id'], 'a' => $z['art'], 'n' => $name])) {
            throw new ApiFehler(t('Ein Preset mit diesem Namen gibt es schon.'), 409);
        }
        $felder[] = 'name = :n';
        $p['n'] = $name;
    }
    $werte = api_wert('werte', null);
    if ($werte !== null) {
        $felder[] = 'werte = :w';
        $p['w'] = preset_werte_pruefen($werte);
    }
    if ($felder) {
        db_tun('UPDATE effekt_presets SET ' . implode(', ', $felder) . ', geaendert_am = NOW() WHERE id = :id', $p);
    }
    return ['preset' => preset_objekt(preset_laden($user, $id))];
}

function api_preset_loeschen(array $user, int $id): array
{
    preset_laden($user, $id);
    db_tun('DELETE FROM effekt_presets WHERE id = :id AND user_id = :u', ['id' => $id, 'u' => $user['id']]);
    return ['ok' => true];
}
