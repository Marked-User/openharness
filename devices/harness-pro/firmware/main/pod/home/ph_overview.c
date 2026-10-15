// Pets Home: "cover cards" (the owner's mockup harness-pro-tabs-cards.html). One tab a page (the TABS frame's scroll is the tab): a 540 x 560 card
// at (90, 56) with a vertical gradient in the colours of the tab's main engine, the name on one line, the agent count in ph_num_230 with
// "agents" beside it, status pills (working with a 4-bar equaliser, asking with a pulsing dot, else "All done"), and a row of 72 px engine
// logos (asking first, then working, then done, the done ones faded) with a state dot under each; more than five agents show four and "+N".
// The neighbour tabs peek in at the sides, 86 % and faded toward the ground. No dots, bell, title or pets. One POD_A_ENTER_TAB hit over the
// card (arg = the tab, id = its id); none for a tab with 0 agents.
// Notices card (the owner's mockup, option B): while there are notices (pod_notice_count: the list the Notices screen shows) one more card comes FIRST,
// before every tab card, in the orange gradient #FF9A52 -> #9C3F10: "Notices", the count in ph_num_230 with "new" beside it and up to three rows (a 44 px engine
// logo and the notice's text, one line cut with an ellipsis). One POD_A_INBOX hit over it. It peeks beside the first tab card like any neighbour.
// Paging: the TABS frame's scroll is the tab index, and -1 is the Notices card (valid only while notices exist). Page = scroll + 1 with notices, scroll
// without, so a notice coming or going never moves the person to another tab: it only adds or drops the page before tab 0 (and when the Notices card is
// what is shown and the last notice goes, Home settles on tab 0).
// Also here: the small helpers the other Pets screens share (the pet / logo art).
#include <stdio.h>
#include <string.h>

#include "pod/home/ph.h"
#include "pod/pod_pet.h"
#include "pod/pod_view_shared.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)
enum {
    LOGO = 72, MARK = 72,
    CARD_X = 90, CARD_Y = 56, CARD_W = 540, CARD_H = 560, CARD_R = 48, PEEK_DX = 500, PEEK_PCT = 86, PEEK_FADE = 45,   // the owner's cover-card mockup
    NAME_X = 44, NAME_Y = 40, NAME_W = CARD_W - 2 * NAME_X, NUM_X = 38, NUM_TOP = 61, NUM_SIZE = 230, NUM_BASE = 291,   // NUM_BASE: the digits' baseline, 291 down the card
    LABEL_GAP = 16, NOTE_Y = 345, NOTE_PITCH = 66, NOTE_ROWS = 3, NOTE_LOGO = 44, NOTE_GAP = 18, PILL_Y = 345, PILL_H = 46, PILL_GAP = 12, PILL_PAD = 18, ICONS_Y = 448, ICON_PITCH = 98, DOT = 12, ICONS_MAX = 5
};

pod_scene_t ph_card_scene(const pod_model_t *m, const pod_agent_t *a)
{
    pod_state_t st = pod_model_eff(m, a);
    return st == POD_WORKING ? POD_SCENE_WORK : st == POD_ASKING ? POD_SCENE_ASK : POD_SCENE_REST;
}


void ph_card_art(ht_scene_t *s, int cx, int cy, int side, const pod_model_t *m, const pod_agent_t *a, unsigned fill, uint32_t now_ms)
{
    if (pod_pet_for(a->engine)) {   // the scene of its state (work, ask, rest), as the agent screen plays it
        pod_pet_draw(s, cx - side / 2, cy - side / 2, side, a->engine, ph_card_scene(m, a), now_ms, 0, 8);
        return;
    }
    if (pod_logo_draw(s, cx - LOGO / 2, cy - LOGO / 2, LOGO, a->engine)) return;
    ht_pro_rect_aa_stroke(s, cx - MARK / 2, cy - MARK / 2, MARK, MARK, 16, C(0x8A909A), C(fill));
    int w = ht_pro_width(&ph_mono_26, ">_");
    ph_text(s, cx - w / 2, cy, w + 2, &ph_mono_26, PH_INK2, ">_");
}


