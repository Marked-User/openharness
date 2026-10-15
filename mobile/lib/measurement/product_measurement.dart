import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

/// Mirrors `PRODUCT_USAGE_FLOWS` in backend/src/types/productUsage.ts; a wire name the backend
/// does not list rejects the whole report. Everything up to [signIn] can happen before an account.
enum ProductFlow {
  setup('setup'),
  setupHarness('setup_harness'),
  setupTmux('setup_tmux'),
  setupClipboard('setup_clipboard'),
  signInScan('sign_in_scan'),
  signInGoogle('sign_in_google'),
  signInApple('sign_in_apple'),
  signInEmail('sign_in_email'),
  signIn('sign_in'),
  workspaceConnect('workspace_connect'),
  computerLink('computer_link'),
  remoteConnect('remote_connect'),
  viewerOpen('viewer_open'),
  updateCheck('update_check'),
  updateStage('update_stage'),
  computerWait('computer_wait'),
  sessionOpen('session_open'),
  firstMessage('first_message'),
  notifyPermission('notify_permission');

  const ProductFlow(this.wire);
  final String wire;

  /// Whether a signed-out session that opted in may count it.
  bool get beforeSignIn => index <= ProductFlow.signIn.index;

  /// Mirrors `PRODUCT_USAGE_LONG_FLOWS`: a step that can take hours, whose over_1m is split further.
  bool get long => this == computerWait || this == firstMessage;
}

enum ProductOutcome { ok, failed, cancelled, unknown }

typedef ProductReportRequest = Future<Map<String, dynamic>> Function(
  Map<String, dynamic> report,
);
typedef ProductChoiceRequest = Future<Map<String, dynamic>> Function();

/// Fixed counters only: no event log, identifiers, errors, request/response objects or content.
/// Nothing is saved. Signed-out sharing is an explicit choice for this app session; a close/crash can lose queued counts.
/// Requests and retries are serialized and never awaited by a product action.
class ProductMeasurement extends ChangeNotifier {
  ProductMeasurement({
    required this.surface,
    required this.sendSetup,
    DateTime Function()? now,
    String Function()? receipt,
    this.automatic = true,
  }) : assert(const ['desktop', 'phone', 'web'].contains(surface)),
       _now = now ?? DateTime.now,
       _receipt = receipt ?? newProductReceipt {
    choiceLoaded = true;
  }

  final String surface;
  final ProductReportRequest sendSetup;
  final bool automatic;
  final DateTime Function() _now;
  final String Function() _receipt;
  bool signedOutSharing = false, choiceLoaded = false;

  /// Which build reports: `{surface, release, platform, channel}`, as backend
  /// `ProductUsageContext` takes it. Sent with the account's reports only, so the totals split by
  /// release and by platform; a `development` build's reports are not kept. Null: no context.
  Map<String, String>? context;
  String? _coverageDay;
  bool _disposed = false;
  Object? _account;
  bool? _enabled;
  int _revision = -1, _accountEpoch = 0, _guestEpoch = 0;
  ProductChoiceRequest? _readChoice;
  ProductReportRequest? _sendAccount;
  Timer? _timer;
  DateTime? _lastAttempt;
  final _active = <Object, String>{};
  Future<void>? _flushing;
  final _days = <String, Map<String, int>>{};
  final _pending = <String, Map<String, dynamic>>{};
  final _setup = <ProductFlow, void Function(ProductOutcome)>{};
  final _setupFacts = <ProductFlow, String>{};

  bool get sharing => _account != null && _enabled == true;

  /// The account's choice has read off: what waits to be counted for it never is.
  bool get declined => _account != null && _enabled == false;
  bool get _setupAllowed =>
      surface != 'web' &&
      signedOutSharing &&
      (_account == null || _enabled == true);

  Future<void> setSignedOutSharing(bool enabled) async {
    _guestEpoch++;
    signedOutSharing = enabled;
    choiceLoaded = true;
    _clear('setup');
    _setup.clear();
    if (enabled) _observeSetupFacts();
    notifyListeners();
  }

  /// The scope is RAM-only and never serialized. A sign-out or account change discards its queue.
  void account(
    Object? scope, {
    ProductChoiceRequest? choice,
    ProductReportRequest? send,
  }) {
    if (_disposed || scope == _account) return;
    _accountEpoch++;
    _account = scope;
    _enabled = null;
    _revision = -1;
    _readChoice = choice;
    _sendAccount = send;
    _clear('ui');
    if (scope != null && automatic) unawaited(flush());
    _schedule();
  }

