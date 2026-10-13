// The Classic notification screens (the bell in the bar, the Inbox, the banner: ci_chrome.c, pod_view_inbox.c) and the misc
// screens of the Index look: Voice, Update and Connection lost (pod_view_talk.c, pod_view_ota.c, ci_connection.c).
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "pod/classic/ci.h"
#include "pod/pod_view.h"
#include "pro_canvas.h"

static int checks;
#define CHECK(c) do { assert(c); checks++; } while (0)

enum { K_TEXT = 1, K_RECT = 2, K_IMAGE = 3, K_RECT_AA = 4, K_STROKE = 5 };

static pod_model_t M;
static pod_nav_t N;
static pod_out_frame_t F;
static ht_scene_t S;
static int max_runs, banner_max;   // banner_max: the most runs pod_banner added

// banner: the glue's order: flag first, pod_render, then pod_banner for the entry (shown at shown_ms).
static void render_at(uint32_t now, const char *banner_agent, uint32_t shown_ms) {
    memset(&F, 0, sizeof F);
    ht_scene_clear(&S, ht_rgb(0xf6f6f0));
    F.scene = &S;
    const pod_unread_t *u = banner_agent ? pod_model_unread_find(&M, banner_agent) : NULL;
    F.banner = u != NULL;
    pod_render(&F, &N, &M, now);
    if (u) {
        int before = S.count;
        pod_banner(&F, &M, u, shown_ms, now);
        if (S.count - before > banner_max) banner_max = S.count - before;
        CHECK(S.count - before <= POD_BANNER_RUNS);
    }
    if (S.count > max_runs) max_runs = S.count;
    CHECK(S.count <= HT_RUNS);
}
static void render_with(uint32_t now, const char *banner_agent) { render_at(now, banner_agent, now); }
static void render(uint32_t now) { render_with(now, NULL); }

static const ht_run_t *find_text(const char *prefix) {
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && !strncmp(S.runs[i].text, prefix, strlen(prefix))) return &S.runs[i];
    return NULL;
}
static const pod_hit_t *find_hit(pod_action_t a) {
    for (int i = F.hit_count - 1; i >= 0; i--) if (F.hits[i].action == a) return &F.hits[i];
    return NULL;
}
static int count_rect(uint16_t ink, int minx, int miny) {
    int n = 0;
    for (int i = 0; i < S.count; i++)
        if ((S.runs[i].pro_kind == K_RECT || S.runs[i].pro_kind == K_RECT_AA) && S.runs[i].fg == ink && S.runs[i].x >= minx && S.runs[i].y >= miny) n++;
    return n;
}
static bool overlap(ht_rect_t a, ht_rect_t b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }

static const char *const NAMES[] = {"firmware-pro", "dial-ota", "backend", "harness-cli", "website", "desktop", "docs", "vault"};
static const char *const ENG[] = {"claude", "claude", "codex", "codex", "muse", "claude", "codex", "cursor"};
static char ids[8][8];
static const char *idp[8];
static const char *const *idl[1];
static uint8_t idn[1] = {8};
static cable_swarm_t sw[1];
static void build(void) {
    pod_model_reset(&M);
    for (int i = 0; i < 8; i++) {
        snprintf(ids[i], 8, "k%d", i);
        idp[i] = ids[i];
        pod_model_agent(&M, ids[i], NAMES[i], ENG[i], "Mac");
    }
    pod_model_agents_end(&M);
    idl[0] = idp;
    memset(sw, 0, sizeof sw);
    snprintf(sw[0].id, SWARM_ID_MAX, "s0");
    snprintf(sw[0].name, CABLE_NAME_MAX, "Firmware");
    sw[0].panes = sw[0].agents = 8;
    pod_model_swarms(&M, sw, (const char *const **)idl, idn, 1, "s0", NULL, 0);
    pod_model_link(&M, true);
    pod_nav_init(&N);
}

static const ht_run_t *find_text_eq(const char *text) {
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && !strcmp(S.runs[i].text, text)) return &S.runs[i];
    return NULL;
}
static const ht_run_t *find_rect(int kind, int w) {
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == kind && S.runs[i].w == w) return &S.runs[i];
    return NULL;
}
static int hits_of(pod_action_t a) {
    int n = 0;
    for (int i = 0; i < F.hit_count; i++) n += F.hits[i].action == a;
    return n;
}

