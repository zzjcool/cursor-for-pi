# cursor-for-pi

给 Pi Coding Agent 用的新 Cursor provider。包名和目录名都是 `cursor-for-pi`（`~/code/cursor-for-pi`）。请求模型照搬 [magpie 的 Cursor 插件](https://github.com/magpie-community/plugins/tree/main/packages/cursor)：每次对话新建一条 HTTP/2 连接，用完即拆。不要 fork `@rahularya01/pi-cursor` 再改它的长连接。

状态：`0.1.0` 可以发到 npm。另一台机器要有 Node.js 22 和 Pi。先确认没有启用 `@rahularya01/pi-cursor`（两个都注册 provider id `cursor`，同时加载会冲突），再装：

```bash
pi install npm:cursor-for-pi@0.1.0
```

然后 `/login cursor`，再 `/model cursor/<id>`。`/cursor.doctor` 只报告用的是哪一级凭证，不打印 token。只想试一次、不写进配置：`pi -e npm:cursor-for-pi@0.1.0`。

发布包里是 `src/*.ts`，`pi.extensions` 指向 `./src/index.ts`，Pi 用 jiti 加载。不要和已经装的 `pi-cursor` 一起开。实现按下文做，不要重开「新插件还是 fork」这个决定。

## 背景

本机已装 `@rahularya01/pi-cursor@1.4.39`（`~/.pi/agent/settings.json` 里是 `npm:@rahularya01/pi-cursor`）。它和 magpie 的 `@magpie-community/opencode-cursor-auth@0.2.2` 走同一条协议：浏览器 PKCE 登录，进程内用 Node `http2` 打 Cursor 的 Connect 双向流 `POST /agent.v1.AgentService/Run`（`content-type: application/connect+proto`）。两边都不把 `cursor-agent` 当模型子进程。

体验不一样。pi-cursor 把 HTTP/2 会话跨回合停放（默认 1 小时），工具结果必须写回同一条 Run。连接在上游失效后，要等到 GOAWAY 或 3 分钟静默才发现，然后靠 checkpoint 恢复。界面上就是偶发断开，以及这两句：

- `Recovered tool output after upstream bridge loss`
- `Cursor tool continuation was lost because the live upstream bridge is no longer available`

magpie 每次 Run 都 `http2.connect`，5 秒一次空的 `client_heartbeat`（protobuf 字段 7），结束时 `req.close(NGHTTP2_CANCEL)` 再 `session.close()`。工具调用一凑齐就关掉这次 Run，下一次请求带完整历史重连，用稳定的 `conversation_id` 让 Cursor 把请求送到缓存了 prompt 的那台机器。这套体验更稳。

本机一次会话的证据（不要把 token 写进仓库）：

- 生命周期日志 `~/.cache/pi-cursor/pi-cursor-lifecycle-65896.jsonl`：同一个 `bridgeKey` `d37817a2`、同一个 `convKey` 从 `req-12` 复用到 `req-16`，模型 `grok-4.7-high`。
- 同一份日志里有 `wire_drift`：`conversationCheckpointUpdate` 字段 38/39，`interactionUpdate` 字段 27。`stranding` 都是 false，不是那次中断的直接原因，但说明 pi-cursor 生成的 `agent_pb.ts` 已经落后于线上。
- 断线补水靠 `~/.cache/pi-cursor/run-journal/<convKey>.json`（24 小时）。新插件不要再做这套 journal。

## 决定

新做插件，把 magpie 的请求实现搬过来。不 fork `@rahularya01/pi-cursor`。

原因：偶发断开就是 pi-cursor 的核心（`src/stream/native-core.ts` 约 2100 行、checkpoint、recovery、run journal、停放的 bridge）。改成 magpie 的行为等于拆掉这些，只留登录和模型列表。上游还在改长连接，之后合并会一直冲突。

Pi 的工具循环本来就是：模型给出工具调用，Pi 执行，下一回合再请求。不需要把连接挂住等工具结果。

## 目标

在 Pi 里选 `cursor/<model>` 就能用 Cursor 订阅里的模型聊天、调 Pi 已经注册的工具。连接按次建立、按次销毁，不再出现上面那两句恢复/丢续接错误。

做到这些就算第一版：

1. Pi 扩展：`package.json` 的 `pi.extensions` 指向入口，注册 provider id `cursor`。命令仍是 `/login cursor`、`/model cursor/<id>`。
2. 每次模型请求：新建 HTTP/2 → `AgentService/Run` → 5 秒心跳 → 结束 `NGHTTP2_CANCEL` 并关掉 session。不要停放连接，不要 `persistent: true`，不要跨回合 `openStream`。
3. 工具：只把调用方（Pi）的工具当 MCP 工具列给 Cursor。模型经 `CallDynamicTool` 发起调用后，插件把它译成 Pi 的 tool call 并**结束这次 Run**。工具由 Pi 执行，结果进下一回合的完整历史，不写回当前流。Cursor 自带的 shell、读文件、改文件不执行。
4. 稳定 `conversation_id`：有 Pi session 时，对 `"cursor conversation\0" + sessionId + "\0" + 第一条 user 消息` 做 SHA-256，取前 16 字节改成 UUID v4。没有 session 名就每次 Run 新 UUID。子 agent 不要和主会话共用同一个 id（加上第一条 user 消息就是为了这个）。
5. 区域：先 `aiserver.v1.ServerConfigService/GetServerConfig`，用返回的 `agentUrl` / `agentnUrl`；拿不到用 `https://agentn.global.api5.cursor.sh`。错误文案含 `region` 时强制再问一次，新地址不同才重跑这一次 Run。不要写死 `agentn.us.api5.cursor.sh`。
6. 鉴权从 pi-cursor 借用，不要用 OpenCode 的 auth 存储：
   1. `CURSOR_ACCESS_TOKEN`
   2. Pi OAuth（`~/.pi/agent/auth.json`，`/login cursor`）
   3. macOS 钥匙串 `cursor-access-token`
   4. Cursor IDE 的 `state.vscdb`
   浏览器登录仍是 `https://cursor.com/loginDeepControl` + 轮询 `https://api2.cursor.sh/auth/poll`。
7. 请求头对齐 magpie，不要对齐 pi-cursor 的自定义头：
   - `content-type: application/connect+proto`
   - `connect-protocol-version: 1`
   - `x-cursor-client-type: cli`
   - `x-cursor-client-version`：安装的 `cursor-agent` 版本，否则回退 `2026.09.23-86fc751`，前面加 `cli-`
   - `x-ghost-mode: true`
   - `x-cursor-agent-allowed-tools: mcp_tool_call,get_mcp_tools_tool_call`
   - `x-request-id` 每次新 UUID
8. 协议层用 magpie 那份手写 protobuf（`index.mjs` 里的 `pb()`），不要生成或复制 pi-cursor 的 `agent_pb.ts`。

## 不做

- 不做跨回合 HTTP/2 会话、checkpoint、run journal、「上游断了就接着写」的恢复提示。
- 不在同一条 Run 上回工具结果。
- 不执行 Cursor 原生 shell / 读写文件。没有合适的 Pi 工具就失败这次调用，不要本地兜底。
- 不把 magpie 的 OpenAI chat-completions `fetch` 适配层整份贴进 Pi。Pi 走 `streamSimple`，事件是文本、思考、tool call。只搬请求和解码。
- 不做多账号切换、Responses/Messages API、用量仪表板。用量可以以后再做。
- 不写 `.env`、不把 access token 写进源码或日志样例。
- 不要求用户卸掉已经装的 `@rahularya01/pi-cursor`。新包名就是 `cursor-for-pi`，不要用 `pi-cursor`、`pi-cursor-runonce` 或 `@rahularya01` 作为包名。两个都注册 provider id `cursor` 时会冲突，默认假设只装这一个，并在 README 里写明。

## 从哪里拿

| 拿 | 从哪 | 不拿什么 |
|---|---|---|
| Run 的组包、解码、心跳、关连接、`conversation_id`、区域重试、手写 protobuf | magpie `packages/cursor/index.mjs`（约 2044 行）。关键函数：`open` 1513、`runOnce` 1542、`buildRun` 1439、`conversationID` 1186、`agentURL` 1488、`decode` 里工具步在凑齐后 `close()` | OpenCode 的 `auth` hook、chat completions 响应格式、dashboard 用量补记（`owed` / `STEP_WAIT`）。用量第一版可以缺 |
| `/login cursor`、四级凭证、模型目录怎么注册进 Pi、`streamSimple` 事件怎么推 | 本机 `~/.pi/agent/npm/node_modules/@rahularya01/pi-cursor`，源码仓库 https://github.com/Rahularya01/pi-cursor 。参考 `src/stream/stream-writer.ts`、登录和 `GetUsableModels` / `AvailableModels` | `src/client/h2-session.ts`、`src/stream/bridge-session.ts`、`native-core.ts`、`recovery.ts`、`session-state.ts`、`run-journal.ts`、生成的 `agent_pb.ts` |

两个仓库都是 MIT。搬过来的文件头部保留原作者和出处：

- https://github.com/magpie-community/plugins/tree/main/packages/cursor
- https://github.com/Rahularya01/pi-cursor

magpie 这份本身注释写明是从 magpie Go 实现移植的（`internal/provider/cursor*.go`）。

## 建议的文件

先保持少数文件，不要照搬 pi-cursor 的 `src/stream/` 拆成三十个模块。

```text
package.json          name 是 cursor-for-pi；pi.extensions、MIT、node >= 22
src/index.ts          扩展入口：注册 provider、/login、/cursor.doctor
src/auth.ts           四级凭证 + PKCE。只读钥匙串和 state.vscdb
src/run.ts            从 magpie 搬的 open / runOnce / buildRun / decode / agentURL
src/codec.ts          手写 protobuf，从 magpie 的 pb() 搬
src/pi-stream.ts      Run 事件 → Pi 的 text / thinking / toolcall
src/models.ts         AvailableModels + GetUsableModels
test/                 用录制的帧测解码和「工具凑齐就 close」，不要打真实 Cursor
```

依赖尽量少。magpie 这份只用 Node 内置模块（`node:http2`、`node:crypto`、`node:zlib`）。不要加 `@bufbuild/protobuf`，除非后来证明手写编码砌不动某个必须字段。

## 验收

不用真实账号也能跑的：

- 解码测试：文本、thinking、`CallDynamicTool` 凑齐后迭代器结束，且调用了 `NGHTTP2_CANCEL`。
- 一次 Run 里不出现工具结果帧。
- `conversation_id` 对同一个 session + 同一条首条 user 消息稳定，换首条消息就变。
- 区域错误：URL 变了才第二次 `runOnce`，没变就不重试。
- 原生 shell/read/write 的 exec 不产生 Pi tool call，也不在本地执行。

有账号再手工看一次：`/login cursor`，`/model cursor/<一个账号里有的模型>`，普通回复、一次工具调用、工具结果后的下一回合。连续几轮不应再出现 bridge loss。

## 实现顺序

1. 搬 `codec.ts` 和 `run.ts`，用假 HTTP/2 把解码和关连接测绿。这一步不要接 Pi。
2. 接 `pi-stream.ts`：一次 Run 的事件变成 Pi 的 assistant stream。工具调用使 stop reason 为 tool use，然后流结束。
3. 接登录和模型列表，能在 Pi 里选中模型。
4. 手工跑一轮真实对话。不要为了对齐 pi-cursor 再加回 checkpoint。
