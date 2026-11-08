# COMPLETION PLAN: all 5 priorities by 08:00 IST, 3 Nov 2026 (boss, written 22:30 IST 2 Nov)
Owner order (22:25): "all work completed, all 5 priorities, by 08:00 IST 3 Nov. Use API credits and cloud." Boss = local_9a1c1486-97de-4e78-a822-f43151b58616 (full owner authority, nobody asks the owner anything). Read BOSS-DIRECTIVE-2026-11-02.md for the base rules; where this plan differs, THIS plan wins (night ceiling for the weekly plan is raised from 80% to 88%).

## What "complete by 08:00" means (boss decision per priority)
| P | Complete = | Owner-only leftovers (cannot be done by AI) |
|---|---|---|
| 1 Games | Wave 1 live (DONE). Wave 2 (new payment pages + no-tick consent) built, full-suite green on the exact heads, released to all six games by 07:30 (rollback ids first, gate 0, checks), claim test done on 3 real devices (laptop, partner laptop, OnePlus) + simulated 10 and 20 simultaneous claims; CLAIM_HOLD flipped ON only if all pass | the owner's own Rs 1 payments |
| 2 Marketing | Everything buildable is built and tested, ready to send on the owner's word: unsubscribe + suppression Worker (Cloudflare free), honest identity page for lucifertech.com, send tool in DRY-RUN mode, segment export recipe (counts only), templates final | Brevo sign-up, GoDaddy DNS records, putting the key in an environment variable (OWNER-5-MINUTE-CHECKLIST.md) |
| 3 DPDP | Billing e-mail wording follows the Razorpay-only flow, tests green on GitHub Actions, merged and deployed; remaining items listed | lawyer-gated pages (refund, terms clause 7, effective date), a real payment through the new flow |
| 4 Townhall | Boss decisions in TOWNHALL-BOSS-DECISIONS.md implemented, full suite green, real-phone check on the OnePlus (adb screenshots), code backed up (bundle) in two places | section A of OWNER-DECISIONS-2026-11-02.md (Turnstile keys, mail sender, key backup, domain spelling, Grievance Officer, processor terms, IT Services go) |
| 5 Startup coach | State verified live, everything buildable done, owner-only list written | DNS switch / owner items that need his logins |

## Lanes (machines). One heavy job per lane at a time.
| Lane | How | Lock |
|---|---|---|
| THIS laptop | editing, git, scripts; heavy only via C:\ct\test-sites\console\tools\heavy-run.mjs --min-free-mb 500 | heavy.lock |
| PARTNER laptop | ssh -i C:\Users\Dell\.ssh\id_ed25519_boss raaja@192.168.50.2 ; bun at C:\dev\tools\bun\bun.exe; scripts via scp + `schtasks /run` (create task once with /sd 31/12/2030 /st 23:59); plain `git` (NO snip.exe); copy big logs back with scp and Grep them (long ssh output gets truncated); clock = IST minus 11.5 h | `mkdir C:\dev\partner.lock` (remove at the end, wait 5 min if held) |
| ONEPLUS phone (8 cores, 7.4 GB, USB-attached to this laptop) | `adb forward tcp:18022 tcp:8022` (adb = C:\Users\Dell\AppData\Local\Microsoft\WinGet\Packages\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\platform-tools\adb.exe) then `ssh -i C:\Users\Dell\.ssh\id_ed25519_boss -p 18022 u0_a307@127.0.0.1` (Tailscale route times out). Termux home ~; bun/git/node run inside proot ubuntu: `proot-distro login ubuntu --bind /data/data/com.termux/files/home:/mnt/h -- bash /mnt/h/<script>`; ship code with `git bundle` + `scp -P 18022`. Watchman already runs there (mon.sh -> ~/mon.log, ~/mon-alert.txt): do NOT kill it; never `pkill -f` a pattern that matches your own ssh command | `mkdir ~/phone.lock` |
| CLOUD = GitHub Actions (free for public repos; `gh` CLI works, keyring) | throwaway branch `ci/<tag>` containing the code under test + a workflow with `on: push: branches: ['ci/**']` (workflow_dispatch needs the file on the default branch, so do NOT touch main); delete the branch after; Lucky Draw repo is private (limited free minutes, use sparingly) | none |
| API credits | USD 20 total cap, about USD 10 left, hard stop USD 18 on the ledger C:\ct\test-sites\data\runs\api-spend.json; at most USD 1 per run; NO API KEY exists yet (owner must put one in the user environment variable ANTHROPIC_API_KEY himself): until then everything runs on the plan + the three free lanes above. Never write a key anywhere. | |

## Rules for every worker
- Brief, mechanical, low effort. No exploring beyond the job. Stop after 2 failed fix rounds and report.
- No deploy unless your brief says so. No paid step, no domain purchase, no DNS/account change, no sending e-mail, no real payment, no secrets in files/output/git.
- Disjoint files: touch only the repos/folders in your brief. Never commit to a wave-1 release branch or to main of a game repo.
- Final answer = short table (what is done, commit shas, test counts, what is left, what the owner must do). Also append it to C:\ct\test-sites\handover\2026-11-02\COMPLETION-REPORTS.md under your own heading.
- Time box 8 hours maximum; report earlier when finished.

## Boss decisions during the night
- 22:45 IST marketing footer: no street address (same as the owner's rule for the games: India only). Footer reads "IT Services by Rajat Agarwal, India" + the contact e-mail; the identity page text stays as built. The remaining go-live inputs are only: From mailbox + reply inbox, the owner's Brevo sign-up, DNS, key, and the words "go week 1".
- 22:45 MARKETING-BUILD done: commit 3789d1d in handover\2026-11-02\marketing\build, 60 tests green, nothing deployed, RUNBOOK.md steps 1-5,7,9 are the boss steps once the owner finishes his checklist.
