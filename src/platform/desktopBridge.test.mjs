// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDesktopBridge } from './desktopBridge.js';

/** Minimal fake document that records the one listener the bridge installs. */
function makeFakeDocument() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    dispatch(type, detail) {
      listeners.get(type)?.({ detail });
    },
  };
}

test('initDesktopBridge is a no-op outside Tauri (no window.__TAURI__)', () => {
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  globalThis.window = {};
  globalThis.document = makeFakeDocument();
  try {
    const installed = initDesktopBridge();
    assert.equal(installed, false);
    assert.equal(globalThis.document.listeners.size, 0);
  } finally {
    globalThis.window = priorWindow;
    globalThis.document = priorDocument;
  }
});

test('initDesktopBridge forwards gev:alert to the notify_from_web command', () => {
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  const invokeCalls = [];
  globalThis.window = {
    __TAURI__: {
      core: {
        invoke: (cmd, args) => {
          invokeCalls.push([cmd, args]);
          return Promise.resolve();
        },
      },
    },
  };
  globalThis.document = makeFakeDocument();
  try {
    const installed = initDesktopBridge();
    assert.equal(installed, true);

    globalThis.document.dispatch('gev:alert', { title: 'Runway incursion', body: 'KSFO 28L' });
    assert.equal(invokeCalls.length, 1);
    assert.deepEqual(invokeCalls[0], [
      'notify_from_web',
      { title: 'Runway incursion', body: 'KSFO 28L' },
    ]);
  } finally {
    globalThis.window = priorWindow;
    globalThis.document = priorDocument;
  }
});

test('initDesktopBridge defaults the title and omits an absent body', () => {
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  const invokeCalls = [];
  globalThis.window = {
    __TAURI__: { core: { invoke: (cmd, args) => { invokeCalls.push([cmd, args]); return Promise.resolve(); } } },
  };
  globalThis.document = makeFakeDocument();
  try {
    initDesktopBridge();
    globalThis.document.dispatch('gev:alert', {});
    assert.deepEqual(invokeCalls[0], ["notify_from_web", { title: "God's Eye View", body: undefined }]);
  } finally {
    globalThis.window = priorWindow;
    globalThis.document = priorDocument;
  }
});
