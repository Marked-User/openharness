// The Tabs screen (Classic Index): a 3 x 2 grid of 164 px covers between the bar and the footer. Each cover wears its
// tab's panes as pale minis (one pane fills it, two or more split into two columns, a mark in each, a dot on a working or
// asking one); the first cover is Recent (up to 8 minis, 4 x 2); an empty tab is grey with a grid icon. A cover whose
// agents are working wears a ribbon at its foot (eq, "Working", the count). The window's selected tab is ringed in blue
// with its name blue. Under each cover: the name, then "7 agents" / "2 panes" / "Empty".
// Two rows of covers a page; more than six covers page (the frame's scroll is the first row of the page, so always even).
// While the finger drags, or the page settles after the release, the glue gives the pixel offset (f->tabs_off) and the grid
// is drawn where it is, the bar and the footer drawn last over whatever has scrolled under them.
//
// The ribbon's eq moves with the clock, so the glue wakes the screen every POD_TABS_BAR_MS while one shows (pod_tabs_ribbon).
// When the frame is short of runs the dots go first, then the marks, then the minis, the least visible covers first (at
// rest: the last covers first) and the selected one last; only while the grid moves, as the very last resort, the ribbons.
#include "pod/classic/ci.h"

#include <stdio.h>
#include <string.h>

enum {
    COLS = 3, COVER = 164, COVER_R = 13, TOP_Y = 113, ROW_PITCH = 255, ROWS_PAGE = 2, PAGE_H = ROWS_PAGE * ROW_PITCH,
    HIT_W = 213, HIT_H = 240, HIT_DX = 24,         // a card's hit: the column, from the row's top to its count line
    NAME_MID = 26, COUNT_MID = 57,                 // the name and count centres below the art's foot
    RING = 5, RING_GAP = 5,
    PAD = 13, GAP = 6, CELLS_MAX = 8,
    RIB_H = 31, RIB_ROUND = 26, RIB_PAD = 9,
    SHOWN_MAX = 4 * COLS,                          // two partial pages: four rows meet the glass
    BAR_RUNS = 12, FOOT_RUNS = 6,                  // the bar (bell and pill included) and the footer, drawn last
    D_DOT = 1, D_MARK = 2, D_BARE = 4, D_NORIB = 8, D_FULL = D_DOT | D_MARK,
    GLASS_TOP = CI_BAR_H + 1, GLASS_BOT = CI_FOOT_Y
};
static const int col_x[COLS] = {52, 278, 505};   // the art's left edges (the card is centred in its 213 px column)

#define MINI 0xf8faf7
#define DOT_WORK 0x35734f
#define DOT_ASK 0xbf861e
#define RIB_INK 0x172f39
#define RIB_EQ 0xa6e0b5

static uint16_t C(unsigned rgb) { return ht_rgb(rgb); }
static int imin(int a, int b) { return a < b ? a : b; }
static int imax(int a, int b) { return a > b ? a : b; }

// The cover colours by tab order (Recent has its own).
static const unsigned palette[][2] = {
    {0x9389c7, 0x584d8e},   // purple
    {0xd99191, 0x995471},   // rose
    {0x80b5a1, 0x477e70},   // green
    {0xd6aa6b, 0xa3733d},   // ochre
    {0x83a1c8, 0x456990},   // slate
};
enum { PALETTE_N = sizeof palette / sizeof palette[0] };

static unsigned mix(unsigned a, unsigned b, int pct)   // a toward b, in percent
{
    unsigned out = 0;
    for (int sh = 16; sh >= 0; sh -= 8) {
        int ca = (int)((a >> sh) & 255), cb = (int)((b >> sh) & 255);
        out |= (unsigned)(ca + (cb - ca) * pct / 100) << sh;
    }
    return out;
}
// Cover c: 0 is Recent, i + 1 is tab i.
static unsigned cover_top(int c) { return c > 0 ? palette[(c - 1) % PALETTE_N][0] : 0x5d8dda; }
static unsigned cover_bottom(int c) { return c > 0 ? palette[(c - 1) % PALETTE_N][1] : 0x2859aa; }
static unsigned cover_at(int c, int pct) { return mix(cover_top(c), cover_bottom(c), pct); }
static bool cover_empty(const pod_model_t *m, int c) { return c > 0 && pod_tab_panes(&m->tabs[c - 1]) == 0; }
static int chosen_cover(const pod_model_t *m)   // the window's selected tab, or -1
{
    return m->tab_count && m->selected < m->tab_count ? m->selected + 1 : -1;
}