// What Home shows: the top frame's scroll (a TAB frame, which Pets never reaches, shows its own tab), clamped to the tabs: the tab index, HOME_NOTICES
// for the Notices card (only while there are notices), HOME_NONE with neither a tab nor a notice.
enum { HOME_NONE = -2, HOME_NOTICES = -1 };
static int home_at(const pod_nav_t *nav, const pod_model_t *m)
{
    const bool notices = pod_notice_count(m) > 0;
    if (m->tab_count < 1) return notices ? HOME_NOTICES : HOME_NONE;
    const pod_frame_t *f = nav->depth ? &nav->stack[nav->depth - 1] : NULL;
    int at = !f ? 0 : f->view == POD_V_TAB ? f->tab : f->scroll;
    return at < (notices ? HOME_NOTICES : 0) ? (notices ? HOME_NOTICES : 0) : at > m->tab_count - 1 ? m->tab_count - 1 : at;
}

// The agents of tab t (panes that name a rostered agent) and how many of them work.
static int tab_agents(const pod_model_t *m, int t, int *working)
{
    int n = 0, w = 0;
    const pod_tab_t *tab = &m->tabs[t];
    for (int k = 0; k < tab->count && k < POD_PANES_MAX; k++)
        if (tab->agent[k] >= 0 && tab->agent[k] < m->agent_count) {
            n++;
            w += pod_model_eff(m, &m->agents[tab->agent[k]]) == POD_WORKING;
        }
    if (working) *working = w;
    return n;
}


static int tab_asking(const pod_model_t *m, int t)
{
    int n = 0;
    const pod_tab_t *tab = &m->tabs[t];
    for (int k = 0; k < tab->count && k < POD_PANES_MAX; k++)
        if (tab->agent[k] >= 0 && tab->agent[k] < m->agent_count && pod_model_eff(m, &m->agents[tab->agent[k]]) == POD_ASKING) n++;
    return n;
}

// What moves on Home: a working agent's equaliser, bob and an asking agent's pulse. Nothing else, so a still tab wakes once a second.
bool ph_home_brand(const pod_nav_t *nav, const pod_model_t *m) { return home_at(nav, m) == HOME_NONE; }

bool ph_home_moves(const pod_nav_t *nav, const pod_model_t *m)
{
    int t = home_at(nav, m), working = 0;
    if (t == HOME_NONE) return true;   // the first screen's shimmer and bar
    if (t < 0) return false;   // the Notices card is still
    tab_agents(m, t, &working);
    return working > 0 || tab_asking(m, t) > 0;
}

uint32_t ph_home_next_ms(const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    return ph_home_moves(nav, m) ? POD_PH_ANIM_MS - now_ms % POD_PH_ANIM_MS : 1000;
}

// The card's two colours by its main engine (the one with the most agents in the tab, a tie to the first in pane order).
static void tint(const pod_model_t *m, int t, unsigned *c1, unsigned *c2)
{
    const pod_tab_t *tab = &m->tabs[t];
    const char *best = NULL;
    int best_n = 0;
    for (int k = 0; k < tab->count && k < POD_PANES_MAX; k++) {
        if (tab->agent[k] < 0 || tab->agent[k] >= m->agent_count) continue;
        const char *e = m->agents[tab->agent[k]].engine;
        int n = 0;
        for (int j = 0; j < tab->count && j < POD_PANES_MAX; j++)
            if (tab->agent[j] >= 0 && tab->agent[j] < m->agent_count && !strcmp(m->agents[tab->agent[j]].engine, e)) n++;
        if (n > best_n) { best_n = n; best = e; }
    }
    if (best && !strcmp(best, "codex")) { *c1 = PH_TINT_CODEX1; *c2 = PH_TINT_CODEX2; }
    else if (best && !strcmp(best, "claude")) { *c1 = PH_TINT_CLAUDE1; *c2 = PH_TINT_CLAUDE2; }
    else if (best && !strcmp(best, "muse")) { *c1 = PH_TINT_MUSE1; *c2 = PH_TINT_MUSE2; }
    else if (best && !strcmp(best, "kilo")) { *c1 = PH_TINT_KILO1; *c2 = PH_TINT_KILO2; }
    else { *c1 = PH_TINT_OTHER1; *c2 = PH_TINT_OTHER2; }
}

