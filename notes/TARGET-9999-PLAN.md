# TARGET-9999: 99.99% success with 99.99% confidence (plan v2, 5 Nov 2026)

Supersedes the 99% framing in `TARGET-99-REAL-GAME-REAL-WEBSITE-PLAN.md` (history, kept) and `TARGET-99-REMAINING-AND-1000-PLAN.md` (history, kept). The 99% milestone (299 failure-free games per type) stays inside this plan as step 1.

## 1. The rule (zero-failure demonstration)
With n failure-free trials, success rate R is shown with confidence C when (1 - R)^n <= 1 - C, so n >= ln(1 - C) / ln(R). Verified in code today:

| Claim | n (failure-free trials) |
|---|---|
| R 99%, C 95% | 299 |
| R 99.9%, C 95% | 2,995 |
| R 99.99%, C 95% | 29,956 |
| R 99.99%, C 99.99% (**the target**) | **92,099** |

One failure resets the count for that claim on that version: n must be failure-free after the last change.

## 2. Trial unit per claim (the honest part)
Sessions inside one game share the same server, database and network path, so they are **correlated**. Counting sessions as independent trials overstates confidence. So each claim gets its own unit, and both numbers are shown.

**(a) "A player's session completes with no error"** — unit = one player-session. Each request is also a trial for "request succeeds".
- Optimistic (sessions independent): 92,099 sessions.
- Conservative (cluster = one game): a failing game counts as one failure cluster, so the game count is the honest unit for the claim; 92,099 sessions then needs about 92,099 / (average players per game) games, and the true confidence sits between the two numbers. We report the session number with this caveat, and never claim the optimistic one alone.

**(b) "A whole game completes end to end"** — unit = one game, at the whole-game level.
- 99% = 299 games now; 99.9% = 2,995 games later; 99.99% at 99.99% = 92,099 games.
- 92,099 games per type is infeasible: about 9.5 minutes per game, 7 workers = roughly 87 days **per game type**, 6 types.
- So the whole-game claim will be stated at 99.9% (2,995 games per type) as the realistic ceiling, and 99.99%/99.99% is claimed only through (a) and the HOME track.

**Smoke tests** (millions of cheap local checks, mocks, fixtures) find bugs. They do **not** count toward real-site confidence unless run against the real site with the same trial definition.

## 3. Current counts (clean real-site runs, from the ledgers, pulled 08:2x UTC)
Sessions = sum of players joined on clean runs, on the **current** commit of each game. Counts restart on every new commit (release-eng's expiry-only releases).

| Game | Commit counted | Clean games | Clean sessions | Needed for 92,099 sessions (250-player games) |
|---|---|---|---|---|
| Tambola | 433fb04 (halted, join fix pending) | 7 | 1,750 | 369 games; restarts after the join fix |
| Bingo | 5956075 (superseded by 82a0e1b) | 10 | 1,210 | 369 games; restarts |
| Tic Tac Toe | 38db2c8 (superseded by 449d517) | 7 | 840 | 369 games; restarts |
| Snakes and Ladders | ca74d09 (superseded by 59bd0cf) | 6 | 820 | 369 games; restarts |
| Luck by Chance | 545d1ef (superseded by 9ae8c0d) | 8 | 1,090 | 369 games; restarts |
| Lucky Draw | 26f0564 (current) | 1 | 100 | 369 games |

Superseded commits don't count toward the new commit's total. On the new commits the counts start at 0 today.

## 4. Speed, per type (7 workers, about 9.5 min per game)
- 250-player games: 250 sessions per ~9.5 min per worker → 92,099 sessions ≈ 369 games ≈ 53 games per worker ≈ **8.3 hours per type** (sessions are correlated, see 2a).
- 100-player: ~920 games ≈ 21 h per type. 20-player: ~4,605 games ≈ 106 h per type.
- Large games are the efficient way to collect sessions; small games are used only for the size mix.
- Whole-game claim: see 2b; 99% = 299 games ≈ 7 h per type on 7 workers.

## 5. What one failure costs
- Session claim at 99.99%/99.99%: any single failure resets to 0 on that version. Expected reset cost at ~8 h per type: the first failure after ~50 h of runs is likely; plan for at least two resets per type.
- Whole-game claim 99%: one failure resets 299 games (about 7 h per type).
- A real defect fixed in code = new version = all counts restart (the release rule).

## 6. HOME track (track 7)
Each HOME run = one page-journey trial (robots, sitemap, 17 pages, links, console CTA). Seconds per trial, so 92,099 trials are feasible in a few days across 3 workers, spread over several times of day. A run counts only when the browser steps (click tracking, 375 px and desktop rendering, console errors) are included; until then it is "partial" and does not count. Runner: `_scratch\home-t99\home-t99.mjs`.

## 7. Minimum plan
1. Keep the 99% milestone running (299 games per type, counts restart on each release).
2. Collect player-sessions on 250-player games first (fastest sessions per hour), per type, until 92,099 sessions on one frozen version (about 8.3 h of 7-worker time per type).
3. Add the browser steps to HOME, then run 92,099 HOME journey trials on one frozen home version.
4. Keep fault-injection cases (duplicate join, host leaves, wrong code, burst join) running on the same frozen versions; they are classified, not counted.
5. Report per claim: count, failures, lower bound, and the cluster caveat for (a). State honestly that (b) is shown at 99.9% at most, and 99.99%/99.99% is claimed for sessions and HOME journeys.
6. Owner-involved proofs P1–P5 from the 99% plan are unchanged and stay separate.

## 8. Not yet done
- Ledger headings still say 99%; rename to 99.99/99.99 in `t99-summary.mjs` (next step).
- Browser steps for HOME (click tracking, viewports, console errors).
- Cluster-aware calculation: ρ (intra-game correlation) is not measured yet; the design effect will be filled in once the 250-player data exists.

## 9. HOME browser-step rule for environmental console noise (BOSS, 5 Nov 2026)
- Only one console error is classed as environmental: a CSP refusal of an INLINE script (violation blockedURI "inline") whose blocked source mentions `__CF$cv$params` or the `cdn-cgi/challenge-platform` path (Cloudflare bot-detection injection, not our code). It is logged in its own column (`env_csp`) and never fails a run.
- Only when every inline violation on that page is that one; if any other inline refusal exists, the console lines stay and the run fails.
- Every other console error, page error, failed request or horizontal scroll fails the run.
- Cloudflare Web Analytics auto-install is being switched off by home-landing; its beacon error is NOT in this rule and must disappear, not be excused.
- The rule is rechecked once home-landing announces its commit.
