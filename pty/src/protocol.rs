use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, Read, Write};

pub const PROTOCOL: u32 = 1;
pub const MAX_FRAME: u32 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Subscribe = 1,
    Input = 2,
    Paste = 3,
    Resize = 4,
    Snapshot = 5,
    Pause = 6,
    Resume = 7,
    Output = 16,
    SnapshotReply = 17,
    Closed = 18,
    Ack = 19,
}

impl Kind {
    pub fn from_u8(v: u8) -> Option<Kind> {
        use Kind::*;
        Some(match v {
            1 => Subscribe,
            2 => Input,
            3 => Paste,
            4 => Resize,
            5 => Snapshot,
            6 => Pause,
            7 => Resume,
            16 => Output,
            17 => SnapshotReply,
            18 => Closed,
            19 => Ack,
            _ => return None,
        })
    }
}

pub fn write_frame(w: &mut impl Write, kind: Kind, payload: &[u8]) -> io::Result<()> {
    if payload.len() > MAX_FRAME as usize {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "frame too large"));
    }
    let mut head = [0u8; 5];
    head[0] = kind as u8;
    head[1..].copy_from_slice(&(payload.len() as u32).to_be_bytes());
    w.write_all(&head)?;
    w.write_all(payload)
}

/// `Ok(None)` at a clean end of stream (no bytes of a next frame). A stream
/// that ends inside a header or payload is an `UnexpectedEof` error.
pub fn read_frame(r: &mut impl Read) -> io::Result<Option<(Kind, Vec<u8>)>> {
    let mut head = [0u8; 5];
    let mut got = 0;
    while got < head.len() {
        match r.read(&mut head[got..]) {
            Ok(0) if got == 0 => return Ok(None),
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    let kind = Kind::from_u8(head[0])
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "unknown frame kind"))?;
    let len = u32::from_be_bytes(head[1..].try_into().unwrap());
    if len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut payload = vec![0u8; len as usize];
    r.read_exact(&mut payload)?;
    Ok(Some((kind, payload)))
}

#[derive(Debug, Deserialize)]
pub struct Hello {
    pub token: String,
    pub protocol: u32,
    pub role: Role,
    #[serde(rename = "clientId")]
    pub client_id: String,
}
#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Control,
    Stream,
}
#[derive(Debug, Deserialize)]
pub struct HelloLine {
    pub hello: Hello,
}

#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: u64,
    #[serde(flatten)]
    pub op: Op,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Op {
    Create {
        command: Vec<String>,
        cwd: Option<String>,
        #[serde(default)]
        env: HashMap<String, String>,
        cols: u16,
        rows: u16,
        owner: String,
        label: Option<String>,
        hold: bool,
    },
    Kill {
        pane: String,
        #[serde(rename = "graceMs", default = "default_grace")]
        grace_ms: u64,
    },
    Inventory,
    Titles,
    PaneState { pane: String },
    PaneInfo { pane: String },
    Capture {
        pane: String,
        #[serde(rename = "historyLines")]
        history_lines: Option<u32>,
        ansi: bool,
        visible: bool,
    },
    Write { pane: String, data: String },
    Paste { pane: String, text: String, bracketed: bool },
    Key { pane: String, key: String },
    SetTitle { pane: String, title: String },
    HoldOpen { pane: String, token: Option<String> },
    ReleaseHold { pane: String },
    Respawn {
        pane: String,
        command: Vec<String>,
        cwd: Option<String>,
        #[serde(default)]
        env: HashMap<String, String>,
        #[serde(rename = "expectedHeldToken")]
        expected_held_token: Option<String>,
    },
    JobPids { pane: String },
    Processes,
    SetEngineExit { pane: String, status: i32 },
}
fn default_grace() -> u64 {
    2_000
}

