// Amberwave Windows Server – Programm im Infobereich (wie Plex Media Server).
// Startet und überwacht die mitgelieferten Teile: MariaDB, PHP (FastCGI-Pool), nginx, Zeitplan, cloudflared.
// Alles liegt neben dieser exe (php\, nginx\, mariadb\, ffmpeg\, flac\, fpcalc\, python\, cloudflared\, app\),
// die Daten unter %LOCALAPPDATA%\Amberwave Server (db\, cache\, backups\, logs\, server.ini).
//
// Aufruf: „Amberwave Server.exe“ – Symbol im Infobereich
//         „Amberwave Server.exe“ --konsole [--dauer Sek] [--musik Pfad] [--daten Pfad] – ohne Symbol (Tests, CI)
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <string>
#include <vector>
#include <map>
#include <mutex>
#include <atomic>
#include <thread>
#include <chrono>
#include <cstdio>
#include <cwchar>
#include <algorithm>

using std::wstring;

#ifndef AW_VERSION
#define AW_VERSION L"0.0.0"
#endif

static const wchar_t *APP = L"Amberwave Server";
static wstring g_ordner, g_daten, g_ini, g_log;
static bool g_konsole = false;
static std::mutex g_logSperre;
static HANDLE g_job = nullptr;
static std::atomic<bool> g_ende{false};
static HWND g_fenster = nullptr;
static NOTIFYICONDATAW g_nid{};
static UINT WM_TRAY = WM_APP + 1;
static int g_port = 9950, g_dbPort = 3399, g_httpsPort = 8443, g_php = 6;
static wstring g_musik, g_downloads;
static wstring g_status = L"Startet …";

// ---------- Hilfen ----------

