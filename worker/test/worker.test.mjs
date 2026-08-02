import worker from '../src/index.js';

// Fixtures inline so the suite is self-contained: a real 40x50 JPEG, a PNG
// (wrong magic bytes) and an oversized JPEG.
const JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAyACgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCeiiivnT6QKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD/2Q==';
const FIX = {
  jpg: JPEG_B64,
  png: Buffer.from(Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.alloc(200)])).toString('base64'),
  big: Buffer.concat([Buffer.from([0xff,0xd8,0xff]), Buffer.alloc(1_600_000)]).toString('base64'),
};

const SECRET = 'test-passcode-123';
const TOKEN = 'ghp_SUPERSECRET_must_never_appear_in_a_response';

const env = {
  PASSCODE: SECRET,
  GITHUB_TOKEN: TOKEN,
  GITHUB_OWNER: 'h-rajpal',
  GITHUB_REPO: 'buzz-on-the-street',
  GITHUB_BRANCH: 'main',
  ALLOWED_ORIGINS: 'https://h-rajpal.github.io,http://127.0.0.1:8777',
};

const ORIGIN = 'https://h-rajpal.github.io';

// ── stub GitHub so we can inspect exactly what would be committed ──────────
let captured = null;
let sawAuthHeader = null;
const realFetch = globalThis.fetch;

function stubGitHub({ failRef = false } = {}) {
  captured = null;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    sawAuthHeader = init.headers?.Authorization ?? sawAuthHeader;
    const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });

    // GitHub reads a ref at /git/ref/... (singular) and updates it at
    // /git/refs/... (plural). Match the plural first — the singular string
    // is not a substring of the plural path.
    if (u.includes('/git/refs/heads/')) {
      return failRef ? J({ message: 'not fast forward' }, 422) : J({});
    }
    if (u.includes('/git/ref/heads/')) return J({ object: { sha: 'HEADSHA' } });
    if (u.includes('/git/commits/HEADSHA')) return J({ tree: { sha: 'BASETREE' } });
    if (u.includes('/contents/data/photos.json')) return new Response('[]', { status: 200 });
    if (u.includes('/contents/data/flavours.json')) return new Response('', { status: 404 });
    if (u.includes('/git/blobs')) return J({ sha: 'BLOB' + Math.random().toString(36).slice(2, 6) });
    if (u.includes('/git/trees')) { captured = JSON.parse(init.body); return J({ sha: 'NEWTREE' }); }
    if (u.includes('/git/commits')) { captured.commitMsg = JSON.parse(init.body).message; return J({ sha: 'NEWCOMMIT' }); }
    return J({}, 404);
  };
}
const restore = () => { globalThis.fetch = realFetch; };

const post = (body, origin = ORIGIN) => worker.fetch(new Request('https://x/submit', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
  body: typeof body === 'string' ? body : JSON.stringify(body),
}), env);

