// mcpp.toml 依赖补全的数据层：定位 mcpp home 与库索引目录、计算索引缓存键，
// 并通过 `mcpp xpkg parse <file> --json`（官方解析器）提取包候选列表。
// 本模块不依赖 vscode API，也不直接触碰文件系统 / 进程 / 环境变量——所有
// 副作用都通过参数注入，测试用 fake 即可覆盖。

import { createHash } from "node:crypto";
import path from "node:path";

/** 当前已知的 `mcpp xpkg parse --json` 描述符格式版本。 */
export const KNOWN_DESCRIPTOR_FORMAT = 1;

/** loadCandidates 缓存内容的格式标记。 */
export const CANDIDATE_CACHE_FORMAT = 1;

/** resolveMcppHome 的注入接口。 */
export interface ResolveMcppHomeOptions {
  /** 环境变量（通常传 process.env）。 */
  env: Record<string, string | undefined>;
  /** PATH 上找到的 mcpp 可执行文件路径；缺省时跳过自包含布局判断。 */
  mcppExePath?: string;
  /** 解析符号链接（fs.realpathSync 形态）；不允许抛错，失败时返回入参。 */
  realpath: (path: string) => string;
  /** 路径是否存在（目录或文件）。 */
  exists: (path: string) => boolean;
  /** 用户主目录（os.homedir 形态）。 */
  homedir: () => string;
}

/** 递归列出目录下全部文件的路径；目录不存在时返回 []。 */
export type ListFilesFn = (dir: string) => string[];

/** 文件 mtime（毫秒）；文件不存在时返回 undefined。 */
export type MtimeFn = (path: string) => number | undefined;

/** `mcpp xpkg parse <file> --json` 的执行结果。 */
export interface XpkgParseResult {
  exitCode: number;
  stdout: string;
}

/** 注入的解析器执行器；入参是描述符文件路径。 */
export type XpkgParseExecutor = (descriptorFile: string) => Promise<XpkgParseResult>;

/** 一个可补全的包候选。 */
export interface PackageCandidate {
  namespace: string;
  name: string;
  /** "ns.name"；无命名空间时为裸名。 */
  qualifiedName: string;
  /** 三平台版本并集去重：semver 倒序在前，非 semver 按字典序排在最后。 */
  versions: string[];
}

export interface ScanIndexOptions {
  indexDir: string;
  listFiles: ListFilesFn;
  execParse: XpkgParseExecutor;
}

export interface LoadCandidatesOptions extends ScanIndexOptions {
  /** computeIndexCacheKey 算出的缓存键。 */
  cacheKey: string;
  /** 读取缓存原始内容；无缓存返回 undefined。 */
  readCache: () => string | undefined | Promise<string | undefined>;
  /** 写入缓存原始内容；允许抛错（内部吞掉）。 */
  writeCache: (content: string) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// 路径小工具：统一把 \ 规范化为 /，再按 posix 规则处理。Node 在 Windows 上
// 同样接受 / 分隔符，因此模块产出的路径可直接交给 fs。
// ---------------------------------------------------------------------------

function normalizeSep(p: string): string {
  return p.replace(/\\/g, "/");
}

function joinPath(...segments: string[]): string {
  return path.posix.join(...segments.map(normalizeSep));
}

/**
 * 定位 mcpp home 目录。规则依据 mcpp 源码 src/home.cppm 的 root()，顺序严格：
 * 1. 环境变量 MCPP_HOME 非空 → 直接用它；
 * 2. 自包含布局：mcpp 可执行文件（解析符号链接后）位于 <dir>/bin/ 下，
 *    且 <dir> 的祖先路径不含名为 target 的组件（排除 dev 构建
 *    target/<triple>/<fp>/bin/mcpp）、不含 data/xpkgs/ 组合（排除 xlings
 *    包安装 .../data/xpkgs/xim-x-mcpp/<ver>/bin/mcpp），且 <dir>/registry
 *    目录实际存在 → <dir>；
 *    registry 存在性检查是扩展侧补充：PATH 上的 mcpp 可能是 xlings shim，
 *    解析符号链接追到的是 xlings 调度器 ~/.xlings/bin/xlings 而非真实二进制，
 *    无此检查会把 home 错判为 ~/.xlings；
 * 3. 默认 <homedir>/.mcpp（Windows 上 homedir 即 %USERPROFILE%）。
 */
export function resolveMcppHome(opts: ResolveMcppHomeOptions): string {
  const fromEnv = opts.env["MCPP_HOME"];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return normalizeSep(fromEnv);
  }

