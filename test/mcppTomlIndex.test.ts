import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CANDIDATE_CACHE_FORMAT,
  KNOWN_DESCRIPTOR_FORMAT,
  compareVersions,
  computeIndexCacheKey,
  indexAgeDays,
  loadCandidates,
  mcppLibsIndexDir,
  resolveMcppHome,
  scanPackageDescriptors,
  type LoadCandidatesOptions,
  type PackageCandidate,
  type ResolveMcppHomeOptions,
  type XpkgParseResult,
} from "../src/mcppTomlIndex";

// ---------------------------------------------------------------------------
// 临时目录 fixture 与真实 fs 探针
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "mcpp-toml-index-"));
}

function writeFile(root: string, relative: string, content: string): string {
  const full = join(root, ...relative.split("/"));
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  return full;
}

function setMtime(path: string, ms: number): void {
  const date = new Date(ms);
  utimesSync(path, date, date);
}

function realMtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function realListFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        out.push(full);
      }
    }
  };
  try {
    walk(dir);
  } catch {
    // 目录不存在
  }
  return out;
}

// ---------------------------------------------------------------------------
// fake：resolveMcppHome 注入与 xpkg parse executor
// ---------------------------------------------------------------------------

function homeOptions(overrides: Partial<ResolveMcppHomeOptions>): ResolveMcppHomeOptions {
  return {
    env: {},
    realpath: (path) => path,
    exists: () => false,
    homedir: () => "/home/user",
    ...overrides,
  };
}

type FakeExecutor = ((file: string) => Promise<XpkgParseResult>) & { calls: string[] };

/** responses：文件 basename → 输出 JSON 对象 / 原始字符串 / Error / 非零退出。 */
function fakeExecutor(
  responses: Record<string, unknown>,
): FakeExecutor {
  const calls: string[] = [];
  const executor = async (file: string): Promise<XpkgParseResult> => {
    calls.push(file);
    const key = file.split("/").pop() ?? file;
    const response = responses[key];
    if (response instanceof Error) {
      throw response;
    }
    if (response === undefined) {
      return { exitCode: 1, stdout: "" };
    }
    if (typeof response === "string") {
      return { exitCode: 0, stdout: response };
    }
    return { exitCode: 0, stdout: JSON.stringify(response) };
  };
  executor.calls = calls;
  return executor;
}

// ---------------------------------------------------------------------------
// resolveMcppHome
// ---------------------------------------------------------------------------

test("resolveMcppHome: MCPP_HOME 优先于其他规则", () => {
  const home = resolveMcppHome(homeOptions({
    env: { MCPP_HOME: "/custom/home" },
    mcppExePath: "/opt/mcpp/bin/mcpp",
    exists: () => true,
  }));
  assert.equal(home, "/custom/home");
});

test("resolveMcppHome: 空 MCPP_HOME 视为未设置", () => {
  const home = resolveMcppHome(homeOptions({ env: { MCPP_HOME: "" } }));
  assert.equal(home, "/home/user/.mcpp");
});

test("resolveMcppHome: 自包含布局命中（<dir>/bin + registry 存在）", () => {
  const home = resolveMcppHome(homeOptions({
    mcppExePath: "/opt/mcpp/bin/mcpp",
    exists: (path) => path === "/opt/mcpp/registry",
  }));
  assert.equal(home, "/opt/mcpp");
});

test("resolveMcppHome: 解析符号链接后再判断 bin 布局", () => {
  const home = resolveMcppHome(homeOptions({
    mcppExePath: "/usr/local/bin/mcpp",
    realpath: () => "/opt/mcpp/bin/mcpp",
    exists: (path) => path === "/opt/mcpp/registry",
  }));
  assert.equal(home, "/opt/mcpp");
});

test("resolveMcppHome: target 祖先排除 dev 构建布局", () => {
  const home = resolveMcppHome(homeOptions({
    mcppExePath: "/home/dev/mcpp/target/x86_64-linux-gnu/abc123/bin/mcpp",
    exists: () => true,
  }));
  assert.equal(home, "/home/user/.mcpp");
});

test("resolveMcppHome: data/xpkgs 祖先排除 xlings 包安装", () => {
  const home = resolveMcppHome(homeOptions({
    mcppExePath: "/home/u/.xlings/data/xpkgs/xim-x-mcpp/0.2.5/bin/mcpp",
    exists: () => true,
  }));
  assert.equal(home, "/home/user/.mcpp");
});

