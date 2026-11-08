$ErrorActionPreference = 'Continue'
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';C:\dev\tools\bun;C:\Program Files\Git\cmd;C:\Program Files\nodejs'
Set-Location C:\dev\work
$branch = (Get-Content C:\dev\work\rc.branch -Raw).Trim()   # the branch inside rc.bundle, e.g. release/console-2026-11-02b
$log = 'C:\dev\work\rc-run.log'
$lock = 'C:\dev\partner.lock'
'queued ' + (Get-Date -Format s) | Out-File $log -Encoding ascii
# one job at a time on this laptop: the ONLY rule is the lock folder (the same one every other job here uses). It is tried about 40 times a second so a free lock is taken at once;
# a progress line goes to the log every 5 minutes. Gives up after 4 hours.
$got = $false
$deadline = (Get-Date).AddHours(4); $nextNote = Get-Date
while ((Get-Date) -lt $deadline) {
  try { New-Item -ItemType Directory $lock -ErrorAction Stop | Out-Null; $got = $true; break } catch { Start-Sleep -Milliseconds 25 }
  if ((Get-Date) -ge $nextNote) { 'waiting ' + (Get-Date -Format s) + ' (lock held by another job)' | Out-File $log -Append -Encoding ascii; $nextNote = (Get-Date).AddMinutes(5) }
}
if (-not $got) { 'GAVE UP: the partner stayed busy' | Out-File $log -Append -Encoding ascii; schtasks /delete /tn BossRC1 /f | Out-Null; exit 3 }
try {
  'start ' + (Get-Date -Format s) | Out-File $log -Append -Encoding ascii
  if (Test-Path t-rc1) { Remove-Item t-rc1 -Recurse -Force }
  git clone C:\dev\work\rc.bundle t-rc1 *>> $log
  Set-Location t-rc1
  git checkout $branch *>> $log
  git log --oneline -1 *>> $log
  'bun ' + (bun --version) | Out-File $log -Append -Encoding ascii
  bun install *>> $log
  'targeted sign-in tests start ' + (Get-Date -Format s) | Out-File $log -Append -Encoding ascii
  bun test --isolate --timeout 120000 tests/signin-one-page.test.ts tests/oauth.test.ts tests/mail-test-mode.test.ts *>> $log
  "targeted exit $LASTEXITCODE" | Out-File $log -Append -Encoding ascii
  'tests start ' + (Get-Date -Format s) | Out-File $log -Append -Encoding ascii
  bun test --isolate --timeout 120000 tests *>> $log
  "exit $LASTEXITCODE" | Out-File $log -Append -Encoding ascii
  'done ' + (Get-Date -Format s) | Out-File $log -Append -Encoding ascii
} finally {
  Set-Location C:\dev\work
  cmd /c "rmdir $lock 2>nul"
  schtasks /delete /tn BossRC1 /f | Out-Null
}
