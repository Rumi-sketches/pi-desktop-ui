import path from "node:path";
import { randomUUID } from "node:crypto";
import { withFileLock } from "./file-lock.mjs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { PRODUCT_ID } from "../../product.mjs";

const JSON_INDENT = 1;

/**
 * Keep independent read-modify-write operations in request order while letting
 * the operation after a failed one run against the last confirmed state.
 * @returns {<T>(operation: () => Promise<T>) => Promise<T>}
 */
export function mutationQueue() {
  let tail = Promise.resolve();
  return (operation) => {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

/**
 * @template T the shape this store holds, inferred from `fallback`/`revive`.
 * @param {string} file absolute path of the store.
 * @param {object} [opts]
 * @param {() => T} [opts.fallback] builds the value used when the file is
 *   missing or unreadable. A factory, so no store shares a mutable default.
 * @param {(raw: any) => T | undefined} [opts.revive] validates the parsed JSON;
 *   returning `undefined` (or throwing) falls back to `fallback()`.
 * @param {number} [opts.indent] JSON indentation width.
 * @param {boolean} [opts.trailingNewline] append a newline after JSON.
 * @param {number} [opts.mode] permission bits for the file, for secrets.
 * @param {number} [opts.dirMode] permission bits used if the directory has to
 *   be created.
 * @returns {{ load: () => Promise<T>, loadStrict: () => Promise<T>, save: (value: T) => Promise<void> }}
 */
export function jsonFile(file, { fallback = () => null, revive = (raw) => raw, indent = JSON_INDENT, trailingNewline = false, mode, dirMode } = {}) {
  let queue = Promise.resolve();

  async function writeAtomically(serialized) {
    const tmpFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(file), dirMode ? { recursive: true, mode: dirMode } : { recursive: true });
      await writeFile(tmpFile, serialized, mode ? { mode } : undefined);
      // `mode` on writeFile only applies when the file is created: tighten pre-existing ones.
      if (mode) await chmod(tmpFile, mode);
      await rename(tmpFile, file);
    } catch (error) {
      console.error(`${PRODUCT_ID}: saving ${path.basename(file)} failed (${error?.message ?? error})`);
      await rm(tmpFile, { force: true }).catch(() => {});
      throw error;
    }
  }

  return {
    async loadStrict() {
      let text;
      try { text = await readFile(file, "utf8"); }
      catch (error) {
        if (error.code === "ENOENT") return fallback();
        throw error;
      }
      const revived = revive(JSON.parse(text));
      if (revived === undefined) throw new Error(`invalid storage file: ${path.basename(file)}`);
      return revived;
    },
    async load() {
      try {
        const revived = revive(JSON.parse(await readFile(file, "utf8")));
        return revived === undefined ? fallback() : revived;
      } catch {
        return fallback();
      }
    },
    save(value) {
      let serialized;
      try {
        // Capture the requested value now: callers often pass mutable state,
        // which may change before an earlier queued write runs.
        serialized = JSON.stringify(value, null, indent) + (trailingNewline ? "\n" : "");
      } catch (error) {
        return Promise.reject(error);
      }
      const result = queue.then(() => writeAtomically(serialized));
      // The caller observes the original result. Only the private tail recovers
      // so a failed write cannot poison later saves.
      queue = result.catch(() => {});
      return result;
    },
  };
}

/** @template T @param {{ loadStrict: () => Promise<T>, save: (value: T) => Promise<void> }} store @param {string} file @param {(current: T) => T | Promise<T>} operation */
export async function mutateJsonFile(store, file, operation) {
  return withFileLock(file, async () => {
    const current = await store.loadStrict();
    const next = await operation(current);
    await store.save(next);
    return next;
  });
}