  /// A saved switch applies immediately in this app, even while a report is in flight.
  void savedChoice(Map<String, dynamic> value) {
    final enabled = value['enabled'], revision = value['revision'];
    if (enabled is! bool || revision is! int || revision < 0) {
      _enabled = null;
      return;
    }
    if (revision != _revision || !enabled) {
      _accountEpoch++;
      _clear('ui');
    }
    _revision = revision;
    _enabled = enabled;
    if (!enabled) {
      _guestEpoch++;
      signedOutSharing = false;
      _clear('setup');
      _setup.clear();
    }
    notifyListeners();
  }

  void _clear(String channel) {
    _days.removeWhere((key, _) => key.startsWith('$channel:'));
    _pending.remove(channel);
    _active.removeWhere((_, value) => value == channel);
    if (channel == 'ui') _coverageDay = null;
  }

  /// Sends what the account has queued before a sign-out discards it ([account]): a step ended by
  /// signing out, and why. At most [within]; what is still queued then is lost as before.
  Future<void> sendBeforeSignOut({
    Duration within = const Duration(seconds: 2),
  }) async {
    final watch = Stopwatch()..start();
    for (var round = 0; round < 3; round++) {
      if (_disposed || !sharing || !_queued('ui') || watch.elapsed >= within) {
        return;
      }
      try {
        await flush().timeout(within - watch.elapsed);
      } on TimeoutException {
        return;
      }
    }
  }

  bool _queued(String channel) =>
      _pending.containsKey(channel) ||
      _days.keys.any((key) => key.startsWith('$channel:'));

