// pincheck.json: the circuits a repository depends on. See docs/manifest.md.
import { reference } from './xlayer.mjs';

export const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_DEPENDENCIES = 16;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export class ManifestError extends Error {
  constructor(message, source) {
    super((source ? source + ': ' : '') + message);
    this.code = 'invalid-manifest';
  }
}

export function emptyManifest() {
  return { version: 1, chainId: 196, dependencies: new Map(), legacy: false };
}

export function parseManifest(text, source = 'pincheck.json') {
  if (typeof text !== 'string') throw new ManifestError('Manifest must be text', source);
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new ManifestError('Manifest is larger than 64 KB', source);
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new ManifestError('Not valid JSON (' + error.message + ')', source);
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new ManifestError('Manifest must be a JSON object', source);

  // v0.1 manifests held a single "circuit" field.
  if (Object.keys(document).length === 1 && typeof document.circuit === 'string') {
    return { version: 1, chainId: 196, legacy: true, dependencies: new Map([['circuit', { name: 'circuit', circuit: ref(document.circuit, 'circuit', source) }]]) };
  }
  allowKeys(document, ['$schema', 'pincheck', 'chain', 'description', 'dependencies'], 'manifest', source);
  if (document.pincheck !== 1) throw new ManifestError('Set "pincheck": 1', source);
  if (document.chain !== undefined && document.chain !== 196) throw new ManifestError('"chain" must be 196 (X Layer mainnet)', source);
  const entries = document.dependencies;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new ManifestError('"dependencies" must be an object of named circuits', source);
  const names = Object.keys(entries);
  if (names.length > MAX_DEPENDENCIES) throw new ManifestError('At most ' + MAX_DEPENDENCIES + ' dependencies are supported', source);
  const dependencies = new Map();
  for (const name of names) {
    if (!NAME.test(name)) throw new ManifestError('Dependency name "' + name.slice(0, 64) + '" must use letters, digits, ".", "_" or "-"', source);
    const entry = entries[name];
    const where = 'dependencies.' + name;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ManifestError(where + ' must be an object', source);
    allowKeys(entry, ['circuit', 'description', 'inputs', 'outputs', 'acceptChange'], where, source);
    const dependency = { name, circuit: ref(entry.circuit, where + '.circuit', source) };
    for (const field of ['inputs', 'outputs']) {
      if (entry[field] === undefined) continue;
      const list = entry[field];
      if (!Array.isArray(list) || list.length > 256 || !list.every(item => typeof item === 'string' && item.length <= 64)) {
        throw new ManifestError(where + '.' + field + ' must be a list of up to 256 names, least significant bit first', source);
      }
      dependency[field] = list;
    }
    if (entry.acceptChange !== undefined) {
      const accept = entry.acceptChange;
      if (!accept || typeof accept !== 'object' || Array.isArray(accept)) throw new ManifestError(where + '.acceptChange must be an object', source);
      allowKeys(accept, ['from', 'reason'], where + '.acceptChange', source);
      if (typeof accept.reason !== 'string' || accept.reason.trim().length < 3 || accept.reason.length > 500) {
        throw new ManifestError(where + '.acceptChange.reason must explain the decision (3-500 characters)', source);
      }
      dependency.acceptChange = { from: ref(accept.from, where + '.acceptChange.from', source), reason: accept.reason.trim() };
    }
    dependencies.set(name, dependency);
  }
  return { version: 1, chainId: 196, legacy: false, dependencies };
}

function ref(value, where, source) {
  try {
    return reference(value);
  } catch {
    throw new ManifestError(where + ' must be "processor-address:circuit-id"', source);
  }
}

function allowKeys(object, allowed, where, source) {
  const unknown = Object.keys(object).filter(key => !allowed.includes(key));
  if (unknown.length) throw new ManifestError('Unknown field ' + JSON.stringify(unknown[0]) + ' in ' + where, source);
}

export const sameRef = (a, b) => !!a && !!b && a.address === b.address && a.id === b.id;
