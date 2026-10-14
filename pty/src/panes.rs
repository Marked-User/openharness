//! The pane table: ids, owner tags, held panes, and the control ops over them.
//!
//! Every pane's events reach one channel (`Panes::new` returns its receiver); one dispatcher
//! thread feeds them to `Panes::event`, which keeps the table's view of exits current and says
//! what to tell the control connections.
//!
//! Lifetimes, as tmux has them:
//! - a pane whose process exits is removed, unless it is held (`hold` at create, or `holdOpen`):
//!   then it stays `dead` with its last grid until `respawn`, `releaseHold` or `kill`;
//! - `kill` removes the pane whether or not it is held (tmux `kill-pane`).
//!
//! `create` and `respawn` spawn under the table lock, so the new child's exit (handled under the
//! same lock) always finds its entry.
//!
//! Stream subscribers (`stream.rs`) live in `streams`, beside the table: the dispatcher queues
//! each output there without taking the table lock. A pane that leaves the table closes its
//! streams (`exited`, or `killed` at `kill`); no thread holds the table lock while it takes the
//! registry's.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use alacritty_terminal::term::TermMode;
use base64::Engine;
use serde_json::{Map, Value, json};

use crate::pane::{Pane, PaneEvent, PaneSpec};
use crate::protocol::Op;
use crate::stream::{Registry, Subscriber};

/// The longest grace a `kill` gives a child before it is killed outright.
const MAX_GRACE: Duration = Duration::from_secs(60);

/// A `kill`'s `graceMs`, held to `MAX_GRACE`.
fn kill_grace(ms: u64) -> Duration {
    Duration::from_millis(ms).min(MAX_GRACE)
}

/// A failed op: one of the protocol's error codes, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpError {
    pub code: &'static str,
    pub reason: String,
}

impl OpError {
    fn new(code: &'static str, reason: impl Into<String>) -> Self {
        OpError {
            code,
            reason: reason.into(),
        }
    }
    fn no_pane(pane: &str) -> Self {
        OpError::new("no_pane", format!("no pane {pane}"))
    }
}

/// The fields of a successful reply, beside `id` and `ok`.
pub type Reply = Map<String, Value>;

/// Something every control connection is told, unasked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Notice {
    Exit { pane: String, status: Option<i32> },
    Title { pane: String, title: String },
}

impl Notice {
    /// The event's line on a control connection.
    pub fn to_line(&self) -> String {
        match self {
            Notice::Exit { pane, status } => {
                json!({"event": "exit", "pane": pane, "status": status}).to_string()
            }
            Notice::Title { pane, title } => {
                json!({"event": "title", "pane": pane, "title": title}).to_string()
            }
        }
    }
}

struct PaneEntry {
    /// Shared so an op can use the pane outside the table lock.
    pane: Arc<Pane>,
    owner: String,
    label: Option<String>,
    /// The argv of the current (or last) child.
    command: Vec<String>,
    hold: bool,
    held_token: Option<String>,
    /// The process exited and the pane is held.
    dead: bool,
    exit_status: Option<i32>,
    engine_exit: Option<i32>,
}

pub struct Panes {
    table: Mutex<HashMap<String, PaneEntry>>,
    next_id: AtomicU64,
    history_limit: usize,
    sink: Sender<(String, PaneEvent)>,
    /// The host's instance, for each child's `HARNESS_PANE`.
    instance: String,
    /// Every pane's stream subscribers.
    pub(crate) streams: Registry,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn reply(value: Value) -> Result<Reply, OpError> {
    match value {
        Value::Object(map) => Ok(map),
        _ => Ok(Reply::new()),
    }
}

fn spec(
    command: Vec<String>,
    cwd: Option<String>,
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
) -> PaneSpec {
    PaneSpec {
        command,
        cwd: cwd.map(PathBuf::from),
        env,
        cols,
        rows,
    }
}

fn pane_number(id: &str) -> u64 {
    id.strip_prefix('%')
        .and_then(|n| n.parse().ok())
        .unwrap_or(u64::MAX)
}

impl Panes {
    /// An empty table, and the receiving end of its panes' events (for the dispatcher).
    pub fn new(
        history_limit: usize,
        instance: impl Into<String>,
    ) -> (Panes, Receiver<(String, PaneEvent)>) {
        let (sink, events) = mpsc::channel();
        let panes = Panes {
            table: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            history_limit,
            sink,
            instance: instance.into(),
            streams: Registry::default(),
        };
        (panes, events)
    }

