# Windows native: PTY host and terminal backend (sub-project A)

Date: 2026-10-14
Status: design, awaiting review

## Goal

Run Harness natively on Windows (no WSL), for both uses:

- A Windows user runs the desktop app and CLI on their own machine and drives agents there.
- A Windows machine is a remote machine that a Mac, phone or web client drives.

Every engine is in scope (Claude Code, Codex, plain shell panes, and the rest), and agents must survive
a daemon restart or upgrade, exactly as they do on tmux today.

## Decomposition

Native Windows is several independent projects. Each gets its own spec, plan and implementation:

| | Sub-project | Depends on |
|---|---|---|
| **A** | PTY host + terminal backend + Windows process control (this spec) | — |
| B | CLI on Windows: PowerShell installer, managed runtimes, harnessd under Task Scheduler, IPC trust (named pipe/token), engine launch without POSIX shells, hook commands | A |
| C | Desktop on Windows: runner build, provisioner, replacements for macOS channels (clipboard, notifications, window, fonts, menu), installer | B |
| D | CI and release for Windows artifacts | A–C |

A is first because every other piece needs a terminal backend that is not tmux.

## Current state

- tmux is the only terminal backend (`cli/src/config/terminalConfig.ts`). The `TerminalBackend`
  interface (`cli/src/lib/terminalBackend.ts`) exists, but `core/agents/*` and about 40 other modules
  import tmux helpers directly.
- Process identity, liveness and kill rely on `ps`, `/proc`, process groups and POSIX signals.
- No ConPTY, node-pty or Windows CI exists anywhere in the repo.
- `tui/vendor/alacritty_terminal` already contains a terminal emulator and a `tty` module with Windows
  ConPTY support, and it loads a bundled `conpty.dll` when one is present
  (`src/tty/windows/conpty.rs`).

## Decisions

1. **A Rust PTY host, `harness-pty`**, is a separate long-lived process. It is not node-pty inside the
   daemon (no persistence, no native Node module) and not a third-party tmux clone (control-mode
   compatibility unknown, bugs outside our reach).
2. **Panes outlive the daemon**: the host is not a child of the daemon's lifetime.
3. **Reuse from Orca** (`stablyai/orca`, MIT): selected TypeScript modules and design ideas, not its
   26k-line Electron-bound terminal daemon. Details below.
4. **mac/Linux stay on tmux.** `harness-pty` builds on Unix only so that it can be tested on Linux CI.

## 1. Architecture and components

### `harness-pty` (Rust, new crate `pty/`)

- Shares the vendored `alacritty_terminal` and `vte` from `tui/vendor`.
- One host per user and `HARNESS_HOME`, listening on
  `\\.\pipe\harness-pty-<hash(user SID + HARNESS_HOME)>[-p<protocol>]` with an owner-only DACL.
  On Unix (tests only) it listens on a Unix socket in `HARNESS_HOME/run/`.
- Per pane:
  - a ConPTY via `alacritty_terminal::tty`, using the bundled `conpty.dll`/`OpenConsole.exe`;
  - the child process in its own Job Object (not kill-on-close);
  - an `alacritty_terminal` grid with scrollback bounded like tmux `history-limit`;
  - metadata: id `p<N>`, title (OSC 0/2), cwd (spawn cwd, then OSC 7), owner tag, and a held flag
    (the `remain-on-exit` equivalent);
  - the env var `HARNESS_PANE=<instanceId>:<paneId>` in the child, so hooks can name their pane the
    way they read `TMUX_PANE` today.

### Protocol

- Each client opens two connections, as in Orca:
  - `control`: NDJSON request/response with an `id` per request;
  - `stream`: length-prefixed binary frames, one subscription per pane.
- Handshake: `hello{token, protocolVersion, clientId}`. The token is read from the discovery file
  (section 4).
- Control requests map one to one onto the backend:
  - pane lifecycle: `create`, `kill`, `respawn` (with `expectedHeldToken`), `holdOpen`, `releaseHold`;
  - reads: `inventory`, `titles`, `paneState`, `paneInfo`, `capture{mode, historyLines, ansi}`,
    `processes`, `jobPids`;
  - writes: `write`, `paste`, `key`, `setTitle`, `notify`;
  - stream control: `resize`, `subscribe`, `pause`, `resume`.
- **Snapshots**: the host serializes the viewport from its grid to ANSI and stamps an output sequence
  number atomically with it. `beginSnapshot`/`endSnapshot` become a sequence cut, with no output gating
  like `tmuxStream.ts`. The `tuiOwnsScrollback`, `conversationHistory` and `repaint` options keep
  their current meaning, implemented over the grid.

### Daemon (TypeScript)

