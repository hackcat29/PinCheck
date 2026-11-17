# PinCheck

PinCheck checks whether an X Layer application can switch between two deployed TapeOut circuits without changing their outputs. It exhaustively compares supported stateless circuits and replays the first disagreement against the processors. A GitHub check can prevent a circuit manifest change from merging.

## Run locally

Use Node.js 22 or newer. There are no npm dependencies.

```sh
npm test
npm start
```

Open http://localhost:4173. Enter each circuit as `processor-address:circuit-id`, or click **Try a live mismatch** or **Try a compatible pair**. The workbench shows coverage, a counterexample if one exists, and an X Layer replay result. Export JSON for automation or copy the replay link to rerun at the same block. A historical replay requires an RPC that retains state at that block.

## CLI and CI

```sh
node cli.mjs --help
node cli.mjs --manifest demo/circuit.json demo/circuit.json
```

The CLI emits JSON and exits with 0 for compatible, 1 for a behavior or interface difference, or 2 for an inconclusive comparison. Use `--block 0xBLOCK` for a historical run. Set `X_LAYER_RPC` to use a different X Layer mainnet endpoint. In proxy environments where Node fetch cannot reach the endpoint, set `PINCHECK_RPC_TRANSPORT=curl` and ensure curl is installed.

The GitHub workflow compares the proposed `demo/circuit.json` against its base-branch version using the base-branch evaluator. It uploads the JSON report even when a compatibility check fails. Require **Circuit compatibility** in your branch rules to enforce it before merge. Teams that permit intentional changes can review them in their existing release approval process. The sample manifest identifies a public OrderGuard circuit on X Layer. PinCheck does not claim ownership of that processor or its circuits.

## How the result is produced

- Fetch both circuits and their supported REF dependencies at one X Layer block, validate the chain ID, and fingerprint the bytecode of each resolved netlist.
- Decode TAP-02 NAND and REF records, check dimensions and backward signal references, and reject stateful circuits or graphs that exceed resource limits.
- Compare every input for roots with up to eight input bits. TAP-02 packs vectors least-significant bit first. A report includes the count checked, number of differing inputs, the first differing input, and changed output positions.
- Replay the first mismatch through both deployed processors using read-only `eth_call`. A processor result that disagrees with the local evaluator makes the comparison inconclusive. An unavailable replay is recorded distinctly and the release still fails for the mismatch.
- Recheck the block hash after the comparison to detect a block change during the run.

A compatible result applies to the recorded snapshot and the raw TAP-02 bit interface. PinCheck cannot infer that two teams assigned the same business meaning to a bit. Two circuits can also share a bug. The tool requires a trusted RPC and gives callers explicit coverage and chain evidence for independent reproduction.

## References

- [TapeOut TAP-02 netlist and processor interfaces](https://github.com/TapeOutProtocol/TAPs/blob/main/TAPs/TAP-02.md)
- [OrderGuard public circuit deployment](https://github.com/0xdopewilly/fusebox#live-on-x-layer-mainnet-chain-196)

## Reproduce the release demo

Both examples use the public OrderGuard processor on X Layer. Start from circuit **#1** in the sample manifest. Compare it with **#11** to see the rejected change and with **#2** to see an accepted replacement. The first pair disagrees at input `0x01`. The second pair shares the same netlist. The separate **#5 → #9** workbench example checks 16 inputs and replays the mismatch at `0x05`.

- [Incompatible live comparison report](demo/incompatible.json)
- [Compatible live comparison report](demo/compatible.json)
