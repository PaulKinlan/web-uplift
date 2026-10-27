// Writes into a tree the audited agent can write must not FOLLOW a link planted at the target
// (web-uplift-rsbb).
//
// The run tree <out>/<site-slug>/<run-id>/ is created by this runner and then handed to an agent
// that holds write tools over it. When that agent exits, the runner writes its own records into the
// same directory: run.json, write-scope.json, the annotated report.json, run-refused.json. Plain
// writeFile() follows a symlink at the LEAF, so an agent can leave `run.json -> ../../.profile`
// behind and have the RUNNER's write land outside the tree - an arbitrary-file-write with the
// runner's privileges, aimed at any file the runner's user can write. The directory-level shapes
// this runner already checks (isRealUnderOutput, the write-scope diff) cannot see it: the directory
// is real, only the final component is a link, and the write happens after the agent's own scope
// window has closed.
//
// This is NOT the same defect as web-uplift-9t8 (runner-harness-write-through-planted-link, "Fixed"
// in the same nightly report): 9t8 contained where a PLANTED POINTER may point, so a consumer would
// not READ a directory outside the host root. It refuses nothing about a write following a leaf
// link, which is why rsbb is not a duplicate.
//
// O_NOFOLLOW refuses ONLY a symlink at the final component, which is exactly the attack. It is not
// containment (the parent chain is checked separately), it does not authenticate content the agent
// wrote earlier, and it cannot stop a race by a LIVE process (the flag makes the kernel do the
// check at open time, so the kernel is not raced - but a process that replaces the leaf between our
// open and our write of a different path is a different problem, and by the time these run the
// agent has exited).
//
// Portability: platforms without O_NOFOLLOW (Windows) fall back to lstat-then-write, which has the
// usual check-then-use window. That is stated rather than hidden: on those platforms the guard is
// best-effort, and the honest boundary remains operator-supplied isolation.
import { closeSync, constants, lstatSync, openSync, writeFileSync } from 'node:fs';
import { lstat, open, readFile, writeFile } from 'node:fs/promises';

const NOFOLLOW = constants.O_NOFOLLOW;
const HAS_NOFOLLOW = typeof NOFOLLOW === 'number';

export class SymlinkWriteRefused extends Error {
  constructor(path, action) {
    super(
      `refusing to ${action} ${path}: the target is a symbolic link, and following it would land outside the run tree ` +
        `(a planted leaf link redirects this runner's own write; web-uplift-rsbb)`
    );
    this.name = 'SymlinkWriteRefused';
    this.code = 'ELOOP';
    this.path = path;
  }
}

const isSymlink = async (path) => {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
};

// Replace the file at `path` (or create it), refusing to write through a symlink there.
export async function writeFileNoFollow(path, data, options) {
  if (HAS_NOFOLLOW) {
    let handle;
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, options?.mode ?? 0o644);
    } catch (err) {
      if (err.code === 'ELOOP') throw new SymlinkWriteRefused(path, 'write');
      throw err;
    }
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    return;
  }
  if (await isSymlink(path)) throw new SymlinkWriteRefused(path, 'write');
  if (options === undefined) return writeFile(path, data);
  return writeFile(path, data, options);
}

// Same guard for the synchronous write paths.
export function writeFileNoFollowSync(path, data, options) {
  if (HAS_NOFOLLOW) {
    let fd;
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, options?.mode ?? 0o644);
    } catch (err) {
      if (err.code === 'ELOOP') throw new SymlinkWriteRefused(path, 'write');
      throw err;
    }
    try {
      writeFileSync(fd, data);
    } finally {
      closeSync(fd);
    }
    return;
  }
  try {
    if (lstatSync(path).isSymbolicLink()) throw new SymlinkWriteRefused(path, 'write');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  writeFileSync(path, data, options);
}

// A READ of an agent-controlled path has the mirror problem: readFile() follows a leaf link, so a
// planted `report.json -> <another run>/report.json` (or any readable JSON file) is read as if it
// were this run's report, and then rewritten. Refuse the link rather than report on someone else's
// file.
export async function readFileNoFollow(path, encoding = 'utf8') {
  if (HAS_NOFOLLOW) {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    } catch (err) {
      if (err.code === 'ELOOP') throw new SymlinkWriteRefused(path, 'read');
      throw err;
    }
    try {
      return await handle.readFile(encoding);
    } finally {
      await handle.close();
    }
  }
  if (await isSymlink(path)) throw new SymlinkWriteRefused(path, 'read');
  return readFile(path, encoding);
}
