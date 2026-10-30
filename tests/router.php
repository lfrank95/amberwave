<?php
// Router für den PHP-Testserver: bildet die .htaccess-Regeln nach (nur für Tests, z. B. tests/windows_probe.sh).
$pfad = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$root = $_SERVER['DOCUMENT_ROOT'];
if (preg_match('#^/api/v1/(.*)$#', $pfad, $m)) {
    $_GET['pfad'] = $m[1];
    chdir($root . '/api');
    require $root . '/api/index.php';
    return true;
}
if (preg_match('#^/(includes|migrations|scripts|bin|klang|i18n)(/|$)#', $pfad)) {
    http_response_code(403);
    echo 'Forbidden';
    return true;
}
if ($pfad !== '/' && is_file($root . $pfad)) {
    if (str_ends_with($pfad, '.php')) {
        require $root . $pfad;
        return true;
    }
    return false; // statische Datei
}
require $root . '/index.php';
return true;
