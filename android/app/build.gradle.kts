plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Version wie der Server (app/includes/config.php) – App und Server erscheinen im selben Release
val awVersion: String = Regex("'version'\\s*=>\\s*'([^']+)'")
    .find(rootProject.file("../app/includes/config.php").readText())?.groupValues?.get(1) ?: "0.0.0"

/** 0.9.1-beta.5 → 90105, 0.9.1 → 90199 (Vorabversionen zählen vor der fertigen) */
fun versionsCode(v: String): Int {
    val m = Regex("^(\\d+)\\.(\\d+)\\.(\\d+)(?:-[a-z]+\\.?(\\d+))?").find(v) ?: return 1
    val (a, b, c) = m.destructured
    val vor = m.groupValues[4]
    return a.toInt() * 1_000_000 + b.toInt() * 10_000 + c.toInt() * 100 + (if (vor.isEmpty()) 99 else vor.toInt().coerceAtMost(98))
}

// Signierschlüssel aus der Umgebung (GitHub-Secrets); ohne: mit dem Debug-Schlüssel (nur zum Testen)
val schluessel = System.getenv("AW_KEYSTORE")?.takeIf { it.isNotBlank() && file(it).exists() }

android {
    namespace = "io.github.lfrank95.amberwave"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.lfrank95.amberwave"
        minSdk = 29
        targetSdk = 35
        versionCode = versionsCode(awVersion)
        versionName = awVersion
    }

    signingConfigs {
        if (schluessel != null) {
            create("amberwave") {
                storeFile = file(schluessel)
                storePassword = System.getenv("AW_KEYSTORE_PASSWORT")
                keyAlias = System.getenv("AW_KEY_ALIAS") ?: "amberwave"
                keyPassword = System.getenv("AW_KEY_PASSWORT") ?: System.getenv("AW_KEYSTORE_PASSWORT")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (schluessel != null) signingConfigs.getByName("amberwave") else signingConfigs.getByName("debug")
        }
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.media:media:1.7.0")
}
