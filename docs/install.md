# Add PinCheck to your repository

## What a result means

PinCheck compares two TapeOut circuits deployed on X Layer mainnet, the one your app calls today and a proposed replacement, and returns one of four decisions.

| Decision | Meaning | Release check |
|---|---|---|
| **Compatible** | Every input produces the same outputs from both circuits. | Pass |
| **Behavior changed** | At least one input produces different outputs. The report shows the first one. | Fail |
| **Interface mismatch** | The circuits take or return a different number of bits. | Fail |
| **Inconclusive** | The comparison could not be completed or is outside what PinCheck can prove. | Fail |

A **Compatible** result is a precise claim: for every one of the 2^n inputs, both circuits return the same output bits under [TAP-02](https://github.com/TapeOutProtocol/TAPs/blob/main/TAPs/TAP-02.md) evaluation, at the recorded block, with inputs and outputs packed least significant bit first. Byte-identical netlists are compatible for every input and state, because they name the same records and the same REF targets.

It does **not** show that either circuit is correct, that the output bits mean the same thing to your app, or that the circuits will behave the same after the processor implementation changes. TapeOut processors are beacon proxies and the X Layer factory is not sealed, so each report records the implementation address it read.

## How PinCheck reaches a decision

1. **Read at one block.** Both circuits and every circuit they reference through REF are read with `eth_call` pinned to one block hash ([EIP-1898](https://eips.ethereum.org/EIPS/eip-1898), `requireCanonical: true`). If an RPC rejects block-hash calls, PinCheck pins by block number, records that in the report, and rechecks the block hash after the run. Both processors must be registered with the X Layer TapeOut factory (`isCPU`).
2. **Compare locally.** PinCheck decodes the netlists, checks them against the TAP-02 well-formedness rules, inlines REFs, and evaluates every input of both circuits, 32 inputs per machine word. The gate count each processor reports must match the netlist.
3. **Replay on chain.** The first differing input is sent to both deployed processors with `eval`. For a compatible pair, a few fixed inputs are spot-checked the same way. If a processor returns anything other than what PinCheck computed, the result is **Inconclusive**.

Local comparison and replay have separate statuses in every report. A replay that cannot run (for example during an RPC outage) never hides a local mismatch: the check still fails.

## Supported circuits and limits

| Limit | Workbench | CLI and GitHub Action |
|---|---|---|
| Exhaustive comparison | up to 24 input bits | up to 26 input bits |
| Gates per circuit, REFs inlined | 20,000 | 20,000 |
| Netlist size | 512 KB | 512 KB |
| REF nesting | 16 levels | 16 levels |
| Time budget | 20 seconds | 45 seconds |

- **Wider circuits** are sampled with a fixed seed. A sampled mismatch is a real behavior change and fails the check. If the sample finds no difference the result is **Inconclusive**, because a sample is not proof. Byte-identical netlists pass at any width.
- **Stateful circuits** (LATCH) pass only when their netlists are byte-identical. Otherwise the result is **Inconclusive**.
- Only X Layer mainnet (chain 196) is supported.

## Reading a report

Reports are JSON (schema 2). The fields a reviewer usually needs:

| Field | What it holds |
|---|---|
| `status`, `code`, `reason` | The decision, and for inconclusive results a machine-readable code and explanation |
| `comparison` | `method` (`exhaustive`, `identical-netlist` or `sampled`), `checked` and `space` (inputs checked out of all inputs), `mismatches`, and `firstMismatch` |
| `firstMismatch` | `packedInput`, `baselineOutput`, `candidateOutput` as LSB-first hex, and `changedBits` (output positions) |
| `replay` | `status` (`confirmed`, `disagrees`, `unavailable`, `not-applicable`), and what each processor returned |
| `block`, `pinning` | Block number, hash and timestamp, and how calls were pinned |
| `processors`, `factory`, `implementation` | Factory registration, whether the factory is sealed, and the circuit implementation behind the beacon |
| `dependencies` | Every circuit read, with dimensions, gate count, and SHA-256 and Keccak-256 of the netlist bytes |
| `tool`, `schema` | PinCheck version and report schema |

You can open any saved report, including the `pincheck-report` artifact from a GitHub run, on the [workbench](/#compare) with **Open a saved report**. It is read in your browser, so it stays readable even when no RPC can rerun it.

## Run it from the command line

PinCheck needs Node.js 22 or newer and has no dependencies.

```sh
git clone https://github.com/hackcat29/PinCheck && cd PinCheck
node cli.mjs 0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355:1 0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355:11
```

The report is printed as JSON. The exit code is `0` for compatible, `1` for a behavior or interface change, and `2` for inconclusive or invalid input. To reproduce a report exactly, pass its block hash:

```sh
node cli.mjs --block 0x5069ea174c5373b88fd00a9172a0303b10364083dd85eadb131c32ee5aa06a99 \
  0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355:1 0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355:11
```

Older blocks need an RPC that keeps historical state. Set `X_LAYER_RPC` to use a different X Layer mainnet endpoint; credentials in the URL are never written to reports or logs. If Node cannot reach the endpoint through a proxy, set `PINCHECK_RPC_TRANSPORT=curl`.
