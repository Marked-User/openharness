#include <stdlib.h>
// Task 8: the Agent, Recap and Talking screens.
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "pod/classic/ci.h"
#include "pod/pod_view.h"
#include "pod/pod_view_shared.h"
#include "pro_canvas.h"

static int checks;
#define CHECK(c) do { assert(c); checks++; } while (0)

enum { K_TEXT = 1, K_RECT = 2, K_IMAGE = 3 };

static pod_model_t M;
static pod_nav_t N;
static pod_out_frame_t F;
static ht_scene_t S;

static bool with_banner;   // the glue will add the banner: the views leave its runs spare
static void render(uint32_t now) {
    memset(&F, 0, sizeof F);
    ht_scene_clear(&S, ht_rgb(0xf6f6f0));
    F.scene = &S;
    F.banner = with_banner;
    pod_render(&F, &N, &M, now);
}
static const ht_run_t *find_text(const char *prefix) {
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && !strncmp(S.runs[i].text, prefix, strlen(prefix))) return &S.runs[i];
    return NULL;
}
static const pod_hit_t *find_hit(pod_action_t a) {
    for (int i = 0; i < F.hit_count; i++) if (F.hits[i].action == a) return &F.hits[i];
    return NULL;
}
// Whether the band's left value carries " · time".
static bool band_dot(void) {
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ci_rg_26 && S.runs[i].y > 221 && S.runs[i].y < 221 + 88 && !strncmp(S.runs[i].text, " \xc2\xb7", 3)) return true;
    return false;
}
// Whether the bar draws a Bold 30 title.
static bool no_bold_title(void) {
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ci_bd_30) return false;
    return true;
}
static int count_cells(void) {
    int n = 0;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == POD_CELL) n++;
    return n;
}
static int count_rects(uint16_t ink, int w) {
    int n = 0;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ink && S.runs[i].w == w) n++;
    return n;
}
// Whether the screen holds exactly the runs pod_pet_draw_on adds for this pet (on `ground`), in a row.
static bool has_pet_on(int x, int y, int side, const char *engine, pod_scene_t scene, uint32_t now, uint32_t started, uint32_t ground) {
    static ht_scene_t scratch;
    ht_scene_clear(&scratch, 0);
    pod_pet_draw_on(&scratch, x, y, side, engine, scene, now, started, ground);
    for (int at = 0; at + scratch.count <= S.count; at++) {
        bool same = true;
        for (int i = 0; i < scratch.count && same; i++) same = !memcmp(&S.runs[at + i], &scratch.runs[i], sizeof S.runs[0]);
        if (same) return true;
    }
    return false;
}


// One tab with: c claude (working), x codex (asking), m muse (idle, no recap), u cursor (idle), d claude (done, recap).
static const char *const ID[] = {"c", "x", "m", "u", "d"};
static const char *const ENG[] = {"claude", "codex", "muse", "cursor", "claude"};
static const char *const *idl[1];
static uint8_t idn[1] = {5};
static cable_swarm_t sw[1];
static void build(void) {
    pod_model_reset(&M);
    for (int i = 0; i < 5; i++) {
        char name[16]; snprintf(name, sizeof name, "agent-%s", ID[i]);
        pod_model_agent(&M, ID[i], name, ENG[i], "Mac Studio");
    }
    pod_model_agents_end(&M);
    idl[0] = ID;
    memset(&sw[0], 0, sizeof sw[0]);
    snprintf(sw[0].id, SWARM_ID_MAX, "s0");
    snprintf(sw[0].name, CABLE_NAME_MAX, "Desktop");
    sw[0].panes = 5; sw[0].agents = 5;
    pod_model_swarms(&M, sw, (const char *const **)idl, idn, 1, "s0", NULL, 0);
    pod_model_link(&M, true);
    pod_model_turn(&M, "c", "started", NULL, 0, 10);
    pod_model_turn(&M, "c", "activity", "Editing touch_gt911.c and turning the touch the same way as the panel", 134, 10);
    pod_model_question(&M, "x", "Run the migration on the dev database now?");
    pod_model_turn(&M, "d", "done", NULL, 0, 20);
    pod_model_recap(&M, "d", "First line. Second line. Third line.", false);
    pod_nav_init(&N);
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
}
static void open_agent(const char *id) {
    pod_nav_init(&N);
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    for (int i = 0; i < 5; i++) if (!strcmp(ID[i], id)) pod_nav_act(&N, &M, POD_A_OPEN_AGENT, i, 0);
}
static void open_view(const char *id, pod_view_t v) {
    open_agent(id);
    pod_view_t now = N.stack[N.depth - 1].view;
    if (v == POD_V_TALK) pod_nav_act(&N, &M, POD_A_TALK, 0, 1000);
    else if (now != v) pod_nav_act(&N, &M, POD_A_RECAP, 0, 0);
    CHECK(N.stack[N.depth - 1].view == v);
}


// The shared verb helpers (the Console and the old pill still use them).
static bool any_text_has(const char *needle);
static void agent_test_spinner_verb(void) {
    char w[POD_VERB_MAX];
    const int room = pod_lcd_verb_room(694 - 248);
    CHECK(pod_activity_verb("Infusing\xe2\x80\xa6", w, sizeof w, room) && !strcmp(w, "Infusing"));
    CHECK(pod_activity_verb("  Reading files... ", w, sizeof w, room) && !strcmp(w, "Reading files"));   // the dial's trim
    CHECK(!pod_activity_verb("Working", w, sizeof w, room) && !pod_activity_verb("Working...", w, sizeof w, room));
    CHECK(!pod_activity_verb("", w, sizeof w, room) && !pod_activity_verb(NULL, w, sizeof w, room));
    CHECK(!pod_activity_verb("Editing touch_gt911.c - turning the touch the same way as the panel", w, sizeof w, room));   // too long: the body
    CHECK(!strcmp(pod_working_verb(0), "Working") && !strcmp(pod_working_verb(6), "Brewing") && !strcmp(pod_working_verb(6 * 14), "Working"));
}

// No "N of M" in the bar, from a tab list or from Recent (owner, 2026-10-10: "bo 3 of 3 di").
static void agent_test_position(void) {
    build();
    open_view("x", POD_V_AGENT);
    render(3000);
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].y < CI_BAR_H) CHECK(strstr(S.runs[i].text, " of ") == NULL);
    open_view("d", POD_V_RECAP);
    render(3000);
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].y < CI_BAR_H) CHECK(strstr(S.runs[i].text, " of ") == NULL);
}

