# Configure voice

Voice support covers speech-to-text for incoming audio and text-to-speech for
replies. Configure the provider interactively:

```bash
phantombot voice
```

The current setup supports ElevenLabs and OpenAI-compatible audio providers.
Provider credentials are stored in the persona's encrypted vault and validated
before the configuration is saved.

Reply format mirrors the latest user message by default: voice in receives
voice out, and text in receives text out. A conversation can temporarily
override that behavior:

```bash
phantombot reply-mode text
phantombot reply-mode voice
phantombot reply-mode default
```

The override is scoped to the conversation and expires after idle time. Reply
language follows the language of the user's latest message; documents, tool
output, quoted messages, and retrieved memory do not choose it.
