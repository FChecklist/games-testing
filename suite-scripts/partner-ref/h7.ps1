$env:Path="C:\dev\tools\bun;"+$env:Path
Set-Location C:\dev\work\t-tambola96
Remove-Item C:\dev\work\h7-out.log,C:\dev\work\h7-done.txt -ErrorAction SilentlyContinue
git fetch -f C:\dev\work\tr4.bundle release/tambola-2026-11-02 2>&1 | Out-File C:\dev\work\h7-git.log
foreach($c in @("cb1ec15","48009d5","88fa696")){
  git checkout -q -f $c 2>&1 | Out-File -Append C:\dev\work\h7-out.log
  "== $c" | Out-File -Append C:\dev\work\h7-out.log
  & C:\dev\tools\bun\bun.exe test --isolate --timeout 120000 apps/web/test/pages.test.ts apps/web/test/zc-default-182.test.ts *>> C:\dev\work\h7-out.log
  "exit=$LASTEXITCODE" | Out-File -Append C:\dev\work\h7-out.log
}
git checkout -q -f 88fa696
"DONE" | Out-File C:\dev\work\h7-done.txt
Remove-Item C:\dev\partner.lock -Recurse -Force -ErrorAction SilentlyContinue
schtasks /delete /tn BossH7 /f | Out-Null
