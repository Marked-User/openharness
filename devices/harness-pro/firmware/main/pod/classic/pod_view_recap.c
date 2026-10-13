// The Recap screen (Classic Index): the head and band of the Agent screen with the tokens, then "SAVED RESULT" and the whole
// recap as wrapped text, scrolled by one 42 px line per step when it is longer than the space. Talk below.
#include "pod/classic/ci.h"
#include "pod/pod_view_shared.h"

#include <stdio.h>
#include <string.h>

#include "pod/pod_mem.h"

enum { LABEL_Y = 324, TEXT_Y = 357, LINE = 42, BODY_W = 656, ROWS_ALL = 64, RECAP_WORDS = 50 };

static EXT_RAM_BSS_ATTR char pod_recap_rows[ROWS_ALL][POD_ROW_MAX];
// The rows that fit between the label and the transport.
static int body_rows(void) { return (CI_TRANS_Y - 2 - TEXT_Y) / LINE; }
// The recap's sentences joined with spaces; returns the bytes written (cap includes the NUL).
int pod_recap_join(const pod_agent_t *a, char *out, size_t cap)
{
    size_t n = 0;
    for (int i = 0; i < a->recap_lines; i++) {
        size_t len = strlen(a->recap + a->line_at[i]);
        if (n + len + 2 > cap) break;
        if (n) out[n++] = ' ';
        memcpy(out + n, a->recap + a->line_at[i], len);
        n += len;
    }
    out[n] = 0;
    return (int)n;
}
// At most RECAP_WORDS words (split on ASCII whitespace, which never occurs inside a UTF-8 sequence); more ends with "...".
// out may be recap itself; cap leaves room for the dots.
int pod_recap_cut(const char *recap, char *out, size_t cap)
{
    if (!cap) return 0;
    size_t n = strlen(recap);
    if (n + 4 > cap) n = cap > 4 ? cap - 4 : 0;
    memmove(out, recap, n);
    out[n] = 0;
    int words = 0;
    for (size_t i = 0; i < n;) {
        while (i < n && (out[i] == ' ' || out[i] == '\n' || out[i] == '\t' || out[i] == '\r')) i++;
        if (i >= n) break;
        if (++words > RECAP_WORDS) {
            while (i && (out[i - 1] == ' ' || out[i - 1] == '\n' || out[i - 1] == '\t' || out[i - 1] == '\r')) i--;
            if (i + 4 > cap) break;
            memcpy(out + i, "...", 4);
            break;
        }
        while (i < n && out[i] != ' ' && out[i] != '\n' && out[i] != '\t' && out[i] != '\r') i++;
    }
    return (int)strlen(out);
}
static int layout(const pod_agent_t *a)
{
    static EXT_RAM_BSS_ATTR char joined[POD_RECAP_BYTES + POD_RECAP_LINES + 4];
    pod_recap_join(a, joined, sizeof joined);
    pod_recap_cut(joined, joined, sizeof joined);
    return pod_wrap_hard(joined, &ci_rg_32, BODY_W, ROWS_ALL, pod_recap_rows);
}
int pod_recap_pitch(void) { return LINE; }
static bool shows_recap(const pod_model_t *m, const pod_agent_t *a)
{
    pod_state_t st = pod_model_eff(m, a);
    return st != POD_WORKING && st != POD_ASKING && a->recap_lines;
}
int pod_recap_max_row(const pod_nav_t *nav, const pod_model_t *m)
{
    const pod_agent_t *a = pod_view_agent_of(nav, m);
    if (!a || !shows_recap(m, a)) return 0;
    int over = layout(a) - body_rows();
    return over > 0 ? over : 0;
}

// The pet's next step; the band's equaliser (working) moves every frame, as on the Agent screen.
uint32_t pod_view_recap_next_ms(const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    const pod_agent_t *a = pod_view_agent_of(nav, m);
    if (!a) return POD_PET_STEP_MS;
    bool working = pod_model_eff(m, a) == POD_WORKING;
    uint32_t ms = pod_pet_next_step_ms(a->engine, working ? POD_SCENE_WORK : POD_SCENE_REST, now_ms, 0);
    uint32_t cap = nav->skin == POD_SKIN_CONSOLE ? POD_CS_ANIM_MS : POD_PET_STEP_MS;
    return working && ms > cap ? cap : ms;
}

void pod_view_recap(pod_out_frame_t *f, const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    ci_bar(f, "Recap", pod_nav_origin(nav, m), f->unread, true);
    const pod_agent_t *a = pod_view_agent_of(nav, m);
    if (!a) { ci_talk(f, false); return; }
    const pod_frame_t *fr = &nav->stack[nav->depth - 1];
    const pod_state_t st = pod_model_eff(m, a);
    ci_agent_head(f, m, a, st, now_ms, true);
    ci_talk(f, m->linked && (st == POD_IDLE || st == POD_WORKING || st == POD_DONE));
    ci_caps(s, CI_MARGIN, LABEL_Y, "SAVED RESULT");
    if (!shows_recap(m, a)) {
        const char *msg = st == POD_IDLE || st == POD_DONE ? "No recap yet." : "The recap comes when this turn ends.";
        ci_text(s, CI_MARGIN, TEXT_Y, BODY_W, &ci_rg_32, CI_INK, msg);
        return;
    }
    const int visible = body_rows(), total = layout(a);
    int first = fr->scroll < 0 ? 0 : fr->scroll, max = total > visible ? total - visible : 0;
    if (first > max) first = max;
    for (int r = 0; r < visible && first + r < total; r++) {
        const char *row = pod_recap_rows[first + r];
        // The last row on screen ends with "…" while there is more below it; the text's own last row, when the text itself was cut.
        bool more_below = r == visible - 1 && first + r + 1 < total;
        bool cut_end = first + r == total - 1 && a->recap_cut;
        char dotted[POD_ROW_MAX];
        if (more_below || cut_end) { ci_dotted(dotted, row, &ci_rg_32, BODY_W); row = dotted; }
        ci_text(s, CI_MARGIN, TEXT_Y + r * LINE, BODY_W, &ci_rg_32, CI_INK, row);
    }
}
