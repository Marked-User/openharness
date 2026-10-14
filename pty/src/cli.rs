//! Command line entry point (stub; later tasks add the server commands).

use crate::protocol::PROTOCOL;

pub fn version_line() -> String {
    format!(
        "{{\"version\":\"{}\",\"protocol\":{}}}",
        env!("CARGO_PKG_VERSION"),
        PROTOCOL
    )
}

pub fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("version") => println!("{}", version_line()),
        _ => {
            eprintln!("usage: harness-pty version");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_line_is_json_with_protocol() {
        let v: serde_json::Value = serde_json::from_str(&version_line()).unwrap();
        assert_eq!(v["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(v["protocol"], PROTOCOL);
    }
}
