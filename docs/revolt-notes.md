# Revolt / Stoat UI notes

Measured from two trees. `R/` = `/tmp/revite/src` (Revolt's legacy Preact client, the Discord-shaped
one); `S/` = `/tmp/stoat/packages/client` (current Solid.js client, Material 3). revite's
`@revoltchat/ui` submodule is **not checked out**, so `Header`, `Category`, `MessageDivider` and
`IconButton` have no source on disk; where a number is missing there the Stoat equivalent is given
and marked `[S]`.

## 1. Layout skeleton

`R/pages/RevoltApp.tsx` docks three panels (`react-overlapping-panels`) as flex rows, each `flex-shrink: 0`:

- Left panel `290px` = server rail `58px` (derived) + channel sidebar `232px` (`R/components/navigation/SidebarBase.tsx` `GenericSidebarBase`; `left/ServerSidebar.tsx` `ServerBase`)
- Right panel (members) `236px`; message column `min-width: 0; flex: 1; flex-direction: column`; bottom nav (touch only) `50px` = `--bottom-navigation-height`
- Header `48px` desktop / `56px` touch — `R/mobx/stores/helpers/STheme.ts:122` → `--header-height`; desktop titlebar `29px`; `--app-height` re-set to `window.innerHeight + "px"` on every resize
- Stoat runs wider: `--layout-width-channel-sidebar: 248px`, members `248px`, search/pins sidebar `360px`, header `48px`, banner header `120px` (`S/components/ui/themes/stoatWebTheme.ts`, `S/src/interface/channels/text/TextChannel.tsx:263,351`)

**Rounded vs flush.** revite is flush except that whichever panel borders the message column takes
`border-start-start-radius: 8px; border-end-start-radius: 8px`, so the message area reads as sitting
*behind* rounded sidebars (`ServerBase`, `Routes`). Stoat makes the main surface a floating card —
`margin-inline: 8px; margin-block-end: 8px; padding-inline: 8px; border-radius: 28px; background:
surface-container-lowest` (`S/components/ui/components/layout/Main.tsx`) — collapsing to `margin: 0;
border-radius: 0` on tablet/phone. Sidebars are translucent: `background-color:
rgba(var(--background-rgb), max(var(--min-opacity), .75)); backdrop-filter: blur(20px)`.

**Breakpoints.** revite has essentially none — it branches on `isTouchscreenDevice`
(`R/lib/isTouchscreenDevice.ts`) and slides panels rather than hiding them; the only width query in
the shell is `@media (max-width: 800px)` hiding jump-bar labels. Stoat has exactly two
(`S/components/common/Breakpoint.ts`): `_phone (max-width: 600px)` and `_tablet (max-width: 840px),
(max-height: 600px)`. On `_phone` the sidebar becomes an overlay (`position: absolute; width: 100vw;
height: 100%`, `--layout-width-channel-sidebar: auto`). Visibility is otherwise *state*, not media —
`SIDEBAR_CHANNELS` / `SIDEBAR_MEMBERS` in `R/mobx/stores/Layout.ts`.

**Scrollbars** (`R/styles/_elements.scss`): `--scrollbar-thickness: 3px` (`thin` on Firefox);
`::-webkit-scrollbar { width: 3px; height: 3px }`; thumb `min-width/min-height: 30px;
background: var(--scrollbar-thumb); background-clip: content-box`; track transparent. A thumb under a
header takes `border-top: var(--header-height) solid transparent` so it never runs beneath it; the
message list overrides thumb `min-height: 150px`. Stoat instead uses `scrollbar-color:
var(--md-sys-color-primary) transparent; scrollbar-gutter: stable`, plus an `invisibleScrollable`
directive (`scrollbar-width: none` + `::-webkit-scrollbar { display: none }`) for the rails.

## 2. Server rail

From `S/src/interface/navigation/servers/ServerList.tsx` (revite's is in the missing package; the
geometry matches — 58px rail, 42px icons).

- Entry slot `56 × 56px`, `display: grid; place-items: center; position: relative; flex-shrink: 0`; icon `42px`, circular (`--border-radius-server-icon: 50%`)
- **The pill**, `&::before` on the entry: `content:" "; position:absolute; left:-8px; width:12px; height:0; border-radius:4px; background: var(--md-sys-color-on-surface); transition:.1s ease-in-out all`. Only `height` animates: `0` idle → `8px` unread → `16px` hover → `32px` selected.
- Unread badge (`S/components/ui/components/design/Unreads.tsx`): `<circle cx=27 cy=5 r=5>` in a `32×32` viewBox, so it hangs off the icon's top-right; numeric box `10×10` at `8px/600`; counts ≥ 10 show a `+`. revite's sidebar dot (`R/components/navigation/items/Item.module.scss` `.alert`) is `6×6` plain, or `16×16` white-on-`var(--error)` at `10px/600` for mentions.
- Order: **Home** → **your avatar** (opens the status menu) → unread DMs (capped at 9, overflow `+N`) → `1px` divider (`margin: 6px auto; width: calc(100% - 24px)`) → servers (draggable) → **`+` create/join** → **compass** → spacer → **settings** pinned at the bottom. A `12px` gradient (`margin-top: -12px`, transparent → surface) fades the list above the pinned entries.
- Every entry has a tooltip, `placement: "right"`.

## 3. Channel sidebar

**Server header** (`R/components/common/ServerHeader.tsx`). No banner: `height: var(--header-height)`,
`background-color: var(--secondary-header)`. With banner: block `height: 120px; background-size: cover;
background-position: center`, and the title strip takes `background: linear-gradient(0deg,
var(--secondary-background), transparent)`. Strip: `height: var(--header-height); padding: 0 14px;
font-weight: 600; gap: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis`. The name
opens the server-info modal; `Cog size={20}` sits right when manageable; `20×20` badges before the name.

