// The Classic Tabs grid and the Recent / Tab lists (and the Connection lost state of pod_render).
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "pod/classic/ci.h"
#include "pod/pod_view.h"
#include "pro_canvas.h"

static int checks;
#define CHECK(c) do { assert(c); checks++; } while (0)

enum { K_TEXT = 1, K_RECT = 2, K_IMAGE = 3, K_RECT_AA = 4 };   // pro_canvas.c's run kinds

static pod_model_t M;
static pod_nav_t N;
static pod_out_frame_t F;
static ht_scene_t S;

static bool banner;   // the glue's banner is up: the views leave its runs spare
static void render(uint32_t now) {
    memset(&F, 0, sizeof F);
    ht_scene_clear(&S, ht_rgb(0xffffff));
    F.scene = &S;
    F.banner = banner;
    pod_render(&F, &N, &M, now);
}
static int budget(void) { return POD_CLASSIC_RUNS - pod_spare_runs(&F) - 4; }   // the 4: the notice pill
static int count_kind(int kind) {
    int n = 0;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == kind) n++;
    return n;
}
static int count_rect(uint16_t ink) {
    int n = 0;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ink) n++;
    return n;
}
static const ht_run_t *find_text(const char *prefix) {
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && !strncmp(S.runs[i].text, prefix, strlen(prefix))) return &S.runs[i];
    return NULL;
}
static const ht_run_t *find_exact(const char *text) {
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && !strcmp(S.runs[i].text, text)) return &S.runs[i];
    return NULL;
}
static const pod_hit_t *find_hit(pod_action_t a, int arg) {
    for (int i = 0; i < F.hit_count; i++) if (F.hits[i].action == a && F.hits[i].arg == arg) return &F.hits[i];
    return NULL;
}

// n tabs, each with `per` agents named a<i>_<k> (claude), ids in the swarms feed.
static char ids[POD_TABS_MAX][12][8];
static const char *idp[POD_TABS_MAX][12];
static const char *const *idl[POD_TABS_MAX];
static uint8_t idn[POD_TABS_MAX];
static cable_swarm_t sw[POD_TABS_MAX];
static void build(int tabs, int per, bool with_ids) {
    pod_model_reset(&M);
    for (int i = 0; i < tabs; i++)
        for (int k = 0; k < per; k++) {
            snprintf(ids[i][k], 8, "t%dk%d", i, k);
            char name[16]; snprintf(name, sizeof name, "agent%d%d", i, k);
            pod_model_agent(&M, ids[i][k], name, "claude", "mac");
        }
    pod_model_agents_end(&M);
    for (int i = 0; i < tabs; i++) {
        for (int k = 0; k < per; k++) idp[i][k] = ids[i][k];
        idl[i] = idp[i]; idn[i] = (uint8_t)per;
        memset(&sw[i], 0, sizeof sw[i]);
        snprintf(sw[i].id, SWARM_ID_MAX, "s%d", i);
        snprintf(sw[i].name, CABLE_NAME_MAX, "Tab%d", i);
        sw[i].panes = per; sw[i].agents = per;
    }
    const char *const *const *lists = with_ids ? (const char *const *const *)idl : NULL;
    pod_model_swarms(&M, sw, (const char *const **)lists, with_ids ? idn : NULL, tabs, "s0", NULL, 0);
    pod_model_link(&M, true);
    pod_nav_init(&N);
}


static int count_in(int kind, int x, int y, int side);
static void build_shared(int tabs, int per);

// ---- geometry helpers ---------------------------------------------------------------------------------------

enum { COVER = 164, ROW_Y0 = 113, ROW_PITCH = 255, ROW_H = 112, LIST_Y0 = 88, FOOT_Y = 628 };
static const int COL_X[3] = {52, 278, 505};   // the art's left edges
#define CI_BLUE_RGB ht_rgb(0x155ccc)
#define CI_GROUND_RGB CI_GROUND
#define CI_INK_RGB ht_rgb(0x20292c)
#define CI_MUTED_RGB ht_rgb(0x657175)

static void cover_xy(int i, int *x, int *y) { *x = COL_X[i % 3]; *y = ROW_Y0 + i / 3 * ROW_PITCH; }
static int tab_hits(void) {
    int n = 0;
    for (int i = 0; i < F.hit_count; i++) if (F.hits[i].action == POD_A_OPEN_TAB) n++;
    return n;
}
static int dots_in(int x, int y, int side) {   // the state dots (green, amber) inside a box
    int n = 0;
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->pro_kind != K_RECT_AA || (r->fg != ht_rgb(0x35734f) && r->fg != ht_rgb(0xbf861e))) continue;
        ht_rect_t b = ht_run_bounds(r);
        if (b.x >= x && b.y >= y && b.x + b.w <= x + side && b.y + b.h <= y + side) n++;
    }
    return n;
}
// Runs of a kind (-1: any but text) whose bounds lie inside the square at (x, y).
static int count_in(int kind, int x, int y, int side) {
    int n = 0;
    for (int i = 0; i < S.count; i++) {
        if (S.runs[i].pro_kind == K_TEXT) continue;
        if (kind >= 0 && S.runs[i].pro_kind != kind) continue;
        ht_rect_t b = ht_run_bounds(&S.runs[i]);
        if (b.x >= x && b.y >= y && b.x + b.w <= x + side && b.y + b.h <= y + side) n++;
    }
    return n;
}
// The cover gradients (164 x 164), in draw order.
static int cover_arts(ht_rect_t out[16]) {
    int n = 0;
    for (int i = 0; i < S.count && n < 16; i++) {
        ht_rect_t b = ht_run_bounds(&S.runs[i]);
        if (S.runs[i].pro_kind == POD_GRAD && b.w == COVER && b.h == COVER) out[n++] = b;
    }
    return n;
}
static int near_(int a, int b) { return a >= b - 1 && a <= b + 1; }

// Every tab lists the same first `per` agents (the roster holds 32): a real mark in every pane of every cover.
static void build_shared(int tabs, int per) {
    pod_model_reset(&M);
    for (int k = 0; k < per; k++) {
        snprintf(ids[0][k], 8, "m%d", k);
        pod_model_agent(&M, ids[0][k], "member", k % 3 == 2 ? "cursor" : "claude", "mac");
    }
    pod_model_agents_end(&M);
    for (int k = 0; k < per; k++) idp[0][k] = ids[0][k];
    for (int i = 0; i < tabs; i++) {
        idl[i] = idp[0]; idn[i] = (uint8_t)per;
        memset(&sw[i], 0, sizeof sw[i]);
        snprintf(sw[i].id, SWARM_ID_MAX, "s%d", i);
        snprintf(sw[i].name, CABLE_NAME_MAX, "Tab%d", i);
        sw[i].panes = (uint8_t)per; sw[i].agents = (uint8_t)per;
    }
    pod_model_swarms(&M, sw, (const char *const **)idl, idn, tabs, "s0", NULL, 0);
    pod_model_link(&M, true);
    pod_nav_init(&N);
}

