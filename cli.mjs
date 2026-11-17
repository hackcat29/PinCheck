import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { compareOnChain, reference } from './src/xlayer.mjs';

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { block: { type: 'string' }, manifest: { type: 'boolean' }, help: { type: 'boolean' } },
  });
  if (values.help) {
    console.log('node cli.mjs [--block 0xBLOCK] BASELINE CANDIDATE\nnode cli.mjs --manifest BASELINE.json CANDIDATE.json');
  } else {
    if (positionals.length !== 2) throw new Error('Supply two circuit references or two manifest files. See --help.');
    const refs = values.manifest ? await Promise.all(positionals.map(async path => {
      const document = JSON.parse(await readFile(path, 'utf8'));
      return reference(document.circuit);
    })) : positionals.map(reference);
    const result = await compareOnChain(...refs, { url: process.env.X_LAYER_RPC, block: values.block });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = { compatible: 0, 'behavior-changed': 1, 'interface-mismatch': 1, inconclusive: 2 }[result.status];
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
