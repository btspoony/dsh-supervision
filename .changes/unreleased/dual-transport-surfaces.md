---
category: Added
---
- The plugin opens its control socket even when `dsh web` runs inside a supervised terminal: the in-process tty is now an additional reporting surface rather than an exclusive mode, so herdr-core keeps watching the terminal while a `dsh-sup` elsewhere can attach another session.
- A session still has exactly one bridge across both surfaces; a second claim is refused with `busy` — on the wire `hello`, on the `/attach` operator command, and for two hellos racing the same session — and the first bridge stays untouched.
- Only the tty's synthesized first session retries for up to 30 s while the profile boots without an agent factory; forwarder creates and `/new` keep failing fast with `create-failed`.
- A tty that cannot be opened no longer suppresses the socket surface.