// ---- the Recent and Tab lists --------------------------------------------------------------------------------

// The footer's left: the mark (3 bars, CI_EQ, in the footer) + the count in Bold + "working", only when `n` agents work (n > 0).
static int foot_eq_runs(void) {
    int c = 0;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ht_rgb(0x2d6a51) && S.runs[i].w == 5 && S.runs[i].y >= FOOT_Y) c++;
    return c;
}
static bool foot_working(int n) {
    char num[8];
    snprintf(num, sizeof num, "%d", n);
    const ht_run_t *c = NULL, *w = NULL;
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->pro_kind != K_TEXT || r->y < FOOT_Y) continue;
        if (r->pro_font == &ci_bd_23 && !strcmp(r->text, num)) c = r;
        if (r->pro_font == &ci_rg_23 && !strcmp(r->text, "working")) w = r;
    }
    return c && w && c->fg == CI_INK_RGB && c->x < w->x && c->x > 32;
}

// No heading: the first row sits right under the bar (its title names the tab), and Back says where it came from.
static void test_list_no_heading(void) {
    build(1, 3, true);
    pod_model_turn(&M, "t0k0", "started", NULL, 0, 10);
    (pod_model_turn(&M, "t0k2", "started", NULL, 0, 0), pod_model_turn(&M, "t0k2", "done", NULL, 0, 20));
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    render(5000);
    const ht_run_t *a = find_text("agent00"), *b = find_text("agent01"), *c = find_text("agent02");
    CHECK(a && b && c && a->y < b->y && b->y < c->y);
    CHECK(find_hit(POD_A_OPEN_AGENT, 0) && find_hit(POD_A_OPEN_AGENT, 0)->y == LIST_Y0);   // the first row's top is the bar's foot
    CHECK(find_text("Tab0") && find_text("Tab0")->y < LIST_Y0 && find_text("Tab0")->pro_font == &ci_bd_30);   // the title, once
    CHECK(find_text("3 panes") == NULL && find_text("TAB") == NULL);
    CHECK(find_text("Tabs") && find_text("Tabs")->y < LIST_Y0 && find_hit(POD_A_BACK, 0));   // Back reads Tabs from the grid
    CHECK(a->pro_font == &ci_rg_33 && a->fg == CI_INK_RGB && a->x == 106);   // the working row's name is ink too
    CHECK(find_text("Claude \xc2\xb7 mac") && find_text("Claude \xc2\xb7 mac")->pro_font == &ci_rg_23 && find_text("Claude \xc2\xb7 mac")->fg == CI_MUTED_RGB);
    CHECK(count_kind(K_IMAGE) >= 3 && S.count <= budget());
    CHECK(S.background == CI_GROUND_RGB);
    // The footer: the working mark, "1" in Bold and "working" (t0k0 works), and the pane count.
    CHECK(find_text("Scroll to browse") == NULL && find_text("3 PANES"));
    CHECK(foot_working(1) && foot_eq_runs() == 3);
    // Recent: the agents that had a task, Back (no origin), "N AGENTS".
    pod_nav_init(&N);
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, POD_TAB_RECENT, 0);
    render(5000);
    CHECK(find_text("Recent") && find_text("Recent")->y < LIST_Y0 && find_text("Back") && find_hit(POD_A_BACK, 0));
    CHECK(find_text("agent00") && find_text("agent02") && !find_text("agent01") && find_text("2 AGENTS"));   // t0k1 had no task
    CHECK(foot_working(1) && foot_eq_runs() == 3);
    CHECK(find_text("Claude \xc2\xb7 mac") != NULL);   // no recap line any more: Engine and Machine
}

// Seven agents: four rows show whole and a fifth peeks above the footer (its hit stops at it); each row is 112 px with its rule.
// A drag scrolls by rows to the last four.
static void test_list_five_rows(void) {
    build_shared(1, 7);
    for (int k = 0; k < 7; k++) pod_model_turn(&M, ids[0][k], "started", NULL, 0, 5);
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    render(100);
    int rows = 0;
    for (int k = 0; k < 7; k++) {
        const pod_hit_t *h = find_hit(POD_A_OPEN_AGENT, k);
        if (!h) continue;
        rows++;
        CHECK(h->h == (k < 4 ? ROW_H : FOOT_Y - h->y) && h->y == LIST_Y0 + k * ROW_H && h->x == 0 && h->w == 720 && !strcmp(h->id, ids[0][k]));
    }
    CHECK(rows == 5 && S.count <= budget());
    CHECK(pod_tab_max_row(&N, &M) == 3 && pod_tab_pitch() == ROW_H && pod_scroll_pitch(&N) == ROW_H && pod_scroll_max(&N, &M) == 3);
    int rules = 0;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_RECT && S.runs[i].w == 720 && S.runs[i].pro_height == 1 && S.runs[i].y > LIST_Y0 && S.runs[i].y < FOOT_Y) rules++;
    CHECK(rules == 4);   // the fifth row's rule is under the footer
    pod_nav_act(&N, &M, POD_A_SCROLL, 9, 0);
    render(100);
    CHECK(find_hit(POD_A_OPEN_AGENT, 6) && find_hit(POD_A_OPEN_AGENT, 3) && !find_hit(POD_A_OPEN_AGENT, 2) && S.count <= budget());
    CHECK(find_hit(POD_A_OPEN_AGENT, 3)->y == LIST_Y0 && find_hit(POD_A_OPEN_AGENT, 6)->y + ROW_H <= FOOT_Y);
}

// Working, Finished, Needs you and Offline: the word in its colour, the time above it (only working and done have one); Ready has no meta.
static void test_list_meta_words(void) {
    build(1, 5, true);
    pod_model_turn(&M, "t0k0", "started", NULL, 0, 10);
    pod_model_turn(&M, "t0k1", "started", NULL, 0, 0);
    pod_model_turn(&M, "t0k1", "activity", NULL, 48, 10);
    pod_model_turn(&M, "t0k1", "done", NULL, 0, 20);
    pod_model_question(&M, "t0k2", "ok?");
    M.agents[pod_agent_index(&M, pod_model_find(&M, "t0k4"))].state = POD_OFFLINE;
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    render(4000);
    const ht_run_t *w = find_text("Working"), *d = find_text("Finished"), *q = find_text("Needs you"), *r = find_text("Ready"), *o = find_text("Offline");
    CHECK(w && d && q && o);
    CHECK(w->fg == ht_rgb(0x377052) && q->fg == ht_rgb(0x956616));
    CHECK(d->fg == CI_MUTED_RGB && o->fg == CI_MUTED_RGB);
    CHECK(w->pro_font == &ci_bd_20 && o->pro_font == &ci_bd_20);
    CHECK(w->x + w->w == 720 - 32 && o->x + o->w == 720 - 32);   // right-aligned at the margin
    CHECK(find_text("0:48") && find_text("0:48")->pro_font == &ci_rg_22 && find_text("0:48")->y < d->y);   // the time over the word
    CHECK(find_text("0:03") != NULL);                            // the working row counts on from its start (4 s - 1 s)
    CHECK(r == NULL);   // Ready (t0k3): no time, no dash, no word
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *t = &S.runs[i];
        if (t->pro_kind == K_TEXT && t->y >= LIST_Y0 + 3 * ROW_H && t->y < LIST_Y0 + 4 * ROW_H) CHECK(t->x + t->w < 400);   // only the name and "Engine · Machine"
    }
    const ht_run_t *dash = find_text("\xe2\x80\x94");
    CHECK(dash && dash->y < q->y);                               // asking, ready and offline: no time
    CHECK(S.count <= budget());
}

