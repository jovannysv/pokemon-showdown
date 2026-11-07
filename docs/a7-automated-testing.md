# A7: Automated Testing

**Project:** Pokémon Showdown (server repository, `smogon/pokemon-showdown`)
**Course:** CSCI 360 — Software Architecture, Security, and Testing

---

## Part 1: Find The Gaps

### Tool and method

The project ships **no coverage tooling**. `package.json` has no `c8`, `nyc` or `istanbul`, and `npm test` runs `eslint`, then `mocha`, then `tsc`.

Rather than add a dependency, I used the coverage engine **built into Node.js 24**: `node --test --experimental-test-coverage`. It records V8 block coverage while the code runs. With `--enable-source-maps`, it maps the compiled `dist/*.js` back to the original `.ts` files, because the build already emits source maps (`tools/build-utils.js:51`).

Node's coverage only instruments its own `node:test` runner, not Mocha. So I added a 40-line entry point, [`test/coverage.js`](../test/coverage.js). It runs the **unchanged** Mocha suite, with the same spec globs and `(slow)` filter as `.mocharc.json`, inside a single `node:test` test. It changes no test and no production code.

```sh
node --test --enable-source-maps --experimental-test-coverage \
  --test-reporter=spec --test-reporter-destination=docs/coverage/before/coverage-summary.txt \
  --test-reporter=lcov --test-reporter-destination=docs/coverage/before/lcov.info \
  test/coverage.js
```

The suite result under coverage matched a normal `npm test` run: **2372 passing, 74 pending, 0 failing**.

**Generated reports (baseline):**
- [docs/coverage/before/coverage-summary.txt](coverage/before/coverage-summary.txt): Node's per-file table, with uncovered line ranges.
- [docs/coverage/before/lcov.info](coverage/before/lcov.info): the LCOV report, readable by any LCOV viewer such as `genhtml` or the VS Code *Coverage Gutters* extension.

Two problems came up while setting this up:
- **Hang after the suite finished.** The suite leaves timers and sockets open, and `.mocharc.json` relies on `exit: true` to kill the process. The wrapper does the same with a `process.exit()` after the result is reported.
- **`--test-coverage-include` silently matched nothing.** Node checks it against the `dist/` paths *before* source-map remapping, so a filter like `server/**` only kept the two config files. The report is therefore unfiltered. Node already leaves out `test/` and `node_modules/`, and I grouped the rest by directory myself.

### What the tool measured

Node reports **line**, **branch** and **function** coverage.

| Directory | Files | Line | Branch | Function |
|---|---|---|---|---|
| `data/` | 197 | 97.26% (527,946 / 542,793) | 77.22% | 54.10% |
| `sim/` | 24 | 83.81% (17,443 / 20,812) | 86.00% | 78.72% |
| `lib/` | 12 | 50.42% (2,442 / 4,843) | 70.55% | 32.09% |
| `server/` | 87 | 31.42% (24,456 / 77,827) | 64.36% | 26.92% |
| `translations/`, `config/`, `tools/`, `build`, `dist/` | 53 | (mostly static data) | | |
| **All measured files** | **373** | **88.48%** (584,690 / 660,844) | **77.92%** (13,707 / 17,590) | **43.12%** |
| **Code only (`server` + `sim` + `lib`)** | **123** | **42.85%** (44,341 / 103,482) | **77.99%** (8,549 / 10,961) | **35.52%** |

**The project's overall figure is 88.48% line coverage**, the tool's own `all files` row. **The figure I report is 42.85% line coverage of the actual code.** The reasons are below.

### Do I believe the number? No, not the headline. Here is what it hides.

1. **`data/` inflates the headline by about 46 points.**
   - `data/` is 543k lines of Pokédex, move and learnset *tables*: object literals that run once, when the module is imported.
   - Every test that loads the simulator "covers" them, and no assertion is involved.
   - Removing `data/`, `translations/` and `config/` drops line coverage from 88.48% to **42.85%**.