**Category headers.** revite wraps them in `<CollapsibleSection>` (`R/components/common/CollapsibleSection.tsx`)
with a `ChevronDown size={20}` and per-category persisted state. Stoat's rule `[S]`
(`S/src/interface/navigation/channels/ServerSidebar.tsx`): `font: 500 13px/.875rem; letter-spacing:
.03125rem; padding: 10px 4px 0 20px; gap: 4px; cursor: pointer; user-select: none; color: on-surface`
(hover `on-surface-variant`), chevron `12px` with `transition: .1s ease-in-out transform` and
`rotateZ(90deg)` when open. Stoat does **not** uppercase them; for the Discord feel use
`text-transform: uppercase; font: 700 12px; letter-spacing: .02em`.

**Channel rows** (`R/components/navigation/items/Item.module.scss`):

```css
.item { height: 42px; padding: 0 8px; margin-bottom: 2px; gap: 8px; cursor: pointer;
  border-radius: var(--border-radius); font-size: 16px;            /* radius 6px */
  color: var(--tertiary-foreground); transition: .1s ease-in-out background-color }
.item.compact { height: 32px }             /* server channel lists use compact */
.item:hover, .item[data-active=true] { background: var(--hover); color: var(--foreground) }
.item[data-muted=true] { opacity: .4 }   .item[data-margin=true] { margin: 0 6px }
@media (pointer: coarse) { .item { height: 50px } }
```

- Icon `ChannelIcon size={compact ? 24 : 32}`; user rows `UserIcon size={32}` with status
- Name `font-weight: 600; font-size: .90625rem` (14.5px); optional second line `.subText { font-size: .6875rem; font-weight: 500; margin-top: -1px; color: var(--tertiary-foreground) }`
- Unread = the row loses its dim and shows the `6px` dot; active rows hide the dot entirely
- Hover swaps badge for action icon: `.item:hover .button .alert { display:none }`, `.item:hover .button svg { opacity:1; display:block }`
- User rows `.item.user { opacity: .4 }` → `1` on `[data-online=true]` or `:hover`, over `.1s ease-in-out`
- List container `padding: 6px; flex-grow: 1; overflow-y: scroll`
- Stoat's row `[S]`: `height 42px; margin 0 8px; padding 0 8px; gap 8px; border-radius 28px; font: 500 15px`; selected = `on-primary-container` on a `primary-container` pill; hover feedback is a Material ripple, not a background swap

**Voice-channel participants**, listed under the channel row
(`S/components/ui/components/features/voice/VoiceChannelPreview.tsx`): list `margin-block: 4px;
margin-inline: 32px 8px; border-radius: 12px; color: var(--md-sys-color-outline)`. Each row
`display: flex; align-items: center; gap: 8px; padding: 4px; border-radius: 12px` with a `24px`
avatar. Speaking sets `color: on-surface` and puts `outline: 2px solid var(--md-sys-color-primary);
outline-offset: 1px; border-radius: 100%` on the avatar. Muted / deafened / camera / screenshare are
small trailing glyphs.

**Bottom user panel.** revite puts it at the *top* of the DM sidebar
(`R/components/common/user/UserHeader.tsx`): display name `16px/600`, `username#0000` `13px/600`
(click = copy, tooltipped), custom status `12px` with `margin-top: -2px` (click opens the status menu),
`Cog size={24}` → `/settings`. Stoat has no bottom panel at all — the avatar is second in the rail and
opens `UserMenu` (avatar `32px`, status swatch `16px`, status text truncated at `300px`). For a
Discord-shaped one: `52–56px` strip, `32px` avatar with a `10px` status dot punched out bottom-right,
name `14px/600`, status `12px` dimmed, three `32×32` icon buttons (mic / headphones / cog) taking
`background: var(--hover)` on hover.

## 4. Message list

Revolt is **cozy only** — the compact toggle is commented out (`R/pages/settings/panes/Appearance.tsx:38`
`// <DisplayCompactShim />`). Stoat brought compact back but hid it under Settings → Advanced
(`appearance:compact_mode`, default `false`); compact simply forces every message to be a `tail` and
drops the fixed left gutter. From `R/components/common/messaging/MessageBase.tsx`:

- Row `padding: .125rem` (2px) + `padding-inline-end: 16px`; left gutter `MessageInfo` `width: 62px; padding-top: 2px; justify-content: center` (Stoat `54px`)
- Avatar `36px` circular; group-head spacing `margin-top: 12px` (Stoat `--message-group-spacing`, default `12px`, adjustable `0–16`)
- Body `var(--text-size)` = `14px` (Stoat `--message-size`, default `14`, slider `12–24`)
- Author `font-weight: 600`, 1-line clamp, `:hover { text-decoration: underline }`; name↔time gap `8px`
- Head-line timestamp `10px` in `var(--tertiary-foreground)`. On grouped lines the same `10px` time sits in the gutter at `opacity: 0`, fading to `1` on row `:hover`
- Row hover `background: var(--hover)`; mention `background: var(--mention)` across the whole row; sending `opacity: .8; color: var(--tertiary-foreground)`; failed `color: var(--error)`
- Blocked `filter: blur(4px); transition: .2s ease filter`, cleared on hover; runs of blocked messages collapse to one line at `font-size: .8em; margin-top: 6px; padding: 4px 64px`
- Jump-to highlight: a `3s ease` keyframe holding `var(--mention)` to 66%, then transparent