// The footer counts the working agents of the whole list (not only the rows on screen); none: "None working", no mark.
static void test_list_footer_working(void) {
    build(1, 7, true);
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    render(1000);
    const ht_run_t *none = find_exact("None working");
    CHECK(none && none->y >= FOOT_Y && none->x == 32 && none->fg == CI_MUTED_RGB && foot_eq_runs() == 0 && find_text("7 PANES"));
    CHECK(!find_exact("working") && !foot_working(0));
    pod_model_turn(&M, ids[0][5], "started", NULL, 0, 0);   // below the fold
    pod_model_turn(&M, ids[0][6], "started", NULL, 0, 0);
    render(1000);
    CHECK(foot_working(2) && foot_eq_runs() == 3 && !find_exact("None working") && find_text("7 PANES"));
    const ht_run_t *eq = NULL;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ht_rgb(0x2d6a51) && S.runs[i].y >= FOOT_Y) { eq = &S.runs[i]; break; }
    CHECK(eq && eq->x >= 32 && eq->x < 40);
    render(1000 + 150);   // the bars move
    int moved = 0;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ht_rgb(0x2d6a51) && S.runs[i].y >= FOOT_Y && S.runs[i].y != eq->y) moved++;
    CHECK(moved > 0);
}

// A 60-character name ends in "…" and stops before the meta column; so does a long machine name.
static void test_list_long_name_ellipsis(void) {
    build(1, 1, true);
    pod_model_turn(&M, ids[0][0], "started", NULL, 0, 0);   // working: it has a meta column
    char longname[80];
    for (int i = 0; i < 60; i++) longname[i] = (char)('a' + i % 26);
    longname[60] = 0;
    pod_model_agent(&M, ids[0][0], longname, "claude", "a-very-long-machine-name-that-keeps-going-and-going-on");
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    render(0);
    const ht_run_t *n = NULL, *sub = NULL, *word = find_text("Working");
    for (int i = 0; i < S.count; i++) {
        if (S.runs[i].pro_kind != K_TEXT) continue;
        if (!strncmp(S.runs[i].text, "abcdef", 6)) n = &S.runs[i];
        if (!strncmp(S.runs[i].text, "Claude", 6)) sub = &S.runs[i];
    }
    CHECK(n && sub && word);
    size_t len = strlen(n->text), sl = strlen(sub->text);
    CHECK(len > 3 && !strcmp(n->text + len - 3, "\xe2\x80\xa6") && sl > 3 && !strcmp(sub->text + sl - 3, "\xe2\x80\xa6"));
    CHECK(n->x + n->w <= word->x - 8 && sub->x + sub->w <= word->x - 8);   // clear of the state word and the time
    CHECK(n->x >= 106 && n->pro_font == &ci_rg_33);
    // A Vietnamese name is cut on a character, never inside one.
    pod_model_agent(&M, ids[0][0], "\xc4\x90\xe1\xba\xb7" "t l\xe1\xbb\x8b" "ch MMMMMMMMMMMMMMMMMMMMMMMMMM", "claude", "mac");
    render(0);
    const ht_run_t *vi = find_text("\xc4\x90\xe1\xba\xb7t");
    CHECK(vi && vi->x + vi->w <= word->x - 8);
    for (const unsigned char *p = (const unsigned char *)vi->text; *p; p++) if (*p >= 0x80 && *p < 0xc0) CHECK(p > (const unsigned char *)vi->text && (p[-1] >= 0x80));   // continuation bytes follow a lead
    CHECK(!strcmp(vi->text + strlen(vi->text) - 3, "\xe2\x80\xa6"));
}

// A tab with no rows to list: "No panes yet." and its line, no rows, "No panes" in the footer. An empty Recent says so too.
static void test_list_empty_tab(void) {
    build(0, 0, true);
    pod_model_swarms(&M, sw, NULL, NULL, 0, "", NULL, 0);
    cable_swarm_t none = {"z", "Shells", 0, 2};   // no agent: not listed
    pod_model_swarms(&M, &none, NULL, NULL, 1, "z", NULL, 0);
    CHECK(M.tab_count == 0);
    cable_swarm_t one = {"e", "Empty", 1, 1};   // members unknown (older daemon): no rows to list
    pod_model_swarms(&M, &one, NULL, NULL, 1, "e", NULL, 0);
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    render(0);
    const ht_run_t *h = find_text("No panes yet.");
    CHECK(h && h->pro_font == &ci_rg_43 && h->fg == CI_INK_RGB && near_(h->x + h->w / 2, 360));
    CHECK(find_text("This tab is managed in Harness.") && find_text("This tab is managed in Harness.")->pro_font == &ci_rg_25);
    CHECK(find_exact("No panes") != NULL && find_exact("No panes")->y >= FOOT_Y && find_text("Scroll to browse") == NULL && foot_eq_runs() == 0);
    for (int i = 0; i < F.hit_count; i++) CHECK(F.hits[i].action != POD_A_OPEN_AGENT);
    CHECK(find_hit(POD_A_BACK, 0) != NULL && find_text("Empty") && find_text("Empty")->y < LIST_Y0);
    pod_nav_init(&N);
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, POD_TAB_RECENT, 0);
    render(0);
    CHECK(find_text("No recent agents.") != NULL && find_text("No panes yet.") == NULL && find_exact("No agents") != NULL);
    for (int i = 0; i < F.hit_count; i++) CHECK(F.hits[i].action != POD_A_OPEN_AGENT);
}

// Nine agents, every mark a light one, a banner and a bell: still within the budget.
static void test_list_budget(void) {
    build_shared(1, 9);
    for (int k = 0; k < 9; k++) { pod_model_agent(&M, ids[0][k], "x", "cursor", "mac"); pod_model_turn(&M, ids[0][k], "started", NULL, 0, 5 + (uint32_t)k); }
    pod_model_unread_add(&M, "m0", "x", "done", 5, 100);
    for (int b = 0; b < 2; b++) {
        banner = b;
        for (int recent = 0; recent < 2; recent++)
            for (int scroll = 0; scroll <= 4; scroll++) {
                pod_nav_init(&N);
                pod_nav_act(&N, &M, POD_A_OPEN_TAB, recent ? POD_TAB_RECENT : 0, 0);
                pod_nav_act(&N, &M, POD_A_SCROLL, scroll, 0);
                render(100);
                CHECK(S.count <= budget() && F.hit_count <= 32);
            }
    }
    banner = false;
}

