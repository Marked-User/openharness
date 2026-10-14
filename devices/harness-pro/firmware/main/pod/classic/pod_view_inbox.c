// The Classic Inbox (Index look, spec 2026-10-13): "N unread." and the agents that ask first (an amber row that stays until
// they are answered, a FOLLOW hit), then the unread entries (a blue dot, the name, two lines of the recap, New or Failed, an
// OPEN_NOTIF hit). And the result banner, a card under the bar when a turn ends, with a close x and a timer line.
#include "pod/classic/ci.h"

#include <stdio.h>
#include <string.h>

enum { ROWS_Y = 234, ASK_H = 111, ENTRY_MIN = 104, ENTRY_BASE = 81, LINE_PITCH = 31, TEXT_X = 59, TEXT_W = 540, ENTRY_LINES = 2,
       ROW_RUNS_ASK = 15, ROW_RUNS_ENTRY = 6, FOOT_RUNS = 4, ROWS_MAX = POD_AGENTS_MAX + POD_UNREAD_MAX };

static uint16_t C(unsigned rgb) { return ht_rgb(rgb); }
static int imax(int a, int b) { return a > b ? a : b; }
static int imin(int a, int b) { return a < b ? a : b; }

void pod_fmt_age(char *out, size_t n, uint32_t secs)
{
    if (secs < 60) snprintf(out, n, "now");
    else if (secs < 3600) snprintf(out, n, "%um", (unsigned)(secs / 60));
    else if (secs < 86400) snprintf(out, n, "%uh", (unsigned)(secs / 3600));
    else snprintf(out, n, "%ud", (unsigned)(secs / 86400));
}
// Name and engine: the roster's when it knows the agent, else what the notification carried.
static const char *name_of(const pod_model_t *m, const pod_unread_t *u)
{
    const pod_agent_t *a = pod_model_find(m, u->agent);
    return a && a->name[0] ? a->name : u->name[0] ? u->name : "Agent";
}
static const char *engine_of(const pod_model_t *m, const pod_unread_t *u)
{
    const pod_agent_t *a = pod_model_find(m, u->agent);
    return a ? a->engine : NULL;
}
static void one_line(char *out, size_t cap, const char *text)
{
    snprintf(out, cap, "%s", text);
    pod_utf8_trim(out);
    for (char *c = out; *c; c++) if (*c == '\n' || *c == '\r' || *c == '\t') *c = ' ';
}

// ---- the list: asking agents, then the unread entries -----------------------------------------------------

static int asking_count(const pod_model_t *m)
{
    int n = 0;
    for (int i = 0; i < m->agent_count; i++) if (pod_model_eff(m, &m->agents[i]) == POD_ASKING) n++;
    return n;
}
static const pod_agent_t *asking_at(const pod_model_t *m, int k)
{
    for (int i = 0; i < m->agent_count; i++)
        if (pod_model_eff(m, &m->agents[i]) == POD_ASKING && k-- == 0) return &m->agents[i];
    return NULL;
}

// An entry's recap, wrapped to two lines; returns the lines.
static int entry_lines(const pod_unread_t *u, char rows[ENTRY_LINES][POD_ROW_MAX])
{
    char line[POD_UNREAD_TEXT];
    one_line(line, sizeof line, u->text);
    return line[0] ? ci_wrap(line, &ci_rg_23, TEXT_W, ENTRY_LINES, rows) : 0;
}
static int entry_h(int lines) { return imax(ENTRY_MIN, ENTRY_BASE + lines * LINE_PITCH); }
// Every row's height (the pitch to the next, rule included), each recap wrapped once: h[i] for the n rows.
static void row_heights(const pod_model_t *m, int na, int n, int h[ROWS_MAX])
{
    char rows[ENTRY_LINES][POD_ROW_MAX];
    for (int i = 0; i < n; i++) h[i] = i < na ? ASK_H : entry_h(entry_lines(&m->unread[i - na], rows));
}
// The rows from `first` that fit above the footer; a row needs its height less the rule and a few px the footer may cover.
static int rows_shown(const int *h, int first, int n)
{
    int y = ROWS_Y, shown = 0;
    for (int i = first; i < n; i++) {
        if (y + h[i] - 4 > CI_FOOT_Y) break;
        y += h[i];
        shown++;
    }
    return shown;
}

