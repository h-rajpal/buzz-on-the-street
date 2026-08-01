/* ═══════════════════════════════════════════════════════════════════════
   Submission endpoint for Buzz on the Street.

   Exists for one reason: so the GitHub token never leaves the server. The
   phone app holds a shared passcode instead, which grants exactly one power
   — "add a sighting" — and can be rotated by changing one secret.

   Everything a client sends is treated as hostile. The passcode gets you
   past the door; it does not buy you trust. In particular the file paths are
   rebuilt here from a sanitised id, never taken from the request, and the
   image bytes must actually be JPEG.
   ═══════════════════════════════════════════════════════════════════ */

const MAX_BATCH = 12;                    // sightings per request
const MAX_FULL_BYTES = 1_500_000;        // ~1.5 MB after base64 decode
const MAX_THUMB_BYTES = 400_000;
const MAX_BODY_BYTES = 20_000_000;

// Greater London, padded. Rejects obviously bogus coordinates (0,0 especially).
const BOUNDS = { minLat: 51.20, maxLat: 51.75, minLng: -0.62, maxLng: 0.42 };

const LIMITS = { flavour: 60, caption: 280, borough: 60, spotter: 40, id: 40 };

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, cors);

    const url = new URL(request.url);
    if (url.pathname !== '/submit') return json({ error: 'Not found' }, 404, cors);

    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) return json({ error: 'Too much data in one go' }, 413, cors);

      let body;
      try { body = JSON.parse(raw); }
      catch { return json({ error: 'Bad JSON' }, 400, cors); }

      if (!timingSafeEqual(String(body.passcode || ''), env.PASSCODE || '')) {
        return json({ error: 'Wrong passcode' }, 401, cors);
      }

      const items = Array.isArray(body.sightings) ? body.sightings : [];
      if (!items.length) return json({ error: 'Nothing to publish' }, 400, cors);
      if (items.length > MAX_BATCH) {
        return json({ error: `At most ${MAX_BATCH} sightings per publish` }, 400, cors);
      }

      const clean = [];
      for (const [i, s] of items.entries()) {
        const v = validate(s, i);
        if (v.error) return json({ error: v.error }, 400, cors);
        clean.push(v.value);
      }

      const result = await commit(clean, env);
      return json({ ok: true, published: clean.length, commit: result.sha }, 200, cors);

    } catch (err) {
      // Never leak internals (the token lives in this scope)
      console.error('submit failed:', err.stack || err.message);
      return json({ error: 'Could not publish. Try again shortly.' }, 502, cors);
    }
  },
};

// ─────────────────────────────────────────────────────────────── helpers

