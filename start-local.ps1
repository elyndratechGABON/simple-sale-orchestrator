$ErrorActionPreference = "SilentlyContinue"
$backend = "C:\Users\Administrator\Desktop\elywrok\jyls\simple-sale-orchestrator\backend"

if (-not (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath "node" -ArgumentList "index.mjs" -WorkingDirectory $backend -WindowStyle Hidden
  "Orchestrateur demarre..."
} else {
  "Orchestrateur deja en cours (port 8787)"
}

if (-not (Get-NetTCPConnection -LocalPort 4040 -State Listen -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath "ngrok" -ArgumentList "http", "8787" -WindowStyle Hidden
  "Ngrok demarre..."
} else {
  "Ngrok deja en cours (port 4040)"
}

$tunnels = $null
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $t = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels" -TimeoutSec 2
    if ($t.tunnels) { $tunnels = $t.tunnels; break }
  } catch {}
}

""
"Dashboard + API local  : http://localhost:8787"
if ($tunnels) {
  $tunnels | ForEach-Object { "URL publique ngrok     : $($_.public_url)" }
} else {
  "Ngrok non pret : attendre quelques secondes puis lire http://127.0.0.1:4040"
}
