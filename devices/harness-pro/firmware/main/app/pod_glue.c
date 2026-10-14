#include "pod_glue.h"

#include <stdio.h>
#include <string.h>

#include "pod/console/cs.h"
#include "pro_canvas.h"

static void set_id(char *dst, const char *src) { strncpy(dst, src ? src : "", ID_MAX - 1); dst[ID_MAX - 1] = 0; }

void pod_ui_init(pod_ui_t *u)
{
    memset(u, 0, sizeof *u);
    pod_model_reset(&u->model);
    pod_nav_init(&u->nav);
}

static const pod_frame_t *top(const pod_ui_t *u);
static int pg_offset(pod_ui_t *u, uint32_t now_ms);

void pod_ui_render(pod_ui_t *u, ht_scene_t *scene, uint32_t now_ms)
{
    u->frame.scene = scene;
    u->frame.hit_count = 0;
    u->frame.tabs_off = 0;
    u->frame.tabs_moving = false;
    if (u->pg_mode) {   // the Tabs grid is dragged or settling: tell the view where it is
        int off = pg_offset(u, now_ms);
        if (u->pg_mode) { u->frame.tabs_moving = true; u->frame.tabs_off = off; }
    }
    pod_model_clock(&u->model, now_ms);
    if (u->ota) {   // the update owns the glass: no stack, no banner, no notice pill
        u->frame.banner = false;
        if (u->nav.skin == POD_SKIN_CONSOLE) cs_view_ota(&u->frame, u->ota_from, u->ota_to, u->ota_pct, u->ota_restarting);
        else pod_view_ota(&u->frame, u->ota_from, u->ota_to, u->ota_pct, u->ota_restarting);
        u->seen_revision = u->model.revision;
        u->dirty = false;
        return;
    }
    pod_nav_flip_recaps(&u->nav, &u->model);   // the clock alone can end a stale Working: show the recap it opens on
    // The banner shows while its entry is still unread, the time has not run out, the cable is up and nobody is recording.
    const pod_unread_t *ban = NULL;
    if (u->ban_on && (int32_t)(now_ms - u->ban_until) >= 0) u->ban_on = false;
    if (u->ban_on && !(ban = pod_model_unread_find(&u->model, u->ban_agent))) u->ban_on = false;
    u->frame.banner = ban && u->model.linked && !pod_ui_talking(u);
    pod_render(&u->frame, &u->nav, &u->model, now_ms);
    if (u->frame.banner) {   // over everything, with the hit on top
        if (u->nav.skin == POD_SKIN_CONSOLE) cs_toast(&u->frame, &u->model, ban, now_ms);
        else pod_banner(&u->frame, &u->model, ban, pod_ui_banner_shown_ms(u), now_ms);
    }
    if (u->notice_on && (int32_t)(now_ms - u->notice_until) >= 0) u->notice_on = false;
    if (u->notice_on && u->model.linked) {
        // Two runs: the pill and its line. Present or absent is a different state, each constant.
        const bool classic = u->nav.skin != POD_SKIN_CONSOLE;
        // Classic: the mockup's toast (Regular 24, 12 px padding, radius 7, at most 604 wide) just above its transport bar.
        const ht_pro_font_t *font = classic ? &ci_rg_24 : &ht_pro_24;
        int w = ht_pro_width(font, u->notice);
        if (w > (classic ? 580 : 600)) w = classic ? 580 : 600;
        int pw = w + (classic ? 24 : 40);
        const int ny = (classic ? POD_CLASSIC_TRANSPORT_Y : POD_TRANSPORT_Y) - 8 - 40;   // just above the transport bar; the agent's name is up top
        const uint16_t bg = ht_rgb(u->notice_bad ? 0xb3261e : classic ? 0x25372f : 0x111111);
        if (classic) ht_pro_rect_aa(scene, (POD_W - pw) / 2, ny, pw, 40, 7, bg);
        else ht_pro_rect(scene, (POD_W - pw) / 2, ny, pw, 40, 20, bg);
        ht_pro_text(scene, (POD_W - w) / 2, ny + (classic ? (40 - font->height) / 2 : 7), w, font, ht_rgb(0xffffff), u->notice);
    }
    u->seen_revision = u->model.revision;
    u->dirty = false;
}

static void apply_pending_focus(pod_ui_t *u);
static pod_out_t synced(pod_ui_t *u)
{
    pod_out_t o = pod_nav_sync(&u->nav, &u->model);
    apply_pending_focus(u);
    return o;
}

pod_out_t pod_ui_link(pod_ui_t *u, bool up)
{
    if (up && !u->model.linked) u->sweep.restart = true;
    if (!up) pod_ui_sweep_abort(u);
    pod_model_link(&u->model, up);
    return synced(u);
}

// The model's tabs hold roster indices, so they are rebuilt from the retained swarm frame.
static void rebuild_tabs(pod_ui_t *u)
{
    if (!u->sw_n) return;
    for (int i = 0; i < u->sw_n; i++) {
        for (int k = 0; k < u->sw_member_count[i]; k++) u->sw_ptr[i][k] = u->sw_member_id[i][k];
        u->sw_list[i] = u->sw_ptr[i];
    }
    pod_model_swarms_meta(&u->model, u->sw_items, u->sw_list, u->sw_member_count, u->sw_n, u->sw_selected, u->sw_tiles,
                          u->sw_tile_n, u->sw_meta);
}

pod_out_t pod_ui_roster(pod_ui_t *u, const pod_roster_row_t *rows, int n)
{
    pod_model_agents_begin(&u->model);
    for (int i = 0; i < n; i++) pod_model_agent(&u->model, rows[i].id, rows[i].name, rows[i].engine, rows[i].machine);
    pod_model_agents_end(&u->model);
    rebuild_tabs(u);
    return synced(u);
}

