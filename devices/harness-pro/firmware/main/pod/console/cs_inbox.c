// Console Inbox (mockup screen 09, .ib* in style4.css): readable rows (44 px logo, 32 px name, up to three 27 px message lines) under the group headings NEEDS YOU (agents asking),
// FINISHED (unread finished entries) and FAILED (agents whose last turn failed, and unread failures). An empty group has no
// heading. Unread rows have a violet rule on the left; the rest are dimmed. A drag scrolls by rows (their heights vary with
// the wrapped message; the scroll limit is the first row from which the rest fits).
// A tap on a row registers POD_A_OPEN_NOTIF with the agent id (the glue resolves it against model->unread); rows with no
// unread entry (asking, failed agents) register POD_A_FOLLOW, which the glue resolves to an index in model->agents.
#include <stdio.h>
#include <string.h>

#include "pod/console/cs.h"
#include "pod/pod_view_shared.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)
enum { PADX = 24, LOGO = 44, TEXT_X = PADX + LOGO + 16, HEAD_H = 44, TOP = CS_BAR_H + 2, MAX_ITEMS = 40, ROW_RUNS = 12, BUDGET = 184,
       LINE_H = 34, LINES_MAX = 3, ROW_PAD_TOP = 14, NAME_H = 36, MSG_GAP = 6, ROW_PAD_BOT = 16, PITCH = 108,
       AVAIL = POD_W - CS_FOOT_H - TOP };

typedef struct { char group; const pod_agent_t *a; const pod_unread_t *u; int unread_index; } item_t;   // group: 0 NEEDS YOU, 1 FINISHED, 2 FAILED

static int collect(const pod_model_t *m, item_t out[MAX_ITEMS])
{
    int n = 0;
    for (int i = 0; i < m->agent_count && n < MAX_ITEMS; i++)
        if (pod_model_eff(m, &m->agents[i]) == POD_ASKING) out[n++] = (item_t){0, &m->agents[i], NULL, -1};
    for (int i = 0; i < m->unread_count && n < MAX_ITEMS; i++)
        if (m->unread[i].kind == POD_UNREAD_FINISHED) out[n++] = (item_t){1, pod_model_find(m, m->unread[i].agent), &m->unread[i], i};
    for (int i = 0; i < m->agent_count && n < MAX_ITEMS; i++) {
        const pod_agent_t *a = &m->agents[i];
        if (!a->failed || pod_model_eff(m, a) == POD_ASKING || pod_model_eff(m, a) == POD_WORKING) continue;
        int ui = -1;   // its unread FAILED entry rides on the row: a tap marks it read
        for (int k = 0; k < m->unread_count && ui < 0; k++)
            if (m->unread[k].kind == POD_UNREAD_FAILED && !strcmp(m->unread[k].agent, a->id)) ui = k;
        out[n++] = (item_t){2, a, ui >= 0 ? &m->unread[ui] : NULL, ui};
    }
    for (int i = 0; i < m->unread_count && n < MAX_ITEMS; i++) {
        const pod_agent_t *a = pod_model_find(m, m->unread[i].agent);
        if (m->unread[i].kind == POD_UNREAD_FAILED && !(a && a->failed)) out[n++] = (item_t){2, a, &m->unread[i], i};
    }
    return n;
}

int cs_inbox_pitch(void) { return PITCH; }