- `TerminalBackendName = 'tmux' | 'ptyhost'`.
- `PtyRuntimeRef { backend: 'ptyhost'; paneId: string }`, and
  `TerminalRuntimeRef = TmuxRuntimeRef | PtyRuntimeRef`.
- `cli/src/lib/ptyHostBackend.ts` implements the whole `TerminalBackend`, including `holdOpen`,
  `respawn` and `openStream`, so restart, fork and swap work.
- The default backend is `ptyhost` on `win32` and `tmux` elsewhere. `TERMINAL_BACKENDS` still
  overrides it.
- Windows helpers live in `cli/src/lib/windows/`.

## 2. Removing tmux coupling

The modules outside `lib/tmux*` that import tmux code fall into three groups.

**Group 1: process table and engine recognition.** These are not tmux, they only live in `tmux.ts`:
`processRows`, `ProcessRow`, `argvTokens`, `engineProcessMatch(Score)`, `resumeSessionId`,
`processLaunchArgs`/`launchArgs`, `bypassPermissionActive`, `permissionModeFromArgv`.

- Move them unchanged to `cli/src/lib/processTable.ts`. Only the data source becomes per platform:
  `ps` on Unix, `harness-pty` on Windows (section 3).
- Callers include `engines/kit/adoption`, `nativeConversation`, `captureResumeIdentity`,
  `deleteAgentFallback`, `gridAssignments`, `sessionSearch/externals/*` and `core/engines/hooks`.

**Group 2: pane operations that bypass the backend.** These are `clearPaneRemainOnExit`,
`tmuxPaneState`, `resolvePaneEngineProcess`, `lookupPaneEngineProcess`, `tmuxPaneInfo` and
`checkSessionRuntime`, used by `create`, `newPane`, `restart`, `retarget`, `swap`, `fork`,
`externalResume`, `core/terminals/*` and `resumeAgentService`.

- Add `releaseHold`, `paneState`, `paneInfo` and `rootProcess` to `TerminalBackend`.
- Engine resolution ("which process in this pane is the engine") moves above the backend: it takes the
  pane's root pid from `rootProcess` and searches the Group 1 process table.
- Callers reach the backend through `TerminalBackendCoordinator.backendFor(runtime)`.

**Group 3: tmux bootstrap and version gates.** These are `ensureTmuxOnPath`,
`tmuxSupportsSessionEnv`/`TMUX_SESSION_ENV_MIN`, `adoptLegacyHarnessSessions` and `listTmuxPanes`,
used in `main.ts`, `create.ts`, `launchOverrides.ts` and `resumeAgentService.ts`.

- Add `backend.prepare()`, run at daemon start. For tmux it does the PATH check and legacy adoption;
  for ptyhost it makes sure a host is running and connects to it.
- Add `backend.capabilities` (for example `{ sessionEnv: boolean }`) to replace the scattered tmux
  version checks.
- `listTmuxPanes` callers use `backend.inventory()`.

**Types.** `TmuxRuntimeRef` in `core/agents/*` becomes `TerminalRuntimeRef`, narrowed by `backend`
only where code is tmux-specific. `HookTerminalHint` becomes a union over both backends.

**Order.** Groups 1–3 land first as a pure refactor on mac/Linux with `TmuxBackend` as the only
implementation and no behavior change. `PtyHostBackend` comes after, which keeps refactor risk apart
from Windows risk.

**Not changed:** `tmuxStream.ts`, `tmuxAgentDiscovery.ts`, and the rest of `tmux.ts`. They stay
tmux-private.

## 3. Windows process control

### Process table

`harness-pty ps --json` provides it, as does the `processes` request while a host is running. It is
built from:

- `CreateToolhelp32Snapshot` for pid, parent pid and executable;
- `QueryFullProcessImageNameW` for the image path;
- `NtQueryInformationProcess(ProcessCommandLineInformation)` for the command line, split with
  `CommandLineToArgvW` into `nativeArgv`;
- `GetProcessTimes` for the creation time.

The rows map onto `ProcessRow` with `startMarker = "w:<creation FILETIME>"`. The kernel records the
creation time and a later wall-clock change does not move it, so Windows needs no `startTicks`
equivalent.

This follows the existing macOS pattern, where a bundled helper serves `nativeProcessControl`. It
avoids a native Node addon (`@vscode/windows-process-tree`) and PowerShell CIM scans, which take about
a second each. `cli/hook/notify.mjs`, which runs its own `ps`, uses the same helper.

### Identity

`PtyHostBackend.validate()` answers `alive` only when the engine matches its recorded pid and creation
time **and** its pid is in the pane's Job (`jobPids`, from `JobObjectBasicProcessIdList`). A recycled
pid therefore cannot pass, even with a colliding start time. Orca documents this as an open gap in
`windows-pty-root-identity.ts`, #10680.

