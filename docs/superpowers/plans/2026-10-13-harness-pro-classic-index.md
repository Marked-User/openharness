# Harness Pro · Classic Index restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repo the owner's model-routing applies: Sonnet codes each task, Opus reviews (risk: **critical**).

**Goal:** Redraw every Classic screen of the Harness Pro to match `mockup/pro-index.html`. The Classic voice gesture becomes tap-anywhere-to-send, and the banner gains × and a timer line.

**Architecture:**
- The Classic views stay in `main/pod/classic/`. Each view is rewritten in place on a new shared chrome (`classic/ci.h` + `classic/ci_chrome.c`), which holds the design tokens, the bar, footer, transport, mark box and metadata band.
- New Liberation Sans faces (`ci_rg_*`, `ci_bd_*`) are generated next to the existing ones.
- Nav and glue changes are small and confined to Classic paths. Console code is not touched.

**Tech Stack:** C11 (ESP-IDF 5.5.4, host tests with clang + sanitizers), Python 3 + Pillow (font generator, render scripts).

**Spec:** `docs/superpowers/specs/2026-10-13-harness-pro-classic-index-design.md`. Every size, colour and copy string comes from there; this plan does not repeat them.

## Global Constraints

- Firmware root: `devices/harness-pro/firmware`. Run host tests with `bash test/run.sh` (they need `IDF_PATH=~/esp/esp-idf-5.5.4` for cJSON).
- Console stays byte-identical: `bash test/golden.sh --skin console --check` passes in both fonts (default and `PRO_FONT=…/LiberationSans-Regular.ttf`).
- Classic goldens are regenerated **once**, in Task 10, after all views are done.
- `POD_CLASSIC_RUNS` = 184. Every Classic view stays within `POD_CLASSIC_RUNS - pod_spare_runs(f) - 4`; the 4 are the notice pill.
- Classic font set ≤ 800 KB, enforced in `test_fonts.py`. Six faces that draw only fixed copy are cut to ASCII (see Task 1). The cs_* cap of 900 KB is unchanged.
- No new cable or daemon fields. `pod_model_t` is unchanged.
- Flash only with `FLASH_PORT=<port> bash scripts/flash.sh`. Never force-flash.
- Do not commit or push (the owner asks for that separately). Never run `git stash`.
- Copy is English, as in the spec. Code comments match the surrounding density.

## Review Focus

1. **Long and Vietnamese text.** A long agent name, tab name or back label, or Vietnamese activity text, must be cut with "…" inside its box and never overlap the time, the × or the bell. Tests: Task 6 (`test_list_long_name_ellipsis`) and Task 7 (`test_agent_vietnamese_activity_wraps`).
2. **No data.** An unknown engine (no logo, no pet), `elapsed_s < 0`, `tokens_in < 0`, an empty activity or an empty recap must give the spec's fallback, never a stray "·" or "0". Tests: Task 7 (`test_band_unknowns`, `test_agent_unknown_engine_mark`).
3. **Voice tap racing a state change.** A tap-to-send after the agent went offline mid-recording must discard, with the notice "That machine is offline", as today. Test: Task 4 (`test_classic_listen_tap_offline_discards`).
4. **The banner over a moving screen.** The banner closes while scrolled or while Tabs is paging, and × is hit on the very first frame. Tests: Task 8 (`test_banner_close_first_frame`, `test_banner_over_tabs_drag`).
5. **Link drop mid-screen.** A drop while on Agent or Voice shows Connection lost, a recording aborts, and the restored link returns to Tabs. Test: Task 9 (`test_link_down_shows_connection_lost`).

---

### Task 1: Liberation Sans Bold and the Classic face set

**Files:**
- Create: `fonts/LiberationSans-Bold.ttf` (liberation-fonts 2.1.5 release, SIL OFL 1.1; verify the SHA-256 against the release tarball).
- Modify: `fonts/LICENSE-LiberationSans.txt` (keep it, and note that it covers Bold), `fonts/README.md`.
- Modify: `scripts/gen_fonts.py`
- Modify: `main/display/pro_font_type.h` (extern declarations)
- Test: `test/test_fonts.py`

**Interfaces:**
- Produces these `ht_pro_font_t` faces, always from `fonts/` whatever `--font` says:
  - `ci_rg_20 ci_rg_22 ci_rg_23 ci_rg_24 ci_rg_25 ci_rg_26 ci_rg_28 ci_rg_30 ci_rg_32 ci_rg_33 ci_rg_41 ci_rg_43 ci_rg_48` (Regular)
  - `ci_bd_20 ci_bd_23 ci_bd_24 ci_bd_26 ci_bd_30 ci_bd_45` (Bold)