// ---- the album grid ---------------------------------------------------------------------------------------

// Six covers: the art boxes (164 x 164) at x {52, 278, 505} and y {113, 368}, each card's hit the 213 px column.
static void test_tabs_grid_geometry(void) {
    build(5, 2, true);
    render(0);
    ht_rect_t art[16];
    CHECK(cover_arts(art) == 6);
    for (int i = 0; i < 6; i++) {
        CHECK(near_(art[i].x, COL_X[i % 3]) && near_(art[i].y, i < 3 ? 113 : 368));
        const pod_hit_t *h = find_hit(POD_A_OPEN_TAB, i ? i - 1 : POD_TAB_RECENT);
        CHECK(h && h->w == 213 && h->h >= 230 && h->x + (h->w - COVER) / 2 + 0 >= art[i].x - 26 && h->x <= art[i].x && h->x + h->w >= art[i].x + COVER);
        CHECK(h->y == art[i].y && h->y + h->h <= FOOT_Y && h->x >= 0 && h->x + h->w <= 720);
    }
    CHECK(tab_hits() == 6 && S.count <= budget());
    // The names and counts sit under the art, left-aligned with it: 30 / 23.
    const ht_run_t *rn = find_text("Recent"), *tn = find_text("Tab3");
    CHECK(rn && rn->pro_font == &ci_rg_30 && near_(rn->x, COL_X[0]) && rn->y > 113 + COVER && rn->y < 113 + COVER + 40);
    CHECK(tn && tn->pro_font == &ci_rg_30 && near_(tn->x, COL_X[1]) && tn->y > 368 + COVER);
    const ht_run_t *cn = find_text("2 panes");
    CHECK(cn && cn->pro_font == &ci_rg_23 && cn->fg == CI_MUTED_RGB && cn->y > 113 + COVER);
    CHECK(S.background == CI_GROUND_RGB && find_text("Tabs") && find_text("Harness") && find_hit(POD_A_INBOX, 0));
}

// The chosen cover: a 5 px blue ring with a 5 px gap (the ground between), its name blue; no other cover has one.
static void test_tabs_selected_ring(void) {
    build(3, 2, true);
    pod_model_swarms(&M, sw, (const char *const **)idl, idn, 3, "s1", NULL, 0);   // Tab1 is the window's selected tab
    render(0);
    CHECK(find_text("Tab1") && find_text("Tab1")->fg == CI_BLUE_RGB);
    CHECK(find_text("Tab0")->fg == CI_INK_RGB && find_text("Tab2")->fg == CI_INK_RGB && find_text("Recent")->fg == CI_INK_RGB);
    int x, y, rings = 0, gaps = 0;
    cover_xy(2, &x, &y);   // cover 2 is Tab1
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        ht_rect_t b = ht_run_bounds(r);
        if (r->pro_kind != K_RECT_AA) continue;
        if (r->fg == CI_BLUE_RGB && b.w == COVER + 20) { rings++; CHECK(b.x == x - 10 && b.y == y - 10 && b.h == COVER + 20); CHECK(i + 1 < S.count); }
        if (r->fg == CI_GROUND_RGB && b.w == COVER + 10) { gaps++; CHECK(b.x == x - 5 && b.y == y - 5 && b.h == COVER + 10 && i > 0); }
    }
    CHECK(rings == 1 && gaps == 1);   // ring 10 px out, ground 5 px out: a 5 px band, a 5 px gap
    // The ring is drawn before the cover, the ground in between.
    int ri = -1, gi = -1, ci = -1;
    for (int i = 0; i < S.count; i++) {
        ht_rect_t b = ht_run_bounds(&S.runs[i]);
        if (S.runs[i].pro_kind == K_RECT_AA && S.runs[i].fg == CI_BLUE_RGB && b.w == COVER + 20) ri = i;
        if (S.runs[i].pro_kind == K_RECT_AA && S.runs[i].fg == CI_GROUND_RGB && b.w == COVER + 10) gi = i;
        if (S.runs[i].pro_kind == POD_GRAD && b.w == COVER && b.x == x && b.y == y) ci = i;
    }
    CHECK(ri >= 0 && ri < gi && gi < ci);
}

// The ribbon shows only on a cover whose agents are working: eq, "Working" and the count; Recent counts its working agents.
static void ribbon_setup(void) {   // Tab0 has one agent working (two panes), Tab1 only an asking one, Tab2 none
    build(3, 2, true);
    pod_model_turn(&M, "t0k0", "started", NULL, 0, 10);
    pod_model_turn(&M, "t1k0", "started", NULL, 0, 10);
    (pod_model_turn(&M, "t1k0", "started", NULL, 0, 0), pod_model_turn(&M, "t1k0", "done", NULL, 0, 11));
    pod_model_question(&M, "t1k1", "ok?");
}
static const ht_run_t *foot_text(int c, const char *text) {   // a text run inside cover c's foot band (31 px)
    int x, y; cover_xy(c, &x, &y);
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->pro_kind == K_TEXT && !strcmp(r->text, text) && r->x >= x && r->x < x + COVER && r->y >= y + COVER - 31 && r->y < y + COVER) return r;
    }
    return NULL;
}
static int foot_eq_bars(int c) {   // the eq's three bars: 5 px wide, light green, inside the band
    int x, y, n = 0; cover_xy(c, &x, &y);
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->pro_kind == K_RECT && r->w == 5 && r->fg == ht_rgb(0xa6e0b5) && r->x >= x && r->x < x + COVER && r->y >= y + COVER - 31 && r->y < y + COVER) n++;
    }
    return n;
}
static void test_tabs_ribbon_only_when_working(void) {
    ribbon_setup();
    render(20);
    const ht_run_t *p = foot_text(1, "Working"), *cnt = foot_text(1, "1");
    CHECK(p && p->fg == ht_rgb(0xffffff) && p->pro_font == &ci_rg_20 && cnt && cnt->fg == ht_rgb(0xffffff) && cnt->x > p->x + 40);
    int x, y; cover_xy(1, &x, &y);
    CHECK(p->x > x + 30 && cnt->x + cnt->w <= x + COVER - 8 && foot_eq_bars(1) == 3);
    CHECK(foot_text(0, "Working") && foot_text(0, "1") && foot_eq_bars(0) == 3);   // Recent counts t0k0
    CHECK(!foot_text(2, "Working") && foot_eq_bars(2) == 0);    // asking only: no ribbon
    CHECK(!foot_text(3, "Working") && foot_eq_bars(3) == 0);    // idle
    CHECK(pod_tabs_ribbon(&M, 0) && !pod_tabs_ribbon(&M, 1));
    pod_model_turn(&M, "t0k1", "started", NULL, 0, 12);          // two working in a tab: the count says 2
    render(30);
    CHECK(foot_text(1, "2") != NULL && foot_text(0, "2") != NULL);
    // Nobody working: no ribbon anywhere, nothing for the glue to wake for.
    build(3, 2, true);
    render(0);
    CHECK(find_text("Working") == NULL && !pod_tabs_ribbon(&M, 0));
    // The eq moves with the clock; the run count does not.
    ribbon_setup();
    render(1000);
    int count = S.count;
    static ht_scene_t prev;
    memcpy(&prev, &S, sizeof S);
    render(1000 + POD_TABS_BAR_MS);
    CHECK(S.count == count);
    int diff = 0;
    for (int i = 0; i < count; i++) if (memcmp(&S.runs[i], &prev.runs[i], sizeof S.runs[i])) { diff++; CHECK(S.runs[i].pro_kind == K_RECT && S.runs[i].w == 5); }
    CHECK(diff > 0);
}

