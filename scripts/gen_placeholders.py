#!/usr/bin/env python3
"""
DEV TOOL — generates placeholder photos + seed data so the site can be designed
before the real photos land. Delete this script (and the files it makes) once
you've submitted your own sightings through the app.

    python3 scripts/gen_placeholders.py

Writes photos/*.jpg, photos/thumbs/*.jpg and data/photos.json.

The point-in-polygon borough lookup here is deliberately the same algorithm the
submit app will run in the browser, so this doubles as a test of that logic.
"""

import json, math, random, pathlib
from PIL import Image, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
random.seed(20260801)  # deterministic: re-running produces identical output

# Flavour -> the ball colour used in the placeholder image. Purely decorative,
# standing in for a real photograph; the site does not colour-code by flavour.
FLAVOURS = {
    "Chili Mango":     (233, 108, 42),
    "Choc Tease":      (96, 62, 48),
    "Lotta Colada":    (232, 214, 168),
    "Strawberry 'Rita": (206, 62, 84),
    "Tequila 'Rita":   (150, 190, 92),
    "Espresso Martini": (74, 56, 50),
    "Watermelon Smash": (222, 74, 96),
    "Peachballz":      (240, 158, 106),
    "Horchata":        (222, 200, 172),
    "Hazelnut Latte":  (168, 122, 84),
    "Other / unknown": (140, 140, 145),
}

SPOTTERS = ["H", "A"]

CAPTIONS = [
    "outside the chicken shop", "in the bus stop", "on a garden wall",
    "wedged in a hedge", "by the canal", "next to the bins",
    "on top of a postbox", "in the gutter", "balanced on a bollard",
    "under the bench", "by the station entrance", "on a windowsill",
    "in the phone box", "beside the bike rack", "on the kerb",
    "in a tree pit", "on the wall by the pub", "left on a bin lid",
    "", "", "",  # some sightings have no caption
]

# Weighted towards inner London, where you'd realistically stumble across these.
BOROUGH_WEIGHTS = {
    "Southwark": 4, "Hackney": 4, "Tower Hamlets": 4, "Lambeth": 3,
    "Camden": 3, "Islington": 3, "Westminster": 2, "Newham": 2,
    "Lewisham": 2, "Wandsworth": 2, "Haringey": 2, "Waltham Forest": 2,
    "Brent": 1, "Greenwich": 1, "Ealing": 1, "Hammersmith and Fulham": 1,
    "Kensington and Chelsea": 1, "City of London": 1, "Barnet": 1, "Croydon": 1,
}

N_PHOTOS = 28


# ---------------------------------------------------------------- geo helpers

def rings_of(geom):
    """Yield each polygon's exterior ring as a list of [lng, lat]."""
    if geom["type"] == "Polygon":
        yield geom["coordinates"][0]
    elif geom["type"] == "MultiPolygon":
        for poly in geom["coordinates"]:
            yield poly[0]


def point_in_ring(lng, lat, ring):
    """Standard ray-casting test. Mirrors the browser implementation."""
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat):
            if lng < (xj - xi) * (lat - yi) / (yj - yi) + xi:
                inside = not inside
        j = i
    return inside


def borough_at(lng, lat, features):
    for f in features:
        for ring in rings_of(f["geometry"]):
            if point_in_ring(lng, lat, ring):
                return f["properties"]["name"]
    return None


def bbox(geom):
    xs, ys = [], []
    for ring in rings_of(geom):
        for x, y in ring:
            xs.append(x); ys.append(y)
    return min(xs), min(ys), max(xs), max(ys)


def sample_point_in(feature, features):
    """Rejection-sample a point that really falls inside this borough."""
    x0, y0, x1, y1 = bbox(feature["geometry"])
    name = feature["properties"]["name"]
    for _ in range(4000):
        lng = random.uniform(x0, x1)
        lat = random.uniform(y0, y1)
        if borough_at(lng, lat, features) == name:
            return round(lng, 6), round(lat, 6)
    raise RuntimeError(f"could not sample inside {name}")


# ------------------------------------------------------------ image placeholder

