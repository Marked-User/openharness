import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  prisma: {
    machineShare: { findUnique: vi.fn(), findMany: vi.fn() },
    machineShareAdd: { findUnique: vi.fn(), findMany: vi.fn() },
    machine: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
  presence: vi.fn(), keys: vi.fn(),
}))
vi.mock('./prisma.js', () => ({ prisma: mocks.prisma, machineAlive: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] } }))
vi.mock('./bus.js', () => ({ getAgentPresenceMany: mocks.presence }))
vi.mock('./deviceKeyLog.js', () => ({ activeMachineKeys: mocks.keys }))
import { machinesSharedWith, shareMembers, sharedMachineAccess, sharedVia } from './machineAccess.js'
import { emailDomain, isPublicEmailDomain } from './publicEmailDomains.js'

const pub = (n: number) => Buffer.alloc(32, n).toString('base64')
const kim = { sub: 'kim', email: ' Kim@Acme.io ', role: 'user', autonomousEnv: 'prod' as const }
const share = (patch: Record<string, unknown> = {}) => ({ id: 's1', machineId: 'm1', ownerId: 'owner', autonomousEnv: 'prod',
  emails: [] as string[], domain: null as string | null, createdAt: new Date(), updatedAt: new Date(), ...patch })
const machine = (patch: Record<string, unknown> = {}) => ({ machineId: 'm1', userId: 'owner', autonomousEnv: 'prod', name: 'Studio',
  hostname: 'studio.local', billingStatus: 'not_required', ...patch })

describe('public email domains', () => {
  it('reads a domain, and knows the ones anyone can have an address at', () => {
    expect(emailDomain(' Kim@Acme.IO ')).toBe('acme.io')
    expect(emailDomain('kim@localhost')).toBeNull()
    expect(emailDomain('no-at-all')).toBeNull()
    for (const domain of ['gmail.com', 'GMAIL.COM', 'privaterelay.appleid.com', 'pending.harness.invalid', 'x.invalid', null]) {
      expect(isPublicEmailDomain(domain)).toBe(true)
    }
    expect(isPublicEmailDomain('acme.io')).toBe(false)
  })
})

describe('who a share reaches', () => {
  it('names an address, or everyone at the domain, never a public one', () => {
    expect(sharedVia(share({ emails: ['kim@acme.io'] }), kim.email)).toBe('email')
    expect(sharedVia(share({ domain: 'acme.io' }), kim.email)).toBe('domain')
    expect(sharedVia(share({ domain: 'acme.io' }), 'kim@other.io')).toBeNull()
    // A row that somehow holds a public domain shares with no one through it.
    expect(sharedVia(share({ domain: 'gmail.com' }), 'stranger@gmail.com')).toBeNull()
    expect(sharedVia(share(), kim.email)).toBeNull()
  })
})

describe('sharedMachineAccess', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('lets a named address in, and a colleague only once they added it', async () => {
    mocks.prisma.machineShare.findUnique.mockResolvedValue(share({ emails: ['kim@acme.io'] }))
    expect(await sharedMachineAccess(kim, machine())).toBe('email')
    mocks.prisma.machineShare.findUnique.mockResolvedValue(share({ domain: 'acme.io' }))
    mocks.prisma.machineShareAdd.findUnique.mockResolvedValueOnce(null)
    expect(await sharedMachineAccess(kim, machine())).toBeNull()
    mocks.prisma.machineShareAdd.findUnique.mockResolvedValueOnce({ machineId: 'm1', userId: 'kim' })
    expect(await sharedMachineAccess(kim, machine())).toBe('domain')
    expect(mocks.prisma.machineShareAdd.findUnique).toHaveBeenCalledWith({ where: { machineId_userId: { machineId: 'm1', userId: 'kim' } } })
  })

  it('refuses the owner (no share needed), no share, another owner’s row and another environment', async () => {
    expect(await sharedMachineAccess(kim, machine({ userId: 'kim' }))).toBeNull()
    expect(mocks.prisma.machineShare.findUnique).not.toHaveBeenCalled()
    mocks.prisma.machineShare.findUnique.mockResolvedValueOnce(null)
    expect(await sharedMachineAccess(kim, machine())).toBeNull()
    mocks.prisma.machineShare.findUnique.mockResolvedValueOnce(share({ emails: ['kim@acme.io'], ownerId: 'someone-else' }))
    expect(await sharedMachineAccess(kim, machine())).toBeNull()
    mocks.prisma.machineShare.findUnique.mockResolvedValueOnce(share({ emails: ['kim@acme.io'], autonomousEnv: 'stag' }))
    expect(await sharedMachineAccess(kim, machine())).toBeNull()
    mocks.prisma.machineShare.findUnique.mockResolvedValueOnce(share({ emails: ['kim@acme.io'] }))
    expect(await sharedMachineAccess(kim, machine({ autonomousEnv: 'stag' }))).toBeNull()
    mocks.prisma.machineShare.findUnique.mockResolvedValueOnce(share({ emails: ['ann@acme.io'] }))
    expect(await sharedMachineAccess(kim, machine())).toBeNull()
  })
})

