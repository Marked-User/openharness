# People-based DAU and D1/D2/D3/D7 retention, behind the existing consent

Status: design, approved in conversation on 2026-10-14. Not implemented.

## Why

#1301 replaced the per-person presence collections with anonymous daily totals
(`product_usage_totals`). Since that backend reached production on 2026-10-14, the team can no longer
answer the questions it used to answer from `user_daily_presence` and friends:

- How many **people** used Harness on a day (DAU), and how many did real work (an agent turn)?
- Of the people active on day C, how many came back on C+1, C+2, C+3 and C+7?
- Of the people who **signed up** on day C, how many came back?
- The same, split by client: desktop, TUI, Harness OS, mobile and web.

The installation-based counters #1301 added cannot answer these: they count installations, not people,
cannot follow a person across devices, and have no sign-up cohort.

The old collections also had real problems this design must not repeat: no opt-out (they were outside
the analytics consent), no expiry, and far more detail than the questions need (first/last time of day,
machine, country, per-agent turn counts).

## Goals

- DAU (active) and working DAU per UTC day, overall and per client surface.
- D1/D2/D3/D7 retention for three cohorts: everyone active on a day, people who worked on a day, and
  people who signed up on a day; and per client surface.
- Collected only while the account's existing product-usage switch is on (Settings → Privacy → Share
  product usage data, `harness privacy on|off`). Turning it off stops collection and deletes what the
  person's marks hold.
- No third-party analytics service. No client change is needed to collect.
- Per-person data lives at most 10 days; long-term history is anonymous totals only.

## Non-goals

- Weekly/monthly people counts, D14/D28/D30 people retention, sessions, time in app.
- Dial/ESP32 devices (`touchDeviceOnlineDay`) as a DAU surface.
- Joining activity to country, version, acquisition attribution (`signUpAttribution`) or any other user
  field beyond sign-up day and the staff flag.
- Total sign-ups (`users.createdAt`) — an operational query, outside this feature.
- Recomputing history before the feature ships or across a change of definition older than 10 days.

## Definitions

- **Active on day D**: any signed-in client reached the backend for this account on UTC day D:
  - desktop: the daemon's `app_presence` open or ping for an attached desktop window (adapter-ws);
  - tui / harness-os / harness-os-pi: the same frame with that `surface`;
  - mobile / web: a `web-ws` connection with `?client=mobile|web`.
  A window left open across midnight marks the next day active (it is open). Working retention is the
  stronger signal and is unaffected.
- **Working on day D**: at least one non-replayed `turn_started` from one of the account's machines on D.
- **New on day C**: the account was created on UTC day C and was active on C.
- **Staff**: the account's email ends in `@autonomous.ai`. Staff are excluded from every people counter
  and counted separately as `people_staff_active`.
- **Population**: accounts with sharing on. Every number is a lower bound for the whole user base.

## Design

### 1. Activity marks (backend)

New Prisma model `ProductUsageActivity`, collection `product_usage_activity`, one row per person per day:

| Field | Type | Meaning |
|---|---|---|
| `subject` | string | `HMAC-SHA256(userId, PRODUCT_USAGE_SUBJECT_KEY)`, hex. Never the raw user id |
| `dayUtc` | Date | UTC day start |
| `surfaces` | string[] | subset of `desktop`, `tui`, `harness-os`, `harness-os-pi`, `mobile`, `web` |
| `worked` | boolean | a turn started that day |
| `signupDay` | Date | UTC day the account was created; set on insert |
| `staff` | boolean | set on insert |
| `expiresAt` | Date | `dayUtc + 10 days`; TTL index |

Indexes: unique `(subject, dayUtc)`; TTL on `expiresAt` (`expireAfterSeconds: 0`), installed with the
existing `ensureProductUsageExpiry()` pattern in the worker.

No time of day, machine, agent, device, country, version or content is stored.

**Why 10 days, not 8:** D7 for cohort C needs the marks of C and C+7 and can only be computed once C+7
has ended, i.e. during C+8. An 8-day TTL deletes C's marks exactly then. Two spare days cover the hourly
rollup and Mongo's TTL monitor lag.

### 2. Write path

`markActivity(userId, now, { surface?, worked? })` in `backend/src/lib/productUsage.ts`, called
fire-and-forget (never awaited on the relay path, errors logged) from the existing touch points in
`backend/src/lib/dailyTracking.ts`:

- `touchUserOnlineDay` (open and ping) → `{ surface: 'desktop' }`
- `touchClientOnlineDay(surface)` → `{ surface }`
- `recordTurnStarted` → `{ worked: true }`

The existing relay totals in those functions stay as they are.

Steps:

1. No `PRODUCT_USAGE_SUBJECT_KEY` → return (fail closed; this is also the rollout switch).
2. In-process de-duplication on `subject|day|surface|worked`, cleared at the UTC day boundary, so a
   person costs a few writes a day however often pings arrive.
