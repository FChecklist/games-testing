"lock exists: " + (Test-Path C:\dev\partner.lock)
"bun procs: " + @(Get-Process bun -ErrorAction SilentlyContinue).Count
"time: " + (Get-Date -Format "HH:mm")
Get-ChildItem C:\dev -File | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-60) } | Sort-Object LastWriteTime -Descending | Select-Object -First 8 Name,Length,LastWriteTime | Format-Table -AutoSize | Out-String
"free MB: " + [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024)