int pod_tabs_pitch(void) { return PAGE_H; }
int pod_tabs_pages(const pod_model_t *m)
{
    int rows = (1 + m->tab_count + COLS - 1) / COLS;
    return imax(1, (rows + ROWS_PAGE - 1) / ROWS_PAGE);
}
int pod_tabs_max_row(const pod_model_t *m) { return (pod_tabs_pages(m) - 1) * ROWS_PAGE; }

// What a cover says under its name.
typedef struct { char name[CABLE_NAME_MAX + 4], count[24]; int working; } caption_t;   // working: agents at work (the ribbon)
static void caption(const pod_model_t *m, int c, caption_t *cap)
{
    memset(cap, 0, sizeof *cap);
    int w = 0;
    if (c == 0) {
        const pod_agent_t *l[POD_RECENT_MAX];
        int n = pod_model_recent(m, l, POD_RECENT_MAX);
        for (int i = 0; i < n; i++) if (pod_model_eff(m, l[i]) == POD_WORKING) w++;
        snprintf(cap->name, sizeof cap->name, "Recent");
        snprintf(cap->count, sizeof cap->count, "%d agent%s", n, n == 1 ? "" : "s");
    } else {
        const pod_tab_t *t = &m->tabs[c - 1];
        int n = pod_tab_panes(t);
        pod_tab_counts(m, t, &w, NULL);
        snprintf(cap->name, sizeof cap->name, "%s", t->name);
        if (n == 0) snprintf(cap->count, sizeof cap->count, "Empty");
        else snprintf(cap->count, sizeof cap->count, "%d pane%s", n, n == 1 ? "" : "s");
    }
    cap->working = w;
}

// Does a ribbon show on the resting page `page`? The glue wakes at POD_TABS_BAR_MS while one does.
bool pod_tabs_ribbon(const pod_model_t *m, int page)
{
    int covers = 1 + m->tab_count;
    for (int c = page * ROWS_PAGE * COLS; c < covers && c < (page + 1) * ROWS_PAGE * COLS; c++) {
        caption_t cap;
        caption(m, c, &cap);
        if (cap.working > 0) return true;
    }
    return false;
}

// ---- a cover's content ------------------------------------------------------------------------------------

// Cell i of n along `len` px from `at`, `gap` between cells.
static void cell(int at, int len, int gap, int n, int i, int *pos, int *size)
{
    int room = len - (n - 1) * gap;
    int a = at + i * gap + room * i / n, b = at + i * gap + room * (i + 1) / n;
    *pos = a; *size = b - a;
}
typedef struct { int x, y, w, h; } box_t;
// The minis of a tab's `n` panes, relative to the cover: one fills it, more are two columns; past 8 the eighth is "+N".
static int tab_cells(int n, box_t out[CELLS_MAX])
{
    int cells = imin(n, CELLS_MAX), cols = n == 1 ? 1 : 2, rows = (cells + cols - 1) / cols, iw = COVER - 2 * PAD;
    for (int i = 0; i < cells; i++) {
        box_t *b = &out[i];
        cell(PAD, iw, GAP, cols, i % cols, &b->x, &b->w);
        cell(PAD, iw, GAP, rows, i / cols, &b->y, &b->h);
    }
    return cells;
}
// Recent's minis: 4 x 2, tall and thin, clear of the ribbon.
static void recent_cell(int i, box_t *b)
{
    const int gap = 4, w = (COVER - 2 * PAD - 3 * gap) / 4, h = (COVER - PAD - 27 - gap) / 2;
    *b = (box_t){PAD + (i % 4) * (w + gap), PAD + (i / 4) * (h + gap), w, h};
}
static const pod_agent_t *pane_agent(const pod_model_t *m, const pod_tab_t *t, int k)
{
    if (!t->members_known || k >= t->count || k >= POD_PANES_MAX) return NULL;
    int i = t->agent[k];
    return i >= 0 && i < m->agent_count ? &m->agents[i] : NULL;
}

