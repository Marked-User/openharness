# Product measurement and the daily improvement review

We use aggregated product signals to decide what to reproduce, fix and measure next. We do not
inspect people's work to explain a count, and a daily review does not imply a daily release or an
automatically proven improvement. Changes still need review, tests and a deliberate release.

## Measurements and their limits

| Question | Signal | Interpretation |
| --- | --- | --- |
| Does first measured use lead to work? | First-launch installation cohorts; work and first text response within 24 hours | Same participating installation, not signup conversion, same-task success or unique people. Existing users enter when updated; mature only after the full follow-up day ends. |
| Where does a launch stall or fail? | Pending install/model/native waits; observed launch created/failed/cancelled/unconfirmed; fixed failure categories and duration buckets | Polls are not attempts. Missing outcomes, daemon restarts and the 15-minute observation bound reduce coverage. Inspect unknowns alongside failures. |
| Which actions break? | Create, resume, restart, model-change and history requests, fixed outcomes/errors and latency buckets | Request acceptance is not task success. Pending/unknown requests are separate from completed replies. |
| Does work get a response promptly? | First text response buckets; over-one-minute waits; error events; matched ends without text; interruptions | Includes automation. Tool-only turns, interruptions and missing lifecycle events can explain missing text. No message is inspected. |
| Do installations return to work? | D1/D7 working-day cohorts and consecutive complete-week returns | Any working day can be a cohort; not new-signup retention. Local date flags produce unlinked totals. Opt-outs, reinstallations, resets and missing uploads affect results. |
| Was the task useful? | Optional five-choice feedback in Privacy settings | Voluntary and self-selected; not representative success or satisfaction. There is no free-text input. |
| Is there usage at all? | Active and working computer counts; app opens; older-client relay totals | Background windows can count as active. Relay events are not distinct people; the populations must not be added together. |

Pre-sign-in setup and sign-in abandonment remain unobserved. Signed-out clients send no product
reports. Reproduce those paths with test accounts and synthetic inputs. No screen recordings,
click trails, stable analytics identifiers, locations, content or arbitrary properties are added.
The exact counter vocabulary is in [productUsage.ts](../backend/src/types/productUsage.ts).

Reports combine participating signed-in installations, including staff and both environments.
They are not all-user counts and are not directly comparable with earlier account-cohort reports
or industry retention benchmarks. No per-person analytics history or joining key is stored.
Authenticated requests still reach the service; infrastructure request logs and backups have their
own retention, which the release owner must verify separately. The account preference remains
linked to the account so the switch works everywhere.

## Each daily review

1. Run `cd backend && npm run usage:daily -- 14` with a read-only `DATABASE_URL` supplied through the
   environment. Keep output in ignored `.harness/usage/`; never commit credentials or production
   exports. The command reads only allowlisted aggregate rows, performs no writes, and uses UTC days.
2. Check collection coverage, missing days, unknown outcomes and participating-installation counts
   before interpreting a rate. Preserve the numerator and denominator. Today is partial; late
   reports can change earlier days. A 24-hour first check can catch friction; D7 cannot mature in a day.
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

Suggested visible release note:

> Harness now shares limited product usage counts by default to help us find broken or slow flows.
> These counts do not include your prompts, responses, code, files or project details. Turn sharing
> off for your account in Settings → Privacy → Share product usage data, or use `harness privacy off`.
> Existing opt-outs stay off. Optional feedback sends only the answer you choose.

Sharing off prevents subsequent admission of new reports and clears local queues at the next
successful preference check. An already admitted operation may finish. Combined totals cannot be
removed for one person because they have no identity link. The [backend guide](../backend/README.md#product-usage-with-an-account-wide-privacy-control)
documents queue bounds, retention, legacy deletion and the separate infrastructure checks.