def make_photo(path_full, path_thumb, ball_rgb, seed):
    """A dark street-ish backdrop with a coloured ball. Stands in for a photo."""
    rnd = random.Random(seed)
    w, h = rnd.choice([(1600, 1200), (1200, 1600), (1600, 1600), (1600, 900)])

    img = Image.new("RGB", (w, h), (30, 30, 29))
    d = ImageDraw.Draw(img)

    # Vertical pavement gradient. Kept light on purpose: the title overlaps
    # these in the opening collage, and charcoal type needs the photograph
    # under it to be bright to stay readable.
    top = rnd.randint(178, 214)
    bot = rnd.randint(132, 170)
    for y in range(h):
        t = y / h
        v = int(top + (bot - top) * t)
        d.line([(0, y), (w, y)], fill=(v, v, v - 1))

    # a few paving lines for texture
    for _ in range(rnd.randint(2, 5)):
        y = rnd.randint(0, h)
        d.line([(0, y), (w, y + rnd.randint(-60, 60))],
               fill=(v + rnd.randint(6, 16),) * 3, width=rnd.randint(1, 3))

    # the ball
    r = int(min(w, h) * rnd.uniform(0.17, 0.28))
    cx = rnd.randint(int(w * 0.3), int(w * 0.7))
    cy = rnd.randint(int(h * 0.4), int(h * 0.72))
    d.ellipse([cx - r * 1.15, cy + r * 0.75, cx + r * 1.15, cy + r * 1.15],
              fill=(12, 12, 12))                      # shadow
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ball_rgb)
    hi = tuple(min(255, c + 70) for c in ball_rgb)
    d.ellipse([cx - r * 0.55, cy - r * 0.62, cx - r * 0.12, cy - r * 0.19], fill=hi)

    img = img.filter(ImageFilter.GaussianBlur(0.6))

    img.save(path_full, "JPEG", quality=82, optimize=True)
    t = img.copy()
    t.thumbnail((400, 400), Image.LANCZOS)
    t.save(path_thumb, "JPEG", quality=78, optimize=True)
    return w, h


# ------------------------------------------------------------------------ main

def main():
    geo = json.loads((ROOT / "data" / "boroughs.geojson").read_text())
    features = geo["features"]
    by_name = {f["properties"]["name"]: f for f in features}

    missing = [b for b in BOROUGH_WEIGHTS if b not in by_name]
    if missing:
        raise SystemExit(f"boroughs not found in geojson: {missing}")

    pool = [b for b, wgt in BOROUGH_WEIGHTS.items() for _ in range(wgt)]
    random.shuffle(pool)
    chosen = [pool[i % len(pool)] for i in range(N_PHOTOS)]

    (ROOT / "photos" / "thumbs").mkdir(parents=True, exist_ok=True)

    photos = []
    flavour_names = list(FLAVOURS)
    for i, bname in enumerate(chosen):
        lng, lat = sample_point_in(by_name[bname], features)

        # verify with the same lookup the app will use
        detected = borough_at(lng, lat, features)
        assert detected == bname, f"point-in-polygon mismatch: {detected} != {bname}"

        flavour = random.choice(flavour_names)
        # spread sightings over roughly the last five months
        days_ago = random.randint(0, 150)
        hour = random.randint(9, 23)
        minute = random.randint(0, 59)
        y, m, dd = 2026, 8, 1
        total = dd - days_ago
        while total < 1:
            m -= 1
            if m == 0:
                m, y = 12, y - 1
            total += [31, 29 if y % 4 == 0 else 28, 31, 30, 31, 30,
                      31, 31, 30, 31, 30, 31][m - 1]
        spotted = f"{y:04d}-{m:02d}-{total:02d}T{hour:02d}:{minute:02d}:00Z"

        pid = f"{y:04d}-{m:02d}-{total:02d}-{i:02d}{random.choice('abcdef')}"
        rel_full = f"photos/{pid}.jpg"
        rel_thumb = f"photos/thumbs/{pid}.jpg"
        w, h = make_photo(ROOT / rel_full, ROOT / rel_thumb, FLAVOURS[flavour], i)

        photos.append({
            "id": pid,
            "file": rel_full,
            "thumb": rel_thumb,
            "w": w, "h": h,
            "lat": lat, "lng": lng,
            "locationSource": "seed",
            "borough": bname,
            "flavour": flavour,
            "caption": random.choice(CAPTIONS),
            "spottedAt": spotted,
            "spotter": random.choice(SPOTTERS),
            "addedAt": spotted,
            "publishToInstagram": False,
            "instagramPostId": None,
            "placeholder": True,
        })

    photos.sort(key=lambda p: p["spottedAt"], reverse=True)
    out = ROOT / "data" / "photos.json"
    out.write_text(json.dumps(photos, indent=2) + "\n")

    (ROOT / "data" / "flavours.json").write_text(
        json.dumps(list(FLAVOURS), indent=2) + "\n")

    total_kb = sum((ROOT / p["file"]).stat().st_size +
                   (ROOT / p["thumb"]).stat().st_size for p in photos) / 1024
    print(f"{len(photos)} sightings -> {out.relative_to(ROOT)}")
    print(f"boroughs covered: {len({p['borough'] for p in photos})}")
    print(f"flavours used:    {len({p['flavour'] for p in photos})}")
    print(f"placeholder images: {total_kb:.0f} KB total "
          f"({total_kb/len(photos):.0f} KB avg — real photos will be ~280 KB)")


if __name__ == "__main__":
    main()
