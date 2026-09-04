# Mutter app mark — round four: the shape of the M

Twelve letterform constructions. Monochrome (#FAFAFA on transparent), 512 viewBox, judged on
silhouette alone. No colour, no material, no tile as a design idea — the neutral rounded tile in
`sheet.png` is a viewing aid so each mark can be read as an app icon.

## What was wrong with the rejected mark

`/tmp/logo2/t-6.svg` and `/tmp/logo3/v-5.svg` share the path
`M96 344L156 168L256 292L356 168L416 344`, stroked 64 with round caps and round joins. Four things
are wrong with it, and every candidate below is a response to at least one:

1. **It is a polyline, not a letterform.** Both outer strokes lean inward at about 19°. An M's
   defining feature is a pair of *vertical* outer stems; without them the eye files the shape under
   W, N, check mark or mountain. Eleven of the twelve below have true vertical stems.
2. **Round caps float.** A 64-wide round cap puts the terminal's visual mass 32 units *past* where
   the stroke stops, and the resulting half-disc has no flat to sit on. Nothing in the mark touches
   a baseline. Every candidate below either cuts its terminals flat (butt caps / flat feet) or
   deliberately runs the vertex past the baseline as a point.
3. **The middle is too shallow.** The centre vertex reaches y=292 in a 168–344 band — 70% of the
   way down. The middle counter is a shallow dish and the two "peaks" are barely peaks. Candidates
   here put the vertex at 78–100% of cap height, or past it.
4. **It blobs at 16px.** Round joins on a 64 stroke fill the counters at small size; the three
   apertures merge and the shape becomes a lozenge. Miter and flat joins hold the counters open.

Two optical corrections are applied throughout, because a mathematically correct M looks wrong:

- **The outer stems are cut heavier than the inner diagonals** (typically 56/48, 48/41). On a
  symmetric M the diagonals read heavier than they measure, because each one is crossed by two
  junctions and sits at an angle; matching them numerically makes the middle look clogged.
- **A pointed vertex overshoots the baseline** by 5–9 units. A point that stops level with a flat
  terminal reads as short, the same reason an O overshoots a H.

---

## 01 — Structural M

**Construction.** The textbook geometric capital: two vertical stems from cap line to baseline,
two straight diagonals from the top corners down to a single centre vertex, 300 wide × 248 tall.

**Decisions.** Stems 56, diagonals 48 perpendicular — the outer/inner correction above. Vertex at
y=326, which is 78% of the cap height, so the middle counter is a deep wedge rather than a dish and
the two apertures beside it are clearly triangular. Terminals are flat and land square on y=380;
there are two real feet, which is what the rejected mark never had.

**At 16px.** Holds. All three counters stay open in the true 16×16 raster and the vertex is legible
as a notch. The safest reading in the set alongside 02 and 12.

## 02 — Pointed M

**Construction.** Same skeleton as 01 but the centre vertex is carried the whole way down and
through the baseline; display width, 332 × 252.

**Decisions.** Stems 62, diagonals 54 — the heaviest cut here, because the deep V takes width out
of the middle and the letter can afford it. Vertex at y=389, a 9-unit overshoot past the baseline
at 380: the point has to break the line to look level with the flat feet. The diagonals are
steeper than 01's, which pushes the middle counter's apex down to y≈294 and makes the aperture a
tall slot instead of a triangle.

**At 16px.** The strongest in the set. The vertex is the last thing to survive downscaling and
here it runs the full height, so it survives; the counters stay open because the diagonals are
steep and the joins are all sharp.

## 03 — Monoline Butt

**Construction.** A single 52-unit stroke on the skeleton `stem → diagonal → diagonal → stem`,
with butt caps and miter joins.

**Decisions.** Butt caps, which is the direct fix for the rejected mark: both feet terminate on a
flat horizontal edge sitting on y=360. Miter joins with limit 8 keep the shoulders and the vertex
sharp — the shoulders come to the slanted points that a monoline M naturally makes (Futura does the
same). The vertex is held at y=300 rather than deeper, because a miter at that angle projects 37
units past the join and any deeper would spike through the baseline.

**At 16px.** Reads, but it is the lightest thing here after 12; the even stroke gives up the
weight contrast that helps 01 and 02 hold their structure. Fine at 32px, marginal at 16.

## 04 — Envelope M

**Construction.** The waveform idea done as a letterform rather than a polyline: the same M
skeleton drawn as a filled outline whose stroke width varies along its travel.

**Decisions.** The diagonals are 98 units wide (horizontally) where they leave the cap line and
taper to 34 at the vertex; the stems flare from 42 at the top to 68 at the foot. Weight collects
where the letter turns and thins where it passes through, which is the shape of an amplitude
envelope. Vertex at y=340, counter apex at 286, so the V stays a real V despite thinning. Flat
terminals; the flare gives the feet a wider footprint than any other candidate, which is why it
sits so solidly.

**At 16px.** Softest of the "plain M" group. The taper is below the resolution of a 16px raster, so
what you get is a slightly mushy version of 01 — the modulation is a 180px idea, not a 16px one.

## 05 — Asymmetric Peaks

**Construction.** 01's skeleton with the symmetry broken: the left stem tops out at y=118, the
right at y=176, and the vertex sits 10 units right of centre, so the two diagonals take different
angles.

**Decisions.** Stems 56, diagonals 48. Both stems stay vertical and both feet stay on the baseline,
so the asymmetry never costs legibility — the letter is still a letter, it just decays from left to
right the way an attack-and-decay envelope does. Vertex at y=330. The taller peak is on the left
because that is the reading-order start and the transient belongs at the beginning.

**At 16px.** Reads, and the asymmetry is still visible at 16 true, which is rare. The risk is not
legibility but interpretation: at small size a non-designer may read the uneven shoulder as a
rendering bug rather than a decision.

## 06 — Condensed M

**Construction.** 01's construction at 200 wide × 264 tall — the narrowest set here, ratio 0.76.

**Decisions.** Stems 46, diagonals 40, scaled down with the width so the colour matches the rest of
the set. Vertex at 80% depth (y=336). The narrow set turns the counters into tall slots instead of
wide triangles.

**At 16px.** **Fails.** In the true 16×16 raster the slot counters are under one pixel wide, they
fill, and the result reads as an H. This is the useful negative result of the round: at icon sizes
the M wants to be wide, not narrow.

## 07 — Extended M

**Construction.** 01's construction at 388 wide × 212 tall, ratio 1.83 — the widest set here.

**Decisions.** Stems 64, diagonals 56, both heavier in absolute terms because the letter is shorter
and needs the colour. Vertex at 80% (y=322). Wide setting buys the widest counters in the group.

**At 16px.** Best-in-set for raw survival — the counters are the last to close, so this is the
clearest M of the twelve at true 16×16. It also fills a square tile better than anything else. The
cost is that it stops looking like type and starts looking like a logotype; at 180px it is notably
squat.

## 08 — Arc Shoulders

**Construction.** The diagonals replaced by cubic arches that leave the stems on a vertical
tangent, so the letter is two curved peaks with a cusp between them.

**Decisions.** Monoline 54, butt caps flat on the baseline at y=370 — the curve is the idea, the
terminals still have to sit. Miter join at the valley for a sharp cusp; the control points are
pulled shallow deliberately so the miter tip lands at y≈367, three units *above* the baseline,
rather than spiking through. Vertex at y=290, shallower than the straight-sided candidates, because
a curved shoulder already gives the eye the peak it needs.

**At 16px.** Reads as an M but softly — the arches lose their tangency and it drifts toward a
rounded lozenge, which is the same failure mode the rejected mark had, just less severe. Keep it as
a study, not as the mark.

## 09 — Barred M

**Construction.** A 46-unit crossbar spans both stems at the cap line and the V hangs off its
underside, which closes the middle counter into an enclosed triangular aperture. Cut with
`fill-rule="evenodd"`.

**Decisions.** Stems 58, diagonals 52, vertex at y=366 (almost the baseline) so the closed counter
is a tall wedge rather than a dot. This is the deliberately unconventional one, and the argument
for it is structural, not decorative: a closed counter is the cheapest way to make a silhouette
identifiable, because a hole is a feature no competitor's blob has. Real precedent exists — barred
capitals are standard in monogram and in Devanagari-influenced display faces.

**At 16px.** **Fails.** The bar and the closed counter both need about three pixels and only get
one; the whole thing fills to a rectangle with a nick in it. It is a 180px mark and a 32px mark, not
a 16px one.

## 10 — Tailed M

**Construction.** 01's stems and diagonals, but the centre vertex carries 102 units past the
baseline and closes to a sharp point.

**Decisions.** Cap height compressed to 212 (y=104 to y=316) so that the descending tail does not
push the whole mark off centre — the letter body sits high in the frame and the tail balances it.
Stems 54, diagonals 48. The point nods at a speech-bubble tail without drawing a bubble, and it
solves the rejected mark's real problem — the middle had nowhere to go — by giving the vertex the
longest run in the set.

**At 16px.** Reads, and the descender is still visible, which makes it the most *distinctive*
silhouette here after 05. The cost is that the letter body is small in the frame, so it looks
lighter than 02 at the same nominal size.

## 11 — Cut Disc

**Construction.** A solid 400-unit disc with the letter removed; the M exists only as negative
space. `fill-rule="evenodd"`.

**Decisions.** Stems 48 and diagonals 42, both lighter than the drawn candidates, because a
knocked-out shape optically gains weight — the counters are the bright part and they bleed into the
cut. The letter is inset on every side so the counters stay attached to the field rather than
floating as islands. A disc rather than a rounded square so it reads as a mark and not as an app
tile.

**At 16px.** **Fails.** At true 16×16 the disc wins and the letter is a grey smudge inside it —
there simply are not enough pixels to spend on both a field and a counter. Negative space needs
about 24px minimum.

## 12 — Grotesk M

**Construction.** The plain one. Text proportions, 268 wide × 240 tall, vertex to the baseline.

**Decisions.** Stems 48 against diagonals 41 — the lightest cut here, deliberately, because this is
the candidate that has to look like *type* rather than like a logo. Vertex at y=381, a 5-unit
overshoot past the baseline at 376. Flat terminals. There is no idea in it: it is a well-set
capital M, which is the point. This is the option a design director cannot argue with.

**At 16px.** Reads cleanly, but it is the lightest in the set and at true 16×16 it goes a shade
thin next to 02 and 07. If this is the direction, it wants roughly 15% more weight before it ships.

---

## Verdict

**Recommend 02 Pointed M.** It is the only candidate that is simultaneously unarguable as a letter
and best-in-class at 16px: the vertex runs the full cap height, so the one feature that
distinguishes M from W and N is also the feature most likely to survive rasterisation. The 9-unit
overshoot and the 62/54 stem-to-diagonal ratio are the two moves that make it look drawn rather
than plotted. It fills a tile without looking squat and it is structurally boring in the way Linear
and Mux are boring.

**Second and third: 07 Extended M** if the icon has to win at 16px above all else, and
**05 Asymmetric Peaks** if the audio reference has to be legible in the mark itself — it is the
only candidate that carries the waveform idea without giving up the letterform.

**Cut 06 Condensed M** (reads as an H at 16px), **11 Cut Disc** (illegible below ~24px) and
**09 Barred M** (the closed counter, which is its whole reason to exist, is the first thing to
disappear).
