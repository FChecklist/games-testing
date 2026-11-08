#!/bin/bash
# run-job.sh <lane> <game> <sha>   (started detached by suitelib.py sched)
# Keeps a heartbeat on state/<lane>.running, runs the lane script, records the outcome, then lets the scheduler start the next job.
. /c/ct/test-sites/handover/2026-11-02/suite/lib.sh
lane=$1; game=$2; sha=$3
st=$S/state/$lane.running
( while [ -f "$st" ]; do touch "$st"; sleep 45; done ) &
HB=$!
bash "$H/lane-$lane.sh" "$game" "$sha" >> "$S/logs/$lane-$game-${sha:0:7}.out" 2>&1
rc=$?
rm -f "$st"; kill $HB 2>/dev/null
python "$PYH/suite/suitelib.py" record "$lane" "$game" "$sha" "$rc"
python "$PYH/suite/suitelib.py" sched >/dev/null 2>&1
exit 0
