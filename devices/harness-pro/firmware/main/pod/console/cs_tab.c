// Console Tab (pro-console-tab-cards.html, B): the selected tab's agents as cards, four a page (the Overview grid), in the window's
// own pane order. Each card takes its agent's state: green while it works, amber when it asks, a red edge when it failed. Head line:
// the agent's name left, its time right ("ask" while it asks); then its pet, logo or ">_"; at the foot the state in a word (the
// working bars before "Working"). Tap opens the agent. The TAB frame's scroll is the page; the glue pages on a vertical swipe and
// steps tabs on a sideways one. More than one page: dots down the right edge.
#include <stdio.h>
#include <string.h>

#include "pod/console/cs.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)
enum { PAD = 19, NAME_Y = 40, FOOT_Y = CS_CARD_H - 30, MARK_W = 26, DOT = 8, DOT_PITCH = 16, DOT_X = POD_W - 8, DOTS_MAX = 8 };

int cs_tab_pages(const pod_nav_t *nav, const pod_model_t *m)
{
    const pod_agent_t *list[POD_AGENTS_MAX];
    int n = pod_nav_list(nav, m, list, POD_AGENTS_MAX);
    return n > 0 ? (n + CS_PER_PAGE - 1) / CS_PER_PAGE : 1;
}

int cs_tab_page(const pod_nav_t *nav, const pod_model_t *m, const pod_agent_t *out[CS_PER_PAGE])
{
    const pod_agent_t *list[POD_AGENTS_MAX];
    int n = pod_nav_list(nav, m, list, POD_AGENTS_MAX), last = cs_tab_pages(nav, m) - 1;
    int page = nav->depth ? nav->stack[nav->depth - 1].scroll : 0;
    page = page < 0 ? 0 : page > last ? last : page;
    int k = 0;
    for (int i = page * CS_PER_PAGE; i < n && k < CS_PER_PAGE; i++) out[k++] = list[i];
    return k;
}

static void card(pod_out_frame_t *f, const pod_model_t *m, const pod_agent_t *a, int idx, int x, int y, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    char st = cs_state_dot(m, a);
    unsigned fill = st == 'g' ? cs_mix(CS_RUN, CS_GROUND, 12) : st == 'q' ? cs_mix(CS_ASK, CS_GROUND, 12) : CS_SURFACE;
    unsigned border = st == 'g' ? cs_mix(CS_RUN, CS_GROUND, 45) : st == 'q' ? CS_ASK : st == 'r' ? cs_mix(CS_FAIL, CS_GROUND, 55) : CS_BORDER;
    ht_pro_rect_aa_stroke(s, x, y, CS_CARD_W, CS_CARD_H, 18, C(border), C(fill));

    // head line: the name left, the time right
    const int left = x + PAD, right = x + CS_CARD_W - PAD, hy = y + NAME_Y;
    char t[12];
    unsigned tc = cs_time_col(t, sizeof t, m, a, now_ms);
    int tw = t[0] ? ht_pro_width(&cs_mono_24, t) : 0;
    if (tw) cs_text(s, right - tw, hy, tw + 2, &cs_mono_24, tc, t);
    char name[sizeof a->name];
    snprintf(name, sizeof name, "%s", a->name);
    for (char *p = name; *p; p++) if (*p == '\n' || *p == '\r' || *p == '\t') *p = ' ';
    cs_text(s, left, hy, right - (tw ? tw + 12 : 0) - left, &cs_md_28, CS_INK, name);

    cs_card_art(s, x + CS_CARD_W / 2, y + CS_CARD_ART_Y + CS_CARD_ART_H / 2, m, a, fill, now_ms);

    // the foot: the state in a word, centred (the working bars first)
    const char *word = st == 'g' ? "Working" : st == 'q' ? "Needs you" : st == 'd' ? "Done" : st == 'r' ? "Failed" :
                       pod_model_eff(m, a) == POD_OFFLINE ? "Offline" : "Idle";
    unsigned wc = st == 'g' ? CS_RUN : st == 'q' ? CS_ASK : st == 'd' ? CS_INK2 : st == 'r' ? CS_FAIL : CS_MUTED;
    int ww = ht_pro_width(&cs_sb_26, word), lead = st == 'g' ? MARK_W + 10 : 0, wx = x + (CS_CARD_W - ww - lead) / 2 + lead;
    if (lead) cs_working_mark(s, wx - lead, y + FOOT_Y - 12, now_ms);
    cs_text(s, wx, y + FOOT_Y, ww + 2, &cs_sb_26, wc, word);
    pod_hit_add_id(f, x, y, CS_CARD_W, CS_CARD_H, POD_A_OPEN_AGENT, idx, a->id);
}

void cs_view_tab(pod_out_frame_t *f, const pod_nav_t *nav, pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    const pod_frame_t *top = &nav->stack[nav->depth - 1];
    const pod_tab_t *t = &m->tabs[top->tab];

    int running, asking;
    cs_counts(m, &running, &asking);
    const char *const crumbs[] = {"Overview", t->name};
    cs_bar(f, crumbs, 2, running, asking, cs_unread(m), NULL, now_ms);

    const pod_agent_t *page[CS_PER_PAGE];
    int k = cs_tab_page(nav, m, page), pages = cs_tab_pages(nav, m);
    if (k <= 0) {
        const char *msg = "No panes in this tab";
        int w = ht_pro_width(&cs_rg_24, msg);
        cs_text(s, (POD_W - w) / 2, POD_W / 2, w + 2, &cs_rg_24, CS_MUTED, msg);
        return;
    }
    int at = top->scroll < 0 ? 0 : top->scroll > pages - 1 ? pages - 1 : top->scroll;
    for (int i = 0; i < k; i++)
        card(f, m, page[i], at * CS_PER_PAGE + i, CS_CARD_MARGIN + (i % 2) * (CS_CARD_W + CS_CARD_GAP),
             CS_CARD_TOP + (i / 2) * (CS_CARD_H + CS_CARD_GAP), now_ms);
    if (pages > 1) {   // the page dots, down the right edge
        int dots = pages < DOTS_MAX ? pages : DOTS_MAX, y0 = CS_CARD_TOP + (2 * CS_CARD_H + CS_CARD_GAP - (dots * DOT_PITCH - (DOT_PITCH - DOT))) / 2;
        for (int i = 0; i < dots; i++)
            ht_pro_rect(s, DOT_X - DOT / 2, y0 + i * DOT_PITCH, DOT, DOT, DOT / 2, C(i == (at < dots ? at : dots - 1) ? CS_INK : CS_TRACK));
    }
}
