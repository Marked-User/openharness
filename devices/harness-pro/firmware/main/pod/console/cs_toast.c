// Console toast (mockup screen 10, .toast* in style4.css): a card that drops under the bar when another agent finishes or
// fails: engine badge, "<name> finished", the time and tab, the first two lines of the text, "tap to open" and "swipe up to
// dismiss", and a 3 px timer line that shrinks along the bottom over CS_TOAST_MS (counted from the entry's at_ms, which the
// glue stamps when it starts the banner). 11 runs at most, so it fits the 16 the glue keeps spare (POD_BANNER_RUNS).
#include <stdio.h>
#include <string.h>

#include "pod/console/cs.h"
#include "pod/pod_view_shared.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)

void cs_toast(pod_out_frame_t *f, const pod_model_t *m, const pod_unread_t *u, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    const int x = 18, y = CS_BAR_H + 12, w = POD_W - 36;
    const pod_agent_t *a = pod_model_find(m, u->agent);
    char line[POD_UNREAD_TEXT], rows[2][POD_ROW_MAX];
    snprintf(line, sizeof line, "%s", u->text);
    pod_utf8_trim(line);
    for (char *c = line; *c; c++) if (*c == '\n' || *c == '\r' || *c == '\t') *c = ' ';
    int n = pod_wrap(line, &cs_rg_20, w - 40, 2, rows);
    const int h = 16 + 30 + 10 + n * 27 + 10 + 18 + 14;
    ht_pro_rect_aa_stroke(s, x, y, w, h, 18, C(CS_EDGE), C(CS_RAISED));

    const char *name = a && a->name[0] ? a->name : u->name[0] ? u->name : "Agent";
    cs_logo(s, x + 20, y + 16, 28, a ? a->engine : NULL);
    char title[CABLE_NAME_MAX + 12], when[2 * CABLE_NAME_MAX + 16];
    snprintf(title, sizeof title, "%s %s", name, u->kind == POD_UNREAD_FAILED ? "failed" : "finished");
    const pod_tab_t *tab = a ? pod_tab_of(m, a) : NULL;
    int k = 0;
    if (u->elapsed_s >= 0) k = snprintf(when, sizeof when, "%d:%02d", (int)(u->elapsed_s / 60), (int)(u->elapsed_s % 60));
    else when[0] = 0;
    if (tab && tab->name[0]) snprintf(when + k, sizeof when - (size_t)k, "%s%s", k ? " \xc2\xb7 " : "", tab->name);
    const int cy = y + 16 + 14;
    int ww = ht_pro_width(&cs_mono_15, when);
    if (ww > 200) ww = 200;
    int tx = x + 20 + 28 + 12, tw = ht_pro_width(&cs_sb_22, title), room = x + w - 20 - ww - 12 - tx;
    if (tw > room) tw = room;
    cs_text(s, tx, cy, tw, &cs_sb_22, u->kind == POD_UNREAD_FAILED ? CS_FAIL : CS_INK, title);
    cs_text(s, x + w - 20 - ww, cy, ww, &cs_mono_15, CS_DIM, when);
    for (int i = 0; i < n; i++) cs_text(s, x + 20, y + 16 + 30 + 10 + i * 27 + 13, w - 40, &cs_rg_20, CS_INK2, rows[i]);
    const int fy = y + h - 14 - 9;
    const char *dismiss = "swipe \xe2\x86\x91 to dismiss";
    cs_text(s, x + 20, fy, ht_pro_width(&cs_mono_15, "tap to open") + 2, &cs_mono_15, CS_DIM, "tap to open");
    int dw = ht_pro_width(&cs_mono_15, dismiss);
    cs_text(s, x + w - 20 - dw, fy, dw + 2, &cs_mono_15, CS_DIM, dismiss);

    int32_t left = CS_TOAST_MS - (int32_t)(now_ms - u->at_ms);
    left = left < 0 ? 0 : left > CS_TOAST_MS ? CS_TOAST_MS : left;
    ht_pro_rect(s, x + 1, y + h - 4, (w - 2) * left / CS_TOAST_MS, 3, 0, C(CS_FOCUS));
    pod_hit_add_id(f, x, y, w, h, POD_A_BANNER, 0, u->agent);
}
