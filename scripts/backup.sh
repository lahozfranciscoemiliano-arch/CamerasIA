#!/usr/bin/env bash
# Respaldo consistente de CamerasIA (base SQLite + capturas de eventos), sin detener el servicio.
#   bash scripts/backup.sh [carpeta_destino]        (por defecto: ./backups, conserva 14 copias)
# La clave maestra de la bóveda (VAULT_MASTER_KEY en .env) NO se incluye: guárdela aparte.
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$APP_DIR/backups}"
KEEP="${KEEP:-14}"
STAMP="$(date +%F_%H%M%S)"
OUT="$DEST/camerasia-$STAMP.tgz"

docker inspect camerasia >/dev/null 2>&1 || { echo "El contenedor 'camerasia' no existe o no está corriendo" >&2; exit 1; }
mkdir -p "$DEST"
chmod 700 "$DEST"

# Copia en caliente y consistente de la base (VACUUM INTO no bloquea a los operadores).
docker exec camerasia rm -f /data/backup-tmp.db
docker exec camerasia node --disable-warning=ExperimentalWarning -e \
  "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('/data/camerasia.db').exec(\"VACUUM INTO '/data/backup-tmp.db'\")"

umask 077
docker exec camerasia sh -c 'cd /data && tar -czf - backup-tmp.db $( [ -d snapshots ] && echo snapshots )' > "$OUT.partial"
mv "$OUT.partial" "$OUT"
docker exec camerasia rm -f /data/backup-tmp.db

# Retención
ls -1t "$DEST"/camerasia-*.tgz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f

echo "Respaldo creado: $OUT ($(du -h "$OUT" | cut -f1))"
echo "Recuerde: la clave VAULT_MASTER_KEY de .env no está en el respaldo; guárdela por separado."
