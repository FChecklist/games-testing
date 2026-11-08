#!/bin/bash
# Shared helpers for the SUITE-RUNNER lane scripts (boss session, 2 Nov 2026). Source this file; do not run it.
# No secrets here: ssh uses the existing boss key file, gh uses the keyring.
H=/c/ct/test-sites/handover/2026-11-02
S=$H/suite
KEY=/c/Users/Dell/.ssh/id_ed25519_boss
GHX="/c/Program Files/GitHub CLI/gh.exe"
ADB="/c/Users/Dell/AppData/Local/Microsoft/WinGet/Packages/Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe/platform-tools/adb.exe"
PYH=C:/ct/test-sites/handover/2026-11-02
# (MSYS path conversion stays ON: git.exe and gh.exe need it for /c/... paths)
mkdir -p "$S/results" "$S/state" "$S/logs" "$S/tmp"

# resolve_game <name>  -> GAME DIR GHREPO LIVE REPO PRIVATE
resolve_game() {
  PRIVATE=0
  case "$1" in
    bingo)                GAME=bingo;     DIR=bingo;        GHREPO=corporate-bingo;               LIVE=release/bingo-2026-11-02 ;;
    luckydraw)            GAME=luckydraw; DIR=luckydraw;    GHREPO=corporate-luckydraw;           LIVE=release/luckydraw-2026-11-02; PRIVATE=1 ;;
    tambola)              GAME=tambola;   DIR=tambola;      GHREPO=corporate-tambola;             LIVE=release/tambola-2026-11-02 ;;
    tictactoe|ttt)        GAME=tictactoe; DIR=tictactoe;    GHREPO=corporate-tic-tac-toe;         LIVE=release/tictactoe-2026-11-02 ;;
    luck|luckbychance)    GAME=luck;      DIR=luckbychance; GHREPO=corporate-luck-by-chance;      LIVE=release/luck-2026-11-02 ;;
    snakes|snakesladders) GAME=snakes;    DIR=snakesladders; GHREPO=corporate-snakes-and-ladders; LIVE=release/snakes-2026-11-02 ;;
    *) return 1 ;;
  esac
  REPO=/c/ct/test-sites/$DIR
}

# resolve_sha <branch|sha> -> full sha on stdout (local repo $REPO, falls back to origin/<branch>)
resolve_sha() {
  local r="$1" s
  s=$(git -C "$REPO" rev-parse --verify -q "$r^{commit}") && { echo "$s"; return 0; }
  s=$(git -C "$REPO" rev-parse --verify -q "origin/$r^{commit}") && { echo "$s"; return 0; }
  return 1
}

# make_bundle <sha> <outfile> <tag>   (temporary ref refs/suite/<tag> in the game repo, removed again)
make_bundle() {
  local sha="$1" out="$2" tag="$3" rc
  git -C "$REPO" update-ref "refs/suite/$tag" "$sha" || return 1
  git -C "$REPO" bundle create "$out" "refs/suite/$tag" >/dev/null 2>&1; rc=$?
  git -C "$REPO" update-ref -d "refs/suite/$tag" >/dev/null 2>&1
  return $rc
}

now() { date '+%H:%M:%S'; }
say() { echo "[$(now)] $*"; }

# ---- phone (adb-forwarded ssh into Termux) ----
phone_forward() { "$ADB" forward tcp:18022 tcp:8022 >/dev/null 2>&1; }
PSSH() { ssh -o LogLevel=ERROR -o ConnectTimeout=15 -o BatchMode=yes -o ServerAliveInterval=20 -i "$KEY" -p 18022 u0_a307@127.0.0.1 "$@"; }
PSCP() { scp -q -o LogLevel=ERROR -o ConnectTimeout=15 -o BatchMode=yes -i "$KEY" -P 18022 "$@"; }

# ---- partner laptop (192.168.50.2, cmd.exe default shell; clock = IST - 11.5 h) ----
XSSH() { ssh -o LogLevel=ERROR -o ConnectTimeout=15 -o BatchMode=yes -o ServerAliveInterval=20 -i "$KEY" raaja@192.168.50.2 "$@"; }
XSCP() { scp -q -o LogLevel=ERROR -o ConnectTimeout=15 -o BatchMode=yes -i "$KEY" "$@"; }

# parse a finished log into meta.json
parse_log() { python "$PYH/suite/suitelib.py" parse "$1" "$2"; }