// The text under the name: the question, the entry's text, or what the failed agent last did; newlines read as spaces.
static void one_line(char *out, size_t cap, const char *text)
{
    snprintf(out, cap, "%s", text);
    pod_utf8_trim(out);
    for (char *c = out; *c; c++) if (*c == '\n' || *c == '\r' || *c == '\t') *c = ' ';
}
static void line_of(const item_t *it, char *line, size_t cap)
{
    if (it->group == 0) one_line(line, cap, it->a->question);
    else if (it->u) one_line(line, cap, it->u->text);
    else one_line(line, cap, it->a && it->a->activity[0] ? it->a->activity : "The last turn failed");
}
// The message wrapped to at most three lines; a longer one ends its third line with "...".
static int wrap3(const char *text, char rows[LINES_MAX][POD_ROW_MAX])
{
    const int w = POD_W - PADX - TEXT_X;
    int n = pod_wrap(text, &cs_rg_27, w, LINES_MAX, rows);
    if (n == LINES_MAX && ht_pro_width(&cs_rg_27, rows[n - 1]) > w) {
        char *r = rows[n - 1];
        size_t len = strlen(r);
        for (;;) {
            char t[POD_ROW_MAX + 4];
            snprintf(t, sizeof t, "%s...", r);
            if (ht_pro_width(&cs_rg_27, t) <= w || len == 0) { snprintf(r, POD_ROW_MAX, "%s", t); break; }
            do { len--; } while (len && ((unsigned char)r[len] & 0xc0) == 0x80);
            r[len] = 0;
            while (len && r[len - 1] == ' ') r[--len] = 0;
        }
    }
    return n;
}
static int row_h(const item_t *it)
{
    char line[POD_UNREAD_TEXT], rows[LINES_MAX][POD_ROW_MAX];
    line_of(it, line, sizeof line);
    int n = wrap3(line, rows);
    return ROW_PAD_TOP + NAME_H + (n ? MSG_GAP + n * LINE_H : 0) + ROW_PAD_BOT + 1;
}

// The scroll limit: the first row from which the rest of the list fits above the bottom margin, so the last row can be reached.
int cs_inbox_max_row(const pod_model_t *m)
{
    item_t it[MAX_ITEMS];
    int n = collect(m, it), h[MAX_ITEMS];
    for (int i = 0; i < n; i++) h[i] = row_h(&it[i]) + (i == 0 || it[i].group != it[i - 1].group ? HEAD_H : 0);
    for (int first = 0; first < n; first++) {
        int used = first > 0 && it[first].group == it[first - 1].group ? HEAD_H : 0;   // the top row always shows its heading
        for (int i = first; i < n; i++) used += h[i];
        if (used <= AVAIL) return first;
    }
    return n > 0 ? n - 1 : 0;
}

static unsigned mix(unsigned rgb, int pct)   // over the ground, pre-mixed: no alpha
{
    unsigned out = 0;
    for (int sh = 0; sh <= 16; sh += 8) {
        unsigned c = (rgb >> sh) & 0xff, g = (CS_GROUND >> sh) & 0xff;
        out |= ((g * (100 - pct) + c * pct) / 100) << sh;
    }
    return out;
}

