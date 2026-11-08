$ErrorActionPreference = 'Continue'
$env:Path = "C:\dev\tools\bun;C:\Program Files\nodejs;C:\Program Files\Git\cmd;" + $env:Path
$tag = '__TAG__'
$sd = 'C:\dev\suite'
$w = "C:\dev\work\t-suite-$tag"
"started $(Get-Date -Format s)" | Out-File "$sd\$tag.started" -Encoding ascii
try {
  if (Test-Path $w) { cmd /c "rmdir /s /q $w" }
  New-Item -ItemType Directory $w | Out-Null
  Set-Location $w
  git init -q . 2>&1 | Out-Null
  git fetch -q "$sd\$tag.bundle" "refs/suite/$tag" 2>&1 | Out-File "$sd\$tag.git.log" -Encoding ascii
  git checkout -q FETCH_HEAD 2>&1 | Out-File "$sd\$tag.git.log" -Append -Encoding ascii
  ("head " + (git rev-parse --short HEAD)) | Out-File "$sd\$tag.git.log" -Append -Encoding ascii
  $t0 = Get-Date
  cmd /c "bun install > $sd\$tag.install.log 2>&1"
  ("install rc=$LASTEXITCODE " + [int]((Get-Date) - $t0).TotalSeconds + "s") | Out-File "$sd\$tag.git.log" -Append -Encoding ascii
  $dirs = 'packages apps'
  if (Test-Path 'tools\control-worker') { $dirs += ' tools/control-worker' }
  $t1 = Get-Date
  cmd /c "bun test --isolate --timeout 120000 $dirs > $sd\$tag.log 2>&1"
  $rc = $LASTEXITCODE
  ("SUITE_EXIT=$rc SECS=" + [int]((Get-Date) - $t1).TotalSeconds) | Out-File "$sd\$tag.log" -Append -Encoding ascii
} finally {
  Set-Location C:\dev
  if (Test-Path $w) { cmd /c "rmdir /s /q $w" }
  "done" | Out-File "$sd\$tag.done" -Encoding ascii
  cmd /c "rmdir C:\dev\partner.lock 2>nul"
}
