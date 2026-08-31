'use strict';

// Markdown -> HTML renderer for the changelog modal.
//
// SECURITY NOTE: markdown-it is configured with `html: false`, so any raw
// HTML in the source markdown (e.g. `<script>`, `<img onerror=...>`) is
// escaped instead of being passed through. This makes the rendered output
// safe to assign to `innerHTML` in the renderer (html/js/front.js). `linkify`
// autolinks bare URLs; `typographer` is left off to keep output byte-stable
// with the plain markdown source. This replaces the previous `showdown`
// dependency, which carried unpatched XSS/ReDoS advisories.
const md = require('markdown-it')({
  html: false,
  linkify: true,
  typographer: false,
});

/**
 * Render a markdown string to sanitized HTML.
 * @param {string} markdown markdown source
 * @returns {string} rendered HTML with raw HTML escaped
 */
function renderMarkdown(markdown) {
  return md.render(markdown);
}

module.exports = { renderMarkdown };
