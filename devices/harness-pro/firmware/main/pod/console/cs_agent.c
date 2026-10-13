// Console Agent (mockup screens 04 and 05, header C of pro-console-agent.html): the header (pet, name, state and time, logo and
// where), then by state NOW (spinner, verb, argument, equaliser) or the QUESTION card. No steps and no tokens.
// The spinner and the equaliser move with now_ms: pod_view_agent_next_ms wakes the glue every POD_CS_ANIM_MS (66 ms)
// while an agent works; the animated region is the NOW block (330 x 40 px at most).
#include <stdio.h>
#include <string.h>

#include "pod/console/cs.h"
#include "pod/pod_view_shared.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)
enum { HERO_BOTTOM = 240, PADX = 28, BOX_W = 170, BOX_H = 130, MUTED_LBL = CS_DIM, EQ_N = 30, EQ_H = 30, LOGO = 28 };

const char *cs_parent_name(const pod_nav_t *nav, const pod_model_t *m)
{
    if (nav->depth < 2) return "Overview";
    const pod_frame_t *p = &nav->stack[nav->depth - 2];
    if (p->view == POD_V_INBOX) return "Inbox";
    if (p->view == POD_V_TAB) {
        if (p->tab == POD_TAB_RECENT) return "Recent";
        if (p->tab >= 0 && p->tab < m->tab_count && m->tabs[p->tab].name[0]) return m->tabs[p->tab].name;
    }
    return "Overview";
}

void cs_label(ht_scene_t *s, int x, int cy, unsigned rgb, const char *t)
{
    cs_text(s, x, cy, ht_pro_width(&cs_mono_15, t) + 2, &cs_mono_15, rgb, t);
}

void cs_spin(ht_scene_t *s, int cx, int cy, unsigned rgb, uint32_t now_ms)
{
    pod_arc(s, cx * 16, cy * 16, 10 * 16, 3 * 16, 0, 180, C(CS_EDGE));
    pod_arc(s, cx * 16, cy * 16, 10 * 16, 3 * 16, (int)((360 - now_ms % 900 * 360 / 900) % 360), 50, C(rgb));
}

static pod_scene_t scene_for(pod_state_t st)
{
    return st == POD_WORKING ? POD_SCENE_WORK : st == POD_ASKING ? POD_SCENE_ASK : POD_SCENE_REST;
}

int cs_hero(pod_out_frame_t *f, const pod_nav_t *nav, const pod_model_t *m, const pod_agent_t *a, uint32_t now_ms)
{
    (void)nav;
    ht_scene_t *s = f->scene;
    pod_state_t st = pod_model_eff(m, a);
    const int by = CS_BAR_H + 20;
    unsigned border = st == POD_ASKING ? CS_ASK_EDGE : st == POD_DONE ? CS_EDGE : CS_BORDER;
    ht_pro_rect_aa_stroke(s, PADX, by, BOX_W, BOX_H, 20, C(border), C(st == POD_ASKING ? CS_ASK_FILL : CS_SURFACE));
    pod_pet_draw(s, PADX + (BOX_W - 112) / 2, by + (BOX_H - 112) / 2, 112, a->engine, scene_for(st), now_ms, 0);

    const int x = PADX + BOX_W + 24, w = POD_W - PADX - x;
    char name[sizeof a->name];
    snprintf(name, sizeof name, "%s", a->name);
    for (char *c = name; *c; c++) if (*c == '\n' || *c == '\r' || *c == '\t') *c = ' ';
    cs_text(s, x, by + 26, w, &cs_sb_34, CS_INK, name);   // one line, cut with an ellipsis

    // state . time: the state word in the 28 px medium face; an unknown time draws no time and no dot
    const char *label = st == POD_WORKING ? "Running" : st == POD_ASKING ? "Needs input" : st == POD_DONE ? "Done" :
                        st == POD_OFFLINE ? "Offline" : a->failed ? "Failed" : "Idle";
    unsigned col = st == POD_WORKING ? CS_RUN : st == POD_ASKING ? CS_ASK : st == POD_DONE ? CS_INK2 :
                   (st != POD_OFFLINE && a->failed) ? CS_FAIL : CS_MUTED;
    const int cy = by + 70;
    cs_dot(s, x + 6, cy, cs_state_dot(m, a), now_ms);
    int lw = ht_pro_width(&cs_md_28, label);
    cs_text(s, x + 22, cy, lw, &cs_md_28, col, label);
    if (st == POD_WORKING || st == POD_ASKING || (st == POD_DONE && a->elapsed_s)) {
        char t[12];
        pod_fmt_time(t, sizeof t, pod_agent_secs(a, now_ms));
        int dw = ht_pro_width(&cs_rg_22, "\xc2\xb7"), tx = x + 22 + lw + 10;
        cs_text(s, tx, cy, dw + 2, &cs_rg_22, CS_TRACK, "\xc2\xb7");
        cs_text(s, tx + dw + 10, cy, ht_pro_width(&cs_mono_26, t) + 2, &cs_mono_26, CS_INK, t);
    }

    // the engine's logo, then the machine
    const char *meta = a->machine;
    const int my = by + 109;
    cs_logo(s, x, my - LOGO / 2, LOGO, a->engine);
    if (meta[0]) cs_text(s, x + LOGO + 10, my, w - LOGO - 10, &cs_rg_20, MUTED_LBL, meta);
    ht_pro_rect(s, 0, HERO_BOTTOM - 1, POD_W, 1, 0, C(CS_BORDER));
    return HERO_BOTTOM;
}