- Coverage: Latin-1, the Vietnamese list and the extras `0x2026` (…) and `0xb7` (·), the same mechanism as `CONSOLE_EXTRA`.
- Cut sets (`CLASSIC_CUT`), exactly the spec's strings plus digits:
  - `ci_rg_43`: "No panes yet." and "Connection lost.";
  - `ci_rg_48`: "Listening.", "unread." and digits;
  - `ci_bd_45`: "Sending your words…", "Updating to", "Restarting…", digits and ".".

- [ ] **Step 1: Write the failing tests** in `test/test_fonts.py`:
  - `test_classic_faces_exist`: every name above is in the generated header, with `height == ceil(size*1.375)`.
  - `test_classic_bold_is_bold`: the summed alpha of "Tabs" in `ci_bd_30` is more than 1.25 × that of a `ci_rg_30` render.
  - `test_classic_coverage`: `ci_rg_32` draws "ạ", "ư", "…" and "·".
  - `test_classic_cut`: `ci_bd_45` draws "S" and has empty masks for "q" and "z".
  - `test_classic_budget`: the Classic faces' bytes total ≤ 800 * 1000; print the total.
  - `test_classic_ascii_cut`: `ci_rg_25` has an empty mask for "ạ". The ASCII-cut faces are ci_rg_20, ci_rg_25, ci_rg_28, ci_bd_20, ci_bd_24 and ci_bd_26.
- [ ] **Step 2: Run them.** `python3 test/test_fonts.py` → the new tests FAIL.
- [ ] **Step 3: Add `CLASSIC = [(symbol, ttf, size), …]` and `CLASSIC_CUT`** to `gen_fonts.py`, and emit the faces with `bake(...)` exactly as `CONSOLE` does (`crop=True`).
- [ ] **Step 4: Run** `python3 test/test_fonts.py` and `bash test/run.sh` → PASS. Record the measured Classic total in the task report.

### Task 2: Renderer bits — `pod_grad_aa` and the pet wave ground

**Files:**
- Modify: `main/pod/pod_draw.h`, `main/pod/pod_draw.c`
- Modify: `main/pod/pod_pet.h`, `main/pod/pod_pet.c:104-120`
- Test: `test/test_pod_draw.c`, `test/test_pod_pet.c`

**Interfaces:**
- Produces:
  - `void pod_grad_aa(ht_scene_t *s, int x, int y, int w, int h, int radius, uint16_t top, uint16_t bottom);` A vertical gradient whose corners use the same coverage as `ht_pro_rect_aa`. It is one run, like `pod_grad`.
  - `void pod_pet_draw_on(ht_scene_t *s, int x, int y, int side, const char *engine, pod_scene_t scene, uint32_t clock_ms, uint32_t started_ms, uint32_t ground_rgb);` Waves fade toward `ground_rgb` (0xRRGGBB). `pod_pet_draw` becomes `pod_pet_draw_on(..., 0xffffff)`, so existing output is unchanged.

- [ ] **Step 1: Write the failing tests.**
  - `test_grad_aa_corner_matches_rect_aa`: with top == bottom, the pixels of `pod_grad_aa` equal those of `ht_pro_rect_aa` for r = 7 and 13.
  - `test_grad_aa_rows`: the middle row of a 100 px gradient is within 1 LSB of the colour mid-point.
  - `test_pet_wave_ground`: for Claude LISTEN at level 4, no wave pixel is brighter than `ground` when `ground = 0xf6f6f0`, and the output with `0xffffff` is byte-equal to `pod_pet_draw`.
- [ ] **Step 2: Run them.** `bash test/run.sh` → FAIL (undefined symbols).
- [ ] **Step 3: Implement.** The gradient goes through a new run kind or the existing gradient run with the AA corner flag. Reuse `corner_cover` from `pro_canvas.c` through a shared static inline in `pro_canvas.h`, without copying it.
- [ ] **Step 4: Run** `bash test/run.sh` plus `bash test/golden.sh --check` and `bash test/golden.sh --skin console --check` → PASS and unchanged. The Classic goldens may not change yet.

### Task 3: Classic chrome — tokens, bar, footer, transport, mark, band