// The characters ph_sb_48 bakes (gen_fonts.CONSOLE_CUT): a name with any other falls to the full 34 px face.
static bool name_fits_48(const char *t)
{
    for (; *t; t++) {
        unsigned char c = (unsigned char)*t;
        if (c >= 0x80) { if (!strncmp(t, "\xe2\x80\xa6", 3)) { t += 2; continue; } return false; }
        if (!(c == ' ' || c == '.' || c == '-' || c == '+' || c == '_' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))) return false;
    }
    return true;
}

// The name on one line: control characters as spaces, "Untitled" when empty, cut with an ellipsis to fit `w`. Returns the face (small: always ph_sb_34).
static const ht_pro_font_t *shown_name(char *out, size_t n, const char *name, int w, bool small)
{
    snprintf(out, n, "%s", name);
    for (char *p = out; *p; p++) if (*p == '\n' || *p == '\r' || *p == '\t') *p = ' ';
    if (!out[strspn(out, " ")]) snprintf(out, n, "Untitled");
    const ht_pro_font_t *font = !small && name_fits_48(out) ? &ph_sb_48 : &ph_sb_34;
    if (ht_pro_width(font, out) > w) {
        size_t len = strlen(out);
        do {
            do len--; while (len > 0 && ((unsigned char)out[len] & 0xC0) == 0x80);   // back one whole character
            snprintf(out + len, n - len, "\xe2\x80\xa6");
        } while (len > 0 && ht_pro_width(font, out) > w);
    }
    return font;
}

static int tri(uint32_t t, uint32_t period)   // 0..100
{
    uint32_t p = t % period, half = period / 2;
    return (int)((p < half ? p : period - p) * 100 / half);
}

// A text run whose baseline sits at `base` (the cell's baseline is 1/1.375 of its height down).
static void on_baseline(ht_scene_t *s, int x, int base, const ht_pro_font_t *f, unsigned rgb, const char *t)
{
    ht_pro_text(s, x, base - f->height * 8 / 11, ht_pro_width(f, t) + 2, f, C(rgb), t);
}

// The first screen (mockup harness-pro-boot.html, option 5 "Shimmer"): the round dial's wordmark, larger, on its own navy ground, with a
// light sweeping across the letters and a sliding pill in a short track. Shown for Home with no tabs (and no notices): before the first swarms
// of a link, after a link drop, or a machine with none. No hits. It moves, so Home wakes on the 66 ms beat while it shows (ph_home_moves).
// Geometry is the mockup's 720 px screen: word box top 300, 84 px, line-height 1 (baseline 373), letter-spacing -0.02em; track 260,430 200x6.
enum { BR_BG = 0x0E1B2C, BR_INK = 0xF2F7FC, BR_LIGHT = 0x9CC6FF, BR_TRACK = 0x1B2A3D, BR_PILL = 0x5F8FD6,
       BR_BASE = 373, BR_SPACE_X100 = 168, BR_SHINE_MS = 2400, BR_SLIDE_MS = 1400,
       BR_BAR_X = 260, BR_BAR_Y = 430, BR_BAR_W = 200, BR_BAR_H = 6, BR_PILL_W = 70 };

