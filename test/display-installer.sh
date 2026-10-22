#!/usr/bin/env bash
# Run directly without Node.js, or through the normal Node.js test suite.
set -euo pipefail
installer=$(cd "$(dirname "$0")/../scripts" && pwd)/install-display.sh
workspace=$(mktemp -d)
browser_pids=()
cleanup() {
  for pid in "${browser_pids[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  rm -rf "$workspace"
}
trap cleanup EXIT
export HOME=$workspace/home
export XDG_CONFIG_HOME=$HOME/.config
export XDG_CONFIG_DIRS=$workspace/xdg
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
expect 'systemctl --user start family-hub-display.service' "$XDG_CONFIG_HOME/labwc/autostart"
run_installer
expect 'Family Hub display changed: false' "$HOME/output"
test "$(grep -c '^# Family Hub kiosk$' "$XDG_CONFIG_HOME/labwc/autostart")" = 1

# Give test processes Chromium's argument layout, without running a browser or
# touching a real profile. Cleanup must match the kiosk, profile, and old URL.
cat >"$HOME/bin/chromium" <<'EOF'
#!/bin/bash
exec -a chromium /bin/bash -c 'trap "exit 0" TERM; touch "$1"; while :; do sleep 0.05; done' browser "$@"
EOF
start_browser() {
  local ready=$1
  "$HOME/bin/chromium" "$@" &
  browser_pid=$!
  browser_pids+=("$browser_pid")
  for _ in $(seq 1 100); do
    [[ ! -f $ready ]] || return 0
    sleep 0.02
  done
  printf 'The test browser did not start.\n' >&2
  exit 1
}
start_browser "$HOME/legacy-ready" --kiosk "--user-data-dir=$HOME/.config/family-hub-kiosk" https://legacy.example/
legacy_pid=$browser_pid
start_browser "$HOME/unrelated-ready" --kiosk "--user-data-dir=$HOME/.config/other-browser" https://legacy.example/
unrelated_pid=$browser_pid
start_browser "$HOME/regular-ready" "--user-data-dir=$HOME/.config/family-hub-kiosk" https://legacy.example/
regular_pid=$browser_pid
start_browser "$HOME/other-url-ready" --kiosk "--user-data-dir=$HOME/.config/family-hub-kiosk" https://different.example/
other_url_pid=$browser_pid
cat >"$XDG_CONFIG_HOME/labwc/autostart" <<'EOF'
: keep-before
# Family Hub kiosk
(sleep 5; chromium --user-data-dir="$HOME/.config/family-hub-kiosk" --kiosk https://legacy.example/) &
# End Family Hub kiosk
: keep-after
EOF
chmod 755 "$XDG_CONFIG_HOME/labwc/autostart"
run_installer https://updated.example/
if kill -0 "$legacy_pid" 2>/dev/null; then
  printf 'The matching legacy kiosk was not stopped.\n' >&2
  exit 1
fi
wait "$legacy_pid"
kill -0 "$unrelated_pid"
kill -0 "$regular_pid"
kill -0 "$other_url_pid"
expect '^: keep-before$' "$XDG_CONFIG_HOME/labwc/autostart"
expect '^: keep-after$' "$XDG_CONFIG_HOME/labwc/autostart"
expect '^test pairing state$' "$XDG_CONFIG_HOME/family-hub-kiosk/pairing"
test "$(stat -c '%a' "$XDG_CONFIG_HOME/labwc/autostart")" = 755
if grep -q -- '--kiosk' "$XDG_CONFIG_HOME/labwc/autostart"; then
  printf 'A direct legacy browser launch remains in autostart.\n' >&2
  exit 1
fi

# A matching browser with no older managed startup entry is not ours to stop.
start_browser "$HOME/unmanaged-ready" --kiosk "--user-data-dir=$HOME/.config/family-hub-kiosk" https://updated.example/
unmanaged_pid=$browser_pid
run_installer
kill -0 "$unmanaged_pid"
expect 'Family Hub display changed: false' "$HOME/output"

# A new Labwc user file must still run the system's desktop startup commands.
export XDG_CURRENT_DESKTOP=labwc
export XDG_CONFIG_HOME=$workspace/fresh-config
mkdir -p "$XDG_CONFIG_DIRS/labwc"
printf 'printf desktop-started >"$HOME/default-started"\n' >"$XDG_CONFIG_DIRS/labwc/autostart"
run_installer https://fresh.example/
expect 'systemctl --user start family-hub-display.service' "$XDG_CONFIG_HOME/labwc/autostart"
: >"$HOME/calls"
unset DISPLAY
export WAYLAND_DISPLAY=wayland-test
bash -c '. "$1"; wait' test-session "$XDG_CONFIG_HOME/labwc/autostart"
expect '^desktop-started$' "$HOME/default-started"
expect '--user import-environment WAYLAND_DISPLAY' "$HOME/calls"
expect '--user start family-hub-display.service' "$HOME/calls"
if grep -q -- '--user import-environment DISPLAY' "$HOME/calls"; then
  printf 'The startup hook tried to import an unset display variable.\n' >&2
  exit 1
fi
run_installer
expect 'Family Hub display changed: false' "$HOME/output"

# Do not erase unrelated content after an incomplete older managed block.
export XDG_CONFIG_HOME=$workspace/broken-config
mkdir -p "$XDG_CONFIG_HOME/labwc"
printf '# Family Hub kiosk\nkeep-this-command\n' >"$XDG_CONFIG_HOME/labwc/autostart"
cp "$XDG_CONFIG_HOME/labwc/autostart" "$HOME/original-autostart"
if bash "$installer" https://fresh.example/ >"$HOME/output" 2>"$HOME/error"; then
  printf 'An incomplete startup block should stop installation.\n' >&2
  exit 1
fi
cmp "$HOME/original-autostart" "$XDG_CONFIG_HOME/labwc/autostart"
expect 'Repair its markers' "$HOME/error"
test ! -e "$XDG_CONFIG_HOME/family-hub/url"
printf 'Display installer tests passed.\n'