const json = (obj, status, headers) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : (allowed[0] || 'null'),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** Compare without leaking length/prefix through timing. */
function timingSafeEqual(a, b) {
  if (!b) return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

const str = (v, max) => String(v ?? '')
  // strip control characters. Written as escapes on purpose: literal
  // control bytes in source get mangled by editors and make git treat
  // the file as binary.
  .replace(/[\u0000-\u001f\u007f]/g, '')
  .trim()
  .slice(0, max);

function decodeBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const isJpeg = bytes =>
  bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

/** Validate one sighting and return a normalised copy. */
function validate(s, i) {
  const at = `sighting ${i + 1}`;

  // The id becomes a file path, so it is the one field that must be paranoid.
  const id = str(s.id, LIMITS.id).toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!id || id.length < 6) return { error: `${at}: bad id` };

  const lat = Number(s.lat), lng = Number(s.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { error: `${at}: missing location` };
  if (lat < BOUNDS.minLat || lat > BOUNDS.maxLat || lng < BOUNDS.minLng || lng > BOUNDS.maxLng) {
    return { error: `${at}: location is not in London` };
  }

  const spotter = str(s.spotter, LIMITS.spotter);
  if (!spotter) return { error: `${at}: no spotter name` };

  const flavour = str(s.flavour, LIMITS.flavour) || 'Other / unknown';

  let spottedAt = new Date(s.spottedAt);
  if (isNaN(spottedAt)) spottedAt = new Date();
  // no future-dating, and nothing sillier than 5 years old
  const now = Date.now();
  if (spottedAt.getTime() > now + 864e5) spottedAt = new Date(now);
  if (spottedAt.getTime() < now - 5 * 365 * 864e5) spottedAt = new Date(now);

  let full, thumb;
  try {
    full = decodeBase64(String(s.full || ''));
    thumb = decodeBase64(String(s.thumb || ''));
  } catch { return { error: `${at}: images are not valid base64` }; }

  if (!isJpeg(full) || !isJpeg(thumb)) return { error: `${at}: images must be JPEG` };
  if (full.length > MAX_FULL_BYTES) return { error: `${at}: photo is too large` };
  if (thumb.length > MAX_THUMB_BYTES) return { error: `${at}: thumbnail is too large` };

  return {
    value: {
      meta: {
        id,
        file: `photos/${id}.jpg`,          // rebuilt here, never trusted
        thumb: `photos/thumbs/${id}.jpg`,
        lat: Math.round(lat * 1e6) / 1e6,
        lng: Math.round(lng * 1e6) / 1e6,
        locationSource: ['exif', 'device', 'manual'].includes(s.locationSource)
          ? s.locationSource : 'manual',
        borough: str(s.borough, LIMITS.borough),
        flavour,
        caption: str(s.caption, LIMITS.caption),
        spottedAt: spottedAt.toISOString(),
        spotter,
        addedAt: new Date().toISOString(),
        publishToInstagram: false,
        instagramPostId: null,
      },
      fullB64: String(s.full),
      thumbB64: String(s.thumb),
    },
  };
}

// ─────────────────────────────────────────────────────────── GitHub commit

/**
 * One commit for the whole batch: images, photos.json and flavours.json
 * together, so the site never references a file that isn't there. If the
 * branch moved while we were building, rebuild on the new head instead of
 * forcing over someone else's push.
 */
async function commit(items, env) {
  const owner = env.GITHUB_OWNER, repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || 'main';
  const base = `https://api.github.com/repos/${owner}/${repo}`;

  const gh = async (path, init = {}) => {
    const r = await fetch(base + path, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'User-Agent': 'buzz-on-the-street-worker',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    if (!r.ok) {
      const e = new Error(`GitHub ${r.status} on ${path}: ${(await r.text()).slice(0, 300)}`);
      e.status = r.status;
      throw e;
    }
    return r.status === 204 ? null : r.json();
  };

  const readText = async path => {
    const r = await fetch(`${base}/contents/${path}?ref=${branch}`, {
      headers: {
        Accept: 'application/vnd.github.raw',
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'User-Agent': 'buzz-on-the-street-worker',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub ${r.status} reading ${path}`);
    return r.text();
  };

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ref = await gh(`/git/ref/heads/${branch}`);
      const headSha = ref.object.sha;
      const headCommit = await gh(`/git/commits/${headSha}`);

      const existing = JSON.parse((await readText('data/photos.json')) || '[]');
      const flavours = JSON.parse((await readText('data/flavours.json')) || '[]');

      const tree = [];
      for (const it of items) {
        const [f, t] = await Promise.all([
          gh('/git/blobs', { method: 'POST', body: JSON.stringify({ content: it.fullB64, encoding: 'base64' }) }),
          gh('/git/blobs', { method: 'POST', body: JSON.stringify({ content: it.thumbB64, encoding: 'base64' }) }),
        ]);
        tree.push({ path: it.meta.file, mode: '100644', type: 'blob', sha: f.sha });
        tree.push({ path: it.meta.thumb, mode: '100644', type: 'blob', sha: t.sha });
      }

      const ids = new Set(items.map(i => i.meta.id));
      const merged = [...items.map(i => i.meta), ...existing.filter(p => !ids.has(p.id))]
        .sort((a, b) => new Date(b.spottedAt) - new Date(a.spottedAt));
      tree.push({
        path: 'data/photos.json', mode: '100644', type: 'blob',
        content: JSON.stringify(merged, null, 2) + '\n',
      });

      const allFlavours = [...new Set([...flavours, ...items.map(i => i.meta.flavour)])];
      if (allFlavours.length !== flavours.length) {
        tree.push({
          path: 'data/flavours.json', mode: '100644', type: 'blob',
          content: JSON.stringify(allFlavours, null, 2) + '\n',
        });
      }

      const newTree = await gh('/git/trees', {
        method: 'POST',
        body: JSON.stringify({ base_tree: headCommit.tree.sha, tree }),
      });

      const first = items[0].meta;
      const message = items.length === 1
        ? `Add sighting: ${first.flavour} in ${first.borough || 'London'} (${first.spotter})`
        : `Add ${items.length} sightings`;

      const newCommit = await gh('/git/commits', {
        method: 'POST',
        body: JSON.stringify({ message, tree: newTree.sha, parents: [headSha] }),
      });

      await gh(`/git/refs/heads/${branch}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: newCommit.sha, force: false }),
      });

      return { sha: newCommit.sha };

    } catch (err) {
      lastErr = err;
      if (err.status === 409 || err.status === 422) continue;   // raced, rebuild
      throw err;
    }
  }
  throw lastErr;
}
