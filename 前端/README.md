# 纸伴 · 前端应用

这是纸伴的 PWA 前端，由 `/api/v1` 后端提供书架、书页 OCR、批注、进度和统计。安装、启动与完整说明见项目根目录的 [README](../README.md)。

## 页面

| 路由 | 作用 |
| --- | --- |
| `#/welcome` | 首页：交互模式、继续阅读、扫描入口、阅读统计 |
| `#/library` | 书架：搜索、继续阅读、扫描新页、删除 |
| `#/setup` | 摆放引导：固定手机、整页入镜、语音提示 |
| `#/scan` | 扫描：相机 / 相册、双页双栏、方向、页码 |
| `#/review` | 识别结果：置信度、文字预览、警告、重扫 |
| `#/reading` | 阅读：逐行高亮、朗读控制、语速、自动翻行、翻页 |
| `#/annotate` | 批注：当前行 / 整页、语音听写、回读确认 |
| `#/notes` | 批注库：搜索、筛选、听取、补充、编辑、删除 |
| `#/settings` | 设置：语音、外观、字号、高对比、读屏模式、数据备份 |
| `#/devices` | 键盘与手柄：按键映射、设备测试 |

## 结构

```
前端/
├── index.html          语义化页面与 SVG 图标精灵
├── styles.css          设计系统（令牌 / 组件 / 深色 / 高对比 / 动效）
├── js/api.js           REST 客户端与上传进度
├── js/store.js         状态、缓存、离线队列
├── js/voice.js         朗读、识别、中文指令解析
├── js/bluetooth.js     Web Bluetooth 连接、昵称、电量与按键
├── js/ui.js            DOM、Toast、对话框、日期
├── js/app.js           路由、视图与业务编排
├── sw.js               Service Worker（外壳离线，API 不缓存）
├── manifest.webmanifest
├── icon-180/192/512.png iPhone 与 PWA 图标
├── docs/screenshots/   界面预览
└── design/             设计交付文件
```

桌面 App 窗口使用同一份前端，由 `后端/paperpal/desktop.py` 启动。

## 开发约定

- 只用原生 ES Modules，无构建步骤；修改后刷新页面即可。
- 所有用户内容使用 `textContent` / `createElement`，不拼接 HTML。
- 触控目标不小于 52 px；新增交互必须同时提供键盘与读屏路径。
- 颜色、圆角、阴影走 `:root` 令牌，深色与高对比模式自动继承。
- 新增 API 时同步更新 `js/api.js`、`js/store.js` 与后端测试。

调试页：`/static/index.html` 保留原 OCR 模块的坐标可视化工具；`/docs` 是 FastAPI 接口文档。