    /// Apply one pane event to the table and its streams; what to tell the control connections,
    /// if anything.
    pub fn event(&self, id: &str, event: &PaneEvent) -> Option<Notice> {
        match event {
            PaneEvent::Output { seq, bytes } => {
                self.streams.deliver(id, *seq, bytes);
                None
            }
            PaneEvent::Title(title) => Some(Notice::Title {
                pane: id.to_owned(),
                title: title.clone(),
            }),
            PaneEvent::Exited { status } => {
                let removed = {
                    let mut table = lock(&self.table);
                    match table.get_mut(id) {
                        Some(entry) if entry.hold => {
                            entry.dead = true;
                            entry.exit_status = *status;
                            None
                        }
                        Some(_) => table.remove(id),
                        None => None,
                    }
                };
                if removed.is_some() {
                    self.streams.close(id, "exited");
                }
                // Dropped outside the lock.
                drop(removed);
                Some(Notice::Exit {
                    pane: id.to_owned(),
                    status: *status,
                })
            }
        }
    }

    /// The child's environment: the caller's, and `HARNESS_PANE=<instance>:<pane>`, so hooks
    /// name their pane as they read `TMUX_PANE` under tmux.
    fn child_env(&self, id: &str, mut env: HashMap<String, String>) -> HashMap<String, String> {
        env.insert("HARNESS_PANE".into(), format!("{}:{id}", self.instance));
        env
    }

    pub(crate) fn pane(&self, id: &str) -> Result<Arc<Pane>, OpError> {
        lock(&self.table)
            .get(id)
            .map(|e| e.pane.clone())
            .ok_or_else(|| OpError::no_pane(id))
    }

    /// A pane whose process runs (input to a dead pane goes nowhere).
    pub(crate) fn live_pane(&self, id: &str) -> Result<Arc<Pane>, OpError> {
        let table = lock(&self.table);
        let entry = table.get(id).ok_or_else(|| OpError::no_pane(id))?;
        if entry.dead {
            return Err(OpError::new("bad_request", format!("pane {id} has exited")));
        }
        Ok(entry.pane.clone())
    }

    /// Add `sub` to `id`'s streams if the pane exists, calling `added` first (under the registry
    /// lock, so nothing is delivered to `sub` before it). False if there is no such pane.
    pub(crate) fn subscribe(&self, id: &str, sub: &Arc<Subscriber>, added: impl FnOnce()) -> bool {
        let mut streams = self.streams.lock();
        if !lock(&self.table).contains_key(id) {
            return false;
        }
        added();
        streams
            .entry(id.to_owned())
            .or_default()
            .push(Arc::downgrade(sub));
        true
    }

    fn write(&self, id: &str, bytes: &[u8]) -> Result<Reply, OpError> {
        self.live_pane(id)?
            .write(bytes)
            .map_err(|_| OpError::new("bad_request", format!("pane {id} has exited")))?;
        Ok(Reply::new())
    }

