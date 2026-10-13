#pragma once
// Pod's screens. Each view fills an ht_scene_t and a hit list from the navigation stack and the model. Pure
// C11 apart from the scene: no I/O and no clock (now_ms is passed in).
#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>

#include "pod_draw.h"
#include "pod_nav.h"
#include "pod_pet.h"

// A hit names what it opens: arg is the index at draw time, id the agent or tab (empty for the Recent list and for
// the buttons). The list can reorder before the tap lands, so the glue resolves the id, not the index.
typedef struct { int16_t x, y, w, h; pod_action_t action; int16_t arg; char id[ID_MAX]; } pod_hit_t;
// tabs_moving / tabs_off: the Tabs grid's pixel offset from the top of page 0 (page * pod_tabs_pitch() at rest; below 0 or past
// the last page while the finger pulls the end), given by the glue while the grid is dragged or settling. Zero: at rest.
// unread / bell_x: set by pod_render (not by the caller): the unread count the status bar's bell shows (0: no bell; it is not
// drawn on the Inbox or while talking) and the bell's left edge. banner: set by the glue before pod_render when it will add
// the notification banner after it, so the views leave POD_BANNER_RUNS (and the bell's POD_BELL_RUNS) spare.
typedef struct { ht_scene_t *scene; pod_hit_t hits[32]; uint8_t hit_count; bool tabs_moving; int tabs_off;
                 uint8_t unread; int16_t bell_x; bool banner;
                 int mic_level;   // 0..4, pro_rec_level(): set by the app layer before rendering; the Console voice wave reads it
               } pod_out_frame_t;
enum { POD_BELL_RUNS = 7, POD_BANNER_RUNS = 16 };
static inline int pod_spare_runs(const pod_out_frame_t *f) { return (f->unread ? POD_BELL_RUNS : 0) + (f->banner ? POD_BANNER_RUNS : 0); }

// Layout, in px on the 720 x 720 glass.
// POD_CLASSIC_TRANSPORT_Y: where Classic's transport bar starts (ci.h's CI_TRANS_Y); the glue clears it of swipes and notices.
enum { POD_W = 720, POD_TRANSPORT_Y = 594, POD_CLASSIC_TRANSPORT_Y = 616 };

// ---- the screen -----------------------------------------------------------------------------------------
// Dispatches on the top frame. While !model->linked it draws the status bar and "Connecting…" only (the stack
// is untouched, the only hit is BACK).
// It advances the model's clock to now_ms first (pod_model_clock), so every reader applies the same stale rule.
void pod_render(pod_out_frame_t *, const pod_nav_t *, pod_model_t *, uint32_t now_ms);

// ---- scrolling is in rows ---------------------------------------------------------------------------------
// Frame.scroll counts rows, whatever the screen draws a row as. Pixels of finger travel become rows in the glue:
// the pitch is the px one row occupies on the top screen (0: it does not scroll) and the max is its last valid
// offset (the views clamp their own draw to it as well).
int pod_scroll_pitch(const pod_nav_t *);
int pod_scroll_max(const pod_nav_t *, const pod_model_t *);

// ---- chrome (pod_chrome.c) ------------------------------------------------------------------------------
// The title the top frame wants (the Tab screen's bar).
const char *pod_view_title(const pod_nav_t *, const pod_model_t *);
// The three-bar equaliser, 23 x 20 at (x, y), moving with now_ms. Always 3 runs.
void pod_eq(ht_scene_t *, int x, int y, uint16_t ink, uint32_t now_ms);
bool pod_hit_add(pod_out_frame_t *, int x, int y, int w, int h, pod_action_t action, int arg);
bool pod_hit_add_id(pod_out_frame_t *, int x, int y, int w, int h, pod_action_t action, int arg, const char *id);
// The Tab screen's scroll geometry (see pod_scroll_*), and the Tabs grid's: a page is two rows of three covers; the frame's
// scroll is the page's first row (even), so max_row is the last page's. pitch is a page's height in px.
int pod_tabs_pitch(void);
int pod_tabs_pages(const pod_model_t *);
// The grid's pages for the skin: the Console's Overview holds four cards a page (2 x 2), the Classic grid six.
int pod_tabs_pages_of(const pod_nav_t *, const pod_model_t *);
// The Playing ribbon's bars step through three heights every POD_TABS_BAR_MS; pod_tabs_ribbon: does a ribbon show on this resting page?
enum { POD_TABS_BAR_MS = 300 };
bool pod_tabs_ribbon(const pod_model_t *, int page);
int pod_tabs_max_row(const pod_model_t *);
int pod_tab_pitch(void);
int pod_tab_max_row(const pod_nav_t *, const pod_model_t *);
// The Recap screen's: a row is one wrapped line of the recap; the last offset shows its last lines.
int pod_recap_max_row(const pod_nav_t *, const pod_model_t *);
int pod_recap_pitch(void);   // the drawn body line pitch
// Small helpers shared by the views.
void pod_engine_name(char *out, size_t n, const char *engine);
void pod_fmt_time(char *out, size_t n, uint32_t secs);                      // "m:ss"
uint32_t pod_agent_secs(const pod_agent_t *, uint32_t now_ms);              // elapsed while working, else the last
// Working and asking agents among a tab's known members.
void pod_tab_counts(const pod_model_t *, const pod_tab_t *, int *working, int *asking);
int pod_tab_panes(const pod_tab_t *);   // the pane count to show: the daemon's panes, else the members
const pod_tab_t *pod_tab_of(const pod_model_t *, const pod_agent_t *);      // the first tab holding the agent
int pod_agent_pane(const pod_model_t *, const pod_agent_t *, const pod_tab_t *);   // its 1-based pane in the tab, or 0
int pod_agent_index(const pod_model_t *, const pod_agent_t *);

