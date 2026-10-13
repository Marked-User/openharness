// Console views and chrome (cs_*.c): the command bar, logos, the working mark, every screen's layout and the run counter.
#include <assert.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#include "pod/console/cs.h"
#include "pod/pod_nav.h"
#include "pod/pod_view_shared.h"
#include "pro_canvas.h"

static int checks;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #c); abort(); } checks++; } while (0)
enum { K_TEXT = 1, K_RECT = 2, K_RECT_AA = 4, K_RECT_STROKE = 5 };
static int texts(const char *t);

static ht_scene_t S;
static pod_out_frame_t F;
static void fresh(void) { memset(&F, 0, sizeof F); ht_scene_clear(&S, ht_rgb(CS_GROUND)); F.scene = &S; }
static const ht_run_t *text_run(const char *t) {
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && !strcmp(S.runs[i].text, t)) return &S.runs[i];
    return NULL;
}
static const ht_run_t *text_prefix(const char *p) { for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && !strncmp(S.runs[i].text, p, strlen(p))) return &S.runs[i]; return NULL; }
static int texts(const char *t) { int n = 0; for (int i = 0; i < S.count; i++) n += S.runs[i].pro_kind == K_TEXT && !strcmp(S.runs[i].text, t); return n; }
static const pod_hit_t *nth_hit(pod_action_t a, int n) { for (int i = 0; i < F.hit_count; i++) if (F.hits[i].action == a && n-- == 0) return &F.hits[i]; return NULL; }
static int hits_of(pod_action_t a) { int n = 0; for (int i = 0; i < F.hit_count; i++) n += F.hits[i].action == a; return n; }

