import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processJsonLines } from '../src/backends/parse-helpers.js';

describe('processJsonLines', () => {
  it('parses a simple NDJSON stream', () => {
    const events = [];
    processJsonLines('{"type":"a"}\n{"type":"b"}\n', e => events.push(e));
    assert.deepEqual(events.map(e => e.type), ['a', 'b']);
  });

  it('splits bursts where multiple JSON objects share a line', () => {
    const events = [];
    processJsonLines('{"type":"a"}{"type":"b"}{"type":"c"}', e => events.push(e));
    assert.deepEqual(events.map(e => e.type), ['a', 'b', 'c']);
  });

  it('reassembles PTY-wrapped JSON objects (continuation lines)', () => {
    // Simulate a PTY wrapping a long text event at column 60.
    const wrapped = [
      '{"type":"text","part":{"text":"this line is longer than th',
      'e terminal width and got wrapped mid-string by the pty"}}',
    ].join('\n');
    const events = [];
    processJsonLines(wrapped, e => events.push(e));
    assert.equal(events.length, 1);
    assert.equal(
      events[0].part.text,
      'this line is longer than the terminal width and got wrapped mid-string by the pty',
    );
  });

  it('ignores log noise that is neither JSON nor a continuation', () => {
    const stream = [
      '[info] starting',
      '{"type":"a"}',
      '[warn] something',
      '{"type":"b"}',
    ].join('\n');
    const events = [];
    processJsonLines(stream, e => events.push(e));
    assert.deepEqual(events.map(e => e.type), ['a', 'b']);
  });
});
