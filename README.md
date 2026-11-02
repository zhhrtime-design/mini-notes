# Mini Notes with LLM Summary（Anna App）

一个本地运行的 Anna App：创建 / 查看 / 删除笔记，笔记通过 `anna.storage.*` 持久化；点击 **Summarize** 后，前端通过 `anna.tools.invoke` 调用本地 Executa Tool，Tool 内部发起反向 JSON-RPC `sampling/createMessage` 借用 host LLM 生成总结。

```
Anna App iframe
  -> AnnaAppRuntime.connect()
  -> anna.storage.get / set            保存、读取 notes
  -> anna.tools.invoke(...)
  -> Executa Tool: invoke              (stdin/stdout JSON-RPC 2.0)
  -> reverse JSON-RPC sampling/createMessage
  -> host LLM（或本地 mock sampling fixture）
  -> summary 返回 UI
```

> **验证状态说明（请先读）**
> 2026-11-02 在 Windows 本机使用 **Anna CLI 0.1.63 / schema 0.32.0 / Python runtime 0.2.0a32** 补验：`anna-app validate --strict`、`anna-app dev --no-llm` 和 `anna-app executa dev --mock-sampling` 均已实际运行。真实 harness UI 验收也已通过；详情和限制见 `VERIFICATION_2026-11-02.md`。
> 已修复缺失的 `app.json` bundled 映射、发布 tool-id sidecar 加载、harness reverse sampling 的 `llm.complete` 授权，以及 Windows UI 测试路径和点击计数竞态。Go 普通单测 11/11、协议 23/23、前端单测 11/11、两种 UI 测试及三平台打包通过；本机 `-race` 因缺少 CGO 工具链未运行成功。GitHub 发布及 macOS 原生运行仍待验证。

## 1. 项目结构

```
manifest.json                       Anna App manifest（schema 3）
app.json                            bundled_executas handle -> 项目路径，供 dev/publish 解析
package.json / tsconfig*.json       包管理、构建与测试脚本
src/                                前端源码（TypeScript）
  config.ts                         TOOL_SLUG / TOOL_METHOD / STORAGE_KEY，唯一常量来源
  anna/runtime.ts                   AnnaAppRuntime.connect()
  anna/audit.ts                     记录每一次 Host API 调用（证据面板 + console）
  anna/types.ts                     用到的 Host API 类型
  storage/notesStore.ts             只通过 anna.storage.get/set 读写 notes
  tools/summarizer.ts               anna.tools.invoke 封装，不生成任何 summary
  ui/view.ts  main.ts               渲染与事件
  index.html  styles.css
bundle/                             构建产物（manifest.ui.bundle.entry 指向 bundle/index.html）
tests/                              前端单测
executas/mini-notes-summarizer/     Executa Tool（Go）
  main.go protocol.go sampling.go manifest.go summarize.go main_test.go
  VERSION                           发布版本的唯一来源
  executa.json                      本地开发启动配置（go run .）
  fixtures/sampling.jsonl           --mock-sampling 使用的 fixture
scripts/
  build.mjs                         esbuild 构建 bundle
  check-consistency.mjs             校验 tool 身份在各处一致
  protocol-test.mjs                 手动/CI 协议测试（initialize/describe/invoke + 反向 sampling）
  e2e-ui.mjs                        浏览器端到端测试（Playwright）
  package_executa.py                三平台二进制打包 + 归档校验
.github/workflows/                  release-executa.yml（发布）、ci.yml
```

## 2. 安装依赖

需要：Node.js >= 22（CLI 0.1.63 要求）、Go >= 1.21、打包脚本 Python >= 3.9。真实 UI harness 另需 uv/uvx 及 runtime 支持的 Python（本轮使用 3.11）。

```bash
npm install                      # esbuild、typescript、@types/node
npm install -g @anna-ai/cli@0.1.63 # 本轮实测版本；提供 anna-app 命令
```

## 3. 构建前端 bundle

```bash
npm run build                    # => bundle/index.html、app.js、style.css
npm run typecheck
npm test                         # 前端单测（node:test）
npm run check:consistency        # manifest / config.ts / executa.json / Go describe 的 tool 身份一致
```

