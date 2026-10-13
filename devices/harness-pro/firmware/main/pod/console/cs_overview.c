// Console Overview ("one hero per tab", 7A' of pro-console-overview-v2.html): a 2 x 2 page of tab cards, Recent first. Each card
// is tinted with its tab's hue; its head line is the tab's name (28 px, the lead's size) on the left and the agent count (a pane
// glyph and N) on the right; then, centred, the agent that leads the tab (working > asking > failed > done > idle) as its pet, logo or a ">_"
// outline, and that agent's name. Amber edge when anyone in the tab asks. More than four cards page (the
// TABS frame's scroll is the first row of the page, two rows a page), with dots along the bottom.
#include <stdio.h>
#include <string.h>

#include "pod/console/cs.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)
enum {
    COLS = 2, CARD_W = CS_CARD_W, CARD_H = CS_CARD_H, GAP = CS_CARD_GAP, MARGIN = CS_CARD_MARGIN, TOP = CS_CARD_TOP, PAD = 19,
    // the head line's middle (name and count), the art's box, the lead's name. The pet's square is 168 so every pet's
    // small loop draws at its stored size (zoom 8, the rasteriser's fast path; Claude's frames are 145 wide); its ink fits ART_H
    NAME_Y = 40, ART_Y = CS_CARD_ART_Y, ART_H = CS_CARD_ART_H, FOOT_Y = CARD_H - 30,
    PET_SIDE = 168, LOGO = 72, MARK = 72, MARK_W = 26, GLYPH = 20,
    DOT = 8, DOT_PITCH = 16, DOT_Y = 700, DOTS_MAX = 8
};

void cs_counts(const pod_model_t *m, int *running, int *asking)
{
    int r = 0, q = 0;
    for (int i = 0; i < m->agent_count; i++) {
        pod_state_t st = pod_model_eff(m, &m->agents[i]);
        r += st == POD_WORKING;
        q += st == POD_ASKING;
    }
    if (running) *running = r;
    if (asking) *asking = q;
}

uint32_t cs_age_s(const pod_model_t *m, const pod_agent_t *a)
{
    uint32_t best = UINT32_MAX;
    const struct { bool has; uint32_t t; } at[2] = {{a->has_act, a->act_ms}, {a->has_lib, a->lib_ms}};
    for (int k = 0; k < 2; k++) {
        if (!at[k].has) continue;
        int32_t d = (int32_t)(m->clock_ms - at[k].t);
        uint32_t age = d < 0 ? 0u : (uint32_t)d / 1000u;
        if (age < best) best = age;
    }
    return best == UINT32_MAX ? 0u : best;
}

char cs_state_dot(const pod_model_t *m, const pod_agent_t *a)
{
    pod_state_t st = pod_model_eff(m, a);
    return st == POD_WORKING ? 'g' : st == POD_ASKING ? 'q' : st == POD_DONE ? 'd' : (st == POD_IDLE && a->failed) ? 'r' : 'i';
}

unsigned cs_time_col(char *out, size_t n, const pod_model_t *m, const pod_agent_t *a, uint32_t now_ms)
{
    pod_state_t st = pod_model_eff(m, a);
    if (st == POD_WORKING) { pod_fmt_time(out, n, pod_agent_secs(a, now_ms)); return CS_RUN; }
    if (st == POD_ASKING) { snprintf(out, n, "ask"); return CS_ASK; }
    if (st == POD_OFFLINE) { snprintf(out, n, "off"); return CS_DIM; }
    pod_fmt_age(out, n, cs_age_s(m, a));
    return CS_DIM;
}

