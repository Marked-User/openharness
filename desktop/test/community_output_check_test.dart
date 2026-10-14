import 'package:flutter_test/flutter_test.dart';
import 'package:harness/community/output_check.dart';

/// The website's own cases (website/src/lib/community/outputCheck.spec.ts), run against the copy.
void main() {
  test('names files and addresses the Hub preview cannot reach', () {
    const html = '''<link rel="stylesheet" href="style.css"><link rel="icon" href="favicon.ico">
      <script type="module" src='./app.js'></script><img src=https://cdn.example/logo.png>
      <style>@import "fonts.css"; body { background: url(bg.png) }</style><a href="other.html">More</a>''';
    expect(outsideResources(html), [
      './app.js',
      'https://cdn.example/logo.png',
      'style.css',
      'bg.png',
      'fonts.css',
    ]);
  });
  test('names the modules and data a page\'s own scripts load', () {
    const html = '''<script type="module">import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
      import { OrbitControls } from "./controls.js"; import 'side-effect.js'; export { x } from "./x.js";
      const lazy = await import("./lazy.js"); fetch('data.json').then(r => r.json());
      const label = "import nothing from here";</script><p>import "prose" is not a script</p>''';
    expect(outsideResources(html), [
      'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js',
      './controls.js',
      'side-effect.js',
      './x.js',
      './lazy.js',
      'data.json',
    ]);
  });
  test('a page that carries everything inside it loads nothing', () {
    expect(
      outsideResources(
        '<style>i{background:url("data:image/png;base64,AA==")}</style><img src="data:image/png;base64,AA=="><script>go()</script><a href="#top">Top</a>',
      ),
      isEmpty,
    );
  });
}