bundle 不含内联脚本（CSP `script-src 'self'`）。`manifest.json` 的 `ui.bundle.entry` 为 `index.html`，相对构建产物目录 `bundle/`。HTML 在 app.js 前加载 `anna-tool-ids.js`：本地构建写入 dev id，`anna-app apps publish` 会用服务器生成的 id 覆盖 sidecar。发布后不要再次 build 覆盖该文件。

## 4. 校验 manifest

```bash
npm run build && anna-app validate --strict
```

## 5. 用 `anna-app dev --no-llm` 测试 UI harness

```bash
npm run build
npm run dev                      # 等价于 anna-app dev --no-llm
```

在 harness 打开的 App 里：

1. 输入文字点 **Add**；空输入不会保存并有提示；保存后输入框清空。
2. 列表显示 `#序号`、内容、时间；点 **Delete** 立即更新列表。
3. 页面底部 **Host API activity** 面板逐条列出 `storage.get` / `storage.set` / `tools.invoke`，浏览器控制台同样输出 `[anna-call] ...`。
4. 点 **Summarize**：见下一节。

legacy in-memory runtime_state 只用于无 login 调试，刷新外层 dashboard 或重启 dev 后 notes 不保留，这是预期行为。

真实 harness 自动验收：先运行 `npm run dev`，另开终端安装 `npm install --no-save playwright` 后运行 `node scripts/e2e-anna.mjs`。默认使用已安装的 Edge，可用 `PLAYWRIGHT_CHANNEL` 改为 `chrome`。该测试会创建、删除验收笔记，请使用空白 dev 会话。

`app.json.bundled_executas` 将 `bundled:mini-notes-summarizer` 解析到开发 tool id；缺少此文件时即使 strict validate 通过，调用仍会被工具白名单拦截。CLI 0.1.63 的 harness 将 Executa sampling 转到 `llm.complete`，因此 `ui.host_api.llm: ["complete"]` 也是必需的。UI 本身仍只调用 `tools.invoke`。

### 为什么 `--no-llm` 下点击 Summarize 会得到 `[-32603] harness started with --no-llm`

`--no-llm` 让 harness 关闭 LLM / sampling 通道。点击 Summarize 时前端仍会调用 `anna.tools.invoke(...)`，请求能到达 tool 路由，但没有 host LLM 可以回答 Tool 的 `sampling/createMessage`，所以 harness 返回该错误。UI 会显示这条错误和一段说明。**这是 App 调试路径的预期结果，不代表后端 Tool 的 sampling 失败**；后端 sampling 请用下一节单独验证。本项目不会在 UI 里用 mock 伪造 summary。

## 6. 单独测试后端 sampling：`anna-app executa dev --mock-sampling`

```bash
npm run executa:dev:mock
# 等价于：
anna-app executa dev --dir executas/mini-notes-summarizer \
  --mock-sampling executas/mini-notes-summarizer/fixtures/sampling.jsonl
```

在其中对 `summarize` 传入：

```json
{"notes":[{"seq":1,"text":"明天跟客户 follow up"},{"seq":2,"text":"修复登录 bug"}]}
```

预期 summary 为 fixture 中的 `[mock-sampling] ...` 固定文本。fixture 使用官方 CLI 模板相同的单条无条件回答：`{"ns":"sampling","method":"createMessage","result":{...}}`。这是离线协议测试数据，不会根据笔记生成真实总结。CLI 0.1.63 的 sampling bridge 已实际读取该 fixture；不要依赖多行条件匹配或默认行回退（该版本实现不保证这些行为）。

## 7. 手动测试 Executa JSON-RPC

不依赖任何 Anna CLI：

```bash
npm run test:protocol            # 编译并运行完整协议测试，23 项检查
node scripts/protocol-test.mjs --exe <二进制路径>          # 测试已打包的二进制
node scripts/protocol-test.mjs --exe <二进制路径> --smoke  # 只测 initialize/describe/health
```

该脚本扮演 host：发送 `initialize`(v2) → `describe` → `health` → `invoke`，并在 `invoke` 进行中**回答 Tool 发出的反向 `sampling/createMessage`**（取自 fixture），同时校验 stdout 只有 JSON-RPC、stdin EOF 后正常退出。

纯手工方式（`describe` / `initialize`）：

```bash
cd executas/mini-notes-summarizer && go build -o /tmp/mns .
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2.0"}}' \
              '{"jsonrpc":"2.0","id":2,"method":"describe"}' | /tmp/mns 2>/dev/null
```