static void test_bell(void) {
    build();
    render(1000);
    const pod_hit_t *h = find_hit(POD_A_INBOX);
    CHECK(h && h->x == 632 && h->y == 0 && h->w == 88 && h->h == 88);   // the bell is always there on Tabs
    CHECK(!find_text_eq("1") && F.unread == 0 && count_rect(CI_BLUE, 500, 0) == 0);   // no pill at 0
    pod_model_unread_add(&M, "k0", "firmware-pro", "Done.", 10, 1000);
    render(1000);
    const ht_run_t *cnt = find_text_eq("1");
    CHECK(cnt && cnt->pro_font == &ci_bd_24 && cnt->fg == ht_rgb(0xffffff) && cnt->y < CI_BAR_H && F.unread == 1 && F.bell_x > 500);
    ht_rect_t pill = {0, 0, 0, 0};
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_RECT_AA && S.runs[i].fg == CI_BLUE && S.runs[i].x > 500 && S.runs[i].y < CI_BAR_H) pill = ht_run_bounds(&S.runs[i]);
    CHECK(pill.w >= 34 && pill.y >= 0 && pill.y + pill.h <= CI_BAR_H && pill.x + pill.w <= POD_W - 16);
    const ht_run_t *title = find_text("Tabs");
    CHECK(title && !overlap(ht_run_bounds(title), pill));
    for (int i = 1; i < 8; i++) pod_model_unread_add(&M, ids[i], NAMES[i], "Done.", 5, 1000 + (uint32_t)i);
    render(1000);
    CHECK(find_text_eq("8") && find_hit(POD_A_INBOX));
    // A long tab name's back label stays clear of the pill.
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    pod_nav_act(&N, &M, POD_A_OPEN_AGENT, 0, 0);
    snprintf(M.tabs[0].name, sizeof M.tabs[0].name, "WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW");
    render(1000);
    h = find_hit(POD_A_BACK);
    CHECK(h && h->w == CI_BACK_W && h->x + h->w <= F.bell_x);
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].y < CI_BAR_H && S.runs[i].x < 173 && S.runs[i].x > 40) CHECK(S.runs[i].x + S.runs[i].w <= 62 + 115 + 2);
    // Not over a recording.
    pod_nav_act(&N, &M, POD_A_TALK, 0, 1000);
    CHECK(N.stack[N.depth - 1].view == POD_V_TALK);
    render(1000);
    CHECK(!find_hit(POD_A_INBOX) && F.unread == 0);
}

// ---- Inbox ---------------------------------------------------------------------------------------------------

static void test_inbox_empty(void) {
    build();
    pod_nav_act(&N, &M, POD_A_INBOX, 0, 0);
    render(1000);
    CHECK(find_text("Inbox") && find_text("Inbox")->y < CI_BAR_H && find_text_eq("0 unread.") && find_text_eq("0 unread") && find_hit(POD_A_BACK));
    CHECK(hits_of(POD_A_OPEN_NOTIF) == 0 && hits_of(POD_A_FOLLOW) == 0);
    CHECK(pod_scroll_pitch(&N) == 143 && pod_scroll_max(&N, &M) == 0);
}

static void test_inbox_heading_and_footer(void) {
    build();
    pod_model_unread_add(&M, "k0", "firmware-pro", "Fixed the cable resync.", 48, 1000);
    pod_model_unread_add(&M, "k2", "backend", "Migration ran.", 20, 2000);
    pod_nav_act(&N, &M, POD_A_INBOX, 0, 0);
    render(5000);
    const ht_run_t *head = find_text_eq("2 unread."), *foot = find_text_eq("2 unread"), *sub = find_text("Open a result to mark that result read.");
    CHECK(head && head->pro_font == &ci_rg_48 && head->y == 113 && head->fg == CI_INK);
    CHECK(sub && sub->pro_font == &ci_rg_24 && sub->fg == CI_MUTED && sub->y == 180);
    CHECK(foot && foot->pro_font == &ci_rg_23 && foot->y > CI_FOOT_Y && foot->fg == CI_MUTED);
    CHECK(find_text("Back") && find_hit(POD_A_INBOX) && F.unread == 2);   // the bell shows the count here too
    // Newest first, 2 lines of recap at most; the rows' hits name their entry.
    int rows = 0;
    for (int i = 0; i < F.hit_count; i++)
        if (F.hits[i].action == POD_A_OPEN_NOTIF) {
            CHECK(F.hits[i].arg == rows && F.hits[i].id[0] && F.hits[i].x == 0 && F.hits[i].w == POD_W);
            rows++;
        }
    CHECK(rows == 2 && !strcmp(find_hit(POD_A_OPEN_NOTIF)->id, "k0"));   // find_hit scans last to first
    const ht_run_t *a = find_text("backend"), *b = find_text("firmware-pro");
    CHECK(a && b && a->pro_font == &ci_rg_33 && a->y < b->y && a->x == 57);
    CHECK(count_rect(CI_BLUE, 0, CI_BAR_H) == 2);   // a blue dot per entry
    CHECK(find_text_eq("New") && find_text_eq("New")->fg == CI_MUTED);
}