// Each letter is its own text run in one solid colour, so a frame damages only the letters whose colour changed plus the pill's old and new
// place. The band is the mockup's gradient: 3x the word wide, the highlight at its middle, easing back to the ink over a tenth of it each side
// (0.3 word widths), its centre running linearly from -0.5 to 2.5 word widths every 2.4 s (left to right). The 100deg slant is dropped.
static void wordmark(ht_scene_t *s, uint32_t now_ms)
{
    static const char word[] = "Harness";
    const int n = (int)sizeof word - 1;
    int total = ht_pro_width(&ph_bd_84, word) - (n * BR_SPACE_X100 + 50) / 100;
    const int x0 = (POD_W - total) / 2;
    s->background = C(BR_BG);
    const int centre = -total / 2 + (int)((uint64_t)(now_ms % BR_SHINE_MS) * 3 * (uint64_t)total / BR_SHINE_MS);   // -0.5 .. 2.5 words
    const int reach = total * 3 / 10;
    for (int i = 0; i < n; i++) {
        char one[2] = {word[i], 0}, head[8];
        memcpy(head, word, (size_t)i); head[i] = 0;
        const int x = x0 + ht_pro_width(&ph_bd_84, head) - (i * BR_SPACE_X100 + 50) / 100, mid = x - x0 + ht_pro_width(&ph_bd_84, one) / 2;
        int d = mid - centre; if (d < 0) d = -d;
        const unsigned lit = d >= reach ? 0 : (unsigned)(100 - d * 100 / reach);
        on_baseline(s, x, BR_BASE, &ph_bd_84, ph_mix(BR_LIGHT, BR_INK, lit), one);
    }
    // The loading bar: a 70 px pill slides from -70 to 200 along the track (ease-in-out), clipped to it, every 1.4 s.
    ht_pro_rect_aa(s, BR_BAR_X, BR_BAR_Y, BR_BAR_W, BR_BAR_H, 3, C(BR_TRACK));
    const int t = (int)(now_ms % BR_SLIDE_MS * 1000 / BR_SLIDE_MS), e = t * t * (3000 - 2 * t) / 1000000;   // smoothstep, 0..1000
    const int px = -BR_PILL_W + (BR_BAR_W + BR_PILL_W) * e / 1000;
    const int a = px < 0 ? 0 : px, b = px + BR_PILL_W > BR_BAR_W ? BR_BAR_W : px + BR_PILL_W;
    if (b > a) ht_pro_rect_aa(s, BR_BAR_X + a, BR_BAR_Y, b - a, BR_BAR_H, b - a >= 6 ? 3 : (b - a) / 2, C(BR_PILL));
}

static int st_of(const pod_model_t *m, const pod_agent_t *a)
{
    pod_state_t st = pod_model_eff(m, a);
    return st == POD_ASKING ? 0 : st == POD_WORKING ? 1 : 2;
}

// An engine's logo in a 72 px slot at (x, y): its 72 px art, else (the pet engines bake no 72) the 44 px one centred in the slot. False without any.
static bool slot_logo(ht_scene_t *s, int x, int y, const char *engine, unsigned opacity)
{
    return pod_logo_draw_faded(s, x, y, LOGO, engine, opacity) || pod_logo_draw_faded(s, x + (LOGO - 44) / 2, y + (LOGO - 44) / 2, 44, engine, opacity);
}

