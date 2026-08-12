import { setTimeout as delay } from "node:timers/promises";

const MAX_COPY_ATTEMPTS = 4;

/** Retry only short-lived Windows file locks; all other copy failures fail fast. */
export async function copyFileWithTransientRetry(copy, from, to) {
  for (let attempt = 1; attempt <= MAX_COPY_ATTEMPTS; attempt += 1) {
    try {
      await copy(from, to);
      return;
    } catch (error) {
      const code = error && typeof error === "object" ? error.code : undefined;
      if (
        (code !== "EBUSY" && code !== "EPERM")
        || attempt === MAX_COPY_ATTEMPTS
      ) {
        throw error;
      }
      await delay(25 * attempt);
    }
  }
}
