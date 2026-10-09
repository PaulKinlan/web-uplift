#!/usr/bin/env node
// Tests for the CDP endpoint exposure guard (web-uplift-4rv): the audit's Chrome exposes an
// UNAUTHENTICATED DevTools endpoint for the life of the run, so the tool pins it to loopback
// and then measures that the pin held.
//
// Two kinds of case: real sockets (bind a server the two ways and probe it), and injected
// verdicts (so the decision table is pinned on a machine with no non-loopback interface).
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cdpEndpointExposure, probeTcp } from '../evidence/cdp.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const listen = (host) =>
  new Promise((resolveListen, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, host, () => resolveListen(server));
  });

export async function testCdpEndpointExposure() {
  // 1. A loopback-bound server is NOT exposed: the probe connects to the host's non-loopback
  // address and the kernel refuses. This is the real case the audit runs under.
  const loopback = await listen('127.0.0.1');
  // An all-interfaces server IS exposed: the same probe gets a connection, which is what a
  // remote host would get. This is the case the guard exists to catch, driven with a real
  // socket rather than a stub.
  const anyAddress = await listen('0.0.0.0');
  try {
    const nonLoopback = Object.values((await import('node:os')).networkInterfaces())
      .flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal)
      .map((a) => a.address);
    assert(!(await cdpEndpointExposure(loopback.address().port)).exposed,
      'a loopback-bound endpoint must not be reported as exposed');
    if (nonLoopback.length > 0) {
      const exposed = await cdpEndpointExposure(anyAddress.address().port);
      assert(exposed.exposed === true, `an all-interfaces endpoint must be reported as exposed: ${JSON.stringify(exposed)}`);
      assert(/not a loopback address/.test(exposed.reason) && exposed.reason.includes(nonLoopback[0]),
        `the refusal must name the address and the reason: ${exposed.reason}`);
      // ...and the same server reached only on loopback is not exposed, so the guard is
      // measuring the ADDRESS rather than "is anything listening".
      const viaLoopback = await probeTcp('127.0.0.1', anyAddress.address().port, 300);
      assert(viaLoopback === 'connected', `the probe must connect on loopback: ${viaLoopback}`);
    } else {
      console.log('  (no non-loopback interface on this host: the real-socket exposure case was skipped)');
    }

    // 2. The decision table, with injected verdicts and injected interfaces, so every branch is
    // pinned on any machine. `refused` is the only verdict that means loopback-only; a timeout
    // or an unexpected error must NOT be reported as exposed OR as verified-safe.
    const verdicts = (verdict) => async () => verdict;
    const interfaces = { eth0: [{ address: '10.0.0.5', family: 'IPv4', internal: false }], lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] };
    assert((await cdpEndpointExposure(9222, { interfaces, connect: verdicts('connected') })).exposed === true,
      'a connected probe is exposure');
    assert((await cdpEndpointExposure(9222, { interfaces, connect: verdicts('refused') })).exposed === false,
      'a refused probe is loopback-only');
    const timeout = await cdpEndpointExposure(9222, { interfaces, connect: verdicts('timeout') });
    assert(timeout.exposed === false && /unconfirmed/.test(timeout.note),
      `a probe that could not decide must be reported as unconfirmed, not as verified: ${JSON.stringify(timeout)}`);
    const errored = await cdpEndpointExposure(9222, { interfaces, connect: verdicts('error') });
    assert(errored.exposed === false && /unconfirmed/.test(errored.note),
      `an erroring probe must be reported as unconfirmed: ${JSON.stringify(errored)}`);
    // A IPv6-only host has no IPv4 address to probe: say so rather than claim verification.
    const v6only = { eth0: [{ address: 'fe80::1', family: 'IPv6', internal: false }] };
    const none = await cdpEndpointExposure(9222, { interfaces: v6only, connect: verdicts('connected') });
    assert(none.exposed === false && /no non-loopback interface/.test(none.note),
      `with no IPv4 interface there is nothing to reach the endpoint on: ${JSON.stringify(none)}`);
    // A port that is not a port is not a probe target.
    assert((await cdpEndpointExposure(0, { interfaces, connect: verdicts('connected') })).exposed === false,
      'a launch with no endpoint yet must not be reported as exposed');
    // The probe itself: refused vs connected, against real sockets.
    const closed = await listen('127.0.0.1');
    const closedPort = closed.address().port;
    await new Promise((r) => closed.close(r));
    assert((await probeTcp('127.0.0.1', closedPort, 500)) === 'refused',
      'a closed loopback port must probe as refused');
    assert((await probeTcp('127.0.0.1', loopback.address().port, 500)) === 'connected',
      'an open loopback port must probe as connected');
    // The launch path actually passes the pin: asserted on the source, because the alternative
    // is spawning a browser to read its command line.
    const source = (await import('node:fs')).readFileSync(resolve(repoRoot, 'evidence', 'cdp.mjs'), 'utf8');
    assert(source.includes("'--remote-debugging-address=127.0.0.1'"),
      'the launch must pin the debugging address to loopback, not rely on Chrome defaulting to it');
    assert(source.includes('cdpEndpointExposure(port)'),
      'the launch must verify the binding it asked for');
  } finally {
    await new Promise((r) => loopback.close(r));
    await new Promise((r) => anyAddress.close(r));
  }
  console.log('tests/cdp-endpoint-exposure.mjs: tests OK');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await testCdpEndpointExposure();
}
