# bridex-plugin-elevenlabs

ElevenLabs for Bridex agents: voiceover in any voice (your own or the shared
library), with word timings and ready subtitles; transcription with speakers;
sound effects and music; and the rest of the API through `eleven_api` /
`eleven_run`. Outputs land in the task's artifacts with provenance — voice,
model, settings.

## Install

From the Bridex plugin catalog (Settings → Plugins → Catalog), then set the
key: **Settings → Integrations → ElevenLabs** (`ELEVENLABS_API_KEY`). It is a
separate key from the dashboard voice assistant's `ELEVENLABS_PERSONA_KEY`.
Give the key the permissions the tools use: text to speech, speech to text,
voices read, models read, sound effects, music — and for `eleven_run`
whatever its operations need (audio isolation, voice changer, dubbing…).

Optional `bridex.yaml`:

```yaml
plugins:
  elevenlabs:
    config:
      api_key: ${ELEVENLABS_API_KEY}     # default
      default_model: eleven_v3             # plays audio tags; eleven_multilingual_v2 takes longer texts
      output_format: mp3_44100_128        # mp3_44100_192, pcm_44100 (saved as .wav), opus_48000_128
```

## Tools

| Tool | Cost | What |
|---|---|---|
| `eleven_voices` | free | find a voice: the account's own, or the shared library by description ("warm british narrator"), language and gender |
| `eleven_models` | free | speech models, their languages and text limits |
| `eleven_speak` | **paid** (characters) | voice a text (up to 5k characters a call on v3, 10k on the others) into `artifacts/<task>/`; `with_timestamps` adds `.srt` subtitles and word timings |
| `eleven_sfx` | **paid** | a sound effect from a description, 0.5–30 s |
| `eleven_music` | **paid** (minutes) | music from a description, 3 s–10 min, instrumental on request |
| `eleven_transcribe` | **paid** (minutes) | Scribe: audio or video → text, `.json` with every word's time and speaker, ready `.srt`; `keyterms` for names |
| `eleven_api` | free | the rest of the API, read live from ElevenLabs' own description: list operations, see one's parameters |
| `eleven_run` | **paid** where ElevenLabs charges | call one of them — voice isolation, forced alignment, voice changer, voice design and cloning, dialogue, dubbing, stems, video-to-music…; files in and out through artifacts. Account administration and every DELETE stay with the owner |

## Acting with v3 tags

The default model, `eleven_v3`, lets the text carry audio tags that steer the
performance: `[laughs] [laughs harder] [starts laughing] [wheezing]
[whispers] [sighs] [exhales] [pauses] [sarcastic] [curious] [excited]
[crying] [snorts] [mischievously] [sings] [woo] [applause] [clapping]
[swallows] [gulps]`, plus `…` for a pause. Sparingly — one or two per
paragraph, where a person would really do it. Other models do not understand
tags. The `.srt` from `with_timestamps` leaves tags out.

Usage is recorded in characters (and effects), not dollars: the price per
character depends on the ElevenLabs plan. An exhausted quota raises one
needs-a-person card in the Inbox.
