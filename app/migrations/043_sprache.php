<?php
// Migration 043 (PHP): Sprache je Konto (de/en; leer = Browser-Vorgabe)
declare(strict_types=1);
$spalten = $pdo->query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'")->fetchAll(PDO::FETCH_COLUMN);
if (!in_array('sprache', $spalten, true)) {
    $pdo->exec("ALTER TABLE users ADD COLUMN sprache VARCHAR(5) NULL DEFAULT NULL");
}
