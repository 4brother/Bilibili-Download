# ============================================================
# B站视频下载助手 · 一键打包脚本
# 产物（输出到 dist/）：
#   dist/unpacked/                        干净的"加载已解压的扩展程序"目录
#   dist/bilibili-downloader_v{版本}.zip  可上传 Chrome Web Store / Edge
#                                         Add-ons 的商店包（zip 根即 manifest.json）
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
#   或直接双击 build.bat
# ============================================================

$ErrorActionPreference = 'Stop'

# 项目根目录（脚本所在目录）
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# ---------- 打包内容白名单（运行所需文件） ----------
$include = @(
  'manifest.json',
  'background/service-worker.js',
  'background/lib/md5.js',
  'offscreen/offscreen.html',
  'offscreen/offscreen.js',
  'popup/popup.html',
  'popup/popup.css',
  'popup/popup.js',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png'
)

Write-Host '==== [1/5] 校验 manifest.json ====' -ForegroundColor Cyan
$manifestPath = Join-Path $root 'manifest.json'
try {
  $manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  Write-Host "  [失败] manifest.json 不是合法 JSON：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
$version = $manifest.version
if (-not $version -or $version -notmatch '^\d+\.\d+\.\d+$') {
  Write-Host "  [失败] manifest.version 不合法：$version" -ForegroundColor Red
  exit 1
}
Write-Host "  [OK] 版本号 v$version，JSON 合法" -ForegroundColor Green

# manifest 引用的资源必须存在
Write-Host '==== [2/5] 检查 manifest 引用的资源 ====' -ForegroundColor Cyan
$refs = @()
if ($manifest.icons) { $refs += $manifest.icons.PSObject.Properties.Value }
if ($manifest.action.default_icon) { $refs += $manifest.action.default_icon.PSObject.Properties.Value }
if ($manifest.action.default_popup) { $refs += $manifest.action.default_popup }
if ($manifest.background.service_worker) { $refs += $manifest.background.service_worker }
$missing = @()
foreach ($r in $refs) {
  if ($r -and -not (Test-Path (Join-Path $root $r))) { $missing += $r }
}
if ($missing.Count -gt 0) {
  Write-Host "  [失败] manifest 引用但缺失的文件：$($missing -join ', ')" -ForegroundColor Red
  exit 1
}
Write-Host "  [OK] 共 $($refs.Count) 个引用资源全部存在" -ForegroundColor Green

# 白名单文件存在性
foreach ($f in $include) {
  if (-not (Test-Path (Join-Path $root $f))) {
    Write-Host "  [失败] 打包清单中的文件不存在：$f" -ForegroundColor Red
    exit 1
  }
}

# ---------- JS 语法检查（有 node 才执行） ----------
Write-Host '==== [3/5] JS 语法检查 ====' -ForegroundColor Cyan
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $jsFiles = @('background/service-worker.js', 'background/lib/md5.js', 'popup/popup.js', 'offscreen/offscreen.js')
  foreach ($js in $jsFiles) {
    $out = & node --check (Join-Path $root $js) 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Host "  [失败] $js 语法错误：$out" -ForegroundColor Red
      exit 1
    }
  }
  Write-Host "  [OK] $($jsFiles.Count) 个 JS 文件语法通过" -ForegroundColor Green
} else {
  Write-Host '  [跳过] 未检测到 node，跳过语法检查' -ForegroundColor Yellow
}

# ---------- 复制到 dist/unpacked ----------
Write-Host '==== [4/5] 组装 dist/unpacked ====' -ForegroundColor Cyan
$dist = Join-Path $root 'dist'
$unpacked = Join-Path $dist 'unpacked'
if (Test-Path $unpacked) { [System.IO.Directory]::Delete($unpacked, $true) }
New-Item $unpacked -ItemType Directory -Force | Out-Null

foreach ($f in $include) {
  $src = Join-Path $root $f
  $dst = Join-Path $unpacked $f
  $dstDir = Split-Path -Parent $dst
  if (-not (Test-Path $dstDir)) { New-Item $dstDir -ItemType Directory -Force | Out-Null }
  Copy-Item $src $dst -Force
}
Write-Host "  [OK] 已复制 $($include.Count) 个文件" -ForegroundColor Green

# ---------- 压缩 zip ----------
Write-Host '==== [5/5] 生成 zip 商店包 ====' -ForegroundColor Cyan
$zipName = "bilibili-downloader_v$version.zip"
$zipPath = Join-Path $dist $zipName
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

# 用 .NET ZipArchive 手动写入（而非 Compress-Archive）：
# Windows PowerShell 5.1 的 Compress-Archive 以反斜杠存条目路径，
# 不符合 ZIP 规范（要求 '/'），严格的商店上传器/解压工具可能报错。
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$fs = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)
$zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($f in $include) {
    # 条目路径统一正斜杠；zip 根目录即 manifest.json（商店要求）
    $entry = $zip.CreateEntry(($f -replace '\\', '/'), [System.IO.Compression.CompressionLevel]::Optimal)
    $es = $entry.Open()
    try {
      $bytes = [System.IO.File]::ReadAllBytes((Join-Path $unpacked $f))
      $es.Write($bytes, 0, $bytes.Length)
    } finally { $es.Dispose() }
  }
} finally {
  $zip.Dispose()
  $fs.Dispose()
}

$zipSize = '{0:N1} KB' -f ((Get-Item $zipPath).Length / 1KB)
Write-Host "  [OK] $zipName（$zipSize）" -ForegroundColor Green

# ---------- 摘要 ----------
Write-Host ''
Write-Host '================ 打包完成 ================' -ForegroundColor Magenta
Write-Host "  可加载目录 : dist\unpacked\"
Write-Host "    Chrome: chrome://extensions/ -> 开发者模式 -> 加载已解压的扩展程序 -> 选它"
Write-Host "    Edge  : edge://extensions/  -> 开发人员模式 -> 加载解压缩的扩展 -> 选它"
Write-Host "  商店上传包 : dist\$zipName"
Write-Host "    Chrome Web Store / Edge Add-ons 上传时直接选择该 zip（根目录即 manifest.json）"
Write-Host "    发给他人：对方解压后按上面方式加载即可"
Write-Host '===========================================' -ForegroundColor Magenta
