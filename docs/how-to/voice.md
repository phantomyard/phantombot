# Configure voice

Voice support covers speech-to-text for incoming audio and text-to-speech for
replies. Configure the provider interactively:

```bash
phantombot voice
```

The current setup supports ElevenLabs and OpenAI-compatible audio providers.
Provider credentials are stored in the persona's encrypted vault and validated
before the configuration is saved.

## Robot replies (free, local)

After the provider, the wizard asks who speaks the replies: the provider's own
voice, or the **robot** — espeak-ng on the phantom's machine, with no API key and
no per-reply cost. Incoming voice notes are still transcribed by the provider,
so the robot only ever replaces the reply voice, never the voice loop.

```toml
[voice]
provider = "openai-compatible"   # still transcribes incoming voice notes
tts = "robot"                    # replies spoken locally

[voice.robot]
voice = "female"                 # or "male"
```

| Voice | espeak-ng settings |
| --- | --- |
| `female` (default) | variant `f3`, 145 words/min, pitch 55 |
| `male` | variant `m3`, 130 words/min, pitch 30 |

Each reply is spoken in its own language when espeak-ng has a voice for it
(`nl+f3`, `de+m3`, …), otherwise in English. The robot needs `espeak-ng` and
`ffmpeg` (with libopus) on `PATH` — on Debian/Ubuntu `sudo apt install espeak-ng
ffmpeg` (espeak-ng is in `universe`); on Windows see
[Run Phantombot on Windows](../operations/windows.md#robot-voice-on-windows).
Replies arrive as OGG-Opus voice notes.
With provider `none` the robot setting is ignored: voice stays off.

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