**Files:**
- Create: `main/pod/classic/ci.h`, `main/pod/classic/ci_chrome.c`
- Modify: `main/CMakeLists.txt` and `test/run.sh` (add the source)
- Modify: `main/display/terminal.h:17` (`POD_CLASSIC_RUNS 184`)
- Test: create `test/test_ci_chrome.c` and register it in `run.sh`

**Interfaces:**
- Produces (in `ci.h`):
  - The spec's colours as `CI_*` RGB565 constants: `CI_GROUND CI_INK CI_MUTED CI_BLUE CI_RULE CI_GREEN CI_EQ CI_AMBER CI_ASK_FILL CI_ASK_BAR CI_ROW_ASK CI_FAIL`.
  - Geometry enums: `CI_BAR_H=88`, `CI_FOOT_Y=628`, `CI_TRANS_Y=616`, `CI_TALK_X=32`, `CI_TALK_Y=624`, `CI_TALK_W=656`, `CI_TALK_H=88`, `CI_MARGIN=32`, `CI_ROW_H=104`, `CI_MARK=56`, `CI_BACK_W=173`, `CI_BELL_W=88`.
  - `void ci_bar(pod_out_frame_t *f, const char *title, const char *back /*NULL: brand*/, uint8_t unread, bool bell);` It draws the bar and adds the `POD_A_BACK` (0,0,173,88) and `POD_A_INBOX` (632,0,88,88) hits.
  - `void ci_foot(ht_scene_t *s, const char *left, bool led, const char *right_caps);`
  - `void ci_talk(pod_out_frame_t *f, bool enabled);` The transport plus the Talk button. The `POD_A_TALK` hit is the button rect, and only when enabled.
  - `void ci_mark(ht_scene_t *s, int x, int y, const char *engine);` The 56 px box with the 36 px logo, or `pod_mark_default`.
  - `void ci_band(ht_scene_t *s, int y, pod_state_t st, int32_t elapsed_s, const char *engine, int32_t tokens_in, int32_t tokens_out, uint32_t now_ms);` Tokens when `tokens_in >= 0`, otherwise Engine.
  - `int ci_state_word(pod_state_t st, const char **word, uint16_t *ink);` For the list meta and the band.
  - `void ci_fmt_tokens(char *out, size_t n, int32_t v);` Gives "10.1k", "2.3k", "980", "1.2M".
  - `void ci_fmt_elapsed(char *out, size_t n, int32_t s);` Gives "2:14", "1:02:03", or "—" when s < 0.

- [ ] **Step 1: Write the failing tests** in `test_ci_chrome.c`:
  - `test_bar_hits`: the BACK hit is {0,0,173,88} and the INBOX hit is {632,0,88,88}. There is no INBOX hit when `bell=false`, and no pill at unread 0.
  - `test_bar_back_ellipsis`: the back label "averyveryverylongtabname" is drawn at ≤ 115 px.
  - `test_talk_disabled_no_hit`: `ci_talk(f,false)` adds no hit.
  - `test_band_tokens_or_engine`: tokens_in=10100, tokens_out=2300 gives the text "10.1k in · 2.3k out". tokens_in=-1 gives "Engine" and the engine name.
  - `test_band_unknowns`: elapsed -1 gives "—", and no run contains "·" next to an empty field.
  - `test_fmt_tokens`: the cases 0, 999, 1000 ("1.0k"), 10100, 1250000 ("1.3M").
- [ ] **Step 2: Run** `bash test/run.sh` → FAIL.
- [ ] **Step 3: Implement** `ci_chrome.c`.
  - Text goes through `ht_pro_text` with the `ci_*` faces.
  - Icons (chevron, bell, mic, tick, eq, dot) reuse `pod_chevron`, the existing bell code from `pod_chrome.c` (move it to `ci_chrome.c`), `pod_tick` and `pod_eq`.
  - The bar gradient uses `pod_grad` (square). The Talk button uses `pod_grad_aa`, r = 7.
- [ ] **Step 4: Run** `bash test/run.sh` → PASS.

### Task 4: Nav and glue — origin label, banner close, tap-anywhere-to-send (Classic)

**Files:**
- Modify: `main/pod/pod_nav.h`, `main/pod/pod_nav.c`
- Modify: `main/app/pod_glue.c`, `main/app/pod_glue.h`
- Test: `test/test_pod_nav.c`, `test/test_cs_glue.c` (it already drives the glue for both skins; add Classic cases here)

