---
category: Changed
---
- The in-process tty transport reads `DSH_SUP_TERMINAL_ID` first and the supervisor label reads `DSH_SUP_TERMINAL_NAME` first; herdr-core's `HC_TERMINAL_ID` and `HC_TERMINAL_NAME` remain as compatibility fallbacks, so an existing `hc` setup keeps working unchanged.
