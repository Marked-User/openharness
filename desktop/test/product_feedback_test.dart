import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/widgets/product_feedback.dart';

void main() {
  testWidgets(
    'counts exposure, successful answer, and dismissal without task context',
    (tester) async {
      var shown = 0, answered = 0, dismissed = 0;
      Future<void> show() => tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ProductFeedback(
              send: (_, _) async {},
              onShown: () => shown++,
              onAnswered: () => answered++,
              onDismissed: () => dismissed++,
            ),
          ),
        ),
      );
      await show();
      await tester.pump();
      expect(shown, 1);
      expect(answered, 0);
      await tester.tap(find.text('Useful'));
      await tester.pumpAndSettle();
      expect(answered, 1);
      await tester.pumpWidget(const SizedBox());
      expect(dismissed, 0);
      await show();
      await tester.pump();
      await tester.pumpWidget(const SizedBox());
      expect(shown, 2);
      expect(dismissed, 1);
    },
  );
  testWidgets(
    'voluntary feedback sends only a fixed answer and retries the same receipt',
    (tester) async {
      final calls = <List<String>>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ProductFeedback(
              send: (answer, receipt) async {
                calls.add([answer, receipt]);
                if (calls.length == 1) throw StateError('PRIVATE_CANARY');
              },
            ),
          ),
        ),
      );
      expect(calls, isEmpty);
      await tester.tap(find.text('Useful'));
      await tester.pumpAndSettle();
      expect(find.textContaining('PRIVATE_CANARY'), findsNothing);
      expect(find.textContaining('Couldn’t confirm'), findsOneWidget);
      await tester.tap(find.text('Useful'));
      await tester.pumpAndSettle();
      expect(calls.length, 2);
      expect(calls[0], calls[1]);
      expect(calls[0][0], 'useful');
      expect(
        calls[0][1],
        matches(
          RegExp(
            r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          ),
        ),
      );
      expect(find.text('Feedback sent. Thank you.'), findsOneWidget);
      expect(
        tester
            .widget<OutlinedButton>(
              find.widgetWithText(OutlinedButton, 'Useful'),
            )
            .onPressed,
        isNull,
      );
    },
  );
}
