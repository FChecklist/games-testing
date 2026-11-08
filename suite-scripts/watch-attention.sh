#!/bin/bash
# watch-attention.sh [lines_already_seen]  - exits (printing the new lines) as soon as state/attention.txt has new lines. One shell loop, no model turns.
. /c/ct/test-sites/handover/2026-11-02/suite/lib.sh
f=$S/state/attention.txt; touch "$f"
seen=${1:-$(wc -l < "$f")}
while true; do
  n=$(wc -l < "$f")
  if [ "$n" -gt "$seen" ]; then tail -n +$((seen+1)) "$f"; echo "(attention lines now: $n)"; exit 0; fi
  sleep 20
done