**Grouping rule** (`R/pages/channels/messaging/MessageRenderer.tsx`): break the group when the author
changes, **or `Math.abs(bTime - aTime) >= 420000`** (7 minutes, decoded from the ULID), or the
masquerade changed, or a divider was just emitted, or the message has replies. Stoat uses the identical
`420000` (`S/components/app/interface/channels/text/Messages.tsx:774`).

**Hover action toolbar** (`R/components/common/messaging/bars/MessageOverlayBar.tsx`), absolutely
positioned inside the message content box:

```css
position: absolute; right: 0; top: -18px; border-radius: 5px; transition: box-shadow .1s ease-out;
background: var(--primary-header); border: 1px solid var(--background);
:hover { box-shadow: rgb(0 0 0 / 20%) 0 2px 10px }
.entry { width:32px; height:32px; display:grid; place-items:center;
         color: var(--secondary-foreground); transition: .2s ease background-color }
.entry:hover { background: var(--secondary-header); color: var(--foreground) }
.entry:active svg { transform: translateY(1px) }
.divider { width: .5px; margin: 6px 4px; background: var(--tertiary-background) }
```

Icons `18px`, in order **Reply → React → Edit** (own) **→ Delete** (`var(--error)`) **→ More**. Holding
<kbd>Shift</kbd> appends a divider plus **Mark as Unread → Copy Link → Copy ID**. Hidden on touch.

**Reply bar above a message** (`attachments/MessageReply.tsx`) — the elbow is pure CSS: `.reply
{ margin-inline: 30px 12px; font-size: .8em; gap: 8px; align-items: end; color:
var(--secondary-foreground) }` and `.reply::before { content:""; width:22px; height:10px;
align-self:flex-end; border-inline-start: 2px solid var(--message-box); border-top: 2px solid
var(--message-box) }`. Preview `.content { max-height: 32px; overflow: hidden }`, hover
`filter: brightness(2)`.

**Date divider** `[S]`: a `height: 0` rule, `margin: 17px 12px 17px 8px; border-top: thin solid
var(--outline-variant)`, with the date sitting on it at `.6875rem/600; padding-inline: 5px;
border-radius: 12px`. **"New messages"** turns that border `primary` and adds a `NEW` pill
(`.625rem/600; padding: 0 6px; border-radius: 60px; on-primary` on `primary`); revite additionally
floats an accent bar at the top of the list (§5).

**System messages** (`SystemMessage.tsx`): `font-size: 14px; color: var(--secondary-foreground);
gap: 4px; padding: 2px 0; flex-wrap: wrap`; embedded names `600` in `--foreground`, underlined on hover;
leading icon `1.33em` with `margin-right: .5em`.

**Attachments / embeds** (`R/styles/_variables.scss`, `attachments/Attachment.module.scss`):
`--attachment-max-width: 400px; --attachment-max-height: 300px; --attachment-default-width: 400px;
--attachment-max-text-width: 800px`. Images `grid-auto-columns: min(100%, 400px)`, `border-radius: 6px`,
`margin: .125rem 0`. Audio block `400px` wide, `padding: 6px`. Text preview `height: 140px; padding:
12px; background: var(--secondary-header)`. Spoilers `filter: blur(30px); pointer-events: none`. Link
embeds: `border-inline-start: 4px solid <colour>; padding: 12px; background: var(--primary-header);
border-radius: 6px`; favicon `14×14`, site `11px`, title `1.1em` clamped to 2 lines, description `12px`
clamped to 6. Stoat clamps media instead: `MIN 160×120`, `MAX 420` per axis, aspect preserved.

**Mention chip** (`R/components/markdown/plugins/mentions.tsx`): inline-flex, `padding: 0 6px 0 2px;
border-radius: calc(var(--border-radius) * 2)` (12px), `background: var(--secondary-background);
font-weight: 600`; hover `filter: brightness(.75)`, active `.65`.

**Markdown** (`R/components/markdown/RemarkRenderer.tsx`, `plugins/Codeblock.tsx`):

```css
p { margin: 0 }   h1..h6 { margin: .2em 0 }   a { color: var(--accent); text-decoration: none }
ul, ol { padding-left: 10px; margin: .2em 0; list-style-position: inside }
code { color:#fff; background: var(--block); font-size:90%; border-radius:3px;
       padding: 1px 4px; font-family: var(--monospace-font) }
pre  { padding: 1em; overflow-x: scroll; background: var(--block); border-radius: 6px }
blockquote { background: var(--hover); border-inline-start: 4px solid var(--tertiary-background);
             border-radius: 6px; margin: 2px 0; padding: 2px 0 }  /* children margin: 0 8px */
th, td { padding: 6px; border: 1px solid var(--tertiary-foreground) }
```

Code blocks carry a copy chip: accent background, `#111` text, `10px` uppercase `600`,
`box-shadow: 0 2px #787676`, `border-radius: 2px`, pressing it `translateY(1px)`. Reactions: list
`gap: .4em; margin-top: .2em`; pill `padding: .4em; border-radius: 6px; background:
var(--secondary-background)`, emoji `1.2em`; the add button appears on list hover only.

**Scrolling** (`MessageArea.tsx`): container `padding-bottom: 26px`; loads more at `100px` from either
edge; smooth jump-to-bottom `150ms`; `MESSAGE_AREA_PADDING = 82` is subtracted from the width for
attachment sizing. **Conversation start**: `margin: 18px 16px 10px`, `h1` `23px`, `h4` `400 14px`.

## 5. Composer

