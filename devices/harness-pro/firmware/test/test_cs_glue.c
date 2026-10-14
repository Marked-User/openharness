// Console gestures in the glue (pod_glue.c): hold to talk (hands free: a later tap sends), the bar's swipe down, tab swipes.
// Synthetic times; the hits come from a real render of the Console views.
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "app/pod_glue.h"
#include "pod/console/cs.h"

static int checks;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #c); abort(); } checks++; } while (0)

static pod_ui_t U;
static ht_scene_t S;
static int sc_events;
static bool sink(ht_scroll_phase_t p, int dy, int v, void *c) { (void)p; (void)dy; (void)v; (void)c; sc_events++; return true; }

static const pod_frame_t *top(void) { return &U.nav.stack[U.nav.depth - 1]; }
static void render(uint32_t t) { ht_scene_clear(&S, ht_rgb(0x08090A)); pod_ui_render(&U, &S, t); }
static pod_out_t act(pod_action_t a, int arg) { return pod_nav_act(&U.nav, &U.model, a, arg, 0); }
static const pod_hit_t *find(pod_action_t a) { for (int i = 0; i < U.frame.hit_count; i++) if (U.frame.hits[i].action == a) return &U.frame.hits[i]; return NULL; }
static pod_out_t t_(bool down, int x, int y, uint32_t t) { bool c; return pod_ui_touch(&U, down, x, y, t, &c); }

// Tab 0 "Build": a1 working, a2 idle, a3 done with a recap. Tab 1 "Docs": a4 asking.
static void fresh(pod_skin_t skin) {
    memset(&U, 0, sizeof U);
    pod_ui_init(&U);
    pod_model_reset(&U.model);
    pod_model_agent(&U.model, "a1", "Alpha", "claude", "mac");
    pod_model_agent(&U.model, "a2", "Beta", "codex", "mac");
    pod_model_agent(&U.model, "a3", "Gamma", "gemini", "box");
    pod_model_agent(&U.model, "a4", "Delta", "claude", "box");
    pod_model_agents_end(&U.model);
    static const char *x[] = {"a1", "a2", "a3"}, *y[] = {"a4"};
    const char *const *ids[2] = {x, y};
    uint8_t cnt[2] = {3, 1};
    cable_swarm_t it[2] = {{"s1", "Build", 3, 3}, {"s2", "Docs", 1, 1}};
    pod_model_swarms(&U.model, it, ids, cnt, 2, "s1", NULL, 0);
    pod_model_turn(&U.model, "a1", "started", NULL, 0, 10);
    pod_model_turn(&U.model, "a3", "started", NULL, 0, 19);
    pod_model_turn(&U.model, "a3", "done", NULL, 0, 20);
    pod_model_recap(&U.model, "a3", "It works. Tests pass. Shipped.", false);
    pod_model_question(&U.model, "a4", "Proceed?");
    U.model.linked = true;
    pod_ui_set_skin(&U, skin);
    pod_ui_scroll_sink(&U, sink, NULL, false);
    sc_events = 0;
}
static void to_tab(int tab) { act(POD_A_OPEN_TAB, tab); }
static void to_agent(int tab, int idx) { to_tab(tab); act(POD_A_OPEN_AGENT, idx); }
// Nobody works: a1 finishes its turn (a3 is done, a4 asks).
static void calm(void) { pod_model_turn(&U.model, "a1", "done", NULL, 0, 30); }

#define MID_X 360
#define MID_Y 400

// A new contact (DOWN then UP) at x,y: the hands-free send.
static pod_out_t tap_(int x, int y, uint32_t t) { t_(true, x, y, t); return t_(false, x, y, t + 50); }

static void hold_agent(pod_skin_t skin) {
    fresh(skin);
    to_agent(0, 0);   // a1, working: Agent
    CHECK(top()->view == POD_V_AGENT);
    render(1000);
    CHECK(t_(true, MID_X, MID_Y, 1000).fx == POD_FX_NONE);
    CHECK(pod_ui_tick(&U, 1399).fx == POD_FX_NONE);
    pod_out_t o = pod_ui_tick(&U, 1400);
    if (skin == POD_SKIN_CLASSIC) { CHECK(o.fx == POD_FX_NONE && top()->view == POD_V_AGENT); CHECK(t_(false, MID_X, MID_Y, 1500).fx == POD_FX_NONE); return; }
    CHECK(o.fx == POD_FX_VOICE_BEGIN && !strcmp(o.agent, "a1") && top()->view == POD_V_TALK);
    CHECK(pod_ui_tick(&U, 1500).fx == POD_FX_NONE);   // once
    // v2: the lift does nothing; the next new tap sends.
    CHECK(t_(false, MID_X, MID_Y, 1600).fx == POD_FX_NONE && top()->view == POD_V_TALK && !U.nav.sending && U.hands_free);
    render(1700);
    o = tap_(MID_X, MID_Y, 2000);
    CHECK(o.fx == POD_FX_VOICE_END && top()->view == POD_V_TALK && U.nav.sending && !U.hands_free);
}

// v1 hold_then_cancel (slide down 120 px aborts) became: a slide does nothing.
static void hold_slide_does_nothing(void) {
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    CHECK(pod_ui_tick(&U, 1400).fx == POD_FX_VOICE_BEGIN);
    CHECK(t_(true, MID_X, MID_Y + 119, 1450).fx == POD_FX_NONE && top()->view == POD_V_TALK);
    CHECK(t_(true, MID_X, MID_Y + 200, 1500).fx == POD_FX_NONE && top()->view == POD_V_TALK);
    CHECK(t_(false, MID_X, MID_Y + 200, 1700).fx == POD_FX_NONE && top()->view == POD_V_TALK && U.hands_free);
    // Held on a recap, moved up and down before the lift: never a scroll.
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 2);
    CHECK(top()->view == POD_V_RECAP);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    CHECK(pod_ui_tick(&U, 1400).fx == POD_FX_VOICE_BEGIN);
    t_(true, MID_X, MID_Y - 90, 1500);
    CHECK(sc_events == 0 && top()->scroll == 0);
    CHECK(t_(false, MID_X, MID_Y - 90, 1600).fx == POD_FX_NONE);   // the lift does nothing
    CHECK(sc_events == 0);
    render(1700);
    CHECK(tap_(MID_X, MID_Y, 2000).fx == POD_FX_VOICE_END);
}

static void drift_cancels(void) {
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    t_(true, MID_X, MID_Y + 30, 1200);
    CHECK(pod_ui_tick(&U, 1500).fx == POD_FX_NONE && top()->view == POD_V_AGENT);
    t_(true, MID_X, MID_Y + 60, 1550);
    t_(false, MID_X, MID_Y + 60, 1600);
    CHECK(sc_events > 0 && top()->view == POD_V_AGENT);   // the drag scrolls the host's pane, as on the round
    // Recap: the same contact scrolls the host's pane, and no recording starts.
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 2);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    t_(true, MID_X, MID_Y - 30, 1200);
    CHECK(pod_ui_tick(&U, 1500).fx == POD_FX_NONE);
    t_(true, MID_X, MID_Y - 60, 1550);
    t_(false, MID_X, MID_Y - 60, 1600);
    CHECK(sc_events > 0 && top()->view == POD_V_RECAP);   // the host's pane scrolls; the summary itself does not
    // A contact lifted before the deadline is a tap/no hold: a late tick does nothing.
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    t_(false, MID_X, MID_Y, 1100);
    CHECK(pod_ui_tick(&U, 1500).fx == POD_FX_NONE && top()->view == POD_V_AGENT);
}

static void bar_swipe(pod_skin_t skin) {
    fresh(skin);
    to_agent(0, 0);
    render(1000);
    const pod_hit_t *b = find(POD_A_BACK);
    int x = MID_X, y = 20;
    if (b) { x = b->x + b->w / 2; y = b->y + b->h / 2; }
    CHECK(y < POD_BAR_H);
    int depth = U.nav.depth;
    t_(true, x, y, 1000);
    t_(true, x, y + 50, 1050);
    pod_out_t o = t_(false, x, y + 90, 1100);
    (void)o;
    if (skin == POD_SKIN_CLASSIC) { CHECK(U.nav.depth == depth); return; }
    (void)depth;
    CHECK(U.nav.depth == depth + 1 && top()->view == POD_V_INBOX);   // the Inbox (notifications), and no crumb tap on top of it
    // 79 px is not enough; mostly sideways is not a swipe-down (a crumb tap would pop however far its arg says).
    act(POD_A_TABS, 0);
    to_agent(0, 0);
    render(1200);
    CHECK(U.nav.depth == 3);
    t_(true, 200, 20, 2000); t_(false, 200, 99, 2100);
    CHECK(U.nav.depth == 3);
    t_(true, 200, 20, 3000); t_(false, 330, 110, 3100);
    CHECK(U.nav.depth == 3);
    // On the root there is no home to go to: the swipe down is Overview's (it opens the Inbox, as from anywhere on the page).
    act(POD_A_TABS, 0);
    render(4000);
    t_(true, 200, 20, 4000); t_(false, 200, 120, 4100);
    CHECK(U.nav.depth == 2 && top()->view == POD_V_INBOX);
}

