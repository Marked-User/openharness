// Pets Update (mockup screen 11, .ota* .lg in style4.css), on the Pets dark tokens (ground, ink, muted ink, accent green: ph.h): "from -> to", a progress bar with the percent, and a log of the
// fw_update stages. The device is told the percent and whether it is restarting, nothing more (no sizes, hash or resend
// count), so the log reads the stage off those: offer and accepted are done; "written n %" runs below 100; "verify" runs at
// 100; "restart" runs once restarting. The glue calls this instead of the stack while an update runs; it draws no hits.
#include <stdio.h>
#include <string.h>

#include "pod/home/ph.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)

void ph_view_ota(pod_out_frame_t *f, const char *from, const char *to, int pct, bool restarting)
{
    ht_scene_t *s = f->scene;
    f->hit_count = 0;
    ht_pro_rect(s, 0, 0, POD_W, POD_W, 0, C(PH_GROUND));
    if (!from) from = "";
    if (!to) to = "";
    pct = pct < 0 ? 0 : pct > 100 ? 100 : pct;
    const char *const crumbs[] = {"System", "Update"};
    ph_bar(f, crumbs, 2);

    const int x = 32, w = POD_W - 64, vy = PH_BAR_H + 30 + 38;
    int fw = ht_pro_width(&ph_mono_26, from), x2 = x;
    ph_text(s, x2, vy, fw + 2, &ph_mono_26, PH_MUTED, from);
    x2 += fw + 18;
    ph_text(s, x2, vy, ht_pro_width(&ph_mono_26, "\xe2\x86\x92") + 2, &ph_mono_26, PH_FOCUS, "\xe2\x86\x92");
    x2 += ht_pro_width(&ph_mono_26, "\xe2\x86\x92") + 18;
    ph_text(s, x2, vy, POD_W - 32 - x2, &ph_sb_48, PH_INK, to);

    const int py = vy + 38 + 26;
    ht_pro_rect(s, x, py, w, 14, 7, C(PH_BORDER));
    if (pct > 0) ht_pro_rect(s, x, py, w * pct / 100 < 14 ? 14 : w * pct / 100, 14, 7, C(PH_FOCUS));
    char p[8];
    snprintf(p, sizeof p, "%d%%", pct);
    ph_text(s, x, py + 14 + 10 + 10, ht_pro_width(&ph_mono_18, p) + 2, &ph_mono_18, PH_INK, p);
    const char *keep = "keep the cable in";
    int kw = ht_pro_width(&ph_mono_18, keep);
    ph_text(s, x + w - kw, py + 14 + 10 + 10, kw + 2, &ph_mono_18, PH_MUTED, keep);

    char log[6][64];
    snprintf(log[0], sizeof log[0], "offer %.20s", to);
    snprintf(log[1], sizeof log[1], "accepted \xc2\xb7 writing the new slot");
    snprintf(log[2], sizeof log[2], "written %d %%", pct);
    snprintf(log[3], sizeof log[3], "verify sha256 from flash");
    snprintf(log[4], sizeof log[4], "check version \xc2\xb7 project \xc2\xb7 chip rev");
    snprintf(log[5], sizeof log[5], "restart into %.20s", to);
    const int cur = restarting ? 5 : pct >= 100 ? 3 : 2, top = py + 14 + 10 + 20 + 30, h = 6 * 46 + 28;
    ht_pro_rect_aa_stroke(s, x, top, w, h, 16, C(PH_BORDER), C(PH_RAISED));
    for (int i = 0; i < 6; i++) {
        const int cy = top + 14 + i * 46 + 23, dx = x + 18 + 7;
        if (i < cur) ht_pro_rect_aa(s, dx - 7, cy - 7, 14, 14, 7, C(PH_RUN));
        else if (i == cur) {
            pod_arc(s, dx * 16, cy * 16, 6 * 16, 2 * 16, 0, 180, C(PH_EDGE));
            pod_arc(s, dx * 16, cy * 16, 6 * 16, 2 * 16, 60, 120, C(PH_FOCUS));
        } else {
            pod_arc(s, dx * 16, cy * 16, 6 * 16, 2 * 16, 0, 180, C(PH_TRACK));
        }
        ph_text(s, x + 18 + 14 + 14, cy, w - 18 - 14 - 14 - 18, &ph_mono_18, i < cur ? PH_MUTED : i == cur ? PH_INK : PH_DIM, log[i]);
    }
}
