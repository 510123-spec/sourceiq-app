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
