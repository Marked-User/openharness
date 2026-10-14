// Console chrome: the command bar, hint strip, dots, badges, logos and the working mark. Sizes and colours are the mockup's
// (.cb .hn .dt .eg .tl in mockup/pro-wow/style4.css).
#include <ctype.h>
#include <stdio.h>
#include <string.h>

#include "pod/console/cs.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)
// The y that centres a face's lowercase band on cy (the cell's baseline sits at 1/1.375 of its height).
static int ty(const ht_pro_font_t *f, int cy) { return cy - f->height * 15 / 32; }
static void text(ht_scene_t *s, int x, int cy, int w, const ht_pro_font_t *f, unsigned rgb, const char *t)
{
    ht_pro_text(s, x, ty(f, cy), w, f, C(rgb), t);
}

void cs_text(ht_scene_t *s, int x, int cy, int w, const ht_pro_font_t *f, unsigned rgb, const char *t) { text(s, x, cy, w, f, rgb, t); }

void cs_dot(ht_scene_t *s, int cx, int cy, char state, uint32_t now_ms)
{
    (void)now_ms;
    unsigned rgb = state == 'g' ? CS_RUN : state == 'q' ? CS_ASK : state == 'd' ? CS_MUTED : state == 'r' ? CS_FAIL : CS_TRACK;
    ht_pro_rect_aa(s, cx - 6, cy - 6, 12, 12, 6, C(rgb));
}

static void badge(ht_scene_t *s, int x, int y, int size, const char *engine)
{
    char code[3] = "--";
    unsigned rgb = 0x8A8F98;
    if (engine && *engine) {
        static const struct { const char *id, *code; unsigned rgb; } known[] = {
            {"claude", "CL", 0xD97757}, {"codex", "CO", 0x5b8cff}, {"muse", "MU", 0xc8b28c}, {"cursor", "CU", 0xe5e7eb}};
        for (unsigned i = 0; i < sizeof known / sizeof known[0]; i++)
            if (!strcmp(engine, known[i].id)) { memcpy(code, known[i].code, 3); rgb = known[i].rgb; break; }
        if (rgb == 0x8A8F98) {
            code[0] = (char)toupper((unsigned char)engine[0]);
            code[1] = engine[1] ? (char)toupper((unsigned char)engine[1]) : ' ';
        }
    }
    const ht_pro_font_t *f = size >= 36 ? &cs_mono_18 : &cs_mono_15;
    ht_pro_rect_aa(s, x, y, size, size, size / 4, C(rgb));
    int w = ht_pro_width(f, code);
    text(s, x + (size - w) / 2, y + size / 2, w + 2, f, CS_GROUND, code);
}

void cs_badge(ht_scene_t *s, int x, int y, const char *engine) { badge(s, x, y, 28, engine); }

bool cs_logo(ht_scene_t *s, int x, int y, int size, const char *engine)
{
    if (pod_logo_draw(s, x, y, size, engine)) return true;
    badge(s, x, y, size, engine);
    return false;
}

int cs_unread(const pod_model_t *m) { return !m->linked ? 0 : m->unread_count > 99 ? 99 : m->unread_count; }

// The bell chip: a dark 30 px pill, an 18 x 18 bell in CS_INK from rects (the fonts have no bell) and the count. Returns its width;
// *out_x is its left edge. cs_bar adds its hit (after the crumbs', so a chip always wins over a crumb).
static int bell_chip(ht_scene_t *s, int right, int cy, int unread, int *out_x)
{
    char t[8];
    snprintf(t, sizeof t, "%d", unread);
    int tw = ht_pro_width(&cs_mono_18, t), cw = 10 + 18 + 7 + tw + 10, x = right - cw, y = cy - 15;
    ht_pro_rect_aa_stroke(s, x, y, cw, 30, 8, C(CS_EDGE), C(CS_RAISED));
    const int gx = x + 10, gy = cy - 9;
    ht_pro_rect(s, gx + 7, gy, 4, 3, 1, C(CS_INK));         // the knob
    ht_pro_rect(s, gx + 3, gy + 2, 12, 11, 5, C(CS_INK));   // the dome
    ht_pro_rect(s, gx, gy + 11, 18, 4, 2, C(CS_INK));       // the flared rim
    ht_pro_rect(s, gx + 6, gy + 15, 6, 3, 1, C(CS_INK));    // the clapper
    text(s, gx + 18 + 7, cy, tw + 2, &cs_mono_18, CS_INK, t);
    *out_x = x;
    return cw;
}

enum { CHIP_REACH = 12, CHIP_GAP = 16 };   // a chip's hit reaches 12 px past it; two chips share their 16 px gap

