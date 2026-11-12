![A running dsh web session in the browser, bridged to a terminal supervisor that reads OSC 7501: state goes out, operator input comes back into the same session](preview.svg)

The plugin runs inside the `dsh web` process that already owns the session, so nothing is restarted or duplicated.
- **Control socket (solid):** the plugin serves a `0600` Unix socket in `$DSH_HOME/supervision`; `dsh-sup` in the supervisor's PTY connects, writes the OSC 7501 and echo records to its own `/dev/tty`, and relays the owner's stdin back as `line` frames.
- **In-process tty (dashed):** with `DSH_SUP_TERMINAL_ID` set (or herdr-core's `HC_TERMINAL_ID`), `dsh web` also writes the same records to its own `/dev/tty`; the control socket stays open for a `dsh-sup` in another PTY.
- **Approval parking:** an `approval/request` from the bridged tree is parked under a six-hex id, the root record becomes `blocked · kind=permission`, and `/approve` or `/reject` settles it as `allowed-once` or `rejected`.
- **stdin relay:** one input line is one `line` frame — bare text steers, and `/cancel`, `/status`, `/new`, `/attach`, `/approve`, `/reject`, `/y`, `/n` are commands.