pod_out_t pod_ui_swarms(pod_ui_t *u, const cable_swarm_t *items, int n, const cable_swarm_members_t *members,
                        const char *selected, const cable_tile_t *tiles, int tile_count)
{
    if (n < 0 || !items) n = 0;
    if (n > SWARMS_MAX) n = SWARMS_MAX;
    if (tile_count < 0 || !tiles) tile_count = 0;
    if (tile_count > SWARM_TILES_MAX) tile_count = SWARM_TILES_MAX;
    bool same = n == u->sw_n;
    for (int i = 0; same && i < n; i++) {
        int c = members ? members->count[i] : 0;
        same = !strcmp(items[i].id, u->sw_items[i].id) && c == u->sw_member_count[i];
        for (int k = 0; same && k < c && k < POD_MEMBERS_MAX; k++) same = !strcmp(members->id[i][k], u->sw_member_id[i][k]);
    }
    if (!same) u->sweep.restart = true;   // another tab, another set of agents to look up
    u->sw_n = n;
    u->sw_tile_n = tile_count;
    if (n) memcpy(u->sw_items, items, (size_t)n * sizeof *items);
    if (tile_count) memcpy(u->sw_tiles, tiles, (size_t)tile_count * sizeof *tiles);
    set_id(u->sw_selected, selected);
    for (int i = 0; i < n; i++) {
        int c = members ? members->count[i] : 0;
        if (c > POD_MEMBERS_MAX) c = POD_MEMBERS_MAX;
        u->sw_member_count[i] = (uint8_t)c;
        for (int k = 0; k < c; k++) set_id(u->sw_member_id[i][k], members->id[i][k]);
        for (int k = 0; k < POD_MEMBERS_MAX; k++)
            u->sw_meta[i][k] = members && k < c ? members->meta[i][k] : (pod_member_meta_t){0};
    }
    if (!n) {   // no tabs: rebuild_tabs() would skip it, so clear the model here
        pod_model_swarms_meta(&u->model, NULL, NULL, NULL, 0, NULL, NULL, 0, u->sw_meta);
    } else {
        rebuild_tabs(u);
    }
    return synced(u);
}

pod_out_t pod_ui_status(pod_ui_t *u, const char *id, const char *status, uint32_t now_ms)
{
    pod_model_library_status(&u->model, id, status, now_ms);
    return synced(u);
}

pod_out_t pod_ui_turn(pod_ui_t *u, const char *id, const char *kind, const char *text, int elapsed_s, uint32_t now_ms)
{
    pod_model_turn(&u->model, id, kind, text, elapsed_s, now_ms);
    return synced(u);
}

pod_out_t pod_ui_turn_stats(pod_ui_t *u, const char *id, int32_t passed, int32_t failed, int32_t commits, int32_t tokens_in, int32_t tokens_out)
{
    pod_model_turn_stats(&u->model, id, passed, failed, commits, tokens_in, tokens_out);
    return synced(u);
}

pod_out_t pod_ui_set_skin(pod_ui_t *u, pod_skin_t skin)
{
    u->hands_free = false;   // a skin switch discards a hands-free recording: the cancel aborts it
    const pod_out_t cancelled = pod_ui_touch_cancel(u);   // a contact or hold under way belongs to the old screen
    pod_nav_init(&u->nav);
    u->nav.skin = skin;
    u->dirty = true;
    const pod_out_t o = synced(u);
    return cancelled.fx != POD_FX_NONE ? cancelled : o;   // an ABORT the cancel produced is not lost
}

pod_out_t pod_ui_sent(pod_ui_t *u, const char *id, uint32_t now_ms)
{
    pod_model_sent(&u->model, id, now_ms);
    return synced(u);
}

pod_out_t pod_ui_question(pod_ui_t *u, const char *id, const char *text)
{
    pod_model_question(&u->model, id, text);
    return synced(u);
}

pod_out_t pod_ui_question_close(pod_ui_t *u, const char *id)
{
    pod_model_question_close(&u->model, id);
    return synced(u);
}

pod_out_t pod_ui_recap(pod_ui_t *u, const char *id, const char *recap, bool restore)
{
    pod_model_recap(&u->model, id, recap, restore);
    return synced(u);
}

bool pod_ui_take_changed(pod_ui_t *u)
{
    if (u->dirty) { u->dirty = false; u->seen_revision = u->model.revision; return true; }
    if (u->model.revision == u->seen_revision) return false;
    u->seen_revision = u->model.revision;
    return true;
}

// ---- touch -------------------------------------------------------------------------------------------------

static const pod_frame_t *top(const pod_ui_t *u) { return u->nav.depth ? &u->nav.stack[u->nav.depth - 1] : NULL; }
static int iabs(int v) { return v < 0 ? -v : v; }

static bool scrolls(const pod_ui_t *u)
{
    const pod_frame_t *f = top(u);
    if (!f) return false;
    if (u->nav.skin == POD_SKIN_CONSOLE)   // Overview pages sideways and a tab's (and Recent's) cards page on a swipe (card_page); the
        // Inbox scrolls; on Agent and Recap a drag scrolls the host's pane (host_scrolls)
        return f->view == POD_V_INBOX || f->view == POD_V_AGENT || f->view == POD_V_RECAP;
    return f->view == POD_V_TABS || f->view == POD_V_TAB || f->view == POD_V_RECAP || f->view == POD_V_INBOX;
}
// Console Tab and Recent: their cards page on a vertical swipe, from anywhere but the bar and the bottom zone (their own swipes;
// the caller checks the zone, whose flag is cleared by then).
static bool card_page(const pod_ui_t *u)
{
    const pod_frame_t *f = top(u);
    return u->nav.skin == POD_SKIN_CONSOLE && f && f->view == POD_V_TAB && !u->bar;
}
// Whether a vertical drag on this screen scrolls the host's terminal pane (the scroll sink): Recap in both skins, and in Console the
// Agent screen too, as on the round. The bar and the bottom zone keep their own swipes (u->bar, u->edge), so a drag there does not.
static bool host_scrolls(const pod_ui_t *u)
{
    const pod_frame_t *f = top(u);
    return f && (f->view == POD_V_RECAP || (u->nav.skin == POD_SKIN_CONSOLE && f->view == POD_V_AGENT));
}
// A horizontal swipe on the Agent, Recap and Talking screens steps panes, as on the round dial (swipe left = next, right =
// previous): travel >= POD_SW_MIN_PX, |dx| > 1.5 |dy|, released within POD_SW_MS or leaving at POD_SW_FLICK px/s.
// Not from the transport bar (taps only). It is never also a tap or a Recap scroll.
#define POD_SW_MIN_PX 60
#define POD_SW_MS 700
#define POD_SW_FLICK 600
static bool swipes(const pod_ui_t *u)
{
    const pod_frame_t *f = top(u);
    return f && (f->view == POD_V_AGENT || f->view == POD_V_RECAP || f->view == POD_V_TALK ||
                 ((f->view == POD_V_TAB || f->view == POD_V_TABS || f->view == POD_V_INBOX) && u->nav.skin == POD_SKIN_CONSOLE));   // Console: the tab view steps tabs, Overview pages, the Inbox goes back
}
// Console hold to talk: only on the agent's own screens (Agent, Recap). Not on a Tab tile or a Recent row (a long press there is
// a tap: its lift opens the agent), not in the command bar (crumbs, chips), not on an agent that asks (voice stays refused
// there, so the hold does not arm and no notice fires). Returns the agent id the hold would talk to, or NULL.
static const char *hold_target(const pod_ui_t *u)
{
    const pod_frame_t *f = top(u);
    if (u->nav.skin != POD_SKIN_CONSOLE || !f || u->ban_touch) return NULL;
    if (u->start_y < POD_BAR_H) return NULL;   // nothing in the command bar holds
    if (u->hit_valid && (u->hit.action == POD_A_BACK || u->hit.action == POD_A_ATTENTION || u->hit.action == POD_A_INBOX)) return NULL;
    const char *id = f->view == POD_V_AGENT || f->view == POD_V_RECAP ? f->agent : NULL;
    const pod_agent_t *a = id ? pod_model_find(&u->model, id) : NULL;
    return a && pod_model_eff(&u->model, a) != POD_ASKING ? id : NULL;
}
static bool wide(int dx, int dy) { return iabs(dx) * 2 > iabs(dy) * 3; }
static bool inside(const pod_hit_t *h, int x, int y)
{
    return x >= h->x && x < h->x + h->w && y >= h->y && y < h->y + h->h;
}

