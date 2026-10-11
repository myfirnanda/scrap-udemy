$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$env:ZERO_CLICK_EXTENSION = '1'

function Get-NormalizedCourseUrl {
  param([string]$Value)

  try {
    $parsedUrl = [Uri]$Value
    $coursePath = [regex]::Match($parsedUrl.AbsolutePath, '^/course/([^/]+)/?(?:learn(?:/.*)?)?$')
    if (-not $parsedUrl.IsAbsoluteUri -or $parsedUrl.Scheme -ne 'https' -or
        $parsedUrl.Host -ne 'www.udemy.com' -or -not $coursePath.Success) {
      return $null
    }
    return "https://www.udemy.com/course/$($coursePath.Groups[1].Value)/"
  } catch {
    return $null
  }
}

$courseQueue = [System.Collections.Generic.List[string]]::new()
Write-Host 'Tambahkan URL course satu per satu. Tekan Enter pada input kosong untuk mulai memproses queue.'

while ($true) {
  $value = (Read-Host ("URL course #{0} (kosong = mulai)" -f ($courseQueue.Count + 1))).Trim()
  if (-not $value) {
    if ($courseQueue.Count -eq 0) {
      Write-Host 'Masukkan minimal satu URL course.' -ForegroundColor Yellow
      continue
    }
    break
  }

  $courseUrl = Get-NormalizedCourseUrl -Value $value
  if (-not $courseUrl) {
    Write-Host 'URL tidak valid. Contoh: https://www.udemy.com/course/retrieval-augmented-gen/' -ForegroundColor Yellow
    continue
  }
  if ($courseQueue.Contains($courseUrl)) {
    Write-Host 'URL tersebut sudah ada dalam queue.' -ForegroundColor Yellow
    continue
  }

  [void]$courseQueue.Add($courseUrl)
  Write-Host ("Ditambahkan. Total queue: {0}" -f $courseQueue.Count) -ForegroundColor Green
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
$results = [System.Collections.Generic.List[object]]::new()

for ($courseIndex = 0; $courseIndex -lt $courseQueue.Count; $courseIndex++) {
  $courseUrl = $courseQueue[$courseIndex]
  $courseNumber = $courseIndex + 1
  $courseSlug = ([Uri]$courseUrl).AbsolutePath.Trim('/').Split('/')[1]
  $lastResult = 2
  $completed = $false

  Write-Host ''
  Write-Host ("=== Course {0}/{1}: {2} ===" -f $courseNumber, $courseQueue.Count, $courseUrl) -ForegroundColor Cyan

  for ($pass = 1; $pass -le $maxPasses; $pass++) {
    $passLog = Join-Path $logDir ("queue-{0}-{1}-course-{2:D2}-{3}-pass-{4}.log" -f $stamp, $PID, $courseNumber, $courseSlug, $pass)
    Write-Host ("Pass {0}/{1}; log: {2}" -f $pass, $maxPasses, $passLog)
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      & node.exe --import tsx src/index.ts all "--course-url=$courseUrl" 2>&1 | Tee-Object -FilePath $passLog
      $lastResult = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }

    if ($lastResult -eq 0) {
      $completed = $true
      break
    }
    if ($lastResult -eq 3) {
      Write-Host 'Security challenge terdeteksi. Queue dihentikan agar verifikasi dapat diselesaikan secara manual.' -ForegroundColor Red
      exit 3
    }
    if ($lastResult -eq 4) {
      Write-Host 'PLAYWRIGHT_MCP_EXTENSION_TOKEN belum tersedia di .env. Queue dihentikan.' -ForegroundColor Red
      exit 4
    }
    if ($pass -lt $maxPasses) {
      Write-Warning ("Course {0} belum tuntas; pass berikutnya akan melanjutkan checkpoint." -f $courseNumber)
      Start-Sleep -Seconds (5 * $pass)
    }
  }

  if ($completed) {
    Write-Host ("Course {0}/{1} selesai. Melanjutkan queue berikutnya." -f $courseNumber, $courseQueue.Count) -ForegroundColor Green
    [void]$results.Add([pscustomobject]@{ Number = $courseNumber; Url = $courseUrl; Status = 'Selesai' })
  } else {
    Write-Warning ("Course {0}/{1} belum tuntas setelah {2} pass. Queue tetap dilanjutkan." -f $courseNumber, $courseQueue.Count, $maxPasses)
    [void]$results.Add([pscustomobject]@{ Number = $courseNumber; Url = $courseUrl; Status = "Belum tuntas (code $lastResult)" })
  }
}

Write-Host ''
Write-Host '=== Ringkasan queue ===' -ForegroundColor Cyan
$results | Format-Table Number, Status, Url -AutoSize

$unfinished = @($results | Where-Object Status -ne 'Selesai').Count
if ($unfinished -gt 0) {
  Write-Host ("{0} course belum tuntas. Jalankan kembali dan masukkan URL tersebut untuk melanjutkan checkpoint." -f $unfinished) -ForegroundColor Yellow
  exit 2
}

Write-Host 'Semua course dalam queue selesai.' -ForegroundColor Green
exit 0
