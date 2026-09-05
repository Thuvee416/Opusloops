<p align="center">
  <img src="assets/Banner.png" alt="Opusloops" width="520">
</p>

<p align="center">
  <a href="https://github.com/Thuvee416/Opusloops/actions/workflows/pages.yml"><img src="https://img.shields.io/github/actions/workflow/status/Thuvee416/Opusloops/pages.yml?branch=main&label=production" alt="生产部署"></a>
  <a href="https://github.com/Thuvee416/Opusloops/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue.svg" alt="GPL-3.0"></a>
</p>

<p align="center">创作 · 编排 · 演进</p>

Opusloops 是一款安静、克制、触控优先的循环音乐工作室，以可安装的移动 Web 应用运行。你可以用 Web Audio 编写节奏、排列灵感、完成轻量混音，并把工程保存在自己的设备上。

<p align="center">
  <strong><a href="https://thuvee416.github.io/Opusloops/">打开 Opusloops</a></strong>
</p>

- [English](README.md) | **简体中文**
- [问题反馈](https://github.com/Thuvee416/Opusloops/issues) · [源代码](https://github.com/Thuvee416/Opusloops)

## 为移动端而设计

- **触控步进音序器**：无需桌面尺寸的控件即可添加或清除步进
- **内置循环与声音**：由 Web Audio 驱动，不需要扫描或安装插件
- **紧凑混音器**：在手机尺寸的界面上调整音量和静音状态
- **本地工程**：将作品保存在当前设备的浏览器存储中
- **可离线安装**：首次成功加载后，可添加到主屏幕并在离线时重新打开
- **平静界面**：温暖的中性色、克制的动效与清晰的单一主操作

Opusloops 不需要通过 App Store 或 Play Store 下载。请在受支持的移动浏览器中打开生产地址，并使用浏览器的“添加到主屏幕”或“安装应用”功能。

## 本地运行

生产 PWA 位于 [`mobile/`](mobile/)，无需包管理器或原生工具链。

```bash
git clone https://github.com/Thuvee416/Opusloops.git
cd Opusloops
python3 -m http.server 4173 --directory mobile
```

然后打开 `http://localhost:4173`。请使用本地服务器，而不是直接打开 `mobile/index.html`，这样 Service Worker 与离线路径才会按生产环境工作。

## 生产环境

推送到 `main` 后，`mobile/` 的内容会部署至 [https://thuvee416.github.io/Opusloops/](https://thuvee416.github.io/Opusloops/)。工作流成功代表部署完成；仍需重新请求生产地址，才能确认线上版本。

## 旧版桌面源代码

本仓库保留了来自上游历史的 GPL C++ DAW 源代码与兼容标识符。该桌面应用、外部插件托管与扫描、MCP、OSC、Lua 控制器接口和桌面安装包都不属于 Opusloops 的移动生产目标。

旧版源代码仅用于来源记录和迁移工作。为了避免破坏既有工程或协议，部分内部目录名称可能保留历史标识符。详见 [NOTICE.md](NOTICE.md) 与[旧版兼容说明](manual/docs/legacy-desktop.md)。

## 贡献与安全

提交拉取请求前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全漏洞请按照 [SECURITY.md](SECURITY.md) 私密提交。

## 许可证与来源说明

Opusloops 采用 GNU General Public License v3.0 发布。许可证见 [LICENSE](LICENSE)，上游来源和第三方声明见 [NOTICE.md](NOTICE.md)。
