import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectKeyUpdates,
  formatAiStatusLine,
  keySetupChipLabel,
  stripKeylessBasemapFromHash,
} from './keySetup.js';

test('the chip counts what is missing, and retires the count at zero', () => {
  assert.equal(keySetupChipLabel({ setCount: 0, total: 8 }), 'POWER UP · 8 KEYS WAITING');
  assert.equal(keySetupChipLabel({ setCount: 7, total: 8 }), 'POWER UP · 1 KEY WAITING');
  assert.equal(keySetupChipLabel({ setCount: 8, total: 8 }), 'POWERED UP');
  assert.equal(keySetupChipLabel(null), 'POWERED UP', 'no status is not a broken label');
});

test('collectKeyUpdates keeps only non-empty trimmed values', () => {
  const updates = collectKeyUpdates([
    { envVar: 'OPENAI_API_KEY', value: '  sk-abc  ' },
    { envVar: 'FIRMS_MAP_KEY', value: '' },
    { envVar: 'TOMTOM_API_KEY', value: '   ' },
    { envVar: '', value: 'orphan' },
    null,
  ]);
  assert.deepEqual(updates, { OPENAI_API_KEY: 'sk-abc' });
  assert.deepEqual(collectKeyUpdates([]), {});
  assert.deepEqual(collectKeyUpdates(null), {});
});

test('the first Google key strips ONLY the keyless OSM basemap from the share hash', () => {
  const stripped = stripKeylessBasemapFromHash('lat=30.2&lon=-97.7&map=osm&style=normal');
  assert.ok(stripped !== null);
  const params = new URLSearchParams(stripped);
  assert.equal(params.get('map'), null, 'osm basemap removed');
  assert.equal(params.get('lat'), '30.2', 'camera survives');
  assert.equal(params.get('style'), 'normal', 'style survives');
  // A stack under any other name was chosen or shared on purpose.
  assert.equal(stripKeylessBasemapFromHash('map=bing-aerial&lat=1'), null);
  assert.equal(stripKeylessBasemapFromHash('lat=1&lon=2'), null, 'no stack, nothing to do');
  assert.equal(stripKeylessBasemapFromHash(''), null);
  assert.equal(stripKeylessBasemapFromHash(undefined), null);
});

test('formatAiStatusLine renders provider, model, host, and health — or nothing without a status', () => {
  assert.equal(formatAiStatusLine(null), '');
  assert.equal(formatAiStatusLine(undefined), '');
  assert.equal(
    formatAiStatusLine({ provider: 'local', model: 'mlx-community/Qwen3-30B-A3B-4bit', baseUrlHost: 'oasiss-mac-studio:4000', healthy: true }),
    'Active: LOCAL · mlx-community/Qwen3-30B-A3B-4bit · oasiss-mac-studio:4000 · healthy'
  );
  assert.equal(
    formatAiStatusLine({ provider: 'openai', model: 'gpt-5-nano', baseUrlHost: 'api.openai.com', healthy: false }),
    'Active: OPENAI · gpt-5-nano · api.openai.com · unreachable'
  );
  assert.equal(formatAiStatusLine({ provider: 'none', model: null, baseUrlHost: null, healthy: false }), 'Active: NONE');
});
