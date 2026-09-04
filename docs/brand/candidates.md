# Mutter — app mark candidates

Six marks, `cand-1..6.svg` (512×512, self-contained, no fonts, no raster) plus a flat
single-colour silhouette for each, `cand-N-flat.svg`. `sheet.png` compares all of them at
200px on `#0B0F17`, at 32px and 16px, flat at 32px on `#151B26`, and with the accent swapped
to Ultra and Ember.

**One variable.** No candidate hard-codes the accent anywhere it matters. Every accent fill,
stroke and gradient stop reads `var(--accent, #3D9BFF)` / `var(--accent-2, #1C77DB)` through
a CSS class, and nothing *declares* those properties inside the file — so the Midnight values
are the fallback, and setting `style="--accent:#A8E831;--accent-2:#7FB513"` on the `<svg>` or
any ancestor re-themes the whole mark. The last two columns of the sheet are that exact
mechanism, not a re-export. (`--accent-2` is just the existing `accent-active` from
`themes.js`; every palette already ships one. Lighting is white/black at low alpha over the
accent, so highlights and shading follow the swap too.)

**No text.** The letter M, where it appears, is drawn as a path — a heavy geometric M built
from stem 48 / arm slope 2.6 / notch at 40% of cap height, in the spirit of Bricolage Display
ExtraBold. Nothing in these files needs a font to render.

**Colour count.** Each is the dark ground + the accent (two tones, gradient) + white ink at
most. The tile is `#0B0F17` pushed toward the accent, matching what `make-appicon.swift`
already does on iOS.

---

## 01 — Pressed Talk Key

**Idea.** The push-to-talk cap as a real object: a skirt with the lit face sitting proud of
it, so the icon has the thickness of something you press, with the monogram on the face.

**Why it isn't generic.** It is the continuity candidate — the vector twin of the iOS icon —
and the thing it depicts is the single gesture the whole product is built around, not a
generic app tile. The depth is honest geometry (a 36-unit skirt, a 5-unit bevel catching
light on the top edge only, one soft ground shadow), not a bevel filter.

**Risk.** At 16px the M's counters close up and it degrades to "blue square with a white
smudge" — see `sheet.png`, and the magnified 16px test showed this most clearly. It is also
the least distant from the mark the user already dislikes: at favicon size it *is* a blue
rounded square with an M. The flat silhouette is the weakest of the six, because a cap
outline with a knocked-out M and a seam line is a lot of information in one colour.

## 02 — Waveform Monogram Trace

**Idea.** The M drawn as one unbroken 64-unit stroke with round caps and joins, so the
letterform and an oscilloscope trace are literally the same line, sitting on a faint baseline.

**Why it isn't generic.** The two readings are the same object rather than a letter with a
waveform stuck next to it: the outer strokes are steep (60:176) and the inner V is shallow
(100:124), which is what makes it read as *M* rather than as a zigzag, while the round joins
and the baseline are what make it read as *audio*. Nothing in it is decoration.

**Risk.** Loses the "object you press" story that the iOS icon has, so the app icon needs a
container (see the recommendation below). Read cold, a rounded zigzag can also suggest a
mountain range or a heart-rate trace; the baseline pulls it toward audio, and the baseline is
the first thing that disappears at small sizes.

## 03 — Bubble Tail Monogram

**Idea.** One solid shape: a speech bubble whose two counters are cut up from the bottom edge,
so the mass reads as an M — and the ink between the counters keeps going past the bottom edge
and tapers to a point, which is the bubble's tail.

**Why it isn't generic.** It is not a bubble with a letter inside it; the letter and the
bubble are the same silhouette, and the tail is the M's centre vertex doing double duty. The
proportions are set to make both readings survive: legs 72 wide, counters 89 wide, tail 34
wide where it leaves the body, big 80 radius on the top corners and a tight 30 on the bottom
so the legs read as stems rather than as a rounded square.