describe('machinesSharedWith', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.presence.mockResolvedValue(new Map([['m1', 'mgr']]))
    mocks.prisma.machineShareAdd.findMany.mockResolvedValue([])
    mocks.prisma.user.findMany.mockResolvedValue([{ id: 'owner', name: 'Dee', email: 'dee@acme.io' }])
    mocks.keys.mockResolvedValue([{ machineId: 'm1', pub: pub(1), label: 'studio', kind: 'machine', addedAt: 1, seq: 1 }])
  })

  it('lists named and domain shares, with the owner, the machine key and whether it was added', async () => {
    mocks.prisma.machineShare.findMany.mockResolvedValue([share({ emails: ['kim@acme.io'] }), share({ machineId: 'm2', domain: 'acme.io' })])
    mocks.prisma.machine.findMany.mockResolvedValue([machine(), machine({ machineId: 'm2', name: null, hostname: null })])
    const rows = await machinesSharedWith(kim)
    expect(mocks.prisma.machineShare.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      autonomousEnv: 'prod', ownerId: { not: 'kim' }, OR: [{ emails: { has: 'kim@acme.io' } }, { domain: 'acme.io' }],
    } }))
    expect(rows).toEqual([
      { machineId: 'm1', name: 'Studio', hostname: 'studio.local', authMode: 'remote', status: 'running', pub: pub(1),
        share: { ownerName: 'Dee', ownerEmail: 'dee@acme.io', via: 'email', added: true } },
      { machineId: 'm2', name: null, hostname: null, authMode: 'remote', status: 'offline', pub: null,
        share: { ownerName: 'Dee', ownerEmail: 'dee@acme.io', via: 'domain', added: false } },
    ])
  })

  it('asks no domain at a public one, and drops deleted, suspended and re-owned machines', async () => {
    const gmail = { ...kim, email: 'kim@gmail.com' }
    mocks.prisma.machineShare.findMany.mockResolvedValue([share({ emails: ['kim@gmail.com'] }), share({ machineId: 'm2', emails: ['kim@gmail.com'] }),
      share({ machineId: 'm3', emails: ['kim@gmail.com'] })])
    mocks.prisma.machine.findMany.mockResolvedValue([machine({ billingStatus: 'suspended' }), machine({ machineId: 'm2', userId: 'thief' })])
    expect(await machinesSharedWith(gmail)).toEqual([])
    expect(mocks.prisma.machineShare.findMany.mock.calls[0][0].where.OR).toEqual([{ emails: { has: 'kim@gmail.com' } }])
  })

  it('answers nothing without touching machines when nothing reaches the person', async () => {
    mocks.prisma.machineShare.findMany.mockResolvedValue([share({ emails: ['ann@acme.io'] })])
    expect(await machinesSharedWith(kim)).toEqual([])
    expect(mocks.prisma.machine.findMany).not.toHaveBeenCalled()
  })

  it('names an owner with no name by email, and one gone as a Harness user; an added domain share reads added', async () => {
    mocks.prisma.machineShare.findMany.mockResolvedValue([share({ domain: 'acme.io' })])
    mocks.prisma.machine.findMany.mockResolvedValue([machine()])
    mocks.prisma.machineShareAdd.findMany.mockResolvedValue([{ machineId: 'm1', userId: 'kim' }])
    mocks.prisma.user.findMany.mockResolvedValueOnce([{ id: 'owner', name: null, email: 'dee@acme.io' }])
    expect((await machinesSharedWith(kim))[0].share).toEqual({ ownerName: 'dee@acme.io', ownerEmail: 'dee@acme.io', via: 'domain', added: true })
    mocks.prisma.user.findMany.mockResolvedValueOnce([])
    expect((await machinesSharedWith(kim))[0].share).toMatchObject({ ownerName: 'Harness user', ownerEmail: '' })
  })
})

describe('shareMembers', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.keys.mockImplementation(async (id: string) => [{ machineId: `${id}-mac`, pub: pub(id.length), label: `${id}'s Mac`, kind: 'machine', addedAt: 1, seq: 1 }])
  })

  it('names the addresses and the colleagues who added it, with their machines’ keys', async () => {
    mocks.prisma.machineShareAdd.findMany.mockResolvedValue([{ machineId: 'm1', userId: 'kim' }])
    mocks.prisma.user.findMany.mockResolvedValue([
      { id: 'ann', email: 'Ann@Gmail.com', name: 'Ann' },
      { id: 'kim', email: 'kim@acme.io', name: null },
      { id: 'lee', email: 'lee@acme.io', name: 'Lee' }, // at the domain, never added
      { id: 'old', email: 'old@other.io', name: 'Old' }, // added once, no longer reached
    ])
    const members = await shareMembers(share({ emails: ['ann@gmail.com'], domain: 'acme.io' }))
    expect(mocks.prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      autonomousEnv: 'prod', id: { not: 'owner' }, OR: [{ email: { in: ['ann@gmail.com'] } }, { id: { in: ['kim'] } }],
    } }))
    expect(members).toEqual([
      { email: 'ann@gmail.com', name: 'Ann', via: 'email', machines: [{ machineId: 'ann-mac', name: "ann's Mac", pub: pub(3) }] },
      { email: 'kim@acme.io', name: null, via: 'domain', machines: [{ machineId: 'kim-mac', name: "kim's Mac", pub: pub(3) }] },
    ])
  })
})