void cs_bar(pod_out_frame_t *f, const char *const crumbs[], int n, int running, int asking, int unread, const char *input, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    bool talk = input != NULL;
    ht_pro_rect(s, 0, 0, POD_W, CS_BAR_H, 0, C(talk ? CS_VOICE_BAR : CS_GROUND));
    ht_pro_rect(s, 0, talk ? CS_BAR_H - 2 : CS_BAR_H - 1, POD_W, talk ? 2 : 1, 0, C(talk ? CS_FOCUS : CS_BORDER));
    const int cy = 36;
    int lw = ht_pro_width(&cs_sb_22, "\xe2\x97\x86");   // ◆
    text(s, 24, cy, lw + 2, &cs_sb_22, CS_FOCUS, "\xe2\x97\x86");

    // right side, laid out from the edge: ▲ chip, the bell chip, then the working mark and the running count (only while someone runs)
    int right = POD_W - 24, ask_x = 0, ask_w = 0, bell_x = 0, bell_w = 0;
    if (asking > 0) {
        char t[16];
        snprintf(t, sizeof t, "\xe2\x96\xb2 %d", asking);       // ▲ N
        int w = ht_pro_width(&cs_mono_18, t), cw = w + 20;
        right -= cw;
        ht_pro_rect_aa(s, right, cy - 15, cw, 30, 8, C(CS_ASK));
        text(s, right + 10, cy, w + 2, &cs_mono_18, 0x1a1200, t);
        ask_x = right;
        ask_w = cw;
        right -= CHIP_GAP;
    }
    if (unread > 0 && !talk) {
        bell_w = bell_chip(s, right, cy, unread, &bell_x);
        right -= bell_w + CHIP_GAP;
    }
    int limit = right;   // the middle may reach here (the gap to the chip is already in `right`)
    if (running > 0) {
        char rn[12];
        snprintf(rn, sizeof rn, "%d", running);
        int rw = ht_pro_width(&cs_mono_18, rn);
        right -= rw;
        text(s, right, cy, rw + 2, &cs_mono_18, CS_MUTED, rn);
        right -= 8 + CS_MARK_SMALL_W;
        cs_working_mark_small(s, right, cy - 9, now_ms);
        limit = right - 16;
    }

    int x = 24 + lw + 16;
    if (talk) {
        const char *to = n > 0 ? crumbs[n - 1] : "";
        int w = ht_pro_width(&cs_sb_26, to), room = limit - x - 20 - 12 - 12;   // the chip may reach the caret; no fixed cap
        if (w > room) w = room > 0 ? room : 0;
        ht_pro_rect_aa(s, x, cy - 17, w + 20, 34, 8, C(0x2a2550));
        if (w > 0) text(s, x + 10, cy, w, &cs_sb_26, 0xb9b2ff, to);
        x += w + 20 + 12;
        int tw = ht_pro_width(&cs_rg_24, input);
        if (tw > limit - x - 6) tw = limit - x - 6;
        text(s, x, cy, tw, &cs_rg_24, CS_INK, input);
        ht_pro_rect(s, x + tw + 4, cy - 14, 2, 28, 0, C(CS_FOCUS));   // the caret
    }
    for (int i = 0; !talk && i < n; i++) {
        bool cur = i == n - 1;
        const ht_pro_font_t *font = cur ? &cs_sb_26 : &cs_rg_24;
        int w = ht_pro_width(font, crumbs[i]);
        if (x + w > limit) w = limit - x;
        if (w <= 0) break;
        if (!cur) {
            ht_pro_rect_aa(s, x - 10, cy - 18, w + 20, 36, 8, C(CS_RAISED));
            pod_hit_add(f, x - 10, 0, w + 20, CS_BAR_H, POD_A_BACK, n - 1 - i);
        }
        text(s, x, cy, w, font, cur ? CS_INK : CS_MUTED, crumbs[i]);
        x += w;
        if (!cur) {
            x += 14;
            int sw = ht_pro_width(&cs_rg_24, "/");
            text(s, x, cy, sw + 2, &cs_rg_24, CS_TRACK, "/");
            x += sw + 14;
        }
    }
    // The chips' hits last, so they win over a crumb's: the full bar height, 12 px past the chip (the 16 px between two chips is split).
    if (bell_w) {
        int x1 = bell_x + bell_w + (ask_w ? CHIP_GAP / 2 : CHIP_REACH);
        pod_hit_add(f, bell_x - CHIP_REACH, 0, x1 - (bell_x - CHIP_REACH), CS_BAR_H, POD_A_INBOX, 0);
    }
    if (ask_w) {
        int x0 = ask_x - (bell_w ? CHIP_GAP / 2 : CHIP_REACH), x1 = ask_x + ask_w + 2 * CHIP_REACH;   // to the screen edge: nothing is right of it
        pod_hit_add(f, x0, 0, (x1 > POD_W ? POD_W : x1) - x0, CS_BAR_H, POD_A_ATTENTION, 0);
    }
}

// Four bars `bw` px wide, `gap` apart, anchored at the bottom of an `hh` px box: each a triangle wave between 40 % and 100 % of hh, 900 ms.
static void mark(ht_scene_t *s, int x, int y, uint32_t now_ms, int bw, int gap, int hh)
{
    static const int phase[4] = {-200, -500, -100, -700};
    for (int i = 0; i < 4; i++) {
        int t = ((int)(now_ms % 900u) + phase[i] + 900) % 900, tri = t < 450 ? t : 900 - t;   // 0..450 and back
        int h = hh * (400 + 600 * tri / 450) / 1000;
        ht_pro_rect(s, x + i * (bw + gap), y + hh - h, bw, h, 2, C(CS_RUN));
    }
}

void cs_working_mark(ht_scene_t *s, int x, int y, uint32_t now_ms) { mark(s, x, y, now_ms, 5, 2, 22); }
void cs_working_mark_small(ht_scene_t *s, int x, int y, uint32_t now_ms) { mark(s, x, y, now_ms, 4, 2, 18); }

int cs_runs(const pod_out_frame_t *f) { return f->scene->count; }

unsigned cs_mix(unsigned a, unsigned b, unsigned pct)
{
    unsigned r = 0;
    for (int sh = 0; sh <= 16; sh += 8) r |= ((((a >> sh) & 0xff) * pct + ((b >> sh) & 0xff) * (100 - pct)) / 100) << sh;
    return r;
}
