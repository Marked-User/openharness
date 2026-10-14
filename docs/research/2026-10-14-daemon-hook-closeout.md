# Bounded daemon hook closeout

The daemon separation phases, Codex crash-resume correction, readiness boundary
and same-millisecond pane fix are merged. The current closeout addresses four
reproduced native delivery failures: acknowledged pending work lost after restart,
repeated completion notifications, accepted changed payloads under a reused ID,
and a paused core leaving Cursor Stop held. The larger draft also introduced a
healthy-running Cursor Stop regression; that must pass before anything lands.

Independent review on October 14 found that the generation controller, new initial
launch schemas, allocation compaction and saved/live handoff in draft #1172 are
not prerequisites for these failures. That work remains preserved on its draft
branch through `f864d6e9e`. It is neither activated nor claimed complete here.

## Fixed scope

- Retain immutable intake, exclusive effect claims, terminal receipts and
  conflicting delivery IDs across restart, with bounded storage and work.
- Keep the existing installed client and hook configuration. A slow durability
  boundary is pending work, not evidence that a Stop belongs to another turn.
- Retain the original live turn boundary through registration, transcript/task
  drains, closure and cleanup. Cancel, a successor or reconstructed interpretation
  cannot inherit an older Stop's authority.
- Confirm actual Stop completion before reporting it complete. An interrupted
  effect with no conclusive result stays visibly held; recovery cannot replay it.
- Start recovery after readiness and prevent unavailable recovery from authorizing
  automatic Close. Preserve current-main behavior unrelated to this change.

Durable client outboxes, automatic reconciliation of uncertain Stop effects,
native generation activation and generalized launch/lifecycle work are deferred.
This change must not be presented as completing every item in the broader
[completion checklist](2026-10-09-daemon-core-completion.md).

## Acceptance

Keep one matrix: the three HTTP/Registry restart regressions; installed legacy
client completion with running and paused core, both with and without its later
transcript marker; duplicate/conflicting deliveries; Cancel and successor
isolation; crash during Stop processing; readiness and visible holds during
unavailable dependencies; relevant runtime cost. Keep the existing failing
acceptance assertions enabled. A callback invocation alone is not completion.

Required gates remain types, architecture, full core and master coverage, touched
specs, unchanged goldens with assertion-failing wiring mutations, relevant private
end-to-end lanes, independent integrated review and every required head check.
Merge with the repository helper after those pass. No release is authorized.

## Evidence and timing

Work on this narrowed branch began about 00:29 UTC on October 14 from main
`402ee861c`. The former hook acknowledgement, client transport and native probe
goldens were recorded before the move and committed alone as `5eb121db0`.
Recording receipts are source-changed; the first playback aggregate failed only
because its copied probe fixture used an argument absent from main's API. The
corrected unchanged playback and types pass in
`20261014T003358.204854Z-86443` (2.7/4.6 seconds).

The reviewed server-delivery prefix through `3bd0dd7cb` is transplanted onto
current main. Its one conflict retains main's agent settings. The already-landed
Close recovery guard is connected. Types and 48 cases in six complete delivery,
storage, golden and architecture files pass in
`20261014T003659.224384Z-971` (24.4/82.5 seconds). The linked-Stop correction and
whole-change acceptance were unfinished at that checkpoint. Earlier draft receipts cover only
their original inputs; they do not establish this branch's acceptance.

Draft [PR #1304](https://github.com/autonomous-ai/openharness/pull/1304) now keeps
Stop inside the registration's existing exclusive claim. It captures the original
core turn, parser, binding and cancellation witness before any admission wait.
Completion waits for the bounded task/transcript drain, actual closure and removal
of the original task IDs. Persistence retries retain that one result. The legacy
follow-up request confirms it without deleting a newer turn's queued tasks.
Cold recovery without the original live witness remains held for explicit Cancel.

Review found and corrected four races: an overdue Promise could beat its deadline
timer, uncertain intake followed by a later request could stall recovery, a late
Stop could publish a hold after shutdown, and legitimate recovery attachment could
invalidate its own delayed cleanup. Preparing receipts now retain the original
witness within the existing capacity limit, including queue refusal. Exact task
IDs survive legitimate reattachment; shutdown still revokes cleanup. Empty task
sets need no storage, and inaccessible storage is a hold rather than absence.

Focused core validation `20261014T012521.698743Z-36595` passes all 100% per-file
coverage measures for the four changed Stop, task, funnel and normalizer modules.
The targeted HTTP restart, uncertainty, queue-pressure and shutdown regressions
pass in `20261014T012554.521658Z-40380` (12.3 seconds). All four shipped-client
Cursor Stop cases pass in `20261014T012639.404954Z-44965` (54.2 seconds), using a
release bundle and verified native helper against private daemons and fake engines.
Both healthy and paused cores complete, with and without a later native completion
record. No acceptance deadline or Stop assertion was relaxed.

The full core/service gate passes in `20261014T012923.357586Z-63604`:
2,751 tests across 185 files, with 100% statements, branches, functions and lines
per covered file (175.1 seconds). Main subsequently advanced to `17ee12593`;
its reporting-route overlap and changed gateway counter boundary require combined
validation before merge. Its unrelated product work does not expand this scope.

The combined-main gate `20261014T013717.105031Z-14571` passes full core/service
coverage (2,752 tests, 170.1 seconds), master coverage (273 passed, one existing
platform skip, 22.7 seconds), and the native helper protocol (3.4 seconds). Both
coverage gates remain 100% per file across all measures. The touched-spec check
in that aggregate failed: 969 tests passed, and two failed during initial setup.
The unchanged catalog suite passes alone, all 83 cases, in
`20261014T015525.878232Z-5667` (76.2 seconds). Its failed observation saw ancestor
directory stamps change before the test deleted any authority; no production
fence or corruption assertion was weakened.

The versioned receipt fixture had deferred recovery without starting it. An
interruption after allocation could leave its initial namespace unsealed, which
receipt-only lookup correctly refuses to repair. The ordinary ready-core case
now starts the existing recovery loop. A controlled interruption proves that
receipt retries leave that namespace untouched and original-owner recovery then
completes exactly one intake. Independent review caught a test spy dropping the
read-only snapshot argument; it now forwards that argument unchanged. Final types
and all 19 protocol cases pass in `20261014T015750.448086Z-15668` (4.6/42.2 seconds).
These corrections change fixtures only, so the completed production coverage
and native checks remain applicable. The Stop notification assertion retains its
original condition and 20-second deadline. The wiring mutant will require an
assertion failure when the composition root's captured-Stop wiring is removed.

Earlier diagnostic aggregates failed and are not passing evidence. The unbundled
run lacked the macOS helper; a later fixture needed to wait for its fake process
record before registration. Concurrent HTTP/coverage/e2e checks then exceeded
fixture or native storage deadlines. Separate runs above passed with the original
deadlines. The capacity regression's first assertion also incorrectly expected a
secondary hold reason to override an existing active hold; it now verifies actual
queue refusal and eventual completion. Remaining gates are full affected
end-to-end lanes, causal mutations, runtime cost, final independent head/base
review and ready-state CI.

The working target given to the owner is one to two focused days including
validation and review, not a guaranteed completion date. The earlier two-to-three
day estimate was wrong. Scope is frozen; additional blockers need a concrete
violation and reproducer. Implementation and validation overlap; merge,
publication and external waiting remain zero at this checkpoint.