static void tab_gestures(pod_skin_t skin) {
    fresh(skin);
    to_tab(0);
    render(1000);
    t_(true, 500, MID_Y, 1000);
    t_(true, 400, MID_Y + 5, 1050);
    t_(false, 300, MID_Y + 5, 1100);
    if (skin == POD_SKIN_CLASSIC) { CHECK(top()->view == POD_V_TAB && top()->tab == 0); return; }
    CHECK(top()->view == POD_V_TAB && top()->tab == 1);
    t_(true, 200, MID_Y, 2000); t_(true, 300, MID_Y, 2050); t_(false, 400, MID_Y, 2100);
    CHECK(top()->tab == 0);
    // A long still press on a tile is no hold (the hold is the agent screens' own): no voice, and its lift opens the agent as a tap.
    render(3000);
    const pod_hit_t *tile = NULL;
    for (int i = 0; i < U.frame.hit_count; i++) if (U.frame.hits[i].action == POD_A_OPEN_AGENT && !strcmp(U.frame.hits[i].id, "a2")) tile = &U.frame.hits[i];
    CHECK(tile);
    int cx = tile->x + tile->w / 2, cy = tile->y + tile->h / 2;
    t_(true, cx, cy, 3000);
    CHECK(!U.hold_armed);
    CHECK(pod_ui_tick(&U, 3400).fx == POD_FX_NONE && top()->view == POD_V_TAB);
    for (uint32_t t = 3404; t <= 4500; t += 4) CHECK(t_(true, cx, cy, t).fx == POD_FX_NONE && top()->view == POD_V_TAB);
    pod_out_t o = t_(false, cx, cy, 4600);
    CHECK(o.fx == POD_FX_AGENT_OPEN && !strcmp(o.agent, "a2") && top()->view == POD_V_AGENT && !pod_ui_talking(&U) && !U.hands_free);
    // A tap on a tile still opens it.
    fresh(skin);
    to_tab(0);
    render(1000);
    for (int i = 0; i < U.frame.hit_count; i++) if (U.frame.hits[i].action == POD_A_OPEN_AGENT && !strcmp(U.frame.hits[i].id, "a2")) tile = &U.frame.hits[i];
    cx = tile->x + tile->w / 2; cy = tile->y + tile->h / 2;
    t_(true, cx, cy, 1000);
    CHECK(t_(false, cx, cy, 1100).fx == POD_FX_AGENT_OPEN && top()->view == POD_V_AGENT);
}

static void no_hold_views(void) {
    fresh(POD_SKIN_CONSOLE);
    render(1000);   // Overview
    t_(true, MID_X, MID_Y, 1000);
    CHECK(pod_ui_tick(&U, 1400).fx == POD_FX_NONE && top()->view == POD_V_TABS);
    t_(false, MID_X, MID_Y, 1500);
    act(POD_A_OPEN_TAB, POD_TAB_RECENT);
    render(2000);
    t_(true, MID_X, MID_Y, 2000);
    CHECK(pod_ui_tick(&U, 2400).fx == POD_FX_NONE && top()->view == POD_V_TAB);
    t_(false, MID_X, MID_Y, 2500);
    act(POD_A_BACK, 0);
    act(POD_A_INBOX, 0);
    CHECK(top()->view == POD_V_INBOX);
    render(3000);
    t_(true, MID_X, MID_Y, 3000);
    CHECK(pod_ui_tick(&U, 3400).fx == POD_FX_NONE && top()->view == POD_V_INBOX);
    t_(false, MID_X, MID_Y, 3500);
}

static void crumb_and_chip(void) {
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    const pod_hit_t *b = find(POD_A_BACK);
    CHECK(b);
    int x = b->x + b->w / 2, y = b->y + b->h / 2, depth = U.nav.depth;
    t_(true, x, y, 1000);
    CHECK(pod_ui_tick(&U, 1400).fx == POD_FX_NONE && top()->view == POD_V_AGENT);
    t_(false, x, y, 1500);
    CHECK(U.nav.depth < depth);   // the tap went through
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    const pod_hit_t *c = find(POD_A_ATTENTION);
    CHECK(c);
    x = c->x + c->w / 2; y = c->y + c->h / 2;
    t_(true, x, y, 1000);
    CHECK(pod_ui_tick(&U, 1400).fx == POD_FX_NONE && top()->view == POD_V_AGENT);
    pod_out_t o = t_(false, x, y, 1500);
    CHECK(o.fx == POD_FX_AGENT_OPEN && !strcmp(o.agent, "a4"));
}

static void offline(void) {
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    ((pod_agent_t *)pod_model_find(&U.model, "a1"))->state = POD_OFFLINE;
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    CHECK(pod_ui_tick(&U, 1400).fx == POD_FX_NONE);
    CHECK(U.notice_on && !strcmp(U.notice, "That machine is offline") && top()->view == POD_V_AGENT);
    CHECK(t_(false, MID_X, MID_Y, 1500).fx == POD_FX_NONE && top()->view == POD_V_AGENT);
    // A Tab tile holds nothing, offline or not: no notice.
    fresh(POD_SKIN_CONSOLE);
    to_tab(0);
    ((pod_agent_t *)pod_model_find(&U.model, "a2"))->state = POD_OFFLINE;
    render(1000);
    const pod_hit_t *tile = NULL;
    for (int i = 0; i < U.frame.hit_count; i++) if (U.frame.hits[i].action == POD_A_OPEN_AGENT && !strcmp(U.frame.hits[i].id, "a2")) tile = &U.frame.hits[i];
    CHECK(tile);
    t_(true, tile->x + tile->w / 2, tile->y + tile->h / 2, 1000);
    CHECK(pod_ui_tick(&U, 1400).fx == POD_FX_NONE && !U.notice_on && top()->view == POD_V_TAB);
}

