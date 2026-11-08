# GAMES (release lead) handover, written 3 Nov 2026 ~02:00 IST, by the GAMES session local_b87dc53c (context 76%)

For the fresh GAMES session the BOSS (local_9a1c1486) starts. Chain: Owner -> BOSS -> GAMES (you, RELEASE LEAD). Read `BOSS-DIRECTIVE-2026-11-02.md` in this folder first. Owner deadline for wave 2: **08:00 IST 3 Nov**. Release window: **05:30-07:30 IST, only on the BOSS's GO**, one site at a time; if the queue is not green by 07:00, release only the green games. Report to the BOSS with send-message, max 8 lines, one line per release. No owner-facing tables, no timers, no long reports (plan ceiling 75%, about 2 points left for all sessions).

## 1. What is LIVE now (wave 1, all verified 2 Nov, deployment id / rollback id)
| Site (Pages project = D1 database name) | commit | live deployment | rollback (before wave 1) |
|---|---|---|---|
| Central ledger (itservices-rajat-agarwal) | 96ca4e8 | 1d1f6009-83a0-4a5a-8f8d-ab3c49892ccf | 5f9788da-4992-4334-9b44-79972c9b0ae2 |
| Console (corporate-console) | 156593e | 4a50cc96-eec5-459d-ab25-b280a84a5195 | fdc07fab-9467-46a5-a397-55622a65a8bd |
| Lucky Draw (corporate-luckydraw) | 27bed51 | bd3c7e30-d645-4341-aa73-13a4e06dbb66 | a4769f28-6cf9-423e-8eb4-4a17587f5197 |
| Luck by Chance (corporate-luck-by-chance) | 26bdbe6 | e88e3853-1030-4272-b258-4e25034f76b9 | 3bf0c431-cdfd-4169-96a2-86f3dc031f73 |
| Snakes and Ladders (corporate-snakes-and-ladders) | 93531a2 | db7dffdf-ab35-4d50-ad60-76d88815d495 | f9a2e2e2-b19a-45fc-9f89-0cba03b58605 |
| Tic Tac Toe (corporate-tic-tac-toe) | 7e17251 | b139003c-12d7-40c8-9310-2400e436717b | 338877c2-9148-4fbf-a7b4-5f1fb973559a |
| Bingo (corporate-bingo) | dfe2ee4 | 0d2d445b-e9df-49b9-8b38-19d55964fedf | 0d3fad0c-b7f3-410c-9155-27556751de7b |
| Tambola (corporate-tambola) | 48009d5 + 2 constants | 7a40cbbb-190a-4b53-b4b4-c3f4771ff863 | 82675824-39e2-415d-a3c5-516472d67fb3 |
| Home (corporatetambola-home) | e5a30f0 | 2c9dab88-672b-4ddd-9888-c608c0228731 | 11f72250-3e43-479a-922a-89aa6924e5c2 |
Hosts: housie / bingo / tictactoe / snakes / luck / luckydraw `.corporatetambola.com`, console.corporatetambola.com, home.corporatetambola.com. The rollback id for a NEW release is the current live deployment id: relgame.ps1 prints it ("ROLLBACK (id commit domains)") before it touches anything; write it in RELEASE-LOG-2026-11-02.md.
Full log with test numbers: `RELEASE-LOG-2026-11-02.md` (same folder).