  /// [elapsed] is time the flow already ran before it could be counted; it lands in the duration.
  void Function(ProductOutcome) begin(
    ProductFlow flow, {
    Duration elapsed = Duration.zero,
  }) {
    final channel = sharing
        ? 'ui'
        : flow.beforeSignIn && _setupAllowed
        ? 'setup'
        : null;
    if (_disposed || channel == null || _active.length >= 64) return (_) {};
    final epoch = channel == 'setup' ? _guestEpoch : _accountEpoch;
    final started = _now().toUtc();
    final watch = Stopwatch()..start();
    final day = started.toIso8601String().substring(0, 10);
    final prefix = '${channel}_${surface}_${flow.wire}_';
    final ticket = Object();
    _active[ticket] = channel;
    _count(channel, day, '${prefix}started');
    var done = false;
    return (outcome) {
      if (done) return;
      done = true;
      if (_active.remove(ticket) == null) return;
      watch.stop();
      if (_disposed ||
          (channel == 'setup'
              ? epoch != _guestEpoch || !signedOutSharing || _enabled == false
              : epoch != _accountEpoch || !sharing)) {
        return;
      }
      _count(channel, day, '$prefix${outcome.name}');
      final ms = watch.elapsedMilliseconds + elapsed.inMilliseconds;
      _count(
        channel,
        day,
        '$prefix${ms < 1000
            ? 'under_1s'
            : ms < 10000
            ? '1s_to_10s'
            : ms < 60000
            ? '10s_to_1m'
            : 'over_1m'}',
      );
      if (!flow.long || ms < 60000) return;
      _count(
        channel,
        day,
        '$prefix${ms < 300000
            ? '1m_to_5m'
            : ms < 900000
            ? '5m_to_15m'
            : ms < 3600000
            ? '15m_to_1h'
            : 'over_1h'}',
      );
    };
  }

  /// Counts [measure] of [flow] — one of `PRODUCT_USAGE_ONBOARDING_MARKS` — for an account that shares.
  void mark(ProductFlow flow, String measure) {
    if (_disposed || !sharing) return;
    final day = _now().toUtc().toIso8601String().substring(0, 10);
    _count('ui', day, 'ui_${surface}_${flow.wire}_$measure');
  }

  /// One attempt counted under several flows at once — `sign_in` and the button that started it.
  void Function(ProductOutcome) beginEach(List<ProductFlow> flows) {
    final finishers = [for (final flow in flows) begin(flow)];
    return (outcome) {
      for (final finish in finishers) {
        finish(outcome);
      }
    };
  }

  /// The adapter hands over only enum-derived status names, never setup logs or commands.
  void setupFacts(Map<ProductFlow, String> facts) {
    _setupFacts
      ..clear()
      ..addAll(facts);
    _observeSetupFacts();
  }

  void _observeSetupFacts() {
    if (!_setupAllowed && !sharing) return;
    for (final entry in _setupFacts.entries) {
      if (!entry.key.beforeSignIn || entry.key == ProductFlow.signIn) continue;
      if (const ['pending', 'running', 'needsTerminal'].contains(entry.value)) {
        _setup.putIfAbsent(entry.key, () => begin(entry.key));
      } else if (const [
        'ready',
        'notApplicable',
        'failed',
        'unavailable',
      ].contains(entry.value)) {
        _setup
            .remove(entry.key)
            ?.call(
              const ['ready', 'notApplicable'].contains(entry.value)
                  ? ProductOutcome.ok
                  : ProductOutcome.failed,
            );
      }
    }
  }

  void _count(String channel, String day, String metric) {
    final today = _now().toUtc();
    final date = DateTime.parse(day);
    if (today.difference(date).inDays > 1 || date.isAfter(today)) return;
    _days.removeWhere(
      (key, _) =>
          today.difference(DateTime.parse(key.split(':')[1])).inDays > 1,
    );
    final counters = _days.putIfAbsent('$channel:$day', () => {});
    counters[metric] = min(1000, (counters[metric] ?? 0) + 1);
    // One collector day per app run and UTC day: the backend shows a release or platform split
    // only above a floor of these.
    if (channel == 'ui' && context != null && _coverageDay != day) {
      _coverageDay = day;
      counters['health_${surface}_collector_days'] = 1;
    }
    _schedule();
  }

  void _schedule() {
    if (!automatic ||
        _disposed ||
        _timer != null ||
        (_account == null && _days.isEmpty && _pending.isEmpty)) {
      return;
    }
    final delay = _lastAttempt == null
        ? const Duration(seconds: 2)
        : Duration(
            milliseconds: max(
              1000,
              60000 - _now().difference(_lastAttempt!).inMilliseconds,
            ),
          );
    _timer = Timer(delay, () {
      _timer = null;
      unawaited(flush());
    });
  }

  Future<void> flush() => _flushing ??= _flush().whenComplete(() {
    _flushing = null;
    _schedule();
  });

  Future<void> _flush() async {
    if (_disposed) return;
    _lastAttempt = _now();
    final account = _account, read = _readChoice;
    final choiceEpoch = _accountEpoch;
    if (account != null && read != null) {
      try {
        final choice = await read();
        if (_disposed || account != _account || choiceEpoch != _accountEpoch) {
          return;
        }
        savedChoice(choice);
      } catch (_) {
        _enabled = null;
        return;
      }
    }
    for (final channel in ['setup', 'ui']) {
      if (_disposed || (channel == 'setup' ? !_setupAllowed : !sharing)) {
        continue;
      }
      final epoch = channel == 'setup' ? _guestEpoch : _accountEpoch;
      var report = _pending[channel];
      if (report == null) {
        final keys = _days.keys.where((k) => k.startsWith('$channel:')).toList()
          ..sort();
        if (keys.isEmpty) continue;
        final key = keys.first, counts = _days[key]!;
        final batch = Map<String, int>.fromEntries(counts.entries.take(32));
        for (final metric in batch.keys) {
          counts.remove(metric);
        }
        if (counts.isEmpty) _days.remove(key);
        report = {
          'schemaVersion': 1,
          'id': _receipt(),
          'day': key.split(':')[1],
          'counters': batch,
          if (channel == 'setup') 'consent': true else 'revision': _revision,
          if (channel == 'ui' && context != null) 'context': context,
        };
        _pending[channel] = report;
      }
      if (_now()
              .toUtc()
              .difference(DateTime.parse(report['day'] as String))
              .inDays >
          1) {
        _pending.remove(channel);
        continue;
      }
      try {
        final result = await (channel == 'setup' ? sendSetup : _sendAccount!)(
          report,
        );
        if (_disposed ||
            (channel == 'setup'
                ? epoch != _guestEpoch
                : epoch != _accountEpoch)) {
          continue;
        }
        if (result['accepted'] == true || result['reason'] == 'EXPIRED') {
          _pending.remove(channel);
        }
        if (result['reason'] == 'CHOICE_CHANGED') {
          _enabled = null;
          _clear('ui');
          _clear('setup');
        }
      } catch (_) {
        /* Same receipt on the next timer. No logs, aggressive retry, or product failure. */
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _days.clear();
    _pending.clear();
    _setup.clear();
    _active.clear();
    super.dispose();
  }
}

String newProductReceipt() {
  final random = Random.secure();
  final bytes = List.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  final h = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}