static void skin_switch_mid_hold(void) {
    // Before the hold fires.
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    pod_ui_set_skin(&U, POD_SKIN_CLASSIC);
    CHECK(U.nav.depth == 1 && pod_ui_wake_ms(&U, 1100) <= 1000);
    CHECK(pod_ui_tick(&U, 1500).fx == POD_FX_NONE && U.nav.depth == 1);
    CHECK(t_(false, MID_X, MID_Y, 1600).fx == POD_FX_NONE && U.nav.depth == 1);
    // After it fired (the caller ended the voice): nothing is sent, nothing stays up.
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    CHECK(pod_ui_tick(&U, 1400).fx == POD_FX_VOICE_BEGIN);
    CHECK(pod_ui_set_skin(&U, POD_SKIN_CLASSIC).fx == POD_FX_VOICE_ABORT);   // hands free or not, a skin switch discards
    CHECK(!pod_ui_talking(&U) && U.nav.depth == 1 && !U.hands_free);
    CHECK(t_(true, MID_X, MID_Y + 200, 1500).fx == POD_FX_NONE);
    CHECK(t_(false, MID_X, MID_Y + 200, 1600).fx == POD_FX_NONE && !pod_ui_talking(&U));
    CHECK(pod_ui_tick(&U, 2500).fx == POD_FX_NONE);
    // And Console again: the next contact starts clean.
    pod_ui_set_skin(&U, POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(3000);
    t_(true, MID_X, MID_Y, 3000);
    CHECK(pod_ui_tick(&U, 3400).fx == POD_FX_VOICE_BEGIN);
}

static const pod_hit_t *tile_of(const char *id) {
    for (int i = 0; i < U.frame.hit_count; i++) if (U.frame.hits[i].action == POD_A_OPEN_AGENT && !strcmp(U.frame.hits[i].id, id)) return &U.frame.hits[i];
    return NULL;
}

// H1: the hold fires on the touch path. The touch task reports a still finger every few ms, and that sample is what
// finds the deadline passed: the begin and the end/abort then run on the one task, and no render wake is needed.
static void hold_fires_on_held_samples(void) {
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    CHECK(t_(true, MID_X, MID_Y, 1000).fx == POD_FX_NONE);
    for (uint32_t t = 1004; t < 1400; t += 4) CHECK(t_(true, MID_X, MID_Y, t).fx == POD_FX_NONE && top()->view == POD_V_AGENT);
    pod_out_t o = t_(true, MID_X, MID_Y, 1400);
    CHECK(o.fx == POD_FX_VOICE_BEGIN && !strcmp(o.agent, "a1") && top()->view == POD_V_TALK);
    CHECK(t_(true, MID_X, MID_Y, 1404).fx == POD_FX_NONE);   // once
    CHECK(t_(false, MID_X, MID_Y, 1500).fx == POD_FX_NONE);
    // A move inside the slop keeps it armed.
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    CHECK(t_(true, MID_X + 5, MID_Y, 1200).fx == POD_FX_NONE);
    o = t_(true, MID_X + 5, MID_Y, 1400);
    CHECK(o.fx == POD_FX_VOICE_BEGIN && !strcmp(o.agent, "a1") && top()->view == POD_V_TALK);
    // A Tab tile's still samples never begin voice: the hold is the agent screens' own.
    fresh(POD_SKIN_CONSOLE);
    to_tab(0);
    render(1000);
    const pod_hit_t *tile = tile_of("a2");
    CHECK(tile);
    int cx = tile->x + tile->w / 2, cy = tile->y + tile->h / 2;
    t_(true, cx, cy, 1000);
    for (uint32_t t = 1004; t <= 2000; t += 4) CHECK(t_(true, cx, cy, t).fx == POD_FX_NONE && top()->view == POD_V_TAB);
}

// H2 (v2): a contact cancelled after the hold fired (an untrusted sample, a second finger, the glass turning, sleep) no
// longer ends a hands-free recording: it does not depend on the finger.
static void hold_cancel_keeps_recording(void) {
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    CHECK(t_(true, MID_X, MID_Y, 1400).fx == POD_FX_VOICE_BEGIN);
    pod_out_t o = pod_ui_touch_cancel(&U);
    CHECK(o.fx == POD_FX_NONE && top()->view == POD_V_TALK && U.hands_free);
    CHECK(t_(false, MID_X, MID_Y, 1500).fx == POD_FX_NONE);
    render(1600);
    CHECK(tap_(MID_X, MID_Y, 1700).fx == POD_FX_VOICE_END);   // still sends with a new tap
    // A cancel before the hold fires, or after the lift, has nothing to abort.
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    CHECK(pod_ui_touch_cancel(&U).fx == POD_FX_NONE && top()->view == POD_V_AGENT);
    CHECK(t_(true, MID_X, MID_Y, 1400).fx == POD_FX_NONE);   // the cancelled contact never talks
    // A refused start (the glue already left Talk): the cancel has no recording to abort.
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    CHECK(t_(true, MID_X, MID_Y, 1400).fx == POD_FX_VOICE_BEGIN);
    pod_ui_talk_over(&U);
    CHECK(pod_ui_touch_cancel(&U).fx == POD_FX_NONE && top()->view == POD_V_AGENT);
}

// Hands free: any new tap on Talk sends, even over the bar crumb or the chip; the first lift does not; the holding
// contact's cancel, a slide, and a swipe from the bar do nothing; Classic is unchanged.
static void hands_free_taps_anywhere(void) {
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    CHECK(t_(true, MID_X, MID_Y, 1400).fx == POD_FX_VOICE_BEGIN);
    CHECK(t_(false, MID_X, MID_Y, 1500).fx == POD_FX_NONE);
    render(1600);
    CHECK(U.frame.hit_count > 1 && U.frame.hits[U.frame.hit_count - 1].action == POD_A_TALK);   // the topmost hit
    CHECK(U.frame.hits[U.frame.hit_count - 1].w == POD_W && U.frame.hits[U.frame.hit_count - 1].y == 0);
    // Over the bar's back crumb (y 20): a send, not a back.
    const pod_hit_t *b = find(POD_A_BACK);
    int bx = b ? b->x + b->w / 2 : 100;
    pod_out_t o = tap_(bx, 20, 2000);
    CHECK(o.fx == POD_FX_VOICE_END && !strcmp(o.agent, "a1") && top()->view == POD_V_TALK && U.nav.sending);
    // A swipe down from the bar does not go back while recording; a tap then sends.
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    t_(true, MID_X, MID_Y, 1400);
    t_(false, MID_X, MID_Y, 1500);
    render(1600);
    t_(true, 300, 20, 2000);
    t_(true, 300, 70, 2050);
    CHECK(t_(false, 300, 120, 2100).fx == POD_FX_NONE && top()->view == POD_V_TALK);
    // The orphan guard's sibling: Talk ended elsewhere, the flag is dropped on the next contact.
    pod_ui_talk_over(&U);
    CHECK(!U.hands_free);
    // Classic: a hold never arms, and its Talk is a tap (unchanged).
    fresh(POD_SKIN_CLASSIC);
    to_agent(0, 0);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    CHECK(pod_ui_tick(&U, 1500).fx == POD_FX_NONE && !U.hands_free);
}

// The send tap right after the hold fires, before Talk is drawn: the old Agent frame's back crumb must not apply.
static void send_before_talk_drawn(void) {
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    const pod_hit_t *b = find(POD_A_BACK);
    CHECK(b);
    int bx = b->x + b->w / 2, by = b->y + b->h / 2;
    t_(true, MID_X, MID_Y, 1000);
    CHECK(pod_ui_tick(&U, 1400).fx == POD_FX_VOICE_BEGIN);
    t_(false, MID_X, MID_Y, 1500);
    pod_out_t o = tap_(bx, by, 1600);   // no render in between
    CHECK(o.fx == POD_FX_VOICE_END && top()->view == POD_V_TALK && U.nav.sending);
}

// Hands free, then the agent's machine goes offline: the next tap discards the recording instead of leaving the mic open.
static void offline_tap_aborts(void) {
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    CHECK(pod_ui_tick(&U, 1400).fx == POD_FX_VOICE_BEGIN);
    t_(false, MID_X, MID_Y, 1500);
    render(1600);
    ((pod_agent_t *)pod_model_find(&U.model, "a1"))->state = POD_OFFLINE;
    pod_out_t o = tap_(MID_X, MID_Y, 2000);
    CHECK(o.fx == POD_FX_VOICE_ABORT && !strcmp(o.agent, "a1") && !pod_ui_talking(&U) && !U.hands_free && U.notice_on);
}

// The Console Tab with a working row wakes at 66 ms (the working mark moves); without one, a second.
static void working_bars_wake(void) {
    fresh(POD_SKIN_CONSOLE);
    to_tab(0);   // a1 works
    CHECK(pod_ui_wake_ms(&U, 330) == 66 && pod_ui_wake_ms(&U, 340) == 56);
    fresh(POD_SKIN_CONSOLE);
    to_tab(1);   // a4 only asks (a1 works elsewhere: the bar's mark still moves)
    CHECK(pod_ui_wake_ms(&U, 330) == 66);
    fresh(POD_SKIN_CONSOLE);
    calm();
    to_tab(1);
    CHECK(pod_ui_wake_ms(&U, 330) > 66);
}

// The Classic Tab and Recent footer's working mark moves only while a listed agent works: 150 ms then, a second otherwise.
static void classic_list_working_wake(void) {
    fresh(POD_SKIN_CLASSIC);
    to_tab(0);   // a1 works
    CHECK(pod_ui_wake_ms(&U, 330) <= 150);
    act(POD_A_BACK, 0);
    act(POD_A_OPEN_TAB, POD_TAB_RECENT);
    CHECK(pod_ui_wake_ms(&U, 330) <= 150);
    fresh(POD_SKIN_CLASSIC);
    to_tab(1);   // a4 only asks (a1 works in tab 0, not listed here)
    CHECK(pod_ui_wake_ms(&U, 330) > 150);
    fresh(POD_SKIN_CLASSIC);
    calm();
    to_tab(0);
    CHECK(pod_ui_wake_ms(&U, 330) > 150);
}

// v3 Task 4: the Console equaliser and spinner step at 66 ms and the voice wave at 100 ms; Classic keeps its 33 ms.
static void animation_rates(void) {
    uint32_t most = 0;
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);   // a1 works
    for (uint32_t t = 1000; t < 1400; t += 7) { uint32_t w = pod_ui_wake_ms(&U, t); CHECK(w <= 66); if (w > most) most = w; }
    CHECK(most > 33);   // not held to the old 33 ms frame
    fresh(POD_SKIN_CLASSIC);
    to_agent(0, 0);
    for (uint32_t t = 1000; t < 1400; t += 7) CHECK(pod_ui_wake_ms(&U, t) <= 33);
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    act(POD_A_TALK, 0);
    CHECK(top()->view == POD_V_TALK);
    for (uint32_t t = 1000; t < 1400; t += 7) CHECK(pod_ui_wake_ms(&U, t) <= 66);   // a1 works: the bar's mark needs 66 ms
    fresh(POD_SKIN_CONSOLE);
    calm();
    to_agent(0, 0);
    act(POD_A_TALK, 0);
    CHECK(top()->view == POD_V_TALK);
    most = 0;
    for (uint32_t t = 1000; t < 1400; t += 7) { uint32_t w = pod_ui_wake_ms(&U, t); CHECK(w <= 100); if (w > most) most = w; }
    CHECK(most == 100);   // the wave steps at 100 ms: neither the pet's 33 nor the 66 ms beat
}

