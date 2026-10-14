# People-based DAU and D1/D2/D3/D7 Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Count distinct people per day (active, working, new, per client) and their D1/D2/D3/D7 returns, only for accounts that share product usage, keeping per-person data 10 days and the history as anonymous totals.

**Architecture:** The backend already sees every signed-in client through the relay sockets (`dailyTracking.ts` touch points). Each touch also writes one pseudonymous activity mark per person per day (`product_usage_activity`, HMAC subject, 10-day TTL) after the existing consent check. An hourly job in the singleton worker turns the marks into `people_*` counters in `product_usage_totals`, and `npm run usage:daily` reports them. No client change is needed to collect; the apps only change their "See what's shared" copy.

**Tech Stack:** Node/TypeScript backend (Fastify, Prisma on MongoDB, vitest), Flutter desktop and phone (copy + widget tests).

**Spec:** `docs/superpowers/specs/2026-10-14-people-dau-retention-design.md`

## Global Constraints

- Collect only while `productUsageChoice(userId).enabled`; turning sharing off (`setProductUsageChoice(userId, false)`) or `POST /api/analytics/delete` deletes the person's marks.
- Never store the raw user id in a mark: `subject = HMAC-SHA256(userId, PRODUCT_USAGE_SUBJECT_KEY)` (hex, first 32 chars).
- No `PRODUCT_USAGE_SUBJECT_KEY` → nothing is written (fail closed; this is the rollout switch).
- A mark stores only `subject, dayUtc, surfaces, worked, signupDay, staff, expiresAt`; no time of day, machine, agent, device, country, version or content.
- Marks expire `dayUtc + 10 days` (TTL on `expiresAt`).
- Surfaces: `desktop`, `tui`, `harness-os`, `harness-os-pi`, `mobile`, `web`.
- Return days: 1, 2, 3, 7. A Dn counter is written only after day C+n has ended; until then it is absent, never zero.
- Staff (`@autonomous.ai`) are excluded from every people counter except `people_staff_active`.
- `people_*` metrics are backend-only: never added to `backend/src/types/productUsage.ts` or `cli/src/lib/productUsageContract.ts`.
- Writing a mark is fire-and-forget on the relay path: never awaited by a socket handler, never throws.
- No third-party analytics service.
- Repo rules: do not commit, push or deploy unless the user asks; leave changes in the working tree. Do not run `dart format` over `desktop/lib/state/app_state.dart` (not touched here anyway).

## Review Focus

1. **One person, two backend processes (PM2 cluster), same day** — both may insert the first mark; the loser hits P2002 and must retry as an update, and `surfaces` may hold a duplicate entry. Expected: one person counted once per surface. Pinned in Task 1 (P2002 retry) and Task 4 (duplicate surfaces collapse).
2. **Sharing turned off mid-day** — expected: the marks are deleted and nothing more is written for that person that day, even from a process that already marked them. Pinned in Task 3.
3. **A touch right before and right after UTC midnight** — expected: two marks on two days; the in-memory de-duplication must not carry over. Pinned in Task 1.
4. **A user row that no longer exists, or a database error** — expected: no mark, no exception reaching the socket. Pinned in Task 1.
5. **Collection not enabled yet (no key in production)** — expected: the report says people counts are not collected, not a table of zeros. Pinned in Task 6.

---

## File structure

| File | Responsibility |
|---|---|
| `backend/prisma/schema.prisma` | `ProductUsageActivity` model |
| `backend/src/config/env.ts` | `PRODUCT_USAGE_SUBJECT_KEY` |
| `backend/src/lib/productUsage.ts` | `activitySubject`, `markActivity`, `deleteActivity`; deletion wired into `setProductUsageChoice` and `deleteLegacyProductUsage`; indexes in `ensureProductUsageExpiry` |
| `backend/src/lib/dailyTracking.ts` | call `markActivity` from the existing touch points |
| `backend/src/analytics/peopleCounters.ts` (new) | pure `peopleCounters(marks, now)` and the `PEOPLE_METRICS` list |
| `backend/src/services/ProductUsagePeopleRollupService.ts` (new) | hourly rollup in the worker |
| `backend/src/worker.ts` | start/stop the rollup |
| `backend/src/analytics/dailyProductPeople.ts` (new) | report section from `people_*` totals |
| `backend/src/productUsageReport.ts` | read `PEOPLE_METRICS`, print `people` |
| `desktop/lib/settings/sections/privacy_section.dart`, `mobile/lib/phone/privacy_page.dart` | "See what's shared" copy |
| `docs/product-measurement.md` | policy text, release note, rollout |

`markActivity` lives in `productUsage.ts` (as the spec says) because it uses `productUsageChoice` from the same file; a separate module would import it back and form a cycle.

---

### Task 1: Activity marks — model, key, `markActivity`

**Files:**
- Modify: `backend/prisma/schema.prisma` (after `model ProductUsageReceipt`)
- Modify: `backend/src/config/env.ts` (env schema, next to `HARNESS_CREDENTIAL_ENCRYPTION_KEY`)
- Modify: `backend/src/lib/productUsage.ts`
- Test: `backend/src/lib/productUsage.test.ts`

**Interfaces:**
- Produces:
  - `export const ACTIVITY_SURFACES = ['desktop','tui','harness-os','harness-os-pi','mobile','web'] as const`
  - `export type ActivitySurface = typeof ACTIVITY_SURFACES[number]`
  - `export const ACTIVITY_DAYS = 10`
  - `export function activitySubject(userId: string, key: string): string`
  - `export async function markActivity(userId: string, now: Date, mark: { surface?: ActivitySurface; worked?: boolean }, key?: string): Promise<void>` (never throws; `key` defaults to `env.PRODUCT_USAGE_SUBJECT_KEY`)
  - `export function resetActivityMarksForTests(): void`
  - Prisma delegate `prisma.productUsageActivity` with unique `subject_dayUtc`.

- [ ] **Step 1: Add the model**

In `backend/prisma/schema.prisma`, after `model ProductUsageReceipt { … }`:

```prisma
/// One UTC day a person used Harness while sharing product usage, under a keyed pseudonym
/// (HMAC of the user id; never the id itself). Expires 10 days after the day; the hourly rollup
/// keeps only anonymous `people_*` totals. Deleted at once when the person turns sharing off.
model ProductUsageActivity {
  id        String   @id @default(auto()) @map("_id") @db.ObjectId
  subject   String
  dayUtc    DateTime
  surfaces  String[]
  worked    Boolean  @default(false)
  signupDay DateTime
  staff     Boolean
  expiresAt DateTime

  @@unique([subject, dayUtc])
  @@map("product_usage_activity")
}
```