// Scroll counts rows (pod_scroll_pitch px each), not pixels: travel accumulates, half a row of it steps one row,
// and the offset stays within the screen's last valid row. True when the offset moved.
static bool scroll_rows(pod_ui_t *u, int travel_px, uint32_t now_ms)
{
    int pitch = pod_scroll_pitch(&u->nav), max = pod_scroll_max(&u->nav, &u->model);
    if (pitch <= 0) return false;
    pod_frame_t *f = &u->nav.stack[u->nav.depth - 1];
    int row = f->scroll, before = row;
    u->scroll_px += travel_px;
    while (u->scroll_px >= pitch / 2 && row < max) { row++; u->scroll_px -= pitch; }
    while (u->scroll_px <= -(pitch / 2) && row > 0) { row--; u->scroll_px += pitch; }
    if ((row == max && u->scroll_px > 0) || (row == 0 && u->scroll_px < 0)) u->scroll_px = 0;   // pushing past an end
    if (row != before) pod_nav_act(&u->nav, &u->model, POD_A_SCROLL, row - before, now_ms);
    return row != before;
}

// ---- the Tabs grid's pages ---------------------------------------------------------------------------------
// The grid is paged: two rows a page, the frame's scroll the first row of the resting page. While the finger drags, the
// offset (px from the top of page 0) is base - dy, with a third of the pull past either end (a rubber band). On the release
// the page it settles on is the nearest to the offset, or the next one in the flick's direction when the finger left
// faster than POD_PG_FLICK; the frame takes that page at once and the offset eases there in POD_PG_ANIM_MS. A render
// stamps the offset into the frame, pod_ui_wake_ms asks for a render every 16 ms while it runs.

static bool pg_on(const pod_ui_t *u)
{
    const pod_frame_t *f = top(u);
    return f && f->view == POD_V_TABS && u->nav.skin != POD_SKIN_CONSOLE && pod_tabs_pages_of(&u->nav, &u->model) > 1;   // Console pages with a swipe: no drag, no settle
}
static int pg_page(const pod_ui_t *u)   // the resting page, from the frame
{
    int p = top(u)->scroll / 2, last = pod_tabs_pages_of(&u->nav, &u->model) - 1;
    return p < 0 ? 0 : p > last ? last : p;
}
static int pg_band(const pod_ui_t *u, int raw)
{
    int end = (pod_tabs_pages_of(&u->nav, &u->model) - 1) * pod_tabs_pitch();
    return raw < 0 ? raw / 3 : raw > end ? end + (raw - end) / 3 : raw;
}
static int pg_ease(const pod_ui_t *u, uint32_t dt)   // ease-out cubic from pg_from to pg_to
{
    long long t = (long long)dt * 1024 / POD_PG_ANIM_MS, r = 1024 - t;
    long long e = 1024 - r * r * r / (1024 * 1024);
    return u->pg_from + (int)((long long)(u->pg_to - u->pg_from) * e / 1024);
}
// The offset to draw now; ends the animation (mode IDLE) when it has run its time or the grid is no longer the screen.
static int pg_offset(pod_ui_t *u, uint32_t now_ms)
{
    if (!pg_on(u)) { u->pg_mode = POD_PG_IDLE; return 0; }
    if (u->pg_mode == POD_PG_DRAG) return pg_band(u, u->pg_base - u->pg_dy);
    if (u->pg_t0_pending) { u->pg_t0 = now_ms; u->pg_t0_pending = false; }
    uint32_t dt = now_ms - u->pg_t0;
    if ((int32_t)dt >= (int32_t)POD_PG_ANIM_MS) { u->pg_mode = POD_PG_IDLE; return u->pg_to; }
    return pg_ease(u, (int32_t)dt < 0 ? 0 : dt);
}
static int pg_nearest(const pod_ui_t *u, int off)
{
    int last = pod_tabs_pages_of(&u->nav, &u->model) - 1, pitch = pod_tabs_pitch();
    int p = off <= 0 ? 0 : (off + pitch / 2) / pitch;
    return p > last ? last : p;
}
// The finger is up (or the contact was cancelled: no velocity): pick the page and start settling onto it.
static void pg_release(pod_ui_t *u, uint32_t now_ms, bool cancelled)
{
    int pitch = pod_tabs_pitch(), last = pod_tabs_pages_of(&u->nav, &u->model) - 1;
    int off = pg_band(u, u->pg_base - u->pg_dy), from = pg_nearest(u, u->pg_base);
    int target = pg_nearest(u, off);
    int vel = (cancelled || (int32_t)(now_ms - u->pg_last_ms) > 100) ? 0 : u->pg_vel;   // a finger that rested has no flick
    if (vel <= -POD_PG_FLICK && target <= from) target = from + 1;
    if (vel >= POD_PG_FLICK && target >= from) target = from - 1;
    target = target < 0 ? 0 : target > last ? last : target;
    int rows = (target - pg_page(u)) * 2;
    if (rows) pod_nav_act(&u->nav, &u->model, POD_A_SCROLL, rows, now_ms);
    u->pg_from = off;
    u->pg_to = target * pitch;
    u->pg_t0 = now_ms;
    u->pg_t0_pending = cancelled;
    u->pg_mode = off == u->pg_to ? POD_PG_IDLE : POD_PG_ANIM;
}

void pod_ui_scroll_sink(pod_ui_t *u, ht_scroll_emit_t emit, void *ctx, bool reversed)
{
    u->scroll_emit = emit;
    u->scroll_ctx = ctx;
    u->scroll_reversed = reversed;
}

// A tap on the banner: show that agent as a focus would (Tabs -> its tab -> its Recap or Agent screen), tell the host (agent.open),
// and mark it read. An agent already on screen or off the roster is only marked read.
static pod_out_t banner_open(pod_ui_t *u, uint32_t now_ms)
{
    pod_out_t o;
    memset(&o, 0, sizeof o);
    char id[ID_MAX];
    pod_copy_str(id, sizeof id, u->hit.id);
    u->ban_on = false;
    if (pod_nav_follow(&u->nav, &u->model, id, now_ms)) {
        u->pg_mode = POD_PG_IDLE;
        u->scroll_px = 0;
        o.fx = POD_FX_AGENT_OPEN;
        pod_copy_str(o.agent, sizeof o.agent, id);
    }
    pod_model_unread_read(&u->model, id);
    return o;
}

