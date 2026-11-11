---
category: Added
---
- Supervision applies to the `dsh web` process that already runs the session, not to a second copy: the plugin publishes a `0600` control socket and a registry entry under `$DSH_HOME/supervision/`, so a forwarder discovers it without any change to the host.
- `dsh-sup` connects from the terminal, reports the supervised session as OSC 7501 records on `/dev/tty`, and relays the operator's stdin back into that same session — bare text steers the running turn, `/cancel` cancels it, `/status` answers with session, state, turn and parked asks, and `/new <absolute path>` / `/attach <session-id>` switch sessions.
- `dsh-sup list` prints one table per live backend instead of one merged listing, and reports a backend that cannot answer rather than letting it look empty.