Run: `cd backend && npx prisma generate`
Expected: `Generated Prisma Client`.

- [ ] **Step 2: Add the key to the env schema**

In `backend/src/config/env.ts`, inside `envSchema`, after `HARNESS_CREDENTIAL_ENCRYPTION_KEY`:

```ts
  // Keys the pseudonym of a person's 10-day activity marks (lib/productUsage.ts `markActivity`).
  // Empty: no marks are written. Set it only after the apps describing the marks have shipped.
  PRODUCT_USAGE_SUBJECT_KEY: z.string().refine(v => v === '' || v.length >= 32, 'must be at least 32 characters').default(''),
```

- [ ] **Step 3: Write the failing tests**

In `backend/src/lib/productUsage.test.ts`:

1. Extend the hoisted `db` mock:
```ts
  productUsageActivity: { upsert: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  user: { findUnique: vi.fn() },
```
2. Extend the import from `./productUsage.js` with `activitySubject, markActivity, resetActivityMarksForTests`.
3. In `beforeEach`, add:
```ts
  resetActivityMarksForTests()
  db.user.findUnique.mockResolvedValue({ createdAt: new Date('2026-10-01T08:00:00Z'), email: 'person@example.com' })
```
4. Append:
```ts
describe('activity marks', () => {
  const KEY = 'k'.repeat(32)
  const at = new Date('2026-10-13T12:00:00Z')

  it('writes one pseudonymous mark per person per day, never the account id', async () => {
    await markActivity('PRIVATE_ACCOUNT', at, { surface: 'desktop' }, KEY)
    expect(db.productUsageActivity.upsert).toHaveBeenCalledOnce()
    const call = db.productUsageActivity.upsert.mock.calls[0][0]
    const subject = activitySubject('PRIVATE_ACCOUNT', KEY)
    expect(subject).toMatch(/^[0-9a-f]{32}$/)
    expect(call).toEqual({
      where: { subject_dayUtc: { subject, dayUtc: new Date('2026-10-13') } },
      update: { surfaces: { push: 'desktop' } },
      create: { subject, dayUtc: new Date('2026-10-13'), surfaces: ['desktop'], worked: false,
        signupDay: new Date('2026-10-01'), staff: false, expiresAt: new Date('2026-10-23') },
    })
    expect(JSON.stringify(call)).not.toContain('PRIVATE_ACCOUNT')
    expect(JSON.stringify(call)).not.toContain('person@example.com')
  })

  it('writes nothing without a key or while sharing is off', async () => {
    await markActivity('a', at, { surface: 'desktop' }, '')
    db.productUsagePreference.findUnique.mockResolvedValue({ enabled: false, revision: 3 })
    await markActivity('a', at, { surface: 'desktop' }, KEY)
    expect(db.productUsageActivity.upsert).not.toHaveBeenCalled()
  })

  it('costs one write per person, surface and kind a day, however often pings arrive', async () => {
    for (let i = 0; i < 5; i++) await markActivity('a', at, { surface: 'desktop' }, KEY)
    await markActivity('a', at, { surface: 'mobile' }, KEY)
    for (let i = 0; i < 3; i++) await markActivity('a', at, { worked: true }, KEY)
    expect(db.productUsageActivity.upsert).toHaveBeenCalledTimes(3)
    expect(db.productUsageActivity.upsert.mock.calls[2][0].update).toEqual({ worked: true })
  })

  it('starts a new day at UTC midnight', async () => {
    await markActivity('a', new Date('2026-10-13T23:59:59.999Z'), { surface: 'web' }, KEY)
    await markActivity('a', new Date('2026-10-14T00:00:00.000Z'), { surface: 'web' }, KEY)
    expect(db.productUsageActivity.upsert.mock.calls.map(c => c[0].where.subject_dayUtc.dayUtc))
      .toEqual([new Date('2026-10-13'), new Date('2026-10-14')])
  })

  it('marks staff so the rollup can leave them out', async () => {
    db.user.findUnique.mockResolvedValue({ createdAt: at, email: 'Someone@Autonomous.AI' })
    await markActivity('a', at, { worked: true }, KEY)
    expect(db.productUsageActivity.upsert.mock.calls[0][0].create).toMatchObject({ staff: true, worked: true, surfaces: [] })
  })

  it('retries a lost first-insert race as an update', async () => {
    db.productUsageActivity.upsert.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }))
    await markActivity('a', at, { surface: 'tui' }, KEY)
    expect(db.productUsageActivity.update).toHaveBeenCalledWith({
      where: { subject_dayUtc: { subject: activitySubject('a', KEY), dayUtc: new Date('2026-10-13') } },
      data: { surfaces: { push: 'tui' } },
    })
  })

  it('never throws: a missing user or a database error writes nothing and is retried next time', async () => {
    db.user.findUnique.mockResolvedValueOnce(null)
    await expect(markActivity('gone', at, { surface: 'desktop' }, KEY)).resolves.toBeUndefined()
    db.productUsageActivity.upsert.mockRejectedValueOnce(new Error('PRIVATE_DB_ERROR'))
    await expect(markActivity('a', at, { surface: 'desktop' }, KEY)).resolves.toBeUndefined()
    await markActivity('a', at, { surface: 'desktop' }, KEY)
    expect(db.productUsageActivity.upsert).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 4: Run the tests to see them fail**

Run: `cd backend && npm test -- src/lib/productUsage.test.ts`
Expected: FAIL — `markActivity` / `activitySubject` / `resetActivityMarksForTests` are not exported.

- [ ] **Step 5: Implement**

In `backend/src/lib/productUsage.ts`:

1. Imports at the top:
```ts
import { createHmac } from 'node:crypto'
import { env } from '../config/env.js'
```
2. After `recordRelayUsage`:
```ts
export const ACTIVITY_SURFACES = ['desktop', 'tui', 'harness-os', 'harness-os-pi', 'mobile', 'web'] as const
export type ActivitySurface = typeof ACTIVITY_SURFACES[number]
/** Marks live past D7: cohort C's D7 is computed during C+8, with the hourly rollup's slack. */
export const ACTIVITY_DAYS = 10
const STAFF_EMAIL = '@autonomous.ai'

/** A keyed pseudonym: the same person maps to the same subject; the id never reaches the marks. */
export function activitySubject(userId: string, key: string): string {
  return createHmac('sha256', key).update(userId).digest('hex').slice(0, 32)
}