// The Console hold's deadline passed with the finger still: talk to the agent on screen. An offline
// machine gets the notice instead. The contact is the hold's from here on, tap or not. It runs from the touch samples
// (pod_ui_touch), the one task that also ends or aborts the recording, so a begin can never be overtaken by its end.
static pod_out_t hold_fire(pod_ui_t *u, uint32_t now_ms)
{
    pod_out_t none;
    memset(&none, 0, sizeof none);
    u->hold_armed = false;
    const pod_frame_t *t = top(u);
    if (!t || u->nav.depth != u->hold_depth || t->view != u->hold_view || strcmp(t->agent, u->hold_agent))
        return none;   // the screen or the agent changed under the finger since the DOWN: not this hold's any more
    u->hold_fired = true;
    u->hit_valid = false;
    char id[ID_MAX];
    pod_copy_str(id, sizeof id, u->hold_agent);
    const pod_agent_t *ag = pod_model_find(&u->model, id);
    if (!ag || pod_model_eff(&u->model, ag) == POD_ASKING) return none;
    if (ag->state == POD_OFFLINE) {
        pod_ui_notice(u, "That machine is offline", now_ms);
        return none;
    }
    pod_out_t o = pod_nav_act(&u->nav, &u->model, POD_A_TALK, 0, now_ms);
    if (o.fx != POD_FX_VOICE_BEGIN) {
        u->dirty = true;
        return none;
    }
    u->hold_voice = true;
    u->hands_free = true;   // the lift of this contact does nothing; a later tap sends
    u->dirty = true;
    return o;
}

