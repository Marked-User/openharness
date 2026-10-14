// Classic Index chrome: the bar, footer, Talk transport, mark box and metadata band (ci.h). Text goes through
// ht_pro_text with the Liberation Sans ci_* faces; the icons come from rects, pod_chevron, pod_tick, pod_eq and pod_arc.
#include "pod/classic/ci.h"

#include <stdio.h>
#include <string.h>

static uint16_t C(unsigned rgb) { return ht_rgb(rgb); }
static int imin(int a, int b) { return a < b ? a : b; }
static int imax(int a, int b) { return a > b ? a : b; }
#define EM_DASH "\xe2\x80\x94"
#define MIDDOT "\xc2\xb7"
#define ELLIPSIS "\xe2\x80\xa6"

// `t` in out (cap bytes) cut at a character boundary and ended with U+2026 when it is wider than max_w; returns the width.
static int fit_text(char *out, size_t cap, const ht_pro_font_t *font, int max_w, const char *t)
{
    t = t ? t : "";
    if (strlen(t) < cap && ht_pro_width(font, t) <= max_w) { strcpy(out, t); return ht_pro_width(font, out); }
    // Binary search on the cut (the width only grows with it): the longest boundary whose text + U+2026 fits.
    size_t best = 0, len = strlen(t), lo = 1, hi = len < cap - sizeof ELLIPSIS - 1 ? len : cap - sizeof ELLIPSIS - 1;
    while (lo <= hi) {
        size_t i = lo + (hi - lo) / 2;
        while (i > lo && t[i] && ((unsigned char)t[i] & 0xc0) == 0x80) i--;   // inside a sequence: step back to a boundary
        if (t[i] && ((unsigned char)t[i] & 0xc0) == 0x80) { lo = i + 1; continue; }
        size_t n = i;
        while (n && t[n - 1] == ' ') n--;
        memcpy(out, t, n);
        memcpy(out + n, ELLIPSIS, sizeof ELLIPSIS);
        if (ht_pro_width(font, out) > max_w) hi = i - 1;
        else { best = n; lo = i + 1; }
    }
    memcpy(out, t, best);
    memcpy(out + best, ELLIPSIS, sizeof ELLIPSIS);
    int w = ht_pro_width(font, out);
    if (w > max_w) { out[0] = 0; w = 0; }   // not even the mark fits
    return w;
}
void ci_text(ht_scene_t *s, int x, int y, int max_w, const ht_pro_font_t *f, uint16_t ink, const char *utf8)
{
    char buf[HT_TEXT_BYTES];
    int w = fit_text(buf, sizeof buf, f, max_w, utf8);
    if (w > 0) ht_pro_text(s, x, y, w, f, ink, buf);
}
int ci_wrap(const char *utf8, const ht_pro_font_t *f, int max_w, int max_lines, char rows[][POD_ROW_MAX])
{
    int n = pod_wrap_hard(utf8, f, max_w, max_lines, rows);
    if (n > 0) {   // pod_wrap's last row takes the rest of the text: cut it to fit
        char cut[POD_ROW_MAX];
        fit_text(cut, sizeof cut, f, max_w, rows[n - 1]);
        strcpy(rows[n - 1], cut);
    }
    return n;
}
// Each channel of `c` moved toward `g` by (100 - keep)%: the disabled Talk button's 45%.
static uint16_t fade(unsigned rgb, unsigned ground, int keep)
{
    unsigned out = 0;
    for (int sh = 16; sh >= 0; sh -= 8) {
        int a = (int)((rgb >> sh) & 255), b = (int)((ground >> sh) & 255);
        out |= (unsigned)((a * keep + b * (100 - keep)) / 100) << sh;
    }
    return ht_rgb(out);
}

// ---- icons ----------------------------------------------------------------------------------------------