// One mini at (x, y) in cover c: a pale card (half faded into the cover when its agent is offline), the mark centred (the
// 44 px logo, or 28 where it is smaller; none where neither fits) and the state dot top right.
static void draw_mini(ht_scene_t *s, const pod_model_t *m, int c, int x, int y, const box_t *b, const pod_agent_t *a, int r, int detail)
{
    pod_state_t st = a ? pod_model_eff(m, a) : POD_IDLE;
    bool off = st == POD_OFFLINE;
    int bx = x + b->x, by = y + b->y;
    unsigned fill = off ? mix(MINI, cover_at(c, (b->y + b->h / 2) * 100 / COVER), 50) : MINI;
    ht_pro_rect_aa(s, bx, by, b->w, b->h, r, C(fill));
    int side = imin(b->w, b->h), size = side >= 46 ? 44 : side >= 30 ? 28 : 0;
    if ((detail & D_MARK) && size) {
        const char *eng = a ? a->engine : NULL;
        const pod_mark_t *mk = pod_mark(eng);
        int lx = bx + (b->w - size) / 2, ly = by + (b->h - size) / 2;
        if (!mk) {   // an unknown member or engine: the default mark
            pod_mark_default_big(s, lx, ly, size, C(fill));
        } else {
            if (mk->light) ht_pro_rect(s, lx, ly, size, size, size / 5, C(off ? 0xb8bab8 : 0x1d1e23));
            if (off) pod_logo_draw_faded(s, lx, ly, size, eng, 128);
            else pod_logo_draw(s, lx, ly, size, eng);
        }
    }
    if ((detail & D_DOT) && (st == POD_WORKING || st == POD_ASKING)) {
        int d = r <= 3 ? 8 : b->h >= 45 ? 13 : 9, o = r <= 3 ? 2 : 5;
        ht_pro_rect_aa(s, bx + b->w - o - d, by + o, d, d, d / 2, C(st == POD_WORKING ? DOT_WORK : DOT_ASK));
    }
}

// The grid icon of an empty tab: four outlined squares, 72 px across.
static void draw_grid_icon(ht_scene_t *s, int x, int y)
{
    const int box = 72, sq = 21, st = 3;
    int ox = x + (COVER - box) / 2, oy = y + (COVER - box) / 2;
    for (int i = 0; i < 4; i++) {
        int sx = ox + (i % 2 ? 42 : 9), sy = oy + (i / 2 ? 42 : 9);
        unsigned ground = mix(0xdce2d7, 0xbfcbbd, (sy + sq / 2 - y) * 100 / COVER);
        unsigned line = mix(ground, 0xf8faf5, 85);
        ht_pro_rect_aa(s, sx, sy, sq, sq, 3, C(line));
        ht_pro_rect_aa(s, sx + st, sy + st, sq - 2 * st, sq - 2 * st, 1, C(ground));
    }
}

// The working ribbon on the cover's foot: eq on the left, "Working" between, the count on the right.
static void draw_ribbon(ht_scene_t *s, int c, int x, int y, int working, uint32_t now_ms)
{
    uint16_t band = C(mix(cover_at(c, 93), RIB_INK, 79));
    int by = y + COVER - RIB_H, mid = by + RIB_H / 2;
    ht_pro_rect_aa(s, x, y + COVER - RIB_ROUND, COVER, RIB_ROUND, COVER_R, band);
    ht_pro_rect(s, x, by, COVER, RIB_H - COVER_R, 0, band);
    char n[8];
    snprintf(n, sizeof n, "%d", working);
    int cw = ht_pro_width(&ci_rg_20, n), tw = ht_pro_width(&ci_rg_20, "Working"), eq = 23;
    int gap = imax(4, (COVER - 2 * RIB_PAD - eq - tw - cw) / 2);
    pod_eq(s, x + RIB_PAD, mid - 10, C(RIB_EQ), now_ms);
    ht_pro_text(s, x + RIB_PAD + eq + gap, mid - ci_rg_20.height / 2, tw, &ci_rg_20, C(0xffffff), "Working");
    ht_pro_text(s, x + COVER - RIB_PAD - cw, mid - ci_rg_20.height / 2, cw, &ci_rg_20, C(0xffffff), n);
}

