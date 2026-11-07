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