// H3: Recent rows open an agent (OPEN_AGENT) like Tab tiles do, and like them they do not hold: a long still press is a tap.
static void recent_rows_do_not_hold(void) {
    fresh(POD_SKIN_CONSOLE);
    act(POD_A_OPEN_TAB, POD_TAB_RECENT);
    render(1000);
    const pod_hit_t *row = NULL;
    for (int i = 0; i < U.frame.hit_count; i++) if (U.frame.hits[i].action == POD_A_OPEN_AGENT) { row = &U.frame.hits[i]; break; }
    CHECK(row && row->y < 200);
    int x = row->x + row->w / 2, y = row->y + row->h / 2;
    t_(true, x, y, 1000);
    CHECK(!U.hold_armed);
    for (uint32_t t = 1004; t <= 2000; t += 4) CHECK(t_(true, x, y, t).fx == POD_FX_NONE && top()->view == POD_V_TAB && top()->tab == POD_TAB_RECENT);
    CHECK(pod_ui_tick(&U, 2000).fx == POD_FX_NONE && !U.notice_on);
    pod_out_t o = t_(false, x, y, 2100);   // still a tap
    CHECK(o.fx == POD_FX_AGENT_OPEN && top()->view != POD_V_TAB && !pod_ui_talking(&U));
}

// M9: voice on an asking agent stays refused, so the hold does not arm there (no notice either).
static void asking_agents_do_not_hold(void) {
    fresh(POD_SKIN_CONSOLE);
    to_agent(1, 0);   // a4, asking
    CHECK(top()->view == POD_V_AGENT && !strcmp(top()->agent, "a4"));
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    CHECK(!U.hold_armed);
    CHECK(t_(true, MID_X, MID_Y, 1400).fx == POD_FX_NONE && top()->view == POD_V_AGENT && !U.notice_on);
    t_(false, MID_X, MID_Y, 1500);
    fresh(POD_SKIN_CONSOLE);
    to_tab(1);
    render(1000);
    const pod_hit_t *tile = tile_of("a4");
    CHECK(tile);
    t_(true, tile->x + tile->w / 2, tile->y + tile->h / 2, 1000);
    CHECK(t_(true, tile->x + tile->w / 2, tile->y + tile->h / 2, 1400).fx == POD_FX_NONE && top()->view == POD_V_TAB && !U.notice_on);
}

// L10: the hold belongs to the screen and agent it was armed on; a contact on nothing carries no stale hit.
static void hold_stays_with_its_target(void) {
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    pod_nav_act(&U.nav, &U.model, POD_A_NEXT, 0, 1100);   // a pane swipe's effect, a notification or a host focus change the agent
    CHECK(strcmp(top()->agent, "a1") != 0);
    CHECK(t_(true, MID_X, MID_Y, 1400).fx == POD_FX_NONE && top()->view == POD_V_AGENT);
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    act(POD_A_BACK, 0);   // the screen changed under the finger
    CHECK(t_(true, MID_X, MID_Y, 1400).fx == POD_FX_NONE && top()->view == POD_V_TAB);
    // A DOWN that hits nothing on a Tab does not hold the previous contact's tile.
    fresh(POD_SKIN_CONSOLE);
    to_tab(0);
    render(1000);
    const pod_hit_t *tile = tile_of("a2");
    t_(true, tile->x + tile->w / 2, tile->y + tile->h / 2, 1000);
    t_(false, tile->x + tile->w / 2, tile->y + tile->h / 2, 1050);
    U.dirty = false;
    act(POD_A_BACK, 0);
    to_tab(0);
    render(2000);
    t_(true, 5, 713, 2000);   // the corner under every tile and hint
    CHECK(!U.hit_valid && U.hit.id[0] == 0 && !U.hold_armed);
    CHECK(t_(true, 5, 713, 2400).fx == POD_FX_NONE && top()->view == POD_V_TAB);
}

// L11: a refused start (the gate refused the recording) leaves the hold's agent screen where it was.
static void refused_hold_stays_on_the_agent(void) {
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    CHECK(t_(true, MID_X, MID_Y, 1400).fx == POD_FX_VOICE_BEGIN);
    pod_ui_talk_over(&U);
    CHECK(top()->view == POD_V_AGENT);
    fresh(POD_SKIN_CONSOLE);   // and on a Recap
    to_agent(0, 2);
    CHECK(top()->view == POD_V_RECAP);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    CHECK(t_(true, MID_X, MID_Y, 1400).fx == POD_FX_VOICE_BEGIN);
    pod_ui_talk_over(&U);
    CHECK(top()->view == POD_V_RECAP);
}

// ---- v3 gestures -------------------------------------------------------------------------------------------

// Six tabs: Overview has two pages.
static void fresh6(void) {
    fresh(POD_SKIN_CONSOLE);
    static const char *x[] = {"a1", "a2", "a3"};
    const char *const *ids[6] = {x, x, x, x, x, x};
    uint8_t cnt[6] = {3, 3, 3, 3, 3, 3};
    cable_swarm_t it[6] = {{"s1", "T1", 3, 3}, {"s2", "T2", 3, 3}, {"s3", "T3", 3, 3}, {"s4", "T4", 3, 3}, {"s5", "T5", 3, 3}, {"s6", "T6", 3, 3}};
    pod_model_swarms(&U.model, it, ids, cnt, 6, "s1", NULL, 0);
    pod_ui_set_skin(&U, POD_SKIN_CONSOLE);
}
static void swipe(int x0, int y0, int x1, int y1, uint32_t t) {
    t_(true, x0, y0, t);
    t_(true, (x0 + x1) / 2, (y0 + y1) / 2, t + 40);
    t_(false, x1, y1, t + 80);
}

// Console Inbox: a sideways swipe either way goes back; a vertical drag scrolls and stays; Classic is unchanged.
static void inbox_swipe_goes_back(void) {
    // a sideways swipe on the Inbox goes back to the screen it was opened from, either way
    for (int k = 0; k < 4; k++) {
        fresh(POD_SKIN_CONSOLE);
        if (k >= 2) to_agent(0, 0);
        act(POD_A_INBOX, 0);
        CHECK(top()->view == POD_V_INBOX && U.nav.depth == (k >= 2 ? 4 : 2));
        render(1000);
        if (k % 2 == 0) swipe(560, 300, 200, 310, 1000); else swipe(200, 300, 560, 310, 1000);
        if (k < 2) CHECK(U.nav.depth == 1 && top()->view == POD_V_TABS);
        else CHECK(U.nav.depth == 3 && top()->view == POD_V_AGENT);
    }
    // a swipe up from the bottom zone still goes back; a swipe down from the bar does nothing (the Inbox is already open)
    fresh(POD_SKIN_CONSOLE);
    act(POD_A_INBOX, 0);
    render(1000);
    int d0 = U.nav.depth;
    swipe(360, 710, 360, 450, 1000);
    CHECK(U.nav.depth == d0 - 1);
    fresh(POD_SKIN_CONSOLE);
    act(POD_A_INBOX, 0);
    render(1000);
    t_(true, 360, 20, 1000);
    t_(true, 360, 70, 1050);
    t_(false, 360, 110, 1100);
    CHECK(U.nav.depth == 2 && top()->view == POD_V_INBOX);
    fresh(POD_SKIN_CONSOLE);   // too short (59 px) and too steep: nothing
    act(POD_A_INBOX, 0);
    render(1000);
    int depth = U.nav.depth;
    swipe(400, 300, 341, 305, 1000);
    CHECK(U.nav.depth == depth);
    swipe(400, 300, 300, 420, 2000);
    CHECK(U.nav.depth == depth && top()->view == POD_V_INBOX);
    // a vertical drag scrolls the list and does not go back
    for (int i = 0; i < 8; i++) {
        char id[8], nm[8];
        snprintf(id, sizeof id, "u%d", i);
        snprintf(nm, sizeof nm, "n%d", i);
        pod_model_unread_add(&U.model, id, nm, "A finished turn with a message long enough to wrap over a few lines in the inbox list view.", 40, 900);
    }
    render(3000);
    int before = top()->scroll;
    swipe(360, 600, 360, 150, 3000);
    CHECK(U.nav.depth == depth && top()->view == POD_V_INBOX && top()->scroll > before);
    // Classic: the Inbox keeps its own behaviour (a sideways swipe, either way, neither goes back nor home)
    for (int k = 0; k < 2; k++) {
        fresh(POD_SKIN_CLASSIC);
        act(POD_A_INBOX, 0);
        render(1000);
        depth = U.nav.depth;
        if (k == 0) swipe(560, 300, 200, 310, 1000); else swipe(200, 300, 560, 310, 1000);
        CHECK(U.nav.depth == depth && depth > 1 && top()->view == POD_V_INBOX);
    }
}

