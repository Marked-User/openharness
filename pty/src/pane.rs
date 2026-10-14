//! One pane: a child on a pseudo terminal, the grid its output draws, and the
//! sequence number of every output chunk.
//!
//! The pane has two halves:
//! - the *screen* (`Screen`: the `Term` grid and `seq`), which lives as long as the pane, so a
//!   respawned child draws into the same grid and continues the same sequence;
//! - the *attachment* (`Attachment`): one child, its tty and the reader thread that owns the tty.
//!   A respawn replaces it.
//!
//! The reader thread is the only one touching the tty. Other threads reach it through a channel
//! and wake it through the poller (`Msg`). It advances the parser and bumps `seq` under the screen
//! lock, then sends `PaneEvent::Output` after releasing it, so `capture` sees a grid and the `seq`
//! of the last output that grid contains.

use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::process::ExitStatus;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

use alacritty_terminal::event::OnResize;
use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::tty::{self, ChildEvent, EventedPty, EventedReadWrite, Options, Shell};
use alacritty_terminal::vte::ansi::{Processor, Timeout};
use polling::{Event as PollEvent, Events, PollMode, Poller};
use serde::Serialize;

/// Bytes read from the tty per read call.
const READ_CHUNK: usize = 64 * 1024;
/// Bytes read per wakeup before going back to the poller, so input and control messages are not
/// starved by a program that floods its output.
const READ_PER_WAKEUP: usize = 1024 * 1024;
/// How long a dropped pane's child gets after SIGHUP before SIGKILL.
#[cfg(unix)]
const SHUTDOWN_GRACE: Duration = Duration::from_secs(1);
/// How long a kill that escalated waits for the reader to report the exit.
const EXIT_REPORT: Duration = Duration::from_secs(1);
/// How often a kill looks whether the pane's process group is empty.
#[cfg(unix)]
const GROUP_POLL: Duration = Duration::from_millis(20);

#[cfg(unix)]
const READ_WRITE_TOKEN: usize = 0; // alacritty's `tty::unix::PTY_READ_WRITE_TOKEN` (crate-private)
#[cfg(unix)]
const CHILD_EVENT_TOKEN: usize = 1; // alacritty's `tty::unix::PTY_CHILD_EVENT_TOKEN` (crate-private)
#[cfg(windows)]
use alacritty_terminal::tty::{
    PTY_CHILD_EVENT_TOKEN as CHILD_EVENT_TOKEN, PTY_READ_WRITE_TOKEN as READ_WRITE_TOKEN,
};

#[derive(Debug, Clone, Default)]
pub struct PaneSpec {
    pub command: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaneEvent {
    Output { seq: u64, bytes: Arc<[u8]> },
    Exited { status: Option<i32> },
    Title(String),
}

/// Mirrors the fields of `PaneMeta` in `cli/src/lib/tmuxStream.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PaneMeta {
    pub cols: u16,
    pub rows: u16,
    pub alternate_on: bool,
    pub cursor_x: u16,
    pub cursor_y: u16,
    pub cursor_visible: bool,
    pub mouse_standard: bool,
    pub mouse_button: bool,
    pub mouse_all: bool,
    pub mouse_utf8: bool,
    pub mouse_sgr: bool,
}

/// A pane's screen at one sequence number (`Pane::snapshot`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub seq: u64,
    pub capture: String,
    pub history: String,
    pub meta: PaneMeta,
}

struct Size {
    cols: u16,
    rows: u16,
}

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows as usize
    }
    fn screen_lines(&self) -> usize {
        self.rows as usize
    }
    fn columns(&self) -> usize {
        self.cols as usize
    }
}

fn window_size(cols: u16, rows: u16) -> WindowSize {
    WindowSize {
        num_lines: rows,
        num_cols: cols,
        cell_width: 1,
        cell_height: 1,
    }
}

/// Synchronized updates (`CSI ? 2026 h`) are not buffered: every byte read reaches the grid
/// before its `seq` is published, which the snapshot cut relies on.
#[derive(Default)]
struct NoSync;

impl Timeout for NoSync {
    fn set_timeout(&mut self, _: Duration) {}
    fn clear_timeout(&mut self) {}
    fn pending_timeout(&self) -> bool {
        false
    }
}

fn meta(term: &Term<Listener>) -> PaneMeta {
    let mode = *term.mode();
    let point = term.grid().cursor.point;
    PaneMeta {
        cols: term.columns() as u16,
        rows: term.screen_lines() as u16,
        alternate_on: mode.contains(TermMode::ALT_SCREEN),
        cursor_x: point.column.0 as u16,
        cursor_y: point.line.0.max(0) as u16,
        cursor_visible: mode.contains(TermMode::SHOW_CURSOR),
        mouse_standard: mode.contains(TermMode::MOUSE_REPORT_CLICK),
        mouse_button: mode.contains(TermMode::MOUSE_DRAG),
        mouse_all: mode.contains(TermMode::MOUSE_MOTION),
        mouse_utf8: mode.contains(TermMode::UTF8_MOUSE),
        mouse_sgr: mode.contains(TermMode::SGR_MOUSE),
    }
}

/// The grid and the sequence number of the last output it contains, behind one lock.
struct Screen {
    term: Term<Listener>,
    seq: u64,
}

/// State the `Term`'s listener and the pane share; it outlives any one child.
#[derive(Default)]
struct Shared {
    /// Events the `Term` raised while the reader thread held the screen lock. The reader thread
    /// handles them after releasing it.
    pending: Mutex<Vec<Event>>,
    title: Mutex<String>,
    /// The last OSC 7 path the current child reported.
    cwd: Mutex<Option<String>>,
}