const sighting = (over = {}) => ({
  id: '2026-07-19-ab12', lat: 51.5055, lng: -0.091, spotter: 'H',
  flavours: ['Chili Mango'], borough: 'Southwark', caption: 'by the bins',
  spottedAt: '2026-07-19T18:42:00Z', locationSource: 'exif',
  full: FIX.jpg, thumb: FIX.jpg, ...over,
});

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// ── routing & CORS ─────────────────────────────────────────────────────────
console.log('\nrouting & CORS');
{
  const r = await worker.fetch(new Request('https://x/submit', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env);
  check('OPTIONS preflight -> 204', r.status === 204, `got ${r.status}`);
  check('echoes the allowed origin', r.headers.get('Access-Control-Allow-Origin') === ORIGIN);
}
{
  const r = await worker.fetch(new Request('https://x/submit', { method: 'GET', headers: { Origin: ORIGIN } }), env);
  check('GET -> 405', r.status === 405, `got ${r.status}`);
}
{
  const r = await worker.fetch(new Request('https://x/nope', { method: 'POST', headers: { Origin: ORIGIN } }), env);
  check('unknown path -> 404', r.status === 404, `got ${r.status}`);
}
{
  const r = await post({ passcode: SECRET, sightings: [sighting()] }, 'https://evil.example');
  const acao = r.headers.get('Access-Control-Allow-Origin');
  check('unlisted origin is not echoed back', acao !== 'https://evil.example', `got ${acao}`);
}

// ── auth ───────────────────────────────────────────────────────────────────
console.log('\nauth');
{
  const r = await post({ passcode: 'wrong', sightings: [sighting()] });
  check('wrong passcode -> 401', r.status === 401, `got ${r.status}`);
}
{
  const r = await post({ sightings: [sighting()] });
  check('missing passcode -> 401', r.status === 401, `got ${r.status}`);
}
{
  const r = await worker.fetch(new Request('https://x/submit', {
    method: 'POST', headers: { Origin: ORIGIN }, body: JSON.stringify({ passcode: SECRET, sightings: [sighting()] }),
  }), { ...env, PASSCODE: '' });
  check('blank server passcode never authenticates', r.status === 401, `got ${r.status}`);
}

// ── validation ─────────────────────────────────────────────────────────────
console.log('\nvalidation');
const bad = async (name, over, expectFragment) => {
  const r = await post({ passcode: SECRET, sightings: [sighting(over)] });
  const b = await r.json();
  check(name, r.status === 400 && (!expectFragment || b.error.includes(expectFragment)),
        `${r.status} ${b.error || ''}`);
};
await bad('rejects coords outside London', { lat: 40.7, lng: -74.0 }, 'not in London');
await bad('rejects 0,0', { lat: 0, lng: 0 }, 'not in London');
await bad('rejects a PNG', { full: FIX.png }, 'JPEG');
await bad('rejects an oversized photo', { full: FIX.big }, 'too large');
await bad('rejects a missing spotter', { spotter: '' }, 'spotter');
await bad('rejects a too-short id', { id: 'ab' }, 'bad id');
{
  const r = await post({ passcode: SECRET, sightings: [] });
  check('empty batch -> 400', r.status === 400, `got ${r.status}`);
}
{
  const r = await post({ passcode: SECRET, sightings: Array(13).fill(sighting()) });
  check('over-large batch -> 400', r.status === 400, `got ${r.status}`);
}
{
  const r = await post('{ not json', ORIGIN);
  check('malformed JSON -> 400', r.status === 400, `got ${r.status}`);
}

// ── the commit it builds ───────────────────────────────────────────────────
console.log('\ncommit construction');
stubGitHub();
{
  const r = await post({ passcode: SECRET, sightings: [sighting()] });
  const b = await r.json();
  check('valid submission -> 200', r.status === 200, `${r.status} ${JSON.stringify(b)}`);
  const paths = captured.tree.map(t => t.path);
  check('commits photo, thumb, photos.json',
    paths.includes('photos/2026-07-19-ab12.jpg') &&
    paths.includes('photos/thumbs/2026-07-19-ab12.jpg') &&
    paths.includes('data/photos.json'), paths.join(' '));
  check('creates flavours.json when absent', paths.includes('data/flavours.json'));
  check('base_tree is the current head tree', captured.base_tree === 'BASETREE');
  const entry = JSON.parse(captured.tree.find(t => t.path === 'data/photos.json').content)[0];
  check('stored record keeps caption + spotter', entry.caption === 'by the bins' && entry.spotter === 'H');
  check('commit message names the sighting', /Chili Mango in Southwark/.test(captured.commitMsg), captured.commitMsg);
}

// ── path traversal ─────────────────────────────────────────────────────────
console.log('\npath traversal');
stubGitHub();
{
  const r = await post({ passcode: SECRET, sightings: [sighting({ id: '../../.github/workflows/evil' })] });
  if (r.status === 200) {
    const paths = captured.tree.map(t => t.path).filter(p => p.endsWith('.jpg'));
    const escaped = paths.some(p => p.includes('..') || !p.startsWith('photos/'));
    check('traversal id cannot escape photos/', !escaped, paths.join(' '));
  } else {
    check('traversal id rejected outright', r.status === 400, `${r.status}`);
  }
}
stubGitHub();
{
  // keep valid images; inject bogus PATH fields alongside them
  const r = await post({ passcode: SECRET, sightings: [
    { ...sighting({ id: 'abcdef' }), file: '.github/workflows/x.yml', thumbPath: 'evil.yml' },
  ] });
  const paths = captured?.tree.map(t => t.path) || [];
  check('client-supplied file paths are ignored',
    r.status === 200 && paths.includes('photos/abcdef.jpg') && !paths.some(p => p.includes('.github')),
    `${r.status} ${paths.join(' ')}`);
}

// ── secret leakage ─────────────────────────────────────────────────────────
console.log('\nsecret handling');
restore();
{
  // real fetch to GitHub with a bogus token -> upstream 401 -> our 502
  const r = await post({ passcode: SECRET, sightings: [sighting()] });
  const text = await r.text();
  check('upstream failure -> 502, not a crash', r.status === 502, `got ${r.status}`);
  check('response never contains the GitHub token', !text.includes(TOKEN) && !text.includes('ghp_'), text.slice(0, 120));
  check('response does not leak GitHub internals', !/api\.github\.com|Bad credentials/i.test(text), text.slice(0, 120));
}


// -- several buzzballs in one photo -----------------------------------------
console.log('\nmultiple buzzballs per photo');
stubGitHub();
{
  const r = await post({ passcode: SECRET, sightings: [
    sighting({ flavours: ['Chili Mango', "Lime 'Rita", 'Choc Tease'] }),
  ] });
  const rec = JSON.parse(captured.tree.find(t => t.path === 'data/photos.json').content)[0];
  check('stores every flavour', r.status === 200 && rec.flavours.length === 3, JSON.stringify(rec.flavours));
  check('drops the old singular field', rec.flavour === undefined);
  const paths = captured.tree.filter(t => t.path.endsWith('.jpg')).length;
  check('still one photo + one thumb', paths === 2, `${paths} image blobs`);
}
stubGitHub();
{
  // two of the same flavour must NOT collapse to one
  const r = await post({ passcode: SECRET, sightings: [
    sighting({ flavours: ['Chili Mango', 'Chili Mango'] }),
  ] });
  const rec = JSON.parse(captured.tree.find(t => t.path === 'data/photos.json').content)[0];
  check('duplicate flavours are kept, not deduped', rec.flavours.length === 2, JSON.stringify(rec.flavours));
  const fl = JSON.parse(captured.tree.find(t => t.path === 'data/flavours.json').content);
  check('flavours.json is still deduped', fl.filter(f => f === 'Chili Mango').length === 1, JSON.stringify(fl));
}
stubGitHub();
{
  // anything queued before this change sends the old string
  const legacy = sighting();
  delete legacy.flavours;
  legacy.flavour = 'Horchata';
  const r = await post({ passcode: SECRET, sightings: [legacy] });
  const rec = JSON.parse(captured.tree.find(t => t.path === 'data/photos.json').content)[0];
  check('legacy single flavour still publishes',
    r.status === 200 && JSON.stringify(rec.flavours) === '["Horchata"]', JSON.stringify(rec.flavours));
}
stubGitHub();
{
  const legacy = sighting({ flavours: [] });
  const r = await post({ passcode: SECRET, sightings: [legacy] });
  const rec = JSON.parse(captured.tree.find(t => t.path === 'data/photos.json').content)[0];
  check('no flavour at all falls back to Other / unknown',
    JSON.stringify(rec.flavours) === '["Other / unknown"]', JSON.stringify(rec.flavours));
}
{
  const r = await post({ passcode: SECRET, sightings: [
    sighting({ flavours: Array(13).fill('Chili Mango') }),
  ] });
  check('absurd flavour count -> 400', r.status === 400, `got ${r.status}`);
}
stubGitHub();
{
  const r = await post({ passcode: SECRET, sightings: [
    sighting({ flavours: ['Chili Mango', "Lime 'Rita"] }),
  ] });
  check('commit message lists both', /Chili Mango \+ Lime 'Rita/.test(captured.commitMsg), captured.commitMsg);
}
restore();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
