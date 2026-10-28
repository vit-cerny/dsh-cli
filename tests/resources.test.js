import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';

import {
  ResourceSampler,
  formatBytes,
  sampleRss,
  sampleRuntimeRss,
} from '../src/session/resources.js';

/** A `tasklist /FO CSV /NH` row; the memory cell holds a thousands separator. */
const TASKLIST_ROW = '"node.exe","4242","Console","1","123,456 K"';

/**
 * A runner double that records calls and replays a fixed answer, so no test
 * ever spawns a child process.
 *
 * @param {string|Error} answer Stdout text, or an error to throw.
 * @returns {{ calls: object[], run: Function }} The double and its call log.
 */
function fakeRunner(answer) {
  const calls = [];
  return {
    calls,
    run(file, args, options) {
      calls.push({ file, args, options });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

/**
 * A timer double that records schedules instead of running them.
 *
 * @returns {{ timers: object[], setInterval: Function, clearInterval: Function }} The double.
 */
function fakeTimers() {
  const timers = [];
  return {
    timers,
    setInterval(fn, ms) {
      const timer = { fn, ms, cleared: false, unrefCalled: false, unref() { this.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
    clearInterval(timer) {
      timer.cleared = true;
    },
  };
}

test('formatBytes reports binary units and trims a zero fraction', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1024), '1 KiB');
  assert.equal(formatBytes(84.2 * 1024 * 1024), '84.2 MiB');
  assert.equal(formatBytes(1.5 * 1024 ** 3), '1.5 GiB');
  assert.equal(formatBytes(-5), '0 B');
  assert.equal(formatBytes(null), '0 B');
  assert.equal(formatBytes('nonsense'), '0 B');
});

test('sampleRss reports this process and honours an injected clock', () => {
  const sample = sampleRss({ now: () => 1234 });
  assert.equal(sample.at, 1234);
  assert.ok(sample.rssBytes > 0);
  assert.ok(sample.heapUsedBytes > 0);
  assert.ok(sample.externalBytes >= 0);
});

test('the windows probe parses the tasklist CSV row', () => {
  const runner = fakeRunner(`${TASKLIST_ROW}\r\n`);
  const bytes = sampleRuntimeRss(4242, { platform: 'win32', run: runner.run });

  assert.equal(bytes, 123456 * 1024);
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].file, 'tasklist');
  assert.deepEqual(runner.calls[0].args, ['/FI', 'PID eq 4242', '/FO', 'CSV', '/NH']);
  assert.ok(runner.calls[0].options.timeoutMs > 0, 'the probe is bounded');
  assert.ok(runner.calls[0].options.timeoutMs <= 5000);
});

test('the posix probe parses the ps row', () => {
  const runner = fakeRunner('  98765\n');
  assert.equal(sampleRuntimeRss(4242, { platform: 'darwin', run: runner.run }), 98765 * 1024);
  assert.equal(runner.calls[0].file, 'ps');
  assert.deepEqual(runner.calls[0].args, ['-o', 'rss=', '-p', '4242']);
});

test('a failing or empty probe degrades to null instead of throwing', () => {
  assert.equal(sampleRuntimeRss(4242, { platform: 'win32', run: fakeRunner(new Error('EPERM')).run }), null);
  assert.equal(sampleRuntimeRss(4242, { platform: 'linux', run: fakeRunner('').run }), null);
  assert.equal(sampleRuntimeRss(4242, { platform: 'win32', run: fakeRunner('INFO: no tasks\n').run }), null);
  assert.equal(
    sampleRuntimeRss(4242, { platform: 'win32', run: fakeRunner('"other.exe","7","Console","1","9,000 K"\n').run }),
    null,
    'a row for another pid is not this process',
  );
  assert.equal(sampleRuntimeRss(0, { run: fakeRunner(TASKLIST_ROW).run }), null);
  assert.equal(sampleRuntimeRss(-1, { run: fakeRunner(TASKLIST_ROW).run }), null);
  assert.equal(sampleRuntimeRss(Number.NaN, { run: fakeRunner(TASKLIST_ROW).run }), null);
});

test('the sampler defaults to a two-second interval', () => {
  const timers = fakeTimers();
  const sampler = new ResourceSampler({
    timers,
    rss: () => ({ rssBytes: 1, heapUsedBytes: 0, externalBytes: 0, at: 0 }),
  });

  assert.equal(timers.timers.length, 0, 'construction never starts a timer');
  sampler.start();
  assert.equal(timers.timers.length, 1);
  assert.equal(timers.timers[0].ms, 2000);
});

test('sampling honours the injected clock and joins client with runtime RSS', () => {
  const timers = fakeTimers();
  let now = 500;
  let probes = 0;
  const sampler = new ResourceSampler({
    intervalMs: 2500,
    runtimePid: 4242,
    now: () => now,
    rss: () => ({ rssBytes: 1000, heapUsedBytes: 400, externalBytes: 50, at: now }),
    sampleRuntime: (pid) => {
      probes += 1;
      return pid === 4242 ? 2000 : null;
    },
    timers,
  });

  sampler.start();
  assert.equal(timers.timers[0].ms, 2500, 'the configured interval is scheduled');
  assert.equal(timers.timers[0].unrefCalled, true, 'the timer never holds the process open');
  assert.deepEqual(sampler.snapshot, { clientRss: 1000, runtimeRss: 2000, totalRss: 3000, at: 500 });

  now = 3000;
  assert.equal(probes, 1, 'reading the snapshot does not probe again');
  timers.timers[0].fn();
  assert.equal(probes, 2, 'one probe per tick, no more');
  assert.equal(sampler.snapshot.at, 3000, 'each tick stamps the current clock');
  assert.equal(sampler.snapshot.at, 3000, 'a repaint reuses the cached tick');
  assert.equal(probes, 2, 'and costs no further probe');

  sampler.start();
  assert.equal(timers.timers.length, 1, 'start() is idempotent');
});

test('a missing runtime probe leaves client RSS as the total', () => {
  const sampler = new ResourceSampler({
    now: () => 7,
    rss: () => ({ rssBytes: 4096, heapUsedBytes: 1, externalBytes: 1, at: 7 }),
    sampleRuntime: () => null,
    timers: fakeTimers(),
  });

  assert.deepEqual(sampler.snapshot, { clientRss: 4096, runtimeRss: null, totalRss: 4096, at: 7 });
  assert.equal(sampler.runtimePid, undefined);
});

test('the first snapshot is taken on demand when start was never called', () => {
  let probes = 0;
  const sampler = new ResourceSampler({
    now: () => 1,
    rss: () => ({ rssBytes: 10, heapUsedBytes: 0, externalBytes: 0, at: 1 }),
    sampleRuntime: () => {
      probes += 1;
      return 5;
    },
    timers: fakeTimers(),
  });

  assert.equal(sampler.snapshot.totalRss, 10, 'no runtime pid means no probe');
  assert.equal(probes, 0);

  // A runtime spawned after the sampler was built must show up without waiting
  // for the next tick, and a repaint must then stop re-probing.
  sampler.runtimePid = 99;
  assert.equal(sampler.snapshot.totalRss, 15);
  assert.equal(probes, 1);
  assert.equal(sampler.snapshot.totalRss, 15);
  assert.equal(probes, 1, 'an unchanged pid reuses the cached sample');
});

test('a throwing probe narrows the snapshot instead of escaping the timer', () => {
  const timers = fakeTimers();
  const sampler = new ResourceSampler({
    runtimePid: 4242,
    now: () => 1,
    rss: () => {
      throw new Error('memoryUsage exploded');
    },
    sampleRuntime: () => {
      throw new Error('tasklist exploded');
    },
    timers,
  });

  assert.doesNotThrow(() => sampler.start());
  assert.deepEqual(sampler.snapshot, { clientRss: null, runtimeRss: null, totalRss: null, at: 1 });
});

test('stop() is idempotent and clears the running timer exactly once', () => {
  const timers = fakeTimers();
  const sampler = new ResourceSampler({
    intervalMs: 1000,
    rss: () => ({ rssBytes: 1, heapUsedBytes: 0, externalBytes: 0, at: 0 }),
    timers,
  });

  sampler.stop();
  assert.equal(timers.timers.length, 0, 'stopping an idle sampler schedules nothing');

  sampler.start();
  sampler.stop();
  sampler.stop();
  assert.equal(timers.timers[0].cleared, true);
  assert.equal(timers.timers.length, 1, 'a second stop() does not reschedule');
});

test('a zero or fractional interval is rejected rather than busy-looping', () => {
  assert.throws(() => new ResourceSampler({ intervalMs: 0 }), TypeError);
  assert.throws(() => new ResourceSampler({ intervalMs: 1.5 }), TypeError);
  assert.throws(() => new ResourceSampler({ intervalMs: -2000 }), TypeError);
});

test('the real probe on this machine is non-fatal', () => {
  // The sandbox may deny the child process; the contract is `null`, not a throw.
  const bytes = sampleRuntimeRss(process.pid);
  assert.ok(bytes === null || bytes > 0);
});
