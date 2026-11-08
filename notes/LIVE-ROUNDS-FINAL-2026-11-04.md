# Live rounds, 4 Nov 2026: final table (written ~22:45 IST; updated at 00:30 IST with the revert result)

Written by the LIVE-ROUNDS session. Only COUNTED results from the run files on the partner laptop and the phone (`live\out\<game>\runs\run-*.json`).
A game is **passed** only if players really joined (at least 95% of the crowd asked for) AND the cycle (start, claims, pause/resume, end) completed. Zero-price test games, test sign-in demo1 to demo3 only. No customer data touched.

## 1. Table per game (rounds on the released versions)

| Game | Asked | Played (people joined) | Passed | Rounds / ids | Notes |
|---|---|---|---|---|---|
| **Tambola, 250 players** | 100 | **104** (ids 1-54 partner, 56-105 phone; 25,630 people joined) | **83 with a confirmed end** (61 confirmed by the driver, 22 more by the site's own record: stored end time or at least 3 phone "game over" votes). **21 ran fully but the end is not proven** (ids 20, 32, 36, 40, 41, 42, 46, 47, 48, 50, 51, 70, 72, 75, 77, 76, 82, 86, 87, 90, 91: the organizer's test key had died, see D3, and the game's data was erased afterwards). 93 of 104 had a full crowd (245+ of 250); 11 had partial crowds (217 to 244, and four late games 102-105 with 163 to 218) | partner 54 + phone 50 | Tambola v1.9.0 (a4522c1) was released in the middle (about 18:10 IST): games from id 70 on ran on the new version. |
| **Tambola, first-time organizer journeys** | 100 | **69** (partner 50, phone 19) | 67 cancelled cleanly as designed, 2 left published (ids 28 and 64, cancel did not complete) | partner ids 1-50, phone ids 51-69 | **31 NOT done tonight**: the phone's join guard (D2) blocks new seats from this public address until 05:30 IST. They start by themselves on the phone at 05:30 IST (`after-reset.sh`, jobs-journeys.txt). |
| **Bingo, 100 players** | 10 | 10 | **10** | 181-190 (released 85d3dbe) | Also 10 of 10 on 161-170 (before the release). Earlier rounds 101-146 (28 runs) joined 0: driver mistake, see D1. |
| **Luck by Chance, 100 players** | 10 | 10 | **10** | 401-410 (released 844a4fb) | Also 10 of 10 on 301-310 and 5 of 5 on 1-5. |
| **Lucky Draw, 100 players** | 10 | 10 | **10** | 201-210 (released 380a2c3) | Also 10 of 10 on 101-110 (before the release). |
| **Snakes and Ladders, 100 players** | 10 | 10 | **10** | 301-310 (released deb6f83) | Also 10 of 10 on 201-210. Game 306: 79 throws lost to DNS errors on the partner (network, not the site): that game passed the join and end, its throw step is **not proven**. Rounds 101-110 joined 0 (driver: the site's 10 second turn window), fixed. |
| **Tic Tac Toe, 100 players** | 10 | 10 | **10** | 301-310 (released 056fcea) | Also 10 of 10 on 101-110 (before the release). |

Percent of the owner order: Tambola games 104 played / 100 asked = 104%; confirmed end 83 of 104 = 80%. Organizers 69%. The other five games 100% each.

## 2. Defects and mistakes (with evidence)

| # | Class | What | Evidence | Status |
|---|---|---|---|---|
| D1 | Driver | Bingo joined 0 players: live Bingo is in ID-only mode (an ID that is not on the organizer's list waits for approval, after a few tries it is locked out: `too-many-tries`, `waiting for approval`) and also asks for a location. | 28 Bingo runs with `joined=0`, 810+ unexpected answers; after the driver listed everybody with an employee ID first and sent a location, 161-170 and 181-190 joined 100 of 100. | Fixed in the driver. Product behaviour: not a defect. |
| D2 | Limit reached (by design) | `It is busy right now` on joins from about 15:18 UTC (games 102-105 and the phone's organizer journeys). It is the per-address daily join guard (`JOIN_PER_IP_DAY` 1500, three times the pack for paid games), NOT the write budget (production budget 2,000,000, usage 427,547). | Laptop, partner and phone all use ONE public address (49.36.144.83, checked). worker.ts joinOverLimit. | Guard works. Risk for TARGET-99 below. |
| D3 | Driver (environment) | `Not allowed` on the organizer's own reads (life, summary, prizes, claims, erase) in about 45 of 104 Tambola games: every sign-in of a shared demo account deletes older organizer keys and keeps the latest 6 (release-eng, worker.ts ~1110); with parallel test runs the earlier test organizers lose their key. NOT a regression of a4522c1 (it started on both sides of it). | run files of games 70, 71, 88, 104; release-eng finding. | Driver now signs in again once on `Not allowed`; for future runs spread games over demo1/demo2/demo3. The 21 games in section 1 stay "end not proven". |
| D4 | Driver | Journey runs: `create-host` refused (`up to 5 Hosts`) in all 69 journeys: 3 leaked test hosts plus 2 hosts of someone else filled the 5 slots. | `organizer_key` rows; 3 `SMOKE10M host` rows retired at 22:40 IST through the normal retire call. | Cleared; host steps will be tested by the 05:30 run. |
| D5 | Driver | Over-cap on journey games (50 + 49 `over-cap`, 50 `waiting for approval`): the test game held 12 people and the driver added more. | counts-tambola.json at 12:15 IST. | Fixed (room for 30 more). |
| D6 | Network on my side | `getaddrinfo ENOTFOUND / EAI_AGAIN` blips on the partner and phone (Tambola 115 network errors, Snakes game 306, Luck game 401). | run files. | Not a site problem. |
| D7 | Driver expectation | Late joins after the start get different words per game ("Sign-up has closed", "The draw is done", "list is closed"); the driver expected another status code. 2 per game in every game. | all five games. | Cosmetic in the counts. |
| D8 | Product observation (not blocking) | Tambola: when the per-address guard answers `busy`, the wording is the same as for the write budget; a big office behind one address could meet it after 3 x pack seats. | D2. | For the owner to judge. |
| Probe | Expected | `429 second announcement within 5 s`: one per run, a deliberate probe. | | OK |

## 3. Risks and open items

* **TARGET-99 risk (per-address join guard):** all machines share one public address, so the per-address join guard (1500 a day, three times the pack for paid games) caps what can be tested from here: about 12 games of 250 players a day. A 99% programme needs a second public address (a different network for the partner or phone) or an owner-test exemption on the guard. Plan for it before the programme starts.
* Not proven: the end of 21 Tambola games (section 1); the throw step of Snakes game 306; the host and co-host steps (blocked by D4 until the 05:30 run).
* **Test mode revert:** at 00:30 IST bingo, snakes, tic-tac-toe and luckydraw go back to LIVE and the test sign-in must be refused. Result: see the last section.

## 3a. UPDATE 5 Nov ~06:00 IST: the 31 missing organizer journeys are DONE

After the 05:30 IST guard reset the phone ran the 31 remaining first-time-organizer journeys (ids 70-100): **31 of 31 cancelled cleanly, 0 unexpected answers in any of them, and the host step worked (no "up to 5 Hosts" refusal this time, so D4 is closed)**. Organizer journeys are now **100 of 100 asked: 98 cancelled cleanly (partner and phone, earlier 67 + these 31), 2 left published (ids 28 and 64, from the earlier round)**. The earlier journeys 51-69 on the phone still show the old host refusal and busy answers (the earlier driver version).

## 3b. Other-address options checked (5 Nov, night)

* **Cloud sandboxes have no outbound network.** Probe on the Managed Agents lane (session sesn_01LQBKnBwpjxUn5kDcrT7Hr2, cost USD 0.02, ledger 31.57): `api.ipify.org` empty, `tambola.corporatetambola.com` and `bingo.corporatetambola.com` connection failed (000). The cloud lane can run offline generators only, never live-site journeys. The extra USD 10 was NOT spent.
* **Phone mobile data: not possible.** The OnePlus reports SIM state ABSENT,ABSENT and only a Wi-Fi network is connected, so it has no address of its own. No hotspot device available.
* So the 31 remaining organizer journeys wait for the 05:30 IST reset (phone `after-reset.sh`, starts about 05:35 IST).

## 4. Revert result (00:30 IST)

Done 5 Nov 00:30 IST (19:00 UTC). D1 `mode` table of bingo, snakes-and-ladders, tic-tac-toe and luckydraw set from TEST to LIVE (reason column updated). Check: POST /api/auth/verify with the test e-mail and code on all four answers 400 "That code is not right or has expired" = test sign-in REFUSED. Tambola was not in test mode and is unchanged (its 31 organizer journeys at 05:30 IST on the phone use the Tambola test sign-in, unaffected).
