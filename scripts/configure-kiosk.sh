#!/usr/bin/env bash
set -euo pipefail

origin=${APP_ORIGIN:-}
url=${1:-${origin:-http://localhost:3000/}}
if [[ $origin == https://* && $url != "$origin" && $url != "$origin/" ]]; then
  printf 'The kiosk must open %s. Do not use a different HTTP address after HTTPS is enabled.\n' "$origin" >&2
  exit 1
fi
config_dir=${XDG_CONFIG_HOME:-$HOME/.config}/labwc
autostart=$config_dir/autostart
rcxml=$config_dir/rc.xml
pointer_profile='<libinput><device category="default"><accelProfile>flat</accelProfile></device></libinput>'
screen_reader_block='<keyboard><keybind key="C-A-space"><action name="Execute" command="true" /></keybind></keyboard>'
desktop_config_dir=${XDG_CONFIG_HOME:-$HOME/.config}
keyring_override=$desktop_config_dir/autostart/gnome-keyring-secrets.desktop
marker='# Family Hub kiosk'
end_marker='# End Family Hub kiosk'

install -d "$config_dir"
install -d "$desktop_config_dir/autostart"
if [[ ! -f $rcxml ]]; then
  printf '<?xml version="1.0"?>\n<openbox_config xmlns="http://openbox.org/3.4/rc">\n%s\n</openbox_config>\n' "$pointer_profile" >"$rcxml"
elif ! grep -Fq '<accelProfile>flat</accelProfile>' "$rcxml"; then
  updated=$(mktemp)
  while IFS= read -r entry || [[ -n $entry ]]; do
    [[ $entry == '</openbox_config>' ]] && printf '%s\n' "$pointer_profile" >>"$updated"
    printf '%s\n' "$entry" >>"$updated"
  done <"$rcxml"
  mv "$updated" "$rcxml"
fi
if ! grep -Fq 'key="C-A-space"' "$rcxml"; then
  updated=$(mktemp)
  while IFS= read -r entry || [[ -n $entry ]]; do
    [[ $entry == '</openbox_config>' ]] && printf '%s\n' "$screen_reader_block" >>"$updated"
    printf '%s\n' "$entry" >>"$updated"
  done <"$rcxml"
  mv "$updated" "$rcxml"
fi
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
  printf '(sleep 5; chromium_bin=/usr/lib/chromium/chromium; test -x "$chromium_bin" || chromium_bin=chromium; "$chromium_bin" --ozone-platform=wayland --disable-gpu-rasterization --use-angle=gles --disable-dev-shm-usage --user-data-dir="$HOME/.config/family-hub-kiosk" --password-store=basic --kiosk --noerrdialogs --disable-session-crashed-bubble --disable-infobars --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 %q) &\n' "$url"
  printf '%s\n' "$end_marker"
} >>"$autostart"

printf 'Chromium kiosk configured for %s. Reboot or sign in again to start it.\n' "$url"
