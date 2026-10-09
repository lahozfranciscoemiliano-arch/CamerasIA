# Despliegue rápido en una VPS

Un solo instalador (`scripts/install-vps.sh`) deja todo funcionando en una VPS Ubuntu 22.04+/Debian 12+:

- instala Docker si falta (y crea swap si la VPS tiene poca memoria),
- genera `.env` con la **clave maestra de la bóveda** y una **contraseña inicial** aleatorias,
- pone **Caddy** delante con **HTTPS automático** (Let's Encrypt si tiene dominio; certificado propio si usa la IP),
- habilita el túnel **FortiVPN** si la VPS lo soporta (`/dev/ppp`),
- configura el firewall (`ufw`: sólo SSH, 80 y 443) y un **respaldo diario**,
- compila, levanta y verifica que responda.

Es **idempotente**: volver a ejecutarlo actualiza la aplicación y conserva `.env`, la bóveda y los datos.

---

## Antes de empezar

| Necesita | Detalle |
|---|---|
| VPS | Ubuntu 22.04/24.04 o Debian 12, **KVM** (no OpenVZ/LXC si quiere FortiVPN), 2 vCPU / 2 GB RAM recomendados, 20 GB de disco. |
| Acceso | SSH como `root` o un usuario con `sudo`. |
| Dominio (recomendado) | Un registro DNS **A** `soc.suempresa.com → IP de la VPS`. Sin dominio funciona igual con la IP, pero el navegador mostrará un aviso de certificado. |
| FortiGate | Si el SSL-VPN restringe IPs de origen, agregue la **IP pública de la VPS**. |

> ¿Por qué FortiVPN en la VPS? La VPS está fuera de la empresa: para llegar a `192.168.109.58` es la propia VPS la que levanta el túnel con la credencial guardada en la bóveda. Detalles en [FORTIVPN.md](FORTIVPN.md).

---

## Opción 1 — Desde su PC con un comando (recomendada)

Sube su copia local del proyecto y ejecuta el instalador. No necesita credenciales de GitHub en la VPS.

**Windows (PowerShell)**, dentro de la carpeta del proyecto:

```powershell
.\scripts\deploy.ps1 -Destino root@IP_DE_LA_VPS -Dominio soc.suempresa.com -Email usted@suempresa.com
```

**Linux / macOS / WSL / Git Bash**:

```bash
./scripts/deploy.sh root@IP_DE_LA_VPS --domain soc.suempresa.com --email usted@suempresa.com
```

Sin dominio: omita `--domain/-Dominio` y entrará por `https://IP_DE_LA_VPS`.

Otras opciones: puerto SSH distinto (`-PuertoSsh 2222` / `SSH_PORT=2222 ./scripts/deploy.sh …`), carpeta remota (`-DirRemoto` / `REMOTE_DIR=…`, por defecto `/opt/camerasia`).

> Si PowerShell no deja ejecutar el script: `Set-ExecutionPolicy -Scope Process Bypass` en esa misma ventana.

## Opción 2 — Clonando directamente en la VPS

El repositorio es **privado**: GitHub pedirá usuario y un **token** (no la contraseña). Créelo en GitHub → *Settings → Developer settings → Fine-grained tokens* con acceso de **sólo lectura** a *Contents* de este repositorio.

```bash
ssh root@IP_DE_LA_VPS
apt-get update && apt-get install -y git
git clone https://github.com/lahozfranciscoemiliano-arch/CamerasIA.git /opt/camerasia
cd /opt/camerasia
git checkout claude/nifty-darwin-ca7zta      # mientras el PR no esté fusionado a main
bash scripts/install-vps.sh --domain soc.suempresa.com --email usted@suempresa.com
```

---

## Opciones del instalador

| Opción | Efecto |
|---|---|
| `--domain soc.suempresa.com` | HTTPS con Let's Encrypt (requiere el DNS apuntando a la VPS y puertos 80/443 abiertos). |
| `--email usted@suempresa.com` | Email para avisos de Let's Encrypt. |
| `--allow-ip 200.1.2.3,190.4.5.0/24` | **Sólo** esas IPs/redes (IPv4 públicas) pueden abrir el sitio; las demás reciben 403. Muy recomendado si los operadores trabajan desde IPs fijas. |
| `--allow-any` | Quita la restricción por IP. |
| `--demo` / `--no-demo` | Activa/desactiva el modo demostración (por defecto en VPS: desactivado). |
| `--no-vpn` | No habilitar el túnel FortiVPN (p. ej. si la VPS ya está dentro de la red). |
| `--no-firewall` | No tocar `ufw` (si usa el firewall del proveedor). |
| `--skip-build` | Usar la imagen `camerasia:latest` existente sin recompilar. |

`--domain`, `--email` y `--allow-ip` **se recuerdan** (quedan en `.env` como `CADDY_*`): para actualizar alcanza con `bash scripts/install-vps.sh`. Para volver a la IP sin dominio: `--domain ""`.

Al terminar muestra la URL, el usuario `admin` y la **contraseña temporal** (también queda en `/root/camerasia-acceso.txt`; bórrelo luego del primer ingreso). En el primer ingreso se exige cambiar la contraseña y activar 2FA.

**Guarde la clave maestra de la bóveda** en su gestor de contraseñas:

```bash
sudo grep VAULT_MASTER_KEY /opt/camerasia/.env
```

Sin esa clave las credenciales guardadas (FortiVPN, exacqVision, IA) no se pueden recuperar.

---

## Después de instalar

1. Ingrese a la URL, cambie la contraseña y active 2FA.
2. Siga la *Puesta en marcha* del [README](../README.md#puesta-en-marcha-con-su-infraestructura): bóveda → perfil FortiVPN → conectar → servidor exacqVision (`http://192.168.109.58`) → **Probar** y **Detectar video**.
3. Marque en el perfil VPN **Conectar automáticamente** si no usa OTP, para que el túnel vuelva solo tras un reinicio.

## Operación diaria

Todo desde `/opt/camerasia`:

```bash
docker compose ps                         # estado
docker compose logs -f camerasia          # logs de la aplicación
docker compose logs -f caddy              # logs de HTTPS
docker compose restart camerasia          # reiniciar
bash scripts/install-vps.sh               # actualizar (tras subir cambios con deploy o git pull)
bash scripts/backup.sh                    # respaldo manual (también corre cada día 03:15)
bash scripts/restore.sh backups/camerasia-AAAA-MM-DD_HHMMSS.tgz   # restaurar (guarda antes el estado actual)
```

Los respaldos (`backups/`, sólo root) contienen la base y las capturas, **no** la clave maestra: para restaurar en otra VPS copie también la misma `VAULT_MASTER_KEY` en su `.env`.

## Problemas frecuentes

| Síntoma | Solución |
|---|---|
| "Esta VPS no tiene /dev/ppp" | La virtualización es OpenVZ/LXC: el túnel no puede funcionar. Use una VPS KVM o instale CamerasIA dentro de la red. |
| El certificado de Let's Encrypt no sale | Verifique el DNS (`dig +short soc.suempresa.com` debe dar la IP de la VPS) y que el proveedor no bloquee 80/443. `docker compose logs caddy`. |
| Aviso de certificado en el navegador | Normal sin dominio (certificado propio de Caddy). Use un dominio para evitarlo. |
| La compilación se corta | Falta memoria: el instalador crea swap si hay < 2 GB; en VPS de 512 MB use una más grande. |
| No puedo entrar después de `--allow-ip` | Vuelva a ejecutar el instalador con su IP actual (`curl -4 ifconfig.me`) o con `--allow-any`. Si su conexión es IPv6, conéctese por IPv4 o agregue esa red. |
| El túnel conecta pero exacq no responde | Revise que la política del FortiGate permita `ssl.root → 192.168.109.58:80` y que *Aplicar rutas* esté activo en el perfil. |

## Seguridad en la VPS

- La aplicación sólo escucha en `127.0.0.1`; desde Internet únicamente Caddy (443/80).
- La aplicación sólo confía en `X-Forwarded-For` del proxy local (redes privadas/loopback).
- `.env` queda con permisos `600` (sólo root). Los respaldos no incluyen la clave maestra.
- Recomendado: `--allow-ip` con las IPs de la empresa, acceso SSH sólo con llave, y actualizar la VPS (`apt upgrade`) periódicamente.
