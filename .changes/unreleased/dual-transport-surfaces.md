---
category: Added
---
- The plugin opens its control socket even when `dsh web` runs inside a supervised terminal: the in-process tty is now an additional reporting surface rather than an exclusive mode, so herdr-core keeps watching the terminal while a `dsh-sup` elsewhere can attach another session.
- A session still has exactly one bridge across both surfaces; a second attach is refused with `busy` and leaves the first bridge untouched.
- The tty's first session retries for up to 30 s while the profile boots without an agent factory, instead of reporting a spurious `create-failed` and leaving the supervisor in `error`.
- A tty that cannot be opened no longer suppresses the socket surface.
