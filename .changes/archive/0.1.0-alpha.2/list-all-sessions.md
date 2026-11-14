---
category: Changed
---
- `dsh-sup list` now lists every session on every live backend; `--cwd` narrows the table to one directory. The CWD column already names where each session lives, so filtering by the caller's directory only hid the rest.
- The table carries a `PID` column naming the backend each row came from, so a listing that spans several `dsh web` processes stays attributable.