static void test_inbox_asking_first(void) {
    build();
    pod_model_question(&M, "k3", "Use the staging key?");
    pod_model_unread_add(&M, "k0", "firmware-pro", "Fixed the cable resync.", 48, 1000);
    pod_model_unread_add(&M, "k2", "backend", "Migration ran.", 20, 2000);
    pod_nav_act(&N, &M, POD_A_INBOX, 0, 0);
    render(5000);
    // The first row is the asking agent's: FOLLOW with its roster index and id, the amber fill, the copy.
    const pod_hit_t *first = NULL;
    for (int i = 0; i < F.hit_count && !first; i++) if (F.hits[i].action == POD_A_FOLLOW || F.hits[i].action == POD_A_OPEN_NOTIF) first = &F.hits[i];
    CHECK(first && first->action == POD_A_FOLLOW && first->y == 234 && first->h == 111 && first->arg == 3 && !strcmp(first->id, "k3"));
    bool fill = false;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == CI_ROW_ASK && S.runs[i].y == 234 && S.runs[i].w == POD_W) fill = true;
    CHECK(fill);
    const ht_run_t *name = find_text("harness-cli"), *copy = find_text("Needs your answer \xc2\xb7 stays until resolved");
    CHECK(name && name->pro_font == &ci_rg_33 && name->y < 234 + 30 && copy && copy->pro_font == &ci_rg_23 && copy->y > name->y);
    bool dot = false;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_RECT_AA && S.runs[i].w == 10 && S.runs[i].pro_height == 10 && S.runs[i].x == CI_MARGIN && S.runs[i].y == 234 + 51) dot = true;
    CHECK(dot);
    // The entries follow, newest first, the first just under the asking row.
    const pod_hit_t *e = NULL;
    for (int i = 0; i < F.hit_count && !e; i++) if (F.hits[i].action == POD_A_OPEN_NOTIF) e = &F.hits[i];
    CHECK(e && e->y == 234 + 111 && e->arg == 0 && !strcmp(e->id, "k2"));
    CHECK(find_text_eq("2 unread.") && find_text_eq("2 unread"));   // the asking agent is not an unread entry
    // Two asking agents, then none: the row goes away with the question.
    pod_model_question(&M, "k4", "Overwrite it?");
    render(5000);
    CHECK(hits_of(POD_A_FOLLOW) == 2);
    pod_model_question_close(&M, "k3");
    pod_model_question_close(&M, "k4");
    render(5000);
    CHECK(hits_of(POD_A_FOLLOW) == 0 && find_hit(POD_A_OPEN_NOTIF) != NULL);
    const pod_hit_t *e2 = NULL;
    for (int i = 0; i < F.hit_count && !e2; i++) if (F.hits[i].action == POD_A_OPEN_NOTIF) e2 = &F.hits[i];
    CHECK(e2 && e2->y == 234);
}

static void test_inbox_failed_entry(void) {
    build();
    pod_model_unread_add(&M, "k0", "firmware-pro", "Fixed the cable resync.", 48, 1000);
    pod_model_unread_add(&M, "k2", "backend", "The migration stopped: a column is missing.", 20, 2000);
    M.unread[0].kind = POD_UNREAD_FAILED;
    CHECK(!strcmp(M.unread[0].agent, "k2"));
    pod_nav_act(&N, &M, POD_A_INBOX, 0, 0);
    render(5000);
    const ht_run_t *failed = find_text_eq("Failed"), *fresh = find_text_eq("New");
    CHECK(failed && failed->fg == CI_FAIL && failed->pro_font == &ci_rg_22 && failed->x + failed->w <= POD_W - CI_MARGIN + 1);
    CHECK(fresh && fresh->fg == CI_MUTED && failed->y < fresh->y);
}

static void test_inbox_scroll(void) {
    build();
    pod_model_unread_add(&M, "k0", "firmware-pro", "Fixed the cable resync. Tests pass on the host and the device, and the frame time is back under forty five milliseconds.", 134, 1000);
    pod_model_unread_add(&M, "k2", "backend", "Migration ran. All tables are in place and the seed data loaded without a single warning in the log.", 20, 61000);
    pod_model_unread_add(&M, "zz", "stranger", "From a machine this roster does not hold.", -1, 62000);   // newest, one line
    pod_nav_act(&N, &M, POD_A_INBOX, 0, 0);
    render(80000);
    int y = 234, rows = 0;
    for (int i = 0; i < F.hit_count; i++)
        if (F.hits[i].action == POD_A_OPEN_NOTIF) {
            CHECK(F.hits[i].y == y && F.hits[i].arg == rows);
            y += F.hits[i].h;
            rows++;
        }
    CHECK(rows == 3 && find_text("stranger") && find_text("backend") && find_text("firmware-pro"));
    CHECK(pod_scroll_max(&N, &M) == 0);
    // Three asking agents and many entries: it scrolls by rows; the last offset shows the last row.
    for (int i = 0; i < 8; i++) pod_model_unread_add(&M, ids[i], NAMES[i], "More words follow here, enough to take two lines of the row.", 3, 70000 + (uint32_t)i);
    for (int i = 0; i < 8; i++) { char id[8]; snprintf(id, sizeof id, "x%d", i); pod_model_unread_add(&M, id, id, "Filler.", 3, 71000 + (uint32_t)i); }
    pod_model_question(&M, "k3", "One?");
    pod_model_question(&M, "k4", "Two?");
    CHECK(M.unread_count == 16);
    const int max = pod_scroll_max(&N, &M);
    CHECK(max > 3 && max <= 17);
    render(80000);
    CHECK(find_text("x7") && !find_text("x0") && hits_of(POD_A_FOLLOW) == 2);
    pod_nav_act(&N, &M, POD_A_SCROLL, max, 0);
    render(80000);
    const pod_hit_t *last = NULL;
    for (int i = 0; i < F.hit_count; i++) if (F.hits[i].action == POD_A_OPEN_NOTIF) last = &F.hits[i];
    CHECK(last && last->arg == 15 && last->y + last->h - 4 <= CI_FOOT_Y && hits_of(POD_A_FOLLOW) == 0);
    pod_nav_act(&N, &M, POD_A_SCROLL, max + 5, 0);   // past the end clamps
    render(80000);
    CHECK(find_hit(POD_A_OPEN_NOTIF) != NULL);
    // Constant run counts across frames (nothing here animates).
    int n0 = 0;
    for (uint32_t t = 80000; t < 80000 + 7000; t += 733) { render(t); if (!n0) n0 = S.count; CHECK(S.count == n0); }
}