static wstring jetzt()
{
    SYSTEMTIME t; GetLocalTime(&t);
    wchar_t b[32]; swprintf(b, 32, L"%04d-%02d-%02d %02d:%02d:%02d", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond);
    return b;
}
static std::string utf8(const wstring &w)
{
    if (w.empty()) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string s(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
    return s;
}
static wstring breit(const std::string &s)
{
    if (s.empty()) return {};
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    wstring w(n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
    return w;
}
static void logz(const wstring &z)
{
    std::lock_guard<std::mutex> l(g_logSperre);
    std::string zeile = utf8(jetzt() + L"  " + z) + "\r\n";
    if (FILE *f = _wfopen(g_log.c_str(), L"ab")) { fwrite(zeile.data(), 1, zeile.size(), f); fclose(f); }
    if (g_konsole) { fwrite(zeile.data(), 1, zeile.size(), stdout); fflush(stdout); }
}
static bool gibt(const wstring &p) { return GetFileAttributesW(p.c_str()) != INVALID_FILE_ATTRIBUTES; }
static void ordner(const wstring &p) { SHCreateDirectoryExW(nullptr, p.c_str(), nullptr); }
static std::string lesen(const wstring &p)
{
    std::string s;
    if (FILE *f = _wfopen(p.c_str(), L"rb")) { char b[4096]; size_t n; while ((n = fread(b, 1, sizeof b, f)) > 0) s.append(b, n); fclose(f); }
    return s;
}
static bool schreiben(const wstring &p, const std::string &s)
{
    FILE *f = _wfopen(p.c_str(), L"wb");
    if (!f) return false;
    fwrite(s.data(), 1, s.size(), f); fclose(f); return true;
}
static wstring slash(wstring p) { for (auto &c : p) if (c == L'\\') c = L'/'; return p; }
static wstring zufall(int n)
{
    static const wchar_t *z = L"abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    HCRYPTPROV h; BYTE b[64]{};
    if (CryptAcquireContextW(&h, nullptr, nullptr, PROV_RSA_FULL, CRYPT_VERIFYCONTEXT)) { CryptGenRandom(h, sizeof b, b); CryptReleaseContext(h, 0); }
    else for (auto &x : b) x = (BYTE)(GetTickCount() * 2654435761u >> 24);
    wstring s; for (int i = 0; i < n && i < 64; i++) s += z[b[i] % 56]; return s;
}

// ---------- server.ini ----------

static wstring ini(const wchar_t *k, const wstring &std_)
{
    wchar_t b[2048]; GetPrivateProfileStringW(L"server", k, std_.c_str(), b, 2048, g_ini.c_str()); return b;
}
static void iniSetzen(const wchar_t *k, const wstring &v) { WritePrivateProfileStringW(L"server", k, v.c_str(), g_ini.c_str()); }
static void iniLaden()
{
    g_musik = ini(L"musik", g_musik);
    g_downloads = ini(L"downloads", L"");
    g_port = _wtoi(ini(L"port", L"9950").c_str());
    g_dbPort = _wtoi(ini(L"datenbank_port", L"3399").c_str());
    g_httpsPort = _wtoi(ini(L"https_port", L"8443").c_str());
    g_php = std::max(2, std::min(32, _wtoi(ini(L"php_prozesse", L"6").c_str())));
}

// ---------- Prozesse ----------

struct Prozess {
    wstring name, befehl, ordner, log;
    HANDLE h = nullptr;
    DWORD pid = 0;
    bool neustarten = false;
};
static std::mutex g_prozSperre;
static std::vector<Prozess> g_dienste;   // php-cgi, nginx, mariadb, cloudflared

static HANDLE logDatei(const wstring &p)
{
    SECURITY_ATTRIBUTES sa{sizeof sa, nullptr, TRUE};
    HANDLE h = CreateFileW(p.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, &sa, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    return h;
}
static HANDLE starten(const wstring &befehl, const wstring &ordner_, const wstring &log, DWORD *pid = nullptr)
{
    STARTUPINFOW si{}; si.cb = sizeof si;
    HANDLE hl = log.empty() ? INVALID_HANDLE_VALUE : logDatei(log);
    SECURITY_ATTRIBUTES sa{sizeof sa, nullptr, TRUE};
    HANDLE nul = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = nul;
    si.hStdOutput = hl != INVALID_HANDLE_VALUE ? hl : nul;
    si.hStdError = si.hStdOutput;
    PROCESS_INFORMATION pi{};
    std::vector<wchar_t> b(befehl.begin(), befehl.end()); b.push_back(0);
    BOOL ok = CreateProcessW(nullptr, b.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr,
                             ordner_.empty() ? nullptr : ordner_.c_str(), &si, &pi);
    if (hl != INVALID_HANDLE_VALUE) CloseHandle(hl);
    if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
    if (!ok) { logz(L"Start fehlgeschlagen (" + std::to_wstring(GetLastError()) + L"): " + befehl); return nullptr; }
    if (g_job) AssignProcessToJobObject(g_job, pi.hProcess);
    ResumeThread(pi.hThread); CloseHandle(pi.hThread);
    if (pid) *pid = pi.dwProcessId;
    return pi.hProcess;
}
/** Befehl ausführen und warten; Ausgabe ins Log; Rückgabe Exit-Code (-1 = nicht gestartet/Zeitüberschreitung) */
static int ausfuehren(const wstring &befehl, const wstring &log, DWORD ms = 120000)
{
    HANDLE h = starten(befehl, g_ordner, log);
    if (!h) return -1;
    DWORD r = WaitForSingleObject(h, ms);
    DWORD code = (DWORD)-1;
    if (r == WAIT_OBJECT_0) GetExitCodeProcess(h, &code); else TerminateProcess(h, 1);
    CloseHandle(h);
    return (int)code;
}
static bool portOffen(int port)
{
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return false;
    sockaddr_in a{}; a.sin_family = AF_INET; a.sin_port = htons((u_short)port); inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
    bool ok = connect(s, (sockaddr *)&a, sizeof a) == 0;
    closesocket(s);
    return ok;
}
static wstring q(const wstring &s) { return L"\"" + s + L"\""; }

// ---------- Teile ----------

static wstring P(const wchar_t *rel) { return g_ordner + L"\\" + rel; }
static wstring D(const wchar_t *rel) { return g_daten + L"\\" + rel; }
static wstring php() { return P(L"php\\php.exe"); }
static wstring phpSkript(const wchar_t *s) { return q(php()) + L" " + q(P(L"app\\scripts\\") + s); }

static void umgebung()
{
    auto set = [](const wchar_t *k, const wstring &v) { SetEnvironmentVariableW(k, v.c_str()); };
    set(L"AMBERWAVE_WINDOWS", L"1");
    set(L"PFAD_MUSIK", g_musik);
    set(L"PFAD_CACHE", D(L"cache"));
    set(L"PFAD_BACKUPS", D(L"backups"));
    if (!g_downloads.empty()) set(L"PFAD_DOWNLOADS", g_downloads);
    set(L"DB_HOST", L"127.0.0.1");
    set(L"DB_PORT", std::to_wstring(g_dbPort));
    set(L"APP_PORT", std::to_wstring(g_port));
    set(L"LOKAL_HTTPS_PORT", std::to_wstring(g_httpsPort));
    set(L"AW_PHP_CLI", php());
    set(L"PHPRC", P(L"php"));
    set(L"AW_PHP_EXT", P(L"php\\ext"));
    set(L"AW_PHP_LOG", D(L"logs\\php-fehler.log"));
    set(L"PHP_FCGI_MAX_REQUESTS", L"0");
    set(L"FFMPEG_PFAD", P(L"ffmpeg\\bin\\ffmpeg.exe"));
    set(L"FFPROBE_PFAD", P(L"ffmpeg\\bin\\ffprobe.exe"));
    set(L"KLANG_PYTHON", P(L"python\\python.exe"));
    set(L"TUNNEL_ZIEL", L"http://127.0.0.1:" + std::to_wstring(g_port));
    set(L"TUNNEL_CONTAINER", L"localhost");
    wchar_t alt[32767]; GetEnvironmentVariableW(L"PATH", alt, 32767);
    set(L"PATH", P(L"php") + L";" + P(L"ffmpeg\\bin") + L";" + P(L"flac") + L";" + P(L"fpcalc") + L";" + P(L"mariadb\\bin") + L";" + alt);
}

static bool datenbankStarten()
{
    wstring db = D(L"db");
    wstring pwDatei = D(L"cache\\geheimnisse\\db_root_passwort");
    ordner(D(L"cache\\geheimnisse"));
    if (!gibt(db + L"\\mysql")) {
        logz(L"Datenbank wird angelegt …");
        wstring pw = zufall(32);
        if (!schreiben(pwDatei, utf8(pw) + "\n")) { logz(L"Konnte db_root_passwort nicht schreiben"); return false; }
        ordner(db);
        int rc = ausfuehren(q(P(L"mariadb\\bin\\mariadb-install-db.exe")) + L" --datadir=" + q(db) + L" --password=" + pw
                            + L" --port=" + std::to_wstring(g_dbPort), D(L"logs\\mariadb-install.log"), 300000);
        if (rc != 0) { logz(L"mariadb-install-db fehlgeschlagen (" + std::to_wstring(rc) + L"), siehe logs\\mariadb-install.log"); return false; }
    }
    std::string cnf = "[mysqld]\r\ndatadir=" + utf8(slash(db)) + "\r\nport=" + std::to_string(g_dbPort)
                    + "\r\nbind-address=127.0.0.1\r\nskip-name-resolve\r\ncharacter-set-server=utf8mb4\r\ncollation-server=utf8mb4_unicode_ci\r\n"
                      "innodb_buffer_pool_size=" + utf8(ini(L"datenbank_puffer", L"256M")) + "\r\nlog-error=" + utf8(slash(D(L"logs\\mariadb.log"))) + "\r\n";
    schreiben(D(L"mariadb.ini"), cnf);
    Prozess p; p.name = L"mariadb";
    p.befehl = q(P(L"mariadb\\bin\\mariadbd.exe")) + L" --defaults-file=" + q(D(L"mariadb.ini"));
    p.h = starten(p.befehl, g_ordner, L"", &p.pid);
    if (!p.h) return false;
    { std::lock_guard<std::mutex> l(g_prozSperre); g_dienste.push_back(p); }
    for (int i = 0; i < 120; i++) {
        if (portOffen(g_dbPort)) { logz(L"MariaDB läuft (Port " + std::to_wstring(g_dbPort) + L")"); return true; }
        if (WaitForSingleObject(p.h, 0) == WAIT_OBJECT_0) break;
        Sleep(500);
    }
    logz(L"MariaDB startet nicht – siehe logs\\mariadb.log");
    return false;
}

static void nginxKonfig()
{
    wstring app = slash(P(L"app"));
    wstring tls = slash(D(L"cache\\tls"));
    std::string ups;
    for (int i = 0; i < g_php; i++) ups += "    server 127.0.0.1:" + std::to_string(9100 + i) + ";\r\n";
    std::string orte =
        "    root \"" + utf8(app) + "\";\r\n"
        "    index index.php;\r\n"
        "    client_max_body_size 64m;\r\n"
        "    location ~ (^|/)\\. { return 404; }\r\n"
        "    location ~ \\.(env|sql|gz|log|bak|md|zip|sh|dist|lock|json\\.tmp)$ { return 404; }\r\n"
        "    location ~ ^/(includes|migrations|scripts|bin|klang|i18n)(/|$) { return 403; }\r\n"
        "    location ^~ /api/v1/ { rewrite ^/api/v1/(.*)$ /api/index.php?pfad=$1 last; }\r\n"
        "    location ~ \\.php$ { try_files $uri =404; include fastcgi_params; fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name; fastcgi_pass php; }\r\n"
        "    location ~ \\.(css|js)$ { add_header Cache-Control \"no-cache\"; try_files $uri =404; }\r\n"
        "    location = /sw.js { add_header Cache-Control \"no-cache\"; add_header Service-Worker-Allowed \"/\"; }\r\n"
        "    location / { try_files $uri /index.php?$args; }\r\n";
    std::string c =
        "worker_processes 1;\r\nerror_log logs/error.log warn;\r\npid logs/nginx.pid;\r\nevents { worker_connections 512; }\r\n"
        "http {\r\n  include mime.types;\r\n  default_type application/octet-stream;\r\n  types { font/woff2 woff2; }\r\n"
        "  access_log off;\r\n  sendfile on;\r\n  server_tokens off;\r\n  gzip on;\r\n"
        "  gzip_types text/css text/plain text/xml application/javascript text/javascript application/json application/manifest+json image/svg+xml;\r\n"
        "  fastcgi_buffering off;\r\n  fastcgi_read_timeout 3600s;\r\n  fastcgi_keep_conn on;\r\n"
        "  upstream php {\r\n    least_conn;\r\n" + ups + "    keepalive 8;\r\n  }\r\n"
        "  server {\r\n    listen " + std::to_string(g_port) + ";\r\n" + orte + "  }\r\n";
    if (gibt(D(L"cache\\tls\\fullchain.pem")) && gibt(D(L"cache\\tls\\privkey.pem"))) {
        c += "  server {\r\n    listen " + std::to_string(g_httpsPort) + " ssl;\r\n    ssl_certificate \"" + utf8(tls) + "/fullchain.pem\";\r\n"
             "    ssl_certificate_key \"" + utf8(tls) + "/privkey.pem\";\r\n    ssl_protocols TLSv1.2 TLSv1.3;\r\n" + orte + "  }\r\n";
    }
    c += "}\r\n";
    wstring n = D(L"nginx");
    ordner(n + L"\\conf"); ordner(n + L"\\logs"); ordner(n + L"\\temp");
    schreiben(n + L"\\conf\\nginx.conf", c);
    // mime.types und fastcgi.conf aus dem Paket daneben legen (nginx sucht sie relativ zur Konfiguration)
    for (const wchar_t *d : {L"mime.types", L"fastcgi_params"})
        CopyFileW((P(L"nginx\\conf\\") + d).c_str(), (n + L"\\conf\\" + d).c_str(), FALSE);
}
static wstring nginxBefehl(const wstring &zusatz)
{
    // Präfix mit / am Ende: ein \ vor dem schließenden Anführungszeichen würde es maskieren
    return q(P(L"nginx\\nginx.exe")) + L" -p " + q(slash(D(L"nginx")) + L"/") + L" -c conf/nginx.conf" + zusatz;
}

static void dienstHinzu(const wstring &name, const wstring &befehl, const wstring &log)
{
    Prozess p; p.name = name; p.befehl = befehl; p.log = log; p.neustarten = true;
    p.h = starten(befehl, g_ordner, log, &p.pid);
    std::lock_guard<std::mutex> l(g_prozSperre);
    g_dienste.push_back(p);
}

// ---------- Ablauf ----------

static void statusSetzen(const wstring &s)
{
    g_status = s;
    logz(s);
    if (g_fenster) {
        wcsncpy(g_nid.szTip, (wstring(APP) + L" – " + s).substr(0, 127).c_str(), 127);
        g_nid.uFlags = NIF_TIP;
        Shell_NotifyIconW(NIM_MODIFY, &g_nid);
    }
}
static void blase(const wstring &titel, const wstring &text)
{
    if (!g_fenster) return;
    g_nid.uFlags = NIF_INFO;
    wcsncpy(g_nid.szInfoTitle, titel.substr(0, 63).c_str(), 63);
    wcsncpy(g_nid.szInfo, text.substr(0, 255).c_str(), 255);
    g_nid.dwInfoFlags = NIIF_INFO;
    Shell_NotifyIconW(NIM_MODIFY, &g_nid);
}
static wstring adresse(const wchar_t *pfad = L"/") { return L"http://localhost:" + std::to_wstring(g_port) + pfad; }

static bool hochfahren()
{
    ordner(D(L"cache")); ordner(D(L"backups")); ordner(D(L"logs"));
    umgebung();
    statusSetzen(L"Datenbank startet …");
    if (!datenbankStarten()) { statusSetzen(L"Datenbank startet nicht – Logs ansehen"); return false; }
    int rc = ausfuehren(phpSkript(L"windows_start.php"), D(L"logs\\server-php.log"));
    if (rc != 0) { statusSetzen(L"Datenbank-Zugang fehlgeschlagen – Logs ansehen"); return false; }
    statusSetzen(L"Datenbank-Update …");
    ausfuehren(phpSkript(L"migrate.php") + L" --start", D(L"logs\\server-php.log"), 1800000);
    logz(L"Einrichtung prüfen …");
    ausfuehren(phpSkript(L"einrichtung_start.php"), D(L"logs\\server-php.log"), 300000);
    logz(L"PHP und Webserver starten …");
    for (int i = 0; i < g_php; i++)
        dienstHinzu(L"php", q(P(L"php\\php-cgi.exe")) + L" -b 127.0.0.1:" + std::to_wstring(9100 + i), D(L"logs\\php-cgi.log"));
    nginxKonfig();
    dienstHinzu(L"nginx", nginxBefehl(L""), D(L"logs\\nginx.log"));
    for (int i = 0; i < 40 && !portOffen(g_port); i++) Sleep(250);
    if (!portOffen(g_port)) { statusSetzen(L"Webserver startet nicht (Port " + std::to_wstring(g_port) + L" belegt?)"); return false; }
    statusSetzen(L"läuft – " + adresse());
    return true;
}

static void wache()
{
    auto letzterZeitplan = std::chrono::steady_clock::now() - std::chrono::seconds(55);
    HANDLE zeitplan = nullptr;
    while (!g_ende) {
        // abgestürzte Teile neu starten
        {
            std::lock_guard<std::mutex> l(g_prozSperre);
            for (auto &p : g_dienste) {
                if (p.h && p.neustarten && WaitForSingleObject(p.h, 0) == WAIT_OBJECT_0 && !g_ende) {
                    CloseHandle(p.h);
                    logz(L"Neustart: " + p.name);
                    p.h = starten(p.befehl, g_ordner, p.log, &p.pid);
                }
            }
        }
        // Zeitplan jede Minute (Mails, geplanter Scan, Klanganalyse …)
        if (std::chrono::steady_clock::now() - letzterZeitplan > std::chrono::seconds(60)) {
            if (!zeitplan || WaitForSingleObject(zeitplan, 0) == WAIT_OBJECT_0) {
                if (zeitplan) CloseHandle(zeitplan);
                zeitplan = starten(phpSkript(L"zeitplan.php"), g_ordner, D(L"logs\\zeitplan.log"));
                letzterZeitplan = std::chrono::steady_clock::now();
            }
        }
        // Fernzugriff: cloudflared, sobald Amberwave einen Tunnel angelegt hat
        wstring token = D(L"cache\\tunnel\\token");
        bool hatTunnel = false;
        { std::lock_guard<std::mutex> l(g_prozSperre); for (auto &p : g_dienste) if (p.name == L"cloudflared") hatTunnel = true; }
        if (!hatTunnel && gibt(token) && gibt(P(L"cloudflared\\cloudflared.exe")))
            dienstHinzu(L"cloudflared", q(P(L"cloudflared\\cloudflared.exe")) + L" tunnel --no-autoupdate run --token-file " + q(token), D(L"logs\\cloudflared.log"));
        // Neues Zertifikat für den Direktzugang: Konfiguration neu schreiben, nginx sanft neu laden
        wstring neu = D(L"cache\\tls\\neu_laden");
        if (gibt(neu)) {
            DeleteFileW(neu.c_str());
            nginxKonfig();
            ausfuehren(nginxBefehl(L" -s reload"), D(L"logs\\nginx.log"), 15000);
            logz(L"Direktzugang: Zertifikat neu geladen");
        }
        for (int i = 0; i < 20 && !g_ende; i++) Sleep(100);
    }
    if (zeitplan) CloseHandle(zeitplan);
}

static void herunterfahren()
{
    g_ende = true;
    statusSetzen(L"wird beendet …");
    ausfuehren(nginxBefehl(L" -s quit"), D(L"logs\\nginx.log"), 10000);
    std::lock_guard<std::mutex> l(g_prozSperre);
    for (auto &p : g_dienste) {
        if (!p.h || p.name == L"mariadb") continue;
        if (WaitForSingleObject(p.h, 2000) != WAIT_OBJECT_0) TerminateProcess(p.h, 0);
    }
    for (auto &p : g_dienste) {
        if (!p.h || p.name != L"mariadb") continue;
        wstring pw = breit(lesen(D(L"cache\\geheimnisse\\db_root_passwort")));
        while (!pw.empty() && (pw.back() == L'\n' || pw.back() == L'\r')) pw.pop_back();
        ausfuehren(q(P(L"mariadb\\bin\\mariadb-admin.exe")) + L" -h127.0.0.1 -P" + std::to_wstring(g_dbPort) + L" -uroot -p" + pw + L" shutdown", L"", 30000);
        if (WaitForSingleObject(p.h, 60000) != WAIT_OBJECT_0) { logz(L"MariaDB reagiert nicht – wird beendet"); TerminateProcess(p.h, 0); }
        else logz(L"MariaDB sauber beendet");
    }
    logz(L"Beendet");
}

// ---------- Musikordner wählen ----------

static wstring ordnerWaehlen(HWND eltern)
{
    wstring ergebnis;
    IFileOpenDialog *d = nullptr;
    if (SUCCEEDED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&d)))) {
        DWORD o; d->GetOptions(&o); d->SetOptions(o | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
        d->SetTitle(L"Amberwave: Wo liegt deine Musik?");
        if (SUCCEEDED(d->Show(eltern))) {
            IShellItem *it = nullptr;
            if (SUCCEEDED(d->GetResult(&it))) {
                PWSTR p = nullptr;
                if (SUCCEEDED(it->GetDisplayName(SIGDN_FILESYSPATH, &p))) { ergebnis = p; CoTaskMemFree(p); }
                it->Release();
            }
        }
        d->Release();
    }
    return ergebnis;
}

// ---------- Autostart ----------

static const wchar_t *RUN = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
static bool autostartAn()
{
    HKEY k; if (RegOpenKeyExW(HKEY_CURRENT_USER, RUN, 0, KEY_READ, &k) != ERROR_SUCCESS) return false;
    bool an = RegQueryValueExW(k, APP, nullptr, nullptr, nullptr, nullptr) == ERROR_SUCCESS;
    RegCloseKey(k); return an;
}
static void autostartSetzen(bool an)
{
    HKEY k; if (RegOpenKeyExW(HKEY_CURRENT_USER, RUN, 0, KEY_SET_VALUE, &k) != ERROR_SUCCESS) return;
    if (an) {
        wchar_t exe[MAX_PATH]; GetModuleFileNameW(nullptr, exe, MAX_PATH);
        wstring v = q(exe);
        RegSetValueExW(k, APP, 0, REG_SZ, (const BYTE *)v.c_str(), (DWORD)((v.size() + 1) * sizeof(wchar_t)));
    } else RegDeleteValueW(k, APP);
    RegCloseKey(k);
}

// ---------- Infobereich ----------

enum { M_OEFFNEN = 1, M_MUSIK, M_AUTOSTART, M_LOGS, M_NEUSTART, M_ENDE };

static void menue(HWND h)
{
    HMENU m = CreatePopupMenu();
    AppendMenuW(m, MF_STRING | MF_GRAYED, 0, (L"Amberwave " AW_VERSION L" – " + g_status).c_str());
    AppendMenuW(m, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(m, MF_STRING | MF_DEFAULT, M_OEFFNEN, L"Amberwave öffnen");
    AppendMenuW(m, MF_STRING, M_MUSIK, (L"Musikordner: " + (g_musik.empty() ? wstring(L"(keiner)") : g_musik)).c_str());
    AppendMenuW(m, MF_STRING | (autostartAn() ? MF_CHECKED : 0), M_AUTOSTART, L"Mit Windows starten");
    AppendMenuW(m, MF_STRING, M_LOGS, L"Logs öffnen");
    AppendMenuW(m, MF_STRING, M_NEUSTART, L"Server neu starten");
    AppendMenuW(m, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(m, MF_STRING, M_ENDE, L"Beenden");
    POINT p; GetCursorPos(&p);
    SetForegroundWindow(h);
    int r = TrackPopupMenu(m, TPM_RETURNCMD | TPM_RIGHTBUTTON, p.x, p.y, 0, h, nullptr);
    DestroyMenu(m);
    switch (r) {
    case M_OEFFNEN: ShellExecuteW(nullptr, L"open", adresse().c_str(), nullptr, nullptr, SW_SHOWNORMAL); break;
    case M_MUSIK: {
        wstring neu = ordnerWaehlen(h);
        if (!neu.empty() && neu != g_musik) {
            iniSetzen(L"musik", neu); g_musik = neu;
            MessageBoxW(h, L"Der neue Musikordner gilt nach einem Neustart des Servers (Menü → Server neu starten).", APP, MB_OK | MB_ICONINFORMATION);
        }
        break;
    }
    case M_AUTOSTART: autostartSetzen(!autostartAn()); break;
    case M_LOGS: ShellExecuteW(nullptr, L"open", D(L"logs").c_str(), nullptr, nullptr, SW_SHOWNORMAL); break;
    case M_NEUSTART: {
        wchar_t exe[MAX_PATH]; GetModuleFileNameW(nullptr, exe, MAX_PATH);
        herunterfahren();
        ShellExecuteW(nullptr, L"open", exe, L"--neustart", nullptr, SW_SHOWNORMAL);
        PostQuitMessage(0);
        break;
    }
    case M_ENDE: herunterfahren(); PostQuitMessage(0); break;
    }
}

static LRESULT CALLBACK fensterProc(HWND h, UINT msg, WPARAM w, LPARAM l)
{
    if (msg == WM_TRAY) {
        if (LOWORD(l) == WM_LBUTTONDBLCLK) ShellExecuteW(nullptr, L"open", adresse().c_str(), nullptr, nullptr, SW_SHOWNORMAL);
        else if (LOWORD(l) == WM_RBUTTONUP || LOWORD(l) == WM_CONTEXTMENU) menue(h);
        return 0;
    }
    if (msg == WM_QUERYENDSESSION) return TRUE;
    if (msg == WM_ENDSESSION && w) { herunterfahren(); return 0; }
    if (msg == WM_DESTROY) { Shell_NotifyIconW(NIM_DELETE, &g_nid); PostQuitMessage(0); return 0; }
    return DefWindowProcW(h, msg, w, l);
}

// ---------- Start ----------

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, PWSTR, int)
{
    int argc = 0; wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    int dauer = 0; bool neustart = false;
    wstring datenArg;
    for (int i = 1; i < argc; i++) {
        wstring a = argv[i];
        if (a == L"--konsole") g_konsole = true;
        else if (a == L"--neustart") neustart = true;
        else if (a == L"--dauer" && i + 1 < argc) dauer = _wtoi(argv[++i]);
        else if (a == L"--musik" && i + 1 < argc) g_musik = argv[++i];
        else if (a == L"--daten" && i + 1 < argc) datenArg = argv[++i];
    }
    if (g_konsole) AttachConsole(ATTACH_PARENT_PROCESS), freopen("CONOUT$", "w", stdout);

    wchar_t exe[MAX_PATH]; GetModuleFileNameW(nullptr, exe, MAX_PATH);
    g_ordner = exe; g_ordner = g_ordner.substr(0, g_ordner.find_last_of(L'\\'));
    if (!datenArg.empty()) g_daten = datenArg;
    else { wchar_t *lad = nullptr; SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &lad); g_daten = wstring(lad) + L"\\Amberwave Server"; CoTaskMemFree(lad); }
    ordner(g_daten); ordner(g_daten + L"\\logs");
    g_ini = g_daten + L"\\server.ini"; g_log = g_daten + L"\\logs\\server.log";

    // Nur einmal laufen (beim Neustart kurz auf die alte Instanz warten)
    HANDLE mx = nullptr;
    for (int i = 0; i < (neustart ? 60 : 1); i++) {
        mx = CreateMutexW(nullptr, TRUE, L"Local\\AmberwaveServer");
        if (GetLastError() != ERROR_ALREADY_EXISTS) break;
        CloseHandle(mx); mx = nullptr; Sleep(500);
    }
    if (!mx) {
        if (!g_konsole) MessageBoxW(nullptr, L"Amberwave Server läuft schon – das Symbol ist unten rechts im Infobereich.", APP, MB_OK | MB_ICONINFORMATION);
        return 0;
    }
    WSADATA wsa; WSAStartup(MAKEWORD(2, 2), &wsa);
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    g_job = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jl{}; jl.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &jl, sizeof jl);

    logz(L"Amberwave Server " AW_VERSION L" startet (" + g_ordner + L")");
    iniLaden();
    if (!g_musik.empty() && ini(L"musik", L"").empty()) iniSetzen(L"musik", g_musik);
    if (g_musik.empty() && !g_konsole) {
        MessageBoxW(nullptr, L"Willkommen bei Amberwave!\n\nWähle im nächsten Fenster den Ordner mit deiner Musik. Amberwave liest ihn nur – geändert wird dort erst, wenn du es in den Einstellungen erlaubst.", APP, MB_OK | MB_ICONINFORMATION);
        g_musik = ordnerWaehlen(nullptr);
        if (g_musik.empty()) return 0;
        iniSetzen(L"musik", g_musik);
    }

    if (g_konsole) {
        bool ok = hochfahren();
        std::thread t(wache);
        DWORD bis = dauer > 0 ? GetTickCount() + dauer * 1000 : 0;
        while (ok && (dauer == 0 || GetTickCount() < bis) && !gibt(D(L"stopp"))) Sleep(500);
        DeleteFileW(D(L"stopp").c_str());
        herunterfahren(); t.join();
        return ok ? 0 : 1;
    }

    WNDCLASSW wc{}; wc.lpfnWndProc = fensterProc; wc.hInstance = inst; wc.lpszClassName = L"AmberwaveServerFenster";
    RegisterClassW(&wc);
    g_fenster = CreateWindowW(wc.lpszClassName, APP, 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, inst, nullptr);
    g_nid.cbSize = sizeof g_nid; g_nid.hWnd = g_fenster; g_nid.uID = 1;
    g_nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP; g_nid.uCallbackMessage = WM_TRAY;
    g_nid.hIcon = (HICON)LoadImageW(inst, MAKEINTRESOURCEW(1), IMAGE_ICON, GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), 0);
    wcscpy(g_nid.szTip, L"Amberwave Server – startet …");
    Shell_NotifyIconW(NIM_ADD, &g_nid);

    std::thread start([] {
        bool ok = hochfahren();
        if (!ok) { blase(APP, g_status); return; }
        std::thread(wache).detach();
        if (!gibt(D(L"cache\\geheimnisse\\eingerichtet"))) {
            blase(APP, L"Fast fertig – richte Amberwave im Browser ein.");
            ShellExecuteW(nullptr, L"open", adresse(L"/einrichtung.php").c_str(), nullptr, nullptr, SW_SHOWNORMAL);
        } else blase(APP, L"Amberwave läuft – " + adresse());
    });
    start.detach();

    MSG m;
    while (GetMessageW(&m, nullptr, 0, 0) > 0) { TranslateMessage(&m); DispatchMessageW(&m); }
    if (!g_ende) herunterfahren();
    Shell_NotifyIconW(NIM_DELETE, &g_nid);
    return 0;
}
