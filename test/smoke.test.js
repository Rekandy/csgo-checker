'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('helpers/util.js exports the expected functions', () => {
  const util = require(path.join(ROOT, 'helpers', 'util.js'));
  assert.strictEqual(typeof util.protoEncode, 'function');
  assert.strictEqual(typeof util.protoDecode, 'function');
  assert.strictEqual(typeof util.penalty_reason_string, 'function');
  assert.strictEqual(typeof util.penalty_reason_permanent, 'function');
});

test('helpers/protos.js exports the Protos loader function', () => {
  const Protos = require(path.join(ROOT, 'helpers', 'protos.js'));
  assert.strictEqual(typeof Protos, 'function');
});

test('helpers/gcpd_parser.js exports the expected parser functions', () => {
  const gcpd = require(path.join(ROOT, 'helpers', 'gcpd_parser.js'));
  assert.strictEqual(typeof gcpd.parseMatchmaking, 'function');
  assert.strictEqual(typeof gcpd.parseAccountMain, 'function');
  assert.strictEqual(typeof gcpd.looksLikeGcpdPage, 'function');
  assert.strictEqual(typeof gcpd.looksLikeLoginPage, 'function');
});
