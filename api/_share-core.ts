// Logic for /api/share, kept free of Vercel specifics so it can be unit tested.
// Storage is Upstash Redis over its REST API. Every key expires after 15 minutes.

export const MAX_BYTES = 64 * 1024;
export const TTL_SECONDS = 15 * 60;
/** No 0/O, 1/I/L: easy to read on a headset keypad. 31^6 is about 887 million codes. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{6}$`);

export interface Redis {
  /** SET key value EX ttl NX. Resolves true when the key was new. */
  setNx(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
}

export function newCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const out: string[] = [];
  while (out.length < 6) {
    for (const b of random(12)) {
      // Rejection sampling keeps every character equally likely.
      if (b < 248 && out.length < 6) out.push(CODE_ALPHABET[b % 31]);
    }
  }
  return out.join('');
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/** Light shape check: a net-core topology with a devices map. */
function looksLikeTopology(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const d = (v as { devices?: unknown }).devices;
  return !!d && typeof d === 'object' && Object.keys(d).length > 0 && Object.keys(d).length <= 300;
}

export async function handleShare(req: Request, redis: Redis | null): Promise<Response> {
  if (!redis) return json(503, { error: 'Sharing is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.' });

  if (req.method === 'POST') {
    const declared = Number(req.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) return json(413, { error: 'The scan is larger than 64 KB.' });
    const text = await req.text();
    if (new TextEncoder().encode(text).length > MAX_BYTES) return json(413, { error: 'The scan is larger than 64 KB.' });
    let body: unknown;
    try { body = JSON.parse(text); } catch { return json(400, { error: 'The body is not JSON.' }); }
    if (!looksLikeTopology(body)) return json(400, { error: 'The body is not a NetTracer topology.' });
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newCode();
      if (await redis.setNx(`scan:${code}`, text, TTL_SECONDS)) return json(201, { code, expiresIn: TTL_SECONDS });
    }
    return json(503, { error: 'Could not pick a free code. Try again.' });
  }

  if (req.method === 'GET') {
    const code = (new URL(req.url).searchParams.get('code') || '').toUpperCase();
    if (!CODE_RE.test(code)) return json(400, { error: 'A code is 6 letters and numbers.' });
    const value = await redis.get(`scan:${code}`);
    if (!value) return json(404, { error: 'That code has expired or does not exist. Run the scanner again.' });
    return new Response(value, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }

  return json(405, { error: 'Use POST to share or GET ?code= to fetch.' });
}

/** Upstash REST client. Accepts the Upstash names or the Vercel KV marketplace names. */
export function redisFromEnv(env: Record<string, string | undefined>): Redis | null {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const call = async (cmd: (string | number)[]) => {
    const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(cmd) });
    if (!res.ok) throw new Error(`Redis ${res.status}`);
    return ((await res.json()) as { result: unknown }).result;
  };
  return {
    setNx: async (key, value, ttl) => (await call(['SET', key, value, 'EX', ttl, 'NX'])) === 'OK',
    get: async (key) => ((await call(['GET', key])) as string | null) ?? null,
  };
}