// M1: pod_inbox_max_row is the first scroll from which the last row is on the glass (checked against the drawn list), and its value
// holds for a full 16-entry inbox of two-line and of one-line recaps.
static void test_inbox_max_row_matches_drawing(void) {
    for (int pass = 0; pass < 2; pass++) {
        build();
        for (int i = 0; i < 16; i++) {
            char id[8]; snprintf(id, sizeof id, "q%d", i);
            pod_model_unread_add(&M, id, id, pass ? "A short result." : "A longer result that wraps onto a second line of the row so it is taller.", 3, 1000 + (uint32_t)i);
        }
        CHECK(M.unread_count == 16);
        pod_nav_act(&N, &M, POD_A_INBOX, 0, 0);
        const int max = pod_inbox_max_row(&M);
        CHECK(max == (pass ? 13 : 14));   // 143 px rows: two fit above the footer; 112 px rows: three
        int first_visible = -1;
        for (int s = 0; s <= 16 && first_visible < 0; s++) {
            render(5000);   // the scroll is relative: one row down per pass
            const pod_hit_t *last = NULL;
            for (int i = 0; i < F.hit_count; i++) if (F.hits[i].action == POD_A_OPEN_NOTIF) last = &F.hits[i];
            if (last && last->arg == 15) first_visible = s;
            pod_nav_act(&N, &M, POD_A_SCROLL, 1, 0);
        }
        CHECK(first_visible == max);
        CHECK(pod_scroll_max(&N, &M) == max);
    }
}

// ---- the banner ----------------------------------------------------------------------------------------------

static const char *LONG = "Fixed the cable resync. Tests pass on the host and the device, frame time back under 45 ms, and the long summary goes on well past two lines of the card.";

static void test_banner(void) {
    build();
    pod_model_unread_add(&M, "k0", "firmware-pro", LONG, 134, 5000);
    render_with(5000, "k0");
    const pod_hit_t *h = find_hit(POD_A_BANNER);
    CHECK(h && h->x == 16 && h->y == 98 && h->w == 688 && h->h == 217 && !strcmp(h->id, "k0"));
    CHECK(F.hits[F.hit_count - 1].action == POD_A_BANNER_CLOSE && F.hits[F.hit_count - 2].action == POD_A_BANNER);   // the x is on top
    const pod_hit_t *x = find_hit(POD_A_BANNER_CLOSE);
    CHECK(x->w == 65 && x->h == 65 && x->x + x->w == 704 && x->y == 98 && !strcmp(x->id, "k0"));
    // Everything of the card sits inside its margins and above its bottom edge.
    int card = -1;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_STROKE && S.runs[i].w == 688 && S.runs[i].y == 98) card = i;
    CHECK(card > 0);
    CHECK(S.runs[card].fg == ht_rgb(0xa6b9a9) && S.runs[card].radius == 10);
    for (int i = card; i < S.count; i++) {
        ht_rect_t b = ht_run_bounds(&S.runs[i]);
        CHECK(b.x >= 16 && b.x + b.w <= 704 && b.y >= 98 && b.y + b.h <= h->y + h->h);
    }
    const ht_run_t *name = find_text("firmware-pro"), *done = find_text("Done"), *cross = find_text("\xc3\x97");
    CHECK(name && name->pro_font == &ci_rg_33 && name->fg == CI_INK && name->x == 110);
    CHECK(cross && cross->pro_font == &ci_rg_41 && cross->x > 630 && cross->y < 98 + 65);
    CHECK(done && done->fg == CI_GREEN && done->pro_font == &ci_rg_23 && !strcmp(done->text, "Done \xc2\xb7 2m 14s"));
    const ht_run_t *r1 = find_text("Fixed the cable"), *r2 = NULL;
    for (int i = 0; i < S.count; i++) if (&S.runs[i] != r1 && S.runs[i].pro_kind == K_TEXT && S.runs[i].fg == ht_rgb(0x3d4a4e)) r2 = &S.runs[i];
    CHECK(r1 && r2 && r1->pro_font == &ci_rg_24 && r1->fg == ht_rgb(0x3d4a4e) && r2->y == r1->y + 33 && strstr(r2->text, "\xe2\x80\xa6"));   // two lines, the second cut
    CHECK(name->y < r1->y && r2->y < done->y);
    const int tall = h->h;
    // A short recap with no elapsed time: one line, a bare "Done", a shorter card.
    pod_model_unread_add(&M, "k1", "dial-ota", "Fast fix.", -1, 5000);
    render_with(5000, "k1");
    CHECK(find_text_eq("Done") && find_hit(POD_A_BANNER)->h == tall - 33);
    // Every engine's mark (a pale one rides on a dark chip, an unknown one is the default mark) and a stranger stay within POD_BANNER_RUNS.
    for (int i = 0; i < 8; i++) { pod_model_unread_add(&M, ids[i], NAMES[i], LONG, 134, 5000); render_with(5000, ids[i]); }
    pod_model_unread_add(&M, "zz", "stranger", LONG, 134, 5000);
    render_with(5000, "zz");
    CHECK(find_text_eq("stranger"));
    // It covers whatever is under it: a Tab list's first rows; its hits come last.
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    render_with(5000, "k0");
    CHECK(F.hits[F.hit_count - 1].action == POD_A_BANNER_CLOSE && find_hit(POD_A_OPEN_AGENT) != NULL);
}