`R/components/common/messaging/MessageBox.tsx`:

- Bar `background: var(--message-box)` (`#363636` dark), `align-items: flex-start` so it grows upward
- `--message-box-padding: 14px 14px 14px 0`, `--textarea-line-height: 20px` → single-line height ≈ `48px`
- Auto-growing textarea `maxRows={20}`, `maxLength={2000}`. Stoat caps the whole box at `--layout-height-message-box: 32vh`, `border-radius: 28px`, `padding: 4px 8px`
- Attach button `48 × 62px` hit area; emoji `HappyBeaming size={24}` and send `Send size={20}` in `48 × 48px` actions. Send is hidden on desktop unless `appearance:show_send_button`, always shown on touch (`.mobile { width: 62px }`). A `16px` spacer replaces the attach button when uploads are denied.
- Keys: `Enter` sends (unless shift / IME composing / touch / caret inside a fenced code block); `Ctrl+Enter` always sends; `ArrowUp` on an empty box edits your last message; `Escape` pops the last reply, then the last attachment; `s/find/replace` edits your last message

**Typing indicator** (`bars/TypingIndicator.tsx`) — a strip floating directly above the composer:

```css
height: 26px; top: -26px; position: absolute; padding: 0 10px; gap: 8px; font-size: 13px;
width: calc(100% - var(--scrollbar-thickness)); color: var(--secondary-foreground);
background-color: rgba(var(--secondary-background-rgb), max(var(--min-opacity), .75));
backdrop-filter: blur(10px);
.avatars img { width:16px; height:16px; border-radius:50%; border:2px solid var(--secondary-background)}
.avatars img:not(:first-child) { margin-left: -6px }
```

Text patterns (`S/src/interface/channels/text/CompositionInfo.tsx`, same three cases in revite):
1 → `{name} is typing…` · 2–4 → `{a, b} and {c} are typing…` · ≥5 → `Several people are typing…`.
Sorted by id; self and blocked users filtered out.

**File preview bar** (`bars/FilePreview.tsx`): `padding: 8px; gap: 4px; background: var(--message-box)`;
horizontal carousel `gap: 8px`; tiles ~`100×100`, `border-radius: 6px`; the trailing "add more" tile is
`100×100` on `--primary-background`, hover `--secondary-background`, `.1s ease`; a `4 × 130px` divider
separates queued files from it; filename `.8em` truncated at `180px`, size `.6em`. `CAN_UPLOAD_AT_ONCE = 5`.

**Reply bar** (`bars/ReplyBar.tsx`): one `30px` row per reply, `padding: 0 20px`, `background:
var(--secondary-background)`, entering with `bottomBounce 340ms cubic-bezier(.2, .9, .5, 1.16)`. Right
side: an `@ On/Off` mention toggle (`12px/800`, uppercase, `min-width: 6ch`) and `XCircle size={16}`.
`MAX_REPLIES = 5`.

**Jump-to-bottom / new-messages bars** (`bars/JumpToBottom.tsx`, shared `Bar`): `> div { height: 28px;
padding: 0 8px; font: 600 12px; justify-content: space-between; transition: color ease-in-out .08s;
backdrop-filter: blur(20px) }`. Bottom variant `top: -28px` (touch `-90px`), `border-radius: 6px 6px 0 0`;
top variant `top: 0` with inner `top: 48px` (touch `56px`), `border-radius: 0 0 6px 6px`. Both animate
`340ms cubic-bezier(.2, .9, .5, 1.16)` from `translateY(±33px)`. Default palette
`secondary-background @ .9`; the "new messages" variant is `accent @ .9` with `--accent-contrast` text.
Copy: *"Viewing older messages" / "Jump to present" ↓* and *"New messages since {time ago}" / "Jump to
beginning" ↑*. Below `800px` the right-hand label hides, leaving the arrow.

## 6. Member list

`R/components/navigation/right/MemberList.tsx` + `MemberSidebar.tsx`, virtualised (`GroupedVirtuoso`;
Stoat uses a fixed `itemSize: 42`).

**Grouping**: hoisted roles by `role.rank` descending (only `hoist: true`), then `Online`, then
`Offline`. Sort within a group by `member.nickname ?? user.username` with `localeCompare`;
`presence === "Invisible"` counts as offline.

**Group header**: `opacity: .8; font-size: .8em; font-weight: 600; user-select: none; padding: 4px 14px;
padding-top: 12px` (`16px` for every group after the first); `color: var(--secondary-foreground);
background: var(--secondary-background)`. Label reads `Online – 12` / `Offline – 43` / `<role> – N`
(en-dash, spaces around it).

**Row**: the shared `.item` from §3 plus `.user` — `42px` tall, `32px` avatar, `opacity: .4` when offline
rising to `1` on hover, name `.90625rem/600`, status `.6875rem/500` dimmed. Stoat's muted variant instead
does `color: outline-variant` + `img { opacity: .3 }`.

**Status dot geometry** (`R/components/common/user/UserIcon.tsx`): the avatar is an SVG with
`viewBox="0 0 32 32"`; the dot is `<circle cx=27 cy=27 r=5>` **masked out of** the avatar, so it holds
84%/84% at any size. A voice state replaces it with a `10×10` circle at `x=22 y=22`, `background:
var(--error)`, holding a `6px` mic-off or volume-mute glyph.

**Presence colours** (identical in `R/context/Theme.tsx` and `S/.../stoatWebTheme.ts`): online `#3ABF7E` ·
idle `#F39F00` · focus `#4799F0` · busy `#F84848` · streaming `#977EFF` · invisible `#A5A5A5`.

