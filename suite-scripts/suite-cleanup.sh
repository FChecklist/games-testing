#!/bin/bash
# suite-cleanup.sh - leave all lanes clean: partner task + folder (+ lock only if no job runs), phone folders, throwaway ci/* branches.
. /c/ct/test-sites/handover/2026-11-02/suite/lib.sh
echo "[$(date '+%T')] cleanup start"
# any lane job still running? then do not touch locks
busy=0; for l in phone cloud partner; do f="$S/state/$l.running"; [ -f "$f" ] && [ $(( $(date +%s) - $(stat -c %Y "$f") )) -lt 240 ] && busy=1; done
# cloud: throwaway branches in every game repo
for g in bingo luckydraw tambola tictactoe luck snakes; do
  resolve_game $g
  for b in $(git -C "$REPO" -c credential.helper= -c "credential.helper=!\"/c/Program Files/GitHub CLI/gh.exe\" auth git-credential" ls-remote --heads origin 'refs/heads/ci/*' 2>/dev/null | sed 's#.*refs/heads/##'); do
    git -C "$REPO" -c credential.helper= -c "credential.helper=!\"/c/Program Files/GitHub CLI/gh.exe\" auth git-credential" push -q origin --delete "$b" && echo "deleted $GHREPO $b"
  done
  git -C "$REPO" for-each-ref --format='%(refname)' refs/suite/ | while read r; do git -C "$REPO" update-ref -d "$r"; done
done
# partner
if XSSH 'echo up' >/dev/null 2>&1; then
  XSSH 'schtasks /delete /tn SuiteRun /f' >/dev/null 2>&1 && echo "partner task SuiteRun deleted"
  if [ $busy = 0 ]; then XSSH 'cmd /c "rmdir /s /q C:\dev\suite 2>nul & for /d %d in (C:\dev\work\t-suite-*) do rmdir /s /q %d"' >/dev/null 2>&1; echo "partner suite folders removed"; fi
  XSSH 'cmd /c "if exist C:\dev\partner.lock (echo partner.lock STILL EXISTS: not mine to guess, left alone) else (echo partner.lock free)"' 2>/dev/null
else echo "partner unreachable now: task SuiteRun / C:\\dev\\suite must be removed later"; fi
# phone
phone_forward
if PSSH 'echo up' >/dev/null 2>&1; then
  if [ $busy = 0 ]; then
    PSSH 'rm -rf ~/suite ~/dnstest.sh; proot-distro login ubuntu -- bash -c "rm -rf /root/suite /root/dnst /root/dbg"; ls -d ~/phone.lock 2>&1 | head -1' 2>&1 | tail -2
    echo "phone folders removed"
  fi
else echo "phone unreachable now"; fi
rm -f "$S"/tmp/*.bundle "$S"/tmp/run-* "$S"/tmp/idx-*
echo "[$(date '+%T')] cleanup end"
