---
name: upgrade-resume
description: Prepare BB thread recovery before an authorized upgrade, inspect recovery outcomes, or cancel pending continuations.
---

Use `bb upgrade-resume --help` for the installed command contract.

Before an already-authorized BB upgrade, run `bb upgrade-resume prepare` immediately before the external deployment process stops the service. Add `--project <project-id>` to limit the snapshot. Check the exit status and recorded thread count before continuing deployment.

After BB restarts, use `bb upgrade-resume status --json` to inspect recovery. The plugin automatically checks pending entries every five seconds. `bb upgrade-resume resume` checks immediately. A plugin reload alone does not activate a prepared batch.

For `uncertain`, inspect the thread's latest messages, queued work and runtime before manually continuing it. A request may have reached BB even if its response was lost. `bb upgrade-resume cancel` cancels remaining pending entries; accepted messages remain in BB.

The plugin prepares and resumes work. Execute service replacement through the installation's existing authorized deployment workflow. Full behavior and verification limits are in [README.md](../../README.md).
