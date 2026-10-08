# New customer for the online links: double-click (or right-click > Run with PowerShell).
# It asks for a short English name, creates the customer in the cloud and shows the CONNECT CODE once, on screen only.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$secret = "C:\Users\Naser\AppData\Local\Programs\MalgardanNetTest\portable_data\neon_secret.json"
if (-not (Test-Path $secret)) { Write-Host "Cannot find your own neon_secret.json: $secret" -ForegroundColor Red; Read-Host "Enter to close"; exit 1 }
$env:FB_NEON_SECRET = $secret
Write-Host ""
Write-Host "Short English name for the customer (letters/digits/dash, e.g. chehresazan):" -ForegroundColor Cyan
$slug = (Read-Host "name").Trim().ToLower()
$title = (Read-Host "Full name (any language)").Trim()
py provision_tenant.py --slug $slug --name $title
Write-Host ""
Write-Host "Copy the CONNECT CODE line above NOW (select it, Enter copies in PowerShell) - it is shown only once." -ForegroundColor Yellow
Write-Host "Paste it in THEIR app: Settings > Connections > Cloud > connect code. Never send it in a group chat." -ForegroundColor Yellow
Read-Host "Enter to close"