**Interfaces:**
- Produces:
  - `const char *pod_nav_origin(const pod_nav_t *, const pod_model_t *);` Returns the label the bar's Back shows for the top frame: "Recent", the tab's name, "Inbox", or "Back" when unknown.
  - `POD_A_BANNER_CLOSE`, a hit-only action appended to `pod_action_t` (after `POD_A_SCROLL`). The glue ends the banner and leaves the unread entry.
  - `uint32_t pod_ui_banner_shown_ms(const pod_ui_t *)`, which the banner draw reads.
  - Classic listening: the Talk view adds one full-screen `POD_A_TALK` hit (Task 9 draws it). The nav already maps TALK while listening to `VOICE_END`; check that nothing in the nav is Console-gated for this.
- Consumes: none.

- [ ] **Step 1: Write the failing tests.**
  - `test_origin_label`: Tabs → Backend → agent gives "Backend". Tabs → Recent → agent gives "Recent". Inbox → open gives "Inbox".
  - `test_classic_listen_tap_anywhere_sends`: Classic, Agent, TALK → VOICE_BEGIN; a DOWN/UP at (360,400) → VOICE_END.
  - `test_classic_side_button_discards`: during listening, the side button gives VOICE_ABORT and nothing is sent.
  - `test_classic_listen_tap_offline_discards`: the agent goes OFFLINE mid-recording, then a tap gives a discard with the notice "That machine is offline".
  - `test_banner_close_keeps_unread`: a tap on the × hit gives banner off, `unread_count` unchanged, and no AGENT_OPEN.
  - `test_banner_timer_wakes_66ms`: with a Classic banner up, the glue's next wake is ≤ 66 ms, and without it the wake is as before.
  - The existing Console glue tests are unchanged and PASS.
- [ ] **Step 2: Run** `bash test/run.sh` → FAIL.
- [ ] **Step 3: Implement.**
  - The origin comes from the frame below the top frame: its view and tab id.
  - `POD_A_BANNER_CLOSE` is handled where `POD_A_BANNER` is (`pod_glue.c:448`). Give it priority: the × sits inside the card, and the hit list is searched last-added-first.
  - Wake: extend the Console toast rule at `pod_glue.c:735` to Classic while the banner is up.
- [ ] **Step 4: Run** `bash test/run.sh` → PASS.

### Task 5: Tabs view

**Files:**
- Modify (rewrite): `main/pod/classic/pod_view_tabs.c`
- Modify: `main/pod/classic/pod_chrome.c` (drop the cover helpers it no longer needs and keep only what other files still call; delete dead code)
- Test: `test/test_pod_views_tabs.c`

**Interfaces:**
- Consumes: `ci_bar`, `ci_foot`, `CI_*` (Task 3), `pod_grad_aa` (Task 2), `pod_logo_draw` (44 and 28).
- Produces: the same public entry and hits as today (`POD_A_OPEN_TAB` with the tab id). `pod_tabs_pitch()` and the ribbon query keep their signatures (the glue uses them).

- [ ] **Step 1: Write the failing tests:**
  - `test_tabs_grid_geometry`: the six covers' art boxes (164 × 164) have their left edges at x {52, 278, 505} and their tops at y {113, 368}, ±1, as measured on the mockup at 720. Each card hit spans the column (213 wide) and the row.
  - `test_tabs_selected_ring`: the selected cover has a ring of 5 px with a 5 px gap.
  - `test_tabs_ribbon_only_when_working`.
  - `test_tabs_footer_pages`: with 9 tabs the footer right reads "PAGE 1 / 2"; with 5 it reads "5 TABS · 7 AGENTS".
  - `test_tabs_empty_cover_grid_icon`.
  - `test_tabs_budget`: the worst case (6 covers of 2+ panes, all working) stays within budget.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the spec's Tabs section.
- [ ] **Step 4: Run** `bash test/run.sh` → PASS. Render `python3 test/pod_render.py tabs` and eyeball it against `mockup/pro-index.html#tabs`.

### Task 6: Recent and Tab lists

**Files:**
- Modify (rewrite): `main/pod/classic/pod_view_tab.c`
- Modify: `main/pod/pod_view.c:54-78` (Classic scroll pitch becomes `CI_ROW_H`)
- Test: `test/test_pod_views_tabs.c` (the list cases live there today; keep them there)

**Interfaces:**
- Consumes: `ci_bar` (back = `pod_nav_origin`; Recent shows "Back"), `ci_foot`, `ci_mark`, `ci_state_word`, `ci_fmt_elapsed`.
- Produces: `POD_A_OPEN_AGENT` hits with the agent id, as today.

