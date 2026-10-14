"""Prove original-turn Stop completion and recovery fences in an owned worktree."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
assert (cli.parent / '.git').is_file(), 'An owned disposable worktree is required'
assert os.environ.get('HARNESS_HOOK_MUTATIONS_OWNED') == '1'
assert Path(os.environ.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp', 'HARNESS_CONNECTIONS_PORT': '0'}
for key in list(environment):
    if key in ('TMUX', 'TMUX_PANE') or key.startswith('RECORD_'):
        environment.pop(key)

server = 'src/hookServer.ts'
turn = 'src/core/turns/turnHooks.ts'
http = 'src/lib/registry.admission.spec.ts'
turn_spec = 'src/core/turns/turnHooks.spec.ts'
tasks = 'src/core/engines/cursorTasks.spec.ts'
mutations = [
    ('original-turn Stop wiring disconnected', 'src/core/main.ts',
     'captureTurnStop: (entry, body) => turnHooks.captureStop(entry, body, attach.captureAdmissionStop(entry)),',
     '', 'e2e/hookclient.e2e.ts', 'completes a Cursor Stop.*running.*unmarked'),
    ('Stop callback entry treated as completion', server,
     'stopOutcome = await stopEffect({ current, verify: () => claim!.verify() })',
     "stopOutcome = 'completed'", http, 'concurrent confirmations pending'),
    ('queue refusal discards the original Stop latch', server,
     'saveReceipt(history.records, deliveryId, { fingerprint, status: 200, reply: { pending: true }, pending: false,\n'
     '          bytes: retainedBytes, preparing: { stopEffect, stopCurrent } })',
     'saveReceipt(history.records, deliveryId)', http, 'full live queue'),
    ('shutdown publishes an unmatched hold', server,
     "if (!current()) return { kind: 'hold', reason: 'Waiting for the original native hook owner.' }",
     '', http, 'owning server shuts down'),
    ('successor inherits the original Stop', turn,
     "if (!turn()) return 'superseded'", '', turn_spec, 'does not close a successor'),
    ('overdue reader closes before the timer runs', turn,
     'if (performance.now() >= deadline) revoked = true', '', turn_spec, 'overdue timer runs'),
    ('completed effect repeated on persistence retry', turn,
     "if (completion) return state() === 'superseded' ? Promise.resolve('superseded') : completion",
     '', turn_spec, 'retries a completed result without closing twice'),
    ('Stop receipt releases attachment before task cleanup', turn,
     'authority = await wait(removePendingCursorTasks(dataDir, sessionId, current, tasks))',
     'void removePendingCursorTasks(dataDir, sessionId, current, tasks)', turn_spec, 'before confirming Stop'),
    ('task cleanup deletes successor IDs', 'src/engines/cursor/pendingTasks.ts',
     'ids && !ids.has(cursorTaskId(sessionId, task.toolUseId))', 'false', tasks, 'original Stop task IDs'),
    ('unreadable task preflight treated as absence', 'src/core/engines/cursorTasks.ts',
     "if (strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error",
     '', tasks, 'preflight instead of treating unreadable'),
]


def run(spec, pattern):
    lane = ['--config', 'vitest.e2e.config.ts'] if spec.startswith('e2e/') else []
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', spec,
                           *lane, '--maxWorkers=1', '-t', pattern], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=90)


for spec in sorted({item[4] for item in mutations}):
    pattern = '|'.join(item[5] for item in mutations if item[4] == spec)
    result = run(spec, pattern)
    assert result.returncode == 0, 'Unchanged baseline failed.\n' + result.stdout + result.stderr
print('Original-turn Stop baselines passed', flush=True)
failures = []
for label, relative, before, after, spec, pattern in mutations:
    source = cli / relative
    original = source.read_text()
    assert original.count(before) == 1, (label, original.count(before))
    try:
        source.write_text(original.replace(before, after))
        result = run(spec, pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': NOT caught by assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        source.write_text(original)
if failures:
    raise SystemExit('Mutations without assertion proof: ' + ', '.join(failures))
