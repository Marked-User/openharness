import 'package:flutter/material.dart';

import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/product_feedback.dart';
import '../widgets/desktop_chrome.dart';

Future<void> showTaskFeedback(
  BuildContext context, {
  required Future<Map<String, dynamic>> Function() choice,
  required ProductFeedbackRequest send,
}) async {
  final permitted = choice();
  await showAppDialog<void>(
    context: context,
    builder: (context) => Dialog(
      backgroundColor: Colors.transparent,
      constraints: const BoxConstraints(maxWidth: 520),
      child: DesktopDialogSurface(
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              DesktopDialogHeader(
                title: 'Rate task outcome',
                onClose: () => Navigator.of(context).pop(),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
                child: FutureBuilder(
                  future: permitted,
                  builder: (context, snapshot) =>
                      snapshot.connectionState != ConnectionState.done
                      ? const Text('Checking your sharing preference…')
                      : snapshot.hasError
                      ? const Text(
                          'Couldn’t check your sharing preference. Try again.',
                        )
                      : snapshot.data?['enabled'] != true
                      ? const Text(
                          'Product usage sharing is off. You can change it in Settings → Privacy.',
                        )
                      : Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            ProductFeedback(
                              key: const ValueKey('outcome'),
                              send: send,
                              outcome: true,
                            ),
                            ProductFeedback(
                              key: const ValueKey('reason'),
                              send: send,
                            ),
                          ],
                        ),
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}
