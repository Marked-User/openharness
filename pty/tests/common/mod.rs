//! Helpers shared by the integration tests: a host on a temporary home, and control calls.
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use harness_pty::protocol::PROTOCOL;

pub struct Host {
    pub child: Child,
    pub home: tempfile::TempDir,
}
impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn discovery_file(home: &std::path::Path) -> std::path::PathBuf {
    home.join(format!("run/pty-host-{PROTOCOL}.json"))
}

pub fn start() -> (Host, serde_json::Value) {
    let home = tempfile::tempdir().unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_harness-pty"))
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
    let disc: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    (Host { child, home }, disc)
}

pub fn hello(token: &str, role: &str) -> String {
    format!(
        r#"{{"hello":{{"token":"{token}","protocol":{PROTOCOL},"role":"{role}","clientId":"t"}}}}"#
    )
}

pub fn connect(disc: &serde_json::Value) -> (UnixStream, BufReader<UnixStream>) {
    let s = UnixStream::connect(disc["endpoint"].as_str().unwrap()).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut w = s.try_clone().unwrap();
    writeln!(w, "{}", hello(disc["token"].as_str().unwrap(), "control")).unwrap();
    let mut r = BufReader::new(s);
    let mut line = String::new();
    r.read_line(&mut line).unwrap();
    assert!(line.contains(r#""ok":true"#), "{line}");
    (w, r)
}

pub fn call(w: &mut UnixStream, r: &mut BufReader<UnixStream>, req: &str) -> serde_json::Value {
    writeln!(w, "{req}").unwrap();
    loop {
        let mut line = String::new();
        r.read_line(&mut line).unwrap();
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        if v.get("id").is_some() {
            return v;
        }
    }
}
