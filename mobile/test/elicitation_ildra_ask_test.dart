import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/elicitation_press.dart';
import 'package:harness_mobile/terminal/question_pane.dart';
import 'package:xterm/xterm.dart';

QuestionPaneView _dialog(String question, {String focused = '2'}) => QuestionPaneView(
      question: question,
      rows: const [
        QuestionPaneRow(number: '1', label: 'Accept', checked: false),
        QuestionPaneRow(number: '2', label: 'Decline', checked: false),
      ],
      multi: false,
      enterSubmits: true,
      partial: false,
      kind: QuestionPaneKind.elicitation,
      focused: focused,
    );

void main() {
  test('Ildra Ask dialogs are recognized and never pressed (Shield F13)', () {
    expect(isIldraAskQuestion('[Ildra Ask abcd1234] ASK: Send an email'), isTrue);
    expect(isIldraAskQuestion('Drop table users?'), isFalse);
  });

  test('a press on an Ildra Ask dialog sends no key, on either button', () {
    final sent = <TerminalKey>[];
    final press = ElicitationPress(
      read: () => _dialog('[Ildra Ask abcd1234] ASK: Send an email', focused: '1'),
      send: sent.add,
    );
    expect(press.press('1'), isFalse);
    expect(press.press('2'), isFalse);
    expect(sent, isEmpty);
  });

  test('a plain MCP dialog is still pressed (Enter on the focused button)', () {
    final sent = <TerminalKey>[];
    final press = ElicitationPress(read: () => _dialog('Drop table users?'), send: sent.add);
    expect(press.press('2'), isTrue);
    expect(sent, [TerminalKey.enter]);
  });
}
