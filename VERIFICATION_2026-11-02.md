# 本机补验记录（2026-11-02）

工作副本位于 `C:/Users/78482/Documents/ChatGPT/面试/mini-notes`，下载目录中的原项目未修改。

环境：Windows x86_64，Node 24.18.0，Anna CLI 0.1.63，schema 0.32.0，Anna Python runtime 0.2.0a32（Python 3.11），Go 1.27.3，打包 Python 3.9。Go/uv 仅为本轮验收下载到 .tools，源码包不附带这些工具。

## 核心补验

- `npm run validate`：strict passed。
- `npm run dev`：真实 Python bridge ready，bundled handle 解析成功，dashboard 启动。初次启动因缺少 uvx、随后因首次下载超过 8 秒失败；预装 runtime 后启动通过。
- `npm run executa:dev:mock -- --invoke summarize --args '{"notes":[{"seq":1,"text":"明天跟客户 follow up"}]}' --json`：真实 Go 进程发出反向 sampling 请求，返回 fixture 原文，source 为 sampling/createMessage。
- `node scripts/e2e-anna.mjs`：真实 SDK 和 harness 中空输入、添加、清空输入、删除、storage 重读、无 LLM 错误提示、审计条目验证通过。它检查 Reload from storage，不声称外层 dashboard 刷新后仍持久化。截图 logs/anna-app.png。

## 实际发现并修复

1. 缺少 app.json 的 bundled_executas 映射，真实 host 返回工具不在白名单中。新增映射，并加入身份一致性检查。
2. 前端依赖 window.__ANNA_TOOL_IDS__，原 HTML 未加载发布产生的 anna-tool-ids.js。构建生成开发 sidecar，并在 app.js 前加载；发布会替换其内容。真实发布仍未执行。
3. 真实 harness 将反向 sampling 送往 llm.complete，原 manifest 缺少授权，返回 manifest does not grant 'llm.complete'。增加最小 host_api 授权后得到真实预期错误 `[-32603] harness started with --no-llm`。
4. 先前推测的 promptIncludes 不是 CLI sampling 匹配字段，且 0.1.63 不可靠地实现多行默认回退。改为官方模板相同的单条无条件 sampling fixture，CLI 已实际读取。
5. Windows UI 测试默认二进制缺少 .exe；新增条目等待条件在点击后才计算，有竞态。均修复。截图失败现在会报错，不再静默吞掉。

## 回归与审计条目数

- 前端 typecheck、11 项单测、build、check:consistency：通过。
- Go vet、普通单测 11 项：通过。`-race` 返回 `-race requires cgo`，本机缺少 CGO 编译工具链，不能宣称 race 验收通过。
- 协议测试：23/23；logs/protocol-evidence.jsonl 记录真实双向消息。
- 测试 host + 真实 Go 二进制 UI：全部通过。刷新 iframe 后，初次 storage.get 1 条；两次 Summarize 各产生 get/invoke，共 **5 条**，badge 同为 (5)。错误调用也计入；此前的添加/删除日志在页面刷新后清空。截图 logs/ui.png。
- 真实 Anna UI 脚本操作序列不同，共 10 条：6 次 get、3 次 set、1 次 invoke。不能把不同操作序列的数量直接比较。
- 三平台重新打包：darwin-arm64、darwin-x86_64、windows-x86_64 归档结构与文件头架构验证通过；Windows 解压执行 describe smoke 通过。macOS 仅交叉编译与文件头验证。
- 归档 manifest 与官方 multifile-binary 示例的 runtime.binary.entrypoint 和 permissions 结构一致： https://github.com/whtcjdtc2007/anna-executa-examples/blob/main/examples/multifile-binary/python-pyinstaller-onedir/manifest.json

GitHub Actions 未推送或远程运行，真实发布、真实付费 LLM、APS 登录持久化不在本轮验收结论内。无仓库推送或打 tag 操作。
