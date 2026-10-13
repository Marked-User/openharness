// The Agent screen (Classic Index): for an agent that is working, asking, offline, or idle with nothing to recap. The head
// (pet, name, "Tab . Machine"), the metadata band, then by state the activity, the question box or a line of copy, and Talk.
// Also the helpers this screen, Recap and Talking share (pod_view_shared.h), and the head and band Recap reuses.
#include "pod/classic/ci.h"
#include "pod/pod_view_shared.h"

#include <stdio.h>
#include <string.h>

static int imin(int a, int b) { return a < b ? a : b; }
#define C pod_c

const pod_agent_t *pod_view_agent_of(const pod_nav_t *nav, const pod_model_t *m)
{
    if (!nav->depth) return NULL;
    return pod_model_find(m, nav->stack[nav->depth - 1].agent);
}

// ---- text helpers ---------------------------------------------------------------------------------------

static int wrap_rows(const char *text, const ht_pro_font_t *font, int width, int max_rows, char rows[][POD_ROW_MAX], bool hard)
{
    int n = 0;
    const char *p = text ? text : "";
    while (n < max_rows) {
        while (*p == ' ' || *p == '\n') p++;
        if (!*p) break;
        char *row = rows[n];
        if (n == max_rows - 1) {   // the last row takes the rest; ht_pro_text clips it with an ellipsis
            size_t len = strlen(p);
            if (len >= POD_ROW_MAX) { len = POD_ROW_MAX - 1; while (len && ((unsigned char)p[len] & 0xc0) == 0x80) len--; }
            memcpy(row, p, len);
            row[len] = 0;
            for (char *q = row; *q; q++) if (*q == '\n') *q = ' ';
            n++;
            break;
        }
        size_t used = 0;
        row[0] = 0;
        for (;;) {
            const char *w = p;
            while (*w && *w != ' ' && *w != '\n') w++;
            size_t wl = (size_t)(w - p);
            if (!wl) break;
            char cut[POD_ROW_MAX];
            bool wide = wl >= POD_ROW_MAX;
            if (hard && !used && !wide) { memcpy(cut, p, wl); cut[wl] = 0; wide = ht_pro_width(font, cut) > width; }
            if (hard && !used && wide) {   // a word wider than the row (a URL): hard-break it
                size_t k = 0;
                for (size_t i = 1; i <= wl && i < POD_ROW_MAX; i++) {
                    if (i < wl && ((unsigned char)p[i] & 0xc0) == 0x80) continue;   // inside a sequence
                    memcpy(cut, p, i);
                    cut[i] = 0;
                    if (k && ht_pro_width(font, cut) > width) break;
                    k = i;
                }
                memcpy(row, p, k);
                row[k] = 0;
                used = k;
                p += k;
                break;
            }
            char cand[POD_ROW_MAX];
            if (used + (used ? 1 : 0) + wl >= POD_ROW_MAX) break;
            memcpy(cand, row, used);
            if (used) cand[used] = ' ';
            memcpy(cand + used + (used ? 1 : 0), p, wl);
            cand[used + (used ? 1 : 0) + wl] = 0;
            if (used && ht_pro_width(font, cand) > width) break;
            memcpy(row, cand, used + (used ? 1 : 0) + wl + 1);
            used += (used ? 1 : 0) + wl;
            p = w;
            while (*p == ' ') p++;
            if (*p == '\n') { p++; break; }
            if (!*p) break;
        }
        if (!used) break;
        n++;
    }
    return n;
}

// Console's wrap: a word wider than the row stays whole (the row buffer's limit drops the text). Classic's keeps going (ci_wrap).
int pod_wrap(const char *text, const ht_pro_font_t *font, int width, int max_rows, char rows[][POD_ROW_MAX])
{
    return wrap_rows(text, font, width, max_rows, rows, false);
}
int pod_wrap_hard(const char *text, const ht_pro_font_t *font, int width, int max_rows, char rows[][POD_ROW_MAX])
{
    return wrap_rows(text, font, width, max_rows, rows, true);
}