#[derive(Debug, Serialize)]
pub struct Failure<'a> {
    pub id: u64,
    pub ok: bool,
    pub code: &'a str,
    pub reason: String,
}
impl<'a> Failure<'a> {
    pub fn new(id: u64, code: &'a str, reason: impl Into<String>) -> Self {
        Failure { id, ok: false, code, reason: reason.into() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_roundtrip() {
        let mut buf = Vec::new();
        write_frame(&mut buf, Kind::Output, &[0, 0, 0, 0, 0, 0, 0, 7, b'h', b'i']).unwrap();
        let (kind, payload) = read_frame(&mut buf.as_slice()).unwrap().unwrap();
        assert_eq!(kind, Kind::Output);
        assert_eq!(&payload[8..], b"hi");
    }
    #[test]
    fn rejects_oversize_frame() {
        let mut buf = vec![16u8];
        buf.extend_from_slice(&(MAX_FRAME + 1).to_be_bytes());
        assert!(read_frame(&mut buf.as_slice()).is_err());
    }
    #[test]
    fn parses_create_request() {
        let r: Request = serde_json::from_str(r#"{"id":1,"op":"create","command":["sh"],"cols":80,"rows":24,"owner":"o","hold":true}"#).unwrap();
        assert!(matches!(r.op, Op::Create { ref command, cols: 80, rows: 24, hold: true, .. } if command == &vec!["sh".to_string()]));
    }
    #[test]
    fn clean_eof_is_none_and_truncation_is_error() {
        assert!(read_frame(&mut [].as_slice()).unwrap().is_none());
        assert!(read_frame(&mut [16u8, 0].as_slice()).is_err());
        assert!(read_frame(&mut [16u8, 0, 0, 0, 3, 1].as_slice()).is_err());
    }
    #[test]
    fn unknown_kind_is_error() {
        assert!(read_frame(&mut [99u8, 0, 0, 0, 0].as_slice()).is_err());
    }
    #[test]
    fn kind_roundtrips_through_u8() {
        for v in 0..=255u8 {
            if let Some(k) = Kind::from_u8(v) {
                assert_eq!(k as u8, v);
            }
        }
        assert_eq!(Kind::from_u8(16), Some(Kind::Output));
        assert_eq!(Kind::from_u8(8), None);
    }
    #[test]
    fn parses_hello_with_current_protocol() {
        let line = format!(
            r#"{{"hello":{{"token":"t","protocol":{PROTOCOL},"role":"stream","clientId":"c"}}}}"#
        );
        let h: HelloLine = serde_json::from_str(&line).unwrap();
        assert_eq!(h.hello.protocol, PROTOCOL);
        assert_eq!(h.hello.role, Role::Stream);
        assert_eq!(h.hello.client_id, "c");
    }
    #[test]
    fn kill_defaults_grace_and_hold_open_token_optional() {
        let r: Request = serde_json::from_str(r#"{"id":2,"op":"kill","pane":"%3"}"#).unwrap();
        assert!(matches!(r.op, Op::Kill { grace_ms: 2000, .. }));
        let r: Request = serde_json::from_str(r#"{"id":3,"op":"holdOpen","pane":"%3","token":"u"}"#).unwrap();
        assert!(matches!(r.op, Op::HoldOpen { token: Some(ref t), .. } if t == "u"));
        let r: Request = serde_json::from_str(r#"{"id":4,"op":"holdOpen","pane":"%3"}"#).unwrap();
        assert!(matches!(r.op, Op::HoldOpen { token: None, .. }));
    }
    #[test]
    fn parses_every_op() {
        let ops = [
            r#"{"op":"inventory"}"#, r#"{"op":"titles"}"#, r#"{"op":"processes"}"#,
            r#"{"op":"paneState","pane":"%1"}"#, r#"{"op":"paneInfo","pane":"%1"}"#,
            r#"{"op":"capture","pane":"%1","ansi":true,"visible":false,"historyLines":5}"#,
            r#"{"op":"write","pane":"%1","data":"aA=="}"#,
            r#"{"op":"paste","pane":"%1","text":"x","bracketed":true}"#,
            r#"{"op":"key","pane":"%1","key":"C-c"}"#,
            r#"{"op":"setTitle","pane":"%1","title":"t"}"#,
            r#"{"op":"releaseHold","pane":"%1"}"#,
            r#"{"op":"respawn","pane":"%1","command":["sh"],"expectedHeldToken":"u"}"#,
            r#"{"op":"jobPids","pane":"%1"}"#,
            r#"{"op":"setEngineExit","pane":"%1","status":-1}"#,
        ];
        for (i, o) in ops.iter().enumerate() {
            let json = format!(r#"{{"id":{i},{}"#, &o[1..]);
            serde_json::from_str::<Request>(&json).unwrap_or_else(|e| panic!("{json}: {e}"));
        }
    }
    #[test]
    fn failure_serializes_as_wire_shape() {
        let v = serde_json::to_value(Failure::new(9, "no_pane", "gone")).unwrap();
        assert_eq!(v, serde_json::json!({"id":9,"ok":false,"code":"no_pane","reason":"gone"}));
    }
}