- [ ] **Step 1: Write the failing tests:**
  - `test_list_no_heading`: the first row's top is at y 88.
  - `test_list_five_rows`: 7 agents give 5 row hits of height 104.
  - `test_list_meta_words`: Working, Finished, Needs you, Ready and Offline, each in its colour.
  - `test_list_long_name_ellipsis`: a 60-character name ends in "…" before the meta column.
  - `test_list_empty_tab`: "No panes yet." is present, there are no row hits, and the footer reads "No panes".
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.

### Task 7: Agent and Recap

**Files:**
- Modify (rewrite): `main/pod/classic/pod_view_agent.c`, `main/pod/classic/pod_view_recap.c`
- Modify: `main/pod/pod_view_shared.h` only if a shared helper changes signature (prefer not to).
- Test: `test/test_pod_views_agent.c`

**Interfaces:**
- Consumes: `ci_bar` (title "Task" or "Recap", back = `pod_nav_origin`), `ci_band`, `ci_talk`, `pod_pet_draw_on(…, 104, …, 0xf6f6f0)`, `pod_wrap`, `pod_recap_cut`.
- Produces: the same hits as today minus the transport ones, plus `POD_A_TALK` (enabled for idle, working and done). Swipe PREV/NEXT stays glue-driven.

- [ ] **Step 1: Write the failing tests:**
  - `test_agent_working_body`: "RIGHT NOW", at most 3 activity lines, at most 2 steps, and "Updated just now" when `event_ms` is within 60 s of now.
  - `test_agent_updated_minutes`: an event 180 s old gives "Updated 3m ago".
  - `test_agent_asking`: the ask box fill is `CI_ASK_FILL`, "Answer it in the Harness app." is present, and there is no TALK hit.
  - `test_agent_offline`: the copy uses the machine name, the pet is faded, and there is no TALK hit.
  - `test_agent_idle_copy`.
  - `test_agent_vietnamese_activity_wraps`: 3 lines of Vietnamese activity are cut with "…" and no line is wider than 656 px.
  - `test_agent_unknown_engine_mark`: an engine "zzz" gives the default mark box and no pet sprite run.
  - `test_recap_tokens_or_engine`.
  - `test_recap_scrolls_by_line`: `POD_A_SCROLL` moves the body by 42 px.
  - `test_agent_budget`: every state stays within budget, with the banner and bell spares.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the spec's Agent and Recap sections.
- [ ] **Step 4: Run** → PASS.

### Task 8: Inbox and the banner

**Files:**
- Modify (rewrite): `main/pod/classic/pod_view_inbox.c`
- Modify: `main/pod/pod_view.h:148-152`. The new signature is `int pod_banner(pod_out_frame_t *, const pod_model_t *, const pod_unread_t *u, uint32_t shown_ms, uint32_t now_ms);` with geometry `POD_BANNER_X=16`, `POD_BANNER_Y=98`, `POD_BANNER_W=688`, and `POD_BANNER_RUNS` raised to fit the measured count.
- Modify: `main/app/pod_glue.c:49` (pass `pod_ui_banner_shown_ms`)
- Test: `test/test_pod_views_inbox.c`, `test/test_cs_glue.c`