#[derive(Clone)]
struct Listener(Arc<Shared>);

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        if matches!(
            event,
            Event::Title(_) | Event::ResetTitle | Event::PtyWrite(_)
        ) {
            lock(&self.0.pending).push(event);
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Whether the current child has exited, and with what status.
#[derive(Default)]
struct Life {
    exited: Mutex<Option<Option<i32>>>,
    changed: Condvar,
}

impl Life {
    fn set(&self, status: Option<i32>) {
        *lock(&self.exited) = Some(status);
        self.changed.notify_all();
    }

    fn has_exited(&self) -> bool {
        lock(&self.exited).is_some()
    }

    /// Wait up to `timeout` for the child to exit; whether it has.
    fn wait(&self, timeout: Duration) -> bool {
        let guard = lock(&self.exited);
        let (guard, _) = self
            .changed
            .wait_timeout_while(guard, timeout, |e| e.is_none())
            .unwrap_or_else(|e| e.into_inner());
        guard.is_some()
    }
}

/// Messages to the reader thread, which owns the tty.
enum Msg {
    Input(Vec<u8>),
    Resize(WindowSize),
    /// The pane was dropped: stop without reporting an exit.
    Shutdown,
    /// Windows `kill`: close the pseudo console, then report the child's exit.
    #[cfg(windows)]
    Hangup,
}

/// The current child: how to reach its reader thread, and its process.
#[derive(Clone)]
struct Attachment {
    tx: Sender<Msg>,
    poller: Arc<Poller>,
    pid: Option<u32>,
    life: Arc<Life>,
    /// The child's terminal device (`/dev/pts/3`, `/dev/ttys004`); empty where there is none.
    tty: String,
    #[cfg(windows)]
    process: Arc<std::os::windows::io::OwnedHandle>,
}

impl Attachment {
    fn send(&self, msg: Msg) -> io::Result<()> {
        self.tx
            .send(msg)
            .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
        self.poller.notify()
    }
}

pub struct Pane {
    id: String,
    screen: Arc<Mutex<Screen>>,
    shared: Arc<Shared>,
    attachment: Mutex<Attachment>,
    /// The directory the current child was spawned in.
    spawn_cwd: Mutex<Option<String>>,
    /// Where every child of this pane reports its events (a respawn attaches with it).
    sink: Sender<(String, PaneEvent)>,
}

impl Pane {
    pub fn spawn(
        id: String,
        spec: PaneSpec,
        history_limit: usize,
        sink: Sender<(String, PaneEvent)>,
    ) -> io::Result<Pane> {
        let (cols, rows) = (spec.cols.max(1), spec.rows.max(1));
        let shared = Arc::new(Shared::default());
        let config = Config {
            scrolling_history: history_limit,
            ..Config::default()
        };
        let term = Term::new(config, &Size { cols, rows }, Listener(shared.clone()));
        let screen = Arc::new(Mutex::new(Screen { term, seq: 0 }));
        let attachment = attach(&id, &spec, cols, rows, &screen, &shared, sink.clone())?;
        Ok(Pane {
            id,
            screen,
            shared,
            attachment: Mutex::new(attachment),
            spawn_cwd: Mutex::new(spec.cwd.map(|p| p.to_string_lossy().into_owned())),
            sink,
        })
    }

    /// Start `spec`'s command in this pane once its child has exited (tmux `respawn-pane`): the
    /// new child draws into the same grid, continuing its sequence. `spec.cwd` defaults to the
    /// previous child's spawn directory; the size is the pane's.
    pub fn respawn(&self, mut spec: PaneSpec) -> io::Result<()> {
        let mut attachment = lock(&self.attachment);
        if !attachment.life.has_exited() {
            return Err(io::Error::other("the pane's process is still running"));
        }
        let (cols, rows) = {
            let screen = lock(&self.screen);
            (
                screen.term.columns() as u16,
                screen.term.screen_lines() as u16,
            )
        };
        if spec.cwd.is_none() {
            spec.cwd = lock(&self.spawn_cwd).as_ref().map(PathBuf::from);
        }
        *attachment = attach(
            &self.id,
            &spec,
            cols,
            rows,
            &self.screen,
            &self.shared,
            self.sink.clone(),
        )?;
        *lock(&self.spawn_cwd) = spec.cwd.map(|p| p.to_string_lossy().into_owned());
        Ok(())
    }

    fn attachment(&self) -> Attachment {
        lock(&self.attachment).clone()
    }

    /// Queue bytes for the child. Fails only once the reader thread is gone.
    pub fn write(&self, bytes: &[u8]) -> io::Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        self.attachment().send(Msg::Input(bytes.to_vec()))
    }

    /// Resize the grid, then tell the child. Returns the sequence number of the last output drawn
    /// at the old size: every later output reaches the grid at the new one. (A resize does not
    /// take a sequence number of its own.)
    pub fn resize(&self, cols: u16, rows: u16) -> u64 {
        let (cols, rows) = (cols.max(1), rows.max(1));
        let seq = {
            let mut screen = lock(&self.screen);
            screen.term.resize(Size { cols, rows });
            screen.seq
        };
        let _ = self.attachment().send(Msg::Resize(window_size(cols, rows)));
        seq
    }

    /// The grid's size, as (cols, rows).
    pub fn size(&self) -> (u16, u16) {
        let screen = lock(&self.screen);
        (
            screen.term.columns() as u16,
            screen.term.screen_lines() as u16,
        )
    }

    /// Under one lock: the grid's capture and the sequence number of the last output it contains.
    pub fn capture(&self, history_lines: Option<u32>, ansi: bool) -> (String, u64) {
        let screen = lock(&self.screen);
        (
            harness_term::capture::capture_pane(screen.term.grid(), history_lines, ansi),
            screen.seq,
        )
    }

    pub fn meta(&self) -> PaneMeta {
        meta(&lock(&self.screen).term)
    }

    /// Under one lock, for a stream keyframe: the visible screen, the last `history_lines` lines
    /// of the history above it (none when 0), the metadata, and the sequence number of the last
    /// output they contain. Both texts are what `tmux capture-pane -p -e -J` prints.
    pub fn snapshot(&self, history_lines: u32) -> Snapshot {
        let screen = lock(&self.screen);
        let grid = screen.term.grid();
        let depth = (history_lines as usize).min(grid.history_size()) as i32;
        let history = if depth == 0 {
            String::new()
        } else {
            let flags = harness_term::capture::Flags2 {
                join: true,
                sequences: true,
                escape: false,
                empty_cells: false,
                trim: false,
            };
            harness_term::capture::history(grid, -depth, -1, flags)
        };
        Snapshot {
            seq: screen.seq,
            capture: harness_term::capture::capture_pane(grid, None, true),
            history,
            meta: meta(&screen.term),
        }
    }

    /// The child's pid while it runs.
    pub fn root_pid(&self) -> Option<u32> {
        let attachment = self.attachment();
        if attachment.life.has_exited() {
            None
        } else {
            attachment.pid
        }
    }

    pub fn title(&self) -> String {
        lock(&self.shared.title).clone()
    }

    /// Set the title (tmux `select-pane -T`); the child's next OSC 0/2 replaces it.
    pub fn set_title(&self, title: &str) {
        *lock(&self.shared.title) = title.to_owned();
    }

    /// The terminal modes the pane's program set (cursor keys, bracketed paste, …).
    pub fn mode(&self) -> TermMode {
        *lock(&self.screen).term.mode()
    }

    /// The current child's terminal device; empty where there is none (Windows).
    pub fn tty(&self) -> String {
        self.attachment().tty
    }

    /// The last directory the child reported with OSC 7, else the directory it was spawned in.
    pub fn cwd(&self) -> Option<String> {
        // One lock at a time: `respawn` takes them in the other order.
        let reported = lock(&self.shared.cwd).clone();
        reported.or_else(|| lock(&self.spawn_cwd).clone())
    }

    /// Send a kill's first signal; `Killing::finish` waits out the grace and escalates. `None`
    /// when the child had already exited: it is left alone, as its pid (and so the group id) may
    /// since belong to another process.
    ///
    /// Unix: SIGHUP to the child's process group, as closing a tmux pane's tty does.
    #[cfg(unix)]
    pub fn start_kill(&self) -> Option<Killing> {
        let attachment = self.attachment();
        let pid = attachment.pid?;
        if attachment.life.has_exited() {
            return None;
        }
        // `tty::new` makes the child a session (and process group) leader: pgid == pid. Until
        // the child is reaped, and then while any process is in the group, the id is not reused.
        let group = pid as libc::pid_t;
        unsafe { libc::kill(-group, libc::SIGHUP) };
        Some(Killing { attachment, group })
    }

    /// Windows: close the pseudo console (the console's processes get CTRL_CLOSE_EVENT).
    /// Task 16 replaces this with a Job.
    #[cfg(windows)]
    pub fn start_kill(&self) -> Option<Killing> {
        let attachment = self.attachment();
        if attachment.life.has_exited() {
            return None;
        }
        let _ = attachment.send(Msg::Hangup);
        Some(Killing { attachment })
    }

    /// `start_kill`, then `Killing::finish`.
    pub fn kill(&self, grace: Duration) {
        if let Some(killing) = self.start_kill() {
            killing.finish(grace);
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }
}

impl Drop for Pane {
    fn drop(&mut self) {
        let _ = self.attachment().send(Msg::Shutdown);
    }
}

/// A kill whose first signal is sent. It holds the child's attachment, not the pane.
pub struct Killing {
    attachment: Attachment,
    #[cfg(unix)]
    group: libc::pid_t,
}

impl Killing {
    /// Unix: after `grace`, SIGKILL the group if anything in it still runs, so a descendant
    /// that ignores SIGHUP does not outlive the pane. Returns once the child has exited and the
    /// group is empty, at most after `grace` (plus `EXIT_REPORT` after a SIGKILL).
    #[cfg(unix)]
    pub fn finish(self, grace: Duration) {
        let Killing { attachment, group } = self;
        let deadline = std::time::Instant::now() + grace;
        loop {
            let exited = attachment.life.has_exited();
            if exited && !group_alive(group) {
                return;
            }
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                unsafe { libc::kill(-group, libc::SIGKILL) };
                // Until the reader has seen the exit: a pane dropped before that ends its
                // reader without reporting one.
                attachment.life.wait(EXIT_REPORT);
                return;
            }
            if exited {
                std::thread::sleep(left.min(GROUP_POLL));
            } else {
                attachment.life.wait(left.min(GROUP_POLL));
            }
        }
    }

    /// Windows: after `grace`, terminate the child if it is still running.
    #[cfg(windows)]
    pub fn finish(self, grace: Duration) {
        use std::os::windows::io::AsRawHandle;
        let attachment = self.attachment;
        if !attachment.life.wait(grace) {
            unsafe {
                windows_sys::Win32::System::Threading::TerminateProcess(
                    attachment.process.as_raw_handle() as _,
                    1,
                )
            };
            attachment.life.wait(EXIT_REPORT);
        }
    }
}