void pod_text_center(ht_scene_t *s, int cx, int y, int width, const ht_pro_font_t *font, uint16_t ink, const char *text)
{
    if (!text || !*text) return;
    int w = imin(ht_pro_width(font, text), width);
    ht_pro_text(s, cx - w / 2, y, w, font, ink, text);
}

int pod_who_line(ht_scene_t *s, int x, int y, int width, const pod_nav_t *nav, const pod_model_t *m, const pod_agent_t *a)
{
    const pod_frame_t *fr = &nav->stack[nav->depth - 1];
    const pod_tab_t *tab = NULL;
    if (fr->tab >= 0 && fr->tab < m->tab_count && pod_agent_pane(m, a, &m->tabs[fr->tab])) tab = &m->tabs[fr->tab];
    if (!tab) tab = pod_tab_of(m, a);
    // The tab alone on a line in blue (ht_pro_text ends it with an ellipsis only if it does not fit the width), then the
    // machine alone under it in grey; each omitted when unknown. No engine (owner, 2026-10-10: the pet or the logo
    // already says it) and no pane number.
    int rows = 0;
    if (tab && tab->name[0]) {
        ht_pro_text(s, x, y + rows * POD_WHO_PITCH, imin(ht_pro_width(&ht_pro_24, tab->name), width), &ht_pro_24, C(0x1f63d1), tab->name);
        rows++;
    }
    if (a->machine[0]) {
        char mach[CABLE_NAME_MAX];
        snprintf(mach, sizeof mach, "%s", a->machine);
        pod_utf8_trim(mach);
        ht_pro_text(s, x, y + rows * POD_WHO_PITCH, imin(ht_pro_width(&ht_pro_24, mach), width), &ht_pro_24, C(0x7b7d84), mach);
        rows++;
    }
    return rows;
}

// The round dial's working verb (ui_screens.c GERUNDS, busy_compose): a gerund that rotates every 6 s of the turn's
// elapsed time. The cable carries no verb (turn.activity's `action` is the activity text), so the dial derives it too.
const char *pod_working_verb(uint32_t secs)
{
    static const char *const gerunds[] = {
        "Working", "Brewing", "Cooking", "Churning", "Frosting", "Simmering", "Tinkering",
        "Conjuring", "Composing", "Percolating", "Wrangling", "Hatching", "Concocting", "Puttering",
    };
    return gerunds[(secs / 6) % (sizeof gerunds / sizeof gerunds[0])];
}

// The round dial's rule (main's focus.c status_verb): the verb is the engine's own activity word, its trailing "..." or
// "\u2026" dropped, and only "Working" or nothing becomes the rotating gerund (owner, 2026-10-10: Claude's terminal said
// "Infusing" while the pill said a made-up "Churning"). Pod adds one thing: a word that does not fit the pill's
// `room` px stays in the body and the pill keeps the gerund. Copies the word into out; false otherwise.
bool pod_activity_verb(const char *text, char *out, size_t cap, int room)
{
    if (!text) return false;
    while (*text == ' ' || *text == '\t' || *text == '\r' || *text == '\n') text++;
    size_t n = strnlen(text, cap);
    if (n >= cap) return false;
    memcpy(out, text, n);
    out[n] = 0;
    while (n && (out[n - 1] == ' ' || out[n - 1] == '\t' || out[n - 1] == '\r' || out[n - 1] == '\n')) out[--n] = 0;
    if (n >= 3 && (!memcmp(out + n - 3, "...", 3) || !memcmp(out + n - 3, "\xe2\x80\xa6", 3))) { n -= 3; out[n] = 0; }
    while (n && out[n - 1] == ' ') out[--n] = 0;
    if (!n || !strcmp(out, "Working") || memchr(out, '\n', n)) return false;
    char shown[POD_VERB_MAX + 4];
    snprintf(shown, sizeof shown, "%s...", out);
    return ht_pro_width(&ht_pro_24, shown) <= room;
}

