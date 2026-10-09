#!/usr/bin/env node
// The corpus this tool emits must arrive WHOLE when stdout is a pipe (web-uplift-as3).
//
// process.stdout.write() is asynchronous and process.exit() does not wait for it, so piping a
// corpus larger than the pipe buffer used to emit whatever had been flushed and drop the rest
// while still exiting 0: 232941 bytes with -o, exactly 131072 through a pipe, and the only
// signal was a JSON parse failure in whatever consumed it. These cases pin both halves of the
// contract: a pipe gets every byte, and a consumer that goes away is reported.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const here = fileURLToPath(import.meta.url);
const CLI = join(repoRoot, 'tests', 'mwg-drift-classify.mjs');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// A package whose extracted corpus is comfortably larger than the 64 KiB pipe buffer.
function makeBigPackage(dir) {
  const guides = join(dir, 'skills', 'modern-web-guidance', 'guides', 'big');
  mkdirSync(guides, { recursive: true });
  const body = `# Guide\n\n${'This paragraph is repeated so the corpus crosses the pipe buffer by a wide margin. '.repeat(40)}\n`;
  for (let i = 1; i <= 45; i += 1) {
    writeFileSync(join(guides, `big-guide-${i}.md`), `${body}\n## Section\n\nUnique id ${i}.\n${'More text to grow the file, and then some more, so a pipe full of it cannot be buffered away. '.repeat(180)}\n`, 'utf8');
  }
  return dir;
}

const runCli = (args) => new Promise((resolveRun) => {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  const err = [];
  child.stdout.on('data', (c) => out.push(c));
  child.stderr.on('data', (c) => err.push(c));
  child.once('close', (code, signal) => resolveRun({ code, signal, out: Buffer.concat(out), err: Buffer.concat(err).toString('utf8') }));
});

export async function testMwgDriftExtractPipe() {
  const tmp = mkdtempSync(join(tmpdir(), 'web-uplift-as3-'));
  try {
    const pkg = makeBigPackage(join(tmp, 'pkg'));
    const fileOut = join(tmp, 'corpus.json');
    const toFile = await runCli(['--extract', pkg, '--version', '1.0.0', '-o', fileOut]);
    assert(toFile.code === 0, `the -o run must succeed: ${toFile.code} ${toFile.err}`);
    const fileBytes = readFileSync(fileOut);
    // Wide margin over the pipe buffer on purpose: the closed-consumer case below must not be
    // satisfiable by buffers anywhere in the path.
    assert(fileBytes.length > 256 * 1024, `the fixture must exceed the pipe buffer by a wide margin: ${fileBytes.length} bytes`);

    // 1. THE PIPE GETS EVERY BYTE. Without this, a pipe is a lossy channel that reports success.
    const piped = await runCli(['--extract', pkg, '--version', '1.0.0']);
    assert(piped.code === 0, `the piped run must succeed: ${piped.code} ${piped.err}`);
    assert(piped.out.length === fileBytes.length,
      `the piped corpus must be the whole corpus: ${piped.out.length} bytes through a pipe vs ${fileBytes.length} with -o`);
    assert(Buffer.compare(piped.out, fileBytes) === 0, 'the piped corpus must be byte-identical to the -o corpus');
    const parsed = JSON.parse(piped.out.toString('utf8'));
    const guideCount = parsed.guides && typeof parsed.guides === 'object' ? Object.keys(parsed.guides).length : -1;
    assert(guideCount === 45, `the piped corpus must parse and hold every guide: ${guideCount}`);

    // 2. A CONSUMER THAT GOES AWAY IS REPORTED, not swallowed: | head, or anything that exits
    // before reading, must not leave this tool claiming success for a corpus nobody received.
    // The reader is a separate process whose stdin IS this run's stdout, because destroying the
    // parent's read stream does not close the pipe fd and the writer then blocks instead.
    const reader = spawn(process.execPath, ['-e', 'process.stdin.destroy(); setTimeout(() => process.exit(0), 300);'], {
      stdio: ['pipe', 'ignore', 'inherit'],
    });
    const child = spawn(process.execPath, [CLI, '--extract', pkg, '--version', '1.0.0'], { stdio: ['ignore', reader.stdin, 'pipe'] });
    const err = [];
    child.stderr.on('data', (c) => err.push(c));
    const result = await new Promise((resolveClose) => child.once('close', (code, signal) => resolveClose({ code, signal })));
    assert(result.code !== 0, `a closed consumer must not exit 0 (code=${result.code} signal=${result.signal})`);
    assert(/could not write the extracted corpus to stdout \(\d+ of \d+ bytes written\)/.test(err.join('')),
      `the failure must name how much was written: ${err.join('')}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`${here.split('/').slice(-2).join('/')}: tests OK`);
}

if (process.argv[1] && resolve(process.argv[1]) === here) {
  await testMwgDriftExtractPipe();
}
