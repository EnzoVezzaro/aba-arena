# Security Policy

ABA (ACC Battle Arena) is an **open-source, agentic-driven development project**.
It runs real coding agents inside sandboxes, so its security model is different
from the ACC framework's: ABA **executes code** (the harness, inside sandboxes),
**makes network calls** (to AI providers), and **stores credentials** (provider
API keys and GitHub tokens) locally. Read this policy before running it with
sensitive data or untrusted repositories.

We work hard to keep ABA **secure, privacy-conscious, reliable, and free of
bugs** — but ABA is open-source software in a rapidly evolving ecosystem, and
**we cannot guarantee that it will always be free of bugs, security
vulnerabilities, or unexpected behavior**.

If you discover a security issue, **please tell us as soon as possible**. Your
report helps us investigate, fix the problem, and protect other users.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use GitHub's private
[Security Advisories](https://github.com/EnzoVezzaro/aba-arena/security/advisories)
to report vulnerabilities.

When possible, include:

- A description of the vulnerability
- Steps to reproduce it
- The affected version or commit
- Potential impact
- Proof of concept or relevant files
- Possible mitigations or suggested fixes

If you're unsure whether something is a security vulnerability, **please report
it anyway**. We'd much rather take a look than have a real issue go unnoticed.

## What ABA Runs and Where

ABA's core loop: it snapshots a repository into two isolated copies, installs
`acc-agents` into one, and runs a coding-agent harness inside each sandbox
against the tasks you configure. Understanding where execution happens matters
for your threat model:

- **Sandbox mode (default when Docker is available):** the harness runs inside
  a Docker container per panel. Containers are isolated from your host and from
  each other, and are removed when a battle is stopped or deleted.
- **Host fallback mode (no Docker):** the harness runs on your local machine in
  a snapshot copy of the repository. This is **not** a security boundary —
  treat it like running the agent directly on your host.
- **The harness executes code.** Plan tasks are read-only; act tasks edit the
  repository and then **start the project** (running its `package.json`
  scripts) to verify it still works. The agent's edits run inside the sandbox,
  but the harness itself is agent-agnostic and will run whatever the agent
  wrote.

**ABA is not a sandbox for untrusted agents by itself.** In host fallback mode,
an agent (or a malicious repository's instructions) can affect your machine. Use
Docker mode, or run ABA on an isolated machine, when the repository or the
tasks are not fully trusted.

## Credentials

- **Provider API keys** and **GitHub tokens** are stored locally by ABA and are
  sent only to their intended services (the provider endpoints you configured,
  and GitHub for login/repository listing).
- **Never put keys in repository files.** ABA reads them from local storage —
  if you paste them into an `AGENTS.md`, a task prompt, or a benchmark
  repository, they may be read by the agents in the sandboxes and end up in
  battle history.
- The benchmark agent sees the repository and the task prompt — **do not run
  ABA against repositories that contain secrets** unless you are certain they
  belong there.

## Security Considerations

Repositories and task prompts are untrusted input. They may contain:

- Malicious instructions (an `AGENTS.md` that tells the agent to exfiltrate,
  escalate, or persist)
- Package scripts that run arbitrary commands at "start the project" time
- Symlinks and unusual filesystem structures
- Extremely large files or repositories (resource exhaustion)
- Files crafted to exploit ABA, the harness, or the AI SDK

Use appropriate caution when running ABA against repositories you do not fully
trust, and prefer Docker mode or an isolated environment for anything sensitive.

## Agentic Development

ABA exists to measure coding agents — which means it intentionally runs
untrusted agent output. New security and privacy risks are emerging in this
space constantly.

If you discover that ABA can:

- Escape its sandbox (in Docker mode)
- Access files outside the battle snapshot
- Leak credentials to unintended destinations
- Cause unexpected network activity
- Fail to clean up containers or processes after a battle
- Expose sensitive information in battle history or logs
- Or otherwise create a security risk

**please report it privately.** Your report can help make ABA safer for the
entire community.

## Recommended Practices

- **Prefer Docker mode** for anything you don't fully trust.
- **Keep ABA and its dependencies up to date.** Security fixes are only useful
  once you install them.
- **Use disposable API keys** and low-privilege GitHub tokens for benchmarking.
- **Never paste secrets into task prompts, repositories, or AGENTS.md files.**
- **Review battle history before sharing it** — the terminal output may contain
  repository paths, keys the agent echoed, or private details.
- **Report vulnerabilities responsibly.** Even a small observation can help us
  find a larger problem.

## Disclosure

When appropriate, reported vulnerabilities may be disclosed publicly after a fix
or mitigation is available. For significant vulnerabilities, we may coordinate
disclosure with the reporter. Security researchers who responsibly report
vulnerabilities may be credited in release notes, unless they prefer to remain
anonymous.

## Disclaimer

ABA is provided as **open-source software on an "AS IS" and "AS AVAILABLE"
basis**, to the fullest extent permitted by applicable law. The maintainers and
contributors cannot guarantee that ABA will always be free from bugs,
vulnerabilities, security issues, privacy risks, or unexpected behavior.

**Please protect yourself, protect your data, and use your best judgment when
using any open-source software.**