test("resolveMcppHome: registry 不存在时 shim 回退默认 home", () => {
  // PATH 上的 mcpp 是 xlings shim，realpath 追到 ~/.xlings/bin/xlings。
  const home = resolveMcppHome(homeOptions({
    mcppExePath: "/usr/bin/mcpp",
    realpath: () => "/home/u/.xlings/bin/xlings",
    exists: () => false,
  }));
  assert.equal(home, "/home/user/.mcpp");
});

test("resolveMcppHome: 无可执行文件信息时默认 ~/.mcpp", () => {
  const home = resolveMcppHome(homeOptions({}));
  assert.equal(home, "/home/user/.mcpp");
});

test("resolveMcppHome: 可执行文件不在 bin/ 下时默认 home", () => {
  const home = resolveMcppHome(homeOptions({
    mcppExePath: "/opt/mcpp/libexec/mcpp",
    exists: () => true,
  }));
  assert.equal(home, "/home/user/.mcpp");
});

test("resolveMcppHome: Windows 反斜杠路径形态", () => {
  const home = resolveMcppHome(homeOptions({
    mcppExePath: "C:\\tools\\mcpp\\bin\\mcpp.exe",
    exists: (path) => path === "C:/tools/mcpp/registry",
  }));
  assert.equal(home, "C:/tools/mcpp");

  const fallback = resolveMcppHome(homeOptions({
    homedir: () => "C:\\Users\\ximi",
  }));
  assert.equal(fallback, "C:/Users/ximi/.mcpp");
});

test("resolveMcppHome: Windows 正斜杠路径形态同样命中", () => {
  const home = resolveMcppHome(homeOptions({
    mcppExePath: "C:/tools/mcpp/bin/mcpp.exe",
    exists: (path) => path === "C:/tools/mcpp/registry",
  }));
  assert.equal(home, "C:/tools/mcpp");
});

test("mcppLibsIndexDir: 拼出 registry/data/mcpplibs", () => {
  assert.equal(mcppLibsIndexDir("/home/user/.mcpp"), "/home/user/.mcpp/registry/data/mcpplibs");
});

// ---------------------------------------------------------------------------
// 缓存键与索引年龄
// ---------------------------------------------------------------------------

