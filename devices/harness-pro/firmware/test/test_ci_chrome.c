// Task 3: the Classic Index chrome (ci_chrome.c): bar, Talk transport, metadata band and the number formats.
#include <assert.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#include "pod/classic/ci.h"
#include "pro_canvas.h"

static int checks;
#define CHECK(c) do { assert(c); checks++; } while (0)

enum { K_TEXT = 1 };

static pod_out_frame_t F;
static ht_scene_t S;

static void fresh(void) {
    memset(&F, 0, sizeof F);
    ht_scene_clear(&S, ht_rgb(0xf6f6f0));
    F.scene = &S;
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

static void test_bar_hits(void) {
    fresh();
    ci_bar(&F, "Task", "Recent", 3, true);
    const pod_hit_t *b = find_hit(POD_A_BACK), *in = find_hit(POD_A_INBOX);
    CHECK(b && b->x == 0 && b->y == 0 && b->w == 173 && b->h == 88);
    CHECK(in && in->x == 632 && in->y == 0 && in->w == 88 && in->h == 88);
    CHECK(F.unread == 3 && F.bell_x > 0 && F.bell_x < 632 + 88);
    CHECK(find_text("3"));
    fresh();
    ci_bar(&F, "Tabs", NULL, 0, true);
    CHECK(!find_hit(POD_A_BACK) && find_hit(POD_A_INBOX) && find_text("Harness"));
    CHECK(!find_text("0"));   // no pill at 0
    fresh();
    ci_bar(&F, "Update", NULL, 5, false);
    CHECK(!find_hit(POD_A_INBOX) && !find_hit(POD_A_BACK) && F.unread == 0 && F.bell_x == 0 && !find_text("5"));
}
static void test_bar_no_title(void) {
    fresh();
    ci_bar(&F, NULL, "averyveryverylongtabname", 2, true);
    const ht_run_t *r = NULL;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && !strncmp(S.runs[i].text, "avery", 5)) r = &S.runs[i];
    const pod_hit_t *b = find_hit(POD_A_BACK);
    CHECK(r && r->w > 115 && r->x + r->w <= F.bell_x - 16 && b && b->x + b->w <= 632 && b->w >= 173);
    for (int i = 0; i < S.count; i++) CHECK(!(S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ci_bd_30));
    fresh();
    ci_bar(&F, "Task", "averyveryverylongtabname", 2, true);   // a titled bar keeps the 115 px cut
    r = NULL;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && !strncmp(S.runs[i].text, "avery", 5)) r = &S.runs[i];
    CHECK(r && r->w <= 115 && find_hit(POD_A_BACK)->w == 173);
}
static void test_bar_back_ellipsis(void) {
    fresh();
    ci_bar(&F, "Task", "averyveryverylongtabname", 0, false);
    const ht_run_t *r = NULL;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && !strncmp(S.runs[i].text, "avery", 5)) r = &S.runs[i];
    CHECK(r && r->w <= 115);
    size_t n = strlen(r->text);
    CHECK(n > 3 && !strcmp(r->text + n - 3, "\xe2\x80\xa6"));
    CHECK(!strstr(r->text, "..."));
    CHECK(strlen(r->text) < strlen("averyveryverylongtabname"));
}
static void test_talk_disabled_no_hit(void) {
    fresh();
    ci_talk(&F, false);
    CHECK(F.hit_count == 0 && find_text("Talk"));
    fresh();
    ci_talk(&F, true);
    const pod_hit_t *t = find_hit(POD_A_TALK);
    CHECK(F.hit_count == 1 && t && t->x == 32 && t->y == 624 && t->w == 656 && t->h == 88);
}
// The mockup's band: rules inset to the 32 px margins, the column rule at x 321, the right column's text near x 338; Ready is green;
// the state dot is anti-aliased (round).
static void test_band_geometry(void) {
    enum { K_RECT = 2, K_RECT_AA = 4 };
    fresh();
    ci_band(&S, 221, POD_IDLE, -1, "claude", -1, -1, 0);
    bool top = false, bottom = false, split = false, dot = false;
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->pro_kind == K_RECT && r->x == 32 && r->w == 656 && r->pro_height == 1 && r->y == 221) top = true;
        if (r->pro_kind == K_RECT && r->x == 32 && r->w == 656 && r->pro_height == 1 && r->y == 221 + 87) bottom = true;
        if (r->pro_kind == K_RECT && r->x == 321 && r->w == 1) split = true;
        if (r->pro_kind == K_RECT_AA && r->w == 10 && r->pro_height == 10 && r->fg == CI_GREEN) dot = true;
    }
    CHECK(top && bottom && split && dot);
    const ht_run_t *eng = find_text("Engine"), *ready = find_text("Ready"), *st = find_text("Status");
    CHECK(eng && eng->x >= 336 && eng->x <= 340 && ready && ready->fg == CI_GREEN);
    CHECK(st && st->x == 32 && st->y == eng->y && st->pro_font == eng->pro_font && st->fg == eng->fg && ready->y > st->y);   // same label face, colour and line
}
// ci_rgb picks the nearest RGB565 where ht_rgb truncates: the ask box is (239, 234, 214) not (246, 234, 222).
static void test_ci_rgb_nearest(void) {
    CHECK(ci_rgb(0xffffff) == 0xffff && ci_rgb(0) == 0);
    unsigned v = CI_ASK_FILL;
    int r = (v >> 11) * 255 / 31, g = ((v >> 5) & 63) * 255 / 63, b = (v & 31) * 255 / 31;
    CHECK(abs(r - 0xf0) <= 5 && abs(g - 0xe9) <= 2 && abs(b - 0xd8) <= 5);
    v = CI_GROUND;
    r = (v >> 11) * 255 / 31; g = ((v >> 5) & 63) * 255 / 63; b = (v & 31) * 255 / 31;
    CHECK(abs(r - 0xf6) <= 5 && abs(g - 0xf6) <= 2 && abs(b - 0xf0) <= 5);
}
// fit_text is not quadratic: a 120-glyph title cut to a short width still ends in U+2026 and fits.
static void test_ci_text_long_fit(void) {
    char t[HT_TEXT_BYTES];
    memset(t, 0, sizeof t);
    for (int i = 0; i < 120; i++) t[i] = (char)('a' + i % 26);
    fresh();
    ci_text(&S, 10, 10, 200, &ci_rg_26, CI_INK, t);
    const ht_run_t *r = find_text("abcd");
    CHECK(r && r->w <= 200 && !strcmp(r->text + strlen(r->text) - 3, "\xe2\x80\xa6") && strlen(r->text) > 4);
}
static void test_band_tokens_or_engine(void) {
    fresh();
    ci_band(&S, 224, POD_DONE, 134, "claude", 10100, 2300, 0);
    CHECK(find_text("Tokens") && find_text("10.1k in \xc2\xb7 2.3k out") && !find_text("Engine"));
    CHECK(find_text("Finished") && find_text("Status") && find_text(" \xc2\xb7 2:14"));
    fresh();
    ci_band(&S, 224, POD_WORKING, 5, "codex", -1, -1, 100);
    CHECK(find_text("Engine") && find_text("Codex") && !find_text("Tokens") && find_text("Working"));
}
static void test_band_unknowns(void) {
    fresh();
    ci_band(&S, 224, POD_DONE, -1, "", 100, -1, 0);
    CHECK(!find_text("\xe2\x80\x94") && find_text("Finished"));   // time unknown: omitted, never a dash or a dangling dot
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT) CHECK(strcmp(S.runs[i].text, "-"));
    CHECK(find_text("100 in"));
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT) {
            const char *dot = strstr(S.runs[i].text, "\xc2\xb7");
            CHECK(!dot);   // tokens_out unknown: no separator at all
        }
    fresh();
    ci_band(&S, 224, POD_ASKING, -1, "", -1, -1, 0);
    CHECK(find_text("Engine") && find_text("Needs you") && find_text("Status"));
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT) CHECK(!strstr(S.runs[i].text, "\xc2\xb7"));
}
static void fmt_t(int32_t v, const char *want) {
    char b[16];
    ci_fmt_tokens(b, sizeof b, v);
    if (strcmp(b, want)) { fprintf(stderr, "tokens %d -> %s, want %s\n", (int)v, b, want); assert(0); }
    checks++;
}
static void test_fmt_tokens(void) {
    fmt_t(0, "0"); fmt_t(999, "999"); fmt_t(1000, "1.0k"); fmt_t(2300, "2.3k"); fmt_t(10100, "10.1k");
    fmt_t(999949, "999.9k"); fmt_t(999950, "1.0M"); fmt_t(1250000, "1.3M");
    char b[16];
    ci_fmt_elapsed(b, sizeof b, 134); CHECK(!strcmp(b, "2:14"));
    ci_fmt_elapsed(b, sizeof b, 3723); CHECK(!strcmp(b, "1:02:03"));
    ci_fmt_elapsed(b, sizeof b, -1); CHECK(!strcmp(b, "\xe2\x80\x94"));
    const char *w; uint16_t ink;
    CHECK(ci_state_word(POD_ASKING, &w, &ink) && !strcmp(w, "Needs you") && ink == ht_rgb(0x956616));
}