2. **Import time counts as coverage.**
   - `test/main.js` boots most of the server, and `server/` loads every chat plugin.
   - So `server/chat-commands/admin.ts` is 20.98% "covered" by line, even though only **2 of its 56 functions** (3.57%) were ever called.
   - The covered lines are the `export const commands = { … }` scaffolding, not behaviour. This is the `divide(10, 2)` problem from the assignment, at the scale of whole files.
   - **For `server/`, function coverage (26.92%) is the honest number.**

3. **Branch coverage is higher than line coverage, which should be impossible for a stricter measure.**
   - V8 lists the branches *inside* a function only once that function has run. A function that never runs adds **zero** branches to the denominator, not all of its branches.
   - That is how `admin.ts` reaches **100% branch (3/3)** with 3.57% of its functions called, and `chat-commands/info.ts` reaches 100% (10/10) with 14.60% line coverage.
   - So **the 77.99% branch figure is not stricter than line coverage. Here it is the most misleading of the three**, because it only describes the code that already ran.

4. **Files nobody loads are not in the report at all.**
   - Node has no equivalent of `c8 --all`. Of 128 `.ts` source files in `server/`, `sim/` and `lib/`, 5 never appear.
   - Four of those are type-only. The fifth is **`server/ladders-remote.ts`** (179 lines), the ladder client the official server uses. It has **0% coverage that the report does not show**.

5. **Coverage says nothing about assertions.** Assertion density varies a lot between folders:

   | Folder | `it()` blocks | `assert` calls |
   |---|---|---|
   | `test/sim/` | 1,985 | 3,655 |
   | `test/server/` | 193 | 458 |
   | `test/lib/` | 18 | 10 |

   - **`test/lib/` is a warning about this kind of count, not evidence of weak tests.** Its `dashycode.js` tests look assertion-free (`encode(codepoint);` and nothing else), but the asserts live in the `encode`/`decode`/`transcode` helpers. A raw count of asserts per test would have accused it wrongly.
   - The `sim/` figure is the one I trust most: 79% function coverage, with dense, specific assertions about battle outcomes.

6. **The number moves slightly between runs.** A trial run measured 42.86% code line coverage, and the committed baseline run measured 42.85%, with no change to any file. Some tests use randomness or timing, so the exact set of lines executed differs slightly from run to run.

### Where the gaps are

These are the most important code files with the least behaviour actually exercised (function coverage):

| File | Line | Function | Why it matters |
|---|---|---|---|
| `server/ladders-remote.ts` | not loaded | not loaded | Rating updates for the official ladder (A5 threat R2). |
| `server/chat-commands/admin.ts` | 20.98% | 3.57% | `/eval`, `/bash`, hot-patching (A5 threat R1). |
| `server/chat-commands/moderation.ts` | 24.64% | 10.45% | Lock, ban, mute: UC3 *Lock a Rule-Breaking User*. |
| `server/tournaments/index.ts` | 14.21% | 0.97% | Tournament brackets and results. |
| `lib/process-manager.ts` | 37.48% | 19.74% | All child-process IPC (A5 crossings 4, 7, 9, 10, 11). |
| `lib/static-server.ts` | 30.52% | 0.00% | The public HTTP surface (A5 crossing 3), never called by a test. |
| `server/punishments.ts` | 47.18% | 50.85% | IP and name punishments. |
| `server/room-battle.ts` | 54.04% | 58.90% | Battle lifecycle, timer, ladder hand-off. |

The well-tested centre of the project is the **simulator**: `sim/battle.ts` 88.89%, `sim/pokemon.ts` 94.39% and `sim/battle-actions.ts` 100% function coverage. Coverage drops steeply as code moves outward to the **network, process and moderation layers**. Those are the layers the A5 threat model found most exposed.

---

## Part 2: Characterize What Exists

**Commit:** `36856b380` *A7-Tests: Characterize matchmaking, login token validation and static file server* (37 tests). A follow-up commit, `c81bc7331` *A7-Tests: Fix lint errors in coverage runner and token tests*, fixed lint only; see "Notes for Part 5".

