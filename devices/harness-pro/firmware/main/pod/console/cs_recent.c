// Console Recent (mockup screen 03, .r2* in style5.css) and the row list it shares with Tab: the agents with the most recent
// tasks, newest first, five rows of 108 px at a time (a drag scrolls the rest). A row: the 44 px logo, the working bars (WORKING)
// or a dot, the name in 32 px, the tab's name, the time (or "ask") at the right, and the agent's line in 27 px.
#include <stdio.h>
#include <string.h>

#include "pod/console/cs.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)
enum { PADX = 24, LOGO = 44, TEXT_X = PADX + LOGO + 16 };

// The one line under the name: the question while asking, the activity while working, else what the agent last did
// (its recap's first line, or the activity). Colours follow the state.
static const char *line_of(const pod_agent_t *a, pod_state_t st, unsigned *rgb)
{
    *rgb = CS_MUTED;
    if (st == POD_ASKING && a->question[0]) { *rgb = CS_ASK; return a->question; }
    if (st == POD_WORKING && a->activity[0]) return a->activity;
    if (a->failed) *rgb = CS_FAIL;
    if (st != POD_WORKING && a->recap_lines > 0) return a->recap + a->line_at[0];
    return a->activity;
}

// A line's newlines read as spaces: the row is one line.
static void one_line(char *out, size_t cap, const char *t)
{
    snprintf(out, cap, "%s", t);
    for (char *c = out; *c; c++) if (*c == '\n' || *c == '\r' || *c == '\t') *c = ' ';
}

int cs_rows(pod_out_frame_t *f, const pod_model_t *m, const pod_agent_t *const list[], int n, int first, bool tab_col, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    int drawn = 0;
    for (int i = 0; i < CS_ROWS_MAX && first + i < n; i++, drawn++) {
        const pod_agent_t *a = list[first + i];
        pod_state_t st = pod_model_eff(m, a);
        const int y = CS_ROWS_TOP + i * CS_ROW_H, cy = y + 34, right = POD_W - PADX;
        cs_logo(s, PADX, y + 18, LOGO, a->engine);

        char t[12] = "";   // an unknown time draws nothing
        unsigned tc = CS_DIM;
        if (st == POD_ASKING) { snprintf(t, sizeof t, "ask"); tc = CS_ASK; }
        else if (st == POD_WORKING) { pod_fmt_time(t, sizeof t, pod_agent_secs(a, now_ms)); tc = CS_RUN; }
        else if (a->elapsed_s) pod_fmt_time(t, sizeof t, pod_agent_secs(a, now_ms));
        int tw = t[0] ? ht_pro_width(&cs_mono_24, t) : 0;
        if (tw) cs_text(s, right - tw, cy, tw + 2, &cs_mono_24, tc, t);

        int x = TEXT_X;
        if (st == POD_WORKING) { cs_working_mark(s, x, cy - 11, now_ms); x += 26 + 10; }
        else { cs_dot(s, x + 6, cy, cs_state_dot(m, a), now_ms); x += 12 + 10; }
        char name[sizeof a->name];
        one_line(name, sizeof name, a->name);
        int avail = right - (tw ? tw + 16 : 0) - x, nw = ht_pro_width(&cs_sb_32, name);
        if (nw > (tab_col ? avail * 3 / 5 : avail)) nw = tab_col ? avail * 3 / 5 : avail;
        cs_text(s, x, cy, nw, &cs_sb_32, CS_INK, name);
        if (tab_col) {
            const pod_tab_t *tab = pod_tab_of(m, a);
            const char *where = tab ? tab->name : a->machine;
            if (avail - nw - 10 > 20) cs_text(s, x + nw + 10, cy, avail - nw - 10, &cs_rg_22, CS_DIM, where);
        }

        unsigned lc;
        char line[POD_ACTIVITY_BYTES];
        one_line(line, sizeof line, line_of(a, st, &lc));
        cs_text(s, TEXT_X, y + 72, right - TEXT_X, &cs_rg_27, lc, line);
        ht_pro_rect(s, 0, y + CS_ROW_H - 1, POD_W, 1, 0, C(CS_RAISED));
        pod_hit_add_id(f, 0, y, POD_W, CS_ROW_H, POD_A_OPEN_AGENT, first + i, a->id);
    }
    return drawn;
}

int cs_rows_max(const pod_nav_t *nav, const pod_model_t *m)
{
    const pod_frame_t *f = nav->depth ? &nav->stack[nav->depth - 1] : NULL;
    if (f && f->tab != POD_TAB_RECENT) return cs_tab_pages(nav, m) - 1;   // a tab's cards: the frame's scroll is the page
    const pod_agent_t *list[POD_AGENTS_MAX];
    int n = pod_nav_list(nav, m, list, POD_AGENTS_MAX);
    return n > CS_ROWS_MAX ? n - CS_ROWS_MAX : 0;
}

void cs_view_recent(pod_out_frame_t *f, const pod_nav_t *nav, pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    int running, asking;
    cs_counts(m, &running, &asking);
    const char *const crumbs[] = {"Overview", "Recent"};
    cs_bar(f, crumbs, 2, running, asking, cs_unread(m), NULL, now_ms);

    const pod_agent_t *list[POD_AGENTS_MAX];
    int n = pod_nav_list(nav, m, list, POD_AGENTS_MAX);
    if (n == 0) {
        const char *msg = "No recent agents";
        int w = ht_pro_width(&cs_rg_24, msg);
        cs_text(s, (POD_W - w) / 2, POD_W / 2, w + 2, &cs_rg_24, CS_MUTED, msg);
        return;
    }
    int max = n > CS_ROWS_MAX ? n - CS_ROWS_MAX : 0, first = nav->stack[nav->depth - 1].scroll;
    cs_rows(f, m, list, n, first < 0 ? 0 : first > max ? max : first, true, now_ms);
}
