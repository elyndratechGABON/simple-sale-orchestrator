# Compile le lanceur de la console orchestrateur en exe Windows (.NET Framework, présent
# sur toutes les versions de Windows) puis le copie sur le Bureau.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$out = Join-Path $root "Orchestrateur.exe"

& $csc /nologo /target:winexe /out:$out /r:System.Windows.Forms.dll "$root\Launcher.cs"
if ($LASTEXITCODE -ne 0) { throw "Échec de la compilation." }

$desktop = [Environment]::GetFolderPath("Desktop")
Copy-Item $out (Join-Path $desktop "Orchestrateur.exe") -Force

Write-Host "OK : $out"
Write-Host "Copié sur le Bureau."