I chose three components that sit on the system's main paths and had **no direct test**. All three appeared in my A5 threat model:

| Component | Why it matters | Test file | Tests |
|---|---|---|---|
| `Ladder#matchmakingOK` (`server/ladders.ts:332`) | Decides every ranked pairing; the anti-win-trading control from A5 (MUC1, C1) | [test/server/matchmaking.js](../test/server/matchmaking.js) | 10 |
| `User#validateToken` (`server/users.ts:638`) | The login check: the guest → registered boundary (A5 crossing 6) | [test/server/validate-token.js](../test/server/validate-token.js) | 14 |
| `StaticServer` (`lib/static-server.ts`) | Everything served over the game server's HTTP port (A5 crossing 3); 0% function coverage at baseline | [test/lib/static-server.js](../test/lib/static-server.js) | 13 |

### `Ladder#matchmakingOK`

| Kind | Test | What it pins down |
|---|---|---|
| Normal | `givenTwoUsersOnDifferentIpsWithEqualRatings_whenPaired_matchesAndRecordsEachOtherAsLastMatch` | Returns `true` **and has a side effect**: it writes `lastMatch` on both users. |
| Boundary | `givenANonCurrentGenFormat_whenRatingGapIsExactly100_matches` / `…Is101_rejectsAndLeavesLastMatchUnset` | The base range is 100, and the comparison is `>` (a gap of exactly 100 is allowed). |
| Boundary | `givenTheCurrentGenOuFormat_whenRatingGapIs50Or51_usesTheTighterRangeOf50` | Current-gen OU uses 50. |
| Boundary | `givenASearchWaiting30Seconds_whenRatingGapIs200Or201_…` | The range grows by 1 per 300 ms of waiting. |
| Boundary | `givenASearchWaitingAnHour_whenRatingGapIs600Or601_capsTheRangeAt600` | The hard cap is 600. |
| Failure | `givenTwoUsersOnTheSameIp_…`, `givenTheSameUserTwice_…`, `givenTwoUsersWhoWereJustMatched_whenPairedAgain_rejectsTheImmediateRematch` | The three rejection rules. |
| Surprising | `givenNoipchecksEnabled_whenSameIpRematchFarApartInRating_stillMatches` | `Config.noipchecks` returns `true` *before* the rating check, so it switches off the **rating range** as well as the IP checks. The name suggests only IP checks. I pinned this behaviour rather than "fixing" it. |

### `User#validateToken`

The test generates a throwaway RSA key pair and points `Config.loginserverpublickey` at it, so **real signatures go through the real verifier** instead of a mock.

| Kind | Test | What it pins down |
|---|---|---|
| Normal | `givenACorrectlySignedAssertion_whenValidated_returnsTheSignedUserTypeAndSendsNothing` | Returns the signed userType string (`'2'`) and sends nothing to the user. |
| Normal | `givenAnAssertionWithExtraFields_…StoresFieldsFiveToSevenOnTheUser` | Fields 5–7 are stored in `user.s1`/`s2`/`s3` (the "future-proofing" fields). |
| Boundary | `givenAnAssertionExactlyTokenexpirySecondsOld_whenValidated_stillAcceptsIt` / `…OneSecondPastTokenexpiry_…rejectsItAsStale` | Expiry is `> 25 h`, so exactly 25 h is still valid. |
| Boundary | `givenAnAssertionDatedInTheFuture_…` | `Math.abs` makes future-dated assertions stale too. |
| Boundary | `givenAnAssertionWithOnlyFourFields_whenValidated_rejectsItAsCorrupt` | At least 5 fields are required. |
| Failure | userid mismatch, challenge mismatch, **edited-after-signing** (userType changed to `'3'`, system operator), host not in `legalhosts`, empty token, `;sig` only | Each returns `null` and sends the exact `\|nametaken\|` message. |
| Failure | `givenAConnectionThatWasNeverSentAChallenge_whenValidated_returnsNullWithoutTellingTheUser` | Fails **silently**: no message to the user, only a server-side `Monitor.warn`. |
| Config path | `givenNoguestsecurityAndNoToken_whenValidated_treatsTheUserAsUnregistered` | Returns `'1'` with no token at all. |

