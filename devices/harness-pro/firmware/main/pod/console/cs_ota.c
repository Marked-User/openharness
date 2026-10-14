// Console Update (mockup screen 11, .ota* .lg in style4.css): "from -> to", a progress bar with the percent, and a log of the
// fw_update stages. The device is told the percent and whether it is restarting, nothing more (no sizes, hash or resend
// count), so the log reads the stage off those: offer and accepted are done; "written n %" runs below 100; "verify" runs at
// 100; "restart" runs once restarting. The glue calls this instead of the stack while an update runs; it draws no hits.
#include <stdio.h>
#include <string.h>

#include "pod/console/cs.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)

void cs_view_ota(pod_out_frame_t *f, const char *from, const char *to, int pct, bool restarting)
{
    ht_scene_t *s = f->scene;
    f->hit_count = 0;
    f->unread = 0;
    f->bell_x = 0;
    ht_pro_rect(s, 0, 0, POD_W, POD_W, 0, C(CS_GROUND));
    if (!from) from = "";
    if (!to) to = "";
    pct = pct < 0 ? 0 : pct > 100 ? 100 : pct;
    const char *const crumbs[] = {"System", "Update"};
    cs_bar(f, crumbs, 2, 0, 0, 0, NULL, 0);

    const int x = 32, w = POD_W - 64, vy = CS_BAR_H + 30 + 38;
    int fw = ht_pro_width(&cs_mono_26, from), x2 = x;
    cs_text(s, x2, vy, fw + 2, &cs_mono_26, CS_MUTED, from);
    x2 += fw + 18;
    cs_text(s, x2, vy, ht_pro_width(&cs_mono_26, "\xe2\x86\x92") + 2, &cs_mono_26, CS_FOCUS, "\xe2\x86\x92");
    x2 += ht_pro_width(&cs_mono_26, "\xe2\x86\x92") + 18;
    cs_text(s, x2, vy, POD_W - 32 - x2, &cs_sb_48, CS_INK, to);

    const int py = vy + 38 + 26;
    ht_pro_rect(s, x, py, w, 14, 7, C(CS_BORDER));
    if (pct > 0) ht_pro_rect(s, x, py, w * pct / 100 < 14 ? 14 : w * pct / 100, 14, 7, C(CS_FOCUS));
    char p[8];
    snprintf(p, sizeof p, "%d%%", pct);
    cs_text(s, x, py + 14 + 10 + 10, ht_pro_width(&cs_mono_18, p) + 2, &cs_mono_18, CS_INK, p);
    const char *keep = "keep the cable in";
    int kw = ht_pro_width(&cs_mono_18, keep);
    cs_text(s, x + w - kw, py + 14 + 10 + 10, kw + 2, &cs_mono_18, CS_MUTED, keep);

    char log[6][64];
    snprintf(log[0], sizeof log[0], "offer %.20s", to);
    snprintf(log[1], sizeof log[1], "accepted \xc2\xb7 writing the new slot");
    snprintf(log[2], sizeof log[2], "written %d %%", pct);
    snprintf(log[3], sizeof log[3], "verify sha256 from flash");
    snprintf(log[4], sizeof log[4], "check version \xc2\xb7 project \xc2\xb7 chip rev");
    snprintf(log[5], sizeof log[5], "restart into %.20s", to);
    const int cur = restarting ? 5 : pct >= 100 ? 3 : 2, top = py + 14 + 10 + 20 + 30, h = 6 * 46 + 28;
    ht_pro_rect_aa_stroke(s, x, top, w, h, 16, C(CS_BORDER), C(CS_RAISED));
    for (int i = 0; i < 6; i++) {
        const int cy = top + 14 + i * 46 + 23, dx = x + 18 + 7;
        if (i < cur) ht_pro_rect_aa(s, dx - 7, cy - 7, 14, 14, 7, C(CS_RUN));
        else if (i == cur) {
            pod_arc(s, dx * 16, cy * 16, 6 * 16, 2 * 16, 0, 180, C(CS_EDGE));
            pod_arc(s, dx * 16, cy * 16, 6 * 16, 2 * 16, 60, 120, C(CS_FOCUS));
        } else {
            pod_arc(s, dx * 16, cy * 16, 6 * 16, 2 * 16, 0, 180, C(CS_TRACK));
        }
        cs_text(s, x + 18 + 14 + 14, cy, w - 18 - 14 - 14 - 18, &cs_mono_18, i < cur ? CS_MUTED : i == cur ? CS_INK : CS_DIM, log[i]);
    }
}
