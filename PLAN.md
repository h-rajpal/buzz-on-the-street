# BuzzLDN — Project Plan

A one-page data-viz site mapping empty BuzzBallz spotted on London streets, fed by a
phone app, with Instagram publishing added later.

**Verdict: entirely feasible, and the running cost is £0.** The only thing that ever
costs money is a custom domain (~£10–15/yr), and that's optional and deferrable.

---

## 1. Decisions locked in

| Question | Answer |
|---|---|
| Phones | One iPhone, one Android |
| Submission app | Installable web app (PWA) with manual pin-drop |
| Instagram | Not now — build the hook, wire it up later |
| Storage / backend | The GitHub repo *is* the database |
| Existing backlog | Under ~30 photos — submit by hand, no import tool |
| Flavours | Seeded UK list + "add new flavour" + "Other/unknown" |
| Spotter | Recorded in the data, not displayed on the site |
| Domain | Free `*.github.io` to start, custom domain later |

---

## 2. Answering the original questions

### Can we do this with Hugo/Jekyll on GitHub Pages?

Yes — but we don't need either. A static site generator earns its keep when you have
many pages from templates. This is **one page**. The leaderboards can be computed in
about 20 lines of JavaScript from a single JSON file at page load.

Dropping Hugo/Jekyll buys us something real: **no build step at all.** GitHub Pages
serves the repo directly, so a photo goes live ~30 seconds after submission with no CI
run, no build config, no Ruby or Go toolchain, and nothing to break in eighteen months
when you come back to it. If we later want pre-rendered leaderboards or Open Graph
cards per photo, Hugo can be added over the top without changing the data model.

### Will data storage cost anything?

No. Photos are resized on the phone before upload to ~250 KB (plus a ~30 KB thumbnail),
so each sighting costs roughly **280 KB** in the repo.

| Sightings | Repo size |
|---|---|
| 100 | ~28 MB |
| 500 | ~140 MB |
| 1,000 | ~280 MB |
| 2,500 | ~700 MB |

GitHub's soft limit is 1 GB per repo (a warning arrives around 750 MB), and GitHub
Pages allows a 1 GB published site with 100 GB/month bandwidth. At a few sightings a
week, you have **well over a decade of headroom**. If you ever approach it, the fix is
cheap: move older photos to Cloudflare R2 (10 GB free, free egress) and change one URL
prefix in the data.

One subtlety: git keeps history forever. Photos are written once and never modified, so
they don't multiply. `photos.json` *is* rewritten on every submission, but it's text and
git deltas it efficiently — a few tens of MB after a thousand submissions. Not a problem,
just worth knowing it exists.

### Total cost

| Item | Cost |
|---|---|
| Public GitHub repo | £0 |
| GitHub Pages hosting + HTTPS | £0 |
| Photo storage (in repo) | £0 |
| Map tiles (CARTO basemaps) | £0 |
| London borough boundaries (London Datastore) | £0 |
| The phone app (PWA — no App Store) | £0 |
| Instagram Graph API (later) | £0 |
| **Total** | **£0** |
| Custom domain (optional, later) | ~£10–15/yr |

No Apple Developer account needed. No server. No database bill. Nothing to cancel.

---

## 3. Architecture

```
Phone (PWA)                          GitHub                      Visitors
───────────                          ──────                      ────────
pick photo
  ├─ read EXIF (date, GPS)
  ├─ drop/confirm pin on map
  ├─ auto-detect borough
  ├─ pick flavour + caption
  ├─ resize to 1600px + 400px thumb
  └─ one atomic commit ──────────▶  repo
                                     ├─ photos/*.jpg
                                     ├─ photos/thumbs/*.jpg
                                     └─ data/photos.json
                                          │
                                     GitHub Pages  ──────────▶  buzzldn.github.io
                                     (~30s, no build)            (one page, all JS)
```

No server, no CI, no third-party service. Two moving parts: a repo and a static page.

### Repo layout

