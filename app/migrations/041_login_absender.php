<?php
// Migration 041 (PHP): Login-Versuche merken sich zusätzlich die echte Absenderadresse (REMOTE_ADDR). Die Besucher-IP
// kann aus einer Proxy-Kopfzeile stammen, die im Heimnetz jeder setzen könnte – die Sperre zählt darum beides.
declare(strict_types=1);
$spalten = $pdo->query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'login_versuche'")->fetchAll(PDO::FETCH_COLUMN);
if (!in_array('absender', $spalten, true)) {
    $pdo->exec("ALTER TABLE login_versuche ADD COLUMN absender VARCHAR(45) NOT NULL DEFAULT '' AFTER ip_adresse, ADD INDEX idx_login_absender (absender, zeitstempel)");
}
