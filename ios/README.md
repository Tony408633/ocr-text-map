# 纸伴 iOS 原生 App（MVP）

## 先选路线：三种“放到手机上”的方式

| 方式 | 界面在哪 | 服务在哪 | 需要 Mac 吗 | 相机 / 识别 | 适合 |
| --- | --- | --- | --- | --- | --- |
| **A. 网页 + 添加到主屏幕（PWA）** | 手机 Safari 全屏 | 电脑 | ❌ 不用 | ✅（HTTPS 下） | 今天就要用、不想折腾 |
| **B. 网页壳 App（`ios/WebShell`）** | 手机 App 里的 WKWebView | 电脑 | ✅ 需要 | ✅ | 想要一个真正的 App 图标、不用输网址 |
| **C. 全原生 App（`ios/PaperPal`）** | 手机原生 SwiftUI | 电脑优先 + 本机降级 | ✅ 需要 | ✅ | 想彻底摆脱电脑 |

A 和 B **界面与功能完全不变**——还是 `前端/` 那一套页面，服务还是在 Windows 上（RapidOCR + SQLite）。
C 是把识别换成本机 Apple Vision，属于重写，见下面「原生 App」部分。

---

## 让它“像原生 App”：已经做好的四层

| 层 | 做了什么 | 在哪 |
| --- | --- | --- |
| ① 外壳参数 | `display: standalone`、`viewport-fit=cover`、`apple-mobile-web-app-*`、`theme-color`（明/暗）、主屏图标 | `manifest.webmanifest`、`index.html` |
| ② 去浏览器感 | `overscroll-behavior: none`（无下拉刷新/橡皮筋）、`-webkit-tap-highlight-color: transparent`、界面元素禁止长按选中与系统菜单、按钮 `touch-action: manipulation`（去 300 ms 双击缩放延迟）、`100dvh` + `env(safe-area-inset-*)` 适配刘海与底部横条 | `styles.css` |
| ③ 交互动感 | **启动画面**（品牌 + 淡出，避免白屏）、触感反馈（`navigator.vibrate` → WebView 里走原生 `UIImpactFeedbackGenerator`）、路由切换动画、`is-standalone` 标记（已装到主屏时隐藏“添加到主屏幕”提示） | `index.html`、`app.js`、`ui.js` |
| ④ 原生容器 | WKWebView 全屏、无地址栏、无滚动回弹、无滚动条、无链接预览；首启可扫码填地址；底部原生工具条 | `ios/WebShell/` |

### 还差什么才算“完全原生”

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 顶部状态栏样式固定 | 由系统控制，网页只能选 `default / black / black-translucent` | 想要完全自定义就上 WebView 壳或原生 |
| iOS 上 PWA 没有振动 | Safari 不支持 `navigator.vibrate` | 用 WebView 壳（已接原生触感） |
| 分享文件、保存到“文件” | WKWebView 的 `navigator.share` 受限 | 需要加原生分享桥（后续） |
| 上架 App Store / TestFlight | 需要开发者账号 + 原生容器 | 已有 WebShell 可打包 |



---

## A. 最快：网页装到主屏幕（不需要 Mac）

1. 电脑双击 **`启动手机隧道.bat`**，得到 `https://xxx.trycloudflare.com`（公网 HTTPS，任意网络可用）。
2. 手机 Safari 打开这个地址。
3. 分享菜单 → **添加到主屏幕** → 桌面上就有“纸伴”图标，点开是全屏、无地址栏。
4. 之后每次先启动隧道，再点图标。

界面、朗读、扫描、批注、蓝牙耳机按键全部和电脑上一样；**服务仍在电脑**。

> 用 `启动手机测试.bat`（局域网 8443）也可以，但第一次要装一次证书；隧道方式不用装。
> 也可以用 GitHub Pages 的 `https://<你的账号>.github.io/ocr-text-map/` 装到主屏幕——但那是**纯界面演示**（没有后端，不能识别书页）。

---

## B. 网页壳 App：把同一个页面装成 App（需要 Mac）

`ios/WebShell/` 只有 4 个文件，作用就一件事：**全屏显示你的网页**，并记住地址。

- 首次打开：填地址 / 扫电脑上的二维码 / 选“演示界面”；
- 之后打开 App 直接进入页面，没有地址栏、没有标签页；
- 底部四个按钮：返回、刷新、换地址、用 Safari 打开；
- 网页里的相机、麦克风、蓝牙耳机按键、PWA 全部照常工作（`requestMediaCapturePermission` + 自签证书处理已经写好）。