pod_out_t pod_ui_touch(pod_ui_t *u, bool down, int x, int y, uint32_t now_ms, bool *changed)
{
    pod_out_t none;
    memset(&none, 0, sizeof none);
    bool dummy;
    if (!changed) changed = &dummy;
    *changed = false;
    if (u->ota) return none;   // nothing to tap while the image is written
    if (down && !u->down) {
        if (u->scroll_begun) { ht_scroll_cancel(&u->scroll); u->scroll_begun = false; }   // a stroke whose UP never came
        u->down = true;
        u->down_ms = now_ms;
        u->touched = true;
        u->last_touch_ms = now_ms;
        u->cancelled = u->dragging = u->hit_valid = u->ban_touch = false;
        memset(&u->hit, 0, sizeof u->hit);   // a DOWN on nothing carries nothing over from the last contact
        if (u->hands_free && !pod_ui_talking(u)) u->hands_free = u->hold_voice = false;   // Talk ended some other way
        u->hold_armed = u->hold_fired = false;
        if (!u->hands_free) u->hold_voice = false;   // a hands-free recording keeps its owner for this tap
        u->bar = !u->hands_free && u->nav.skin == POD_SKIN_CONSOLE && u->nav.depth > 1 && y < POD_BAR_H && top(u)->view != POD_V_TALK;
        u->start_x = x;
        u->start_y = y;
        u->anchor_y = y;
        u->scroll_px = 0;
        u->pg_dy = u->pg_vel = 0;
        // Console has no transport line (Classic's starts at POD_CLASSIC_TRANSPORT_Y): a contact from anywhere may swipe sideways. One that starts in the bottom zone is a
        // swipe up (BACK) or sideways (panes), decided on the lift by which direction dominates.
        const bool console = u->nav.skin == POD_SKIN_CONSOLE;
        u->sw_ok = !u->hands_free && swipes(u) && (console || y < POD_CLASSIC_TRANSPORT_Y);
        const pod_view_t tv = top(u)->view;
        u->edge = !u->hands_free && console && u->nav.depth > 1 && tv != POD_V_TALK &&
                  y >= (tv == POD_V_TAB || tv == POD_V_INBOX ? POD_LIST_BOTTOM_Y : POD_BOTTOM_Y);
        u->sw_on = false;
        u->sw_vx = 0;
        u->sw_last_x = x;
        u->sw_last_ms = now_ms;
        u->pg_last_y = y;
        u->pg_last_ms = now_ms;
        if (pg_on(u)) {   // a grid still settling is caught where it is (the touch then only stops it); else the resting page
            bool caught = u->pg_mode == POD_PG_ANIM;
            u->pg_base = caught ? pg_offset(u, now_ms) : pg_page(u) * pod_tabs_pitch();
            u->pg_mode = caught && u->pg_mode == POD_PG_ANIM ? POD_PG_DRAG : POD_PG_IDLE;
        } else {
            u->pg_mode = POD_PG_IDLE;
        }
        // The later hit is drawn on top of the earlier ones.
        // Priority: the banner's x sits inside the card's POD_A_BANNER hit, so it is looked for first, whatever the order
        // the views added them in. Every other hit: the last added wins.
        int pick = -1;
        if (u->frame.banner)
            for (int i = (int)u->frame.hit_count - 1; i >= 0 && pick < 0; i--)
                if (u->frame.hits[i].action == POD_A_BANNER_CLOSE && inside(&u->frame.hits[i], x, y)) pick = i;
        if (pick < 0)
            for (int i = (int)u->frame.hit_count - 1; i >= 0; i--)
                if (inside(&u->frame.hits[i], x, y)) { pick = i; break; }
        if (pick >= 0) {
            u->hit = u->frame.hits[pick];
            u->hit_valid = true;
        }
        if (u->hands_free && pod_ui_talking(u)) {   // the send tap is the whole screen's, even before Talk is drawn (u->frame is the old screen's)
            memset(&u->hit, 0, sizeof u->hit);
            u->hit.w = POD_W;
            u->hit.h = POD_W;
            u->hit.action = POD_A_TALK;
            u->hit_valid = true;
        }
        if (u->hit_valid && (u->hit.action == POD_A_BANNER || u->hit.action == POD_A_BANNER_CLOSE)) {   // the banner takes the whole contact: no scroll, no swipe, no tap through it
            u->ban_touch = true;
            u->sw_ok = false;
            if (u->pg_mode == POD_PG_DRAG && pg_on(u)) pg_release(u, now_ms, false);   // a grid caught mid-settle lets go
        }
        const char *target = hold_target(u);
        if (target) {   // the hold belongs to this screen and this agent: if either changes before it fires, it does not
            u->hold_armed = true;
            u->hold_due_ms = now_ms + POD_HOLD_MS;
            u->hold_depth = u->nav.depth;
            u->hold_view = top(u)->view;
            pod_copy_str(u->hold_agent, sizeof u->hold_agent, target);
        }
        return none;
    }
    if (down) {
        if (!u->down || u->cancelled || u->ban_touch) return none;
        if (u->hold_armed && (iabs(x - u->start_x) > POD_TAP_SLOP || iabs(y - u->start_y) > POD_TAP_SLOP)) u->hold_armed = false;
        if (u->hold_armed && (int32_t)(now_ms - u->hold_due_ms) >= 0) {   // the still finger's sample that finds the deadline passed
            pod_out_t held = hold_fire(u, now_ms);
            if (u->hold_fired) { *changed = true; return held; }
        }
        if (u->hold_fired) return none;   // after the hold the contact only waits for its lift: never a scroll, a swipe or a tap
        if (iabs(x - u->start_x) > POD_TAP_SLOP || iabs(y - u->start_y) > POD_TAP_SLOP) u->hit_valid = false;
        if (u->sw_ok) {
            if ((int32_t)(now_ms - u->sw_last_ms) > 0) {
                int inst = (x - u->sw_last_x) * 1000 / (int)(now_ms - u->sw_last_ms);
                u->sw_vx = (u->sw_vx + inst) / 2;
                u->sw_last_x = x;
                u->sw_last_ms = now_ms;
            }
            if (!u->dragging && iabs(x - u->start_x) > POD_TAP_SLOP && wide(x - u->start_x, y - u->start_y)) u->sw_on = true;
        }
        if (scrolls(u) && pg_on(u) && top(u)->view == POD_V_TABS) {   // the paged grid follows the finger
            if (u->dragging || iabs(y - u->start_y) > POD_TAP_SLOP) {
                u->dragging = true;
                u->pg_mode = POD_PG_DRAG;
                int dy = y - u->start_y;
                if ((int32_t)(now_ms - u->pg_last_ms) > 0) {
                    int inst = (y - u->pg_last_y) * 1000 / (int)(now_ms - u->pg_last_ms);
                    u->pg_vel = (u->pg_vel + inst) / 2;
                    u->pg_last_y = y;
                    u->pg_last_ms = now_ms;
                }
                if (dy != u->pg_dy) { u->pg_dy = dy; *changed = true; }
            }
        } else if (scrolls(u) && !u->sw_on && !u->bar && !u->edge && (u->dragging || iabs(y - u->start_y) > POD_TAP_SLOP)) {
            // The first step carries the travel since the DOWN; each later one the travel since the last.
            int dy = y - u->anchor_y;
            u->dragging = true;
            u->anchor_y = y;
            if (host_scrolls(u) && u->scroll_emit) {
                if (!u->scroll_begun) {   // from the DOWN's point and time, so the first MOVE carries the travel so far
                    ht_scroll_begin(&u->scroll, u->start_x, u->start_y, u->down_ms, u->scroll_reversed, false, u->scroll_emit,
                                    u->scroll_ctx);
                    u->scroll_begun = true;
                }
                ht_scroll_move(&u->scroll, x, y, now_ms);
            }
            if (dy && scroll_rows(u, -dy, now_ms)) *changed = true;
        }
        return none;
    }
    // UP
    bool was = u->down && !u->cancelled;
    if (u->down) { u->touched = true; u->last_touch_ms = now_ms; }
    u->down = false;
    u->hold_armed = false;
    if (u->hold_fired) {   // the hold already took this contact: its lift does nothing (a recording stays open, hands free)
        u->hold_fired = false;
        return none;
    }
    if (u->scroll_begun) {   // the lift carries the rest of the travel and the speed it left at
        ht_scroll_end(&u->scroll, x, y, now_ms);
        u->scroll_begun = false;
    }
    if (u->ban_touch) {   // a contact that began on the banner: a swipe up dismisses it, a tap opens the agent
        u->ban_touch = false;
        if (!was) return none;
        int dx = x - u->start_x, dy = y - u->start_y;
        *changed = true;
        if (dy <= -POD_BANNER_SWIPE_PX && iabs(dx) < -dy) { u->ban_on = false; return none; }
        if (u->ban_on && iabs(dx) <= POD_TAP_SLOP && iabs(dy) <= POD_TAP_SLOP && inside(&u->hit, x, y)) {
            if (u->hit.action == POD_A_BANNER_CLOSE) { u->ban_on = false; return none; }   // the x: end it, keep the unread entry, open nothing
            return banner_open(u, now_ms);
        }
        return none;
    }
    if (was && u->bar) {   // Console: a swipe down from the command bar opens the Inbox (and is not a crumb tap); on the Inbox, nothing
        int dx = x - u->start_x, dy = y - u->start_y;
        if (dy >= POD_BAR_SWIPE && iabs(dy) * 2 > iabs(dx) * 3) {
            *changed = true;
            return pod_nav_act(&u->nav, &u->model, POD_A_INBOX, 0, now_ms);
        }
    }
    const bool from_edge = u->edge;   // the contact began in the bottom zone (for card paging below, after the flag is cleared)
    if (was && u->edge) {   // Console: a swipe up from the bottom zone goes back one level (the sideways case falls through)
        int dx = x - u->start_x, dy = y - u->start_y;
        u->edge = false;
        const pod_frame_t *t = top(u);
        if (dy <= -POD_EDGE_SWIPE && iabs(dy) * 2 > iabs(dx) * 3 && t && t->view != POD_V_TALK) {
            *changed = true;
            return pod_nav_act(&u->nav, &u->model, POD_A_BACK, 1, now_ms);
        }
    }
    if (was && u->nav.skin == POD_SKIN_CONSOLE && top(u)->view == POD_V_TABS) {   // Console Overview: a swipe down, from anywhere, opens the Inbox
        int dx = x - u->start_x, dy = y - u->start_y;
        if (dy >= POD_BAR_SWIPE && iabs(dy) * 2 > iabs(dx) * 3) {
            *changed = true;
            return pod_nav_act(&u->nav, &u->model, POD_A_INBOX, 0, now_ms);
        }
    }
    if (was && !from_edge && card_page(u)) {   // Console Tab: a swipe up shows the next page of the tab's cards, a swipe down the previous one
        int dx = x - u->start_x, dy = y - u->start_y, last = cs_tab_pages(&u->nav, &u->model) - 1, at = top(u)->scroll;
        at = at < 0 ? 0 : at > last ? last : at;   // the page the view shows (the tab may have shrunk under the frame's scroll)
        if (iabs(dy) >= POD_SW_MIN_PX && iabs(dy) * 2 > iabs(dx) * 3) {
            int want = at + (dy < 0 ? 1 : -1);
            if (want >= 0 && want <= last) { pod_nav_act(&u->nav, &u->model, POD_A_SCROLL, want - top(u)->scroll, now_ms); *changed = true; }   // to the page itself
            return none;
        }
    }
    if (was && u->pg_mode == POD_PG_DRAG && pg_on(u)) {   // dragged, or caught while settling: settle onto a page
        pg_release(u, now_ms, false);
        *changed = true;
        return none;
    }
    if (was && u->sw_ok && !u->dragging) {
        int dx = x - u->start_x, dy = y - u->start_y;
        bool fast = (int32_t)(now_ms - u->down_ms) <= POD_SW_MS ||
                    ((int32_t)(now_ms - u->sw_last_ms) <= 100 && iabs(u->sw_vx) >= POD_SW_FLICK && (u->sw_vx < 0) == (dx < 0));
        if (iabs(dx) >= POD_SW_MIN_PX && wide(dx, dy) && fast) {
            u->sw_ok = u->sw_on = false;
            *changed = true;
            if (u->nav.skin == POD_SKIN_CONSOLE && top(u)->view == POD_V_TABS) {   // Overview: a page (two grid rows) a swipe
                int last = pod_tabs_pages_of(&u->nav, &u->model) - 1, want = pg_page(u) + (dx < 0 ? 1 : -1);
                if (want >= 0 && want <= last) pod_nav_act(&u->nav, &u->model, POD_A_SCROLL, want * 2 - top(u)->scroll, now_ms);   // to the page itself, whatever the frame's scroll holds
                return none;
            }
            if (u->nav.skin == POD_SKIN_CONSOLE && top(u)->view == POD_V_INBOX)   // the Inbox: either way goes back to where it was opened
                return pod_nav_act(&u->nav, &u->model, POD_A_BACK, 1, now_ms);
            return pod_nav_act(&u->nav, &u->model, dx < 0 ? POD_A_NEXT : POD_A_PREV, 0, now_ms);
        }
    }
    if (!was || u->dragging || !u->hit_valid || !inside(&u->hit, x, y)) return none;
    // The list can have changed since the scene was drawn: a hit that names its agent or tab is resolved now.
    int arg = u->hit.arg;
    if (u->hit.id[0] && u->hit.action == POD_A_OPEN_AGENT) {
        const pod_agent_t *l[POD_AGENTS_MAX];
        int cnt = pod_nav_list(&u->nav, &u->model, l, POD_AGENTS_MAX);
        arg = -1;
        for (int i = 0; i < cnt; i++) if (!strcmp(l[i]->id, u->hit.id)) { arg = i; break; }
    } else if (u->hit.id[0] && u->hit.action == POD_A_OPEN_NOTIF) {
        arg = -1;
        for (int i = 0; i < u->model.unread_count; i++) if (!strcmp(u->model.unread[i].agent, u->hit.id)) { arg = i; break; }
    } else if (u->hit.id[0] && u->hit.action == POD_A_FOLLOW) {
        arg = -1;
        for (int i = 0; i < u->model.agent_count; i++) if (!strcmp(u->model.agents[i].id, u->hit.id)) { arg = i; break; }
    } else if (u->hit.id[0] && u->hit.action == POD_A_OPEN_TAB) {
        arg = -1;
        for (int i = 0; i < u->model.tab_count; i++) if (!strcmp(u->model.tabs[i].id, u->hit.id)) { arg = i; break; }
    }
    if (arg == -1 && u->hit.id[0]) { *changed = true; return none; }   // what it named is gone: redraw, open nothing
    if (u->hit.action == POD_A_TALK && u->nav.depth) {   // an agent of an offline machine cannot be talked to: say why
        const pod_agent_t *ag = pod_model_find(&u->model, top(u)->agent);
        if (ag && ag->state == POD_OFFLINE) {
            pod_out_t o = none;   // the machine went away under an open recording: discard it, send nothing
            if (pod_ui_talking(u)) {
                o.fx = POD_FX_VOICE_ABORT;
                pod_copy_str(o.agent, sizeof o.agent, top(u)->agent);
                pod_ui_talk_over(u);
            }
            pod_ui_notice(u, "That machine is offline", now_ms);
            *changed = true;
            return o;
        }
    }
    pod_out_t out = pod_nav_act(&u->nav, &u->model, u->hit.action, arg, now_ms);
    *changed = true;
    if (u->hands_free && out.fx == POD_FX_VOICE_END) u->hands_free = u->hold_voice = false;   // sent
    return out;
}

