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
server.js            HTTP 服务 + 路由分发 + 全部业务 handler（单文件，约 2000 行）
knowledge-base.js    知识库（RAG 第二层）：结构化切分 / MD5 去重 / 入库 / 检索 / 参考块渲染
vector-store.js      进程内向量库：embed / add / query / chunkText，持久化到 data/
upload-utils.js      上传字节级工具：multipart 解析 / 文件名净化 / 编码识别（UTF-8·GBK）
progress-utils.js    推理进度解析：parseProgressFromText / estimateProgressLocally
offline-engine.js    离线判题引擎：字面 bigram 匹配，无 LLM 时的兜底
annotation-store.js  人工标注答案表（离线引擎第二层，只读查询，不参与判定逻辑）
public/
  index.html         登录页
  app.html           主应用外壳（含主题切换按钮 + 侧边栏底部的管理者入口）
  js/app.js          SPA 全部视图与交互
  js/api.js          所有后端接口的封装，新增接口写这里
  js/auth.js         登录态
  js/theme.js        亮/暗主题
  css/style.css      全部样式
tests/               单测与评测集（npm test，共 256 项）
tools/               批量导入等一次性脚本（幂等 + --dry-run）
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

5 张表**由 `server.js` 启动时自动创建**（`CREATE TABLE IF NOT EXISTS`），无需手动导入 DDL：

| 表 | 用途 | 要点 |
|---|---|---|
| `users` | 用户 | 密码加盐 SHA256 存储；字段 `salt` |
| `user_settings` | 每用户的陪玩引擎配置 | `llm_enabled` / `llm_base_url` / `llm_model` / `llm_api_key` |
| `soups` | 海龟汤题目 | `face`（汤面）/ `bottom`（汤底）/ `type` / `style` / `diff_*`；隐藏题 `is_hidden=1` |
| `game_saves` | AI 陪玩存档 | 唯一键 `uk_user_soup(user_id, soup_id)`，存剩余问题数、剩余秒数、进度、历史 JSON |
| `kb_documents` | 知识库上传台账 | 唯一键 `uk_md5(md5)` 做内容去重；向量本体在 `data/chroma/haigui_kb.json` |

## 管理者入口与知识库（RAG 第二层）

- 入口：侧边栏**最底部**「管理者入口」（`.nav-item-admin`，`margin-top:auto` 沉底），路由 `#/admin`
- 鉴权：口令只从环境变量 **`ADMIN_PASSWORD`** 读取，代码内无任何默认值（公开仓库不能写死）。
  未配置 → 接口返回 503，其余功能不受影响。口令通过后换取 **2 小时**有效的管理令牌，
  请求头 **`X-Admin-Token`** 携带，前端存 `sessionStorage`
- 管理接口：`/api/admin/login`、`/api/admin/kb/{stats,documents,upload,search,reset}`、
  `DELETE /api/admin/kb/documents/:id`
- 链路：上传 txt → 编码识别 → 结构化切分（**一道汤 = 一个检索单元**）→ MD5 去重 →
  入 collection `haigui_kb` → 玩家提问时检索 Top-K 4 / 门槛 0.08 → 注入汤主 system prompt
- **为什么全站用户共享**：检索与提示词组装都在服务端完成。用户只在自己设置里填
  base_url/key/model，服务端调他们的大模型时 system prompt 已带知识库内容，用户侧零配置
- **只增强大模型引擎**。内置离线引擎行为不变（它刻意只做字面匹配，是产品取舍，别去"顺手接上"）
- 门槛与 Top-K 在 `knowledge-base.js` 顶部常量；管理页「检索测试」可看真实分数分布

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

6. **上传必须走 `upload-utils.js`，不要在 server.js 里按字符串切 multipart**。
   旧实现先 `toString('utf8')` 再 `split(boundary)`：中文文件名/多文件会串段，
   更要命的是 **GBK 编码的 txt（Windows 记事本「ANSI」）会被整篇解成乱码**。
   现在统一走二进制安全的 `parseMultipart` + `decodeTextBuffer`（UTF-8 / BOM / GBK 自动识别）。
   判断编码是否识别错的信号：数据库里出现「涓婁紶」这类典型 UTF-8-as-GBK 乱码。

7. **管理者口令相关接口的失败响应必须带 `admin: true`**。
   前端 `api.js` 把 HTTP 401 一律当成「登录过期」并清 token 跳登录页；
   如果不加这个标记，**只是口令输错就会把用户踢下线**。
   `api.js` 见到 `admin:true` 时会改为只清管理令牌、保留登录态。

8. **`ADMIN_PASSWORD` 必须在 `.env` 加载之后读取**。
   它与 `PORT`/`JWT_SECRET` 同批，放在文件顶部的 require 区会读到 undefined
   （`.env` 由文件里的 IIFE 加载），表现为"明明配了却提示未启用"。

9. **`vector-store.js` 的落盘目录可用 `CHROMA_DIR` 覆盖**（默认 `data/chroma`）。
   单测必须指向临时目录，否则会污染真实向量库。该变量像 `ANNOTATIONS_DIR` 一样按次解析，
   不要把它固化成模块级常量。

10. **新增后端模块必须放项目根目录，否则部署即整站拒连**（2026-09-28 真实事故）。
    `一键更新.bat` 用 glob 上传**根目录**的全部 `.js` / `.json`（**不要改回手写文件清单**——
    手写清单正是本次事故的成因：`server.js` 新增 `require('./knowledge-base')`，
    而清单里还是旧模块，服务器启动即 `MODULE_NOT_FOUND`，pm2 崩溃重启 36 次、
    3000 端口无监听、全站 `ERR_CONNECTION_REFUSED`）。
    连带两条：① 临时调试脚本别丢在根目录（会被一起上传），放 `tools/`；
    ② 部署后**必须**同时看 `/healthz` 和 `pm2 list` 的 `online` 状态 + `↺` 计数，
    只看 `/healthz` 会漏掉崩溃重启。回滚用服务器上的 `C:\haigui\_bak\server.js.bak`。

## 相关文档

- `README.md` — 对外说明
- `.codebuddy/rules/` — 后端 / 前端 / 部署三份规范
- `.codebuddy/commands/deploy.md` — `/deploy` 斜杠命令
