// POST /api/share   stores a scan for 15 minutes and returns a 6-character code.
// GET  /api/share?code=ABC234   returns the scan while the code is alive.
import { handleShare, redisFromEnv } from './_share-core.js';

async function handle(request: Request): Promise<Response> {
  try {
    return await handleShare(request, redisFromEnv(process.env));
  } catch {
    return new Response(JSON.stringify({ error: 'The share service had a problem. Try again in a minute.' }), {
      status: 502,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
}

export const GET = handle;
export const POST = handle;
