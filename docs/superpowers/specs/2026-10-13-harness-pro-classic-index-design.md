# Harness Pro · Classic restyled after the Index v5 handoff

Status: design · 2026-10-13 · owner 0xdiego25
Mockup of record: `devices/harness-pro/mockup/pro-index.html`, built by `mockup/pro-index/build.py` (gitignored; main checkout).
Source design: the design team's "Harness Pro / Index v5" developer handoff (`harness-pro-index.html`, SHA-256 `565b4ab9…bad`). The mockup reuses its CSS verbatim, so each size below is its `cqw` value × 7.2, rounded to a whole pixel.

## Goal

**Replace** the Classic skin's look and some of its behaviour with the mockup.
- Console is not touched. The setting stays `uiSkin: classic | console`, and Classic stays the default.
- Nothing new comes from the daemon. Every field the new screens show is already in `pod_model_t`.

## Decisions

| Topic | Decision |
|---|---|
| Skin | The new design **replaces** Classic in place. No third skin. |
| Font | **Liberation Sans**: Regular for weights 400 and 500 (Liberation has no Medium), and **Bold** for 600 and 700. Bold is a new file, `fonts/LiberationSans-Bold.ttf` (SIL OFL 1.1, liberation-fonts 2.1.5), with its licence beside it. |
| Pet | The engine's own pet, drawn with `pod_pet_draw`, which scales to any side. Scenes: working → WORK, asking → ASK, done / idle / offline → REST (there is no relax scene in firmware), listening → LISTEN, sending → SEND. An engine without a pet shows its logo on a pale box, as today. |
| Logos | The existing pre-rendered sizes (28 / 36 / 44 / 72), nearest to the design's box. |
| Navigation | The 5-button transport goes away. Back is the top-left label. The side button still pops to Tabs. Swiping horizontally on Agent and Recap still steps to the neighbour agent. Drag paging on Tabs stays as it is. |

## Global look (720 × 720)

**Ground and colours**
- Ground `#f6f6f0`, set as the scene background.
- Ink `#20292c`, muted `#657175`, blue `#155ccc`, rule `#ccd0ce`.
- Green (working / done) `#3d6653`, eq `#2d6a51`, amber (needs you) `#8b570f`, ask box `#f0e9d8` with a 4 px `#b78230` left bar.

**Top bar, y 0–88**
- A vertical gradient `#f8f9f7`→`#e9eae5`, a 1 px `#bcc4c1` rule at y 88, and a 1 px white line at y 0.
- Grid: left 173 px | title centred | right 88 px.
  - **Left:** at the root, the brand "Harness" in Bold 26. Elsewhere, a chevron plus the back label in Regular 26, `#314449`, ellipsis at 115 px. The `POD_A_BACK` hit is 173 × 88.
  - **Title:** Bold 30, centred on the screen, ellipsis.
  - **Right:** the bell (the existing drawn bell, 30 px) plus the count pill (Bold 24, white on blue, radius 29, min width 34). The `POD_A_INBOX` hit is 88 × 88 in the top-right corner. There is no bell on Update or Voice, and no pill at 0.

**Footer, y 628–720, on list screens**
- The same gradient, a 1 px `#c4cbc7` rule on top, and 32 px side padding.
- Left: an optional 8 px green led plus Regular 23 muted.
- Right: Regular 20 caps, muted, tracking about 1 px.

**Transport, y 616–720, on Agent and Recap only**
- The same gradient, with a rule on top.
- One **Talk** button, x 32–688, y 624, 88 high, radius 7.
  - Fill: a gradient `#286fda`→`#1759bd` with anti-aliased corners, a 1 px `#1145a0` border and a 1 px top highlight.
  - Content: the mic icon plus "Talk" in Regular 28, white, centred.
- **Disabled** (asking, offline, link down): 45 % opacity, no hit.

**Side margin:** 32 px everywhere.

## Screens

### Tabs (root)
- **Grid:** a 3 × 2 grid of 164 px covers, starting at padding 23 / 27 with gaps of 15 (row) and 13 (column).
- **Cover:** radius 13, with a vertical gradient from the design's palette (Recent `#5d8dda`→`#2859aa`, then purple, rose, green, ochre, slate in tab order).
- **Inside a cover** are the tab's pane minis on `#f8faf7`, radius 6:
  - 1 pane fills the cover; 2 or more are split into 2 columns;
  - each holds the **44 px logo**;
  - a working or asking pane gets a 13 px dot top-right, green `#35734f` or amber `#bf861e`;
  - offline panes are at 50 %.