/// Spawn `spec`'s command on a new tty and start its reader thread.
fn attach(
    id: &str,
    spec: &PaneSpec,
    cols: u16,
    rows: u16,
    screen: &Arc<Mutex<Screen>>,
    shared: &Arc<Shared>,
    sink: Sender<(String, PaneEvent)>,
) -> io::Result<Attachment> {
    let (program, args) = spec
        .command
        .split_first()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "empty command"))?;
    #[allow(unused_mut)]
    let mut env = spec.env.clone();
    #[cfg(unix)]
    {
        // tmux gives its panes a TERM; the host's own may be absent or wrong.
        env.entry("TERM".into())
            .or_insert_with(|| "xterm-256color".into());
        env.entry("COLORTERM".into())
            .or_insert_with(|| "truecolor".into());
    }
    // alacritty's Unix `tty::new` puts its window variables in the child's environment; panes
    // should look like tmux panes, so `env -u` takes them out (as hn's local panes do). `env`
    // execs the command: the pid stays the child's.
    #[cfg(unix)]
    let (program, args) = (
        &"/usr/bin/env".to_owned(),
        ["-u", "ALACRITTY_WINDOW_ID", "-u", "WINDOWID", "--", program]
            .into_iter()
            .map(str::to_owned)
            .chain(args.iter().cloned())
            .collect::<Vec<_>>(),
    );
    let options = Options {
        shell: Some(Shell::new(program.clone(), args.to_vec())),
        working_directory: spec.cwd.clone(),
        env,
        drain_on_exit: true,
        // `command` is an argv: quote each argument by the C runtime's rules.
        #[cfg(windows)]
        escape_args: true,
    };

    let mut pty = tty::new(&options, window_size(cols, rows), 0)?;
    #[cfg(unix)]
    let pid = Some(pty.child().id());
    #[cfg(unix)]
    let tty = {
        use std::os::fd::AsRawFd;
        crate::unix_proc::tty_name(pty.file().as_raw_fd()).unwrap_or_default()
    };
    #[cfg(windows)]
    let tty = String::new();
    #[cfg(windows)]
    let pid = pty.child_watcher().pid().map(|p| p.get());
    #[cfg(windows)]
    let process = Arc::new(duplicate_process_handle(
        pty.child_watcher().raw_handle() as _
    )?);

    let poller = Arc::new(Poller::new()?);
    let interest = PollEvent::readable(READ_WRITE_TOKEN);
    // SAFETY: the reader thread deregisters before it drops the pty.
    unsafe { pty.register(&poller, interest, PollMode::Level)? };

    let (tx, rx) = mpsc::channel();
    let life = Arc::new(Life::default());
    *lock(&shared.cwd) = None;
    let reader = Reader {
        id: id.to_owned(),
        pty,
        poller: poller.clone(),
        rx,
        screen: screen.clone(),
        shared: shared.clone(),
        sink,
        life: life.clone(),
        parser: Processor::new(),
        osc7: Osc7Scanner::default(),
        writes: VecDeque::new(),
        written: 0,
        interest,
        eof: false,
        #[cfg(windows)]
        process: process.clone(),
    };
    std::thread::Builder::new()
        .name(format!("pty-reader {id}"))
        .spawn(move || reader.run())?;
    Ok(Attachment {
        tx,
        poller,
        pid,
        life,
        tty,
        #[cfg(windows)]
        process,
    })
}