static void ci_bell_glyph(ht_scene_t *s, int x, int y, int h, uint16_t ink)
{
    // The design's outline bell (24 box, stroke 1.75): dome arc, two sides, base and clapper bars. 5 runs.
#define K(v) ((v) * h / 24)
    const int sw = imax(2, (7 * h + 48) / 96), sw16 = 7 * h / 6;
    pod_arc(s, x * 16 + h * 8, y * 16 + h * 6, h * 10 / 3, sw16, 90, 90, ink);                    // the dome: centre (12, 9), r 5
    ht_pro_rect(s, x + K(7) - sw / 2, y + K(9), sw, K(16) - K(9) + sw / 2, 0, ink);      // left side, down to the base
    ht_pro_rect(s, x + K(17) - sw / 2, y + K(9), sw, K(16) - K(9) + sw / 2, 0, ink);     // right side
    ht_pro_rect(s, x + K(5) - sw / 2, y + K(16) - sw / 2, K(14) + sw, sw, sw / 2, ink);            // the base, y 16
    ht_pro_rect(s, x + K(10), y + K(20) - sw / 2, K(4), sw, sw / 2, ink);                          // the clapper, y 20
#undef K
}
static void pod_mic_draw(ht_scene_t *s, int cx, int mid, int pct, uint16_t ink)
{
#define K(v) ((v) * pct / 100)
    ht_pro_rect(s, cx - K(11), mid - K(26), K(22), K(34), K(22) / 2, ink);            // the capsule
    pod_arc(s, cx * 16, mid * 16 - K(58), K(281), K(72), 270, 90, ink);              // the cradle
    ht_pro_rect(s, cx - K(2), mid + K(15), K(4) > 0 ? K(4) : 1, K(12), 0, ink);       // a pixel into the cradle: no seam
#undef K
}

// ---- bar and footer -------------------------------------------------------------------------------------

void ci_bar(pod_out_frame_t *f, const char *title, const char *back, uint8_t unread, bool bell)
{
    ht_scene_t *s = f->scene;
    pod_grad_gray(s, 0, 0, POD_W, CI_BAR_H, C(0xf8f9f7), C(0xe9eae5));
    ht_pro_rect(s, 0, 0, POD_W, 1, 0, C(0xffffff));
    ht_pro_rect(s, 0, CI_BAR_H, POD_W, 1, 0, C(0xbcc4c1));
    // The bell's geometry first: a bar without a title lets the back label run up to it.
    const int right = POD_W - 24;
    int bx = right, px = 0, pw = 0;
    char cnt[8] = "";
    if (bell) {
        if (unread) {
            snprintf(cnt, sizeof cnt, "%d", unread);
            int tw = ht_pro_width(&ci_bd_24, cnt);
            pw = tw + 10 > 34 ? tw + 10 : 34;
            px = right - pw;
            bx = px - 8;
        }
        bx -= 28;
    }
    const bool titled = title && *title;
    if (back) {
        pod_chevron(s, 32, 44, 9, CI_BLUE);
        int room = titled ? 115 : (bell ? bx : POD_W - CI_MARGIN) - 16 - 62, lw;
        char cut[HT_TEXT_BYTES];
        lw = fit_text(cut, sizeof cut, &ci_rg_26, room, back);
        if (lw > 0) ht_pro_text(s, 62, (CI_BAR_H - ci_rg_26.height) / 2, lw, &ci_rg_26, C(0x314449), cut);
        int hw = titled ? CI_BACK_W : imax(CI_BACK_W, 62 + lw + 16);
        pod_hit_add(f, 0, 0, imin(hw, POD_W - CI_BELL_W), CI_BAR_H, POD_A_BACK, 0);
    } else {
        ci_text(s, 29, (CI_BAR_H - ci_bd_26.height) / 2, CI_BACK_W - 29, &ci_bd_26, CI_INK, "Harness");
    }
    if (titled) {
        char cut[HT_TEXT_BYTES];
        int w = fit_text(cut, sizeof cut, &ci_bd_30, 2 * (POD_W / 2 - CI_BACK_W), title);
        if (w > 0) ht_pro_text(s, (POD_W - w) / 2, (CI_BAR_H - ci_bd_30.height) / 2, w, &ci_bd_30, CI_INK, cut);
    }
    f->bell_x = 0;
    f->unread = bell ? unread : 0;
    if (!bell) return;
    if (unread) {
        const int py = (CI_BAR_H - 31) / 2, tw = ht_pro_width(&ci_bd_24, cnt);
        ht_pro_rect_aa(s, px, py, pw, 31, 15, CI_BLUE);
        ht_pro_text(s, px + (pw - tw) / 2, py + (31 - ci_bd_24.height) / 2, tw, &ci_bd_24, C(0xffffff), cnt);
    }
    ci_bell_glyph(s, bx, (CI_BAR_H - 30) / 2, 30, C(0x314449));
    f->bell_x = (int16_t)bx;
    pod_hit_add(f, POD_W - CI_BELL_W, 0, CI_BELL_W, CI_BAR_H, POD_A_INBOX, 0);
}