// 9 tabs: "PAGE 1 / 2" (and "PAGE 2 / 2" on the next page); 5 tabs and 7 agents: "5 TABS · 7 AGENTS"; "N working" at the left.
static void test_tabs_footer_pages(void) {
    build(9, 1, true);
    CHECK(pod_tabs_pages(&M) == 2);
    render(0);
    const ht_run_t *pg = find_text("PAGE 1 / 2");
    CHECK(pg && pg->pro_font == &ci_rg_20 && pg->y >= FOOT_Y && pg->x + pg->w == 720 - 32 && !find_text("TABS"));
    CHECK(find_text("0 working") && find_text("0 working")->x == 32 && find_text("0 working")->pro_font == &ci_rg_23);
    pod_nav_act(&N, &M, POD_A_SCROLL, 2, 0);
    render(0);
    CHECK(find_text("PAGE 2 / 2") != NULL && find_text("PAGE 1 / 2") == NULL);
    F.tabs_moving = true; F.tabs_off = pod_tabs_pitch() / 2 - 20;   // mid-drag: the page nearer the offset
    ht_scene_clear(&S, ht_rgb(0xffffff)); F.hit_count = 0; pod_render(&F, &N, &M, 0);
    CHECK(find_text("PAGE 1 / 2") != NULL);
    build_shared(5, 7);
    pod_model_turn(&M, "m0", "started", NULL, 0, 10);
    render(0);
    CHECK(pod_tabs_pages(&M) == 1);
    CHECK(find_text("5 TABS \xc2\xb7 7 AGENTS") != NULL && find_text("1 working") != NULL && !find_text("PAGE 1 / 1"));
    build(1, 1, true);
    render(0);
    CHECK(find_text("1 TAB \xc2\xb7 1 AGENT") != NULL);
}

// Tabs holding no agent get no cover: only Recent is drawn, and the bar counts the tabs that are shown.
static void test_tabs_hide_agentless(void) {
    pod_model_reset(&M);
    cable_swarm_t two[2] = {{"a", "Alpha", 0, 0}, {"b", "Beta", 0, 1}};
    pod_model_swarms(&M, two, NULL, NULL, 2, "a", NULL, 0);
    pod_model_link(&M, true);
    pod_nav_init(&N);
    render(0);
    CHECK(M.tab_count == 0 && find_text("Alpha") == NULL && find_text("Beta") == NULL && find_text("Empty") == NULL);
    CHECK(find_text("Recent") != NULL && find_hit(POD_A_OPEN_TAB, 0) == NULL);
}

// The worst frame: six covers of 2 to 9 panes, every agent working, a light mark in every third pane, a bell and a banner.
// Always within the budget, the same count at every clock, and the ribbon of every shown cover kept at rest.
static int max_runs;
static void test_tabs_budget(void) {
    static const int tabs_for[] = {1, 2, 5, 7, 12, 24};
    for (int b = 0; b < 2; b++) {
        banner = b;
        for (int j = 0; j < 6; j++)
            for (int per = 0; per <= 9; per++)
                for (int known = 0; known < 2; known++) {
                    if (known) build_shared(tabs_for[j], per); else build(tabs_for[j], per, false);
                    if (per) {
                        pod_model_turn(&M, known ? "m0" : "t0k0", "started", NULL, 0, 10);
                        if (known && per > 1) pod_model_question(&M, "m1", "ok?");
                        pod_model_unread_add(&M, known ? "m0" : "t0k0", "x", "done", 5, 100);
                    }
                    for (int k = 0; k < per && known; k++)   // a task each, so Recent holds them
                        if (strcmp(ids[0][k], "m0") && strcmp(ids[0][k], "m1")) (pod_model_turn(&M, ids[0][k], "started", NULL, 0, 0), pod_model_turn(&M, ids[0][k], "done", NULL, 0, 20 + (uint32_t)k));
                    for (int row = 0; row <= pod_tabs_max_row(&M); row += 2) {
                        pod_nav_init(&N);
                        pod_nav_act(&N, &M, POD_A_SCROLL, row, 0);
                        render(1000);
                        int want = S.count;
                        if (want > max_runs) max_runs = want;
                        CHECK(want > 0 && want <= budget() && F.hit_count <= 32);
                        for (uint32_t t = 1000; t < 3000; t += 331) { render(t); CHECK(S.count == want); }
                    }
                }
        // Every agent working in every cover: nine light marks, a ribbon on each, eight recent agents.
        for (int per = 2; per <= 9; per += 7) {
            build_shared(12, per);
            for (int k = 0; k < per; k++) { pod_model_agent(&M, ids[0][k], "x", "cursor", "mac"); pod_model_turn(&M, ids[0][k], "started", NULL, 0, 5 + (uint32_t)k); }
            pod_model_unread_add(&M, "m0", "x", "done", 5, 100);
            for (int row = 0; row <= pod_tabs_max_row(&M); row += 2) {
                pod_nav_init(&N); pod_nav_act(&N, &M, POD_A_SCROLL, row, 0);
                render(100);
                CHECK(S.count <= budget() && F.hit_count <= 32);
                int pl = 0; for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && !strcmp(S.runs[i].text, "Working")) pl++;
                int covers = 1 + 12, first = row * 3, shown = covers - first < 6 ? covers - first : 6;
                CHECK(pl == shown);   // the ribbons are never dropped at rest
            }
        }
    }
    banner = false;
}