- **Recent's cover** shows up to 8 minis in 4 × 2, each with a 28 px logo.
- **An empty tab** gets a grey gradient `#dce2d7`→`#bfcbbd` and the grid icon.
- **Working ribbon:** 31 px, `#172f39` at 79 %, on the cover's bottom edge. It holds the eq, "Working" and the count, in Regular 21 white.
- **Under the cover:**
  - the name in Regular 30, ink, or blue when selected;
  - the count in Regular 23 muted ("7 agents", "2 panes", "Empty").
- **Selected cover:** a 5 px blue ring with a 5 px gap.
- **Footer:** "N working" | "N TABS · M AGENTS", or "PAGE p / n" when there is more than one page.

### Recent and Tab (lists)
- **No heading block.** The first row sits directly under the bar.
- **Row:** 104 px pitch, with a 1 px rule between rows.
  - **Left:** a 56 px mark box (`#e6e9df`, a 1 px `#c8cec7` border, radius 8) holding the **36 px logo**.
  - **Middle:** the name in Regular 33, ink, then "Engine · Machine" in Regular 23 muted.
  - **Right:** right-aligned, the time in Regular 22 muted and the state word in Bold 20:
    - Working (green `#377052`);
    - Finished (muted);
    - Needs you (`#956616`);
    - Ready (muted);
    - Offline (muted).
- Five rows are visible, and a drag scrolls (`POD_A_SCROLL`).
- **Footer:**
  - Recent: "Scroll to browse" | "N AGENTS".
  - Tab: "Scroll to browse" | "N PANES".
- **Empty tab:** "No panes yet." in Regular 43, centred, then "This tab is managed in Harness." in Regular 24 muted. The footer reads "No panes".

### Agent (working, needs you, ready, offline)
- **Head, from y 104:**
  - the pet at 104 px, at x 32;
  - from x 152: the name in Regular 41 (one line, ellipsis), then "Tab · Machine" in Regular 23 muted.
- **Metadata band, y about 224–312:**
  - a 1 px rule above and below, and a column split at 46 % with a 1 px `#d7ddd3` rule;
  - **left:** the state icon (eq, ✓ or dot) plus the state word in Regular 25, coloured; under it the elapsed time in Regular 22 `#6b746c` ("—" when unknown);
  - **right:** "Engine" in Regular 20 muted, then the 28 px logo plus the engine name in Regular 26 ink.
- **Body, from y about 328, with 32 px margins:**

  | State | Body |
  |---|---|
  | Working | "RIGHT NOW" (Bold 20 caps, tracking 1 px, muted). The activity in Regular 32, line pitch 42, at most 3 lines, then "…". Up to 2 newest steps in Regular 22 muted, pitch 27. "Updated just now" / "Updated 3m ago" in Regular 20 `#7b827c`, from `event_ms`. |
  | Needs you | The ask box: Regular 32, up to 3 lines. Then "Answer it in the Harness app." in Regular 23 muted. |
  | Ready | "Ready when you are." in Regular 32, then "Send a new voice instruction to this agent." in Regular 23 muted. |
  | Offline | "That machine is offline.", then "Reconnect {machine} in Harness to continue.". The pet is at 50 %. |

- **Header:** the title is "Task". The back label is the frame's origin: the tab name, "Recent" or "Inbox".
- **Transport:** Talk.

### Recap (done)
- The same head and band as Agent. The pet is REST.
- **Right half of the band:** "Tokens" plus "{in} in · {out} out" in Regular 26 (k / M with one decimal), when `tokens_in >= 0`. Otherwise it shows Engine.
- **Body:** "SAVED RESULT", then the recap in Regular 32, pitch 42. It scrolls by line and keeps the existing scroll and "…" rules.
- The title is "Recap".

### Inbox
- **Heading:** "N unread." in Regular 48, at y 117, then "Open a result to mark that result read." in Regular 24 muted.
- **Rows:**
  - **Asking agents first:** an amber row background `#f0eadc`, an amber dot, the name, "Needs your answer · stays until resolved", and a chevron. The hit is `POD_A_FOLLOW`.
  - **Then the unread entries:** a 9 px blue dot, the name, up to 2 lines of the recap in Regular 23, and "New" at the right. A FAILED entry gets "Failed" in `#974f43`. The hit is `POD_A_OPEN_NOTIF`.
- **Footer:** "N unread".

