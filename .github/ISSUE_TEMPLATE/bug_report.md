---
name: Bug report
about: A battle, sandbox, panel, or provider isn't working as expected
title: "[bug] "
labels: ["bug"]
assignees: []
---

<!-- Thanks for reporting. ABA runs real agents in real sandboxes, so
     details about the run matter: provider, panel, sandbox mode, and
     what the terminal showed. -->

## What happened

<!-- Describe the failure in one or two sentences. Include what the
     terminal in the Answer panel showed, if anything. -->

## Battle context

- Provider + model: <!-- e.g. OpenAI gpt-5-mini, NVIDIA nim, local Ollama -->
- Sandbox mode: <!-- docker, or local fallback -->
- Task mode: <!-- plan or act -->
- Repo used: <!-- local path, GitHub URL, or connected-GitHub repo -->
- Did the "start the project" step run? <!-- yes / no / never reached -->

## Steps to reproduce

1. Open ABA and configure the panel(s)…
2. Start a battle…
3. …

## Expected vs actual

<!-- What should have happened (task completed, project started, winner
     declared) vs. what actually happened. Paste output/logs if you can. -->

## Environment

- OS: <!-- macOS, Linux, Windows -->
- Node: <!-- `node --version` -->
- aba version: <!-- `npm ls acc-battle-arena` or package.json version -->
- Browser: <!-- e.g. Chrome 130, Safari 18 -->

## After the failure

- [ ] The sandboxes were cleaned up (no leftover containers / processes)
- [ ] I restarted and the problem reproduced
- [ ] It only happened once / it happens every time

<!-- ABA must always clean up its sandboxes when a battle is stopped or
     deleted — if leftovers remain, that's a bug on its own. -->
