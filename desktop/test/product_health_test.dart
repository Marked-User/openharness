import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/measurement/product_measurement.dart';
import 'package:harness/measurement/product_connections.dart';
import 'package:harness/measurement/product_runtime_health.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late ProductMeasurement usage;
  late List<Map<String, dynamic>> reports, setup;
  late DateTime now;
  setUp(() {
    now = DateTime.utc(2026, 10, 14, 12);
    reports = [];
    setup = [];
    usage = ProductMeasurement(
      surface: 'desktop',
      automatic: false,
      context: ProductUsageContext(
        release: '1.2.73',
        platform: 'macos',
        production: true,
      ),
      now: () => now,
      sendSetup: (report) async {
        setup.add(report);
        return {'accepted': true};
      },
    );
    usage.account(
      'PRIVATE_ACCOUNT',
      choice: () async => {'enabled': true, 'revision': 0},
      send: (report) async {
        reports.add(jsonDecode(jsonEncode(report)));
        return {'accepted': true};
      },
    );
  });
  tearDown(() => usage.dispose());
  test('development builds do not send anonymous setup counts', () async {
    usage.account(null);
    usage.context = ProductUsageContext(release: 'unknown', platform: 'macos', production: false);
    await usage.setSignedOutSharing(true);
    usage.begin(ProductFlow.setup)(ProductOutcome.ok);
    usage.milestone(ProductHealthMeasure.funnelSetupSeen);
    await usage.flush();
    expect(setup, isEmpty);
  });
  Map<String, int> totals() {
    final all = <String, int>{};
    for (final report in [...reports, ...setup]) {
      for (final e in (report['counters'] as Map).entries)
        all[e.key as String] = (all[e.key] ?? 0) + (e.value as int);
    }
    return all;
  }

  test('consented funnel is once per local episode, with coarse waits and no identity', () async {
    usage.milestone(ProductHealthMeasure.funnelFirstWork);
    expect(totals(), isEmpty);
    usage.account(null);
    await usage.setSignedOutSharing(true);
    usage.milestone(ProductHealthMeasure.funnelSetupSeen);
    now = now.add(const Duration(minutes: 2));
    usage.milestone(ProductHealthMeasure.funnelFirstWork);
    usage.milestone(ProductHealthMeasure.funnelFirstWork);
    now = now.add(const Duration(minutes: 4));
    usage.milestone(ProductHealthMeasure.funnelFirstResponse);
    await usage.flush();
    expect(totals()['setup_desktop_funnel_first_work'], 1);
    expect(totals()['setup_desktop_first_work_1m_to_5m'], 1);
    expect(totals()['setup_desktop_first_response_over_5m'], 1);
    expect(jsonEncode(setup), isNot(contains('PRIVATE')));
  });

  test('manual connect and automatic retries remain separate; missing outcomes expire as unknown', () async {
    await usage.flush();
    final connections = ProductConnections(usage);
    connections.status('PRIVATE_MACHINE', connecting: true, connected: false);
    connections.status(
      'PRIVATE_MACHINE',
      connecting: false,
      connected: false,
      failure: ProductHealthMeasure.connectErrorUnlinked,
    );
    final manual = connections.manual('PRIVATE_MACHINE');
    connections.status('PRIVATE_MACHINE', connecting: true, connected: false);
    connections.status('PRIVATE_MACHINE', connecting: false, connected: true);
    manual(ProductOutcome.ok);
    manual(ProductOutcome.failed);
    usage.begin(ProductFlow.resumeRecovery);
    now = now.add(const Duration(minutes: 16));
    await usage.flush();
    await usage.flush();
    expect(totals()['ui_desktop_connect_auto_failed'], 1);
    expect(totals()['ui_desktop_connect_user_ok'], 1);
    expect(totals()['ui_desktop_connect_auto_started'], 1);
    expect(totals()['ui_desktop_resume_recovery_unknown'], 1);
    expect(jsonEncode(reports), isNot(contains('PRIVATE')));
    expect(reports.first['context'], usage.context!.toJson());
  });

  test('opt-out and account changes fence delayed callbacks, counters, and retries', () async {
    await usage.flush();
    final old = usage.begin(ProductFlow.viewerLoad);
    final feedback = usage.observer(
      ProductHealthMeasure.feedbackOutcomeAnswered,
    );
    usage.savedChoice({'enabled': false, 'revision': 1});
    usage.savedChoice({'enabled': true, 'revision': 2});
    old(ProductOutcome.ok);
    feedback();
    await usage.flush();
    expect(totals()['ui_desktop_viewer_load_ok'], isNull);
    expect(totals()['health_desktop_feedback_outcome_answered'], isNull);
    usage.health(ProductHealthMeasure.frameworkError);
    usage.account('DIFFERENT_PRIVATE_ACCOUNT');
    await usage.flush();
    expect(totals()['health_desktop_framework_error'], isNull);
  });

  testWidgets(
    'runtime stores only last-run control flags and removes them after opt-out',
    (tester) async {
      Map<String, dynamic> saved = {};
      final runtime = ProductRuntimeHealth(
        usage,
        readState: () async => Map.of(saved),
        writeState: (value) async {
          saved = Map.of(value);
        },
        readVersion: () async => '1.2.73',
      );
      runtime.account('PRIVATE_ACCOUNT');
      runtime.ready();
      ProductRuntimeHealth.launched();
      await usage.flush();
      await tester.pump();
      expect(saved.keys.toSet(), {'scope', 'revision', 'release', 'clean'});
      expect(saved['clean'], false);
      expect(jsonEncode(saved), isNot(contains('PRIVATE')));
      runtime.expectUpdate('1.2.74');
      await tester.pump();
      expect(saved['pendingUpdate'], '1.2.74');
      usage.savedChoice({'enabled': false, 'revision': 1});
      await tester.pump();
      expect(saved, isEmpty);
      runtime.dispose();
      await tester.pump();
      expect(saved, isEmpty);
    },
  );

  testWidgets(
    'relaunch confirms only the expected public version and sharing revision',
    (tester) async {
      Map<String, dynamic> saved = {};
      ProductRuntimeHealth create(String version) => ProductRuntimeHealth(
        usage,
        readState: () async => Map.of(saved),
        writeState: (value) async {
          saved = Map.of(value);
        },
        readVersion: () async => version,
      );
      var runtime = create('1.2.73');
      runtime.account('PRIVATE_ACCOUNT');
      await usage.flush();
      await tester.pump();
      runtime.expectUpdate('1.2.74');
      await tester.pump();
      runtime.dispose();
      await tester.pump();
      runtime = create('1.2.74');
      runtime.account('PRIVATE_ACCOUNT');
      await tester.pump();
      await usage.flush();
      await usage.flush();
      expect(totals()['ui_desktop_update_relaunch_ok'], 1);
      expect(totals()['health_desktop_install_upgrade'], 1);
      expect(jsonEncode(reports), isNot(contains('scope')));
      runtime.dispose();
      await tester.pump();
    },
  );
}