`invoke` 需要有人回答反向请求，手工管道只能看到 Tool 发出的 `sampling/createMessage` 并以错误结束（stdin 已关闭，Tool 不会伪造 summary）：

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2.0"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"invoke","params":{"tool":"summarize","invoke_id":"manual-1","arguments":{"notes":[{"seq":1,"text":"hello"}]}}}' | /tmp/mns
```

输出中会出现 `"method":"sampling/createMessage"` 的一行，以及 `id:2` 的 error。完整的“请求→响应→summary”链路由 `protocol-test.mjs` 演示。

## 8. 如何确认 notes 走的是 `anna.storage.*`

- **代码**：`src/storage/notesStore.ts` 只依赖注入的 `StorageApi`（`get`/`set`），没有 localStorage / IndexedDB / 文件 / 内存副本；每次变更先 `get` 再 `set`，并串行化。
  `grep -rn "localStorage\|indexedDB" src | grep -v "^\S*:\s*[0-9]*:\s*\*"` 除注释外应无结果（唯一命中是 `notesStore.ts` 里说明“不使用它们”的注释）。
- **运行时**：页面底部 Host API activity 面板与控制台 `[anna-call] storage.get key=mini-notes:v1` / `storage.set key=mini-notes:v1 (N chars)`。
- **单测**：`tests/notesStore.test.ts` 用记录调用的 fake storage 断言读写、序号不复用、并发不丢、损坏数据不被覆盖。
- **端到端**：`npm run test:e2e`（需要 Playwright 与 Chromium）刷新页面后 notes 从 storage 取回。

## 9. 如何确认 summary 走的是 `anna.tools.invoke -> Executa -> sampling/createMessage`

1. 前端：面板出现 `tools.invoke tool-...-mini-notes-summarizer-... method=summarize`；`src/tools/summarizer.ts` 没有任何拼接逻辑，错误和空结果都会抛出。
2. Tool 的 stderr（`anna-app dev` 的 executa 日志，或协议脚本输出）：
   `→ sampling/createMessage invoke_id=...`、`← sampling/createMessage id=... ok model=...`
3. 协议证据：`npm run test:protocol` 写出 `logs/protocol-evidence.jsonl`，逐帧记录 host↔tool 双向消息，可见 tool→host 的 `sampling/createMessage`（`params.metadata.executa_invoke_id` 与 `invoke` 的 `invoke_id` 一致）和随后的 host→tool 响应。
4. 返回数据中带 `source: "sampling/createMessage"`、`sampling_request_id`、`invoke_id`，UI 的 meta 行会显示。
5. 反证：`go test` 中 `TestSummaryAlwaysComesFromHostText`（host 返回什么，summary 就是什么）和 `TestSamplingErrorIsPropagatedNotFaked`（sampling 失败时不返回任何 summary）。

## 10. 本机二进制打包

```bash
npm run package:executa          # 只打当前机器的平台（自动识别 OS/架构）
npm run package:executa:all      # darwin-arm64、darwin-x86_64、windows-x86_64
python3 scripts/package_executa.py --target windows-x86_64 --out dist-executa
python3 scripts/package_executa.py --verify dist-executa/<archive>
```

只需 Go + Python 标准库（Go 以 `CGO_ENABLED=0` 交叉编译）。产物在 `dist-executa/`，另有 `SHA256SUMS`：

```
mini-notes-summarizer-darwin-arm64.tar.gz
mini-notes-summarizer-darwin-x86_64.tar.gz
mini-notes-summarizer-windows-x86_64.zip
```

归档结构（根目录即 archive root，条目不带 `./`）：

```
manifest.json                      runtime.binary.entrypoint / permissions
bin/mini-notes-summarizer          (windows: bin/mini-notes-summarizer.exe)，权限 0755
```

脚本会：校验根 `manifest.json`、entrypoint 存在且可执行、manifest 权限为 `0o755`、**读取可执行文件头确认与平台 key 的格式和 CPU 架构相符**；对本机平台还会解压并运行 `describe` 做 smoke。归档为确定性构建（固定 mtime，可用 `SOURCE_DATE_EPOCH` 覆盖）。
检查：`tar -tvzf dist-executa/*.tar.gz`、`unzip -l dist-executa/*.zip`、`tar -xzOf <archive> manifest.json`。

## 11. GitHub Actions 发布

`.github/workflows/release-executa.yml`：

- 触发：推送 tag `v<VERSION>`（`git tag v0.1.0 && git push origin v0.1.0`），或手动 `workflow_dispatch` 并填写 tag。tag 必须等于 `v` + `executas/mini-notes-summarizer/VERSION`，否则失败。
- 流程：`resolve`（tag 守卫）→ `test`（go vet/test -race + 协议测试）→ `build`（一次构建三平台归档并校验）→ `smoke`（在 macOS arm64 / macOS Intel / Windows 原生 runner 上解压并跑 `protocol-test.mjs --exe`）→ `release`（单个 job 用 `softprops/action-gh-release` 把三个文件上传为 **GitHub Release assets**）。Workflow artifact 仅作辅助。
- 预期 Release assets：`mini-notes-summarizer-darwin-arm64.tar.gz`、`mini-notes-summarizer-darwin-x86_64.tar.gz`、`mini-notes-summarizer-windows-x86_64.zip`。
- 注意：该 workflow 尚未在真实 GitHub 上运行过；Intel macOS runner 标签（`macos-15-intel`）可能随 GitHub 调整。

## 12. 概念关系

- **manifest**（`manifest.json`）声明 App 的一切：`required_executas` 说明依赖哪个 Executa；`ui.bundle` / `ui.views` 说明加载哪个静态 bundle；`ui.host_api` 是 iframe 可调用的 Host API 白名单（`storage: get/set`、`tools: required:*`）；`permissions` 供展示/审计。
- **bundle**：`npm run build` 的静态产物，在 Anna 的 iframe 里运行，只能通过 `AnnaAppRuntime` 调 Host API，不能直连自建 HTTP。
- **executas**：App 依赖的本地工具进程，通过 stdio 的 JSON-RPC 2.0 与 Anna 通信（`initialize`/`describe`/`invoke`/`health`/`shutdown`）。`required_executas` 里的 `bundled:mini-notes-summarizer`、`ui.host_api.tools`、前端常量、`describe().name` 必须一致（`check:consistency` 校验）。
- **Anna storage / APS KV**：App 的持久化层，经 `anna.storage.get/set` 访问；本地无 login 时落在 harness 的 legacy in-memory runtime_state。
- **sampling**：Executa 没有 API key，通过反向 `sampling/createMessage` 请求 host 的 LLM；需要 `initialize` 协商 v2 并声明 `client_capabilities.sampling`，且 manifest 声明 `host_capabilities: ["llm.sample"]`。host 的响应与普通请求共用同一条 stdin，所以 Tool 的 invoke 在单独 goroutine 中等待。
- **binary archive**：发布 Executa 的方式。每个平台一个归档，根目录有 `manifest.json`（entrypoint、权限）和 `bin/` 下的可执行文件；平台 key 为 `darwin-arm64` / `darwin-x86_64` / `windows-x86_64`。

## 13. 自测结果（本仓库开发环境）

| 项 | 命令 | 结果 |
|---|---|---|
| Go 普通单测 | `go test -v ./...`（在 Executa 目录） | 11 通过；go vet 通过 |
| Go race | `npm run test:executa` | 本机缺少 CGO，未通过；不复述交接环境结果为本机实测 |
| Executa 协议脚本 | `npm run test:protocol` | 23/23 |
| 前端类型检查 / 单测 | `npm run typecheck` / `npm test` | 通过 / 11 通过 |
| 构建 + 一致性 | `npm run build` / `npm run check:consistency` | 通过 |
| 浏览器端到端（真实 Go 二进制） | `npm run test:e2e` | 全部通过 |
| 三平台打包 + 归档校验 | `npm run package:executa:all` | 通过；对改名伪装的归档校验器能报错 |
| `anna-app validate/dev/executa dev` | 见第 4–6 节 | CLI 0.1.63 均实测通过；dev 含真实 harness UI 验收 |

`npm run test:e2e` 使用测试内置的假 host（内存 storage + 真实二进制 + fixture 回答 sampling），它**不属于**发布的 App；运行需要 Playwright（`PLAYWRIGHT_MODULE=<路径> npm run test:e2e` 可指定模块位置）并先执行过 `npm run test:protocol`（生成 `.build/` 下的二进制）。
