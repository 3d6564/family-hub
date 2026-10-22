#!/usr/bin/env bash
set -euo pipefail

mode=apply
json=false
phase=arguments
changed=false
would_change=false
configuration_change_required=false
browser_install_required=false
service_active=false
service_enabled=false
service_action=none
installed_version=none
target_version=1
migration_required=false
staging=
result_emitted=false
legacy_pids=()
exec 3>&1

# JSON contains only fixed status fields, never the URL or browser data.
report_result() {
  local status=$1
  printf '{"status":"%s","phase":"%s","mode":"%s","changed":%s,"would_change":%s,"installed_version":"%s","target_version":%s,"migration_required":%s,"browser_install_required":%s,"configuration_change_required":%s,"service_action":"%s","service_active":%s,"service_enabled":%s,"legacy_processes":%s}\n' \
    "$status" "$phase" "$mode" "$changed" "$would_change" "$installed_version" "$target_version" "$migration_required" "$browser_install_required" "$configuration_change_required" "$service_action" "$service_active" "$service_enabled" "${#legacy_pids[@]}" >&3
  result_emitted=true
}

finish() {
  local status=$?
  [[ -z $staging ]] || rm -rf "$staging"
  if $json && ! $result_emitted && [[ $status != 0 ]]; then
    report_result error
  fi
}
trap finish EXIT

usage() {
  printf 'Usage: install-display.sh [--check] [--json] [http(s)://hub.example/]\n'
}

url_argument=
while [[ $# -gt 0 ]]; do
  case $1 in
    --check) mode=check ;;
    --json) json=true ;;
    --help) usage; exit 0 ;;
    --) shift; break ;;
    -*) usage >&2; exit 2 ;;
    *)
      [[ -z $url_argument ]] || { usage >&2; exit 2; }
      url_argument=$1
      ;;
  esac
  shift
