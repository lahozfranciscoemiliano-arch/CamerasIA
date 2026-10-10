#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
#  CamerasIA · instalador / actualizador para VPS (Ubuntu 22.04+/Debian 12+)
#
#  Uso (como root, dentro de la carpeta del proyecto):
#    bash scripts/install-vps.sh [--domain soc.empresa.com] [--email yo@empresa.com]
#                                [--allow-ip 200.1.2.3,190.4.5.0/24 | --allow-any] [--demo|--no-demo]
#                                [--no-vpn] [--no-firewall] [--skip-build]
#
#  Dominio, email y lista de IPs se recuerdan en .env: al actualizar alcanza con
#  "bash scripts/install-vps.sh" (use --allow-any para quitar la restricción por IP).
#  Es idempotente: volver a ejecutarlo actualiza la aplicación y conserva .env,
#  la clave de la bóveda y los datos.
# ════════════════════════════════════════════════════════════════════════════
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"
CADDYFILE="$APP_DIR/deploy/Caddyfile"
ACCESS_FILE="/root/camerasia-acceso.txt"

DOMAIN=""; DOMAIN_SET=0
EMAIL=""; EMAIL_SET=0
ALLOW_IP=""; ALLOW_SET=0
DEMO_FLAG=""
WANT_VPN=1
FIREWALL=1
SKIP_BUILD=0

c_info=$'\033[1;36m'; c_ok=$'\033[1;32m'; c_warn=$'\033[1;33m'; c_err=$'\033[1;31m'; c_off=$'\033[0m'
info() { printf '%s» %s%s\n' "$c_info" "$*" "$c_off"; }
ok()   { printf '%s✔ %s%s\n' "$c_ok" "$*" "$c_off"; }
warn() { printf '%s⚠ %s%s\n' "$c_warn" "$*" "$c_off" >&2; }
die()  { printf '%s✘ %s%s\n' "$c_err" "$*" "$c_off" >&2; exit 1; }
trap 'die "Falló en la línea $LINENO: $BASH_COMMAND"' ERR

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; DOMAIN_SET=1; shift 2 ;;
    --email) EMAIL="${2:-}"; EMAIL_SET=1; shift 2 ;;
    --allow-ip) ALLOW_IP="${2:-}"; ALLOW_SET=1; shift 2 ;;
    --allow-any) ALLOW_IP=""; ALLOW_SET=1; shift ;;
    --demo) DEMO_FLAG="true"; shift ;;
    --no-demo) DEMO_FLAG="false"; shift ;;
    --no-vpn) WANT_VPN=0; shift ;;
    --no-firewall) FIREWALL=0; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    -h|--help) usage ;;
    *) die "Opción desconocida: $1 (use --help)" ;;
  esac
done

