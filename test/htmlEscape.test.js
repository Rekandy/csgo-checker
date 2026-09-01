'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { escapeHtml } = require('../helpers/htmlEscape');

test('escapes the ampersand', () => {
    assert.strictEqual(escapeHtml('a & b'), 'a &amp; b');
});

test('escapes angle brackets', () => {
    assert.strictEqual(escapeHtml('<script>'), '&lt;script&gt;');
});

test('escapes the double quote', () => {
    assert.strictEqual(escapeHtml('say "hi"'), 'say &quot;hi&quot;');
});

test('escapes the single quote', () => {
    assert.strictEqual(escapeHtml("it's"), 'it&#39;s');
});

test('maps null to an empty string', () => {
    assert.strictEqual(escapeHtml(null), '');
});

test('maps undefined to an empty string', () => {
    assert.strictEqual(escapeHtml(undefined), '');
});

test('leaves benign map names unchanged', () => {
    // Legitimate GCPD data has no HTML metacharacters, so escaping is a no-op
    // and the maps modal renders identically to before.
    assert.strictEqual(escapeHtml('Dust II'), 'Dust II');
    assert.strictEqual(escapeHtml('Mirage'), 'Mirage');
    assert.strictEqual(escapeHtml('Silver Elite'), 'Silver Elite');
    assert.strictEqual(escapeHtml('Silver I'), 'Silver I');
});

test('coerces numeric values to their string form', () => {
    assert.strictEqual(escapeHtml(0), '0');
    assert.strictEqual(escapeHtml(42), '42');
});

test('neutralizes the attribute-breakout payload (C-1 exploit)', () => {
    // The exact ambient exploit: a value that, if interpolated raw into
    // alt="..."/title="...", would close the attribute and inject an onerror
    // event handler = executable DOM-XSS. After escaping, no raw double-quote
    // may survive, so the attribute cannot be broken out of.
    const payload = 'x" onerror="alert(1)';
    const escaped = escapeHtml(payload);
    assert.ok(!escaped.includes('"'), 'no raw double-quote may survive');
    assert.match(escaped, /&quot;/);
    assert.strictEqual(escaped, 'x&quot; onerror=&quot;alert(1)');
});

test('neutralizes a raw <img onerror> injection into a text node', () => {
    const escaped = escapeHtml('<img src=x onerror=alert(1)>');
    assert.ok(!/<img\b/i.test(escaped), 'raw <img> tag must not survive');
    assert.match(escaped, /&lt;img/);
});
