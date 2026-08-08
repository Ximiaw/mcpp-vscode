import assert from "node:assert/strict";
import test from "node:test";

import {
  computeMcppTomlCompletions,
  type McppTomlCompletionData,
  type McppTomlSuggestion,
} from "../src/mcppTomlCompletion";
import type { PackageCandidate } from "../src/mcppTomlIndex";

const PACKAGES: readonly PackageCandidate[] = [
  { namespace: "compat", name: "zlib", qualifiedName: "compat.zlib", versions: ["1.3.2"] },
  { namespace: "mcpplibs", name: "cmdline", qualifiedName: "mcpplibs.cmdline", versions: ["0.0.2", "0.0.1"] },
  { namespace: "mcpplibs.capi", name: "lua", qualifiedName: "mcpplibs.capi.lua", versions: ["0.0.3"] },
];

const DATA: McppTomlCompletionData = { packages: PACKAGES };

function labels(suggestions: McppTomlSuggestion[]): string[] {
  return suggestions.map((suggestion) => suggestion.label);
}

test("suggests section headers on a partial bracket line", () => {
  const suggestions = computeMcppTomlCompletions(["[dep"], 0, 4);
  assert.ok(suggestions.length > 0);
  assert.ok(suggestions.every((suggestion) => suggestion.kind === "section"));
  assert.ok(labels(suggestions).includes("[dependencies]"));
  assert.ok(labels(suggestions).includes("[workspace]"));
  // 每条建议都带显式替换范围（覆盖已输入的 "[dep"）。
  for (const suggestion of suggestions) {
    assert.deepEqual(suggestion.range, { startCharacter: 0, endCharacter: 4 });
  }
  // 参数化段插入 snippet。
  const targets = suggestions.find((suggestion) => suggestion.label === "[targets.<name>]");
  assert.equal(targets?.insertSnippet, "[targets.${1:name}]");
});

test("suggests section headers at the top of the document", () => {
  const suggestions = computeMcppTomlCompletions([""], 0, 0);
  assert.ok(suggestions.length > 0);
  assert.ok(suggestions.every((suggestion) => suggestion.kind === "section"));
});

test("offers nothing in unknown sections", () => {
  // 附录 A：不支持包自定义 toml 键；未知段不提供任何建议。
  assert.deepEqual(computeMcppTomlCompletions(["[mytool]", ""], 1, 0), []);
  assert.deepEqual(computeMcppTomlCompletions(["[mytool]", "key = "], 1, 6), []);
});

test("offers no static field keys (removed, waiting for upstream schema)", () => {
  // 静态字段键/枚举刻意不做：等上游版本化 manifest schema。
  assert.deepEqual(computeMcppTomlCompletions(["[package]", ""], 1, 0), []);
  assert.deepEqual(computeMcppTomlCompletions(["[package]", "standard = "], 1, 11), []);
  assert.deepEqual(computeMcppTomlCompletions(["[targets.app]", "kind = "], 1, 7), []);
});

test("suggests packages and templates in dependency sections", () => {
  const suggestions = computeMcppTomlCompletions(["[dependencies]", ""], 1, 0, DATA);
  const names = labels(suggestions);
  assert.ok(names.includes("compat.zlib"));
  assert.ok(names.includes("mcpplibs.cmdline"));
  assert.ok(names.includes('name = "version"')); // 写法模板
  const zlib = suggestions.find((suggestion) => suggestion.label === "compat.zlib");
  assert.equal(zlib?.kind, "package");
  assert.equal(zlib?.insertSnippet, 'compat.zlib = "1.3.2"');
  assert.deepEqual(zlib?.range, { startCharacter: 0, endCharacter: 0 });
});

test("suggests packages in conditional dependency sections", () => {
  const suggestions = computeMcppTomlCompletions(
    ["[target.'cfg(windows)'.dependencies]", ""],
    1,
    0,
    DATA,
  );
  assert.ok(labels(suggestions).includes("compat.zlib"));
});

test("works without index data (structural suggestions only)", () => {
  const suggestions = computeMcppTomlCompletions(["[dependencies]", ""], 1, 0);
  assert.ok(suggestions.length > 0);
  assert.ok(suggestions.every((suggestion) => suggestion.kind === "template"));
});

test("suggests versions at dependency value position", () => {
  const suggestions = computeMcppTomlCompletions(["[dependencies]", "cmdline = "], 1, 11, DATA);
  // 裸名按解析阶梯匹配到 mcpplibs.cmdline。
  assert.deepEqual(labels(suggestions), ["0.0.2", "0.0.1"]);
  // 光标不在字符串内：带引号插入。
  assert.equal(suggestions[0].insertSnippet, '"0.0.2"');
});

test("does not double-quote versions inside a string", () => {
  const suggestions = computeMcppTomlCompletions(["[dependencies]", 'cmdline = "0.'], 1, 13, DATA);
  assert.equal(suggestions[0].insertSnippet, "0.0.2");
});

test("matches dotted selector keys to qualified names", () => {
  const suggestions = computeMcppTomlCompletions(["[dependencies]", '"mcpplibs.capi.lua" = "'], 1, 22, DATA);
  assert.deepEqual(labels(suggestions), ["0.0.3"]);
});

test("offers no versions for unknown packages or free-form values", () => {
  assert.deepEqual(computeMcppTomlCompletions(["[dependencies]", 'nosuchpkg = "'], 1, 12, DATA), []);
  assert.deepEqual(computeMcppTomlCompletions(["[package]", 'name = "'], 1, 7, DATA), []);
});

test("annotates stale index in package details", () => {
  const fresh = computeMcppTomlCompletions(["[dependencies]", ""], 1, 0, {
    packages: PACKAGES,
    indexAgeDays: 3,
    staleThresholdDays: 30,
  });
  const freshZlib = fresh.find((suggestion) => suggestion.label === "compat.zlib");
  assert.equal(freshZlib?.detail, "compat · 索引 3 天前更新");

  const stale = computeMcppTomlCompletions(["[dependencies]", ""], 1, 0, {
    packages: PACKAGES,
    indexAgeDays: 45,
    staleThresholdDays: 30,
  });
  const staleZlib = stale.find((suggestion) => suggestion.label === "compat.zlib");
  assert.match(staleZlib?.detail ?? "", /45 天前更新（较旧，可运行 mcpp index update 刷新）/);

  // 阈值 0 = 关闭提示。
  const silent = computeMcppTomlCompletions(["[dependencies]", ""], 1, 0, {
    packages: PACKAGES,
    indexAgeDays: 45,
    staleThresholdDays: 0,
  });
  const silentZlib = silent.find((suggestion) => suggestion.label === "compat.zlib");
  assert.equal(silentZlib?.detail, "compat · 索引 45 天前更新");
});

test("suggests templates in free-key sections", () => {
  const features = computeMcppTomlCompletions(["[features]", ""], 1, 0);
  assert.ok(features.every((suggestion) => suggestion.kind === "template"));
  assert.ok(labels(features).includes("name = { defines = [...] }"));

  const capabilities = computeMcppTomlCompletions(["[capabilities]", ""], 1, 0);
  assert.ok(labels(capabilities).includes('capability = "provider"'));
});

test("replacement range covers a partially typed key", () => {
  const suggestions = computeMcppTomlCompletions(["[dependencies]", "com"], 1, 3, DATA);
  const zlib = suggestions.find((suggestion) => suggestion.label === "compat.zlib");
  assert.deepEqual(zlib?.range, { startCharacter: 0, endCharacter: 3 });
});