# ───────────────────────── Validaciones ─────────────────────────
[[ $EUID -eq 0 ]] || die "Ejecute como root:  sudo bash scripts/install-vps.sh ..."
[[ -f "$APP_DIR/docker-compose.yml" && -f "$APP_DIR/.env.example" ]] || die "No encuentro el proyecto en $APP_DIR"
validate_options() {
  if [[ -n "$DOMAIN" && ! "$DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$ ]]; then
    die "Dominio inválido: $DOMAIN"
  fi
  if [[ -n "$EMAIL" && ! "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
    die "Email inválido: $EMAIL"
  fi
  ALLOW_LIST=()
  if [[ -n "$ALLOW_IP" ]]; then
    IFS=',' read -r -a _ips <<< "$ALLOW_IP"
    for ip in "${_ips[@]}"; do
      ip="${ip//[[:space:]]/}"
      [[ -z "$ip" ]] && continue
      [[ "$ip" =~ ^[0-9A-Fa-f:.]+(/[0-9]{1,3})?$ ]] || die "IP/CIDR inválida en --allow-ip: $ip"
      ALLOW_LIST+=("$ip")
    done
  fi
}
validate_options

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian) ok "Sistema: ${PRETTY_NAME:-$ID}" ;;
    *) warn "Sistema ${PRETTY_NAME:-desconocido}: probado en Ubuntu/Debian; se intentará igual." ;;
  esac
fi

# ───────────────────────── Utilidades .env ─────────────────────────
get_env() { # clave → valor (vacío si no existe)
  local line
  line="$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 || true)"
  printf '%s' "${line#*=}"
}
set_env() { # clave valor → reemplaza o agrega, preservando permisos y el resto del archivo
  local key="$1" val="$2" tmp found=0 line
  tmp="$(mktemp)"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$key="* ]]; then
      printf '%s=%s\n' "$key" "$val"
      found=1
    else
      printf '%s\n' "$line"
    fi
  done < "$ENV_FILE" > "$tmp"
  [[ $found -eq 1 ]] || printf '%s=%s\n' "$key" "$val" >> "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}
rand_b64() { openssl rand -base64 32 | tr -d '\n'; }
rand_password() { # sin caracteres que Docker Compose interprete ($, comillas, #)
  local s
  s="$(openssl rand -base64 33 | tr -dc 'A-Za-z0-9')"
  printf '%s-Ok7' "${s:0:20}"
}

# ───────────────────────── 1. Memoria (swap para compilar) ─────────────────────────
mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
swap_kb="$(awk '/SwapTotal/ {print $2}' /proc/meminfo)"
if (( mem_kb < 1900000 && swap_kb < 1000000 )) && [[ ! -f /swapfile ]]; then
  info "Poca memoria ($((mem_kb / 1024)) MB): creando swap de 2 GB para compilar la imagen"
  if fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none; then
    chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "Swap activado"
  else
    warn "No se pudo crear swap; la compilación podría fallar por memoria"
  fi
fi

# ───────────────────────── 2. Dependencias y Docker ─────────────────────────
need_pkgs=()
command -v curl >/dev/null || need_pkgs+=(curl)
command -v openssl >/dev/null || need_pkgs+=(openssl)
command -v ca-certificates >/dev/null 2>&1 || [[ -d /etc/ssl/certs ]] || need_pkgs+=(ca-certificates)
if (( ${#need_pkgs[@]} )); then
  info "Instalando ${need_pkgs[*]}"
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need_pkgs[@]}" >/dev/null
fi

if ! command -v docker >/dev/null; then
  info "Instalando Docker (script oficial get.docker.com)"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker info >/dev/null 2>&1 || die "Docker no está funcionando (revise: systemctl status docker)"
docker compose version >/dev/null 2>&1 || die "Falta el plugin 'docker compose' (apt-get install docker-compose-plugin)"
ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null) listo"

# ───────────────────────── 3. Soporte para el túnel FortiVPN ─────────────────────────
VPN_OK=0
if (( WANT_VPN )); then
  modprobe ppp_generic 2>/dev/null || true
  if [[ -c /dev/ppp ]]; then
    echo ppp_generic > /etc/modules-load.d/camerasia-ppp.conf
    VPN_OK=1
    ok "/dev/ppp disponible: el túnel FortiVPN podrá levantarse desde la VPS"
  else
    warn "Esta VPS no tiene /dev/ppp (típico de OpenVZ/LXC). El túnel FortiVPN NO funcionará aquí."
    warn "Opciones: VPS con virtualización KVM, o instalar CamerasIA dentro de la red de la empresa."
  fi
fi

# ───────────────────────── 4. Configuración (.env) ─────────────────────────
FIRST_INSTALL=0
if [[ ! -f "$ENV_FILE" ]]; then
  FIRST_INSTALL=1
  tr -d '\r' < "$APP_DIR/.env.example" > "$ENV_FILE"
  info "Creado .env a partir de .env.example"
fi
chmod 600 "$ENV_FILE"

[[ -n "$(get_env VAULT_MASTER_KEY)" ]] || { set_env VAULT_MASTER_KEY "$(rand_b64)"; ok "Clave maestra de la bóveda generada"; }

# Opciones recordadas de instalaciones anteriores (si no se indicaron ahora)
(( DOMAIN_SET )) || DOMAIN="$(get_env CADDY_DOMAIN)"
(( EMAIL_SET )) || EMAIL="$(get_env CADDY_EMAIL)"
(( ALLOW_SET )) || ALLOW_IP="$(get_env CADDY_ALLOW_IP)"
validate_options
set_env CADDY_DOMAIN "$DOMAIN"
set_env CADDY_EMAIL "$EMAIL"
set_env CADDY_ALLOW_IP "$(IFS=,; echo "${ALLOW_LIST[*]}")"

ADMIN_PASS=""
DB_EXISTS=0
docker volume inspect camerasia_camerasia-data >/dev/null 2>&1 && DB_EXISTS=1
if (( ! DB_EXISTS )); then
  ADMIN_PASS="$(rand_password)"
  set_env ADMIN_USERNAME "admin"
  set_env ADMIN_INITIAL_PASSWORD "$ADMIN_PASS"
fi

if [[ -n "$DEMO_FLAG" ]]; then
  set_env DEMO_MODE "$DEMO_FLAG"
elif (( FIRST_INSTALL )); then
  set_env DEMO_MODE "false"
fi

PUBLIC_IP="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || curl -4 -fsS --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
if [[ ! "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  [[ -n "$DOMAIN" ]] || die "No pude determinar la IP pública de la VPS; indique un dominio con --domain"
  PUBLIC_IP=""
fi

COMPOSE_FILES="docker-compose.yml:docker-compose.caddy.yml"
(( VPN_OK )) && COMPOSE_FILES+=":docker-compose.vpn.yml"
set_env COMPOSE_FILE "$COMPOSE_FILES"
set_env NODE_ENV production
set_env APP_BIND 127.0.0.1
set_env APP_PORT 8443
set_env TLS_CERT_FILE ""
set_env TLS_KEY_FILE ""
set_env TRUST_PROXY true
set_env COOKIE_SECURE true
if (( VPN_OK )); then
  set_env VPN_MODE openfortivpn
  set_env VPN_USE_SUDO true
else
  set_env VPN_MODE disabled
fi
ok "Configuración en $ENV_FILE (permisos 600)"

# ───────────────────────── 5. Caddy (HTTPS) ─────────────────────────
mkdir -p "$APP_DIR/deploy"
CADDY_BEFORE="$(sha256sum "$CADDYFILE" 2>/dev/null | cut -d' ' -f1 || true)"
{
  echo "# Generado por scripts/install-vps.sh — se reescribe en cada ejecución."
  echo "{"
  [[ -n "$EMAIL" ]] && echo "	email $EMAIL"
  if [[ -z "$DOMAIN" ]]; then
    echo "	default_sni $PUBLIC_IP"
    echo "	skip_install_trust"
  fi
  echo "}"
  echo
  if [[ -n "$DOMAIN" ]]; then
    echo "$DOMAIN {"
    echo '	header Strict-Transport-Security "max-age=31536000; includeSubDomains"'
  else
    echo "https://$PUBLIC_IP {"
    echo "	tls internal"
  fi
  if (( ${#ALLOW_LIST[@]} )); then
    echo "	@bloqueado not remote_ip ${ALLOW_LIST[*]}"
    echo '	respond @bloqueado "Acceso no permitido" 403'
  fi
  echo "	reverse_proxy camerasia:8443 {"
  echo "		flush_interval -1"
  echo "	}"
  echo "}"
} > "$CADDYFILE"
CADDY_AFTER="$(sha256sum "$CADDYFILE" | cut -d' ' -f1)"
ok "Caddyfile generado (${DOMAIN:-https://$PUBLIC_IP})"

# ───────────────────────── 6. Firewall ─────────────────────────
if (( FIREWALL )); then
  if ! command -v ufw >/dev/null && command -v apt-get >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ufw >/dev/null 2>&1 || true
  fi
  if command -v ufw >/dev/null; then
    # Puertos SSH: 22 + el de la conexión actual + los configurados en sshd + los que escucha sshd.
    # (Ubuntu 24.04 usa ssh.socket, por eso no alcanza con mirar el proceso sshd.)
    ssh_ports=(22)
    [[ -n "${SSH_CONNECTION:-}" ]] && ssh_ports+=("$(awk '{print $4}' <<< "$SSH_CONNECTION")")
    while read -r p; do [[ "$p" =~ ^[0-9]+$ ]] && ssh_ports+=("$p"); done < <(
      { sshd -T 2>/dev/null | awk '$1 == "port" {print $2}'; ss -tlnpH 2>/dev/null | awk '/"sshd"/ {n = split($4, a, ":"); print a[n]}'; } | sort -u
    )
    for p in $(printf '%s\n' "${ssh_ports[@]}" | sort -u); do ufw allow "$p/tcp" >/dev/null; done
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
    ufw allow 443/udp >/dev/null
    ufw --force enable >/dev/null
    ok "Firewall (ufw): abiertos SSH ($(printf '%s ' "${ssh_ports[@]}"| xargs)), 80 y 443"
  else
    warn "ufw no disponible: configure el firewall del proveedor (abrir sólo SSH, 80 y 443)"
  fi
fi

# ───────────────────────── 7. Compilar y levantar ─────────────────────────
cd "$APP_DIR"
if (( SKIP_BUILD )); then
  info "Usando la imagen camerasia:latest existente (--skip-build)"
else
  info "Compilando la imagen (la primera vez tarda unos minutos)"
  docker compose build --pull
fi
docker compose pull caddy --quiet 2>/dev/null || true
docker compose up -d --remove-orphans
# Caddy no relee su configuración solo: reiniciarlo si el Caddyfile cambió (dominio, IP o lista de IPs).
if [[ -n "$CADDY_BEFORE" && "$CADDY_BEFORE" != "$CADDY_AFTER" ]]; then
  info "Configuración HTTPS modificada: reiniciando Caddy"
  docker compose restart caddy >/dev/null
fi

info "Esperando que la aplicación esté saludable"
status=""
for _ in $(seq 1 90); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' camerasia 2>/dev/null || true)"
  [[ "$status" == "healthy" ]] && break
  sleep 2
done
if [[ "$status" != "healthy" ]]; then
  docker compose logs --tail 60 camerasia || true
  die "La aplicación no quedó saludable (estado: ${status:-desconocido}). Revise los logs de arriba."
fi
ok "Aplicación en marcha"

SITE_HOST="${DOMAIN:-$PUBLIC_IP}"
code=""
for _ in $(seq 1 30); do
  # Se valida el cuerpo: Caddy responde 200 vacío si el host no coincide con ningún sitio.
  body="$(curl --noproxy '*' -sk --max-time 5 --resolve "$SITE_HOST:443:127.0.0.1" "https://$SITE_HOST/api/ping" || true)"
  if [[ "$body" == *'"ok":true'* ]]; then code="200"; break; fi
  # Con --allow-ip la propia VPS no está en la lista: un 403 de Caddy prueba que HTTPS y el filtro funcionan.
  if (( ${#ALLOW_LIST[@]} )) && [[ "$body" == *"Acceso no permitido"* ]]; then code="200"; break; fi
  code="${body:0:40}"
  sleep 2
done
if [[ "$code" == "200" ]]; then
  ok "HTTPS respondiendo vía Caddy"
elif [[ -n "$DOMAIN" ]]; then
  warn "Caddy aún no responde (código ${code:-n/a}). Verifique que el DNS de $DOMAIN apunte a ${PUBLIC_IP:-esta VPS} y los puertos 80/443 estén abiertos; luego: docker compose logs caddy"
else
  warn "Caddy aún no responde (código ${code:-n/a}). Revise: docker compose logs caddy"
fi

# Respaldo diario automático (03:15) con retención de 14 copias.
if [[ -d /etc/cron.d ]]; then
  printf '# CamerasIA: respaldo diario de la base y capturas\n15 3 * * * root bash %q >> /var/log/camerasia-backup.log 2>&1\n' "$APP_DIR/scripts/backup.sh" > /etc/cron.d/camerasia-backup
  chmod 644 /etc/cron.d/camerasia-backup
  ok "Respaldo diario programado (/etc/cron.d/camerasia-backup → $APP_DIR/backups)"
fi

# La contraseña inicial sólo sirve hasta el primer ingreso: se retira de .env y se guarda aparte.
if [[ -n "$ADMIN_PASS" ]]; then
  set_env ADMIN_INITIAL_PASSWORD ""
  umask 077
  cat > "$ACCESS_FILE" <<EOF
CamerasIA — acceso inicial ($(date '+%F %T'))
URL:        https://$SITE_HOST
Usuario:    admin
Contraseña: $ADMIN_PASS   (temporal: se pide cambiarla y activar 2FA al ingresar)

Borre este archivo después del primer ingreso:  rm $ACCESS_FILE
EOF
fi

# ───────────────────────── Resumen ─────────────────────────
echo
printf '%s════════════════════════════════════════════════════════════════════%s\n' "$c_ok" "$c_off"
printf '%s  CamerasIA listo%s\n' "$c_ok" "$c_off"
printf '%s════════════════════════════════════════════════════════════════════%s\n' "$c_ok" "$c_off"
echo "  URL:         https://$SITE_HOST"
if [[ -n "$ADMIN_PASS" ]]; then
  echo "  Usuario:     admin"
  echo "  Contraseña:  $ADMIN_PASS   (temporal; también en $ACCESS_FILE)"
fi
[[ -z "$DOMAIN" ]] && echo "  Certificado: autofirmado por Caddy → el navegador mostrará un aviso la primera vez."
echo "  FortiVPN:    $([[ $VPN_OK -eq 1 ]] && echo 'habilitado (openfortivpn)' || echo 'NO disponible en esta VPS')"
echo "  Modo demo:   $(get_env DEMO_MODE)"
(( ${#ALLOW_LIST[@]} )) && echo "  Acceso sólo desde: ${ALLOW_LIST[*]}"
echo
echo "  IMPORTANTE: guarde la clave maestra de la bóveda en su gestor de contraseñas:"
echo "     sudo grep VAULT_MASTER_KEY $ENV_FILE"
echo
echo "  Comandos útiles (en $APP_DIR):"
echo "     docker compose logs -f camerasia     # ver logs"
echo "     bash scripts/install-vps.sh          # actualizar tras subir cambios"
echo "     bash scripts/backup.sh               # respaldo de la base y capturas"
echo