#[cfg(windows)]
fn duplicate_process_handle(
    raw: windows_sys::Win32::Foundation::HANDLE,
) -> io::Result<std::os::windows::io::OwnedHandle> {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    let mut out: HANDLE = std::ptr::null_mut();
    let ok = unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            raw,
            GetCurrentProcess(),
            &mut out,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(out as _) })
}

fn exit_code(status: ExitStatus) -> Option<i32> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        // A signal death reads as a shell does: 128 + signal.
        status.code().or_else(|| status.signal().map(|s| 128 + s))
    }
    #[cfg(not(unix))]
    {
        status.code()
    }
}

/// How the reader loop ended.
enum End {
    /// The child exited and `Exited` was sent.
    Exited,
    /// The pane was dropped.
    Shutdown,
    #[cfg(windows)]
    Hangup,
    /// The poller or tty failed; the child's fate is unknown.
    Failed,
}

/// The reader thread: owns the tty, follows `alacritty_terminal::event_loop`.
struct Reader {
    id: String,
    pty: tty::Pty,
    poller: Arc<Poller>,
    rx: Receiver<Msg>,
    screen: Arc<Mutex<Screen>>,
    shared: Arc<Shared>,
    sink: Sender<(String, PaneEvent)>,
    life: Arc<Life>,
    parser: Processor<NoSync>,
    osc7: Osc7Scanner,
    /// Bytes waiting for the tty: input and terminal replies, in order.
    writes: VecDeque<Vec<u8>>,
    /// How much of `writes.front()` is written.
    written: usize,
    interest: PollEvent,
    /// Unix: the tty hung up (all of the child's side closed); it is no longer polled.
    eof: bool,
    #[cfg(windows)]
    process: Arc<std::os::windows::io::OwnedHandle>,
}

impl Reader {
    fn run(mut self) {
        let end = self.event_loop();
        #[cfg(unix)]
        if let End::Shutdown = end {
            self.end_child();
        }
        if !(cfg!(unix) && self.eof) {
            let _ = self.pty.deregister(&self.poller);
        }
        let Reader {
            pty,
            life,
            sink,
            id,
            #[cfg(windows)]
            process,
            ..
        } = self;
        // Unix: SIGHUP to the child, then reap it (alacritty's `Pty::drop`; after `end_child` on
        // a shutdown, so the reap cannot block).
        // Windows: ClosePseudoConsole; the console's processes get CTRL_CLOSE_EVENT.
        drop(pty);
        let status = match end {
            End::Exited | End::Shutdown => return,
            End::Failed => {
                log::error!("pane {id}: reader stopped");
                None
            }
            #[cfg(windows)]
            End::Hangup => wait_process(&process),
        };
        life.set(status);
        let _ = sink.send((id, PaneEvent::Exited { status }));
    }

    fn event_loop(&mut self) -> End {
        let mut events = Events::new();
        let mut buf = vec![0u8; READ_CHUNK];
        loop {
            events.clear();
            if let Err(err) = self.poller.wait(&mut events, None) {
                if err.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                log::error!("pane {}: poll failed: {err}", self.id);
                return End::Failed;
            }

            while let Ok(msg) = self.rx.try_recv() {
                match msg {
                    Msg::Input(bytes) => self.writes.push_back(bytes),
                    Msg::Resize(size) => self.pty.on_resize(size),
                    Msg::Shutdown => return End::Shutdown,
                    #[cfg(windows)]
                    Msg::Hangup => return End::Hangup,
                }
            }

            for event in events.iter() {
                match event.key {
                    CHILD_EVENT_TOKEN => {
                        if let Some(ChildEvent::Exited(status)) = self.pty.next_child_event() {
                            // Drain what the child wrote before it exited.
                            self.read(&mut buf);
                            let status = status.and_then(exit_code);
                            self.life.set(status);
                            let _ = self
                                .sink
                                .send((self.id.clone(), PaneEvent::Exited { status }));
                            return End::Exited;
                        }
                    }
                    READ_WRITE_TOKEN => {
                        if event.is_interrupt() {
                            // epoll/poll hang-up: no process has the tty open any more. It stays
                            // reported (level-triggered) until the tty is closed, so drain it and
                            // stop polling it; the child's exit still ends the loop.
                            #[cfg(unix)]
                            {
                                self.read(&mut buf);
                                self.hang_up();
                            }
                            continue;
                        }
                        if event.readable {
                            self.read(&mut buf);
                        }
                    }
                    _ => {}
                }
            }

            // Write eagerly: input and replies usually fit without waiting for writability.
            self.write();
            if let Err(err) = self.update_interest() {
                log::error!("pane {}: poll registration failed: {err}", self.id);
                return End::Failed;
            }
        }
    }