void pod_lcd_pill(ht_scene_t *s, int x, int y, int width, const pod_agent_t *a, uint32_t now_ms)
{
    const uint32_t secs = pod_agent_secs(a, now_ms);
    // The LCD (owner's S5, 2026-10-10): content only, no shape. The Pod screen is cleared to the canvas (0xeeede5), not
    // white, so the old fill showed as a white patch; the rim went too. The three bars, the verb and the time sit
    // where they did inside the POD_LCD_H box, which still reserves the space.
    pod_eq(s, x + 16, y + (POD_LCD_H - 20) / 2, C(0x2a9a57), now_ms);
    char t[12], verb[40];
    pod_fmt_time(t, sizeof t, secs);
    char own[POD_VERB_MAX];
    const int room = pod_lcd_verb_room(width);
    snprintf(verb, sizeof verb, "%s\xe2\x80\xa6", pod_activity_verb(a->verb, own, sizeof own, room) ? own : pod_working_verb(secs));
    const int ty = y + (POD_LCD_H - ht_pro_24.height) / 2, tw = ht_pro_width(&ht_pro_24, t);
    const int vx = x + 16 + 33, vw = imin(ht_pro_width(&ht_pro_24, verb), width - 16 - tw - 12 - (vx - x));
    if (vw > 0) ht_pro_text(s, vx, ty, vw, &ht_pro_24, C(0x26292b), verb);
    ht_pro_text(s, x + width - 16 - tw, ty, tw, &ht_pro_24, C(0x1f9d4c), t);
}

// ---- the screen -----------------------------------------------------------------------------------------

#define MIDDOT "\xc2\xb7"
#define ELLIPSIS "\xe2\x80\xa6"
enum { PET_X = 32, PET_Y = 104, PET_SIDE = 104, HEAD_X = 152, NAME_Y = 110, WHO_Y = 165, BAND_Y = 221,
       LABEL_Y = 324, BODY_Y = 357, LINE = 42, BODY_W = 656, STEP_PITCH = 37, ASK_X = 32, ASK_PAD = 23 };

// The scene the agent shows now, by state. Idle and done rest (REST, not the relaxing face: owner, 2026-10-10).
// SEND plays on the voice screen (pod_view_talk.c), not here.
static pod_scene_t scene_for(pod_state_t st)
{
    return st == POD_WORKING ? POD_SCENE_WORK : st == POD_ASKING ? POD_SCENE_ASK : POD_SCENE_REST;
}

// What changes on this screen: the pet at its own steps, and the band's equaliser while the agent works.
uint32_t pod_view_agent_next_ms(const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    const pod_agent_t *a = pod_view_agent_of(nav, m);
    if (!a) return POD_PET_STEP_MS;
    pod_state_t st = pod_model_eff(m, a);
    uint32_t ms = pod_pet_next_step_ms(a->engine, scene_for(st), now_ms, 0);
    uint32_t cap = nav->skin == POD_SKIN_CONSOLE ? POD_CS_ANIM_MS : POD_PET_STEP_MS;   // Console: the equaliser and the spinner step at 66 ms
    return st == POD_WORKING && ms > cap ? cap : ms;
}

// `row` followed by "…", trimmed so the whole fits max_w (the last visible line of cut or clipped text).
void ci_dotted(char out[POD_ROW_MAX], const char *row, const ht_pro_font_t *font, int max_w)
{
    char t[POD_ROW_MAX];
    snprintf(t, sizeof t, "%s", row);
    size_t n = strlen(t);
    while (n && (t[n - 1] == ' ' || t[n - 1] == '.' || t[n - 1] == ',')) t[--n] = 0;
    if (n >= 3 && !memcmp(t + n - 3, ELLIPSIS, 3)) { snprintf(out, POD_ROW_MAX, "%s", t); return; }
    for (;;) {
        snprintf(out, POD_ROW_MAX, "%s" ELLIPSIS, t);
        if (!n || ht_pro_width(font, out) <= max_w) return;
        do n--; while (n && ((unsigned char)t[n] & 0xc0) == 0x80);
        t[n] = 0;
        while (n && t[n - 1] == ' ') t[--n] = 0;
    }
}

