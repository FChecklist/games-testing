# Can the $5 Cloudflare plan carry 1000 players in one game? (research part D, 5 Nov 2026; the measured part is the ladder, section 6)

Sources: Cloudflare docs read today (developers.cloudflare.com: workers/platform/limits, workers/platform/pricing, d1/platform/limits, d1/platform/pricing), our own game code (`packages/beacon/src/phone-runtime.ts`, `beat.ts`, `apps/edge/src/worker.ts`), and the account's real usage read through the Cloudflare analytics API (token never printed).
Rupee figures use an assumed Rs 88 to the US dollar (change it if you like: every figure scales).

## 1. What Cloudflare includes and limits (Workers Paid, $5 a month)

| Item | Number |
|---|---|
| Requests | 10 million a month included, then $0.30 per extra million. No per-second limit ("no general limit on requests per second"). |
| CPU time | 30 million CPU-milliseconds a month included, then $0.02 per extra million ms. 30 s default per request (up to 5 min). |
| Memory | 128 MB per request worker |
| Pages Functions (what our six game sites run on) | billed exactly like Workers, same allowance |
| Subrequests per request | 10,000 |
| D1 (the database) rows read | 25 billion a month included, then $0.001 per million |
| D1 rows written | 50 million a month included, then $1.00 per million |
| D1 storage | 5 GB included, then $0.75 per GB-month; one database up to 10 GB |
| D1 speed | each database handles ONE query at a time: about 1,000 queries a second if a query takes 1 ms, about 10 a second if it takes 100 ms. A batch counts as one query. |
| Other D1 limits | 1,000 queries per request, 6 connections per request, 30 s per query |

## 2. What our usage looks like today (1 to 5 Nov, real analytics)

* Pages Functions requests this month: **713,929 in total** (Tambola site 623,306; each of the other five 11 to 19 thousand). That is **7 percent of the 10 million included** after four days of the heaviest testing we have done (about 140 Tambola games of 250 players).
* D1 rows read: 1.93 billion (7.7 percent of 25 billion). Rows written: 3.0 million (6 percent of 50 million).
* The Tambola database reads about 377 rows per query on average (1.88 billion rows over 5 million queries): some query scans a lot. It costs nothing at this size, but it is the first thing that gets slower as data grows (see fixes).
* So today the $5 plan is nowhere near its limit; the question is only what a 1000-player game adds.

## 3. How one phone talks to the game (from the code)

The numbers are worked out on the phone from a shared seed (zero-server design), so the phone does NOT ask for each number. What it does ask for:

* **Claim signal `/cv`**, a few digits, answered from Cloudflare's cache: once every **2 seconds** per phone (games up to 2000 seats; phones spread over slots so they do not all ask in the same moment). = 1,800 requests an hour per player.
* **Seat list `/seats`** (new seats and claims since the last time): every **15 s** up to 250 seats, **25 s** up to 1000 seats, 40 s up to 2500 (6 s while a phone waits for a claim result). = 144 an hour per player at 1000.
* **Presence** (one phone in K tells the server it is listening) and claims: negligible.
* **Join**: one batch of about 9 database rows (seat, person, consent, counters).

## 4. What 1000 players in one game costs (per hour the game is open)

| | 250 players | 1000 players |
|---|---|---|
| Requests per second (average) | about 142 | about 542 |
| Requests per hour | about 0.51 million | about 1.95 million |
| CPU, if a cached `/cv` takes 2 to 5 ms | 1 to 2.5 million ms | 4 to 10 million ms |
| D1 rows written (1000 joins x 9 + claims + presence) | about 3,000 | about 10,000 |
| D1 queries per second (seat lists only, `/cv` is cached) | about 17 | about 40 |
| Cost beyond the included allowance | nothing | requests about $0.59 (Rs 51), CPU about $0.08 to $0.20 (Rs 7 to 17), D1 about nothing |

* A Tambola game lasts about 18 minutes of calling (90 numbers x 12 s) plus lobby: a "1000 players for one hour" figure is a generous upper bound.
* **Monthly picture:** the included 10 million requests are about **5 games of 1000 players of one full hour each**; after that each extra such game-hour costs about **Rs 60 to Rs 70** (requests + CPU). Even **100 such games in a month = about Rs 5,500**. Writes and reads stay inside the included allowance for thousands of games.

## 5. Verdict from research (to be confirmed by the measured ladder)

* **Money: yes, the $5 plan is enough** for 1000 players in one game; the overage is cents to a few rupees per game.
* **Speed limits to watch** (these are what can actually break first, not the bill):
  1. **D1 single-threaded writes**: a burst of 1000 joins in a few seconds is about 1000 small batches; if each takes 5 to 10 ms that is 5 to 10 seconds of queue, so join latency p95/p99 will rise at the start. The ladder measures this.
  2. **The 377-rows-per-query scan** on the Tambola database: at 1000 seats each seat-list query reads more; fix is an index on the participant/claim tables by engagement and by "after" key.
  3. **The per-address join guard (our own rule, not Cloudflare's)**: 200 joins a minute and 1,500 a day per network address for a free game (a paid game gets its pack size a minute and three times the pack a day). A company where 1000 people join from ONE office address with a free or small-pack game would be told "busy". The ladder runs with the guard skipped (runner key), so it does NOT prove this; real-crowd behaviour needs its own proof (plan P3/P5) or a decision on the guard for paid big games.
  4. Daily write budget in the game (2,000,000 writes a day, one join = 9): 1000 joins = 9,000, no issue.

## 6. Cheapest fixes if the ladder shows trouble

1. Slow the `/cv` poll for big games (2 s to 4 s halves requests and CPU; claim news arrives 2 s later).
2. Batch the join writes into fewer statements, and spread joins: a short "doors open" ramp.
3. Add the missing index for the seat-list scan.
4. Only if one database is the bottleneck: a Durable Object per game for the hot state (a bigger change; not needed on today's numbers).

## 7. Measured results (filled in by the ladder)

To be added after the 250 -> 500 -> 750 -> 1000 run: per step join success %, join and claim-signal latency p50/p95/p99, HTTP errors, D1 errors, first breaking point.
