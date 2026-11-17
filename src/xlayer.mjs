import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { compare } from './compare.mjs';

export const defaultRpc = 'https://rpc.xlayer.tech';
const word = value => BigInt(value).toString(16).padStart(64, '0');

export function reference(value) {
  const match = /^((?:0x)[0-9a-f]{40}):([1-9][0-9]{0,77})$/i.exec(value ?? '');
  if (!match || BigInt(match[2]) >= 2n ** 256n) throw new Error('Use a processor address followed by a colon and a positive circuit ID');
  return { address: match[1].toLowerCase(), id: match[2] };
}

function decodeBytes(value) {
  if (value.length < 128 || value.slice(0, 64) !== word(32)) throw new Error('Unexpected processor ABI response');
  const length = Number(BigInt('0x' + value.slice(64, 128)));
  if (value.length !== 128 + Math.ceil(length / 32) * 64) throw new Error('Malformed processor byte response');
  return '0x' + value.slice(128, 128 + length * 2);
}

export async function compareOnChain(baseline, candidate, { url = defaultRpc, block = 'latest' } = {}) {
  const report = { schema: 1, evaluator: 'pincheck/0.1.0 TAP-02 stateless', chainId: 196, baseline, candidate };
  const budget = AbortSignal.timeout(60000);
  let id = 0;
  async function rpc(method, params) {
    const requestId = ++id;
    const payload = JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params });
    const signal = AbortSignal.any([budget, AbortSignal.timeout(15000)]);
    let body;
    if (process.env.PINCHECK_RPC_TRANSPORT === 'curl') {
      const { stdout } = await promisify(execFile)('curl', [
        '--disable', '--silent', '--show-error', '--fail', '--max-time', '14',
        '--header', 'content-type: application/json', '--data-binary', payload, '--', url,
      ], { signal, maxBuffer: 2_000_000 });
      body = JSON.parse(stdout);
    } else {
      const response = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, signal,
      });
      if (!response.ok) throw new Error('X Layer RPC returned HTTP ' + response.status);
      body = await response.json();
    }
    if (body.id !== requestId || body.error || body.result == null) throw new Error(body.error?.message ?? 'Missing RPC result');
    return body.result;
  }
  try {
    if (block !== 'latest' && !/^0x[0-9a-f]+$/i.test(block)) throw new Error('Block must be latest or a hexadecimal block number');
    const [chainId, snapshot] = await Promise.all([rpc('eth_chainId', []), rpc('eth_getBlockByNumber', [block, false])]);
    if (BigInt(chainId) !== 196n) throw new Error('RPC is not X Layer mainnet (196)');
    report.block = { number: snapshot.number, hash: snapshot.hash };
    const call = async (address, data) => {
      const value = await rpc('eth_call', [{ to: address, data: '0x' + data }, snapshot.number]);
      if (!/^0x(?:[a-f0-9]{2})*$/i.test(value)) throw new Error('Invalid eth_call response');
      return value.slice(2).toLowerCase();
    };
    async function read({ address, id }) {
      const [info, bytes] = await Promise.all([call(address, '084d60f1' + word(id)), call(address, '3fc4be56' + word(id))]);
      if (info.length !== 256) throw new Error('Unexpected circuitInfo response');
      const [nIn, nOut, nState] = [0, 64, 128].map(offset => Number(BigInt('0x' + info.slice(offset, offset + 64))));
      return { nIn, nOut, nState, netlist: decodeBytes(bytes) };
    }
    const { dependencies, ...result } = await compare(read, baseline, candidate);
    Object.assign(report, result);
    if (dependencies) {
      report.dependencies = Object.fromEntries(Object.entries(dependencies).map(([key, { netlist, ...info }]) => [
        key, { ...info, sha256: createHash('sha256').update(Buffer.from(netlist.slice(2), 'hex')).digest('hex') },
      ]));
    }
    if (result.firstMismatch) {
      const bytes = result.firstMismatch.packedInput.slice(2);
      const args = word(64) + word(bytes.length / 2) + bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0');
      const evaluate = async ({ address, id }) => decodeBytes(await call(address, '934d06ea' + word(id) + args));
      try {
        const [oldOutput, newOutput] = await Promise.all([evaluate(baseline), evaluate(candidate)]);
        const confirmed = oldOutput === result.firstMismatch.baselineOutput && newOutput === result.firstMismatch.candidateOutput;
        report.replay = { status: confirmed ? 'confirmed' : 'disagrees', baselineOutput: oldOutput, candidateOutput: newOutput };
        if (!confirmed) {
          report.status = 'inconclusive';
          report.reason = 'Processor evaluation disagreed with the local evaluator';
        }
      } catch (error) {
        report.replay = { status: 'unavailable', reason: error.message };
      }
    }
    const canonical = await rpc('eth_getBlockByNumber', [snapshot.number, false]);
    if (canonical.hash !== snapshot.hash) throw new Error('Comparison block changed during the run');
    return report;
  } catch (error) {
    return { ...report, status: 'inconclusive', reason: error.message };
  }
}
