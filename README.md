<p align="center">
  <img src="images/logo.png" width="160" alt="mcpp 标志">
</p>

# mcpp VS Code 扩展

把 mcpp 工程的构建、运行、测试、工具链管理和 `mcpp.toml` 编辑支持接入 VS Code。

当前版本为 `0.4.0`。C++20/23 模块的诊断、补全、跳转、引用、状态和模块图由
[`sunrisepeak.mcpp-language-server`](https://github.com/Sunrisepeak/mcpp-language-server)
（显示名为 **C++ Modules Language Server**，下文简称 **mcppls**）提供。本扩展不启动第二个
LSP 客户端，也不配置用户安装的 clangd。

> mcppls 会在自己的 payload 中携带固定版本的语义引擎；这不表示 mcpp-vscode 仍依赖官方
> `llvm-vs-code-extensions.vscode-clangd` 扩展，也不表示本扩展读取用户的 `clangd.*` 设置。

## 职责边界

| 能力 | 负责方 |
| --- | --- |
| mcpp 工程发现、`mcpp.toml` 语法与结构补全 | mcpp-vscode |
| build / run / test / clean 任务 | mcpp-vscode |
| mcpp 工具链查看、安装、选择和项目操作 | mcpp-vscode |
| C++ 模块诊断、补全、悬停、定义、引用 | mcppls |
| C++ Modules 状态、模块图、分析上下文和语言服务日志 | mcppls |
| 语言服务冲突与其他 C++ 扩展的管理 | mcppls |

## 安装

从 [GitHub Releases](https://github.com/mcpp-community/mcpp-vscode/releases) 下载本扩展的
VSIX，然后在 VS Code 中执行 **Extensions: Install from VSIX...**，或者运行：

```sh
code --install-extension /path/to/mcpp-vscode-0.4.0.vsix
```

本扩展在 `package.json` 中声明了 `sunrisepeak.mcpp-language-server` 依赖。安装后确认当前
VS Code profile 中同时存在：

```text
mcpp-community.mcpp-vscode
sunrisepeak.mcpp-language-server
```

当前 mcppls 发布包支持 `linux-x64`、`linux-arm64`、`darwin-arm64` 和 `win32-x64`。
在这些平台之外（例如 `darwin-x64`）先确认上游已提供对应 VSIX；本扩展不会把不匹配的
payload 伪装成可用。

## 使用条件

- VS Code `1.91` 或更高版本。
- 包含 `mcpp.toml` 的 mcpp 工程，或从 mcpp-vscode 的新建工程命令创建工程。
- 可执行的 `mcpp`。它可以由 xlings、官方独立安装脚本或其他受支持方式安装。
- mcppls 扩展及其对应平台包。mcppls 自己负责语言服务进程和语义 payload。

`mcpp.path` 只控制 **mcpp-vscode 执行的 mcpp CLI 命令**。它不会跨扩展写入 mcppls 的
启动参数；如果 mcppls 从 PATH 找到的 mcpp 与该设置不同，请分别配置并查看两个输出频道。

## 快速开始

1. 使用 VS Code 打开包含 `mcpp.toml` 的目录。
2. 打开 C++ 源文件，观察 C++ Modules 语言状态项；它由 mcppls 显示当前工程、工具链和降级原因。
3. 执行 **mcpp: 构建**，或在终端运行 `mcpp build`。
4. 构建任务结束后，mcpp-vscode 请求 mcppls 重启并重新读取构建描述。

打开工程本身不会静默执行 `mcpp build`，也不会下载或切换工具链。需要刷新模块语义时，
使用 **mcpp: 刷新模块构建描述** 或 **mcpp: 一键构建并刷新模块语言服务**。

## 已实现功能

### 工程发现与自动激活

- 工作区包含 `mcpp.toml`，或打开 C/C++ 文件时激活。
- 从活动文件或工作区目录查找最近的 mcpp 工程，并支持工作区成员边界。
- 监听 `mcpp.toml` 创建、修改和删除，更新当前工程的快捷菜单与运行/测试按钮。
- 不再监听或解析 `compile_commands.json`，也不再替 mcppls 重启或配置 clangd。
- 只有用户主动执行 mcpp 任务时才启动 mcpp；任务结束后仅对 build 请求 mcppls 刷新。

### 语法高亮与 `mcpp.toml`

- 将精确文件名 `mcpp.toml` 识别为 mcpp TOML 语言。
- 将精确文件名 `build.mcpp` 识别为 mcpp build language，并复用 C++ TextMate grammar。
- `.cppm`、`.ixx`、`.mpp`、`.ccm` 文件继续关联为 C++。
- 注入 `module`、`export module`、`import`、模块名和模块分区语法。
- 为 `mcpp.toml` 提供段头和写法模板补全；建议只覆盖结构，不猜测动态依赖版本。
- 补全清单与当前 mcpp 契约测试同步；已被新版 mcpp 删除的 `[xlings.envs]` 段不再建议。

语法高亮只负责词法着色。错误模块名、不可见声明和跨模块引用诊断由 mcppls 提供。

### 构建、运行与工具链

- 构建、运行、测试、清理 target 使用 VS Code 原生 `ProcessExecution` 和任务终端。
- 同一工程任务互斥；取消不会被误报为成功。
- 工具链列表、安装和全局默认选择继续由 mcpp CLI 决定，本扩展不复制版本解析策略。
- 工具链安装或默认工具链变化不会静默切换语言服务；mcppls 独立读取工程描述。

### C++ Modules 语言服务桥接

本扩展只调用 mcppls 公开的 VS Code 命令：

- 选择 C++ 模块分析上下文：`mcppls.selectContext`
- 重启语言服务：`mcppls.restartServer`
- 查看模块图：`mcppls.showModuleGraph`
- 打开 C++ Modules 日志：`mcppls.showLogs`

build 任务成功后，桥接调用 restart，让 mcppls 重新读取描述。桥接不解析 mcppls 内部 LSP
消息，不读取 `mcppls.*` 设置，也不创建 `vscode-languageclient`。如果依赖未安装或被禁用，
命令会显示明确提示并提供打开扩展搜索的操作，不会静默失败。

## 命令

| 命令 | 作用 |
| --- | --- |
| **mcpp: 打开快捷菜单** | 汇总工程、工具链和 C++ Modules 操作 |
| **mcpp: 新建工程** | 创建并打开新的 mcpp 工程，不自动构建 |
| **mcpp: 构建** | 执行 `mcpp build`；结束后刷新 mcppls |
| **mcpp: 运行 / 测试 / 清理 target** | 执行对应 mcpp 任务 |
| **mcpp: 查看工具链** | 查看 mcpp 报告的工具链状态 |
| **mcpp: 安装工具链** | 通过 mcpp 安装工具链 |
| **mcpp: 选择全局默认工具链** | 修改 mcpp 的全局默认工具链 |
| **mcpp: 选择 C++ 模块分析上下文** | 转发到 mcppls 的上下文选择 |
| **mcpp: 刷新模块构建描述** | 执行 `mcpp build` 并请求 mcppls 重新加载 |
| **mcpp: 重启 C++ Modules 语言服务** | 转发到 `mcppls.restartServer` |
| **mcpp: 查看模块图** | 转发到 `mcppls.showModuleGraph` |
| **mcpp: 打开 C++ Modules 日志** | 转发到 `mcppls.showLogs` |
| **mcpp: 一键构建并刷新模块语言服务** | 一次确认后 build，再刷新 mcppls |

旧的 `mcpp.configureClangd` 命令 ID 暂时保留为弃用别名，行为与“选择 C++ 模块分析上下文”相同；
请把自定义 keybinding 迁移到 `mcpp.configureLanguageServer`。

## 设置

### mcpp-vscode 设置

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `mcpp.path` | 空 | mcpp-vscode 执行 mcpp CLI 时使用的可执行文件；空值表示从 VS Code 的 PATH 查找 |
| `mcpp.tomlCompletion` | `true` | 是否为 `mcpp.toml` 提供结构补全 |

### 迁移后弃用设置

以下旧设置仍保留在 manifest 中，便于旧工作区平滑升级，但 mcpp-vscode 不再读取或写入它们：

- `mcpp.clangd.path`
- `mcpp.modulesSupport`
- `mcpp.configureCppTools`

mcppls 的语言服务、冲突处理和语义引擎设置由 mcppls 自己的 `mcppls.*` 设置管理。不要把
旧 `clangd.*` 工作区设置当作 mcppls 的配置。

## 未受信任工作区

Restricted Mode 下，mcpp-vscode 只提供纯文本的模块语法高亮和 `mcpp.toml` 结构补全，不执行
mcpp CLI，也不接管语言服务配置。mcppls 自身也有受限模式：它不运行工作区指定的构建工具
或编译器，并使用受限的模块索引/语义工具包。

## 故障排查

### C++ Modules 没有出现

1. 确认 mcppls 扩展已安装并启用：

   ```sh
   code --list-extensions --show-versions
   ```

2. 确认当前 VS Code 平台有 mcppls 对应 VSIX。
3. 打开 **C++ Modules** 日志，查看 payload、编译器或工作区信任错误。
4. 确认工作区受信任；未受信任时不会执行 mcpp。

### mcpp 找不到

macOS 从 Dock 或桌面入口启动 VS Code 时，PATH 可能与终端不同。设置 `mcpp.path` 为实际
可执行文件，例如 `/opt/homebrew/bin/mcpp`。该设置只作用于 mcpp-vscode 自己的 CLI 调用。

### mcpp 构建完成但模块描述没有更新

手动执行 **mcpp: 刷新模块构建描述**，或查看 mcppls 日志。build 失败时，mcppls 可能继续使用
最后一次可用描述并显示 degraded；这不等于模块语义一定可用。

### 出现两套 C++ 诊断

mcppls 会提示关闭其他 C++ 扩展的语言功能。可使用 mcppls 提供的
**C++ Modules: Turn Off Other C++ Language Features** 和
**C++ Modules: Restore Other C++ Language Features**。mcpp-vscode 不再自动修改
`C_Cpp.intelliSenseEngine` 或官方 clangd 设置。

### 出现旧 clangd 配置提示

旧 `clangd.*` 和 `mcpp.clangd.*` 设置已不再由 mcpp-vscode 使用。请删除不再需要的设置，
并以 mcppls 的状态、日志和设置为准。

## 开发与验证

```sh
npm ci
npm run compile
npm test
npm run package
npm run test:e2e
```

`npm test` 包含纯 Node 单元测试和真实 mcpp 契约测试；没有 mcpp 时契约测试会跳过。
`npm run test:e2e` 使用隔离的 mcppls stub 验证扩展激活、任务回调和公开命令桥接，不启动真实
LSP。真实 mcppls 语义验证应在安装对应平台 VSIX 的 Extension Development Host 或发布前
验收中执行。

## 发布

先更新 `package.json`、`package-lock.json` 和更新日志中的版本并提交，再推送与扩展版本完全
一致的 tag：

```sh
git tag -a v0.4.0 -m "mcpp-vscode 0.4.0"
git push origin v0.4.0
```

`.github/workflows/release.yml` 会校验 tag、运行测试和打包，生成 VSIX 与 SHA-256 文件，
并创建或更新 GitHub Release。发布前必须在干净 extensions 目录安装 VSIX，确认 mcppls
依赖被自动解析，并记录未覆盖的平台。

项目地址：[mcpp-community/mcpp-vscode](https://github.com/mcpp-community/mcpp-vscode)

问题反馈：[GitHub Issues](https://github.com/mcpp-community/mcpp-vscode/issues)
