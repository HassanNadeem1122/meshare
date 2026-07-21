// meshare share registry + R2 backup fallback.
// KV (SHARES): meta/<fileId> JSON - name, size, expiry, revoked, passwordHash, ownerToken.
// R2 (BUCKET, optional until enabled): files/<fileId> blob backup.
// Static app assets are served via the ASSETS binding for non-/api/ routes.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Owner-Token'
};

// Durable, cross-isolate rate limiting. One DO instance per
// route+IP; each stores a single fixed-window counter, so idle objects
// cost nothing and there's no cleanup to run.
export class RateLimiter {
  constructor(state) { this.state = state; }
  async fetch(request) {
    const { limit, windowMs } = await request.json();
    const now = Date.now();
    const bucket = Math.floor(now / windowMs);
    let rec = await this.state.storage.get('w');
    if (!rec || rec.bucket !== bucket) rec = { bucket, count: 0 };
    rec.count++;
    await this.state.storage.put('w', rec);
    return new Response(JSON.stringify({
      allowed: rec.count <= limit,
      remaining: Math.max(0, limit - rec.count),
      resetMs: (bucket + 1) * windowMs - now
    }));
  }
}

async function rateLimit(env, route, request, limit, windowMs) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  try {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`${route}:${ip}`));
    const res = await stub.fetch('https://rl/', {
      method: 'POST',
      body: JSON.stringify({ limit, windowMs })
    });
    return await res.json();
  } catch {
    // Rate limiter unavailable must never take the product down.
    return { allowed: true, remaining: -1, degraded: true };
  }
}

function tooMany(rl) {
  return json(
    { error: `rate limited - try again in ${Math.ceil((rl.resetMs || 60000) / 1000)}s` },
    429,
    { 'Retry-After': String(Math.ceil((rl.resetMs || 60000) / 1000)) }
  );
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra }
  });
}

const ID_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function randomId(len = 8) {
  const b = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(b, x => ALPHABET[x % ALPHABET.length]).join('');
}

function shareStatus(meta) {
  if (meta.revoked) return 'revoked';
  if (meta.expiresAt && Date.now() > meta.expiresAt) return 'expired';
  return 'active';
}

async function getMeta(env, fileId) {
  const raw = await env.SHARES.get(`meta/${fileId}`);
  return raw ? JSON.parse(raw) : null;
}

