FROM php:8.3-apache

# ffmpeg: live conversion (Opus/AAC) and reading tags/covers for non-FLAC files
# python3 + numpy: sound analysis (built-in method); python3-venv: optional advanced model that the admin
# downloads from the vendor themselves via a button (not shipped)
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
    && docker-php-ext-install pdo pdo_mysql zip gd opcache \
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

# OPcache: compiled PHP stays in memory (otherwise ~30k lines are recompiled on every request – also for every cover image)
RUN { \
    echo 'opcache.enable = 1'; \
    echo 'opcache.enable_cli = 0'; \
    echo 'opcache.memory_consumption = 128'; \
    echo 'opcache.interned_strings_buffer = 16'; \
    echo 'opcache.max_accelerated_files = 10000'; \
    echo 'opcache.validate_timestamps = 1'; \
    echo 'opcache.revalidate_freq = 2'; \
    } > /usr/local/etc/php/conf.d/opcache.ini

# Hardening: no version banners, do not output PHP errors, strict sessions
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

# Covers and images live outside the web root (/cache) and are served through PHP.
