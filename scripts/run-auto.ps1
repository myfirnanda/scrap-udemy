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

$logDir = Join-Path $projectRoot 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$queueStateFile = Join-Path $logDir 'queue-state.json'
$problemReportFile = Join-Path $logDir 'problem-courses.json'

function Save-JsonAtomic {
  param([string]$Path, [object]$Value)
  $temp = "$Path.$PID.tmp"
  $Value | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $temp -Encoding UTF8
  if (Test-Path -LiteralPath $Path) {
    $backup = "$Path.bak"
    [IO.File]::Replace($temp, $Path, $backup)
    [IO.File]::Delete($backup)
  } else {
    Move-Item -LiteralPath $temp -Destination $Path
  }
}

function Save-QueueState {
  param([object]$State)
  $State.updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  Save-JsonAtomic -Path $queueStateFile -Value $State
}

function Save-ProblemReport {
  param([object]$State)
  $problems = @($State.courses | Where-Object { $_.Status -in @('blocked', 'incomplete', 'configuration-error') } | Select-Object Number, Url, Status, Reason, LastLog, UpdatedAt)
  Save-JsonAtomic -Path $problemReportFile -Value ([pscustomobject]@{
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    courses = $problems
  })
}

$queueState = $null
if (Test-Path -LiteralPath $queueStateFile) {
  try { $queueState = Get-Content -Raw -LiteralPath $queueStateFile | ConvertFrom-Json }
  catch { Write-Warning 'Queue state lama tidak dapat dibaca; queue baru akan dibuat.' }
}