// Six covers (Recent and five tabs of six panes): every pane draws its mark, the busy ones their dots, until the frame runs short.
static void grid_test_six_covers(void) {
    build_shared(5, 6);
    pod_model_turn(&M, "m0", "started", NULL, 0, 10);
    pod_model_question(&M, "m1", "ok?");
    render(500);
    CHECK(tab_hits() == 6 && S.count <= budget());
    int x1, y1, x5, y5;
    cover_xy(1, &x1, &y1); cover_xy(5, &x5, &y5);
    CHECK(count_in(K_IMAGE, x1, y1, COVER) == 6);   // the selected cover keeps all six marks
    CHECK(count_in(K_IMAGE, x5, y5, COVER) <= 6);
    CHECK(dots_in(x1, y1, COVER) == 2 && dots_in(x5, y5, COVER) <= dots_in(x1, y1, COVER));   // the last covers lose their dots first
    // With two panes a cover everything fits: every busy pane has its dot, on every cover.
    build_shared(5, 2);
    pod_model_turn(&M, "m0", "started", NULL, 0, 10);
    pod_model_question(&M, "m1", "ok?");
    render(500);
    for (int i = 1; i < 6; i++) {
        int x, y;
        cover_xy(i, &x, &y);
        CHECK(dots_in(x, y, COVER) == 2 && count_in(K_IMAGE, x, y, COVER) == 2);   // m0 working (green), m1 asking (amber)
    }
    CHECK(count_in(POD_TRI, 0, 88, 720) == 0 && count_kind(POD_CELL) == 0);   // no triangles, no pets
}

// Counts only (an older daemon): the tabs' minis are blank with the default mark; Recent has its agents' marks.
static void tabs_test_no_ids(void) {
    build(2, 3, false);
    render(0);
    int x1, y1, x2, y2;
    cover_xy(1, &x1, &y1); cover_xy(2, &x2, &y2);
    CHECK(count_in(K_IMAGE, x1, y1, COVER) == 0 && count_in(K_IMAGE, x2, y2, COVER) == 0);   // the tabs' panes are blank
    CHECK(find_text("3 panes") != NULL);
    CHECK(count_rect(ht_rgb(0x9aa09a)) == 6);   // both tabs' three panes, each with the default mark's outline
    CHECK(find_hit(POD_A_OPEN_TAB, 0) != NULL && find_hit(POD_A_OPEN_TAB, 1) != NULL);
}

// A pane whose agent or engine has no mark shows the default mark, never an empty pane; a tab with no panes is the grid icon.
static void tabs_test_default_mark(void) {
    build(1, 2, true);
    pod_model_agent(&M, ids[0][1], "blank", "", "mac");
    pod_model_agent(&M, ids[0][0], "odd", "zzz-unknown", "mac");
    for (int k = 0; k < 2; k++) (pod_model_turn(&M, ids[0][k], "started", NULL, 0, 0), pod_model_turn(&M, ids[0][k], "done", NULL, 0, 1 + (uint32_t)k));   // tasks: Recent lists them
    render(0);
    int x, y;
    cover_xy(1, &x, &y);
    CHECK(count_rect(ht_rgb(0x9aa09a)) == 4);   // the tab's two panes, and Recent's two agents
    int in_tab = 0;
    for (int i = 0; i < S.count; i++) {
        ht_rect_t b = ht_run_bounds(&S.runs[i]);
        if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ht_rgb(0x9aa09a)) {
            CHECK(b.w == b.h && (b.w == 44 || b.w == 28));
            if (b.x >= x && b.x < x + COVER) in_tab++;
        }
    }
    CHECK(in_tab == 2 && find_text(">_") != NULL);
    pod_model_reset(&M);
    pod_model_link(&M, true);
    pod_nav_init(&N);
    cable_swarm_t two = {"e", "Two", 2, 2};   // members unknown (older daemon) with 2 panes: two default marks
    pod_model_swarms(&M, &two, NULL, NULL, 1, "e", NULL, 0);
    render(0);
    CHECK(count_rect(ht_rgb(0x9aa09a)) == 2);
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);   // the list holds no rows for unknown members
    render(0);
    CHECK(count_rect(ht_rgb(0x9aa09a)) == 0 && find_text("No panes yet.") != NULL);
}

// One pane fills the cover; two or more are two columns; an offline agent's mini is faded; a tab of many panes ends in "+N".
static void tabs_test_minis(void) {
    build_shared(3, 1);
    render(0);
    int x, y;
    cover_xy(1, &x, &y);
    int one = 0, w1 = 0;
    for (int i = 0; i < S.count; i++) {
        ht_rect_t b = ht_run_bounds(&S.runs[i]);
        if (S.runs[i].pro_kind == K_RECT_AA && b.x >= x && b.y >= y && b.x + b.w <= x + COVER && b.y + b.h <= y + COVER && b.w > 100) { one++; w1 = b.w; }
    }
    CHECK(one == 1 && w1 == COVER - 26);   // 13 px padding all round
    build_shared(3, 2);
    render(0);
    int two = 0;
    for (int i = 0; i < S.count; i++) {
        ht_rect_t b = ht_run_bounds(&S.runs[i]);
        if (S.runs[i].pro_kind == K_RECT_AA && b.x >= x && b.y >= y && b.x + b.w <= x + COVER && b.y + b.h <= y + COVER && b.h > 100) { two++; CHECK(b.w == 66); }
    }
    CHECK(two == 2);
    M.agents[1].state = POD_OFFLINE;
    render(0);
    CHECK(count_in(K_IMAGE, x, y, COVER) == 2);
    int faded = 0;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_IMAGE && S.runs[i].radius > 0 && S.runs[i].radius < 255) faded++;
    CHECK(faded >= 1);
    build_shared(3, 12);
    render(0);
    CHECK(find_text("+5") != NULL && count_in(K_IMAGE, x, y, COVER) <= 7);
}

// The runs that are not text, the bar or the footer.
static int lowest_cover_edge(void) {
    int low = 0;
    for (int i = 0; i < S.count; i++) {
        ht_rect_t b = ht_run_bounds(&S.runs[i]);
        if (b.w >= 720 || b.y < LIST_Y0 || b.y >= FOOT_Y) continue;   // the glass, the bar, the footer
        if (b.y + b.h > low) low = b.y + b.h;
    }
    return low;
}