void ci_foot(ht_scene_t *s, const char *left, bool led, const char *right_caps)
{
    const int y = CI_FOOT_Y, h = POD_W - y, cy = y + h / 2;
    pod_grad_gray(s, 0, y, POD_W, h, C(0xf8f9f7), C(0xe9eae5));
    ht_pro_rect(s, 0, y, POD_W, 1, 0, C(0xc4cbc7));
    int rw = right_caps && *right_caps ? imin(ht_pro_width(&ci_rg_20, right_caps), 300) : 0;
    int x = CI_MARGIN;
    if (led) { ht_pro_rect_aa(s, x, cy - 4, 8, 8, 4, CI_GREEN); x += 8 + 10; }
    if (left && *left) ci_text(s, x, cy - ci_rg_23.height / 2, POD_W - CI_MARGIN - x - (rw ? rw + 16 : 0), &ci_rg_23, CI_MUTED, left);
    if (rw) ci_text(s, POD_W - CI_MARGIN - rw, cy - ci_rg_20.height / 2, rw, &ci_rg_20, CI_MUTED, right_caps);
}

// ---- transport ------------------------------------------------------------------------------------------

void ci_talk(pod_out_frame_t *f, bool enabled)
{
    ht_scene_t *s = f->scene;
    const int keep = enabled ? 100 : 45, x = CI_TALK_X, y = CI_TALK_Y, w = CI_TALK_W, h = CI_TALK_H;
    pod_grad_gray(s, 0, CI_TRANS_Y, POD_W, POD_W - CI_TRANS_Y, C(0xf8f9f7), C(0xe9eae5));
    ht_pro_rect(s, 0, CI_TRANS_Y, POD_W, 1, 0, C(0xc4cbc7));
    const unsigned ground = 0xe9eae5;
    ht_pro_rect_aa(s, x, y, w, h, 7, fade(0x1145a0, ground, keep));
    pod_grad_aa(s, x + 1, y + 1, w - 2, h - 2, 6, fade(0x286fda, ground, keep), fade(0x1759bd, ground, keep));
    ht_pro_rect(s, x + 7, y + 1, w - 14, 1, 0, fade(0x6aa2ee, ground, keep));   // the top highlight
    const uint16_t white = fade(0xffffff, ground, keep);
    const int tw = ht_pro_width(&ci_rg_28, "Talk"), micw = 24, gap = 12, x0 = POD_W / 2 - (micw + gap + tw) / 2, cy = y + h / 2;
    pod_mic_draw(s, x0 + micw / 2, cy - 1, 60, white);
    ht_pro_text(s, x0 + micw + gap, cy - ci_rg_28.height / 2, tw, &ci_rg_28, white, "Talk");
    if (enabled) pod_hit_add(f, x, y, w, h, POD_A_TALK, 0);
}

// ---- mark and band --------------------------------------------------------------------------------------

void ci_mark(ht_scene_t *s, int x, int y, const char *engine)
{
    const unsigned fill = 0xe6e9df;
    ht_pro_rect_aa_stroke(s, x, y, CI_MARK, CI_MARK, 8, C(0xc8cec7), C(fill));
    const pod_mark_t *m = pod_mark(engine);
    if (!m) { pod_mark_default(s, x + (CI_MARK - POD_DEFAULT_MARK_SIDE) / 2, y + (CI_MARK - POD_DEFAULT_MARK_SIDE) / 2, C(fill)); return; }
    if (m->light) ht_pro_rect(s, x + 10, y + 10, 36, 36, 8, C(0x1d1e23));   // pale art sits on a dark chip
    pod_logo_draw(s, x + 10, y + 10, 36, engine);
}

int ci_state_word(pod_state_t st, const char **word, uint16_t *ink)
{
    const char *w = ""; uint16_t c = CI_MUTED; int ok = 1;
    switch (st) {
    case POD_WORKING: w = "Working"; c = C(0x377052); break;
    case POD_DONE: w = "Finished"; break;
    case POD_ASKING: w = "Needs you"; c = C(0x956616); break;
    case POD_IDLE: w = "Ready"; break;
    case POD_OFFLINE: w = "Offline"; break;
    default: ok = 0;
    }
    if (word) *word = w;
    if (ink) *ink = c;
    return ok;
}

