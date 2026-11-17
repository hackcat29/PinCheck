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

> **Release status.** The action is verified on GitHub from branch `product/release-gate`, both installed by commit (`hackcat29/PinCheck@ab080a6…`) and from the base commit (pull requests [#3](https://github.com/hackcat29/PinCheck/pull/3), [#4](https://github.com/hackcat29/PinCheck/pull/4) and [#5](https://github.com/hackcat29/PinCheck/pull/5)). The `v0.2.0` tag that the snippet above uses is published when this branch is merged and tagged; until then `@v0.2.0` does not resolve.

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

## Credits and references

- [TAP-02](https://github.com/TapeOutProtocol/TAPs/blob/main/TAPs/TAP-02.md): netlist encoding, evaluation semantics and processor interface. X Layer contract addresses are from TAP-10 and were read back on chain.
- Example circuits come from public deployments PinCheck does not own: the [OrderGuard processor used by Fusebox](https://github.com/0xdopewilly/fusebox#live-on-x-layer-mainnet-chain-196) and [Neon Reliquary](https://github.com/tizerluo/neon-reliquary-xlayer/blob/main/docs/XLAYER-MAINNET.md).