pod_out_t pod_ui_touch_cancel(pod_ui_t *u)
{
    pod_out_t none;
    memset(&none, 0, sizeof none);
    if (u->down && !u->cancelled && u->pg_mode == POD_PG_DRAG && pg_on(u)) pg_release(u, u->pg_last_ms, true);
    if (u->scroll_begun) { ht_scroll_cancel(&u->scroll); u->scroll_begun = false; }
    u->down = false;
    u->cancelled = true;
    u->hit_valid = false;
    u->ban_touch = false;
    // The hold fired and a recording may be open: the finger is gone, so end it (and Talk).
    pod_out_t o = none;
    if (u->hands_free && pod_ui_talking(u)) {   // hands free: the recording does not depend on this contact
        u->hold_armed = u->hold_fired = u->bar = false;
        return none;
    }
    if (u->hold_voice && pod_ui_talking(u)) {
        o.fx = POD_FX_VOICE_ABORT;
        pod_copy_str(o.agent, sizeof o.agent, top(u)->agent);
        pod_nav_talk_over(&u->nav);
        u->dirty = true;
    }
    u->hold_armed = u->hold_fired = u->hold_voice = u->bar = u->hands_free = false;
    return o;
}

// Fires the hold for a deadline passed outside a touch sample (tests; the device reaches it through pod_ui_touch only).
pod_out_t pod_ui_tick(pod_ui_t *u, uint32_t now_ms)
{
    pod_out_t none;
    memset(&none, 0, sizeof none);
    if (!u->hold_armed || !u->down || u->cancelled || (int32_t)(now_ms - u->hold_due_ms) < 0) return none;
    return hold_fire(u, now_ms);
}

// ---- voice and clock ---------------------------------------------------------------------------------------

uint32_t pod_ui_banner_shown_ms(const pod_ui_t *u) { return u->ban_until - POD_BANNER_MS; }

bool pod_ui_talking(const pod_ui_t *u)
{
    const pod_frame_t *f = top(u);
    return f && f->view == POD_V_TALK;
}

void pod_ui_talk_over(pod_ui_t *u)
{
    pod_nav_talk_over(&u->nav);   // back on the screen TALK came from, same stack; no ABORT: nothing records
    u->hold_voice = u->hands_free = false;
}

void pod_ui_unsend(pod_ui_t *u, uint32_t now_ms)
{
    pod_nav_unsend(&u->nav);
    pod_ui_notice(u, "Not sent", now_ms);
}

