# Amberwave – fertiges Image (GitHub Container Registry). Enthält den Code; Updates per `docker compose pull`.
# Die Laufzeit-Schritte sind dieselben wie in docker/Dockerfile (lokaler Bau mit eingebundenem Code) – Änderungen in beiden machen.
FROM php:8.3-apache

LABEL org.opencontainers.image.title="Amberwave" \
      org.opencontainers.image.description="Self-hosted music server with bit-perfect Windows client, remote streaming and remote control" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

# ffmpeg: Live-Umwandlung (Opus/AAC) und Lesen von Tags/Covern bei Nicht-FLAC-Dateien
# python3 + numpy: Klanganalyse (eingebautes Verfahren); python3-venv: optionales erweitertes Modell, das der Admin
# per Knopf selbst vom Hersteller lädt (wird nicht mitgeliefert)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-numpy \
    python3-venv \
    libzip-dev \
    libpng-dev \
    libjpeg62-turbo-dev \
    libwebp-dev \
    unzip \
    && docker-php-ext-configure gd --with-jpeg --with-webp \
    && docker-php-ext-install pdo pdo_mysql zip gd \
    && a2enmod rewrite headers deflate brotli \
    && rm -rf /var/lib/apt/lists/*

RUN { \
    echo 'upload_max_filesize = 20M'; \
    echo 'post_max_size = 22M'; \
    echo 'memory_limit = 512M'; \
    echo 'max_execution_time = 120'; \
    echo 'output_buffering = Off'; \
    echo 'zlib.output_compression = Off'; \
    } > /usr/local/etc/php/conf.d/amberwave.ini

# Härtung: keine Versions-Banner, PHP-Fehler nicht ausgeben, strikte Sessions
RUN { \
    echo 'expose_php = Off'; \
    echo 'display_errors = Off'; \
    echo 'log_errors = On'; \
    echo 'session.use_strict_mode = 1'; \
    echo 'session.cookie_httponly = 1'; \
    echo 'session.use_only_cookies = 1'; \
    } > /usr/local/etc/php/conf.d/haertung.ini

RUN printf '<Directory /var/www/html>\n    AllowOverride All\n</Directory>\n' > /etc/apache2/conf-available/allow-override.conf \
    && a2enconf allow-override \
    && printf 'ServerTokens Prod\nServerSignature Off\nTraceEnable Off\n' > /etc/apache2/conf-available/haertung.conf \
    && a2enconf haertung

# Cover und Bilder liegen außerhalb des Webroots (/cache) und werden über PHP ausgeliefert.

# Code ins Image (lokale Installationen binden ihn stattdessen als Ordner ein)
COPY app /var/www/html
ENV AMBERWAVE_IMAGE=1
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
    CMD php -r '$c = @file_get_contents("http://127.0.0.1/api/v1/ping"); exit($c !== false && str_contains($c, "amberwave") ? 0 : 1);'
CMD ["sh", "/var/www/html/scripts/start.sh"]
