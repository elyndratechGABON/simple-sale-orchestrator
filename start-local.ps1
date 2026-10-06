$ErrorActionPreference = "SilentlyContinue"
$backend = "C:\Users\Administrator\Desktop\elywrok\jyls\simple-sale-orchestrator\backend"

# Le port n'est plus ecrit en dur : Windows reserve des plages (8697-8796 avec
# Hyper-V/WSL d'actif) et `listen()` y echoue en EACCES — un acces refuse,
# pas un port occupe. 8787 etait pile dedans, d'ou le crash au demarrage alors
# que rien n'ecoutait. On lit donc la meme valeur que le backend.
$envFile = Join-Path $backend ".env"
$port = 8787
if (Test-Path $envFile) {
  $line = Get-Content $envFile | Where-Object { $_ -match "^PORT=" } | Select-Object -First 1
  if ($line) { $port = [int]($line -replace "^PORT=", "") }
}

if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath "node" -ArgumentList "index.mjs" -WorkingDirectory $backend -WindowStyle Hidden
  "Orchestrateur demarre sur le port $port..."
} else {
  "Orchestrateur deja en cours (port $port)"
}

if (-not (Get-NetTCPConnection -LocalPort 4040 -State Listen -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath "ngrok" -ArgumentList "http", "$port" -WindowStyle Hidden
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
"Dashboard + API local  : http://localhost:$port"
if ($tunnels) {
  $tunnels | ForEach-Object { "URL publique ngrok     : $($_.public_url)" }
} else {
  "Ngrok non pret : attendre quelques secondes puis lire http://127.0.0.1:4040"
}
