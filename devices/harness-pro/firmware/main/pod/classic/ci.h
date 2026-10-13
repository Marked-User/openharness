#pragma once
// Classic Index chrome (spec 2026-10-13): the design tokens and the pieces every Classic screen shares: the bar, the
// footer, the Talk transport, the mark box and the metadata band. Text is Liberation Sans (ci_rg_* / ci_bd_*).
#include "pod/pod_view.h"
#include "pod/pod_view_shared.h"   // POD_ROW_MAX
#include "pro_canvas.h"

// The nearest RGB565 to a colour (ht_rgb truncates: 0xf0 would show as 246). For the tokens ht_rgb makes visibly off.
static inline uint16_t ci_rgb(unsigned c)
{
    return (uint16_t)((((((c >> 16) & 255) * 31 + 127) / 255) << 11) | (((((c >> 8) & 255) * 63 + 127) / 255) << 5) | ((c & 255) * 31 + 127) / 255);
}
#define CI_GROUND   ci_rgb(0xf6f6f0)
#define CI_INK      ht_rgb(0x20292c)
#define CI_MUTED    ht_rgb(0x657175)
#define CI_BLUE     ht_rgb(0x155ccc)
#define CI_RULE     ht_rgb(0xccd0ce)
#define CI_GREEN    ht_rgb(0x3d6653)
#define CI_EQ       ht_rgb(0x2d6a51)
#define CI_AMBER    ht_rgb(0x8b570f)
#define CI_ASK_FILL ci_rgb(0xf0e9d8)
#define CI_ASK_BAR  ht_rgb(0xb78230)
#define CI_ROW_ASK  ci_rgb(0xf0eadc)
#define CI_FAIL     ht_rgb(0x974f43)

enum { CI_BAR_H = 88, CI_FOOT_Y = 628, CI_TRANS_Y = POD_CLASSIC_TRANSPORT_Y, CI_TALK_X = 32, CI_TALK_Y = 624, CI_TALK_W = 656, CI_TALK_H = 88,
       CI_MARGIN = 32, CI_ROW_H = 112, CI_MARK = 56, CI_BACK_W = 173, CI_BELL_W = 88 };

// Text at (x, y) in at most max_w px. Wider text is cut at a UTF-8 character boundary and ends with "\xe2\x80\xa6" (U+2026, one glyph;
// ht_pro_text's own cut is the three ASCII dots), so the whole fits. The ci_* faces carry the mark.
void ci_text(ht_scene_t *s, int x, int y, int max_w, const ht_pro_font_t *f, uint16_t ink, const char *utf8);
// pod_wrap_hard (pod_view_agent.c): pod_wrap that also breaks a word wider than the row at a character boundary.
int pod_wrap_hard(const char *text, const ht_pro_font_t *, int width, int max_rows, char rows[][POD_ROW_MAX]);
// pod_wrap's greedy word wrap into at most max_lines rows of at most max_w px; when text remains after the last row, that row
// is cut to fit and ends with U+2026. Returns the rows used.
int ci_wrap(const char *utf8, const ht_pro_font_t *f, int max_w, int max_lines, char rows[][POD_ROW_MAX]);

// The bar, y 0-88: brand "Harness" when back is NULL, else a chevron and the back label (cut at 115 px); the title
// centred on the screen; the bell and its count pill when `bell`. Adds BACK (0,0,173,88) when back != NULL and INBOX
// (632,0,88,88) when bell. Sets f->unread (0 without a bell) and f->bell_x (the bell's left edge, 0 without).
void ci_bar(pod_out_frame_t *f, const char *title, const char *back, uint8_t unread, bool bell);
// The footer, y 628-720: an optional green led and `left` (muted), `right_caps` right-aligned (either may be NULL).
void ci_foot(ht_scene_t *s, const char *left, bool led, const char *right_caps);
// The transport (y 616-720) with the Talk button; the TALK hit is the button, only when enabled (disabled draws at 45%).
void ci_talk(pod_out_frame_t *f, bool enabled);
// The 56 px mark box at (x, y) with the 36 px logo, or the default mark for an engine without one.
void ci_mark(ht_scene_t *s, int x, int y, const char *engine);
// The metadata band, 88 px from y: state icon, word and elapsed on the left; Tokens (tokens_in >= 0) or Engine on the right.
void ci_band(ht_scene_t *s, int y, pod_state_t st, int32_t elapsed_s, const char *engine, int32_t tokens_in, int32_t tokens_out,
             uint32_t now_ms);
// The list meta word and its colour for a state. Returns 1 (0 for an unknown state, word "").
int ci_state_word(pod_state_t st, const char **word, uint16_t *ink);
void ci_fmt_tokens(char *out, size_t n, int32_t v);    // "980", "2.3k", "10.1k", "1.2M"
void ci_fmt_elapsed(char *out, size_t n, int32_t s);   // "2:14", "1:02:03", "—" when s < 0

// The Agent and Recap screens (pod_view_agent.c): the head (pet, name, "Tab . Machine") and metadata band (Tokens on the right when
// `tokens` and the agent has them, else Engine); the "RIGHT NOW" caps label; "Updated just now / 3m ago / 2h ago" (false when the event
// time is unknown); `row` + U+2026 trimmed to fit max_w.
void ci_agent_head(pod_out_frame_t *, const pod_model_t *, const pod_agent_t *, pod_state_t, uint32_t now_ms, bool tokens);
void ci_caps(ht_scene_t *, int x, int y, const char *label);
bool ci_updated(char *out, size_t n, const pod_agent_t *, uint32_t now_ms);
void ci_dotted(char out[POD_ROW_MAX], const char *row, const ht_pro_font_t *, int max_w);

void ci_connection_lost(pod_out_frame_t *f, uint8_t unread);   // Connection lost: the whole screen, no hits (ci_connection.c)