// This process's marks already written today: a person costs a few writes a day, not one per ping.
const marked = new Set<string>()
let markedDay = ''
export function resetActivityMarksForTests(): void { marked.clear(); markedDay = '' }
let activityWarnedAt = 0

/** Fire-and-forget from the relay touch points; never awaited by a socket, never throws. */
export async function markActivity(userId: string, now: Date, mark: { surface?: ActivitySurface; worked?: boolean },
  key: string = env.PRODUCT_USAGE_SUBJECT_KEY): Promise<void> {
  if (!key || (!mark.surface && !mark.worked)) return
  try {
    const dayUtc = new Date(Math.floor(now.getTime() / DAY) * DAY)
    const day = dayUtc.toISOString().slice(0, 10)
    if (day !== markedDay) { marked.clear(); markedDay = day }
    const subject = activitySubject(userId, key)
    const seen = `${subject}|${mark.surface ?? ''}|${mark.worked ? 'w' : ''}`
    if (marked.has(seen)) return
    if (!(await productUsageChoice(userId)).enabled) return
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true, email: true } })
    if (!user) return
    const where = { subject_dayUtc: { subject, dayUtc } }
    const update = { ...(mark.surface ? { surfaces: { push: mark.surface } } : {}), ...(mark.worked ? { worked: true } : {}) }
    try {
      await prisma.productUsageActivity.upsert({ where, update, create: {
        subject, dayUtc, surfaces: mark.surface ? [mark.surface] : [], worked: mark.worked === true,
        signupDay: new Date(Math.floor(user.createdAt.getTime() / DAY) * DAY),
        staff: user.email.toLowerCase().endsWith(STAFF_EMAIL),
        expiresAt: new Date(dayUtc.getTime() + ACTIVITY_DAYS * DAY),
      } })
    } catch (error) {
      // Another server process inserted this person's first mark of the day first.
      if ((error as { code?: string }).code !== 'P2002') throw error
      await prisma.productUsageActivity.update({ where, data: update })
    }
    marked.add(seen)
  } catch {
    if (Date.now() - activityWarnedAt >= 60_000) {
      activityWarnedAt = Date.now()
      console.warn('[product-usage] Some activity marks are unavailable.')
    }
  }
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `cd backend && npm test -- src/lib/productUsage.test.ts`
Expected: PASS (all, including the existing ones).

- [ ] **Step 7: Typecheck and checkpoint**

Run: `cd backend && npx tsc --noEmit`
Expected: no output. Leave the changes uncommitted unless the user asks to commit.

---

### Task 2: Mark activity from the relay touch points

**Files:**
- Modify: `backend/src/lib/dailyTracking.ts`
- Test: `backend/src/lib/dailyTracking.test.ts`

**Interfaces:**
- Consumes: `markActivity(userId, now, { surface?, worked? })` from Task 1.
- Produces: no new exports. `touchUserOnlineDay`, `touchClientOnlineDay` and `recordTurnStarted` keep their signatures.

- [ ] **Step 1: Write the failing tests**

In `backend/src/lib/dailyTracking.test.ts`, change the mock and add tests:

```ts
const record = vi.hoisted(() => vi.fn())
const mark = vi.hoisted(() => vi.fn())
vi.mock('./productUsage.js', () => ({ recordRelayUsage: record, markActivity: mark }))
```
In `beforeEach` add `mark.mockReset(); mark.mockResolvedValue(undefined)`. Replace the test `'idle heartbeats add no analytics records'` with:

```ts
it('idle heartbeats add no relay totals but keep the person active', async () => {
  const now = new Date()
  await touchUserOnlineDay('a', 'm', now, { isNewConnection: false })
  await touchClientOnlineDay('a', 'tui', now, { isNewConnection: false })
  await touchDeviceOnlineDay('a', 'd', now, { isNewConnection: false })
  await touchMachineOnlineDay('a', 'm', now, { isNewConnection: false })
  expect(record).not.toHaveBeenCalled()
  expect(mark.mock.calls).toEqual([['a', now, { surface: 'desktop' }], ['a', now, { surface: 'tui' }]])
})

it('marks the person, not the machine, agent or device', async () => {
  const now = new Date('2026-10-13T12:00:00Z')
  await touchUserOnlineDay('account', 'PRIVATE_MACHINE', now, { isNewConnection: true })
  await touchClientOnlineDay('account', 'mobile', now, { isNewConnection: true })
  await touchDeviceOnlineDay('account', 'PRIVATE_DEVICE', now, { isNewConnection: true, countryCode: 'VN' })
  await recordTurnStarted('account', 'PRIVATE_MACHINE', 'PRIVATE_AGENT', now)
  expect(mark.mock.calls).toEqual([
    ['account', now, { surface: 'desktop' }], ['account', now, { surface: 'mobile' }], ['account', now, { worked: true }],
  ])
  expect(JSON.stringify(mark.mock.calls)).not.toContain('PRIVATE_')
})

it('a failing mark never reaches the socket', async () => {
  mark.mockRejectedValue(new Error('PRIVATE'))
  await expect(touchUserOnlineDay('a', 'm', new Date(), { isNewConnection: true })).resolves.toBeUndefined()
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && npm test -- src/lib/dailyTracking.test.ts`
Expected: FAIL — `mark` is never called.

- [ ] **Step 3: Implement**

In `backend/src/lib/dailyTracking.ts`:

```ts
import { markActivity, recordRelayUsage } from './productUsage.js'
```
and change the three functions:

