# 工作区目录

> 代码本体在 `main/`（主进程）、`preload/`、`renderer/`、`scripts/`，这里只放配套资料。

## docs/ — 设计与文档（进仓库）

- `docs/screenshots/` — 界面截图归档（**不进仓库**，gitignore）。历史取证截图已从根目录迁入：`01-main.png`（主界面）、`03-plugins.png`、`05-skills.png`、`06b/07-settings-*.png`（设置页）、`08~11-orb*.png`（小球各状态）、`final-*.png`（小球定稿）。
- 设计稿、排期表、方案文档放这里，命名建议 `YYYY-MM-DD-主题.md`。

## notes/ — 过程笔记（进仓库）

日常记录、复盘、踩坑笔记。注意：**权威工作日志在仓库外的 `.workbuddy/memory/`**（跨会话记忆），这里放适合随仓库走的沉淀内容。

## scratch/ — 临时草稿（不进仓库，gitignore）

一次性脚本、实验代码、临时输出。原则：**能进 `scripts/` 的正式工具别留在 scratch**；这里的东西随时可删。

## release/ — 打包产物（不进仓库，gitignore）

`npm run dist:mac` 输出；构建入口与自检见 `scripts/dist.js`、`scripts/check-package.js`。
