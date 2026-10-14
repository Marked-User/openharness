import { describe, expect, it } from 'vitest'
import { countWindows, localWindowsOf, tuiPresence, WINDOW_SURFACES, windowSurfaceOf } from './windowSurfaces.js'

describe('the windows a person has open, per surface', () => {
  it('reads a surface off the pipe: anything but tui is the desktop app', () => {
    expect(WINDOW_SURFACES).toEqual(['desktop', 'tui'])
    expect(windowSurfaceOf('tui')).toBe('tui')
    for (const value of ['desktop', 'web', undefined, null, 3, {}]) expect(windowSurfaceOf(value)).toBe('desktop')
  })

  it('counts a TUI as the TUI, or as Harness OS on a PC or an Orange Pi', () => {
    const files = (entries: Record<string, string>) => (path: string) => entries[path] ?? ''
    const unit = '/usr/lib/systemd/user/harness-daemon.service'
    const model = '/proc/device-tree/model'
    expect(tuiPresence({}, files({}))).toBe('tui')
    expect(tuiPresence({}, files({ [model]: 'Orange Pi 4 Pro\0' })), 'a board alone is not Harness OS').toBe('tui')
    expect(tuiPresence({ HARNESS_OS: '1' }, files({}))).toBe('harness-os')
    expect(tuiPresence({}, files({ [unit]: '[Unit]' }))).toBe('harness-os')
    expect(tuiPresence({ HARNESS_OS: '1' }, files({ [model]: 'Orange Pi 4 Pro\0' }))).toBe('harness-os-pi')
    expect(tuiPresence({}, files({ [unit]: '[Unit]', [model]: 'OrangePi 5\0' }))).toBe('harness-os-pi')
    expect(tuiPresence({ HARNESS_OS: '1' }, files({ [model]: 'Raspberry Pi 5\0' }))).toBe('harness-os')
    // Orange Pi's own Debian, as an Orange Pi 4 Pro reads it (2026-10-13): the SoC in `model`.
    const compatible = '/proc/device-tree/compatible'
    const release = '/etc/orangepi-release'
    expect(tuiPresence({ HARNESS_OS: '1' }, files({ [model]: 'sun60iw2\0', [compatible]: 'xunlong,orangepi-4-pro\0arm,sun60iw2p1\0' }))).toBe('harness-os-pi')
    expect(tuiPresence({ HARNESS_OS: '1' }, files({ [model]: 'sun60iw2\0', [release]: 'BOARD=orangepi4pro\nBOARD_NAME="Orange Pi 4 Pro"\n' }))).toBe('harness-os-pi')
    expect(tuiPresence({ HARNESS_OS: '1' }, files({ [model]: 'sun60iw2\0' })), 'a SoC alone names no board').toBe('harness-os')
    expect(['tui', 'harness-os']).toContain(tuiPresence())
  })

  it('reads window counts off the pipe, and anything unreadable as none', () => {
    expect(localWindowsOf({ desktop: 2, tui: 1 })).toEqual({ desktop: 2, tui: 1 })
    expect(localWindowsOf({ desktop: 2.7, tui: -1 })).toEqual({ desktop: 2, tui: 0 })
    expect(localWindowsOf({ desktop: 'two', tui: Number.NaN })).toEqual({ desktop: 0, tui: 0 })
    expect(localWindowsOf({ desktop: Number.POSITIVE_INFINITY })).toEqual({ desktop: 0, tui: 0 })
    expect(localWindowsOf(undefined)).toEqual({ desktop: 0, tui: 0 })
    expect(localWindowsOf(null)).toEqual({ desktop: 0, tui: 0 })
  })

  it('counts the loopback clients that are windows: tools are none, and tui windows are their own', () => {
    expect(countWindows(0, 0, 0)).toEqual({ desktop: 0, tui: 0 })
    expect(countWindows(5, 2, 1)).toEqual({ desktop: 2, tui: 1 })
    expect(countWindows(3, 0, 3)).toEqual({ desktop: 0, tui: 3 })
  })
})
