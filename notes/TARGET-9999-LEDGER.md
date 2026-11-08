# TARGET-9999 ledger, per LIVE commit (regenerated 2026-11-08 06:27 UTC, hourly)

Counts are per live commit only; each new release restarts that game's count. Clean = ended, >=95% joined, no unexpected answers outside the normal list. ENV = our side, not counted. Sessions = players joined on clean runs.

| Game | Live commit | Clean runs | Site failures | ENV | Sessions (clean) |
|---|---|---|---|---|---|
| Tambola | c9d34f3 | 100 | 1 | 48 | 10850 |
| Bingo | f17d190 | 67 | 0 | 1 | 7390 |
| Snakes and Ladders | 042b4d6 | 53 | 0 | 7 | 7030 |
| Luck by Chance | ebda764 | 51 | 0 | 1 | 6990 |
| Tic Tac Toe | fa5ab0a | 54 | 0 | 0 | 7130 |
| Lucky Draw | d040396 | 45 | 0 | 23 | 5630 |
| HOME | 25785fe | 80 | 1 | 0 | 80 trials |

Sign-ins today (test-login rows in the run files, per machine):

- phone (clock day): test-login rows 2

Each game and machine signs in fresh once per 20 h window (reuse). A machine at 25 fresh sign-ins a day stops fresh sign-ins.

HOME: a trial counts only when the fetch half passes AND the Edge browser half is clean.

Failures and ENV classifications: TARGET-9999-CLASSIFICATIONS.md.
