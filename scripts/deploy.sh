#!/usr/bin/env bash
# Sube CamerasIA desde esta PC (Linux, macOS, WSL o Git Bash) a la VPS y ejecuta el instalador.
#
#   ./scripts/deploy.sh root@203.0.113.10 --domain soc.empresa.com --email yo@empresa.com
#   SSH_PORT=2222 REMOTE_DIR=/opt/camerasia ./scripts/deploy.sh admin@vps.empresa.com --allow-ip 200.1.2.3
#
# Todo lo que va después del destino se pasa a scripts/install-vps.sh (ver --help de ese script).
# Se envían los archivos del proyecto (sin node_modules, .env, datos ni certificados privados);
# el .env y los datos que ya existan en la VPS se conservan.
set -Eeuo pipefail

if [[ $# -lt 1 || "$1" == "-h" || "$1" == "--help" ]]; then
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

TARGET="$1"
shift
REMOTE_DIR="${REMOTE_DIR:-/opt/camerasia}"
SSH_PORT="${SSH_PORT:-22}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHIVE="$(mktemp "${TMPDIR:-/tmp}/camerasia-deploy.XXXXXX")"
trap 'rm -f "$ARCHIVE"' EXIT

cd "$REPO"
echo "» Empaquetando el proyecto"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # Archivos versionados + nuevos no ignorados (incluye cambios locales sin commit).
  git ls-files -z --cached --others --exclude-standard |
    while IFS= read -r -d '' f; do [[ -e "$f" ]] && printf '%s\0' "$f"; done |
    tar --null -czf "$ARCHIVE" -T -
else
  tar -czf "$ARCHIVE" --exclude=node_modules --exclude=.git --exclude=dist --exclude=data \
    --exclude=.env --exclude=backups --exclude='certs/*.pem' --exclude=deploy/Caddyfile .
fi
echo "  $(du -h "$ARCHIVE" | cut -f1) a subir"

SUDO="sudo "
[[ "${TARGET%%@*}" == "root" ]] && SUDO=""
q_dir="$(printf '%q' "$REMOTE_DIR")"
remote_args=""
(( $# )) && remote_args="$(printf ' %q' "$@")"

echo "» Subiendo a $TARGET:$REMOTE_DIR"
scp -P "$SSH_PORT" -q "$ARCHIVE" "$TARGET:/tmp/camerasia-deploy.tgz"

echo "» Instalando en la VPS (puede pedir la contraseña de sudo)"
ssh -t -p "$SSH_PORT" "$TARGET" \
  "${SUDO}mkdir -p $q_dir && ${SUDO}tar -xzf /tmp/camerasia-deploy.tgz --no-same-owner -C $q_dir && rm -f /tmp/camerasia-deploy.tgz \
   && ${SUDO}sed -i 's/\r\$//' $q_dir/scripts/*.sh $q_dir/Dockerfile $q_dir/.env.example \
   && ${SUDO}bash $q_dir/scripts/install-vps.sh$remote_args"
