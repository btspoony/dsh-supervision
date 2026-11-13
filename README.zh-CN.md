![preview](https://raw.githubusercontent.com/btspoony/dsh-supervision/main/docs/preview.zh.svg)

# dsh-supervision

[English](README.md) | [中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/dt/dsh-supervision)](https://www.npmjs.com/package/dsh-supervision)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](package.json)
![node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)
![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-4B32C3.svg)

**把运行中的 DSH 会话桥接到任意终端 supervisor 上——状态可见，指令可发。** 插件就装在你已经在运行的那个 `dsh web` 进程里：[**OSC 7501**](https://www.superlogical.com/rex/docs/build/program-status) 记录写到终端上，操作者输入回到同一个会话。herdr-core（`hc`）是受支持的一种 supervisor，也是参考实现；只要能从 PTY 读到 OSC 7501、又能往那个 PTY 的 stdin 写行，任何 supervisor 都可以。

## 你能得到什么

- **每个会话一条状态记录。**被桥接的会话是**根记录**，同一进程里其他存活会话作为带 `id=` 的**子记录**随它上报；状态取 `idle` / `working` / `done` / `blocked` / `error`，每次变化整条替换，不会留下增量补丁。
- **操作者输入被送回会话。**中途 steer 一轮、取消本轮、`/status`、`/new`、`/attach`，以及 `/approve` / `/reject` 应答挂起的工具审批——都在终端里完成。
- **审批不再只活在另一个界面里。**挂起的提问变成根记录上的 `blocked · kind=permission`，在终端里结掉；GUI 会显示监督横幅和「Take back control」。

## 能搭配哪些 supervisor

| Supervisor | 连接方式 | 需要什么 |
|---|---|---|
| herdr-core（`hc`） | 进程内 tty，走它自己的 `HC_TERMINAL_ID`（宿主导出 `DSH_SUP_TERMINAL_ID` 时也可用）**并且**走控制套接口，让 `dsh-sup` 跑在它的 PTY 里；两条通路同时可用 | 被监督的终端里有一个 `dsh web`，外加任意 PTY |
| 任何读 OSC 7501 的 supervisor | 控制套接口 + 把它自己的 PTY 交给 `dsh-sup` | 能读到该 PTY 的 OSC 输出，并能往该 PTY 的 stdin 写行 |
| 另一种想用进程内模式的 supervisor | 设置 `DSH_SUP_TERMINAL_ID` | 这个变量只被本包读取、从不写入；任何 supervisor 都可以设置它 |
| 只开 GUI 的 `dsh web` | 不需要任何东西 | 插件只暴露一个不干活的套接口，别的什么都没有 |

## 快速开始

### 安装

**插件页面**——在 DeepSeek Harness 里打开 Plugins 页面，点「Add plugin」，填 `dsh-supervision` 安装，然后按宿主提示重启。GUI 写入 `web` profile，与下面命令的目标是同一个。

**命令行**——脚本化安装用：

```sh
dsh plugin --profile web add dsh-supervision   # the plugin, into the web profile
npm i -g dsh-sup                               # the forwarder, for the supervisor's PTY
```

`dsh-sup` 是单独的包，因为它以独立程序的身份跑在 supervisor 的 PTY 里。要固定版本就加 `@<version>`。

### 连接会话

```sh
dsh-sup                                  # create a session in the dsh web process's directory
dsh-sup --cwd ~/work/project             # create it elsewhere (resolved here, then sent absolute)
dsh-sup attach session-abc123            # attach an existing session (or: dsh-sup session-abc123)
dsh-sup --pid 4711 new                   # pick the backend when several dsh web processes run
dsh-sup list                             # list every session on every live backend
```

`list` 对每个存活后端打印一张表，不建立任何桥接。它读的是与侧边栏同一份会话账目：持久化过的会话即使当前没有加载 agent 也会列出（`LIVE no`），而已归档的会话（除非正被桥接持有）与空白会话（从未有过 turn）都不列出。`PID` 列标明该行来自哪个 `dsh web` 进程，多后端时也能对得上：

```text
SESSION            PID    CWD                LIVE  BRIDGED
session-4f2a…      4711   /Users/me/work     yes   -
```

后端通过 `$DSH_HOME/supervision` 发现（`DSH_HOME` 未设置时是 `~/.dsh/supervision`）。建立桥接恰好需要一个存活后端；有多个时拒绝信息会列出每个候选的 `pid` 与套接口，用 `--pid` 选定一个。`--cwd` 只对 `new` 和 `list` 生效；`list` 不带它时列出全部会话，CWD 列说明每个会话在哪个目录。

桥接期间 stdin 仍走终端自己的行模式——插件从不进入 raw 模式——因此 `Ctrl+C`、`Ctrl+Z`、`Ctrl+\`、输入回显与行编辑都和没装插件时一样。`Ctrl+S`/`Ctrl+Q` 仍由终端驱动做流控：走 `/dev/tty` 时终端暂停会让桥接记录进入有序队列，不阻塞宿主，恢复后照常写出；没有控制终端而退回 stdout 时仍是同步写，暂停仍会卡住它。操作者的输入按行读取，回车后生效；行规程会按 `MAX_CANON` 限制单行长度（Linux 4 KB、macOS 1 KB），超长的粘贴到达 agent 时会被截断。

**空会话不会出现在 Web UI 列表。** 这里创建的会话已经挂到对应项目，但 DSH 侧边栏只列出发过第一条消息的会话；在那之前它只存在于 `dsh-sup list` 与桥接上，项目下没有条目。从终端发一行（或 attach 后 steer）它就会出现。

### 应答审批

挂起的提问带六位十六进制 id；先问会话现在处于什么状态，再按 id 应答：

```text
/status
session=session-4f2a… state=blocked turn=3 asks=3f9ac1

/approve 3f9ac1
[ask 3f9ac1] bash → allowed-once (source=supervisor)
```

`/y` 与 `/n` 应答唯一挂起的提问；挂起不止一个时它们会拒绝，并要求你指名。有提问挂起期间，`/new` 与 `/attach` 会被拒绝；提问方撤回时，提问以 `cancelled` 结掉。

### 把会话拿回来

只要会话处于桥接状态，GUI 输入框上方就会出现监督横幅——`Supervised from <terminal> (pid <n>) · approvals are answered there`——旁边是「Take back control」按钮。它请求回收路由；桥接被丢弃，监督方收到清除记录，`dsh-sup` 转发器以 `0` 退出。

## 如何上报

一个 `dsh web` 进程拥有一棵会话树，插件挂在其中，开控制套接口；当进程本身跑在被监督的终端里时，再叠加一条进程内 tty 通路。

```text
dsh web (the process you already run)
└── dsh-supervision plugin
      ├── control socket   $DSH_HOME/supervision/<pid>-<8hex>.sock   (0600)
      │     └── dsh-sup in the supervisor's PTY ── OSC 7501 + echo lines ──▶ supervisor (reads OSC 7501)
      └── in-process tty   (added when DSH_SUP_TERMINAL_ID or HC_TERMINAL_ID is set)
            └── OSC 7501 written to this process's own /dev/tty
```

**挂载规则。**插件总是先把套接口发现面打开——监听器、`0600` 套接口，以及指向它的 `<pid>-<8hex>.json` 注册表条目——这样转发器才有东西可连。效果层（会话监听、OSC 上报、echo 行、stdin 处理）按桥接打开，"有一条桥接"和"有转发器已连接"是同一件事。因此一个只开 GUI 的 `dsh web` 只暴露一个不干活的套接口，别的什么都没有。当 `DSH_SUP_TERMINAL_ID` 非空（或 herdr-core 的 `HC_TERMINAL_ID` 非空）时，进程同时监督自己所在的终端：同样的记录写到自己的 `/dev/tty`，套接口仍然为别处的 `dsh-sup` 开着。一个会话在两条通路上仍只有一条桥接，第二个认领者会收到 `busy`。如果终端打不开——既没有 `/dev/tty`、stdout 也不是 TTY，或者 stdin 不是终端——插件把原因写到 stderr，并保留套接口这条路。

## 写给实现者与 agent

这一半是写给实现者与编码 agent 的参考材料；只想使用的人可以跳到[链接](#链接)。

### 仓库地图

| 路径 | 内容 |
|---|---|
| `src/` | 插件本体，以及注入 GUI 的客户端横幅 |
| `packages/protocol` | OSC 7501 编码器与 NDJSON 帧 |
| `packages/cli` | `dsh-sup` 转发器 |
| `lib/` | 构建产物 |
| `docs/` | 图与图注 |
| `.agents/adr`、`.agents/knowledge` | 架构决策记录与架构/踩坑笔记 |
| `.changes/` | 发布片段 |
| `locale/` | 插件页面文案 |

### 监督协议

监督方需要的全部事实，都在这套线上：

**套接口与注册表。**每个 `dsh web` 进程一个 Unix 套接口，权限 `0600`，位于 `$DSH_HOME/supervision/<pid>-<8hex>.sock`，旁边是原子写入、同样 `0600` 的 `<pid>-<8hex>.json` 条目 `{proto, pid, socket, startedAt, dshVersion}`。一个会话只有一条桥接：第二个连接来认领时会被以 `error` 码 `busy` 拒绝并关闭。帧是 NDJSON，`PROTO` 为 `1`，单帧最大 64 KiB。

| 方向 | 帧 |
|---|---|
| 转发器 → 插件 | `hello`（`attach` 某会话、`new {cwd}`，或不带目标）、`line {text}`（按 stdin 的 `\r`、`\n` 或 `\r\n` 切行）、`list {cwd?}`、`bye` |
| 插件 → 转发器 | `welcome`、`osc {data}`、`echo {text}`、`sessions {items}`、`error {code, message}`、`bye {reason}` |

`error.code` 取 `busy`、`unknown-session`、`create-failed`、`locked`、`protocol`、`internal` 之一。

**OSC 7501 输出。**每条记录写到 `/dev/tty`（stdout 是 TTY 时退而用它），supervisor 读的是那里。每次上报都整条替换旧记录，所以每个字段都要重述：

```text
ESC ] 7501 ; state=<idle|working|done|blocked|error>[ :id=<child id>][ :kind=<permission|question|auth>][ :app=<word>][ :title=<base64>][ :msg=<base64>] ST
```

清除是根记录用 `state=clear`、单条子记录用 `state=clear:id=<id>`。`kind` 只在 `blocked` 上合法。上限：整条序列小于 4096 字节，title 192 字节，`msg` 2048 字节，id 128 字节且按 `/` 分段、每段至多 32 字节（最多 8 段）。根词优先级为 `blocked` > `working` > `done` / `error` / `idle`。挂起的审批把根记录写成 `state=blocked:kind=permission`，`msg=<tool> <reason> [ask <id>]`。

**路由**，只在宿主挂载了 webserver 时提供：

| 路由 | 应答 |
|---|---|
| `GET /dsh-supervision/state` | `{"proto":1,"sessions":{"<session id>":{"bridged":true,"terminal":"…","pid":<n>,"since":<ms>,"asks":["<ask id>"]}}}`；其他方法 `405` |
| `POST /dsh-supervision/reclaim` | `content-type: application/json`，请求体 `{"session":"<id>"}` 且小于 4 KiB → `200 {"reclaimed":true}`；没有桥接持有该会话时 `409 {"reclaimed":false}`；其他 content type `415`，请求体不合法 `400` |

**监督方读到的 echo 行**，按写入顺序：状态变化时 `[turn <n>] <state>`，`[ask <id>] <tool> parked (<session>)`，`[ask <id>] <tool> → <outcome> (source=supervisor|attached)`，上面那条 `/status` 应答，`refused: <n> approval(s) parked`，`new failed: …`，`attach failed: …`，`unknown command /<verb>`。

**`dsh-sup` 退出码：**`0` 正常 `bye`，`1` 后端丢失，`2` 用法错误或没有存活后端，`3` `busy`，`4` `locked`，`5` `create-failed`，`6` `protocol`（本进程拒发某帧，说明后端还活着）。

### 配置

六个键，全部由 `src/index.ts` 读取；形状不对会带着字段级问题被拒绝，不会半应用。

| 键 | 默认值 | 作用 |
|---|---|---|
| `enabled` | `true` | 是否挂载任何东西。`false` 是硬开关：没有套接口、没有路由、没有横幅。 |
| `programStatus` | `true` | 是否发出 OSC 7501 上报。关掉后套接口只回答 `list`。 |
| `echo` | `true` | 是否把状态变化与审批决定镜像成 supervisor 读的 `echo` 行。 |
| `app` | `"dsh"` | 每条上报都要重述的程序名。 |
| `titleFrom` | `"cwd-basename"` | 根标题来源：`cwd-basename`、`session-title` 或 `none`。 |
| `socketDir` | `$DSH_HOME/supervision` | 注册表与套接口目录。 |

它读取的环境变量：

| 变量 | 读取方 | 作用 |
|---|---|---|
| `DSH_HOME` | 插件与 `dsh-sup` | 注册表目录的基路径，默认 `~/.dsh`。 |
| `DSH_SUP_TERMINAL_ID` | 插件 | 非空 ⇒ 额外叠加一条进程内 tty 通路；控制套接口与注册表照常打开。 |
| `DSH_SUP_TERMINAL_NAME` | 插件 | 状态路由上报的 supervisor 标签，默认 `dsh-sup`。 |
| `HC_TERMINAL_ID` | 插件 | herdr-core 兼容：同一条通路，仅在 `DSH_SUP_TERMINAL_ID` 未设置或为空时读取。 |
| `HC_TERMINAL_NAME` | 插件 | herdr-core 兼容：标签，仅在 `DSH_SUP_TERMINAL_NAME` 未设置或为空时读取。 |

两个 `DSH_SUP_*` 变量及其 `HC_*` 兼容变量都只被本包读取、从不写入。

### 不变量

改动不能破坏这些：

1. **一个会话一条桥接。**第二个认领者拿到 `busy` 并被断开；套接口与进程内 tty 可以同时分别桥接不同会话，但同一会话在两条通路上仍只有一条桥接。
2. **一条记录整体替换。**每次上报都要重述每个字段，清除也一样；没有增量更新。
3. **挂起的审批压过正在跑的一轮。**根词优先级 `blocked` > `working` > `done` / `error` / `idle`。
4. **卸载先结账。**桥接离开、回收、插件卸载或提问方撤回时，每个挂起的提问都以 `cancelled` 结掉——失败关闭，绝不留下悬挂。
5. **终端变量只读。**进程内通路与它的标签由环境选择，不由配置选择；本包从不写这些变量。
6. **上限是硬限制。**整条 OSC 7501 序列 < 4096 字节，title 192 字节，`msg` 2048 字节，id 128 字节（按 `/` 分段，每段 ≤32 字节，最多 8 段）；单帧 64 KiB。

## 链接

| 文档 | 内容 |
|---|---|
| [CHANGELOG.md](CHANGELOG.md) | 已发布的变更 |

## 许可证

以 **MIT** 许可证发布——以 [package.json](package.json) 里的 `license` 字段为准。
