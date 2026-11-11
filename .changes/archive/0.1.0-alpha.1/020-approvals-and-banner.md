---
category: Added
---
- A tool approval raised inside the bridged session tree is parked under a short id and surfaces as `state=blocked:kind=permission` naming the tool and its reason, so the supervisor answers it without a second GUI: `/approve <ask>` settles it as `allowed-once`, `/reject <ask>` as `rejected`, `/y` and `/n` answer the only parked ask, and a withdrawn ask becomes `cancelled`.
- While a session is bridged the GUI shows a supervision banner above the composer with a **Take back control** button that posts to the reclaim route, drops the bridge and lets the forwarder exit cleanly.
