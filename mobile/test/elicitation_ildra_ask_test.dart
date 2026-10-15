import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/elicitation_press.dart';

void main() {
  test('Ildra Ask dialogs are recognized and never pressed (Shield F13)', () {
    expect(isIldraAskQuestion('[Ildra Ask abcd1234] ASK: Send an email'), isTrue);
    expect(isIldraAskQuestion('Drop table users?'), isFalse);
  });
}
