#!/usr/bin/env bash
# Run directly without Node.js, or through the normal Node.js test suite.
set -euo pipefail
installer=$(cd "$(dirname "$0")/../scripts" && pwd)/install-display.sh
workspace=$(mktemp -d)
trap 'rm -rf "$workspace"' EXIT
export HOME=$workspace/home
export XDG_CONFIG_HOME=$HOME/.config
export SITE_URL=
mkdir -p "$HOME/bin"
export PATH=$HOME/bin:$PATH

cat >"$HOME/bin/chromium" <<'EOF'
#!/bin/sh
exit 0
EOF
cat >"$HOME/bin/systemctl" <<'EOF'
#!/bin/bash
set -eu
printf '%s\n' "$*" >>"$HOME/calls"
case "$2" in
  is-enabled) test -f "$HOME/enabled" ;;
  is-active) test -f "$HOME/active" ;;
  enable) touch "$HOME/enabled" ;;
  start|restart) touch "$HOME/active" ;;
esac
EOF
chmod +x "$HOME/bin/chromium" "$HOME/bin/systemctl"

run_installer() {
  : >"$HOME/calls"
  bash "$installer" "$@" >"$HOME/output"
}

expect() {
  if ! grep -q -- "$1" "$2"; then
    printf 'Expected %s in %s\n' "$1" "$2" >&2
    exit 1
  fi
}

run_installer 'https://hub.example/'
expect '--user start family-hub-display.service' "$HOME/calls"
expect 'Family Hub display changed: true' "$HOME/output"
bash -n "$XDG_CONFIG_HOME/family-hub/display.sh"
mkdir -p "$XDG_CONFIG_HOME/family-hub-kiosk"
printf 'test pairing state\n' >"$XDG_CONFIG_HOME/family-hub-kiosk/pairing"

run_installer
expect 'Family Hub display changed: false' "$HOME/output"
if grep -Eq -- 'daemon-reload| restart | start | enable ' "$HOME/calls"; then
  printf 'An unchanged active display must not be restarted.\n' >&2
  exit 1
fi
expect '^test pairing state$' "$XDG_CONFIG_HOME/family-hub-kiosk/pairing"

run_installer 'https://other.example/'
expect '--user restart family-hub-display.service' "$HOME/calls"
expect 'Family Hub display changed: true' "$HOME/output"
expect '^https://other.example/$' "$XDG_CONFIG_HOME/family-hub/url"
expect '^test pairing state$' "$XDG_CONFIG_HOME/family-hub-kiosk/pairing"

rm "$HOME/active"
run_installer
expect '--user start family-hub-display.service' "$HOME/calls"
expect 'Family Hub display changed: true' "$HOME/output"

rm "$HOME/enabled"
run_installer
expect '--user enable family-hub-display.service' "$HOME/calls"
expect 'Family Hub display changed: true' "$HOME/output"

chmod 644 "$XDG_CONFIG_HOME/family-hub/display.sh"
run_installer
expect 'Family Hub display changed: true' "$HOME/output"
test "$(stat -c '%a' "$XDG_CONFIG_HOME/family-hub/display.sh")" = 700

mkdir -p "$XDG_CONFIG_HOME/labwc"
cat >"$XDG_CONFIG_HOME/labwc/autostart" <<'EOF'
keep-before
# Family Hub kiosk
old-browser-command
# End Family Hub kiosk
keep-after
EOF
run_installer
expect '--user restart family-hub-display.service' "$HOME/calls"
expect '^keep-before$' "$XDG_CONFIG_HOME/labwc/autostart"
expect '^keep-after$' "$XDG_CONFIG_HOME/labwc/autostart"
if grep -q 'old-browser-command' "$XDG_CONFIG_HOME/labwc/autostart"; then
  printf 'The legacy kiosk block was not removed.\n' >&2
  exit 1
fi
printf 'Display installer tests passed.\n'
