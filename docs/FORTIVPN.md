# FortiVPN integrado

CamerasIA puede levantar por sí mismo el túnel **SSL-VPN** hacia el FortiGate para llegar a las IPs internas (p. ej. `192.168.109.58`) sin que cada operador tenga que abrir FortiClient y tipear credenciales.

## Cómo funciona

1. El administrador guarda en la **Bóveda** una credencial tipo *FortiVPN* (usuario + contraseña del portal SSL-VPN). Queda cifrada con AES-256-GCM.
2. Crea un **perfil** en *Conectividad*: gateway, puerto, realm (opcional), si requiere **OTP FortiToken**, rutas/DNS y reconexión automática.
3. Al pulsar **Conectar** (rol Operador o superior), el backend:
   - descifra la credencial en memoria,
   - escribe un archivo de configuración temporal **0600** en un directorio privado (la contraseña **nunca** va en la línea de comandos, donde la vería `ps`),
   - ejecuta `openfortivpn -c <archivo>`,
   - sobrescribe con ceros y borra el archivo apenas openfortivpn lo leyó,
   - interpreta la salida (`Got addresses`, `Interface ppp0 is UP`, `Tunnel is up and running`) y publica el estado en tiempo real.
4. Cuando el túnel está arriba, el servidor alcanza la red interna y CamerasIA re-sincroniza las cámaras de exacqVision.
5. Todo queda auditado (quién conectó, cuándo, con qué perfil). La contraseña y el OTP se enmascaran en la consola.

## Certificado del FortiGate (pinning)

Si el FortiGate usa un certificado autofirmado o de una CA no pública, openfortivpn rechaza la conexión y muestra la huella SHA-256. CamerasIA la detecta y muestra el aviso **"Certificado del FortiGate no confiable"**:

1. Compare la huella con la del certificado en el FortiGate (*System → Certificates* / *VPN → SSL-VPN Settings → Server Certificate*), o desde una PC de confianza:
   ```bash
   echo | openssl s_client -connect vpn.empresa.com:443 2>/dev/null | openssl x509 -outform der | openssl dgst -sha256
   ```
2. Si coincide, un administrador pulsa **Confiar en esta huella** (requiere 2FA). Queda guardada en el perfil (`trusted-cert`).

Nunca confíe en una huella que no verificó: es la protección contra un ataque de intermediario.

## FortiToken / OTP

Marque *Requiere OTP* en el perfil. El operador ingresa el código de 6 dígitos al conectar (se pasa a openfortivpn por el archivo temporal). Con OTP activo la **reconexión automática** queda deshabilitada (no hay un código válido para reintentar).

No soportado por openfortivpn: login SAML/SSO y aprobación *push* de FortiToken (use el código).

## Requisitos del servidor

openfortivpn usa `pppd`, que necesita privilegios de red:

- **Docker** (imagen incluida): `cap_add: [NET_ADMIN]` y `devices: ["/dev/ppp:/dev/ppp"]`, definidos en `docker-compose.vpn.yml` (actívelo con `COMPOSE_FILE=docker-compose.yml:docker-compose.vpn.yml` en `.env`; `scripts/install-vps.sh` lo hace solo si la VPS tiene `/dev/ppp`). El proceso corre como usuario `cia` sin privilegios y sólo puede ejecutar `openfortivpn` vía `sudo` (`VPN_USE_SUDO=true`). Si el host no tiene `/dev/ppp`: `sudo modprobe ppp_generic`.
- **Instalación directa (Linux)**: `apt install openfortivpn ppp` y ejecute el servicio con un usuario que tenga permiso `sudo` sólo para `/usr/bin/openfortivpn`:
  ```
  camerasia ALL=(root) NOPASSWD: /usr/bin/openfortivpn
  ```
- Sin openfortivpn instalado, `VPN_MODE=auto` **simula** el túnel (útil para probar la interfaz).
- Si CamerasIA corre dentro de la LAN, use `VPN_MODE=disabled`.

> Nota: poder ejecutar openfortivpn como root equivale a privilegios de root dentro del contenedor (pppd admite plugins). Por eso el contenedor debe aislarse y no compartir la red del host salvo necesidad. CamerasIA sólo genera configuraciones con claves conocidas y rechaza saltos de línea en usuario/contraseña/OTP (anti-inyección).

## Recomendaciones para el FortiGate

- Usuario SSL-VPN **dedicado** para CamerasIA, en un grupo propio.
- Portal SSL-VPN en modo túnel con *split tunneling* y una **política de firewall** que permita sólo: `ssl.root` → IPs de exacqVision (TCP 80/443) y los equipos que quiera monitorear.
- Habilite FortiToken para ese usuario si su política lo exige (los operadores ingresarán el OTP al conectar).
- Registre los eventos de VPN en FortiAnalyzer/syslog; CamerasIA además los muestra como eventos (`VPN conectada`, `VPN caída`).