// Console Recent is one of the tabs: a sideways swipe steps Recent -> tab 0 -> ... -> last -> Recent; a vertical drag scrolls; Classic unchanged.
static void recent_swipe_steps_tabs(void) {
    fresh(POD_SKIN_CONSOLE);
    act(POD_A_OPEN_TAB, POD_TAB_RECENT);
    render(1000);
    int depth = U.nav.depth;
    swipe(560, 300, 200, 310, 1000);   // left: forward, to tab 0
    CHECK(U.nav.depth == depth && top()->view == POD_V_TAB && top()->tab == 0);
    render(2000);
    swipe(200, 300, 560, 310, 2000);   // right from tab 0: back to Recent
    CHECK(U.nav.depth == depth && top()->view == POD_V_TAB && top()->tab == POD_TAB_RECENT);
    render(3000);
    swipe(200, 300, 560, 310, 3000);   // right from Recent wraps to the last tab
    CHECK(U.nav.depth == depth && top()->view == POD_V_TAB && top()->tab == U.model.tab_count - 1);
    render(4000);
    swipe(560, 300, 200, 310, 4000);   // left from the last tab wraps to Recent
    CHECK(U.nav.depth == depth && top()->tab == POD_TAB_RECENT);
    fresh(POD_SKIN_CONSOLE);
    to_tab(0);
    render(1000);
    depth = U.nav.depth;
    swipe(560, 300, 200, 310, 1000);
    CHECK(U.nav.depth == depth && top()->view == POD_V_TAB && top()->tab == 1);
    fresh(POD_SKIN_CONSOLE);
    act(POD_A_OPEN_TAB, POD_TAB_RECENT);
    render(1000);
    depth = U.nav.depth;
    swipe(360, 600, 360, 150, 1000);
    CHECK(U.nav.depth == depth && top()->view == POD_V_TAB && top()->tab == POD_TAB_RECENT);
    fresh(POD_SKIN_CLASSIC);
    act(POD_A_OPEN_TAB, POD_TAB_RECENT);
    render(1000);
    depth = U.nav.depth;
    swipe(560, 300, 200, 310, 1000);
    CHECK(U.nav.depth == depth);
}

static void overview_pages(void) {
    fresh6();
    render(1000);
    CHECK(top()->view == POD_V_TABS && U.nav.depth == 1 && pod_tabs_pages_of(&U.nav, &U.model) == 2 && top()->scroll == 0);
    swipe(600, 300, 200, 310, 1000);
    CHECK(top()->scroll / 2 == 1);
    CHECK(pod_ui_wake_ms(&U, 1200) > 16 && U.pg_mode == POD_PG_IDLE);
    render(1300);
    swipe(600, 300, 200, 310, 2000);   // past the last page: stays
    CHECK(top()->scroll / 2 == 1);
    render(2300);
    swipe(200, 300, 600, 310, 3000);
    CHECK(top()->scroll / 2 == 0);
    swipe(200, 300, 600, 310, 4000);   // before the first page: stays
    CHECK(top()->scroll / 2 == 0);
    // A vertical drag of 200 px leaves the page alone, and nothing animates.
    swipe(360, 250, 360, 310, 5000);   // 60 px: under the Inbox swipe's 80
    swipe(360, 450, 360, 250, 6000);   // up: nothing
    CHECK(top()->scroll == 0 && U.pg_mode == POD_PG_IDLE && pod_ui_wake_ms(&U, 7000) > 16 && sc_events == 0);
    // Classic keeps its vertical paging.
    fresh6();
    pod_ui_set_skin(&U, POD_SKIN_CLASSIC);
    swipe(600, 300, 200, 310, 1000);
    CHECK(top()->scroll == 0);
}

static void bottom_up_goes_back(void) {
    for (int k = 0; k < 5; k++) {
        fresh(POD_SKIN_CONSOLE);
        if (k == 0) to_agent(0, 0);
        else if (k == 1) to_agent(0, 2);   // Recap
        else if (k == 2) to_tab(0);
        else if (k == 3) act(POD_A_OPEN_TAB, POD_TAB_RECENT);
        else act(POD_A_INBOX, 0);
        static const pod_view_t want[] = {POD_V_AGENT, POD_V_RECAP, POD_V_TAB, POD_V_TAB, POD_V_INBOX};
        CHECK(top()->view == want[k]);
        render(1000);
        int depth = U.nav.depth, y0 = k >= 2 ? POD_LIST_BOTTOM_Y + 10 : 690;   // Tab, Recent and the Inbox: below their content
        t_(true, 360, y0, 1000);
        t_(true, 360, y0 - 50, 1040);
        CHECK(U.nav.depth == depth);   // nothing until the lift
        t_(false, 360, y0 - 120, 1080);
        CHECK(U.nav.depth == depth - 1);
        if (k == 1) CHECK(sc_events == 0);
    }
    // 79 px is not enough; the same swipe in Classic does nothing.
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    swipe(360, 690, 360, 611, 1000);
    CHECK(U.nav.depth == 3);
    fresh(POD_SKIN_CLASSIC);
    to_agent(0, 0);
    render(1000);
    swipe(360, 690, 360, 500, 1000);
    CHECK(U.nav.depth == 3);
    // Talk: no back (the swipe does not leave the recording); the root: nothing.
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    CHECK(t_(true, MID_X, MID_Y, 1400).fx == POD_FX_VOICE_BEGIN);
    t_(false, MID_X, MID_Y, 1500);
    render(1600);
    int d = U.nav.depth;
    swipe(360, 690, 360, 500, 2000);
    CHECK(U.nav.depth == d && top()->view == POD_V_TALK);
    fresh(POD_SKIN_CONSOLE);
    render(1000);
    swipe(360, 690, 360, 500, 1000);
    CHECK(U.nav.depth == 1);
}

static void bottom_start_sideways_is_a_pane_swipe(void) {
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    t_(true, 300, 690, 1000);
    t_(true, 380, 680, 1040);
    t_(false, 450, 660, 1080);   // dx 150, dy -30
    CHECK(U.nav.depth == 3 && (top()->view == POD_V_AGENT || top()->view == POD_V_RECAP) && strcmp(top()->agent, "a1") != 0);   // NEXT pane, not BACK
    // A hold that starts in the bottom zone still talks, and its lift is not a back.
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    t_(true, 360, 690, 1000);
    CHECK(pod_ui_tick(&U, 1400).fx == POD_FX_VOICE_BEGIN && top()->view == POD_V_TALK);
    t_(false, 360, 690, 1500);
    CHECK(top()->view == POD_V_TALK && U.nav.depth == 3);
}

static void bar_down_opens_inbox(void) {
    // from an agent (and a tab, and Recent) a swipe down from the bar opens the Inbox on top; on the Inbox it does nothing
    for (int k = 0; k < 4; k++) {
        fresh(POD_SKIN_CONSOLE);
        if (k == 0) to_agent(0, 0); else if (k == 1) to_tab(0); else if (k == 2) act(POD_A_OPEN_TAB, POD_TAB_RECENT); else act(POD_A_INBOX, 0);
        render(1000);
        int depth = U.nav.depth;
        CHECK(depth >= 2);
        t_(true, 360, 20, 1000);
        t_(true, 360, 70, 1040);
        t_(false, 360, 140, 1080);
        CHECK(top()->view == POD_V_INBOX && U.nav.depth == (k == 3 ? depth : depth + 1));
    }
}

static void toast_and_edges(void) {
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    CHECK(pod_ui_notify(&U, "a3", true, 1000));
    render(1000);
    const pod_hit_t *ban = find(POD_A_BANNER);
    CHECK(ban && ban->y > POD_BAR_H);
    int bx = ban->x + ban->w / 2, by = ban->y + ban->h / 2;
    swipe(bx, by, bx, by - 100, 1100);
    CHECK(!U.ban_on && U.nav.depth == 3);
    // The toast's timer line shrinks evenly: the glue wakes within 33 ms while it shows.
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    CHECK(pod_ui_notify(&U, "a3", true, 1000));
    render(1000);
    CHECK(U.ban_on && pod_ui_wake_ms(&U, 1000) <= 33);
    // A bar swipe down while a toast is up still opens the Inbox.
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    CHECK(pod_ui_notify(&U, "a3", true, 1000));
    render(1000);
    CHECK(U.ban_on);
    t_(true, 360, 20, 1100); t_(true, 360, 70, 1140); t_(false, 360, 140, 1180);
    CHECK(U.nav.depth == 4 && top()->view == POD_V_INBOX);
}


// ---- v3b -----------------------------------------------------------------------------------------------------

