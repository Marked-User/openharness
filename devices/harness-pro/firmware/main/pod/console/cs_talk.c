// Console voice (mockup screens 07 and 08, .vo .wave .msg in style4.css). Listening: the bar is the input (the agent chip, an
// empty line and the caret: the device has no live transcript), the listening pet, a 36-bar wave driven by the mic level the app
// layer puts in f->mic_level, and "Listening . m:ss". Sending: the message card (no text for the same reason) with a moving
// progress line and "Sending...". The wave and the line move with now_ms; pod_view_next_ms wakes the glue every 100 ms here.
#include <stdio.h>
#include <string.h>

#include "pod/console/cs.h"
#include "pod/pod_view_shared.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)
enum { PET = 200, WAVE_N = 36, WAVE_H = 90, BAR_W = 9, BAR_GAP = 6, VIOLET_HI = 0xb9b2ff, AREA_H = POD_W - CS_BAR_H - CS_FOOT_H };

static int tri(uint32_t t, uint32_t period)   // 0..100
{
    uint32_t p = t % period, half = period / 2;
    return (int)((p < half ? p : period - p) * 100 / half);
}

static void wave(ht_scene_t *s, int cy, int level, uint32_t now_ms)
{
    if (level < 0) level = 0;
    if (level > 4) level = 4;
    const int x0 = (POD_W - (WAVE_N * BAR_W + (WAVE_N - 1) * BAR_GAP)) / 2;
    for (int i = 0; i < WAVE_N; i++) {
        int shape = 35 + tri(now_ms + (uint32_t)i * 131, 600 + (uint32_t)(i % 5) * 110) * 65 / 100;
        int h = WAVE_H * 20 / 100 + (WAVE_H * 80 / 100) * level / 4 * shape / 100;
        bool edge = i < 5 || i >= WAVE_N - 5;   // the ends fade (35 %)
        ht_pro_rect(s, x0 + i * (BAR_W + BAR_GAP), cy - h / 2, BAR_W, h, 0, C(edge ? 0x302c5f : CS_FOCUS));
    }
}

static void sending(ht_scene_t *s, const pod_model_t *m, const pod_agent_t *a, int y, uint32_t now_ms)
{
    const int w = 600, x = (POD_W - w) / 2, h = 18 + 28 + 18 + 4 + 14 + 24 + 18;
    ht_pro_rect_aa_stroke(s, x, y, w, h, 18, C(0x2a2550), C(CS_SURFACE));
    cs_logo(s, x + 22, y + 18, 28, a->engine);
    char to[CABLE_NAME_MAX + 8];
    snprintf(to, sizeof to, "To %s", a->name);
    int tw = ht_pro_width(&cs_sb_22, to);
    if (tw > 260) tw = 260;
    cs_text(s, x + 22 + 28 + 12, y + 32, tw, &cs_sb_22, CS_INK, to);
    const pod_tab_t *tab = pod_tab_of(m, a);
    char where[2 * CABLE_NAME_MAX + 4];
    snprintf(where, sizeof where, "%s%s%s", tab ? tab->name : "", tab && a->machine[0] ? " \xc2\xb7 " : "", a->machine);
    int sx = x + 22 + 28 + 12 + tw + 12;
    if (where[0] && sx < x + w - 22) cs_text(s, sx, y + 32, x + w - 22 - sx, &cs_rg_17, CS_DIM, where);
    const int ty = y + 18 + 28 + 18, tw2 = w - 44, fw = tw2 * 4 / 10;
    ht_pro_rect(s, x + 22, ty, tw2, 4, 2, C(CS_BORDER));
    int fx = (int)(now_ms % 1400 * (uint32_t)(tw2 + fw) / 1400) - fw, l = fx < 0 ? 0 : fx, r = fx + fw > tw2 ? tw2 : fx + fw;
    ht_pro_rect(s, x + 22 + l, ty, r - l > 0 ? r - l : 1, 4, 2, C(CS_FOCUS));
    cs_spin(s, x + 22 + 11, ty + 14 + 12, CS_FOCUS, now_ms);
    cs_text(s, x + 22 + 22 + 10, ty + 14 + 12, 160, &cs_mono_18, VIOLET_HI, "Sending\xe2\x80\xa6");
}

void cs_view_talk(pod_out_frame_t *f, const pod_nav_t *nav, pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    const pod_agent_t *a = pod_view_agent_of(nav, m);
    int running, asking;
    cs_counts(m, &running, &asking);
    const char *crumbs[1] = {a ? a->name : ""};
    cs_bar(f, crumbs, 1, running, asking, 0, "", now_ms);
    if (!a) return;
    if (nav->sending) {
        const int h = 18 + 28 + 18 + 4 + 14 + 24 + 18, top = CS_BAR_H + (AREA_H - (PET + 20 + h)) / 2;
        pod_pet_draw(s, (POD_W - PET) / 2, top, PET, a->engine, POD_SCENE_SEND, now_ms, nav->send_started_ms);
        sending(s, m, a, top + PET + 20, now_ms);
        return;
    }
    const int top = CS_BAR_H + (AREA_H - (PET + 20 + WAVE_H + 20 + 28)) / 2, wy = top + PET + 20 + WAVE_H / 2;
    pod_pet_draw(s, (POD_W - PET) / 2, top, PET, a->engine, POD_SCENE_LISTEN, now_ms, nav->talk_started_ms);
    wave(s, wy, f->mic_level, now_ms);
    uint32_t secs = (now_ms - nav->talk_started_ms) / 1000;
    char t[32];
    snprintf(t, sizeof t, "Listening \xc2\xb7 %u:%02u", (unsigned)(secs / 60), (unsigned)(secs % 60));
    int tw = ht_pro_width(&cs_mono_18, t), lx = (POD_W - (14 + 10 + tw)) / 2, ly = wy + WAVE_H / 2 + 20 + 14;
    ht_pro_rect(s, lx, ly - 7, 14, 14, 7, C(CS_FAIL));
    cs_text(s, lx + 24, ly, tw + 2, &cs_mono_18, VIOLET_HI, t);
    const char *tap = "Tap anywhere to send";   // the pill (.vo-tap): the hold was the start, any new tap is the send
    const int pw = ht_pro_width(&cs_sb_22, tap) + 44, ph = 44, px = (POD_W - pw) / 2, py = ly + 14 + 12;
    ht_pro_rect_aa_stroke(s, px, py, pw, ph, ph / 2, C(0x4a40a6), C(0x2a2550));
    cs_text(s, px + 22, py + ph / 2, pw - 40, &cs_sb_22, CS_INK, tap);
    pod_hit_add(f, 0, 0, POD_W, POD_W, POD_A_TALK, 0);   // LAST: hits are scanned last to first, so no crumb or chip steals the send
}
