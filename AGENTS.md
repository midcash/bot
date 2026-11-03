# midbot

一个聊天机器人：消息从传输层进来，经过准入与输出策略，交给一个**受限的 pi 实例**当大脑，回答再经策略过滤后发回。

## 规则（改代码前先读）

- 不直接推 main，一律走 PR。合并由人做。
- 不碰部署、正式环境、任何密钥。仓库里不出现密钥、邮箱、QQ 号、群号、用户数据。
- 只改当前 issue 范围内的文件；顺手发现的问题写成 follow-up，不要顺手改。
- 提交前必须跑 npm test 并且全绿。
- 只用 Node 22 内置能力。要引入依赖必须由 issue 明确授权，并在 PR 里说明理由。
- 大脑层（src/brain.mjs）保持无工具：不给它文件系统、shell、网络。谁想加工具，先改架构文档再说。
- 每个 PR 的 base 是 main。不要基于未合并的分支再开分支。

## 命令

- npm test —— 跑全部单元测试（node --test）
- npm start —— 起本地服务，默认 http://127.0.0.1:8787
- curl -s localhost:8787/healthz —— 探活

## 结构

- src/config.mjs —— 所有开关的默认值，环境变量覆盖
- src/policy.mjs —— 准入（白名单、限频）、输出过滤（路径/密钥）、长文折叠
- src/memory.mjs —— 每个会话一个 JSONL，群/私聊/用户互相隔离
- src/brain.mjs —— spawn 一个受限 pi 进程，stdin 传 prompt，解析 JSONL 事件
- src/server.mjs —— HTTP 入口，OneBot 11 风格的消息体
- src/index.mjs —— 组装并监听

## 本地验证约定

没有真实 QQ 也能跑：POST /v1/message 接受 OneBot 11 的 message 事件，group 和 private 两种都支持。