// A: on Overview a swipe down (>= 80 px, |dy| > 1.5 |dx|) opens the Inbox, wherever it starts.
static void overview_down_opens_inbox(void) {
    static const int start[][2] = {{360, 300}, {200, 100}, {600, 500}, {100, 560}};   // a card, the top, the right, the bottom zone
    for (unsigned k = 0; k < sizeof start / sizeof start[0]; k++) {
        fresh(POD_SKIN_CONSOLE);
        render(1000);
        CHECK(U.nav.depth == 1 && top()->view == POD_V_TABS);
        swipe(start[k][0], start[k][1], start[k][0], start[k][1] + 100, 1000);
        CHECK(U.nav.depth == 2 && top()->view == POD_V_INBOX);
    }
    // too short, too slanted, upward: nothing; and a tap on a card still opens the tab
    fresh(POD_SKIN_CONSOLE);
    render(1000);
    swipe(360, 300, 360, 379, 1000);
    CHECK(U.nav.depth == 1);
    swipe(300, 300, 400, 430, 2000);   // dy 130 but dx 100: 130 < 1.5 * 100
    CHECK(U.nav.depth == 1);
    swipe(360, 430, 360, 300, 2000);
    CHECK(top()->view == POD_V_TABS);
    // the paging swipe still pages (six tabs)
    fresh6();
    render(1000);
    swipe(600, 300, 200, 310, 1000);
    CHECK(top()->view == POD_V_TABS && top()->scroll / 2 == 1);
    // Classic: no
    fresh(POD_SKIN_CLASSIC);
    render(1000);
    swipe(360, 300, 360, 420, 1000);
    CHECK(top()->view == POD_V_TABS);
    // not from the Inbox's own scroll, a Tab or an agent screen
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    swipe(360, 300, 360, 420, 1000);
    CHECK(top()->view == POD_V_AGENT);
}

// M2: Overview paging is absolute and the scroll follows a shrinking tab list.
static void fresh8(void) {
    fresh(POD_SKIN_CONSOLE);
    static const char *x[] = {"a1", "a2", "a3"};
    const char *const *ids[8] = {x, x, x, x, x, x, x, x};
    uint8_t cnt[8] = {3, 3, 3, 3, 3, 3, 3, 3};
    cable_swarm_t it[8] = {{"s1", "T1", 3, 3}, {"s2", "T2", 3, 3}, {"s3", "T3", 3, 3}, {"s4", "T4", 3, 3}, {"s5", "T5", 3, 3}, {"s6", "T6", 3, 3}, {"s7", "T7", 3, 3}, {"s8", "T8", 3, 3}};
    pod_model_swarms(&U.model, it, ids, cnt, 8, "s1", NULL, 0);
}
static void shrink_tabs_to(int n) {
    static const char *x[] = {"a1", "a2", "a3"};
    const char *const *ids[8] = {x, x, x, x, x, x, x, x};
    uint8_t cnt[8] = {3, 3, 3, 3, 3, 3, 3, 3};
    cable_swarm_t it[8] = {{"s1", "T1", 3, 3}, {"s2", "T2", 3, 3}, {"s3", "T3", 3, 3}, {"s4", "T4", 3, 3}, {"s5", "T5", 3, 3}, {"s6", "T6", 3, 3}, {"s7", "T7", 3, 3}, {"s8", "T8", 3, 3}};
    pod_model_swarms(&U.model, it, ids, cnt, n, "s1", NULL, 0);
}
static void overview_scroll_follows_tab_removal(void) {
    // the glue alone: the frame keeps scroll 4 (page 3 of 3) while the list shrinks to 2 pages; a right swipe lands on page 1
    fresh8();
    render(1000);
    CHECK(pod_tabs_pages_of(&U.nav, &U.model) == 3);
    act(POD_A_SCROLL, 4);
    CHECK(top()->scroll == 4);
    shrink_tabs_to(6);
    CHECK(pod_tabs_pages_of(&U.nav, &U.model) == 2);
    render(2000);
    swipe(200, 300, 600, 310, 2000);
    CHECK(top()->scroll == 0);
    // and with the nav synced (the cable's path), the scroll is clamped to the last page at once
    fresh8();
    render(1000);
    act(POD_A_SCROLL, 4);
    shrink_tabs_to(6);
    pod_nav_sync(&U.nav, &U.model);
    CHECK(top()->scroll == 2);
    render(2000);
    swipe(200, 300, 600, 310, 2000);
    CHECK(top()->scroll == 0);
    // down to one page: scroll 0
    fresh8();
    act(POD_A_SCROLL, 4);
    shrink_tabs_to(2);
    pod_nav_sync(&U.nav, &U.model);
    CHECK(top()->scroll == 0);
    // still pages normally
    fresh8();
    render(1000);
    swipe(600, 300, 200, 310, 1000);
    CHECK(top()->scroll == 2);
    swipe(600, 300, 200, 310, 2000);
    CHECK(top()->scroll == 4);
    swipe(600, 300, 200, 310, 3000);
    CHECK(top()->scroll == 4);
}

// L3: the hold does not arm on the bell, nor on anything in the bar.
static void hold_not_in_bar(void) {
    fresh(POD_SKIN_CONSOLE);
    pod_model_unread_add(&U.model, "a3", "Gamma", "Shipped.", 5, 500);
    to_agent(0, 0);
    render(1000);
    const pod_hit_t *bell = find(POD_A_INBOX);
    CHECK(bell && bell->y == 0);
    t_(true, bell->x + bell->w / 2, bell->y + bell->h / 2, 1000);
    CHECK(!U.hold_armed);
    CHECK(pod_ui_tick(&U, 1400).fx == POD_FX_NONE && top()->view == POD_V_AGENT);
    pod_out_t o = t_(false, bell->x + bell->w / 2, bell->y + bell->h / 2, 1500);
    (void)o;
    CHECK(top()->view == POD_V_INBOX);   // the tap opens the Inbox
    // a DOWN anywhere in the bar (no hit there) does not arm either
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    render(1000);
    t_(true, 330, 10, 1000);
    CHECK(!U.hold_armed);
    t_(false, 330, 10, 1100);
    // and the body still arms
    t_(true, MID_X, MID_Y, 2000);
    CHECK(U.hold_armed);
    t_(false, MID_X, MID_Y, 2100);
}

// L4: no bar swipe on Talk.
static void talk_ignores_bar_swipe(void) {
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    act(POD_A_TALK, 0);
    render(1000);
    CHECK(top()->view == POD_V_TALK);
    int depth = U.nav.depth;
    t_(true, 330, 20, 1000); t_(true, 330, 70, 1040); t_(false, 330, 140, 1080);
    CHECK(U.nav.depth == depth && top()->view == POD_V_TALK);
}

// L5: the toast's 33 ms cap only while the toast is drawn.
static void toast_cap_only_when_drawn(void) {
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    CHECK(pod_ui_notify(&U, "a3", true, 1000));
    render(1000);
    CHECK(U.ban_on && pod_ui_wake_ms(&U, 1000) <= 33);   // drawn
    act(POD_A_TALK, 0);   // recording: no toast
    render(1010);
    CHECK(U.ban_on && pod_ui_talking(&U) && pod_ui_wake_ms(&U, 1010) > 33);
    fresh(POD_SKIN_CONSOLE);
    to_agent(0, 0);
    CHECK(pod_ui_notify(&U, "a3", true, 1000));
    render(1000);
    U.model.linked = false;   // cable down: no toast
    CHECK(pod_ui_wake_ms(&U, 1010) > 33);
}

// B and L6: the bar's working mark wakes every screen at 66 ms while anyone works, and only then; Overview does not
// poll at the Classic ribbon's 300 ms.
static uint32_t wakes_in(uint32_t from, uint32_t span, uint32_t *min_gap) {
    uint32_t n = 0, t = from;
    *min_gap = 99999;
    while (t < from + span) { render(t); uint32_t w = pod_ui_wake_ms(&U, t); if (w < *min_gap) *min_gap = w; t += w; n++; }
    return n;
}
static void wake_rates(void) {
    uint32_t mn;
    for (int k = 0; k < 5; k++) {   // a1 works: every screen moves its bar mark
        fresh(POD_SKIN_CONSOLE);
        if (k == 1) to_tab(1);
        else if (k == 2) act(POD_A_OPEN_TAB, POD_TAB_RECENT);
        else if (k == 3) act(POD_A_INBOX, 0);
        else if (k == 4) { to_agent(1, 0); }   // a4 asks (its pet is a still ask scene)
        render(1000);
        for (uint32_t t = 1000; t < 1400; t += 13) CHECK(pod_ui_wake_ms(&U, t) <= 66);
        uint32_t n = wakes_in(2000, 10000, &mn);
        CHECK(n >= 10000 / 66 && n <= 10000 / 66 + 40);
    }
    {   // nobody works but Delta asks: Overview's Docs card plays the ask pet, at its own steps and never faster than 66 ms
        fresh(POD_SKIN_CONSOLE);
        calm();
        render(1000);
        CHECK(pod_ui_pet_on_screen(&U));
        uint32_t n = wakes_in(2000, 10000, &mn);
        CHECK(n > 10 && n <= 10000 / 66 + 1 && mn >= 1);
    }
    for (int k = 0; k < 4; k++) {   // nobody works or asks: Overview's and a Tab's cards still play their pets' rest scenes (never
                                    // faster than 66 ms); Recent and the Inbox, with no pet, wake once a second
        fresh(POD_SKIN_CONSOLE);
        calm();
        pod_model_question_close(&U.model, "a4");
        pod_model_turn(&U.model, "a4", "done", NULL, 0, 30);
        if (k == 1) to_tab(1);
        else if (k == 2) act(POD_A_OPEN_TAB, POD_TAB_RECENT);
        else if (k == 3) act(POD_A_INBOX, 0);
        render(1000);
        uint32_t n = wakes_in(2000, 10000, &mn);
        if (k < 2) CHECK(pod_ui_pet_on_screen(&U) && n > 10 && n <= 10000 / 66 + 1);
        else CHECK(n == 10 && mn == 1000);
    }
    // an Overview with a Playing ribbon in Classic still polls at 300 ms; Console does not (its bar mark is the only motion)
    fresh(POD_SKIN_CLASSIC);
    render(1000);
    CHECK(pod_ui_wake_ms(&U, 1000) <= 300);
}

