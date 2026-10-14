import 'dart:async';

import 'package:flutter/material.dart';

import 'product_measurement.dart';

/// Visible before any optional signed-out report. It never blocks setup or sign-in.
class SetupUsageChoice extends StatelessWidget {
  const SetupUsageChoice({super.key, required this.measurement});
  final ProductMeasurement measurement;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: measurement,
    builder: (context, _) => Material(
      color: Theme.of(context).colorScheme.surface,
      child: CheckboxListTile(
        dense: true,
        controlAffinity: ListTileControlAffinity.leading,
        value: measurement.signedOutSharing,
        onChanged: measurement.choiceLoaded
            ? (value) =>
                  unawaited(measurement.setSignedOutSharing(value == true))
            : null,
        title: const Text('Share setup and sign-in counts'),
        subtitle: const Text(
          'Optional for this app session. Help us find setup problems without sharing account details, prompts, or files.',
        ),
      ),
    ),
  );
}