async function putMeta(env, meta) {
  await env.SHARES.put(`meta/${meta.fileId}`, JSON.stringify(meta));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const parts = url.pathname.split('/').filter(Boolean); // ['api','shares',id?,'blob'?]
    if (parts[1] !== 'shares') return json({ error: 'not found' }, 404);
    const fileId = parts[2] ? parts[2].toLowerCase() : null;
    const sub = parts[3] || null;

    try {
      // POST /api/shares - register a share (custom or random name)
      if (request.method === 'POST' && !fileId) {
        const rl = await rateLimit(env, 'register', request, 10, 3600000);
        if (!rl.allowed) return tooMany(rl);
        const body = await request.json().catch(() => ({}));
        if (!body.fileName || !Number.isFinite(body.size)) {
          return json({ error: 'fileName and size are required' }, 400);
        }
        let id;
        if (body.name) {
          id = String(body.name).toLowerCase();
          if (!ID_RE.test(id)) {
            return json({ error: 'invalid name: use 3-40 chars, lowercase letters, digits and dashes, starting with a letter or digit' }, 400);
          }
          const existing = await getMeta(env, id);
          const existingStatus = existing ? shareStatus(existing) : null;
          // Active names collide; revoked names are retired forever so a link the
          // previous owner circulated can never be hijacked to serve new content.
          // Only natural expiry frees a name for reuse.
          if (existingStatus === 'active' || existingStatus === 'revoked') {
            const suggestions = [`${id}-2`, `${id}-${randomId(4)}`, `${id}-${new Date().getFullYear()}`];
            const reason = existingStatus === 'active'
              ? `name "${id}" is already taken by an active share`
              : `name "${id}" was revoked by its previous owner and is permanently retired`;
            return json({ error: reason, suggestions }, 409);
          }
        } else {
          do { id = randomId(); } while (await getMeta(env, id));
        }
        const expiresDays = body.expiresDays === undefined ? 7 : Number(body.expiresDays);
        if (!Number.isFinite(expiresDays) || expiresDays < 0 || expiresDays > 365) {
          return json({ error: 'expiresDays must be 0-365' }, 400);
        }
        const meta = {
          fileId: id,
          kind: body.kind === 'site' ? 'site' : 'file',
          fileName: String(body.fileName).slice(0, 200),
          size: body.size,
          mime: String(body.mime || 'application/octet-stream').slice(0, 100),
          createdAt: Date.now(),
          expiresAt: expiresDays === 0 ? Date.now() : Date.now() + expiresDays * 86400000,
          revoked: false,
          passwordHash: body.passwordHash ? String(body.passwordHash).slice(0, 64) : null,
          ownerToken: randomId(24),
          r2: false
        };
        await putMeta(env, meta);
        return json({
          fileId: id,
          ownerToken: meta.ownerToken,
          expiresAt: meta.expiresAt,
          link: `${url.origin}/#${id}`
        }, 201);
      }

      if (!fileId) return json({ error: 'not found' }, 404);
      const meta = await getMeta(env, fileId);
      if (!meta) return json({ error: 'unknown share' }, 404);
      const status = shareStatus(meta);

      // GET /api/shares/:id - public metadata (enforces expiry/revocation)
      if (request.method === 'GET' && !sub) {
        return json({
          fileId: meta.fileId,
          kind: meta.kind || 'file',
          fileName: meta.fileName,
          size: meta.size,
          mime: meta.mime,
          status,
          hasPassword: !!meta.passwordHash,
          r2Available: !!meta.r2 && !!env.BUCKET,
          expiresAt: meta.expiresAt,
          createdAt: meta.createdAt
        });
      }

      // PUT /api/shares/:id/blob - owner uploads backup copy to R2
      if (request.method === 'PUT' && sub === 'blob') {
        const rl = await rateLimit(env, 'upload', request, 10, 3600000);
        if (!rl.allowed) return tooMany(rl);
        if (request.headers.get('X-Owner-Token') !== meta.ownerToken) return json({ error: 'bad owner token' }, 403);
        if (status !== 'active') return json({ error: `share is ${status}` }, 410);
        if (!env.BUCKET) return json({ error: 'backup storage unavailable: R2 is not enabled on this deployment yet' }, 503);
        const max = Number(env.MAX_BLOB_BYTES) || 2147483648;
        const len = Number(request.headers.get('Content-Length') || meta.size);
        if (len > max) return json({ error: `file too large for backup: ${len} bytes exceeds the ${max}-byte cap` }, 413);
        try {
          await env.BUCKET.put(`files/${fileId}`, request.body, {
            httpMetadata: { contentType: meta.mime }
          });
        } catch (e) {
          return json({ error: `R2 upload failed: ${e.message}` }, 502);
        }
        meta.r2 = true;
        await putMeta(env, meta);
        return json({ ok: true, r2: true });
      }

      // GET /api/shares/:id/blob - R2 fallback download (password-gated)
      if (request.method === 'GET' && sub === 'blob') {
        const rl = await rateLimit(env, 'download', request, 60, 3600000);
        if (!rl.allowed) return tooMany(rl);
        if (status !== 'active') return json({ error: `share is ${status}` }, 410);
        if (meta.passwordHash && url.searchParams.get('pw') !== meta.passwordHash) {
          return json({ error: 'password required or incorrect' }, 403);
        }
        if (!meta.r2 || !env.BUCKET) return json({ error: 'no backup copy available for this share' }, 404);
        const obj = await env.BUCKET.get(`files/${fileId}`);
        if (!obj) return json({ error: 'backup copy missing from storage' }, 404);
        return new Response(obj.body, {
          headers: {
            'Content-Type': meta.mime,
            'Content-Length': String(obj.size),
            'Content-Disposition': `attachment; filename="${meta.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"`,
            'X-Meshare-Source': 'r2-fallback',
            ...CORS
          }
        });
      }

      // DELETE /api/shares/:id - owner revokes; blob is deleted from R2
      if (request.method === 'DELETE' && !sub) {
        if (request.headers.get('X-Owner-Token') !== meta.ownerToken) return json({ error: 'bad owner token' }, 403);
        meta.revoked = true;
        await putMeta(env, meta);
        if (meta.r2 && env.BUCKET) {
          try { await env.BUCKET.delete(`files/${fileId}`); } catch {}
        }
        return json({ ok: true, revoked: true });
      }

      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: `internal: ${e.message}` }, 500);
    }
  }
};
