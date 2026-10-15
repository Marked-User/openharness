#pragma once
// The screen turn (always on: every panel is mounted turned 180 degrees). It happens ONCE, in
// display/pro_display.c (rules in display/pro_turn.h): the strips are reversed and pro_touch_poll() hands back upright
// coordinates. Everything above it (pro_touch.c, pro_app.c, Pod) sees an upright 720 x 720 glass, so nothing
// in main/app may apply this turn again. pod_turn_coord() is the panel layer's rule written down; the host
// tests use it to play the part of the controller (a contact reported on the controller's axes).
#include "pro_turn.h"   // display/: the panel layer's own rule, shared so the tests play the real one

// A contact coordinate on the controller's axes -> on the upright glass.
static inline int pod_turn_coord(int v) { return pro_turn_coord(v); }
