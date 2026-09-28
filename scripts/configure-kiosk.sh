#!/usr/bin/env bash
set -euo pipefail

url=${1:-http://localhost:3000/}
config_dir=${XDG_CONFIG_HOME:-$HOME/.config}/labwc
autostart=$config_dir/autostart
marker='# Family Hub kiosk'

install -d "$config_dir"
touch "$autostart"
if ! grep -Fq "$marker" "$autostart"; then
  {
    printf '\n%s\n' "$marker"
    printf '(sleep 5; chromium --kiosk --noerrdialogs --disable-session-crashed-bubble --disable-infobars %q) &\n' "$url"
  } >>"$autostart"
fi

printf 'Chromium kiosk configured for %s. Reboot or sign in again to start it.\n' "$url"