static void test_banner_timer_width(void) {
    build();
    pod_model_unread_add(&M, "k0", "firmware-pro", LONG, 134, 5000);
    const uint32_t shown = 5000;
    const int want[3] = {688, 344, 11};
    const uint32_t at[3] = {0, 3000, 5900};
    for (int k = 0; k < 3; k++) {
        render_at(shown + at[k], "k0", shown);
        const ht_run_t *line = NULL;
        for (int i = 0; i < S.count; i++)
            if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == CI_BLUE && S.runs[i].pro_height == 6 && S.runs[i].y == 98 + 217 - 7) line = &S.runs[i];
        CHECK(line && line->x == 16 && line->w == want[k]);
    }
    // At the end the line is gone (the glue closes the banner); the card still draws. Before the start it clamps to full.
    render_at(shown + 6000, "k0", shown);
    for (int i = 0; i < S.count; i++) CHECK(!(S.runs[i].pro_kind == K_RECT && S.runs[i].fg == CI_BLUE && S.runs[i].pro_height == 6 && S.runs[i].y > 300));
    CHECK(find_hit(POD_A_BANNER) != NULL);
    render_at(shown - 50, "k0", shown);
    const ht_run_t *line = NULL;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == CI_BLUE && S.runs[i].pro_height == 6 && S.runs[i].y == 98 + 217 - 7) line = &S.runs[i];
    CHECK(line && line->w == 688);
}

static void test_banner_done_and_failed_lines(void) {
    build();
    pod_model_unread_add(&M, "k0", "firmware-pro", "All good.", 48, 5000);
    render_with(5000, "k0");
    const ht_run_t *done = find_text("Done");
    CHECK(done && !strcmp(done->text, "Done \xc2\xb7 0m 48s") && done->fg == CI_GREEN);
    int ticks = 0;   // the tick is green strokes left of the text
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind != K_TEXT && S.runs[i].fg == CI_GREEN && S.runs[i].x < done->x) ticks++;
    CHECK(ticks > 0);
    M.unread[0].kind = POD_UNREAD_FAILED;
    render_with(5000, "k0");
    const ht_run_t *failed = find_text("Failed");
    CHECK(failed && !strcmp(failed->text, "Failed \xc2\xb7 0m 48s") && failed->fg == CI_FAIL && !find_text("Done"));
    for (int i = 0; i < S.count; i++) CHECK(!(S.runs[i].pro_kind != K_TEXT && S.runs[i].fg == CI_GREEN));   // no tick on a failure
    M.unread[0].elapsed_s = -1;
    render_with(5000, "k0");
    CHECK(find_text_eq("Failed"));
    M.unread[0].kind = POD_UNREAD_FINISHED;
    render_with(5000, "k0");
    CHECK(find_text_eq("Done"));
    M.unread[0].elapsed_s = 3725;
    render_with(5000, "k0");
    CHECK(find_text_eq("Done \xc2\xb7 1h 02m"));
}

static void test_banner_close_first_frame(void) {
    build();
    pod_model_unread_add(&M, "k0", "firmware-pro", LONG, 134, 5000);
    // The very first frame (shown == now), over Tabs and over a Tab list: the x is already there, on top of the card.
    for (int k = 0; k < 2; k++) {
        if (k) pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
        render_at(7000, "k0", 7000);
        const pod_hit_t *x = find_hit(POD_A_BANNER_CLOSE);
        CHECK(x && x == &F.hits[F.hit_count - 1] && x->x == 639 && x->y == 98 && x->w == 65 && x->h == 65);
        CHECK(F.hits[F.hit_count - 2].action == POD_A_BANNER);
    }
    // While the grid is dragged, too.
    pod_nav_init(&N);
    memset(&F, 0, sizeof F);
    ht_scene_clear(&S, CI_GROUND);
    F.scene = &S;
    F.tabs_moving = true;
    F.tabs_off = 200;
    F.banner = true;
    pod_render(&F, &N, &M, 7000);
    pod_banner(&F, &M, pod_model_unread_find(&M, "k0"), 7000, 7000);
    CHECK(F.hits[F.hit_count - 1].action == POD_A_BANNER_CLOSE);
}

// ---- misc: Voice, Update, Connection lost ------------------------------------------------------------------

static void to_talk(void) {
    pod_nav_init(&N);
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    pod_nav_act(&N, &M, POD_A_OPEN_AGENT, 0, 0);
    pod_nav_act(&N, &M, POD_A_TALK, 0, 1000);
    CHECK(N.stack[N.depth - 1].view == POD_V_TALK);
}