// A 600 byte Vietnamese activity: the model cuts it at a codepoint boundary, the view fills 8 rows and ends with "...".
static bool utf8_valid(const char *s) {
    for (const unsigned char *p = (const unsigned char *)s; *p;) {
        int n = *p < 0x80 ? 1 : (*p >> 5) == 6 ? 2 : (*p >> 4) == 14 ? 3 : (*p >> 3) == 30 ? 4 : 0;
        if (!n) return false;
        for (int k = 1; k < n; k++) if ((p[k] & 0xc0) != 0x80) return false;
        p += n;
    }
    return true;
}

static void agent_test_one_pet(void) {
    build();
    static const pod_view_t views[] = {POD_V_AGENT, POD_V_RECAP, POD_V_TALK};
    for (int i = 0; i < 5; i++)
        for (int v = 0; v < 3; v++) {
            open_agent(ID[i]);
            pod_view_t cur = N.stack[N.depth - 1].view;
            if (views[v] == POD_V_TALK) pod_nav_act(&N, &M, POD_A_TALK, 0, 1000);
            else if (cur != views[v]) pod_nav_act(&N, &M, POD_A_RECAP, 0, 0);
            if (N.stack[N.depth - 1].view != views[v]) continue;   // a done agent has no Agent view
            for (uint32_t t = 2000; t < 4000; t += 211) {
                render(t);
                CHECK(count_cells() <= 2);   // one scene: its frame and at most an overlay
                CHECK(S.count <= HT_RUNS && F.hit_count <= 32);
            }
        }
}

static void agent_test_runs_constant(void) {
    build();
    static const struct { const char *id; pod_view_t v; } cases[] = {
        {"c", POD_V_AGENT}, {"x", POD_V_AGENT}, {"m", POD_V_AGENT}, {"u", POD_V_AGENT},
        {"c", POD_V_RECAP}, {"d", POD_V_RECAP}, {"m", POD_V_RECAP}, {"c", POD_V_TALK}, {"u", POD_V_TALK}, {"d", POD_V_TALK},
    };
    for (unsigned k = 0; k < sizeof cases / sizeof cases[0]; k++) {
        open_view(cases[k].id, cases[k].v);
        render(1000);
        int want = S.count;
        CHECK(want > 0 && want <= HT_RUNS);
        for (uint32_t t = 1000; t < 7000; t += 137) { render(t); CHECK(S.count == want); }
    }
}


static bool any_text_has(const char *part) {
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && strstr(S.runs[i].text, part)) return true;
    return false;
}


static int count_kind_run(int kind);
static const ht_run_t *find_in(const ht_pro_font_t *font, const char *prefix);
// ---- Classic Voice (listening and sending): the Index look draws no bell, no transport and no buttons; one full-screen TALK
// hit sends. The look itself is pinned in test_pod_views_inbox.c (test_talk_*).
static int wave_bars(void) {
    int n = 0;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ht_rgb(0x2c6e64) && S.runs[i].w == 5) n++;
    return n;
}
static void talk_test_word_without_pet(void) {
    build();
    CHECK(!pod_pet_has("cursor", POD_SCENE_LISTEN));
    open_view("u", POD_V_TALK);
    render(4000);
    CHECK(count_cells() == 0 && wave_bars() == 13);   // no pet: the text and the bars alone
    CHECK(find_in(&ci_rg_48, "Listening.") && find_in(&ci_rg_24, "Tap to send.") && find_in(&ci_bd_23, "agent-u"));
    CHECK(count_rects(ht_rgb(0xff3b30), 12) == 0);
    int runs = S.count;
    for (uint32_t t = 4000; t < 5700; t += 105) { render(t); CHECK(S.count == runs); }   // the bars keep their slots
}

static void talk_test_listen_with_pet(void) {
    build();
    CHECK(pod_pet_has("claude", POD_SCENE_LISTEN));
    open_view("c", POD_V_TALK);
    render(4000);
    CHECK(has_pet_on(219, 192, 281, "claude", POD_SCENE_LISTEN, 4000, 1000, 0xf6f6f0));
    CHECK(find_in(&ci_rg_48, "Listening.") && find_in(&ci_bd_23, "agent-c") && find_in(&ci_rg_23, "To "));
    CHECK(find_text("TABS") == NULL && find_text("TALK") == NULL && find_text("PANES") == NULL && find_text("SEND") == NULL);
}

static void transport_test_hit_sizes(void) {   // Voice has no transport: the Back hit and one full-screen TALK hit
    build();
    static const char *const ids[] = {"c", "u"};
    for (unsigned k = 0; k < 2; k++) {
        open_view(ids[k], POD_V_TALK);
        render(2000);
        CHECK(F.hit_count == 2);
        const pod_hit_t *talk = find_hit(POD_A_TALK), *back = find_hit(POD_A_BACK);
        CHECK(talk && talk->x == 0 && talk->y == 88 && talk->w == 720 && talk->h == 632);
        CHECK(back && back->x == 0 && back->y == 0 && back->w == 173 && back->h == 88);
        CHECK(!find_hit(POD_A_TABS) && !find_hit(POD_A_PANES) && !find_hit(POD_A_PREV) && !find_hit(POD_A_NEXT) && !find_hit(POD_A_INBOX));
    }
}