// The first row from which the rest of the list fits.
static int max_row_of(const int *h, int n)
{
    for (int first = 0; first < n; first++)
        if (first + rows_shown(h, first, n) >= n) return first;
    return 0;
}
int pod_inbox_pitch(void) { return entry_h(ENTRY_LINES); }
int pod_inbox_max_row(const pod_model_t *m)
{
    int h[ROWS_MAX], na = asking_count(m), n = na + m->unread_count;
    row_heights(m, na, n, h);
    return max_row_of(h, n);
}

static void chevron_right(ht_scene_t *s, int x, int y, uint16_t ink)   // 12 x 20, ten 2-row steps
{
    for (int k = 0; k < 10; k++) ht_pro_rect(s, x + (k < 5 ? 2 * k : 2 * (9 - k)), y + 2 * k, 3, 2, 0, ink);
}

static void row_ask(pod_out_frame_t *f, const pod_model_t *m, const pod_agent_t *a, int y0)
{
    ht_scene_t *s = f->scene;
    ht_pro_rect(s, 0, y0, POD_W, ASK_H - 1, 0, CI_ROW_ASK);
    ht_pro_rect_aa(s, CI_MARGIN, y0 + 51, 10, 10, 5, ht_rgb(0xab6b17));
    ci_text(s, 65, y0 + 15, 580, &ci_rg_33, CI_INK, a->name[0] ? a->name : "Agent");
    ci_text(s, 65, y0 + 62, 580, &ci_rg_23, CI_MUTED, "Needs your answer \xc2\xb7 stays until resolved");
    chevron_right(s, 668, y0 + 46, CI_INK);
    ht_pro_rect(s, 0, y0 + ASK_H - 1, POD_W, 1, 0, CI_RULE);
    pod_hit_add_id(f, 0, y0, POD_W, ASK_H, POD_A_FOLLOW, (int)(a - m->agents), a->id);
}

static void row_entry(pod_out_frame_t *f, const pod_model_t *m, const pod_unread_t *u, int index, int y0)
{
    ht_scene_t *s = f->scene;
    char rows[ENTRY_LINES][POD_ROW_MAX];
    int n = entry_lines(u, rows), h = entry_h(n), cy = y0 + (h - 1) / 2;
    const bool failed = u->kind == POD_UNREAD_FAILED;
    const char *tag = failed ? "Failed" : "New";
    int tw = ht_pro_width(&ci_rg_22, tag);
    ht_pro_rect_aa(s, CI_MARGIN, cy - 4, 9, 9, 4, CI_BLUE);
    ci_text(s, TEXT_X - 2, y0 + 16, TEXT_W, &ci_rg_33, CI_INK, name_of(m, u));
    for (int i = 0; i < n; i++) ci_text(s, TEXT_X - 2, y0 + 62 + i * LINE_PITCH, TEXT_W, &ci_rg_23, CI_MUTED, rows[i]);
    ht_pro_text(s, POD_W - CI_MARGIN - tw, cy - 14, tw, &ci_rg_22, failed ? CI_FAIL : CI_MUTED, tag);
    ht_pro_rect(s, 0, y0 + h - 1, POD_W, 1, 0, CI_RULE);
    pod_hit_add_id(f, 0, y0, POD_W, h, POD_A_OPEN_NOTIF, index, u->agent);
}

void pod_view_inbox(pod_out_frame_t *f, const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    (void)now_ms;
    ht_scene_t *s = f->scene;
    const pod_frame_t *fr = &nav->stack[nav->depth - 1];
    const int unread = m->unread_count, na = asking_count(m), n = na + unread;
    ci_bar(f, "Inbox", strcmp(pod_nav_origin(nav, m), "Tabs") ? pod_nav_origin(nav, m) : "Back", (uint8_t)imin(unread, 99), unread > 0);   // no bell on an empty list
    char head[16], foot[16];
    snprintf(head, sizeof head, "%d unread.", unread);
    snprintf(foot, sizeof foot, "%d unread", unread);
    ci_text(s, CI_MARGIN, 113, POD_W - 2 * CI_MARGIN, &ci_rg_48, CI_INK, head);
    ci_text(s, CI_MARGIN, 180, POD_W - 2 * CI_MARGIN, &ci_rg_24, CI_MUTED,
            n ? "Open a result to mark that result read." : "Results from your agents appear here.");
    int h[ROWS_MAX];
    row_heights(m, na, n, h);
    int first = imax(0, imin(fr->scroll, max_row_of(h, n)));
    int shown = rows_shown(h, first, n);
    int budget = POD_CLASSIC_RUNS - s->count - 4 - pod_spare_runs(f) - FOOT_RUNS;
    int y = ROWS_Y;
    for (int i = first; i < first + shown; i++) {
        int need = i < na ? ROW_RUNS_ASK : ROW_RUNS_ENTRY;
        if (need > budget) break;
        budget -= need;
        if (i < na) row_ask(f, m, asking_at(m, i), y);
        else row_entry(f, m, &m->unread[i - na], i - na, y);
        y += h[i];
    }
    ci_foot(s, foot, true, NULL);
}

