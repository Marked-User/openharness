# Product measurement and the daily improvement review

We use aggregated product signals to decide what to reproduce, fix and measure next. We do not
inspect people's work to explain a count, and a daily review does not imply a daily release or an
automatically proven improvement. Changes still need review, tests and a deliberate release.

## Measurements and their limits

| Question | Signal | Interpretation |
| --- | --- | --- |
| Does first measured use lead to work? | First-launch installation cohorts; work and first text response within 24 hours | Same participating installation, not signup conversion, same-task success or unique people. Existing users enter when updated; mature only after the full follow-up day ends. |
| Where does a launch stall or fail? | Pending install/model/native waits; observed launch created/failed/cancelled/unconfirmed; fixed failure categories and duration buckets | Polls are not attempts. Missing outcomes, daemon restarts and the 15-minute observation bound reduce coverage. Inspect unknowns alongside failures. |
| Which actions break? | Create, resume, restart, model-change, history, fork, close, delete, search, history paging, Store list/install/update/remove, model list/download/start/stop and browser-open requests, fixed outcomes/errors and latency buckets | Request acceptance is not task success. Pending/unknown requests are separate from completed replies. |
| Does work get a response promptly? | First text response buckets; over-one-minute waits; error events; matched ends without text; interruptions | Includes automation. Tool-only turns, interruptions and missing lifecycle events can explain missing text. No message is inspected. |
| Do installations return to work? | D1/D7/D28 working-day cohorts, consecutive complete-week and calendar-month returns, return after a seven-day gap | Any working day can be a cohort; not new-signup retention. Local date flags produce unlinked totals. Opt-outs, reinstallations, resets and missing uploads affect results. |
| Was the task useful? | Optional Completed / Partly completed / Not completed plus five fixed reason choices, reachable from Rate task outcome and Privacy | Voluntary and self-selected; not representative success or satisfaction. There is no free-text input. |
| Is there usage at all? | Active and working computer counts; app opens; older-client relay totals | Background windows can count as active. An open is a surface going from no attached window to one, not each connection (the desktop holds one per machine and redials). Relay events are not distinct people; the populations must not be added together. |

| Which features get tried and used again? | First measured installations and daily first/repeat feature reach | Locally deduplicated installation-days, not unique accounts. Reads the apps make on their own (history, history paging, Store list, model list; `PRODUCT_USAGE_AUTOMATIC_ACTIONS`) count reliability only and have no reach. |
| Where do app flows break? | Setup, Harness/tmux/clipboard steps, sign-in, workspace/remote connections, computer linking, viewer-pane opening and manual update checking/staging | Fixed started/ok/failed/cancelled/unknown counts and coarse duration buckets. Opening a viewer pane is not rendering its content; staging an update is not a successful relaunch. |
| Is measurement losing coverage? | Updated collector installation-days, pruned queues, full observation maps, unmatched app starts | Loss signals warrant caution. No signal does not prove complete collection. |
| How many people use Harness, and do they come back? | People active / working / new per day and per app, and D1/D2/D3/D7 returns (backend rollup of 10-day pseudonymous marks) | Sharing accounts only, staff excluded; an app open across midnight counts on both days, so prefer working returns. Not available before `PRODUCT_USAGE_SUBJECT_KEY` is set. |

Native signed-out sessions can explicitly enable **Share setup and sign-in counts**. It starts off
on every app launch, sends no credentials/cookies, and never replays earlier actions. Setup state
already visible when opted in can start an observation; duration then begins at that observation,
not necessarily at installation start. An account's off choice disables it once known. Web pre-sign-in
collection stays disabled because that transport cannot guarantee omitted cookies. These optional,
untrusted, self-selected counts are a separate population from signed-in app/daemon reports. They
show observed friction at each step, **not** unique signup conversion or a linked user funnel.
Reproduce those paths with test accounts and synthetic inputs. No screen recordings,
click trails, stable analytics identifiers, locations, content or arbitrary properties are added.
The exact counter vocabulary is in [productUsage.ts](../backend/src/types/productUsage.ts).

Daemon reports combine participating signed-in installations, including staff and both environments.
App reports are surface-specific operation totals; never add them to daemon or relay counts.
They are not all-user counts and are not directly comparable with earlier account-cohort reports
or industry retention benchmarks. Apart from the 10-day people marks below (a keyed pseudonym, deleted on opt-out), no per-person analytics
history or joining key is stored.
Authenticated requests still reach the service; infrastructure request logs and backups have their
own retention, which the release owner must verify separately. The account preference remains
linked to the account so the switch works everywhere.

## Runtime and storage budget

The daemon collector belongs to the gateway service, ordinarily a separate process. The core
forwards fixed counters with a 64 KiB optional-traffic backpressure limit, never waits for reporting,
and never wakes a service just to send measurement. Existing lifecycle broadcasts supply scalar
facts; no extra per-token observer, content reader, thread or database dependency enters the core.
Unmeasured RPCs return a shared no-op immediately. The `HARNESSD_SERVICES=none` development mode
runs services inline; it does not provide process isolation.

The gateway coalesces asynchronous disk writes, caps its local queue at 256 KiB / 35 UTC days,
and bounds in-memory turn/launch observations at 1,000 each. Reports contain at most 64 counters
and stay below 8 KiB. One sync runs at a time, with five-second network deadlines and a one-minute
report interval. Unknown or failed preference checks stop collection. Slow or failed reporting can
lose counts and cannot become a product dependency. A failed disk write also disables collection.