// The head (pet, name, "Tab . Machine") and the band (Tokens on the right only when `tokens`, else Engine), shared by Agent and Recap. The pet of an offline agent
// cannot fade (it is drawn from cells and arcs), so it shows the engine's logo, faded to half, on the pale cover.
void ci_agent_head(pod_out_frame_t *f, const pod_model_t *m, const pod_agent_t *a, pod_state_t st, uint32_t now_ms, bool tokens)
{
    ht_scene_t *s = f->scene;
    if (st == POD_OFFLINE) {
        ht_pro_rect_aa_stroke(s, PET_X, PET_Y, PET_SIDE, PET_SIDE, 14, ht_rgb(0xdcdfd8), ht_rgb(0xefefe9));
        // The largest logo the engine has (pet engines carry the small sizes only).
        static const int sizes[] = {0, 44, 36};
        bool drawn = false;
        for (int i = 0; i < 3 && !drawn; i++) {
            const int logo = i ? sizes[i] : pod_logo_cover_size(PET_SIDE);
            drawn = pod_logo_draw_faded(s, PET_X + (PET_SIDE - logo) / 2, PET_Y + (PET_SIDE - logo) / 2, logo, a->engine, 128);
        }
        if (!drawn) pod_mark_default_big(s, PET_X + (PET_SIDE - 56) / 2, PET_Y + (PET_SIDE - 56) / 2, 56, ht_rgb(0xefefe9));
    } else {
        pod_pet_draw_on(s, PET_X, PET_Y, PET_SIDE, a->engine, scene_for(st), now_ms, 0, 0xf6f6f0);
    }
    char name[sizeof a->name];
    snprintf(name, sizeof name, "%s", a->name);
    for (char *c = name; *c; c++) if (*c == '\n' || *c == '\r' || *c == '\t') *c = ' ';
    ci_text(s, HEAD_X, NAME_Y, POD_W - CI_MARGIN - HEAD_X, &ci_rg_41, CI_INK, name);
    const pod_tab_t *tab = pod_tab_of(m, a);
    char who[2 * CABLE_NAME_MAX + 4];
    const char *tn = tab && tab->name[0] ? tab->name : "", *mn = a->machine;
    snprintf(who, sizeof who, "%s%s%s", tn, *tn && *mn ? " " MIDDOT " " : "", mn);
    ci_text(s, HEAD_X, WHO_Y, POD_W - CI_MARGIN - HEAD_X, &ci_rg_23, CI_MUTED, who);
    const int32_t el = st == POD_WORKING ? (int32_t)pod_agent_secs(a, now_ms) : st == POD_DONE && a->elapsed_s ? (int32_t)a->elapsed_s : -1;
    ci_band(s, BAND_Y, st, el, a->engine, tokens && a->tokens_in >= 0 ? a->tokens_in : -1, a->tokens_out, now_ms);
}

// The caps label ("RIGHT NOW", "SAVED RESULT"): Bold 20, muted. One run, so no tracking (the mockup's 1 px adds about 8 px).
void ci_caps(ht_scene_t *s, int x, int y, const char *label)
{
    ht_pro_text(s, x, y, ht_pro_width(&ci_bd_20, label), &ci_bd_20, CI_MUTED, label);
}

// "Updated just now" (under 60 s) / "Updated 3m ago" / "Updated 2h ago"; false when the event time is unknown.
bool ci_updated(char *out, size_t n, const pod_agent_t *a, uint32_t now_ms)
{
    if (!a->has_event || !a->event_ms) return false;
    uint32_t d = (int32_t)(now_ms - a->event_ms) > 0 ? now_ms - a->event_ms : 0;
    if (d < 60000) snprintf(out, n, "Updated just now");
    else if (d < 3600000) snprintf(out, n, "Updated %um ago", (unsigned)(d / 60000));
    else snprintf(out, n, "Updated %uh ago", (unsigned)(d / 3600000));
    return true;
}

