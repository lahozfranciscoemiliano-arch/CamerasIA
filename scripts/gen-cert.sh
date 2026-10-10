#!/usr/bin/env bash
# Genera un certificado TLS autofirmado para uso interno (válido 2 años).
# Para producción, prefiera un certificado de su CA interna o del FortiGate.
set -euo pipefail
NAME="${1:-camerasia.local}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/certs"
mkdir -p "$OUT"
openssl req -x509 -newkey rsa:3072 -sha256 -days 730 -nodes \
  -keyout "$OUT/key.pem" -out "$OUT/cert.pem" \
  -subj "/CN=$NAME/O=CamerasIA SOC" \
  -addext "subjectAltName=DNS:$NAME,DNS:localhost,IP:127.0.0.1"
chmod 600 "$OUT/key.pem"
chmod 644 "$OUT/cert.pem"
echo "Certificado generado en $OUT (cert.pem / key.pem) para $NAME"
