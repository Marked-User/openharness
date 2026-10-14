// Console Recap (mockup screen 06, .rp2 and .st2 in style5.css): the header, the summary (the recap at Classic's length, 36 px, no
// scrolling) and a slim row of one-line tiles along the bottom: TOKENS (with in and out), DURATION, TESTS, COMMITS. A tile is drawn only with data (-1 is
// unknown); with none the whole row is gone and the summary takes the room.
#include <stdio.h>
#include <string.h>

#include "pod/console/cs.h"
#include "pod/pod_mem.h"
#include "pod/pod_view_shared.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)
enum { PADX = 28, TEXT_W = POD_W - 2 * PADX, SUM_Y = 261, SUM_PITCH = 47, TILE_H = 54, TILE_Y = POD_W - CS_FOOT_H - 6 - TILE_H, ROWS_ALL = 8, GAP = 6, TILES_MAX = 4 };

static EXT_RAM_BSS_ATTR char rows_buf[ROWS_ALL][POD_ROW_MAX];

// The summary as wrapped rows: Classic's cut of the recap, wrapped in 36 px, at most `rows` of them (the last holds the rest and
// ends with an ellipsis when the text is longer). Returns the row count.
static int layout(const pod_agent_t *a, int rows)
{
    static EXT_RAM_BSS_ATTR char text[POD_RECAP_BYTES + POD_RECAP_LINES + 4];
    int n = pod_recap_join(a, text, sizeof text);
    n = pod_recap_cut(text, text, sizeof text);
    if (a->recap_cut && n >= 3 && strcmp(text + n - 3, "...") && n + 4 <= (int)sizeof text) memcpy(text + n, "...", 4);   // the source was cut
    return pod_wrap(text, &cs_rg_36, TEXT_W, rows < ROWS_ALL ? rows : ROWS_ALL, rows_buf);
}

int cs_recap_max_row(const pod_nav_t *nav, const pod_model_t *m) { (void)nav; (void)m; return 0; }

// Tokens as the mockup writes them: plain digits under 1000, "61.4k", then "1.2M".
static void fmt_tokens(char *out, size_t n, int32_t v)
{
    if (v < 1000) snprintf(out, n, "%d", (int)v);
    else if (v < 999950) snprintf(out, n, "%d.%dk", (int)((v + 50) / 1000), (int)((v + 50) % 1000 / 100));
    else snprintf(out, n, "%d.%dM", (int)((v + 50000) / 1000000), (int)((v + 50000) % 1000000 / 100000));
}

typedef struct { const char *label; char value[24], sub[40]; unsigned col; int w; } tile_t;   // w: the tile's width, set when the row is laid out

enum { TPAD = 12, TGAP = 6, SUBGAP = 10 };

// The tile's natural width: pad, label, gap, value and (TOKENS) in/out.
static int natural(const tile_t *t)
{
    int w = 2 * TPAD + ht_pro_width(&cs_mono_15, t->label) + TGAP + ht_pro_width(&cs_mono_22, t->value);
    if (t->sub[0]) w += SUBGAP + ht_pro_width(&cs_mono_15, t->sub);
    return w;
}

// One line: the label small and muted, the value after it on the same baseline; TOKENS ends with in/out. When the whole "in x · out y" does not fit, "in x" alone is shown; when even that does not
// fit, the sub-line is left out. It is never cut inside a number.
static void tile(ht_scene_t *s, int x, const tile_t *t)
{
    const int cy = TILE_Y + TILE_H / 2, w = t->w;
    ht_pro_rect_aa_stroke(s, x, TILE_Y, w, TILE_H, 14, C(CS_BORDER), C(CS_SURFACE));
    int lw = ht_pro_width(&cs_mono_15, t->label), vw = ht_pro_width(&cs_mono_22, t->value), cx = x + TPAD;
    cs_text(s, cx, cy, lw + 2, &cs_mono_15, CS_MUTED, t->label);
    cx += lw + TGAP;
    cs_text(s, cx, cy, vw + 2, &cs_mono_22, t->col, t->value);
    cx += vw + SUBGAP;
    const int room = x + w - TPAD - cx;
    if (t->sub[0] && room > 0) {
        char sub[sizeof t->sub];
        snprintf(sub, sizeof sub, "%s", t->sub);
        if (ht_pro_width(&cs_mono_15, sub) > room) {   // drop the "· out y" part
            char *dot = strstr(sub, " \xc2\xb7 ");
            if (dot) *dot = 0;
        }
        if (ht_pro_width(&cs_mono_15, sub) <= room) cs_text(s, cx, cy, room, &cs_mono_15, CS_MUTED, sub);
    }
}

