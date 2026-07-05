/**
 * Atomic file write utility.
 *
 * Writes files atomically using the temp-file-then-rename pattern:
 * 1. Write content to a temporary file with fsync
 * 2. Preserve permissions of existing target file
 * 3. Atomically rename temp to target (POSIX atomic rename)
 * 4. Fallback to direct write if atomic write fails
 *
 * Also handles symlink resolution: if the target path is a symlink,
 * writes to the resolved target while preserving the symlink.
 */

import {
  writeFileSync as fsWriteFileSync,
  renameSync,
  readlinkSync,
  chmodSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import {
  writeFile as fsWriteFile,
  rename as fsRename,
  readlink as fsReadlink,
  chmod as fsChmod,
  stat as fsStat,
  unlink as fsUnlink,
} from 'node:fs/promises'
import { isAbsolute, resolve, dirname } from 'node:path'

export interface AtomicWriteOptions {
  encoding?: BufferEncoding
  mode?: number
}

/**
 * Write a file atomically using temp-file + rename pattern.
 *
 * @param filePath - Target file path (may be a symlink)
 * @param content - Content to write
 * @param options - Write options (encoding, mode)
 */
export function writeFileSyncAtomic(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): void {
  const encoding = options.encoding ?? 'utf-8'

  // Resolve symlink: write to target while preserving symlink
  let targetPath = filePath
  try {
    const linkTarget = readlinkSync(filePath)
    targetPath = isAbsolute(linkTarget)
      ? linkTarget
      : resolve(dirname(filePath), linkTarget)
  } catch {
    // Not a symlink or doesn't exist — write directly to filePath
  }

  // Check if target file exists and get its permissions
  let targetMode: number | undefined
  let targetExists = false
  try {
    targetMode = statSync(targetPath).mode
    targetExists = true
  } catch (e: unknown) {
    if (!isEnoent(e)) throw e
    // New file — use provided mode if any
    if (options.mode !== undefined) {
      targetMode = options.mode
    }
  }

  const tempPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`

  try {
    // Write to temp file with flush
    const writeOptions: { encoding: BufferEncoding; flush: boolean; mode?: number } = {
      encoding,
      flush: true,
    }
    if (!targetExists && options.mode !== undefined) {
      writeOptions.mode = options.mode
    }

    fsWriteFileSync(tempPath, content, writeOptions)

    // Preserve permissions of existing file
    if (targetExists && targetMode !== undefined) {
      chmodSync(tempPath, targetMode)
    }

    // Atomic rename
    renameSync(tempPath, targetPath)
  } catch (atomicError) {
    // Clean up temp file
    try {
      unlinkSync(tempPath)
    } catch {
      // Ignore cleanup errors
    }

    // Fallback to non-atomic write
    const fallbackOptions: { encoding: BufferEncoding; flush: boolean; mode?: number } = {
      encoding,
      flush: true,
    }
    if (!targetExists && options.mode !== undefined) {
      fallbackOptions.mode = options.mode
    }

    fsWriteFileSync(targetPath, content, fallbackOptions)
  }
}

/**
 * Async version of atomic file write.
 *
 * @param filePath - Target file path (may be a symlink)
 * @param content - Content to write (string or Buffer)
 * @param options - Write options (encoding, mode)
 */
export async function writeFileAtomic(
  filePath: string,
  content: string | Buffer,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const encoding = options.encoding ?? 'utf-8'

  // Resolve symlink
  let targetPath = filePath
  try {
    const linkTarget = await fsReadlink(filePath)
    targetPath = isAbsolute(linkTarget)
      ? linkTarget
      : resolve(dirname(filePath), linkTarget)
  } catch {
    // Not a symlink or doesn't exist
  }

  // Check if target exists and get permissions
  let targetMode: number | undefined
  let targetExists = false
  try {
    targetMode = (await fsStat(targetPath)).mode
    targetExists = true
  } catch (e: unknown) {
    if (!isEnoent(e)) throw e
    if (options.mode !== undefined) {
      targetMode = options.mode
    }
  }

  const tempPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`

  try {
    const writeOptions: { encoding: BufferEncoding; flush: boolean; mode?: number } = {
      encoding: encoding as BufferEncoding,
      flush: true,
    }
    if (!targetExists && options.mode !== undefined) {
      writeOptions.mode = options.mode
    }

    await fsWriteFile(tempPath, content as string, writeOptions)

    if (targetExists && targetMode !== undefined) {
      await fsChmod(tempPath, targetMode)
    }

    await fsRename(tempPath, targetPath)
  } catch {
    // Clean up temp file
    try { await fsUnlink(tempPath) } catch { /* ignore */ }

    // Fallback to non-atomic write
    const fallbackOptions: { encoding: BufferEncoding; flush: boolean; mode?: number } = {
      encoding: encoding as BufferEncoding,
      flush: true,
    }
    if (!targetExists && options.mode !== undefined) {
      fallbackOptions.mode = options.mode
    }

    await fsWriteFile(targetPath, content as string, fallbackOptions)
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: string }).code === 'ENOENT'
  )
}