// ---- the banner ----------------------------------------------------------------------------------------------

// "0m 48s", "14m 02s", "1h 02m".
static void fmt_elapsed(char *out, size_t n, int32_t secs)
{
    if (secs < 3600) snprintf(out, n, "%dm %02ds", (int)(secs / 60), (int)(secs % 60));
    else snprintf(out, n, "%dh %02dm", (int)(secs / 3600), (int)(secs % 3600 / 60));
}

int pod_banner(pod_out_frame_t *f, const pod_model_t *m, const pod_unread_t *u, uint32_t shown_ms, uint32_t now_ms)
{
    enum { TX = 112, TEXT_BW = 544, PITCH = 33, CLOSE = 65, TIMER_H = 6 };
    ht_scene_t *s = f->scene;
    const int x = POD_BANNER_X, y = POD_BANNER_Y, w = POD_BANNER_W;
    char rows[2][POD_ROW_MAX], line[POD_UNREAD_TEXT], tail[40], el[16];
    one_line(line, sizeof line, u->text);
    int n = line[0] ? ci_wrap(line, &ci_rg_24, TEXT_BW, 2, rows) : 0;
    const bool failed = u->kind == POD_UNREAD_FAILED;
    const int h = 217 - (2 - n) * PITCH;
    ht_pro_rect_aa_stroke(s, x, y, w, h, 10, C(0xa6b9a9), C(0xf7faf2));
    ci_mark(s, 39, y + 20, engine_of(m, u));
    ci_text(s, TX - 2, y + 31, 520, &ci_rg_33, CI_INK, name_of(m, u));
    int cw = ht_pro_width(&ci_rg_41, "\xc3\x97");   // the x: a multiplication sign centred on (662, y + 51)
    ht_pro_text(s, 663 - cw / 2, y + 25, cw, &ci_rg_41, C(0x53675a), "\xc3\x97");
    for (int i = 0; i < n; i++) ci_text(s, TX, y + 93 + i * PITCH, TEXT_BW, &ci_rg_24, C(0x3d4a4e), rows[i]);
    const int dy = y + 93 + n * PITCH + 7;   // the Done / Failed line's cell
    if (u->elapsed_s >= 0) {
        fmt_elapsed(el, sizeof el, u->elapsed_s);
        snprintf(tail, sizeof tail, "%s \xc2\xb7 %s", failed ? "Failed" : "Done", el);
    } else snprintf(tail, sizeof tail, "%s", failed ? "Failed" : "Done");
    if (failed) {
        ci_text(s, TX, dy, 520, &ci_rg_23, CI_FAIL, tail);
    } else {
        pod_tick(s, 114, dy + 5, CI_GREEN);
        ci_text(s, 145, dy, 480, &ci_rg_23, CI_GREEN, tail);
    }
    int32_t left = POD_BANNER_MS - (int32_t)(now_ms - shown_ms);
    int tw = left <= 0 ? 0 : left >= POD_BANNER_MS ? w : (int)((int64_t)w * left / POD_BANNER_MS);
    if (tw > 0) ht_pro_rect(s, x, y + h - 1 - TIMER_H, tw, TIMER_H, 0, CI_BLUE);
    pod_hit_add_id(f, x, y, w, h, POD_A_BANNER, 0, u->agent);
    pod_hit_add_id(f, x + w - CLOSE, y, CLOSE, CLOSE, POD_A_BANNER_CLOSE, 0, u->agent);
    return h;
}