    /// Read what the tty has (bounded per wakeup) into the grid.
    fn read(&mut self, buf: &mut [u8]) {
        if self.eof {
            return;
        }
        let mut total = 0;
        while total < READ_PER_WAKEUP {
            match self.pty.reader().read(buf) {
                // Unix: end of file, the child's side closed. Windows: nothing buffered right now.
                Ok(0) => {
                    #[cfg(unix)]
                    self.hang_up();
                    break;
                }
                Ok(n) => {
                    total += n;
                    self.ingest(&buf[..n]);
                }
                Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => break,
                Err(err) => {
                    // Linux reports a hung-up tty as EIO.
                    #[cfg(unix)]
                    {
                        if err.raw_os_error() != Some(libc::EIO) {
                            log::error!("pane {}: tty read failed: {err}", self.id);
                        }
                        self.hang_up();
                    }
                    #[cfg(windows)]
                    log::error!("pane {}: tty read failed: {err}", self.id);
                    break;
                }
            }
        }
    }

    /// Stop polling a tty whose other side closed: it would report readable (or hang-up) forever.
    /// The loop keeps waiting for the child's exit.
    #[cfg(unix)]
    fn hang_up(&mut self) {
        if !self.eof {
            self.eof = true;
            self.writes.clear();
            self.written = 0;
            let _ = self.poller.delete(self.pty.file());
        }
    }

    /// The pane was dropped while its child runs: SIGHUP the child's process group, and SIGKILL
    /// the group if the child, or anything else in the group, still runs after `SHUTDOWN_GRACE`,
    /// so the reap in `Pty::drop` cannot block this thread forever and no descendant that ignores
    /// SIGHUP outlives the pane. Runs here, not in the dropping caller.
    #[cfg(unix)]
    fn end_child(&mut self) {
        // The tty is not read any more; left in the poller, its data would wake every wait.
        self.hang_up();
        let group = self.pty.child().id() as libc::pid_t;
        unsafe { libc::kill(-group, libc::SIGHUP) };
        let deadline = std::time::Instant::now() + SHUTDOWN_GRACE;
        let exited = self.wait_child(SHUTDOWN_GRACE);
        // Reaped: the group id stays reserved only while the group has a member.
        while exited && group_alive(group) && std::time::Instant::now() < deadline {
            std::thread::sleep(GROUP_POLL);
        }
        if !exited || group_alive(group) {
            unsafe { libc::kill(-group, libc::SIGKILL) };
            if !exited {
                self.wait_child(SHUTDOWN_GRACE);
            }
        }
    }

    /// Wait up to `timeout` for the child to exit, on the poller (SIGCHLD); whether it has.
    #[cfg(unix)]
    fn wait_child(&mut self, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        let mut events = Events::new();
        loop {
            if let Some(ChildEvent::Exited(_)) = self.pty.next_child_event() {
                return true;
            }
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                return false;
            }
            events.clear();
            let _ = self.poller.wait(&mut events, Some(left));
        }
    }

    fn ingest(&mut self, bytes: &[u8]) {
        let seq = {
            let mut screen = lock(&self.screen);
            let Screen { term, seq } = &mut *screen;
            self.parser.advance(term, bytes);
            *seq += 1;
            *seq
        };
        if let Some(path) = self.osc7.feed(bytes) {
            *lock(&self.shared.cwd) = Some(path);
        }
        let _ = self.sink.send((
            self.id.clone(),
            PaneEvent::Output {
                seq,
                bytes: Arc::from(bytes),
            },
        ));

        let pending = std::mem::take(&mut *lock(&self.shared.pending));
        for event in pending {
            match event {
                Event::PtyWrite(reply) => self.writes.push_back(reply.into_bytes()),
                Event::Title(title) => self.set_title(title),
                Event::ResetTitle => self.set_title(String::new()),
                _ => {}
            }
        }
    }

    fn set_title(&self, title: String) {
        *lock(&self.shared.title) = title.clone();
        let _ = self.sink.send((self.id.clone(), PaneEvent::Title(title)));
    }

    fn write(&mut self) {
        if self.eof {
            return;
        }
        while let Some(front) = self.writes.front() {
            match self.pty.writer().write(&front[self.written..]) {
                Ok(0) => break,
                Ok(n) => {
                    self.written += n;
                    if self.written >= front.len() {
                        self.writes.pop_front();
                        self.written = 0;
                    }
                }
                Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => break,
                Err(err) => {
                    log::error!("pane {}: tty write failed: {err}", self.id);
                    self.writes.clear();
                    self.written = 0;
                    break;
                }
            }
        }
    }

    fn update_interest(&mut self) -> io::Result<()> {
        if self.eof {
            return Ok(());
        }
        let writable = !self.writes.is_empty();
        if writable != self.interest.writable {
            self.interest.writable = writable;
            self.pty
                .reregister(&self.poller, self.interest, PollMode::Level)?;
        }
        Ok(())
    }
}

/// Whether any process is in process group `group`.
#[cfg(unix)]
fn group_alive(group: libc::pid_t) -> bool {
    // EPERM: a member exists that this process may not signal.
    let probe = unsafe { libc::kill(-group, 0) };
    probe == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn wait_process(process: &std::os::windows::io::OwnedHandle) -> Option<i32> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, INFINITE, WaitForSingleObject,
    };
    let handle = process.as_raw_handle() as _;
    let mut code = 0u32;
    unsafe {
        WaitForSingleObject(handle, INFINITE);
        if GetExitCodeProcess(handle, &mut code) == 0 {
            return None;
        }
    }
    Some(code as i32)
}

