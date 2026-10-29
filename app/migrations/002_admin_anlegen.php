<?php
// Migration 002 (PHP): früher wurde hier ein Konto „admin“ mit dem Werkspasswort „Admin“ angelegt. Das gibt es nicht mehr:
// das erste Konto legt der Einrichtungs-Assistent an (/einrichtung.php). Bestehende Installationen haben die Migration
// bereits angewendet und behalten ihr Konto.
declare(strict_types=1);