void pod_view_agent(pod_out_frame_t *f, const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    const pod_agent_t *a = pod_view_agent_of(nav, m);
    ci_bar(f, "Task", pod_nav_origin(nav, m), f->unread, true);
    if (!a) { ci_talk(f, false); return; }
    const pod_state_t st = pod_model_eff(m, a);
    ci_agent_head(f, m, a, st, now_ms, false);
    char rows[3][POD_ROW_MAX];
    if (st == POD_WORKING) {
        ci_caps(s, CI_MARGIN, LABEL_Y, "RIGHT NOW");
        char fallback[24];
        const char *act = a->activity;
        if (!act[0]) { snprintf(fallback, sizeof fallback, "%s" ELLIPSIS, pod_working_verb(pod_agent_secs(a, now_ms))); act = fallback; }
        int n = ci_wrap(act, &ci_rg_32, BODY_W, 3, rows);
        if (a->activity_cut && a->activity[0] && n > 0) ci_dotted(rows[n - 1], rows[n - 1], &ci_rg_32, BODY_W);
        for (int i = 0; i < n; i++) ci_text(s, CI_MARGIN, BODY_Y + i * LINE, BODY_W, &ci_rg_32, CI_INK, rows[i]);
        int y = BODY_Y + n * LINE + 12;
        // The newest two steps since the turn began or its question closed, one muted line each.
        const int steps = imin(imin(a->step_count, a->fresh_steps), 2);
        for (int i = 0; i < steps; i++, y += STEP_PITCH) ci_text(s, CI_MARGIN, y, BODY_W, &ci_rg_22, CI_MUTED, a->steps[i]);
        char up[24];
        if (ci_updated(up, sizeof up, a, now_ms)) ci_text(s, CI_MARGIN, y + 7, BODY_W, &ci_rg_20, ht_rgb(0x7b827c), up);
    } else if (st == POD_ASKING) {
        int n = ci_wrap(a->question, &ci_rg_32, BODY_W - ASK_PAD - 18, 3, rows);
        if (!n) n = ci_wrap("Needs your answer.", &ci_rg_32, BODY_W, 1, rows);
        const int top = LABEL_Y + 2, h = 2 * ASK_PAD - 10 + n * LINE;
        ht_pro_rect(s, ASK_X, top, BODY_W, h, 0, CI_ASK_FILL);
        ht_pro_rect(s, ASK_X, top, 4, h, 0, CI_ASK_BAR);
        for (int i = 0; i < n; i++) ci_text(s, ASK_X + ASK_PAD, top + 19 + i * LINE, BODY_W - ASK_PAD - 18, &ci_rg_32, CI_INK, rows[i]);
        ci_text(s, CI_MARGIN, top + h + 12, BODY_W, &ci_rg_23, CI_MUTED, "Answer it in the Harness app.");
    } else if (st == POD_OFFLINE) {
        char line[2 * CABLE_NAME_MAX + 40];
        ci_text(s, CI_MARGIN, LABEL_Y + 2, BODY_W, &ci_rg_32, CI_INK, "That machine is offline.");
        snprintf(line, sizeof line, "Reconnect %s in Harness to continue.", a->machine[0] ? a->machine : "it");
        ci_text(s, CI_MARGIN, LABEL_Y + 55, BODY_W, &ci_rg_23, CI_MUTED, line);
    } else {
        ci_text(s, CI_MARGIN, LABEL_Y + 2, BODY_W, &ci_rg_32, CI_INK, "Ready when you are.");
        ci_text(s, CI_MARGIN, LABEL_Y + 55, BODY_W, &ci_rg_23, CI_MUTED, "Send a new voice instruction to this agent.");
    }
    ci_talk(f, m->linked && (st == POD_IDLE || st == POD_WORKING || st == POD_DONE));
}