**Interfaces:**
- Consumes: `ci_bar`, `ci_foot`, `ci_mark`, `POD_A_BANNER_CLOSE` and `pod_ui_banner_shown_ms` (Task 4), `POD_A_FOLLOW`.
- Produces: banner hits, `POD_A_BANNER` (the card) and then `POD_A_BANNER_CLOSE` (65 × 65 at the card's top right).

- [ ] **Step 1: Write the failing tests:**
  - `test_inbox_heading_and_footer`: "2 unread." and the footer "2 unread".
  - `test_inbox_asking_first`: an asking agent's row comes first, with `POD_A_FOLLOW` and the row fill `CI_ROW_ASK`.
  - `test_inbox_failed_entry`: "Failed" in `CI_FAIL`.
  - `test_banner_timer_width`: at shown + 0, + 3000 and + 5900 ms, the line width is 688, 344 and about 11.
  - `test_banner_done_and_failed_lines`: "Done · 0m 48s", "Failed · 0m 48s", and "Done" when `elapsed_s < 0`.
  - `test_banner_close_first_frame`: the first frame after the banner appears already carries the CLOSE hit.
  - `test_banner_over_tabs_drag`: while Tabs is dragged, a tap on × closes the banner and the page does not move.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.

### Task 9: Voice, Connection lost and Update

**Files:**
- Modify (rewrite): `main/pod/classic/pod_view_talk.c`, `main/pod/classic/pod_view_ota.c`
- Modify: `main/pod/pod_view.c` (the `!linked` branch draws `ci_connection_lost` for Classic; Console keeps its own)
- Create the function `void ci_connection_lost(pod_out_frame_t *f, uint8_t unread);` in `ci_chrome.c`.
- Test: `test/test_pod_views_agent.c` (talk cases), and a new `test_pod_views_misc` section inside `test_pod_views_inbox.c` (to avoid another runner entry)

**Interfaces:**
- Consumes: `pod_pet_draw_on` (281 LISTEN, 209 SEND, ground 0xf6f6f0), `f->mic_level` for the 13 bars, `pod_grad_aa` for the progress fill.
- Produces: while listening in Classic, one full-screen `POD_A_TALK` hit {0,88,720,632}; the bar's Back still works. No hits on Update.

- [ ] **Step 1: Write the failing tests:**
  - `test_talk_listen_fullscreen_hit`.
  - `test_talk_no_bell_no_buttons`.
  - `test_talk_sending_copy`.
  - `test_ota_even_gaps`: the five items are 22 px apart, ±1 px, measured from the run boxes.
  - `test_ota_restarting`.
  - `test_link_down_shows_connection_lost`: the copy is present, the footer reads "Disconnected", and a recording in progress was aborted by the nav sync (existing behaviour; assert it).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.

### Task 10: Goldens, dead code, budget sweep

**Files:**
- Modify: `test/golden.sh` (the Classic screen list gains: inbox, inbox:ask, banner:done@0/3000/5900, banner:failed, offline-link, talk:listen, talk:send, tab:empty, tabs:9)
- Modify: `test/pod_render.c` (support those screens; the background is the scene's, not forced white)
- Regenerate: `test/golden.txt`, `test/golden-liberation.txt`
- Delete: the Classic helpers in `classic/pod_chrome.c` that no file calls any more (`grep` proves it). Keep the file only if something remains.

- [ ] **Step 1:** Run `bash test/golden.sh` and `PRO_FONT=$PWD/fonts/LiberationSans-Regular.ttf bash test/golden.sh` (they rewrite the baselines), then `--check` both → PASS.
- [ ] **Step 2:** `bash test/golden.sh --skin console --check`, in both fonts → unchanged.
- [ ] **Step 3:** Run the clang-18 / Liberation CI combination in Docker as before (`firmware-checks`: `-Wformat-truncation` etc.) → clean.
- [ ] **Step 4:** `idf.py build` → the app image fits, and the size goes in the report (compare with `docs/size-baseline.txt`).

### Task 11: Mockup comparison (dev check)

**Files:**
- Modify: `devices/harness-pro/mockup/pro-index/build.py` (main checkout, gitignored). With `--font liberation` it embeds `fonts/LiberationSans-{Regular,Bold}.ttf` as `@font-face` and writes `pro-index-liberation.html`.
- Create: `test/classic_vs_mockup.py`
  - It renders each screen from firmware (`pod_render.py`) and from the mockup (headless Chrome, `?only=<id>`, 720 × 720, with animations off).
  - It finds the ink boxes in matching regions (bar, band, rows, transport) and prints the offsets.
  - It exits non-zero when any offset is above 2 px.
  - Matching demo data: `pod_render.c`'s demo agents get the mockup's names (firmware-pro, backend, harness-cli, desktop, docs, landing, api-client).

- [ ] **Step 1:** Implement and run it on all 16 screens. Fix the views until it passes, or list the remaining deltas with a reason for each (pet and logo pixels are excluded).

### Task 12: Perf and the device

- [ ] **Step 1:** Add the Classic screens to `test/test_cs_perf.sh` (opt-in, `CS_PERF=1`) with a new baseline. Run it and record the host µs in `docs/size-baseline.txt`.
- [ ] **Step 2:** Build with `-DPROJECT_VER=0.0.99` and flash with `FLASH_PORT=<port> bash scripts/flash.sh` (the MAC must be in WANT_MACS). Then set `uiSkin` to classic in the app.
- [ ] **Step 3:** Walk every screen. Check:
  - tap-to-send;
  - the side button discarding;
  - banner × and the timer;
  - unplugging the cable (Connection lost);
  - a real Claude turn, through Agent working, Recap with tokens, and Inbox.
- [ ] **Step 4:** Read the heartbeat `frame_max_us` on Tabs, Recent, Agent working, Recap, Voice and the banner. Each must be ≤ 24 000. Report the numbers per screen, and file any miss in the report with the screen named.
