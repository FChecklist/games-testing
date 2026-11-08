# SUITE-RESULTS (wave-2 payment-pages heads, full test suites)

Updated 2026-11-03 02:04:05 IST by SUITE-RUNNER (boss session). Command per game: `bun test --isolate --timeout 120000 packages apps tools/control-worker`. Lanes: phone = OnePlus (proot ubuntu), cloud = GitHub Actions ubuntu-latest, partner = partner laptop.
A head is GREEN when it has no failure that the live release tip does not also have on the same lane. NEW failure = fails on the head, passes (or is absent) on live.

## Game verdicts

Pay head = the payment-pages head. Consent head = the priority=low head that sits on it (one more commit); a green full suite on the consent head covers both.

| game | pay head | pay verdict | consent head | consent verdict | lanes run / notes |
|---|---|---|---|---|---|
| bingo | 03842b8 | GREEN | 5344976 | GREEN | pay api-cloud: clean; consent api-cloud: clean |
| luckydraw | ff46a0c | GREEN | 2a6472e | GREEN | pay phone: same 13 failure(s) as live; pay cloud: same 1 failure(s) as live; consent phone: same 13 failure(s) as live; consent cloud: same 1 failure(s) as live |
| tambola | 745bd35 | GREEN | 5d01d34 | GREEN | pay cloud: only known-flaky failures (1 known-flaky ignored, see flaky.json); consent cloud: clean |
| tictactoe | b3ea3b1 | GREEN | a4510d4 | GREEN | pay api-cloud: clean; consent cloud: clean |
| luck | 27ad37b | GREEN | 12955e7 | GREEN | pay cloud: clean; consent cloud: clean |
| snakes | 41d0c50 | GREEN | f8bb326 | GREEN | pay cloud: clean; consent cloud: clean |

## Head runs (current heads: pay heads and consent heads)

| game | sha | lane | pass | skip | fail | errors | secs | new failures vs live | verdict | note |
|---|---|---|---|---|---|---|---|---|---|---|
| bingo | 03842b8 | api-cloud | 2176 | 0 | 0 | 0 | 423 | 0 | GREEN | clean |
| bingo | 5344976 | api-cloud | 2179 | 0 | 0 | 0 | 401 | 0 | GREEN | clean |
| luckydraw | ff46a0c | phone | 1949 | 0 | 12 | 1 | 1179 | 0 | GREEN | same 13 failure(s) as live |
| luckydraw | ff46a0c | cloud | 1961 | 0 | 0 | 1 | 82 | 0 | GREEN | same 1 failure(s) as live |
| luckydraw | 2a6472e | phone | 1952 | 0 | 12 | 1 | 922 | 0 | GREEN | same 13 failure(s) as live |
| luckydraw | 2a6472e | cloud | 1964 | 0 | 0 | 1 | 139 | 0 | GREEN | same 1 failure(s) as live |
| tambola | 745bd35 | cloud | 3929 | 1 | 1 | 0 | 650 | 0 | GREEN | only known-flaky failures (1 known-flaky ignored, see flaky.json) |
| tambola | 5d01d34 | cloud | 3933 | 1 | 0 | 0 | 674 | 0 | GREEN | clean |
| tictactoe | b3ea3b1 | api-cloud | 2318 | 1 | 0 | 0 | 162 | 0 | GREEN | clean |
| tictactoe | a4510d4 | cloud | 2321 | 1 | 0 | 0 | 107 | 0 | GREEN | clean |
| luck | 27ad37b | cloud | 1773 | 0 | 0 | 0 | 108 | 0 | GREEN | clean |
| luck | 12955e7 | cloud | 1776 | 0 | 0 | 0 | 130 | 0 | GREEN | clean |
| snakes | 41d0c50 | cloud | 1835 | 2 | 0 | 0 | 72 | 0 | GREEN | clean |
| snakes | f8bb326 | cloud | 1839 | 2 | 0 | 0 | 98 | 0 | GREEN | clean |

## Superseded heads (older runs, kept for the record; a newer head replaced them)

