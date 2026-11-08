$env:Path="C:\dev\tools\bun;"+$env:Path
Set-Location C:\dev\work\t-tambola96
git checkout -q -f 88fa696
git fetch -f C:\dev\work\tr4.bundle release/tambola-2026-11-02 2>&1 | Out-File C:\dev\work\g6-git.log
git checkout -q -f FETCH_HEAD
git rev-parse --short HEAD | Out-File -Append C:\dev\work\g6-git.log
$t=Get-Date
& C:\dev\tools\bun\bun.exe test --isolate --timeout 120000 packages apps tools/control-worker *> C:\dev\work\g6-full.log
"exit=$LASTEXITCODE secs=$([int]((Get-Date)-$t).TotalSeconds)" | Out-File -Append C:\dev\work\g6-full.log
git checkout -q -f 88fa696
"DONE" | Out-File C:\dev\work\g6-done.txt
