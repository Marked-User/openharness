/// Files and addresses an output page loads that the Hub's preview cannot reach.
///
/// ⚠️ Mirrored, not shared: `website/src/lib/community/outputCheck.ts` is the Hub's own check, and
/// `test/community_output_check_test.dart` runs the website's cases against this copy.
library;

/// Addresses the page loads for itself that the Hub's sandbox serves: none, apart from these.
final _inline = RegExp(
  r'^(?:data:|blob:|#|about:|javascript:)',
  caseSensitive: false,
);
final _sourced = RegExp(
  r'<(?:script|img|iframe|source|video|audio|embed|track)\b[^>]*>',
  caseSensitive: false,
);
final _link = RegExp(r'<link\b[^>]*>', caseSensitive: false);
final _loadedLink = RegExp(
  r'''\brel\s*=\s*["']?(?:stylesheet|preload|modulepreload)\b''',
  caseSensitive: false,
);
final _cssUrl = RegExp(
  r'''url\(\s*["']?([^"')]+)["']?\s*\)''',
  caseSensitive: false,
);
final _cssImport = RegExp(
  r'''@import\s+["']([^"']+)["']''',
  caseSensitive: false,
);

/// What a page's own scripts load: modules (`import … from "…"`, `import "…"`, `export … from "…"`,
/// `import("…")`) and `fetch("…")`. A module from a CDN is the usual way a one-file page still needs
/// the network (three.js from jsdelivr), and the sandbox blocks it.
final _scriptBody = RegExp(
  r'<script\b[^>]*>([\s\S]*?)</script>',
  caseSensitive: false,
);
final _scriptLoads = [
  RegExp(
    r'''\b(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?["']([^"'\n]+)["']''',
  ),
  RegExp(r'''\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)'''),
  RegExp(r'''\bfetch\s*\(\s*["'`]([^"'`\n]+)["'`]'''),
];

String? _attribute(String tag, String name) {
  final match = RegExp(
    '\\s$name\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))',
    caseSensitive: false,
  ).firstMatch(tag);
  if (match == null) return null;
  return (match.group(1) ?? match.group(2) ?? match.group(3))?.trim();
}

/// What [html] loads from elsewhere: the sandbox serves no other file and blocks the network, so
/// each one is missing for readers. Empty means the page runs on its own.
List<String> outsideResources(String html) {
  final found = <String>{};
  void add(String? value) {
    if (value == null || value.isEmpty || _inline.hasMatch(value)) return;
    found.add(value);
  }

  for (final tag in _sourced.allMatches(html)) {
    add(_attribute(tag[0]!, 'src'));
  }
  for (final tag in _link.allMatches(html)) {
    if (_loadedLink.hasMatch(tag[0]!)) add(_attribute(tag[0]!, 'href'));
  }
  for (final match in _cssUrl.allMatches(html)) {
    add(match[1]!.trim());
  }
  for (final match in _cssImport.allMatches(html)) {
    add(match[1]);
  }
  for (final script in _scriptBody.allMatches(html)) {
    for (final pattern in _scriptLoads) {
      for (final match in pattern.allMatches(script[1]!)) {
        add(match[1]!.trim());
      }
    }
  }
  return found.toList();
}
