#!/usr/bin/env bash
set -euo pipefail

host=${1:-familyhub@family-hub.local}

ssh -t "$host" 'sudo apt-get update && sudo apt-get install -y docker.io docker-compose && sudo systemctl enable --now docker && sudo usermod --append --groups docker "$USER" && sudo install -d -o "$USER" -g "$USER" /opt/family-hub'

printf 'Docker and Compose are installed on %s.\n' "$host"