// After the stop tap the voice screen stays up as "sending": the pet plays SEND from the tap and holds its last step; a pet-less
// engine gets the text alone. The Agent screen never plays SEND.
static void send_test_pet_in_listen_slot(void) {
    static const char *const eng[] = {"c", "x", "m"};
    static const char *const name[] = {"claude", "codex", "muse"};
    for (int k = 0; k < 3; k++) {
        build();
        open_view(eng[k], POD_V_TALK);
        pod_out_t o = pod_nav_act(&N, &M, POD_A_TALK, 0, 6000);
        CHECK(o.fx == POD_FX_VOICE_END && N.stack[N.depth - 1].view == POD_V_TALK && N.sending);
        const ht_pet_scene_t *sc = pod_pet_for(name[k])->sending_scene;
        CHECK(sc != NULL);
        uint32_t len = (uint32_t)sc->steps * sc->step_ms;
        render(6000 + 50);
        CHECK(has_pet_on(255, 186, 209, name[k], POD_SCENE_SEND, 6050, 6000, 0xf6f6f0));
        CHECK(!has_pet_on(219, 192, 281, name[k], POD_SCENE_LISTEN, 6050, 1000, 0xf6f6f0));
        CHECK(find_in(&ci_bd_45, "Sending your words") && !find_in(&ci_rg_48, "Listening.") && find_in(&ci_rg_30, "agent-"));
        int want = S.count;
        render(6000 + len - 1);
        CHECK(has_pet_on(255, 186, 209, name[k], POD_SCENE_SEND, 6000 + len - 1, 6000, 0xf6f6f0) && S.count == want);
        render(6000 + len + 5000);   // held on its last step
        CHECK(has_pet_on(255, 186, 209, name[k], POD_SCENE_SEND, 6000 + len + 5000, 6000, 0xf6f6f0));
        CHECK(pod_view_talk_next_ms(&N, &M, 6000 + len + 5000) > 0);
        // the turn begins: the Agent screen shows the working gif, no SEND
        pod_model_sent(&M, ID[k], 6100);
        pod_model_turn(&M, ID[k], "started", NULL, 0, 6200);
        pod_nav_sync(&N, &M);
        CHECK(N.stack[N.depth - 1].view == POD_V_AGENT);
        render(6300);
        CHECK(!has_pet_on(32, 104, 104, name[k], POD_SCENE_SEND, 6300, 6000, 0xf6f6f0));
    }
    // A tap on the voice screen while sending does nothing.
    CHECK(pod_nav_act(&N, &M, POD_A_TALK, 0, 7000).fx != POD_FX_VOICE_END);
}
static void send_test_word_without_pet(void) {
    build();
    CHECK(!pod_pet_has("cursor", POD_SCENE_SEND));
    open_view("u", POD_V_TALK);
    pod_nav_act(&N, &M, POD_A_TALK, 0, 6000);
    render(6000);
    CHECK(count_cells() == 0 && find_in(&ci_bd_45, "Sending your words") && !find_in(&ci_rg_48, "Listening.") && wave_bars() == 0);
    int runs = S.count;
    for (uint32_t t = 6000; t < 7600; t += 105) {
        render(t);
        CHECK(S.count == runs);   // constant per frame
        CHECK(pod_view_talk_next_ms(&N, &M, t) == POD_PET_STEP_MS);
    }
}

static int chrome_arcs(void) {   // arcs in the status bar and transport (the pets draw their own)
    int n = 0;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == POD_ARC && S.runs[i].w > 0 && (S.runs[i].y < CI_BAR_H || S.runs[i].y >= POD_TRANSPORT_Y)) n++;
    return n;
}
static int count_kind_run(int kind) {
    int n = 0;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == kind) n++;
    return n;
}
// Owner round 2: the icons are POD_TRI triangles (a mitered chevron, play triangles, no pie slices), the info line is
// "<Tab> . <Machine>", and a long name is one line cut with "..." on both screens.
static void icon_test_triangles(void) {
    build();
    open_view("m", POD_V_AGENT);
    render(3000);
    // the bar's chevron (4); two chrome arcs: the outline bell's dome and the Talk mic's cradle.
    CHECK(count_kind_run(POD_TRI) == 4 && chrome_arcs() == 2);
    open_view("d", POD_V_RECAP);
    render(3000);
    CHECK(count_kind_run(POD_TRI) == 4 + 4 && chrome_arcs() == 2);   // + the band's tick (4)
}
// The chevron is one clean stroke: no gaps at the joint, nothing outside its outline.
static void icon_test_chevron_solid(void) {
    enum { W = 64, H = 64 };
    static uint16_t buf[W * H];
    ht_scene_t sc;
    ht_scene_clear(&sc, 0xffff);
    uint16_t blue = ht_rgb(0x1f63d1);
    pod_chevron(&sc, 20, 30, 13, blue);
    CHECK(sc.count == 4);
    memset(buf, 0xff, sizeof buf);
    ht_rect_t clip = {0, 0, W, H};
    for (int i = 0; i < sc.count; i++) ht_pro_raster(&sc.runs[i], clip, buf);
    for (int px = 22; px <= 30; px++) {
        CHECK(buf[(49 - px) * W + px] == blue);   // the upper arm's centreline
        CHECK(buf[(px + 10) * W + px] == blue);   // the lower arm's
    }
    for (int px = 19; px <= 21; px++) CHECK(buf[29 * W + px] == blue && buf[30 * W + px] == blue);   // across the joint
    CHECK(buf[30 * W + 14] == 0xffff && buf[10 * W + 20] == 0xffff && buf[30 * W + 40] == 0xffff);
    // The same for the tick.
    ht_scene_clear(&sc, 0xffff);
    pod_tick(&sc, 10, 20, blue);
    CHECK(sc.count == 4);
    memset(buf, 0xff, sizeof buf);
    for (int i = 0; i < sc.count; i++) ht_pro_raster(&sc.runs[i], clip, buf);
    int inked = 0;
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) if (buf[y * W + x] == blue) inked++;
    CHECK(inked > 40);
    CHECK(buf[(20 + 13) * W + 17] == blue || buf[(20 + 13) * W + 16] == blue || buf[(20 + 12) * W + 17] == blue);   // the joint
}



// ---- the pill takes the glass's colour; the steps of a working turn ----------------------------------------

enum { GROUND = 0xeeede5 };   // HT_THEME_CANVAS: what the Pod screen is cleared to on the device
static uint16_t px[56 * 450];
static void raster_pill(int x, int y, int w, uint16_t ground) {
    static ht_scene_t sc;
    ht_scene_clear(&sc, ground);
    pod_agent_t a;
    memset(&a, 0, sizeof a);
    snprintf(a.id, sizeof a.id, "c");
    a.state = POD_WORKING;
    pod_lcd_pill(&sc, x, y, w, &a, 1000);
    ht_rect_t clip = {x - 4, y - 4, w + 8, POD_LCD_H + 8};
    for (int i = 0; i < clip.w * clip.h; i++) px[i] = ground;
    for (int i = 0; i < sc.count; i++) {
        if (sc.runs[i].pro_kind >= POD_KIND_BASE) pod_draw_raster(&sc.runs[i], clip, px);
        else ht_pro_raster(&sc.runs[i], clip, px);
    }
}
static void lcd_test_content_only(void) {
    const int x = 248, y = 190, w = 446;
    const uint16_t ground = ht_rgb(GROUND);
    raster_pill(x, y, w, ground);
    const int cw = w + 8;
    #define PX(X, Y) px[((Y) - (y - 4)) * cw + ((X) - (x - 4))]
    // no rim, no fill: the strips along the top and bottom (content sits 8 px in), the corners and both sides are the ground
    for (int yy = y; yy <= y + 5; yy++)
        for (int xx = x; xx < x + w; xx++) CHECK(PX(xx, yy) == ground);
    for (int yy = y + POD_LCD_H - 6; yy < y + POD_LCD_H; yy++)
        for (int xx = x; xx < x + w; xx++) CHECK(PX(xx, yy) == ground);
    for (int yy = y; yy < y + POD_LCD_H; yy++) CHECK(PX(x, yy) == ground && PX(x + w - 1, yy) == ground && PX(x + 8, yy) == ground);
    #undef PX
    // only the three bars, the verb and the time: five runs, whatever the clock or the ground
    for (uint32_t t = 0; t < 3000; t += 250) {
        static ht_scene_t sc;
        ht_scene_clear(&sc, 0);
        pod_agent_t a;
        memset(&a, 0, sizeof a);
        a.state = POD_WORKING;
        pod_lcd_pill(&sc, x, y, w, &a, t);
        CHECK(sc.count == 5);
    }
}




