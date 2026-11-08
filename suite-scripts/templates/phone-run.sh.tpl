#!/bin/bash
# runs INSIDE proot ubuntu on the OnePlus; Termux home is bind-mounted at /mnt/h (SUITE-RUNNER, generated)
export PATH=/root/.bun/bin:$PATH
TAG=__TAG__
OUT=/mnt/h/suite
W=/root/suite/$TAG
echo "nameserver 8.8.8.8" > /etc/resolv.conf 2>/dev/null
rm -rf "$W"; mkdir -p "$W"; cd "$W" || { echo 90 > $OUT/$TAG.done; exit 90; }
git init -q . 2>/dev/null
git fetch -q $OUT/$TAG.bundle refs/suite/$TAG 2>>$OUT/$TAG.git.log && git checkout -q FETCH_HEAD 2>>$OUT/$TAG.git.log || { echo 91 > $OUT/$TAG.done; exit 91; }
echo "head $(git rev-parse --short HEAD) bun $(bun --version) tz $(date +%Z) start $(date '+%H:%M:%S')" > $OUT/$TAG.meta
T0=$(date +%s)
# bun install under proot: 48 parallel downloads give DNSResolveFailed, 8 works; retry fills in what is missing
irc=1
for i in 1 2 3 4; do
  bun install --network-concurrency 8 >> $OUT/$TAG.install.log 2>&1 && { irc=0; break; }
  sleep 5
done
echo "install rc=$irc tries=$i $(( $(date +%s) - T0 ))s" >> $OUT/$TAG.meta
dirs="packages apps"; [ -d tools/control-worker ] && dirs="$dirs tools/control-worker"
T1=$(date +%s)
bun test --isolate --timeout 120000 $dirs > $OUT/$TAG.log 2>&1
rc=$?
echo "SUITE_EXIT=$rc SECS=$(( $(date +%s) - T1 ))" >> $OUT/$TAG.log
cd /root; rm -rf "$W"
echo $rc > $OUT/$TAG.done
