import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/measurement/setup_transport.dart';

void main() {
  test('signed-out transport uses only a loopback fixture and sends no credentials', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final received = server.first.then((request) async {
      expect(request.uri.path, '/api/product-usage/setup');
      for (final header in [
        'authorization',
        'cookie',
        'x-device-id',
        'x-account-id',
      ]) {
        expect(request.headers.value(header), isNull);
      }
      final body = jsonDecode(await utf8.decoder.bind(request).join());
      expect(body, {
        'schemaVersion': 1,
        'consent': true,
        'counters': {'setup_desktop_sign_in_started': 1},
      });
      request.response.headers.contentType = ContentType.json;
      request.response.write(
        jsonEncode({
          'success': true,
          'data': {'accepted': true},
        }),
      );
      await request.response.close();
    });
    try {
      expect(
        await sendSetupMeasurement('http://127.0.0.1:${server.port}', {
          'schemaVersion': 1,
          'consent': true,
          'counters': {'setup_desktop_sign_in_started': 1},
        }),
        {'accepted': true},
      );
      await received;
      await expectLater(
        sendSetupMeasurement('https://not-a-fixture.invalid', {}),
        throwsStateError,
      );
    } finally {
      await server.close(force: true);
    }
  });
}
