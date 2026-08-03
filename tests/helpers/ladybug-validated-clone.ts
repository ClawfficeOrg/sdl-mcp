import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const validatedCopies = new Map<string, string>();

/**
 * Copies a raw, closed LadybugDB fixture to a distinct family before opening it.
 * Repeated calls reopen the validated copy so migration tests retain state.
 */
export async function initValidatedTestLadybugClone(
  sourceDbPath: string,
): Promise<string> {
  const [familyFiles, ladybug] = await Promise.all([
    import("../../dist/db/ladybug-family-files.js"),
    import("../../dist/db/ladybug.js"),
  ]);
  const existing = validatedCopies.get(sourceDbPath);
  if (existing && existsSync(existing)) {
    await ladybug.initLadybugDb(existing);
    return existing;
  }

  // Remove only legacy paths created by earlier versions of this test helper.
  rmSync(sourceDbPath + ".validated-clone", { recursive: true, force: true });
  rmSync(sourceDbPath + ".validated-clone.sdl-lineage.json", {
    recursive: true,
    force: true,
  });

  const cloneRoot = join(
    dirname(sourceDbPath),
    ".validated-clones",
    createHash("sha256").update(sourceDbPath).digest("hex").slice(0, 16),
  );
  rmSync(cloneRoot, { recursive: true, force: true });
  const destination = join(cloneRoot, basename(sourceDbPath));
  const capability = familyFiles.copyLadybugFamilyForValidatedClone(
    sourceDbPath,
    destination,
  );
  validatedCopies.set(sourceDbPath, destination);
  await ladybug.initValidatedLadybugClone(destination, capability);
  return destination;
}
