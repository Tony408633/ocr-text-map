# 纸伴 · 后端

这里放纸伴的后端、OCR 模块、测试和启动脚本。前端在项目根目录的 `前端/` 中。

```
后端/
├── paperpal/              FastAPI + SQLite 后端、桌面窗口启动器
│   ├── text.py            繁简转换与可选在线翻译
│   └── ...
├── ocr-text-map-main/     原有 OCR / 版面分析模块（B 模块）
├── tests/                 接口测试
├── data/                  数据库与书页图片（运行后生成）
├── requirements*.txt
├── start.ps1              网页版
├── start-lan.ps1          手机 / iPhone 局域网访问
├── start-app.ps1          桌面 App
└── start-app.bat          桌面 App 的批处理入口
```

## 启动

在项目根目录：

```powershell
.\后端\start-app.ps1       # 独立 App 窗口
.\后端\start.ps1           # 网页版
.\后端\start-lan.ps1       # 手机 / iPhone 局域网访问
```

或在 `后端` 目录：

```powershell
python -m paperpal desktop
python -m paperpal serve --host 127.0.0.1 --port 8000
```

手机相机、PWA 离线安装需要 HTTPS；阅读和批注在 HTTP 下也可用。详见项目根目录 [README](../README.md) 的 iPhone 兼容性说明。

## 数据

默认数据库和书页图片在 `后端/data/`：

```
data/
├── paperpal.db
└── images/
```

可用环境变量 `PAPERPAL_DATA_DIR` 改到其他目录。

## 测试

在项目根目录：

```powershell
.\后端\.venv\Scripts\python.exe -m pytest
```

完整说明见项目根目录 [README](../README.md)。