Desktop and phone collectors keep only fixed counters in RAM, at most 64 in-flight observations,
with at most 32 counters per report, one pending report per channel and one flush at a time.
Callbacks from product actions never await measurement I/O. Reports retry no faster than once per
minute with the same random receipt. Send/receive deadlines are five seconds; the authenticated
app transport retains its existing 15-second connect timeout. Signed-out transport uses five seconds
for all three phases. Counts expire after
yesterday; app exit loses RAM counts. Update-stage outcomes may be lost during immediate exit;
never delay an update to flush analytics. There is no persistent app identifier or local event log.

The signed-out endpoint permits only setup counters and explicit consent, rejects auth/cookie
headers, limits bodies to 4 KiB and values to 1,000, and admits at most 120 writes/minute and four
concurrent writes per server process. No IP-based analytics or new rate-limit identity is stored.
Exhaustion drops measurement rather than affecting sign-in. Public counts remain susceptible to
fabrication; they are directional diagnostics, not trusted account acquisition metrics.

Both ingestion paths atomically add only UTC-day/metric totals plus an unlinked random retry receipt.
Receipts expire within 36 days and totals within 396 days through the existing Mongo TTL indexes.
No account deduplication markers or stable hashes enter these totals. People-based daily counts and
D1/D2/D3/D7 returns come from one mark per sharing person per day under an HMAC pseudonym (no time,
machine, agent, device, country or content), kept 10 days and then only as anonymous `people_*` totals;
turning sharing off deletes the person's marks at once. Weekly/monthly people counts and longer returns
are not collected.

## Each daily review

1. Run `cd backend && npm run usage:daily -- 14` with a read-only `DATABASE_URL` supplied through the
   environment. Keep output in ignored `.harness/usage/`; never commit credentials or production
   exports. The command reads only allowlisted aggregate rows, performs no writes, and uses UTC days.
2. Check collection coverage, missing days, unknown outcomes and participating-installation counts
   before interpreting a rate. Preserve the numerator and denominator. Today is partial; late
   reports can change earlier days. A 24-hour first check can catch friction; D7/D28 and calendar-month returns need their full follow-up windows. Missing metrics stay unknown during rollout, not evidence of zero use.
3. Pick one product problem together. Record a hypothesis, target metric, guardrails, observation
   window, release commit/time and expected result **before** implementing it. Keep fixed cohorts
   and equal-length periods; do not select a favorable window after seeing the outcome.
4. Reproduce with synthetic inputs. Profile or benchmark a fixed workload on the same machine and
   toolchain before and after. Add a regression test for the behavior and check failures recover.
   In production compare reliability and wait buckets, not captured user errors or work.
5. Review and release. Record rollout boundaries outside the analytics data; do not infer exposure
   from a global date alone. Allow enough time for adoption and the selected follow-up window.
6. Compare the report's complete seven-day windows and mature cohorts. Repeated work is not
   independent sampling. A change in client adoption or participation can change a rate without a
   product effect. With little data, record "inconclusive" and the next observation date. Keep, revise
   or revert together; do not claim causality from a before/after count.

A review record can use this compact shape (no user or task identifiers):

```text
Question / hypothesis:
Synthetic reproduction and benchmark:
Primary metric / numerator / denominator:
Guardrails: launch failures, unknown outcomes, response waits, interruptions, privacy choice
Baseline dates / follow-up dates / cohort maturity:
Released commit / UTC rollout time / overlapping changes:
Observed coverage and uncertainty:
Decision: keep | revise | revert | inconclusive
Next review date:
```

The `review` output proposes investigations, not code changes or automatic deployments. Feedback
is one source of evidence; a missing response does not identify why a person stopped using Harness.

## Rollout and privacy controls

Deploy backend schema and the singleton worker first, including unique indexes and TTL indexes.
Use synthetic data to verify duplicate receipts, transaction rollback/retry, off/on revision fencing
and expiry. Then release CLI, desktop and phone together. Check that the switch saves and that reports
stop when it is off. Old clients stop contributing individual daily histories when the backend changes;
the historical reporting command will no longer be a current-usage source.

People counts roll out in this order: deploy the backend without `PRODUCT_USAGE_SUBJECT_KEY` (no marks
are written); release desktop, phone and CLI with the updated "See what's shared" text; then set the key
(32+ random characters, in the Helm secret). The first D1 is available two days later, D7 eight days
later. Rotating the key: delete every `product_usage_activity` document first. Losing the key while
marks live prevents deleting a person's marks when they turn sharing off.

Suggested visible release note:

> Harness now shares limited product usage counts by default to help us find broken or slow flows.
> These counts do not include your prompts, responses, code, files or project details. Turn sharing
> off for your account in Settings → Privacy → Share product usage data, or use `harness privacy off`.
> Existing opt-outs stay off. Optional feedback sends only the answer you choose.
> With sharing on, Harness also keeps which days you used it and through which app, under an
> coded ID instead of your account, for 10 days, then only as combined totals.

Sharing off prevents subsequent admission of new reports and clears local queues at the next
successful preference check. An already admitted operation may finish. Combined totals cannot be
removed for one person because they have no identity link. The [backend guide](../backend/README.md#product-usage-with-an-account-wide-privacy-control)
documents queue bounds, retention, legacy deletion and the separate infrastructure checks.
