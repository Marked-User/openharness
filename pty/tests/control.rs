#![cfg(unix)]
mod common;
use common::{call, connect, discovery_file, hello, start};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::process::Command;
use std::time::{Duration, Instant};

use harness_pty::protocol::PROTOCOL;

#[test]
fn rejects_bad_token() {
    let (_h, disc) = start();
    let mut s = UnixStream::connect(disc["endpoint"].as_str().unwrap()).unwrap();
    writeln!(s, "{}", hello("nope", "control")).unwrap();
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line).unwrap();
    assert!(line.contains(r#""code":"incompatible""#), "{line}");
}

#[test]
fn rejects_other_protocol() {
    let (_h, disc) = start();
    let mut s = UnixStream::connect(disc["endpoint"].as_str().unwrap()).unwrap();
    let token = disc["token"].as_str().unwrap();
    writeln!(
        s,
        r#"{{"hello":{{"token":"{token}","protocol":{},"role":"control","clientId":"t"}}}}"#,
        PROTOCOL + 1
    )
    .unwrap();
    let mut r = BufReader::new(s);
    let mut line = String::new();
    r.read_line(&mut line).unwrap();
    assert!(line.contains(r#""code":"incompatible""#), "{line}");
    // …and the host closes the connection.
    line.clear();
    assert_eq!(r.read_line(&mut line).unwrap(), 0, "{line}");
}

#[test]
fn discovery_names_the_host() {
    let (h, disc) = start();
    assert_eq!(disc["protocol"], PROTOCOL);
    assert_eq!(disc["instance"], format!("p{PROTOCOL}"));
    assert_eq!(disc["pid"], h.child.id());
    assert_eq!(disc["version"], env!("CARGO_PKG_VERSION"));
    let endpoint = std::path::PathBuf::from(disc["endpoint"].as_str().unwrap());
    assert_eq!(
        endpoint,
        h.home.path().join(format!("run/pty-host-{PROTOCOL}.sock"))
    );
    let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&discovery_file(h.home.path())), 0o600);
    assert_eq!(mode(&endpoint), 0o600);
    // The hello reply names the same host.
    let s = UnixStream::connect(&endpoint).unwrap();
    let mut w = s.try_clone().unwrap();
    writeln!(w, "{}", hello(disc["token"].as_str().unwrap(), "control")).unwrap();
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line).unwrap();
    let v: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(v["hello"]["instance"], format!("p{PROTOCOL}"));
    assert_eq!(v["hello"]["pid"], h.child.id());
}