### `StaticServer`

The tests serve files from a temporary directory, with minimal request and response stand-ins, so no port is opened.

| Kind | Test | What it pins down |
|---|---|---|
| Normal | `givenAFileInTheRoot_whenRequested_streamsItWith200ContentTypeAndCacheHeaders` | Status, MIME type, length, `max-age=3600`, the `server` header and the body. |
| Normal | `givenADirectoryWithIndexHtml_whenRequestedWithTrailingSlash_servesTheIndex` | |
| Boundary | `…WithoutTrailingSlash_redirectsWith301`, `givenADirectoryWithoutAnIndex_…404` | |
| Boundary | `givenAValidByteRange_…206WithOnlyThoseBytes`, `givenAByteRangeEndingPastTheFile_whenRequested_ignoresTheRangeAndReturnsTheWholeFile` | An out-of-bounds range is silently ignored, not answered with a 416. |
| Boundary | `givenADefaultExtension_…`, `givenAMatchingEtag_…304…`, `givenAHeadRequest_…` | |
| Failure | `givenAMissingFile_…404…`, `givenMalformedPercentEncoding_whenRequested_returns400`, `givenAnEncodedPathEscapingTheRoot_whenRequested_returns403…` | |
| Failure | `givenAnErrorCallbackReturningTrue_whenTheFileIsMissing_leavesTheResponseUntouched` | The caller's error callback can suppress the default response. |

**Production code changed to make these reachable: none.** All three components could be tested as they are. The cost was in the *test setup* instead (see Part 4).

### Do these tests test anything? Mutation check

All 37 tests passed the first time they ran. For characterization tests that is expected, and it is also exactly how a hollow test looks. So I deliberately broke each component, ran the suite, and reverted with `git checkout`:

| Mutation (one character or one line) | Original 2372 tests | With the new tests |
|---|---|---|
| `ladders.ts`: rating gap `> searchRange` → `>= searchRange` | **all pass** | **4 fail** |
| `users.ts`: expiry `> expiry` → `>= expiry` | **all pass** | **1 fails** |
| `static-server.ts`: remove the "outside the root" 403 check | **all pass** | **1 fails** |

The existing suite already *executed* `matchmakingOK` (indirectly, through `test/server/ladders.js`), so its lines counted as covered. But it would not have noticed any of these three changes. This is the Part 1 warning, measured.

---

## Part 3: Red, Green, Refactor On A Real Defect

### Finding the defect

