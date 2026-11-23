import { describe, expect, it } from 'vitest';
import { CODE_RE, MAX_BYTES, handleShare, newCode, type Redis } from './_share-core';

function memory(): Redis & { ttl: Record<string, number> } {
  const m = new Map<string, string>();
  const ttl: Record<string, number> = {};
  return {
    ttl,
    async setNx(k, v, t) { if (m.has(k)) return false; m.set(k, v); ttl[k] = t; return true; },
    async get(k) { return m.get(k) ?? null; },
  };
}
const topo = JSON.stringify({ vlans: false, hsrp: false, tls: false, devices: { pc: { id: 'pc', type: 'laptop', name: 'PC' } } });
const post = (body: string) => new Request('https://x.test/api/share', { method: 'POST', body, headers: { 'content-type': 'application/json' } });

describe('/api/share', () => {
  it('stores a scan for 15 minutes and returns it by code', async () => {
    const r = memory();
    const res = await handleShare(post(topo), r);
    expect(res.status).toBe(201);
    const { code, expiresIn } = await res.json();
    expect(code).toMatch(CODE_RE);
    expect(expiresIn).toBe(900);
    expect(Object.values(r.ttl)).toEqual([900]);
    const got = await handleShare(new Request(`https://x.test/api/share?code=${code.toLowerCase()}`), r);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe(topo);
  });

  it('rejects payloads over 64 KB', async () => {
    const big = JSON.stringify({ devices: { a: { pad: 'x'.repeat(MAX_BYTES) } } });
    expect((await handleShare(post(big), memory())).status).toBe(413);
  });

  it('rejects bodies that are not topologies', async () => {
    expect((await handleShare(post('{"hello":1}'), memory())).status).toBe(400);
    expect((await handleShare(post('not json'), memory())).status).toBe(400);
  });

  it('answers 404 for unknown codes and 400 for malformed ones', async () => {
    expect((await handleShare(new Request('https://x.test/api/share?code=ABCDEF'), memory())).status).toBe(404);
    expect((await handleShare(new Request('https://x.test/api/share?code=AB0'), memory())).status).toBe(400);
  });

  it('says so when Redis is not configured', async () => {
    expect((await handleShare(post(topo), null)).status).toBe(503);
  });

  it('makes codes from the readable alphabet only', () => {
    for (let i = 0; i < 200; i++) expect(newCode()).toMatch(CODE_RE);
  });
});
