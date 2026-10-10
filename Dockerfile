# syntax=docker/dockerfile:1

# ── 1) Compilación (frontend + backend) ─────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

# ── 2) Dependencias de producción del backend ───────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server --include-workspace-root=false

# ── 3) Imagen final ─────────────────────────────────────────────────
FROM node:22-bookworm-slim
# openfortivpn + ppp para el túnel SSL-VPN hacia el FortiGate
RUN apt-get update \
 && apt-get install -y --no-install-recommends openfortivpn ppp iproute2 ca-certificates tini sudo openssl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8443 \
    WEB_DIST_DIR=/app/web/dist \
    VPN_USE_SUDO=true
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/web/dist ./web/dist
# Usuario sin privilegios; sólo puede ejecutar openfortivpn como root (requerido por pppd).
RUN useradd -r -u 10001 -d /app -s /usr/sbin/nologin cia \
 && mkdir -p /data && chown cia:cia /data \
 && echo 'cia ALL=(root) NOPASSWD: /usr/bin/openfortivpn' > /etc/sudoers.d/cia-vpn \
 && chmod 0440 /etc/sudoers.d/cia-vpn
USER cia
VOLUME ["/data"]
EXPOSE 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "const m=process.env.TLS_CERT_FILE?'https':'http';require(m).get({host:'127.0.0.1',port:process.env.PORT,path:'/api/ping',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/dist/index.js"]
