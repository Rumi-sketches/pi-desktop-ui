import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

const WAIT_MS = 5_000;
const POLL_MS = 40;
const pause = () => new Promise((resolve) => setTimeout(resolve, POLL_MS));

/** Coordinate cooperating processes for one persisted file. Never steal a live or ambiguous lock. */
export async function withFileLock(file, operation) {
  const lock = `${file}.lock`;
  const reclaim = `${lock}.reclaim`;
  const id = randomUUID();
  const staging = `${lock}.${process.pid}.${id}.staging`;
  const owner = { pid: process.pid, id };
  const deadline = Date.now() + WAIT_MS;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await mkdir(staging);
  try {
    await writeFile(path.join(staging, "owner.json"), JSON.stringify(owner));
    while (true) {
      try {
        // The owner record is complete before the lock becomes visible.
        await rename(staging, lock);
        break;
      } catch (error) {
        if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY" && error.code !== "EPERM") throw error;
        try {
          await mkdir(reclaim);
          try {
            let held;
            try { held = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")); }
            catch (readError) {
              if (readError.code !== "ENOENT") throw readError;
            }
            if (held && Number.isSafeInteger(held.pid) && held.pid > 0 && typeof held.id === "string") {
              let alive = true;
              try { process.kill(held.pid, 0); }
              catch (checkError) { alive = checkError.code !== "ESRCH"; }
              if (!alive) {
                const latest = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8"));
                if (latest.id === held.id && latest.pid === held.pid) {
                  await rm(lock, { recursive: true, force: true });
                }
              }
            }
          } finally {
            await rm(reclaim, { recursive: true, force: true });
          }
        } catch (reclaimError) {
          if (reclaimError.code !== "EEXIST" && reclaimError.code !== "ENOENT") throw reclaimError;
        }
        if (Date.now() >= deadline) {
          throw Object.assign(new Error(`timed out waiting for storage lock: ${path.basename(file)}`), { code: 'STORAGE_LOCK_TIMEOUT' });
        }
        await pause();
      }
    }
    try {
      return await operation();
    } finally {
      // A reclaimer cannot remove a live owner's lock. Check identity before release.
      const latest = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8"));
      if (latest.id === id) await rm(lock, { recursive: true, force: true });
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
