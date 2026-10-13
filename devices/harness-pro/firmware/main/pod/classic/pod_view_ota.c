// The Classic software-update screen (Index look, spec 2026-10-13), drawn by the glue instead of the stack while an update runs:
// the bar (brand, "Update", no bell), then centred with an equal 22 px gap between the CSS boxes of the five items: the download
// circle, "HARNESS PRO", "Updating to {to}" (or "Restarting…"), the progress bar and the two-line note; the footer says
// Downloading and the percent (or Restarting). No hits: nothing to tap while the image is written.
#include "pod/classic/ci.h"

#include <stdio.h>
#include <string.h>

enum { CIRCLE = 86, EYEBROW_H = 26, TITLE_H = 50, BAR_W = 446, BAR_H = 10, NOTE_LINE = 36, GAP = 22, NOTE_W = 583 };

// The y of a text cell whose CSS line box (`box_h` tall) starts at `top`: the baseline sits where a 1.117 em content area
// (ascent 0.905, descent 0.212) centred in the box puts it, and the cell starts `size` above it.
static int cell_y(int top, int box_h, int size) { return top + (box_h * 1000 - 1117 * size) / 2000 + (905 * size + 500) / 1000 - size; }

// The download arrow, ox the shaft's centre: a 3 px shaft, a head of 2-row steps and a base line; 29 px across, 32 tall.
static void download_arrow(ht_scene_t *s, int ox, int top, uint16_t ink)
{
    static const struct { int8_t dy, xl, w; } arm[3] = {{12, -10, 4}, {14, -9, 5}, {16, -7, 5}};   // left arm (the right mirrors it)
    ht_pro_rect(s, ox - 1, top, 3, 24, 0, ink);
    for (int k = 0; k < 3; k++) {
        ht_pro_rect(s, ox + arm[k].xl, top + arm[k].dy, arm[k].w, 2, 0, ink);
        ht_pro_rect(s, ox + 1 - arm[k].xl - arm[k].w + 1, top + arm[k].dy, arm[k].w, 2, 0, ink);
    }
    for (int r = 0; r < 6; r++) ht_pro_rect(s, ox - 6 + r, top + 18 + r, 13 - 2 * r, 1, 0, ink);   // the head's point
    ht_pro_rect(s, ox - 14, top + 28, 29, 3, 0, ink);
}

void pod_view_ota(pod_out_frame_t *f, const char *from, const char *to, int pct, bool restarting)
{
    (void)from;
    f->scene->background = CI_GROUND;
    ht_scene_t *s = f->scene;
    f->hit_count = 0;
    f->unread = 0;
    f->bell_x = 0;
    if (!to) to = "";
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    ci_bar(f, "Update", NULL, 0, false);
    char title[64], rows[2][POD_ROW_MAX], right[16];
    if (restarting) snprintf(title, sizeof title, "Restarting\xe2\x80\xa6");
    else snprintf(title, sizeof title, "Updating to %s", to);
    int n = ci_wrap("Keep the cable connected. The device restarts when it is done.", &ci_rg_26, NOTE_W, 2, rows);
    const int note_h = n * NOTE_LINE, total = CIRCLE + GAP + EYEBROW_H + GAP + TITLE_H + GAP + BAR_H + GAP + note_h;
    int y = CI_BAR_H + (CI_FOOT_Y - CI_BAR_H - total) / 2;
    // 1. the circle and its arrow
    ht_pro_rect_aa_stroke(s, (POD_W - CIRCLE) / 2, y, CIRCLE, CIRCLE, CIRCLE / 2, ht_rgb(0xa3b6a8), ht_rgb(0xe5efdf));
    download_arrow(s, POD_W / 2 - 1, y + 28, ht_rgb(0x386848));
    y += CIRCLE + GAP;
    // 2. the eyebrow
    const char *eyebrow = "HARNESS PRO";
    int ew = ht_pro_width(&ci_rg_20, eyebrow);
    ht_pro_text(s, (POD_W - ew) / 2, cell_y(y, EYEBROW_H, 20), ew, &ci_rg_20, ht_rgb(0x657a6c), eyebrow);
    y += EYEBROW_H + GAP;
    // 3. the title
    int tw = ht_pro_width(&ci_bd_45, title);
    if (tw > POD_W - 2 * CI_MARGIN) tw = POD_W - 2 * CI_MARGIN;
    ht_pro_text(s, (POD_W - tw) / 2, cell_y(y, TITLE_H, 45) - 1, tw, &ci_bd_45, CI_INK, title);
    y += TITLE_H + GAP;
    // 4. the bar: a 1 px edge, the track, and the blue fill to pct (a slot at 0 keeps the run count)
    const int x0 = (POD_W - BAR_W) / 2, fill = (BAR_W - 2) * (restarting ? 100 : pct) / 100;
    ht_pro_rect_aa_stroke(s, x0, y, BAR_W, BAR_H, 5, ht_rgb(0xc4cbc7), ht_rgb(0xdfe3dc));
    if (fill > 0) pod_grad_aa(s, x0 + 1, y + 1, fill, BAR_H - 2, 4, ht_rgb(0x286fda), ht_rgb(0x1759bd));
    else pod_arc(s, x0 * 16, y * 16, 0, 0, 0, 0, 0);   // the fill's slot
    y += BAR_H + GAP;
    // 5. the note
    for (int i = 0; i < n; i++) {
        int w = ht_pro_width(&ci_rg_26, rows[i]);
        ht_pro_text(s, (POD_W - w) / 2, cell_y(y + i * NOTE_LINE, NOTE_LINE, 26) - 1, w, &ci_rg_26, CI_MUTED, rows[i]);
    }
    if (restarting) snprintf(right, sizeof right, "RESTARTING");
    else snprintf(right, sizeof right, "%d%%", pct);
    ci_foot(s, "Downloading", true, right);
}
