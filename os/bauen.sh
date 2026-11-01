#!/bin/bash
# Amberwave OS – bootfähiges USB-Image bauen (x86-64, UEFI). Läuft als root auf Debian/Ubuntu (GitHub Actions).
#   bauen.sh <ausgabe-ordner>
# Ergebnis: amberwave-os-<version>.img – auf einen USB-Stick schreiben, davon starten, im Browser einrichten,
# auf die interne SSD installieren. Inhalt: Debian 13 minimal, Docker, Avahi (amberwave.local), der Installer im Browser
# und der Dienst, der beim ersten Start den Amberwave-Container (All-in-One) von GitHub holt.
set -euo pipefail
HIER="$(cd "$(dirname "$0")" && pwd)"
AUS="${1:-$HIER/aus}"
VERSION="$(grep -oE "'version' => '[^']+'" "$HIER/../app/includes/config.php" | head -1 | sed -E "s/.*'([^']+)'$/\1/")"
SUITE="${AW_SUITE:-trixie}"
SPIEGEL="${AW_SPIEGEL:-http://deb.debian.org/debian}"
W="$AUS/bau"; R="$W/rootfs"
rm -rf "$W"; mkdir -p "$W" "$AUS"

PAKETE=(systemd-sysv systemd-resolved systemd-timesyncd udev dbus kmod linux-image-amd64 initramfs-tools live-boot
  grub-efi-amd64-bin grub2-common efibootmgr gdisk e2fsprogs dosfstools rsync util-linux
  iproute2 iputils-ping avahi-daemon libnss-mdns ca-certificates curl python3
  docker.io cifs-utils exfatprogs ntfs-3g firmware-linux-free firmware-realtek)
echo "== Grundsystem ($SUITE)"
mmdebstrap --variant=minbase --components=main,contrib,non-free-firmware \
  --include="$(IFS=,; echo "${PAKETE[*]}")" \
  --customize-hook='echo amberwave > "$1/etc/hostname"' \
  "$SUITE" "$R" "$SPIEGEL"

echo "== Amberwave-Dateien"
cp -a "$HIER/dateien/." "$R/"
mkdir -p "$R/usr/local/share/amberwave/installer/fonts"
cp "$HIER/../app/fonts/"*.woff2 "$R/usr/local/share/amberwave/installer/fonts/"
cp "$HIER/../app/img/logo.svg" "$R/usr/local/share/amberwave/installer/logo.svg"
echo "$VERSION" > "$R/etc/amberwave-version"
chmod +x "$R/usr/local/lib/amberwave/"*
cat > "$R/etc/hosts" <<H
127.0.0.1 localhost
127.0.1.1 amberwave
::1 localhost ip6-localhost ip6-loopback
H
# Konsole: auf tty1 läuft die Anzeige (Adresse, Stand) statt einer Anmeldung; niemand muss sich je anmelden
chroot "$R" systemctl enable systemd-networkd systemd-networkd-wait-online systemd-resolved systemd-timesyncd avahi-daemon aw-anzeige aw-installer aw-start >/dev/null
chroot "$R" systemctl mask getty@tty1.service >/dev/null
chroot "$R" passwd -l root >/dev/null
ln -sf /run/systemd/resolve/stub-resolv.conf "$R/etc/resolv.conf"
rm -rf "$R/var/cache/apt/archives/"*.deb "$R/var/lib/apt/lists/"* "$R/tmp/"*

echo "== squashfs"
mkdir -p "$W/stick/live" "$W/stick/EFI/BOOT" "$W/stick/boot/grub"
mksquashfs "$R" "$W/stick/live/filesystem.squashfs" -comp zstd -Xcompression-level 15 -noappend -quiet -e boot/efi
cp "$(readlink -f "$R/vmlinuz")" "$W/stick/live/vmlinuz"
cp "$(readlink -f "$R/initrd.img")" "$W/stick/live/initrd.img"
cp "$HIER/grub-stick.cfg" "$W/stick/boot/grub/grub.cfg"
# GRUB für den Stick: findet seine Konfiguration über das Dateisystem-Label AMBERWAVE
printf 'search --no-floppy --set=root --label AMBERWAVE\nset prefix=($root)/boot/grub\nconfigfile ($root)/boot/grub/grub.cfg\n' > "$W/grub-eingebettet.cfg"
grub-mkstandalone -O x86_64-efi -o "$W/stick/EFI/BOOT/BOOTX64.EFI" --modules="part_gpt fat search search_label configfile linux normal all_video gfxterm echo test" \
  "boot/grub/grub.cfg=$W/grub-eingebettet.cfg"

echo "== Image"
GROESSE_MB=$(( $(du -sm "$W/stick" | cut -f1) + 96 ))
IMG="$AUS/amberwave-os-$VERSION.img"
rm -f "$IMG"; truncate -s "$(( GROESSE_MB + 2 ))M" "$IMG"
sgdisk -Z -n 1:1M:0 -t 1:ef00 -c 1:aw-stick "$IMG" >/dev/null
mformat -i "$IMG@@1M" -F -v AMBERWAVE -T $(( GROESSE_MB * 2048 )) -h 64 -s 32 ::
mcopy -s -i "$IMG@@1M" "$W/stick/"* ::
echo "fertig: $IMG ($(du -h "$IMG" | cut -f1), Amberwave $VERSION, Debian $SUITE)"
