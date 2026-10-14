import 'package:flutter/material.dart';

import '../../shared/widgets/section_scaffold.dart';
import '../../shared/widgets/setting_row.dart';
import '../../shared/widgets/product_feedback.dart';
import '../../state/app_state.dart';
import '../../measurement/setup_usage_choice.dart';
import '../../measurement/task_feedback.dart';
import '../../measurement/product_measurement.dart';

typedef UsagePreferenceRequest = Future<Map<String, dynamic>> Function({
  bool? enabled,
});

class PrivacySection extends StatelessWidget {
  const PrivacySection({super.key, required this.notifier});
  final AppNotifier notifier;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: notifier,
    builder: (context, _) => SectionScaffold(
      title: 'Privacy',
      subtitle: 'Choose what you share to help improve Harness.',
      child: notifier.isGuest
          ? notifier.productMeasurement.surface == 'web'
                ? const Text(
                    'Product usage sharing is available after sign-in.',
                  )
                : SetupUsageChoice(measurement: notifier.productMeasurement)
          : ProductUsagePreference(
              key: ObjectKey(notifier.api),
              request: ({bool? enabled}) async {
                final value = await notifier.api.productUsageSettings(
                  enabled: enabled,
                );
                notifier.productMeasurement.savedChoice(value);
                return value;
              },
              feedback: notifier.api.productUsageFeedback,
              measurement: notifier.productMeasurement,
            ),
    ),
  );
}

/// This switch shows the server's saved answer, never an optimistic default.
class ProductUsagePreference extends StatefulWidget {
  const ProductUsagePreference({
    super.key,
    required this.request,
    this.feedback,
    this.measurement,
  });
  final UsagePreferenceRequest request;
  final ProductFeedbackRequest? feedback;
  final ProductMeasurement? measurement;

  @override
  State<ProductUsagePreference> createState() => _ProductUsagePreferenceState();
}

class _ProductUsagePreferenceState extends State<ProductUsagePreference> {
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
          _error = enabled == null
              ? 'Couldn’t load this setting. Update Harness or try again.'
              : 'Couldn’t confirm the change. Reload to check your saved setting.';
          // An ambiguous write must not leave a switch claiming the old value is still saved.
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
  Widget build(BuildContext context) => SingleChildScrollView(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SettingRow(
          title: 'Share product usage data',
          detail:
              'Help improve Harness by sharing usage counts and duration statistics. '
              'Your prompts, code, files, and conversations are never included.',
          controlSemanticLabel: 'Share product usage data',
          control: _enabled == null
              ? _busy
                    ? const SizedBox.square(
                        dimension: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('Unavailable')
              : Switch(
                  value: _enabled!,
                  onChanged: _busy ? null : (value) => _read(enabled: value),
                ),
          footer: const Text(
            'Applies to every computer and app signed in to this account. '
            'Turning this off stops new product usage reports. Essential service and security records are separate.',
          ),
        ),
        if (_error != null) ...[
          const SizedBox(height: 12),
          Text(_error!),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: _busy ? null : () => _read(),
              child: const Text('Reload'),
            ),
          ),
        ],
        const SizedBox(height: 8),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton(
            onPressed: () => setState(() {
              _details = !_details;
            }),
            child: Text(_details ? 'Hide shared fields' : 'See what’s shared'),
          ),
        ),
        if (_details) ...[
          const SizedBox(height: 8),
          const SelectableText(
            'Shared fields\n'
            '• UTC day and a random report receipt to prevent duplicate counts\n'
            '• Active and working computer counts; first and repeat work\n'
            '• Desktop and terminal app opens\n'
            '• The days you used Harness, which apps you used, whether an agent worked and your sign-up day, under a coded ID instead of your account; kept 10 days, then only as combined totals\n'
            '• Agent turns started, ended, or interrupted (including automated work)\n'
            '• Turn durations: under 10 seconds, 10–60 seconds, 1–5 minutes, or over 5 minutes\n'
            '• Launch, resume, restart, model change and history request outcomes, fixed failure categories and wait buckets\n'
            '• First response waits, missing responses and error-event counts; first-launch 24-hour response counts and D1/D7/D28 working-day returns\n'
            '• A fixed feedback answer only when you choose to send one\n'
            '• Protocol version and the revision of your sharing preference\n\n'
            'Desktop and CLI also share separate release and operating-system totals; '
            'fixed startup, viewer-load, update-apply, reconnect and resume-to-work outcomes; '
            'coarse memory, CPU and frame-time buckets; and counts of errors and interrupted app runs. '
            'No error text, stack trace, device specification or browsing address is sent. '
            'Local day flags measure explicit composer work and weekly use; they are never uploaded. '
            'The last app run keeps only local restart/update control flags, removed when sharing is off. '
            'Feedback views, answers and dismissals are counted without linking them to a task.\n\n'
            'Older apps contribute connection, remote-session, and turn-start totals. '
            'These event counts are separate from active computer counts.\n\n'
            'Sign-in checks your preference. Account, computer, and agent identifiers are not stored '
            'with the combined totals. The 10-day daily records use a coded ID instead of your account '
            'and are deleted when you turn sharing off. Queued local counters older than 35 days are discarded when Harness next runs. '
            'Server retry receipts are scheduled to expire after 36 days; combined totals after 13 months. Background cleanup may lag. '
            'Combined totals cannot be removed for one person. Apart from those 10-day records, reports create no per-person history. '
            'Previously collected activity records expire after 35 days. '
            'Fixed setup, sign-in, connection, viewer and update-stage outcomes; first and repeat feature use; weekly and monthly returns. '
            'Optional task feedback sends only your selected outcome or reason. '
            'A turn ending does not tell us whether your task succeeded.',
          ),
        ],
        if (_enabled == true && widget.feedback != null) ...[
          TextButton(
            onPressed: () => showTaskFeedback(
              context,
              choice: widget.request,
              send: widget.feedback!,
              measurement: widget.measurement,
            ),
            child: const Text('Rate task outcome'),
          ),
          ProductFeedback(
            send: widget.feedback!,
            onShown: widget.measurement?.observer(
              ProductHealthMeasure.feedbackReasonShown,
            ),
            onAnswered: widget.measurement?.observer(
              ProductHealthMeasure.feedbackReasonAnswered,
            ),
            onDismissed: widget.measurement?.observer(
              ProductHealthMeasure.feedbackReasonDismissed,
            ),
          ),
        ],
      ],
    ),
  );
}
