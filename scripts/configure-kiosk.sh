#!/usr/bin/env bash
set -euo pipefail

printf 'configure-kiosk.sh now uses the display installer.\n' >&2
exec "$(cd "$(dirname "$0")" && pwd)/install-display.sh" "$@"