## 7. User profile card

**Hover card** (`R/components/common/user/UserHover.tsx`): a tippy tooltip, `placement: "right-end"`,
username `13px/600`, status `11px` ellipsised.

**Full card** (`R/controllers/modals/components/legacy/UserProfile.module.scss`): modal `height: 460px`,
flex column, `padding: 0`. Banner `background-size: cover; border-radius: 6px 6px 0 0`, falling back to
`--secondary-background`. Profile row `width: 560px; padding: 20px; gap: 16px; align-items: center` with
`.displayname 22px/600`, `.username 13px/600` secondary, `.status 13px` secondary. Tabs `padding: 0 1.5em;
.875rem/500`, item `padding: 8px`, `border-bottom: 2px solid transparent` → `var(--foreground)` active /
`var(--tertiary-foreground)` hover, `transition: .3s`. Content `min/max-height: 240px; padding: 1em 1.5em;
background: var(--primary-background); border-radius: 0 0 6px 6px`, with `.category 12px/600 uppercase`
tertiary (`margin-bottom: 8px`) and `.entry { padding: 12px; gap: 12px; border-radius: 6px; background:
var(--secondary-background) }` → `--primary-background` on hover over `.1s`, `img 32px` circle. Badges
`24×24`, `gap: 8px`.

Stoat's `[S]` is a `340 × 400` floating card, `border-radius: 28px`, `box-shadow: 0 0 3px
var(--md-sys-color-shadow)`, `background: surface-container-high`, laid out as a 2-column grid with
`gap: 8px; padding: 8px`. Sections in order: **Banner** (full width, `120px`, overlay
`linear-gradient(rgba(0,0,0,.2), rgba(0,0,0,.7))`, `48px` avatar *inside* it — no negative-margin
overlap), **Actions** (full width), **Roles**, **Badges**, **Status**, **Joined**, **Owner**, **Bio**.

**User context menu** (`R/lib/ContextMenus.tsx`), in order: `view_profile`, `message_user`, `mention`,
then relationship-dependent `add_friend` / `remove_friend` / `cancel_friend` / `block_user` /
`unblock_user`, then moderation `make_owner`, `remove_member`, `kick_member`, `ban_member` (all in
`var(--error)`), then `report_user`, then `copy_uid`.

## 8. Channel header

`R/pages/channels/ChannelHeader.tsx`, `actions/HeaderActions.tsx`:

- Height `var(--header-height)` = `48px` desktop / `56px` touch
- Leading icon `24px`: `Hash` text channel · `At` DM · `Group` group · `Notepad` saved notes
- Info block `display: flex; gap: 8px; align-items: center; min-width: 0; overflow: hidden; white-space: nowrap`; children are `display: inline-block`
- The name/description separator is a 1px vertical rule, not a bullet: `height: 20px; margin: 0 5px; padding-left: 1px; background-color: var(--tertiary-background)`
- Description `font-size: .8em; font-weight: 400; margin-top: 2px; color: var(--secondary-foreground)`. **Truncation is two-stage**: the source is `channel.description.split("\n")[0]` (first line only), rendered as inline markdown, then clipped by the parent's `nowrap; overflow: hidden`. Click opens the channel-info modal. Hidden entirely on touch.
- For DMs the description slot becomes a `10×10` status dot (`margin-inline-end: 6px`) plus status text
- Right-hand actions `display: flex; gap: 16px`, in render order: update indicator · `UserPlus size={27}` add member (groups) · `Cog size={24}` channel settings (groups) · `PhoneCall size={24}` / `PhoneOff size={22}` join/leave voice · `Group size={25}` toggle member sidebar · `Search size={25}` open search sidebar

## 9. Theme tokens

Every variable is emitted twice — `--x: <value>` **and** `--x-rgb: r, g, b` — so translucency composes as
`rgba(var(--x-rgb), .75)` (`R/context/Theme.tsx` `generateVariables`). Contrast partners `--x-contrast`
(black or white, by HSP luminance > 175) are generated too.

```css
/* R/context/Theme.tsx PRESETS.dark */
--accent:               #FD6671;    --foreground:           #F6F6F6;
--background:           #191919;   /* canvas behind the translucent rails      */
--primary-background:   #242424;   /* message column                           */
--primary-header:       #363636;   /* channel header, hover toolbar, embeds    */
--secondary-background: #1E1E1E;   /* sidebars, member list                    */
--secondary-foreground: #C8C8C8;    --secondary-header:     #2D2D2D;
--tertiary-background:  #4D4D4D;   /* rules, dividers                          */
--tertiary-foreground:  #848484;   /* timestamps, muted labels                 */
--block:                #2D2D2D;   /* code background                          */
--message-box:          #363636;   /* composer                                 */
--mention: rgba(251,255,0,.06);  --hover: rgba(0,0,0,.1);  --tooltip: #000000;
--success: #65E572;  --warning: #FAA352;  --error: #ED4245;
--scrollbar-thumb: #CA525A;  --scrollbar-track: transparent;   /* thumb = accent, 20% darker */
--status-online:#3ABF7E; --status-away:#F39F00; --status-focus:#4799F0;
--status-busy:#F84848;   --status-streaming:#977EFF; --status-invisible:#A5A5A5;
--logo-filter: invert(1);

