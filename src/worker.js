// API do painel Geleias da Beca.
// Roda no Cloudflare Workers, guarda os dados no D1 (binding DB) e só responde
// a quem passou pelo Cloudflare Access (JWT verificado). Sem Access configurado, a API fecha (503).

const COLLECTIONS = new Set(['lancamentos', 'config']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY = 32 * 1024;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/* ---------- Cloudflare Access ---------- */

let certCache = { at: 0, keys: null };

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function accessKeys(env) {
  if (certCache.keys && Date.now() - certCache.at < 3600 * 1000) return certCache.keys;
  const r = await fetch(`https://${env.TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error('certs');
  const { keys } = await r.json();
  certCache = { at: Date.now(), keys };
  return keys;
}

async function verifyAccess(request, env) {
  if (!env.TEAM_DOMAIN || !env.POLICY_AUD) return { error: 'access_not_configured', status: 503 };
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  const denied = { error: 'unauthorized', status: 401 };
  if (!token) return denied;
  const parts = token.split('.');
  if (parts.length !== 3) return denied;
  try {
    const dec = new TextDecoder();
    const header = JSON.parse(dec.decode(b64urlToBytes(parts[0])));
    const payload = JSON.parse(dec.decode(b64urlToBytes(parts[1])));
    if (header.alg !== 'RS256') return denied;
    const jwk = (await accessKeys(env)).find((k) => k.kid === header.kid);
    if (!jwk) return denied;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(parts[0] + '.' + parts[1])
    );
    if (!ok) return denied;
    const now = Math.floor(Date.now() / 1000);
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.POLICY_AUD)) return denied;
    if (payload.iss !== `https://${env.TEAM_DOMAIN}`) return denied;
    if (payload.exp && payload.exp < now) return denied;
    if (payload.nbf && payload.nbf > now + 60) return denied;
    return { email: payload.email || '' };
  } catch (e) {
    return denied;
  }
}

/* ---------- API ---------- */

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) return { status: 413 };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 400 };
    return { value };
  } catch (e) {
    return { status: 400 };
  }
}

async function handleApi(request, env, url) {
  const auth = await verifyAccess(request, env);
  if (auth.error) return json({ error: auth.error }, auth.status);

  const method = request.method;
  // Escritas exigem este cabeçalho: outro site não consegue enviá-lo sem pedido de permissão (CORS).
  if (method !== 'GET' && request.headers.get('x-requested-with') !== 'geleias') return json({ error: 'forbidden' }, 403);

  const [, kind, collection, id] = url.pathname.split('/').filter(Boolean).concat([undefined, undefined, undefined, undefined]);
  if (!COLLECTIONS.has(collection)) return json({ error: 'not_found' }, 404);

  if (kind === 'c' && method === 'GET' && !id) {
    const { results } = await env.DB.prepare('SELECT id, data FROM docs WHERE collection = ?1 ORDER BY updated_at DESC, id LIMIT 5000')
      .bind(collection)
      .all();
    return json({ docs: results.map((r) => ({ id: r.id, data: JSON.parse(r.data) })) });
  }

  if (kind === 'd' && id && ID_RE.test(id)) {
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM docs WHERE collection = ?1 AND id = ?2').bind(collection, id).run();
      return new Response(null, { status: 204 });
    }
    if (method === 'PUT' || method === 'PATCH') {
      const body = await readBody(request);
      if (body.status) return json({ error: 'invalid_body' }, body.status);
      let data = body.value;
      if (method === 'PATCH') {
        const row = await env.DB.prepare('SELECT data FROM docs WHERE collection = ?1 AND id = ?2').bind(collection, id).first();
        if (!row) return json({ error: 'not_found' }, 404);
        data = Object.assign(JSON.parse(row.data), data);
      }
      await env.DB.prepare(
        'INSERT INTO docs (collection, id, data, updated_at) VALUES (?1, ?2, ?3, ?4) ' +
          'ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
      )
        .bind(collection, id, JSON.stringify(data), Date.now())
        .run();
      return new Response(null, { status: 204 });
    }
  }
  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        return json({ error: 'server_error' }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