static void test_talk_listen_fullscreen_hit(void) {
    build();
    to_talk();
    render(1500);
    CHECK(hits_of(POD_A_TALK) == 1);
    const pod_hit_t *t = find_hit(POD_A_TALK);
    CHECK(t->x == 0 && t->y == 88 && t->w == 720 && t->h == 632);
    const pod_hit_t *b = find_hit(POD_A_BACK);
    CHECK(b && b->x == 0 && b->y == 0 && b->w == CI_BACK_W && b->h == CI_BAR_H && !overlap((ht_rect_t){b->x, b->y, b->w, b->h}, (ht_rect_t){t->x, t->y, t->w, t->h}));
    CHECK(find_text_eq("Voice") && find_text_eq("Listening.") && find_text("Listening.")->pro_font == &ci_rg_48);
    CHECK(find_text_eq("Tap to send.") && find_text("Tap to send.")->pro_font == &ci_rg_24 && find_text("Tap to send.")->fg == CI_MUTED);
    const ht_run_t *to = find_text_eq("To "), *who = find_text("firmware-pro");
    CHECK(to && to->pro_font == &ci_rg_23 && who && who->pro_font == &ci_bd_23 && who->x == to->x + ht_pro_width(&ci_rg_23, "To "));
    // 13 wave bars, 5 px wide, in #2c6e64; louder means taller.
    for (int level = 0; level <= 4; level += 4) {
        memset(&F, 0, sizeof F);
        ht_scene_clear(&S, CI_GROUND);
        F.scene = &S;
        F.mic_level = level;
        pod_render(&F, &N, &M, 1500);
        int bars = 0, tallest = 0;
        for (int i = 0; i < S.count; i++)
            if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ht_rgb(0x2c6e64) && S.runs[i].w == 5) { bars++; if (S.runs[i].pro_height > tallest) tallest = S.runs[i].pro_height; }
        CHECK(bars == 13);
        CHECK(level == 0 ? tallest == 7 : tallest >= 20);
    }
    // The listening pet sits on the ground, not on white.
    CHECK(S.count <= POD_CLASSIC_RUNS);
}

static void test_talk_no_bell_no_buttons(void) {
    build();
    for (int i = 0; i < 3; i++) pod_model_unread_add(&M, ids[i], NAMES[i], "Done.", 5, 1000 + (uint32_t)i);
    to_talk();
    render(1500);
    CHECK(F.unread == 0 && F.bell_x == 0 && !find_hit(POD_A_INBOX) && !find_text_eq("3"));
    CHECK(F.hit_count == 2 && find_hit(POD_A_BACK) && find_hit(POD_A_TALK));   // nothing else: no transport
    CHECK(!find_hit(POD_A_PREV) && !find_hit(POD_A_NEXT) && !find_hit(POD_A_TABS) && !find_hit(POD_A_PANES));
    CHECK(!find_text_eq("Talk"));
    for (int i = 0; i < S.count; i++) CHECK(S.runs[i].pro_kind != K_RECT_AA || S.runs[i].y < CI_TRANS_Y);   // no button below
    // Sending: still no bell, only Back.
    pod_nav_act(&N, &M, POD_A_TALK, 0, 2000);
    CHECK(N.sending);
    render(2500);
    CHECK(F.unread == 0 && !find_hit(POD_A_INBOX) && !find_hit(POD_A_TALK) && F.hit_count == 1 && find_hit(POD_A_BACK));
}

static void test_talk_sending_copy(void) {
    build();
    to_talk();
    pod_nav_act(&N, &M, POD_A_TALK, 0, 2000);
    render(2600);
    CHECK(find_text_eq("Message"));
    const ht_run_t *head = find_text_eq("Sending your words\xe2\x80\xa6"), *who = find_text_eq("firmware-pro"), *note = find_text("One request is pending.");
    CHECK(head && head->pro_font == &ci_bd_45 && head->fg == CI_INK);
    CHECK(who && who->pro_font == &ci_rg_30 && who->fg == CI_MUTED && who->y > head->y);
    CHECK(note && note->pro_font == &ci_rg_26 && note->fg == CI_MUTED && note->y > who->y);
    int lines = 0;
    char joined[160] = "";
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ci_rg_26 && S.runs[i].y > CI_BAR_H) {   // the bar's Back label is 26 too
            CHECK(S.runs[i].w <= 583 && S.runs[i].x >= (POD_W - 583) / 2 - 1);
            if (lines++) strncat(joined, " ", sizeof joined - strlen(joined) - 1);
            strncat(joined, S.runs[i].text, sizeof joined - strlen(joined) - 1);
        }
    // where it breaks depends on the face (two lines in Helvetica, three in Liberation); the whole note shows, uncut
    CHECK(lines >= 2 && lines <= 3 && !strcmp(joined, "One request is pending. Going back will not send it again."));
    CHECK(!find_text_eq("Listening.") && !find_text_eq("Tap to send."));
}

static void render_ota(int pct, bool restarting) {
    memset(&F, 0, sizeof F);
    ht_scene_clear(&S, CI_GROUND);
    F.scene = &S;
    pod_view_ota(&F, "0.1.2", "0.1.3", pct, restarting);
    CHECK(S.count <= POD_CLASSIC_RUNS);
}
// The CSS line box's top of a text cell at r->y: the baseline is where a 1.117 em content area centred in the box puts it.
static int css_top(const ht_run_t *r, int box_h, int size) { return r->y - ((box_h * 1000 - 1117 * size) / 2000 + (905 * size + 500) / 1000 - size); }

