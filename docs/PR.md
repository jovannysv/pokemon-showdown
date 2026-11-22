# Tournaments: Add Swiss tournaments

Closes #2205 (the Swiss half; the Best-of-3 half already shipped as the `Best Of` rule).

> **Before opening upstream:** CONTRIBUTING.md asks that feature additions be discussed in the Development room first (https://psim.us/development). That conversation has not happened yet. `docs/DESIGN.md` and this file are course artifacts and would be dropped from an upstream PR.

## Problem

Room tours only offer Elimination (half the field plays once) and Round Robin (*n − 1* rounds, so it only works for small tours). VGC players asked in #2205 for **Swiss rounds** so they could practise the structure used at Premier Challenges and Regionals: everyone plays every round, nobody is eliminated, and players with the same record meet.

## What changed

```
/tour create gen9vgc2025regi, swiss            rounds chosen automatically (⌈log₂ players⌉)
/tour create gen9vgc2025regi, swiss, 32, 5     cap 32, exactly 5 rounds ("5-Round Swiss")
/tour settype swiss, 0, 4                      switch type before the start
/tour rules Best Of = 3                        existing rule, works unchanged
```

- **New generator: `server/tournaments/generator-swiss.ts`.** It implements the same methods as `Elimination` and `RoundRobin`, so `Tournament` drives it without changes.
  - **Rounds are paired one at a time,** only after every match in the current round has finished.
  - **Pairing:** players are sorted by score, then Buchholz (the sum of opponents' scores), then a random seed. Each player is paired with the highest-ranked player they haven't met, backtracking if needed.
  - **Step budget:** the backtracking search stops after 10,000 steps because it runs on the main process. Past that, a greedy pass that prefers new opponents but allows rematches is used.
  - **Byes:** with an odd number of players, the lowest-ranked player who hasn't had a bye gets one, worth 1 point.
  - **Draws** are worth ½ point each.
  - **Disqualification:** the opponent is awarded the current match, and the disqualified player is never paired again and is ranked last.
  - **Results** are groups of players with identical (score, Buchholz).
- **Bracket display reuses the existing formats**, so the client needs no change.
  - Sign-ups use `tree` with no root, i.e. the player list Elimination already shows.
  - After the start it uses `table`: a crosstable in standings order with one cell per match. The "In progress" battle links come from `Tournament.getBracketData` unchanged.
- **`server/tournaments/index.ts`** (4 added, 2 edited lines): register `swiss`, extend the `Generator` union, add a `/tour` list icon (`fa-list-ol`), and add one `/tour help` line listing the types.
- **`server/chat-plugins/smogtours.ts`** (1 line): the same icon in the duplicated `renderLink`.
- **`server/chat-commands/info.ts`** plus **`translations/*`**: one `/tournamenthelp` line. The template entries were added with `./build translations` and `./build translations --sync`.
- **`PROTOCOL.md`:** `GENERATOR` can now be `Swiss` or `N-Round Swiss`.

Nothing else in `Tournament`, `Elimination` or `RoundRobin` changed.

## How it was tested

| Level | File | What it covers |
|---|---|---|
| Unit (17 tests) | `test/server/tournaments/generator-swiss.js` | Names and round parsing; default round counts for 2–16 players; one round at a time; equal records meet; **no rematches across 150 seeded random tournaments** (6–16 players); byes; draws; disqualification; result ordering and tie grouping; the same error codes as the other generators; crosstable shape; a 64-player, 63-round run that must finish quickly |
| System (5 tests) | `test/server/tournaments/swiss.js` | Real chat commands: `/tour create … swiss` → `/tour join` ×5 → `/tour start` → `/tour ready` → results reported through `Tournament.onBattleWin` (the call `RoomBattle` makes). Checks that round *r + 1* never starts early, that the tour ends after 3 rounds with no repeated pairing, the `|tournament|end|` payload, `/tour settype`, error replies, and `isJoined` after `/tour dq` |

To reproduce:

```sh
npm ci
npx mocha -g "Swiss"     # 22 passing
npm run full-test        # what CI runs: oxlint --max-warnings 0, all mocha tests, test-npm
npx tsc                  # type-check
```

Results on this branch, compared with clean `master` (`f1040ecb5`):

| | `master` | this branch |
|---|---|---|
| oxlint `--max-warnings 0` | pass | pass |
| mocha (`-g ".*"`, includes slow tests) | 2762 passing, 76 pending | **2784 passing, 76 pending** (+22 new) |
| `test-npm` | pass | pass |
| `tsc` | pass | pass |

**To check by hand with real battles:**
1. Put `YOURNAME,~` in `config/usergroups.csv`.
2. Run `node pokemon-showdown start` and open `http://localhost:8000`.
3. Log in from several browser profiles, join a chat room, and run `/tour create gen9customgame, swiss`. Then `/tour join` in each profile and `/tour start`.
4. Play or forfeit the battles, and watch the crosstable (the bracket button) fill in round by round.

The mutation checks below were run to confirm that the tests actually catch mistakes. Each change was made to the source and reverted afterwards:

| Deliberate bug | Result |
|---|---|
| Skip rematch avoidance | 1 test fails |
| Give the bye to the top player | 1 test fails |
| Ignore Buchholz in the standings | 1 test fails |
| Pair the next round before the current one is finished | 10 tests fail |
| Remove the pairing step budget | the test run **hangs** (killed after 10 minutes): the event loop is blocked |

## Deliberately left out

- A top cut (an Elimination playoff for the top *k*), late joining, manual pairing overrides, and round announcements in chat.
- Play! Pokémon tie-breakers (OWP/OOWP). Buchholz was chosen because it is exact in floating point, so ties can be grouped reliably. See `docs/DESIGN.md` §4.4.
- A dedicated Swiss standings view in the client. The crosstable is *n × n*, which is large for big tours. The end-of-tour summary only shows the top 4.

## Risks and compatibility

- **No behaviour change for existing tours or settings.** No stored data changes, and tournaments are not persisted.
- **Protocol:** a new `GENERATOR` value. The official client shows unknown generator names verbatim. Bots that `switch` on the generator name without a default case may mishandle it.
- **Availability:** pairing is synchronous on the main process. It is bounded by the step budget. Measured at default rounds over 140 tours of 8–512 players: the budget never triggered, there were no rematches, and pairing took at most 279 ms in total for a whole 512-player tour.

## Please look closely at

1. **The pairing search (`pairWithoutRematches`).** The 10,000-step budget was chosen by measurement, not derived. Is a fixed constant acceptable, or would you prefer it scaled by player count?
2. **Name-based icon checks.** I added `generator.name.endsWith('Swiss')` to both copies of `renderLink` to match the surrounding code, rather than refactoring generator identity (name checks in four places and `instanceof RoundRobin` in two, in and around `Tournament`). I'm happy to follow up with a `TournamentGenerator` interface if you want that.
3. **The `/faq tournaments` text** still says "There are two different types of room tournaments". Changing that string would invalidate its existing translations in 9 languages, so I left it alone. Should it be updated?
4. **Disqualified players in results.** They are listed last, not omitted (Round Robin lists everyone; Elimination lists only the podium).
