import 'package:flutter/material.dart';

import '../shared/widgets/product_feedback.dart';

typedef UsagePreferenceRequest = Future<Map<String, dynamic>> Function({
  bool? enabled,
});

/// Account-wide privacy control, available without a connected computer.
class PrivacyPage extends StatefulWidget {
  const PrivacyPage({super.key, required this.request, this.feedback});
  final UsagePreferenceRequest request;
  final ProductFeedbackRequest? feedback;

  @override
  State<PrivacyPage> createState() => _PrivacyPageState();
}

class _PrivacyPageState extends State<PrivacyPage> {
  bool? _enabled;
  bool _busy = true, _details = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _read();
  }

  Future<void> _read({bool? enabled}) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final result = await widget.request(enabled: enabled);
      if (!mounted) return;
      if (result['enabled'] is! bool) throw const FormatException();
      setState(() {
        _enabled = result['enabled'] as bool;
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          _error = enabled == null ? 'Couldn’t load this setting. Try again.' : 'Couldn’t confirm the change. Reload to check your saved setting.';
          if (enabled != null) _enabled = null;
        });
      }
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Privacy')),
    body: ListView(
      padding: const EdgeInsets.all(20),
      children: [
        if (_enabled == null)
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Share product usage data'),
            subtitle: Text(
              _busy ? 'Checking your saved preference…' : 'Setting unavailable',
            ),
          )
        else
          SwitchListTile.adaptive(
            contentPadding: EdgeInsets.zero,
            title: const Text('Share product usage data'),
            subtitle: const Text(
              'Help improve Harness by sharing usage counts and duration statistics. '
              'Your prompts, code, files, and conversations are never included.',
            ),
            value: _enabled!,
            onChanged: _busy ? null : (value) => _read(enabled: value),
          ),
        if (_busy) const LinearProgressIndicator(),
        const SizedBox(height: 12),
        const Text(
          'Applies to every computer and app signed in to this account. '
          'Turning this off stops new product usage reports. Essential service and security records are separate.',
        ),
        if (_error != null) ...[
          const SizedBox(height: 12),
          Text(_error!),
          TextButton(
            onPressed: _busy ? null : () => _read(),
            child: const Text('Reload'),
          ),
        ],
        TextButton(
          onPressed: () => setState(() {
            _details = !_details;
          }),
          child: Text(_details ? 'Hide shared fields' : 'See what’s shared'),
        ),
        if (_enabled == true && widget.feedback != null)
          ProductFeedback(send: widget.feedback!),
        if (_details)
          const Text(
            'Shared fields: UTC day, a random retry receipt, protocol and preference revisions; '
            'active/working computer counts, first/repeat work, desktop/terminal opens, '
            'turns started/ended/interrupted (including automation), and duration buckets '
            '(under 10 seconds, 10–60 seconds, 1–5 minutes, over 5 minutes). '
            'Also: request outcomes and fixed failure categories for launch/resume/restart/model changes/history, '
            'response wait buckets, missing responses and error-event counts, and first-launch 24-hour response counts and D1/D7 working-day returns. '
            'Feedback is a fixed answer sent only when you choose one. '
            'Older apps contribute connection, remote-session and turn-start totals separately.\n\n'
            'Sign-in checks your preference. Account, computer and agent identifiers are not stored '
            'with new totals. Queued local counters older than 35 days are discarded when Harness next runs. '
            'Server retry receipts are scheduled to expire after 36 days; combined totals after 13 months. Background cleanup may lag. '
            'Combined totals cannot be removed for one person. '
            'Previously collected activity records expire after 35 days. '
            'A turn ending does not establish task success.',
          ),
      ],
    ),
  );
}