// M1: a Console agent screen wakes for what it draws. The hero pet is drawn, so it steps at the pet's own rate; with no agent
// (nothing is drawn) or a pet-less engine it is once a second.
static void agent_screen_wakes(void) {
    uint32_t mn;
    fresh(POD_SKIN_CONSOLE);
    calm();
    to_agent(0, 2);   // a3: gemini, done, with a recap
    CHECK(top()->view == POD_V_RECAP);
    render(1000);
    uint32_t n = wakes_in(2000, 10000, &mn);
    uint32_t pet_step = pod_pet_next_step_ms("gemini", POD_SCENE_REST, 2000, 0);
    CHECK(pet_step >= 1000 ? n == 10 : n <= 10000 / 33);
    // a claude recap: bounded by its pet's step (never the 33 ms frame, no more than the pet changes)
    fresh(POD_SKIN_CONSOLE);
    calm();
    pod_model_recap(&U.model, "a1", "Done.", false);
    to_agent(0, 0);
    CHECK(top()->view == POD_V_RECAP);
    render(1000);
    n = wakes_in(2000, 10000, &mn);
    uint32_t changes = 0;
    for (uint32_t t = 2000; t < 12000;) { uint32_t w = pod_pet_next_step_ms("claude", POD_SCENE_REST, t, 0); changes++; t += w; }
    CHECK(n <= changes + 10 && n < 10000 / 33);
    // the agent leaves the roster under an open screen: nothing is drawn, so a second
    fresh(POD_SKIN_CONSOLE);
    calm();
    to_agent(0, 2);
    pod_model_agents_begin(&U.model);
    pod_model_agent(&U.model, "a1", "Alpha", "claude", "mac");
    pod_model_agent(&U.model, "a2", "Beta", "codex", "mac");
    pod_model_agent(&U.model, "a4", "Delta", "claude", "box");
    pod_model_agents_end(&U.model);
    CHECK(!pod_model_find(&U.model, "a3"));
    render(1000);
    n = wakes_in(2000, 10000, &mn);
    CHECK(n == 10 && mn == 1000);
}

// Console Tab cards: a tab of six agents is two pages of four. A swipe up (>= 60 px, |dy| > 1.5 |dx|) shows the next page, a swipe
// down the previous one, clamped; a short or slanted drag and a tap do not page; sideways still steps tabs; Recent's rows still scroll.
static void N_scroll(int v) { U.nav.stack[U.nav.depth - 1].scroll = (int16_t)v; }
static void tab_cards_page(void) {
    fresh(POD_SKIN_CONSOLE);
    pod_model_agents_begin(&U.model);
    static const char *const ids[] = {"a1", "a2", "a3", "a4", "a5", "a6"};
    for (int i = 0; i < 6; i++) pod_model_agent(&U.model, ids[i], ids[i], "claude", "mac");
    pod_model_agents_end(&U.model);
    const char *const *l[2] = {ids, ids};
    uint8_t cnt[2] = {6, 1};
    cable_swarm_t it[2] = {{"s1", "Build", 6, 6}, {"s2", "Docs", 1, 1}};
    pod_model_swarms(&U.model, it, l, cnt, 2, "s1", NULL, 0);
    to_tab(0);
    render(1000);
    CHECK(top()->view == POD_V_TAB && top()->scroll == 0 && cs_tab_pages(&U.nav, &U.model) == 2);
    swipe(360, 500, 360, 300, 1000);   // up: the next page
    CHECK(top()->view == POD_V_TAB && top()->scroll == 1);
    render(1200);
    swipe(360, 300, 360, 520, 1300);   // down: the previous page
    CHECK(top()->scroll == 0);
    swipe(360, 300, 360, 520, 1400);   // down on the first page: stays
    CHECK(top()->scroll == 0);
    swipe(360, 500, 360, 300, 1500);
    swipe(360, 500, 360, 300, 1700);   // up on the last page: stays on it
    CHECK(top()->scroll == 1 && top()->view == POD_V_TAB);
    swipe(360, 500, 360, 445, 1900);   // 55 px: not a swipe
    CHECK(top()->scroll == 1);
    swipe(300, 500, 420, 400, 2100);   // slanted (|dy| < 1.5 |dx|): not a page, not a tab step either
    CHECK(top()->scroll == 1 && top()->view == POD_V_TAB);
    render(2300);
    const pod_hit_t *c = find(POD_A_OPEN_AGENT);   // a tap on page 2's first card opens a5
    CHECK(c && !strcmp(c->id, "a5"));
    CHECK(tap_(c->x + c->w / 2, c->y + c->h / 2, 2400).fx == POD_FX_AGENT_OPEN && !strcmp(top()->agent, "a5"));
    // sideways steps tabs, as before
    act(POD_A_BACK, 0);
    render(2600);
    int tab = top()->tab;
    swipe(560, 300, 200, 310, 2700);
    CHECK(top()->view == POD_V_TAB && top()->tab != tab);
    // the bottom card row reaches into the old bottom zone: a swipe up from it (y 650) pages, it does not go back
    act(POD_A_TABS, 0);
    act(POD_A_OPEN_TAB, 0);
    CHECK(top()->view == POD_V_TAB && top()->tab == 0);
    N_scroll(0);
    render(3000);
    int depth = U.nav.depth;
    swipe(360, 650, 360, 450, 3000);
    CHECK(U.nav.depth == depth && top()->scroll == 1);
    swipe(360, 650, 360, 712, 3200);   // a swipe down from there (62 px) pages back
    CHECK(U.nav.depth == depth && top()->scroll == 0);
    // below the cards (y >= 692) a swipe up still goes back
    swipe(360, 710, 360, 450, 3400);
    CHECK(U.nav.depth == depth - 1);
    // a scroll left past the last page (the tab shrank) pages back from the page it shows
    act(POD_A_OPEN_TAB, 0);
    N_scroll(5);
    render(3600);
    swipe(360, 300, 360, 520, 3600);
    CHECK(top()->scroll == 0);
    // Recent keeps its row scroll, and its sixth row (y 596..700) starts a scroll rather than going back
    fresh(POD_SKIN_CONSOLE);
    pod_model_agents_begin(&U.model);
    static const char *const r8[] = {"r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"};
    for (int i = 0; i < 8; i++) pod_model_agent(&U.model, r8[i], r8[i], "claude", "mac");
    pod_model_agents_end(&U.model);
    for (int i = 0; i < 8; i++) pod_model_turn(&U.model, r8[i], "activity", "Editing", 10, 900u + (uint32_t)i);
    act(POD_A_OPEN_TAB, POD_TAB_RECENT);
    render(1000);
    CHECK(top()->tab == POD_TAB_RECENT && top()->scroll == 0 && pod_scroll_max(&U.nav, &U.model) == 2);
    depth = U.nav.depth;
    t_(true, 360, 660, 1000); t_(true, 360, 560, 1050); t_(true, 360, 450, 1100); t_(false, 360, 450, 1150);
    CHECK(U.nav.depth == depth && top()->scroll > 0);
}

// ---- Classic index (Task 4) ----------------------------------------------------------------------------------

// The Classic Talk view will register one full-screen TALK hit while listening; until it does, the tests add it.
static void add_hit_front(int x, int y, int w, int h, pod_action_t a) {   // first in the list: the worst order for priority
    CHECK(U.frame.hit_count < sizeof U.frame.hits / sizeof U.frame.hits[0]);
    memmove(&U.frame.hits[1], &U.frame.hits[0], U.frame.hit_count * sizeof U.frame.hits[0]);
    memset(&U.frame.hits[0], 0, sizeof U.frame.hits[0]);
    U.frame.hits[0].x = (int16_t)x; U.frame.hits[0].y = (int16_t)y; U.frame.hits[0].w = (int16_t)w; U.frame.hits[0].h = (int16_t)h;
    U.frame.hits[0].action = a;
    U.frame.hit_count++;
}
static void classic_listen(void) {   // Classic, a1 open and recording; the frame carries the full-screen send hit
    fresh(POD_SKIN_CLASSIC);
    to_agent(0, 0);
    render(1000);
    const pod_hit_t *talk = find(POD_A_TALK);
    CHECK(talk);
    CHECK(tap_(talk->x + talk->w / 2, talk->y + talk->h / 2, 1000).fx == POD_FX_VOICE_BEGIN && top()->view == POD_V_TALK);
    render(1200);
    U.frame.hit_count = 0;   // the Talk view registers this one hit alone while listening
    add_hit_front(0, 88, 720, 632, POD_A_TALK);
}

