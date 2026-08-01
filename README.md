# Buzz on the Street

Empty BuzzBallz found on the streets of London, mapped and counted.
One static page, no build step, hosted free on GitHub Pages.

The page is a single continuous scroll: an editorial photo gallery with the
title centred over it, then the map, then the tallies. Nothing is fixed to
the viewport — there is no sticky header.

See [PLAN.md](PLAN.md) for the full architecture, costs and roadmap.

## Running it locally

```bash
python3 -m http.server 8777
# → http://127.0.0.1:8777/
```

There is no build step. Edit the files, refresh the browser.

## Layout

```
index.html              the whole site
assets/style.css        design tokens + layout
assets/app.js           map, leaderboards, scroll choreography
assets/vendor/          Leaflet 1.9.4 (vendored — no CDN dependency)
data/photos.json        the database: one record per sighting
data/boroughs.geojson   33 London boroughs, simplified to 47 KB
data/flavours.json      the flavour dropdown list
photos/                 full images (~1600px)
photos/thumbs/          thumbnails (~400px)
submit/                 the submission app (not built yet)
scripts/                dev tooling
```

## The submit app (`/submit/`)

An installable web app for logging a sighting from your phone.

**It works before the GitHub repo exists.** Every submission is saved to
IndexedDB on the device first, and the site merges those drafts in with
`data/photos.json` — so a photo appears on the map seconds after you take it,
with no repo, no token and no deploy. Publishing to GitHub is a separate,
optional step that drains the queue.

Flow: pick a photo → EXIF is read for date and GPS → place the pin → borough
resolves by point-in-polygon → flavour, caption, time → save.

- **Resizing happens on the phone**: 1600px long edge at q0.82, plus a 400px
  thumbnail. This is what keeps hosting free. Re-encoding through a canvas also
  strips all metadata, so published files carry no GPS — the coordinates live in
  the JSON instead.
- **Orientation is handled** via `createImageBitmap(file, {imageOrientation:
  'from-image'})`, so rotated phone photos don't come out sideways.
- **On Android** the location fills itself in from the photo's EXIF. **On iPhone
  it won't** — Safari strips GPS from the photo picker — so the app falls back to
  your current location and then to dragging the pin. The chip above the map
  always says which of the three you got.
- **Publishing is one atomic commit.** All queued photos, thumbnails,
  `photos.json` and `flavours.json` go up in a single commit built through the
  Git Data API, so the site never references an image that isn't pushed. If the
  branch moved underneath you, the ref update is rejected and the commit is
  rebuilt on the new head rather than clobbering it.
- **Offline**: a service worker precaches the shell, so you can log a sighting
  with no signal and publish later. Map tiles and the GitHub API are
  deliberately not cached.

### Running it on your phone

This is the fiddly part, and it's worth knowing why. Browsers treat plain HTTP
on a LAN address as an **insecure origin**, which disables:

| | localhost | `http://<lan-ip>` | GitHub Pages (HTTPS) |
|---|---|---|---|
| Pick a photo, read EXIF | ✅ | ✅ | ✅ |
| Save to the queue | ✅ | ✅ | ✅ |
| **Use my current location** | ✅ | ❌ | ✅ |
| **Install to home screen** | ✅ | ❌ | ✅ |

So over your wifi you can still submit photos and read EXIF GPS, but you lose
the current-location button and the ability to install the app. Both come back
the moment the site is on GitHub Pages, which is HTTPS by default. A tunnel
(`cloudflared tunnel --url http://localhost:8777`) also works for testing.

### The token

A fine-grained personal access token, scoped to this one repository, with
**Contents: read and write** and nothing else. It lives in `localStorage` on the
phone. Anyone with your unlocked phone could commit buzzball photos — that's the
trade for having no server. Give it a 1-year expiry and rotate it.

## The data

`data/photos.json` is an array of sightings:

