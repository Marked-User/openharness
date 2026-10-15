// The 180 degree panel turn. THE one place it is written down; the panel layer (pro_display.c) applies each helper once,
// and the host tests call these same functions to play the glass. Callers above the panel layer see an upright
// PRO_DISPLAY_PX x PRO_DISPLAY_PX glass and must never turn anything.
//
// Every unit's panel is mounted turned 180 degrees, so the turn is always on.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PRO_TURN_PX 720

// A coordinate on the controller's axes <-> on the upright glass (the turn is its own inverse).
static inline int pro_turn_coord(int v) { return PRO_TURN_PX - 1 - v; }
// A contact (x, y) on the controller's axes -> on the upright glass.
static inline void pro_turn_point(int *x, int *y)
{
    *x = PRO_TURN_PX - 1 - *x;
    *y = PRO_TURN_PX - 1 - *y;
}

// Reverse a w*h block of pixels in place: with the rectangle mapped by pro_turn_rect this is a 180 degree turn.
static inline void pro_turn_pixels(uint16_t *px, size_t count)
{
    if (count < 2) return;
    for (uint16_t *a = px, *b = px + count - 1; a < b; a++, b--) {
        const uint16_t v = *a;
        *a = *b;
        *b = v;
    }
}

// The rectangle (x, y, w, h) of the upright glass -> its top-left corner on the panel.
static inline void pro_turn_rect(int x, int y, int w, int h, int *panel_x, int *panel_y)
{
    *panel_x = PRO_TURN_PX - x - w;
    *panel_y = PRO_TURN_PX - y - h;
}
