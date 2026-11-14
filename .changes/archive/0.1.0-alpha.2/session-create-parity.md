---
category: Fixed
---
- A session created by `dsh-sup` (`new`, or a bare hello) now carries the profile's default model selection and mounts the default agent preset, so its first turn no longer fails with "no provider/model" and its tool set includes bash and the file tools — the same shape the GUI creates.
- The plugin reads `agentDefaultModel` and `agentPresets` reflectively, so a host without those services keeps the plain create.