test("computeIndexCacheKey: 有 .git 时用 FETCH_HEAD 的 mtime", () => {
  const dir = makeTmpDir();
  try {
    const fetchHead = writeFile(dir, ".git/FETCH_HEAD", "abc\n");
    writeFile(dir, ".git/HEAD", "ref: refs/heads/main\n");
    setMtime(fetchHead, 1_700_000_000_000);
    const key = computeIndexCacheKey(dir, realMtimeMs, realListFiles);
    assert.ok(key.startsWith(`${dir}:git-fetch-head:1700000000`), key);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computeIndexCacheKey: 无 FETCH_HEAD 时退到 HEAD", () => {
  const dir = makeTmpDir();
  try {
    const head = writeFile(dir, ".git/HEAD", "ref: refs/heads/main\n");
    setMtime(head, 1_700_000_000_000);
    const key = computeIndexCacheKey(dir, realMtimeMs, realListFiles);
    assert.ok(key.startsWith(`${dir}:git-head:1700000000`), key);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computeIndexCacheKey: 键含索引路径，不同目录相同 mtime 不碰撞", () => {
  const dirA = makeTmpDir();
  const dirB = makeTmpDir();
  try {
    // git 分支：两个索引的 FETCH_HEAD mtime 完全相同。
    for (const dir of [dirA, dirB]) {
      const fetchHead = writeFile(dir, ".git/FETCH_HEAD", "abc\n");
      setMtime(fetchHead, 1_700_000_000_000);
    }
    assert.notEqual(
      computeIndexCacheKey(dirA, realMtimeMs, realListFiles),
      computeIndexCacheKey(dirB, realMtimeMs, realListFiles),
    );
    // files 分支：同样的文件清单与 mtime。
    for (const dir of [dirA, dirB]) {
      rmSync(join(dir, ".git"), { recursive: true, force: true });
      const lua = writeFile(dir, "pkgs/z/zlib.lua", "package('zlib')\n");
      setMtime(lua, 1_700_000_000_000);
    }
    assert.notEqual(
      computeIndexCacheKey(dirA, realMtimeMs, realListFiles),
      computeIndexCacheKey(dirB, realMtimeMs, realListFiles),
    );
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("computeIndexCacheKey: 无 .git 时用 pkgs 文件清单摘要，内容变化键变化", () => {
  const dir = makeTmpDir();
  try {
    writeFile(dir, "pkgs/z/zlib.lua", "package('zlib')\n");
    const key1 = computeIndexCacheKey(dir, realMtimeMs, realListFiles);
    assert.ok(key1.startsWith(`${dir}:`), key1);
    assert.match(key1, /:files:[0-9a-f]{64}$/);

    // 新增描述符 → 键变化
    writeFile(dir, "pkgs/o/openssl.lua", "package('openssl')\n");
    const key2 = computeIndexCacheKey(dir, realMtimeMs, realListFiles);
    assert.notEqual(key2, key1);

    // 仅 mtime 变化 → 键也变化
    writeFile(dir, "pkgs/z/zlib.lua", "package('zlib') -- touched\n");
    setMtime(join(dir, "pkgs/z/zlib.lua"), 1_800_000_000_000);
    const key3 = computeIndexCacheKey(dir, realMtimeMs, realListFiles);
    assert.notEqual(key3, key2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computeIndexCacheKey: FETCH_HEAD mtime 变化导致键变化", () => {
  const dir = makeTmpDir();
  try {
    const fetchHead = writeFile(dir, ".git/FETCH_HEAD", "abc\n");
    setMtime(fetchHead, 1_700_000_000_000);
    const key1 = computeIndexCacheKey(dir, realMtimeMs, realListFiles);
    setMtime(fetchHead, 1_700_100_000_000);
    const key2 = computeIndexCacheKey(dir, realMtimeMs, realListFiles);
    assert.notEqual(key1, key2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("indexAgeDays: 按 FETCH_HEAD mtime 计算年龄", () => {
  const dir = makeTmpDir();
  try {
    const fetchHead = writeFile(dir, ".git/FETCH_HEAD", "abc\n");
    const now = 1_700_000_000_000;
    setMtime(fetchHead, now - 3.5 * 86_400_000);
    assert.equal(indexAgeDays(dir, realMtimeMs, now), 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("indexAgeDays: 非 git 索引返回 undefined", () => {
  const dir = makeTmpDir();
  try {
    writeFile(dir, "pkgs/z/zlib.lua", "package('zlib')\n");
    assert.equal(indexAgeDays(dir, realMtimeMs), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 描述符扫描
// ---------------------------------------------------------------------------

test("scanPackageDescriptors: 正常输出，qualifiedName 与版本并集 semver 倒序", async () => {
  const executor = fakeExecutor({
    "zlib.lua": {
      namespace: "compat",
      name: "zlib",
      versions: { linux: ["1.3.2", "1.10.0"], macosx: ["1.3.2"], windows: ["2.0.0"] },
      standard: "c++23",
      targets: ["zlib"],
      unknown_keys: [],
    },
  });
  const candidates = await scanPackageDescriptors({
    indexDir: "/idx",
    listFiles: () => ["/idx/pkgs/z/zlib.lua"],
    execParse: executor,
  });
  assert.equal(executor.calls.length, 1);
  assert.deepEqual(candidates, [{
    namespace: "compat",
    name: "zlib",
    qualifiedName: "compat.zlib",
    versions: ["2.0.0", "1.10.0", "1.3.2"],
  }]);
});

test("scanPackageDescriptors: 教学仓最小输出（无 versions）", async () => {
  const executor = fakeExecutor({
    "mcpp-start.lua": { namespace: "", name: "mcpp-start", form: "A" },
  });
  const candidates = await scanPackageDescriptors({
    indexDir: "/idx",
    listFiles: () => ["/idx/pkgs/m/mcpp-start.lua"],
    execParse: executor,
  });
  assert.deepEqual(candidates, [{
    namespace: "",
    name: "mcpp-start",
    qualifiedName: "mcpp-start",
    versions: [],
  }]);
});

test("scanPackageDescriptors: 坏 JSON / 执行失败 / 缺 name 的文件被跳过", async () => {
  const executor = fakeExecutor({
    "bad.lua": "{not json",
    "fail.lua": new Error("spawn failed"),
    "noname.lua": { namespace: "compat" },
    "exit1.lua": undefined, // 未登记 → fake 返回 exitCode 1
    "good.lua": { namespace: "", name: "ok", versions: { linux: ["1.0.0"] } },
  });
  const candidates = await scanPackageDescriptors({
    indexDir: "/idx",
    listFiles: () => [
      "/idx/pkgs/b/bad.lua",
      "/idx/pkgs/e/exit1.lua",
      "/idx/pkgs/f/fail.lua",
      "/idx/pkgs/g/good.lua",
      "/idx/pkgs/n/noname.lua",
    ],
    execParse: executor,
  });
  assert.deepEqual(candidates.map((candidate) => candidate.qualifiedName), ["ok"]);
});

test("scanPackageDescriptors: 缺 versions 字段视为空版本列表", async () => {
  const executor = fakeExecutor({
    "a.lua": { namespace: "ns", name: "a" },
  });
  const candidates = await scanPackageDescriptors({
    indexDir: "/idx",
    listFiles: () => ["/idx/pkgs/a/a.lua"],
    execParse: executor,
  });
  assert.deepEqual(candidates[0]?.versions, []);
});

test("scanPackageDescriptors: 未知 format 字段整体降级为空", async () => {
  const executor = fakeExecutor({
    "new.lua": { format: KNOWN_DESCRIPTOR_FORMAT + 1, namespace: "", name: "new", versions: { linux: ["1.0.0"] } },
    "old.lua": { namespace: "", name: "old", versions: { linux: ["1.0.0"] } },
  });
  const candidates = await scanPackageDescriptors({
    indexDir: "/idx",
    listFiles: () => ["/idx/pkgs/n/new.lua", "/idx/pkgs/o/old.lua"],
    execParse: executor,
  });
  assert.deepEqual(candidates, []);
});

test("scanPackageDescriptors: 已知 format 字段正常解析", async () => {
  const executor = fakeExecutor({
    "a.lua": { format: KNOWN_DESCRIPTOR_FORMAT, namespace: "", name: "a", versions: { linux: ["1.0.0"] } },
  });
  const candidates = await scanPackageDescriptors({
    indexDir: "/idx",
    listFiles: () => ["/idx/pkgs/a/a.lua"],
    execParse: executor,
  });
  assert.deepEqual(candidates.map((candidate) => candidate.qualifiedName), ["a"]);
});

test("scanPackageDescriptors: 非 semver 版本排最后按字典序", async () => {
  const executor = fakeExecutor({
    "a.lua": {
      namespace: "",
      name: "a",
      versions: { linux: ["2026.08.08", "1.2.0", "2025.01.01", "10.0.0"] },
    },
  });
  const candidates = await scanPackageDescriptors({
    indexDir: "/idx",
    listFiles: () => ["/idx/pkgs/a/a.lua"],
    execParse: executor,
  });
  assert.deepEqual(candidates[0]?.versions, ["10.0.0", "1.2.0", "2025.01.01", "2026.08.08"]);
});

test("scanPackageDescriptors: 多文件同名包合并版本并去重", async () => {
  const executor = fakeExecutor({
    "a.lua": { namespace: "ns", name: "dup", versions: { linux: ["1.0.0", "2.0.0"] } },
    "b.lua": { namespace: "ns", name: "dup", versions: { windows: ["2.0.0", "3.0.0"] } },
  });
  const candidates = await scanPackageDescriptors({
    indexDir: "/idx",
    listFiles: () => ["/idx/pkgs/a/a.lua", "/idx/pkgs/b/b.lua"],
    execParse: executor,
  });
  assert.deepEqual(candidates, [{
    namespace: "ns",
    name: "dup",
    qualifiedName: "ns.dup",
    versions: ["3.0.0", "2.0.0", "1.0.0"],
  }]);
});

test("compareVersions: semver 数值比较而非字典序", () => {
  assert.ok(compareVersions("1.10.0", "1.3.2") < 0);
  assert.ok(compareVersions("2.0.0", "10.0.0") > 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
});

// ---------------------------------------------------------------------------
// 缓存命中 / 失效
// ---------------------------------------------------------------------------

function loadOptions(overrides: Partial<LoadCandidatesOptions>): LoadCandidatesOptions {
  return {
    indexDir: "/idx",
    cacheKey: "key-1",
    listFiles: () => [],
    execParse: fakeExecutor({}),
    readCache: () => undefined,
    writeCache: () => {},
    ...overrides,
  };
}

function cachePayload(cacheKey: string, candidates: PackageCandidate[]): string {
  return JSON.stringify({ format: CANDIDATE_CACHE_FORMAT, cacheKey, candidates });
}

test("loadCandidates: 缓存键匹配时直接读缓存，不执行 executor", async () => {
  const cached: PackageCandidate[] = [{
    namespace: "compat",
    name: "zlib",
    qualifiedName: "compat.zlib",
    versions: ["1.3.2"],
  }];
  const executor = fakeExecutor({});
  const candidates = await loadCandidates(loadOptions({
    execParse: executor,
    readCache: () => cachePayload("key-1", cached),
  }));
  assert.deepEqual(candidates, cached);
  assert.equal(executor.calls.length, 0);
});

test("loadCandidates: 缓存键不匹配时重建并写回", async () => {
  const writes: string[] = [];
  const executor = fakeExecutor({
    "zlib.lua": { namespace: "compat", name: "zlib", versions: { linux: ["1.3.2"] } },
  });
  const candidates = await loadCandidates(loadOptions({
    listFiles: () => ["/idx/pkgs/z/zlib.lua"],
    execParse: executor,
    readCache: () => cachePayload("old-key", []),
    writeCache: (content) => { writes.push(content); },
  }));
  assert.equal(executor.calls.length, 1);
  assert.deepEqual(candidates.map((candidate) => candidate.qualifiedName), ["compat.zlib"]);
  assert.equal(writes.length, 1);
  const payload = JSON.parse(writes[0]) as { format: number; cacheKey: string; candidates: PackageCandidate[] };
  assert.equal(payload.format, CANDIDATE_CACHE_FORMAT);
  assert.equal(payload.cacheKey, "key-1");
  assert.deepEqual(payload.candidates, candidates);
});

test("loadCandidates: 无缓存时扫描并写回", async () => {
  const writes: string[] = [];
  const executor = fakeExecutor({
    "a.lua": { namespace: "", name: "a" },
  });
  const candidates = await loadCandidates(loadOptions({
    listFiles: () => ["/idx/pkgs/a/a.lua"],
    execParse: executor,
    writeCache: (content) => { writes.push(content); },
  }));
  assert.deepEqual(candidates.map((candidate) => candidate.qualifiedName), ["a"]);
  assert.equal(writes.length, 1);
});

test("loadCandidates: 缓存内容损坏时重建", async () => {
  const executor = fakeExecutor({
    "a.lua": { namespace: "", name: "a" },
  });
  const candidates = await loadCandidates(loadOptions({
    listFiles: () => ["/idx/pkgs/a/a.lua"],
    execParse: executor,
    readCache: () => "{corrupted",
  }));
  assert.equal(executor.calls.length, 1);
  assert.deepEqual(candidates.map((candidate) => candidate.qualifiedName), ["a"]);
});

test("loadCandidates: 未知缓存格式视为未命中", async () => {
  const executor = fakeExecutor({
    "a.lua": { namespace: "", name: "a" },
  });
  const candidates = await loadCandidates(loadOptions({
    listFiles: () => ["/idx/pkgs/a/a.lua"],
    execParse: executor,
    readCache: () => JSON.stringify({ format: CANDIDATE_CACHE_FORMAT + 1, cacheKey: "key-1", candidates: [] }),
  }));
  assert.equal(executor.calls.length, 1);
  assert.deepEqual(candidates.map((candidate) => candidate.qualifiedName), ["a"]);
});

test("loadCandidates: 缓存写失败不影响返回结果", async () => {
  const executor = fakeExecutor({
    "a.lua": { namespace: "", name: "a" },
  });
  const candidates = await loadCandidates(loadOptions({
    listFiles: () => ["/idx/pkgs/a/a.lua"],
    execParse: executor,
    writeCache: () => { throw new Error("disk full"); },
  }));
  assert.deepEqual(candidates.map((candidate) => candidate.qualifiedName), ["a"]);
});

test("loadCandidates: 空扫描结果不写缓存，修复后重试可恢复", async () => {
  const writes: string[] = [];
  const listFiles = () => ["/idx/pkgs/a/a.lua"];
  // 第一次：mcpp 损坏，executor 全部失败 → 空结果，且不落盘。
  const broken = fakeExecutor({ "a.lua": new Error("spawn mcpp ENOENT") });
  const first = await loadCandidates(loadOptions({
    listFiles,
    execParse: broken,
    writeCache: (content) => { writes.push(content); },
  }));
  assert.deepEqual(first, []);
  assert.equal(writes.length, 0);

  // 第二次：mcpp 修好，无缓存可读（readCache 仍返回 undefined）→ 重扫成功并写回。
  const fixed = fakeExecutor({ "a.lua": { namespace: "", name: "a" } });
  const second = await loadCandidates(loadOptions({
    listFiles,
    execParse: fixed,
    writeCache: (content) => { writes.push(content); },
  }));
  assert.deepEqual(second.map((candidate) => candidate.qualifiedName), ["a"]);
  assert.equal(writes.length, 1);
});
