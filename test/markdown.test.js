'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { renderMarkdown } = require('../helpers/markdown');

test('renders a level-1 heading as <h1>', () => {
    const html = renderMarkdown('# Heading');
    assert.match(html, /<h1>Heading<\/h1>/);
});

test('renders a bullet list item as <li>', () => {
    const html = renderMarkdown('- item');
    assert.match(html, /<ul>/);
    assert.match(html, /<li>item<\/li>/);
});

test('renders **bold** as <strong>', () => {
    const html = renderMarkdown('**bold**');
    assert.match(html, /<strong>bold<\/strong>/);
});

test('renders a markdown link as an <a href>', () => {
    const html = renderMarkdown('[text](http://x)');
    assert.match(html, /<a href="http:\/\/x">text<\/a>/);
});

test('escapes a raw <script> tag instead of emitting an executable tag', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    // The literal tag must NOT survive as an executable element.
    assert.ok(!/<script>/.test(html), 'raw <script> tag must not be emitted');
    // It should be HTML-escaped instead.
    assert.match(html, /&lt;script&gt;/);
});

test('escapes a raw <img onerror> injection instead of emitting an executable tag', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>');
    assert.ok(!/<img\b/i.test(html), 'raw <img> tag must not be emitted');
    assert.match(html, /&lt;img/);
});

test('linkifies a bare URL into an <a href>', () => {
    const html = renderMarkdown('see http://example.com for details');
    assert.match(html, /<a href="http:\/\/example\.com">/);
});