// ---- Classic Index: Agent and Recap -------------------------------------------------------------------------------

static bool has_pet104(const char *engine, pod_scene_t scene, uint32_t now) { return has_pet_on(32, 104, 104, engine, scene, now, 0, 0xf6f6f0); }
static const ht_run_t *find_in(const ht_pro_font_t *font, const char *prefix) {
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == font && !strncmp(S.runs[i].text, prefix, strlen(prefix))) return &S.runs[i];
    return NULL;
}
static int count_in(const ht_pro_font_t *font, int y0, int y1) {
    int n = 0;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == font && S.runs[i].y >= y0 && S.runs[i].y < y1) n++;
    return n;
}
static bool ends_with(const char *t, const char *tail) { size_t a = strlen(t), b = strlen(tail); return a >= b && !strcmp(t + a - b, tail); }
static void push_steps(const char *id, int n, uint32_t t) {
    for (int i = 0; i < n; i++) { char st[40]; snprintf(st, sizeof st, "Step %d \xc2\xb7 file%d.c", i + 1, i + 1); pod_model_turn(&M, id, "step", st, 134, t + (uint32_t)i); }
}
// A Vietnamese sentence, cut by the model at a codepoint.
static void viet(char *out, size_t n) {
    out[0] = 0;
    while (strlen(out) < n - 160) strcat(out, "Đang kiểm tra những nguyên nhân khiến thiết bị không kết nối được ");
}

static void test_agent_working_body(void) {
    build();
    push_steps("c", 3, 20);
    open_view("c", POD_V_AGENT);
    render(3000);
    CHECK(!find_in(&ci_bd_30, "Task") && no_bold_title() && find_in(&ci_rg_26, "Desktop") && find_hit(POD_A_BACK));   // no title; the back label is the origin tab
    CHECK(find_in(&ci_rg_41, "agent-c") && find_in(&ci_rg_41, "agent-c")->x == 152);
    CHECK(find_in(&ci_rg_23, "Desktop \xc2\xb7 Mac Studio"));
    CHECK(has_pet104("claude", POD_SCENE_WORK, 3000));
    CHECK(find_in(&ci_rg_20, "Status") && find_in(&ci_rg_26, "Working") && find_in(&ci_rg_26, " \xc2\xb7 2:") && find_in(&ci_rg_26, "Claude"));   // the band: Status, "Working · 2:14", Engine (no tokens)
    const ht_run_t *stl = find_in(&ci_rg_20, "Status"), *enl = find_in(&ci_rg_20, "Engine"), *stv = find_in(&ci_rg_26, "Working"), *stt = find_in(&ci_rg_26, " \xc2\xb7 2:");
    CHECK(stl->fg == CI_MUTED && stl->x == 32 && stl->y == enl->y && stv->y == find_in(&ci_rg_26, "Claude")->y && stv->y > stl->y);
    CHECK(stt->fg == ht_rgb(0x6b746c) && stt->x >= stv->x + stv->w - 1 && stt->x <= stv->x + stv->w + 1);
    const ht_run_t *label = find_in(&ci_bd_20, "RIGHT NOW");
    CHECK(label && label->fg == CI_MUTED && label->x == 32);
    const ht_run_t *act = find_in(&ci_rg_32, "Editing touch");
    CHECK(act && act->x == 32 && act->fg == CI_INK && act->y > label->y);
    CHECK(count_in(&ci_rg_32, 300, CI_TRANS_Y) <= 3);
    int steps = 0;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ci_rg_22 && S.runs[i].fg == CI_MUTED && S.runs[i].y > act->y) { steps++; CHECK(S.runs[i].x == 32); }
    CHECK(steps == 2 && find_in(&ci_rg_22, "Step 3") && find_in(&ci_rg_22, "Step 2") && !find_in(&ci_rg_22, "Step 1"));   // the two newest
    const ht_run_t *up = find_in(&ci_rg_20, "Updated just now");
    CHECK(up && up->fg == ht_rgb(0x7b827c) && up->y > find_in(&ci_rg_22, "Step 2")->y);
    const pod_hit_t *talk = find_hit(POD_A_TALK);
    CHECK(talk && talk->x == 32 && talk->w == 656 && talk->h == 88);
    CHECK(!find_hit(POD_A_PREV) && !find_hit(POD_A_NEXT) && !find_hit(POD_A_TABS) && !find_hit(POD_A_PANES));   // the old transport is gone
    // A long activity: three lines, the last cut with the ellipsis (the model's own cut also ends with one).
    char big[600] = "";
    for (int i = 1; i <= 60; i++) { char w[24]; snprintf(w, sizeof w, "word%d ", i); strcat(big, w); }
    pod_model_turn(&M, "c", "activity", big, 134, 30);
    render(3000);
    CHECK(count_in(&ci_rg_32, 300, CI_TRANS_Y) == 3);
    const ht_run_t *last = NULL;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ci_rg_32 && S.runs[i].y > 300) last = &S.runs[i];
    CHECK(last && ends_with(last->text, "\xe2\x80\xa6") && last->w <= 656);
    // No activity text: the rotating gerund, not an empty body.
    pod_model_turn(&M, "c", "started", NULL, 0, 40);
    pod_model_turn(&M, "c", "activity", "", 0, 40);
    render(3000);
    CHECK(find_in(&ci_rg_32, "Working\xe2\x80\xa6"));
}

