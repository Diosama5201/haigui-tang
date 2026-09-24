# 海龟汤网站 — 项目记忆

## 项目是什么

文字推理游戏（海龟汤）网站。玩家读「汤面」后自由提问，AI 陪玩只回答「是 / 否 / 无关紧要」，
并根据提问内容实时估算**推理进度**（0-100%）。另有题库管理、txt 批量上传入向量库、
用户系统，以及 AI 陪玩存档（保存后退出 / 继续游玩）。

## 技术栈（已定型，不要擅自更换）

| 层 | 选型 | 说明 |
|---|---|---|
| 后端 | Node.js 原生 `http` 模块 | **不用 Express / Koa / Fastify**，路由是 `server.js` 里手写的 if 分支 |
| 数据库 | MySQL + `mysql2/promise` | 唯一生产依赖，全部参数化查询 |
| 前端 | 原生 HTML + CSS + ES Module | **不用 Vue / React**，无构建步骤，改完刷新即生效 |
| 向量检索 | `vector-store.js`（自研进程内实现） | 不是外部 Chroma 服务；1024 维、带符号特征哈希、余弦相似度 |
| 进程管理 | pm2，进程名 `haigui` | 服务器常驻 |
| 部署 | Windows Server，目标目录 `C:\haigui` | scp 上传 + `pm2 restart haigui` |

> **关键约束**：本项目刻意保持**零框架、零构建**。引入任何打包工具或前端框架都属于破坏性变更，
> 必须先与负责人确认，不要"顺手升级"。

## 目录结构

```
server.js            HTTP 服务 + 路由分发 + 全部业务 handler（单文件，约 1300 行）
vector-store.js      进程内向量库：embed / add / query / chunkText，持久化到 data/
progress-utils.js    推理进度解析：parseProgressFromText / estimateProgressLocally
offline-engine.js    离线判题引擎：字面 bigram 匹配，无 LLM 时的兜底
public/
  index.html         登录页
  app.html           主应用外壳（含主题切换按钮）
  js/app.js          SPA 全部视图与交互
  js/api.js          所有后端接口的封装，新增接口写这里
  js/auth.js         登录态
  js/theme.js        亮/暗主题
  css/style.css      全部样式
data/                运行时数据（已 gitignore）：uploads 原始文件、向量库持久化
一键更新.bat         部署脚本（不含任何服务器地址）
deploy.local.bat     本地部署凭据（已 gitignore，新成员从 .example 复制）
.codebuddy/          项目级 AI 配置（本目录，随仓库共享）
```

## 启动与自测

```bash
npm install
cp .env.example .env        # 填入 MySQL 连接信息
npm start                   # 默认 http://localhost:3000
curl http://localhost:3000/healthz
```

## 数据库

4 张表**由 `server.js` 启动时自动创建**（`CREATE TABLE IF NOT EXISTS`），无需手动导入 DDL：

| 表 | 用途 | 要点 |
|---|---|---|
| `users` | 用户 | 密码加盐 SHA256 存储；字段 `salt` |
| `user_settings` | 每用户的陪玩引擎配置 | `llm_enabled` / `llm_base_url` / `llm_model` / `llm_api_key` |
| `soups` | 海龟汤题目 | `face`（汤面）/ `bottom`（汤底）/ `type` / `style` / `diff_*` |
| `game_saves` | AI 陪玩存档 | 唯一键 `uk_user_soup(user_id, soup_id)`，存剩余问题数、剩余秒数、进度、历史 JSON |

## 双引擎机制（改这块前务必读）

陪玩有两种引擎，按用户的 `user_settings` 决定走哪条：

1. **在线**：用户的 `llm_enabled = 1` 且配置了 base_url / model / api_key → 调 OpenAI 兼容接口
2. **离线**：未配置或在线调用失败 → 回落到 `offline-engine.js`

**硬性要求**：在线引擎任何失败（超时、鉴权失败、返回不合法 JSON）都必须降级到离线引擎，
**不允许直接把 500 抛给前端**。

## 已踩过的坑（改代码前先看这里）

1. **内部跳转必须用 `goto(hash)`**，禁止直接 `location.hash = '#/xxx'`。
   给 `location.hash` 赋相同值时浏览器**不触发 `hashchange`**，页面不会重渲染。
   典型事故：用户从"继续游玩"进入时 hash 已经是 `#/ai/play`，点击按钮后界面卡死无响应。

2. **`/api/ai/` 分支必须在鉴权后立刻 `req.authUser = user;`**。
   漏了这一步，下游 handler 会抛 `TypeError: Cannot read properties of undefined (reading 'uid')`，
   表现为"保存失败 500"。这类错误只看前端现象很难定位，先查这里。

3. **进度解析要防截断**。让模型输出 JSON 时 `max_tokens` 太小会截断（曾用 120 导致
   `Unexpected end of JSON input`，进度条永远 0%）。当前 `runProgressAgent` 用 `maxTokens: 500`，
   并由 `parseProgressFromText` 做截断修复 + 正则兜底。三层兜底顺序：agent > 宿主回传 > 本地估算，
   且进度**只增不减**（单调）。

4. **向量维度不能小于 1024**。256 维时无关文本相似度会虚高到 0.16，造成误命中。
   当前用带符号特征哈希让碰撞相互抵消；自测标准：无关文本 < 0.1，相关文本 > 0.3。

5. **离线引擎不做同义词推断**。它只在字面 bigram 命中时才断言「是 / 否」，否则一律回「无关紧要」。
   这是刻意的诚实降级——**不要为了"命中率好看"把它放宽成模糊匹配**，那会让游戏失去推理意义。

## 相关文档

- `README.md` — 对外说明
- `.codebuddy/rules/` — 后端 / 前端 / 部署三份规范
- `.codebuddy/commands/deploy.md` — `/deploy` 斜杠命令
