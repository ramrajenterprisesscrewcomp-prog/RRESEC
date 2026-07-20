# Appointment Secretary - Windows VPS setup
# Run this ON THE VPS in PowerShell (as Administrator), from inside the app folder:
#   powershell -ExecutionPolicy Bypass -File .\setup-vps.ps1
#   powershell -ExecutionPolicy Bypass -File .\setup-vps.ps1 -Domain book.yourname.duckdns.org
param([string]$Domain = "")
$ErrorActionPreference = "Stop"
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "App folder: $appDir"

# 1. Node.js must be installed
try { $v = node --version } catch {
  Write-Host "Node.js is not installed. Download the LTS .msi from https://nodejs.org , install, then re-run this script."
  exit 1
}
Write-Host "Node $v found"

# 2. Install app dependencies
Set-Location $appDir
npm install

# 3. Open firewall ports
netsh advfirewall firewall add rule name="Secretary 3010" dir=in action=allow protocol=TCP localport=3010 | Out-Null
netsh advfirewall firewall add rule name="Secretary 80"   dir=in action=allow protocol=TCP localport=80   | Out-Null
netsh advfirewall firewall add rule name="Secretary 443"  dir=in action=allow protocol=TCP localport=443  | Out-Null
Write-Host "Firewall ports opened (80, 443, 3010)"

# 4. Auto-start the app at boot + start it now
$nodeExe = (Get-Command node).Source
schtasks /Create /F /TN "AppointmentSecretary" /TR "\"$nodeExe\" \"$appDir\server.js\"" /SC ONSTART /RU SYSTEM | Out-Null
schtasks /Run /TN "AppointmentSecretary" | Out-Null
Write-Host "App installed as auto-start task and started"

# 5. HTTPS via Caddy when a domain is given
if ($Domain) {
  $caddyDir = "C:\caddy"
  New-Item -ItemType Directory -Force $caddyDir | Out-Null
  if (-not (Test-Path "$caddyDir\caddy.exe")) {
    Write-Host "Downloading Caddy web server..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest "https://caddyserver.com/api/download?os=windows&arch=amd64" -OutFile "$caddyDir\caddy.exe" -UseBasicParsing
  }
  Set-Content "$caddyDir\Caddyfile" "$Domain {`n    reverse_proxy localhost:3010`n}" -Encoding ascii
  schtasks /Create /F /TN "CaddyHTTPS" /TR "\"$caddyDir\caddy.exe\" run --config \"$caddyDir\Caddyfile\"" /SC ONSTART /RU SYSTEM | Out-Null
  schtasks /Run /TN "CaddyHTTPS" | Out-Null
  Write-Host ""
  Write-Host "DONE! Wait ~1 minute for the certificate, then open:  https://$Domain"
} else {
  Write-Host ""
  Write-Host "DONE (without HTTPS domain). Test at:  http://<this-VPS-IP>:3010"
  Write-Host "For the proper mobile-app experience, get a free subdomain at duckdns.org,"
  Write-Host "point it to this VPS IP, then re-run:  .\setup-vps.ps1 -Domain yourname.duckdns.org"
}