static void test_agent_updated_minutes(void) {
    build();
    open_view("c", POD_V_AGENT);
    render(59000);   // event at 10 ms: 58.99 s
    CHECK(find_in(&ci_rg_20, "Updated just now"));
    render(60010);
    CHECK(find_in(&ci_rg_20, "Updated 1m ago"));
    render(180010);
    CHECK(find_in(&ci_rg_20, "Updated 3m ago") && !find_in(&ci_rg_20, "Updated just"));
    render(3600010 - 1);
    CHECK(find_in(&ci_rg_20, "Updated 59m ago"));
    render(3600010);
    CHECK(find_in(&ci_rg_20, "Updated 1h ago"));
    render(2u * 3600000u + 10 + 59 * 60000u);
    CHECK(find_in(&ci_rg_20, "Updated 2h ago"));
    render(1000);   // the clock behind the event: still "just now"
    CHECK(find_in(&ci_rg_20, "Updated just now"));
    pod_agent_t *a = (pod_agent_t *)pod_model_find(&M, "c");   // no event time: no line, never "0"
    a->has_event = false;
    render(3000);
    CHECK(!find_in(&ci_rg_20, "Updated"));
    a->has_event = true; a->event_ms = 0;
    render(3000);
    CHECK(!find_in(&ci_rg_20, "Updated"));
}

static void test_agent_asking(void) {
    build();
    open_view("x", POD_V_AGENT);
    render(3000);
    CHECK(has_pet104("codex", POD_SCENE_ASK, 3000));
    CHECK(find_in(&ci_rg_26, "Needs you")->fg == CI_AMBER && !band_dot());   // elapsed unknown: no time and no dangling dot
    bool box = false, bar = false;
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->pro_kind == K_RECT && r->fg == CI_ASK_FILL && r->x == 32 && r->w == 656) box = true;
        if (r->pro_kind == K_RECT && r->fg == CI_ASK_BAR && r->x == 32 && r->w == 4) bar = true;
    }
    CHECK(box && bar);
    const ht_run_t *q = find_in(&ci_rg_32, "Run the migration");
    CHECK(q && q->x == 32 + 23 && q->fg == CI_INK);
    const ht_run_t *hint = find_in(&ci_rg_23, "Answer it in the Harness app.");
    CHECK(hint && hint->fg == CI_MUTED && hint->y > q->y && hint->x == 32);
    CHECK(!find_in(&ci_bd_20, "RIGHT NOW") && !find_hit(POD_A_TALK));
    // The transport is drawn disabled (one run fewer than none: the button still exists, at 45%).
    CHECK(find_in(&ci_rg_28, "Talk"));
    // A three line question stays above the hint and the transport.
    char big[600] = "";
    for (int i = 1; i <= 40; i++) { char w[24]; snprintf(w, sizeof w, "question%d ", i); strcat(big, w); }
    pod_model_question(&M, "x", big);
    render(3000);
    CHECK(count_in(&ci_rg_32, 300, CI_TRANS_Y) <= 3 && find_in(&ci_rg_23, "Answer it")->y + ci_rg_23.height <= CI_TRANS_Y);
}

static void offline_setup(void) {
    build();
    cable_swarm_t sw1[1];
    memset(sw1, 0, sizeof sw1);
    snprintf(sw1[0].id, SWARM_ID_MAX, "s0"); snprintf(sw1[0].name, CABLE_NAME_MAX, "Desktop");
    sw1[0].panes = 6; sw1[0].agents = 6;
    static const char *ids6[] = {"c", "x", "m", "u", "d", "off"};
    const char *const *idl6[1] = {ids6};
    uint8_t cnt6[1] = {6};
    static pod_member_meta_t meta[1][POD_PANES_MAX];
    memset(meta, 0, sizeof meta);
    meta[0][5] = (pod_member_meta_t){"Stylist", "codex", "Diego's Mac", true, false};
    pod_model_swarms_meta(&M, sw1, idl6, cnt6, 1, "s0", NULL, 0, meta);
    CHECK(pod_model_find(&M, "off") && pod_model_find(&M, "off")->state == POD_OFFLINE);
    pod_nav_init(&N);
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    pod_out_t o = pod_nav_act(&N, &M, POD_A_OPEN_AGENT, 5, 0);
    CHECK(o.fx == POD_FX_AGENT_OPEN && N.stack[N.depth - 1].view == POD_V_AGENT);
}
static void test_agent_offline(void) {
    offline_setup();
    render(3000);
    CHECK(find_in(&ci_rg_41, "Stylist") && find_in(&ci_rg_26, "Offline")->fg == CI_MUTED && find_in(&ci_rg_20, "Status"));
    CHECK(find_in(&ci_rg_32, "That machine is offline.") && find_in(&ci_rg_23, "Reconnect Diego's Mac in Harness to continue."));
    CHECK(!find_in(&ci_bd_20, "RIGHT NOW") && !find_hit(POD_A_TALK) && find_in(&ci_rg_28, "Talk"));
    // The pet cannot fade (cells and arcs): the head is the pale cover with the logo at 50%, and no pet run at all.
    CHECK(!has_pet104("codex", POD_SCENE_REST, 3000) && count_cells() == 0);
    int faded = 0;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_IMAGE && S.runs[i].radius == 128 && S.runs[i].x >= 32 && S.runs[i].x < 136 && S.runs[i].y >= 104 && S.runs[i].y < 208) faded++;
    CHECK(faded == 1);
    pod_out_t o = pod_nav_act(&N, &M, POD_A_TALK, 0, 1000);   // and the nav ignores a Talk tap on it
    CHECK(o.fx == POD_FX_NONE && N.stack[N.depth - 1].view == POD_V_AGENT);
    // No machine name: the copy still reads.
    snprintf(((pod_agent_t *)pod_model_find(&M, "off"))->machine, CABLE_NAME_MAX, "%s", "");
    render(3000);
    CHECK(find_in(&ci_rg_23, "Reconnect it in Harness to continue."));
}

static void test_agent_idle_copy(void) {
    build();
    open_view("m", POD_V_AGENT);
    render(3000);
    CHECK(has_pet104("muse", POD_SCENE_REST, 3000));
    CHECK(find_in(&ci_rg_26, "Ready")->fg == CI_GREEN && !find_in(&ci_rg_22, "\xe2\x80\x94") && !band_dot());
    const ht_run_t *a = find_in(&ci_rg_32, "Ready when you are."), *b = find_in(&ci_rg_23, "Send a new voice instruction to this agent.");
    CHECK(a && a->fg == CI_INK && b && b->fg == CI_MUTED && b->y > a->y && a->x == 32);
    CHECK(find_hit(POD_A_TALK) && !find_in(&ci_bd_20, "RIGHT NOW") && !find_in(&ci_rg_20, "Updated"));
    open_view("u", POD_V_AGENT);   // cursor: no pet, the engine's cover
    render(3000);
    CHECK(find_in(&ci_rg_32, "Ready when you are.") && find_hit(POD_A_TALK));
}

