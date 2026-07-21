# Huobao Drama 启动脚本
$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Root 'backend'))) { $Root = $PSScriptRoot }
$env:DB_PATH = Join-Path $Root 'data\huobao_drama.db'
Write-Host "Huobao Drama root: $Root"
Write-Host "DB_PATH: $env:DB_PATH"
Write-Host "启动后端 http://localhost:5679"
Start-Process powershell -ArgumentList "-NoExit","-Command","cd '$Root\backend'; `$env:DB_PATH='$env:DB_PATH'; npm run dev"
Start-Sleep -Seconds 2
Write-Host "启动前端 http://localhost:3013"
Start-Process powershell -ArgumentList "-NoExit","-Command","cd '$Root\frontend'; npm run dev"
Write-Host "浏览器打开: http://localhost:3013"
