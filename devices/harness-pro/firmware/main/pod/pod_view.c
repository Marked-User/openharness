// pod_render: the one entry point. Dispatches on the top navigation frame.
#include "pod_view.h"
#include "pro_canvas.h"
#include "pod/classic/ci.h"
#include "pod/console/cs.h"

void pod_render(pod_out_frame_t *f, const pod_nav_t *nav, pod_model_t *m, uint32_t now_ms)
{
    if (nav->skin == POD_SKIN_CONSOLE) { cs_render(f, nav, m, now_ms); return; }
    pod_model_clock(m, now_ms);
    f->scene->background = CI_GROUND;   // the app clears to its canvas; Classic's ground is its own
    f->hit_count = 0;
    const pod_frame_t *top = nav->depth ? &nav->stack[nav->depth - 1] : NULL;
    // The bell: every screen with a status bar while something is unread, but not the Inbox itself and never over a recording.
    f->unread = !m->linked ? 0 : !top || (top->view != POD_V_INBOX && top->view != POD_V_TALK) ? (m->unread_count > 99 ? 99 : m->unread_count) : 0;
    f->bell_x = 0;
    if (!m->linked) {   // no cable: Connection lost in place of the stack, which comes back on reconnect
        ci_connection_lost(f, (uint8_t)(m->unread_count > 99 ? 99 : m->unread_count));
        return;
    }
    switch (top ? top->view : POD_V_TABS) {
    case POD_V_TAB: pod_view_tab(f, nav, m, now_ms); break;
    case POD_V_AGENT: pod_view_agent(f, nav, m, now_ms); break;
    case POD_V_RECAP: pod_view_recap(f, nav, m, now_ms); break;
    case POD_V_TALK: pod_view_talk(f, nav, m, now_ms); break;
    case POD_V_INBOX: pod_view_inbox(f, nav, m, now_ms); break;
    default: pod_view_tabs(f, nav, m, now_ms); break;
    }
}

uint32_t pod_view_next_ms(const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    const pod_frame_t *top = nav->depth ? &nav->stack[nav->depth - 1] : NULL;
    switch (top ? top->view : POD_V_TABS) {
    case POD_V_TABS:
    case POD_V_TAB: return nav->skin == POD_SKIN_CONSOLE ? cs_cards_next_ms(nav, m, now_ms) : POD_PET_STEP_MS;   // Console: the cards' pets
    case POD_V_AGENT: return pod_view_agent_next_ms(nav, m, now_ms);
    case POD_V_RECAP: return pod_view_recap_next_ms(nav, m, now_ms);
    case POD_V_TALK: {
        uint32_t ms = pod_view_talk_next_ms(nav, m, now_ms);
        // The Console voice wave (and the listening pet, which would ask for every 33 ms) steps at 100 ms.
        return nav->skin == POD_SKIN_CONSOLE && !nav->sending ? POD_CS_WAVE_MS : ms;
    }
    default: return POD_PET_STEP_MS;
    }
}

int pod_tabs_pages_of(const pod_nav_t *nav, const pod_model_t *m)
{
    return nav->skin == POD_SKIN_CONSOLE ? (1 + m->tab_count + CS_PER_PAGE - 1) / CS_PER_PAGE : pod_tabs_pages(m);
}

int pod_scroll_pitch(const pod_nav_t *nav)
{
    const pod_frame_t *top = nav->depth ? &nav->stack[nav->depth - 1] : NULL;
    if (!top) return 0;
    if (nav->skin == POD_SKIN_CONSOLE && top->view == POD_V_INBOX) return cs_inbox_pitch();
    if (nav->skin == POD_SKIN_CONSOLE && top->view == POD_V_RECAP) return CS_RECAP_ROW;
    if (nav->skin == POD_SKIN_CONSOLE && top->view == POD_V_TAB) return 0;   // cards page on a swipe; nothing scrolls by pixels
    return top->view == POD_V_TABS ? pod_tabs_pitch() :
           top->view == POD_V_TAB ? pod_tab_pitch() :
           top->view == POD_V_INBOX ? pod_inbox_pitch() :
           top->view == POD_V_RECAP ? pod_recap_pitch() : 0;
}
int pod_scroll_max(const pod_nav_t *nav, const pod_model_t *m)
{
    const pod_frame_t *top = nav->depth ? &nav->stack[nav->depth - 1] : NULL;
    if (!top) return 0;
    if (nav->skin == POD_SKIN_CONSOLE && top->view == POD_V_INBOX) return cs_inbox_max_row(m);
    if (nav->skin == POD_SKIN_CONSOLE && top->view == POD_V_RECAP) return cs_recap_max_row(nav, m);
    if (nav->skin == POD_SKIN_CONSOLE && top->view == POD_V_TAB) return cs_tab_pages(nav, m) - 1;
    if (nav->skin == POD_SKIN_CONSOLE && top->view == POD_V_TABS) return (pod_tabs_pages_of(nav, m) - 1) * 2;
    return top->view == POD_V_TABS ? pod_tabs_max_row(m) :
           top->view == POD_V_TAB ? pod_tab_max_row(nav, m) :
           top->view == POD_V_INBOX ? pod_inbox_max_row(m) :
           top->view == POD_V_RECAP ? pod_recap_max_row(nav, m) : 0;
}
