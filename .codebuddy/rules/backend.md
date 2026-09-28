---
alwaysApply: true
---

# 后端编码规范（server.js）

## 路由

- 所有路由集中在 `server.js` 的请求分发处，用 `if (method === 'X' && pathname === '/api/...')`
  的形式；**新增接口必须同步补上分发分支**，否则前端请求会走到静态资源兜底逻辑。
- 带路径参数的路由先用 `pathname.startsWith()` 判断，再解析 id，避免与静态资源路由冲突。
- `/api/ai/` 开头的分支**必须在鉴权通过后立刻执行 `req.authUser = user;`**，
  否则下游 handler 拿不到用户，抛 `Cannot read properties of undefined (reading 'uid')`。

## 统一响应

- 成功用 `sendJSON(res, 200, { ... })`；失败用 `sendJSON(res, 4xx/5xx, { error: '中文可读原因' })`
- 错误信息面向用户，**不要把异常对象直接序列化返回**（会泄露表名、SQL 片段、堆栈）
- 完整异常只写日志，不写响应体

## 鉴权分支的两种「401」要区分开（易错）

前端 `api.js` 把 HTTP 401 统一解释为「登录态过期」→ 清 token → 跳登录页。
因此**管理者接口（`/api/admin/*`）的失败响应必须额外带 `admin: true`**，
否则只是输错管理口令就会把用户踢下线。前端见到该标记时会改为只清管理令牌。

```js
// 正确：管理接口的所有失败响应都带 admin 标记
sendJSON(res, 403, { code: 403, admin: true, message: '管理者身份已失效，请重新验证口令' });
```

同样地，`/api/ai/` 与 `/api/admin/` 分支**都必须在鉴权通过后立刻 `req.authUser = user;`**。

## 数据库

- 一律使用 `mysql2` 的 `?` 占位符参数化查询，**禁止字符串拼接 SQL**
- 列表查询必须分页（`LIMIT ? OFFSET ?`），禁止全表返回
- 表结构变更直接改进 `initDB()` 里的 `CREATE TABLE IF NOT EXISTS`，不单独维护 schema.sql
- `data/` 已被 .gitignore 忽略：**不要把业务数据写成 JSON 文件**，一律进 MySQL

## 外部调用（LLM / HTTP）

每个外部调用都必须同时具备三件事，缺一不可：

1. **显式超时数值**（毫秒），不允许无限等待
2. **重试策略**：次数上限 + 退避；重试只针对可重试错误（超时、5xx、连接失败）
3. **降级路径**：LLM 不可用 → 回落 `offline-engine.js`，**不允许直接 500**

错误分类：可重试（超时/5xx）→ 重试；不可重试但可降级（鉴权失败、返回不合法 JSON）→ 降级；
未知异常 → 记日志 + 降级，不要吞掉。

## 安全

- 密钥、密码、连接串只从 `process.env` 读取，禁止硬编码（`DB_PASSWORD`、`JWT_SECRET` 等）
- 日志禁止打印密码、token、`.env` 内容、生产服务器地址
- 上传文件校验类型与大小
- 用户密码加盐哈希后存储

> **已知待改进**：当前密码用的是加盐 SHA256，强度低于 bcrypt / argon2。
> 如需提升，应做一次带迁移的平滑替换，而不是直接改 hash 函数（会让存量用户无法登录）。
