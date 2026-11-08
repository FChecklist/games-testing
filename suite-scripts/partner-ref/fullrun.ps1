$env:Path = "C:\dev\tools\bun;C:\Program Files\nodejs;C:\Program Files\Git\cmd;" + $env:Path
$lock = "C:\dev\partner.lock"; $log = "C:\dev\full.txt"
$games = @(@("luck","eab061f"),@("snakes","f907a4f"),@("tictactoe","4b37bf3"),@("bingo","fc5f01f"))
"waiting " + (Get-Date) | Set-Content $log
foreach ($g in $games) {
  $n = $g[0]; $live = $g[1]
  while ($true) { try { New-Item -ItemType Directory $lock -ErrorAction Stop | Out-Null; break } catch { Start-Sleep -Seconds 300 } }
  try {
    $d = "C:\dev\work\t-full-$n"; if (Test-Path $d) { Remove-Item -Recurse -Force $d }
    "start $n " + (Get-Date) | Add-Content $log
    git clone -q "C:\dev\int-$n.bundle" $d 2>&1 | Add-Content $log
    Set-Location $d
    "head $n " + (git rev-parse --short HEAD) | Add-Content $log
    bun install > "C:\dev\full-$n-install.log" 2>&1
    $dirs = @("packages","apps"); if (Test-Path "tools\control-worker") { $dirs += "tools/control-worker" }
    bun test --isolate --timeout 120000 @dirs > "C:\dev\full-$n-head.log" 2>&1
    "headdone $n " + (Get-Date) | Add-Content $log
    $files = @(); $cur = ""
    foreach ($l in Get-Content "C:\dev\full-$n-head.log") { if ($l -match '^(\S+\.test\.(ts|js|mjs)):\s*$') { $cur = $Matches[1] } elseif ($l -match '^\(fail\)' -and $cur) { if ($files -notcontains $cur) { $files += $cur } } }
    "failfiles $n : " + ($files -join ' ') | Add-Content $log
    if ($files.Count -gt 0) {
      git checkout -q --detach $live 2>&1 | Add-Content $log
      bun test --isolate --timeout 120000 @files > "C:\dev\full-$n-live.log" 2>&1
      "livedone $n " + (Get-Date) | Add-Content $log
    }
  } finally { Set-Location C:\dev; Remove-Item $lock -Force -Recurse -ErrorAction SilentlyContinue }
}
schtasks /delete /tn BossFull /f | Out-Null
"ALLDONE " + (Get-Date) | Add-Content $log
