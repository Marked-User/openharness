//! Command line: `serve`, `version`, `ps --json`.

use std::path::{Path, PathBuf};

use crate::protocol::PROTOCOL;

/// tmux's default `history-limit`.
const DEFAULT_HISTORY_LIMIT: usize = 2000;

const USAGE: &str =
    "usage: harness-pty serve --home <dir> [--history-limit N] | version | ps --json";

pub fn version_line() -> String {
    format!(
        "{{\"version\":\"{}\",\"protocol\":{}}}",
        env!("CARGO_PKG_VERSION"),
        PROTOCOL
    )
}

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Serve { home: PathBuf, history_limit: usize },
    Version,
    Ps,
}

pub fn parse(args: &[String]) -> Result<Command, String> {
    let mut args = args.iter().map(String::as_str);
    match args.next() {
        Some("version") => Ok(Command::Version),
        Some("ps") => match args.next() {
            Some("--json") => Ok(Command::Ps),
            _ => Err("ps needs --json".into()),
        },
        Some("serve") => {
            let mut home = None;
            let mut history_limit = DEFAULT_HISTORY_LIMIT;
            while let Some(arg) = args.next() {
                match arg {
                    "--home" => {
                        home = Some(PathBuf::from(
                            args.next().ok_or("--home needs a directory")?,
                        ))
                    }
                    "--history-limit" => {
                        history_limit = args
                            .next()
                            .and_then(|n| n.parse().ok())
                            .ok_or("--history-limit needs a number")?
                    }
                    other => return Err(format!("unknown argument {other}")),
                }
            }
            Ok(Command::Serve {
                home: home.ok_or("serve needs --home")?,
                history_limit,
            })
        }
        _ => Err(USAGE.into()),
    }
}

pub fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse(&args) {
        Ok(Command::Version) => println!("{}", version_line()),
        Ok(Command::Ps) => {
            // The process table is Windows-only (Task 18).
            println!("{{\"unsupported\":true}}");
            std::process::exit(3);
        }
        Ok(Command::Serve {
            home,
            history_limit,
        }) => {
            if let Err(err) = serve(&home, history_limit) {
                eprintln!("harness-pty: {err}");
                std::process::exit(1);
            }
        }
        Err(err) => {
            eprintln!("{err}\n{USAGE}");
            std::process::exit(2);
        }
    }
}

/// Create `<home>/run` (owner-only) if it is missing.
fn run_dir(home: &Path) -> std::io::Result<PathBuf> {
    let run = home.join("run");
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&run)?;
    Ok(run)
}

/// Bind the endpoint, publish the discovery file, and serve until killed. Returns at once, with
/// success, when another host already serves this home.
#[cfg(unix)]
pub fn serve(home: &Path, history_limit: usize) -> std::io::Result<()> {
    use crate::transport::{Bound, Listener, unix};
    let run = run_dir(home)?;
    // Owner-only from its creation, so no other user can connect before the chmod. The umask is
    // the process's: set while this is the only thread, restored before panes are spawned.
    let old = unsafe { libc::umask(0o177) };
    let bound = unix::bind(&unix::socket_path(&run));
    unsafe { libc::umask(old) };
    let listener = match bound? {
        Bound::Listening(listener) => listener,
        Bound::Taken => return Ok(()),
    };
    let info = crate::server::HostInfo {
        token: uuid::Uuid::new_v4().to_string(),
        instance: crate::discovery::instance(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        pid: std::process::id(),
    };
    // Before the host is published: a host that cannot keep its pane counter must not serve.
    let (panes, events) =
        crate::panes::Panes::persistent(history_limit, info.instance.clone(), &run)?;
    crate::discovery::write(
        &run,
        &crate::discovery::Discovery {
            protocol: PROTOCOL,
            instance: info.instance.clone(),
            endpoint: listener.endpoint(),
            pid: info.pid,
            version: info.version.clone(),
            token: info.token.clone(),
        },
    )?;
    crate::server::run(listener, panes, events, info)
}

/// The named pipe transport is Task 17.
#[cfg(not(unix))]
pub fn serve(home: &Path, _history_limit: usize) -> std::io::Result<()> {
    run_dir(home)?;
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "serve is not supported on this platform yet",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn version_line_is_json_with_protocol() {
        let v: serde_json::Value = serde_json::from_str(&version_line()).unwrap();
        assert_eq!(v["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(v["protocol"], PROTOCOL);
    }

    #[test]
    fn parses_commands() {
        assert_eq!(parse(&args(&["version"])), Ok(Command::Version));
        assert_eq!(parse(&args(&["ps", "--json"])), Ok(Command::Ps));
        assert_eq!(
            parse(&args(&["serve", "--home", "/h"])),
            Ok(Command::Serve {
                home: "/h".into(),
                history_limit: DEFAULT_HISTORY_LIMIT
            })
        );
        assert_eq!(
            parse(&args(&["serve", "--history-limit", "50", "--home", "/h"])),
            Ok(Command::Serve {
                home: "/h".into(),
                history_limit: 50
            })
        );
        assert!(parse(&args(&["serve"])).is_err());
        assert!(parse(&args(&["serve", "--home"])).is_err());
        assert!(parse(&args(&["serve", "--home", "/h", "--x"])).is_err());
        assert!(parse(&args(&["ps"])).is_err());
        assert!(parse(&args(&[])).is_err());
    }

    #[test]
    fn run_dir_is_created() {
        let home = tempfile::tempdir().unwrap();
        let run = run_dir(&home.path().join("nested")).unwrap();
        assert!(run.is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&run).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }
}
