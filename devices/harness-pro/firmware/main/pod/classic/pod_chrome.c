// What the Pod views share: the hit list, the model helpers (names, times, a tab's counts and panes), the equaliser and
// the chevron and tick icons. The Pro fonts have no chevrons or ticks, so they are drawn as two strokes with a mitered
// joint (four POD_TRI triangles, no round caps).
#include "pod/pod_view.h"
#include "pod/classic/ci.h"
#include "pro_canvas.h"

#include <stdio.h>
#include <string.h>


bool pod_hit_add(pod_out_frame_t *f, int x, int y, int w, int h, pod_action_t action, int arg)
{
    if (f->hit_count >= 32) return false;
    f->hits[f->hit_count++] = (pod_hit_t){(int16_t)x, (int16_t)y, (int16_t)w, (int16_t)h, action, (int16_t)arg, {0}};
    return true;
}
bool pod_hit_add_id(pod_out_frame_t *f, int x, int y, int w, int h, pod_action_t action, int arg, const char *id)
{
    if (!pod_hit_add(f, x, y, w, h, action, arg)) return false;
    pod_copy_str(f->hits[f->hit_count - 1].id, sizeof f->hits[0].id, id);
    return true;
}

// ---- small helpers --------------------------------------------------------------------------------------

void pod_engine_name(char *out, size_t n, const char *engine)
{
    if (!n) return;
    static const struct { const char *id, *name; } known[] = {
        {"claude", "Claude"}, {"codex", "Codex"}, {"muse", "Muse"}, {"cursor", "Cursor"},
    };
    for (unsigned i = 0; i < sizeof known / sizeof known[0]; i++)
        if (engine && !strcmp(engine, known[i].id)) { snprintf(out, n, "%s", known[i].name); return; }
    snprintf(out, n, "%s", engine ? engine : "");
    if (out[0] >= 'a' && out[0] <= 'z') out[0] = (char)(out[0] - 'a' + 'A');
}
void pod_fmt_time(char *out, size_t n, uint32_t secs)
{
    snprintf(out, n, "%u:%02u", (unsigned)(secs / 60), (unsigned)(secs % 60));
}
uint32_t pod_agent_secs(const pod_agent_t *a, uint32_t now_ms)
{
    if (!a) return 0;
    if (a->state == POD_WORKING && (int32_t)(now_ms - a->event_ms) >= 0) return a->elapsed_s + (now_ms - a->event_ms) / 1000;
    return a->elapsed_s;
}
int pod_agent_index(const pod_model_t *m, const pod_agent_t *a)
{
    if (!a || a < m->agents || a >= m->agents + m->agent_count) return -1;
    return (int)(a - m->agents);
}
void pod_tab_counts(const pod_model_t *m, const pod_tab_t *t, int *working, int *asking)
{
    int w = 0, q = 0;
    for (int k = 0; t && k < t->count && k < POD_PANES_MAX; k++) {
        int i = t->agent[k];
        if (i < 0 || i >= m->agent_count) continue;
        pod_state_t st = pod_model_eff(m, &m->agents[i]);
        if (st == POD_WORKING) w++;
        else if (st == POD_ASKING) q++;
    }
    if (working) *working = w;
    if (asking) *asking = q;
}
int pod_tab_panes(const pod_tab_t *t) { return t->panes ? t->panes : t->count; }
const pod_tab_t *pod_tab_of(const pod_model_t *m, const pod_agent_t *a)
{
    int idx = pod_agent_index(m, a);
    if (idx < 0) return NULL;
    for (int i = 0; i < m->tab_count; i++)
        for (int k = 0; k < m->tabs[i].count && k < POD_PANES_MAX; k++)
            if (m->tabs[i].agent[k] == idx) return &m->tabs[i];
    return NULL;
}
int pod_agent_pane(const pod_model_t *m, const pod_agent_t *a, const pod_tab_t *t)
{
    int idx = pod_agent_index(m, a);
    if (idx < 0 || !t) return 0;
    for (int k = 0; k < t->count && k < POD_PANES_MAX; k++)
        if (t->agent[k] == idx) return k + 1;
    return 0;
}

// ---- icons ----------------------------------------------------------------------------------------------

