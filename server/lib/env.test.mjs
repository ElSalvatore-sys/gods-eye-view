import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonEnv, parseCsvOrJsonEnv } from './env.js';

const ENV_KEY = 'GEV_LIB_ENV_TEST_VALUE';

test('parseJsonEnv falls back when the env var is unset', () => {
  delete process.env[ENV_KEY];
  assert.deepEqual(parseJsonEnv(ENV_KEY, { fallback: true }), { fallback: true });
});

test('parseJsonEnv parses valid JSON', () => {
  process.env[ENV_KEY] = '{"a":1}';
  try {
    assert.deepEqual(parseJsonEnv(ENV_KEY, null), { a: 1 });
  } finally {
    delete process.env[ENV_KEY];
  }
});

test('parseJsonEnv falls back (and does not throw) on invalid JSON', () => {
  process.env[ENV_KEY] = '{not json';
  try {
    assert.deepEqual(parseJsonEnv(ENV_KEY, ['fallback']), ['fallback']);
  } finally {
    delete process.env[ENV_KEY];
  }
});

test('parseCsvOrJsonEnv falls back when the env var is unset', () => {
  delete process.env[ENV_KEY];
  assert.deepEqual(parseCsvOrJsonEnv(ENV_KEY, ['default']), ['default']);
});

test('parseCsvOrJsonEnv parses a JSON array', () => {
  process.env[ENV_KEY] = '["a","b"]';
  try {
    assert.deepEqual(parseCsvOrJsonEnv(ENV_KEY, []), ['a', 'b']);
  } finally {
    delete process.env[ENV_KEY];
  }
});

test('parseCsvOrJsonEnv falls back when JSON parses to a non-array', () => {
  process.env[ENV_KEY] = '{"a":1}';
  try {
    assert.deepEqual(parseCsvOrJsonEnv(ENV_KEY, ['default']), ['default']);
  } finally {
    delete process.env[ENV_KEY];
  }
});

test('parseCsvOrJsonEnv splits a plain comma-separated value, trimming and dropping empties', () => {
  process.env[ENV_KEY] = ' a, b ,,c';
  try {
    assert.deepEqual(parseCsvOrJsonEnv(ENV_KEY, []), ['a', 'b', 'c']);
  } finally {
    delete process.env[ENV_KEY];
  }
});
