import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const repositoryRoot = resolve(__dirname, "../../..");
  const fixtureRoot = join(repositoryRoot, "test/e2e/fixtures");
  const tempRoot = mkdtempSync(join(tmpdir(), "mcpp-vscode-e2e-"));
  const userDataDir = join(tempRoot, "user-data");
  const extensionsDir = join(tempRoot, "extensions");
  const workspaceDir = join(tempRoot, "project");
  const fakeMcpp = join(tempRoot, "mcpp");
  const mcppLogPath = join(tempRoot, "mcpp.log");
  const mcpplsLogPath = join(tempRoot, "mcppls.log");
  const mcpplsStub = join(extensionsDir, "sunrisepeak.mcpp-language-server-0.0.0");

  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(extensionsDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(mcpplsStub, { recursive: true });
  copyFileSync(join(fixtureRoot, "fake-mcpp.js"), fakeMcpp);
  chmodSync(fakeMcpp, 0o755);
  copyFileSync(join(fixtureRoot, "mcppls-stub/package.json"), join(mcpplsStub, "package.json"));
  copyFileSync(join(fixtureRoot, "mcppls-stub/extension.js"), join(mcpplsStub, "extension.js"));
  copyFileSync(join(fixtureRoot, "project/mcpp.toml"), join(workspaceDir, "mcpp.toml"));
  copyFileSync(join(fixtureRoot, "project/main.cpp"), join(workspaceDir, "main.cpp"));

  try {
    await runTests({
      version: "1.91.0",
      extensionDevelopmentPath: repositoryRoot,
      extensionTestsPath: join(repositoryRoot, "dist/test/e2e/suite/index.js"),
      launchArgs: [
        workspaceDir,
        "--user-data-dir",
        userDataDir,
        "--extensions-dir",
        extensionsDir,
        "--disable-updates",
        "--skip-welcome",
        "--disable-workspace-trust",
      ],
      extensionTestsEnv: {
        MCPP_E2E_FAKE_MCPP: fakeMcpp,
        MCPP_E2E_LOG: mcppLogPath,
        MCPP_E2E_MCPPLS_LOG: mcpplsLogPath,
      },
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
