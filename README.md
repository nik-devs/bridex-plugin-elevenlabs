# bridex-plugin-elevenlabs

ElevenLabs for Bridex agents: voiceover in any voice (your own or the shared
library), with word timings and ready subtitles, and sound effects. Outputs
land in the task's artifacts with provenance — voice, model, settings.

## Install

From the Bridex plugin catalog (Settings → Plugins → Catalog), then set the
key: **Settings → Integrations → ElevenLabs** (`ELEVENLABS_API_KEY`). It is a
separate key from the dashboard voice assistant's `ELEVENLABS_PERSONA_KEY`.
Give the key the permissions the tools use: text to speech, voices read,
models read, sound effects.

Optional `bridex.yaml`:

```yaml
plugins:
  elevenlabs:
    config:
      api_key: ${ELEVENLABS_API_KEY}     # default
      default_model: eleven_multilingual_v2
      output_format: mp3_44100_128        # mp3_44100_192, pcm_44100 (saved as .wav), opus_48000_128
```

## Tools

| Tool | Cost | What |
|---|---|---|
| `eleven_voices` | free | find a voice: the account's own, or the shared library by description ("warm british narrator"), language and gender |
| `eleven_models` | free | speech models, their languages and text limits |
| `eleven_speak` | **paid** (characters) | voice a text (up to 10k characters a call) into `artifacts/<task>/`; `with_timestamps` adds `.srt` subtitles and word timings |
| `eleven_sfx` | **paid** | a sound effect from a description, 0.5–30 s |

## Acting with v3 tags

With `model_id: eleven_v3` the text can carry audio tags that steer the
performance: `[laughs] [laughs harder] [starts laughing] [wheezing]
[whispers] [sighs] [exhales] [pauses] [sarcastic] [curious] [excited]
[crying] [snorts] [mischievously] [sings] [woo] [applause] [clapping]
[swallows] [gulps]`, plus `…` for a pause. Sparingly — one or two per
paragraph, where a person would really do it. Other models do not understand
tags. The `.srt` from `with_timestamps` leaves tags out.

Usage is recorded in characters (and effects), not dollars: the price per
character depends on the ElevenLabs plan. An exhausted quota raises one
needs-a-person card in the Inbox.
