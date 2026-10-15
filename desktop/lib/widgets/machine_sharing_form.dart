import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../state/app_state.dart';
import '../terminal/terminal_text.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import 'box_chrome.dart' show ReadlineKeys;
import 'desktop_chrome.dart';
import 'terminal_text_action.dart';

/// The most addresses one machine is shared with (CLI services/sharedMachines.ts `SHARE_EMAILS_MAX`).
const int machineShareEmailsMax = 100;

/// The backend's own rule for an address (zod's `email()`): one it would refuse is refused as it is
/// typed, by name, never as a failed save of the whole list.
final _emailPattern = RegExp(
  r"^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$",
);

/// Sharing one of the account's machines with other accounts
/// (docs/plans/2026-10-15-share-machine-plan.md), in the Machines picker's preview like Rename: the
/// addresses it is shared with, and everyone at the owner's domain. The policy lives on the machine
/// itself, so it is read from and written to that machine (`shared_machines`).
class MachineSharingForm extends StatefulWidget {
  const MachineSharingForm({
    super.key,
    required this.app,
    required this.machineId,
    required this.onClose,
    required this.onFocusChanged,
    this.onSwitchPane,
  });
  final AppNotifier app;
  final String machineId;
  final ValueChanged<String?> onClose;
  final ValueChanged<bool> onFocusChanged;
  final VoidCallback? onSwitchPane;

  @override
  State<MachineSharingForm> createState() => MachineSharingFormState();
}

class MachineSharingFormState extends State<MachineSharingForm> {
  final _scope = FocusNode(debugLabel: 'Machine sharing');
  final _input = FocusNode(debugLabel: 'Share email');
  final _buttons = <String, FocusNode>{};
  final _value = TextEditingController();
  bool _loading = true, _busy = false, _error = false;
  String? _message;
  List<String> _emails = [];
  List<String> _savedEmails = [];
  bool _sameDomain = false, _savedSameDomain = false;
  String? _domain;
  List<Map<String, dynamic>> _members = const [];

