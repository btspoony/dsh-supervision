---
category: Added
---
- `dsh-sup` exits with a distinct code per outcome: `0` clean bye, `1` backend lost, `2` usage or no live backend, `3` session busy, `4` locked, `5` create failed, and `6` a protocol refusal from a backend that is still alive.
- A `list` run that hits several failures keeps the strongest signal: a lost backend outranks a coded refusal, and the exit code does not depend on registry order.
