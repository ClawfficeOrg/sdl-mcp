import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";

const SCRIPT_PATH = resolve("scripts/postinstall-models.mjs");

function isolatedModelEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    LOCALAPPDATA: root,
    SDL_MCP_SKIP_MODEL_DOWNLOAD: "1",
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("postinstall model setup stays soft by default", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sdl-model-soft-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    env: isolatedModelEnvironment(root),
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /skipping model download/i);
});

test("strict postinstall model setup fails when required artifacts are absent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sdl-model-strict-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [SCRIPT_PATH, "--strict"], {
    env: isolatedModelEnvironment(root),
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /required model artifacts.*missing|unverified/i,
  );
});

test("model artifact verification checks content hashes and JSON syntax", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sdl-model-verify-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modelDir = join(root, "fixture-model");
  mkdirSync(modelDir, { recursive: true });

  const modelBytes = "fixture-onnx";
  const tokenizer = '{"model":{"type":"WordPiece"}}';
  const config = '{"hidden_size":768}';
  writeFileSync(join(modelDir, "model_quantized.onnx"), modelBytes);
  writeFileSync(join(modelDir, "tokenizer.json"), tokenizer);
  writeFileSync(join(modelDir, "config.json"), config);

  const model = {
    name: "fixture-model",
    files: ["model_quantized.onnx", "tokenizer.json", "config.json"],
    maxBytes: 1024,
    sha256: {
      "model_quantized.onnx": sha256(modelBytes),
      "tokenizer.json": sha256(tokenizer),
      "config.json": sha256(config),
    },
  };
  const scriptUrl = pathToFileURL(SCRIPT_PATH).href;
  const verifyCode = `
    const { verifyModelArtifacts } = await import(${JSON.stringify(scriptUrl)});
    const result = verifyModelArtifacts(
      ${JSON.stringify(model)},
      ${JSON.stringify(modelDir)}
    );
    process.stdout.write(JSON.stringify(result));
  `;

  const valid = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", verifyCode],
    {
      env: isolatedModelEnvironment(root),
      encoding: "utf8",
    },
  );
  assert.equal(valid.status, 0);
  assert.deepEqual(JSON.parse(valid.stdout), { ok: true, errors: [] });

  const invalidTokenizer = "{";
  writeFileSync(join(modelDir, "tokenizer.json"), invalidTokenizer);
  model.sha256["tokenizer.json"] = sha256(invalidTokenizer);
  const invalidCode = `
    const { verifyModelArtifacts } = await import(${JSON.stringify(scriptUrl)});
    const result = verifyModelArtifacts(
      ${JSON.stringify(model)},
      ${JSON.stringify(modelDir)}
    );
    process.stdout.write(JSON.stringify(result));
  `;
  const invalid = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", invalidCode],
    {
      env: isolatedModelEnvironment(root),
      encoding: "utf8",
    },
  );

  assert.equal(invalid.status, 0);
  const parsed = JSON.parse(invalid.stdout) as {
    ok: boolean;
    errors: string[];
  };
  assert.equal(parsed.ok, false);
  assert.match(parsed.errors.join("\n"), /tokenizer\.json.*valid JSON/i);
});

test("required model provenance pins immutable revisions and checksums", async () => {
  const module = await import(pathToFileURL(SCRIPT_PATH).href);
  const getProvenance = Reflect.get(module, "getRequiredModelProvenance");
  const getDigest = Reflect.get(module, "getRequiredModelSetDigest");

  assert.equal(typeof getProvenance, "function");
  assert.equal(typeof getDigest, "function");
  if (typeof getProvenance !== "function" || typeof getDigest !== "function") {
    return;
  }

  const provenance = getProvenance() as Array<{
    name: string;
    revision: string;
    files: Array<{
      name: string;
      primary: string;
      fallback: string;
      sha256: string;
    }>;
  }>;
  assert.equal(provenance.length, 2);
  for (const model of provenance) {
    assert.match(model.revision, /^[a-f0-9]{40}$/);
    assert.equal(model.files.length, 3);
    for (const file of model.files) {
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
      assert.match(file.primary, new RegExp(`/resolve/${model.revision}/`));
      assert.doesNotMatch(file.primary, /\/resolve\/main\//);
      assert.match(file.fallback, /\/releases\/assets\/\d+$/);
    }
  }
  assert.match(getDigest(), /^[a-f0-9]{64}$/);
  assert.equal(getDigest(), getDigest());
});
