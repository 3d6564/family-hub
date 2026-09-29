#!/usr/bin/env bash
set -euo pipefail

url=${1:-http://localhost:3000/}
config_dir=${XDG_CONFIG_HOME:-$HOME/.config}/labwc
autostart=$config_dir/autostart
desktop_config_dir=${XDG_CONFIG_HOME:-$HOME/.config}
keyring_override=$desktop_config_dir/autostart/gnome-keyring-secrets.desktop
marker='# Family Hub kiosk'
end_marker='# End Family Hub kiosk'

install -d "$config_dir"
install -d "$desktop_config_dir/autostart"
printf '[Desktop Entry]\nHidden=true\n' >"$keyring_override"
systemctl --user mask --now gnome-keyring-daemon.service gnome-keyring-daemon.socket || true
touch "$autostart"
if grep -Fq "$marker" "$autostart"; then
  retained=$(mktemp)
  in_managed_block=false
  while IFS= read -r entry; do
    if [[ $entry == "$marker" ]]; then
      in_managed_block=true
      continue
    fi
    if [[ $entry == "$end_marker" ]]; then
      in_managed_block=false
      continue
    fi
    $in_managed_block || printf '%s\n' "$entry" >>"$retained"
  done <"$autostart"
  mv "$retained" "$autostart"
fi
{
  printf '\n%s\n' "$marker"
  printf '(sleep 5; chromium --ozone-platform=wayland --user-data-dir="$HOME/.config/family-hub-kiosk" --password-store=basic --kiosk --noerrdialogs --disable-session-crashed-bubble --disable-infobars --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 %q) &\n' "$url"
  printf '%s\n' "$end_marker"
} >>"$autostart"

printf 'Chromium kiosk configured for %s. Reboot or sign in again to start it.\n' "$url"
