# Manage personas

A persona is an isolated identity and runtime home. It owns its prompt files,
memory, knowledge base, channel identities, harness settings, and encrypted
vault. Several personas can run inside one daemon without sharing credentials
or conversation state.

Open the persona manager:

```bash
phantombot persona
```

Use the same command to create, list, import, or switch personas. For scripted
imports, inspect the installed command first:

```bash
phantombot persona --help
```

Persona data lives under the platform data root. Do not copy only one file
when moving a persona: identity, local configuration, memory, channel state,
and vault data are a unit. Use the supported import and restore flows so that
persona-scoped credentials and configuration remain isolated.

The default persona is the one used by bare terminal commands. Additional
personas can be selected per channel or configured to start alongside it. A
missing optional harness does not prevent the daemon starting; `phantombot
doctor` reports the effective chain and availability.

See also [Harnesses and models](harnesses-and-models.md),
[Channels](channels.md), and [Memory](memory.md).
