'use strict';

// Pure HTML-escaping helper for the renderer.
//
// SECURITY NOTE: Some values rendered by the renderer (html/js/front.js) come
// from external, MITM-able Steam GCPD HTML parsed by regex in
// helpers/gcpd_parser.js (competitive map name + skill_group). The parser's
// `[^<]` character classes block a literal `<` (so a raw `<script>` tag cannot
// reach a text node) but do NOT block the double-quote `"` or spaces. A crafted
// value such as `x" onerror="alert(1)` therefore breaks out of an
// `alt="..."` / `title="..."` attribute and injects an event-handler attribute
// = executable DOM-XSS when interpolated into `innerHTML`. This helper
// neutralizes that attribute-breakout by escaping the five HTML-significant
// characters (& < > " ') into their entities. It is the single source of truth
// for renderer-side escaping; preload.js exposes it via contextBridge as
// `window.htmlEscape.escape` so there is exactly one implementation to test.
//
// It is a no-op for legitimate values (map names like 'Dust II', skill groups
// like 'Silver Elite') which contain none of these characters, so rendered
// output for normal Steam data is byte-identical to before.

const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape HTML-significant characters in an arbitrary value.
 * @param {*} value value to escape (coerced to string); null/undefined -> ''
 * @returns {string} the escaped string, safe for both HTML text nodes and
 *   double- or single-quoted attribute values
 */
function escapeHtml(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char]);
}

module.exports = { escapeHtml };
