# WeiScheduler（尉定时任务调度器）

WeiScheduler 是一个基于 Node.js 的本地网页调度工具，用于按 Cron 表达式定时执行 Python 脚本。支持多种 Python/Conda 环境配置，适用于数据处理、自动化任务和脚本调度场景。

English:
WeiScheduler is a web-based local task scheduler built on Node.js, designed to execute Python scripts based on Cron expressions. It supports multiple Python and Conda environment configurations, making it suitable for data processing, automation workflows, and scheduled scripting tasks.

当前版本：`1.2.2`
Latest Version: `1.2.2`

核心定位：
一个轻量级、本地优先的 Python 定时任务调度器，强调环境兼容性和可视化管理。

Core Positioning:
A lightweight, local-first Python task scheduler focused on environment compatibility and visual management.

版本更新记录见 [CHANGELOG.md](./CHANGELOG.md)。

## 功能

- 配置任务名称、Python 可执行文件、脚本路径、参数、工作目录、Cron 表达式
- 支持直接 Python、Conda 环境名、Conda 环境路径三种执行方式
- 支持 Cron 五段自由组合输入，并保留常用预设
- 可选配置时间参数名称和值，执行时自动追加到命令行
- 启用或禁用调度
- 立即手动执行任务
- 支持最小化到系统托盘，关闭窗口后继续后台调度
- 手动执行失败时，弹窗显示具体错误内容
- 任务列表直接显示最近失败原因
- 任务列表和详情显示“下次执行时间”
- 保存最近运行日志和状态
- 使用本地 `data/tasks.json` 持久化任务数据
- Conda 环境名支持跨机器解析，优先读取 Conda 环境列表，不依赖固定用户名和固定盘符
- Windows 安装器按系统语言显示名称：英文环境 `WeiScheduler`，中文环境 `尉定时任务调度器`

## 版本亮点

`1.2.2`：

- 修复任务数据文件损坏时桌面端启动直接失败的问题，损坏数据会自动备份并重建空任务库
- 补充 README 中的清理旧产物与 Windows 安装包打包指令

`1.2.1`：

- 新增最小化到系统托盘能力，关闭窗口后调度器仍可在后台继续运行
- 补充软件中英文简介、核心定位和版本说明，统一更新关于页元数据
- 安装器按系统语言显示名称：英文环境为 `WeiScheduler`，中文环境为 `尉定时任务调度器`

`1.2.0`：

- 修复跨小时 Cron 任务稳定性问题，为 `每 3 小时`、`每 6 小时` 等表达式增加服务端补偿触发
- 新增 `每 6 小时` 预设，并在任务列表中显示对应的人类可读描述

`1.1.10`：

- 任务列表和详情新增“下次执行”具体时间显示，便于直接确认下一次触发时刻

`1.1.9`：

- 提升 Conda 环境名解析稳定性，适配不同电脑上的不同环境目录
- 手动执行失败时显示更完整的错误详情
- 修复失败日志丢失后只显示 `failed` 的问题
- 增强 Cron 配置交互，支持更灵活的时间组合

## 启动

```bash
npm install
npm start
```

Web 开发模式默认从 `http://localhost:3000` 启动；如果 `3000` 已被占用，程序会自动切换到可用端口。

桌面版会自动打开实际运行端口对应的页面，无需手动处理端口。

开发模式下，Electron 会直接加载本地源码。

重新构建 Windows 安装包前，建议先清理旧产物：

```bash
Remove-Item -Recurse -Force release, dist
```

然后执行打包：

```bash
npm run build:installer
```

打包完成后，安装包和解包目录会生成在 `release/` 下。

## 字段说明

- `执行方式`: 选择直接 Python 或 Conda 环境
- `Python/Conda 命令路径`: 直接 Python 时必填 `python.exe`；Conda 模式选填，建议填写 Conda 根目录或 `conda.exe` 路径以提高解析稳定性
- `Conda 环境名或路径`: Conda 模式必填
- `脚本路径`: 需要执行的 `.py` 文件
- `启动参数`: 按命令行形式填写，例如 `--name demo --count 5`
- `时间参数名`: 可选，例如 `--run-time`
- `时间参数值`: 可选，留空时执行时自动传当前时间
- `工作目录`: 可选，不填时默认用脚本所在目录
- `Cron 时间表达式`: 使用 `分 时 日 月 周` 五段格式，例如 `*/5 * * * *` 表示每 5 分钟执行一次，`0 9 * * 1-5` 表示工作日 09:00 执行

## 常见 Cron 示例

- `*/5 * * * *`: 每 5 分钟执行一次
- `0 * * * *`: 每小时整点执行
- `0 */3 * * *`: 每 3 小时执行一次
- `0 */6 * * *`: 每 6 小时执行一次
- `0 9 * * 1-5`: 工作日 09:00 执行
- `30 23 * * *`: 每天 23:30 执行

## 数据文件

任务保存在 `data/tasks.json`。

## Conda 跨机器建议

- 跨电脑共享任务时，优先使用 `Conda 环境名`
- `Conda 目标` 只填环境名，例如 `py3143`
- 不要把任务绑定到某一台机器的绝对环境路径，例如 `C:\Users\Administrator\.conda\envs\py3143`
- 程序会优先通过 Conda 环境列表定位环境，解析不到时再回退到本机目录扫描和 `conda run`
