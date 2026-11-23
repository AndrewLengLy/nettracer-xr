// Hands the scan to the headset: a 6-character code from the share API, plus a backup link
// that carries the whole topology in the URL fragment (the part after #, which browsers never send to a server).
import { deflateRawSync } from 'node:zlib';

export const MAX_BYTES = 64 * 1024;

export function fragmentLink(base, topology) {
  const packed = deflateRawSync(Buffer.from(JSON.stringify(topology), 'utf8'), { level: 9 }).toString('base64url');
  return `${base.replace(/\/+$/, '')}/#scan=${packed}`;
}

/** Upload to /api/share. Resolves { code, expiresIn } or throws with a plain-language message. */
export async function upload(base, topology) {
  const body = JSON.stringify(topology);
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error(`The scan is ${Math.round(Buffer.byteLength(body) / 1024)} KB. The share limit is 64 KB.`);
  let res;
  try {
    res = await fetch(`${base.replace(/\/+$/, '')}/api/share`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new Error(`Could not reach ${base} (${e.cause?.code || e.name}).`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The share API answered ${res.status}.`);
  return data;
}
