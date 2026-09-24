---
alwaysApply: false
paths: ["一键更新.bat", "deploy.local.bat.example", "Dockerfile", "docker-compose.yml", "render.yaml", "_deploy/**"]
---

# 部署约定

## 目标环境

- Windows Server，站点目录 `C:\haigui`
- 进程由 pm2 托管，进程名 `haigui`
- 数据库为服务器本机 MySQL

## 服务器地址从哪来

- `一键更新.bat` 里**不含任何**服务器地址或密钥路径，可以安全提交
- 真实的 `KEY`（SSH 私钥路径）与 `HOST`（`用户名@IP`）只存在于 `deploy.local.bat`，
  该文件已被 `.gitignore` 忽略
- 新成员上手：复制 `deploy.local.bat.example` 为 `deploy.local.bat` 并填入自己的值

## 部署流程（`一键更新.bat` 四步）

1. 上传后端：`server.js` `vector-store.js` `progress-utils.js` `offline-engine.js` `package.json` `package-lock.json`
2. 上传前端：先删服务器上的 `public` 目录，再整目录 scp 上传
3. 服务器执行 `npm install --omit=dev --no-audit --no-fund`
4. `pm2 restart haigui`

任一步失败会跳到 `:fail` 提示并中止。

## 改动影响面

| 改了哪些文件 | 需要做的事 |
|---|---|
| `server.js` / `vector-store.js` / `progress-utils.js` / `offline-engine.js` | 重新上传 + `pm2 restart` |
| `public/` 下任意文件 | 重新上传 `public/`（脚本会先删旧目录） |
| `package.json` / `package-lock.json` | 服务器需重新 `npm install` |
| `.env` / 数据库结构 | **不在自动部署范围内**，需登录服务器手动处理 |

## 回滚

1. 部署前记录当前提交号（`git log -1 --oneline`）
2. 回滚：`git checkout <上一个正常提交>` → 重新运行 `一键更新.bat`
3. 服务器上 `pm2 logs haigui` 看失败原因

## 红线

- 禁止把 `deploy.local.bat`、`.env`、`data/` 加入版本控制
- 禁止在脚本、日志、提交信息、对话记录里出现生产服务器地址与密钥路径
- 禁止在未确认影响面的情况下直接部署 `server.js`（它是单文件承载全部业务逻辑）
