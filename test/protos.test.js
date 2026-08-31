'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/**
 * Load the proto sets exactly the way main.js does: pass the csgo proto files
 * (in the same order) through helpers/protos.js.
 * @returns {object} the loaded protobufs map keyed by set name
 */
function loadProtos() {
  const Protos = require(path.join(ROOT, 'helpers', 'protos.js'));
  return Protos([{
    name: 'csgo',
    protos: [
      path.join(ROOT, 'protos', 'cstrike15_gcmessages.proto'),
      path.join(ROOT, 'protos', 'gcsdk_gcmessages.proto'),
      path.join(ROOT, 'protos', 'base_gcmessages.proto')
    ]
  }]);
}

test('all message types referenced by main.js load without error', () => {
  const Protos = loadProtos();
  const csgo = Protos.csgo;
  const referenced = [
    'CMsgClientHello',
    'CMsgClientWelcome',
    'CSOEconGameAccountClient',
    'CMsgGCCStrike15_v2_MatchmakingGC2ClientHello',
    'CMsgGCCStrike15_v2_ClientGCRankUpdate',
    'CMsgGCCStrike15_v2_PlayersProfile',
    'CMsgGCCStrike15_v2_ClientRequestPlayersProfile',
    'PlayerRankingInfo'
  ];
  for (const typeName of referenced) {
    assert.ok(csgo[typeName], `expected proto type ${typeName} to be loaded`);
    assert.strictEqual(typeof csgo[typeName].encode, 'function', `${typeName} should be a protobufjs Type`);
  }
});

test('proto field numbers match the values main.js relies on', () => {
  const Protos = loadProtos();
  const csgo = Protos.csgo;

  // CMsgClientHello.version = 1
  assert.strictEqual(csgo.CMsgClientHello.fields.version.id, 1);

  // PlayerRankingInfo.rank_type_id = 6
  assert.strictEqual(csgo.PlayerRankingInfo.fields.rank_type_id.id, 6);

  // The player profile fields live on MatchmakingGC2ClientHello (which is the
  // element type of PlayersProfile.account_profiles):
  // player_level = 17, player_cur_xp = 18, rankings = 20
  const mmHello = csgo.CMsgGCCStrike15_v2_MatchmakingGC2ClientHello;
  assert.strictEqual(mmHello.fields.player_level.id, 17);
  assert.strictEqual(mmHello.fields.player_cur_xp.id, 18);
  assert.strictEqual(mmHello.fields.rankings.id, 20);
});

test('CMsgClientHello round-trips version through encode/decode', () => {
  const Protos = loadProtos();
  const { protoEncode, protoDecode } = require(path.join(ROOT, 'helpers', 'util.js'));

  const encoded = protoEncode(Protos.csgo.CMsgClientHello, { version: 2000244 });
  assert.ok(Buffer.isBuffer(encoded) || encoded instanceof Uint8Array);
  assert.ok(encoded.length > 0, 'encoded hello should not be empty');

  const decoded = protoDecode(Protos.csgo.CMsgClientHello, encoded);
  assert.strictEqual(Number(decoded.version), 2000244);
});

test('protoDecode handles an empty buffer without throwing', () => {
  const Protos = loadProtos();
  const { protoDecode } = require(path.join(ROOT, 'helpers', 'util.js'));

  // An empty buffer is a *valid* protobuf encoding of a message with every
  // field left at its default, so protobufjs returns the defaults object
  // rather than an error. The defensive guarantee we care about is that this
  // never throws and always yields a plain object.
  let result;
  assert.doesNotThrow(() => {
    result = protoDecode(Protos.csgo.CMsgClientWelcome, Buffer.alloc(0));
  });
  assert.strictEqual(typeof result, 'object');
  assert.notStrictEqual(result, null);
  // No message content: version defaults to 0 and no caches are present.
  assert.strictEqual(Number(result.version), 0);
});

test('protoDecode returns {} for a non-buffer / invalid input without throwing', () => {
  const Protos = loadProtos();
  const { protoDecode } = require(path.join(ROOT, 'helpers', 'util.js'));

  let a, b;
  assert.doesNotThrow(() => {
    a = protoDecode(Protos.csgo.CMsgClientWelcome, undefined);
    b = protoDecode(undefined, Buffer.alloc(0));
  });
  assert.deepStrictEqual(a, {});
  assert.deepStrictEqual(b, {});
});

test('protoDecode returns {} for a malformed buffer without throwing', () => {
  const Protos = loadProtos();
  const { protoDecode } = require(path.join(ROOT, 'helpers', 'util.js'));

  // Random bytes that are not a valid encoding for this message.
  const malformed = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x0a, 0x7f, 0x42]);
  let result;
  assert.doesNotThrow(() => {
    result = protoDecode(Protos.csgo.CMsgGCCStrike15_v2_PlayersProfile, malformed);
  });
  assert.deepStrictEqual(result, {});
});

test('protoEncode returns an empty Buffer for bad/undefined input without throwing', () => {
  const Protos = loadProtos();
  const { protoEncode } = require(path.join(ROOT, 'helpers', 'util.js'));

  let a, b, c;
  assert.doesNotThrow(() => {
    a = protoEncode(Protos.csgo.CMsgClientHello, undefined);
    b = protoEncode(undefined, { version: 1 });
    c = protoEncode(null, null);
  });
  for (const out of [a, b, c]) {
    assert.ok(Buffer.isBuffer(out), 'expected a Buffer');
    assert.strictEqual(out.length, 0, 'expected an empty Buffer');
  }
});