### 跑起来

**XcodeGen（推荐）**

```bash
brew install xcodegen
cd ios && xcodegen generate && open PaperPal.xcodeproj
# 选择 PaperPalWeb scheme → 选你的 iPhone → ⌘R
```

**手动新建**

1. Xcode → File → New → Project → iOS App，名字 `PaperPalWeb`，Interface **SwiftUI**
2. 删除模板的 `ContentView.swift`、`PaperPalWebApp.swift`
3. 把 `ios/WebShell/` 下 4 个 `.swift` 拖进工程
4. Target → Info 添加：`NSCameraUsageDescription`、`NSMicrophoneUsageDescription`、`NSAppTransportSecurity → NSAllowsLocalNetworking = YES`
5. Signing 选你的 Apple ID → ⌘R

### 填什么地址

| 场景 | 电脑上运行 | App 里填 |
| --- | --- | --- |
| 任意网络（推荐） | `启动手机隧道.bat` | `https://xxx.trycloudflare.com`（不需要开自签证书） |
| 同一 Wi-Fi | `启动手机测试.bat` | `https://电脑IP:8443` + 打开「接受自签 HTTPS 证书」 |
| 只局域网、不装证书 | `后端\start-lan.ps1 -Port 8090` | `http://电脑IP:8090` |
| 只看看界面 | —— | `https://<你的账号>.github.io/ocr-text-map/` |

---

## C. 全原生 App（识别在本机，可选）

这是给两周汇报准备的 iPhone 原生版本。核心思路：

> **iPhone 负责看、读、记；识别优先交给你们自己的 Windows（已经在跑的那套 RapidOCR），连不上就自动用 iPhone 本机的 Apple Vision。**

所以它既不是“纯网页”，也不是“必须联网”，而是一个**双通道客户端**：

| 能力 | 在哪里完成 |
| --- | --- |
| 相机取景、连续自动扫描的节奏控制 | iPhone（AVFoundation） |
| 文字识别 | Windows 的 `/auto-scan`；不可用时切 Apple Vision |
| 逐行朗读 | iPhone（AVSpeechSynthesizer，中文，离线） |
| 耳机播放 / 暂停、上一首 / 下一首 | iPhone（MPRemoteCommandCenter） |
| 书架 / 批注 / 进度 | 服务器模式存在 Windows；本机模式存在手机 |

---

### C1. 最快跑起来（15 分钟）

### 前提

- 一台 **Mac**，装好 **Xcode 15 或 16**
- 一个 **Apple ID**（免费即可）
- 一台 **iPhone** + 数据线（iOS 16 以上）

### 方式 A：用 XcodeGen（推荐，命令少）

```bash
brew install xcodegen      # 只装一次
cd ios
xcodegen generate          # 生成 PaperPal.xcodeproj
open PaperPal.xcodeproj
```

### 方式 B：手动新建（没装 XcodeGen 时）

1. Xcode → **File → New → Project → iOS → App**
2. Product Name 填 `PaperPal`，Interface 选 **SwiftUI**，Language 选 **Swift**，取消勾选 Core Data / Tests
3. 删除模板里的 `ContentView.swift` 和 `PaperPalApp.swift`
4. 把 `ios/PaperPal/` 里**所有 `.swift` 文件**拖进工程（勾选 Copy items if needed）
5. Target → General → **Minimum Deployments** 设为 **iOS 16.0**
6. Target → Info → 添加三项权限（见第 4 节），并加上 ATS 的 `NSAllowsLocalNetworking = YES`

### 签到自己手机上

1. Xcode 左侧点工程 → **Signing & Capabilities** → Team 选你的 Apple ID（没有就 Add Account）
2. Bundle Identifier 改成唯一值，例如 `com.你的名字.paperpal`
3. 手机连电脑 → 顶部设备选你的 iPhone → **⌘R**
4. 手机上：设置 → 通用 → VPN与设备管理 → 信任你的开发者证书
5. 打开 App → 允许相机

> 免费账号的 App **7 天过期**。答辩前一天重新 ⌘R 安装一次即可。

---

## 2. 连接 Windows 服务（这正是你要的“Windows 当服务器”）

App 里：**设置 → 识别方式 → 连接电脑**，填地址，点「测试连接」。

