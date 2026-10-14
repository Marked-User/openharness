/** Which OS community this machine claims, by grid's own rule (autonomous-grid
 * `shared/system/os_grid.py`, ADR 0039 D-c), so a feature offered "on Omarchy" reaches exactly the
 * machines the Omarchy grid admits. Grid has no command that prints it; this reads what grid reads.
 *
 * The set is closed: macOS, Linux, Omarchy. Anything else — Windows included — is no OS grid.
 * Omarchy reports `Linux` like every distribution: it is `ID=omarchy` in `/etc/os-release` (`ID=`,
 * never `ID_LIKE=`, which every Arch derivative shares), or, where Omarchy leaves that file as Arch
 * Linux ARM's (an Apple Silicon Mac), the install's own `/usr/share/omarchy/version`. */
import { readFileSync, statSync } from 'node:fs'

export type OsToken = 'macos' | 'linux' | 'omarchy'

const OS_RELEASE = '/etc/os-release'
const OMARCHY_MARKER = '/usr/share/omarchy/version'
/** Grid's bound on the file it reads: a real one is a few hundred bytes. */
const MAX_OS_RELEASE_BYTES = 64 * 1024

/** `ID=` of [text], unquoted and lower-cased, exactly as grid's `_distro_id` reads it: the first
 * line that starts with `ID=`; '' when there is none. */
export function distroId(text: string): string {
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.startsWith('ID=')) return line.slice(3).trim().replace(/^["']+|["']+$/g, '').trim().toLowerCase()
  }
  return ''
}

/** A file, never a directory: `pacman -R omarchy` can leave `/usr/share/omarchy` behind (grid's `is_file`). */
const isFile = (path: string): boolean => { try { return statSync(path).isFile() } catch { return false } }

export interface OsProbe {
  platform?: NodeJS.Platform
  readOsRelease?: () => string
  markerExists?: () => boolean
}

export function osToken(probe: OsProbe = {}): OsToken | undefined {
  const platform = probe.platform ?? process.platform
  if (platform === 'darwin') return 'macos'
  if (platform !== 'linux') return undefined
  const read = probe.readOsRelease ?? (() => {
    try { return readFileSync(OS_RELEASE, 'utf8').slice(0, MAX_OS_RELEASE_BYTES) } catch { return '' }
  })
  if (distroId(read()) === 'omarchy') return 'omarchy'
  return (probe.markerExists ?? (() => isFile(OMARCHY_MARKER)))() ? 'omarchy' : 'linux'
}
