# Huobao Drama 一键启动（Windows）
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:DB_PATH = Join-Path $Root 'data\huobao_drama.db'
if (-not (Test-Path (Split-Path $env:DB_PATH))) { New-Item -ItemType Directory -Force -Path (Split-Path $env:DB_PATH) | Out-Null }
Write-Host "==> Huobao Drama" -ForegroundColor Cyan
Write-Host "项目: $Root"
Write-Host "后端: http://127.0.0.1:5679"
Write-Host "前端: http://127.0.0.1:3013"
Start-Process powershell -ArgumentList "-NoExit","-Command","`$env:DB_PATH='$($env:DB_PATH)'; Set-Location '$Root\backend'; npm run dev"
Start-Sleep -Seconds 2
Start-Process powershell -ArgumentList "-NoExit","-Command","Set-Location '$Root\frontend'; npx nuxi dev --port 3013 --host 127.0.0.1"
Start-Sleep -Seconds 3
Start-Process "http://127.0.0.1:3013"
Write-Host "已启动，请在浏览器查看。" -ForegroundColor Green