static void test_classic_listen_tap_anywhere_sends(void) {
    classic_listen();
    pod_out_t o = tap_(360, 400, 2000);
    CHECK(o.fx == POD_FX_VOICE_END && !strcmp(o.agent, "a1") && U.nav.sending);
    classic_listen();   // a tap in a corner of the area too, and a drag out is not a tap
    CHECK(t_(true, 20, 700, 2000).fx == POD_FX_NONE);
    CHECK(t_(false, 20, 700, 2050).fx == POD_FX_VOICE_END);
    classic_listen();
    t_(true, 360, 300, 2000); t_(true, 360, 400, 2030);
    CHECK(t_(false, 360, 500, 2060).fx != POD_FX_VOICE_END);
}

static void test_classic_side_button_discards(void) {
    // pro_app.c's side button calls the nav's abort path: POD_A_TABS from TALK, and a contact cancel.
    classic_listen();
    pod_out_t o = pod_nav_act(&U.nav, &U.model, POD_A_TABS, 0, 1500);
    CHECK(o.fx == POD_FX_VOICE_ABORT && !strcmp(o.agent, "a1") && top()->view == POD_V_TABS && !U.nav.sending);
    classic_listen();   // a contact cancelled mid-listen never sends
    t_(true, 360, 400, 2000);
    CHECK(pod_ui_touch_cancel(&U).fx != POD_FX_VOICE_END);
    CHECK(t_(false, 360, 400, 2050).fx == POD_FX_NONE);
}

static void test_classic_listen_tap_offline_discards(void) {
    classic_listen();
    ((pod_agent_t *)pod_model_find(&U.model, "a1"))->state = POD_OFFLINE;
    pod_out_t o = tap_(360, 400, 2000);
    CHECK(o.fx == POD_FX_VOICE_ABORT && !strcmp(o.agent, "a1") && !pod_ui_talking(&U));
    CHECK(U.notice_on && !strcmp(U.notice, "That machine is offline"));
}

static void test_banner_close_keeps_unread(void) {
    fresh(POD_SKIN_CLASSIC);
    to_agent(0, 0);
    CHECK(pod_ui_notify(&U, "a3", true, 1000));
    render(1000);
    pod_hit_t card0 = *find(POD_A_BANNER);
    const pod_hit_t *ban = &card0;
    CHECK(U.ban_on);
    int cx = ban->x + ban->w - 40, cy = ban->y + 30;   // inside the card
    add_hit_front(cx - 22, cy - 22, 44, 44, POD_A_BANNER_CLOSE);
    int unread = U.model.unread_count, depth = U.nav.depth;
    CHECK(unread > 0);
    pod_out_t o = tap_(cx, cy, 1100);
    CHECK(o.fx == POD_FX_NONE && !U.ban_on && U.model.unread_count == unread && U.nav.depth == depth && !strcmp(top()->agent, "a1"));
    // Elsewhere on the card still opens the agent.
    fresh(POD_SKIN_CLASSIC);
    to_agent(0, 0);
    CHECK(pod_ui_notify(&U, "a3", true, 1000));
    render(1000);
    pod_hit_t card = *find(POD_A_BANNER);   // a copy: add_hit_front shifts the list
    add_hit_front(card.x + card.w - 62, card.y + 8, 44, 44, POD_A_BANNER_CLOSE);
    o = tap_(card.x + 60, card.y + card.h / 2, 1100);
    CHECK(o.fx == POD_FX_AGENT_OPEN && !strcmp(o.agent, "a3"));
}

// The banner over a moving Tabs grid (Classic): the page flick is still settling, the x is on the frame (the glue picks it before
// the card), and a tap on it closes the banner with the entry still unread, opens nothing and leaves the page where it was going.
static void test_banner_over_tabs_drag(void) {
    fresh(POD_SKIN_CLASSIC);
    static const char *ids3[] = {"a1", "a2", "a3"};
    const char *const *ids[8] = {ids3, ids3, ids3, ids3, ids3, ids3, ids3, ids3};
    uint8_t cnt[8] = {3, 3, 3, 3, 3, 3, 3, 3};
    cable_swarm_t it[8] = {{"s1", "T1", 3, 3}, {"s2", "T2", 3, 3}, {"s3", "T3", 3, 3}, {"s4", "T4", 3, 3},
                           {"s5", "T5", 3, 3}, {"s6", "T6", 3, 3}, {"s7", "T7", 3, 3}, {"s8", "T8", 3, 3}};
    pod_model_swarms(&U.model, it, ids, cnt, 8, "s1", NULL, 0);
    pod_ui_set_skin(&U, POD_SKIN_CLASSIC);
    CHECK(top()->view == POD_V_TABS && pod_tabs_pages_of(&U.nav, &U.model) == 2);
    CHECK(pod_ui_notify(&U, "a3", true, 1000));
    render(1000);
    CHECK(U.ban_on && find(POD_A_BANNER_CLOSE));
    swipe(360, 500, 360, 200, 1100);   // a flick up to page 1: the grid settles
    CHECK(U.pg_mode == POD_PG_ANIM);
    render(1200);
    CHECK(U.frame.tabs_moving && U.frame.banner);
    const pod_hit_t *x = find(POD_A_BANNER_CLOSE);
    CHECK(x && &U.frame.hits[U.frame.hit_count - 1] == x);
    pod_hit_t cl = *x;
    const int page = top()->scroll, unread = U.model.unread_count, depth = U.nav.depth;
    CHECK(page > 0 && unread > 0);
    pod_out_t o = tap_(cl.x + cl.w / 2, cl.y + cl.h / 2, 1250);
    CHECK(o.fx == POD_FX_NONE && !U.ban_on && U.model.unread_count == unread && U.nav.depth == depth && top()->view == POD_V_TABS);
    CHECK(top()->scroll == page);   // the page did not move
    render(1400);
    CHECK(!U.frame.banner && !find(POD_A_BANNER_CLOSE) && top()->scroll == page);
}

static void test_banner_timer_wakes_66ms(void) {
    fresh(POD_SKIN_CLASSIC);
    to_agent(0, 0);
    calm();
    render(1000);
    uint32_t before = pod_ui_wake_ms(&U, 1000);
    CHECK(pod_ui_notify(&U, "a3", true, 1000));
    CHECK(pod_ui_banner_shown_ms(&U) == 1000);
    render(1000);
    CHECK(U.ban_on && pod_ui_wake_ms(&U, 1000) <= 66);
    CHECK(pod_ui_wake_ms(&U, 1010) <= 66);
    U.ban_on = false;
    CHECK(pod_ui_wake_ms(&U, 1000) == before);
}

int main(void) {
    test_classic_listen_tap_anywhere_sends();
    test_classic_side_button_discards();
    test_classic_listen_tap_offline_discards();
    test_banner_close_keeps_unread();
    test_banner_timer_wakes_66ms();
    test_banner_over_tabs_drag();
    overview_pages();
    bottom_up_goes_back();
    bottom_start_sideways_is_a_pane_swipe();
    bar_down_opens_inbox();
    toast_and_edges();
    hold_agent(POD_SKIN_CONSOLE);
    hold_agent(POD_SKIN_CLASSIC);
    hold_slide_does_nothing();
    drift_cancels();
    bar_swipe(POD_SKIN_CONSOLE);
    bar_swipe(POD_SKIN_CLASSIC);
    tab_gestures(POD_SKIN_CONSOLE);
    tab_gestures(POD_SKIN_CLASSIC);
    no_hold_views();
    crumb_and_chip();
    offline();
    skin_switch_mid_hold();
    hold_fires_on_held_samples();
    hold_cancel_keeps_recording();
    hands_free_taps_anywhere();
    send_before_talk_drawn();
    offline_tap_aborts();
    working_bars_wake();
    classic_list_working_wake();
    animation_rates();
    recent_rows_do_not_hold();
    overview_down_opens_inbox();
    inbox_swipe_goes_back();
    tab_cards_page();
    recent_swipe_steps_tabs();
    overview_scroll_follows_tab_removal();
    hold_not_in_bar();
    talk_ignores_bar_swipe();
    toast_cap_only_when_drawn();
    wake_rates();
    agent_screen_wakes();
    asking_agents_do_not_hold();
    hold_stays_with_its_target();
    refused_hold_stays_on_the_agent();
    printf("test_cs_glue: %d checks ok\n", checks);
    return 0;
}
