<?php
// Migration 050 (PHP): „Angemeldet bleiben“ gehört zu einem Gerät. Wird das Gerät abgemeldet (Geräteliste, Gerätegrenze),
// verfällt damit auch sein Merk-Token – vorher überlebte es die Abmeldung, wenn das Geräte-Cookie fehlte.
declare(strict_types=1);
$da = $pdo->query("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'remember_tokens' AND COLUMN_NAME = 'geraet_id'")->fetchColumn();
if ((int) $da === 0) {
    $pdo->exec('ALTER TABLE remember_tokens ADD COLUMN geraet_id INT NULL, ADD INDEX idx_remember_geraet (geraet_id)');
}
