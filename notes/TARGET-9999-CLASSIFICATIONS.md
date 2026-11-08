# TARGET-9999 classifications (live-rounds, 5 Nov 2026, 13:40 UTC)

## 1. Luck by Chance, run 100440940 (partner, 12:15Z), not counted
- Class: ENV (our side). Sign-in refused with 429 "Too many sign-ins from this network today" (test sign-in from the shared address). No site fault.
- Action: HALT-luck cleared; evidence kept as HALT-luck.evidence-100440940; run repeated.
- Rule added (BOSS, 5 Nov): runners must not sign in more than the daily limit from one address. Spread sign-ins or reuse the session. Implementation of the reuse in the driver is pending; until then, Luck runs are paused by hand if the 429 returns.

## 2. Tic Tac Toe, run 100435900 (partner, 12:06Z), not counted
- Class: ENV (our set-up timing), proven from the run file:
  - create-game (200) at 12:06:30; schedule-helper called at 12:06:31 (the start time the runner asked for);
  - publish/join-before-publish POST join -> 409 "The tournament has started and the list is closed" (before publish);
  - settings/save-settings PATCH -> 409 "The game has already started, so it can no longer be changed";
  - no 5xx, and no out-of-order action accepted by the site: every refusal was a correct 409.
- Cause: the runner's default lead was 300 s, and set-up took longer than that, so the scheduled start came before the joins.
- Fix: default lead raised from 300 s to 900 s in run.mjs (partner and phone copies).
- Caveat: the create payload's start field is not in the run file; the proof is the schedule-helper time matching the runner's create time.
- Action: HALT-tictactoe cleared; evidence kept as HALT-tictactoe.evidence-100435900; run repeated on the same commit.

## 4. Luck by Chance, run 100691670 (partner, 19:13Z, live commit ebda764), now ENV
- Class: ENV (our side). Sign-in refused with 429 "Too many sign-ins from this network today" (our daily sign-in budget on the shared address). No site fault.
- Previously filed as a site fail in the ledger; reclassified to ENV by BOSS instruction (6 Nov). regen-ledger.py now counts it under ENV (RECLASS override), raw run file untouched.

## 5. Tambola, run 101106400 (partner, 07:03Z, live commit c9d34f3), counted as SITE FAIL
- Evidence (ledger row, lp.jsonl): 250 joined, ended, 893 requests, exit 0. One server error answer: announce/second-within-5s POST /api/z/:eid/announce -> 503 "[site busy] The doors are very busy just now". The site itself returned the 5xx, so it is a site answer, not a net blip (netBlips 0) and not a sign-in or host-cap refusal.
- Our side: the runner sent its second announce within 5 s by design (the double-announce check). That timing is the only thing on our side, and it does not prove our request caused the 503, so it is filed as a site fail, not ENV.
- Action: HALT-tambola written on the partner with this evidence; Tambola is held until the 503 is reproduced or explained. Other games continue. Clear HALT-tambola only after classification.

### 5b. Cause of the 503 (investigated 6 Nov, c9d34f3 source read from git blob)
- Where the text comes from: `busyReply()` in `apps/edge/src/worker.ts` (c9d34f3, line ~648). It is returned by the retry wrapper in `handle()`, not by the announce handler. The announce handler's own write-budget refusal (`spend()` -> `BUSY()`) says "It is very busy right now", a different text, so it is not the source.
- Route class: `announce` is not in `SAFE_WRITE`, so `retryKind()` gives "once". A transient D1 error on a "once" route is answered at once with the 503 busy, never retried (by design: nothing can be written twice).
- Run evidence (partner run file 101106400): row `second-within-5s` -> 503, 329 ms, message "[site busy] The doors are very busy just now". The first announce was accepted.
- The first DB call in the announce handler is the 5-second guard's `SELECT v FROM kv WHERE k='ann/<eid>'`. A healthy DB answers that with 429 "Please wait a few seconds before sending another message." The 503 means that read itself threw a transient error (D1 overload, timeout or dropped connection, the kinds `transientDb()` matches). The 329 ms latency fits contention.
- Verdict: the guard works as designed (a gentle busy with retry-after, not a bare 500). The status code is correct for a passing DB overload. It is NOT a wrong-status defect, and no release fix is needed for this code path.
- Still a site fail in the ledger: the Worker answered 503 to a guest-facing write because D1 was overloaded at that moment. Count it as a site fail, not ENV.
- Reproduction: NOT reproduced. A D1 overload cannot be forced safely on the shared database, and the 429 path (the healthy answer) was not run. The D1 error log (`error_report`, written by `recordServerError`) would confirm the exact thrown error at ~07:03Z, but I could not find the database id in the repo (`wrangler.toml` holds a placeholder), so that check is not done.
- Action: HALT-tambola cleared on partner and phone after this finding; Tambola runs continue. A repeat 503 on a second announce would be a new evidence row.
