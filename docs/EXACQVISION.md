# Integración con exacqVision

CamerasIA habla con el **exacqVision Web Service** (el mismo componente que sirve el cliente web/móvil de Exacq), no con el puerto 22609 del servidor de grabación.

## Endpoints usados

| Función | Endpoint | Estado |
|---|---|---|
| Login | `POST /v1/login.web` (`u`, `p`, `responseVersion=2`, `s=0`) → `sessionId` | Verificado (uso real en proyectos de la comunidad) |
| Logout | `POST /v1/logout.web?s=` | Verificado |
| Cámaras | `GET /v1/config.web?s=&output=json` → `Cameras[]` | Verificado |
| Búsqueda de grabaciones | `GET /v1/search.web?s=&camera=&start=&end=&output=json` → `videoInfo[].clips[]` | Verificado |
| Exportar clip MP4 | `GET /v1/export.web?s=&camera=&start=&end=&format=mp4&name=` → `export_id`; progreso `?export=ID`; descarga `&action=download`; cierre `&action=finish` | Verificado |
| Imagen en vivo (snapshot) | Plantilla configurable | **Varía según versión** |
| Stream MJPEG | Plantilla configurable (opcional) | **Varía según versión** |

Las fechas se envían en ISO-8601 con la **zona horaria del servidor** (configúrela al agregar el servidor), igual que el cliente oficial.

La sesión se renueva sola: si exacq la invalida (reinicio, expiración), CamerasIA vuelve a loguearse y reintenta.

## Imagen en vivo: detectar la URL correcta

1. En *Administración → Servidores exacqVision* pulse **Detectar video**: CamerasIA prueba varias plantillas conocidas contra una cámara y guarda la que devuelve una imagen (`image/*`) o un stream `multipart/x-mixed-replace`.
2. Si ninguna funciona, obténgala del cliente web oficial:
   - Abra `http://192.168.109.58` en Chrome, ingrese y abra una cámara en vivo.
   - Presione **F12 → Red (Network)**, filtre por `Img` o `.web`.
   - Copie la ruta de la petición que trae la imagen, por ejemplo `/v1/xxxx.web?s=ABC...&camera=12&...`.
   - Reemplace el valor de la sesión por `{session}` y el número de cámara por `{camera}` y péguela en **Plantilla de snapshot** (o de stream si la respuesta es continua).
3. Pulse **Probar**. Si ve las cámaras en *Video en vivo*, listo.

Variables disponibles en las plantillas: `{session}`, `{camera}`, `{quality}`, `{ts}`. Por seguridad sólo se aceptan rutas que empiecen con `/` (el host siempre es el del servidor configurado).

Sin plantilla de stream, el video se arma pidiendo imágenes sucesivas (1-4 cuadros/s según la grilla), lo que funciona con cualquier versión y evita saturar las conexiones del navegador.

## Usuario recomendado en exacqVision

Cree en exacqVision un usuario **sólo para CamerasIA** con permisos de: ver en vivo, buscar y exportar, en las cámaras necesarias. No use el administrador del VMS. Guárdelo en la Bóveda como credencial tipo *exacqVision*.

Si su Web Service tiene usuarios *passthrough*, tenga en cuenta el aviso de seguridad de Tenable para versiones antiguas (TRA-2021-40) y mantenga el Web Service actualizado.

## HTTPS con certificado propio

Si el Web Service usa `https://` con un certificado de su CA interna, monte el certificado de la CA en el contenedor y defina `NODE_EXTRA_CA_CERTS=/certs/ca-interna.pem`. No desactive la verificación TLS.

## Carga sobre el servidor

Cada cámara con **Detección** activa pide una imagen cada 2 segundos al Web Service (compartida con los visores). Con decenas de cámaras, active la detección sólo donde aporte valor o use analíticas propias de las cámaras enviando eventos por la API de ingesta.

## Diagnóstico

- **Probar**: hace login, lista cámaras y muestra latencia o el error exacto ("Credenciales rechazadas", "No se pudo contactar… ¿VPN conectada?").
- **JSON**: el Administrador ve la respuesta original de `config.web`; Tester ve las cámaras y la estructura tipada sin los demás valores de configuración.
- Los errores de conexión aparecen también en el Tablero (Infraestructura) y en *Conectividad → Servidores de video*.

### Diagnóstico desde la VPS con la credencial guardada

Si el puerto TCP responde pero **Probar** vence a los 8 segundos, ejecute el siguiente diagnóstico desde el checkout de CamerasIA. No requiere reconstruir ni reiniciar la aplicación o la VPN:

```bash
cd /opt/camerasia
git pull --ff-only
docker exec -i camerasia node --disable-warning=ExperimentalWarning --input-type=module < scripts/diagnose-exacq.mjs
```

El script usa el contenedor actual y sus módulos compilados. Lee SQLite en modo de solo lectura, descifra en memoria la credencial asignada al servidor habilitado y prueba el login con un plazo de 30 segundos. Si obtiene una sesión, consulta el inventario y después cierra esa sesión de diagnóstico. Selecciona el único servidor habilitado o, si hay varios, el único cuyo nombre contiene `Bistro`; falla si la selección es ambigua.

La salida incluye estado HTTP, tipo de respuesta, etapa, duración y cantidad de cámaras. No muestra contraseñas, clave maestra, sesión, cuerpo de respuesta ni nombres de cámaras. Mantiene la verificación TLS. Un fallo devuelve un código de salida distinto de cero; comparta únicamente la salida JSON para analizar si el problema está en autenticación, respuesta de la API o descubrimiento.
