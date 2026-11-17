# Add PinCheck to your repository

PinCheck adds one required check, **Circuit compatibility**, to your pull requests. When a pull request changes a circuit your X Layer app calls, the check compares the old and new circuit on mainnet and blocks the merge if any output changes. Setup takes three files and one branch rule, and needs no account, token or service.

## Install

You need a GitHub repository for an app that calls TapeOut circuits on X Layer mainnet, and admin access to it.

### 1. Pin the circuits your app calls

Create `pincheck.json` at the root of the repository. Name each circuit your app calls and give its processor address and circuit ID, exactly as your app uses them.

```json
{
  "pincheck": 1,
  "dependencies": {
    "order-guard": {
      "circuit": "0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355:1"
    }
  }
}
```

Before committing, check that PinCheck can read each circuit. Comparing a circuit with itself should print `"status": "compatible"`:

```sh
git clone https://github.com/hackcat29/PinCheck && cd PinCheck
node cli.mjs 0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355:1 0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355:1
```

### 2. Add the workflow

Create `.github/workflows/pincheck.yml`:

```yaml
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

The workflow needs only `contents: read`. It runs on pull requests from forks without secrets. Do not add a `paths:` filter: a required check that never starts leaves pull requests waiting forever. When `pincheck.json` is unchanged, the check passes in a few seconds without calling X Layer.

To use your own RPC endpoint, store its URL as a repository secret and add `rpc-url: ${{ secrets.X_LAYER_RPC }}` under `with:`. Secrets are not passed to pull requests from forks, so those runs use the public endpoint.

### 3. Require code-owner review for the pin and the check

Create `.github/CODEOWNERS` so that changes to the manifest and to workflows need approval from the people who own your circuit integration. Replace the team name with your own team or usernames.

```text
/pincheck.json        @your-org/circuit-owners
/.github/workflows/   @your-org/circuit-owners
/.github/CODEOWNERS   @your-org/circuit-owners
```

Commit the three files, open a pull request, and confirm that a check named **Circuit compatibility** appears and passes.

### 4. Require the check before merge

In your repository, open **Settings → Rules → Rulesets → New ruleset → New branch ruleset**, then:

1. Name it `PinCheck release gate`, set **Enforcement status** to **Active**, and under **Target branches** add **Include default branch**.
2. Turn on **Require a pull request before merging**. Under it, turn on **Require review from Code Owners**.
3. Turn on **Require status checks to pass**. Select **Add checks**, type `Circuit compatibility`, and choose the check from **GitHub Actions** as its source.
4. Select **Create**.

If you use a merge queue, the `merge_group` trigger in the workflow already runs the same check for queued merges.

> The ruleset can also be created with the GitHub CLI: `gh api repos/OWNER/REPO/rulesets --method POST --input ruleset.json`, using the JSON in [the example layout](https://github.com/hackcat29/PinCheck/tree/main/examples/consumer). `15368` is the GitHub Actions app, which binds the required check to Actions as its source.

### What you will see

When a pull request changes a pinned circuit, the job summary leads with the decision and the evidence:

```text
PinCheck blocked this merge: a circuit dependency changed behavior

| Dependency  | Change              | Result           | Coverage              | On-chain replay      |
| order-guard | 0x57f3…a355 #1 → #11 | Behavior changed | 4 of 4 inputs checked | Confirmed on X Layer |

First mismatch: input 0x01 → current output 0x01, candidate output 0x00.
```

It ends with the exact command to reproduce the result at the same block. The full JSON report is attached to the run as the `pincheck-report` artifact, even when the check fails. Open it on the [workbench](/#compare) with **Open a saved report**.

## Accept an intended change

Sometimes a circuit is upgraded on purpose and its behavior is supposed to change. Record the decision in `pincheck.json`, next to the new circuit, with the circuit it replaces and a reason:

```json
"order-guard": {
  "circuit": "0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355:11",
  "acceptChange": {
    "from": "0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355:1",
    "reason": "Reject single-signer payments, approved in #142"
  }
}
```

The check then passes and the summary shows **Behavior changed (accepted)** with the counterexample and your reason, so reviewers still see exactly what changes. Because CODEOWNERS covers `pincheck.json`, a code owner has to approve the acceptance, and git history keeps a record of who approved which version and why.

- `from` must match the circuit pinned on the base branch. An acceptance written for a different upgrade is ignored and the summary says so.
- An acceptance covers a known behavior or interface change, or a circuit PinCheck cannot prove (stateful, too wide, too large). It never covers a run that failed: RPC errors, a processor that disagrees with PinCheck, or a missing or malformed circuit keep the check failed.
- The entry stays harmless after merge. It only applies while the base branch pins the `from` circuit.

## How the check protects your branch

| Concern | How it is handled |
|---|---|
| Which baseline is trusted | The baseline is `pincheck.json` at the pull request's **base commit**, read through the GitHub API. The proposed manifest at the head commit is read the same way, parsed strictly as data, and validated. No code from the pull request runs. |
| Who decides what PinCheck version runs | The `uses: hackcat29/PinCheck@…` line in your workflow. For the strongest pin, use the full commit SHA of a release instead of the tag. |
| A pull request that edits the workflow | With `pull_request`, GitHub runs the workflow file from the pull request, so a contributor could weaken it. CODEOWNERS on `.github/workflows/` plus **Require review from Code Owners** means that edit needs a code owner's approval. Organizations that can use organization rulesets can also require this workflow centrally. |
| A different job posting a passing "Circuit compatibility" status | The ruleset accepts the status only from GitHub Actions. Code-owner review on workflows controls which Actions jobs exist. |
| Pull requests from forks | They run with a read-only token and no secrets, using the public X Layer RPC. PinCheck never uses `pull_request_target`, which GitHub blocks by default in public repositories from December 2, 2026. |
| Intended changes | `acceptChange` lives in the reviewed manifest, is bound to one exact transition, and is shown in every summary. There is no label or comment that skips the check. |
| RPC outages | An outage makes the check **Inconclusive**, which blocks the merge. Rerun the job when the RPC recovers, or set `rpc-url` to another endpoint. |

## Manifest reference

| Field | Required | Meaning |
|---|---|---|
| `pincheck` | yes | Manifest format version. Use `1`. |
| `chain` | no | `196`, X Layer mainnet, the only supported chain. |
| `description` | no | Free text. |
| `dependencies` | yes | Up to 16 named circuits. Names use letters, digits, `.`, `_` and `-`. |
| `dependencies.NAME.circuit` | yes | `processor-address:circuit-id`. The processor must be created by the X Layer TapeOut factory. |
| `dependencies.NAME.inputs` | no | Names for input bits, least significant bit first. Shown next to raw values in summaries. |
| `dependencies.NAME.outputs` | no | Names for output bits, least significant bit first. |
| `dependencies.NAME.acceptChange` | no | `{ "from": "processor:id", "reason": "…" }`. See [Accept an intended change](#accept-an-intended-change). |
| `dependencies.NAME.description` | no | Free text. |

Unknown fields are rejected, so a typo such as `acceptchange` fails the check instead of being ignored. A manifest from PinCheck 0.1 with a single `"circuit"` field is still accepted.

Adding a dependency passes, because there is no earlier behavior to break. Removing one passes with a note in the summary.

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