$savedCourses = @(if ($queueState) { $queueState.courses })
foreach ($course in $savedCourses) {
  if (-not $course.PSObject.Properties['Source']) {
    if ([int]$queueState.version -ge 2) { throw "Queue v2 tidak memiliki sumber input untuk $($course.Url); eksekusi dihentikan." }
    Add-Member -InputObject $course -NotePropertyName Source -NotePropertyValue 'legacy-queue'
  }
  if ($course.Source -notin @('terminal-input', 'terminal-input-legacy', 'legacy-queue', 'recovered-from-run-history')) {
    throw "Sumber input queue tidak dikenali untuk $($course.Url): $($course.Source)"
  }
  if (-not $course.PSObject.Properties['AddedAt']) { Add-Member -InputObject $course -NotePropertyName AddedAt -NotePropertyValue $queueState.createdAt }
}
if ($queueState -and [int]$queueState.version -lt 2) { $queueState.version = 2 }
$unfinishedSaved = @($savedCourses | Where-Object Status -ne 'completed')
if ($unfinishedSaved.Count -gt 0) {
  foreach ($course in $unfinishedSaved) {
    $course.Status = 'pending'
    $course.UpdatedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  $courseQueue = @($queueState.courses)
  Write-Host ("Melanjutkan queue tersimpan: {0} course belum selesai dari total {1}." -f $unfinishedSaved.Count, $courseQueue.Count) -ForegroundColor Cyan
  Save-QueueState -State $queueState
} else {
  $urls = [System.Collections.Generic.List[string]]::new()
  Write-Host 'Tambahkan URL course satu per satu. Tekan Enter pada input kosong untuk mulai memproses queue.'
  while ($true) {
    $value = (Read-Host ("URL course #{0} (kosong = mulai)" -f ($urls.Count + 1))).Trim()
    if (-not $value) {
      if ($urls.Count -eq 0) {
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
    if ($urls.Contains($courseUrl)) {
      Write-Host 'URL tersebut sudah ada dalam queue.' -ForegroundColor Yellow
      continue
    }
    [void]$urls.Add($courseUrl)
    Write-Host ("Ditambahkan. Total queue: {0}" -f $urls.Count) -ForegroundColor Green
  }
  $now = (Get-Date).ToUniversalTime().ToString('o')
  $courses = for ($index = 0; $index -lt $urls.Count; $index++) {
    [pscustomobject]@{
      Number = $index + 1
      Url = $urls[$index]
      Source = 'terminal-input'
      AddedAt = $now
      Status = 'pending'
      Reason = $null
      LastExitCode = $null
      LastLog = $null
      UpdatedAt = $now
    }
  }
  $queueState = [pscustomobject]@{ version = 2; createdAt = $now; updatedAt = $now; courses = @($courses) }
  $courseQueue = @($queueState.courses)
  Save-QueueState -State $queueState
}

$maxPasses = 3
if ($env:AUTO_PASSES) {
  $parsedPasses = 0
  if (-not [int]::TryParse($env:AUTO_PASSES, [ref]$parsedPasses) -or $parsedPasses -lt 1 -or $parsedPasses -gt 10) {
    throw 'AUTO_PASSES harus berupa angka 1 sampai 10.'
  }
  $maxPasses = $parsedPasses
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$results = [System.Collections.Generic.List[object]]::new()

for ($courseIndex = 0; $courseIndex -lt $courseQueue.Count; $courseIndex++) {
  $courseEntry = $courseQueue[$courseIndex]
  if ($courseEntry.Status -eq 'completed') { continue }
  $courseUrl = $courseEntry.Url
  $courseNumber = $courseEntry.Number
  $courseSlug = ([Uri]$courseUrl).AbsolutePath.Trim('/').Split('/')[1]
  $lastResult = 2
  $completed = $false
  $blocked = $false

  $courseEntry.Status = 'running'
  $courseEntry.UpdatedAt = (Get-Date).ToUniversalTime().ToString('o')
  Save-QueueState -State $queueState

  Write-Host ''
  Write-Host ("=== Course {0}/{1}: {2} ===" -f $courseNumber, $courseQueue.Count, $courseUrl) -ForegroundColor Cyan

  for ($pass = 1; $pass -le $maxPasses; $pass++) {
    $passLog = Join-Path $logDir ("queue-{0}-{1}-course-{2:D2}-{3}-pass-{4}.log" -f $stamp, $PID, $courseNumber, $courseSlug, $pass)
    Write-Host ("Pass {0}/{1}; log: {2}" -f $pass, $maxPasses, $passLog)
    $previousErrorActionPreference = $ErrorActionPreference
    $previousRunLogFile = $env:RUN_LOG_FILE
    $ErrorActionPreference = 'Continue'
    New-Item -ItemType File -Path $passLog -Force | Out-Null
    $env:RUN_LOG_FILE = $passLog
    try {
      & node.exe --import tsx src/index.ts all "--course-url=$courseUrl"
      $lastResult = $LASTEXITCODE
    } finally {
      if ($null -eq $previousRunLogFile) { Remove-Item Env:RUN_LOG_FILE -ErrorAction SilentlyContinue }
      else { $env:RUN_LOG_FILE = $previousRunLogFile }
      $ErrorActionPreference = $previousErrorActionPreference
    }
    $courseEntry.LastExitCode = $lastResult
    $courseEntry.LastLog = $passLog
    $lastDiagnostic = [string](Get-Content -LiteralPath $passLog -Tail 40 | Where-Object { $_ -match 'failed:|Error:|SECURITY_CHALLENGE_DETECTED|belum siap|tidak ditemukan|tidak tersedia' } | Select-Object -Last 1)
    $courseEntry.UpdatedAt = (Get-Date).ToUniversalTime().ToString('o')
    Save-QueueState -State $queueState

    if ($lastResult -eq 0) {
      $completed = $true
      break
    }
    if ($lastResult -eq 3) {
      $blocked = $true
      $courseEntry.Reason = [string](Get-Content -LiteralPath $passLog -Tail 30 | Where-Object { $_ -match 'SECURITY_CHALLENGE_DETECTED' } | Select-Object -Last 1)
      if (-not $courseEntry.Reason) { $courseEntry.Reason = 'Security challenge terkonfirmasi.' }
      Write-Warning ("Course {0} diblokir dan dilewati. Queue dilanjutkan; detail: {1}" -f $courseNumber, $passLog)
      break
    }
    if ($lastResult -eq 4) {
      $courseEntry.Status = 'configuration-error'
      $courseEntry.Reason = 'PLAYWRIGHT_MCP_EXTENSION_TOKEN belum tersedia.'
      Save-QueueState -State $queueState
      Save-ProblemReport -State $queueState
      Write-Host 'PLAYWRIGHT_MCP_EXTENSION_TOKEN belum tersedia di .env. Queue dihentikan.' -ForegroundColor Red
      exit 4
    }
    if ($pass -lt $maxPasses) {
      Write-Warning ("Course {0} belum tuntas; pass berikutnya akan melanjutkan checkpoint." -f $courseNumber)
      Start-Sleep -Seconds (5 * $pass)
    }
  }

  if ($completed) {
    $courseEntry.Status = 'completed'
    $courseEntry.Reason = $null
    $courseEntry.UpdatedAt = (Get-Date).ToUniversalTime().ToString('o')
    Write-Host ("Course {0}/{1} selesai. Melanjutkan queue berikutnya." -f $courseNumber, $courseQueue.Count) -ForegroundColor Green
    [void]$results.Add([pscustomobject]@{ Number = $courseNumber; Url = $courseUrl; Status = 'Selesai' })
  } elseif ($blocked) {
    $courseEntry.Status = 'blocked'
    $courseEntry.UpdatedAt = (Get-Date).ToUniversalTime().ToString('o')
    [void]$results.Add([pscustomobject]@{ Number = $courseNumber; Url = $courseUrl; Status = 'Diblokir; dilewati' })
  } else {
    $courseEntry.Status = 'incomplete'
    $courseEntry.Reason = if ($lastDiagnostic) { $lastDiagnostic } else { "Belum tuntas setelah $maxPasses pass (exit code $lastResult)." }
    $courseEntry.UpdatedAt = (Get-Date).ToUniversalTime().ToString('o')
    Write-Warning ("Course {0}/{1} belum tuntas setelah {2} pass. Queue tetap dilanjutkan." -f $courseNumber, $courseQueue.Count, $maxPasses)
    [void]$results.Add([pscustomobject]@{ Number = $courseNumber; Url = $courseUrl; Status = "Belum tuntas (code $lastResult)" })
  }
  Save-QueueState -State $queueState
  Save-ProblemReport -State $queueState
}

Write-Host ''
Write-Host '=== Ringkasan queue ===' -ForegroundColor Cyan
$results | Format-Table Number, Status, Url -AutoSize

$unfinished = @($queueState.courses | Where-Object Status -ne 'completed').Count
if ($unfinished -gt 0) {
  Write-Host ("{0} course belum tuntas. Queue tersimpan dan akan dilanjutkan otomatis saat npm start berikutnya." -f $unfinished) -ForegroundColor Yellow
  Write-Host ("Laporan masalah: {0}" -f $problemReportFile) -ForegroundColor Yellow
  exit 2
}

Write-Host 'Semua course dalam queue selesai.' -ForegroundColor Green
exit 0