static void test_agent_vietnamese_activity_wraps(void) {
    build();
    char big[800];
    viet(big, sizeof big);
    pod_model_turn(&M, "c", "activity", big, 134, 10);
    open_view("c", POD_V_AGENT);
    render(3000);
    int rows = 0;
    const ht_run_t *last = NULL;
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->pro_kind == K_TEXT && r->pro_font == &ci_rg_32 && r->y > 300 && r->y < CI_TRANS_Y) {
            rows++; last = r;
            CHECK(utf8_valid(r->text) && r->w <= 656 && r->x == 32 && r->x + r->w <= 688);
        }
    }
    CHECK(rows == 3 && last && ends_with(last->text, "\xe2\x80\xa6"));
    // A long Vietnamese name, tab and back label end with the ellipsis inside their boxes: never over the time, the bell or each other.
    char name[CABLE_NAME_MAX];
    snprintf(name, sizeof name, "%s", "Đang kiểm tra những nguyên nhân khiến thiết bị không kết nối được nữa");
    pod_model_agent(&M, "c", name, "claude", "Máy tính của Diệp ở văn phòng phía sau nhà");
    snprintf(sw[0].name, CABLE_NAME_MAX, "%s", "Thư mục dự án chung của cả nhóm phát triển phần mềm");
    pod_model_swarms(&M, sw, (const char *const **)idl, idn, 1, "s0", NULL, 0);
    open_view("c", POD_V_AGENT);
    render(3000);
    const ht_run_t *nm = NULL, *who = NULL, *back = NULL;
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->pro_kind != K_TEXT) continue;
        if (r->pro_font == &ci_rg_41) nm = r;
        if (r->pro_font == &ci_rg_23 && r->y < 200) who = r;
        if (r->pro_font == &ci_rg_26 && r->y < 88) back = r;
    }
    CHECK(nm && nm->x == 152 && nm->x + nm->w <= 688 && ends_with(nm->text, "\xe2\x80\xa6") && utf8_valid(nm->text));
    CHECK(who && who->x == 152 && who->x + who->w <= 688 && ends_with(who->text, "\xe2\x80\xa6") && utf8_valid(who->text));
    CHECK(back && back->w > 115 && back->x + back->w <= F.bell_x - 16 && utf8_valid(back->text));   // the room is up to the bell; cut (with U+2026) only past it
    CHECK(!strstr(nm->text, "\n") && who->y > nm->y + 40);
}

static void test_agent_unknown_engine_mark(void) {
    build();
    pod_model_agent(&M, "c", "agent-c", "zzz", "Mac Studio");   // an engine with no logo and no pet
    open_view("c", POD_V_AGENT);
    render(3000);
    int images = 0;
    bool cover = false;
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->pro_kind == K_IMAGE) images++;
        if (r->pro_kind == K_RECT && r->x == 32 && r->y == 104 && r->w == 104 && r->pro_height == 104) cover = true;
    }
    CHECK(images == 0 && cover && count_cells() == 0);   // the default mark box, no logo, no pet sprite
    CHECK(find_in(&ci_rg_26, "Zzz") || find_in(&ci_rg_26, "\xe2\x80\x94"));   // the band names the engine or shows a dash
    for (int i = 0; i < S.count; i++) CHECK(!(S.runs[i].pro_kind == K_TEXT && S.runs[i].text[0] == 0));
    // The same on Recap, and with no tokens and no elapsed time the band says so with dashes only.
    open_view("d", POD_V_RECAP);
    pod_model_agent(&M, "d", "agent-d", "zzz", "Mac Studio");
    render(3000);
    CHECK(find_in(&ci_rg_20, "Engine") && !find_in(&ci_rg_20, "Tokens"));
    for (int i = 0; i < S.count; i++) {
        if (S.runs[i].pro_kind != K_TEXT) continue;
        CHECK(strcmp(S.runs[i].text, "0") != 0 && strcmp(S.runs[i].text, "\xc2\xb7") != 0 && strncmp(S.runs[i].text, "\xc2\xb7 ", 3) != 0);
        CHECK(!ends_with(S.runs[i].text, " \xc2\xb7"));
    }
}

// No title on Agent and Recap: the back label (the tab's name) may use the room up to the bell (left edge - 16); BACK follows it.
static const ht_run_t *back_label(void) {
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ci_rg_26 && S.runs[i].y < CI_BAR_H) return &S.runs[i];
    return NULL;
}
static void test_back_label_room(void) {
    build();
    snprintf(M.tabs[0].name, sizeof M.tabs[0].name, "%s", "Firmware projects");
    for (int v = 0; v < 2; v++) {
        open_view(v ? "d" : "c", v ? POD_V_RECAP : POD_V_AGENT);
        render(3000);
        const ht_run_t *l = back_label();
        const pod_hit_t *b = find_hit(POD_A_BACK), *in = find_hit(POD_A_INBOX);
        CHECK(l && !strcmp(l->text, "Firmware projects") && l->w > 115 && l->x + l->w <= F.bell_x - 16);   // whole, wider than 115 px
        CHECK(b && in && b->w >= 173 && b->w >= l->x + l->w - b->x && b->x + b->w <= in->x && no_bold_title());
    }
    char name[CABLE_NAME_MAX];
    memset(name, 0, sizeof name);
    for (int i = 0; i < CABLE_NAME_MAX - 1 && i < 60; i++) name[i] = 'W';
    snprintf(M.tabs[0].name, sizeof M.tabs[0].name, "%s", name);
    open_view("c", POD_V_AGENT);
    render(3000);
    const ht_run_t *l = back_label();
    size_t n = l ? strlen(l->text) : 0;
    const pod_hit_t *b = find_hit(POD_A_BACK);
    CHECK(l && n > 3 && !strcmp(l->text + n - 3, "\xe2\x80\xa6") && l->w > 115 && l->x + l->w <= F.bell_x - 16 && F.bell_x - 16 - (l->x + l->w) < 40);
    CHECK(b && b->x + b->w <= 632 && b->w >= 173);
    pod_model_unread_add(&M, "c", "agent-c", "Done", 48, 100);   // a pill narrows the room: the label still clears the bell
    render(3000);
    l = back_label();
    CHECK(l && l->x + l->w <= F.bell_x - 16);
}

