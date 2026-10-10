#!/usr/bin/env bash
# Restaura un respaldo creado por scripts/backup.sh (base de datos + capturas).
#   bash scripts/restore.sh backups/camerasia-AAAA-MM-DD_HHMMSS.tgz [--yes]
# Antes de restaurar guarda una copia del estado actual en backups/pre-restore/.
# La VAULT_MASTER_KEY de .env debe ser la misma que cuando se hizo el respaldo.
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FILE="${1:-}"
YES="${2:-}"
die() { echo "✘ $*" >&2; exit 1; }

[[ -n "$FILE" && -f "$FILE" ]] || die "Indique un archivo de respaldo existente (ver: ls $APP_DIR/backups)"
FILE_ABS="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"
listing="$(tar -tzf "$FILE_ABS" 2>/dev/null || true)"   # (sin pipe: grep -q + pipefail daría falso error)
grep -qx 'backup-tmp.db' <<< "$listing" || die "$FILE no parece un respaldo de CamerasIA"

if [[ "$YES" != "--yes" ]]; then
  read -r -p "Esto reemplaza la base de datos actual por $(basename "$FILE"). ¿Continuar? [s/N] " answer
  [[ "$answer" =~ ^[sSyY]$ ]] || die "Cancelado"
fi

cd "$APP_DIR"
if [[ "$(docker inspect -f '{{.State.Running}}' camerasia 2>/dev/null || true)" == "true" ]]; then
  echo "» Copia de seguridad del estado actual"
  bash "$APP_DIR/scripts/backup.sh" "$APP_DIR/backups/pre-restore" >/dev/null
fi

echo "» Deteniendo la aplicación"
docker compose stop camerasia >/dev/null

echo "» Restaurando"
docker compose run --rm --no-deps --user root -v "$FILE_ABS:/restore.tgz:ro" --entrypoint sh camerasia -c '
  set -e
  rm -rf /tmp/r && mkdir -p /tmp/r && tar -xzf /restore.tgz -C /tmp/r
  cd /data
  mv /tmp/r/backup-tmp.db camerasia.db
  rm -f camerasia.db-wal camerasia.db-shm
  if [ -d /tmp/r/snapshots ]; then rm -rf snapshots && mv /tmp/r/snapshots snapshots; fi
  chown -R cia:cia /data
' >/dev/null

echo "» Iniciando"
docker compose start camerasia >/dev/null
status=""
for _ in $(seq 1 60); do
  status="$(docker inspect -f '{{.State.Health.Status}}' camerasia 2>/dev/null || true)"
  [[ "$status" == "healthy" ]] && break
  sleep 2
done
[[ "$status" == "healthy" ]] || die "La aplicación no quedó saludable tras restaurar: docker compose logs camerasia"
echo "✔ Restauración completa"
