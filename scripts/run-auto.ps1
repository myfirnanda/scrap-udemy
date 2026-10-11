$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

$env:ZERO_CLICK_EXTENSION = '1'

while ($true) {
  $courseUrl = (Read-Host 'Masukkan URL course Udemy').Trim()
  if (-not $courseUrl) {
    Write-Host 'URL wajib diisi. Proses dihentikan.' -ForegroundColor Red
    exit 1
  }

  try {
    $parsedUrl = [Uri]$courseUrl
    $validUrl = $parsedUrl.IsAbsoluteUri -and
      $parsedUrl.Scheme -eq 'https' -and
      $parsedUrl.Host -eq 'www.udemy.com' -and
      $parsedUrl.AbsolutePath -match '^/course/[^/]+/?(?:learn(?:/.*)?)?$'
  } catch {
    $validUrl = $false
  }

  if ($validUrl) { break }
  Write-Host 'URL tidak valid. Contoh: https://www.udemy.com/course/retrieval-augmented-gen/' -ForegroundColor Yellow
}

$maxPasses = 3
if ($env:AUTO_PASSES) {
  $parsedPasses = 0
  if (-not [int]::TryParse($env:AUTO_PASSES, [ref]$parsedPasses) -or $parsedPasses -lt 1 -or $parsedPasses -gt 10) {
    throw 'AUTO_PASSES harus berupa angka 1 sampai 10.'
  }
  $maxPasses = $parsedPasses
}

$logDir = Join-Path $projectRoot 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

for ($pass = 1; $pass -le $maxPasses; $pass++) {
  $passLog = Join-Path $logDir ("auto-{0}-pass-{1}.log" -f $stamp, $pass)
  Write-Host ("Auto pass {0}/{1}; log: {2}" -f $pass, $maxPasses, $passLog)
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & node.exe --import tsx src/index.ts all "--course-url=$courseUrl" 2>&1 | Tee-Object -FilePath $passLog
    $result = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  if ($result -eq 0) {
    Write-Host 'Scraping selesai tanpa lecture gagal atau tertunda.'
    exit 0
  }
  if ($result -eq 3) {
    Write-Host 'Security challenge terdeteksi. Proses otomatis dihentikan.' -ForegroundColor Red
    exit 3
  }
  if ($result -eq 4) {
    Write-Host 'Konfigurasi zero-click belum lengkap. Isi PLAYWRIGHT_MCP_EXTENSION_TOKEN di .env.' -ForegroundColor Red
    exit 4
  }
  if ($pass -lt $maxPasses) {
    Write-Warning ("Pass {0} belum tuntas (exit code {1}); melanjutkan dari checkpoint." -f $pass, $result)
    Start-Sleep -Seconds (5 * $pass)
  }
}

Write-Host ("Scraping belum tuntas setelah {0} pass. Periksa log terbaru di {1}." -f $maxPasses, $logDir) -ForegroundColor Red
exit 2