void ci_fmt_tokens(char *out, size_t n, int32_t v)
{
    if (!n) return;
    if (v < 0) snprintf(out, n, EM_DASH);
    else if (v < 1000) snprintf(out, n, "%d", (int)v);
    else if (v < 999950) snprintf(out, n, "%d.%dk", (int)((v + 50) / 1000), (int)((v + 50) % 1000 / 100));
    else snprintf(out, n, "%d.%dM", (int)(((int64_t)v + 50000) / 1000000), (int)(((int64_t)v + 50000) % 1000000 / 100000));
}
void ci_fmt_elapsed(char *out, size_t n, int32_t sec)
{
    if (!n) return;
    if (sec < 0) snprintf(out, n, EM_DASH);
    else if (sec < 3600) snprintf(out, n, "%d:%02d", (int)(sec / 60), (int)(sec % 60));
    else snprintf(out, n, "%d:%02d:%02d", (int)(sec / 3600), (int)(sec / 60 % 60), (int)(sec % 60));
}

void ci_band(ht_scene_t *s, int y, pod_state_t st, int32_t elapsed_s, const char *engine, int32_t tokens_in, int32_t tokens_out,
             uint32_t now_ms)
{
    const int h = 88, split = 321, rx = 336, x0 = CI_MARGIN, x1 = POD_W - CI_MARGIN;   // the mockup's columns; rules inset to the margins
    ht_pro_rect(s, x0, y, x1 - x0, 1, 0, CI_RULE);
    ht_pro_rect(s, x0, y + h - 1, x1 - x0, 1, 0, CI_RULE);
    ht_pro_rect(s, split, y + 1, 1, h - 2, 0, C(0xd7ddd3));
    // left: the "Status" label over the state icon and word, then " · time" in the muted time colour when known
    const char *word; uint16_t listc;
    ci_state_word(st, &word, &listc);
    uint16_t ink = st == POD_WORKING || st == POD_DONE || st == POD_IDLE ? CI_GREEN : st == POD_ASKING ? CI_AMBER : CI_MUTED;
    const int ly = y + 13, vy = y + 40, lmax = split - CI_MARGIN - 8, cy = vy + ci_rg_26.height / 2;
    ci_text(s, CI_MARGIN, ly, lmax, &ci_rg_20, CI_MUTED, "Status");
    int wx = CI_MARGIN + 26;
    if (st == POD_WORKING) { pod_eq(s, CI_MARGIN, cy - 10, CI_EQ, now_ms); wx = CI_MARGIN + 35; }
    else if (st == POD_DONE) { pod_tick(s, CI_MARGIN, cy - 8, CI_GREEN); wx = CI_MARGIN + 34; }
    else ht_pro_rect_aa(s, CI_MARGIN + 2, cy - 5, 10, 10, 5, ink);
    const int ww = imin(ht_pro_width(&ci_rg_26, word), split - 8 - wx);
    ci_text(s, wx, vy, ww, &ci_rg_26, ink, word);
    if (elapsed_s >= 0) {
        char el[24];
        el[0] = ' ';
        snprintf(el + 1, sizeof el - 1, MIDDOT " ");
        ci_fmt_elapsed(el + strlen(el), sizeof el - strlen(el), elapsed_s);
        ci_text(s, wx + ww, vy, split - 8 - wx - ww, &ci_rg_26, C(0x6b746c), el);
    }
    // right: Tokens, or Engine with its logo
    const int vmax = POD_W - CI_MARGIN - rx;
    if (tokens_in >= 0) {
        char a[16], b[16], line[48];
        ci_fmt_tokens(a, sizeof a, tokens_in);
        if (tokens_out >= 0) {
            ci_fmt_tokens(b, sizeof b, tokens_out);
            snprintf(line, sizeof line, "%s in " MIDDOT " %s out", a, b);
        } else snprintf(line, sizeof line, "%s in", a);
        ci_text(s, rx, ly, vmax, &ci_rg_20, CI_MUTED, "Tokens");
        ci_text(s, rx, vy, vmax, &ci_rg_26, CI_INK, line);
    } else {
        char name[24];
        pod_engine_name(name, sizeof name, engine);
        ci_text(s, rx, ly, vmax, &ci_rg_20, CI_MUTED, "Engine");
        int x = rx;
        if (pod_logo_draw(s, x, vy + 4, 28, engine)) x += 28 + 10;
        ci_text(s, x, vy, POD_W - CI_MARGIN - x, &ci_rg_26, CI_INK, name[0] ? name : EM_DASH);
    }
}
