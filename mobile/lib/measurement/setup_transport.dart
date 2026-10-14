import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../core/test_run.dart';

/// Separate from every authenticated API client: no auth interceptor, cookie jar or device headers.
/// Web pre-sign-in collection remains disabled until its transport can guarantee omitted cookies.
Future<Map<String, dynamic>> sendSetupMeasurement(
  String base,
  Map<String, dynamic> report,
) async {
  if (kIsWeb) throw StateError('Signed-out web measurement is unavailable');
  final uri = Uri.parse(base);
  if (kUnderTest &&
      !(const ['127.0.0.1', 'localhost', '::1'].contains(uri.host) &&
          uri.hasPort)) {
    throw StateError('Tests require an isolated measurement server');
  }
  final dio = Dio(
    BaseOptions(
      baseUrl: base,
      connectTimeout: const Duration(seconds: 5),
      receiveTimeout: const Duration(seconds: 5),
      sendTimeout: const Duration(seconds: 5),
    ),
  );
  try {
    final response = await dio.post('/api/product-usage/setup', data: report);
    final body = response.data;
    if (body is! Map || body['data'] is! Map) return {};
    return Map<String, dynamic>.from(body['data'] as Map);
  } finally {
    dio.close(force: true);
  }
}
