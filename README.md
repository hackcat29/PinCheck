# PinCheck

**Catch breaking TapeOut circuit upgrades before they ship.**

PinCheck is a required GitHub check for X Layer apps that call [TapeOut](https://tapeout.net/) circuits. Pin the circuits your app calls in `pincheck.json`. When a pull request proposes a different circuit, PinCheck compares every input of both circuits at one X Layer block, replays the first difference on the deployed processors, and blocks the merge with the input that proves it.

A real example from this repository, [pull request #1](https://github.com/hackcat29/PinCheck/pull/1) ([check run](https://github.com/hackcat29/PinCheck/actions/runs/44116618733)):

| Change | Result | Input | Current #1 | Candidate #11 | Replay |
|---|---|---|---|---|---|
| OrderGuard circuit #1 → #11 | **Behavior changed**, 4 of 4 inputs checked, 3 differ | `0x01` | `0x01` | `0x00` | Confirmed by both processors at block 76,160,736 |

The same check passed [#1 → #2](https://github.com/hackcat29/PinCheck/pull/2), whose netlist is identical.

## Add it to your repository

Three files and one branch rule; no account, token or service. The full guide is [docs/install.md](docs/install.md).

```yaml
# .github/workflows/pincheck.yml
name: PinCheck
on:
  pull_request:
  merge_group:
permissions:
  contents: read
jobs:
  pincheck:
    name: Circuit compatibility
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: hackcat29/PinCheck@v0.2.0
        with:
          manifest: pincheck.json
```

```json
{ "pincheck": 1, "dependencies": { "order-guard": { "circuit": "0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355:1" } } }
```

Then add `.github/CODEOWNERS` for `pincheck.json` and `.github/workflows/`, and a branch ruleset that requires **Circuit compatibility** from GitHub Actions and code-owner review. [examples/consumer](examples/consumer) is the complete layout.

> **Release status.** v0.2.0 is the first release that includes the GitHub Action. Before release it was verified on GitHub both installed by commit and run from the base commit, in pull requests [#3](https://github.com/hackcat29/PinCheck/pull/3) (blocked), [#4](https://github.com/hackcat29/PinCheck/pull/4) (passed) and [#5](https://github.com/hackcat29/PinCheck/pull/5) (intended change accepted). For the strongest pin, replace `@v0.2.0` with the tag's full commit SHA.

## What a pass means

**Compatible** means every one of the 2^n inputs produces the same output bits from both circuits under [TAP-02](https://github.com/TapeOutProtocol/TAPs/blob/main/TAPs/TAP-02.md) evaluation, at the recorded block, with inputs and outputs packed least significant bit first. Byte-identical netlists are compatible for every input and state.

It does not show that either circuit is correct, that the bits mean the same thing to your app, or that behavior will hold after the processor implementation changes (TapeOut processors are beacon proxies and the X Layer factory is not sealed). Each report records what it read so another maintainer can reproduce it:

- chain ID, block number, hash and timestamp; calls pinned with [EIP-1898](https://eips.ethereum.org/EIPS/eip-1898) block hashes (`requireCanonical`), falling back to block number plus a hash recheck only when an RPC rejects them;
- both processors' registration with the X Layer factory, the factory's sealed flag, and the circuit implementation behind the beacon;
- every circuit in both REF closures with dimensions, gate count, SHA-256 and Keccak-256 of the netlist bytes;
- local comparison and on-chain replay as separate statuses, with explicit coverage, and the PinCheck version.

A processor that disagrees with PinCheck makes the result **Inconclusive**. A replay that cannot run never hides a local mismatch. An RPC failure is **Inconclusive** and blocks the merge; it can never pass.

## Supported scope

| | Workbench | CLI and GitHub Action |
|---|---|---|
| Exhaustive comparison | up to 24 input bits | up to 26 input bits |
| Gates per circuit (REFs inlined), netlist size, REF depth | 20,000 · 512 KB · 16 | same |

Wider circuits are sampled with a fixed seed: a sampled mismatch fails the check, but a clean sample is **Inconclusive**, never a pass. Stateful (LATCH) circuits pass only when byte-identical. X Layer mainnet (chain 196) only. Intended changes are approved in the manifest with `acceptChange`, bound to the exact circuit transition and shown in every summary; an acceptance can never override a run that failed.

Measured on mainnet circuits from the projects below: Neon Reliquary's 20-input chips are checked over all 1,048,576 inputs (a full run, including chain reads and replay, takes about 6 seconds), Fusebox's 24- and 19-input fuses fit exhaustively, and its 33-input and stateful fuses are covered only when unchanged. Circuits with 32 to 64 inputs, such as AI Pulse's indicators, need a proof method beyond enumeration; today they get identical-netlist checks and sampled counterexamples only.

## Use it locally

Node.js 22 or newer. No dependencies.

```sh
npm start                     # workbench on http://localhost:4173
npm test                      # deterministic tests, no network
npm run test:live             # X Layer mainnet smoke tests
node cli.mjs --help
node cli.mjs 0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355:1 0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355:11
```

The CLI prints a JSON report and exits `0` (compatible), `1` (behavior or interface changed) or `2` (inconclusive or invalid input). `node cli.mjs gate --base A.json --head B.json` runs the same gate as the action. Set `X_LAYER_RPC` for another endpoint; credentials in it never appear in output.

The workbench opens on recorded evidence, reruns it live, compares any two circuits, and opens saved reports (including the `pincheck-report` artifact from a GitHub run) in the browser without an RPC. Deployment, environment variables, health checks and the RPC outage runbook are in [docs/deploy.md](docs/deploy.md).

## Layout

| Path | Contents |
|---|---|
| `src/compare.mjs` | TAP-02 decoding, well-formedness checks, REF inlining, bit-sliced exhaustive and sampled comparison. No I/O. |
| `src/xlayer.mjs` | X Layer reads: pinning, factory registration, implementation, replay, RPC limits and redaction |
| `src/manifest.mjs`, `src/gate.mjs`, `src/summary.mjs` | `pincheck.json`, the release gate, the GitHub job summary |
| `src/report.mjs` | Decision, coverage, guarantee and next-step wording shared by the CLI, summary and browser |
| `action.yml`, `action/` | The composite GitHub Action |
| `server.mjs`, `web/` | Workbench and docs site |
| `examples/` | Recorded schema 2 reports with provenance, and the consumer repository layout |
| `demo/` | The schema 1 reports captured by the original GitHub checks, and the manifest PRs #1 and #2 change |

## Verification evidence

Every check below was run on 2026-11-17 for v0.2.0 and passed, or returned the result it was designed to return. Mainnet runs read X Layer through `https://rpc.xlayer.tech`. Block numbers are given where the run was pinned or recorded; the rest ran at the latest block, and a `--block` hash reproduces any of them while the RPC keeps that state.

### Deterministic tests (`npm test`, no network)

55 of 55 pass, locally and in GitHub Actions.

| File | Tests | Covers |
|---|---|---|
| `test/compare.test.mjs` | 17 | NAND/REF semantics, multi-output REF order, LSB-first packing, interface mismatch, malformed and self-referencing netlists, undeclared state, gate-count mismatch, 2^20 and 2^22 exhaustive search (a single differing input among 4,194,304 found exactly), sampling that can fail but never pass, identical stateful circuits, size and REF-depth limits |
| `test/xlayer.test.mjs` | 17 | Replay ABI encoding, EIP-1898 pinning and its fallback, spot-checks, replay disagreement, replay unavailable after a real mismatch, RPC down, wrong chain, unregistered processor, missing circuit, reorg during a run, historical state errors, credential redaction, response size cap, input parsing |
| `test/gate.test.mjs` | 13 | Manifest validation, legacy manifests, pass/fail/inconclusive exit codes, acceptChange bound to one transition and refused for failed runs, added/removed/multiple dependencies, summary content with bit names, CLI exit codes |
| `test/web.test.mjs` | 4 | Landing-page evidence matches the recorded report, recorded examples match the captured v0.1 fingerprints, Markdown escaping, server validation, 429 under load and cache hits |
| `test/docs.test.mjs` | 4 | Install snippets, README, example layout and ruleset stay in sync |

### GitHub Actions

| Run | Commit | Result |
|---|---|---|
| [Push to main](https://github.com/hackcat29/PinCheck/actions/runs/44129826650) | `e670742` (v0.2.0) | Evaluator tests and mainnet smoke tests passed |
| [PR #3](https://github.com/hackcat29/PinCheck/pull/3), #1 → #11 | `ec42162` | [Circuit compatibility](https://github.com/hackcat29/PinCheck/actions/runs/44129125420) and [the installed action](https://github.com/hackcat29/PinCheck/actions/runs/44129124752) **blocked the merge**, as intended; evaluator and smoke tests passed |
| [PR #4](https://github.com/hackcat29/PinCheck/pull/4), #1 → #2 | `861d61d` | [Circuit compatibility](https://github.com/hackcat29/PinCheck/actions/runs/44129130478) and [the installed action](https://github.com/hackcat29/PinCheck/actions/runs/44129130390) passed; evaluator and smoke tests passed |
| [PR #5](https://github.com/hackcat29/PinCheck/pull/5), #1 → #11 with acceptChange | `3f4fa42` | [Circuit compatibility](https://github.com/hackcat29/PinCheck/actions/runs/44129139534) and [the installed action](https://github.com/hackcat29/PinCheck/actions/runs/44129139738) passed with the change marked accepted; evaluator and smoke tests passed |
| [PR #1](https://github.com/hackcat29/PinCheck/pull/1) and [PR #2](https://github.com/hackcat29/PinCheck/pull/2) (v0.1) | | [Failed](https://github.com/hackcat29/PinCheck/actions/runs/44116618733) and [passed](https://github.com/hackcat29/PinCheck/actions/runs/44116681813) |

The `pincheck-report` artifacts downloaded from the first runs of PRs #3 and #5 contained `decision: fail`, exit code 1, input `0x01` with replay confirmed (#3), and `decision: pass` with the acceptChange reason recorded (#5). The artifacts were uploaded even though the job failed, with 90-day retention. The unchanged `demo/circuit.json` gate passed in the same runs.

### X Layer mainnet comparisons (CLI and workbench)

| Comparison | Block | Result | Coverage | First mismatch: input → current, candidate | Replay |
|---|---|---|---|---|---|
| OrderGuard #1 → #11 | 76,160,736 (recorded) | Behavior changed | 4 of 4, 3 differ | `0x01` → `0x01`, `0x00` | Confirmed |
| OrderGuard #1 → #2 | 76,160,736 (recorded) | Compatible | 4 of 4, identical netlists | | 3 spot-checks confirmed |
| OrderGuard #1 → #11 | latest (several runs, e.g. 76,163,331 and 76,163,784) | Behavior changed | 4 of 4 | `0x01` → `0x01`, `0x00` | Confirmed |
| OrderGuard #5 → #9 | latest | Behavior changed | 16 of 16, 3 differ | `0x05` → `0x01`, `0x00` | Confirmed |
| Neon Reliquary #5 vs #7 (20 in, 22 out) | 76,163,385 (recorded) | Behavior changed | 1,048,576 of 1,048,576, 131,072 differ | `0x108001` → `0x4f1201`, `0x4f1202` (bits 16, 17) | Confirmed |
| Neon Reliquary #9 vs #10 | latest | Behavior changed | 1,048,576 of 1,048,576, 196,608 differ | `0x008401` → `0x4f1200`, `0x4f1210` (bit 20) | Confirmed |
| Fusebox Daily Cap #15 vs itself (24 in) | 76,165,405 | Compatible | 16,777,216 of 16,777,216 | | Spot-checks confirmed |
| Fusebox Payee Guard #16 vs itself (33 in) | 76,165,412 | Compatible | Identical netlists, all 2^33 inputs | | Spot-checks confirmed |
| Fusebox Breaker #17 vs itself (LATCH) | 76,165,418 | Compatible | Identical netlists, every input and state | | Not applicable (stateful) |
| Fusebox Two of Three #18 vs itself (19 in) | 76,165,481 | Compatible | 524,288 of 524,288 | | 3 spot-checks confirmed |
| Fusebox #15 → #18 | latest | Interface mismatch | 24 vs 19 input bits | | Not applicable |
| OrderGuard #1 → #999999 | latest | Inconclusive (`no-circuit`) | | | Not run |
| Unregistered contract → OrderGuard #1 | latest | Inconclusive (`unregistered-processor`) | | | Not run |

The recorded OrderGuard reports were reproduced at block hash `0x5069ea17…6a99` with the same SHA-256 netlist fingerprints as the reports captured by the v0.1 checks (`91c81eb0…` for #1 and #2, `c4324090…` for #11). Re-running all three recorded examples at their pinned hashes changed only the timestamp and wording fields.

**Netlist fingerprints match what projects publish.** PinCheck's Keccak-256 for Neon Reliquary chip #5 equals the hash in their [XLAYER-MAINNET.md](https://github.com/tizerluo/neon-reliquary-xlayer/blob/main/docs/XLAYER-MAINNET.md) (`0xe7817e01…0b02`). For Fusebox, the hashes of #15, #16, #17 and #18 equal those listed for `daily-cap`, `payee-guard`, `breaker` and `approval-2of3` in their [`circuits/build/fuses.json`](https://github.com/0xdopewilly/fusebox/blob/main/circuits/build/fuses.json): `0xd65b2e8a…dd97`, `0x2d1dc771…9099`, `0xb3a4fd12…f4ea`, `0x1236c24f…5027`.

**Fusebox rival fuses.** Fusebox's unreleased rival designs, taken from their `circuits/build/rivals.json` (not on chain, so the rival side cannot be replayed), were compared with the deployed fuses using PinCheck's evaluator through a one-off script, since the CLI cannot yet compare a deployed circuit with a local netlist:

- Per-Payment Cap vs Daily Cap #15: all 16,777,216 inputs, 5,592,320 differ. The first is amount 0, spent 1, cap 0: #15 denies and the rival approves.
- Lead Approver vs Two of Three #18: all 524,288 inputs, 32,640 differ. The first is approvers 2 and 3, amount 1, threshold 0: #18 approves and the rival denies.
- Strict Payee Book vs Payee Guard #16 (33 inputs): a sampled counterexample at `0x3dc841d001`, so the check fails without a full proof.
- Two-Strike Breaker vs Breaker #17: Inconclusive, because the circuits are stateful and not identical.

### Mainnet smoke tests (`npm run test:live`)

6 of 6 pass in about 48 seconds locally, and in the GitHub runs for PRs #3 to #5 and the push to main: PR #1 and #2 conclusions reproduced at the recorded block, the regression still present at the latest block, Neon Reliquary 20-input exhaustive check with matching Keccak, Fusebox #16 and #17 identical-netlist passes, and inconclusive results for an unregistered contract and a missing circuit.

### X Layer RPC and contract facts

Checked directly against `rpc.xlayer.tech`:

- `eth_call` accepts EIP-1898 `{ blockHash, requireCanonical: true }` and rejects an unknown block hash with "block not found".
- State at the recorded block 76,160,736 is still served. A call before the processor existed returns empty data.
- The factory `0x1f09…0761` reports `isCPU` true for OrderGuard and false for an arbitrary address, 426 processors, and `isSealed` false.
- The circuit beacon `0xf70d…991C` returns implementation `0x977f…29b2`, the address TAP-10 lists.
- `circuitInfo` for a missing circuit reverts with `no circuit`.
- The function selectors PinCheck uses, recomputed with Keccak-256, match the values published in TAP-02. PinCheck's Keccak-256 passes the standard empty-string and `abc` vectors and agrees with an independent implementation across block boundaries.

### Release gate, end to end

- **The action's scripts, run locally against the real GitHub API at the SHAs of PRs #1 and #2:** `decision=fail`, exit 1 with the counterexample summary, and `decision=pass`, exit 0.
- **A fresh repository set up by copying each snippet from `docs/install.md`:** the documented sanity command returned compatible. A simulated #1 → #2 pull request passed with exit 0. #1 → #11 blocked with exit 1 and the counterexample. #1 → #11 with the documented acceptChange passed as "Behavior changed (accepted)" with the reason.
- **A live gate run of #1 → #11:** produced the job summary shown in [docs/install.md](docs/install.md#what-you-will-see).

### Workbench and server

Checked with Playwright (Chromium) and axe-core 4.10 at 1280 px and 390 px, in light and dark mode:

- **Accessibility:** no axe violations (WCAG 2.0, 2.1 and 2.2 A/AA rules plus best practices) on the landing page or the docs.
- **Layout:** no horizontal scrolling, and the real counterexample is visible above the fold at both widths. No touch target is under 24 px.
- **Keyboard:** a logical tab order with a 3 px focus ring. Activating an example with the keyboard moves focus to the decision.
- **Actions:** Copy link and Copy CLI command copy the right text. Download JSON saves the full report. Opening the captured v0.1 report renders it, and a non-report file is rejected with a clear message. Empty form fields are flagged and focused.
- **Live runs:** a live #1 → #11 comparison completed in 6.4 to 6.9 seconds. Reloading its permalink was answered from cache in 21 to 24 ms. A missing circuit, an unregistered processor and an interface mismatch each showed their own decision and next step.
- **Server:** every route returned the expected status and content type. Bad input got 400, an unknown path 404, and a POST 405, and the CSP header is set. The deep health check confirmed chain 196.
- **RPC outage:** with an unreachable RPC URL containing a key, the deep health check returned 503, comparisons returned Inconclusive, and the key appeared in neither the response nor the server log.
- **Production launch:** `NODE_ENV=production HOST=0.0.0.0 PORT=8080 node server.mjs` served the site and docs.

### Evaluator speed

Two comparisons of every input, locally, before chain reads:

| Input bits | Gates (both circuits) | Time |
|---|---|---|
| 20 | 102 | 16 ms |
| 24 | 218 | 308 ms |
| 24 | 434 | 523 ms |
| 26 | 402 | 1,980 ms |

### Not yet verified

- A Docker image build: the Docker daemon was not running.
- A pull request from a fork: GitHub does not allow forking your own repository.
- Creating the ruleset from `examples/consumer/ruleset.json`: this was not applied, to avoid changing repository settings.
- A `merge_group` run.
- How GitHub renders the job summary: summaries are not visible to signed-out browsers. The Markdown itself is covered by tests.
- A workflow that uses `@v0.2.0` by tag: the tag resolves and serves `action.yml`, but runs so far used the commit SHA.
- A hosted deployment of the workbench.

## Credits and references

- [TAP-02](https://github.com/TapeOutProtocol/TAPs/blob/main/TAPs/TAP-02.md): netlist encoding, evaluation semantics and processor interface. X Layer contract addresses are from TAP-10 and were read back on chain.
- Example circuits come from public deployments PinCheck does not own: the [OrderGuard processor used by Fusebox](https://github.com/0xdopewilly/fusebox#live-on-x-layer-mainnet-chain-196) and [Neon Reliquary](https://github.com/tizerluo/neon-reliquary-xlayer/blob/main/docs/XLAYER-MAINNET.md).