### Voice: listening
- The title is "Voice"; there is no bell.
- "To **{name}**" in Regular 23 (the name in Bold 23) at y 112.
- The LISTEN pet at 281 px, centred.
- "Listening." in Regular 48.
- 13 wave bars, 5 px wide, `#2c6e64`, from the mic level.
- "Tap to send." in Regular 24 muted.
- **No transport, no buttons.**

### Voice: sending
- The SEND pet at 209 px.
- "Sending your words…" in Bold 45.
- The agent name in Regular 30.
- "One request is pending. Going back will not send it again." in Regular 26 muted, centred, at most 81 % wide.

### Result banner (over any screen but Voice and Update)
- **Card:**
  - x 16, y 98, w 688, radius 10;
  - a 1 px `#a6b9a9` border and a `#f7faf2` fill;
  - padding 19 / 22 / 23.
- **Row:** the 56 px mark box with the 36 px logo, then:
  - the name in Regular 33, with the **×** (a 65 × 65 hit, the glyph in muted) at the right;
  - up to 2 lines of the recap in Regular 24 `#3d4a4e`, then "…";
  - "✓ Done · 0m 48s" in Regular 23 green, or "Failed · 0m 48s" in `#974f43` for a FAILED entry. With no elapsed time it is just "Done".
- **Timer line:** 6 px, blue, along the card's bottom edge. Its width is `w × (1 − (now − shown) / POD_BANNER_MS)`. When it reaches 0 the banner closes, as today.
- **Gestures:**
  - a tap on the card opens it (unchanged);
  - **×** closes it at once and keeps the entry unread;
  - a swipe up closes it (unchanged).

### Connection lost (link down, in place of the stack)
- The bar: brand, title "Connection", bell.
- Centred: the grid icon (50 px stroke), "Connection lost." in Regular 43, then "Live status is unavailable." / "Your saved results and unread marks remain." in Regular 25 muted.
- The footer: led plus "Disconnected".

### Update (OTA)
- The bar: brand and "Update", with no bell.
- Centred, with an equal 22 px gap between items:
  1. an 86 px circle (`#e5efdf`, a 1 px `#a3b6a8` border) with a download arrow in `#386848`;
  2. "HARNESS PRO" in Regular 20, tracking 1 px, `#657a6c`;
  3. "Updating to {to}" in Bold 45, or "Restarting…";
  4. a 446 × 10 bar (`#dfe3dc`, a 1 px border, radius 7) with a blue gradient fill to pct;
  5. "Keep the cable connected. The device restarts when it is done." in Regular 26 muted.
- **Footer:** led plus "Downloading" | "{pct}%" (or "Restarting").

## Behaviour changes

1. **Talk (Classic):**
   - A tap on Talk gives `VOICE_BEGIN`, as before.
   - While listening, the Talk view registers one full-screen `POD_A_TALK` hit, which already maps to `VOICE_END`. This is the same mechanism Console uses.
   - The side button discards, unchanged. The 600 s cap sends, unchanged.
   - The old "press the big button again" path goes away with the transport.
2. **Banner close:** a new hit-only action, `POD_A_BANNER_CLOSE`, which the glue handles: the banner ends, and the unread entry stays.
3. **Banner timer:**
   - `pod_banner` gets `shown_ms` and draws the line from `now_ms`.
   - The glue wakes every 66 ms while a Classic banner is up, the same rule Console's toast uses.
   - The damage is the line only.
4. **Back label:** the nav exposes the frame's origin ("Recent", the tab name, or "Inbox") for the bar.
5. **Connection lost:** while `!model.linked`, Classic draws this screen in place of the stack.

## Renderer work

