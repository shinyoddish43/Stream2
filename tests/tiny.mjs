// A 40-line test harness. The project has no build step and no node_modules;
// a test runner should not be the thing that breaks that.

let passed = 0;
let failed = 0;
const failures = [];
let group = '';

const pending = [];

export function describe(name, fn) {
  group = name;
  fn();
  group = '';
}

export function it(name, fn) {
  const label = group ? `${group} › ${name}` : name;
  const fail = (e) => {
    failed++;
    failures.push(`${label}\n    ${e && e.message ? e.message : e}`);
    process.stdout.write('x');
  };
  const pass = () => { passed++; process.stdout.write('.'); };
  try {
    const result = fn();
    // An async test used to "pass" the moment it started, because nothing
    // awaited it and its rejection went to the void. Track the promise.
    if (result && typeof result.then === 'function') {
      pending.push(result.then(pass, fail));
    } else {
      pass();
    }
  } catch (e) {
    fail(e);
  }
}

export const assert = {
  ok(value, message = 'expected truthy') {
    if (!value) throw new Error(`${message} (got ${format(value)})`);
  },
  equal(actual, expected, message = 'not equal') {
    if (actual !== expected) throw new Error(`${message}: expected ${format(expected)}, got ${format(actual)}`);
  },
  close(actual, expected, tolerance = 1e-6, message = 'not close enough') {
    if (Math.abs(actual - expected) > tolerance) {
      throw new Error(`${message}: expected ~${format(expected)}, got ${format(actual)}`);
    }
  },
  deep(actual, expected, message = 'not deeply equal') {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${message}:\n      expected ${b}\n      got      ${a}`);
  },
  throws(fn, message = 'expected a throw') {
    try { fn(); } catch (e) { return; }
    throw new Error(message);
  },
};

const format = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v));

export async function report(title) {
  await Promise.all(pending);
  process.stdout.write('\n');
  for (const failure of failures) console.log('  FAIL ' + failure);
  console.log(`${title}: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
  return failed === 0;
}