/* R/styles/_variables.scss — structure */
--text-size: 14px;  --font: "Open Sans";  --ligatures: none;
--border-radius: 6px;  --border-radius-half: 50%;   /* user/channel/server icon radii = 50% */
--input-border-width: 2px;  --textarea-padding: 16px;  --textarea-line-height: 20px;
--message-box-padding: 14px 14px 14px 0;  --sidebar-active: var(--secondary-background);
--scrollbar-thickness: 3px;  --scrollbar-thickness-ff: thin;
--bottom-navigation-height: 50px;  --titlebar-height: 29px;
```

Light swaps to `background #F6F6F6`, `primary-background #FFFFFF`, `primary/secondary-header #F1F1F1`,
`foreground #000`, `hover rgba(0,0,0,.2)`, `mention rgba(251,255,0,.40)`, `tooltip #FFF`, `block #414141`,
`tertiary-foreground #3a3a3a`. Accent and status colours are identical in both. Runtime additions:
`--header-height`, `--app-height`, `--min-opacity` (0 when transparency is on, 1 when off — `1` also
globally kills every `backdrop-filter`), `--effective-bottom-offset`, `--monospace-font`.

**What Material 3 / Stoat changed:**

- **Dynamic colour.** The 24-variable palette is gone; Stoat generates all `--md-sys-color-*` at runtime from one seed via `@material/material-color-utilities` (`S/components/ui/themes/materialTheme.ts`) — default seed `#5470ec`, `contrast: 0.0`, variant `tonal_spot`. A parallel `--mdui-color-*` set holds the same colours as `"R, G, B"` triplets. 43 roles are emitted and there are **no literal hexes in the repo**. Accent swatches offered in the UI: `#FF5733 #ffdc2f #9bf088 #54ecc1 #549bec #5470ec #8C5FD3`.
- **Tonal surfaces** replace primary/secondary/tertiary: `surface-dim`, `surface`, `surface-bright`, `surface-container-lowest / -low / (base) / -high / -highest`, plus `on-surface`, `on-surface-variant`, `outline`, `outline-variant`, `scrim`, `shadow`, and the `primary / on-primary / primary-container / on-primary-container` quadruples. Shell mapping: app frame `surface-container-high`, content `surface-container-low`, main card `surface-container-lowest`. Selection is a `primary-container` pill, not a grey `--hover` fill. Standard M3 dark tones if hand-rolling: surface & surface-dim 6, bright 24, container-lowest 4 / low 10 / base 12 / high 17 / highest 22, on-surface 90, on-surface-variant 80, outline 60, outline-variant 30, primary 80, on-primary 20, primary-container 30, on-primary-container 90.
- **Bigger radii** — a 10-step scale (`S/components/ui/themes/stoatWebTheme.ts`): `xs 4 · sm 8 · md 12 · lg 16 · li 20 · xl 28 · xli 32 · xxl 48 · full ∞ · circle 100%`. Sidebar rows and the composer are `28px`, cards `28px`, message rows `12px` — versus revite's single `6px`.
- **M3 type scale** (`S/components/ui/components/design/Text.tsx`), `display / headline / title / body / label × large / medium / small`. The ones you need: `body/medium .875rem/1.25rem ls .015625rem 400` (default) · `body/small .75rem/1rem ls .025rem 400` (timestamps) · `label/medium .75rem/1rem ls .03125rem 500` · `label/small .6875rem/.875rem ls .03125rem 500` (member headers) · `title/medium 1rem/1.5rem 550`. Message body is its own class: `400`, `var(--message-size)`. `title` weight is `550`, a variable-font weight, not M3's 500.
- **Fonts**: interface default moved Open Sans → **Inter** (300–800 bundled); monospace JetBrains Mono (revite defaulted to Fira Code). Exposed as `--fonts-primary`, `--fonts-monospace`.
- **Spacing** `--gap-*`: `xxs 1 · xs 2 · sm 4 · s 6 · md 8 · l 12 · lg 15 · x 28 · xl 32 · xxl 64` — non-monotonic, and `lg` is an odd `15px` (hence paddings like `calc(var(--gap-lg) + 5px)` = 20px). Marked `@deprecated` in-source; use a plain 4-pt scale.
- **No elevation scale.** Shadows are ad-hoc: `0 0 3px var(--md-sys-color-shadow)` (cards, menus, toolbars), `0 .5px 1.5px #0004` (elevated button), `0 2px 8px rgba(0,0,0,.2)` (select). Modal scrim `rgba(0,0,0,.6)`, `z-index: 998`.
- **Disabled** uses the M3 formula: `color-mix(in srgb, 38% var(--md-sys-color-on-surface), transparent)` for text, `10%` for background. Hover/press feedback is a Material ripple element. Buttons scale `xs 32 · sm 40 (default) · md 56 · lg 96 · xl 136px`, pill-shaped by default.

## 10. Motion and micro-interactions

- Sidebar row background / colour / opacity — `.1s ease-in-out` (`Item.module.scss`). Stoat has only two tokens: `--transitions-fast: .1s ease-in-out`, `--transitions-medium: .2s ease`
- Hover toolbar shadow `.1s ease-out`, its buttons `.2s ease background-color`; any pressed icon does `transform: translateY(1px)` on `:active`; blocked-message unblur `.2s ease filter`
- Jump / new-messages / reply bars: `340ms cubic-bezier(0.2, 0.9, 0.5, 1.16)` from `translateY(±33px)`, their text colour `.08s ease-in-out`
- Message jump highlight `3s ease` (holds the mention colour to 66%, then fades); smooth scroll-to-bottom `150ms` with a 150ms re-entrancy guard
- Category chevron `.1s ease-in-out transform`, `rotateZ(90deg)` open; rail pill `.1s ease-in-out` on height; profile tab underline `.3s`; theme swatch border `.3s`; empty-channel ghost `3s ease-in-out infinite` (`translateY 0 → 15px → 0`)
- Skeleton (`S/components/ui/components/utils/ListView2.tsx`): `linear-gradient(90deg, surface-container-highest 25%, surface-container-high 50%, surface-container-highest 75%)`, `background-size: 200% 100%`, `animation: skeletonShimmer 1.5s infinite`; shapes are a `36px` circle, a `.8em` username bar and a `var(--message-size)` content bar, all `border-radius: 8px`