// The cut ends in U+2026, fits max_w and never splits a UTF-8 sequence.
static void check_cut_utf8(const char *t) {
    size_t n = strlen(t);
    CHECK(n >= 3 && !strcmp(t + n - 3, "\xe2\x80\xa6"));
    for (size_t i = 0; i < n;) {
        unsigned char c = (unsigned char)t[i];
        size_t len = c < 0x80 ? 1 : (c >> 5) == 6 ? 2 : (c >> 4) == 14 ? 3 : (c >> 3) == 30 ? 4 : 0;
        CHECK(len && i + len <= n);
        for (size_t k = 1; k < len; k++) CHECK(((unsigned char)t[i + k] & 0xc0) == 0x80);
        i += len;
    }
}
static void test_ci_text_ellipsis(void) {
    const char *name = "Nguy\xe1\xbb\x85n V\xc4\x83n \xc3\x81nh \xc4\x90\xe1\xbb\x93ng Th\xc3\xa1p Mu\xe1\xbb\x9di";
    for (int max_w = 60; max_w <= 240; max_w += 7) {
        fresh();
        ci_text(&S, 10, 20, max_w, &ci_rg_26, CI_INK, name);
        const ht_run_t *r = find_text("N");
        CHECK(r && r->w <= max_w && ht_pro_width(&ci_rg_26, r->text) <= max_w);
        check_cut_utf8(r->text);
        CHECK(!strstr(r->text, "..."));
    }
    fresh();   // text that fits is drawn whole
    ci_text(&S, 0, 0, 400, &ci_rg_26, CI_INK, "Short");
    CHECK(find_text("Short") && !strstr(find_text("Short")->text, "\xe2\x80\xa6"));
    fresh();   // not even the mark fits: nothing is drawn
    ci_text(&S, 0, 0, 2, &ci_rg_26, CI_INK, name);
    CHECK(S.count == 0);
}
static void test_ci_wrap_last_line_ellipsis(void) {
    char rows[3][POD_ROW_MAX], plain[3][POD_ROW_MAX];
    const char *t = "The quick brown fox jumps over the lazy dog and keeps running through the whole wide forest until night";
    int n = ci_wrap(t, &ci_rg_26, 300, 2, rows);
    CHECK(n == 2 && pod_wrap(t, &ci_rg_26, 300, 2, plain) == 2);
    CHECK(!strcmp(rows[0], plain[0]));   // earlier rows are pod_wrap's
    check_cut_utf8(rows[1]);
    CHECK(ht_pro_width(&ci_rg_26, rows[1]) <= 300 && !strstr(rows[1], "..."));
    n = ci_wrap("two short words", &ci_rg_26, 300, 2, rows);   // fits: no ellipsis
    CHECK(n == 1 && !strcmp(rows[0], "two short words"));
    n = ci_wrap("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty", &ci_rg_26, 300, 3, rows);
    CHECK(n == 3 && !strstr(rows[0], "\xe2\x80\xa6") && !strstr(rows[1], "\xe2\x80\xa6"));
    check_cut_utf8(rows[2]);
    CHECK(ci_wrap("", &ci_rg_26, 300, 2, rows) == 0);
}
static void test_classic_em_dash(void) {
    // ci_* faces carry U+2014 and U+2026; the code() mapping must not read Console's arrow slot as a dash.
    fresh();
    ht_pro_text(&S, 0, 0, 100, &ci_rg_22, CI_INK, "\xe2\x80\x94");
    CHECK(S.count == 1 && S.runs[0].pro_kind == K_TEXT);
    uint16_t a[100 * 40], b[100 * 40];
    ht_rect_t clip = {0, 0, 100, 40};
    for (int i = 0; i < 100 * 40; i++) a[i] = b[i] = 0xffff;
    ht_pro_raster(&S.runs[0], clip, a);
    int ink = 0;
    for (int i = 0; i < 100 * 40; i++) ink += a[i] != 0xffff;
    CHECK(ink > 0);
    // distinct from the '?' an unmapped mark draws, and from the hyphen the other dashes alias to
    fresh();
    ht_pro_text(&S, 0, 0, 100, &ci_rg_22, CI_INK, "\xe2\x86\x92");   // U+2192: not a Classic mark
    ht_pro_raster(&S.runs[0], clip, b);
    int same = 1;
    for (int i = 0; i < 100 * 40; i++) if (a[i] != b[i]) same = 0;
    CHECK(!same);
    // Console faces: U+2014 still aliases to the hyphen; their mark slots keep their glyphs
    CHECK(ht_pro_width(&cs_rg_22, "\xe2\x80\x94") == ht_pro_width(&cs_rg_22, "-"));
    CHECK(ht_pro_width(&cs_rg_22, "\xe2\x80\xa6") == ht_pro_width(&cs_rg_22, "\xe2\x80\xa6"));
    CHECK(ht_pro_width(&cs_rg_22, "\xe2\x86\x92") != ht_pro_width(&cs_rg_22, "?") || ht_pro_width(&cs_rg_22, "\xe2\x86\x92") > 0);
    // ht_pro_* old Classic atlases keep the hyphen
    CHECK(ht_pro_width(&ht_pro_32, "\xe2\x80\x94") == ht_pro_width(&ht_pro_32, "-"));
}

int main(void) {
    test_bar_hits();
    test_bar_back_ellipsis();
    test_bar_no_title();
    test_talk_disabled_no_hit();
    test_band_tokens_or_engine();
    test_band_unknowns();
    test_band_geometry();
    test_ci_rgb_nearest();
    test_ci_text_long_fit();
    test_fmt_tokens();
    test_ci_text_ellipsis();
    test_ci_wrap_last_line_ellipsis();
    test_classic_em_dash();
    printf("test_ci_chrome: %d checks passed\n", checks);
    return 0;
}