// One status pill at (x, y): fill (black 28 % over the card), a mark (equaliser, dot or none), the text. Returns its width.
static int pill(ht_scene_t *s, int x, int y, unsigned fill, int kind, unsigned ink, const char *text, uint32_t now_ms)
{
    const int mark = kind == 1 ? 32 : kind == 2 ? 11 : 0, tw = ht_pro_width(&ph_sb_22, text), w = PILL_PAD * 2 + (mark ? mark + 10 : 0) + tw;
    ht_pro_rect_aa(s, x, y, w, PILL_H, PILL_H / 2, C(fill));
    int tx = x + PILL_PAD;
    if (kind == 1) {   // four bars, 5 px wide 4 px apart, 30..100 % of 22 px, anchored at the bottom
        static const int phase[4] = {0, -300, -600, -150};
        for (int i = 0; i < 4; i++) {
            int h = 22 * (30 + 70 * tri((uint32_t)((int)(now_ms % 1000u) + phase[i] + 1000), 1000) / 100) / 100;
            ht_pro_rect(s, tx + i * 9, y + PILL_H / 2 + 11 - h, 5, h, 2, C(ink));
        }
    } else if (kind == 2) {   // a dot that pulses between 25 and 100 %
        ht_pro_rect_aa(s, tx, y + PILL_H / 2 - 5, 11, 11, 5, C(ph_mix(ink, fill, 25 + 75 * (unsigned)tri(now_ms, 1200) / 100)));
    }
    ph_text(s, tx + (mark ? mark + 10 : 0), y + PILL_H / 2, tw + 2, &ph_sb_22, ink, text);
    return w;
}

// An engine's logo at exactly `size` (a baked one: 28, 36, 44 or 72), else a ">_" outline box of that size on `fill`.
void ph_engine_logo(ht_scene_t *s, int x, int y, int size, const char *engine, unsigned fill)
{
    if (engine && pod_logo_draw(s, x, y, size, engine)) return;
    ht_pro_rect_aa_stroke(s, x, y, size, size, size / 5, C(0x8A909A), C(fill));
    int w = ht_pro_width(&ph_mono_22, ">_");
    ph_text(s, x + (size - w) / 2, y + size / 2, w + 2, &ph_mono_22, PH_INK2, ">_");
}

// The Notices card: the same card as a tab's, in the notice orange. A neighbour (full false) shows its gradient and name only.
static void notices_card(pod_out_frame_t *f, const pod_model_t *m, int x, int y, int w, int h, int r, int fade, bool full)
{
    ht_scene_t *s = f->scene;
    unsigned c1 = PH_NOTICE1, c2 = PH_NOTICE2;
    if (fade) { c1 = ph_mix(c1, PH_HOME_BG, (unsigned)fade); c2 = ph_mix(c2, PH_HOME_BG, (unsigned)fade); }
    pod_grad_aa_dither(s, x, y, w, h, r, C(c1), C(c2));
    char name[CABLE_NAME_MAX + 4];
    const ht_pro_font_t *nf = shown_name(name, sizeof name, "Notices", full ? NAME_W : NAME_W * PEEK_PCT / 100, !full);
    const int nx = x + (full ? NAME_X : NAME_X * PEEK_PCT / 100), nw = ht_pro_width(nf, name);
    if (!full) {
        if (nx < POD_W && nx + nw > 0) ht_pro_text(s, nx, y + 40 * PEEK_PCT / 100, nw + 2, nf, C(ph_mix(PH_CARD_INK, c1, 80)), name);
        return;
    }
    ph_text(s, nx, y + NAME_Y + nf->height / 2, NAME_W, nf, PH_CARD_INK, name);
    const int count = pod_notice_count(m);
    char num[8];
    snprintf(num, sizeof num, "%d", count > 99 ? 99 : count);
    const int nw2 = ht_pro_width(&ph_num_230, num);
    ht_pro_text(s, x + NUM_X, y + NUM_TOP, nw2 + 2, &ph_num_230, C(PH_CARD_INK), num);
    on_baseline(s, x + NUM_X + nw2 + LABEL_GAP, y + NUM_BASE, &ph_sb_26, ph_mix(0xFFFFFF, ph_mix(c1, c2, 100 - NUM_BASE * 100 / h), 85), "new");
    ph_notice_line_t line[NOTE_ROWS];
    const int n = ph_notices_top(m, NOTE_ROWS, line);
    for (int k = 0; k < n; k++) {
        const int ry = y + NOTE_Y + k * NOTE_PITCH, tx = x + NAME_X + NOTE_LOGO + NOTE_GAP;
        const unsigned ground = ph_mix(c1, c2, 100 - (NOTE_Y + k * NOTE_PITCH + NOTE_LOGO / 2) * 100 / h);   // the gradient where the row sits
        ph_engine_logo(s, x + NAME_X, ry, NOTE_LOGO, line[k].engine, ground);
        ph_text(s, tx, ry + NOTE_LOGO / 2, x + w - NAME_X - tx, &ph_rg_24, ph_mix(0xFFFFFF, ground, 92), line[k].text);
    }
}