int main(void) {
    const char *crumbs[] = {"Overview", "Backend"};
    fresh();
    cs_bar(&F, crumbs, 2, 6, 0, 0, NULL, 0);
    CHECK(hits_of(POD_A_BACK) == 1);
    const ht_run_t *ov = text_run("Overview");
    CHECK(ov);
    for (int i = 0; i < F.hit_count; i++)
        if (F.hits[i].action == POD_A_BACK) {
            CHECK(F.hits[i].arg == 1);
            CHECK(F.hits[i].x <= ov->x && F.hits[i].x + F.hits[i].w >= ov->x + ov->w);
        }
    const ht_run_t *cur = text_run("Backend");
    CHECK(cur);
    for (int i = 0; i < F.hit_count; i++) CHECK(!(F.hits[i].x < cur->x && F.hits[i].x + F.hits[i].w > cur->x + cur->w && F.hits[i].action == POD_A_BACK));
    CHECK(hits_of(POD_A_ATTENTION) == 0);          // asking == 0: no chip
    CHECK(S.runs[0].fg == ht_rgb(CS_GROUND));

    fresh();
    cs_bar(&F, crumbs, 2, 6, 2, 0, NULL, 0);
    CHECK(hits_of(POD_A_ATTENTION) == 1 && text_run("\xe2\x96\xb2 2"));

    // the bell chip (v3): the unread count left of the ▲ chip, a POD_A_INBOX hit; none at 0
    fresh();
    cs_bar(&F, crumbs, 2, 6, 0, 3, NULL, 0);
    CHECK(hits_of(POD_A_INBOX) == 1 && text_run("3") && nth_hit(POD_A_INBOX, 0)->arg == 0);
    { const ht_run_t *n3 = text_run("3"); CHECK(n3->pro_font == &cs_mono_18); }
    fresh();
    cs_bar(&F, crumbs, 2, 6, 0, 0, NULL, 0);
    CHECK(hits_of(POD_A_INBOX) == 0);
    fresh();
    cs_bar(&F, crumbs, 2, 6, 2, 5, NULL, 0);
    {   // bell left of the ▲ chip, both hits live, no overlap
        const pod_hit_t *b = nth_hit(POD_A_INBOX, 0), *a = nth_hit(POD_A_ATTENTION, 0);
        CHECK(b && a && b->x + b->w <= a->x && text_run("5") && text_run("\xe2\x96\xb2 2"));
    }
    fresh();
    cs_bar(&F, crumbs, 2, 6, 0, 3, "hi", 0);   // the voice bar never shows the bell
    CHECK(hits_of(POD_A_INBOX) == 0 && !text_run("3"));
    {   // v3b B: the bar's running count is led by the animated working mark (4 bars, 4 px wide, 2 px gaps, as tall as the 18 px bell), not a dot
        int hmin = 99, hmax = 0;
        for (uint32_t t = 0; t < 1800; t += 30) {
            fresh();
            cs_bar(&F, crumbs, 2, 3, 0, 0, NULL, t);
            const ht_run_t *bar[4];
            int nb = 0, green_dots = 0;
            for (int i = 0; i < S.count; i++) {
                const ht_run_t *r = &S.runs[i];
                if (r->pro_kind == K_RECT && r->fg == ht_rgb(CS_RUN) && r->y < CS_BAR_H) { if (nb < 4) bar[nb] = r; nb++; }
                green_dots += r->pro_kind == K_RECT_AA && r->fg == ht_rgb(CS_RUN);
            }
            CHECK(nb == 4 && green_dots == 0);
            for (int i = 0; i < 4; i++) {
                CHECK(bar[i]->w == 4 && bar[i]->x == bar[0]->x + i * 6);
                CHECK(bar[i]->y + bar[i]->pro_height == 45 && bar[i]->y >= 27 && bar[i]->pro_height <= 18);   // the bell's 18 px band (cy 36 -/+ 9)
                if (bar[i]->pro_height < hmin) hmin = bar[i]->pro_height;
                if (bar[i]->pro_height > hmax) hmax = bar[i]->pro_height;
            }
            const ht_run_t *cnt = text_run("3");   // the count follows the mark
            CHECK(cnt && cnt->x >= bar[3]->x + bar[3]->w && cnt->fg == ht_rgb(CS_MUTED));
        }
        CHECK(hmin >= 7 && hmin <= 8 && hmax >= 17);
        // it moves with now_ms
        fresh(); cs_bar(&F, crumbs, 2, 3, 0, 0, NULL, 0);
        int h0[4], k = 0;
        for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ht_rgb(CS_RUN)) h0[k++] = S.runs[i].pro_height;
        fresh(); cs_bar(&F, crumbs, 2, 3, 0, 0, NULL, 450);
        int moved = 0; k = 0;
        for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ht_rgb(CS_RUN)) moved += S.runs[i].pro_height != h0[k++];
        CHECK(moved >= 3);
        // nobody runs: no mark, no "0"
        fresh(); cs_bar(&F, crumbs, 2, 0, 0, 0, NULL, 0);
        CHECK(!text_run("0"));
        for (int i = 0; i < S.count; i++) CHECK(S.runs[i].fg != ht_rgb(CS_RUN));
        // with the voice input too (its bar shows the count)
        fresh(); cs_bar(&F, crumbs, 2, 2, 0, 0, "hi", 0);
        k = 0; for (int i = 0; i < S.count; i++) k += S.runs[i].pro_kind == K_RECT && S.runs[i].w == 4 && S.runs[i].fg == ht_rgb(CS_RUN);
        CHECK(k == 4 && text_run("2"));
    }
    {   // v3b C: the chips' hits span the whole bar and reach 12 px past the chip; the two never overlap; chips win over crumbs
        const char *longc[] = {"Overview", "marketing-site-redesign-with-long-name"};
        for (int both = 0; both < 2; both++) {
            fresh();
            cs_bar(&F, longc, 2, 12, both ? 9 : 0, 5, NULL, 0);
            const ht_run_t *chip = NULL, *ask = NULL;
            for (int i = 0; i < S.count; i++) {
                if (S.runs[i].pro_kind == K_RECT_STROKE && S.runs[i].pro_height == 30) chip = &S.runs[i];
                if (S.runs[i].pro_kind == K_RECT_AA && S.runs[i].fg == ht_rgb(CS_ASK)) ask = &S.runs[i];
            }
            const pod_hit_t *b = nth_hit(POD_A_INBOX, 0), *a = nth_hit(POD_A_ATTENTION, 0);
            CHECK(chip && b && b->y == 0 && b->h == CS_BAR_H && b->x == chip->x - 12);
            if (both) {
                CHECK(ask && a && a->y == 0 && a->h == CS_BAR_H && a->x + 12 <= ask->x + 4 && a->x >= b->x + b->w && b->x + b->w >= chip->x + chip->w + 8);
                CHECK(a->x + a->w >= ask->x + ask->w + 12);
            } else {
                CHECK(!a && b->x + b->w == chip->x + chip->w + 12);
            }
            // the topmost hit at each edge of a chip's zone is the chip's (the later hit is drawn on top)
            for (int e = 0; e < 2 + 2 * both; e++) {
                const pod_hit_t *h = e < 2 ? b : a;
                int px = (e & 1) ? h->x + h->w - 1 : h->x, py = (e & 1) ? 5 : 66;
                const pod_hit_t *top = NULL;
                for (int i = (int)F.hit_count - 1; i >= 0 && !top; i--)
                    if (px >= F.hits[i].x && px < F.hits[i].x + F.hits[i].w && py >= F.hits[i].y && py < F.hits[i].y + F.hits[i].h) top = &F.hits[i];
                CHECK(top && top->action == (e < 2 ? POD_A_INBOX : POD_A_ATTENTION));
            }
        }
    }
    {   // a 39-byte crumb with both chips: the crumb is cut, no chip run clips (x + w <= 704)
        const char *longc[] = {"Overview", "marketing-site-redesign-with-long-name"};
        fresh();
        cs_bar(&F, longc, 2, 12, 9, 99, NULL, 0);
        CHECK(text_run("\xe2\x96\xb2 9") && text_run("99") && text_run("12"));
        const ht_run_t *c = NULL;
        for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &cs_sb_26) c = &S.runs[i];
        const ht_run_t *an = text_run("\xe2\x96\xb2 9"), *bn = text_run("99"), *rn = text_run("12");
        CHECK(c && c->x + c->w <= bn->x && bn->x + bn->w <= an->x && rn->x + rn->w <= bn->x);
        CHECK(an->x + an->w <= 704 && bn->x + bn->w <= 704);
    }
    {   // Talk: the agent chip in the 26 px semibold, whole, up to the caret
        const char *tc[] = {"firmware-pro"};
        fresh();
        cs_bar(&F, tc, 1, 1, 0, 0, "", 0);
        const ht_run_t *r = text_run("firmware-pro");
        CHECK(r && r->pro_font == &cs_sb_26);
    }

    fresh();
    cs_bar(&F, crumbs, 2, 1, 0, 0, "make the", 0);
    CHECK(hits_of(POD_A_BACK) == 0);
    CHECK(S.runs[0].pro_kind == K_RECT && S.runs[0].fg == ht_rgb(CS_VOICE_BAR));
    CHECK(text_run("make the") && text_run("Backend"));

    fresh();
    cs_badge(&S, 10, 10, "claude");
    CHECK(text_run("CL"));
    cs_badge(&S, 50, 10, "zed");
    CHECK(text_run("ZE"));
    // cs_logo: a baked size is one image run (the logo's own pixels); no logo or an unbaked size falls back to a badge of that size
    fresh();
    CHECK(cs_logo(&S, 10, 10, 36, "claude") && S.count == 1 && S.runs[0].w == 36 && S.runs[0].bitmap.pixels == pod_logo_find("claude", 36)->px);
    fresh();
    CHECK(!cs_logo(&S, 10, 10, 44, "nosuchengine") && text_run("NO"));
    CHECK(S.runs[0].pro_kind == K_RECT_AA && S.runs[0].w == 44);
    fresh();
    CHECK(!cs_logo(&S, 10, 10, 40, "claude") && text_run("CL") && S.runs[0].w == 40);   // 40 is not baked

    cs_dot(&S, 100, 100, 'q', 0);
    CHECK(S.runs[S.count - 1].pro_kind == K_RECT_AA && S.runs[S.count - 1].fg == ht_rgb(CS_ASK));

    // the working mark: four 5 px bars, 2 px gaps (26 px wide), anchored at the bottom of a 22 px box, each 40..100 % tall, moving with the clock
    {
        int hmin = 99, hmax = 0;
        for (uint32_t t = 0; t < 1800; t += 30) {
            fresh();
            cs_working_mark(&S, 100, 200, t);
            CHECK(S.count == 4);
            for (int i = 0; i < 4; i++) {
                const ht_run_t *r = &S.runs[i];
                CHECK(r->pro_kind == K_RECT && r->w == 5 && r->x == 100 + i * 7 && r->fg == ht_rgb(CS_RUN));
                CHECK(r->y + r->pro_height == 222 && r->pro_height >= 8 && r->pro_height <= 22);
                if (r->pro_height < hmin) hmin = r->pro_height;
                if (r->pro_height > hmax) hmax = r->pro_height;
            }
        }
        CHECK(hmin >= 8 && hmin <= 9 && hmax >= 21);
        fresh(); cs_working_mark(&S, 100, 200, 0);
        CHECK(S.runs[3].x + S.runs[3].w - 100 == 26);
        fresh(); cs_working_mark(&S, 0, 0, 0);
        int h0[4]; for (int i = 0; i < 4; i++) h0[i] = S.runs[i].pro_height;
        fresh(); cs_working_mark(&S, 0, 0, 450);
        int moved = 0; for (int i = 0; i < 4; i++) moved += S.runs[i].pro_height != h0[i];
        CHECK(moved >= 3);
    }

    CHECK(cs_runs(&F) == S.count);

    fresh();
    cs_bar(&F, crumbs, 2, 6, 3, 0, NULL, 0);
    CHECK(text_run("\xe2\x96\xb2 3"));   // the mark reaches the atlas
    CHECK(cs_runs(&F) < 40);

    // ---- Overview and Recent ----
    {
        static pod_model_t M;
        static pod_nav_t N;
        static const char *const eng[] = {"claude", "codex", "muse", "claude", "codex", "muse", "claude", "codex"};
        pod_model_reset(&M);
        pod_model_agents_begin(&M);
        for (int i = 0; i < 8; i++) { char id[8], nm[16]; snprintf(id, sizeof id, "a%d", i); snprintf(nm, sizeof nm, "agent-%d", i); pod_model_agent(&M, id, nm, eng[i], "Mac"); }
        pod_model_agents_end(&M);
        enum { NT = 8 };
        cable_swarm_t sw[NT];
        const char *ids0[] = {"a0", "a1"}, *ids1[] = {"a2", "a3", "a4"}, *ids2[] = {"a5"};
        const char *const *lists[NT];
        uint8_t counts[NT];
        memset(sw, 0, sizeof sw);
        static char names[NT][16];
        for (int i = 0; i < NT; i++) {
            snprintf(sw[i].id, SWARM_ID_MAX, "s%d", i);
            snprintf(names[i], sizeof names[i], i == 0 ? "Firmware" : i == 1 ? "Backend" : "Tab%d", i);
            snprintf(sw[i].name, CABLE_NAME_MAX, "%s", names[i]);
            lists[i] = i == 0 ? ids0 : i == 1 ? ids1 : ids2;
            counts[i] = i == 0 ? 2 : i == 1 ? 3 : 1;
            sw[i].panes = sw[i].agents = counts[i];
        }
        pod_model_swarms(&M, sw, lists, counts, 3, "s0", NULL, 0);   // Recent + 3 tabs
        pod_model_link(&M, true);
        for (int i = 0; i < 8; i++) { char id[8]; snprintf(id, sizeof id, "a%d", i); pod_model_turn(&M, id, "activity", "Editing a file", 10 + i, 100000u - (uint32_t)i * 90000u); }
        pod_model_turn(&M, "a3", "done", NULL, 0, 100000u - 3u * 90000u + 1000u);
        pod_model_turn(&M, "a2", "activity", "Preparing", 29, 100000u);
        pod_model_question(&M, "a2", "Run the migration now?");
        pod_nav_init(&N);
        N.skin = POD_SKIN_CONSOLE;
        uint32_t now = 100000u;
        pod_model_clock(&M, now);

        fresh();
        cs_view_overview(&F, &N, &M, now);
        CHECK(text_run("Recent") && text_run("Firmware") && text_run("Backend"));
        CHECK(text_run("2") && text_run("3") && !text_run("2 agents") && text_run("\xe2\x96\xb2 1") && !text_run("1 ask"));
        {   // the count chip: its number in the 24 px mono face
            const ht_run_t *k3 = text_run("3");
            CHECK(k3 && k3->pro_font == &cs_mono_24);
        }
        CHECK(hits_of(POD_A_OPEN_TAB) == 4);
        CHECK(nth_hit(POD_A_OPEN_TAB, 0)->arg == POD_TAB_RECENT && nth_hit(POD_A_OPEN_TAB, 1)->arg == 0 && !strcmp(nth_hit(POD_A_OPEN_TAB, 1)->id, "s0"));
        CHECK(cs_runs(&F) <= 184);
        // 2 x 2 cards of 338 x 296 at x 16 / 366, y 86 / 394
        {
            const pod_hit_t *c0 = nth_hit(POD_A_OPEN_TAB, 0), *c1 = nth_hit(POD_A_OPEN_TAB, 1), *c2 = nth_hit(POD_A_OPEN_TAB, 2), *c3 = nth_hit(POD_A_OPEN_TAB, 3);
            CHECK(c0->x == 16 && c0->y == 86 && c0->w == 338 && c0->h == 296);
            CHECK(c1->x == 366 && c1->y == 86 && c2->x == 16 && c2->y == 394 && c3->x == 366 && c3->y == 394 && c3->w == 338);
            // one hero per tab: the tab name left in the 28 px medium face, the count chip right, the lead (working first) and its name in the
            // 28 px medium face; no agent rows, no logos at 36, no badges
            const ht_run_t *tn = text_run("Firmware");
            CHECK(tn && tn->pro_font == &cs_md_28 && tn->x == 366 + 19);   // the lead's size, left at the card's pad (Firmware is the second card)
            CHECK(cs_card_lead(&M, 2) == pod_model_find(&M, "a4"));      // Backend: a4 works, so it leads over a2 that asks
            CHECK(pod_model_eff(&M, cs_card_lead(&M, 0)) == POD_WORKING); // Recent: a working agent leads
            CHECK(cs_card_lead(&M, 1) == pod_model_find(&M, "a0") && cs_card_lead(&M, 3) == pod_model_find(&M, "a5"));
            const ht_run_t *ln = text_run("agent-4");
            CHECK(ln && ln->pro_font == &cs_md_28 && text_run("agent-0") && text_run("agent-5") && !text_run("agent-2"));
            CHECK(!text_run("CL") && !text_run("CO") && !text_run("MU"));
            int imgs = 0;
            for (int i = 0; i < S.count; i++) imgs += S.runs[i].pro_kind == 3 && S.runs[i].w == 36;
            CHECK(imgs == 0);
            CHECK(cs_cards_move(&N, &M));
            uint32_t nx = cs_cards_next_ms(&N, &M, now);
            CHECK(nx >= 1 && nx <= 1000);
        }

        // no hint strip: no key caps or labels along the bottom, and nothing is drawn in the last CS_FOOT_H px but the page dots
        {
            const char *const gone[] = {"open tab", "pages", "inbox", "go to the ask", "tap"};
            for (int k = 0; k < 5; k++) CHECK(!text_run(gone[k]));
            for (int i = 0; i < F.hit_count; i++) CHECK(F.hits[i].y + F.hits[i].h <= POD_W - CS_FOOT_H);
        }

        // 6 tabs: 7 covers, 4 to a page: two pages; the second holds the last three
        pod_model_swarms(&M, sw, lists, counts, 6, "s0", NULL, 0);
        CHECK(pod_tabs_pages_of(&N, &M) == 2);
        fresh();
        cs_view_overview(&F, &N, &M, now);
        CHECK(hits_of(POD_A_OPEN_TAB) == 4 && text_run("Recent") && !text_run("Tab4"));
        CHECK(cs_runs(&F) <= 184);
        N.stack[0].scroll = 2;
        fresh();
        cs_view_overview(&F, &N, &M, now);
        CHECK(hits_of(POD_A_OPEN_TAB) == 3 && !text_run("Recent") && text_run("Tab3") && text_run("Tab5"));
        N.stack[0].scroll = 0;
        // 8 tabs: 9 covers, three pages; the Console pages by four, the Classic grid by six
        pod_model_swarms(&M, sw, lists, counts, NT, "s0", NULL, 0);
        CHECK(pod_tabs_pages_of(&N, &M) == 3 && pod_tabs_pages(&M) == 2);
        CHECK(pod_scroll_max(&N, &M) == 4 && pod_scroll_pitch(&N) > 0);
        N.stack[0].scroll = 4;
        fresh();
        cs_view_overview(&F, &N, &M, now);
        CHECK(hits_of(POD_A_OPEN_TAB) == 1 && text_run("Tab7"));
        N.stack[0].scroll = 0;
        pod_model_swarms(&M, sw, lists, counts, 3, "s0", NULL, 0);

        // Recent: 8 agents, six rows of 104 px at a time (the screen down to its bottom margin); drag scroll shows the rest
        pod_nav_act(&N, &M, POD_A_OPEN_TAB, POD_TAB_RECENT, now);
        fresh();
        cs_view_recent(&F, &N, &M, now);
        const pod_agent_t *rl[POD_RECENT_MAX];
        int rn = pod_model_recent(&M, rl, POD_RECENT_MAX);
        CHECK(rn == 8 && hits_of(POD_A_OPEN_AGENT) == 6);
        for (int i = 0; i < 6; i++) { const pod_hit_t *h = nth_hit(POD_A_OPEN_AGENT, i); CHECK(!strcmp(h->id, rl[i]->id) && h->arg == i && h->y == 76 + i * 104 && h->h == 104); }
        CHECK(76 + 6 * 104 <= POD_W - CS_FOOT_H);   // the last row ends above the bottom margin
        CHECK(text_run("ask") && text_run("Recent") && text_run("Overview") && text_run("go to the ask") == NULL);
        CHECK(hits_of(POD_A_BACK) == 1);
        CHECK(!text_run("open") && !text_run("tabs") && !text_run("back") && !text_run("home"));   // no hint strip
        CHECK(cs_runs(&F) <= 184);
        CHECK(pod_scroll_pitch(&N) == 104 && pod_scroll_max(&N, &M) == 2);
        {   // a WORKING agent has the four bars and no dot; the others a dot and no bars
            int work = 0, bars = 0, green_dots = 0;
            for (int i = 0; i < CS_ROWS_MAX; i++) work += pod_model_eff(&M, rl[i]) == POD_WORKING;
            for (int i = 0; i < S.count; i++) {
                const ht_run_t *r = &S.runs[i];
                bars += r->pro_kind == K_RECT && r->w == 5 && r->fg == ht_rgb(CS_RUN);
                green_dots += r->pro_kind == K_RECT_AA && r->w == 12 && r->y > CS_BAR_H && r->fg == ht_rgb(CS_RUN);   // the bar has its own
            }
            CHECK(work >= 2 && bars == 4 * work && green_dots == 0);
            const ht_run_t *nm = text_run(rl[0]->name);   // the name sits in the 32 px face, the line in the 27 px
            CHECK(nm && nm->pro_font == &cs_sb_32);
            const ht_run_t *ln = text_run("Editing a file");
            CHECK(ln && ln->pro_font == &cs_rg_27);
            CHECK(text_run("Firmware"));   // Recent names each agent's tab
        }
        N.stack[N.depth - 1].scroll = 2;
        fresh();
        cs_view_recent(&F, &N, &M, now);
        CHECK(hits_of(POD_A_OPEN_AGENT) == 6);
        for (int i = 0; i < 6; i++) { const pod_hit_t *h = nth_hit(POD_A_OPEN_AGENT, i); CHECK(!strcmp(h->id, rl[2 + i]->id) && h->arg == 2 + i); }
        N.stack[N.depth - 1].scroll = 0;

        // ---- Tab: the real pane split (3 panes, then 8) ----
        {
            cable_tile_t tl[8];
            memset(tl, 0, sizeof tl);
            const int r3[3][4] = {{0, 0, 500, 1000}, {500, 0, 1000, 500}, {500, 500, 1000, 1000}};
            const char *a3[3] = {"a2", "a3", "a4"};
            for (int k = 0; k < 3; k++) {
                tl[k].x1 = (int16_t)r3[k][0]; tl[k].y1 = (int16_t)r3[k][1]; tl[k].x2 = (int16_t)r3[k][2]; tl[k].y2 = (int16_t)r3[k][3];
                snprintf(tl[k].agent_id, sizeof tl[k].agent_id, "%s", a3[k]);
            }
            pod_model_swarms(&M, sw, lists, counts, 3, "s1", tl, 3);   // Backend (s1) is selected with its rects
            pod_nav_init(&N);
            N.skin = POD_SKIN_CONSOLE;
            pod_nav_act(&N, &M, POD_A_OPEN_TAB, 1, now);   // tabs[1] = Backend
            fresh();
            cs_view_tab(&F, &N, &M, now);
            CHECK(hits_of(POD_A_OPEN_AGENT) == 3);
            // cards in pane order on the Overview grid; the hit's arg is the agent's place in the list
            for (int i = 0; i < 3; i++) {
                const pod_hit_t *h = nth_hit(POD_A_OPEN_AGENT, i);
                CHECK(h->x == CS_CARD_MARGIN + (i % 2) * (CS_CARD_W + CS_CARD_GAP) && h->y == CS_CARD_TOP + (i / 2) * (CS_CARD_H + CS_CARD_GAP));
                CHECK(h->w == CS_CARD_W && h->h == CS_CARD_H && h->arg == i && !strcmp(h->id, a3[i]));
            }
            CHECK(texts("Backend") == 1);   // the bar's crumb only: no tab name on a card
            CHECK(text_run("Overview") && text_run("Backend") && !text_run("Run the migration now?"));   // no activity line
            // the state, in a word at each card's foot, in its colour; the name in the 28 px face; the asking card's time is "ask"
            { const ht_run_t *w = text_run("Needs you"); CHECK(w && w->fg == ht_rgb(CS_ASK) && w->pro_font == &cs_sb_26); }
            { const ht_run_t *w = text_run("Working"); CHECK(w && w->fg == ht_rgb(CS_RUN)); }
            CHECK(text_run("ask") && text_run("ask")->fg == ht_rgb(CS_ASK));
            CHECK(!text_run("open") && !text_run("home") && !text_run("talk to a pane") && !text_run("open pane"));
            CHECK(cs_tab_pages(&N, &M) == 1);
            CHECK(cs_runs(&F) <= 184);

            // 8 panes: two pages of four; the frame's scroll is the page, and page dots run down the right edge
            cable_swarm_t sw8;
            memset(&sw8, 0, sizeof sw8);
            snprintf(sw8.id, SWARM_ID_MAX, "big");
            snprintf(sw8.name, CABLE_NAME_MAX, "Big");
            sw8.panes = sw8.agents = 8;
            const char *const ids8[] = {"a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7"}, *const *l8[1] = {ids8};
            uint8_t c8[1] = {8};
            for (int k = 0; k < 8; k++) {
                tl[k].x1 = (int16_t)(k % 3 * 333); tl[k].x2 = (int16_t)(k % 3 == 2 ? 1000 : (k % 3 + 1) * 333);
                tl[k].y1 = (int16_t)(k / 3 * 333); tl[k].y2 = (int16_t)(k / 3 == 2 ? 1000 : (k / 3 + 1) * 333);
                snprintf(tl[k].agent_id, sizeof tl[k].agent_id, "%s", ids8[k]);
            }
            pod_model_swarms(&M, &sw8, l8, c8, 1, "big", tl, 8);
            pod_nav_init(&N);
            N.skin = POD_SKIN_CONSOLE;
            pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, now);
            fresh();
            cs_view_tab(&F, &N, &M, now);
            CHECK(hits_of(POD_A_OPEN_AGENT) == 4 && cs_tab_pages(&N, &M) == 2 && pod_scroll_max(&N, &M) == 1);
            CHECK(cs_runs(&F) <= 184);
            int dots = 0;
            for (int i = 0; i < S.count; i++) dots += S.runs[i].pro_kind == K_RECT && S.runs[i].w == 8 && S.runs[i].x > POD_W - 20;
            CHECK(dots == 2);
            N.stack[N.depth - 1].scroll = 1;
            fresh();
            cs_view_tab(&F, &N, &M, now);
            CHECK(hits_of(POD_A_OPEN_AGENT) == 4 && !strcmp(nth_hit(POD_A_OPEN_AGENT, 0)->id, "a4") && nth_hit(POD_A_OPEN_AGENT, 3)->arg == 7);
            N.stack[N.depth - 1].scroll = 9;   // past the end: the last page
            fresh();
            cs_view_tab(&F, &N, &M, now);
            CHECK(hits_of(POD_A_OPEN_AGENT) == 4 && !strcmp(nth_hit(POD_A_OPEN_AGENT, 0)->id, "a4"));
        }
    }

    // a tab with 20 agents, every one working with a long name: five pages of cards, the last reachable, the run budget holds
    {
        static pod_model_t M;
        static pod_nav_t N;
        pod_model_reset(&M);
        pod_model_agents_begin(&M);
        static char ids[20][8], *idp[20];
        for (int i = 0; i < 20; i++) { snprintf(ids[i], sizeof ids[i], "b%d", i); idp[i] = ids[i]; pod_model_agent(&M, ids[i], "an-agent-with-a-rather-long-name-indeed", "claude", "A Machine With A Long Name"); }
        pod_model_agents_end(&M);
        cable_swarm_t sw;
        memset(&sw, 0, sizeof sw);
        snprintf(sw.id, SWARM_ID_MAX, "w");
        snprintf(sw.name, CABLE_NAME_MAX, "Twenty");
        sw.panes = sw.agents = 20;
        const char *const *lists[1] = {(const char *const *)idp};
        uint8_t cnt[1] = {20};
        pod_model_swarms(&M, &sw, lists, cnt, 1, "w", NULL, 0);
        pod_model_link(&M, true);
        for (int i = 0; i < 20; i++)
            pod_model_turn(&M, ids[i], "activity", "A long line of activity that cannot fit on one row of the list however hard it tries to, it just goes on", 30 + i, 100000u);
        pod_nav_init(&N);
        N.skin = POD_SKIN_CONSOLE;
        pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 100000u);
        fresh();
        cs_view_tab(&F, &N, &M, 100000u);
        CHECK(hits_of(POD_A_OPEN_AGENT) == 4 && pod_scroll_max(&N, &M) == 4);
        CHECK(cs_runs(&F) <= 184);
        N.stack[N.depth - 1].scroll = 4;
        fresh();
        cs_view_tab(&F, &N, &M, 100000u);
        CHECK(hits_of(POD_A_OPEN_AGENT) == 4 && nth_hit(POD_A_OPEN_AGENT, 3)->arg == 19);
        CHECK(cs_runs(&F) <= 184);
        bool cut = false;   // the long name ends with an ellipsis
        for (int i = 0; i < S.count; i++) cut |= S.runs[i].pro_kind == K_TEXT && strstr(S.runs[i].text, "...") != NULL;
        CHECK(cut);
        printf("runs tab-20 %d\n", cs_runs(&F));
    }

    // a tab of ten panes where only the ninth works: it still leads the tab's Overview card (every pane is ranked)
    {
        static pod_model_t M;
        pod_model_reset(&M);
        pod_model_agents_begin(&M);
        static char ids[10][8], *idp[10];
        for (int i = 0; i < 10; i++) { snprintf(ids[i], sizeof ids[i], "c%d", i); idp[i] = ids[i]; pod_model_agent(&M, ids[i], ids[i], "claude", "mac"); }
        pod_model_agents_end(&M);
        cable_swarm_t sw;
        memset(&sw, 0, sizeof sw);
        snprintf(sw.id, SWARM_ID_MAX, "ten");
        snprintf(sw.name, CABLE_NAME_MAX, "Ten");
        sw.panes = sw.agents = 10;
        const char *const *lists[1] = {(const char *const *)idp};
        uint8_t cnt[1] = {10};
        pod_model_swarms(&M, &sw, lists, cnt, 1, "ten", NULL, 0);
        pod_model_link(&M, true);
        pod_model_turn(&M, "c8", "activity", "Editing", 12, 100000u);
        pod_model_clock(&M, 100000u);
        CHECK(cs_card_lead(&M, 1) == pod_model_find(&M, "c8"));
    }

    // ---- Agent, Recap, Talk, Inbox, Toast, Update (Task 10) ----
    {
        static pod_model_t M;
        static pod_nav_t N;
        const uint32_t t0 = 1000, now = 200000;
        pod_model_reset(&M);
        pod_model_agents_begin(&M);
        pod_model_agent(&M, "w", "landing", "claude", "Mac Studio");
        pod_model_agent(&M, "q", "harness-cli", "codex", "MacBook Pro");
        pod_model_agent(&M, "d", "desktop", "claude", "Mac Studio");
        pod_model_agent(&M, "f", "api-retry", "codex", "MacBook Pro");
        pod_model_agents_end(&M);
        cable_swarm_t sw[1];
        memset(sw, 0, sizeof sw);
        snprintf(sw[0].id, SWARM_ID_MAX, "t0");
        snprintf(sw[0].name, CABLE_NAME_MAX, "Desktop");
        sw[0].panes = sw[0].agents = 4;
        const char *ids[] = {"w", "q", "d", "f"};
        const char *const *lists[1] = {ids};
        uint8_t cnt[1] = {4};
        pod_model_swarms(&M, sw, lists, cnt, 1, "t0", NULL, 0);
        pod_model_link(&M, true);
        pod_model_turn(&M, "w", "started", NULL, 0, t0);
        for (int i = 0; i < 6; i++) { char t[24]; snprintf(t, sizeof t, "step %d", i); pod_model_turn(&M, "w", "step", t, 10 + i, t0 + 1000u * (unsigned)i); }
        pod_model_turn(&M, "w", "activity", "src/hero.tsx", 20, t0 + 9000);
        pod_model_turn(&M, "q", "started", NULL, 0, t0);
        pod_model_question(&M, "q", "Run the migration on the dev database now?");
        {   // pod_model_question clears steps[] (and ignores later ones while ASKING), so give the asking agent its lead-up directly
            pod_agent_t *qa = (pod_agent_t *)pod_model_find(&M, "q");
            const char *lead[] = {"Read migrations/0042.sql", "Ran the migration on a copy", "A third step"};
            for (int i = 0; i < 3; i++) { snprintf(qa->steps[i], sizeof qa->steps[i], "%s", lead[i]); qa->step_at_s[i] = (uint16_t)(12 + i * 18); }
            qa->step_count = 3;
        }
        pod_model_turn(&M, "d", "started", NULL, 0, t0);
        for (int i = 0; i < 8; i++) { char t[24]; snprintf(t, sizeof t, "dstep %d", i); pod_model_turn(&M, "d", "step", t, 10 + i, t0 + 100u * (unsigned)i); }
        pod_model_turn(&M, "d", "activity", "Wrapping up", 252, t0 + 1500);   // the turn's length comes with an activity
        pod_model_turn(&M, "d", "done", NULL, 252, t0 + 2000);
        static char recap[2100];
        for (int i = 0; i < 35; i++) strcat(recap, "The Relaxing chip now follows Rest until you pick a row. ");
        pod_model_recap(&M, "d", recap, false);
        pod_model_turn_stats(&M, "d", 54, 0, 0, -1, -1);
        pod_model_turn(&M, "f", "started", NULL, 0, t0);
        pod_model_turn(&M, "f", "error", NULL, 40, t0 + 40000);
        pod_model_clock(&M, now);
#define OPEN(id, v) do { pod_nav_init(&N); N.skin = POD_SKIN_CONSOLE; N.depth = 3; N.stack[0].view = POD_V_TABS; N.stack[1].view = POD_V_TAB; \
        snprintf(N.stack[1].tab_id, SWARM_ID_MAX, "t0"); N.stack[2].view = (v); snprintf(N.stack[2].agent, ID_MAX, "%s", id); } while (0)

        // Agent, working (header C): the bar names only the tab, the name in 34 px, "Running" in the 28 px face and the time in mono,
        // then the 28 px logo and "machine · pane i of n"; NOW and the equaliser, no timeline, no tokens
        OPEN("w", POD_V_AGENT);
        fresh();
        cs_view_agent(&F, &N, &M, now);
        { const ht_run_t *r = text_run("Running"); CHECK(r && r->fg == ht_rgb(CS_RUN) && r->pro_font == &cs_md_28); }
        CHECK(text_run("NOW") && text_run("landing") && !text_run("hold") && text_run("src/hero.tsx"));
        { const ht_run_t *r = text_run("landing"); CHECK(r && r->pro_font == &cs_sb_34); }
        CHECK(!text_run("THIS TURN") && !text_run("LEADING UP TO IT") && !text_run("TOKENS") && !text_run("step 0") && !text_run("step 5"));
        CHECK(!text_run("talk") && !text_run("back") && !text_run("home") && !text_run("panes") && text_run("Desktop") && !text_run("Overview"));
        for (int i = 0; i < S.count; i++) CHECK(S.runs[i].pro_kind != K_TEXT || !strstr(S.runs[i].text, "pane "));   // no "pane i of n"
        CHECK(text_run("Mac Studio") && text_run("\xc2\xb7"));
        { const ht_run_t *r = text_run("Mac Studio"); CHECK(r->pro_font == &cs_rg_20); }
        { int logos = 0; for (int i = 0; i < S.count; i++) logos += S.runs[i].pro_kind == 3 && S.runs[i].w == 28; CHECK(logos == 1); }
        CHECK(hits_of(POD_A_BACK) == 1 && nth_hit(POD_A_BACK, 0)->arg == 1);   // the bar's one crumb goes back
        { int crumbs = 0; for (int i = 0; i < S.count; i++) crumbs += S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &cs_sb_26; CHECK(crumbs == 1); }
        CHECK(cs_runs(&F) <= 184);
        printf("runs agent-working %d\n", cs_runs(&F));
        // a 39-byte name does not fit the 34 px line: it is cut with an ellipsis
        {
            pod_agent_t *wa = (pod_agent_t *)pod_model_find(&M, "w");
            char keep[sizeof wa->name];
            snprintf(keep, sizeof keep, "%s", wa->name);
            snprintf(wa->name, sizeof wa->name, "marketing-site-redesign-with-long-name");
            fresh();
            cs_view_agent(&F, &N, &M, now);
            const ht_run_t *r = NULL;
            for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &cs_sb_34) r = &S.runs[i];
            CHECK(r && strstr(r->text, "...") && r->x + r->w <= 700);
            snprintf(wa->name, sizeof wa->name, "%s", keep);
        }

        // Working with a 300-byte activity: the verb line, then at most three cs_rg_27 lines, the last cut with "..."
        {
            pod_agent_t *wa = (pod_agent_t *)pod_model_find(&M, "w");
            char keep[sizeof wa->activity];
            snprintf(keep, sizeof keep, "%s", wa->activity);
            wa->activity[0] = 0;
            for (int i = 0; i < 30; i++) strcat(wa->activity, "alpha beta ");
            wa->activity[299] = 0;
            fresh();
            cs_view_agent(&F, &N, &M, now);
            int lines = 0, last_y = -1;
            const ht_run_t *last = NULL;
            for (int i = 0; i < S.count; i++)
                if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &cs_rg_27) { lines++; if (S.runs[i].y > last_y) { last_y = S.runs[i].y; last = &S.runs[i]; } }
            CHECK(lines >= 2 && lines <= 3 && last && strlen(last->text) > 3 && !strcmp(last->text + strlen(last->text) - 3, "..."));
            CHECK(cs_runs(&F) <= 184);
            wa->activity[0] = 0;   // no activity: only the verb line
            fresh();
            cs_view_agent(&F, &N, &M, now);
            lines = 0;
            for (int i = 0; i < S.count; i++) lines += S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &cs_rg_27;
            CHECK(lines == 0 && text_run("NOW"));
            snprintf(wa->activity, sizeof wa->activity, "%s", keep);
        }

        // Agent, asking: the QUESTION card, no steps
        OPEN("q", POD_V_AGENT);
        fresh();
        cs_view_agent(&F, &N, &M, now);
        CHECK(text_run("QUESTION") && text_run("Needs input") && text_run("Answer in the Harness app"));
        CHECK(!text_run("LEADING UP TO IT") && !text_run("THIS TURN") && !text_run("TOKENS") && !text_run("NOW"));
        // M9: voice on an asking agent stays refused, so the screen does not offer it: no hold hint, no voice line.
        CHECK(!text_run("or hold to answer by voice") && !text_run("answer by voice") && !text_run("hold") && !text_run("talk") && !text_run("talk to harness-cli"));
        CHECK(!text_run("panes") && !text_run("back") && !text_run("home"));
        CHECK(!text_run("Read migrations/0042.sql") && !text_run("Ran the migration on a copy"));
        CHECK(cs_runs(&F) <= 184);
        printf("runs agent-ask %d\n", cs_runs(&F));

        // Recap: the summary is Classic's cut in 36 px, then TOKENS (wide), DURATION, TESTS, COMMITS
        OPEN("d", POD_V_RECAP);
        pod_model_turn_stats(&M, "d", 54, 0, 0, 42900, 18500);
        fresh();
        cs_view_recap(&F, &N, &M, now);
        CHECK(!text_run("SUMMARY") && text_run("Done") && text_run("TOKENS") && text_run("DURATION") && text_run("TESTS") && text_run("COMMITS"));
        CHECK(!text_run("STEPS"));
        CHECK(text_run("54 \xe2\x9c\x93") && !text_run("talk") && text_run("4:12"));
        CHECK(text_run("61.4k") && text_prefix("in 42.9k") && text_prefix("in 42.9k")->pro_font == &cs_mono_15);
        {   // the sub-line, when drawn, starts "in " and is never cut inside a number: "in 42.9k" or "in 42.9k \xc2\xb7 out 18.5k", whole (Linux fonts are wider than macOS)
            const ht_run_t *sub = text_prefix("in ");
            CHECK(sub && (!strcmp(sub->text, "in 42.9k") || !strcmp(sub->text, "in 42.9k \xc2\xb7 out 18.5k")));
        }
        {   // one line per tile: the label (small, muted) then the value on the same baseline; the TOKENS tile also holds in/out (muted, small)
            const ht_run_t *r = text_run("61.4k"), *sub = text_prefix("in 42.9k"), *lab = text_run("TOKENS");
            CHECK(r && sub && lab);
            CHECK(r->pro_font == &cs_mono_22 && sub->pro_font == &cs_mono_15 && lab->pro_font == &cs_mono_15);
            CHECK(sub->fg == ht_rgb(CS_MUTED) && lab->fg == ht_rgb(CS_MUTED));
            CHECK(lab->x < r->x && r->x < sub->x);
            const char *const labels[] = {"TOKENS", "DURATION", "TESTS", "COMMITS"}, *const values[] = {"61.4k", "4:12", "54 \xe2\x9c\x93", "0"};
            int tiles = 0, tile_h = 0;
            for (int i = 0; i < S.count; i++)
                if (S.runs[i].pro_kind == K_RECT_STROKE && S.runs[i].y > 400 && S.runs[i].pro_height >= 40) { tiles++; tile_h = S.runs[i].pro_height; }
            CHECK(tiles == 4 && tile_h > 0 && tile_h <= 54);   // half of the old 108 px
            for (int k = 0; k < 4; k++) {
                const ht_run_t *l = NULL, *v = NULL;
                for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && S.runs[i].y >= 500 && S.runs[i].y < POD_W - CS_FOOT_H) {   // the tile band
                    if (!strcmp(S.runs[i].text, labels[k])) l = &S.runs[i];
                    if (!strcmp(S.runs[i].text, values[k])) v = &S.runs[i];
                }
                CHECK(l && v);
                CHECK(l->y + l->pro_font->height * 15 / 32 == v->y + v->pro_font->height * 15 / 32);   // one baseline
                CHECK(l->x < v->x);
                CHECK(l->y == text_run("TOKENS")->y);   // and the four tiles share it
            }
        }
        CHECK(hits_of(POD_A_BACK) == 1 && !text_run("Overview"));
        {   // the summary: the same words as Classic cuts (50), ending "...", wrapped in the 36 px face
            const pod_agent_t *da = pod_model_find(&M, "d");
            char joined[POD_RECAP_BYTES + POD_RECAP_LINES + 4], cut[POD_RECAP_BYTES + POD_RECAP_LINES + 4];
            pod_recap_join(da, joined, sizeof joined);
            int n = pod_recap_cut(joined, cut, sizeof cut);
            CHECK(n == (int)strlen(cut) && n < (int)strlen(joined) && !strcmp(cut + n - 3, "..."));
            char rows[8][POD_ROW_MAX];
            int nr = pod_wrap(cut, &cs_rg_36, 664, 7, rows);   // the freed label height gives a seventh row above the tiles
            int seen = 0, y0 = -1;
            for (int i = 0; i < S.count; i++) {
                const ht_run_t *r = &S.runs[i];
                if (r->pro_kind != K_TEXT || r->pro_font != &cs_rg_36) continue;
                seen++;
                CHECK(r->y > y0);
                y0 = r->y;
            }
            CHECK(seen == nr);
            CHECK(text_run(rows[0]));   // the first row is the cut text's first row
            CHECK(text_run(rows[0])->y < 290 + 23);   // and it starts where the label was (it was 290 + 23 with the label)
        }
        CHECK(pod_scroll_max(&N, &M) == 0);   // no scrolling
        CHECK(cs_runs(&F) <= 184);
        printf("runs recap %d\n", cs_runs(&F));
        // tokens as the mockup writes them: plain under 1000, k to a million, then M; no tokens: no TOKENS tile, the others stay
        pod_model_turn_stats(&M, "d", 54, 0, 0, 640, 12);
        fresh(); cs_view_recap(&F, &N, &M, now);
        CHECK(text_run("652") && text_prefix("in 640"));
        pod_model_turn_stats(&M, "d", 54, 0, 0, 1000000, 200000);
        fresh(); cs_view_recap(&F, &N, &M, now);
        CHECK(text_run("1.2M") && text_prefix("in 1.0M"));
        { pod_agent_t *da = (pod_agent_t *)pod_model_find(&M, "d"); da->tokens_in = da->tokens_out = -1; }
        fresh();
        cs_view_recap(&F, &N, &M, now);
        CHECK(!text_run("TOKENS") && text_run("DURATION") && text_run("TESTS") && text_run("COMMITS"));
        { pod_agent_t *da = (pod_agent_t *)pod_model_find(&M, "d"); da->tests_passed = da->tests_failed = da->commits = da->tokens_in = da->tokens_out = -1; }   // the feed only sets, never clears
        fresh();
        cs_view_recap(&F, &N, &M, now);
        CHECK(text_run("DURATION") && !text_run("TOKENS") && !text_run("TESTS") && !text_run("COMMITS"));
        pod_model_turn_stats(&M, "d", 52, 2, 0, -1, -1);
        fresh();
        cs_view_recap(&F, &N, &M, now);
        { const ht_run_t *r = text_run("52 \xe2\x9c\x93 2 \xc3\x97"); CHECK(r && r->fg == ht_rgb(CS_FAIL)); }
        // nothing to show (no duration, no stats): no tile row, no time and no "\xc2\xb7" in the header
        { pod_agent_t *da = (pod_agent_t *)pod_model_find(&M, "d"); da->tests_passed = da->tests_failed = da->commits = -1; da->elapsed_s = 0; }
        fresh();
        cs_view_recap(&F, &N, &M, now);
        CHECK(!text_run("DURATION") && !text_run("TESTS") && !text_run("COMMITS") && !text_run("TOKENS") && !text_run("4:12"));
        CHECK(!texts("\xc2\xb7") && text_run("Done") && !text_run("SUMMARY"));
        for (int i = 0; i < S.count; i++) CHECK(!(S.runs[i].pro_kind == K_RECT_STROKE && S.runs[i].y >= 500 && S.runs[i].y < 660));   // the tile row's boxes
        CHECK(cs_runs(&F) <= 184);
        { pod_agent_t *da = (pod_agent_t *)pod_model_find(&M, "d"); da->elapsed_s = 252; }
        pod_model_turn_stats(&M, "d", 54, 0, 0, 42900, 18500);

        {   // v3b L7: extreme stats never push a tile past the right margin (x 702)
            struct { int32_t tin, tout; int pass, fail, commits, elapsed; } cases[] = {
                {99999999, 99999999, 999, 12, 99999, 5025}, {42900, 18500, 999, 12, 7, 5025}, {-1, -1, 999, 12, 99999, 5025}, {1000000, 200000, 9999, 99, 9999, 36000}};
            for (unsigned c = 0; c < sizeof cases / sizeof cases[0]; c++) {
                pod_agent_t *da = (pod_agent_t *)pod_model_find(&M, "d");
                da->tokens_in = cases[c].tin; da->tokens_out = cases[c].tout; da->tests_passed = cases[c].pass; da->tests_failed = cases[c].fail;
                da->commits = cases[c].commits; da->elapsed_s = (uint32_t)cases[c].elapsed;
                fresh();
                cs_view_recap(&F, &N, &M, now);
                int tiles = 0, left = 18;
                for (int i = 0; i < S.count; i++) {
                    const ht_run_t *r = &S.runs[i];
                    if (r->pro_kind == K_RECT_STROKE && r->y > 400 && r->pro_height >= 40) {
                        tiles++;
                        CHECK(r->x >= left && r->x + r->w <= POD_W - 18);
                        left = r->x + r->w;
                    }
                }
                CHECK(tiles >= 1);
                for (int i = 0; i < S.count; i++)
                    if (S.runs[i].pro_kind == K_TEXT && S.runs[i].y >= 500 && S.runs[i].y < 640) CHECK(S.runs[i].x + S.runs[i].w <= POD_W - 18);
            }
            pod_agent_t *da = (pod_agent_t *)pod_model_find(&M, "d");
            da->elapsed_s = 252;
            pod_model_turn_stats(&M, "d", 54, 0, 0, 42900, 18500);
        }

        // Talk: the wave follows the mic; the sending card
        OPEN("w", POD_V_TALK);
        N.talk_started_ms = now - 3000;
        int hmax[2];
        for (int k = 0; k < 2; k++) {
            fresh();
            F.mic_level = k ? 4 : 0;
            cs_view_talk(&F, &N, &M, now);
            hmax[k] = 0;
            int bars = 0;
            for (int i = 0; i < S.count; i++)
                if (S.runs[i].pro_kind == K_RECT && S.runs[i].w == 9) { bars++; if (S.runs[i].pro_height > hmax[k]) hmax[k] = S.runs[i].pro_height; }
            CHECK(bars == 36);
        }
        CHECK(hmax[1] > hmax[0] + 20);
        CHECK(text_run("Listening \xc2\xb7 0:03") && text_run("landing") && text_run("Tap anywhere to send") && !text_run("tap") && !text_run("send") && !text_run("release") && !text_run("slide \xe2\x86\x93"));
        CHECK(F.hit_count && F.hits[F.hit_count - 1].action == POD_A_TALK && F.hits[F.hit_count - 1].w == POD_W);   // topmost: wins over crumbs and chip
        CHECK(cs_runs(&F) <= 184);
        printf("runs talk-listen %d\n", cs_runs(&F));
        N.sending = true;
        N.send_started_ms = now - 500;
        fresh();
        cs_view_talk(&F, &N, &M, now);
        CHECK(text_run("Sending\xe2\x80\xa6") && text_run("To landing") && !text_run("Listening \xc2\xb7 0:03"));
        CHECK(cs_runs(&F) <= 184);
        printf("runs talk-send %d\n", cs_runs(&F));
        N.sending = false;

        // Inbox: NEEDS YOU, FINISHED, FAILED in that order; an empty group is not drawn
        pod_model_unread_add(&M, "d", "desktop", "The Relaxing chip now follows Rest.", 252, now - 240000u);
        pod_nav_init(&N);
        N.skin = POD_SKIN_CONSOLE;
        N.depth = 2; N.stack[0].view = POD_V_TABS; N.stack[1].view = POD_V_INBOX;
        fresh();
        cs_view_inbox(&F, &N, &M, now);
        {
            const ht_run_t *g1 = text_run("NEEDS YOU"), *g2 = text_run("FINISHED"), *g3 = text_run("FAILED");
            CHECK(g1 && g2 && g3 && g1->y < g2->y && g2->y < g3->y);
            CHECK(text_run("api-retry") && text_run("harness-cli") && !text_run("tap") && !text_run("home"));
            CHECK(cs_runs(&F) <= 184);
            printf("runs inbox %d\n", cs_runs(&F));
            // NEEDS YOU rows have no unread entry: they register FOLLOW (index into model->agents), and it opens the agent
            const pod_hit_t *fh = NULL;
            for (int i = 0; i < F.hit_count; i++) if (F.hits[i].action == POD_A_FOLLOW && !strcmp(F.hits[i].id, "q")) fh = &F.hits[i];
            CHECK(fh && !strcmp(M.agents[fh->arg].id, "q"));
            pod_nav_act(&N, &M, fh->action, fh->arg, now);
            CHECK(N.stack[N.depth - 1].view == POD_V_AGENT && !strcmp(N.stack[N.depth - 1].agent, "q"));
            N.depth = 2; N.stack[1].view = POD_V_INBOX;
        }
        // Readable Inbox (v3): faces, wrapped message, logos, group labels, two hints, every row reachable
        {
            const char *longmsg = "The Relaxing chip now follows Rest until you pick a row for it. All 54 pet settings tests pass and the build is green on every target we ship, including the older boards that still need the slower flash path and a full retest.";
            pod_model_unread_add(&M, "d", "desktop", longmsg, 252, now - 240000u);
            fresh();
            cs_view_inbox(&F, &N, &M, now);
            const ht_run_t *nm = text_run("harness-cli"), *g1 = text_run("NEEDS YOU");
            CHECK(nm && nm->pro_font == &cs_sb_32);
            CHECK(g1 && g1->pro_font == &cs_mono_18 && g1->x == 24);
            const ht_run_t *cnt = NULL;   // the count sits right-aligned on the label's line
            for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &cs_mono_18 && S.runs[i].x > 400) { cnt = &S.runs[i]; break; }
            CHECK(cnt && cnt->x + cnt->w <= POD_W - 24 + 2);
            const ht_run_t *msg = text_prefix("Run the migration");
            CHECK(msg && msg->pro_font == &cs_rg_27 && msg->x == 84);
            const ht_run_t *l1 = text_prefix("The Relaxing chip"), *l3 = NULL;
            int lines = 0;
            for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &cs_rg_27 && S.runs[i].x == 84 && S.runs[i].y >= l1->y && S.runs[i].y < l1->y + 3 * 34) { lines++; l3 = &S.runs[i]; }
            CHECK(l1 && lines == 3 && l3 && strlen(l3->text) > 3 && !strcmp(l3->text + strlen(l3->text) - 3, "..."));
            CHECK(ht_pro_width(&cs_rg_27, l3->text) <= POD_W - 24 - 84);
            int logos = 0;
            for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind != K_TEXT && S.runs[i].w == 44 && S.runs[i].pro_height == 44) logos++;
            CHECK(logos >= 2);
            CHECK(!text_run("tap") && !text_run("open") && !text_run("home") && !text_run("back"));   // no hint strip
            CHECK(cs_runs(&F) <= 184);
            // a tall list: 8 entries of mixed lengths, each reachable by scrolling
            const char *const msgs[] = {"Done.", "OTA resend on a gap; 3 tests added.", longmsg, "Short one", longmsg, "Draft ready for review.", "Build green on all targets after the rebase onto main today.", "Last row"};
            pod_model_unread_clear(&M);
            for (int i = 0; i < 8; i++) {
                char id[8], name[8];
                snprintf(id, sizeof id, "x%d", i);
                snprintf(name, sizeof name, "n%d", i);
                pod_model_unread_add(&M, id, name, msgs[i], 40, now - 1000u * (unsigned)(i + 1));
            }
            int max = pod_scroll_max(&N, &M);
            CHECK(max > 0);
            bool seen[8] = {false};
            for (int sc = 0; sc <= max; sc++) {
                N.stack[1].scroll = (int16_t)sc;
                fresh();
                cs_view_inbox(&F, &N, &M, now);
                CHECK(cs_runs(&F) <= 184);
                for (int i = 0; i < F.hit_count; i++) {
                    if (F.hits[i].action != POD_A_OPEN_NOTIF) continue;
                    CHECK(F.hits[i].y + F.hits[i].h <= POD_W - CS_FOOT_H);
                    for (int k = 0; k < 8; k++) { char id[8]; snprintf(id, sizeof id, "x%d", k); if (!strcmp(F.hits[i].id, id)) seen[k] = true; }
                }
            }
            for (int k = 0; k < 8; k++) CHECK(seen[k]);
            N.stack[1].scroll = 0;
            pod_model_unread_clear(&M);
            pod_model_unread_add(&M, "d", "desktop", "The Relaxing chip now follows Rest.", 252, now - 240000u);
        }
        // M8: a failed agent with an unread FAILED entry is one row, and its tap is OPEN_NOTIF (it marks the entry read).
        pod_model_unread_add(&M, "f", "api-retry", "Timed out talking to the API.", 40, now - 5000u);
        CHECK(pod_model_unread_find(&M, "f")->kind == POD_UNREAD_FAILED);
        fresh();
        cs_view_inbox(&F, &N, &M, now);
        {
            int rows = 0, notif = 0;
            for (int i = 0; i < F.hit_count; i++) if (!strcmp(F.hits[i].id, "f")) { rows++; notif += F.hits[i].action == POD_A_OPEN_NOTIF; }
            CHECK(rows == 1 && notif == 1);
        }
        pod_model_unread_clear(&M);
        pod_model_unread_add(&M, "d", "desktop", "The Relaxing chip now follows Rest.", 252, now - 240000u);
        pod_model_turn(&M, "f", "started", NULL, 0, now);   // the failure is cleared by a new turn
        fresh();
        cs_view_inbox(&F, &N, &M, now);
        CHECK(text_run("NEEDS YOU") && text_run("FINISHED") && !text_run("FAILED"));
        pod_model_unread_clear(&M);
        pod_model_question_close(&M, "q");
        fresh();
        cs_view_inbox(&F, &N, &M, now);
        CHECK(!text_run("NEEDS YOU") && !text_run("FINISHED") && text_run("No notifications"));
        pod_model_unread_add(&M, "d", "desktop", "The Relaxing chip now follows Rest.", 252, now - 1000u);
        pod_model_question(&M, "q", "Run the migration on the dev database now?");

        // Toast: over every Console screen at most 192 runs
        const pod_unread_t *u = pod_model_unread_find(&M, "d");
        CHECK(u);
        fresh();
        cs_toast(&F, &M, u, now);
        CHECK(text_run("tap to open") && text_run("swipe \xe2\x86\x91 to dismiss") && hits_of(POD_A_BANNER) == 1);
        printf("runs toast %d\n", cs_runs(&F));
        pod_model_swarms(&M, sw, lists, cnt, 1, "t0", NULL, 0);
        struct { const char *name; pod_view_t v; int tab; } scr[] = {
            {"tabs", POD_V_TABS, 0}, {"recent", POD_V_TAB, POD_TAB_RECENT}, {"tab", POD_V_TAB, 0}, {"agent-w", POD_V_AGENT, 0},
            {"agent-q", POD_V_AGENT, 1}, {"recap", POD_V_RECAP, 0}, {"talk", POD_V_TALK, 0}, {"inbox", POD_V_INBOX, 0}};
        for (unsigned i = 0; i < sizeof scr / sizeof scr[0]; i++) {
            const char *aid = scr[i].tab == 1 ? "q" : scr[i].v == POD_V_RECAP ? "d" : "w";
            pod_nav_init(&N);
            N.skin = POD_SKIN_CONSOLE;
            if (scr[i].v == POD_V_TABS) { }
            else if (scr[i].v == POD_V_TAB) { N.depth = 2; N.stack[0].view = POD_V_TABS; N.stack[1].view = POD_V_TAB; N.stack[1].tab = (int8_t)scr[i].tab; snprintf(N.stack[1].tab_id, SWARM_ID_MAX, "t0"); }
            else if (scr[i].v == POD_V_INBOX) { N.depth = 2; N.stack[0].view = POD_V_TABS; N.stack[1].view = POD_V_INBOX; }
            else OPEN(aid, scr[i].v);
            N.talk_started_ms = now - 3000;
            fresh();
            F.banner = true;
            F.mic_level = 3;
            cs_render(&F, &N, &M, now);
            int base = cs_runs(&F);
            cs_toast(&F, &M, u, now);
            printf("runs %s %d + toast %d\n", scr[i].name, base, cs_runs(&F) - base);
            CHECK(base <= 184 && cs_runs(&F) <= 192);
        }

        // Update
        fresh();
        cs_view_ota(&F, "0.1.1", "0.1.2", 62, false);
        CHECK(text_run("0.1.1") && text_run("0.1.2") && text_run("\xe2\x86\x92") && text_run("62%") && text_run("Update") && text_run("System"));
        CHECK(cs_runs(&F) <= 184);
        printf("runs ota %d\n", cs_runs(&F));
        fresh();
        cs_view_ota(&F, "0.1.1", "0.1.2", 100, true);
        CHECK(text_run("restart into 0.1.2") && cs_runs(&F) <= 184);
    }
    printf("test_cs_views: %d checks ok\n", checks);
    return 0;
}