static int isqrt32(uint32_t n)
{
    uint32_t root = 0, bit = 1u << 30;
    while (bit > n) bit >>= 2;
    while (bit) {
        if (n >= root + bit) { n -= root + bit; root = (root >> 1) + bit; }
        else root >>= 1;
        bit >>= 2;
    }
    return (int)root;
}
// A stroke p0 -> p1 -> p2 (sixteenths of a px) t16 thick with a mitered joint and square ends: two quads of two
// triangles each. The edges inside the figure are inner (they bleed, so there is no seam); only the outline is
// anti-aliased.
static void miter(ht_scene_t *s, const int p[3][2], int t16, uint16_t ink)
{
    int h = t16 / 2, n[2][2];
    for (int i = 0; i < 2; i++) {
        int dx = p[i + 1][0] - p[i][0], dy = p[i + 1][1] - p[i][1], len = isqrt32((uint32_t)(dx * dx + dy * dy));
        if (!len) return;
        n[i][0] = -dy * h / len; n[i][1] = dx * h / len;
    }
    int dot = n[0][0] * n[1][0] + n[0][1] * n[1][1], den = h * h + dot;
    if (den <= 0) return;
    int mx = (n[0][0] + n[1][0]) * h * h / den, my = (n[0][1] + n[1][1]) * h * h / den;
    int a0x = p[0][0] + n[0][0], a0y = p[0][1] + n[0][1], b0x = p[0][0] - n[0][0], b0y = p[0][1] - n[0][1];
    int a1x = p[1][0] + mx, a1y = p[1][1] + my, b1x = p[1][0] - mx, b1y = p[1][1] - my;
    int a2x = p[2][0] + n[1][0], a2y = p[2][1] + n[1][1], b2x = p[2][0] - n[1][0], b2y = p[2][1] - n[1][1];
    pod_tri_inner(s, a0x, a0y, a1x, a1y, b1x, b1y, ink, 6);
    pod_tri_inner(s, a0x, a0y, b1x, b1y, b0x, b0y, ink, 1);
    pod_tri_inner(s, a1x, a1y, a2x, a2y, b2x, b2y, ink, 4);
    pod_tri_inner(s, a1x, a1y, b2x, b2y, b1x, b1y, ink, 5);
}
void pod_chevron(ht_scene_t *s, int x, int y, int a, uint16_t ink)
{
    // Tip at (x, y), legs a px across and a px up or down, 3.25 px thick.
    const int p[3][2] = {{(x + a) * 16, (y - a) * 16}, {x * 16, y * 16}, {(x + a) * 16, (y + a) * 16}};
    miter(s, p, 52, ink);
}
void pod_tick(ht_scene_t *s, int x, int y, uint16_t ink)
{
    const int p[3][2] = {{(x + 2) * 16, (y + 8) * 16}, {(x + 7) * 16 + 8, (y + 13) * 16 + 8}, {(x + 19) * 16, (y + 2) * 16}};
    miter(s, p, 48, ink);
}

const char *pod_view_title(const pod_nav_t *nav, const pod_model_t *m)
{
    const pod_frame_t *f = nav->depth ? &nav->stack[nav->depth - 1] : NULL;
    if (!f || f->view == POD_V_TABS) return "Tabs";
    if (f->view == POD_V_RECAP) return "Recap";
    if (f->view == POD_V_INBOX) return "Inbox";
    if (f->view == POD_V_TALK) {   // Listening: the title is who the words go to
        const pod_agent_t *a = pod_model_find(m, f->agent);
        return a && a->name[0] ? a->name : "Listening";
    }
    if (f->tab == POD_TAB_RECENT) return "Recent";
    return f->tab >= 0 && f->tab < m->tab_count ? m->tabs[f->tab].name : "Tab";
}

void pod_eq(ht_scene_t *s, int x, int y, uint16_t ink, uint32_t now_ms)
{
    static const uint16_t phase[3] = {0, 300, 600};
    for (int i = 0; i < 3; i++) {
        int p = (int)((now_ms + phase[i]) % 900), v = p < 450 ? p : 900 - p;
        int h = 5 + 15 * v / 450;
        ht_pro_rect(s, x + i * 9, y + 20 - h, 5, h, 1, ink);
    }
}