/// Finds `OSC 7 ; file://host/path` (ended by BEL, ST or a bare ESC as in vte) in a byte
/// stream that may be split anywhere, and returns its percent-decoded path.
#[derive(Debug, Default)]
pub struct Osc7Scanner {
    state: Osc7State,
    body: Vec<u8>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum Osc7State {
    #[default]
    Ground,
    Esc,
    /// `ESC ]` seen.
    Osc,
    /// `ESC ] 7` seen.
    Seven,
    /// In the body, after `ESC ] 7 ;`.
    Body,
    /// In a body too long to be a path: skip to its end.
    Skip,
}

/// Longer OSC 7 bodies are ignored.
const OSC7_MAX: usize = 4096;

impl Osc7Scanner {
    /// Feed the next chunk; the last path completed in it, if any.
    pub fn feed(&mut self, bytes: &[u8]) -> Option<String> {
        use Osc7State::*;
        let mut found = None;
        for &b in bytes {
            match (self.state, b) {
                (Body | Skip, 0x07) => {
                    if self.state == Body {
                        found = parse_file_url(&self.body).or(found);
                    }
                    self.state = Ground;
                }
                (Body | Skip, 0x1b) => {
                    // ST is `ESC \`; vte ends the string at the ESC either way.
                    if self.state == Body {
                        found = parse_file_url(&self.body).or(found);
                    }
                    self.state = Esc;
                }
                (Body | Skip, 0x18 | 0x1a) => self.state = Ground, // CAN, SUB: abort
                (Body | Skip, 0x00..=0x1f) => {}                   // other C0: ignored, as vte does
                (Body, _) => {
                    if self.body.len() < OSC7_MAX {
                        self.body.push(b);
                    } else {
                        self.state = Skip;
                    }
                }
                (Skip, _) => {}
                (_, 0x1b) => self.state = Esc,
                (Esc, b']') => self.state = Osc,
                (Osc, b'7') => self.state = Seven,
                (Seven, b';') => {
                    self.body.clear();
                    self.state = Body;
                }
                _ => self.state = Ground,
            }
        }
        found
    }
}

fn parse_file_url(body: &[u8]) -> Option<String> {
    let rest = body.strip_prefix(b"file://")?;
    let path = &rest[rest.iter().position(|&b| b == b'/')?..];
    let mut out = Vec::with_capacity(path.len());
    let mut i = 0;
    while i < path.len() {
        let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
        if path[i] == b'%'
            && let (Some(&h), Some(&l)) = (path.get(i + 1), path.get(i + 2))
            && let (Some(h), Some(l)) = (hex(h), hex(l))
        {
            out.push(h << 4 | l);
            i += 3;
            continue;
        }
        out.push(path[i]);
        i += 1;
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}

#[cfg(test)]
mod osc7_tests {
    use super::Osc7Scanner;

    fn scan_split(stream: &[u8]) -> Vec<Option<String>> {
        // Every split point gives the same result as one chunk.
        let whole = Osc7Scanner::default().feed(stream);
        for at in 0..=stream.len() {
            let mut s = Osc7Scanner::default();
            let a = s.feed(&stream[..at]);
            let b = s.feed(&stream[at..]);
            assert_eq!(b.or(a), whole, "split at {at}");
        }
        let mut s = Osc7Scanner::default();
        stream
            .iter()
            .map(|b| s.feed(std::slice::from_ref(b)))
            .collect()
    }

    fn scan(stream: &[u8]) -> Option<String> {
        scan_split(stream);
        Osc7Scanner::default().feed(stream)
    }

    #[test]
    fn bel_and_st_terminated() {
        assert_eq!(
            scan(b"x\x1b]7;file://host/tmp/a\x07y").as_deref(),
            Some("/tmp/a")
        );
        assert_eq!(
            scan(b"\x1b]7;file://host/tmp/b\x1b\\").as_deref(),
            Some("/tmp/b")
        );
        assert_eq!(
            scan(b"\x1b]7;file:///no/host\x07").as_deref(),
            Some("/no/host")
        );
    }

    #[test]
    fn byte_at_a_time_reports_on_the_terminator() {
        let got = scan_split(b"ab\x1b]7;file://h/p\x07cd");
        let at = got.iter().position(Option::is_some).unwrap();
        assert_eq!(at, 2 + 4 + "file://h/p".len()); // the BEL
        assert_eq!(got[at].as_deref(), Some("/p"));
    }

    #[test]
    fn percent_decoding_and_the_last_path_wins() {
        assert_eq!(
            scan(b"\x1b]7;file://h/one\x07\x1b]7;file://h/a%20b/%E2%9C%93\x07").as_deref(),
            Some("/a b/\u{2713}")
        );
        assert_eq!(
            scan(b"\x1b]7;file://h/bad%zz\x07").as_deref(),
            Some("/bad%zz")
        );
    }

    #[test]
    fn state_carries_across_chunks() {
        let mut s = Osc7Scanner::default();
        assert_eq!(s.feed(b"\x1b]"), None);
        assert_eq!(s.feed(b"7;file://h/sp"), None);
        // ST's ESC ends the string (as in vte); its `\` then comes in the next chunk.
        assert_eq!(s.feed(b"lit\x1b").as_deref(), Some("/split"));
        assert_eq!(s.feed(b"\\"), None);
        assert_eq!(
            s.feed(b"\x1b]7;file://h/next\x07").as_deref(),
            Some("/next")
        );
    }

    #[test]
    fn other_sequences_are_ignored() {
        assert_eq!(
            scan(b"\x1b]0;title\x07\x1b]8;;file://h/x\x07\x1b[7;1H"),
            None
        );
        assert_eq!(scan(b"\x1b]7;https://h/x\x07"), None);
        assert_eq!(scan(b"\x1b]7;file://h/x\x18\x07"), None); // CAN aborts
        assert_eq!(
            scan(b"\x1b\x1b]7;file://h/esc\x07").as_deref(),
            Some("/esc")
        );
        assert_eq!(scan(b"\x1b]77;file://h/x\x07"), None);
    }

    #[test]
    fn overlong_bodies_are_skipped() {
        let mut stream = b"\x1b]7;file://h/".to_vec();
        stream.extend(std::iter::repeat_n(b'a', 5000));
        stream.extend(b"\x07\x1b]7;file://h/ok\x07");
        let mut s = Osc7Scanner::default();
        assert_eq!(s.feed(&stream).as_deref(), Some("/ok"));
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;
    use std::time::{Duration, Instant};

    fn wait_for(
        rx: &std::sync::mpsc::Receiver<(String, PaneEvent)>,
        pred: impl Fn(&PaneEvent) -> bool,
    ) -> bool {
        let end = Instant::now() + Duration::from_secs(5);
        while Instant::now() < end {
            if let Ok((_, ev)) = rx.recv_timeout(Duration::from_millis(100))
                && pred(&ev)
            {
                return true;
            }
        }
        false
    }

    fn sh(script: &str) -> PaneSpec {
        PaneSpec {
            command: vec!["/bin/sh".into(), "-c".into(), script.into()],
            cwd: None,
            env: HashMap::new(),
            cols: 40,
            rows: 10,
        }
    }

    /// Wait until the visible screen contains `needle`; the screen then.
    fn wait_text(pane: &Pane, rx: &Receiver<(String, PaneEvent)>, needle: &str) -> String {
        let end = Instant::now() + Duration::from_secs(5);
        loop {
            let (text, _) = pane.capture(None, false);
            if text.contains(needle) {
                return text;
            }
            assert!(Instant::now() < end, "no {needle:?} in {text:?}");
            let _ = rx.recv_timeout(Duration::from_millis(100));
        }
    }

    #[test]
    fn output_reaches_grid_and_sink_with_increasing_seq() {
        let (tx, rx) = channel();
        let pane = Pane::spawn(
            "%1".into(),
            PaneSpec {
                command: vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "printf hello; sleep 1".into(),
                ],
                cwd: None,
                env: HashMap::new(),
                cols: 40,
                rows: 10,
            },
            1000,
            tx,
        )
        .unwrap();
        assert!(wait_for(&rx, |e| matches!(e, PaneEvent::Output { .. })));
        let (text, seq) = pane.capture(None, false);
        assert!(text.starts_with("hello"), "{text:?}");
        assert!(seq >= 1);
    }

    #[test]
    fn exit_is_reported_with_status() {
        let (tx, rx) = channel();
        let _pane = Pane::spawn(
            "%2".into(),
            PaneSpec {
                command: vec!["/bin/sh".into(), "-c".into(), "exit 3".into()],
                cwd: None,
                env: HashMap::new(),
                cols: 40,
                rows: 10,
            },
            1000,
            tx,
        )
        .unwrap();
        assert!(wait_for(&rx, |e| matches!(
            e,
            PaneEvent::Exited { status: Some(3) }
        )));
    }

    #[test]
    fn output_seqs_increase_by_one_and_end_before_exit() {
        let (tx, rx) = channel();
        let _pane = Pane::spawn(
            "%3".into(),
            sh("for i in 1 2 3 4 5; do echo line$i; sleep 0.05; done"),
            1000,
            tx,
        )
        .unwrap();
        let mut seqs = Vec::new();
        let mut bytes = Vec::new();
        loop {
            match rx.recv_timeout(Duration::from_secs(5)).expect("no exit").1 {
                PaneEvent::Output { seq, bytes: b } => {
                    seqs.push(seq);
                    bytes.extend_from_slice(&b);
                }
                PaneEvent::Exited { status } => {
                    assert_eq!(status, Some(0));
                    break;
                }
                PaneEvent::Title(_) => {}
            }
        }
        assert_eq!(seqs, (1..=seqs.len() as u64).collect::<Vec<_>>());
        assert!(String::from_utf8_lossy(&bytes).contains("line5"));
    }

    #[test]
    fn terminal_queries_are_answered_to_the_child() {
        let (tx, rx) = channel();
        // DA1: the reply reaches the child's stdin; it prints the bytes it read in hex.
        let pane = Pane::spawn("%4".into(),
            sh(r#"stty -echo -icanon min 1 time 0; printf '\033[c'; r=$(dd bs=1 count=5 2>/dev/null | od -An -tx1); echo "reply:$r"; sleep 2"#),
            1000, tx).unwrap();
        let text = wait_text(&pane, &rx, "reply:");
        let reply: Vec<&str> = text
            .split("reply:")
            .nth(1)
            .unwrap()
            .split_whitespace()
            .collect();
        assert_eq!(&reply[..5], ["1b", "5b", "3f", "36", "63"], "{text:?}"); // ESC [ ? 6 c
    }

    #[test]
    fn write_and_resize_reach_the_child() {
        let (tx, rx) = channel();
        let pane = Pane::spawn(
            "%5".into(),
            sh("read x; echo got:$x; stty size; sleep 2"),
            1000,
            tx,
        )
        .unwrap();
        pane.resize(50, 12);
        assert_eq!((pane.meta().cols, pane.meta().rows), (50, 12));
        pane.write(b"abc\n").unwrap();
        let text = wait_text(&pane, &rx, "12 50");
        assert!(text.contains("got:abc"), "{text:?}");
    }

    #[test]
    fn title_cwd_and_meta() {
        let (tx, rx) = channel();
        let mut spec = sh(
            r#"printf '\033]2;my title\007\033]7;file://host/x%%20y\007\033[?1049h\033[?1000h\033[?1006h\033[?25l\033[3;5H'; sleep 2"#,
        );
        spec.cwd = Some("/".into());
        let pane = Pane::spawn("%6".into(), spec, 1000, tx).unwrap();
        assert_eq!(pane.cwd().as_deref(), Some("/"));
        assert!(pane.root_pid().is_some());
        assert!(wait_for(&rx, |e| *e == PaneEvent::Title("my title".into())));
        let end = Instant::now() + Duration::from_secs(5);
        while !pane.meta().alternate_on || pane.meta().cursor_y != 2 {
            assert!(Instant::now() < end, "{:?}", pane.meta());
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(pane.title(), "my title");
        assert_eq!(pane.cwd().as_deref(), Some("/x y"));
        let meta = pane.meta();
        assert_eq!(
            (meta.cursor_x, meta.cursor_y, meta.cursor_visible),
            (4, 2, false)
        );
        assert!(
            meta.mouse_standard
                && meta.mouse_sgr
                && !meta.mouse_all
                && !meta.mouse_button
                && !meta.mouse_utf8
        );
    }

    #[test]
    fn kill_hangs_up_then_returns_once_the_child_exits() {
        let (tx, rx) = channel();
        let pane = Pane::spawn("%7".into(), sh("echo ready; exec sleep 30"), 1000, tx).unwrap();
        wait_text(&pane, &rx, "ready");
        let start = Instant::now();
        pane.kill(Duration::from_secs(10));
        assert!(start.elapsed() < Duration::from_secs(5));
        assert!(wait_for(&rx, |e| *e
            == PaneEvent::Exited {
                status: Some(128 + libc::SIGHUP)
            }));
        assert_eq!(pane.root_pid(), None);
    }

    #[test]
    fn kill_escalates_to_sigkill_after_grace() {
        let (tx, rx) = channel();
        let pane = Pane::spawn(
            "%8".into(),
            sh("trap '' HUP; echo ready; while :; do sleep 1; done"),
            1000,
            tx,
        )
        .unwrap();
        wait_text(&pane, &rx, "ready");
        let start = Instant::now();
        pane.kill(Duration::from_millis(300));
        assert!(start.elapsed() >= Duration::from_millis(300));
        assert!(wait_for(&rx, |e| *e
            == PaneEvent::Exited {
                status: Some(128 + libc::SIGKILL)
            }));
    }

    #[test]
    fn scrollback_keeps_history_lines() {
        let (tx, rx) = channel();
        let pane = Pane::spawn(
            "%9".into(),
            sh("i=1; while [ $i -le 30 ]; do echo row$i; i=$((i+1)); done; sleep 2"),
            1000,
            tx,
        )
        .unwrap();
        wait_text(&pane, &rx, "row30");
        let (text, _) = pane.capture(Some(100), false);
        assert!(text.contains("row1\n"), "{text:?}");
    }

    #[test]
    fn exit_is_reported_after_the_child_closes_its_tty() {
        // The tty hangs up (no process has it open) a while before the child exits: the reader
        // stops polling it (else epoll reports the hang-up forever) and still sees the exit.
        let (tx, rx) = channel();
        let _pane = Pane::spawn(
            "%10".into(),
            sh("echo hi; exec sleep 1 </dev/null >/dev/null 2>&1"),
            1000,
            tx,
        )
        .unwrap();
        assert!(wait_for(&rx, |e| *e == PaneEvent::Exited { status: Some(0) }));
    }

    #[test]
    fn dropping_a_pane_ends_a_child_that_ignores_sighup_and_its_reader() {
        let (tx, rx) = channel();
        let pane = Pane::spawn(
            "%11".into(),
            sh("trap '' HUP; echo ready; sleep 30"),
            1000,
            tx,
        )
        .unwrap();
        wait_text(&pane, &rx, "ready");
        let pid = pane.root_pid().unwrap() as libc::pid_t;
        let start = Instant::now();
        drop(pane);
        assert!(
            start.elapsed() < Duration::from_millis(200),
            "drop blocked the caller"
        );
        // The reader thread holds the sink's only other sender: it is gone once the thread ends.
        let end = Instant::now() + Duration::from_secs(5);
        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                _ => assert!(Instant::now() < end, "reader thread still running"),
            }
        }
        // Reaped: the pid no longer exists.
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
    }

    fn gone(pid: libc::pid_t) -> bool {
        let end = Instant::now() + Duration::from_secs(5);
        while Instant::now() < end {
            if unsafe { libc::kill(pid, 0) } == -1
                && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn kill_ends_a_descendant_that_ignores_sighup() {
        // The root exits on SIGHUP at once; the sleep in its group ignores it.
        let (tx, rx) = channel();
        let pane = Pane::spawn(
            "%13".into(),
            sh(r#"sh -c 'trap "" HUP; echo "kid:$$:"; exec sleep 30' & wait"#),
            1000,
            tx,
        )
        .unwrap();
        let text = wait_text(&pane, &rx, "kid:");
        let kid: libc::pid_t = text
            .split("kid:")
            .nth(1)
            .unwrap()
            .split(':')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        let start = Instant::now();
        pane.kill(Duration::from_millis(300));
        assert!(
            start.elapsed() >= Duration::from_millis(250),
            "returned before the group was empty"
        );
        assert!(gone(kid), "a descendant outlived kill");
    }

    #[test]
    fn respawn_draws_into_the_same_grid_and_continues_the_sequence() {
        let (tx, rx) = channel();
        let mut spec = sh("echo first");
        spec.cwd = Some("/".into());
        let pane = Pane::spawn("%14".into(), spec, 1000, tx).unwrap();
        assert!(wait_for(&rx, |e| matches!(e, PaneEvent::Exited { .. })));
        let (_, seq) = pane.capture(None, false);
        assert!(pane.root_pid().is_none());
        pane.respawn(sh("pwd; echo second; sleep 2")).unwrap();
        assert!(pane.root_pid().is_some());
        // Not while the new child runs.
        assert!(pane.respawn(sh("true")).is_err());
        let text = wait_text(&pane, &rx, "second");
        assert!(text.contains("first"), "{text:?}");
        assert!(
            text.contains("\n/\n"),
            "the previous spawn directory: {text:?}"
        );
        assert!(pane.capture(None, false).1 > seq);
        assert_eq!(pane.cwd().as_deref(), Some("/"));
    }

    #[test]
    fn title_can_be_set_and_modes_and_tty_are_read() {
        let (tx, rx) = channel();
        let pane = Pane::spawn(
            "%15".into(),
            sh(r#"printf '\033[?2004h\033[?1hready'; sleep 2"#),
            1000,
            tx,
        )
        .unwrap();
        wait_text(&pane, &rx, "ready");
        let mode = pane.mode();
        assert!(mode.contains(TermMode::BRACKETED_PASTE) && mode.contains(TermMode::APP_CURSOR));
        pane.set_title("set");
        assert_eq!(pane.title(), "set");
        assert!(pane.tty().starts_with("/dev/"), "{:?}", pane.tty());
    }

    #[test]
    fn children_do_not_see_the_pty_library_window_variables() {
        let (tx, rx) = channel();
        let pane = Pane::spawn(
            "%12".into(),
            sh(r#"echo "w=${WINDOWID-unset} a=${ALACRITTY_WINDOW_ID-unset}"; sleep 2"#),
            1000,
            tx,
        )
        .unwrap();
        let text = wait_text(&pane, &rx, "w=");
        assert!(text.contains("w=unset a=unset"), "{text:?}");
    }
}
