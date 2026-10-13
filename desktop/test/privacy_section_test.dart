import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/settings/sections/privacy_section.dart';

void main() {
  Future<void> show(WidgetTester tester, UsagePreferenceRequest request) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ProductUsagePreference(
            request: request,
            feedback: (_, _) async {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets(
    'shows the saved preference and turns sharing off for the account',
    (tester) async {
      final changes = <bool>[];
      await show(tester, ({bool? enabled}) async {
        if (enabled != null) changes.add(enabled);
        return {'enabled': enabled ?? true, 'revision': 1};
      });
      expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue);
      expect(find.text('How did your latest task go?'), findsOneWidget);
      await tester.tap(find.byType(Switch));
      await tester.pumpAndSettle();
      expect(changes, [false]);
      expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
      expect(find.text('How did your latest task go?'), findsNothing);
      expect(find.textContaining('every computer and app'), findsOneWidget);
      await tester.tap(find.text('See what’s shared'));
      await tester.pumpAndSettle();
      expect(find.textContaining('random report receipt'), findsOneWidget);
      expect(
        find.textContaining('does not tell us whether your task succeeded'),
        findsOneWidget,
      );
    },
  );
  testWidgets(
    'does not pretend an ambiguous save succeeded or retained its old value',
    (tester) async {
      await show(tester, ({bool? enabled}) async {
        if (enabled != null) throw StateError('PRIVATE_CANARY');
        return {'enabled': true};
      });
      await tester.tap(find.byType(Switch));
      await tester.pumpAndSettle();
      expect(find.byType(Switch), findsNothing);
      expect(find.text('Unavailable'), findsOneWidget);
      expect(find.textContaining('Couldn’t confirm'), findsOneWidget);
      expect(find.textContaining('PRIVATE_CANARY'), findsNothing);
    },
  );
  testWidgets('keeps the control unavailable until a real preference arrives', (
    tester,
  ) async {
    final pending = Completer<Map<String, dynamic>>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ProductUsagePreference(
            request: ({bool? enabled}) => pending.future,
          ),
        ),
      ),
    );
    await tester.pump();
    expect(find.byType(Switch), findsNothing);
    pending.complete({'enabled': false});
    await tester.pumpAndSettle();
    expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
  });
}