### Kill and signals

- **Pane kill** has three steps:
  1. `ClosePseudoConsole`, which delivers `CTRL_CLOSE_EVENT`;
  2. wait the same grace period tmux uses;
  3. `TerminateJobObject`, which kills the whole tree.
- **Process signals**: agent-process kills (`process.kill(pid, SIG…)` in `stopAgentService`,
  `swap`, `tmux.ts` and session search) go through a new `cli/src/lib/processSignals.ts` with
  `terminateProcess(identity, { graceful })`. Daemon and service kills are sub-project B.
  - Unix keeps `process.kill`.
  - Windows asks the host to end the process when it belongs to a pane. Otherwise it runs
    `taskkill /T /F`, guarded by a root-identity check adapted from Orca.
  - The liveness probe (signal 0) is unchanged.
- **Process groups** (pgid/tpgid, negative-pid kills) have no Windows equivalent. The pane's Job takes
  the "whole group" role.

### Unavailable on Windows in v1 (reported as unavailable, not emulated)

- `nativeProcessControl`/`processEvidence`, which control engines running outside Harness. They need
  descriptor enumeration (`lsof`), and Windows handle enumeration is not reliable. These modules
  already return `nativeUnavailable` on unsupported platforms.
- External pane adoption (`externalOwnerControl`, `adoptLegacyHarnessSessions`), because there is no
  user tmux to adopt.
- `macosProcessGpu` and `darwin-process-images.c`, which are macOS only.

Agents created inside Harness keep every operation: create, kill, restart, fork, swap, resume, stream
and capture.

## 4. Lifecycle, upgrade and errors

### Start

- **Production**: the host is a harnessd sub-service (harnessd for Windows is sub-project B and runs
  under Task Scheduler at logon, outside any kill-on-close job). It runs beside the daemon and does
  not restart with it.
- **Development/tests**: without harnessd, `PtyHostBackend.prepare()` spawns
  `harness-pty.exe serve` with `DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB`.
- **Single instance**: the pipe is created with `FILE_FLAG_FIRST_PIPE_INSTANCE`, and a second host
  exits. No lock file is needed.
- **Discovery**: `HARNESS_HOME/run/pty-host-<protocol>.json` holds pipe, pid, creation time, version
  and token. The host writes it with an owner-only DACL.

### Daemon restart or upgrade

The daemon reconnects, calls `inventory()`, and reconciles the registry exactly as with tmux. Agent ids
are kept.

### Host upgrade

- A running `.exe` cannot be overwritten on Windows, so binaries install per version as
  `runtime/pty/<version>/harness-pty.exe` with `conpty.dll` and `OpenConsole.exe`.
- The daemon speaks protocol N and N−1, so it keeps using an older host with no interruption.
- **Drain** on a protocol bump:
  - a new host starts on a pipe suffixed with its protocol;
  - new panes go to the new host;
  - the old host keeps its panes and exits once it has none.

  `TerminalBackendCoordinator` already holds several backend instances (`instanceId`, `byInstance`),
  so each host is one instance. A version directory is removed once no host runs from it.
- **An upgrade never kills an agent.**

### Host crash, logoff or reboot

- Panes die, as when a tmux server dies. The daemon sees the pipe close and marks the runtimes `gone`.
- The existing resume path (`resumeStoppedAgent`) relaunches engines with their resume session ids.
- harnessd restarts the host with backoff.

### Error semantics ("we could not look" is not "nothing is there")

| Situation | Result |
|---|---|
| Pipe unreachable | `inventory` → `unavailable`, never an empty list |
| Request never sent | `not_started` |
| Request sent, no reply before timeout | `possibly_executed` |
| Bad token or protocol mismatch | `incompatible`, with the reason |

### Backpressure

- Each stream subscriber has a bounded buffer (4 MB). Past it, the host drops the subscriber with
  reason `overflow`.
- The daemon resubscribes and receives a fresh keyframe. The grid is authoritative, so only
  intermediate output is lost, as with tmux control mode.

### Resources

- Scrollback is bounded per pane.
- The host logs to `HARNESS_HOME/logs/pty-host.log`, with rotation.

## 5. Testing

### Backend contract suite

`cli/src/lib/terminalBackend.contract.ts` runs one suite against `TmuxBackend` and `PtyHostBackend`.
It covers:

- create and kill;
- inventory and titles;
- capture in all three modes;
- typeLiteral, submitText and sendKey;
- holdOpen → respawn, and releaseHold;
- openStream: snapshot cut, resize, paste, pause/resume, overflow and resubscribe;
- validate when a pid is reused and when the process exits.