static void test_ota_even_gaps(void) {
    for (int pct = 0; pct <= 100; pct += 62) {
        render_ota(pct, false);
        const ht_run_t *circle = find_rect(K_STROKE, 86), *bar = find_rect(K_STROKE, 446);
        const ht_run_t *eyebrow = find_text_eq("HARNESS PRO"), *title = find_text("Updating to"), *n1 = find_text("Keep the cable"), *n2 = find_text("when it is done.");
        CHECK(circle && bar && eyebrow && title && n1 && n2 && F.hit_count == 0);
        CHECK(!strcmp(title->text, "Updating to 0.1.3") && title->pro_font == &ci_bd_45 && eyebrow->pro_font == &ci_rg_20);
        const int top[5] = {circle->y, css_top(eyebrow, 26, 20), css_top(title, 50, 45), bar->y, css_top(n1, 36, 26)};
        const int bot[5] = {circle->y + 86, css_top(eyebrow, 26, 20) + 26, css_top(title, 50, 45) + 50, bar->y + 10, css_top(n2, 36, 26) + 36};
        for (int i = 1; i < 5; i++) CHECK(top[i] - bot[i - 1] >= 21 && top[i] - bot[i - 1] <= 23);
        CHECK(top[0] - CI_BAR_H >= CI_FOOT_Y - bot[4] - 1 && top[0] - CI_BAR_H <= CI_FOOT_Y - bot[4] + 1);   // centred between the bar and the footer
        CHECK(bar->x == 137 && bar->pro_height == 10 && n1->pro_font == &ci_rg_26);
        CHECK(find_text_eq("Update") && find_text_eq("Downloading"));
        char p[8];
        snprintf(p, sizeof p, "%d%%", pct);
        CHECK(find_text_eq(p) && find_text_eq(p)->y > CI_FOOT_Y);
    }
}

static void test_ota_restarting(void) {
    render_ota(100, true);
    CHECK(find_text_eq("Restarting\xe2\x80\xa6") && find_text_eq("Restarting\xe2\x80\xa6")->pro_font == &ci_bd_45);
    CHECK(!find_text("Updating to") && find_text_eq("RESTARTING") && !find_text_eq("100%") && F.hit_count == 0);
    CHECK(find_text("Keep the cable") && find_text_eq("Downloading"));
    // Same layout as the download screen: the circle, the bar (full) and the note keep their places.
    const ht_run_t *circle = find_rect(K_STROKE, 86), *bar = find_rect(K_STROKE, 446);
    CHECK(circle && bar);
    const int cy = circle->y, by = bar->y;
    render_ota(40, false);
    CHECK(find_rect(K_STROKE, 86)->y == cy && find_rect(K_STROKE, 446)->y == by);
    // The title with no version: "Updating to " alone does not break.
    memset(&F, 0, sizeof F);
    ht_scene_clear(&S, CI_GROUND);
    F.scene = &S;
    pod_view_ota(&F, NULL, NULL, -5, false);
    CHECK(find_text("Updating to") && find_text_eq("0%"));
}

static void test_link_down_shows_connection_lost(void) {
    build();
    pod_model_unread_add(&M, "k0", "firmware-pro", "Done.", 5, 1000);
    pod_model_unread_add(&M, "k2", "backend", "Done.", 5, 1000);
    to_talk();
    pod_model_link(&M, false);
    const pod_out_t o = pod_nav_sync(&N, &M);   // the model keeps its roster: the stack stays and the screen comes back with the link
    CHECK(o.fx == POD_FX_NONE && N.stack[N.depth - 1].view == POD_V_TALK);
    render(3000);
    CHECK(find_text_eq("Connection lost.") && find_text("Connection lost.")->pro_font == &ci_rg_43);
    CHECK(find_text_eq("Live status is unavailable.") && find_text_eq("Your saved results and unread marks remain."));
    CHECK(find_text_eq("Disconnected") && find_text_eq("Disconnected")->y > CI_FOOT_Y && find_text_eq("Connection") && find_text_eq("Harness"));
    char cnt[8];
    snprintf(cnt, sizeof cnt, "%d", M.unread_count);
    CHECK(M.unread_count > 0 && find_text_eq(cnt) && F.hit_count == 0 && !find_hit(POD_A_TALK));   // the bell shows the count, nothing is live
    CHECK(!find_text_eq("Listening."));
    // Not on Voice only: over Tabs and the Inbox as well, and the Tabs return with the link.
    pod_nav_init(&N);
    render(3000);
    CHECK(find_text_eq("Connection lost.") && F.hit_count == 0);
    pod_nav_act(&N, &M, POD_A_INBOX, 0, 0);
    render(3000);
    CHECK(find_text_eq("Connection lost.") && !find_text("0 unread") && !find_text("1 unread"));
    pod_model_link(&M, true);
    pod_nav_init(&N);
    render(3000);
    CHECK(!find_text_eq("Connection lost.") && find_text_eq("Tabs") && find_hit(POD_A_INBOX));
}

