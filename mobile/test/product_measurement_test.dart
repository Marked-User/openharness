import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/measurement/product_measurement.dart';

void main() {
  late ProductMeasurement usage;
  late List<Map<String, dynamic>> setup, reports;
  late Map<String, dynamic> choice;
  late DateTime now;
  var fail = false;
  setUp(() {
    now = DateTime.utc(2026, 10, 14, 12);
    setup = [];
    reports = [];
    choice = {'enabled': true, 'revision': 0};
    fail = false;
    usage = ProductMeasurement(
      surface: 'desktop',
      automatic: false,
      now: () => now,
      sendSetup: (r) async {
        setup.add(jsonDecode(jsonEncode(r)));
        return {'accepted': true};
      },
    );
  });
  tearDown(() => usage.dispose());
  Future<void> account([Object id = 'PRIVATE_ACCOUNT']) async {
    usage.account(
      id,
      choice: () async => choice,
      send: (r) async {
        reports.add(jsonDecode(jsonEncode(r)));
        if (fail) throw StateError('PRIVATE_ERROR');
        return {'accepted': true};
      },
    );
    await usage.flush();
  }

  test(
    'signed-out sharing defaults off and opt-in never replays earlier actions',
    () async {
      usage.begin(ProductFlow.signIn)(ProductOutcome.failed);
      await usage.flush();
      expect(setup, isEmpty);
      await usage.setSignedOutSharing(true);
      final finish = usage.begin(ProductFlow.signIn);
      finish(ProductOutcome.ok);
      finish(ProductOutcome.failed);
      await usage.flush();
      expect(setup.single.keys.toSet(), {
        'schemaVersion',
        'consent',
        'id',
        'day',
        'counters',
      });
      expect(setup.single['counters'], {
        'setup_desktop_sign_in_started': 1,
        'setup_desktop_sign_in_ok': 1,
        'setup_desktop_sign_in_under_1s': 1,
      });
    },
  );
  test(
    'off and account changes discard queued counts and open observations',
    () async {
      await account();
      final finish = usage.begin(ProductFlow.remoteConnect);
      choice = {'enabled': false, 'revision': 1};
      usage.savedChoice(choice);
      finish(ProductOutcome.ok);
      await usage.flush();
      expect(reports, isEmpty);
      choice = {'enabled': true, 'revision': 2};
      await usage.flush();
      usage.begin(ProductFlow.viewerOpen)(ProductOutcome.ok);
      await account('OTHER_PRIVATE_ACCOUNT');
      expect(reports, isEmpty);
      usage.begin(ProductFlow.computerLink)(ProductOutcome.failed);
      await usage.flush();
      expect(jsonEncode(reports), isNot(contains('PRIVATE')));
      expect(
        (reports.single['counters'] as Map).keys,
        everyElement(startsWith('ui_desktop_computer_link_')),
      );
    },
  );
  test(
    'retry is immutable, current events wait, and batching is bounded',
    () async {
      await account();
      fail = true;
      usage.begin(ProductFlow.signIn)(ProductOutcome.ok);
      await usage.flush();
      final first = jsonEncode(reports.single);
      for (final flow in ProductFlow.values) {
        usage.begin(flow)(ProductOutcome.failed);
      }
      await usage.flush();
      expect(jsonEncode(reports.last), first);
      fail = false;
      await usage.flush();
      expect(jsonEncode(reports.last), first);
      await usage.flush();
      await usage.flush();
      for (final r in reports) {
        expect((r['counters'] as Map).length, lessThanOrEqualTo(32));
        expect(utf8.encode(jsonEncode(r)).length, lessThan(4096));
      }
      expect(reports.last['id'], isNot(reports.first['id']));
    },
  );
  test(
    'stale preference response cannot undo an explicit off choice',
    () async {
      final pending = Completer<Map<String, dynamic>>();
      usage.account(
        'PRIVATE_ACCOUNT',
        choice: () => pending.future,
        send: (r) async {
          reports.add(r);
          return {'accepted': true};
        },
      );
      usage.savedChoice(choice);
      usage.begin(ProductFlow.remoteConnect)(ProductOutcome.ok);
      final flushing = usage.flush();
      usage.savedChoice({'enabled': false, 'revision': 1});
      pending.complete(choice);
      await flushing;
      expect(usage.sharing, isFalse);
      expect(reports, isEmpty);
    },
  );
  test(
    'unknown settings fail closed and account off also clears guest consent',
    () async {
      await usage.setSignedOutSharing(true);
      usage.begin(ProductFlow.signIn)(ProductOutcome.ok);
      choice = {'enabled': false, 'revision': 1};
      await account();
      expect(setup, isEmpty);
      expect(usage.signedOutSharing, isFalse);
      usage.savedChoice({'enabled': true});
      expect(usage.sharing, isFalse);
    },
  );
  test(
    'expired RAM queues are discarded and unmatched setup remains unknown',
    () async {
      await usage.setSignedOutSharing(true);
      usage.setupFacts({ProductFlow.setupTmux: 'running'});
      usage.setupFacts({ProductFlow.setupTmux: 'ready'});
      usage.setupFacts({ProductFlow.setupTmux: 'ready'});
      await usage.flush();
      expect(
        (setup.single['counters'] as Map)['setup_desktop_setup_tmux_ok'],
        1,
      );
      usage.begin(ProductFlow.signIn);
      now = now.add(const Duration(days: 2));
      await usage.flush();
      expect(setup.length, 1);
    },
  );
  test(
    'flow observations are bounded and unknown operations never upload content',
    () async {
      await account();
      for (var i = 0; i < 1000; i++) {
        usage.begin(ProductFlow.remoteConnect);
      }
      await usage.flush();
      expect(reports.single['counters'], {
        'ui_desktop_remote_connect_started': 64,
      });
    },
  );
  test(
    'web never queues signed-out setup even if a caller enables it',
    () async {
      final web = ProductMeasurement(
        surface: 'web',
        automatic: false,
        sendSetup: (r) async {
          setup.add(r);
          return {'accepted': true};
        },
      );
      await web.setSignedOutSharing(true);
      web.begin(ProductFlow.signIn)(ProductOutcome.ok);
      await web.flush();
      web.dispose();
      expect(setup, isEmpty);
    },
  );
}
