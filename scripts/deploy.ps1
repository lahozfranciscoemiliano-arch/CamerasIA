<#
.SYNOPSIS
  Sube CamerasIA desde Windows 10/11 a la VPS y la instala o actualiza.

.DESCRIPTION
  Empaqueta el proyecto, lo copia por SCP y ejecuta scripts/install-vps.sh en la VPS.
  Requiere el "Cliente OpenSSH" de Windows (ssh/scp) y tar, incluidos en Windows 10 1803+.
  El .env y los datos que ya existan en la VPS se conservan.

.EXAMPLE
  .\scripts\deploy.ps1 -Destino root@203.0.113.10 -Dominio soc.empresa.com -Email yo@empresa.com

.EXAMPLE
  .\scripts\deploy.ps1 -Destino admin@203.0.113.10 -PuertoSsh 2222 -PermitirIP "200.1.2.3,190.4.5.0/24"
#>
param(
  [Parameter(Mandatory = $true)][string]$Destino,
  [string]$Dominio,
  [string]$Email,
  [string]$PermitirIP,
  [switch]$Demo,
  [switch]$SinVpn,
  [switch]$SinFirewall,
  [int]$PuertoSsh = 22,
  [string]$DirRemoto = "/opt/camerasia"
)
$ErrorActionPreference = "Stop"

foreach ($cmd in @("ssh", "scp", "tar")) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "Falta '$cmd'. Instale 'Cliente OpenSSH' en Configuración > Aplicaciones > Características opcionales."
  }
}

# Comillas simples para bash (escapa ' como '\'')
function Quote([string]$v) { return "'" + ($v -replace "'", "'\''") + "'" }

$repo = Split-Path -Parent $PSScriptRoot
$archivo = Join-Path $env:TEMP "camerasia-deploy.tgz"
if (Test-Path $archivo) { Remove-Item -Force $archivo }

Push-Location $repo
try {
  Write-Host "» Empaquetando el proyecto"
  $usarGit = $false
  if (Get-Command git -ErrorAction SilentlyContinue) {
    git rev-parse --verify HEAD 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $usarGit = $true }
  }
  if ($usarGit) {
    if (git status --porcelain) {
      Write-Warning "Hay cambios sin commit: se sube la última versión confirmada (HEAD). Haga commit para incluirlos."
    }
    # git archive respeta .gitattributes (finales de línea LF para Linux)
    git archive --format=tar.gz -o $archivo HEAD
    if ($LASTEXITCODE -ne 0) { throw "git archive falló" }
  } else {
    tar -czf $archivo --exclude=node_modules --exclude=.git --exclude=dist --exclude=data `
      --exclude=.env --exclude=backups --exclude="certs/*.pem" --exclude=deploy/Caddyfile .
    if ($LASTEXITCODE -ne 0) { throw "tar falló" }
  }
} finally {
  Pop-Location
}
Write-Host ("  {0:N1} MB a subir" -f ((Get-Item $archivo).Length / 1MB))

$installArgs = @()
if ($Dominio) { $installArgs += "--domain", (Quote $Dominio) }
if ($Email) { $installArgs += "--email", (Quote $Email) }
if ($PermitirIP) { $installArgs += "--allow-ip", (Quote $PermitirIP) }
if ($Demo) { $installArgs += "--demo" }
if ($SinVpn) { $installArgs += "--no-vpn" }
if ($SinFirewall) { $installArgs += "--no-firewall" }

$sudo = if ($Destino -like "root@*") { "" } else { "sudo " }
$dir = Quote $DirRemoto
$stripCr = 's/\r$//'

Write-Host "» Subiendo a ${Destino}:$DirRemoto"
scp -P $PuertoSsh -q $archivo "${Destino}:/tmp/camerasia-deploy.tgz"
if ($LASTEXITCODE -ne 0) { throw "La copia por SCP falló" }
Remove-Item -Force $archivo

Write-Host "» Instalando en la VPS (puede pedir la contraseña de sudo)"
$remoto = "${sudo}mkdir -p $dir && ${sudo}tar -xzf /tmp/camerasia-deploy.tgz --no-same-owner -C $dir && rm -f /tmp/camerasia-deploy.tgz" +
  " && ${sudo}sed -i '$stripCr' $dir/scripts/*.sh $dir/Dockerfile $dir/.env.example" +
  " && ${sudo}bash $dir/scripts/install-vps.sh " + ($installArgs -join " ")
ssh -t -p $PuertoSsh $Destino $remoto
if ($LASTEXITCODE -ne 0) { throw "La instalación remota terminó con error ($LASTEXITCODE)" }