// The cover at (x, y): its gradient, its minis (or the grid icon), the ribbon.
static void draw_cover(ht_scene_t *s, const pod_model_t *m, int c, int x, int y, int working, int detail, uint32_t now_ms)
{
    if (cover_empty(m, c)) {
        pod_grad_aa(s, x, y, COVER, COVER, COVER_R, C(0xdce2d7), C(0xbfcbbd));
        draw_grid_icon(s, x, y);
        return;
    }
    pod_grad_aa(s, x, y, COVER, COVER, COVER_R, C(cover_top(c)), C(cover_bottom(c)));
    if (!(detail & D_BARE)) {
        box_t b[CELLS_MAX];
        if (c == 0) {
            const pod_agent_t *l[POD_RECENT_MAX];
            int n = pod_model_recent(m, l, POD_RECENT_MAX);
            for (int i = 0; i < n; i++) { recent_cell(i, &b[0]); draw_mini(s, m, c, x, y, &b[0], l[i], 3, detail); }
        } else {
            const pod_tab_t *t = &m->tabs[c - 1];
            int real = t->count ? t->count : t->panes, cells = tab_cells(real, b), shown = real > CELLS_MAX ? cells - 1 : cells;
            for (int k = 0; k < shown; k++) draw_mini(s, m, c, x, y, &b[k], pane_agent(m, t, k), 6, detail);
            if (real > CELLS_MAX) {   // the last cell: the rest, as a count
                char more[12];
                snprintf(more, sizeof more, "+%d", real - shown);
                int w = ht_pro_width(&ci_rg_20, more);
                ht_pro_rect_aa(s, x + b[shown].x, y + b[shown].y, b[shown].w, b[shown].h, 6, C(MINI));
                ht_pro_text(s, x + b[shown].x + (b[shown].w - w) / 2, y + b[shown].y + (b[shown].h - ci_rg_20.height) / 2, w, &ci_rg_20, CI_INK, more);
            }
        }
    }
    if (working > 0 && !(detail & D_NORIB)) draw_ribbon(s, c, x, y, working, now_ms);
}
// What draw_cover adds to the scene at `detail`: drawn and taken back.
static int cover_cost(ht_scene_t *s, const pod_model_t *m, int c, int working, int detail)
{
    int n0 = s->count;
    draw_cover(s, m, c, 0, 0, working, detail, 0);
    int n = s->count - n0;
    s->count = (uint8_t)n0;
    return n;
}

typedef struct { int c, x, y, vis, detail, cost; caption_t cap; } slot_t;