  AppNotifier get app => widget.app;
  String get _name =>
      app.stateOf(widget.machineId)?.machine.displayName ?? 'this machine';
  bool get _changed =>
      _sameDomain != _savedSameDomain ||
      _emails.length != _savedEmails.length ||
      _emails.any((email) => !_savedEmails.contains(email));
  bool get _composing =>
      _value.value.composing.isValid && !_value.value.composing.isCollapsed;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _scope.dispose();
    _input.dispose();
    for (final node in _buttons.values) {
      node.dispose();
    }
    _value.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    Map<String, dynamic> answer;
    try {
      answer = await app.machineSharing(widget.machineId);
    } catch (error) {
      answer = {
        'error': 'UNAVAILABLE',
        'message': 'Could not reach $_name: $error',
      };
    }
    if (!mounted) return;
    setState(() {
      _loading = false;
      _show(answer);
    });
    focus();
  }

  /// What the machine answered: its sharing as saved, or why it could not say.
  void _show(Map<String, dynamic> answer) {
    _savedEmails = [
      for (final email in answer['emails'] as List? ?? const [])
        if (email is String) email,
    ];
    _savedSameDomain = answer['sameDomain'] == true;
    _emails = [..._savedEmails];
    _sameDomain = _savedSameDomain;
    _domain = answer['domain'] as String?;
    _members = [
      for (final member in answer['members'] as List? ?? const [])
        if (member is Map) Map<String, dynamic>.from(member),
    ];
    final error = answer['error'];
    _error = error != null;
    _message = error == null
        ? null
        : error == 'UNSUPPORTED'
        ? 'Update Harness on $_name to share it.'
        : answer['message'] as String? ??
              'Could not read its sharing ($error).';
  }

  void focus() {
    final target = _busy || _loading ? _scope : _input;
    if (target.context != null) {
      target.requestFocus();
    } else {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) target.requestFocus();
      });
    }
  }

  /// Every address typed in the field joins the list; false when one is not an address.
  bool _addTyped() {
    final typed = _value.text
        .split(RegExp(r'[\s,;]+'))
        .map((email) => email.trim().toLowerCase())
        .where((email) => email.isNotEmpty)
        .toList();
    if (typed.isEmpty) return true;
    final bad = typed
        .where((email) => !_emailPattern.hasMatch(email))
        .firstOrNull;
    if (bad != null) {
      _say('Not an email address: $bad');
      return false;
    }
    final next = {..._emails, ...typed}.toList();
    if (next.length > machineShareEmailsMax) {
      _say('Share with up to $machineShareEmailsMax addresses.');
      return false;
    }
    setState(() {
      _emails = next;
      _value.clear();
      _message = null;
    });
    return true;
  }

  void _say(String message, {bool error = true}) {
    setState(() {
      _message = message;
      _error = error;
    });
  }

  void _remove(String email) {
    setState(() {
      _emails = [..._emails]..remove(email);
      _message = null;
    });
    focus();
  }

  Future<void> _save() async {
    if (_busy || _loading || _composing) return;
    if (!_addTyped()) {
      _input.requestFocus();
      return;
    }
    if (!_changed) {
      widget.onClose(null);
      return;
    }
    setState(() {
      _busy = true;
      _message = null;
    });
    Map<String, dynamic> answer;
    try {
      answer = await app.setMachineSharing(
        widget.machineId,
        _emails,
        sameDomain: _sameDomain,
      );
    } catch (error) {
      answer = {
        'error': 'UNAVAILABLE',
        'message': 'Could not reach $_name: $error',
      };
    }
    if (!mounted) return;
    if (answer['error'] != null) {
      setState(() {
        _busy = false;
        _error = true;
        _message =
            answer['message'] as String? ??
            'Could not share it (${answer['error']}).';
      });
      focus();
      return;
    }
    setState(() => _busy = false);
    final emails = (answer['emails'] as List? ?? const []).length;
    final domain = answer['sameDomain'] == true
        ? answer['domain'] as String?
        : null;
    widget.onClose(
      emails == 0 && domain == null
          ? 'Not shared.'
          : 'Shared with ${[if (emails > 0) emails == 1 ? '1 person' : '$emails people', if (domain != null) 'everyone at @$domain'].join(' and ')}.',
    );
  }

  List<({String id, String label, VoidCallback? run})> get _actions => [
    if (_domain != null && !_loading)
      (
        id: 'domain',
        label: 'Everyone at @$_domain: ${_sameDomain ? 'On' : 'Off'}',
        run: _busy ? null : () => setState(() => _sameDomain = !_sameDomain),
      ),
    for (final email in _emails)
      (
        id: 'remove:$email',
        label: 'Remove $email',
        run: _busy ? null : () => _remove(email),
      ),
    (
      id: 'save',
      label: _busy ? 'Saving…' : 'Save',
      run: _busy || _loading ? null : () => unawaited(_save()),
    ),
    (id: 'cancel', label: 'Cancel', run: () => widget.onClose(null)),
  ];

  List<FocusNode> get _nodes => [
    if (!_loading && !_busy) _input,
    for (final action in _actions)
      if (action.run != null && _buttons[action.id] != null)
        _buttons[action.id]!,
  ];

  void _move(bool forward) {
    if (_composing) return;
    final nodes = _nodes;
    if (nodes.isEmpty) return;
    final current = nodes.indexWhere((node) => node.hasFocus);
    final node =
        nodes[current < 0 ? 0 : (current + (forward ? 1 : -1)) % nodes.length];
    node.requestFocus();
    if (node.context case final context?) Scrollable.ensureVisible(context);
  }

  void _tab(bool forward) {
    if (_composing) return;
    final nodes = _nodes;
    final current = nodes.indexWhere((node) => node.hasFocus);
    final next = current + (forward ? 1 : -1);
    if (next >= 0 && next < nodes.length) {
      nodes[next].requestFocus();
    } else if (widget.onSwitchPane != null) {
      widget.onSwitchPane!();
    } else {
      _move(forward);
    }
  }

  void _accept() {
    if (_composing) return;
    final action = _actions
        .where((a) => _buttons[a.id]?.hasFocus == true)
        .firstOrNull;
    if (action != null) {
      action.run?.call();
    } else if (_input.hasFocus && _value.text.trim().isNotEmpty) {
      _addTyped();
    } else {
      unawaited(_save());
    }
  }

  /// The picker's commands, while this editor holds the keys.
  bool handle(String command) {
    if (_composing) return true;
    switch (command) {
      case 'picker.cancel':
        widget.onClose(null);
      case 'picker.accept':
        _scope.hasFocus ? _accept() : focus();
      case 'picker.complete':
        _tab(true);
      case 'picker.complete_back':
        _tab(false);
      case 'picker.next' || 'picker.previous':
        if (!_scope.hasFocus) return false;
        _move(command == 'picker.next');
      default:
        return false;
    }
    return true;
  }

  Widget _keys(Widget child) {
    if (KeymapTheme.of(context) != null) {
      return KeymapRegion(
        contextKind: KeymapContext.picker,
        composing: () => _composing,
        actions: {
          'picker.accept': _accept,
          'picker.cancel': () => widget.onClose(null),
          'picker.complete': () => _tab(true),
          'picker.complete_back': () => _tab(false),
          'picker.next': () => _move(true),
          'picker.previous': () => _move(false),
        },
        child: child,
      );
    }
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.enter, includeRepeats: false):
            _accept,
        const SingleActivator(
          LogicalKeyboardKey.numpadEnter,
          includeRepeats: false,
        ): _accept,
        const SingleActivator(LogicalKeyboardKey.escape): () =>
            widget.onClose(null),
        const SingleActivator(LogicalKeyboardKey.tab): () => _tab(true),
        const SingleActivator(LogicalKeyboardKey.tab, shift: true): () =>
            _tab(false),
        const SingleActivator(LogicalKeyboardKey.arrowDown): () => _move(true),
        const SingleActivator(LogicalKeyboardKey.arrowUp): () => _move(false),
      },
      child: child,
    );
  }

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    grid.AppTheme.watch(context);
    final desktop = DesktopChrome.of(context);
    final cell = desktop ? const Size(9, 14) : terminalCellSizeOf(context);
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    final gap = SizedBox(height: cell.height);
    Widget line(String text, {bool muted = false}) => Text(
      text,
      style: desktop
          ? DesktopChrome.text(
              size: 13,
              color: muted ? DesktopChrome.muted : null,
            )
          : terminalContentStyle(color: muted ? theme.muted : theme.foreground),
    );
    Widget button(({String id, String label, VoidCallback? run}) action) {
      final node = _buttons.putIfAbsent(
        action.id,
        () => FocusNode(debugLabel: action.label),
      );
      final destructive = action.id.startsWith('remove:');
      return desktop
          ? DesktopPill(
              key: ValueKey('machine-sharing:${action.id}'),
              label: destructive ? 'Remove' : action.label,
              compact: true,
              focusNode: node,
              foregroundColor: destructive
                  ? Theme.of(context).colorScheme.error
                  : null,
              onPressed: action.run,
            )
          : TerminalTextAction(
              key: ValueKey('machine-sharing:${action.id}'),
              label: destructive ? 'Remove' : action.label,
              padding: EdgeInsets.zero,
              focusNode: node,
              onPressed: action.run,
            );
    }

    final actions = _actions;
    final field = ReadlineKeys(
      controller: _value,
      enabled: !_busy,
      onChanged: (_) {
        if (_message != null) setState(() => _message = null);
      },
      child: TextField(
        key: const ValueKey('machine-sharing-email'),
        controller: _value,
        focusNode: _input,
        readOnly: _busy || _loading,
        onTapOutside: (_) {},
        enableSuggestions: false,
        autocorrect: false,
        keyboardType: TextInputType.emailAddress,
        style: desktop
            ? DesktopChrome.text(size: 13)
            : terminalContentStyle(color: theme.foreground),
        cursorColor: desktop ? DesktopChrome.accent : theme.foreground,
        decoration: desktop
            ? InputDecoration(
                hintText: 'name@company.com',
                hintStyle: DesktopChrome.text(
                  size: 13,
                  color: DesktopChrome.muted,
                ),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(
                    grid.AppDesktop.fieldRadius,
                  ),
                  borderSide: BorderSide(color: DesktopChrome.rim),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(
                    grid.AppDesktop.fieldRadius,
                  ),
                  borderSide: BorderSide(color: DesktopChrome.rim),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(
                    grid.AppDesktop.fieldRadius,
                  ),
                  borderSide: BorderSide(
                    color: DesktopChrome.focusRing,
                    width: grid.AppDesktop.focusWidth,
                  ),
                ),
                filled: true,
                fillColor: DesktopChrome.field,
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 10,
                ),
              )
            : InputDecoration(
                hintText: 'name@company.com',
                hintStyle: terminalContentStyle(color: theme.muted),
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                filled: false,
                isDense: true,
                isCollapsed: true,
                constraints: const BoxConstraints(),
                contentPadding: EdgeInsets.zero,
              ),
        onEditingComplete: () {},
        onChanged: (_) {
          if (_message != null) setState(() => _message = null);
        },
      ),
    );
    final using = [
      for (final member in _members)
        if (member['email'] is String) member['email'] as String,
    ];
    final body = SingleChildScrollView(
      padding: EdgeInsets.symmetric(
        horizontal: cell.width * 2,
        vertical: cell.height,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Share $_name',
            style: desktop
                ? DesktopChrome.heading()
                : terminalContentStyle(color: theme.foreground),
          ),
          gap,
          line(
            'People you share it with use it as their own: its harnesses, terminals and files.',
            muted: true,
          ),
          gap,
          if (_loading)
            line('Reading its sharing…', muted: true)
          else ...[
            if (actions.where((a) => a.id == 'domain').firstOrNull
                case final domain?) ...[
              button(domain),
              if (_sameDomain)
                line('They add it from Add machine.', muted: true),
              gap,
            ],
            if (desktop) ...[
              Text(
                'Email',
                style: DesktopChrome.text(size: 12, color: DesktopChrome.muted),
              ),
              const SizedBox(height: 6),
              field,
            ] else
              Row(
                children: [
                  SizedBox(
                    width: cell.width * 8,
                    child: Text(
                      'email >',
                      style: terminalContentStyle(color: theme.muted),
                    ),
                  ),
                  Expanded(child: field),
                ],
              ),
            line('Enter adds it. They see it in their Machines.', muted: true),
            if (_emails.isNotEmpty) ...[
              gap,
              for (final email in _emails)
                Padding(
                  padding: EdgeInsets.only(bottom: desktop ? 4 : 0),
                  child: Row(
                    children: [
                      Expanded(child: line(email)),
                      button(
                        actions.firstWhere((a) => a.id == 'remove:$email'),
                      ),
                    ],
                  ),
                ),
            ],
            if (using.isNotEmpty) ...[
              gap,
              line('Using it now: ${using.join(', ')}', muted: true),
            ],
          ],
          gap,
          if (_message != null) ...[
            Semantics(
              liveRegion: true,
              child: Text(
                _message!,
                style: desktop
                    ? DesktopChrome.text(
                        size: 12,
                        color: _error
                            ? Theme.of(context).colorScheme.error
                            : DesktopChrome.muted,
                      )
                    : terminalContentStyle(
                        color: _error ? theme.yellow : theme.muted,
                      ),
              ),
            ),
            gap,
          ],
          Wrap(
            spacing: desktop ? 8 : cell.width * 2,
            runSpacing: desktop ? 8 : cell.height,
            children: [
              for (final action in actions)
                if (action.id == 'save' || action.id == 'cancel')
                  button(action),
            ],
          ),
        ],
      ),
    );
    String? hint(String command) => effectiveCommandHint(
      context,
      command,
      contextKind: KeymapContext.picker,
    )?.replaceAll('⇥', 'Tab').replaceAll('↵', 'Enter');
    return _keys(
      Focus(
        focusNode: _scope,
        onFocusChange: widget.onFocusChanged,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(child: body),
            Padding(
              padding: EdgeInsets.symmetric(
                horizontal: cell.width * 2,
                vertical: cell.height,
              ),
              child: Text(
                [
                  if (hint('picker.accept') case final enter?)
                    '$enter add or save',
                  if (hint('picker.complete') case final tab?) '$tab next',
                  if (hint('picker.cancel') case final escape?) '$escape back',
                ].join('  ·  '),
                style: desktop
                    ? DesktopChrome.metadata()
                    : terminalContentStyle(color: theme.muted),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