static void test_recap_tokens_or_engine(void) {
    build();
    open_view("d", POD_V_RECAP);
    render(3000);
    CHECK(!find_in(&ci_bd_30, "Recap") && no_bold_title() && find_in(&ci_rg_26, "Desktop") && find_hit(POD_A_BACK));
    CHECK(find_in(&ci_rg_20, "Engine") && find_in(&ci_rg_26, "Claude") && !find_in(&ci_rg_20, "Tokens"));
    CHECK(has_pet104("claude", POD_SCENE_REST, 3000));
    CHECK(find_in(&ci_rg_26, "Finished") && !any_text_has("SAVED RESULT") && !any_text_has("Saved result"));
    CHECK(!find_in(&ci_rg_22, "\xe2\x80\x94") && !band_dot());   // no elapsed time was sent: no time, no dangling dot
    pod_model_turn_stats(&M, "d", -1, -1, -1, 10100, 2300);
    pod_model_turn(&M, "d", "activity", "Wrapping up", 48, 25);
    pod_model_turn(&M, "d", "done", NULL, 0, 30);
    render(3000);
    CHECK(find_in(&ci_rg_20, "Tokens") && find_in(&ci_rg_26, "10.1k in \xc2\xb7 2.3k out") && !find_in(&ci_rg_20, "Engine"));
    CHECK(find_in(&ci_rg_26, "Finished") && find_in(&ci_rg_26, " \xc2\xb7 0:48"));
    const ht_run_t *body = find_in(&ci_rg_32, "First line.");
    CHECK(body && body->fg == CI_INK && body->x == 32 && strstr(body->text, "Second line.") && strstr(body->text, "Third line."));   // joined, one row
    CHECK(find_hit(POD_A_TALK) && pod_recap_max_row(&N, &M) == 0);
    // A recap with no text: the Talk button stays, the body says so.
    open_view("m", POD_V_RECAP);
    render(3000);
    CHECK(find_in(&ci_rg_32, "No recap yet.") || N.stack[N.depth - 1].view == POD_V_AGENT);
}

static void test_recap_scrolls_by_line(void) {
    build();
    char big[900] = "";
    for (int i = 1; i <= 30; i++) { char w[40]; snprintf(w, sizeof w, "Sentence-%02d-wide-token ", i); strcat(big, w); }   // one per row
    pod_model_recap(&M, "d", big, false);
    open_view("d", POD_V_RECAP);
    render(3000);
    const int shown = count_in(&ci_rg_32, 300, CI_TRANS_Y), max = pod_recap_max_row(&N, &M);
    CHECK(shown == 6 && max == 30 - 6 && pod_scroll_max(&N, &M) == max);
    const ht_run_t *first = find_in(&ci_rg_32, "Sentence-01-"), *second = find_in(&ci_rg_32, "Sentence-02-");
    CHECK(first && second && second->y - first->y == 42 && first->y == 324 && first->y > find_in(&ci_rg_26, "Finished")->y);   // the body starts where the eyebrow was
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ci_rg_32 && S.runs[i].y > 300) CHECK(S.runs[i].y + ci_rg_32.height <= CI_TRANS_Y && S.runs[i].w <= 656);
    const ht_run_t *lastrow = NULL;   // more below: the last visible row ends with the ellipsis
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ci_rg_32 && S.runs[i].y > 300) lastrow = &S.runs[i];
    CHECK(lastrow && ends_with(lastrow->text, "\xe2\x80\xa6") && strstr(lastrow->text, "Sentence-06"));
    int y0 = first->y;
    pod_nav_act(&N, &M, POD_A_SCROLL, 1, 0);   // one line
    render(3000);
    const ht_run_t *now2 = find_in(&ci_rg_32, "Sentence-02-");
    CHECK(!find_in(&ci_rg_32, "Sentence-01-") && now2 && now2->y == y0 && find_in(&ci_rg_32, "Sentence-07-"));
    pod_nav_act(&N, &M, POD_A_SCROLL, 1000, 0);   // past the end: the draw clamps; the whole text, no dots
    render(3000);
    CHECK(find_in(&ci_rg_32, "Sentence-30-") && !find_in(&ci_rg_32, "Sentence-24-") && find_in(&ci_rg_32, "Sentence-25-")->y == y0);
    for (int i = 0; i < S.count; i++) CHECK(!(S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ci_rg_32 && ends_with(S.runs[i].text, "\xe2\x80\xa6")));
    pod_nav_act(&N, &M, POD_A_SCROLL, -3000, 0);
    render(3000);
    CHECK(find_in(&ci_rg_32, "Sentence-01-")->y == y0);
    // The 50 word cut still ends "...", the source's own cut ends with the ellipsis.
    char fifty[1800] = "";
    for (int i = 1; i <= 120; i++) { char w[40]; snprintf(w, sizeof w, "%sTiếng%d", i > 1 ? " " : "", i); strcat(fifty, w); }
    pod_model_recap(&M, "d", fifty, false);
    pod_nav_act(&N, &M, POD_A_SCROLL, -3000, 0);
    pod_nav_act(&N, &M, POD_A_SCROLL, 1000, 0);
    render(3000);
    bool end50 = false;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && strstr(S.runs[i].text, "Tiếng50") && utf8_valid(S.runs[i].text)) end50 = true;
    CHECK(end50 && !any_text_has("Tiếng51"));
    pod_model_recap(&M, "d", "Fixed the parser and then +", false);
    render(3000);
    CHECK(find_in(&ci_rg_32, "Fixed the parser and then") && !any_text_has("+") && ends_with(find_in(&ci_rg_32, "Fixed")->text, "\xe2\x80\xa6"));
    pod_model_recap(&M, "d", "First line. Second line.", false);
    render(3000);
    CHECK(!ends_with(find_in(&ci_rg_32, "First")->text, "\xe2\x80\xa6"));
}

