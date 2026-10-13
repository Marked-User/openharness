import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/privacy_page.dart';

void main() {
  testWidgets('the phone can turn off sharing for the whole account', (
    tester,
  ) async {
    final changes = <bool>[];
    await tester.pumpWidget(
      MaterialApp(
        home: PrivacyPage(
          request: ({bool? enabled}) async {
            if (enabled != null) changes.add(enabled);
            return {'enabled': enabled ?? true};
          },
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();
    expect(changes, [false]);
    expect(find.textContaining('every computer and app'), findsOneWidget);
    await tester.tap(find.text('See what’s shared'));
    await tester.pumpAndSettle();
    expect(find.textContaining('random retry receipt'), findsOneWidget);
  });
  testWidgets(
    'a failed write leaves an unavailable switch and a reload action',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: PrivacyPage(
            request: ({bool? enabled}) async {
              if (enabled != null) throw StateError('PRIVATE_CANARY');
              return {'enabled': true};
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byType(Switch));
      await tester.pumpAndSettle();
      expect(find.byType(Switch), findsNothing);
      expect(find.text('Setting unavailable'), findsOneWidget);
      expect(find.text('Reload'), findsOneWidget);
      expect(find.textContaining('PRIVATE_CANARY'), findsNothing);
    },
  );
}
