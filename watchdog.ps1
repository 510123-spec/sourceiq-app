$root = "D:\search-engine-app"

$nodeOk = $false
try {
  $r = Invoke-WebRequest -Uri "http://localhost:3001/" -UseBasicParsing -TimeoutSec 5
  if ($r.StatusCode -eq 200) { $nodeOk = $true }
} catch {}

if (-not $nodeOk) {
  Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-Process -Name "cmd" -ErrorAction SilentlyContinue | Where-Object {
    (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -match "node server\.js"
  } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput "$root\logs\node-server.log" `
    -RedirectStandardError "$root\logs\node-error.log"
}

# --- Daily backup of the shared shortlist (data/saved.json) ---
# The watchdog fires every 2 minutes; this block is a no-op except the first
# run of each calendar day. Keeps the 14 most recent daily backups.
$savedFile = "$root\data\saved.json"
$backupDir = "$root\data\backups"
if (Test-Path $savedFile) {
  $today = Get-Date -Format "yyyy-MM-dd"
  $todayBackup = "$backupDir\saved-$today.json"
  if (-not (Test-Path $todayBackup)) {
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    Copy-Item $savedFile $todayBackup -Force
    Get-ChildItem "$backupDir\saved-*.json" | Sort-Object Name -Descending |
      Select-Object -Skip 14 | Remove-Item -Force -ErrorAction SilentlyContinue
  }
}
