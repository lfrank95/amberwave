#!/bin/bash
# Amberwave OS auf eine interne Platte installieren (vom Installer im Browser gestartet).
# Aufteilung: aw-efi (512 MB, Start) · aw-system (8 GB, Debian + Amberwave-Dienste, jederzeit neu aufspielbar) ·
# aw-daten (Rest: Einstellungen, Datenbank, Cover, Docker-Images, auf Wunsch Musik).
# Eingaben als Umgebung: AW_PLATTE (z. B. nvme0n1), AW_BEHALTEN (1 = vorhandene Datenpartition behalten), dazu die
# Einstellungen AW_NAME, AW_KANAL, AW_ZEITZONE, AW_MUSIK_ART, AW_MUSIK_UUID, AW_NAS_PFAD, AW_NAS_BENUTZER, AW_NAS_PASSWORT.
set -euo pipefail
ST=/run/amberwave/installation.json; mkdir -p /run/amberwave
stand() { printf '{"schritt":"%s","prozent":%s,"fertig":%s,"fehler":%s}\n' "$1" "$2" "${3:-false}" "${4:-null}" > "$ST.neu"; mv "$ST.neu" "$ST"; echo "[installieren] $2 % $1"; }
fehler() { stand "fehler" 0 false "\"$(echo "$1" | sed 's/"/\\"/g')\""; echo "fehler:$1" > /run/amberwave/stand; exit 1; }
trap 'fehler "Unerwarteter Fehler in Zeile $LINENO ($BASH_COMMAND)."' ERR

D="/dev/$AW_PLATTE"
[ -b "$D" ] || fehler "Die Platte $AW_PLATTE gibt es nicht."
teil() { case "$AW_PLATTE" in nvme*|mmcblk*|loop*) echo "${D}p$1" ;; *) echo "${D}$1" ;; esac; }
QUELLE=/run/live/rootfs/filesystem.squashfs
[ -d "$QUELLE/usr" ] || QUELLE=/
echo "Installation auf $D läuft …" > /run/amberwave/stand

stand "Platte vorbereiten" 3
umount -R /mnt/aw 2>/dev/null || true
mkdir -p /mnt/aw
if [ "${AW_BEHALTEN:-0}" = 1 ] && [ "$(lsblk -no PARTLABEL "$(teil 3)" 2>/dev/null)" = aw-daten ]; then
  # Neu aufspielen: Start und System neu, Daten bleiben
  wipefs -qa "$(teil 1)" "$(teil 2)"
else
  wipefs -qa "$D" || true
  sgdisk -Z "$D" >/dev/null 2>&1 || true
  sgdisk -n 1:1M:+512M -t 1:ef00 -c 1:aw-efi -n 2:0:+8G -t 2:8300 -c 2:aw-system -n 3:0:0 -t 3:8300 -c 3:aw-daten "$D" >/dev/null
  partprobe "$D" 2>/dev/null || true; udevadm settle
  mkfs.ext4 -q -F -L aw-daten "$(teil 3)"
fi
udevadm settle
stand "Dateisysteme anlegen" 8
mkfs.vfat -F 32 -n AW-EFI "$(teil 1)" >/dev/null
mkfs.ext4 -q -F -L aw-system "$(teil 2)"

stand "System kopieren" 10
mount "$(teil 2)" /mnt/aw
GESAMT=$(du -sxm "$QUELLE" 2>/dev/null | cut -f1 || true)
( rsync -aHAXx --exclude=/mnt/* --exclude=/media/* --exclude=/proc/* --exclude=/sys/* --exclude=/dev/* --exclude=/run/* --exclude=/tmp/* "$QUELLE/" /mnt/aw/ ) &
KOPIE=$!
while kill -0 $KOPIE 2>/dev/null; do
  sleep 2; JETZT=$(du -sxm /mnt/aw 2>/dev/null | cut -f1 || true); JETZT=${JETZT:-0}
  [ "${GESAMT:-0}" -gt 0 ] && stand "System kopieren" $(( 10 + 70 * JETZT / GESAMT > 80 ? 80 : 10 + 70 * JETZT / GESAMT ))
done
wait $KOPIE

stand "Startmenü einrichten" 84
mkdir -p /mnt/aw/boot/efi /mnt/aw/daten
mount "$(teil 1)" /mnt/aw/boot/efi
SYS_UUID=$(blkid -s PARTUUID -o value "$(teil 2)"); FS_UUID=$(blkid -s UUID -o value "$(teil 2)")
cat > /mnt/aw/etc/fstab <<F
# Amberwave OS
PARTUUID=$SYS_UUID  /          ext4  defaults,noatime,errors=remount-ro  0 1
PARTLABEL=aw-efi    /boot/efi  vfat  umask=0077                          0 2
PARTLABEL=aw-daten  /daten     ext4  defaults,noatime                    0 2
F
for x in dev proc sys run; do mount --rbind /$x /mnt/aw/$x; mount --make-rslave /mnt/aw/$x; done
chroot /mnt/aw grub-install --target=x86_64-efi --efi-directory=/boot/efi --boot-directory=/boot --removable --no-nvram >/dev/null 2>&1 \
  || fehler "Das Startmenü ließ sich nicht einrichten."
cat > /mnt/aw/boot/grub/grub.cfg <<G
set timeout=2
set default=0
insmod part_gpt
insmod ext2
search --no-floppy --fs-uuid --set=root $FS_UUID
menuentry "Amberwave" {
  linux /vmlinuz root=PARTUUID=$SYS_UUID ro quiet console=tty1 console=ttyS0,115200n8
  initrd /initrd.img
}
menuentry "Amberwave (vorheriger Kernel)" {
  linux /vmlinuz.old root=PARTUUID=$SYS_UUID ro quiet console=tty1 console=ttyS0,115200n8
  initrd /initrd.img.old
}
G
# auch über einen Starteintrag in der Firmware (falls die Platte nicht von selbst gefunden wird)
chroot /mnt/aw efibootmgr -q -c -d "$D" -p 1 -L Amberwave -l '\EFI\BOOT\BOOTX64.EFI' >/dev/null 2>&1 || true
for x in run sys proc dev; do umount -R -l /mnt/aw/$x 2>/dev/null || true; done

stand "Einstellungen speichern" 92
mkdir -p /mnt/aw/daten
mount "$(teil 3)" /mnt/aw/daten
mkdir -p /mnt/aw/daten/system /mnt/aw/daten/appdata /mnt/aw/daten/musik
{
  echo "# Amberwave OS – Einstellungen dieses Geräts (werden in der Weboberfläche geändert)"
  for k in AW_NAME AW_KANAL AW_ZEITZONE AW_MUSIK_ART AW_MUSIK_UUID AW_MUSIK_OPTIONEN AW_NAS_PFAD; do
    v="${!k:-}"; [ -n "$v" ] && printf '%s=%q\n' "$k" "$v"
  done
} > /mnt/aw/daten/system/einstellungen
if [ "${AW_MUSIK_ART:-}" = nas ]; then
  { set +x; } 2>/dev/null   # das Passwort nie ins Protokoll
  ( umask 077; printf 'username=%s\npassword=%s\n' "${AW_NAS_BENUTZER:-}" "${AW_NAS_PASSWORT:-}" > /mnt/aw/daten/system/nas.zugang )
fi
sync
umount -R /mnt/aw 2>/dev/null || { sleep 2; umount -R -l /mnt/aw; }
trap - ERR
stand "fertig" 100 true
echo "Fertig – Stick abziehen, das Gerät startet dann von selbst neu." > /run/amberwave/stand