bool pod_ui_pet_on_screen(const pod_ui_t *u)
{
    const pod_frame_t *f = top(u);
    if (!u->model.linked || !f) return false;
    if (u->nav.skin == POD_SKIN_CONSOLE) {   // Console draws the hero pet on Agent and Recap (nothing when the agent has left the roster), the listening pet on Talk and a pet per card on Overview and Tab
        if (f->view == POD_V_TALK) return true;
        if (f->view == POD_V_TABS || f->view == POD_V_TAB) return cs_cards_move(&u->nav, &u->model);
        return (f->view == POD_V_AGENT || f->view == POD_V_RECAP) && pod_model_find(&u->model, f->agent);
    }
    return f->view == POD_V_AGENT || f->view == POD_V_RECAP || f->view == POD_V_TALK;
}

// The clock's period while the screen animates on a fixed beat: 300 ms while the Classic Tabs grid shows a Playing ribbon; 150 ms
// while a listed agent works on Tab (Classic: the footer mark; Console: 66 ms while a row on screen works, its bars move; the equaliser is three rects, cheap to redraw); else a second (the elapsed clocks).
static uint32_t unit_ms(const pod_ui_t *u)
{
    if (u->pg_mode == POD_PG_ANIM && u->nav.skin != POD_SKIN_CONSOLE) return POD_PG_STEP_MS;   // Console's pages switch at once
    const pod_frame_t *f = top(u);
    if (u->model.linked && f && f->view == POD_V_TABS && u->nav.skin != POD_SKIN_CONSOLE && u->pg_mode == POD_PG_IDLE && pod_tabs_ribbon(&u->model, pg_page(u)))
        return POD_TABS_BAR_MS;   // the Playing ribbon's bars: three tiny rects
    if (u->model.linked && f && f->view == POD_V_TAB && u->nav.skin == POD_SKIN_CONSOLE) {   // a tab's (or Recent's) cards
        const pod_agent_t *l[CS_PER_PAGE];
        int n = cs_tab_page(&u->nav, &u->model, l);
        for (int i = 0; i < n; i++)
            if (pod_model_eff(&u->model, l[i]) == POD_WORKING) return POD_CS_ANIM_MS;
    } else if (u->model.linked && f && f->view == POD_V_TAB) {   // Classic: the footer's mark moves while a listed agent works
        const pod_agent_t *l[POD_AGENTS_MAX];
        int n = pod_nav_list(&u->nav, &u->model, l, POD_AGENTS_MAX);
        for (int i = 0; i < n; i++)
            if (pod_model_eff(&u->model, l[i]) == POD_WORKING) return 150;
    }
    return 1000;
}

// Whether the Console command bar draws its working mark: someone runs and the update screen does not own the glass.
static bool bar_mark(const pod_ui_t *u)
{
    if (u->nav.skin != POD_SKIN_CONSOLE || u->ota) return false;
    int running;
    cs_counts(&u->model, &running, NULL);
    return running > 0;
}

// Milliseconds to the next edge: the pet's own next step (the screen says which pet, scene and extra animation) while
// one is on screen, else the next beat of unit_ms.
static uint32_t edge_ms(const pod_ui_t *u, uint32_t now_ms)
{
    uint32_t edge;
    if (u->pg_mode != POD_PG_ANIM && pod_ui_pet_on_screen(u)) {
        edge = pod_view_next_ms(&u->nav, &u->model, now_ms);
        if (edge > 1000 - now_ms % 1000) edge = 1000 - now_ms % 1000;   // the elapsed clocks still tick on the second
    }
    else { uint32_t unit = unit_ms(u); edge = unit - now_ms % unit; }
    if (u->notice_on) {   // a notice clears on time, not at the pet's next step
        int32_t left = (int32_t)(u->notice_until - now_ms);
        if (left < 1) left = 1;
        if ((uint32_t)left < edge) edge = (uint32_t)left;
    }
    if (u->ban_on) {   // so does the banner
        int32_t left = (int32_t)(u->ban_until - now_ms);
        if (left < 1) left = 1;
        if ((uint32_t)left < edge) edge = (uint32_t)left;
        if (u->model.linked && !pod_ui_talking(u) && !u->ota) {   // the timer line shrinks (only while the banner is drawn): Console 33 ms, Classic 66
            uint32_t cap = u->nav.skin == POD_SKIN_CONSOLE ? 33 : 66;
            if (edge > cap) edge = cap;
        }
    }
    if (bar_mark(u)) {   // the bar's working mark: a new height every POD_CS_ANIM_MS on every Console screen, only while someone runs
        uint32_t beat = POD_CS_ANIM_MS - now_ms % POD_CS_ANIM_MS;
        if (edge > beat) edge = beat;
    }
    return edge;
}

uint32_t pod_ui_wake_ms(const pod_ui_t *u, uint32_t now_ms) { return edge_ms(u, now_ms); }

bool pod_ui_clock_tick(pod_ui_t *u, uint32_t now_ms)
{
    // clock_stamp is the time of the next edge. Due: redraw and set the next. A screen whose edge comes sooner than the
    // one waited for (a pet after a quiet screen) also redraws now.
    uint32_t next = now_ms + edge_ms(u, now_ms);
    bool due = (int32_t)(now_ms - u->clock_stamp) >= 0, sooner = (int32_t)(next - u->clock_stamp) < 0;
    if (due || sooner) u->clock_stamp = next;
    return due || sooner;
}

// ---- the library sweep -------------------------------------------------------------------------------------

bool pod_ui_sweeping(const pod_ui_t *u) { return u->sweep.active; }

bool pod_ui_sweep_due(const pod_ui_t *u, uint32_t now_ms)
{
    if (!u->model.linked) return false;
    if (u->sweep.active) return (int32_t)(now_ms - u->sweep.started_ms) > (int32_t)POD_SWEEP_MS;   // stalled: start over
    return u->sweep.restart || !u->sweep.ever || (int32_t)(now_ms - u->sweep.started_ms) >= (int32_t)POD_SWEEP_MS;
}

void pod_ui_sweep_begin(pod_ui_t *u, uint32_t now_ms)
{
    u->sweep.active = true;
    u->sweep.ever = true;
    u->sweep.restart = false;
    u->sweep.last_next = 0;
    u->sweep.started_ms = now_ms;
    pod_model_library_begin(&u->model);
}

void pod_ui_sweep_abort(pod_ui_t *u) { u->sweep.active = false; }

pod_out_t pod_ui_library_rows(pod_ui_t *u, const pod_library_row_t *rows, int count, uint32_t now_ms)
{
    for (int i = 0; i < count; i++)
        pod_model_library_row(&u->model, rows[i].id, rows[i].name, rows[i].engine, rows[i].machine, rows[i].status,
                              rows[i].age_s, now_ms);
    rebuild_tabs(u);   // new agents may be members of a tab
    return synced(u);
}

