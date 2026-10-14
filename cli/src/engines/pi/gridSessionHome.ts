/**
 * A Pi conversation an earlier grid launch left in the daemon's own config directory, brought home before a resume.
 *
 * Until 2026-10-14 a grid launch moved Pi's whole home (`PI_CODING_AGENT_DIR`) into a directory under the daemon's
 * data dir, so the sessions of a Pi on a grid were written there. A grid launch now leaves Pi's home where the person
 * keeps it (lib/gridLaunch.ts `piProviderExtension`), and `--session <id>` looks for the conversation there: without
 * this, the first relaunch after the update would find nothing and start fresh.
 */
import { constants, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * Copy [transcriptPath] into [sessionsDir] (Pi's own, `~/.pi/agent/sessions`) when it lies in a Pi home under one of
 * [roots] (each `<root>/<agent>/sessions/<folder>/<file>`), under the same `<folder>/<file>`. A file already there is
 * never replaced, and the original is left where it was. The path Pi will resume from, or null when there was nothing
 * to bring.
 */
export function bringPiSessionHome(transcriptPath: string | null | undefined, roots: readonly string[], sessionsDir: string): string | null {
  if (!transcriptPath) return null
  for (const root of roots) {
    const parts = relative(root, transcriptPath).split(sep)
    if (parts.length !== 4 || parts[0] === '..' || parts[1] !== 'sessions' || !parts[3].endsWith('.jsonl')) continue
    const home = join(sessionsDir, parts[2], parts[3])
    if (existsSync(home)) return home
    mkdirSync(join(sessionsDir, parts[2]), { recursive: true, mode: 0o700 })
    copyFileSync(transcriptPath, home, constants.COPYFILE_EXCL)
    return home
  }
  return null
}