3. `productUsageChoice(userId)`; disabled → return.
4. On a de-duplication miss only, read the user's `createdAt` and `email` (one indexed lookup).
5. Upsert on `(subject, dayUtc)`: `$addToSet: { surfaces }` when a surface is given, `$set: { worked: true }`
   when worked, `$setOnInsert: { signupDay, staff, expiresAt }`.

### 3. Deletion

- `setProductUsageChoice(userId, false)` and `POST /api/analytics/delete` also run
  `deleteMany({ subject: hmac(userId) })`, removing the person's marks immediately.
- Totals already rolled up cannot be attributed to anyone and stay, as today.

### 4. Daily rollup (worker)

A `productUsagePeopleRollup` service in the singleton worker (`backend/src/worker.ts`, same lifecycle as
`machineBillingWorkerService`): runs at start and hourly. For every **ended** UTC day whose marks still
exist it recomputes and writes counters into `product_usage_totals` with `$set` (idempotent; the
existing `(dayUtc, metric)` unique index holds).

The computation is a pure function `peopleCounters(marks, today)` (marks in, `{ day, metric, value }[]`
out), so it is testable without a database.

Counters, staff excluded unless named:

| Counter on `dayUtc = D` (or cohort day C) | Meaning |
|---|---|
| `people_active`, `people_working` | distinct subjects active / working on D |
| `people_active_<surface>` | active on D through that surface |
| `people_new` | signed up on D and active on D |
| `people_staff_active` | staff active on D |
| `people_active_d{1,2,3,7}_returned` | active on C and active on C+n |
| `people_working_d{1,2,3,7}_returned` | working on C and working on C+n |
| `people_new_d{1,2,3,7}_returned` | signed up on C and active on C+n |
| `people_active_<surface>_d{1,2,3,7}_returned` | active through the surface on C and through the same surface on C+n |

Denominators are the same-day counters of cohort day C (`people_active`, `people_working`,
`people_new`, `people_active_<surface>`). A Dn counter is written only once C+n has ended; until then it
is absent, never zero.

`people_*` metrics are a backend-only list. They are not part of the client contract
(`productUsageContract.ts` / `types/productUsage.ts`), so the report ingestion endpoint keeps rejecting
them and no client can fabricate them.

### 5. Report

`npm run usage:daily` reads the `people_*` counters with the other allowlisted totals (never the marks)
and adds a `people` section:

- DAU per day: active, working, new, per surface.
- Retention tables for each cohort kind (active, working, new, per surface): rows are cohort days,
  columns D1/D2/D3/D7, each cell `{ numerator, denominator, percent }`; immature cells are `null` with a
  note; today is excluded.
- Definitions: consenting population, staff excluded, open-across-midnight counts as active, prefer
  working retention.

### 6. Transparency and rollout

1. One PR: backend (model, write path, deletion, rollup, report), docs, and the user-facing description
   of what is shared:
   - Desktop `lib/settings/sections/privacy_section.dart` and phone `lib/phone/privacy_page.dart`
     "See what's shared": add the days you used Harness and through which app, under an anonymous code,
     kept 10 days, then only as combined totals; and correct the sentence "Account, computer, and agent
     identifiers are not stored with the new totals", which would no longer be true for the 10-day marks.
   - `harness privacy status` wording if it lists fields.
   - `docs/product-measurement.md`: replace "Exact people-based DAU/MAU and cross-device retention are
     deliberately unavailable" with this design; add a release note line.
2. Deploy the backend **without** `PRODUCT_USAGE_SUBJECT_KEY`: nothing is written.
3. Release desktop, phone and CLI with the new description.
4. Then set the key (32 random bytes, in the Helm secret). Collection starts; the first D1 is available
   two days later, D7 eight days later.

Key handling: rotating the key loses de-duplication and in-flight D1–D7 for up to 10 days and leaks
nothing. Losing the key while marks live would prevent deleting a person's marks on opt-out, so a
rotation must also delete all existing marks.

## Testing

- `markActivity`: no key → no write; sharing off → no write; repeated pings → one database write;
  surfaces merge and `worked` sets; `signupDay`/`staff`/`expiresAt` only on insert; the raw user id is
  never written.
- Deletion: switching off and `/api/analytics/delete` remove the subject's marks.
- `peopleCounters`: each cohort kind; staff exclusion; Dn absent until C+n ends; same-surface rule;
  identical output on re-run.
- Report: `people` section values, numerators/denominators, `null` for immature cells.
- Synthetic Mongo replica set (as in #1301): schema push, unique and TTL indexes, actual expiry after
  10 days, concurrent upserts for one subject/day.

## Risks

- **Undercount by design**: opted-out people, staff and clients that never reach the backend are absent.
- **Carry-over days**: an app open across midnight counts as active; working retention is the guard.
- **One process's de-duplication**: the backend runs as a PM2 cluster, so each process de-duplicates
  separately; this only costs a few extra idempotent upserts.
- **Preference reads**: `productUsageChoice` is not cached when enabled; de-duplication keeps it to a
  few reads per person per day.