```ts
export async function touchUserOnlineDay(userId: string, _machineId: string, now: Date, opts: { isNewConnection: boolean }): Promise<void> {
  // The person is active today whether this is an open or a ping; only opens add a relay total.
  void markActivity(userId, now, { surface: 'desktop' }).catch(() => {})
  if (opts.isNewConnection) await recordRelayUsage(userId, now, 'relay_desktop_opens')
}
export async function recordTurnStarted(userId: string, _machineId: string, _agentId: string, now: Date): Promise<void> {
  void markActivity(userId, now, { worked: true }).catch(() => {})
  await recordRelayUsage(userId, now, 'relay_turns_started')
}
export async function touchClientOnlineDay(
  userId: string, surface: ClientSurface, now: Date, opts: { isNewConnection: boolean },
): Promise<void> {
  void markActivity(userId, now, { surface }).catch(() => {})
  if (opts.isNewConnection) await recordRelayUsage(userId, now, `relay_${surface}_opens`)
}
```
(`ClientSurface` is a subset of `ActivitySurface`, so `{ surface }` type-checks.) Update the module comment's first line to: `Relay signals contribute daily fleet totals and, while sharing is on, a person's 10-day activity mark (lib/productUsage.ts markActivity).`

- [ ] **Step 4: Run them to see them pass**

Run: `cd backend && npm test -- src/lib/dailyTracking.test.ts && npx tsc --noEmit`
Expected: PASS, no tsc output. Checkpoint (no commit unless asked).

---

### Task 3: Delete a person's marks when they stop sharing

**Files:**
- Modify: `backend/src/lib/productUsage.ts` (`setProductUsageChoice`, `deleteLegacyProductUsage`, new `deleteActivity`)
- Test: `backend/src/lib/productUsage.test.ts`

**Interfaces:**
- Consumes: `activitySubject`, the in-memory `marked` set from Task 1.
- Produces: `export async function deleteActivity(userId: string, key?: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Append to the `describe('activity marks')` block in `backend/src/lib/productUsage.test.ts` (import `deleteActivity` too):

```ts
  it('deletes the person\'s marks when sharing is turned off, and writes no more that day', async () => {
    await markActivity('a', at, { surface: 'desktop' }, KEY)
    db.productUsagePreference.upsert.mockResolvedValue({ enabled: false, revision: 2 })
    await setProductUsageChoice('a', false)
    // setProductUsageChoice uses the configured key; exercise the explicit-key path too.
    await deleteActivity('a', KEY)
    expect(db.productUsageActivity.deleteMany).toHaveBeenLastCalledWith({ where: { subject: activitySubject('a', KEY) } })
    db.productUsagePreference.findUnique.mockResolvedValue({ enabled: false, revision: 2 })
    await markActivity('a', at, { surface: 'desktop' }, KEY)
    expect(db.productUsageActivity.upsert).toHaveBeenCalledOnce()
  })

  it('turning sharing on deletes nothing', async () => {
    db.productUsagePreference.upsert.mockResolvedValue({ enabled: true, revision: 3 })
    await setProductUsageChoice('a', true)
    expect(db.productUsageActivity.deleteMany).not.toHaveBeenCalled()
  })
```
And in the existing legacy-deletion test (the one calling `deleteLegacyProductUsage`), add an expectation that `deleteActivity` ran when a key is configured — since tests run without `PRODUCT_USAGE_SUBJECT_KEY`, assert the call count is unchanged instead:
```ts
  expect(db.productUsageActivity.deleteMany).not.toHaveBeenCalled() // no key configured in tests
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && npm test -- src/lib/productUsage.test.ts`
Expected: FAIL — `deleteActivity` is not exported.

- [ ] **Step 3: Implement**

In `backend/src/lib/productUsage.ts`:

```ts
/** Remove a person's marks at once, here and in this process's de-duplication. */
export async function deleteActivity(userId: string, key: string = env.PRODUCT_USAGE_SUBJECT_KEY): Promise<void> {
  if (!key) return
  const subject = activitySubject(userId, key)
  for (const seen of [...marked]) if (seen.startsWith(subject + '|')) marked.delete(seen)
  await prisma.productUsageActivity.deleteMany({ where: { subject } })
}
```
Change `setProductUsageChoice` to delete on off:
```ts
export async function setProductUsageChoice(userId: string, enabled: boolean): Promise<ProductUsageChoice> {
  // Every explicit save advances the generation. A queue prepared before an off/on cycle is refused.
  const choice = await prisma.productUsagePreference.upsert({
    where: { userId }, create: { userId, enabled, revision: 1 },
    update: { enabled, revision: { increment: 1 } }, select: { enabled: true, revision: true },
  })
  if (!enabled) await deleteActivity(userId)
  return choice
}
```
And add `deleteActivity(userId)` to the `Promise.all` in `deleteLegacyProductUsage`.

Note: another server process may still hold "already marked" for this person until midnight, so it writes nothing more today either — the intended behavior; turning sharing back on the same day resumes the next day in that process.

- [ ] **Step 4: Run them to see them pass**

Run: `cd backend && npm test -- src/lib/productUsage.test.ts src/routes/productUsage.test.ts`
Expected: PASS. Checkpoint.

`harness privacy status` prints only on/off (`cli/src/lib/privacyCommand.ts`), so the CLI needs no copy change.

---

### Task 4: Pure people counters

**Files:**
- Create: `backend/src/analytics/peopleCounters.ts`
- Test: `backend/src/analytics/peopleCounters.test.ts`

**Interfaces:**
- Consumes: `ACTIVITY_SURFACES` from `../lib/productUsage.js` (type-only import of the surfaces list is fine: `import { ACTIVITY_SURFACES } from '../lib/productUsage.js'`).
- Produces:
  - `export interface ActivityMark { subject: string; dayUtc: Date; surfaces: string[]; worked: boolean; signupDay: Date; staff: boolean }`
  - `export const PEOPLE_RETURN_DAYS = [1, 2, 3, 7] as const`
  - `export const PEOPLE_METRICS: readonly string[]` — every metric name below
  - `export function peopleCounters(marks: ActivityMark[], now: Date): { day: string; metric: string; value: number }[]`

Metric names (exact):
- per day: `people_active`, `people_working`, `people_new`, `people_staff_active`, `people_active_<surface>` for each surface
- per cohort day and n ∈ {1,2,3,7}: `people_active_d<n>_returned`, `people_working_d<n>_returned`, `people_new_d<n>_returned`, `people_active_<surface>_d<n>_returned`

- [ ] **Step 1: Write the failing tests**

`backend/src/analytics/peopleCounters.test.ts`:

```ts
import { expect, it } from 'vitest'
import { PEOPLE_METRICS, peopleCounters, type ActivityMark } from './peopleCounters.js'

const m = (subject: string, day: string, over: Partial<ActivityMark> = {}): ActivityMark => ({
  subject, dayUtc: new Date(day), surfaces: ['desktop'], worked: false, signupDay: new Date('2026-09-01'), staff: false, ...over,
})
const asMap = (rows: { day: string; metric: string; value: number }[]) =>
  Object.fromEntries(rows.map(r => [`${r.day}:${r.metric}`, r.value]))

it('counts people per ended day, per surface, working, new and staff apart', () => {
  const c = asMap(peopleCounters([
    m('a', '2026-10-10', { surfaces: ['desktop', 'mobile', 'desktop'], worked: true }),
    m('b', '2026-10-10', { surfaces: ['web'], signupDay: new Date('2026-10-10') }),
    m('s', '2026-10-10', { staff: true, worked: true }),
    m('a', '2026-10-13'),
  ], new Date('2026-10-13T09:00:00Z')))
  expect(c['2026-10-10:people_active']).toBe(2)
  expect(c['2026-10-10:people_working']).toBe(1)
  expect(c['2026-10-10:people_new']).toBe(1)
  expect(c['2026-10-10:people_staff_active']).toBe(1)
  expect(c['2026-10-10:people_active_desktop']).toBe(1) // duplicate surface entries collapse
  expect(c['2026-10-10:people_active_mobile']).toBe(1)
  expect(c['2026-10-10:people_active_web']).toBe(1)
  expect(c['2026-10-10:people_active_tui']).toBe(0)
  expect(c['2026-10-13:people_active']).toBeUndefined() // today has not ended
})

it('writes Dn returns only once day C+n has ended, zero when nobody came back', () => {
  const marks = [
    m('a', '2026-10-01', { worked: true, signupDay: new Date('2026-10-01') }), m('b', '2026-10-01'),
    m('a', '2026-10-02', { worked: true }), m('a', '2026-10-04', { surfaces: ['mobile'] }), m('b', '2026-10-08'),
  ]
  const c = asMap(peopleCounters(marks, new Date('2026-10-08T10:00:00Z')))
  expect(c['2026-10-01:people_active_d1_returned']).toBe(1)
  expect(c['2026-10-01:people_working_d1_returned']).toBe(1)
  expect(c['2026-10-01:people_new_d1_returned']).toBe(1)
  expect(c['2026-10-01:people_active_d2_returned']).toBe(0)
  expect(c['2026-10-01:people_active_d3_returned']).toBe(1)
  expect(c['2026-10-01:people_active_desktop_d3_returned']).toBe(0) // same surface only
  expect(c['2026-10-01:people_active_d7_returned']).toBeUndefined() // 2026-10-08 has not ended
  const later = asMap(peopleCounters(marks, new Date('2026-10-09T00:30:00Z')))
  expect(later['2026-10-01:people_active_d7_returned']).toBe(1)
})

it('leaves staff out of every return and is identical on re-run', () => {
  const marks = [m('s', '2026-10-01', { staff: true }), m('s', '2026-10-02', { staff: true }), m('a', '2026-10-01')]
  const now = new Date('2026-10-05T00:00:00Z')
  const first = peopleCounters(marks, now)
  expect(asMap(first)['2026-10-01:people_active_d1_returned']).toBe(0)
  expect(peopleCounters([...marks].reverse(), now)).toEqual(first)
})

it('names only metrics in PEOPLE_METRICS', () => {
  const rows = peopleCounters([m('a', '2026-10-01'), m('a', '2026-10-08')], new Date('2026-10-20'))
  for (const r of rows) expect(PEOPLE_METRICS).toContain(r.metric)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && npm test -- src/analytics/peopleCounters.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`backend/src/analytics/peopleCounters.ts`:

```ts
import { ACTIVITY_SURFACES } from '../lib/productUsage.js'

const DAY = 86_400_000
export const PEOPLE_RETURN_DAYS = [1, 2, 3, 7] as const
export interface ActivityMark { subject: string; dayUtc: Date; surfaces: string[]; worked: boolean; signupDay: Date; staff: boolean }
type Counter = { day: string; metric: string; value: number }

const KINDS = ['active', 'working', 'new', ...ACTIVITY_SURFACES.map(s => `active_${s}`)] as const
export const PEOPLE_METRICS: readonly string[] = [
  'people_active', 'people_working', 'people_new', 'people_staff_active',
  ...ACTIVITY_SURFACES.map(s => `people_active_${s}`),
  ...KINDS.flatMap(kind => PEOPLE_RETURN_DAYS.map(n => `people_${kind}_d${n}_returned`)),
]

const dayKey = (d: Date) => d.toISOString().slice(0, 10)

/** Distinct people per ended UTC day and their D1/D2/D3/D7 returns. Staff count only as staff. */
export function peopleCounters(marks: ActivityMark[], now: Date): Counter[] {
  const today = Math.floor(now.getTime() / DAY) * DAY
  type Person = { surfaces: Set<string>; worked: boolean; isNew: boolean }
  const byDay = new Map<number, Map<string, Person>>()
  const staffByDay = new Map<number, Set<string>>()
  for (const mark of marks) {
    const day = Math.floor(mark.dayUtc.getTime() / DAY) * DAY
    if (mark.staff) { (staffByDay.get(day) ?? staffByDay.set(day, new Set()).get(day)!).add(mark.subject); continue }
    const people = byDay.get(day) ?? byDay.set(day, new Map()).get(day)!
    const person = people.get(mark.subject) ?? { surfaces: new Set<string>(), worked: false, isNew: false }
    for (const s of mark.surfaces) person.surfaces.add(s)
    person.worked ||= mark.worked
    person.isNew ||= Math.floor(mark.signupDay.getTime() / DAY) * DAY === day
    people.set(mark.subject, person)
  }
  const inKind = (p: Person | undefined, kind: string): boolean => !!p && (kind === 'active' ? true
    : kind === 'working' ? p.worked : kind === 'new' ? p.isNew : p.surfaces.has(kind.slice('active_'.length)))
  const days = [...new Set([...byDay.keys(), ...staffByDay.keys()])].filter(d => d < today).sort((a, b) => a - b)
  const out: Counter[] = []
  for (const day of days) {
    const people = byDay.get(day) ?? new Map<string, Person>()
    const key = dayKey(new Date(day))
    const count = (kind: string) => [...people.values()].filter(p => inKind(p, kind)).length
    out.push({ day: key, metric: 'people_active', value: people.size })
    out.push({ day: key, metric: 'people_working', value: count('working') })
    out.push({ day: key, metric: 'people_new', value: count('new') })
    out.push({ day: key, metric: 'people_staff_active', value: staffByDay.get(day)?.size ?? 0 })
    for (const s of ACTIVITY_SURFACES) out.push({ day: key, metric: `people_active_${s}`, value: count(`active_${s}`) })
    for (const n of PEOPLE_RETURN_DAYS) {
      if (day + (n + 1) * DAY > today) continue // C+n has not ended yet
      const later = byDay.get(day + n * DAY) ?? new Map<string, Person>()
      for (const kind of KINDS) {
        // Returning means active again; for working, working again; for a surface, the same surface.
        const back = kind === 'working' ? 'working' : kind.startsWith('active_') ? kind : 'active'
        const value = [...people].filter(([subject, p]) => inKind(p, kind) && inKind(later.get(subject), back)).length
        out.push({ day: key, metric: `people_${kind}_d${n}_returned`, value })
      }
    }
  }
  return out
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `cd backend && npm test -- src/analytics/peopleCounters.test.ts && npx tsc --noEmit`
Expected: PASS, no tsc output. Checkpoint.

---

### Task 5: Hourly rollup in the worker, and the indexes

**Files:**
- Create: `backend/src/services/ProductUsagePeopleRollupService.ts`
- Test: `backend/src/services/ProductUsagePeopleRollupService.test.ts`
- Modify: `backend/src/worker.ts`
- Modify: `backend/src/lib/productUsage.ts` (`ensureProductUsageExpiry`)
- Modify test: `backend/src/lib/productUsage.test.ts` (index call count)

**Interfaces:**
- Consumes: `peopleCounters`, `ActivityMark` (Task 4); `ACTIVITY_DAYS` (Task 1).
- Produces: `export async function rollupPeople(now?: Date): Promise<number>`; `export const productUsagePeopleRollupService: { start(): void; stop(): void }`.

- [ ] **Step 1: Write the failing tests**

`backend/src/services/ProductUsagePeopleRollupService.test.ts`:

```ts
import { beforeEach, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ productUsageActivity: { findMany: vi.fn() }, productUsageTotal: { upsert: vi.fn() } }))
vi.mock('../lib/prisma.js', () => ({ prisma: db }))
import { rollupPeople } from './ProductUsagePeopleRollupService.js'

beforeEach(() => { vi.resetAllMocks(); db.productUsageTotal.upsert.mockResolvedValue({}) })

it('reads only the live window of marks and writes totals with $set, never $inc', async () => {
  db.productUsageActivity.findMany.mockResolvedValue([
    { subject: 'x', dayUtc: new Date('2026-10-12'), surfaces: ['web'], worked: true, signupDay: new Date('2026-09-01'), staff: false },
  ])
  const written = await rollupPeople(new Date('2026-10-14T05:00:00Z'))
  expect(db.productUsageActivity.findMany.mock.calls[0][0].where).toEqual({ dayUtc: { gte: new Date('2026-10-03') } })
  expect(written).toBeGreaterThan(0)
  expect(db.productUsageTotal.upsert).toHaveBeenCalledWith({
    where: { dayUtc_metric: { dayUtc: new Date('2026-10-12'), metric: 'people_active' } },
    create: { dayUtc: new Date('2026-10-12'), metric: 'people_active', value: 1 }, update: { value: 1 },
  })
  expect(JSON.stringify(db.productUsageTotal.upsert.mock.calls)).not.toContain('"x"')
})
```

In `backend/src/lib/productUsage.test.ts`, the test asserting `toHaveBeenCalledTimes(12)` for `ensureProductUsageExpiry` becomes:
```ts
  expect(db.$runCommandRaw).toHaveBeenCalledTimes(14)
  expect(db.$runCommandRaw.mock.calls[12][0]).toMatchObject({ createIndexes: 'product_usage_activity', indexes: [{ key: { expiresAt: 1 }, expireAfterSeconds: 0 }] })
  expect(db.$runCommandRaw.mock.calls[13][0]).toMatchObject({ createIndexes: 'product_usage_activity', indexes: [{ key: { subject: 1, dayUtc: 1 }, unique: true }] })
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && npm test -- src/services/ProductUsagePeopleRollupService.test.ts src/lib/productUsage.test.ts`
Expected: FAIL — module missing; 12 ≠ 14.

- [ ] **Step 3: Implement the service**

`backend/src/services/ProductUsagePeopleRollupService.ts`:

```ts
import { peopleCounters } from '../analytics/peopleCounters.js'
import { ACTIVITY_DAYS } from '../lib/productUsage.js'
import { prisma } from '../lib/prisma.js'
import { logger } from '../utils/logger.js'

const DAY = 86_400_000
const INTERVAL_MS = 60 * 60_000

/** Recompute people totals for every ended day whose marks still live. Idempotent ($set). */
export async function rollupPeople(now = new Date()): Promise<number> {
  const today = Math.floor(now.getTime() / DAY) * DAY
  // ponytail: reads every live mark (≤ people × 11 days); move to an aggregation pipeline if that grows past ~100k rows.
  const marks = await prisma.productUsageActivity.findMany({
    where: { dayUtc: { gte: new Date(today - (ACTIVITY_DAYS + 1) * DAY) } },
    select: { subject: true, dayUtc: true, surfaces: true, worked: true, signupDay: true, staff: true },
  })
  const counters = peopleCounters(marks, now)
  for (const { day, metric, value } of counters) {
    const dayUtc = new Date(day)
    await prisma.productUsageTotal.upsert({ where: { dayUtc_metric: { dayUtc, metric } }, create: { dayUtc, metric, value }, update: { value } })
  }
  return counters.length
}

class ProductUsagePeopleRollupService {
  private timer: NodeJS.Timeout | undefined
  start(): void {
    if (this.timer) return
    const tick = () => void rollupPeople().catch(err => logger.warn('people rollup failed; retrying next hour', { error: String(err) }))
    tick()
    this.timer = setInterval(tick, INTERVAL_MS)
    this.timer.unref?.()
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }
}
export const productUsagePeopleRollupService = new ProductUsagePeopleRollupService()
```

- [ ] **Step 4: Indexes**

In `ensureProductUsageExpiry` (`backend/src/lib/productUsage.ts`), append `['product_usage_activity', 'expiresAt', 0]` as the **last** entry of the TTL list (after the legacy collections), and after the loop:
```ts
  await prisma.$runCommandRaw({ createIndexes: 'product_usage_activity', indexes: [{
    key: { subject: 1, dayUtc: 1 }, name: 'product_usage_activity_subject_dayUtc_key', unique: true,
  }] })
```

- [ ] **Step 5: Start and stop it in the worker**

In `backend/src/worker.ts`: `import { productUsagePeopleRollupService } from './services/ProductUsagePeopleRollupService.js'`; after `machineBillingWorkerService.start()` add `productUsagePeopleRollupService.start()`; in `shutdown` after `machineBillingWorkerService.stop()` add `productUsagePeopleRollupService.stop()`.

- [ ] **Step 6: Run the tests to see them pass**

Run: `cd backend && npm test -- src/services/ProductUsagePeopleRollupService.test.ts src/lib/productUsage.test.ts && npx tsc --noEmit`
Expected: PASS, no tsc output. Checkpoint.

---

### Task 6: People section in `usage:daily`

**Files:**
- Create: `backend/src/analytics/dailyProductPeople.ts`
- Test: `backend/src/analytics/dailyProductPeople.test.ts`
- Modify: `backend/src/productUsageReport.ts`

**Interfaces:**
- Consumes: `PEOPLE_METRICS`, `PEOPLE_RETURN_DAYS` (Task 4); `ACTIVITY_SURFACES` (Task 1).
- Produces: `export function dailyProductPeople(rows: { dayUtc: Date; metric: string; value: number }[], days: number, now: Date)` returning
  `{ status: 'collected' | 'not collected', definitions: Record<string, string>, daily: DailyPeople[], retention: Record<string, Cohort[]> }` where
  `DailyPeople = { day: string; active: number|null; working: number|null; new: number|null; staff: number|null; surfaces: Record<string, number|null> }` and
  `Cohort = { day: string; size: number|null; d1: Cell; d2: Cell; d3: Cell; d7: Cell }`, `Cell = { returned: number; percent: number|null } | null`.

- [ ] **Step 1: Write the failing tests**

`backend/src/analytics/dailyProductPeople.test.ts`:

```ts
import { expect, it } from 'vitest'
import { dailyProductPeople } from './dailyProductPeople.js'
const r = (day: string, metric: string, value: number) => ({ dayUtc: new Date(day), metric, value })

it('says people are not collected instead of printing zeros', () => {
  expect(dailyProductPeople([r('2026-10-12', 'turns_started', 3)], 3, new Date('2026-10-14T01:00:00Z')).status).toBe('not collected')
})

it('reports DAU per day and retention cells with numerator, denominator and immature nulls', () => {
  const p = dailyProductPeople([
    r('2026-10-11', 'people_active', 10), r('2026-10-11', 'people_working', 4), r('2026-10-11', 'people_active_desktop', 7),
    r('2026-10-11', 'people_active_d1_returned', 6), r('2026-10-11', 'people_working_d1_returned', 3),
    r('2026-10-11', 'people_new', 0), r('2026-10-11', 'people_new_d1_returned', 0),
  ], 4, new Date('2026-10-14T01:00:00Z'))
  expect(p.status).toBe('collected')
  expect(p.daily.find(d => d.day === '2026-10-11')).toMatchObject({ active: 10, working: 4, surfaces: { desktop: 7 } })
  expect(p.daily.find(d => d.day === '2026-10-14')).toBeUndefined() // today is left out
  const cohort = p.retention.active.find(c => c.day === '2026-10-11')!
  expect(cohort).toMatchObject({ size: 10, d1: { returned: 6, percent: 60 }, d7: null })
  expect(p.retention.working.find(c => c.day === '2026-10-11')!.d1).toEqual({ returned: 3, percent: 75 })
  expect(p.retention.new.find(c => c.day === '2026-10-11')!.d1).toEqual({ returned: 0, percent: null }) // no denominator
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && npm test -- src/analytics/dailyProductPeople.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`backend/src/analytics/dailyProductPeople.ts`:

```ts
import { ACTIVITY_SURFACES } from '../lib/productUsage.js'
import { PEOPLE_METRICS, PEOPLE_RETURN_DAYS } from './peopleCounters.js'

const DAY = 86_400_000
type Row = { dayUtc: Date; metric: string; value: number }
type Cell = { returned: number; percent: number | null } | null

export function dailyProductPeople(rows: Row[], days: number, now: Date) {
  const today = Math.floor(now.getTime() / DAY) * DAY
  const values = new Map<string, number>()
  for (const row of rows) if (PEOPLE_METRICS.includes(row.metric)) values.set(`${row.dayUtc.toISOString().slice(0, 10)}:${row.metric}`, row.value)
  const get = (day: string, metric: string) => values.get(`${day}:${metric}`) ?? null
  const dayList = Array.from({ length: days }, (_, i) => new Date(today - (days - i) * DAY).toISOString().slice(0, 10))
  const kinds: Record<string, string> = { active: 'people_active', working: 'people_working', new: 'people_new',
    ...Object.fromEntries(ACTIVITY_SURFACES.map(s => [s, `people_active_${s}`])) }
  const cell = (day: string, base: string, n: number): Cell => {
    const returned = get(day, `${base}_d${n}_returned`)
    if (returned === null) return null
    const size = get(day, base)
    return { returned, percent: size ? Math.round(returned / size * 1000) / 10 : null }
  }
  return {
    status: values.size ? 'collected' as const : 'not collected' as const,
    definitions: {
      population: 'People whose account shares product usage, staff excluded. A lower bound for all users.',
      active: 'Any signed-in client reached Harness that UTC day; an app left open across midnight counts on both days.',
      working: 'At least one agent turn started that day. Prefer working retention: it is not inflated by open apps.',
      returns: 'Dn: in the cohort on day C and back on C+n (same surface for a surface cohort). null until C+n has ended.',
    },
    daily: dayList.filter(day => get(day, 'people_active') !== null).map(day => ({
      day, active: get(day, 'people_active'), working: get(day, 'people_working'), new: get(day, 'people_new'),
      staff: get(day, 'people_staff_active'),
      surfaces: Object.fromEntries(ACTIVITY_SURFACES.map(s => [s, get(day, `people_active_${s}`)])),
    })),
    retention: Object.fromEntries(Object.entries(kinds).map(([kind, base]) => [kind,
      dayList.filter(day => get(day, base) !== null).map(day => ({
        day, size: get(day, base),
        ...Object.fromEntries(PEOPLE_RETURN_DAYS.map(n => [`d${n}`, cell(day, base, n)])),
      })),
    ])),
  }
}
```

- [ ] **Step 4: Wire it into the report**

In `backend/src/productUsageReport.ts`:
- `import { dailyProductPeople } from './analytics/dailyProductPeople.js'` and `import { PEOPLE_METRICS } from './analytics/peopleCounters.js'`.
- Query: `metric: { in: [...DAILY_PRODUCT_METRICS, ...PEOPLE_METRICS] }` and `take: 93 * (DAILY_PRODUCT_METRICS.length + PEOPLE_METRICS.length)`.
- Output object: after `review: dailyProductReview(rows, new Date())` add `, people: dailyProductPeople(rows, days, new Date())`.

- [ ] **Step 5: Run the tests to see them pass**

Run: `cd backend && npm test -- src/analytics && npx tsc --noEmit`
Expected: PASS, no tsc output. Checkpoint.

---

### Task 7: Tell people what is shared, and the policy

**Files:**
- Modify: `desktop/lib/settings/sections/privacy_section.dart` (the `'Shared fields\n'` text, ~line 151)
- Modify: `mobile/lib/phone/privacy_page.dart` (the `'Shared fields: …'` text, ~line 107)
- Test: `desktop/test/privacy_section_test.dart`, `mobile/test/privacy_page_test.dart`
- Modify: `docs/product-measurement.md`

**Interfaces:** none (copy and docs).

- [ ] **Step 1: Write the failing widget assertions**

In both tests, after the existing `await tester.tap(find.text('See what’s shared'))` + pump and the existing `random retry receipt` assertion, add:
```dart
    expect(find.textContaining('kept 10 days'), findsOneWidget);
    expect(find.textContaining('are not stored with the combined totals'), findsOneWidget);
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd desktop && flutter test test/privacy_section_test.dart` and `cd mobile && flutter test test/privacy_page_test.dart`
Expected: FAIL — text not found.

- [ ] **Step 3: Change the copy**

Desktop (`privacy_section.dart`): add a bullet after `'• Desktop and terminal app opens\n'`:
```dart
            '• The days you used Harness, which apps you used and whether an agent worked, under an anonymous code; kept 10 days, then only as combined totals\n'
```
and replace `'Sign-in checks your preference. Account, computer, and agent identifiers are not stored '` + `'with the new totals. '` with:
```dart
            'Sign-in checks your preference. Account, computer, and agent identifiers are not stored '
            'with the combined totals. The 10-day daily records use an anonymous code instead of your account '
            'and are deleted when you turn sharing off. '
```
Phone (`privacy_page.dart`): in `'Shared fields: …'` append after `'desktop/terminal opens, '`:
```dart
            'the days you used Harness, which apps you used and whether an agent worked (an anonymous code, kept 10 days, then only as combined totals), '
```
and replace `'Sign-in checks your preference. Account, computer and agent identifiers are not stored '` + `'with new totals. '` with:
```dart
            'Sign-in checks your preference. Account, computer and agent identifiers are not stored '
            'with the combined totals. The 10-day daily records use an anonymous code instead of your account '
            'and are deleted when you turn sharing off. '
```
Keep the surrounding strings unchanged so each file's other assertions still hold.

- [ ] **Step 4: Run them to see them pass**

Run: `cd desktop && flutter test test/privacy_section_test.dart && flutter analyze lib/settings/sections/privacy_section.dart` and `cd mobile && flutter test test/privacy_page_test.dart && flutter analyze lib/phone/privacy_page.dart`
Expected: PASS; no new analyzer issues. Optional visual check: render the Privacy pane at 1.0×/1.8× text in light and dark and confirm nothing overflows.

- [ ] **Step 5: Policy doc**

In `docs/product-measurement.md`:
- Add a row to the measurements table:
  `| How many people use Harness, and do they come back? | People active / working / new per day and per app, and D1/D2/D3/D7 returns (backend rollup of 10-day pseudonymous marks) | Sharing accounts only, staff excluded; an app open across midnight counts on both days — prefer working returns. Not available before PRODUCT_USAGE_SUBJECT_KEY is set. |`
- Replace the sentence `Exact people-based DAU/MAU and cross-device retention are deliberately unavailable.` with:
  `People-based daily counts and D1/D2/D3/D7 returns come from one mark per sharing person per day under an HMAC pseudonym (no time, machine, agent, device, country or content), kept 10 days and then only as anonymous totals; turning sharing off deletes the person's marks at once. Weekly/monthly people counts and longer returns are not collected.`
- Under "Rollout and privacy controls", add the order: deploy backend without `PRODUCT_USAGE_SUBJECT_KEY` → release desktop, phone and CLI with the new "See what's shared" text → set the key (32+ random characters, Helm secret). Rotating the key: delete all `product_usage_activity` documents first; losing the key while marks live prevents deleting a person's marks.
- In the suggested release note, add: `With sharing on, Harness also keeps which days you used it and through which app, under an anonymous code, for 10 days, then only as combined totals.`

Checkpoint.

---

### Task 8: Database acceptance and full verification

**Files:** none (verification only).

- [ ] **Step 1: Synthetic Mongo replica set**

```bash
docker run -d --rm --name pu-mongo -p 27099:27017 mongo:7 --replSet rs0
sleep 3 && docker exec pu-mongo mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})'
cd backend && export DATABASE_URL='mongodb://localhost:27099/pu_accept?replicaSet=rs0&directConnection=true'
npx prisma db push --skip-generate
```
Expected: schema pushed; `product_usage_activity` exists.

- [ ] **Step 2: Indexes, upserts and TTL against the real database**

Create a throwaway script in the scratchpad (not in the repo), run with `PRODUCT_USAGE_SUBJECT_KEY=$(openssl rand -hex 32) npx tsx <script>`:
```ts
import { ensureProductUsageExpiry, markActivity } from './src/lib/productUsage.js'
import { prisma } from './src/lib/prisma.js'
await ensureProductUsageExpiry()
const user = await prisma.user.create({ data: { email: `a${Date.now()}@example.com`, externalId: `x${Date.now()}` } })
await Promise.all([markActivity(user.id, new Date(), { surface: 'desktop' }), markActivity(user.id, new Date(), { worked: true })])
console.log(await prisma.productUsageActivity.findMany())
console.log(await prisma.$runCommandRaw({ listIndexes: 'product_usage_activity' }))
await prisma.productUsageActivity.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } })
```
Expected: exactly one document with `surfaces: ['desktop']`, `worked: true`, no user id; indexes include the unique `(subject, dayUtc)` and the `expiresAt` TTL. Within ~2 minutes (Mongo's TTL monitor runs every 60 s) `db.product_usage_activity.countDocuments()` returns 0. Stop the container: `docker stop pu-mongo`.

- [ ] **Step 3: Affected suites**

```bash
cd backend && npx tsc --noEmit && npm test
cd ../desktop && flutter test test/privacy_section_test.dart
cd ../mobile && flutter test test/privacy_page_test.dart
```
Expected: backend all green except failures already present on `origin/main` (compare a clean worktree before calling anything new); desktop and phone tests pass.

- [ ] **Step 4: Report run against the synthetic database**

Run: `cd backend && npm run -s usage:daily -- 7 | node -e 'const r=JSON.parse(require("fs").readFileSync(0));console.log(r.people.status)'`
Expected: `not collected` before any rollup; after `npx tsx -e "import('./src/services/ProductUsagePeopleRollupService.js').then(m=>m.rollupPeople(new Date(Date.now()+86400000)))"` it prints `collected`.

- [ ] **Step 5: Hand back**

Summarize the changed files and test results to the user. Do not commit, push or open a PR unless asked. Remind them of the rollout order: deploy backend (no key) → release apps → set `PRODUCT_USAGE_SUBJECT_KEY`.