// A tab's agents for its card: Recent's newest first, or the tab's panes in pane order (at most CS_CARD_AGENTS).
static int card_agents(const pod_model_t *m, int c, const pod_agent_t *out[CS_CARD_AGENTS])
{
    int n = 0;
    if (c == 0) {
        const pod_agent_t *all[POD_RECENT_MAX];
        int k = pod_model_recent(m, all, POD_RECENT_MAX);
        for (int i = 0; i < k && n < CS_CARD_AGENTS; i++) out[n++] = all[i];
    } else {
        const pod_tab_t *t = &m->tabs[c - 1];
        for (int k = 0; k < t->count && k < POD_PANES_MAX && n < CS_CARD_AGENTS; k++)
            if (t->agent[k] >= 0 && t->agent[k] < m->agent_count) out[n++] = &m->agents[t->agent[k]];
    }
    return n;
}

// Which state speaks for a card: working, then asking, failed, done, idle. The first agent of the best rank leads.
static int rank(char dot) { return dot == 'g' ? 0 : dot == 'q' ? 1 : dot == 'r' ? 2 : dot == 'd' ? 3 : 4; }

// Every agent the card stands for (Recent's whole list, or every pane of the tab with an agent), and whether one asks.
static int card_count(const pod_model_t *m, int c, bool *asks)
{
    int n = 0;
    *asks = false;
    if (c == 0) {
        const pod_agent_t *all[POD_RECENT_MAX];
        n = pod_model_recent(m, all, POD_RECENT_MAX);
        for (int i = 0; i < n; i++) *asks |= pod_model_eff(m, all[i]) == POD_ASKING;
        return n;
    }
    const pod_tab_t *t = &m->tabs[c - 1];
    for (int k = 0; k < t->count && k < POD_PANES_MAX; k++)
        if (t->agent[k] >= 0 && t->agent[k] < m->agent_count) {
            n++;
            *asks |= pod_model_eff(m, &m->agents[t->agent[k]]) == POD_ASKING;
        }
    return n;
}

const pod_agent_t *cs_card_lead(const pod_model_t *m, int c)
{
    const pod_agent_t *l[CS_CARD_AGENTS], *best = NULL;
    int n = card_agents(m, c, l), br = 99;
    for (int i = 0; i < n; i++) {
        int r = rank(cs_state_dot(m, l[i]));
        if (r < br) { br = r; best = l[i]; }
    }
    return best;
}

ht_pet_state_t cs_card_loop(const pod_model_t *m, const pod_agent_t *a)
{
    pod_state_t st = pod_model_eff(m, a);
    return st == POD_WORKING ? HT_PET_WORKING : st == POD_ASKING ? HT_PET_ASKING : HT_PET_IDLE;
}

// The first cover on the page Overview shows and how many (the TABS frame's scroll is the page's first row, two rows a page).
static int page_span(const pod_nav_t *nav, const pod_model_t *m, int *first)
{
    int covers = 1 + m->tab_count, pages = pod_tabs_pages_of(nav, m);
    int page = nav->depth ? nav->stack[0].scroll / 2 : 0;
    page = page < 0 ? 0 : page > pages - 1 ? pages - 1 : page;
    *first = page * CS_PER_PAGE;
    return covers - *first < CS_PER_PAGE ? covers - *first : CS_PER_PAGE;
}

// The agents whose cards the screen shows: Overview's leads on its page, or the card Tab's page. 0 on any other screen.
static int on_screen(const pod_nav_t *nav, const pod_model_t *m, const pod_agent_t *out[CS_PER_PAGE])
{
    const pod_frame_t *f = nav->depth ? &nav->stack[nav->depth - 1] : NULL;
    if (!f || nav->skin != POD_SKIN_CONSOLE) return 0;
    if (f->view == POD_V_TAB && f->tab != POD_TAB_RECENT) return cs_tab_page(nav, m, out);
    if (f->view != POD_V_TABS) return 0;
    int first, n = page_span(nav, m, &first), k = 0;
    for (int i = 0; i < n; i++) {
        const pod_agent_t *a = cs_card_lead(m, first + i);
        if (a) out[k++] = a;
    }
    return k;
}

