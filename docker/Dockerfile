FROM php:8.3-apache

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