#[test]
fn create_capture_kill() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let created = call(
        &mut w,
        &mut r,
        r#"{"id":1,"op":"create","command":["/bin/sh"],"cols":80,"rows":24,"owner":"t","hold":false}"#,
    );
    let pane = created["pane"].as_str().unwrap().to_string();
    assert!(pane.starts_with('%'));
    call(
        &mut w,
        &mut r,
        &format!(r#"{{"id":2,"op":"write","pane":"{pane}","data":"ZWNobyBoaS0kKCg0MCsyKSkK"}}"#),
    ); // "echo hi-$((40+2))\n"
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        let cap = call(
            &mut w,
            &mut r,
            &format!(r#"{{"id":3,"op":"capture","pane":"{pane}","ansi":false,"visible":true}}"#),
        );
        if cap["text"].as_str().unwrap().contains("hi-42") {
            break;
        }
        assert!(Instant::now() < end, "no output: {cap}");
        std::thread::sleep(Duration::from_millis(50));
    }
    call(
        &mut w,
        &mut r,
        &format!(r#"{{"id":4,"op":"kill","pane":"{pane}","graceMs":200}}"#),
    );
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        let st = call(
            &mut w,
            &mut r,
            &format!(r#"{{"id":5,"op":"paneState","pane":"{pane}"}}"#),
        );
        if st["state"] == "gone" {
            break;
        }
        assert!(Instant::now() < end);
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn second_host_exits_cleanly() {
    let (h, _disc) = start();
    let status = Command::new(env!("CARGO_BIN_EXE_harness-pty"))
        .args(["serve", "--home"])
        .arg(h.home.path())
        .status()
        .unwrap();
    assert!(status.success());
}

#[test]
fn stale_socket_is_replaced() {
    let home = tempfile::tempdir().unwrap();
    let run = home.path().join("run");
    std::fs::create_dir_all(&run).unwrap();
    // A socket file nobody listens on, as a crashed host leaves it.
    let path = run.join(format!("pty-host-{PROTOCOL}.sock"));
    drop(std::os::unix::net::UnixListener::bind(&path).unwrap());
    // A child another test forks just now holds the listener until it execs: wait for refusal.
    let end = Instant::now() + Duration::from_secs(5);
    while UnixStream::connect(&path).is_ok() {
        assert!(Instant::now() < end, "the listener stays open");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(path.exists());
    let mut child = Command::new(env!("CARGO_BIN_EXE_harness-pty"))
        .args(["serve", "--home"])
        .arg(home.path())
        .spawn()
        .unwrap();
    let file = discovery_file(home.path());
    let end = Instant::now() + Duration::from_secs(5);
    while !file.exists() {
        assert!(Instant::now() < end, "no discovery file");
        std::thread::sleep(Duration::from_millis(20))
    }
    assert!(UnixStream::connect(&path).is_ok());
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn exit_events_reach_every_control_connection() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let (_w2, mut r2) = connect(&disc);
    let created = call(
        &mut w,
        &mut r,
        r#"{"id":1,"op":"create","command":["/bin/sh","-c","sleep 0.3; exit 7"],"cols":80,"rows":24,"owner":"t","hold":false}"#,
    );
    let pane = created["pane"].as_str().unwrap().to_string();
    for reader in [&mut r, &mut r2] {
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let v: serde_json::Value = serde_json::from_str(&line).unwrap();
            if v["event"] == "exit" {
                assert_eq!(v["pane"], pane.as_str());
                assert_eq!(v["status"], 7);
                break;
            }
        }
    }
    // Not held: gone once it exited.
    let st = call(
        &mut w,
        &mut r,
        &format!(r#"{{"id":2,"op":"paneState","pane":"{pane}"}}"#),
    );
    assert_eq!(st["state"], "gone");
}

#[test]
fn held_pane_respawns_with_its_token() {
    // A held shell, as tmux's `heldPaneFormat` knows one: `harness-held` and the token in its start command.
    const TOK: &str = "0b5f9d38-3c1e-4c55-9f1a-1d2e3f4a5b6c";
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let created = call(
        &mut w,
        &mut r,
        &format!(
            r#"{{"id":1,"op":"create","command":["/bin/sh","-c","echo first; exit 3","harness-held","{TOK}"],"cols":80,"rows":24,"owner":"o","label":"l","hold":true}}"#
        ),
    );
    let pane = created["pane"].as_str().unwrap().to_string();
    // Created held; holdOpen holds it again, dead or not.
    let held = call(
        &mut w,
        &mut r,
        &format!(r#"{{"id":2,"op":"holdOpen","pane":"{pane}"}}"#),
    );
    if held["ok"] != true {
        panic!("holdOpen: {held}");
    }
    let end = Instant::now() + Duration::from_secs(5);
    let state = loop {
        let st = call(
            &mut w,
            &mut r,
            &format!(r#"{{"id":3,"op":"paneState","pane":"{pane}"}}"#),
        );
        if st["state"]["dead"] == true {
            break st;
        }
        assert!(Instant::now() < end, "{st}");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(state["state"]["exitStatus"], 3);
    assert_eq!(
        state["state"]["startCommand"],
        format!("/bin/sh -c echo first; exit 3 harness-held {TOK}")
    );
    let inv = call(&mut w, &mut r, r#"{"id":4,"op":"inventory"}"#);
    let row = inv["panes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["pane"] == pane.as_str())
        .unwrap()
        .clone();
    assert_eq!(row["dead"], true);
    assert_eq!(row["owner"], "o");
    assert!(row["rootPid"].as_u64().is_some(), "{row}");

    let wrong = call(
        &mut w,
        &mut r,
        &format!(
            r#"{{"id":5,"op":"respawn","pane":"{pane}","command":["/bin/sh","-c","echo second; sleep 30"],"expectedHeldToken":"11111111-2222-3333-4444-555555555555"}}"#
        ),
    );
    assert_eq!(wrong["code"], "held_mismatch", "{wrong}");
    let ok = call(
        &mut w,
        &mut r,
        &format!(
            r#"{{"id":6,"op":"respawn","pane":"{pane}","command":["/bin/sh","-c","echo second; sleep 30"],"expectedHeldToken":"{TOK}"}}"#
        ),
    );
    assert_eq!(ok["ok"], true, "{ok}");
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        let cap = call(
            &mut w,
            &mut r,
            &format!(r#"{{"id":7,"op":"capture","pane":"{pane}","ansi":false,"visible":true}}"#),
        );
        let text = cap["text"].as_str().unwrap();
        if text.contains("second") {
            assert!(
                text.contains("first"),
                "the grid survives a respawn: {text:?}"
            );
            break;
        }
        assert!(Instant::now() < end, "{cap}");
        std::thread::sleep(Duration::from_millis(50));
    }
    let st = call(
        &mut w,
        &mut r,
        &format!(r#"{{"id":8,"op":"paneState","pane":"{pane}"}}"#),
    );
    assert_eq!(st["state"]["dead"], false, "{st}");
    // kill removes a held pane (as tmux kill-pane does).
    call(
        &mut w,
        &mut r,
        &format!(r#"{{"id":9,"op":"kill","pane":"{pane}","graceMs":200}}"#),
    );
    let st = call(
        &mut w,
        &mut r,
        &format!(r#"{{"id":10,"op":"paneState","pane":"{pane}"}}"#),
    );
    assert_eq!(st["state"], "gone");
}

#[test]
fn children_see_harness_pane() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let created = call(
        &mut w,
        &mut r,
        r#"{"id":1,"op":"create","command":["/bin/sh","-c","echo \"hp=$HARNESS_PANE.\"; sleep 5"],"cols":80,"rows":24,"owner":"t","hold":false}"#,
    );
    let pane = created["pane"].as_str().unwrap().to_string();
    let want = format!("hp=p{PROTOCOL}:{pane}.");
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        let cap = call(
            &mut w,
            &mut r,
            &format!(r#"{{"id":2,"op":"capture","pane":"{pane}","ansi":false,"visible":true}}"#),
        );
        if cap["text"].as_str().unwrap().contains(&want) {
            break;
        }
        assert!(Instant::now() < end, "no {want:?}: {cap}");
        std::thread::sleep(Duration::from_millis(50));
    }
    call(
        &mut w,
        &mut r,
        &format!(r#"{{"id":3,"op":"kill","pane":"{pane}","graceMs":200}}"#),
    );
}

#[test]
fn kill_does_not_hold_up_the_connection_and_the_exit_still_arrives() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let created = call(
        &mut w,
        &mut r,
        r#"{"id":1,"op":"create","command":["/bin/sh","-c","trap '' HUP; echo ready; while :; do sleep 1; done"],"cols":80,"rows":24,"owner":"t","hold":false}"#,
    );
    let pane = created["pane"].as_str().unwrap().to_string();
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        let cap = call(
            &mut w,
            &mut r,
            &format!(r#"{{"id":2,"op":"capture","pane":"{pane}","ansi":false,"visible":true}}"#),
        );
        if cap["text"].as_str().unwrap().contains("ready") {
            break;
        }
        assert!(Instant::now() < end, "{cap}");
        std::thread::sleep(Duration::from_millis(50));
    }
    let start = Instant::now();
    let killed = call(
        &mut w,
        &mut r,
        &format!(r#"{{"id":3,"op":"kill","pane":"{pane}","graceMs":2000}}"#),
    );
    assert_eq!(killed["ok"], true, "{killed}");
    assert!(
        start.elapsed() < Duration::from_millis(500),
        "kill waited out the grace"
    );
    let st = call(
        &mut w,
        &mut r,
        &format!(r#"{{"id":4,"op":"paneState","pane":"{pane}"}}"#),
    );
    assert_eq!(st["state"], "gone");
    assert!(start.elapsed() < Duration::from_millis(500));
    // The shell ignores SIGHUP: SIGKILL after the grace, and its exit is announced.
    loop {
        let mut line = String::new();
        r.read_line(&mut line).unwrap();
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        if v["event"] == "exit" && v["pane"] == pane.as_str() {
            assert_eq!(v["status"], 128 + 9);
            break;
        }
    }
    let waited = start.elapsed();
    assert!(waited >= Duration::from_millis(2000), "{waited:?}");
}

#[test]
fn bad_requests_get_error_replies() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let v = call(&mut w, &mut r, r#"{"id":1,"op":"paneState","pane":"%999"}"#);
    assert_eq!(v["state"], "gone");
    let v = call(
        &mut w,
        &mut r,
        r#"{"id":2,"op":"capture","pane":"%999","ansi":false,"visible":true}"#,
    );
    assert_eq!(
        (v["ok"].clone(), v["code"].clone()),
        (false.into(), "no_pane".into()),
        "{v}"
    );
    let v = call(&mut w, &mut r, r#"{"id":3,"op":"nope"}"#);
    assert_eq!(v["code"], "bad_request", "{v}");
    assert_eq!(v["id"], 3);
    let v = call(
        &mut w,
        &mut r,
        r#"{"id":4,"op":"create","command":["/nonexistent/x"],"cols":80,"rows":24,"owner":"t","hold":false}"#,
    );
    // The spawn itself may succeed (env execs the command): either an error or a pane that exits.
    assert!(v["ok"] == true || v["code"] == "spawn_failed", "{v}");
}