// The busiest screens with the bell and the banner on top: within HT_RUNS, and the same count at every animation frame.
static void test_budget(void) {
    build();
    for (int i = 0; i < 8; i++) pod_model_turn(&M, ids[i], "started", NULL, 0, 10);
    pod_model_turn(&M, "k0", "activity", "Editing touch_gt911.c \xe2\x80\x94 turning the touch the same way as the panel", 134, 10);
    pod_model_turn(&M, "k0", "step", "Read \xc2\xb7 pod_glue.c", 134, 10);
    pod_model_turn(&M, "k0", "step", "Edit \xc2\xb7 pod_nav.c", 134, 10);
    pod_model_question(&M, "k2", "Run the migration on the dev database now? It touches every table in the schema.");
    pod_model_turn(&M, "k5", "done", NULL, 0, 20);
    pod_model_recap(&M, "k5", "The Relaxing chip now follows Rest until you pick a row for it. Rest reads Idle, so the two are not confused. All 54 pet settings tests pass. Nothing is committed yet. More words follow here so the Recap screen scrolls past its first page and fills every row it has.", false);
    for (int i = 0; i < 16; i++) {
        char id[8], text[64];
        snprintf(id, sizeof id, i < 8 ? "k%d" : "x%d", i);
        snprintf(text, sizeof text, "Summary number %d, with some words.", i);
        pod_model_unread_add(&M, id, NAMES[i % 8], text, 60 + i, 5000 + (uint32_t)i);
    }
    const char *banner_for = "k3";
    for (int s = 0; s < 8; s++) {
        pod_nav_init(&N);
        switch (s) {
        case 0: break;                                                          // Tabs
        case 1: pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0); break;               // a tab of 8 rows
        case 2: pod_nav_act(&N, &M, POD_A_OPEN_TAB, POD_TAB_RECENT, 0); break;  // Recent
        case 3: pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0); pod_nav_act(&N, &M, POD_A_OPEN_AGENT, 0, 0); break;   // working, with steps
        case 4: pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0); pod_nav_act(&N, &M, POD_A_OPEN_AGENT, 2, 0); break;   // asking
        case 5: pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0); pod_nav_act(&N, &M, POD_A_OPEN_AGENT, 5, 0); break;   // a long recap
        case 6: pod_nav_act(&N, &M, POD_A_INBOX, 0, 0); break;                  // the Inbox, 7 rows
        case 7: pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0); pod_nav_act(&N, &M, POD_A_OPEN_AGENT, 0, 0); pod_nav_act(&N, &M, POD_A_TALK, 0, 0); break;
        }
        int first = -1, firstb = -1;
        for (uint32_t t = 20000; t < 20000 + 4000; t += 130) {
            render(t);
            if (first < 0) first = S.count;
            CHECK(S.count == first || s == 3 || s == 4 || s == 5 || s == 7);   // pets and the clocks animate runs on some screens
            render_with(t, banner_for);
            bool talking = N.stack[N.depth - 1].view == POD_V_TALK;
            if (!talking) {   // the glue never draws the banner over a recording; the budget still holds if it did
                if (firstb < 0) firstb = S.count;
                CHECK(S.count == firstb || s == 3 || s == 4 || s == 5);
            }
        }
    }
}

// The Tabs grid picks its detail by what fits: with the bell and the banner it must still fit (and drop detail, not runs).
static void test_budget_tabs(void) {
    build();
    cable_swarm_t many[12];
    const char *const *lists[12];
    uint8_t counts[12];
    memset(many, 0, sizeof many);
    for (int i = 0; i < 12; i++) {
        snprintf(many[i].id, SWARM_ID_MAX, "m%d", i);
        snprintf(many[i].name, CABLE_NAME_MAX, "Tab number %d", i);
        many[i].panes = many[i].agents = 8;
        lists[i] = idp;
        counts[i] = 8;
    }
    pod_model_swarms(&M, many, lists, counts, 12, "m0", NULL, 0);
    for (int i = 0; i < 8; i++) pod_model_turn(&M, ids[i], "started", NULL, 0, 10);
    for (int i = 0; i < 8; i++) pod_model_unread_add(&M, ids[i], NAMES[i], "Done.", 5, 5000 + (uint32_t)i);
    for (int page = 0; page < 3; page++) {
        pod_nav_init(&N);
        pod_nav_act(&N, &M, POD_A_SCROLL, page * 2, 0);
        for (uint32_t t = 20000; t < 21200; t += 300) { render(t); render_with(t, "k3"); }
    }
}

int main(void) {
    test_bell();
    test_inbox_empty();
    test_inbox_heading_and_footer();
    test_inbox_asking_first();
    test_inbox_failed_entry();
    test_inbox_scroll();
    test_inbox_max_row_matches_drawing();
    test_banner();
    test_banner_timer_width();
    test_banner_done_and_failed_lines();
    test_banner_close_first_frame();
    test_talk_listen_fullscreen_hit();
    test_talk_no_bell_no_buttons();
    test_talk_sending_copy();
    test_ota_even_gaps();
    test_ota_restarting();
    test_link_down_shows_connection_lost();
    test_budget();
    test_budget_tabs();
    printf("test_pod_views_inbox: %d checks ok (most runs with the bell and a banner: %d of %d; the banner adds at most %d of %d)\n", checks, max_runs, POD_CLASSIC_RUNS, banner_max, POD_BANNER_RUNS);
    return 0;
}