done
if [[ $# -gt 0 ]]; then
  [[ $# == 1 && -z $url_argument ]] || { usage >&2; exit 2; }
  url_argument=$1
fi
$json && exec 1>&2
phase=inspect
config_home=${XDG_CONFIG_HOME:-$HOME/.config}
wrapper=$config_home/family-hub/display.sh
url_file=$config_home/family-hub/url
version_file=$config_home/family-hub/install-version
unit=$config_home/systemd/user/family-hub-display.service
autostart=$config_home/labwc/autostart
marker='# Family Hub kiosk'
end_marker='# End Family Hub kiosk'
for owned_file in "$wrapper" "$url_file" "$version_file" "$unit" "$autostart"; do
  if [[ ( -e $owned_file || -L $owned_file ) && ! -f $owned_file ]]; then
    printf 'An installer-owned path is not a regular file. Review %s before retrying.\n' "$owned_file" >&2
    exit 1
  fi
done
if [[ -f $unit || -f $wrapper || -f $url_file ]]; then
  installed_version=unversioned
fi
if [[ -f $version_file ]]; then
  recorded_version=$(<"$version_file")
  if [[ $recorded_version != "$target_version" ]]; then
    printf 'The display install version is unsupported. Use an installer that supports the recorded version.\n' >&2
    exit 1
  fi
  installed_version=$recorded_version
fi
if [[ -f $unit ]] && { ! grep -Fxq 'Description=Family Hub display' "$unit" || ! grep -Fxq "ExecStart=$wrapper" "$unit"; }; then
  printf 'The existing display service is unrecognized. Review it before retrying.\n' >&2
  exit 1
fi
if [[ -f $wrapper ]] && ! grep -Fq -- '--user-data-dir="$HOME/.config/family-hub-kiosk"' "$wrapper"; then
  printf 'The existing browser wrapper is unrecognized. Review it before retrying.\n' >&2
  exit 1
fi
staging=$(mktemp -d)

# Build the full plan before changing files, packages, or running services.
planned_sources=()
planned_targets=()
planned_modes=()
plan_file() {
  local source=$1 destination=$2 permissions=$3 kind=${4:-configuration}
  if ! cmp -s "$source" "$destination" || [[ $(stat -c '%a' "$destination") != "$permissions" ]]; then
    planned_sources+=("$source")
    planned_targets+=("$destination")
    planned_modes+=("$permissions")
    would_change=true
    [[ $kind != configuration ]] || configuration_change_required=true
  fi
}

saved_url=
legacy_url=
if [[ -f $autostart ]] && grep -Fq "$marker" "$autostart"; then
  legacy_url=$(sed -n "/^$marker\$/,/^$end_marker\$/p" "$autostart" | grep -oE 'https?://[^[:space:]'\''")]+' | head -n 1 || true)
fi
if [[ -f $url_file ]]; then
  saved_url=$(head -n 1 "$url_file")
elif [[ -f $autostart ]] && grep -Fq "$marker" "$autostart"; then
  saved_url=$legacy_url
fi

url=${url_argument:-${SITE_URL:-$saved_url}}
if [[ ! $url =~ ^https?://[^[:space:]]+$ ]]; then
  printf 'Supply an HTTP or HTTPS display URL, or retain a valid saved URL.\n' >&2
  exit 2
fi
if [[ ${SITE_URL:-} == https://* && $url != "$SITE_URL" && $url != "$SITE_URL/" ]]; then
  printf 'The display URL must match SITE_URL when HTTPS is enabled.\n' >&2
  exit 1
fi

# Labwc does not always activate graphical-session.target. Keep the startup
# hook in its own marked block, preserving unrelated desktop commands.
labwc_startup=false
if [[ -d $config_home/labwc || ${XDG_CURRENT_DESKTOP:-} == *labwc* || ${DESKTOP_SESSION:-} == *labwc* ]] || command -v labwc >/dev/null 2>&1; then
  labwc_startup=true
  : >"$staging/autostart"
  : >"$staging/legacy-block"
  in_block=false
  if [[ -f $autostart ]]; then
    while IFS= read -r entry || [[ -n $entry ]]; do
      if [[ $entry == "$marker" ]]; then
        if $in_block; then
          printf 'The Family Hub startup block is incomplete. Repair its markers in %s, then retry.\n' "$autostart" >&2
          exit 1
        fi
        in_block=true
      elif [[ $entry == "$end_marker" ]]; then
        if ! $in_block; then
          printf 'The Family Hub startup block is incomplete. Repair its markers in %s, then retry.\n' "$autostart" >&2
          exit 1
        fi
        in_block=false
      elif $in_block; then
        printf '%s\n' "$entry" >>"$staging/legacy-block"
      else
        printf '%s\n' "$entry" >>"$staging/autostart"
      fi
    done <"$autostart"
    if $in_block; then
      printf 'The Family Hub startup block is incomplete. Repair its markers in %s, then retry.\n' "$autostart" >&2
      exit 1
    fi
    if [[ -s $staging/legacy-block ]]; then
      [[ $installed_version != none ]] || installed_version=unversioned
      if ! grep -Fq 'systemctl --user start family-hub-display.service' "$staging/legacy-block" &&
        ! { grep -Fq chromium "$staging/legacy-block" && grep -Fq -- '--kiosk' "$staging/legacy-block" && grep -Fq '.config/family-hub-kiosk' "$staging/legacy-block"; }; then
        printf 'The existing Family Hub startup block is unrecognized. Review it before retrying.\n' >&2
        exit 1
      fi
      if grep -Fq -- '--kiosk' "$staging/legacy-block"; then
        migration_required=true
      fi
    fi
    if grep -Fq '.config/family-hub-kiosk' "$staging/autostart"; then
      printf 'An unmanaged startup command uses the kiosk profile. Resolve it before retrying.\n' >&2
      exit 1
    fi
  else
    printf '#!/bin/sh\n' >"$staging/autostart"
    # A user autostart file takes precedence over the system file. Continue
    # running the system defaults instead of replacing the rest of the desktop.
    IFS=: read -r -a system_config_dirs <<<"${XDG_CONFIG_DIRS:-/etc/xdg}"
    for directory in "${system_config_dirs[@]}"; do
      if [[ -f $directory/labwc/autostart ]]; then
        printf '/bin/sh %q &\n' "$directory/labwc/autostart" >>"$staging/autostart"
        break
      fi
    done
  fi
  cat >>"$staging/autostart" <<'EOF'
# Family Hub kiosk
(
  for name in DISPLAY WAYLAND_DISPLAY XDG_CURRENT_DESKTOP XDG_SESSION_TYPE; do
    if printenv "$name" >/dev/null; then
      systemctl --user import-environment "$name" || exit 1
    fi
  done
  systemctl --user start family-hub-display.service
) &
# End Family Hub kiosk
EOF
fi

find_chromium() {
  chromium_bin=
  for candidate in /usr/lib/chromium/chromium chromium chromium-browser; do
    if [[ $candidate == /* && -x $candidate ]] || command -v "$candidate" >/dev/null 2>&1; then
      chromium_bin=$candidate
      break
    fi
  done
}
find_chromium
if [[ -z $chromium_bin ]]; then
  if ! command -v apt-get >/dev/null 2>&1; then
    printf 'Install Chromium, then run this installer again.\n' >&2
    exit 1
  fi
  browser_install_required=true
  would_change=true
  chromium_bin=chromium
fi

if ! systemctl --user show --property=Version >/dev/null 2>&1; then
  printf 'Cannot reach the display user service manager. Sign in to the graphical account and retry with its runtime environment.\n' >&2
  exit 1
fi
systemctl --user is-active --quiet family-hub-display.service && service_active=true
systemctl --user is-enabled --quiet family-hub-display.service && service_enabled=true
[[ $installed_version != unversioned ]] || migration_required=true

# Migrate only a direct browser launch from a known older managed block.
# Match the account, browser name, kiosk flag, exact profile, and old URL.
# Never stop the current service's browser or use a broad Chromium process kill.
if $labwc_startup && [[ -n $legacy_url ]] && grep -Fq -- '--kiosk' "$staging/legacy-block" && grep -Fq -- '.config/family-hub-kiosk' "$staging/legacy-block"; then
  # Chromium can move its main process to a desktop scope. The service's
  # tracked MainPID still belongs to this installer even outside its group.
  current_service_pid=$(systemctl --user show family-hub-display.service --property=MainPID --value 2>/dev/null || true)
  matches_legacy_process() {
    local process=/proc/$1 argument
    local is_kiosk=false same_profile=false same_url=false
    local -a arguments=()
    [[ -O $process && $1 != "$current_service_pid" ]] || return 1
    if ! mapfile -d '' -t arguments 2>/dev/null <"$process/cmdline"; then
      return 1
    fi
    case ${arguments[0]:-} in
      */chromium|*/chromium-browser|chromium|chromium-browser) ;;
      *) return 1 ;;
    esac
    for argument in "${arguments[@]}"; do
      [[ $argument != --kiosk ]] || is_kiosk=true
      [[ $argument != "--user-data-dir=$HOME/.config/family-hub-kiosk" ]] || same_profile=true
      [[ $argument != "$legacy_url" ]] || same_url=true
    done
    $is_kiosk && $same_profile && $same_url || return 1
    if grep -Fq '/family-hub-display.service' "$process/cgroup" 2>/dev/null; then
      return 1
    fi
    kill -0 "$1" 2>/dev/null
  }
  for process in /proc/[0-9]*; do
    pid=${process##*/}
    if matches_legacy_process "$pid"; then
      legacy_pids+=("$pid")
      would_change=true
      migration_required=true
    fi
  done
fi

printf '%s\n' "$url" >"$staging/url"
plan_file "$staging/url" "$url_file" 600

generate_wrapper() {
cat >"$staging/display.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
runtime=\${XDG_RUNTIME_DIR:-/run/user/\$(id -u)}
export XDG_RUNTIME_DIR=\$runtime
for _ in \$(seq 1 60); do
  if [[ -n \${WAYLAND_DISPLAY:-} || -n \${DISPLAY:-} || -S \$runtime/wayland-0 ]]; then
    break
  fi
  sleep 1
done
if [[ -z \${WAYLAND_DISPLAY:-} && -S \$runtime/wayland-0 ]]; then
  export WAYLAND_DISPLAY=wayland-0
fi
bin=$chromium_bin
args=(--disable-dev-shm-usage --user-data-dir="\$HOME/.config/family-hub-kiosk" --password-store=basic --kiosk --noerrdialogs --disable-session-crashed-bubble --disable-infobars)
if [[ -n \${WAYLAND_DISPLAY:-} ]]; then
  args+=(--ozone-platform=wayland --disable-gpu-rasterization --use-angle=gles)
fi
exec "\$bin" "\${args[@]}" $(printf '%q' "$url")
EOF
}
generate_wrapper
plan_file "$staging/display.sh" "$wrapper" 700

cat >"$staging/display.service" <<EOF
[Unit]
Description=Family Hub display
After=graphical-session.target
PartOf=graphical-session.target

[Service]
ExecStart=$wrapper
Restart=on-failure
RestartSec=3

[Install]
WantedBy=graphical-session.target
EOF
plan_file "$staging/display.service" "$unit" 644

if $labwc_startup; then
  autostart_mode=644
  [[ ! -f $autostart ]] || autostart_mode=$(stat -c '%a' "$autostart")
  plan_file "$staging/autostart" "$autostart" "$autostart_mode"
fi
printf '%s\n' "$target_version" >"$staging/install-version"
plan_file "$staging/install-version" "$version_file" 600 metadata

if ! $service_active; then
  service_action=start
elif $configuration_change_required || [[ ${#legacy_pids[@]} -gt 0 ]]; then
  service_action=restart
fi
if ! $service_enabled || [[ $service_action != none ]]; then
  would_change=true
fi

phase=plan
if [[ $mode == check ]]; then
  if $json; then
    report_result ok
  else
    printf 'Installed display version: %s; target: %s\n' "$installed_version" "$target_version"
    printf 'Planned browser installation: %s; legacy processes: %s; service action: %s\n' "$browser_install_required" "${#legacy_pids[@]}" "$service_action"
    printf 'Family Hub display would change: %s\n' "$would_change"
  fi
  exit 0
fi

if $browser_install_required; then
  phase=packages
  changed=true
  sudo -n apt-get update
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y chromium || sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y chromium-browser
  find_chromium
  [[ -n $chromium_bin ]] || { printf 'Chromium installation failed. Install it before retrying.\n' >&2; exit 1; }
  generate_wrapper
fi

phase=migration
if [[ ${#legacy_pids[@]} -gt 0 ]]; then
  current_service_pid=$(systemctl --user show family-hub-display.service --property=MainPID --value 2>/dev/null || true)
fi
for pid in "${legacy_pids[@]}"; do
  # Package installation can take time. Recheck ownership and arguments before
  # signaling a PID from the earlier plan.
  if matches_legacy_process "$pid"; then
    kill -TERM "$pid"
    changed=true
    for _ in $(seq 1 100); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      printf 'The old Family Hub kiosk did not exit. Stop that kiosk, then run the installer again.\n' >&2
      exit 1
    fi
  fi
done

phase=apply
for index in "${!planned_targets[@]}"; do
  install -d "$(dirname "${planned_targets[$index]}")"
  install -m "${planned_modes[$index]}" "${planned_sources[$index]}" "${planned_targets[$index]}"
  changed=true
done
installed_version=$target_version
if $configuration_change_required; then
  systemctl --user daemon-reload
fi
if ! $service_enabled; then
  systemctl --user enable family-hub-display.service
  changed=true
fi
if [[ $service_action == restart ]]; then
  systemctl --user restart family-hub-display.service
  changed=true
elif [[ $service_action == start ]]; then
  systemctl --user start family-hub-display.service
  changed=true
fi
phase=verify
systemctl --user is-active --quiet family-hub-display.service
systemctl --user is-enabled --quiet family-hub-display.service
service_active=true
service_enabled=true
if $json; then
  report_result ok
else
  printf 'Family Hub display service is active. The browser profile was kept.\n'
  printf 'Family Hub display changed: %s\n' "$changed"
fi
