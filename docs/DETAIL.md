![The supervision topology: a dsh web session, the plugin's control socket and in-process tty transports, the dsh-sup forwarder, herdr-core, and the approval parking and stdin relay paths](preview.svg)

The plugin runs inside the `dsh web` process that already owns the session, so nothing is restarted or duplicated.
- **Control socket (solid):** the plugin serves a `0600` Unix socket in `$DSH_HOME/supervision`; `dsh-sup` in the `hc` PTY connects, writes the OSC 7501 and echo records to its own `/dev/tty`, and relays the owner's stdin back as `line` frames.
- **In-process tty (dashed):** with `HC_TERMINAL_ID` set, `dsh web` is itself inside the supervised terminal, so it writes the same records to its own `/dev/tty` — no socket and no forwarder.
- **Approval parking:** an `approval/request` from the bridged tree is parked under a six-hex id, the root record becomes `blocked · kind=permission`, and `/approve` or `/reject` settles it as `allowed-once` or `rejected`.
- **stdin relay:** one input line is one `line` frame — bare text steers, and `/cancel`, `/status`, `/new`, `/attach`, `/approve`, `/reject`, `/y`, `/n` are commands.
