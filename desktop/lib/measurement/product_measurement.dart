
import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import 'product_health_contract.dart';
export 'product_health_contract.dart';

enum ProductFlow {
  setup('setup'),
  setupHarness('setup_harness'),
  setupTmux('setup_tmux'),
  setupClipboard('setup_clipboard'),
  signIn('sign_in'),
  workspaceConnect('workspace_connect'),
  computerLink('computer_link'),
  remoteConnect('remote_connect'),
  viewerOpen('viewer_open'),
  updateCheck('update_check'),
  updateStage('update_stage'),
  appStart('app_start'),
  workspaceReady('workspace_ready'),
  viewerLoad('viewer_load'),
  updateApply('update_apply'),
  updateRelaunch('update_relaunch'),
  connectUser('connect_user'),
  connectAuto('connect_auto'),
  resumeRecovery('resume_recovery');

  const ProductFlow(this.wire);
  final String wire;
  bool get beforeSignIn => index <= ProductFlow.signIn.index;
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
    this.context,
  }) : assert(const ['desktop', 'phone', 'web'].contains(surface)),
       _now = now ?? DateTime.now,
       _receipt = receipt ?? newProductReceipt {
    choiceLoaded = true;
  }

  final String surface;
  ProductUsageContext? context;
  bool get healthEnabled => surface == 'desktop' && context != null;
  String? _coverageDay;
  final _funnelSeen = <String, Set<ProductHealthMeasure>>{};
  final _funnelStarted = <String, DateTime>{};
  final _expires = <Object, DateTime>{};
  final _expire = <Object, void Function(ProductOutcome)>{};
  int get choiceRevision => _revision;
  final ProductReportRequest sendSetup;
  final bool automatic;
  final DateTime Function() _now;
  final String Function() _receipt;
  bool signedOutSharing = false, choiceLoaded = false;
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
    if (_account != null) {
      _guestEpoch++;
      signedOutSharing = false;
      _clear('setup');
      _setup.clear();
    }
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
    for (final ticket
        in _active.keys.where((key) => _active[key] == channel).toList()) {
      _active.remove(ticket);
      _expires.remove(ticket);
      _expire.remove(ticket);
    }
    _funnelSeen.remove(channel);
    _funnelStarted.remove(channel);
    if (channel == 'ui') _coverageDay = null;
  }

  void _coverage() {
    if (!healthEnabled || !sharing || _disposed) return;
    final day = _now().toUtc().toIso8601String().substring(0, 10);
    if (_coverageDay == day) return;
    _coverageDay = day;
    _count('ui', day, 'health_desktop_collector_days');
  }

  /// Only fixed enum scalars enter the queue. Called after checking the account choice.
  void health(ProductHealthMeasure measure) {
    if (!healthEnabled || !sharing || _disposed) return;
    _coverage();
    _count(
      'ui',
      _now().toUtc().toIso8601String().substring(0, 10),
      'health_desktop_${measure.wire}',
    );
  }

  /// Observed readiness since process launch; only its coarse duration is kept.
  void observedStartup(Duration elapsed) {
    if (!healthEnabled || !sharing || _disposed) return;
    _coverage();
    final day = _now().toUtc().toIso8601String().substring(0, 10);
    const prefix = 'ui_desktop_app_start_';
    final ms = elapsed.inMilliseconds;
    _count('ui', day, '${prefix}started');
    _count('ui', day, '${prefix}ok');
    _count(
      'ui',
      day,
      '$prefix${ms < 1000
          ? 'under_1s'
          : ms < 10000
          ? '1s_to_10s'
          : ms < 60000
          ? '10s_to_1m'
          : 'over_1m'}',
    );
  }

  /// A consented app-session funnel, never a click trail or an account join.
  /// Its clock starts at the first permitted observation, not retrospectively at install.
  void milestone(ProductHealthMeasure measure) {
    if (!healthEnabled || _disposed || !measure.wire.startsWith('funnel_')) {
      return;
    }
    final channel = _setupAllowed
        ? 'setup'
        : sharing
        ? 'ui'
        : null;
    if (channel == null) return;
    final seen = _funnelSeen.putIfAbsent(channel, () => {});
    if (!seen.add(measure)) return;
    final now = _now().toUtc();
    final start = _funnelStarted.putIfAbsent(channel, () => now);
    final day = now.toIso8601String().substring(0, 10);
    if (channel == 'ui') _coverage();
    void count(String name) => _count(
      channel,
      day,
      channel == 'setup' ? 'setup_desktop_$name' : 'health_desktop_$name',
    );
    count(measure.wire);
    if (measure == ProductHealthMeasure.funnelFirstWork ||
        measure == ProductHealthMeasure.funnelFirstResponse) {
      final elapsed = now.difference(start).inSeconds;
      final value = measure == ProductHealthMeasure.funnelFirstWork
          ? 'first_work'
          : 'first_response';
      count(
        '${value}_${elapsed < 60
            ? 'under_1m'
            : elapsed < 300
            ? '1m_to_5m'
            : 'over_5m'}',
      );
    }
  }

  void Function(ProductOutcome) begin(ProductFlow flow) {
    if (flow == ProductFlow.signIn) {
      milestone(ProductHealthMeasure.funnelSignInSeen);
    }
    if (flow.index >= ProductFlow.appStart.index && !healthEnabled) {
      return (_) {};
    }
    _coverage();
    final channel = sharing
        ? 'ui'
        : flow.beforeSignIn && _setupAllowed
        ? 'setup'
        : null;
    if (_disposed || channel == null) return (_) {};
    if (_active.length >= 64) {
      health(ProductHealthMeasure.observationOverflow);
      return (_) {};
    }
    final epoch = channel == 'setup' ? _guestEpoch : _accountEpoch;
    final started = _now().toUtc();
    final watch = Stopwatch()..start();
    final day = started.toIso8601String().substring(0, 10);
    final prefix = '${channel}_${surface}_${flow.wire}_';
    final ticket = Object();
    _active[ticket] = channel;
    _count(channel, day, '${prefix}started');
    var done = false;
    void finish(ProductOutcome outcome) {
      if (done) return;
      done = true;
      if (_active.remove(ticket) == null) return;
      _expires.remove(ticket);
      _expire.remove(ticket);
      watch.stop();
      if (_disposed ||
          (channel == 'setup'
              ? epoch != _guestEpoch || !signedOutSharing || _enabled == false
              : epoch != _accountEpoch || !sharing)) {
        return;
      }
      _count(channel, day, '$prefix${outcome.name}');
      final ms = watch.elapsedMilliseconds;
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
    }

    _expires[ticket] = started.add(const Duration(minutes: 15));
    _expire[ticket] = finish;
    return finish;
  }

  /// A widget's delayed callback cannot count after sign-out or a choice revision.
  VoidCallback observer(ProductHealthMeasure measure) {
    final epoch = _accountEpoch;
    return () {
      if (epoch == _accountEpoch) health(measure);
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
    if (_setupFacts.isNotEmpty) milestone(ProductHealthMeasure.funnelSetupSeen);
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
    if ((counters[metric] ?? 0) >= 1000 && healthEnabled && channel == 'ui') {
      counters['health_desktop_queue_capped'] = 1;
    }
    counters[metric] = min(1000, (counters[metric] ?? 0) + 1);
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
    for (final ticket in _expires.keys.toList()) {
      if (!_now().toUtc().isBefore(_expires[ticket]!)) {
        _expire[ticket]?.call(ProductOutcome.unknown);
      }
    }
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
          if (channel == 'ui' && healthEnabled) 'context': context!.toJson(),
        };
        _pending[channel] = report;
      }
      if (_now()
              .toUtc()
              .difference(DateTime.parse(report['day'] as String))
              .inDays >
          1) {
        _pending.remove(channel);
        if (channel == 'ui') health(ProductHealthMeasure.reportExpired);
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
        if (result['accepted'] != true &&
            result['reason'] != 'EXPIRED' &&
            result['reason'] != 'CHOICE_CHANGED') {
          health(ProductHealthMeasure.reportRejected);
        }
        if (result['reason'] == 'CHOICE_CHANGED') {
          _enabled = null;
          _clear('ui');
          _clear('setup');
        }
      } catch (_) {
        if (channel == 'ui') health(ProductHealthMeasure.reportFailed);
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
    _expires.clear();
    _expire.clear();
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