    pub fn handle(&self, op: Op) -> Result<Reply, OpError> {
        match op {
            Op::Create {
                command,
                cwd,
                env,
                cols,
                rows,
                owner,
                label,
                hold,
            } => {
                // A child given no directory starts in the host's; report that one.
                let cwd = cwd.or_else(|| {
                    std::env::current_dir()
                        .ok()
                        .map(|p| p.to_string_lossy().into_owned())
                });
                let id = format!("%{}", self.next_id.fetch_add(1, Ordering::Relaxed));
                let mut table = lock(&self.table);
                let pane = Pane::spawn(
                    id.clone(),
                    spec(command.clone(), cwd, self.child_env(&id, env), cols, rows),
                    self.history_limit,
                    self.sink.clone(),
                )
                .map_err(|e| OpError::new("spawn_failed", e.to_string()))?;
                table.insert(
                    id.clone(),
                    PaneEntry {
                        pane: Arc::new(pane),
                        owner,
                        label,
                        command,
                        hold,
                        held_token: None,
                        dead: false,
                        exit_status: None,
                        engine_exit: None,
                    },
                );
                reply(json!({ "pane": id }))
            }
            Op::Kill { pane, grace_ms } => {
                let entry = lock(&self.table)
                    .remove(&pane)
                    .ok_or_else(|| OpError::no_pane(&pane))?;
                self.streams.close(&pane, "killed");
                // The reply follows the first signal; the grace, the escalation and the drop
                // happen off the connection. The pane is dropped (which ends its reader) only
                // once its exit is reported, so the `exit` notice is never lost.
                let killing = entry.pane.start_kill();
                let grace = kill_grace(grace_ms);
                std::thread::Builder::new()
                    .name(format!("pty-kill {pane}"))
                    .spawn(move || {
                        if let Some(killing) = killing {
                            killing.finish(grace);
                        }
                        drop(entry);
                    })
                    .map_err(|e| OpError::new("internal", e.to_string()))?;
                Ok(Reply::new())
            }
            Op::Inventory => {
                let table = lock(&self.table);
                let mut rows: Vec<(&String, &PaneEntry)> = table.iter().collect();
                rows.sort_by_key(|(id, _)| pane_number(id));
                let panes: Vec<Value> = rows
                    .into_iter()
                    .map(|(id, e)| {
                        json!({
                            "pane": id,
                            "rootPid": e.pane.root_pid(),
                            "cwd": e.pane.cwd().unwrap_or_default(),
                            "title": e.pane.title(),
                            "dead": e.dead,
                            "owner": e.owner,
                            "label": e.label,
                        })
                    })
                    .collect();
                reply(json!({ "panes": panes }))
            }
            Op::Titles => {
                let titles: Map<String, Value> = lock(&self.table)
                    .iter()
                    .map(|(id, e)| (id.clone(), Value::String(e.pane.title())))
                    .collect();
                reply(json!({ "titles": titles }))
            }
            Op::PaneState { pane } => {
                let table = lock(&self.table);
                let state = match table.get(&pane) {
                    None => json!("gone"),
                    Some(e) => json!({
                        "dead": e.dead,
                        "exitStatus": e.exit_status,
                        "command": e.command,
                        "engineExit": e.engine_exit,
                        "heldToken": e.held_token,
                    }),
                };
                reply(json!({ "state": state }))
            }
            Op::PaneInfo { pane } => {
                let (p, command) = {
                    let table = lock(&self.table);
                    let e = table.get(&pane).ok_or_else(|| OpError::no_pane(&pane))?;
                    (e.pane.clone(), e.command.clone())
                };
                let pid = p.root_pid();
                let fallback = || {
                    command
                        .first()
                        .map(|c| c.rsplit(['/', '\\']).next().unwrap_or(c).to_owned())
                        .unwrap_or_default()
                };
                #[cfg(unix)]
                let name = pid
                    .and_then(crate::unix_proc::foreground_name)
                    .unwrap_or_else(fallback);
                #[cfg(not(unix))]
                let name = fallback();
                reply(json!({ "info": {
                    "command": name,
                    "path": p.cwd().unwrap_or_default(),
                    "pid": pid,
                    "tty": p.tty(),
                }}))
            }
            Op::Capture {
                pane,
                history_lines,
                ansi,
                visible,
            } => {
                // As tmuxCaptureArgs: the visible screen, or 100 lines of history by default.
                let history = if visible {
                    None
                } else {
                    Some(history_lines.unwrap_or(100))
                };
                let (text, _) = self.pane(&pane)?.capture(history, ansi);
                reply(json!({ "text": text }))
            }
            Op::Write { pane, data } => {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data.as_bytes())
                    .map_err(|e| OpError::new("bad_request", format!("data: {e}")))?;
                self.write(&pane, &bytes)
            }
            Op::Paste {
                pane,
                text,
                bracketed,
            } => {
                let mode = self.live_pane(&pane)?.mode();
                let bytes = harness_term::paste::bytes(
                    &text,
                    bracketed,
                    mode.contains(TermMode::BRACKETED_PASTE),
                );
                self.write(&pane, &bytes)
            }
            Op::Key { pane, key } => {
                let mode = self.live_pane(&pane)?.mode();
                let bytes =
                    harness_term::keys::bytes_for(&key, mode.contains(TermMode::APP_CURSOR))
                        .ok_or_else(|| OpError::new("bad_request", format!("unknown key {key}")))?;
                self.write(&pane, &bytes)
            }
            Op::SetTitle { pane, title } => {
                self.pane(&pane)?.set_title(&title);
                Ok(Reply::new())
            }
            Op::HoldOpen { pane, token } => {
                let mut table = lock(&self.table);
                let entry = table
                    .get_mut(&pane)
                    .ok_or_else(|| OpError::no_pane(&pane))?;
                entry.hold = true;
                entry.held_token = token;
                Ok(Reply::new())
            }
            Op::ReleaseHold { pane } => {
                let removed = {
                    let mut table = lock(&self.table);
                    let entry = table
                        .get_mut(&pane)
                        .ok_or_else(|| OpError::no_pane(&pane))?;
                    entry.hold = false;
                    entry.held_token = None;
                    if entry.dead {
                        table.remove(&pane)
                    } else {
                        None
                    }
                };
                if removed.is_some() {
                    self.streams.close(&pane, "exited");
                }
                drop(removed);
                Ok(Reply::new())
            }
            Op::Respawn {
                pane,
                command,
                cwd,
                env,
                expected_held_token,
            } => {
                let mut table = lock(&self.table);
                let entry = table
                    .get_mut(&pane)
                    .ok_or_else(|| OpError::no_pane(&pane))?;
                if !entry.dead {
                    return Err(OpError::new(
                        "bad_request",
                        format!("pane {pane} is still running"),
                    ));
                }
                if let Some(expected) = expected_held_token
                    && entry.held_token.as_deref() != Some(expected.as_str())
                {
                    return Err(OpError::new(
                        "held_mismatch",
                        format!("pane {pane} is held by another token"),
                    ));
                }
                entry
                    .pane
                    .respawn(spec(command.clone(), cwd, self.child_env(&pane, env), 0, 0))
                    .map_err(|e| OpError::new("spawn_failed", e.to_string()))?;
                entry.command = command;
                entry.dead = false;
                entry.exit_status = None;
                entry.engine_exit = None;
                Ok(Reply::new())
            }
            Op::SetEngineExit { pane, status } => {
                let mut table = lock(&self.table);
                let entry = table
                    .get_mut(&pane)
                    .ok_or_else(|| OpError::no_pane(&pane))?;
                entry.engine_exit = Some(status);
                Ok(Reply::new())
            }
            Op::JobPids { .. } | Op::Processes => Err(OpError::new(
                "unsupported",
                "not available on this platform yet",
            )),
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc::Receiver;
    use std::time::Instant;

    /// A table with its dispatcher running; the notices it raised.
    fn table() -> (Arc<Panes>, Receiver<Notice>) {
        let (panes, events) = Panes::new(1000, "p9");
        let panes = Arc::new(panes);
        let (tx, notices) = mpsc::channel();
        let p = panes.clone();
        std::thread::spawn(move || {
            for (id, event) in events {
                if let Some(n) = p.event(&id, &event) {
                    let _ = tx.send(n);
                }
            }
        });
        (panes, notices)
    }

    fn op(json: Value) -> Op {
        let mut v = json;
        v["id"] = json!(1);
        serde_json::from_value::<crate::protocol::Request>(v)
            .unwrap()
            .op
    }

    fn create(panes: &Panes, script: &str, hold: bool) -> String {
        let r = panes
            .handle(op(
                json!({"op": "create", "command": ["/bin/sh", "-c", script],
                "cols": 40, "rows": 10, "owner": "o", "hold": hold}),
            ))
            .unwrap();
        r["pane"].as_str().unwrap().to_owned()
    }

    fn state(panes: &Panes, pane: &str) -> Value {
        panes
            .handle(op(json!({"op": "paneState", "pane": pane})))
            .unwrap()["state"]
            .clone()
    }

    fn until(what: &str, mut f: impl FnMut() -> bool) {
        let end = Instant::now() + Duration::from_secs(5);
        while !f() {
            assert!(Instant::now() < end, "timed out: {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn exit_notice(notices: &Receiver<Notice>, pane: &str) -> Option<i32> {
        loop {
            match notices
                .recv_timeout(Duration::from_secs(5))
                .expect("no exit")
            {
                Notice::Exit { pane: p, status } if p == pane => return status,
                _ => {}
            }
        }
    }

    fn capture(panes: &Panes, pane: &str) -> Result<String, OpError> {
        panes
            .handle(op(
                json!({"op": "capture", "pane": pane, "ansi": false, "visible": true}),
            ))
            .map(|r| r["text"].as_str().unwrap().to_owned())
    }

    #[test]
    fn ids_count_from_one_and_inventory_lists_owner_and_label() {
        let (panes, _n) = table();
        let a = create(&panes, "sleep 5", false);
        let r = panes
            .handle(op(
                json!({"op": "create", "command": ["/bin/sh", "-c", "sleep 5"],
                "cols": 40, "rows": 10, "owner": "me", "label": "lbl", "hold": false, "cwd": "/"}),
            ))
            .unwrap();
        assert_eq!((a.as_str(), r["pane"].as_str().unwrap()), ("%1", "%2"));
        let inv = panes.handle(Op::Inventory).unwrap();
        let rows = inv["panes"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1]["owner"], "me");
        assert_eq!(rows[1]["label"], "lbl");
        assert_eq!(rows[1]["cwd"], "/");
        assert_eq!(rows[1]["dead"], false);
        assert!(rows[0]["rootPid"].as_u64().is_some());
        assert_eq!(
            rows[0]["cwd"],
            std::env::current_dir().unwrap().to_string_lossy().as_ref()
        );
        panes
            .handle(op(json!({"op": "setTitle", "pane": "%2", "title": "t2"})))
            .unwrap();
        let titles = panes.handle(Op::Titles).unwrap();
        assert_eq!(titles["titles"]["%2"], "t2");
    }

    #[test]
    fn a_pane_that_is_not_held_is_removed_when_it_exits() {
        let (panes, notices) = table();
        let pane = create(&panes, "exit 4", false);
        assert_eq!(exit_notice(&notices, &pane), Some(4));
        assert_eq!(state(&panes, &pane), json!("gone"));
        assert_eq!(capture(&panes, &pane).unwrap_err().code, "no_pane");
    }

    #[test]
    fn a_held_pane_stays_dead_with_its_grid() {
        let (panes, notices) = table();
        let pane = create(&panes, "echo last-words; exit 5", true);
        assert_eq!(exit_notice(&notices, &pane), Some(5));
        let st = state(&panes, &pane);
        assert_eq!(st["dead"], true);
        assert_eq!(st["exitStatus"], 5);
        assert_eq!(
            st["command"],
            json!(["/bin/sh", "-c", "echo last-words; exit 5"])
        );
        assert_eq!(st["heldToken"], Value::Null);
        assert!(capture(&panes, &pane).unwrap().contains("last-words"));
        let inv = panes.handle(Op::Inventory).unwrap();
        assert_eq!(inv["panes"][0]["dead"], true);
        assert_eq!(inv["panes"][0]["rootPid"], Value::Null);
        // Input to a dead pane is refused.
        let err = panes
            .handle(op(json!({"op": "write", "pane": pane, "data": "eA=="})))
            .unwrap_err();
        assert_eq!(err.code, "bad_request");
    }

    #[test]
    fn hold_open_holds_a_running_pane_and_records_its_token() {
        let (panes, notices) = table();
        let pane = create(&panes, "read x; exit 2", false);
        panes
            .handle(op(json!({"op": "holdOpen", "pane": pane, "token": "tok"})))
            .unwrap();
        panes
            .handle(op(json!({"op": "write", "pane": pane, "data": "eAo="})))
            .unwrap();
        assert_eq!(exit_notice(&notices, &pane), Some(2));
        let st = state(&panes, &pane);
        assert_eq!(
            (st["dead"].clone(), st["heldToken"].clone()),
            (json!(true), json!("tok"))
        );
    }

    #[test]
    fn release_hold_removes_a_dead_pane_and_lets_a_live_one_go_on_exit() {
        let (panes, notices) = table();
        let dead = create(&panes, "exit 0", true);
        exit_notice(&notices, &dead);
        assert_eq!(state(&panes, &dead)["dead"], true);
        panes
            .handle(op(json!({"op": "releaseHold", "pane": dead})))
            .unwrap();
        assert_eq!(state(&panes, &dead), json!("gone"));

        let live = create(&panes, "read x", true);
        panes
            .handle(op(json!({"op": "releaseHold", "pane": live})))
            .unwrap();
        assert_eq!(state(&panes, &live)["dead"], false);
        panes
            .handle(op(json!({"op": "key", "pane": live, "key": "Enter"})))
            .unwrap();
        exit_notice(&notices, &live);
        assert_eq!(state(&panes, &live), json!("gone"));
    }

    #[test]
    fn kill_removes_held_panes_dead_or_alive() {
        let (panes, notices) = table();
        let live = create(&panes, "sleep 30", true);
        let start = Instant::now();
        panes
            .handle(op(json!({"op": "kill", "pane": live, "graceMs": 2000})))
            .unwrap();
        assert!(start.elapsed() < Duration::from_secs(1));
        assert_eq!(state(&panes, &live), json!("gone"));
        // Its exit is still announced.
        exit_notice(&notices, &live);

        let dead = create(&panes, "exit 1", true);
        exit_notice(&notices, &dead);
        panes
            .handle(op(json!({"op": "kill", "pane": dead})))
            .unwrap();
        assert_eq!(state(&panes, &dead), json!("gone"));
        assert_eq!(
            panes
                .handle(op(json!({"op": "kill", "pane": dead})))
                .unwrap_err()
                .code,
            "no_pane"
        );
    }

    #[test]
    fn respawn_needs_a_dead_pane_and_the_held_token() {
        let (panes, notices) = table();
        let pane = create(&panes, "echo one; read x; exit 3", true);
        let respawn = |token: Option<&str>| {
            let mut v = json!({"op": "respawn", "pane": pane,
                "command": ["/bin/sh", "-c", "echo two; sleep 30"]});
            if let Some(t) = token {
                v["expectedHeldToken"] = json!(t);
            }
            panes.handle(op(v))
        };
        assert_eq!(respawn(None).unwrap_err().code, "bad_request"); // still running
        panes
            .handle(op(json!({"op": "holdOpen", "pane": pane, "token": "tok"})))
            .unwrap();
        panes
            .handle(op(
                json!({"op": "setEngineExit", "pane": pane, "status": 9}),
            ))
            .unwrap();
        until("one", || capture(&panes, &pane).unwrap().contains("one"));
        panes
            .handle(op(json!({"op": "write", "pane": pane, "data": "eAo="})))
            .unwrap();
        exit_notice(&notices, &pane);
        assert_eq!(state(&panes, &pane)["engineExit"], 9);
        assert_eq!(respawn(Some("other")).unwrap_err().code, "held_mismatch");
        respawn(Some("tok")).unwrap();
        let st = state(&panes, &pane);
        assert_eq!(st["dead"], false);
        assert_eq!(st["engineExit"], Value::Null);
        assert_eq!(st["exitStatus"], Value::Null);
        assert_eq!(st["heldToken"], "tok");
        assert_eq!(
            st["command"],
            json!(["/bin/sh", "-c", "echo two; sleep 30"])
        );
        until("two", || capture(&panes, &pane).unwrap().contains("two"));
        assert!(capture(&panes, &pane).unwrap().contains("one"));
        panes
            .handle(op(json!({"op": "kill", "pane": pane, "graceMs": 200})))
            .unwrap();
    }

    #[test]
    fn paste_brackets_when_the_program_asked_and_keys_are_named() {
        let (panes, _n) = table();
        let pane = create(
            &panes,
            r#"stty -echo; printf '\033[?2004h'; echo ready; exec cat -v"#,
            false,
        );
        until("ready", || {
            capture(&panes, &pane).unwrap().contains("ready")
        });
        panes
            .handle(op(
                json!({"op": "paste", "pane": pane, "text": "a\nb\u{1b}[201~c", "bracketed": true}),
            ))
            .unwrap();
        panes
            .handle(op(json!({"op": "key", "pane": pane, "key": "Enter"})))
            .unwrap();
        until("pasted", || {
            let text = capture(&panes, &pane).unwrap();
            text.contains("^[[200~a\nb^[[201~c^[[201~")
        });
        assert_eq!(
            panes
                .handle(op(json!({"op": "key", "pane": pane, "key": "NoSuchKey"})))
                .unwrap_err()
                .code,
            "bad_request"
        );
    }

    #[test]
    fn pane_info_names_the_foreground_command() {
        let (panes, _n) = table();
        let pane = create(&panes, "echo ready; exec sleep 30", false);
        until("ready", || {
            capture(&panes, &pane).unwrap().contains("ready")
        });
        let info = panes
            .handle(op(json!({"op": "paneInfo", "pane": pane})))
            .unwrap()["info"]
            .clone();
        assert_eq!(info["command"], "sleep");
        assert!(info["pid"].as_u64().is_some());
        assert!(info["tty"].as_str().unwrap().starts_with("/dev/"), "{info}");
        assert_eq!(
            panes
                .handle(op(json!({"op": "paneInfo", "pane": "%99"})))
                .unwrap_err()
                .code,
            "no_pane"
        );
    }

    #[test]
    fn children_name_their_pane_in_harness_pane() {
        let (panes, notices) = table();
        let r = panes
            .handle(op(
                json!({"op": "create", "command": ["/bin/sh", "-c", "echo \"hp=$HARNESS_PANE.\""],
                "env": {"HARNESS_PANE": "caller", "OTHER": "kept"},
                "cols": 40, "rows": 10, "owner": "o", "hold": true}),
            ))
            .unwrap();
        let pane = r["pane"].as_str().unwrap().to_owned();
        exit_notice(&notices, &pane);
        assert!(
            capture(&panes, &pane)
                .unwrap()
                .contains(&format!("hp=p9:{pane}."))
        );
        panes
            .handle(op(json!({"op": "respawn", "pane": pane,
                "command": ["/bin/sh", "-c", "echo \"again=$HARNESS_PANE $OTHER.\"; sleep 5"],
                "env": {"OTHER": "o2"}})))
            .unwrap();
        until("again", || {
            capture(&panes, &pane)
                .unwrap()
                .contains(&format!("again=p9:{pane} o2."))
        });
        panes
            .handle(op(json!({"op": "kill", "pane": pane, "graceMs": 200})))
            .unwrap();
    }

    #[test]
    fn kill_answers_at_once_and_an_escalated_kill_still_reports_the_exit() {
        let (panes, notices) = table();
        let pane = create(
            &panes,
            "trap '' HUP; echo ready; while :; do sleep 1; done",
            false,
        );
        until("ready", || {
            capture(&panes, &pane).unwrap().contains("ready")
        });
        let start = Instant::now();
        panes
            .handle(op(json!({"op": "kill", "pane": pane, "graceMs": 500})))
            .unwrap();
        assert!(
            start.elapsed() < Duration::from_millis(200),
            "kill waited out the grace"
        );
        assert_eq!(state(&panes, &pane), json!("gone"));
        // SIGKILL after the grace; the exit is still announced.
        assert_eq!(exit_notice(&notices, &pane), Some(128 + libc::SIGKILL));
        assert!(start.elapsed() >= Duration::from_millis(500));
    }

    #[test]
    fn kill_holds_the_grace_to_a_minute() {
        assert_eq!(kill_grace(500), Duration::from_millis(500));
        assert_eq!(kill_grace(60_001), Duration::from_secs(60));
        assert_eq!(kill_grace(u64::MAX), Duration::from_secs(60));
        let (panes, notices) = table();
        let pane = create(&panes, "echo ready; sleep 30", false);
        until("ready", || {
            capture(&panes, &pane).unwrap().contains("ready")
        });
        // A grace past what an `Instant` can hold does not end the kill thread before it reports.
        panes
            .handle(op(json!({"op": "kill", "pane": pane, "graceMs": u64::MAX})))
            .unwrap();
        assert_eq!(exit_notice(&notices, &pane), Some(128 + libc::SIGHUP));
    }

    #[test]
    fn job_pids_and_processes_are_unsupported_here() {
        let (panes, _n) = table();
        assert_eq!(panes.handle(Op::Processes).unwrap_err().code, "unsupported");
    }
}