// The equaliser: EQ_N bars, the last eight bright; each bar a triangle wave of its own period (about 0.7 to 1.1 s).
static void equaliser(ht_scene_t *s, int x, int y, uint32_t now_ms)
{
    const int pitch = 22;   // 17 px bar + 5 px gap
    for (int i = 0; i < EQ_N; i++) {
        uint32_t period = 700 + (uint32_t)(i % 4) * 130, p = (now_ms + (uint32_t)i * 173) % period, half = period / 2;
        int h = 9 + (int)((p < half ? p : period - p) * 21 / half);
        ht_pro_rect(s, x + i * pitch, y + EQ_H - h, 17, h, 2, C(i >= EQ_N - 8 ? CS_RUN : CS_RUN_DIM));
    }
}

void cs_back_hit(pod_out_frame_t *f, const char *crumb)
{
    int w = 24 + 22 + 16 + ht_pro_width(&cs_sb_26, crumb) + 20;
    pod_hit_add(f, 0, 0, w > 540 ? 540 : w, CS_BAR_H, POD_A_BACK, 1);   // one level up
}

void cs_view_agent(pod_out_frame_t *f, const pod_nav_t *nav, pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    const pod_agent_t *a = pod_view_agent_of(nav, m);
    int running, asking;
    cs_counts(m, &running, &asking);
    const char *crumbs[1] = {cs_parent_name(nav, m)};
    cs_bar(f, crumbs, 1, running, asking, cs_unread(m), NULL, now_ms);
    if (!a) return;
    cs_back_hit(f, crumbs[0]);   // the bar names only the tab; a tap on it goes up
    pod_state_t st = pod_model_eff(m, a);
    int y = cs_hero(f, nav, m, a, now_ms);

    if (st == POD_ASKING) {
        char rows[4][POD_ROW_MAX];
        int n = pod_wrap(a->question, &cs_sb_34, POD_W - 2 * 18 - 44, 4, rows);
        const int top = y + 16, h = 18 + 18 + 10 + n * 42 + 16 + 28 + 24 + 18;
        ht_pro_rect_aa_stroke(s, 18, top, POD_W - 36, h, 18, C(CS_ASK_EDGE), C(CS_ASK_FILL));
        cs_label(s, 18 + 22, top + 18 + 9, CS_ASK, "QUESTION");
        for (int i = 0; i < n; i++) cs_text(s, 18 + 22, top + 18 + 18 + 10 + i * 42 + 21, POD_W - 36 - 44, &cs_sb_34, CS_INK, rows[i]);
        int ay = top + 18 + 18 + 10 + n * 42 + 16;
        cs_text(s, 18 + 22, ay + 14, POD_W - 36 - 44, &cs_sb_22, CS_ASK, "Answer in the Harness app");
        return;
    }
    if (st == POD_WORKING) {
        cs_label(s, PADX, y + 16 + 8, MUTED_LBL, "NOW");
        const int ly = y + 16 + 16 + 10 + 18;   // the verb line's centre
        cs_spin(s, PADX + 12, ly, CS_RUN, now_ms);
        const char *verb = a->verb[0] ? a->verb : "Working";
        int vw = ht_pro_width(&cs_mono_26, verb), x = PADX + 24 + 14;
        cs_text(s, x, ly, vw + 2, &cs_mono_26, CS_RUN, verb);
        equaliser(s, PADX, ly + 18 + 12, now_ms);
        int bottom = ly + 18 + 12 + EQ_H + 12;
        if (a->activity[0]) {   // the latest reply text, up to three lines; the last is cut with an ellipsis
            char rows[3][POD_ROW_MAX];
            int n = pod_wrap(a->activity, &cs_rg_27, POD_W - 2 * PADX, 3, rows);
            for (int i = 0; i < n; i++) cs_text(s, PADX, bottom + 20 + i * 36, POD_W - 2 * PADX, &cs_rg_27, CS_INK, rows[i]);
            bottom += 20 + n * 36 + 8;
        }
        ht_pro_rect(s, 0, bottom, POD_W, 1, 0, C(CS_BORDER));
    }
}