int pod_ui_library_page(pod_ui_t *u, const pod_library_row_t *rows, int count, int offset, int total,
                        uint32_t now_ms, pod_out_t *fx)
{
    pod_out_t o = pod_ui_library_rows(u, rows, count, now_ms);
    int next = offset + count;
    // The daemon clamps an offset past the last full page, so the page's own offset + count is where it ended.
    if (!u->sweep.active || count <= 0 || next >= total || next <= u->sweep.last_next) {
        if (u->sweep.active) {
            pod_model_library_end(&u->model);
            rebuild_tabs(u);
            pod_out_t e = synced(u);
            if (o.fx == POD_FX_NONE) o = e;
            u->sweep.active = false;
        }
        next = -1;
    } else {
        u->sweep.last_next = next;
    }
    if (fx) *fx = o;
    return next;
}

void pod_ui_notice(pod_ui_t *u, const char *text, uint32_t now_ms)
{
    pod_copy_str(u->notice, sizeof u->notice, text);
    u->notice_until = now_ms + 3000;
    u->notice_on = u->notice[0] != 0;
    u->notice_bad = false;
    u->dirty = true;
}

void pod_ui_notice_bad(pod_ui_t *u, const char *text, uint32_t now_ms)
{
    pod_ui_notice(u, text, now_ms);
    u->notice_bad = true;
}

void pod_ui_ota(pod_ui_t *u, const char *from, const char *to, int pct, bool restarting)
{
    if (pct < 0) {
        u->ota = false;
    } else {
        if (!u->ota) pod_ui_touch_cancel(u);   // a contact under way when it came up ends with it
        u->ota = true;
        pod_copy_str(u->ota_from, sizeof u->ota_from, from ? from : "");
        pod_copy_str(u->ota_to, sizeof u->ota_to, to ? to : "");
        u->ota_pct = pct > 100 ? 100 : pct;
        u->ota_restarting = restarting;
    }
    u->dirty = true;
}

bool pod_ui_updating(const pod_ui_t *u) { return u->ota; }

// ---- following the host ------------------------------------------------------------------------------------

static bool follow_now(pod_ui_t *u, const char *id, uint32_t now_ms)
{
    if (pod_ui_talking(u)) return true;   // recording: dropped, not kept
    // They are driving: a touch within the quiet window. On the Tabs screen itself there is nothing to disturb (the usual way
    // there is a tap on Tabs, then the hand goes to the desktop app), so only the daemon's echo of the device's own last
    // move (POD_FOLLOW_ECHO_MS) is ignored there; elsewhere the full window protects what the person is reading.
    uint32_t quiet = u->nav.depth <= 1 ? POD_FOLLOW_ECHO_MS : POD_FOLLOW_QUIET_MS;
    if (u->touched && (int32_t)(now_ms - u->last_touch_ms) < (int32_t)quiet) return true;
    if (u->down) return true;
    if (pod_nav_follow(&u->nav, &u->model, id, now_ms)) {
        u->pg_mode = POD_PG_IDLE;
        u->scroll_px = 0;
        u->dirty = true;
    }
    return true;
}

static void apply_pending_focus(pod_ui_t *u)
{
    if (!u->pending_focus[0]) return;
    uint32_t now_ms = u->model.clock_ms;
    if ((int32_t)(now_ms - u->pending_focus_ms) > (int32_t)POD_FOLLOW_PENDING_MS) { u->pending_focus[0] = 0; return; }
    if (!pod_model_find(&u->model, u->pending_focus)) return;
    char id[ID_MAX];
    memcpy(id, u->pending_focus, ID_MAX);
    u->pending_focus[0] = 0;
    follow_now(u, id, now_ms);
}

pod_out_t pod_ui_focus(pod_ui_t *u, const char *agent_id, uint32_t now_ms)
{
    pod_out_t none;
    memset(&none, 0, sizeof none);
    if (!agent_id || !*agent_id) return none;
    pod_model_clock(&u->model, now_ms);
    if (!pod_model_find(&u->model, agent_id)) {   // not in the roster yet: apply when it arrives
        set_id(u->pending_focus, agent_id);
        u->pending_focus_ms = now_ms;
        return none;
    }
    u->pending_focus[0] = 0;
    follow_now(u, agent_id, now_ms);
    return none;
}

// ---- notifications -----------------------------------------------------------------------------------------

bool pod_ui_notify(pod_ui_t *u, const char *agent_id, bool awake, uint32_t now_ms)
{
    pod_model_clock(&u->model, now_ms);
    const pod_agent_t *a = pod_model_find(&u->model, agent_id);
    if (!a) return false;
    const pod_frame_t *t = top(u);
    if (awake && t && (t->view == POD_V_AGENT || t->view == POD_V_RECAP) && !strcmp(t->agent, a->id)) return false;   // already looking
    char text[POD_UNREAD_TEXT];
    size_t pos = 0;
    text[0] = 0;
    for (int i = 0; i < a->recap_lines && pos + 1 < sizeof text; i++) {   // the recap's sentences, joined
        const char *l = a->recap + a->line_at[i];
        if (!*l) continue;
        int n = snprintf(text + pos, sizeof text - pos, "%s%s", pos ? " " : "", l);
        if (n < 0) break;
        pos += (size_t)n < sizeof text - pos ? (size_t)n : sizeof text - pos - 1;
    }
    pod_utf8_trim(text);
    pod_model_unread_add(&u->model, a->id, a->name, text, (int32_t)pod_agent_secs(a, now_ms), now_ms);
    if (!pod_ui_talking(u) && !u->ota) {   // no banner over the update
        pod_copy_str(u->ban_agent, sizeof u->ban_agent, a->id);
        u->ban_until = now_ms + POD_BANNER_MS;
        u->ban_on = true;
    }
    u->dirty = true;
    return true;
}

void pod_ui_notif_begin(pod_ui_t *u) { pod_model_unread_clear(&u->model); }

void pod_ui_notif_row(pod_ui_t *u, const char *agent_id, const char *name, const char *token, const char *summary, uint32_t now_ms)
{
    const pod_agent_t *a = pod_model_find(&u->model, agent_id);
    pod_model_unread_append(&u->model, agent_id, a && a->name[0] ? a->name : name, token, summary, now_ms);
}

void pod_ui_notif_end(pod_ui_t *u) { u->dirty = true; }

bool pod_ui_notif_seen(pod_ui_t *u, const char *agent_id, const char *token)
{
    bool gone = pod_model_unread_seen(&u->model, agent_id, token);
    if (gone) u->dirty = true;
    return gone;
}

int pod_ui_take_reads(pod_ui_t *u, pod_read_out_t out[], int max) { return pod_model_take_reads(&u->model, out, max); }