// Two rows of covers a page, whole pages: nothing of the next row shows at rest, the frame's scroll is the page's first row.
static void grid_test_scroll(void) {
    build(10, 2, true);                                     // 11 covers: 4 rows, 2 pages
    CHECK(pod_tabs_pitch() == 2 * ROW_PITCH && pod_tabs_pages(&M) == 2 && pod_tabs_max_row(&M) == 2);
    render(0);
    CHECK(find_hit(POD_A_OPEN_TAB, POD_TAB_RECENT) && find_hit(POD_A_OPEN_TAB, 4) && !find_hit(POD_A_OPEN_TAB, 5));   // covers 0..5 only
    CHECK(tab_hits() == 6);
    CHECK(find_text("Tab4") != NULL && find_text("Tab5") == NULL);
    CHECK(lowest_cover_edge() <= FOOT_Y);                   // nothing below the footer's rule
    for (int i = 0; i < F.hit_count; i++) if (F.hits[i].action == POD_A_OPEN_TAB) CHECK(F.hits[i].y + F.hits[i].h <= FOOT_Y);
    pod_nav_act(&N, &M, POD_A_SCROLL, 2, 0);               // the second page: covers 6..10
    render(0);
    CHECK(!find_hit(POD_A_OPEN_TAB, POD_TAB_RECENT) && find_hit(POD_A_OPEN_TAB, 5) && find_hit(POD_A_OPEN_TAB, 9) && tab_hits() == 5);
    CHECK(find_hit(POD_A_OPEN_TAB, 5)->y == ROW_Y0 && find_hit(POD_A_OPEN_TAB, 9)->y == ROW_Y0 + ROW_PITCH);
    CHECK(find_text("PAGE 2 / 2"));
    pod_nav_act(&N, &M, POD_A_SCROLL, 50, 0);               // past the end: the draw clamps
    render(0);
    CHECK(find_hit(POD_A_OPEN_TAB, 9) && !find_hit(POD_A_OPEN_TAB, 4));
    const pod_hit_t *last = find_hit(POD_A_OPEN_TAB, 9);
    CHECK(last->y + last->h <= FOOT_Y && last->x >= 0 && last->x + last->w <= 720);
    pod_nav_init(&N); pod_nav_act(&N, &M, POD_A_SCROLL, 1, 0);   // an odd row: its page
    render(0);
    CHECK(find_hit(POD_A_OPEN_TAB, POD_TAB_RECENT) != NULL);
    pod_nav_act(&N, &M, POD_A_SCROLL, -100, 0);
    render(0);
    CHECK(find_hit(POD_A_OPEN_TAB, POD_TAB_RECENT) != NULL);
    build(4, 1, true);                                      // five covers: nothing to scroll
    CHECK(pod_tabs_max_row(&M) == 0 && pod_tabs_pages(&M) == 1);
    render(0);
    CHECK(find_text("PAGE 1 / 1") == NULL);
    F.tabs_moving = true; F.tabs_off = 200; ht_scene_clear(&S, ht_rgb(0xffffff)); F.hit_count = 0; pod_render(&F, &N, &M, 0);   // one page does not move
    CHECK(find_hit(POD_A_OPEN_TAB, POD_TAB_RECENT)->y == ROW_Y0);
    build(0, 0, true);
    render(0);
    CHECK(find_hit(POD_A_OPEN_TAB, POD_TAB_RECENT) != NULL && tab_hits() == 1);
}

static void render_at(int off, uint32_t now) {
    memset(&F, 0, sizeof F);
    ht_scene_clear(&S, ht_rgb(0xffffff));
    F.scene = &S;
    F.banner = banner;
    F.tabs_moving = true;
    F.tabs_off = off;
    pod_render(&F, &N, &M, now);
}

// While the grid is dragged it is drawn at the pixel offset: both pages, the rows that meet the glass, the bar and the footer
// over whatever has scrolled under them, the hits clipped to the glass; on a page boundary it is the resting screen.
static void grid_test_motion(void) {
    build(10, 2, true);                                     // 11 covers, 2 pages
    int rest0;
    render(0);
    rest0 = S.count;
    render_at(0, 0);
    CHECK(S.count == rest0 && tab_hits() == 6 && find_hit(POD_A_OPEN_TAB, 0)->y == ROW_Y0);   // offset 0: the resting page 0
    render_at(2 * ROW_PITCH, 0);
    CHECK(tab_hits() == 5 && find_hit(POD_A_OPEN_TAB, 5)->y == ROW_Y0 && !find_hit(POD_A_OPEN_TAB, 4));   // a boundary: the resting page 1
    render_at(100, 0);                                      // 100 px into the first page
    const pod_hit_t *h = find_hit(POD_A_OPEN_TAB, 2);       // cover 3 (tab 2), the second row: it moved up by the offset
    CHECK(h && h->x == COL_X[0] - 24 && h->y == ROW_Y0 + ROW_PITCH - 100);
    CHECK(find_hit(POD_A_OPEN_TAB, 5) && find_hit(POD_A_OPEN_TAB, 5)->y == ROW_Y0 + 2 * ROW_PITCH - 100 && find_hit(POD_A_OPEN_TAB, 5)->y + find_hit(POD_A_OPEN_TAB, 5)->h == FOOT_Y);
    CHECK(find_hit(POD_A_OPEN_TAB, 0) && find_hit(POD_A_OPEN_TAB, 0)->y == LIST_Y0 + 1);   // the first row's card, clipped under the bar
    CHECK(find_text("Tab2") != NULL && find_text("Tab5") == NULL && find_text("Tab8") == NULL);   // row 2: its cover shows, its name is below the glass; row 3 is gone
    for (int i = 0; i < F.hit_count; i++) if (F.hits[i].action == POD_A_OPEN_TAB) CHECK(F.hits[i].y >= LIST_Y0 && F.hits[i].y + F.hits[i].h <= FOOT_Y);
    // The footer and the bar are drawn last: every run after the footer's gradient lies in the footer or the bar.
    int foot = -1;
    for (int i = 0; i < S.count; i++) { ht_rect_t b = ht_run_bounds(&S.runs[i]); if (b.y == FOOT_Y && b.h == 720 - FOOT_Y && b.w == 720) foot = i; }
    CHECK(foot >= 0);
    for (int i = foot; i < S.count; i++) { ht_rect_t b = ht_run_bounds(&S.runs[i]); CHECK(b.y >= FOOT_Y || b.y + b.h <= LIST_Y0 + 2); }
    CHECK(find_text("PAGE 1 / 2") != NULL);                 // 100 of 510: nearer the first page
    render_at(300, 0);
    CHECK(find_text("PAGE 2 / 2") != NULL);
    // A mid-motion row that has scrolled wholly under the bar is not drawn; a row below the glass neither.
    render_at(400, 0);
    CHECK(find_hit(POD_A_OPEN_TAB, POD_TAB_RECENT) == NULL);   // row 0 at 113 - 400: wholly under the bar, gone
    render_at(-100, 0);                                     // the end pulled down: the first page lower, nothing before it
    CHECK(find_hit(POD_A_OPEN_TAB, POD_TAB_RECENT)->y == ROW_Y0 + 100 && find_hit(POD_A_OPEN_TAB, 5) == NULL);
}

