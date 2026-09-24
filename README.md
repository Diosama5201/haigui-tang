# 海龟汤 🐢

一个干净素雅、浅绿色风格的海龟汤（推理文字游戏）网站。支持用户注册登录、海龟汤库浏览预览、自己写故事与上传 txt 文件两种方式添加海龟汤。**数据存储在 MySQL 数据库，所有登录用户共享同一份海龟汤库。**

## 功能特性

- 🔐 **登录 / 注册**：进入网站先登录，用户名与密码匹配才能进入；未登录会被拦截，可随时注册新账号
- 📚 **海龟汤库（全局共享）**：所有用户看到同一份全量海龟汤，按添加时间从上到下列表展示，每条含「汤名 / 类型（清汤·红汤）/ 风格（本格·变格）/ 难度（最高五颗星）」，行尾「预览」按钮弹出小窗查看汤面（可滚动）与汤底
- ✍️ **添加海龟汤**：分「自己写故事」与「上传故事」两类
  - 自己写故事：左侧占 1/5 屏幕圆角方框（红光闪烁）填汤面，右侧占 1/5 屏幕圆角方框（紫光闪烁）填汤底
  - 上传故事：页面正下方「上传文件」按钮，上传 .txt 文件自动解析汤名/汤面/汤底
- 🗑️ **删除权限**：只能删除自己添加的海龟汤（记录创建者）
- 🖱️ **小海龟光标**：鼠标悬停交互元素时，光标变成一只绿色小海龟
- 🌿 **流式布局**：浅绿色自然素雅风格，多页面 + 左侧侧边导航栏

## 技术栈

- **后端**：Node.js 原生 `http` 模块 + `mysql2`；自实现 JWT 鉴权（HS256）
- **数据库**：MySQL（自动建库建表）
- **前端**：原生 HTML / CSS / JavaScript，无框架、无构建
- **存储**：用户与海龟汤数据存 MySQL；上传的原始 txt 文件存 `data/uploads/`

## 本地运行

### 1. 准备 MySQL

确保本机 MySQL 已启动（Windows 服务名如 `MySQL95`），并确认 root 账号密码。

### 2. 配置数据库连接

复制 `.env.example` 为 `.env`，填写你的数据库信息：

```bash
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=你的密码
DB_NAME=haiguitang
PORT=3000
JWT_SECRET=改成随机字符串
```

> 数据库 `haiguitang` 不存在也没关系，服务启动时会**自动创建**数据库和表。

### 3. 安装依赖并启动

```bash
npm install
node server.js
```

浏览器打开 <http://localhost:3000>。

## 数据模型

### users 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | VARCHAR(36) | 主键（UUID） |
| username | VARCHAR(50) | 用户名（唯一） |
| salt | VARCHAR(32) | 密码盐 |
| password_hash | VARCHAR(64) | 加盐 SHA256 哈希 |
| created_at | DATETIME | 注册时间 |

### soups 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | VARCHAR(36) | 主键（UUID） |
| title | VARCHAR(200) | 汤名 |
| face | TEXT | 汤面（谜面） |
| bottom | TEXT | 汤底（答案） |
| type | VARCHAR(10) | 清汤 / 红汤 |
| style | VARCHAR(10) | 本格 / 变格 |
| difficulty | TINYINT | 难度 1~5 星 |
| author_id | VARCHAR(36) | 创建者 id |
| author_name | VARCHAR(50) | 创建者用户名 |
| created_at | DATETIME | 创建时间 |

## 目录结构

```
海龟汤网站/
├── server.js            # 后端服务（登录/注册/鉴权/海龟汤CRUD/文件上传/静态资源）
├── package.json         # 依赖（mysql2）
├── .env.example         # 环境变量示例（复制为 .env 填写真实配置）
├── Dockerfile
├── docker-compose.yml
├── render.yaml
├── public/              # 前端静态资源
└── data/uploads/        # 上传的原始 txt 文件（用户与海龟汤数据在 MySQL）
```

## 部署上线

### Docker

```bash
docker compose up -d --build
```

> 注意：Docker 内服务连接 MySQL 时，`DB_HOST` 需指向宿主机或独立的 MySQL 服务（不能用 127.0.0.1）。

### 免费云平台

需要为 MySQL 单独提供托管服务（如 Render 的 PostgreSQL 需改驱动，或用 Planetscale/Supabase 等 MySQL 托管），或将应用与数据库一起编排。

## 安全说明

- 密码使用「加盐 SHA256」哈希存储，不保存明文
- 登录鉴权使用自实现 JWT（HS256），默认 7 天过期
- 所有 SQL 使用**参数化查询**（`?` 占位符），防 SQL 注入
- 生产环境务必设置 `JWT_SECRET` 为随机长密钥
- 数据库密码通过环境变量 / `.env` 注入，不硬编码在代码中

## 上传文件格式约定

上传的 .txt 文件建议按以下格式：

```
汤名（第一行，≤30 字会被识别为标题）
汤面内容……
汤底
汤底内容……
```

分隔符支持「汤底」「答案」「谜底」「====」「----」等，也可不写标题（系统会提示手动补充）。