| game | sha | lane | pass | skip | fail | errors | secs | new failures vs live | verdict | note |
|---|---|---|---|---|---|---|---|---|---|---|
| bingo | cce95d0 | phone | 2163 | 0 | 3 | 0 | 1396 | 3: console phase 3: brand on the card, See what guest; console: no refunds (credit), games that wait or d; what each role may do > a Co-host reads only the s | RED | 3 new failure(s), 0 also fail on live |
| bingo | f5d67d7 | api-cloud | 2165 | 0 | 1 | 0 | 409 | 1: what each role may do > a Co-host reads only the s | PENDING | api-cloud failures not counted until reproduced on phone / cloud / partner |
| luckydraw | 4cdadec | phone | 1949 | 0 | 12 | 1 | 1100 | 1: plain e-mail words > no example company address (l | RED | 1 new failure(s), 12 also fail on live |
| tambola | a887909 | cloud | 3927 | 1 | 3 | 0 | 710 | 3: 1.8.0 open join form > an open game asks for an op; TA15: the words on screen match > the console note; plain e-mail words > no example company address (l | RED | 3 new failure(s), 0 also fail on live |
| tictactoe | 1ea8202 | cloud | 2315 | 1 | 2 | 0 | 145 | 2: plain e-mail words > no example company address (l; the server does no game work (the phones compute,  | RED | 2 new failure(s), 0 also fail on live |

## Live baselines (release tips, same command)

| game | live sha | lane | pass | skip | fail | errors | secs | failing tests | source |
|---|---|---|---|---|---|---|---|---|---|
| bingo | dfe2ee4 | phone | 2124 | 0 | 0 | 0 | 1295 | - | this runner |
| bingo | dfe2ee4 | cloud | 2124 | 0 | 0 | 0 | 354 | - | this runner |
| bingo | dfe2ee4 | partner | 2124 | 0 | 0 | 0 | 526 | - | imported partner run of today |
| luckydraw | 27bed51 | phone | 1896 | 0 | 12 | 1 | 935 | UNHANDLED error: ENOENT: no such file or directory, open 'big.js'; big lists come in pages, and the daily clean-up runs by itse; free-plan guard and scale > a l | this runner |
| luckydraw | 27bed51 | cloud | 1908 | 0 | 0 | 1 | 137 | UNHANDLED error: ENOENT: no such file or directory, open 'big.js' | this runner |
| tambola | 48009d5 | phone | 3862 | 1 | 4 | 0 | 2222 | an existing game made in the previous console opens in the n; console phase 3: brand on the ticket, See what guests see, p; console: no refunds (credit), games  | this runner |
| tambola | 48009d5 | cloud | 3866 | 1 | 0 | 0 | 641 | - | this runner |
| tambola | 48009d5 | partner | 3864 | 1 | 2 | 0 | 938 | an existing game made in the previous console opens in the n; console: no refunds (credit), games that wait or did not sta | imported partner run of today |
| tictactoe | 7e17251 | phone | 2257 | 1 | 1 | 0 | 917 | console phase 3: brand on the page, See what players see, pa | this runner |
| tictactoe | 7e17251 | cloud | 2258 | 1 | 0 | 0 | 116 | - | this runner |
| tictactoe | 7e17251 | partner | 2258 | 1 | 0 | 0 | 265 | - | imported partner run of today |
| luck | 26bdbe6 | phone | 1711 | 0 | 3 | 0 | 582 | console phase 3: brand on the page, See what players see, pa; console round 2 (cancel, confirming, team, e-mail rule, AI s; the owner desk page > data requests: | this runner |
| luck | 26bdbe6 | cloud | 1714 | 0 | 0 | 0 | 104 | - | this runner |
| luck | 26bdbe6 | partner | 1714 | 0 | 0 | 0 | 219 | - | imported partner run of today |
| snakes | 93531a2 | cloud | 1780 | 2 | 0 | 0 | 94 | - | this runner |
| snakes | 93531a2 | partner | 1780 | 2 | 0 | 0 | 208 | - | imported partner run of today |

## api-cloud lane (Anthropic sandbox, owner API credit; stop line USD 22 tonight, USD 2 max per run)

Ledger total now: USD 11.84. A green api-cloud run counts like any lane; a failure there is reproduced on phone / cloud / partner first.

| tag | head sha | branch | pass | fail | skip | folders | cents booked | verdict |
|---|---|---|---|---|---|---|---|---|
| suite-bingo-f5d67d7 | f5d67d7e8e7247b67e254c1e26bb4563841d9e1e | feat/pay-redesign-2026-11-02 | 2165 | 1 | 0 | 6 | 3.0 | PENDING (reproduce on another lane) |
| suite-bingo-03842b8 | 03842b85bcb00a721cf7cc1c4bc80e7454426dd1 | feat/pay-redesign-2026-11-02 | 2176 | 0 | 0 | 6 | 3.0 | GREEN |
| suite-bingo-5344976 | 534497635400e93a3c648dcf9d6bc37b3665fa41 | feat/consent-lines-2026-11-02 | 2179 | 0 | 0 | 6 | 2.0 | GREEN |
| suite-tictactoe-b3ea3b1 | b3ea3b19078a99bc021557dd0859472155102075 | feat/pay-pages-2026-11-02 | 2318 | 0 | 1 | 6 | 1.0 | GREEN |

## Lanes now

- phone: free
- cloud: free
- api-cloud: free
- partner: free

## Consent-fix heads (3 Nov 2026 06:07 IST, GAMES consent-fix agent; added by hand, the suite daemon had ended)

Same command and lane as the runs above (`lane-cloud.sh`, GitHub Actions ubuntu-latest, `bun test --isolate --timeout 120000 packages apps tools/control-worker`). Live baselines for comparison: tictactoe 7e17251 cloud 0 failures, luck 26bdbe6 cloud 0 failures. GREEN = no failure the live tip does not also have.

| game | sha | lane | pass | skip | fail | errors | secs | new failures vs live | verdict | note |
|---|---|---|---|---|---|---|---|---|---|---|
| tictactoe | d001ccf | cloud | 2324 | 0 (1 todo) | 0 | 0 | 125 | 0 | GREEN | clean; = consent head a4510d4 + build.mjs `consent.js` + built-output guard test (3 new tests) |
| luck | 4b4da90 | cloud | 1779 | 0 | 0 | 0 | 125 | 0 | GREEN | clean; = consent head 12955e7 + build.mjs `consent.js` + built-output guard test (3 new tests) |
