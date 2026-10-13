// The Tab screen (Classic Index): the tab's agents in pane order, 112 px a row, right under the bar (whose title names the
// tab). Recent is the same list over the agents with the most recent tasks. Four rows show whole and a fifth peeks above the
// footer; a drag scrolls by rows.
#include "pod/classic/ci.h"

#include <stdio.h>
#include <string.h>

enum { ROWS_Y = CI_BAR_H, ROWS_MAX = (CI_FOOT_Y - CI_BAR_H) / CI_ROW_H, ROWS_DRAWN = ROWS_MAX + 1, NAME_X = 106, META_GAP = 16 };   // 4 whole + 1 peeking

static int imin(int a, int b) { return a < b ? a : b; }
static int imax(int a, int b) { return a > b ? a : b; }

// One row at y0: the mark box, the name over "Engine · Machine", the time over the state word on the right.
static void row(pod_out_frame_t *f, const pod_model_t *m, const pod_agent_t *a, int index, int y0, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    pod_state_t st = pod_model_eff(m, a);
    const char *word;
    uint16_t wink;
    ci_state_word(st, &word, &wink);
    char t[16];
    ci_fmt_elapsed(t, sizeof t, st == POD_WORKING || st == POD_DONE ? (int32_t)pod_agent_secs(a, now_ms) : -1);
    int tw = ht_pro_width(&ci_rg_22, t), ww = ht_pro_width(&ci_bd_20, word), mw = imax(tw, ww), right = POD_W - CI_MARGIN;
    const int cy = y0 + CI_ROW_H / 2;
    ci_mark(s, CI_MARGIN, y0 + (CI_ROW_H - CI_MARK) / 2, a->engine);
    ci_text(s, right - tw, cy - 15 - ci_rg_22.height / 2, tw, &ci_rg_22, CI_MUTED, t);
    ci_text(s, right - ww, cy + 16 - ci_bd_20.height / 2, ww, &ci_bd_20, wink, word);
    int room = right - mw - META_GAP - NAME_X;
    ci_text(s, NAME_X, cy - 18 - ci_rg_33.height / 2, room, &ci_rg_33, CI_INK, a->name);
    char eng[16], sub[HT_TEXT_BYTES];
    pod_engine_name(eng, sizeof eng, a->engine);
    snprintf(sub, sizeof sub, "%s%s%s", eng, eng[0] && a->machine[0] ? " \xc2\xb7 " : "", a->machine);
    ci_text(s, NAME_X, cy + 21 - ci_rg_23.height / 2, room, &ci_rg_23, CI_MUTED, sub);
    ht_pro_rect(s, 0, y0 + CI_ROW_H - 1, POD_W, 1, 0, CI_RULE);
    pod_hit_add_id(f, 0, y0, POD_W, imin(CI_ROW_H, CI_FOOT_Y - y0), POD_A_OPEN_AGENT, index, a->id);
}

void pod_view_tab(pod_out_frame_t *f, const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    s->background = CI_GROUND;
    const pod_frame_t *fr = &nav->stack[nav->depth - 1];
    bool is_recent = fr->tab == POD_TAB_RECENT;
    const pod_agent_t *list[POD_AGENTS_MAX];
    int n = pod_nav_list(nav, m, list, POD_AGENTS_MAX);

    const char *back = is_recent ? "Back" : pod_nav_origin(nav, m);   // Recent: "Back"; a tab list: "Tabs"
    char foot[24];
    if (n == 0) {
        if (is_recent) {   // the spec fixes the copy of an empty tab only
            const char *l1 = "No recent agents.", *l2 = "Agents with a task show up here.";
            int w1 = ht_pro_width(&ci_rg_33, l1), w2 = ht_pro_width(&ci_rg_25, l2);
            ht_pro_text(s, (POD_W - w1) / 2, 159 - ci_rg_33.height / 2, w1, &ci_rg_33, CI_INK, l1);
            ht_pro_text(s, (POD_W - w2) / 2, 242 - ci_rg_25.height / 2, w2, &ci_rg_25, CI_MUTED, l2);
            snprintf(foot, sizeof foot, "No agents");
        } else {
            const char *l1 = "No panes yet.", *l2 = "This tab is managed in Harness.";
            int w1 = ht_pro_width(&ci_rg_43, l1), w2 = ht_pro_width(&ci_rg_25, l2);
            ht_pro_text(s, (POD_W - w1) / 2, 159 - ci_rg_43.height / 2, w1, &ci_rg_43, CI_INK, l1);
            ht_pro_text(s, (POD_W - w2) / 2, 242 - ci_rg_25.height / 2, w2, &ci_rg_25, CI_MUTED, l2);
            snprintf(foot, sizeof foot, "No panes");
        }
        ci_foot(s, foot, true, NULL);
        ci_bar(f, pod_view_title(nav, m), back, f->unread, true);
        return;
    }

    int first = imax(0, imin(fr->scroll, n - ROWS_MAX));
    int shown = imin(ROWS_DRAWN, n - first);
    for (int i = 0; i < shown; i++) row(f, m, list[first + i], first + i, ROWS_Y + i * CI_ROW_H, now_ms);

    char right[24];
    snprintf(right, sizeof right, "%d %s%s", n, is_recent ? "AGENT" : "PANE", n == 1 ? "" : "S");
    ci_foot(s, "Scroll to browse", true, right);
    ci_bar(f, pod_view_title(nav, m), back, f->unread, true);
}

// Scrolling (see pod_scroll_pitch): a row is CI_ROW_H px and the last offset shows the last ROWS_MAX agents whole.
int pod_tab_pitch(void) { return CI_ROW_H; }
int pod_tab_max_row(const pod_nav_t *nav, const pod_model_t *m)
{
    const pod_agent_t *list[POD_AGENTS_MAX];
    return imax(0, pod_nav_list(nav, m, list, POD_AGENTS_MAX) - ROWS_MAX);
}
