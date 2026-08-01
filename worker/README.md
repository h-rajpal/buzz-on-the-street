# Submission endpoint

A Cloudflare Worker that accepts sightings from the phone app and commits them
to the repo.

**Why it exists:** without it, every submitter needs a GitHub token on their
phone — and a token that can write to the repo can also delete it. This moves
the token server-side so a submitter only ever holds a shared passcode, which
grants exactly one power: add a sighting.

```
phone ──POST /submit──▶ Worker ──▶ GitHub commit ──▶ Pages rebuild
        passcode         token lives here,
                         never sent to a browser
```

## Deploying

You need a free Cloudflare account. From this directory:

```bash
npm install
npx wrangler login          # opens a browser once
```

Edit `wrangler.toml` if your repo details differ, then set the two secrets —
these are encrypted at Cloudflare and never appear in the repo:

```bash
npx wrangler secret put GITHUB_TOKEN   # paste the fine-grained PAT
npx wrangler secret put PASSCODE       # invent one, share it with friends
npx wrangler deploy
```

Deploy prints a URL like `https://buzz-submit.<subdomain>.workers.dev`. Put it
in [`../submit/config.json`](../submit/config.json) with `/submit` on the end,
then commit and push:

```json
{ "endpoint": "https://buzz-submit.<subdomain>.workers.dev/submit" }
```

That's what lets a new submitter type only a name and a passcode.

## Tests

```bash
npm test
```

28 checks, no network or Cloudflare account needed — GitHub is stubbed so the
suite can assert on the exact commit that *would* be made. Worth re-running
after any change to validation, because most of what this Worker does is
refuse things.

## What it refuses

The passcode gets you past the door; it does not buy trust. Every field is
re-validated server-side:

| Check | Why |
|---|---|
| `id` stripped to `[a-z0-9-]`, paths rebuilt here | An id becomes a file path. A submitter must not be able to write to `.github/workflows/`. |
| Client-supplied `file`/`thumb` paths ignored | Same reason — the Worker derives them from the id. |
| Images must start with JPEG magic bytes | Otherwise the passcode lets anyone commit arbitrary files. |
| Photo ≤ 1.5 MB, thumb ≤ 400 KB, ≤ 12 per request | Keeps the repo inside GitHub's limits. |
| Coordinates must be inside Greater London | Catches `0,0` and junk. |
| Text fields length-capped, control characters stripped | Keeps `photos.json` well-formed. |
| Dates clamped to a sane window | Stops future-dating to the top of the feed. |
| Errors return a generic message | The token is in scope; upstream errors are logged, never returned. |

The passcode is compared in constant time, and an unset `PASSCODE` rejects
everything rather than allowing everything.

## Rotating the passcode

```bash
npx wrangler secret put PASSCODE
```

Takes effect immediately. Everyone re-enters it in the app's settings; nothing
is reinstalled. Do this whenever someone leaves the group.

## If you need rate limiting

The passcode plus the size caps are the main defence. If you ever want more,
add a WAF rate-limiting rule in the Cloudflare dashboard (free tier includes
one) against the Worker route — no code change needed.

## Costs

Free tier is 100,000 requests/day. A sighting is one request.
