# DSH Shortcutter · 0.1.40

DSH 桌面端的单键快捷插件（界面名称 **Shortcutter**）。通过**快捷模式**用左手键位切换区域、新建并直接输入、切换工具标签与全局页面，支持中文输入法下直接按键，不修改或替换宿主原有交互。

## 基本用法

- **快捷模式**：页面没有输入框聚焦时默认开启（左上角圆点标记当前区域）；点击输入框打字时自动退出，失焦后安静恢复。
- **回到快捷模式**：在对话、侧栏、全局页面、设置输入框或浏览器地址栏按 **Esc**；在终端与网页内容中按 **⌥ Esc**（可在插件页切换为 **⌃ Esc** 或录制自定义组合键）。
- **进入内容**：按 **i** 或鼠标点击进入对话输入、终端、网页或页面首个输入框；用 **n c / n b / n t** 新建会话、浏览器或终端时自动进入输入。
- **查看与配置**：快捷模式下按 **?** 展开 / 收起键位面板；点击面板右上角 **⚙**（或按 `g e` 打开插件页 → **Shortcutter**）修改快捷键设置。

## 默认键位

| 键位 | 动作 |
| --- | --- |
| `s` | 展开 / 收起左侧栏 |
| `c` | 回到对话（右侧全屏时先恢复面板） |
| `r` / `R` | 展开或收起工具面板 / 放大或恢复面板 |
| `b` / `t` / `e` | 切换浏览器 / 终端 / 文件（已打开当前类型时再按一次收起面板） |
| `n c` / `n b` / `n t` | 新建会话 / 浏览器 / 终端，并直接聚焦输入区（地址栏提交有效网址后自动回到快捷模式） |
| `Tab` / `⇧ Tab` | 下一个 / 上一个右侧工具标签 |
| `g` + `1`..`9` | 按 `g` 时右侧标签浮现序号，再按数字直达对应工具标签 |
| `w` | 关闭当前工具标签，或关闭设置 / 插件 / 定时任务页面 |
| `i` | 进入当前内容输入 |
| `f` | 搜索会话名称或工作区；`↑` / `↓` 选择，`Enter` 打开，`Esc` 返回 |
| `g b` | 上一个会话 |
| `g e` / `g a` / `g s` | 打开插件 / 定时任务 / DSH 设置 |
| `?` | 展开 / 收起键位提示 |

会话搜索默认优先显示本次窗口内最近访问的会话，其余按更新时间排列；不显示已归档会话、子代理会话和非当前的空白会话。只搜索会话名称和工作区，不读取消息正文。搜索期间不切换会话，按 `Enter` 或点击结果才打开，草稿仍由 DSH 保留。升级会自动补上 `f`；若 `f` 已有自定义用途，会保留原绑定，并在插件设置中提示为“搜索会话”另设键位。

> **macOS 提示**：若将回到快捷模式手动改为 `⌘ Esc` 且无响应，通常是 macOS“游戏叠层”占用了系统快捷键（可在 **系统设置 → 键盘 → 键盘快捷键… → 调度中心** 中关闭“游戏叠层”，或直接使用默认的 `⌥ Esc` / `⌃ Esc`）。

## 安装与卸载

在 DSH **插件** 页面添加 `git+https://github.com/bywangdong/dsh-shortcutter.git#main`，或通过桌面应用自带 CLI 安装：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add 'git+https://github.com/bywangdong/dsh-shortcutter.git#main'
```

首次 Git 安装若提示 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，按提示将该包键写入对应 profile `pnpm-workspace.yaml` 的 `allowBuilds` 后重试；或使用本地预构建包免脚本安装：

```sh
npm run pack:local
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add ./dist/dsh-shortcutter-0.1.40.tgz --offline --ignore-scripts
```

卸载可在 DSH **插件** 页面操作，或运行：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop remove dsh-shortcutter
```

## 开发验证

```sh
npm run build
npm test
DSH_PERF_TOOLCHAIN=/path/to/deepseek-harness npm run test:browser
npm run test:install
```
