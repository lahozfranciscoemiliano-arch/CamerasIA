# Seguridad de CamerasIA

Un centro de monitoreo con credenciales de VPN y acceso a cámaras es un **objetivo de alto valor**. Este documento resume qué protege la plataforma, de qué depende y qué debe hacer usted al desplegarla.

## Qué se protege y cómo

| Riesgo | Control implementado |
|---|---|
| Robo de contraseñas | scrypt (N=2¹⁷, r=8, p=1, sal aleatoria). Política: 12+ caracteres, 3 tipos, no contener el usuario. |
| Contraseña filtrada / phishing | **2FA TOTP obligatorio** (`REQUIRE_2FA=true`); secreto TOTP cifrado; anti-replay (un código no sirve dos veces); códigos de recuperación de un uso, guardados como hash. |
| Fuerza bruta | Bloqueo tras `LOGIN_MAX_ATTEMPTS` (incluye fallos de 2FA), *rate limit* por IP en login/2FA/acciones, tiempos constantes ante usuarios inexistentes. |
| Robo de sesión | Token aleatorio de 256 bits, guardado como SHA-256; cookie `HttpOnly`, `Secure`, `SameSite=Strict` (prefijo `__Host-` con HTTPS); expiración por inactividad y absoluta; revocación al cambiar la contraseña. |
| CSRF | `SameSite=Strict` + cabecera `X-Requested-With` obligatoria + verificación de `Origin` en cada operación de escritura y en el WebSocket. |
| XSS / clickjacking | React (escape automático), Markdown propio sin HTML crudo, CSP `script-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`. |
| Sesión abierta desatendida | Acciones sensibles exigen **re-autenticación 2FA** reciente (`STEP_UP_MINUTES`). |
| Exposición de credenciales | Bóveda AES-256-GCM con AAD por registro; la clave maestra vive fuera de la base; la API nunca devuelve secretos (salvo "revelar", deshabilitado por defecto y auditado). |
| Credenciales VPN en disco / procesos | Archivo temporal 0600 en directorio privado, sobrescrito y borrado al instante; nunca en argumentos; enmascarado en logs. |
| Inyección en la configuración VPN | Sólo claves conocidas; se rechazan saltos de línea en usuario/contraseña/OTP; host validado. |
| SSRF vía plantillas de video | Las plantillas sólo pueden ser rutas (`/…`); el host siempre es el del servidor configurado por un admin. |
| Escalamiento de privilegios | Roles verificados en el servidor en cada endpoint; Tester tiene consultas y diagnósticos, y no se puede quitar el último admin activo. |
| Manipulación de evidencia | Bitácora encadenada con SHA-256 (cada registro incluye el hash del anterior); verificación desde la UI. |
| Integraciones externas | API keys de ingesta con prefijo + hash SHA-256 (se muestran una sola vez), revocables, límite de tamaño y de tasa. |
| Prompt injection por imágenes | Las instrucciones de la IA tratan todo texto en imágenes/eventos como dato; el asistente sólo tiene herramientas de **lectura**. |

## Responsabilidades del despliegue

1. **TLS**: no use HTTP fuera de pruebas. Certificado de su CA interna o del FortiGate.
2. **Clave maestra**: `VAULT_MASTER_KEY` en un gestor de secretos o Docker secret; respáldela por separado de `/data`. Sin ella los secretos no se recuperan; con ella y una copia de `/data`, sí.
3. **Exposición**: idealmente accesible sólo vía FortiClient/ZTNA. Si se publica con una VIP, restrinja IPs de origen y active IPS/geo-bloqueo en el FortiGate.
4. **Mínimo privilegio**: usuario de exacqVision sólo de visualización/exportación; usuario SSL-VPN dedicado con política que sólo llegue a exacq.
5. **Contenedor**: el modo VPN requiere `NET_ADMIN` y `/dev/ppp`, y openfortivpn corre como root dentro del contenedor. Mantenga el contenedor aislado, actualizado y sin montar el socket de Docker.
6. **Actualizaciones**: `npm audit` / reconstruir la imagen periódicamente; mantener exacqVision Web Service y FortiOS al día.
7. **Revisión**: controle *Auditoría* (intentos fallidos, revelado de secretos, cambios de VPN) y verifique la integridad de la cadena.

## Cuenta Tester (ChatGPT)

Un administrador puede crear o asignar el rol **Tester (ChatGPT)** desde **Administración → Usuarios**. Está pensado para revisar cámaras, eventos, conectividad, servidores exacq, configuración, metadatos de la bóveda y auditoría. Puede ejecutar **Probar**, **Detectar video** y consultar el JSON de configuración de los servidores exacq habilitados; estas pruebas usan las credenciales almacenadas en el backend y pueden actualizar el estado y el inventario descubierto.

El JSON diagnóstico para Tester contiene los campos de identificación y estado de cámaras y la estructura tipada de la configuración; los demás valores no se devuelven. El Administrador conserva el JSON original.

Tester no puede modificar usuarios, configuración ni credenciales, revelar secretos, conectar o desconectar la VPN, gestionar eventos ni ejecutar análisis IA. El cambio de contraseña inicial y el alta TOTP siguen el flujo normal; **2FA es obligatorio para Tester incluso si `REQUIRE_2FA=false`**. Al confirmar el alta TOTP se cierran las otras sesiones abiertas antes de verificar ese segundo factor. No hay cuentas precreadas ni acceso especial sin autenticación. Para una revisión temporal, deshabilite la cuenta al terminar.

Las actualizaciones migran el esquema SQLite para admitir este rol conservando los usuarios y sus sesiones, contraseñas y datos de 2FA. La migración se ejecuta automáticamente al iniciar la aplicación; mantenga el respaldo habitual antes de actualizar.

## Privacidad

- Las imágenes se envían a la API de Anthropic sólo ante verificación IA, análisis manual o el asistente. Revise la política de retención de datos de su cuenta de Anthropic y su normativa local de videovigilancia (avisos, finalidad, conservación).
- La IA tiene prohibido identificar personas o inferir rasgos sensibles.
- Capturas de eventos: se borran a los 30 días; eventos: a los 90 días.
