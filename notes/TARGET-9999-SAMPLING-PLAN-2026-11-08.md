# 99.99% confidence plan v3: ten claims, statistics and sampling (owner order 8 Nov 2026)

Owner: do NOT run every test. Reach 99.99% by sampling. Use more weekly tokens, partner laptop (Wi-Fi 192.168.29.140) and OnePlus phone (adb cable) for parallel work, finish fast. This supersedes the "cable only" lane rule for the partner; never use the cable address 192.168.50.2 (silent). Heartbeat file is a signal, not proof of dead.

## The ten claims (each gets its own number, own frozen version, own ledger line)
1 End to end (one full player journey, all products)  2 Corporate Tambola  3 Snakes and Ladders  4 Luck by Chance  5 Lucky Draw  6 Tic Tac Toe  7 home.corporatetambola.com end to end  8 console.corporatetambola.com  9 all games and the systems inside games  10 the complete system of games.
(Bingo stays tested as part of 9 and 10.)

## Honest statistics (what sampling can and cannot do)
- Zero-failure rule: n = ln(1-C)/ln(R). R 99.99% with C 99.99% needs 92,099 failure-free independent trials; C 95% needs 29,956; C 99% needs 46,050.
- Sampling saves effort in three real ways, and nothing else does:
 1. Cheap trial unit. A trial is one player-session or one HTTP journey, not a whole 10-minute game. 250 sessions per game means 369 games for 92,099 sessions, not 92,099 games.
 2. Stratified sampling. Split by risk strata (player count 20/100/250, device phone/desktop, browser, first-join vs rejoin, payment-free vs Rs 1 coupon, time of day, host actions). Draw trials in proportion to risk weight plus a floor per stratum, not equal counts everywhere. A stratum with a failure gets re-sampled to 3x.
 3. Bayesian prior from the last two weeks. Beta(1,1) prior plus every failure-free session on versions with the SAME code in the touched modules (diff-checked) counts as evidence. Only inherited when the diff of that module is empty; otherwise counts restart (release rule).
- Nothing lets 99.99%/99.99% be shown with a few hundred trials. Whole-game claims (needing whole games) stay capped at 99.9% (2,995 games) unless the owner accepts lower C. Claims 1, 9, 10 are composites: stated as min of their parts (a chain is as strong as its weakest part), with the cluster caveat (sessions in one game are correlated).
- A failure resets only the stratum plus module that changed, if the diff is module-local and diff-checked; whole-version reset otherwise.

## Layers (cheap first)
L1 per-endpoint state-machine fuzz against the real server (join, call, claim, rejoin, reconnect): millions of cheap trials, finds bugs, not counted as confidence.
L2 real-site player-sessions (counted trials). Phone and partner run 100/250-player sessions in parallel with the existing 7 cloud workers.
L3 whole games, sampled (299 per type for 99%, 2,995 for 99.9%).
L4 home/console journeys by browser robots, 92,099 runs over several days, three time-of-day bands.

## Where each claim stands (ledger 8 Nov 04:24 IST, last two weeks of test data)
Tambola 10,850 sessions, Bingo 6,920, TicTacToe 6,680, Snakes 6,430, Luck 6,290, Lucky Draw 5,630 of 92,099 (6-12%). Home track not at scale. Bingo has one real cloud-suite failure to fix. Counts restart on each release. Lucky Draw private repo cannot run in the cloud.

## Lane assignment (use all machines)
- Cloud (existing workers): L2 for Tambola, Snakes, Luck, TTT, Bingo.
- Partner laptop: L2 Lucky Draw (private repo, needs a local runner) + L4 home/console robots. Lane script must use 192.168.29.140.
- OnePlus phone: L1 mobile-browser strata and L4 mobile viewport runs; the phone is also the real-device stratum.
- Laptop (this, 8 GB): coordination only, RAM first.
No paid cloud API step: ledger 31.65 is above the 29.88 stop line.