```
index.html                  the one-pager
assets/app.js               map, leaderboards, gallery
assets/style.css
submit/index.html           the PWA
submit/submit.js
data/photos.json            the database
data/boroughs.geojson       simplified London borough boundaries (~100 KB)
data/flavours.json          the flavour list
photos/2026-08-01-a3f9.jpg          ~1600px, ~250 KB
photos/thumbs/2026-08-01-a3f9.jpg   ~400px, ~30 KB
manifest.webmanifest
sw.js                       service worker (offline app shell)
```

### Data model

```json
{
  "id": "2026-08-01-a3f9",
  "file": "photos/2026-08-01-a3f9.jpg",
  "thumb": "photos/thumbs/2026-08-01-a3f9.jpg",
  "lat": 51.5142,
  "lng": -0.0931,
  "locationSource": "exif",
  "borough": "Southwark",
  "flavour": "Chili Mango",
  "caption": "outside the chicken shop on Walworth Rd",
  "spottedAt": "2026-07-28T19:42:00Z",
  "spotter": "H",
  "addedAt": "2026-08-01T12:04:11Z",
  "publishToInstagram": false,
  "instagramPostId": null
}
```

The last two fields do nothing today. Including them now means adding Instagram later
requires zero data migration.

---

## 4. The website (one page, four sections)

**Hero + stats.** Total spotted, boroughs covered (*n* of 33), most-common flavour,
date of first sighting.

**Interactive map.** Leaflet with CARTO Positron tiles — muted greyscale, so the photo
pins carry all the colour. Borough boundaries drawn as a faint choropleth shaded by
count, which visually ties the map to the leaderboard below it. Pins cluster when zoomed
out. Hover shows a small square photo card; on mobile, tap does the same, since hover
doesn't exist there. Click opens a lightbox with the full photo, flavour, caption and date.

**Borough leaderboard.** Ranked bars with counts. Hovering a row highlights that borough
on the map above.

**Flavour leaderboard.** Same treatment, colour-coded per flavour, and those same colours
are reused for the map pins so the two sections read as one system.

**Recent sightings gallery.** A horizontally scrolling row of the newest photos.

> **A note on the Instagram-fed gallery:** you'd mentioned this row cycling photos *from*
> the Instagram account. I'd suggest inverting that — pull from `photos.json` instead. It
> renders identically, works from day one with no Instagram account, has no API token to
> expire, and can't break when Meta changes something. The website becomes the source of
> truth and Instagram becomes a publishing target downstream of it. That ordering is worth
> keeping even after Instagram is wired up.

---

## 5. The submission app (PWA)

A page at `/submit`, added to the home screen on both phones. It looks and behaves like
an app; it just isn't one, which is why it's free and needs no App Store.

**First run only:** paste a GitHub token, pick which of you you are. Both saved to the
device.

**Each submission:**

1. Pick a photo from the gallery.
2. It reads EXIF for date and GPS. On **Android this fills in the location automatically**.
   On **iPhone it won't** — Safari's photo picker strips GPS coordinates as a privacy
   measure (this is the one genuine constraint in the project, and the reason we're doing
   manual pin-drop). The date usually survives on both; if it doesn't, it's editable.
3. A map appears. If GPS was found, the pin is pre-placed for confirmation. If not, the
   map centres on your current location — useful, since you'll often be submitting near
   where you found it — and you drag the pin to the exact spot.
4. The borough auto-fills from the pin position (point-in-polygon against the boundary
   data). No manual selection.
5. Choose a flavour, optionally add a caption, confirm the date.
6. The photo is resized on-device to 1600px and a 400px thumbnail. This is what keeps
   storage free, makes the site fast, and — as a side effect — strips all remaining
   metadata from the published file.
7. One atomic commit writes the photo, the thumbnail and the updated `photos.json`
   together.

Roughly 15 seconds per sighting, and the site is live about 30 seconds later.

### Two implementation details worth flagging now

**Atomic commits.** Writing three files via GitHub's simple Contents API means three
separate commits, three Pages rebuilds, and a window where `photos.json` points at a
photo that isn't uploaded yet. Using the Git Data API instead (blobs → tree → commit →
ref) makes it a single commit. It's a handful of extra API calls and it eliminates a
whole category of bugs, including the case where you both submit at the same moment —
the second push is rejected as non-fast-forward and simply retries.

