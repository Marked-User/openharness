// Console skin entry point: cs_render paints the ground and dispatches on the top frame.
#include "pod/console/cs.h"
#include "pro_canvas.h"

void cs_render(pod_out_frame_t *f, const pod_nav_t *nav, pod_model_t *m, uint32_t now_ms)
{
    pod_model_clock(m, now_ms);
    f->hit_count = 0;
    f->scene->background = ht_rgb(CS_GROUND);   // the scene's own clear colour: no 720 x 720 ground rect to overdraw
    const pod_frame_t *top = nav->depth ? &nav->stack[nav->depth - 1] : NULL;
    if (!top || top->view == POD_V_TABS) cs_view_overview(f, nav, m, now_ms);
    else if (top->view == POD_V_TAB && (top->tab == POD_TAB_RECENT || (top->tab >= 0 && top->tab < m->tab_count))) cs_view_tab(f, nav, m, now_ms);
    else if (top->view == POD_V_AGENT) cs_view_agent(f, nav, m, now_ms);
    else if (top->view == POD_V_RECAP) cs_view_recap(f, nav, m, now_ms);
    else if (top->view == POD_V_TALK) cs_view_talk(f, nav, m, now_ms);
    else if (top->view == POD_V_INBOX) cs_view_inbox(f, nav, m, now_ms);
}
