#!/bin/bash
# Nur im automatischen Test (Kernel-Parameter aw.test=wlan): drei simulierte WLAN-Karten (mac80211_hwsim)
#   wlan0  Amberwave selbst
#   wlan1  „Router“: WLAN „AW-Test-Heim“ (WPA2, Passwort testpasswort1) mit DHCP 192.168.77.0/24
#   wlan2  „Handy“: bei aw.test=ohne-kabel verbindet es sich mit dem Hotspot, prüft DNS-Umleitung und Captive Portal
#          und wählt dann in der Einrichtung das Heim-WLAN
# Ergebnisse als „AWTEST …“-Zeilen auf der seriellen Konsole.
set -u
[ "${1:-}" = handy ] && HANDY=1 || HANDY=0
melde() { echo "AWTEST $*" > /dev/ttyS0; echo "AWTEST $*"; }
if [ "$HANDY" = 0 ]; then
modprobe mac80211_hwsim radios=3 || { melde "fehler hwsim fehlt"; exit 1; }
for i in $(seq 1 20); do [ -d /sys/class/net/wlan2 ] && break; sleep 0.5; done
mkdir -p /run/systemd/network
cat > /run/systemd/network/04-test-heim.network <<N
[Match]
Name=wlan1
[Network]
Address=192.168.77.1/24
DHCPServer=yes
[DHCPServer]
PoolOffset=50
PoolSize=50
N
cat > /run/systemd/network/04-test-handy.network <<N
[Match]
Name=wlan2
[Network]
DHCP=ipv4
[DHCPv4]
UseRoutes=no
UseDNS=no
N
networkctl reload
cat > /run/test-heim.conf <<C
interface=wlan1
driver=nl80211
ssid=AW-Test-Heim
hw_mode=g
channel=1
wpa=2
wpa_passphrase=testpasswort1
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
C
hostapd -B /run/test-heim.conf && melde "heim-ap laeuft"
networkctl reconfigure wlan1
fi
grep -q 'aw.test=ohne-kabel' /proc/cmdline || exit 0
# Das Handy läuft im Hintergrund weiter; der Dienst selbst ist fertig, damit die Einrichtung startet
[ "${1:-}" = handy ] || { setsid "$0" handy >/dev/null 2>&1 < /dev/null & exit 0; }

# --- Handy: Hotspot der Einrichtung ---
for i in $(seq 1 150); do [ -f /run/amberwave/hotspot ] && break; sleep 1; done
[ -f /run/amberwave/hotspot ] || { melde "fehler kein hotspot"; exit 1; }
melde "hotspot an"
sleep 3
printf 'ctrl_interface=/run/wpa_handy\nnetwork={\n ssid="Amberwave-Setup"\n key_mgmt=NONE\n}\n' > /run/handy.conf
wpa_supplicant -B -i wlan2 -c /run/handy.conf -C /run/wpa_handy
networkctl reconfigure wlan2
ip_handy=""
for i in $(seq 1 60); do ip_handy="$(ip -4 -o addr show dev wlan2 | awk '{split($4,a,"/"); print a[1]}')"; [ -n "$ip_handy" ] && break; sleep 1; done
[ -n "$ip_handy" ] && melde "handy dhcp $ip_handy" || { melde "fehler handy bekommt keine adresse"; exit 1; }
antwort="$(python3 - <<P
import socket
q = b'\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x11connectivitycheck\x07gstatic\x03com\x00\x00\x01\x00\x01'
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(('$ip_handy', 0)); s.settimeout(5)
s.sendto(q, ('10.42.0.1', 53)); a = s.recv(512); print(socket.inet_ntoa(a[-4:]))
P
)"
melde "dns $antwort"
code="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --interface "$ip_handy" -H 'Host: connectivitycheck.gstatic.com' http://10.42.0.1/generate_204)"
melde "portal $code"
info="$(curl -s --interface "$ip_handy" http://10.42.0.1/api/info | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["ueber_hotspot"], [n["ssid"] for n in d["netz"]["netze"]])')"
melde "info $info"
r="$(curl -s --interface "$ip_handy" -H 'Content-Type: application/json' -d '{"ssid":"AW-Test-Heim","passwort":"testpasswort1"}' http://10.42.0.1/api/wlan)"
melde "wlan-wahl $r"