  if (opts.mcppExePath !== undefined && opts.mcppExePath.length > 0) {
    const real = normalizeSep(opts.realpath(opts.mcppExePath));
    const binDir = path.posix.dirname(real);
    if (path.posix.basename(binDir) === "bin") {
      const candidate = path.posix.dirname(binDir);
      if (!hasDisqualifyingAncestor(candidate) && opts.exists(joinPath(candidate, "registry"))) {
        return candidate;
      }
    }
  }

  return joinPath(opts.homedir(), ".mcpp");
}

/** 与 home.cppm 一致：从 candidate 自身开始向上走（不含根），排除 target 组件与 data/xpkgs 组合。 */
function hasDisqualifyingAncestor(candidate: string): boolean {
  let current = candidate;
  for (;;) {
    const parent = path.posix.dirname(current);
    if (parent === current) {
      return false; // 已到根
    }
    const base = path.posix.basename(current);
    if (base === "target") {
      return true;
    }
    if (base === "xpkgs" && path.posix.basename(parent) === "data") {
      return true;
    }
    current = parent;
  }
}

/** 库索引目录：<home>/registry/data/mcpplibs（src/xlings.cppm 硬编码）。 */
export function mcppLibsIndexDir(home: string): string {
  return joinPath(home, "registry", "data", "mcpplibs");
}

/**
 * 索引缓存键：
 * - 有 .git/FETCH_HEAD → 其 mtime；没有则退到 .git/HEAD 的 mtime；
 * - 无 .git（项目级 path 索引）→ pkgs 下全部 .lua 文件清单 + 各文件 mtime 的摘要。
 */
export function computeIndexCacheKey(indexDir: string, mtimeMs: MtimeFn, listFiles: ListFilesFn): string {
  const fetchHeadMtime = mtimeMs(joinPath(indexDir, ".git", "FETCH_HEAD"));
  if (fetchHeadMtime !== undefined) {
    return `git-fetch-head:${fetchHeadMtime}`;
  }
  const headMtime = mtimeMs(joinPath(indexDir, ".git", "HEAD"));
  if (headMtime !== undefined) {
    return `git-head:${headMtime}`;
  }

  const hash = createHash("sha256");
  const luaFiles = safeListFiles(listFiles, joinPath(indexDir, "pkgs"))
    .filter((file) => file.endsWith(".lua"))
    .sort();
  const prefix = normalizeSep(indexDir) + "/";
  for (const file of luaFiles) {
    const normalized = normalizeSep(file);
    const relative = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
    hash.update(`${relative}:${mtimeMs(file) ?? "?"}\n`);
  }
  return `files:${hash.digest("hex")}`;
}

/** 索引年龄（天）：从 FETCH_HEAD（缺失则 HEAD）的 mtime 到现在；非 git 索引返回 undefined。 */
export function indexAgeDays(indexDir: string, mtimeMs: MtimeFn, nowMs: number = Date.now()): number | undefined {
  const mtime = mtimeMs(joinPath(indexDir, ".git", "FETCH_HEAD")) ?? mtimeMs(joinPath(indexDir, ".git", "HEAD"));
  if (mtime === undefined) {
    return undefined;
  }
  return Math.max(0, Math.floor((nowMs - mtime) / 86_400_000));
}

function safeListFiles(listFiles: ListFilesFn, dir: string): string[] {
  try {
    return listFiles(dir);
  } catch {
    return [];
  }
}