- **Fonts.** `gen_fonts.py` gains a Classic face set from Liberation Sans:
  - **Regular** 20, 22, 23, 24, 25, 26, 28, 30, 32, 33, 41, 43, 48;
  - **Bold** 20, 23, 24, 26, 30, 45.
  - Glyphs are Latin-1 plus Vietnamese plus "…" (U+2026) and "·". The "×" is U+00D7. The ✓, chevrons, bell, mic, eq, grid and download icons are drawn with the existing primitives (`pod_tick`, `pod_chevron`, rects, `pod_tri`), not as glyphs. The static-only big faces are cut to the characters they draw:
    - Regular 43: "No panes yet.", "Connection lost.";
    - Regular 48: "Listening.", "unread." and digits;
    - Bold 45: "Sending your words…", "Updating to", "Restarting…", digits and ".".
  - The `ht_pro_*` faces stay, because the notice pill uses them.
  - Faces that draw only fixed English copy are cut to printable ASCII plus "…" and "·": Regular 20 (labels, footer caps, "Updated…"), Regular 25 (the band's state word, the Connection lost copy), Regular 28 (Talk), Bold 20 (eyebrows, list state words), Bold 24 (the count pill) and Bold 26 (the brand). Every face that draws names, activity or recaps keeps Vietnamese.
  - `test_fonts.py` caps the **Classic set at 800 KB**, alongside the existing 900 KB cap on cs_*. The first measurement was 934 KB uncut.
- **`pod_grad` gets anti-aliased corners** (the corner_cover math of `ht_pro_rect_aa`), opt-in through a new `pod_grad_aa`, so existing callers render byte-identically.
- **Pet waves fade to the ground.** `pod_pet.c:114` fades toward a passed ground colour (white for existing callers) instead of fixed white.
- **Budget:** `POD_CLASSIC_RUNS` goes from 128 to 184. The views still leave `pod_spare_runs()` free.

## Not changing

- Console: all of it, including its 200 goldens.
- The model, the cable and the daemon.
- The OTA logic and the voice pipeline.
- The side button's long press to sleep.

## Tests

**Goldens**
- Classic `golden.txt` and `golden-liberation.txt` are regenerated. The screen list grows to cover:
  - Inbox (with and without asking rows);
  - the banner (done, failed, at 0 / 3000 / 5900 ms);
  - Connection lost;
  - Voice listening and sending;
  - an empty tab;
  - Tabs with more than one page.
- Console's 200 lines stay unchanged.

**`test_pod_views_*`**
- No heading on Recent or Tab.
- Five 104 px rows.
- The bell hit is the top-right 88 × 88; the Back hit is 173 × 88.
- Talk is disabled (no hit) when asking or offline.
- Tokens is shown only when `tokens_in >= 0`, otherwise Engine.
- The Inbox has asking rows first with `POD_A_FOLLOW`.
- Each view stays within 184 runs plus spares.

**`test_pod_nav` / glue**
- Classic listening: a tap anywhere gives `VOICE_END`.
- The side button discards.
- × gives `POD_A_BANNER_CLOSE`, closes the banner and keeps the entry unread.
- The timer reaching 0 closes it.
- The Back label follows the origin.

**`test_fonts.py`:** the new faces exist with their coverage, and the Classic set is within 800 KB.

**Layout check against the mockup**
- `build.py --font liberation` renders the mockup with Liberation Sans, and `test/pod_render.py` renders the same screens from firmware.
- A dev script (`test/classic_vs_mockup.py`) overlays the two and reports box offsets.
- The target is within ±2 px for every text baseline and box edge.
- This is a dev check, not part of `run.sh`.

**Perf**
- `test_cs_perf.sh` gains Classic screens (opt-in, `CS_PERF=1`).
- On the device, the heartbeat must show frame_max ≤ 24 ms on Tabs, Recent, Agent working, Recap, Voice and the banner.

**Device:** flash with `scripts/flash.sh`, switch to Classic, and walk every screen above, including Voice tap-to-send, banner × and timer, link down, and a real Claude turn (Agent → Recap with tokens).

## v2 (owner, 2026-10-14)

Classic only; Console is unchanged.

**A. Lists (Recent and Tab)**
- The footer's left shows the working mark (green, about 3 cqw tall), the count of working agents in that list in Bold and " working"; "None working" (no mark) when none, "No panes" for an empty tab. The right side is unchanged. The glue wakes for the mark only while a listed agent works.
- A Ready row has no right-hand meta: no time or dash, no state word.

**B. Agent and Recap**
- Recap loses the "SAVED RESULT" eyebrow; the body moves up to where it was. Scroll by 42 px lines and the cut rules are unchanged.
- No title in the bar. The back label (tab name, or "Recent" / "Inbox") may run up to the bell's left edge minus 16 px; BACK widens to the label (at least 173 px) and stays clear of the bell hit. Other screens keep their titles.
- The band's left half has two lines like the right half: a muted "Status" label, then the state icon and word followed by " Â· time" in the muted time colour when the time is known (omitted when unknown, never a dangling "Â·"). All states; Ready stays green. Geometry is unchanged; label and value baselines follow the mockup within 2 px.

## Risk

**Critical:**
- the voice gesture changes in Classic, and every Classic screen is redrawn;
- a font is added, which costs flash.

The review runs on the strongest model.
