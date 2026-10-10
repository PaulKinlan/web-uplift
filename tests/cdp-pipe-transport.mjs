#!/usr/bin/env node
// Tests for the pipe transport (web-uplift-j3re): the audit's Chrome must not publish an
// UNAUTHENTICATED DevTools endpoint at all.
//
// The reproduction this closes: a SEPARATE local process fetched /json/version from the loopback
// port (HTTP 200) and a separate CDP session then attached and ran script in a target. Anyone who
// can reach that port drives the browser as the operator for the whole run. web-uplift-4rv pins and
// verifies the endpoint; --remote-debugging-pipe removes it, because a pipe is reachable only by a
// process that already holds the browser's file descriptors.
//
// The CONTROL is the point of this file. "No listening socket" is trivially true of a launcher that
// failed to start a browser at all, so every zero here is paired with a positive: the same browser
// evaluates script over the pipe, the same kernel read sees the listener that the PORT transport
// really does publish, and a separate process really can reach that one.
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { launchChrome, newSession, readBoundListeners } from '../evidence/cdp.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// A separate PROCESS, not an in-process fetch: the reproduction was another program on the machine,
// and only a separate process proves the endpoint is reachable the way an attacker would reach it.
function probeFromSeparateProcess(port, timeoutMs = 5000) {
  return new Promise((done) => {
    const script = `
      const http = require('node:http');
      const req = http.get({ host: '127.0.0.1', port: ${port}, path: '/json/version', timeout: ${timeoutMs} },
        (res) => { res.resume(); console.log(res.statusCode); process.exit(0); });
      req.on('error', () => { console.log('unreachable'); process.exit(0); });
      req.on('timeout', () => { req.destroy(); console.log('timeout'); process.exit(0); });
    `;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.on('close', () => done(out.trim()));
  });
}

function listenersFor(pid) {
  const read = readBoundListeners(pid);
  const listeners = Array.isArray(read) ? read : (read && read.listeners) || [];
  const unreadable = Array.isArray(read) ? [] : (read && read.unreadable) || [];
  return { listeners, unreadable };
}

export async function testCdpPipeTransport() {
  const pipeChrome = await launchChrome({ log: () => {} });
  try {
    assert(pipeChrome.port === undefined, 'the default transport must not publish a port');
    assert(pipeChrome.pipe, 'the default transport must be the pipe');
    // The browser must genuinely work, or "no endpoint" is a statement about a broken launcher.
    const session = await newSession(pipeChrome, { log: () => {} });
    try {
      const value = await session.client.Runtime.evaluate({ expression: '6 * 7', returnByValue: true });
      assert(value.result && value.result.value === 42, 'the pipe browser must evaluate script');
      // The no-argument call is how this codebase awaits events, and it is ambiguous in CDP: it must
      // resolve on the event without ever reaching the browser as a command.
      const loaded = session.client.Page.loadEventFired();
      await session.client.Page.navigate({ url: 'data:text/html,<title>pipe</title>' });
      const event = await loaded;
      assert(event && typeof event.timestamp === 'number', 'awaiting an event with no argument must resolve with its params');
    } finally {
      await session.close();
    }
    if (existsSync('/proc/net/tcp')) {
      const { listeners, unreadable } = listenersFor(pipeChrome.proc.pid);
      assert(unreadable.length === 0,
        `a zero only means something if the binding read was complete; unreadable: ${unreadable.join(', ')}`);
      assert(listeners.length === 0,
        `a pipe browser must hold no listening TCP socket, saw ${JSON.stringify(listeners)}`);
    } else {
      console.log('  (SKIPPED the kernel binding check: no /proc/net/tcp on this platform)');
    }
  } finally {
    await pipeChrome.close();
  }

  // The control: the port transport really does publish an endpoint a separate process can reach.
  const portChrome = await launchChrome({ transport: 'port', log: () => {} });
  try {
    assert(Number.isInteger(portChrome.port), 'the port transport must publish a port');
    const status = await probeFromSeparateProcess(portChrome.port);
    assert(status === '200',
      `a separate process must be able to reach the port transport, got ${status} (unreachable here would make the pipe assertion meaningless)`);
    if (existsSync('/proc/net/tcp')) {
      const { listeners } = listenersFor(portChrome.proc.pid);
      assert(listeners.length > 0, 'the kernel read must see the listener the port transport publishes');
    }
  } finally {
    await portChrome.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await testCdpPipeTransport();
  console.log('cdp-pipe-transport OK: the default transport publishes no endpoint, and the control shows the check can see one');
}