1. **Issue tracker first.** The open issues (https://github.com/smogon/pokemon-showdown/issues) are almost all game mechanics. The one that fit, **#12402** ("Attacker and defender reversed in Poison Touch's `checkMoveMakesContact`", https://github.com/smogon/pokemon-showdown/issues/12402), has a **disputed expected behaviour**. The only commenter argues that the reporter's expected outcome is itself wrong, nobody has confirmed the correct mechanic in-game, and PR #12411 is already open. A Red test needs an agreed definition of "correct", so I did not use it.
2. **A case the characterization tests exposed.** Writing the `StaticServer` failure-path test meant reading `servePath`:

   ```ts
   // lib/static-server.ts:193–198 (before)
   // Make sure we're not trying to access a
   // file outside of the root.
   if (!pathname.startsWith(this.root)) {
   	// Forbidden
   	return this.getResult(403);
   }
   ```

   The comment states the intent: nothing outside the root. But `startsWith` compares **strings, not paths**. With root `…/public`, the path `…/public-secret/secret.txt` starts with `…/public` and passes the check. A plain `/../` gets normalised away by `new URL()`. An **encoded slash** does not: `/..%2Fpublic-secret%2Fsecret.txt` is a single URL segment, and `serve()` then decodes it into `/../public-secret/secret.txt` *after* normalisation. So the intent is clear, the code does something else, and the boundary is reachable from an HTTP request.

### Red: `103a3e55f` *A7-Red: Failing test for StaticServer serving files from sibling directories*

```js
it('givenASiblingDirectorySharingTheRootsNamePrefix_whenReachedWithAnEncodedSlash_returns403', async () => {
	const { result, res } = await get(new StaticServer(root), '/..%2Fpublic-secret%2Fsecret.txt');
	assert.equal(result.status, 403);
	assert.notEqual(res.body(), 'not for the web');
});
```

Failure output (`npm test`):

```
  2409 passing (7s)
  74 pending
  1 failing

  1) StaticServer
       givenASiblingDirectorySharingTheRootsNamePrefix_whenReachedWithAnEncodedSlash_returns403:
      AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
200 !== 403
      + expected - actual
      -200
      +403
      at Context.<anonymous> (test\lib\static-server.js:141:10)
```

It fails for the right reason: the server answered **200** and served the sibling's file, where it should have refused with 403.

### Green: `81236d4e4` *A7-Green: Fix StaticServer serving files from sibling directories*

```diff
 		// Make sure we're not trying to access a
 		// file outside of the root.
-		if (!pathname.startsWith(this.root)) {
+		const rootDir = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
+		if (pathname !== this.root && !pathname.startsWith(rootDir)) {
```

This is the least change that makes the test pass. Two details keep it from introducing a regression:
- **`pathname !== this.root`** is needed because a request for `/` resolves to the root itself, with no trailing separator.
- **The `endsWith(path.sep)` guard** keeps a filesystem root (`/` or `C:\`) working. Without it, adding a second separator would make every request a 403.

**Whole suite** (`npm test`, which runs eslint, then mocha, then tsc): **2410 passing, 74 pending, 0 failing**. Lint and `tsc` are clean.

### Refactor: `fcb76ecac` *A7-Refactor: Clean up StaticServer root containment check*

I extracted the rule into a named method next to `resolve()`, the method that produces the paths it checks:

```ts
// lib/static-server.ts:193
if (!this.isInsideRoot(pathname)) {
	// Forbidden
	return this.getResult(403);
}

// lib/static-server.ts:231–239
/**
 * Whether a path from `resolve` is the root or inside it. A plain
 * `startsWith(root)` would also accept siblings like `root-other/`.
 */
isInsideRoot(resolved: string) {
	const rootDir = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
	return resolved === this.root || resolved.startsWith(rootDir);
}
```

**Why this is a real improvement.**
- The security rule now has a **name** in place of a two-line comment.
- The comment now records *why* the obvious version is wrong, so nobody "simplifies" it back to `startsWith(root)`.
- Any future method that needs the same guarantee can call it. `serveFile()` currently does no check at all; it is only ever called with a fixed `'404.html'`.

Adding the check to `serveFile` would have **changed behaviour**, so it does not belong in a refactor commit.

**Test files:** `git diff --quiet test` reported no changes. **Whole suite:** 2410 passing, 74 pending, 0 failing. Lint and `tsc` are clean.

---

## Part 4: What The Code Told You

### What fought me, and which design rule it breaks

| # | Obstacle (where) | What I had to do in the test | Principle violated | What would make it testable |
|---|---|---|---|---|
| 1 | **Hidden clock.** `matchmakingOK` computes `Date.now() - …search.time` (`ladders.ts:357`). `BattleReady` stamps `time = Date.now()` in its constructor (`ladders-challenges.ts:31`). `validateToken` compares against `Date.now() / 1000` (`users.ts:691`). | Replace the global `Date.now` in `beforeEach` and restore it in `afterEach`. Boundary tests at "exactly 25 h" or "exactly 600" are impossible otherwise; real time would make them flaky. | **Protected Variations**: the variation point (time) has no stable interface. **Low Coupling**: coupled to the system clock. | Inject a clock, `now: () => number`, through the `Ladder` constructor and `validateToken`'s options, defaulting to `Date.now`. |
| 2 | **Globals used as a service locator.** `validateToken` calls `Verifier.verify` through a global assigned in `server/index.ts:117`, not an import. It reads `Config.loginserverpublickey`, `loginserverkeyalgo`, `legalhosts`, `tokenexpiry` and `noguestsecurity`, and logs through the global `Monitor`. | Snapshot and restore 5 `Config` keys around every test, swap in a test public key, and silence `Monitor.warn`/`debug`. The lint config does not even declare `Monitor` as a test global, so I had to import it. A test that forgets to restore `Config` leaks into every later test. | **Low Coupling** and **Protected Variations** (dependency inversion): the function depends on concrete global singletons, not on what it needs. | Extract a pure `checkAssertion(token, { challenge, userid, now, publicKey, algo, legalhosts, expiry })` that returns a result. `User` passes in its own state. |
| 3 | **Validation mixed with UI.** `validateToken` both decides validity *and* sends `\|nametaken\|…` messages through `this.send`. | Replace `user.send` with a recorder to observe *why* a token failed. The return value only says `null`. | **High Cohesion**, and command–query separation: one method answers a question *and* talks to the client. | Return `{ ok: false, reason: 'stale' }`. Let the caller (`rename`) turn reasons into messages. |
| 4 | **"Build half the system."** A `User` needs a `Connection`, which needs a worker stream. `test/users-utils.js` contains a 130-line `WorkerStream` that **re-implements the sockets IPC protocol** just so a user can exist. `test/main.js` builds `dist/` and starts the *whole server* (`require('../dist/server')`: rooms, chat plugins, login server client) before any test runs. | Use the existing harness. Every test file pays the full start-up cost, and a unit test of a 30-line predicate depends on the chat-plugin loader working. | **Low Coupling**: `User` is coupled to transport (`Connection` → worker stream). | `matchmakingOK` reads only `id`, `latestIp` and `lastMatch`. A narrow `{ id, latestIp, lastMatch }` parameter type would let it be tested with plain objects. |
| 5 | **Predicate with side effects.** `matchmakingOK` is named like a yes/no query, but on success it **writes `lastMatch` on both users**, including on the `noipchecks` early-return path. | Each test needs fresh users, because calling the predicate once changes the answer the second time (see the rematch test). | **Command–query separation**, and Information Expert: the *Ladder* records history on the *User*. | Split it into `canMatch()` (pure) and `recordMatch()` (command), called by `addSearch`. |
| 6 | **Lazy global with a temporal dependency.** `matchmakingOK` builds `` `gen${Dex.gen}ou` ``, but `Dex.gen` is `0` until game data has been lazily loaded. Run before anything loads the Dex, the "current gen" check compares against `gen0ou`. | Call `Dex.includeData()` in `before()`. | **Protected Variations**: hidden ordering dependency on global initialisation. | Pass the current generation in, or read it from the format being searched. |
| 7 | **Leaked resources.** The suite leaves timers and sockets open (for example `periodicMatchInterval`, a `setInterval` started at module load in `ladders.ts:504`), which is why `.mocharc.json` needs `exit: true` and my coverage runner needed a forced `process.exit()`. | Force the exit. | Resource ownership is unclear. Components start global timers at import time, with no `destroy()` the tests can call. | Start periodic jobs from an explicit `start()`, not at module load. |

**The contrast: `StaticServer` was the easy one, and that is a design result too.** Its only dependency, the directory to serve, is a **constructor parameter**. It does not read `Config`, has no globals and no clock (its `Date` use is only for response headers), and `serve(req, res)` takes its collaborators as arguments. A temporary directory and two 10-line fakes were enough. It also went from 0% to 74% function coverage, and it is where the defect was. Code that is easy to test is code you can *afford* to look at closely.

### Other surprising behaviour found but not fixed

- **`validateToken` accepts a non-numeric date (it fails open).**
  - `Math.abs(parseInt(signedDate) - now) > expiry` is `false` when `signedDate` is not a number, because `NaN > x` is always false. So the expiry check *passes* instead of failing.
  - Exploiting it would require the login server to *sign* such an assertion, so this is defence-in-depth, not a live bug.
  - A safe version would reject `!Number.isFinite(date)` explicitly.
- **`Config.noipchecks` also disables the rating range.** It is pinned by a characterization test, as described in Part 2.

### Coverage before and after

The reports are in [docs/coverage/before/](coverage/before/) and [docs/coverage/after/](coverage/after/). Both were produced by the same command, from `test/coverage.js`.

| | Line | Branch | Function |
|---|---|---|---|
| All measured files | 88.48% → **88.53%** | 77.92% → 77.95% | 43.12% → 43.37% |
| **Code only (`server` + `sim` + `lib`)** | 42.85% → **43.20%** | 77.99% → 78.03% | 35.52% → 35.96% |
| `lib/static-server.ts` | 30.52% → **85.65%** | **100.00% (1/1) → 71.43% (50/70)** | 0.00% → 73.91% |
| `server/users.ts` | 58.59% → 63.13% | 65.00% → 67.60% | 61.18% → 63.53% |
| `server/ladders.ts` | 55.26% → 56.39% | 67.61% → 79.75% | 70.83% → 70.83% |

**What these numbers do not tell you:**
- **Branch coverage fell where testing improved.** `static-server.ts` went *down* from 100% to 71% branch coverage when its functions were first exercised, because V8 only counts branches inside functions that ran (Part 1, point 3).
- **`ladders.ts` line coverage barely moved (+1.1 points), even though `matchmakingOK` went from untested to the most thoroughly tested function in this assignment.** The old suite had already *run* those lines without checking them. The mutation table in Part 2 is the real before and after for that file: 0 of 1 mutations caught before, 4 failing tests after.

### Is the defect worth reporting upstream? Yes, privately

It is reachable on a **real deployment with the default layout**. `server/sockets.ts:341–343` creates three static servers, and one of them is `new StaticServer('./config/avatars')`. Its sibling **`config/avatars.json`** starts with the same prefix. The `/avatars/` route (`sockets.ts:356–358`) strips `/avatars` and passes the rest on.

On my local copy only, with the server's real URL rewriting:

```
before fix:  GET /avatars/..%2Favatars.json -> 200
after fix:   GET /avatars/..%2Favatars.json -> 403
```

`config/avatars.json` maps userids to their custom avatars, with timestamps (`server/chat-commands/avatars.tsx:24–32`). It is low sensitivity, but it was never meant to be public. The fix is three lines and does not change any legitimate request.

**How to report it.** Because this is a security bug, it should be reported **privately to the maintainers**, not as a public issue or PR. The repository has no `SECURITY.md` (A5, Part 5), so that means GitHub's private vulnerability reporting if it is enabled, or contacting a maintainer directly. Per the course rules, I have not opened anything against the upstream repository and have tested only my local copy.

---

## Notes for Part 5 (where the assistant helped and where it misled)

- **Lint was missed, and the error got committed.** While writing the tests, the assistant ran only `mocha` (`npx mocha test/main.js …`), not the full `npm test`, which runs `eslint` first. Two lint errors (`Monitor` is not a declared test global, and a Promise executor returning a value) were committed in A7-Tests and the baseline commit. They surfaced only when the Green step ran the full suite, and needed the extra commit `c81bc7331`.
- **Tests that pass immediately.** All 37 characterization tests passed the first time they ran. That is expected for characterization, but it is also what a test asserting nothing looks like. The mutation check in Part 2 was needed to show they actually detect changes.
- **A silent filter in the coverage tool.** In Part 1, `--test-coverage-include="server/**"` produced a report showing **100%** coverage, because it silently dropped every file except two config files. An assistant reporting that number without checking the file list would have been confidently wrong.
- **An inflated headline number.** The headline 88% coverage figure is real output from the tool, but it mostly measures `data/` tables being imported. Without the per-directory breakdown, the number would have been passed on as-is.
