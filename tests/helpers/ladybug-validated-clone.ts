/**
 * Opens a raw, closed LadybugDB test fixture through the explicit validated-clone
 * capability instead of manufacturing a production lineage receipt.
 */
export async function initValidatedTestLadybugClone(
  dbPath: string,
): Promise<void> {
  const [{ fingerprintDbFamily }, { bindVerifiedLadybugClone }, ladybug] =
    await Promise.all([
      import("../../dist/benchmark/external-runner.js"),
      import("../../dist/db/ladybug-lineage.js"),
      import("../../dist/db/ladybug.js"),
    ]);
  const authority = bindVerifiedLadybugClone(
    dbPath,
    fingerprintDbFamily(dbPath),
  );
  await ladybug.initValidatedLadybugClone(dbPath, authority);
}