// Run budget in motion: 24 tabs, nine marked panes a cover, the worst two partial pages, every offset.
static void grid_test_motion_budget(void) {
    for (int per = 1; per <= 9; per += (per < 6 ? 2 : 1)) {
        build_shared(24, per);
        for (int k = 0; k < per; k++) { pod_model_agent(&M, ids[0][k], "x", k % 2 ? "cursor" : "claude", "mac"); pod_model_turn(&M, ids[0][k], "started", NULL, 0, 5 + (uint32_t)k); }
        if (per > 1) pod_model_question(&M, "m1", "ok?");
        pod_model_unread_add(&M, "m0", "x", "done", 5, 100);
        int pages = pod_tabs_pages(&M), most = 0;
        CHECK(pages == 5);                                  // 25 covers: 9 rows
        for (int off = -255; off <= 4 * 510 + 255; off += 11) {
            render_at(off, 100);
            CHECK(S.count > 0 && S.count <= budget() && F.hit_count <= 32);
            if (S.count > most) most = S.count;
        }
        CHECK(most > 30);
    }
    // Resting is constant: the same count at every clock, and the same as the page-aligned motion.
    build_shared(24, 9);
    for (int row = 0; row <= pod_tabs_max_row(&M); row += 2) {
        pod_nav_init(&N); pod_nav_act(&N, &M, POD_A_SCROLL, row, 0);
        render(0);
        int want = S.count;
        for (uint32_t t = 0; t < 3000; t += 331) { render(t); CHECK(S.count == want); render_at(row / 2 * 510, t); CHECK(S.count == want); }
    }
}

// Tap a cover: its tab (a normal tab by its id), Recent included.
static void grid_test_taps(void) {
    build(4, 2, true);
    render(0);
    const pod_hit_t *h = find_hit(POD_A_OPEN_TAB, POD_TAB_RECENT);
    CHECK(h && h->id[0] == 0 && h->x == COL_X[0] - 24 && h->y == ROW_Y0);
    pod_nav_act(&N, &M, (pod_action_t)h->action, h->arg, 0);
    CHECK(N.depth == 2 && N.stack[1].view == POD_V_TAB && N.stack[1].tab == POD_TAB_RECENT);
    pod_nav_init(&N);
    render(0);
    h = find_hit(POD_A_OPEN_TAB, 2);
    CHECK(h && !strcmp(h->id, "s2"));
    CHECK(h->x == COL_X[0] - 24 && h->y == ROW_Y0 + ROW_PITCH);   // cover 3 is row 1, column 0
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, h->arg, 0);
    CHECK(N.depth == 2 && N.stack[1].tab == 2 && !strcmp(N.stack[1].tab_id, "s2"));
    pod_nav_init(&N);
    render(0);
    for (int i = 0; i < F.hit_count; i++) {                // every card hit is on the glass and big enough to tap
        if (F.hits[i].action != POD_A_OPEN_TAB) continue;
        CHECK(F.hits[i].w == 213 && F.hits[i].x >= 0 && F.hits[i].x + F.hits[i].w <= 720 && F.hits[i].y >= LIST_Y0 && F.hits[i].y + F.hits[i].h <= FOOT_Y);
    }
}

// The captions: name in Regular 30, the count line in 23 muted; "N working" in the footer only.
static void grid_test_captions(void) {
    build(3, 2, true);
    pod_model_turn(&M, "t0k0", "started", NULL, 0, 10);
    pod_model_turn(&M, "t1k0", "started", NULL, 0, 10);
    pod_model_question(&M, "t2k1", "ok?");
    render(20);
    const ht_run_t *name = find_text("Tab0"), *sub = find_text("2 panes");
    CHECK(name && sub && name->pro_font == &ci_rg_30 && sub->pro_font == &ci_rg_23 && sub->fg == CI_MUTED_RGB);
    CHECK(name->fg == CI_BLUE_RGB);                         // Tab0 is the selected one
    CHECK(!find_text("1 asking"));
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && S.runs[i].y > LIST_Y0 && S.runs[i].y < FOOT_Y && strstr(S.runs[i].text, "working")) CHECK(0);
    CHECK(find_text("Tabs") != NULL && find_text("Tabs")->pro_font == &ci_bd_30 && find_text("3 working") != NULL && find_text("3 working")->y >= FOOT_Y);   // working and asking
    CHECK(find_text("Tab1") != NULL && find_text("Tab2") != NULL && find_text("Recent") != NULL && find_text("3 agents") != NULL);   // Recent: the three with tasks
}

// Connection lost (the cable is down): the stack stays where it is, nothing on it is live, and it comes back with the link.
static void render_test_connection_lost(void) {
    build(2, 2, true);
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    pod_nav_act(&N, &M, POD_A_OPEN_AGENT, 0, 0);
    int depth = N.depth;
    char who[ID_MAX]; strcpy(who, N.stack[N.depth - 1].agent);
    pod_model_link(&M, false);
    render(0);
    CHECK(find_text("Connection lost.") != NULL && find_text("Connecting") == NULL);
    CHECK(count_kind(K_IMAGE) == 0);
    for (int i = 0; i < S.count; i++) CHECK(S.runs[i].pro_kind != POD_CELL);
    CHECK(F.hit_count == 0);
    CHECK(N.depth == depth && !strcmp(N.stack[N.depth - 1].agent, who));
    pod_model_link(&M, true);
    render(0);
    CHECK(find_text("Connection lost.") == NULL);
}

// M12: a send whose turn never came: after POD_SENT_WAIT_MS the agent is no longer counted as working anywhere. (A real
// turn has no such expiry.)
static void tabs_test_stale_working(void) {
    build(1, 3, true);
    pod_model_sent(&M, "t0k0", 10);
    render(20);
    CHECK(find_text("3 panes") != NULL && find_text("Working") != NULL);
    int w, q;
    pod_tab_counts(&M, &M.tabs[0], &w, &q);
    CHECK(w == 1);
    render(10 + POD_SENT_WAIT_MS + 1);
    CHECK(find_text("Working") == NULL && find_text("3 panes") != NULL);
    pod_tab_counts(&M, &M.tabs[0], &w, &q);
    CHECK(w == 0 && q == 0);
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    render(10 + POD_SENT_WAIT_MS + 1);
    CHECK(find_text("3 panes") == NULL && find_text("1 working") == NULL);   // the Tab screen has no head
}

int main(void) {
    test_list_footer_working();
    test_tabs_grid_geometry();
    test_tabs_selected_ring();
    test_tabs_ribbon_only_when_working();
    test_tabs_footer_pages();
    test_tabs_hide_agentless();
    test_tabs_budget();
    tabs_test_minis();
    grid_test_six_covers();
    grid_test_scroll();
    grid_test_motion();
    grid_test_motion_budget();
    grid_test_taps();
    grid_test_captions();
    tabs_test_no_ids();
    tabs_test_default_mark();
    tabs_test_stale_working();
    test_list_no_heading();
    test_list_five_rows();
    test_list_meta_words();
    test_list_long_name_ellipsis();
    test_list_empty_tab();
    test_list_budget();
    render_test_connection_lost();
    printf("test_pod_views_tabs: %d checks ok (most runs in a Tabs frame: %d of %d)\n", checks, max_runs, HT_RUNS);
    return 0;
}

