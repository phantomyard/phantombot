# Contributor invariants

The numbered rules that used to live inline in [`/AGENTS.md`](../../../AGENTS.md), one file per area. The per-invariant index (number → title → file) is kept in AGENTS.md, which is what every agent session loads; these files hold the full text.

- [Architecture and the orchestrator](architecture-and-orchestrator.md) — the turn pipeline, prompt assembly and prompt-cache epochs, the embeddable engine.
- [Channels](channels.md) — the channel-agnostic core, the Telegram / PhantomChat / ACP adapters, streaming and reply modality.
- [Security perimeter](security-perimeter.md) — trusted vs untrusted input, the threat judge, the decision model, principal tiers.
- [Personas, config and credentials](personas-and-config.md) — the many-personas-one-process model, the two config layers, the vault and the retired `.env`.
- [Harnesses](harnesses.md) — the tool watchdog, spawn/kill/timeout coordination, the fallback chain, resume and nudge, native Pi.
- [Memory](memory.md) — drawers, the journal, daily recall, drawer import/export, embeddings, the nightly.
- [Scheduler and concurrency](scheduler-and-concurrency.md) — the turn registry, digests and workspace claims, the tick's wake budget.
- [Services and platforms](services-and-platforms.md) — systemd / launchd / Task Scheduler units, self-heal, macOS signing, Windows PATH.
- [Release and install](release-and-install.md) — the release pipeline and rings, versioning, the installers, `phantombot update`.
- [CLI, TUI and wizards](cli-tui-and-wizards.md) — the Ink app, the TTY gate, settings/brain/voice wizards, model pickers.
- [Testing](testing.md) — suite isolation from the developer's real HOME and live stores.
