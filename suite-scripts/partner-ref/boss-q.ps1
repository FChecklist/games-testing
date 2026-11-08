foreach($n in "BossFull","BossHbLoop","BossQueue1"){
  $i=Get-ScheduledTaskInfo -TaskName $n; $t=Get-ScheduledTask -TaskName $n
  "$n last=$($i.LastRunTime) result=$($i.LastTaskResult) next=$($i.NextRunTime)"
  "  trig=" + (($t.Triggers | ForEach-Object { $_.CimClass.CimClassName + ":" + $_.StartBoundary }) -join ";")
  "  act=" + $t.Actions[0].Execute + " " + $t.Actions[0].Arguments
}
Get-ChildItem C:\dev -Filter *.ps1 | Select-Object Name,LastWriteTime | Format-Table -AutoSize | Out-String