// The card's content or, for a neighbour, only its gradient and name.
static void card(pod_out_frame_t *f, const pod_model_t *m, int t, int x, int y, int w, int h, int r, int fade, bool full, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    unsigned c1, c2;
    tint(m, t, &c1, &c2);
    if (fade) { c1 = ph_mix(c1, PH_HOME_BG, (unsigned)fade); c2 = ph_mix(c2, PH_HOME_BG, (unsigned)fade); }
    pod_grad_aa_dither(s, x, y, w, h, r, C(c1), C(c2));   // Pets only: no banding on the card
    char name[CABLE_NAME_MAX + 4];
    const ht_pro_font_t *nf = shown_name(name, sizeof name, m->tabs[t].name, full ? NAME_W : NAME_W * PEEK_PCT / 100, !full);
    const int nx = x + (full ? NAME_X : NAME_X * PEEK_PCT / 100), nw = ht_pro_width(nf, name);
    if (!full) {   // a neighbour: the name only, faded (most of it is off the glass)
        if (nx < POD_W && nx + nw > 0) ht_pro_text(s, nx, y + 40 * PEEK_PCT / 100, nw + 2, nf, C(ph_mix(PH_CARD_INK, c1, 80)), name);
        return;
    }
    ph_text(s, nx, y + NAME_Y + nf->height / 2, NAME_W, nf, PH_CARD_INK, name);

    int working, count = tab_agents(m, t, &working), asking = tab_asking(m, t);
    char num[8];
    snprintf(num, sizeof num, "%d", count);
    const int nw2 = ht_pro_width(&ph_num_230, num);
    ht_pro_text(s, x + NUM_X, y + NUM_TOP, nw2 + 2, &ph_num_230, C(PH_CARD_INK), num);
    on_baseline(s, x + NUM_X + nw2 + LABEL_GAP, y + NUM_BASE, &ph_sb_26, ph_mix(0xFFFFFF, ph_mix(c1, c2, 100 - NUM_BASE * 100 / h), 85), count == 1 ? "agent" : "agents");

    const unsigned fill = ph_mix(0x000000, ph_mix(c1, c2, 100 - (PILL_Y + PILL_H / 2) * 100 / h), 28);
    char txt[24];
    int px = x + NAME_X;
    if (working > 0) { snprintf(txt, sizeof txt, "%d working", working); px += pill(s, px, y + PILL_Y, fill, 1, PH_PILL_WORK, txt, now_ms) + PILL_GAP; }
    if (asking > 0) { snprintf(txt, sizeof txt, "%d asking", asking); px += pill(s, px, y + PILL_Y, fill, 2, PH_PILL_ASK, txt, now_ms) + PILL_GAP; }
    if (!working && !asking) pill(s, px, y + PILL_Y, fill, 0, ph_mix(0xFFFFFF, fill, 80), "\xe2\x9c\x93 All done", now_ms);

    // the engine logos: asking, working, then done; more than five show four and "+N"
    const pod_agent_t *ord[POD_PANES_MAX];
    int n = 0;
    for (int pass = 0; pass < 3; pass++)
        for (int k = 0; k < m->tabs[t].count && k < POD_PANES_MAX; k++) {
            int ai = m->tabs[t].agent[k];
            if (ai >= 0 && ai < m->agent_count && st_of(m, &m->agents[ai]) == pass) ord[n++] = &m->agents[ai];
        }
    const int shown = n > ICONS_MAX ? ICONS_MAX - 1 : n, iy = y + ICONS_Y;
    const unsigned bottom = ph_mix(c1, c2, 100 - (ICONS_Y + LOGO + 12) * 100 / h);
    for (int k = 0; k < shown; k++) {
        const int ix = x + NAME_X + k * ICON_PITCH, st = st_of(m, ord[k]);
        const int bob = st == 1 ? -6 * tri(now_ms, 1800) / 100 : 0;
        bool drawn = slot_logo(s, ix, iy + bob, ord[k]->engine, st == 2 ? 140 : 255);
        if (!drawn) {
            ht_pro_rect_aa_stroke(s, ix, iy + bob, MARK, MARK, 16, C(st == 2 ? ph_mix(0x8A909A, c1, 55) : 0x8A909A), C(c1));
            int gw = ht_pro_width(&ph_mono_26, ">_");
            ph_text(s, ix + MARK / 2 - gw / 2, iy + bob + MARK / 2, gw + 2, &ph_mono_26, PH_INK2, ">_");
        }
        unsigned dot = st == 1 ? 0x5FE08F : st == 0 ? ph_mix(0xFF9A52, bottom, 25 + 75 * (unsigned)tri(now_ms, 1200) / 100) : ph_mix(0xFFFFFF, bottom, 35);
        ht_pro_rect_aa(s, ix + LOGO / 2 - DOT / 2, iy + LOGO + 6, DOT, DOT, DOT / 2, C(dot));
    }
    if (n > ICONS_MAX) {
        char more[8];
        snprintf(more, sizeof more, "+%d", n - shown);
        const int mx = x + NAME_X + shown * ICON_PITCH;
        ph_text(s, mx, iy + LOGO / 2, ht_pro_width(&ph_sb_32, more) + 2, &ph_sb_32, ph_mix(0xFFFFFF, bottom, 80), more);
    }
}

