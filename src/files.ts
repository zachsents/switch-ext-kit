// A file an extension keeps beside its log, written whole: to a temp file next to it, flushed, then
// renamed over it, so a crash leaves the old file or the new one, never half of either.
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs"
import path from "node:path"

/**
 * Writes `data` to `file` in one step: the old contents until the new are whole on disk. `mode` is
 * the new file's from its first byte (0o600 for a secret).
 */
export const writeFileAtomic = (file: string, data: string, mode = 0o666): void => {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  rmSync(temp, { force: true })
  const fd = openSync(temp, "w", mode)
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, file)
}