// 严格 semver（不允许前导零，因此 "2026.08.08" 之类日期式版本号算非 semver）。
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** semver 倒序在前；非 semver 排在最后按字典序。 */
export function compareVersions(a: string, b: string): number {
  const matchA = SEMVER_PATTERN.exec(a);
  const matchB = SEMVER_PATTERN.exec(b);
  if (matchA !== null && matchB !== null) {
    for (let index = 1; index <= 3; index += 1) {
      const diff = Number(matchB[index]) - Number(matchA[index]);
      if (diff !== 0) {
        return diff;
      }
    }
    return 0;
  }
  if (matchA !== null) {
    return -1;
  }
  if (matchB !== null) {
    return 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 扫描索引目录：枚举 <indexDir>/pkgs/**\/*.lua，逐文件经 executor 跑
 * `mcpp xpkg parse <file> --json` 并解析输出。
 * 逐字段容错：executor 失败 / 坏 JSON / 缺 name → 跳过该文件不抛错；
 * 若描述符带 format 字段且值未知 → 整体返回空（降级，等扩展升级）。
 */
export async function scanPackageDescriptors(opts: ScanIndexOptions): Promise<PackageCandidate[]> {
  const luaFiles = safeListFiles(opts.listFiles, joinPath(opts.indexDir, "pkgs"))
    .filter((file) => file.endsWith(".lua"))
    .sort();

  const byQualifiedName = new Map<string, { candidate: PackageCandidate; versionSet: Set<string> }>();
  for (const file of luaFiles) {
    const parsed = await parseDescriptor(opts.execParse, file);
    if (parsed === undefined) {
      continue;
    }
    if (parsed.unknownFormat) {
      return [];
    }
    const qualifiedName = parsed.namespace.length > 0 ? `${parsed.namespace}.${parsed.name}` : parsed.name;
    let entry = byQualifiedName.get(qualifiedName);
    if (entry === undefined) {
      entry = {
        candidate: { namespace: parsed.namespace, name: parsed.name, qualifiedName, versions: [] },
        versionSet: new Set(),
      };
      byQualifiedName.set(qualifiedName, entry);
    }
    for (const version of parsed.versions) {
      entry.versionSet.add(version);
    }
  }

  const candidates = [...byQualifiedName.values()].map((entry) => ({
    ...entry.candidate,
    versions: [...entry.versionSet].sort(compareVersions),
  }));
  candidates.sort((a, b) => (a.qualifiedName < b.qualifiedName ? -1 : a.qualifiedName > b.qualifiedName ? 1 : 0));
  return candidates;
}

interface ParsedDescriptor {
  namespace: string;
  name: string;
  versions: string[];
  unknownFormat: boolean;
}

async function parseDescriptor(execParse: XpkgParseExecutor, file: string): Promise<ParsedDescriptor | undefined> {
  let result: XpkgParseResult;
  try {
    result = await execParse(file);
  } catch {
    return undefined;
  }
  if (result.exitCode !== 0) {
    return undefined;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;

  // 未来版本可能加 format 字段；值不认识时整体降级。
  const unknownFormat = obj["format"] !== undefined && obj["format"] !== KNOWN_DESCRIPTOR_FORMAT;

  const name = obj["name"];
  if (typeof name !== "string" || name.length === 0) {
    return undefined;
  }
  const namespaceRaw = obj["namespace"];
  const namespace = typeof namespaceRaw === "string" ? namespaceRaw : "";

  return { namespace, name, versions: collectVersions(obj["versions"]), unknownFormat };
}

/** versions 字段形如 { linux: [...], macosx: [...], windows: [...] }；逐字段容错取并集。 */
function collectVersions(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return [];
  }
  const collected = new Set<string>();
  for (const value of Object.values(raw)) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const item of value) {
      if (typeof item === "string" && item.length > 0) {
        collected.add(item);
      }
    }
  }
  return [...collected];
}

interface CachePayload {
  format: number;
  cacheKey: string;
  candidates: PackageCandidate[];
}

/**
 * 带缓存的候选加载：缓存键匹配且缓存格式认识则直接读缓存，
 * 否则重新扫描并写回缓存。缓存读写失败一律降级为重建，不抛错。
 */
export async function loadCandidates(opts: LoadCandidatesOptions): Promise<PackageCandidate[]> {
  const cached = await readValidCache(opts);
  if (cached !== undefined) {
    return cached;
  }

  const candidates = await scanPackageDescriptors(opts);
  const payload: CachePayload = { format: CANDIDATE_CACHE_FORMAT, cacheKey: opts.cacheKey, candidates };
  try {
    await opts.writeCache(JSON.stringify(payload));
  } catch {
    // 缓存写失败不影响主流程。
  }
  return candidates;
}

async function readValidCache(opts: LoadCandidatesOptions): Promise<PackageCandidate[] | undefined> {
  let content: string | undefined;
  try {
    content = await opts.readCache();
  } catch {
    return undefined;
  }
  if (content === undefined) {
    return undefined;
  }

  let payload: CachePayload;
  try {
    payload = JSON.parse(content) as CachePayload;
  } catch {
    return undefined;
  }
  // 缓存格式不认识或键不匹配：视为未命中，重建。
  if (payload.format !== CANDIDATE_CACHE_FORMAT || payload.cacheKey !== opts.cacheKey) {
    return undefined;
  }
  if (!Array.isArray(payload.candidates)) {
    return undefined;
  }

  // 逐条校验缓存条目，坏条目丢弃。
  const candidates: PackageCandidate[] = [];
  for (const entry of payload.candidates) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof entry.namespace === "string" &&
      typeof entry.name === "string" &&
      typeof entry.qualifiedName === "string" &&
      Array.isArray(entry.versions) &&
      entry.versions.every((version) => typeof version === "string")
    ) {
      candidates.push(entry);
    }
  }
  return candidates;
}