**Risk.** The heaviest silhouette of the six, and the one that suffers most at 16px: the
counters close and it becomes a blue blob with a notch (the flat version survives better than
the colour one). A centred tail also flirts with map-pin; the two legs flanking it are what
stop that, so it must never be used with the legs cropped.

## 04 — Live Hold Ring

**Idea.** No letter: the speaking ring the UI already puts around talking avatars, broken like
a hold gauge, around the talk key — the mark is a *state*, not an object.

**Why it isn't generic.** The ring is deliberately unequal — a 180° dim arc and a 108° bright
arc with two 36° gaps — so it reads as a ring lighting up rather than as a target or a
spinner, and the core is the app's squircle keycap, not a circle, which is what keeps it tied
to push-to-talk. Best small-size behaviour of the set after 02.

**Risk.** Ring-plus-core is a crowded space: loading spinner, record button, power button. It
is also the candidate that says nothing about *speech* on its own — it needs the product
around it to mean "presence". Conceptually adjacent to 06.

## 05 — Whisper Waveform Bars

**Idea.** No letter: four fat capsules on a centre line — one short utterance rising and
falling away, at deliberately low amplitude, because *mutter* is quiet speech.

**Why it isn't generic.** Four bars rather than the usual five so nothing is a hairline at
16px (66 wide, 34 apart — a bar is still 2px at favicon size); centred on an axis like a real
waveform rather than sitting on a floor like a settings equalizer; and the rhythm is a phrase
(168, 300, 236, 128) rather than a symmetric decoration.

**Risk.** The weakest of the six on ownability, and I would say so to the user's face: audio
bars are the most-used mark in this category (Voice Memos, Siri, every podcast app). It also
shares its subject with 02 without 02's letterform payoff, and the two middle bars merge into
each other at 16px.

## 06 — Key On Air

**Idea.** No letter: the talk key with sound leaving it, drawn as one heavy pair of *squircle*
brackets in the app's own corner radius rather than as radio arcs.

**Why it isn't generic.** Concentric circular arcs would be a wifi/broadcast cliché; using the
product's own rounded-square geometry for the emission makes the sound look like it came off
that specific key. Everything is 46 units or heavier, so there is no detail that evaporates.

**Risk.** Still the closest to "signal" iconography, and at 16px it collapses to roughly the
same blob as 04 — the two are close enough that they should not both go forward. Reads as a
scanning/focus reticle if the brackets get any longer.

---

## Recommendation: 02 — Waveform Monogram Trace

It is the only candidate that is a *mark* rather than an *icon*: it works with no container,
in one colour, at 16px, and at 200px, and it survives the accent swap without any of its
lighting logic breaking. It carries the name (M) and the product (a voice trace) in a single
gesture, which is what the current flat-square-with-an-M has none of — and unlike 01 it does
not degrade into exactly the thing the user already called plain. It is also the most
confident piece of geometry here: one stroke, one weight, no ornament, which is the register
Linear and Raycast operate in.

The keycap should not be thrown away, though. The strongest system is **02 as the brand mark
and 01 as the app icon with 02's trace on the cap face instead of the letter M** — the icon
stays the object you press (continuity with `make-appicon.swift`), the mark travels
everywhere else, and they are recognisably the same drawing. That composite is one edit to
`cand-1.svg` (swap the `<path class="ink">` for the trace path) and is worth rendering before
anything is committed.

If the user wants a mark with no letter at all, take **04**, not 05 or 06.

### Notes for whoever implements the winner

- `web/app/icon.svg` and the `.cap` class in `web/app/style.css` are the two places the
  current mark lives on the web side; `scripts/make-appicon.swift` is the iOS one. Nothing in
  the repo was touched for this exercise.
- All twelve SVGs parse as XML (checked), so they work as `<img src>`, as `<link rel=icon>`,
  and inlined. Beware when inlining more than one in the same document: they share gradient
  and filter ids, so scope them (the sheet script does this).
- The 16px renders in `sheet.png` are real 16px rasterisations, not scaled-down large ones.