void pod_view_tabs(pod_out_frame_t *f, const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    s->background = CI_GROUND;
    const pod_agent_t *wl[POD_AGENTS_MAX];
    int wn = pod_model_working(m, wl, POD_AGENTS_MAX);

    int covers = 1 + m->tab_count, sel = chosen_cover(m), pages = pod_tabs_pages(m);
    int rows = (covers + COLS - 1) / COLS;
    int page = nav->depth ? nav->stack[0].scroll / ROWS_PAGE : 0;
    page = imax(0, imin(page, pages - 1));
    int off = page * PAGE_H;
    bool moving = false;
    if (f->tabs_moving && pages > 1) {
        off = imax(-PAGE_H / 2, imin(f->tabs_off, (pages - 1) * PAGE_H + PAGE_H / 2));
        if (off % PAGE_H == 0) page = off / PAGE_H;   // exactly on a page: the resting screen
        else moving = true;
    }

    // The covers that meet the glass: at rest the page's two rows, in motion every row that shows.
    slot_t sl[SHOWN_MAX];
    int n = 0;
    for (int r = moving ? 0 : page * ROWS_PAGE; r < rows && r < (moving ? rows : (page + 1) * ROWS_PAGE); r++) {
        int y = TOP_Y + r * ROW_PITCH - off;
        if (moving && (y + HIT_H <= GLASS_TOP || y - RING - RING_GAP >= GLASS_BOT)) continue;
        for (int k = 0; k < COLS && r * COLS + k < covers && n < SHOWN_MAX; k++) {
            slot_t *e = &sl[n++];
            e->c = r * COLS + k;
            e->x = col_x[k];
            e->y = y;
            e->vis = imax(0, imin(y + COVER, GLASS_BOT) - imax(y, GLASS_TOP));
            e->detail = D_FULL;
            caption(m, e->c, &e->cap);
            e->cost = cover_cost(s, m, e->c, e->cap.working, e->detail);
        }
    }

    // What fits: the dots go first, then the marks, then the minis; the least visible covers first (at rest the last ones),
    // and the selected one last; only in motion, the ribbons.
    int base = s->count + BAR_RUNS + FOOT_RUNS + 4 + pod_spare_runs(f), budget = POD_CLASSIC_RUNS;   // 4: the notice
    for (int i = 0; i < n; i++) base += 2 + (sl[i].c == sel ? 2 : 0);   // the captions; the ring
    static const int stage[4] = {D_DOT, D_MARK, D_BARE, D_NORIB};
    for (int st = 0; st < (moving ? 4 : 3); st++)
        for (int pass = 0; pass < 2; pass++)
            for (;;) {
                int total = base;
                for (int k = 0; k < n; k++) total += sl[k].cost;
                if (total <= budget) goto fitted;
                int pick = -1;
                for (int i = 0; i < n; i++) {
                    int d = sl[i].detail;
                    bool has = st == 3 ? sl[i].cap.working > 0 && !(d & D_NORIB) : st == 2 ? !(d & D_BARE) : (d & stage[st]) != 0;
                    if (!has || (sl[i].c == sel) != (pass == 1)) continue;
                    if (pick < 0 || sl[i].vis <= sl[pick].vis) pick = i;
                }
                if (pick < 0) break;
                if (st >= 2) sl[pick].detail |= stage[st]; else sl[pick].detail &= ~stage[st];
                sl[pick].cost = cover_cost(s, m, sl[pick].c, sl[pick].cap.working, sl[pick].detail);
            }
fitted:

    for (int i = 0; i < n; i++) {
        const slot_t *e = &sl[i];
        int c = e->c, x = e->x, y = e->y;
        bool on = c == sel, cover_on = y + COVER + RING + RING_GAP > GLASS_TOP && y - RING - RING_GAP < GLASS_BOT;   // in motion a cover can be off the glass with its caption on
        if (on && cover_on) {   // a 5 px blue ring with a 5 px gap, over the ground
            int o = RING + RING_GAP, w = COVER + 2 * o;
            ht_pro_rect_aa(s, x - o, y - o, w, w, COVER_R + o, CI_BLUE);
            ht_pro_rect_aa(s, x - RING_GAP, y - RING_GAP, COVER + 2 * RING_GAP, COVER + 2 * RING_GAP, COVER_R + RING_GAP, CI_GROUND);
        }
        if (cover_on) draw_cover(s, m, c, x, y, e->cap.working, e->detail, now_ms);
        int ny = y + COVER + NAME_MID - ci_rg_30.height / 2, ly = y + COVER + COUNT_MID - ci_rg_23.height / 2;
        const caption_t *cap = &e->cap;
        if (ny + ci_rg_30.height > GLASS_TOP && ny < GLASS_BOT)
            ci_text(s, x, ny, COVER, &ci_rg_30, on ? CI_BLUE : CI_INK, cap->name);
        if (ly + ci_rg_23.height > GLASS_TOP && ly < GLASS_BOT)
            ci_text(s, x, ly, COVER, &ci_rg_23, CI_MUTED, cap->count);
        int hx = x - HIT_DX, hy = imax(y, GLASS_TOP), hb = imin(y + HIT_H, GLASS_BOT);   // the part of the card on the glass
        if (hb - hy >= 40)
            pod_hit_add_id(f, hx, hy, HIT_W, hb - hy, POD_A_OPEN_TAB, c ? c - 1 : POD_TAB_RECENT, c ? m->tabs[c - 1].id : "");
    }

    // The footer, then the bar, last: what has scrolled under them is covered.
    char left[24], right[40];
    snprintf(left, sizeof left, "%d working", wn);
    if (pages > 1) {
        int cur = imax(0, imin(pages - 1, (off + PAGE_H / 2) / PAGE_H));
        snprintf(right, sizeof right, "PAGE %d / %d", cur + 1, pages);
    } else {
        snprintf(right, sizeof right, "%d TAB%s \xc2\xb7 %d AGENT%s", m->tab_count, m->tab_count == 1 ? "" : "S", m->agent_count, m->agent_count == 1 ? "" : "S");
    }
    ci_foot(s, left, false, right);
    ci_bar(f, "Tabs", NULL, f->unread, true);
}