uint32_t cs_cards_next_ms(const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    const pod_agent_t *l[CS_PER_PAGE];
    int n = on_screen(nav, m, l);
    uint32_t best = 1000;
    for (int i = 0; i < n; i++) {
        if (cs_card_loop(m, l[i]) == HT_PET_IDLE) continue;   // a resting pet is drawn still
        uint32_t ms = pod_pet_loop_next_ms(l[i]->engine, cs_card_loop(m, l[i]), now_ms);
        if (ms < best) best = ms;
    }
    // four pets redraw the whole page: no faster than the Console's animation beat
    if (best < POD_CS_ANIM_MS) best = POD_CS_ANIM_MS - now_ms % POD_CS_ANIM_MS;
    return best;
}

bool cs_cards_move(const pod_nav_t *nav, const pod_model_t *m)
{
    const pod_agent_t *l[CS_PER_PAGE];
    int n = on_screen(nav, m, l);
    for (int i = 0; i < n; i++)
        if (cs_card_loop(m, l[i]) != HT_PET_IDLE && pod_pet_for(l[i]->engine)) return true;
    return false;
}

// The tab hues: six that stay clear of the state colours (green working, amber asking), and the ground they are mixed into.
static const unsigned HUES[] = {0x8B7CFF, 0x38BDF8, 0xF472B6, 0xFF8A65, 0x2DD4BF, 0xA3A8FF};
enum { CARD_BASE = CS_GROUND };

void cs_card_art(ht_scene_t *s, int cx, int cy, const pod_model_t *m, const pod_agent_t *a, unsigned fill, uint32_t now_ms)
{
    ht_pet_state_t loop = cs_card_loop(m, a);   // a resting pet holds its first step: a quiet screen wakes once a second
    if (pod_pet_draw_loop(s, cx - PET_SIDE / 2, cy - PET_SIDE / 2, PET_SIDE, a->engine, loop, loop == HT_PET_IDLE ? 0 : now_ms) ||
        pod_logo_draw(s, cx - LOGO / 2, cy - LOGO / 2, LOGO, a->engine))
        return;
    ht_pro_rect_aa_stroke(s, cx - MARK / 2, cy - MARK / 2, MARK, MARK, 16, C(0x8A909A), C(fill));
    int w = ht_pro_width(&cs_mono_26, ">_");
    cs_text(s, cx - w / 2, cy, w + 2, &cs_mono_26, CS_INK2, ">_");
}

// Text centred on the card's middle line at cy, cut with an ellipsis at the card's inner width.
static int centred(ht_scene_t *s, int x, int cy, const ht_pro_font_t *font, unsigned rgb, const char *t, int lead_w)
{
    int max = CARD_W - 2 * PAD - lead_w, w = ht_pro_width(font, t);
    if (w > max) w = max;
    int tx = x + (CARD_W - w - lead_w) / 2 + lead_w;
    cs_text(s, tx, cy, w + 2, font, rgb, t);
    return tx;
}

