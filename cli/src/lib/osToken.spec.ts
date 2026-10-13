import { describe, expect, it } from 'vitest'
import { distroId, osToken } from './osToken.js'

const linux = (osRelease: string, marker = false) => osToken({ platform: 'linux', readOsRelease: () => osRelease, markerExists: () => marker })

describe('osToken (grid os_grid.py, ADR 0039 D-c)', () => {
  it('names macOS and Linux, and no OS grid for anything else', () => {
    expect(osToken({ platform: 'darwin' })).toBe('macos')
    expect(linux('ID=fedora\n')).toBe('linux')
    expect(linux('')).toBe('linux')
    expect(osToken({ platform: 'win32' })).toBeUndefined()
    expect(osToken({ platform: 'freebsd' })).toBeUndefined()
  })

  it('reads Omarchy from ID= alone, never from ID_LIKE=', () => {
    expect(linux('NAME="Omarchy"\nID=omarchy\nID_LIKE=arch\n')).toBe('omarchy')
    expect(linux('ID="Omarchy"\n')).toBe('omarchy')
    // EndeavourOS, CachyOS and Manjaro share ID_LIKE=arch with Omarchy: Linux, not Omarchy.
    expect(linux('ID=endeavouros\nID_LIKE=arch\n')).toBe('linux')
    expect(linux('ID_LIKE=omarchy\n')).toBe('linux')
  })

  it('reads Omarchy from its install where os-release stays Arch Linux ARM (an Apple Silicon Mac)', () => {
    expect(linux('ID=archarm\n', true)).toBe('omarchy')
  })

  it('takes the first line that starts with ID=, as grid does', () => {
    expect(distroId('VERSION_ID=3\nID=omarchy\nID=arch\n')).toBe('omarchy')
    expect(distroId(' ID=omarchy\n')).toBe('')
    expect(distroId('ID=\'arch\'\r\n')).toBe('arch')
  })
})