## 2. What wave 2 releases (all pushed to origin, private repos; worktrees in `C:\ct\test-sites\wt-payredesign\<game>`, game repos in `C:\ct\test-sites\<game>`)
| Game | pay-pages head (branch) | consent head (branch `feat/consent-lines-2026-11-02`, one commit on the pay head) |
|---|---|---|
| Tambola (OWNER'S MAIN GAME, first) | 745bd35 (`feat/pay-pages-2026-11-02`) | 5d01d34 |
| Bingo | 03842b8 (`feat/pay-redesign-2026-11-02`, = f5d67d7 + wave-1 dfe2ee4 merged by the BOSS) | 5344976 |
| Lucky Draw | ff46a0c (`feat/pay-pages-2026-11-02`) | 2a6472e |
| Tic Tac Toe | b3ea3b1 (same branch name) | a4510d4 |
| Luck by Chance | 27ad37b | 12955e7 |
| Snakes and Ladders | 41d0c50 | f8bb326 |
Order the BOSS gave: Tambola, Bingo, Lucky Draw first (the owner's Rs 1 tests), then TTT, Luck, Snakes ("second release"). Heads can move (suite runner fixes): always `git ls-remote --heads origin <branch>` and use what the BOSS says is green.
- **Pay pages** (v2, Razorpay first, owner coupon via `payable`) are the main wave-2 payload; the consent commit only replaces the one remaining tick-box (Refer & earn sign-up, partner.js) by the approved agreement line, server unchanged. Pay pages NEVER wait for consent: at release time deploy the **consent head where its full suite is green, otherwise the pay-pages head** (BOSS). Full suites run in the cloud / on the partner laptop by the suite runner; queue folders `handover\2026-11-02\queue\<game>-<sha7>\info.txt` (the consent ones are marked `priority=low`; leave them alone, BOSS said the runner uses idle lanes). Results appear as `result-*.txt` in those folders; ask the BOSS if unclear.
- Known honest limits: Razorpay's real Checkout was never opened in tests (the owner's live Rs 1 / US$ 1 test is still owed, needs RAZORPAY_INTERNATIONAL=1). Until wave 2 the live pay page shows the LIST price, so nobody gets a special price before wave 2 is live.

## 3. Release steps (per game, one at a time; the script does 1-9 and stops at the first problem; copies of the scripts are in `handover\2026-11-02\tools\`)
1. BOSS GO for that game, inside 05:30-07:30 IST.
2. Live gate must end `: 0` -> `python C:\ct\test-sites\tools\live_games_now.py` (the script checks it twice).
3. Rollback id first (script prints it); record it.
4. D1 migrations of the worktree (`C:\ct\games-ops\mig_all.py <worktree> <d1 name>`, retried, must say "0 failed"). D1 name = Pages project name (list above).
5. Build: `bun run pages/build.mjs` through heavy-run (needs node_modules in the worktree: they are junctions to the Bingo trial's; if missing, `bun install --frozen-lockfile` via heavy-run); built `pages/public/version.json` commit must equal HEAD and `dirty:false`.
6. Deploy: `python %TEMP%\ld\depx.py <pages project> <worktree>` (wrangler3, `--commit-dirty=true`). The `%TEMP%\ld\` helper folder (cf.py, depx.py, chk.py, smoke.py, claimhold.py) is machine-local; it needs `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_TOKEN` from the Windows USER environment (the script reads them; never print them).
7. Live checks: version.json = commit, `chk.py <host>` (noindex), `smoke.py <host>`, `/api/owner/panel` vs `/api/owner/no-such-thing` byte-identical 404, banned words absent in `/owner-desk.js` and `/owner-visits.js` (coupon, price as agreed, Save price, api/owner/price).
8. Any failed check = rollback at once (Pages dashboard/API: promote the rollback deployment id), then tell the BOSS.
9. Log one line in `RELEASE-LOG-2026-11-02.md` and one line to the BOSS.
Run it as: `powershell -NoProfile -ExecutionPolicy Bypass -File C:\ct\test-sites\handover\2026-11-02\tools\relgame.ps1 -Proj <pages project> -Wt <clean worktree at the exact commit> -Db <d1 name> [-AllowDirty]`. The worktree must be clean and at the exact commit (use a worktree on that branch/commit; the wt-payredesign ones are clean and on their pay branches, switch with `git switch` to the consent branch when releasing a consent head; do not create extra worktrees if RAM is low: SearchIndexer balloons).
- **Tambola special case:** the live Tambola build carries two UNCOMMITTED deploy-time constants, both `1793554453235`, in `apps/edge/src/approvals.ts` (`PRIZES_FROM_MS`) and `apps/edge/src/empid.ts` (`EMP_CLEAN_FROM_MS`). Every Tambola release build must carry them (never commit them); run relgame with `-AllowDirty` (it permits ONLY those two files to differ; version.json then shows `dirty:true`, expected). `C:\ct\test-sites\wt-tamb-boss` is the worktree used for the wave-1 Tambola deploy (48009d5 + the two constants); check out the wanted Tambola commit there (`git checkout --detach <sha>`, re-apply the two constants if checkout refuses). `wt-tamb-r80` also holds the original constants; do not commit them.
- Home / console / central ledger are NOT part of wave 2 unless the BOSS says so. relgame.ps1 deploys Pages only (depx); it does not deploy the `*-cron` Workers: if `git diff <wave-1 tip>..<head> -- apps/cron` shows a change, ask the BOSS before releasing.

## 4. What you must NOT do
- No deploy without the BOSS's GO, none outside 05:30-07:30 IST, none while the live gate is not `: 0`, never two sites at once. After a failed check roll back first, then report.
- CLAIM_HOLD stays OFF (Tambola `CLAIM_HOLD`); only the BOSS flips it after the 3-phone claim test with the owner's OnePlus.
- Legal text stays exactly as approved v4. Blunt "We do not / We never" wording and the 20h vs 23h deletion line are an owner item (BOSS lists it). Leave the "This name is correct" / "I understand" ticks, guide.js and the old "Please tick the box" strings alone.
- No Vercel deploys; no paid step; no outside e-mail; no deleting repos, branches with unmerged work or live data; no push to main; no secrets in chat, files, memory or git (tokens live in the Windows user environment only). API credit is the BOSS's call.
- Owner rules in force: one public site (home), game sites private/noindex but reachable; ONE legal document and no tick boxes (one small line with links); no address, only "India"; ID-only join, participant data deleted within 24 h; demo Rs 0 up to 10 people, 3/day; FAMILY LIMIT = SELF + 4; caps Tambola/Bingo/Lucky Draw 100,000 and TTT/Snakes/Luck 2,000; payments only via IT SERVICES BY RAJAT AGARWAL / Razorpay; the secret price coupon is never visible to organizers (only owner/boss via the owner dashboard on a specific game ID); soft, favour-the-user wording; never write "company/work e-mail".
- RAM: this laptop is 8 GB with ~1 GB free; heavy jobs only through `C:\ct\test-sites\console\tools\heavy-run.mjs --min-free-mb 700` (real bun: `C:\Users\Dell\AppData\Roaming\npm\node_modules\bun\bin\bun.exe`), one at a time. Full suites are the suite runner's / partner laptop's job (`ssh -i ~/.ssh/id_ed25519_boss -o IdentitiesOnly=yes raaja@192.168.50.2`, lock `C:\dev\partner.lock`).
- Do not wake, unarchive or message other sessions (payment-pages, design-tambola, owner-coupon, Townhall, DPDP, marketing) unless the BOSS says so; they are archived or idle on purpose.
- Do not start new builds; only the six consent heads were built by GAMES on top of the pay-pages heads.

## 5. Open items (not yours to fix now)
Stale cached `/sitemap.xml` on the Snakes and Tambola custom domains (needs a Cloudflare cache purge, owner permission). Two old Tambola test failures that also fail on live cb1ec15. The claim test and the owner's Rs 1 payment tests are BOSS-led. Unreachable old "Please tick the box" strings remain in code (TTT zc/site/ai-link, Snakes z.js:212, Tambola zc/site/z).

## 6. More detail
Memory (auto-loaded): `boss-state-2026-11-01.md`, `boss-session-9a1c1486-2026-11-02.md`, `wave2-consent-lines-state-2026-11-02.md`. Payment-pages notes: `PAYMENT-PAGES-HANDOVER.md` (this folder). Consent audit: `api-jobs\audit-<game>\REPORT.md`.