void ph_view_home(pod_out_frame_t *f, const pod_nav_t *nav, pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    s->background = C(PH_HOME_BG);
    const int t = home_at(nav, m);
    if (t == HOME_NONE) { wordmark(s, now_ms); return; }
    const int pw = CARD_W * PEEK_PCT / 100, ph = CARD_H * PEEK_PCT / 100, py = CARD_Y + CARD_H / 2 - ph / 2;
    const int lx = CARD_X + CARD_W / 2 - PEEK_DX - pw / 2, rx = CARD_X + CARD_W / 2 + PEEK_DX - pw / 2, pr = CARD_R * PEEK_PCT / 100;
    // The tab t's neighbours in the page order: the Notices card (HOME_NOTICES) comes before tab 0.
    const int prev = t == HOME_NOTICES ? HOME_NONE : t > 0 ? t - 1 : pod_notice_count(m) > 0 ? HOME_NOTICES : HOME_NONE;
    const int next = t + 1 < m->tab_count ? t + 1 : HOME_NONE;
    if (prev == HOME_NOTICES) notices_card(f, m, lx, py, pw, ph, pr, PEEK_FADE, false);
    else if (prev >= 0) card(f, m, prev, lx, py, pw, ph, pr, PEEK_FADE, false, now_ms);
    if (next >= 0) card(f, m, next, rx, py, pw, ph, pr, PEEK_FADE, false, now_ms);
    if (t == HOME_NOTICES) {
        notices_card(f, m, CARD_X, CARD_Y, CARD_W, CARD_H, CARD_R, 0, true);
        pod_hit_add(f, CARD_X, CARD_Y, CARD_W, CARD_H, POD_A_INBOX, 0);
        return;
    }
    card(f, m, t, CARD_X, CARD_Y, CARD_W, CARD_H, CARD_R, 0, true, now_ms);
    if (tab_agents(m, t, NULL) > 0) pod_hit_add_id(f, CARD_X, CARD_Y, CARD_W, CARD_H, POD_A_ENTER_TAB, t, m->tabs[t].id);
}
