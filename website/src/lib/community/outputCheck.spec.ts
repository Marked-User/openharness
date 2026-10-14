import { describe, expect, it } from 'vitest';
import { outsideResources } from './outputCheck';

describe('output check', () => {
  it('names what an output page loads from elsewhere', () => {
    const html = `<link rel="stylesheet" href="style.css"><link rel="icon" href="favicon.ico">
      <script type="module" src='./app.js'></script><img src=https://cdn.example/logo.png>
      <style>@import "fonts.css"; body { background: url(bg.png) }</style><a href="other.html">More</a>`;
    expect(outsideResources(html)).toEqual(['./app.js', 'https://cdn.example/logo.png', 'style.css', 'bg.png', 'fonts.css']);
  });
  it('names the modules and data a page\'s own scripts load', () => {
    const html = `<script type="module">import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
      import { OrbitControls } from "./controls.js"; import 'side-effect.js'; export { x } from "./x.js";
      const lazy = await import("./lazy.js"); fetch('data.json').then(r => r.json());
      const label = "import nothing from here";</script><p>import "prose" is not a script</p>`;
    expect(outsideResources(html)).toEqual(['https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js', './controls.js', 'side-effect.js', './x.js', './lazy.js', 'data.json']);
  });
  it('accepts a page that carries everything itself', () => {
    expect(outsideResources('<style>i{background:url("data:image/png;base64,AA==")}</style><img src="data:image/png;base64,AA=="><script>go()</script><a href="#top">Top</a>')).toEqual([]);
  });
});
