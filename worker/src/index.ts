/* ============================================================================
   Authenticated upload/delete proxy for the "finding-photos" R2 bucket.

   Deliberately minimal: this Worker never touches R2 access keys (env.PHOTO_BUCKET
   below is a native binding, not the S3-compatible API), and it never touches any
   Supabase secret either — it confirms the caller is logged in by asking Supabase's
   own /auth/v1/user endpoint, using the same publishable key already committed in
   src/core/supabase.ts. No secrets live in this Worker at all.

   Reads are NOT handled here — the R2 bucket is public (r2.dev), so the app fetches
   photos directly from R2's public URL, same as it did with Supabase Storage before.
   ============================================================================ */

export interface Env {
  PHOTO_BUCKET: R2Bucket;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
}

const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:4173',
  'https://pipeassessor.onrender.com'
];

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Object keys this Worker ever writes/deletes: "{findingId}/{uuid}.jpg" — validated on every
// request so an authenticated-but-malicious caller can't write/delete arbitrary R2 keys
// (every authenticated user has full CRUD in this app's data model, same as Supabase RLS
// today — this regex is just basic sanity, not a stricter permission model).
const KEY_RE = /^[0-9a-fA-F-]{36}\/[0-9a-fA-F-]{36}\.jpg$/;

function corsHeaders(origin: string | null): HeadersInit {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
  });
}

async function verifyUser(request: Request, env: Env): Promise<boolean> {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return false;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: env.SUPABASE_ANON_KEY }
  });
  return res.ok;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method === 'GET' && url.pathname === '/photo') {
      const path = url.searchParams.get('path') || '';
      if (!KEY_RE.test(path)) return new Response('invalid path', { status: 400, headers: corsHeaders(origin) });
      const object = await env.PHOTO_BUCKET.get(path);
      if (!object) return new Response('not found', { status: 404, headers: corsHeaders(origin) });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('etag', object.httpEtag);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      return new Response(object.body, { headers });
    }

    if (request.method !== 'POST') {
      return json({ error: 'not found' }, 404, origin);
    }
    if (!(await verifyUser(request, env))) {
      return json({ error: 'unauthorized' }, 401, origin);
    }

    if (url.pathname === '/upload') {
      const findingId = url.searchParams.get('findingId') || '';
      if (!UUID_RE.test(findingId)) return json({ error: 'invalid findingId' }, 400, origin);
      if (!request.body) return json({ error: 'missing body' }, 400, origin);
      const key = `${findingId}/${crypto.randomUUID()}.jpg`;
      await env.PHOTO_BUCKET.put(key, request.body, { httpMetadata: { contentType: 'image/jpeg' } });
      return json({ path: key }, 200, origin);
    }

    if (url.pathname === '/delete') {
      let body: { paths?: unknown };
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400, origin); }
      const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === 'string') : [];
      if (!paths.length || paths.length > 20 || !paths.every(p => KEY_RE.test(p))) {
        return json({ error: 'invalid paths' }, 400, origin);
      }
      await Promise.all(paths.map(p => env.PHOTO_BUCKET.delete(p)));
      return json({ ok: true }, 200, origin);
    }

    return json({ error: 'not found' }, 404, origin);
  }
};
