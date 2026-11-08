Get-Date -Format s
'logmtime ' + (Get-Item C:\dev\work\rc-run.log).LastWriteTime.ToString('s')
'--- task'
schtasks /query /tn BossRC1 2>&1 | Out-String
'--- procs'
Get-Process bun,node,powershell,git -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime | Format-Table -AutoSize | Out-String
'lock exists: ' + (Test-Path C:\dev\partner.lock)
'node_modules exists: ' + (Test-Path C:\dev\work\t-rc1\node_modules)
