#!/bin/bash
# suite-daemon.sh - the ONE background loop of SUITE-RUNNER (no model turns).
# Every 5 minutes: one scheduler pass (claims new queue heads by mkdir queue/<game>-<sha7>/claimed, starts jobs on free lanes in order
# phone, cloud, partner, rewrites SUITE-RESULTS.md). Lane jobs finish by themselves and trigger an extra pass.
# Stops at 05:30 IST or when all six games have a GREEN final head, waits for running jobs, then runs suite-cleanup.sh.
. /c/ct/test-sites/handover/2026-11-02/suite/lib.sh
LOG=$S/logs/daemon.log
echo "[$(date '+%F %T')] daemon start pid $$" >> "$LOG"
rm -f "$S/state/stop"
while true; do
  python "$PYH/suite/suitelib.py" sched >> "$LOG" 2>&1
  rc=$?
  if [ $rc -eq 10 ]; then echo "[$(date '+%F %T')] all six games GREEN" >> "$LOG"; echo "$(date '+%F %T') ALL SIX GREEN" >> "$S/state/attention.txt"; break; fi
  hm=$(date +%H%M)
  if [ "$hm" -ge 0530 ] && [ "$hm" -lt 1200 ]; then echo "[$(date '+%F %T')] 05:30 reached" >> "$LOG"; break; fi
  [ -f "$S/state/stop" ] && { echo "[$(date '+%F %T')] stop file seen" >> "$LOG"; break; }
  for i in $(seq 1 30); do sleep 10; [ -f "$S/state/stop" ] && break; done
done
# let running jobs finish (max 60 min), keep the scheduler from starting new ones
touch "$S/state/stop"
for i in $(seq 1 360); do
  n=0; for l in phone cloud partner; do f="$S/state/$l.running"; [ -f "$f" ] && [ $(( $(date +%s) - $(stat -c %Y "$f") )) -lt 240 ] && n=$((n+1)); done
  [ $n -eq 0 ] && break
  sleep 10
done
python "$PYH/suite/suitelib.py" report >> "$LOG" 2>&1
bash "$S/suite-cleanup.sh" >> "$LOG" 2>&1
echo "[$(date '+%F %T')] daemon end" >> "$LOG"
echo "$(date '+%F %T') DAEMON ENDED" >> "$S/state/attention.txt"