**Tooltips** — tippy.js with `animation: "shift-away"`. There is **no delay configured anywhere** (tippy
default `0`, instant) and no default placement (tippy default `top`); each call site sets its own — rail
entries `right`, avatars `right-end`, header actions `bottom`, composer/voice `top`. Styling
(`R/styles/index.scss`): `.tippy-box { color: var(--foreground); background: var(--tooltip,
var(--background)) }`, `.tippy-content { padding: 6px 10px; font-size: 13px; font-weight: 600; max-width:
200px }`. Stoat's is simply `background: black; padding: 8px; border-radius: 12px`.

**Context menus** (`R/styles/_context-menu.scss`):

```css
.context-menu { z-index: 9998; min-width: 190px; padding: 6px 8px; font: 500 .875rem;
  color: var(--secondary-foreground); border-radius: 6px; backdrop-filter: blur(10px);
  background-color: rgba(var(--primary-background-rgb), max(var(--min-opacity), .9));
  box-shadow: 0 0 8px 8px rgba(0,0,0,.05) }
.context-menu > span { gap: 6px; margin: 2px 0; padding: 6px 8px; white-space: nowrap;
  border-radius: 3px }                       /* calc(--border-radius / 2) */
.context-menu > span:hover { backdrop-filter: blur(10px);
  background-color: rgba(var(--secondary-background-rgb), .75) }
.context-menu .tip { font-size: .65rem; text-align: right; color: var(--tertiary-foreground) }
```

Destructive entries are coloured inline with `var(--error)`; keyboard hints and submenu chevrons live in
`.tip` on the right; dividers are suppressed when leading or doubled.

## 11. Settings → Appearance and Audio

`R/pages/settings/panes/Appearance.tsx`, in order:

1. **Theme** — light / dark image cards (`3px solid transparent` → `var(--accent)` active, `var(--tertiary-background)` hover, `transition: border .3s`), plus a link to the theme shop (an iframe to `rvlt.gg`, not a native pane)
2. **Accent colour** — colour input bound to `--accent`; also rewrites `--scrollbar-thumb` as the accent shaded 20% darker
3. **Appearance options** — `Show send button` (off), `Show account age` (off)
4. **Theme options** — `Transparency` (default **on**; off sets `--min-opacity: 1`), `Seasonal theme` (on)
5. **Font** — 14, alphabetical: Atkinson Hyperlegible, Bitter, Comic Neue, Inter, Lato, Lexend, Montserrat, Noto Sans, **Open Sans** (default), OpenDyslexic, Poppins, Raleway, Roboto, Ubuntu
6. **Ligatures** — offered only when the font is Inter; toggles `--ligatures: normal | none`
7. **Emoji pack** — 2×2 grid of `padding: 2rem 1.2rem` cards: **Mutant Remix** (default), Twemoji, Openmoji, Noto Emoji
8. **Overrides** (collapsed) — a `repeat(auto-fill, minmax(200px, 1fr))` grid of 24 colour pickers (`38×38`, 100 ms debounce): accent, background, foreground, primary-background, primary-header, secondary-background, secondary-foreground, secondary-header, tertiary-background, tertiary-foreground, block, message-box, mention, scrollbar-thumb, scrollbar-track, status-online, status-away, status-busy, status-streaming, status-invisible, success, warning, error, hover. Plus Reset / copy-JSON / Import.
9. **Advanced** (collapsed) — monospace font (Fira Code default, JetBrains Mono, Roboto Mono, Source Code Pro, Space Mono, Ubuntu Mono) and a custom-CSS textarea (`maxRows 20`, `minHeight 480`)

**Not present in revite**: cozy/compact (commented out) and font size (fixed `--text-size: 14px`).
Stoat's pane (`S/components/app/interface/settings/user/appearance/AppearanceMenu.tsx`) instead has Mode
(Light / Dark / System), Accent (picker + 7 swatches), **Contrast** (−1.0 Reduced / 0.0 Normal / 0.5 More
/ 1.0 High), **Variant** (Monochrome / Neutral / Tonal Spot / Fruit Salad), **Blur** toggle, **Message
Size** slider `12–24`, **Message Group Spacing** slider `0–16`, interface + monospace font selects,
show-send-button, and an emoji-pack select (fluent-3d default, fluent-color, fluent-flat, mutant, noto,
twemoji). Compact mode hides under Settings → Advanced. A `126px` live preview sits at the top
(`border-radius: 16px`, `surface-container-lowest`).

**Audio** (`R/pages/settings/panes/Audio.tsx`): two combo boxes side by side (`width: 50%`, stacking below
`800px`) — **Input device** and **Output device**, filled from `enumerateDevices()` and persisted in
`localStorage` as `audioInputDevice` / `audioOutputDevice` (not the settings store). A "Grant permission"
button when `getUserMedia({audio: true})` has not been allowed, an error tip on `NotAllowedError`, and an
"Audio codec powered by Opus" footer (`24px` logo, `12px`, `opacity: .5`). **No volume or sensitivity
sliders** — the 10-notch VU meter is commented out.

## 12. What actually makes it feel like Discord/Revolt

In priority order; the first four carry most of the impression.

