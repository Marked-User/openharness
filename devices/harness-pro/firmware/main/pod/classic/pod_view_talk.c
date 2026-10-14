// The Classic Voice screens (Index look, spec 2026-10-13). Listening: "To {name}", the LISTEN pet, "Listening.", the 13 mic bars
// and "Tap to send."; one full-screen TALK hit sends (Back stays in the bar). Sending: the SEND pet, "Sending your words…", the
// agent and the pending note. No bell, no transport, no buttons.
#include "pod/classic/ci.h"
#include "pod/pod_view_shared.h"

#include <stdio.h>
#include <string.h>

enum { LISTEN = 281, SEND = 209, WAVE_N = 13, BAR_W = 5, BAR_GAP = 7, WAVE_CY = 568, PET_LISTEN_Y = 192, PET_SEND_Y = 186 };
#define GROUND 0xf6f6f0u

static int tri(uint32_t t, uint32_t period)   // 0..100
{
    uint32_t p = t % period, half = period / 2;
    return (int)((p < half ? p : period - p) * 100 / half);
}
static void centered(ht_scene_t *s, int y, int max_w, const ht_pro_font_t *f, uint16_t ink, const char *t)
{
    char cut[HT_TEXT_BYTES];
    snprintf(cut, sizeof cut, "%s", t);
    int w = ht_pro_width(f, cut);
    if (w > max_w) { ci_text(s, (POD_W - max_w) / 2, y, max_w, f, ink, t); return; }
    ht_pro_text(s, (POD_W - w) / 2, y, w, f, ink, cut);
}

// 13 bars, 5 px wide 7 px apart, at the mic level (0 = a row of dots); each breathes with the clock.
static void wave(ht_scene_t *s, int level, uint32_t now_ms)
{
    if (level < 0) level = 0;
    if (level > 4) level = 4;
    const int x0 = (POD_W - (WAVE_N * BAR_W + (WAVE_N - 1) * BAR_GAP)) / 2;
    for (int i = 0; i < WAVE_N; i++) {
        int n = i + 1, peak = n % 3 == 0 ? 32 : n % 2 == 0 ? 22 : 7;   // the mockup's three heights
        int shape = 35 + tri(now_ms + (uint32_t)i * 131, 600 + (uint32_t)(i % 5) * 110) * 65 / 100;
        int h = 7 + (peak - 7) * level / 4 * shape / 100;
        ht_pro_rect(s, x0 + i * (BAR_W + BAR_GAP), WAVE_CY - h / 2, BAR_W, h, BAR_W / 2, ht_rgb(0x2c6e64));
    }
}

// A pet draws by its own clock (the sending scene from the stop tap); without one the bars move every frame.
uint32_t pod_view_talk_next_ms(const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    const pod_agent_t *a = pod_view_agent_of(nav, m);
    if (nav->sending)
        return a && pod_pet_has(a->engine, POD_SCENE_SEND)
                   ? pod_pet_next_step_ms(a->engine, POD_SCENE_SEND, now_ms, nav->send_started_ms)
                   : POD_PET_STEP_MS;
    return a && pod_pet_has(a->engine, POD_SCENE_LISTEN) ? pod_pet_next_step_ms(a->engine, POD_SCENE_LISTEN, now_ms, nav->talk_started_ms)
                                                         : POD_PET_STEP_MS;
}

void pod_view_talk(pod_out_frame_t *f, const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    const pod_agent_t *a = pod_view_agent_of(nav, m);
    ci_bar(f, nav->sending ? "Message" : "Voice", pod_nav_origin(nav, m), 0, false);
    if (!a) return;
    const uint16_t muted = CI_MUTED;
    char name[sizeof a->name];
    snprintf(name, sizeof name, "%s", a->name);
    for (char *c = name; *c; c++) if (*c == '\n' || *c == '\r' || *c == '\t') *c = ' ';
    if (nav->sending) {
        if (pod_pet_has(a->engine, POD_SCENE_SEND))
            pod_pet_draw_on(s, (POD_W - SEND) / 2, PET_SEND_Y, SEND, a->engine, POD_SCENE_SEND, now_ms, nav->send_started_ms, GROUND);
        centered(s, 402, 640, &ci_bd_45, CI_INK, "Sending your words\xe2\x80\xa6");
        centered(s, 481, 640, &ci_rg_30, muted, name);
        char rows[3][POD_ROW_MAX];   // two lines in Helvetica, three in Liberation: never cut
        int n = ci_wrap("One request is pending. Going back will not send it again.", &ci_rg_26, 583, 3, rows);
        for (int i = 0; i < n; i++) centered(s, 543 + i * 37, 583, &ci_rg_26, muted, rows[i]);
        return;
    }
    {   // "To " in Regular and the name in Bold, centred as one line
        int tw = ht_pro_width(&ci_rg_23, "To "), nw = ht_pro_width(&ci_bd_23, name);
        if (nw > 560) nw = 560;
        int x = (POD_W - (tw + nw)) / 2;
        ht_pro_text(s, x, 172, tw, &ci_rg_23, muted, "To ");
        ci_text(s, x + tw, 172, nw, &ci_bd_23, muted, name);
    }
    if (pod_pet_has(a->engine, POD_SCENE_LISTEN))
        pod_pet_draw_on(s, (POD_W - LISTEN) / 2, PET_LISTEN_Y, LISTEN, a->engine, POD_SCENE_LISTEN, now_ms, nav->talk_started_ms, GROUND);
    centered(s, 467, 640, &ci_rg_48, CI_INK, "Listening.");
    wave(s, f->mic_level, now_ms);
    centered(s, 599, 640, &ci_rg_24, muted, "Tap to send.");
    pod_hit_add(f, 0, CI_BAR_H, POD_W, POD_W - CI_BAR_H, POD_A_TALK, 0);   // anywhere below the bar sends
}