static void card(pod_out_frame_t *f, const pod_model_t *m, int c, int x, int y, bool sel, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    bool asks;
    int count = card_count(m, c, &asks);
    const pod_agent_t *lead = cs_card_lead(m, c);
    char tone = lead ? cs_state_dot(m, lead) : 'i';

    // the tab's hue (by cover, six in turn): a dark tint of it fills the card and a mid one edges it. An amber edge when anyone in
    // the tab asks; the selected card is outlined in the focus colour.
    const unsigned hue = HUES[c % (int)(sizeof HUES / sizeof HUES[0])];
    unsigned fill = cs_mix(hue, CARD_BASE, 15), border = sel ? CS_FOCUS : asks ? CS_ASK : cs_mix(hue, CARD_BASE, 75);
    ht_pro_rect_aa_stroke(s, x, y, CARD_W, CARD_H, 18, C(border), C(fill));

    // head line: the tab's name on the left; on the right the count chip (a 2 x 2 pane glyph and N, in the hue), or "empty"
    const int left = x + PAD, right = x + CARD_W - PAD, hy = y + NAME_Y;
    int cw;
    if (c > 0 && pod_tab_panes(&m->tabs[c - 1]) == 0) {
        cw = ht_pro_width(&cs_rg_22, "empty");
        cs_text(s, right - cw, hy, cw + 2, &cs_rg_22, CS_MUTED, "empty");
    } else {
        char k[8];
        snprintf(k, sizeof k, "%d", count);
        int kw = ht_pro_width(&cs_mono_24, k), cx0;
        cw = 10 + GLYPH + 8 + kw + 10;
        cx0 = right - cw;
        ht_pro_rect_aa(s, cx0, hy - 17, cw, 34, 10, C(cs_mix(hue, CARD_BASE, 50)));
        for (int i = 0; i < 4; i++)   // the pane glyph: four 8 px squares, 4 px apart
            ht_pro_rect(s, cx0 + 10 + (i % 2) * 12, hy - GLYPH / 2 + (i / 2) * 12, 8, 8, 2, C(hue));
        cs_text(s, cx0 + 10 + GLYPH + 8, hy, kw + 2, &cs_mono_24, CS_INK, k);
    }
    cs_text(s, left, hy, right - cw - 12 - left, &cs_md_28, CS_INK, c == 0 ? "Recent" : m->tabs[c - 1].name);
    if (!lead) { pod_hit_add_id(f, x, y, CARD_W, CARD_H, POD_A_OPEN_TAB, c ? c - 1 : POD_TAB_RECENT, c ? m->tabs[c - 1].id : ""); return; }

    // the lead (working first): its pet, else its logo straight on the card, else a thin ">_" outline
    cs_card_art(s, x + CARD_W / 2, y + ART_Y + ART_H / 2, m, lead, fill, now_ms);

    // its name at the foot, centred, after the working mark while it works
    char nm[sizeof lead->name];
    snprintf(nm, sizeof nm, "%s", lead->name);
    for (char *p = nm; *p; p++) if (*p == '\n' || *p == '\r' || *p == '\t') *p = ' ';
    const bool works = tone == 'g';
    int tx = centred(s, x, y + FOOT_Y, &cs_md_28, CS_INK2, nm, works ? MARK_W + 10 : 0);
    if (works) cs_working_mark(s, tx - MARK_W - 10, y + FOOT_Y - 13, now_ms);
    pod_hit_add_id(f, x, y, CARD_W, CARD_H, POD_A_OPEN_TAB, c ? c - 1 : POD_TAB_RECENT, c ? m->tabs[c - 1].id : "");
}

void cs_view_overview(pod_out_frame_t *f, const pod_nav_t *nav, pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    int running, asking;
    cs_counts(m, &running, &asking);
    const char *const crumbs[] = {"Overview"};
    cs_bar(f, crumbs, 1, running, asking, cs_unread(m), NULL, now_ms);
    int pages = pod_tabs_pages_of(nav, m);

    int first, count = page_span(nav, m, &first), page = first / CS_PER_PAGE;
    for (int i = 0; i < count; i++) {
        int c = first + i;
        card(f, m, c, MARGIN + (i % COLS) * (CARD_W + GAP), TOP + (i / COLS) * (CARD_H + GAP), c > 0 && c - 1 == m->selected && m->tab_count, now_ms);
    }
    int dots = pages > 1 ? (pages < DOTS_MAX ? pages : DOTS_MAX) : 0;
    int x0 = (POD_W - (dots * DOT_PITCH - (DOT_PITCH - DOT))) / 2;   // the page dots, centred along the bottom
    for (int i = 0; i < dots; i++)
        ht_pro_rect(s, x0 + i * DOT_PITCH, DOT_Y, DOT, DOT, DOT / 2, C(i == (page < dots ? page : dots - 1) ? CS_INK : CS_TRACK));
}
