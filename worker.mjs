// Cloudflare Worker: /api/* runs PinCheck; everything else is static files built into dist/ (npm run build).
import { createApi, SECURITY_HEADERS } from './src/api.mjs';

let api;

export default {
  async fetch(request, env) {
    api ??= createApi({
      rpc: env.X_LAYER_RPC || undefined,
      maxActive: Number(env.PINCHECK_MAX_CONCURRENCY ?? 4),
      log: event => console.log(JSON.stringify(event)),
    });
    const url = new URL(request.url);
    const client = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const result = await api.handle(request.method, url.pathname, url.searchParams, client);
    if (!result) return env.ASSETS.fetch(request);
    return new Response(request.method === 'HEAD' ? null : JSON.stringify(result.body), {
      status: result.status,
      headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...result.headers },
    });
  },
};
