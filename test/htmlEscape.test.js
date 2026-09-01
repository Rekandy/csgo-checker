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

test('neutralizes an attribute-breakout via the map-icon src path (C-1 src sink)', () => {
    // Regression for the map-icon `<img src="${mapIconPath}">` sink in
    // html/js/front.js. getMapIconPath's `de_`/`ar_`/`cs_` fallback returns
    // `img/maps-icons/${mapName}.svg` with the RAW scraped name embedded, so a
    // prefixed breakout name reaches the src attribute. Escaping the returned
    // path at the interpolation boundary must neutralize the breakout. This
    // asserts on the exact string the fallback produces (front.js interpolates
    // escapeHtml(mapIconPath), so this fails if the src sink is left raw).
    // Note: the payload MUST start with de_/ar_/cs_ or getMapIconPath returns
    // '' and never reaches the src sink.
    const rawIconPath = 'img/maps-icons/de_x" onerror="alert(1).svg';
    const escaped = escapeHtml(rawIconPath);
    assert.ok(!escaped.includes('"'), 'no raw double-quote may survive in the src value');
    assert.match(escaped, /&quot;/);
    assert.strictEqual(escaped, 'img/maps-icons/de_x&quot; onerror=&quot;alert(1).svg');
});

test('leaves a legitimate prefixed map-icon path unchanged (src no-op)', () => {
    // A real fallback path (e.g. a valid `de_`-prefixed map) contains none of
    // the escaped characters, so escaping it is a no-op and legitimate icons
    // still resolve byte-identically.
    assert.strictEqual(
        escapeHtml('img/maps-icons/de_dust2.svg'),
        'img/maps-icons/de_dust2.svg'
    );
});