三种地址，按场景选：

| 场景 | 电脑上运行 | App 里填 | 需要证书吗 |
| --- | --- | --- | --- |
| **局域网 HTTP（原生 App 专用，最简单）** | `后端\start-lan.ps1 -Port 8090` | `http://电脑IP:8090` | **不需要** |
| 局域网 HTTPS（和网页版共用一套） | `启动手机测试.bat` | `https://电脑IP:8443` + 打开「接受自签证书」 | 不需要装，App 里放开校验即可 |
| **任意网络 / 校园网隔离** | `启动手机隧道.bat` | 出现的 `https://xxx.trycloudflare.com` | 不需要（公网证书） |

- 电脑 IP 用 `ipconfig` 看 WLAN 的 IPv4，例如 `192.168.1.10`。
- 8080 常被代理或其它软件占用（这台机器上就占用过），所以示例统一用 **8090**；冲突时换一个端口即可。
- 电脑地址也可以**直接扫**：打开手机页二维码 → App 里「扫描电脑上的二维码」，会自动填地址并按需打开自签证书开关。
- 如果电脑设置了 `PAPERPAL_TOKEN`，把同一个口令填到「访问令牌」。
- 防火墙：`启动手机测试.bat` 会自动请求放行；用 `start-lan.ps1` 时如果连不上，用管理员 PowerShell 执行：

```powershell
netsh advfirewall firewall add rule name="PaperPal Lan 8090" dir=in action=allow protocol=TCP localport=8090 profile=any
```

### 连不上会自动降级

`设置 → 使用电脑识别` 打开时，App 启动会先 `GET /api/health`：

- 通 → 服务器模式（识别、批注、进度都在电脑）
- 不通 → 自动切换本机 Vision 识别，界面顶部会显示“电脑连不上，已切换到本机识别”

所以**答辩当天电脑出问题也不会开天窗**。

---

## 3. 已实现的功能（MVP）

- [x] 相机实时取景（后置、竖屏）
- [x] **连续自动扫描**：画面模糊/没变化时不动，清晰且变化才识别
- [x] 判断「同一页 / 翻页 / 往回翻」，翻页自动页码 +1 并从第一行朗读
- [x] 同一页重新识别时按文字相似度**找回原来那一行**（不跳行、不错行）
- [x] 逐行朗读、上一行 / 下一行、暂停 / 继续、每行自动接读
- [x] 字号、语速、音高设置
- [x] 阅读进度保存（本机 / 电脑）
- [x] 批注（当前行 / 整页；本机 / 电脑）
- [x] 蓝牙耳机按键（播放/暂停、上一首/下一首）+ 锁屏“正在播放”
- [x] 连接电脑：地址、令牌、扫码、连通性测试、自签证书开关
- [x] 演示内容（答辩兜底）
- [x] 无障碍：大按钮（≥64pt）、VoiceOver 标签、状态语音播报

## 4. 权限（Info.plist）

`ios/PaperPal/Info.plist` 已经写好；如果你是用 Xcode 新建的工程，在 **Target → Info** 里手动加：

| Key | 值 |
| --- | --- |
| `NSCameraUsageDescription` | 纸伴需要用相机看书页，才能识别文字并读给你听。 |
| `NSMicrophoneUsageDescription` | 语音批注需要用麦克风（后续功能）。 |
| `NSSpeechRecognitionUsageDescription` | 语音转文字（后续功能）。 |
| `NSAppTransportSecurity → NSAllowsLocalNetworking` | `YES`（允许连局域网 HTTP 的电脑） |

> 原生 App 的相机**不需要 HTTPS**，这是它比 Safari 省事的地方。

---

## 5. 文件结构