static void budget_model(void) {   // the worst bodies, and an unread entry of an agent we never open: the bell and its pill
    build();
    char big[800];
    viet(big, sizeof big);
    pod_model_turn(&M, "c", "activity", big, 134, 10);
    push_steps("c", 3, 20);
    char q[600] = "";
    for (int i = 1; i <= 40; i++) { char w[24]; snprintf(w, sizeof w, "question%d ", i); strcat(q, w); }
    pod_model_question(&M, "x", q);
    pod_model_turn_stats(&M, "d", -1, -1, -1, 10100, 2300);
    char rec[900] = "";
    for (int i = 1; i <= 30; i++) { char w[40]; snprintf(w, sizeof w, "Sentence-%02d-wide-token ", i); strcat(rec, w); }
    pod_model_recap(&M, "d", rec, false);
    pod_model_unread_add(&M, "ghost", "ghost", "Done", 48, 100);
}
static void test_agent_budget(void) {
    static const struct { const char *id; pod_view_t v; } cases[] = {
        {"c", POD_V_AGENT}, {"x", POD_V_AGENT}, {"m", POD_V_AGENT}, {"u", POD_V_AGENT}, {"d", POD_V_RECAP}, {"c", POD_V_RECAP},
    };
    int worst = 0;
    for (int banner = 0; banner < 2; banner++) {
        with_banner = banner;
        budget_model();
        for (unsigned k = 0; k < sizeof cases / sizeof cases[0]; k++) {
            open_view(cases[k].id, cases[k].v);
            pod_nav_act(&N, &M, POD_A_SCROLL, 2, 0);
            for (uint32_t t = 3000; t < 3300; t += 66) {
                render(t);
                CHECK(F.unread > 0 && S.count <= POD_CLASSIC_RUNS - pod_spare_runs(&F) - 4);
                if (S.count > worst) worst = S.count;
            }
        }
        offline_setup();   // an offline agent over the same bell
        pod_model_unread_add(&M, "ghost", "ghost", "Done", 48, 100);
        render(3000);
        CHECK(F.unread > 0 && S.count <= POD_CLASSIC_RUNS - pod_spare_runs(&F) - 4);
        if (S.count > worst) worst = S.count;
    }
    with_banner = false;
    printf("test_pod_views_agent: classic Agent/Recap worst case %d runs of %d\n", worst, POD_CLASSIC_RUNS);
}

// Low1: the Agent band shows Engine whatever the agent's tokens; only Recap shows Tokens.
static void test_agent_band_engine_not_tokens(void) {
    build();
    pod_model_turn_stats(&M, "c", -1, -1, -1, 10100, 2300);   // working, with tokens
    pod_model_turn_stats(&M, "u", -1, -1, -1, 980, 40);        // idle, with tokens
    for (int k = 0; k < 2; k++) {
        open_view(k ? "u" : "c", POD_V_AGENT);
        render(3000);
        CHECK(find_in(&ci_rg_20, "Engine") && !find_in(&ci_rg_20, "Tokens") && !find_in(&ci_rg_26, "10.1k"));
    }
    pod_model_turn(&M, "d", "done", NULL, 0, 30);
    pod_model_turn_stats(&M, "d", -1, -1, -1, 980, 40);
    open_view("d", POD_V_RECAP);
    render(3000);
    CHECK(find_in(&ci_rg_20, "Tokens") && !find_in(&ci_rg_20, "Engine"));
}

// Low4: a word wider than the line (a URL) is hard-broken at a character boundary; the text goes on and the last row ends with U+2026.
static bool valid_utf8(const char *t) {
    for (const unsigned char *p = (const unsigned char *)t; *p;) {
        int n = *p < 0x80 ? 1 : (*p & 0xe0) == 0xc0 ? 2 : (*p & 0xf0) == 0xe0 ? 3 : (*p & 0xf8) == 0xf0 ? 4 : 0;
        if (!n) return false;
        for (int i = 1; i < n; i++) if ((p[i] & 0xc0) != 0x80) return false;
        p += n;
    }
    return true;
}
static void test_wrap_long_word(void) {
    char url[400] = "https://example.com/";
    while (strlen(url) < 200) strcat(url, "aa/bbbb?cc=dd&");
    char text[512];
    snprintf(text, sizeof text, "%s and then the sentence goes on for a while", url);
    char rows[3][POD_ROW_MAX];
    int n = pod_wrap_hard(text, &ci_rg_32, 656, 3, rows);
    CHECK(n == 3 && !strncmp(rows[0], "https://", 8) && ht_pro_width(&ci_rg_32, rows[0]) <= 656 && strlen(rows[0]) > 20);
    CHECK(!strncmp(url + strlen(rows[0]), rows[1], 5) || strlen(rows[0]) + strlen(rows[1]) >= strlen(url));   // the word continues on row 2
    char cut[3][POD_ROW_MAX];
    n = ci_wrap(text, &ci_rg_32, 656, 3, cut);
    CHECK(n == 3);
    for (int i = 0; i < n; i++) CHECK(valid_utf8(cut[i]) && ht_pro_width(&ci_rg_32, cut[i]) <= 656);
    CHECK(!strcmp(cut[n - 1] + strlen(cut[n - 1]) - 3, "\xe2\x80\xa6"));   // text remains: the last row ends with the ellipsis
    // A word of two-byte letters longer than the row buffer: never cut inside a sequence.
    char wide[400] = "";
    while (strlen(wide) < 300) strcat(wide, "\xc3\xa9");
    n = pod_wrap_hard(wide, &ci_rg_32, 656, 3, rows);
    CHECK(n > 0);
    for (int i = 0; i < n; i++) CHECK(valid_utf8(rows[i]) && rows[i][0]);
    n = ci_wrap(wide, &ci_rg_32, 656, 1, cut);
    CHECK(n == 1 && valid_utf8(cut[0]) && cut[0][0]);
    // On Recap: the screen shows the URL's start, not nothing.
    build();
    pod_model_recap(&M, "d", text, false);
    open_view("d", POD_V_RECAP);
    render(3000);
    CHECK(find_in(&ci_rg_32, "https://"));
}

int main(void) {
    test_agent_working_body();
    test_back_label_room();
    test_agent_updated_minutes();
    test_agent_asking();
    test_agent_offline();
    test_agent_idle_copy();
    test_agent_vietnamese_activity_wraps();
    test_agent_unknown_engine_mark();
    test_agent_band_engine_not_tokens();
    test_wrap_long_word();
    test_recap_tokens_or_engine();
    test_recap_scrolls_by_line();
    test_agent_budget();
    agent_test_spinner_verb();
    agent_test_position();
    agent_test_one_pet();
    agent_test_runs_constant();
    talk_test_word_without_pet();
    talk_test_listen_with_pet();
    transport_test_hit_sizes();
    send_test_pet_in_listen_slot();
    send_test_word_without_pet();
    icon_test_triangles();
    icon_test_chevron_solid();
    lcd_test_content_only();
    printf("test_pod_views_agent: %d checks passed\n", checks);
    return 0;
}