```json
{
  "id": "2026-07-30-04e",
  "file": "photos/2026-07-30-04e.jpg",
  "thumb": "photos/thumbs/2026-07-30-04e.jpg",
  "lat": 51.568919, "lng": -0.144305,
  "borough": "Camden",
  "flavour": "Watermelon Smash",
  "caption": "in the phone box",
  "spottedAt": "2026-07-30T13:46:00Z",
  "spotter": "A",
  "publishToInstagram": false,
  "instagramPostId": null
}
```

`borough` is resolved by point-in-polygon against `boroughs.geojson` at
submission time, so the site never has to compute it.

`publishToInstagram` / `instagramPostId` are unused today. They exist so
adding Instagram later needs no data migration.

## Placeholder data

Every photo currently in the repo is a generated placeholder, flagged with
`"placeholder": true`. To regenerate them:

```bash
python3 scripts/gen_placeholders.py
```

When the real photos arrive, delete `photos/`, `photos/thumbs/`,
`data/photos.json` and `scripts/gen_placeholders.py`, then submit the real
ones through the app.

## Colour

Paper `#fffbf4`, charcoal ink `#2b2a28`, Helvetica Neue.

Three chart hues, validated for colour-blind separation against the paper
surface using the all-pairs test (worst CVD ΔE 9.2, normal-vision 24.0):

| Role | Hex | Used by |
|---|---|---|
| Boroughs | `#2a78d6` | leaderboard + map choropleth |
| Flavours | `#eb6834` | leaderboard + map pins |
| Spotters | `#1baf7a` | leaderboard |

Leaderboards are ranked *nominal* bars, so each chart takes a single hue
rather than colouring every row differently. The choropleth uses a
one-hue sequential blue ramp (`--seq-1` … `--seq-5`).

Aqua sits at 2.73:1 against the paper, just under the 3:1 mark. That is
permitted only because every row carries a visible count as the relief
channel — **don't remove those numbers.**

## The opening collage — read this before moving a photo

Sixteen photos, full bleed, scattered but not freehand. Every photo is
**Instagram 4:5** (`aspect-ratio: 4/5`), and the scatter is governed by a grid:

- **x** comes from a **24-column** grid. Twenty-four, not twelve: in the design
  reference each photo is only ~10% of the viewport wide, and on a 12-column
  grid the narrowest possible image is already 8%+, so they collide into a wall
  of photos. The finer grid is what buys the cream between them.
- **y** comes from `--y`, a whole number of module *pitches*
  (`--u = column width + gutter`). Nothing is offset by an eyeballed pixel value.

Every photo lives in the **same grid row** with `align-self: start`; the vertical
position is pure margin. That's what lets photos overlap each other freely while
staying aligned.

Consequences worth knowing:

- **The title is a grid item, last in the DOM**, so it stacks over the photos.
  It's `pointer-events: none` so clicks fall through to the images beneath.
- **The offset must be set with the `margin` shorthand**, not `margin-top`. A
  `margin: 0` on `.gallery figure` (0,1,1) outranks a `margin-top` longhand on
  `.gallery > *` (0,1,0) and silently zeroes every offset — the collage collapses
  into a row at the top and still passes a naive "offsets are whole modules"
  check, because zero is a whole multiple.
- **Column lines run 1–25 for 24 tracks.** Ending a span at 26 silently adds a
  25th implicit column and skews the composition.
- **`--y: -1`** on two photos is deliberate: it bleeds the top row off the page.
  `.opening` has `overflow: hidden` to clip it.

### Legibility

The title sits directly on the photographs with no scrim, matching the reference.
That only works while the photos under it are **light**. The placeholder generator
deliberately produces bright pavement for this reason. If real photos land dark
behind the title, either reorder them so light ones fall in the middle stacks, or
give `.opening__title` a paper wash.

The stats line lives *below* the collage on clean paper — small grey type over
photographs is unreadable, and the reference has the title standing alone.

Layout is checked automatically, not by eye: the verification run asserts every
photo is exactly 4:5, that no photo is off the column grid, that vertical offsets
are whole modules, and that they actually vary.
