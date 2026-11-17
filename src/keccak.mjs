// Keccak-256 (the Ethereum variant, 0x01 padding) over 32-bit lane halves. Dependency-free.
const RC = [
  [0x00000001, 0x00000000], [0x00008082, 0x00000000], [0x0000808a, 0x80000000], [0x80008000, 0x80000000],
  [0x0000808b, 0x00000000], [0x80000001, 0x00000000], [0x80008081, 0x80000000], [0x00008009, 0x80000000],
  [0x0000008a, 0x00000000], [0x00000088, 0x00000000], [0x80008009, 0x00000000], [0x8000000a, 0x00000000],
  [0x8000808b, 0x00000000], [0x0000008b, 0x80000000], [0x00008089, 0x80000000], [0x00008003, 0x80000000],
  [0x00008002, 0x80000000], [0x00000080, 0x80000000], [0x0000800a, 0x00000000], [0x8000000a, 0x80000000],
  [0x80008081, 0x80000000], [0x00008080, 0x80000000], [0x80000001, 0x00000000], [0x80008008, 0x80000000],
];
const ROTATION = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const RATE = 136;

function permute(lo, hi) {
  const cLo = new Int32Array(5), cHi = new Int32Array(5), bLo = new Int32Array(25), bHi = new Int32Array(25);
  for (const [rcLo, rcHi] of RC) {
    for (let x = 0; x < 5; x++) {
      cLo[x] = lo[x] ^ lo[x + 5] ^ lo[x + 10] ^ lo[x + 15] ^ lo[x + 20];
      cHi[x] = hi[x] ^ hi[x + 5] ^ hi[x + 10] ^ hi[x + 15] ^ hi[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const nLo = cLo[(x + 1) % 5], nHi = cHi[(x + 1) % 5];
      const dLo = cLo[(x + 4) % 5] ^ ((nLo << 1) | (nHi >>> 31));
      const dHi = cHi[(x + 4) % 5] ^ ((nHi << 1) | (nLo >>> 31));
      for (let y = 0; y < 25; y += 5) { lo[y + x] ^= dLo; hi[y + x] ^= dHi; }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const from = x + 5 * y, to = y + 5 * ((2 * x + 3 * y) % 5), r = ROTATION[from];
        const l = lo[from], h = hi[from];
        if (r === 0) { bLo[to] = l; bHi[to] = h; }
        else if (r < 32) { bLo[to] = (l << r) | (h >>> (32 - r)); bHi[to] = (h << r) | (l >>> (32 - r)); }
        else if (r === 32) { bLo[to] = h; bHi[to] = l; }
        else { const m = r - 32; bLo[to] = (h << m) | (l >>> (32 - m)); bHi[to] = (l << m) | (h >>> (32 - m)); }
      }
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        lo[y + x] = bLo[y + x] ^ (~bLo[y + (x + 1) % 5] & bLo[y + (x + 2) % 5]);
        hi[y + x] = bHi[y + x] ^ (~bHi[y + (x + 1) % 5] & bHi[y + (x + 2) % 5]);
      }
    }
    lo[0] ^= rcLo;
    hi[0] ^= rcHi;
  }
}

export function keccak256(bytes) {
  const length = bytes.length;
  const padded = new Uint8Array((Math.floor(length / RATE) + 1) * RATE);
  padded.set(bytes);
  padded[length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const lo = new Int32Array(25), hi = new Int32Array(25);
  const view = new DataView(padded.buffer);
  for (let offset = 0; offset < padded.length; offset += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      lo[i] ^= view.getUint32(offset + 8 * i, true);
      hi[i] ^= view.getUint32(offset + 8 * i + 4, true);
    }
    permute(lo, hi);
  }
  const out = new DataView(new ArrayBuffer(32));
  for (let i = 0; i < 4; i++) { out.setUint32(8 * i, lo[i], true); out.setUint32(8 * i + 4, hi[i], true); }
  return Array.from(new Uint8Array(out.buffer), byte => byte.toString(16).padStart(2, '0')).join('');
}