`harness-pty` builds on Unix, so the ptyhost half runs in the normal Linux PR CI.

### Rust

`cargo test` covers framing, grid capture and snapshot serialization, subscriber backpressure and
drain. Windows-only units (ConPTY, Jobs, process table) are gated by `cfg(windows)`.

### Refactor gate (section 2)

`test:core`, `test:resume`, `test:orchestrator`, the real-tmux specs and the PTY specs must pass
unchanged, with no snapshot or golden changes. They are run locally per AGENTS.md and recorded in the
PR.

### Windows workflow

A new manual workflow, "Windows PTY", runs on `windows-latest`: `cargo test` and then the contract
suite against a real host. It is not part of PR CI. Build targets are `x86_64-pc-windows-msvc` and
`aarch64-pc-windows-msvc`.

### End to end

E2E runs in a Windows 11 ARM64 VM on the Mac. The Mac desktop app connects to the Windows daemon as a
remote machine, which tests the remote-machine use before sub-project C exists. Scenarios:

1. Create Claude Code, Codex and PowerShell agents. Stream them to the Mac desktop; type, paste large
   text (Vietnamese, CJK) and resize.
2. Restart the daemon: agent ids are kept and streams reattach.
3. Upgrade the host with a protocol bump: the drain moves new panes and old agents survive.
4. Kill the host: resume relaunches the engines.
5. Kill a pane whose engine has child processes: the whole tree is gone and nothing is orphaned.
6. Change the system clock: identities are unchanged.
7. Performance baseline: host idle CPU and memory per pane, compared with tmux on the Mac.

## Reuse from Orca (MIT, attributed in `THIRD_PARTY_NOTICES`)

| Orca source | Use |
|---|---|
| `src/main/windows/windows-process-tree-kill.ts`, `windows-pty-root-identity.ts` | Fallback kill for processes outside a pane (A, section 3) |
| `src/main/git-bash.ts`, `pwsh.ts`, `providers/windows-powershell-executable.ts`, `windows-shell-args.ts`, shell fallback chain | Shell detection; A needs a PowerShell default, B the rest |
| `src/main/pty/windows-environment-path.ts` and the registry PATH reader/merge | Engine environment (B) |
| Two-role connections, versioned hello, batched output with backpressure, Job per shell without kill-on-close, OSC 7 cwd, bundled `conpty.dll`/OpenConsole | Design ideas only, reimplemented |

Not reused: Orca's terminal daemon (Electron-bound), its patched `node-pty` build and its patched
`@xterm/headless`.

## Decisions made while planning

- **Pane ids are `%<n>`, tmux-shaped.** `RegisteredSession.tmuxPane` is sent to clients
  (`lib/agentFrame.ts`), keys the message inbox and is checked by terminal handoff (`/^%\d+$/`).
  Using the same shape keeps all of them working. The registry projects the primary runtime's pane
  into that field for either backend. Route keys carry the backend and host instance, so equal ids on
  two hosts never collide.
- **Capture is byte-compatible with tmux.** `tui/src/capture.rs` already reproduces
  `capture-pane` over an alacritty grid. It moves into a shared crate, `harness-term`, which both
  `hn` and `harness-pty` use.
- **Keyframes reuse `synthesizeTmuxSnapshot`** (`lib/tmuxStream.ts`). The host returns the capture
  and the pane metadata, and the daemon builds the keyframe exactly as it does for tmux.
- **Spawning into the Job is race-free.** The vendored alacritty ConPTY spawn is patched to create
  the child suspended, assign it to the pane's Job, then resume it.
- **Signal scope.** Only agent-process kills (about 22 call sites) move to `processSignals.ts` in A.
  Daemon and service kills belong to B.
- **Host home.** The host's `--home` is `~/.harness/pty` (`HARNESS_PTY_DIR`), which holds `run/`
  and `logs/`.

## Out of scope for A

The installer, harnessd on Windows, named-pipe trust for the daemon socket, engine launch without
POSIX shells and hook command lines (all B); the desktop app (C); release artifacts (D); the `hn` TUI
on Windows; and serial/USB cables.

## Risks

- **ConPTY behavior differences** (resize reflow, DA1 replies, mouse modes) can change what engines
  draw. Mitigation: bundle `conpty.dll`, and test every engine in the E2E matrix.
- **Engine support for Windows** varies, and some engines may not run natively. Each engine's status
  is recorded during E2E; an engine that cannot run is reported as unavailable on Windows, not
  emulated.
- **The Group 2 refactor touches restart, swap and resume**, the most race-sensitive code. Mitigation:
  a separate behavior-preserving PR first, with the full local gates.