static int row(pod_out_frame_t *f, const pod_model_t *m, const item_t *it, int y)
{
    ht_scene_t *s = f->scene;
    const pod_agent_t *a = it->a;
    const bool unread = it->group != 2 || it->u;
    const int dim = unread ? 100 : 62, h = row_h(it), right = POD_W - PADX;
    const char *name = a && a->name[0] ? a->name : it->u && it->u->name[0] ? it->u->name : "Agent";
    char line[POD_UNREAD_TEXT], rows[LINES_MAX][POD_ROW_MAX], age[8];
    line_of(it, line, sizeof line);
    int n = wrap3(line, rows);
    unsigned lc = it->group == 0 ? CS_ASK : it->group == 2 ? CS_FAIL : CS_INK2;
    if (it->u) {
        int32_t d = (int32_t)(m->clock_ms - it->u->at_ms);
        pod_fmt_age(age, sizeof age, d > 0 ? (uint32_t)d / 1000 : 0);
    } else pod_fmt_age(age, sizeof age, a ? cs_age_s(m, a) : 0);
    if (unread) ht_pro_rect(s, 0, y, 4, h - 1, 0, C(CS_FOCUS));
    cs_logo(s, PADX, y + ROW_PAD_TOP + 4, LOGO, a ? a->engine : NULL);
    const int cy = y + ROW_PAD_TOP + NAME_H / 2, aw = ht_pro_width(&cs_mono_22, age);
    cs_text(s, right - aw, cy, aw + 2, &cs_mono_22, mix(CS_DIM, dim), age);
    int x = TEXT_X;
    cs_dot(s, x + 6, cy, it->group == 0 ? 'q' : it->group == 2 ? 'r' : 'd', 0);
    x += 22;
    const int avail = right - aw - 16 - x;
    int nw = ht_pro_width(&cs_sb_32, name);
    if (nw > avail * 3 / 5) nw = avail * 3 / 5;
    cs_text(s, x, cy, nw, &cs_sb_32, mix(CS_INK, dim), name);
    const pod_tab_t *tab = a ? pod_tab_of(m, a) : NULL;
    if (tab && avail - nw - 10 > 20) cs_text(s, x + nw + 10, cy, avail - nw - 10, &cs_rg_22, mix(CS_DIM, dim), tab->name);
    for (int i = 0; i < n; i++)
        cs_text(s, TEXT_X, y + ROW_PAD_TOP + NAME_H + MSG_GAP + LINE_H / 2 + i * LINE_H, right - TEXT_X, &cs_rg_27, mix(lc, dim), rows[i]);
    ht_pro_rect(s, 0, y + h - 1, POD_W, 1, 0, C(CS_RAISED));
    // A row with an unread entry marks it read (OPEN_NOTIF); asking and failed agents have none: FOLLOW opens them by id.
    if (it->u) pod_hit_add_id(f, 0, y, POD_W, h, POD_A_OPEN_NOTIF, it->unread_index, it->u->agent);
    else pod_hit_add_id(f, 0, y, POD_W, h, POD_A_FOLLOW, (int)(a - m->agents), a->id);
    return h;
}

void cs_view_inbox(pod_out_frame_t *f, const pod_nav_t *nav, pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    int running, asking;
    cs_counts(m, &running, &asking);
    const char *const crumbs[] = {"Inbox"};
    cs_bar(f, crumbs, 1, running, asking, 0, NULL, now_ms);
    item_t it[MAX_ITEMS];
    int n = collect(m, it);
    if (n == 0) {
        const char *msg = "No notifications";
        int w = ht_pro_width(&cs_rg_24, msg);
        cs_text(s, (POD_W - w) / 2, POD_W / 2, w + 2, &cs_rg_24, CS_MUTED, msg);
        return;
    }
    static const char *const title[] = {"NEEDS YOU", "FINISHED", "FAILED"};
    int count[3] = {0, 0, 0};
    for (int i = 0; i < n; i++) count[(int)it[i].group]++;
    const pod_frame_t *fr = &nav->stack[nav->depth - 1];
    int max = cs_inbox_max_row(m);
    int first = fr->scroll < 0 ? 0 : fr->scroll > max ? max : fr->scroll, y = TOP, prev = -1;
    for (int i = first; i < n; i++) {
        int need = (it[i].group != prev ? HEAD_H : 0) + row_h(&it[i]);
        if (y + need > POD_W - CS_FOOT_H || cs_runs(f) + ROW_RUNS + 2 > BUDGET) break;
        if (it[i].group != prev) {
            char c[8];
            snprintf(c, sizeof c, "%d", count[(int)it[i].group]);
            cs_text(s, PADX, y + 16 + 11, ht_pro_width(&cs_mono_18, title[(int)it[i].group]) + 2, &cs_mono_18, CS_DIM, title[(int)it[i].group]);
            int cw = ht_pro_width(&cs_mono_18, c);
            cs_text(s, POD_W - PADX - cw, y + 16 + 11, cw + 2, &cs_mono_18, CS_MUTED, c);
            y += HEAD_H;
            prev = it[i].group;
        }
        y += row(f, m, &it[i], y);
    }
}