void cs_view_recap(pod_out_frame_t *f, const pod_nav_t *nav, pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    const pod_agent_t *a = pod_view_agent_of(nav, m);
    int running, asking;
    cs_counts(m, &running, &asking);
    const char *crumbs[1] = {cs_parent_name(nav, m)};
    cs_bar(f, crumbs, 1, running, asking, cs_unread(m), NULL, now_ms);
    if (!a) return;
    cs_back_hit(f, crumbs[0]);
    cs_hero(f, nav, m, a, now_ms);

    // the tiles that have data
    tile_t tiles[TILES_MAX];
    int n = 0;
    if (a->tokens_in >= 0) {
        char in[12], out[12], total[12];
        fmt_tokens(total, sizeof total, a->tokens_in + (a->tokens_out > 0 ? a->tokens_out : 0));
        fmt_tokens(in, sizeof in, a->tokens_in);
        tile_t *t = &tiles[n++];
        t->label = "TOKENS"; t->col = CS_INK;
        snprintf(t->value, sizeof t->value, "%s", total);
        if (a->tokens_out >= 0) { fmt_tokens(out, sizeof out, a->tokens_out); snprintf(t->sub, sizeof t->sub, "in %s \xc2\xb7 out %s", in, out); }
        else snprintf(t->sub, sizeof t->sub, "in %s", in);
    }
    if (a->elapsed_s) { tile_t *t = &tiles[n++]; t->label = "DURATION"; t->col = CS_INK; t->sub[0] = 0; pod_fmt_time(t->value, sizeof t->value, pod_agent_secs(a, now_ms)); }
    if (a->tests_passed >= 0) {
        tile_t *t = &tiles[n++];
        t->label = "TESTS"; t->sub[0] = 0;
        if (a->tests_failed > 0) { snprintf(t->value, sizeof t->value, "%d \xe2\x9c\x93 %d \xc3\x97", (int)a->tests_passed, (int)a->tests_failed); t->col = CS_FAIL; }
        else { snprintf(t->value, sizeof t->value, "%d \xe2\x9c\x93", (int)a->tests_passed); t->col = CS_RUN; }
    }
    if (a->commits >= 0) { tile_t *t = &tiles[n++]; t->label = "COMMITS"; t->col = CS_INK; t->sub[0] = 0; snprintf(t->value, sizeof t->value, "%d", (int)a->commits); }

    if (!a->recap_lines) {
        cs_text(s, PADX, SUM_Y + 17, TEXT_W, &cs_rg_24, CS_MUTED, "No recap yet.");
    } else {
        const int floor_y = n ? TILE_Y - 8 : POD_W - CS_FOOT_H - 12, rows = layout(a, (floor_y - SUM_Y) / SUM_PITCH);
        for (int r = 0; r < rows; r++) cs_text(s, PADX, SUM_Y + SUM_PITCH / 2 + r * SUM_PITCH, TEXT_W, &cs_rg_36, CS_INK2, rows_buf[r]);
    }

    // widths: every tile its natural width; spare room spread evenly, a shortfall taken from TOKENS (its in/out is cut). When even
    // that cannot make them fit (extreme values), the last tile is dropped and the row laid out again.
    int span = 0, total = 0;
    for (;;) {
        span = POD_W - 36 - GAP * (n - 1);
        total = 0;
        for (int i = 0; i < n; i++) { tiles[i].w = natural(&tiles[i]); total += tiles[i].w; }
        if (n == 0 || total <= span) break;
        int cut = total - span;
        for (int i = 0; i < n && cut > 0; i++) {   // TOKENS is first: down to the label and value
            int min = 2 * TPAD + ht_pro_width(&cs_mono_15, tiles[i].label) + TGAP + ht_pro_width(&cs_mono_22, tiles[i].value) + (tiles[i].sub[0] ? SUBGAP + 20 : 0);
            int give = tiles[i].w - min;
            if (give > cut) give = cut;
            if (give > 0) { tiles[i].w -= give; cut -= give; }
        }
        if (cut <= 0) { total = span; break; }
        n--;
    }
    if (n && total < span) {
        int extra = span - total, left = extra;
        for (int i = 0; i < n; i++) { int d = i == n - 1 ? left : extra / n; tiles[i].w += d; left -= d; }
    }
    for (int i = 0, x = 18; i < n; i++) {
        tile(s, x, &tiles[i]);
        x += tiles[i].w + GAP;
    }
}
