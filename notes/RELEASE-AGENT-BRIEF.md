# GAMES wave-2 release agent: brief (written by the boss, 4:30 IST 3 Nov 2026)

You are the GAMES release agent (boss = session local_9a1c1486-97de-4e78-a822-f43151b58616; full owner authority, nobody asks the owner anything).

Read first, in this order:
1. `C:\ct\test-sites\handover\2026-11-02\GAMES-HANDOVER-2026-11-03.md` (live versions + rollback ids, the six pay-pages heads, the six consent heads, release steps, Tambola two-constants case, what NOT to do)
2. `BOSS-DIRECTIVE-2026-11-02.md`, `RELEASE-LOG-2026-11-02.md`, `SUITE-RESULTS.md`, and only the parts of `PAYMENT-PAGES-HANDOVER.md` the handover points to (all in the same folder).
Release scripts are in `handover\2026-11-02\tools\`.

## Goal
Release wave 2 (new payment pages + no-tick consent) to all six games between 05:30 and 07:30 IST on 3 Nov 2026.
GO IS GIVEN for that window; no further message is needed. Check the clock (`date`; the laptop clock is IST) and start releasing at 05:30:00 or later.

## Pre-flight (do before 05:30, read-only, no deploys)
- Confirm live versions/commits of all 8 sites (home, console, six games) match the handover.
- Confirm every rollback id still exists.
- Run `python C:\ct\test-sites\tools\live_games_now.py` (must end ": 0").
- Confirm each head sha in the handover exists in its repo.
- Write down the exact order and commands you will run.

## Release rules (binding)
- One site at a time. Per game deploy the CONSENT head (pay head + one consent commit). All twelve heads are GREEN in SUITE-RESULTS.md; a green full suite on the consent head covers both.
- Record the rollback id BEFORE each deploy.
- Re-run the live gate before each deploy; if it is not 0, wait and retry. Never deploy during a live game.
- After each deploy: `version.json` must equal the commit; noindex still present; smoke checks from the handover (home 200, pay page loads, sign-in page, consent line shows as text with no tick-box, except the Refer & earn tick-box in partner.js where applicable).
- Then log a row in `RELEASE-LOG-2026-11-02.md` (time, game, sha, deployment id, rollback id, checks).
- If any check fails: roll back that site at once to its rollback id, log it, continue with the next game only if the failure is clearly specific to that site; otherwise stop and report.
- After each release update the OnePlus watchman expected-versions file `~/mon-expected.txt`: `adb forward tcp:18022 tcp:8022`, then `ssh -i C:\Users\Dell\.ssh\id_ed25519_boss -p 18022 u0_a307@127.0.0.1`; adb = `C:\Users\Dell\AppData\Local\Microsoft\WinGet\Packages\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\platform-tools\adb.exe`. If you cannot update it, say so in the report.
- If by 07:00 IST not all are green, release only the green games and stop. Do NOT deploy after 07:30 IST.

## Hard limits
- CLAIM_HOLD stays OFF (only the boss flips it).
- No legal-text changes (Legal v4 stays exactly as approved).
- No DNS, domain, account, billing or Vercel changes. No paid steps, no e-mail sending, no real payments (the owner does his own Rs 1 tests).
- Customer-facing wording: short, warm, India only, payments only via IT Services by Rajat Agarwal through Razorpay.
- Never print or store keys/tokens (the Cloudflare token is in `C:\ct\ct\.env.local`; read it with python, never echo it).
- This laptop has under 1 GB free RAM: no heavy jobs; do not run test suites (they are done).
- Stop after 2 failed fix rounds on any one game and report.

## Report
Append a short table (per game: sha, new deployment id, rollback id, checks, result) under `## P1 games-release (3 Nov 2026)` in `C:\ct\test-sites\handover\2026-11-02\COMPLETION-REPORTS.md`, then end with the same table as your final answer, plus anything left for the boss or owner.
