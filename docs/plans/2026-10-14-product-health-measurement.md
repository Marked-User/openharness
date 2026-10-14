# Aggregate product health measurement

Requested 2026-10-14 08:31 UTC. Scope: Desktop, CLI/gateway, backend ingestion and the daily report.
Web and mobile keep their existing instrumentation. This extends fleet aggregates, not the separate
optional people-retention records on main. No new identity, content, event-history or join key is collected.

## Definitions and implementation

- Preserve legacy counters. Add explicit coverage markers for the new observations so missing data is
  unknown. Separate application requests, tool requests and unknown sources; a source is not proof of human intent.
- Measure explicit composed-message submissions separately; raw terminal input is never inspected.
  Working days and first-work return cohorts are calculated from bounded local flags. Unclassified work stays unknown.
- Add bounded public release versions and broad platform categories as **separate marginal totals**.
  Never store their cross-product or attach them to people records. Development reports do not enter
  production totals. Hide sparse breakdowns in the review; this is not a claim of mathematical anonymity.
- Observe setup milestones only after consent, with no retrospective replay. First-use counts include
  an unknown installation class when an upgrade cannot be distinguished from a fresh install.
- Observe viewer main-frame load, update apply/relaunch, manual connection attempts, automatic retries,
  recovery and fixed refusal categories. App closure, timeout and missing replies remain separate from failure.
- Measure startup readiness, coarse UI frame stalls, process resource buckets and unexpected restarts.
  An unclean prior run is not proof of a crash. Never send stacks, error messages, URLs or machine inventories.
- Count feedback shown/answered/dismissed with the existing voluntary fixed answers. No task association.
- Report upload rejection/failure/expiry, observation overflow, capped counts and unmatched starts. Synthetic
  fixtures exercise every path, privacy off/on and account switching, and failures of the measurement service.

## Validation selected before implementation

1. Backend and CLI typechecks; affected measurement, protocol, boundary and report tests while developing.
2. Automatic full backend/CLI/Desktop PR suites on a stable ready head; no second equivalent local full suite.
3. Local CLI coverage gates if their covered files change; macOS Desktop affected tests and native callback
   fixtures for changed platform behavior. Core grows only for existing scalar forwarding, if needed.
4. Disposable Mongo integration: strict schemas, atomic dedupe and marginal totals, no identity fields,
   expiry, choice fencing and old-client compatibility. No production writes or user records.
5. Real daemon measurement isolation and the existing on/off/stalled collector benchmark, with synthetic
   work and the pinned toolchain. New timers must remain outside core and bounded.
6. Review final diff independently of implementation while CI runs. Record implementation, validation,
   merge, publication and waiting separately under ignored `.harness/measurement-health/`.

## Deliberate limits

No exact attribution of private task success, individual churn reasons or arbitrary click trails.
Counters describe participating clients; opt-outs and missing uploads affect coverage. Public release
comparisons are descriptive, not causal experiments. Unexpected exits are only observable on a later
consented launch. Synthetic benchmarks supply controlled performance evidence without collecting work.