1. **Three fixed columns, one scroller each.** Rail 58 · channels 232 · messages fluid · members 236. Nothing reflows; each column owns its own `overflow-y: scroll`.
2. **The rail pill.** `12px` wide, hanging `8px` off the left of the icon, animating only its *height*: 0 → 8 (unread) → 16 (hover) → 32 (selected). The single most recognisable gesture.
3. **Cozy rows with a 62px gutter.** `36px` avatar, name and time on one line, body `14px`, and grouping that hides the avatar and name for `7 minutes` of same-author messages — revealing a `10px` gutter timestamp only on hover.
4. **Hover reveals, never clutters.** Row hover paints `var(--hover)`; the `32px` toolbar floats at `top: -18px; right: 0`; sidebar unread dots swap for action icons. Nothing is visible at rest.
5. **Everything is dim until it matters.** Channels, members and timestamps sit at `--tertiary-foreground` / `opacity: .4`; unread and hovered items jump to `--foreground`; muted things go to `.4` and stay.
6. **Uppercase category headers with a rotating chevron**, collapsible and persisted per category.
7. **Status is punched out of the avatar**, not placed beside it: `r=5` at `cx/cy 27` of a `32` viewBox, masked so there is a real hole behind it.
8. **Floating bars, not modals**, for transient state — typing (26), replies (30), new-messages and jump-to-bottom (28) — sliding in over `340ms` on a `cubic-bezier(.2,.9,.5,1.16)` overshoot.
9. **Translucent chrome**: sidebars, menus and bars at `rgba(…, .75–.9)` + `backdrop-filter: blur(10–20px)`, with one setting that turns it all off at once.
10. **Instant tooltips** on every icon-only control (no delay), `13px/600`, capped at `200px`.

## 13. Mapping to Mumble / Mutter

Mutter Web is plain HTML/CSS/JS (`web/app/*.js`, `web/app/style.css`), so all of the above ports directly.

- **Servers → saved Mumble servers.** `web/app/store.js` already holds them; render each as a `42px` tile in a `58px` rail with the pill. Bottom entries `+` add server, then settings; the connected server takes the `32px` pill.
- **Server header → server name + state line.** Reuse the `48px` header (Mutter's `#top` is currently 54). The ping pill can take the settings-cog slot.
- **Categories → parent channels.** Mumble's tree is arbitrarily deep; flatten to two levels — depth-0 channels become collapsible category headers, deeper ones become rows with `12px` extra `padding-left` per level. Persist collapse state per channel id, as `CollapsibleSection` does.
- **Channels → channels.** One `32px` compact row type. Every Mumble channel is text *and* voice, so the icon should be `#` normally and a headset when anyone is in it.
- **Voice participants → users in a channel.** The closest one-to-one mapping here: Stoat's `VoiceChannelPreview` (24px avatars, indented 32px, speaking = `2px` primary outline at `1px` offset) *is* the Mumble channel-tree user list. Use it verbatim; drop the join-to-see logic, since Mumble always reports occupancy.
- **Member list → users here, then users elsewhere.** Keep the 236px panel. Groups become **In this channel – N** then **Elsewhere – N**; Mumble has no offline roster.
- **Roles → none.** Substitute a deterministic name colour (hash the username, IRC-style) and hoist at most **Registered** vs **Guests** if the ACL exposes it.
- **Presence → speaking / muted / deafened / idle.** Reuse the punched-out dot geometry. Suggested palette borrowing Revolt's hexes: speaking `#3ABF7E`, muted `#F39F00`, deafened or suppressed `#F84848`, idle `#A5A5A5`. Speaking should also take the `outline: 2px solid <accent>; outline-offset: 1px` ring — Mutter's `.round.live::after` already approximates it.
- **Status text → Mumble comment**, rendered as the `.6875rem` sub-text line, sanitised through `chat.js`'s existing whitelist.
- **Typing → the existing extension.** `web/app/typing.js` already implements `mutter/typing` over PluginDataTransmission (3s repeat, 5s idle, 6s expire). Wire it to the 26px floating strip with 16px overlapping avatars and the three text patterns from §5.
- **Replies → quote-prefixed text.** Not in the protocol. Revolt's own `quote_message` action does exactly this — prefix each line with `> `, append two newlines (`MessageBox.tsx` `append()`). Render leading `>` blockquotes with the `4px` inline-start border so quoted text *looks* like a reply. A richer version could carry the quoted message id over the same plugin channel typing uses.
- **Reactions → skip.** Not in the protocol and not worth an extension. Drop the react button from the hover toolbar; keep Reply (quote), Copy text, Copy link, Delete-local.
- **Mentions → `@name` matching a connected user.** Highlight the row with `--mention` and render the chip (12px radius, `secondary-background`, `600`). Mumble's per-user text messages are the nearest thing to a DM.
- **Embeds / attachments → inline `data:` images.** `chat.js` already normalises Mumble's percent-encoded data URIs; clamp with `--attachment-max-width: 400px` and `border-radius: 6px`.
- **Unread badge → chat tab count.** Already `#unread`; restyle to the `16×16` white-on-`--error` mention pill, plus a `6px` plain dot for non-mention unread.
- **Appearance settings.** `web/app/themes.js` already ships five palettes with the same token shape (`--bg / --surface / --elevated / --separator / --ink / --body / --muted`). Add accent picker, font choice, message size (12–24), group spacing (0–16), and a transparency toggle driving `--min-opacity`.
- **Audio settings.** Mutter's pane is already richer than Revolt's (transmit mode, VU meter, DSP); keep it, and just adopt the two-column `50%` layout and combo-box styling.