**The token.** A fine-grained personal access token, scoped to this one repo with
`Contents: read and write` and nothing else, stored in each phone's browser storage.
Being straight about the tradeoff: anyone with your unlocked phone could commit to a
public repo of buzzball photos. That's an acceptable risk here, and it's the price of
having no server. Set a 1-year expiry and rotate it. If it ever bothers you, a Cloudflare
Worker holding the token costs £0 and removes it from the phones entirely.

### Flavours

Seeded from the UK range — Chili Mango, Choc Tease, Lotta Colada, Strawberry 'Rita,
Tequila 'Rita, Espresso Martini, Watermelon Smash, Peachballz, Horchata, Hazelnut Latte —
plus "Other / unknown" for an unidentifiable ball. UK stock rotates and this list will go
stale, which is exactly why the app has **"+ Add new flavour"**: type it once and it joins
the dropdown permanently. Correct or extend the seed list whenever you like; it's one file.

---

## 6. Instagram (deferred, but here's what it involves)

Not being built now. Recorded so the decision is informed later.

**Requirements:** an Instagram Business or Creator account (free conversion, two minutes
in settings), a linked Facebook Page, and a Meta developer app.

**The good news:** you do *not* need Meta's App Review. App Review is required to post on
behalf of *other people's* accounts. An app left in Development mode can post to accounts
whose owners hold an admin/developer/tester role on it — which is you. This is the normal
route for self-posting and it's free.

**The maintenance cost:** long-lived tokens expire every 60 days. A scheduled GitHub
Action can refresh one automatically, or you can re-paste it six times a year.

**How it would work:** a GitHub Action triggers when a commit adds a photo with
`publishToInstagram: true`, and calls the Content Publishing API. Instagram must fetch
the image from a public URL — which it already has, since the photo is live on Pages.

**Posting the map/leaderboard periodically** is also feasible: a scheduled Action runs
headless Chrome, screenshots the live page, and posts the image. Worth doing monthly
rather than often.

**If the Meta setup ever feels like too much:** the semi-automatic fallback is a scheduled
Action that renders the image and messages it to you to post by hand. One tap, no tokens.

---

## 7. Risks, honestly

| Risk | Severity | Handling |
|---|---|---|
| iOS strips photo GPS | Low | Already designed around it — manual pin-drop, verified before building |
| ~30s delay before a photo appears | Low | App confirms submission and says it'll be live shortly |
| Token stored on phones | Low | Single-repo scope, 1-year expiry; Worker proxy available if wanted |
| Simultaneous submissions | Very low | Atomic commit + automatic retry |
| CARTO tile terms | Very low | Attribution included; Stadia/Protomaps are drop-in fallbacks |
| Repo outgrows 1 GB | Very low | 10+ years away; move photos to R2 and change a URL prefix |
| WhatsApp-sourced photos have no metadata | Medium | WhatsApp strips all EXIF — those need locating from memory |

Nothing here is a blocker, and nothing changes the £0.

---

## 8. Build order

Each phase leaves you with something usable.

**Phase 1 — Foundations.** Create the repo, enable Pages, add the borough boundary data,
hand-write 3–5 real sightings into `photos.json`. *Outcome: a live URL with a real map
and real pins.*

**Phase 2 — The one-pager.** Map interactions, hover cards, both leaderboards, gallery,
stats, lightbox, responsive layout. *Outcome: the finished website.*

**Phase 3 — The submission app.** The PWA end to end, installed on both phones. *Outcome:
you stop editing JSON by hand.*

**Phase 4 — Backlog + polish.** Submit your ~30 existing photos, add offline support, the
install prompt, and a favicon. *Outcome: the project is done.*

**Phase 5 — Instagram.** Only when you want it. Nothing built earlier needs to change.

Phases 1–2 are one sitting. Phase 3 is the largest single piece. Phases 1–4 are realistically
a weekend.

---

## 9. Open items

- **Repo/site name** — `buzzldn` gives `buzzldn.github.io`. Needs a GitHub account or org
  with that name to get the bare subdomain; otherwise it's `username.github.io/buzzldn`,
  which works identically.
- **Spotter labels** — initials, names, or nicknames? Stored but not shown.
- **Flavour list** — the seed above is from UK retailer listings; correct it if you know
  better. Easy to change at any point.
