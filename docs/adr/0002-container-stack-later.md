# 0002: The office as a container stack, later

Status: accepted as a plan, not built (owner decision, 2026-11-04)

## Context

The office is Windows first. Ungated agents (ADR 0001) run on the host with the user's rights. NVIDIA NemoClaw and its OpenShell sandbox (Landlock, seccomp, network namespace, network approval) were considered for them. OpenShell does not ask about file edits, is alpha on Windows (WSL2 only), and can run with no file limits when the kernel lacks Landlock. The owner dropped it and chose a container stack for the whole office as the future plan.

## Decision

- No container work now.
- New code (the ACP provider, the OpenClaw provider, the Paperclip adapter) keeps Windows-only parts behind the seams that exist: `resolveExe`, injected `spawn` and `execFile`, `auth.writeOwnerOnly`.
- New code reaches each harness only over stdio or loopback (127.0.0.1). It never reads another program's files to talk to it.

## What the move will change

- The 127.0.0.1 bind and the Host and Origin checks (`auth.checkRequest`): a container reaches the host through another address.
- Owner-only files: `writeOwnerOnly` uses icacls and a Windows ACL check. A container needs file modes or a secrets mount.
- Process stop: `taskkill` by pid.
- Start with Windows (`startup.mjs`, the Startup folder).
- "Non-Windows session launch" leaves Not built in `CLAUDE.md`.

## Consequences

- The container stack becomes the real sandbox for ungated agents: an agent sees only its worktree and the office.
- Until then, ungated agents run on the host, and ADR 0001's labels and opt-in are the protection.