// Drawing primitives Pod's glyph-free icons are made of (the Pro fonts have no arrows or chevrons).
// A chevron ‹ with its tip at (x, y); legs a px across and down, one mitered stroke (4 runs).
void pod_chevron(ht_scene_t *, int x, int y, int a, uint16_t ink);
// A tick ✓ in a box with top-left (x, y), about 20 x 15 (4 runs).
void pod_tick(ht_scene_t *, int x, int y, uint16_t ink);

// ---- views ----------------------------------------------------------------------------------------------
void pod_view_tabs(pod_out_frame_t *, const pod_nav_t *, const pod_model_t *, uint32_t now_ms);
void pod_view_tab(pod_out_frame_t *, const pod_nav_t *, const pod_model_t *, uint32_t now_ms);
// Task 8 provides these three.
void pod_view_agent(pod_out_frame_t *, const pod_nav_t *, const pod_model_t *, uint32_t now_ms);
void pod_view_recap(pod_out_frame_t *, const pod_nav_t *, const pod_model_t *, uint32_t now_ms);
void pod_view_talk(pod_out_frame_t *, const pod_nav_t *, const pod_model_t *, uint32_t now_ms);
// The Inbox (pod_view_inbox.c): the unread notifications as the Tab list's rows, newest first, 84 px each.
void pod_view_inbox(pod_out_frame_t *, const pod_nav_t *, const pod_model_t *, uint32_t now_ms);
int pod_inbox_pitch(void);
int pod_inbox_max_row(const pod_model_t *);
// The software-update screen (pod_view_ota.c), drawn by the glue instead of the stack while an update runs: the status bar
// "Updating", the mark, "Updating Harness Pro", "<from> -> <to>" and a progress bar (pct 0..100); restarting: the ring,
// "Restarting..." and "<to> is installed". Full screen, no transport, no hits.
void pod_view_ota(pod_out_frame_t *, const char *from, const char *to, int pct, bool restarting);
// "now", "3m", "1h", "2d" for an age in seconds.
void pod_fmt_age(char *out, size_t n, uint32_t secs);
// The notification banner for unread entry `u`: a card at (16, 98), 688 px wide, over whatever the frame holds (call it last): the
// engine's mark, the agent's name, the recap's first two lines, "Done . 0m 48s" (or "Failed ..."), the x and, along the card's bottom
// edge, a 6 px blue line that shrinks from the full width at shown_ms to 0 after POD_BANNER_MS. Adds the hits POD_A_BANNER (the card)
// then POD_A_BANNER_CLOSE (65 x 65 at its top right, on top). Returns the card's height. At most POD_BANNER_RUNS runs.
#ifndef POD_BANNER_MS
#define POD_BANNER_MS 6000   // how long a banner shows (pod_glue.h repeats it)
#endif
enum { POD_BANNER_X = 16, POD_BANNER_Y = 98, POD_BANNER_W = 688 };
int pod_banner(pod_out_frame_t *, const pod_model_t *, const pod_unread_t *u, uint32_t shown_ms, uint32_t now_ms);
// Milliseconds until the top screen, if it shows a pet (Agent, Recap, Talk), next draws something different: the pet's
// next step and every animation beside it. POD_PET_STEP_MS when unsure. Always >= 1.
uint32_t pod_view_next_ms(const pod_nav_t *, const pod_model_t *, uint32_t now_ms);
uint32_t pod_view_agent_next_ms(const pod_nav_t *, const pod_model_t *, uint32_t now_ms);
uint32_t pod_view_recap_next_ms(const pod_nav_t *, const pod_model_t *, uint32_t now_ms);
uint32_t pod_view_talk_next_ms(const pod_nav_t *, const pod_model_t *, uint32_t now_ms);
