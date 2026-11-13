$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

Write-Host "=== 剪贴板QuickClipboard 编译并启动 ===" -ForegroundColor Cyan

# 1. 强制结束旧版进程
Write-Host "正在结束旧版进程..." -ForegroundColor Yellow
$processName = "QuickClipboard"
Get-Process -Name $processName -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  结束进程: $($_.Id)"
    $_.Kill()
}
Start-Sleep -Milliseconds 500

# 2. 编译并启动
Write-Host "正在编译并启动..." -ForegroundColor Green
npm run tauri:dev
