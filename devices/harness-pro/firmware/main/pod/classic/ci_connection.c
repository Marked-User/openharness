// Classic "Connection lost" (spec 2026-10-13): drawn in place of the stack while the cable is down. The bar (brand,
// "Connection", the bell with its count, no hit), the grid icon, the heading and two lines, the footer "Disconnected".
#include "pod/classic/ci.h"

static void centered(ht_scene_t *s, int y, const ht_pro_font_t *f, uint16_t ink, const char *t)
{
    int w = ht_pro_width(f, t);
    ht_pro_text(s, (POD_W - w) / 2, y, w, f, ink, t);
}

void ci_connection_lost(pod_out_frame_t *f, uint8_t unread)
{
    ht_scene_t *s = f->scene;
    ci_bar(f, "Connection", NULL, unread, true);
    f->hit_count = 0;   // nothing to open without a cable; the stack returns with the link
    for (int i = 0; i < 4; i++) {   // four 19 px squares, 3 px stroke
        int x = 339 + (i & 1) * 23, y = 235 + (i >> 1) * 23;
        ht_pro_rect_aa(s, x, y, 19, 19, 3, CI_INK);
        ht_pro_rect_aa(s, x + 3, y + 3, 13, 13, 1, CI_GROUND);
    }
    centered(s, 292, &ci_rg_43, CI_INK, "Connection lost.");
    centered(s, 385, &ci_rg_25, CI_MUTED, "Live status is unavailable.");
    centered(s, 423, &ci_rg_25, CI_MUTED, "Your saved results and unread marks remain.");
    ci_foot(s, "Disconnected", true, NULL);
}