```
ios/
├── project.yml                    # XcodeGen 工程描述（两个 target：PaperPal / PaperPalWeb）
├── WebShell/                      # 网页壳 App（4 个文件：把现有页面装进 iPhone）
│   ├── Info.plist
│   ├── PaperPalWebApp.swift
│   ├── WebController.swift
│   ├── WebShellView.swift
│   └── SetupView.swift
├── PaperPal/
│   ├── Info.plist                 # 权限与 ATS
│   ├── PaperPalApp.swift          # @main 入口
│   ├── RootView.swift             # 标签栏 + 首页
│   ├── LiveReaderView.swift       # 阅读页：相机条 + 当前行 + 控制 + 批注
│   ├── MoreViews.swift            # 书架 / 批注 / 设置 / 设备 / 连接电脑 / 扫二维码
│   ├── ReaderModel.swift          # 核心：相机→识别→朗读→进度的编排
│   ├── ServerClient.swift         # 调 Windows 的 5 个接口（URLSession）
│   ├── ServerSettings.swift       # 服务器地址 / 令牌持久化
│   ├── Models.swift               # 数据模型 + 文字相似度 + 自动扫描阈值
│   ├── AppStore.swift             # 本机 JSON 存储（书 / 页 / 批注 / 进度）
│   ├── OCREngine.swift            # Apple Vision 中文识别（降级通道）
│   ├── CameraEngine.swift         # 相机采集 + 预览
│   ├── AutoScanner.swift          # 自动扫描节奏控制（清晰度 / 位移 / 间隔）
│   ├── SpeechEngine.swift         # 朗读 + 静音保活（耳机按键）
│   └── RemoteControls.swift       # 蓝牙耳机按键 / 锁屏信息
└── README.md
```

`@main` 在 `RootView.swift` 顶部（`PaperPalApp`）。

---

## 6. 验证情况（请务必看）

- 后端接口、自动判页逻辑、文字相似度：在 Windows 上用真实服务验证过（Python 测试 + 真实 OCR）。
- **Swift 代码没有在真机/Mac 上编译过**（我的环境是 Windows，装不了 Xcode）。第一次打开工程大概率会出现少量编译告警，常见于：
  - iOS 17 对 `onChange(of:)` 的弃用警告（可忽略）
  - 免费签名 / Bundle ID 冲突
  - `MainActor` 相关警告（Swift 6 严格并发下才是错误）
- 建议流程：**D1 就先把工程跑起来（能启动、能开相机），再往里填功能**，不要等到最后一天才编译。

---

## 7. 已知限制（MVP 范围外）

| 限制 | 说明 | 之后的改法 |
| --- | --- | --- |
| 服务器模式固定使用“电脑上第一本书” | 书架页能看到电脑上的书，但还不能点进去切书 | 在 `ReaderModel.start()` 里接收 bookId 参数 |
| 电脑上的批注只读 | 批注列表能看，删除/编辑仍在网页端 | 接 `PATCH/DELETE /notes/{id}` |
| 没有语音听写批注 | 先用手打字 | 接 `SFSpeechRecognizer` |
| 竖排书支持一般 | Apple Vision 对竖排较弱；服务器模式用 RapidOCR 同样需要调试 | 横排演示，或后续训练 |
| 耳机按键依赖音频会话 | 已在 `SpeechEngine` 里保活；个别耳机把双击做在固件里，收不到 | 换播放/暂停键或换耳机 |

---

## 8. 两周排期（可直接贴进周报）

| 天 | 事情 | 谁 |
| --- | --- | --- |
| D1 | Mac + Xcode 跑通工程，真机启动、相机预览 | 技术 1 |
| D2 | 连接电脑（三种地址）、测试连接、扫码填地址 | 技术 1 |
| D3–4 | 服务器模式：自动扫描 → 识别 → 朗读 主链路 | 技术 1+2 |
| D5 | 本机 Vision 降级通道 + 同一页判重 | 技术 2 |
| D6–7 | 阅读页打磨：进度、翻页自动接读、错行修复 | 技术 2 |
| D8–9 | 批注（行 / 整页）、书架展示 | 技术 1 |
| D10 | 耳机按键 + 锁屏信息 + 蓝牙键盘 | 技术 1 |
| D11 | 无障碍：VoiceOver、大按钮、状态播报 | 设计 1 |
| D12 | 真机联调：弱光、翻页、断网降级 | 全员 |
| D13 | 演示脚本 + 录屏（含电脑不可用的备用段） | 设计 2 |
| D14 | 答辩材料与彩排 | 全员 |

---

## 9. 演示脚本（5 个动作，2 分钟）

1. 首页点「放好书，自动开始读」→ 把书放好（不碰手机）
2. 听到“第 1 页，开始朗读”→ 说明“没有按任何按钮”
3. 按耳机播放键 → 暂停；再按 → 继续
4. 翻一页 → 自动识别、页码 +1、从第一行接着读
5. 点右上角加一条批注 → 回到批注页能看到，并点「听」播出来

彩排时务必额外演练一次**拔掉电脑网线**的降级版本：顶部提示“已切换到本机识别”，功能继续可用。
