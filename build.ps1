$ErrorActionPreference = "Stop"
Write-Host "Installing dependencies..." -ForegroundColor Cyan
npm install
Write-Host "Building Windows installer..." -ForegroundColor Cyan
npm run dist:win
Write-Host "Done. Check the release folder." -ForegroundColor Green
