![preview](https://raw.githubusercontent.com/btspoony/dsh-supervision/main/docs/preview.svg)

# dsh-supervision

[English](README.md) | [中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/dt/dsh-supervision)](https://www.npmjs.com/package/dsh-supervision)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](package.json)
![node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)
![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-4B32C3.svg)

Supervise the `dsh web` process you already have running from herdr-core (`hc`). The plugin lives inside that process: it reports the supervised session as **OSC 7501** records on a terminal and takes operator input — steer a running turn, cancel it, create or attach a session, approve or reject a parked tool approval — back into that same session, so a supervisor watches the session you actually work in instead of a second copy of it. Two transports carry it: a **control socket** driven by the small `dsh-sup` forwarder that runs in the `hc` PTY, or — when `dsh web` itself is started inside an `hc` terminal — the **process's own tty**, with no forwarder and no socket at all. Neither DSH nor herdr-core changes.

## Topology

One `dsh web` process owns one session tree; the plugin mounts in it and opens exactly one transport.

```text
dsh web (the process you already run)
└── dsh-supervision plugin
      ├── control socket   $DSH_HOME/supervision/<pid>-<8hex>.sock   (0600)
      │     └── dsh-sup in the hc PTY ── OSC 7501 + echo lines ──▶ herdr-core
      └── in-process tty   (only when HC_TERMINAL_ID is set)
            └── OSC 7501 written to this process's own /dev/tty
```

**Activation.** In the socket path the plugin always opens its discovery surface — the listener, the `0600` socket and the `<pid>-<8hex>.json` registry entry that names it — so a forwarder has something to connect to. The effect layer (session listeners, OSC reports, echo lines, stdin handling) mounts per bridge, which is the same fact as "a forwarder is connected". A GUI-only `dsh web` therefore exposes an inert socket and nothing else. With `HC_TERMINAL_ID` non-empty the process is its own supervisor: nothing is created, the terminal is the whole discovery surface. If that terminal cannot be opened — no `/dev/tty` and a non-TTY stdout, or a stdin that is not a terminal — the plugin writes the reason to stderr and mounts nothing, so the host keeps its sessions.

**Approvals park the root report.** While a bridge is live the plugin prepends an `approval/request` listener for that session's tree. An ask is parked under a six-hex id and the root record becomes `state=blocked:kind=permission` with `msg=<tool> <reason> [ask <id>]`; the ask is settled by `/approve <ask>` (`allowed-once`) or `/reject <ask>` (`rejected`), by `/y` / `/n` when exactly one is parked, or as `cancelled` when the asker withdraws. A session switch (`/new`, `/attach`) is refused while an ask is parked, and teardown fails every parked ask closed before the socket goes.

**stdin relay.** The forwarder splits its own stdin on `\r`, `\n` or `\r\n` and sends each line as a `line` frame; the plugin parses it and acts: bare text steers the agent, `/cancel` cancels the turn, `/status` answers `session=… state=… turn=… asks=…`, `/new <absolute path>` and `/attach <session-…>` switch sessions, `/approve` / `/reject` answer a named ask. `/dev/tty` is the reporting surface on both paths (stdout when it is a TTY); that is what herdr-core reads, not our stdout.

**Taking the session back.** While a session is bridged the GUI shows a supervision banner above the composer — `Supervised from <terminal> (pid <n>) · approvals are answered there` — with a **Take back control** button. It posts to the reclaim route; the bridge is dropped, the supervisor reports the clear record, and a `dsh-sup` forwarder exits `0`.

## Quick start

### Install

**Plugins page** — in DeepSeek Harness open the **Plugins** page, click **Add plugin**, enter `dsh-supervision` and install; then restart as the host asks. The GUI writes into the `web` profile, the same profile the command below targets.

**CLI** — for scripted setups:

```sh
dsh plugin --profile web add dsh-supervision   # the plugin, into the web profile
npm i -g dsh-sup                               # the forwarder, for the hc PTY
```

`dsh-sup` is a separate package because it runs as its own program in the `hc` PTY. Pin a version with `@<version>`.

### Connect a session

```sh
dsh-sup                                  # create a session in the dsh web process's directory
dsh-sup --cwd ~/work/project             # create it elsewhere (resolved here, then sent absolute)
dsh-sup attach session-abc123            # attach an existing session (or: dsh-sup session-abc123)
dsh-sup --pid 4711 new                   # pick the backend when several dsh web processes run
dsh-sup list                             # list the sessions a forwarder may attach
```

`list` prints one table for every live backend and binds nothing:

```text
SESSION            CWD                LIVE  BRIDGED
session-4f2a…      /Users/me/work     yes   -
```

Backends are found through `$DSH_HOME/supervision` (`~/.dsh/supervision` when `DSH_HOME` is unset). A bridge needs exactly one live backend; with several, the refusal names each candidate's `pid` and socket, and `--pid` picks one. `--cwd` applies to `new` and `list` only.

### Answer an approval

Ask where the session stands, then answer the parked ask by id:

```text
/status
session=session-4f2a… state=blocked turn=3 asks=3f9ac1

/approve 3f9ac1
[ask 3f9ac1] bash → allowed-once (source=supervisor)
```

`/y` and `/n` answer the only parked ask; with more than one parked they refuse and ask you to name it.

## Supervision protocol

The facts a supervisor needs, all of them on this repository's wire:

**Socket and registry.** One Unix socket per `dsh web` process, mode `0600`, at `$DSH_HOME/supervision/<pid>-<8hex>.sock`, next to a `<pid>-<8hex>.json` entry `{proto, pid, socket, startedAt, dshVersion}` written atomically and mode `0600`. A session has exactly one bridge: a second connection claiming it is refused with `error` code `busy` and closed. Frames are NDJSON, `PROTO` is `1`, one frame is at most 64 KiB.

| Direction | Frames |
|---|---|
| forwarder → plugin | `hello` (`attach` a session, `new {cwd}`, or bare), `line {text}`, `list {cwd?}`, `bye` |
| plugin → forwarder | `welcome`, `osc {data}`, `echo {text}`, `sessions {items}`, `error {code, message}`, `bye {reason}` |

`error.code` is one of `busy`, `unknown-session`, `create-failed`, `locked`, `protocol`, `internal`.

**OSC 7501 output.** One record is replaced whole on every report, so every field is restated:

```text
ESC ] 7501 ; state=<idle|working|done|blocked|error>[ :id=<child id>][ :kind=<permission|question|auth>][ :app=<word>][ :title=<base64>][ :msg=<base64>] ST
```

A clear is `state=clear` for the root, `state=clear:id=<id>` for one child record. `kind` is legal only on `blocked`. Caps: sequence under 4096 bytes, title 192 bytes, `msg` 2048 bytes, id 128 bytes as `/`-joined segments of at most 32 bytes each (8 segments). The root word is `blocked` > `working` > `done` / `error` / `idle`, and a parked approval outranks a live turn.

**Routes**, served only when the host mounts a webserver:

| Route | Answer |
|---|---|
| `GET /dsh-supervision/state` | `{"proto":1,"sessions":{"<session id>":{"bridged":true,"terminal":"…","pid":<n>,"since":<ms>,"asks":["<ask id>"]}}}`; `405` for another method |
| `POST /dsh-supervision/reclaim` | `content-type: application/json`, body `{"session":"<id>"}` under 4 KiB → `200 {"reclaimed":true}`; `409 {"reclaimed":false}` when no bridge held it; `415` for another content type, `400` for a bad body |

**Echo lines** the supervisor reads, in the order they are written: `[turn <n>] <state>` on a state change, `[ask <id>] <tool> parked (<session>)`, `[ask <id>] <tool> → <outcome> (source=supervisor|attached)`, the `/status` answer above, `refused: <n> approval(s) parked`, `new failed: …`, `attach failed: …`, `unknown command /<verb>`.

**Exit codes of `dsh-sup`:** `0` clean `bye`, `1` backend lost, `2` usage or no live backend, `3` `busy`, `4` `locked`, `5` `create-failed`, `6` `protocol` (a frame this process refused, so the backend is alive).

## Configuration

Six keys, all of them read by `src/index.ts`; an unknown shape is refused with a field-level issue instead of half-applying.

| Key | Default | What it does |
|---|---|---|
| `enabled` | `true` | Mount anything at all. `false` is a hard off switch: no socket, no routes, no banner. |
| `programStatus` | `true` | Emit OSC 7501 reports. Off leaves the socket answering `list` only. |
| `echo` | `true` | Mirror state changes and approval decisions as `echo` lines for the supervisor. |
| `app` | `"dsh"` | The program word every report restates. |
| `titleFrom` | `"cwd-basename"` | Where the root title comes from: `cwd-basename`, `session-title`, or `none`. |
| `socketDir` | `$DSH_HOME/supervision` | Registry and socket directory. |

Environment variables it reads:

| Variable | Read by | Effect |
|---|---|---|
| `DSH_HOME` | plugin and `dsh-sup` | Registry directory base; defaults to `~/.dsh`. |
| `HC_TERMINAL_ID` | plugin | Non-empty ⇒ in-process tty transport. No socket, no registry entry, no forwarder. |
| `HC_TERMINAL_NAME` | plugin | The supervisor label the state route reports; defaults to `dsh-sup`. |

Both `HC_*` variables are read, never written, by this package.

## Links

| Doc | Content |
|---|---|
| [docs/DETAIL.md](docs/DETAIL.md) | the one-screen figure caption: topology, both transports, approval parking, stdin relay |
| [docs/preview.svg](docs/preview.svg) | the figure shown at the top of this page |
| [docs/preview.zh.svg](docs/preview.zh.svg) | the Chinese figure, same geometry |
| [CHANGELOG.md](CHANGELOG.md) | released changes |

## License

Released under the **MIT** License — the `license` field in [package.json](package.json) is authoritative.
