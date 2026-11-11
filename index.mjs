import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * ElevenLabs plugin: voiceover, sound effects and music for agents. Voices and models
 * are browsed for free; speech and effects are paid and land in the task's
 * artifacts with provenance (voice, model, settings). Speech can come with
 * word timings and a ready .srt, so a video step can burn captions without a
 * separate transcription pass.
 *
 * The key is its own ELEVENLABS_API_KEY credential (Settings → Integrations),
 * read per call so it can be set without a restart. The dashboard voice
 * assistant's ELEVENLABS_PERSONA_KEY is a different key on purpose.
 *
 *   plugins:
 *     elevenlabs:
 *       enabled: true
 *       config:
 *         api_key: ${ELEVENLABS_API_KEY}        # optional; this is the default
 *         default_model: eleven_v3             # plays [tags]; eleven_multilingual_v2 for longer texts
 *         output_format: mp3_44100_128
 */

const API = "https://api.elevenlabs.io";
/** One request's text: v3 takes up to 5k characters, the multilingual/flash models 10k. */
const textCap = (model) => (model === "eleven_v3" ? 5_000 : 10_000);

const EXT_BY_FORMAT = (f) => (f.startsWith("mp3") ? "mp3" : f.startsWith("pcm") ? "wav" : f.startsWith("opus") ? "opus" : "bin");

const resolveRef = (ref) => String(ref ?? "").replace(/\$\{([A-Z0-9_]+)\}/g, (_, n) => process.env[n] ?? "");
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "audio";

/** Raw PCM from the API → a playable WAV (16-bit mono). */
function wavFromPcm(pcm, sampleRate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Audio tags a v3 performance understands; they steer the voice and never belong in subtitles. */
const V3_TAGS =
  "[laughs] [laughs harder] [starts laughing] [wheezing] [whispers] [sighs] [exhales] [pauses] [sarcastic] [curious] [excited] [crying] [snorts] [mischievously] [sings] [woo] [applause] [clapping] [swallows] [gulps]";

/** Character timings → words → subtitle cues (≤ 42 chars, ≤ 3.5 s, split at sentence ends); [tags] dropped. */
function srtFromAlignment(al) {
  const chars = al?.characters ?? [];
  const starts = al?.character_start_times_seconds ?? [];
  const ends = al?.character_end_times_seconds ?? [];
  const words = [];
  let cur = null;
  let inTag = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    // a v3 audio tag is performed, not said: keep it out of the captions
    if (c === "[") inTag = true;
    if (inTag) {
      if (c === "]") inTag = false;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur) words.push(cur);
      cur = null;
      continue;
    }
    if (!cur) cur = { text: "", start: starts[i] ?? 0, end: ends[i] ?? 0 };
    cur.text += c;
    cur.end = ends[i] ?? cur.end;
  }
  if (cur) words.push(cur);
  const cues = [];
  let cue = null;
  for (const w of words) {
    const fits = cue && (cue.text + " " + w.text).length <= 42 && w.end - cue.start <= 3.5;
    if (!fits) {
      if (cue) cues.push(cue);
      cue = { text: w.text, start: w.start, end: w.end };
    } else {
      cue.text += " " + w.text;
      cue.end = w.end;
    }
    if (/[.!?…]$/.test(w.text)) {
      cues.push(cue);
      cue = null;
    }
  }
  if (cue) cues.push(cue);
  const ts = (s) => {
    const ms = Math.max(0, Math.round(s * 1000));
    const p = (n, l = 2) => String(n).padStart(l, "0");
    return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  return cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join("\n");
}

/** Scribe's timed words → subtitle cues (≤ 42 chars, ≤ 3.5 s, split at sentence ends); spacing and sound tags skipped. */
function srtFromWords(words) {
  const cues = [];
  let cue = null;
  for (const w of words) {
    if (w.type && w.type !== "word") continue;
    const t = String(w.text ?? "").trim();
    if (!t) continue;
    if (cue && (cue.text + " " + t).length <= 42 && w.end - cue.start <= 3.5) {
      cue.text += " " + t;
      cue.end = w.end;
    } else {
      if (cue) cues.push(cue);
      cue = { text: t, start: w.start ?? 0, end: w.end ?? 0 };
    }
    if (/[.!?…]$/.test(t)) {
      cues.push(cue);
      cue = null;
    }
  }
  if (cue) cues.push(cue);
  const ts = (s) => {
    const ms = Math.max(0, Math.round(s * 1000));
    const p = (n, l = 2) => String(n).padStart(l, "0");
    return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  return cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join("\n");
}

/**
 * The parts of the API eleven_run may call: everything that makes or shapes
 * audio and voices. Account administration (keys, workspace, members, service
 * accounts, the conversational-agents platform) stays out, and so does every
 * DELETE — an agent has no business removing the account's voices or history.
 */
const OPEN = [
  "/v1/speech-to-text", "/v1/forced-alignment", "/v1/audio-isolation", "/v1/voice-changer", "/v1/text-to-speech", "/v1/text-to-dialogue",
  "/v1/text-to-voice", "/v1/sound-generation", "/v1/music", "/v1/dubbing", "/v1/voices", "/v2/voices", "/v1/shared-voices", "/v1/similar-voices",
  "/v1/models", "/v1/history", "/v1/pronunciation-dictionaries", "/v1/studio", "/v1/audio-native", "/v1/audio-effects",
];
const openTo = (method, p) => method !== "delete" && OPEN.some((o) => p === o || p.startsWith(`${o}/`));
const FILE_CAP = 200 * 1024 * 1024;
const MIME_BY_EXT = {
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", opus: "audio/opus", flac: "audio/flac", aac: "audio/aac", webm: "video/webm",
  mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  txt: "text/plain", srt: "text/plain", json: "application/json", pls: "application/pls+xml",
};
const EXT_BY_MIME = {
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/opus": "opus", "audio/flac": "flac",
  "audio/aac": "aac", "audio/mp4": "m4a", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "application/zip": "zip",
  "image/png": "png", "image/jpeg": "jpg", "text/plain": "txt", "text/srt": "srt", "text/vtt": "vtt", "application/pls+xml": "pls",
};

export default async function activate(ctx) {
  const cfg = { api_key: "${ELEVENLABS_API_KEY}", default_model: "eleven_v3", output_format: "mp3_44100_128", ...(ctx.config ?? {}) };
  const key = () => {
    const k = resolveRef(cfg.api_key);
    if (!k) throw new Error("ELEVENLABS_API_KEY is not set — add the ElevenLabs key under Settings → Integrations (or plugins.elevenlabs.config.api_key)");
    return k;
  };

  /** One call to the API; an exhausted quota becomes one needs-a-person card, not a silent failure. */
  async function call(pathname, init = {}, timeoutMs = 120_000) {
    const res = await fetch(`${API}${pathname}`, {
      ...init,
      headers: { "xi-api-key": key(), ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text();
      const perm = /missing the permission (\w+)/.exec(body)?.[1];
      if (perm) throw new Error(`the ElevenLabs key lacks the "${perm}" permission — enable it on the key in the ElevenLabs dashboard (API keys)`);
      if (res.status === 401) throw new Error(`ElevenLabs rejected the key (401): ${body.slice(0, 200)}`);
      if (res.status === 402 || /quota_exceeded|insufficient|credits/i.test(body))
        ctx.billing?.outOfFunds?.({ provider: "ElevenLabs", what: "voiceover and sound effects (elevenlabs plugin)", detail: body.slice(0, 400) });
      throw new Error(`ElevenLabs HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    return res;
  }

  /** Credits used so far this period — null when the key may not read the subscription. */
  async function creditsUsed() {
    try {
      const r = await fetch(`${API}/v1/user/subscription`, { headers: { "xi-api-key": key() }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) return null;
      const j = await r.json();
      return typeof j.character_count === "number" ? j.character_count : null;
    } catch {
      return null;
    }
  }

  /**
   * What a generation cost, in ElevenLabs credits: the `character-cost` header
   * when the response carries it, else the subscription counter before vs after
   * (another generation on the same key at the same time inflates that — it is
   * marked as such). Unknown stays unknown: no estimate from a price list.
   */
  function spentCredits(res, before, after) {
    const h = res.headers.get("character-cost");
    if (h !== null && h.trim() !== "" && Number.isFinite(Number(h))) return { credits: Number(h), credits_source: "response header" };
    if (before !== null && after !== null && after >= before) return { credits: after - before, credits_source: "balance difference (inflated if the key was used in parallel)" };
    return null;
  }

  /** Run one paid call and learn its cost in credits. */
  async function paidCall(pathname, init, timeoutMs) {
    const before = await creditsUsed();
    const res = await call(pathname, init, timeoutMs);
    const buf = Buffer.from(await res.arrayBuffer());
    const spent = spentCredits(res, before, res.headers.get("character-cost") === null ? await creditsUsed() : null);
    return { buf, spent, type: (res.headers.get("content-type") ?? "").split(";")[0].trim() };
  }

  /** Save one generated file into the task's artifacts, with how it was made. */
  function save(c, name, buf, description, generation) {
    const folder = c.taskId ?? "elevenlabs";
    const rel = path.posix.join(folder, name);
    const abs = path.join(ctx.paths.workspaceArtifacts(c.workspace), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    ctx.artifacts.annotate(c.workspace, rel, { agent: c.agent, taskId: c.taskId, description: description.slice(0, 300), action: "generated", generation });
    return rel;
  }

  const text = (t) => ({ content: [{ type: "text", text: t }] });
  const json = (v) => text(JSON.stringify(v, null, 1));
  const z = ctx.z;

  ctx.registerTool({
    name: "eleven_voices",
    description:
      "Find an ElevenLabs voice (free). source=mine: the account's own voices (cloned, professional, default); source=library: the shared library of thousands, searchable by description ('warm british narrator', 'energetic russian female'); all (default) searches both. Returns voice_id, labels (gender, age, accent, language, use case) and a preview URL. Any voice_id from here works in eleven_speak — never guess one.",
    schema: {
      search: z.string().optional().describe("a name or a description of the sound you want"),
      source: z.enum(["all", "mine", "library"]).optional(),
      language: z.string().optional().describe("library only: ISO 639-1, e.g. 'ru'"),
      gender: z.enum(["male", "female", "neutral"]).optional().describe("library only"),
      limit: z.number().int().min(1).max(30).optional(),
    },
    handler: async (args) => {
      const source = args.source ?? "all";
      const limit = args.limit ?? 12;
      const out = { mine: [], library: [] };
      if (source !== "library") {
        const q = new URLSearchParams({ page_size: String(limit) });
        if (args.search) q.set("search", String(args.search));
        const r = await (await call(`/v2/voices?${q}`, {}, 30_000)).json();
        out.mine = (r.voices ?? []).map((v) => ({
          voice_id: v.voice_id,
          name: v.name,
          category: v.category,
          labels: v.labels ?? {},
          description: String(v.description ?? "").slice(0, 160),
          preview_url: v.preview_url,
        }));
      }
      if (source !== "mine") {
        const q = new URLSearchParams({ page_size: String(limit) });
        if (args.search) q.set("search", String(args.search));
        if (args.language) q.set("language", String(args.language));
        if (args.gender) q.set("gender", String(args.gender));
        const r = await (await call(`/v1/shared-voices?${q}`, {}, 30_000)).json();
        out.library = (r.voices ?? []).map((v) => ({
          voice_id: v.voice_id,
          name: v.name,
          labels: Object.fromEntries(Object.entries({ gender: v.gender, age: v.age, accent: v.accent, language: v.language, use_case: v.use_case, descriptive: v.descriptive }).filter(([, x]) => x)),
          description: String(v.description ?? "").slice(0, 160),
          preview_url: v.preview_url,
        }));
      }
      return json(out);
    },
  });

  ctx.registerTool({
    name: "eleven_models",
    description: "ElevenLabs speech models (free): model_id, which languages each speaks, and how long a text it takes. The default comes from the plugin config.",
    schema: {},
    handler: async () => {
      const r = await (await call("/v1/models", {}, 30_000)).json();
      return json({
        default: cfg.default_model,
        models: (Array.isArray(r) ? r : [])
          .filter((m) => m.can_do_text_to_speech)
          .map((m) => ({
            model_id: m.model_id,
            name: m.name,
            languages: (m.languages ?? []).map((l) => l.language_id),
            max_characters: m.maximum_text_length_per_request,
            description: String(m.description ?? "").slice(0, 160),
          })),
      });
    },
  });

  ctx.registerTool({
    name: "eleven_speak",
    description:
      "Voice a text with an ElevenLabs voice — PAID per character. The audio lands in this task's artifacts; with_timestamps also writes word timings (.json) and ready subtitles (.srt, tags removed) next to it, for captions on a video. Pick the voice with eleven_voices first; for long scripts voice a short sample, check it, then the rest.\n" +
      `Acting: with model_id "eleven_v3" the text may carry audio tags that steer the performance — ${V3_TAGS} — plus "…" for a pause. Use them sparingly and where a person would really do it (one or two per paragraph, never on every line); write the rest as natural spoken language, numbers and abbreviations the way they are said. Other models do not understand tags — they would be spoken or dropped, so leave them out there.`,
    schema: {
      text: z.string().min(1).describe("what to say — up to 5000 characters a call on eleven_v3, 10000 on the others"),
      voice_id: z.string().describe("from eleven_voices"),
      model_id: z.string().optional().describe("from eleven_models; default from config"),
      language_code: z.string().optional().describe("ISO 639-1, e.g. 'ru' — only for models that take it"),
      stability: z.number().min(0).max(1).optional().describe("lower = more expressive, higher = steadier"),
      similarity_boost: z.number().min(0).max(1).optional(),
      style: z.number().min(0).max(1).optional(),
      speed: z.number().min(0.7).max(1.2).optional(),
      seed: z.number().int().optional().describe("same seed + same inputs → the same take"),
      with_timestamps: z.boolean().optional().describe("also save word timings and an .srt"),
      name: z.string().max(40).optional().describe("file name stem, e.g. 'intro-ru'"),
      note: z.string().max(200).optional().describe("what this is for (stored on the file)"),
    },
    handler: async (args, c) => {
      const t = String(args.text);
      const model = String(args.model_id ?? cfg.default_model);
      const cap = textCap(model);
      if (t.length > cap) return text(`error: ${t.length} characters — ${model} takes up to ${cap} a call; split the script and voice the parts one by one`);
      const format = String(cfg.output_format);
      const settings = Object.fromEntries(
        Object.entries({ stability: args.stability, similarity_boost: args.similarity_boost, style: args.style, speed: args.speed }).filter(([, v]) => v !== undefined),
      );
      const body = {
        text: t,
        model_id: model,
        ...(args.language_code ? { language_code: args.language_code } : {}),
        ...(Object.keys(settings).length ? { voice_settings: settings } : {}),
        ...(args.seed !== undefined ? { seed: args.seed } : {}),
      };
      const voice = encodeURIComponent(String(args.voice_id));
      const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
      let audio;
      let alignment = null;
      const { buf, spent } = await paidCall(`/v1/text-to-speech/${voice}${args.with_timestamps ? "/with-timestamps" : ""}?output_format=${format}`, init, 300_000);
      if (args.with_timestamps) {
        const r = JSON.parse(buf.toString("utf8"));
        audio = Buffer.from(r.audio_base64 ?? "", "base64");
        alignment = r.normalized_alignment ?? r.alignment ?? null;
      } else {
        audio = buf;
      }
      if (format.startsWith("pcm")) audio = wavFromPcm(audio, Number(format.split("_")[1]) || 44100);
      const stem = `${slugify(args.name ?? `tts-${args.voice_id}`)}-${crypto.randomBytes(3).toString("hex")}`;
      const generation = { provider: "ElevenLabs", model, params: { voice_id: args.voice_id, ...body, text: t.length > 400 ? `${t.slice(0, 400)}…` : t }, ...(spent ?? {}) };
      const note = String(args.note ?? t.slice(0, 120));
      const files = [save(c, `${stem}.${EXT_BY_FORMAT(format)}`, audio, `ElevenLabs voiceover · ${note}`, generation)];
      if (alignment) {
        files.push(save(c, `${stem}.srt`, Buffer.from(srtFromAlignment(alignment)), `subtitles for ${stem}`, generation));
        files.push(save(c, `${stem}.timings.json`, Buffer.from(JSON.stringify(alignment)), `word timings for ${stem}`, generation));
      }
      ctx.artifacts.mirror(c.workspace, files);
      ctx.usage.record({ workspace: c.workspace, agent: c.agent, taskId: c.taskId, kind: "elevenlabs", model, costUsd: 0, ...(spent ? { units: spent.credits, unit: "credits" } : { units: t.length, unit: "chars" }) });
      return json({ artifacts: files, characters: t.length, ...(spent ?? {}), hint: "reference the audio as [media: artifacts/<path>]; listen to a sample before voicing the rest" });
    },
  });

  ctx.registerTool({
    name: "eleven_sfx",
    description: "Generate a sound effect from a description — PAID, and a made effect is reusable. First look for one the team already has: artifact_search matches the prompt an effect was made from (\"mp3 whoosh\"), and the project or the wiki may keep a sound list; listen to a candidate with audio_understand. Generate only what is not there. Lands in this task's artifacts. Describe the sound concretely (source, space, mood), e.g. 'soft whoosh of a UI card sliding in, short, clean'.",
    schema: {
      text: z.string().min(1).max(450).describe("what it should sound like"),
      duration_s: z.number().min(0.5).max(30).optional().describe("omit to let the model choose"),
      prompt_influence: z.number().min(0).max(1).optional().describe("higher = follows the text more literally"),
      name: z.string().max(40).optional(),
      note: z.string().max(200).optional(),
    },
    handler: async (args, c) => {
      const body = {
        text: String(args.text),
        ...(args.duration_s !== undefined ? { duration_seconds: args.duration_s } : {}),
        ...(args.prompt_influence !== undefined ? { prompt_influence: args.prompt_influence } : {}),
      };
      const { buf: audio, spent } = await paidCall(`/v1/sound-generation?output_format=mp3_44100_128`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, 180_000);
      const stem = `${slugify(args.name ?? `sfx-${args.text}`)}-${crypto.randomBytes(3).toString("hex")}`;
      const rel = save(c, `${stem}.mp3`, audio, `Sound effect: ${String(args.text).slice(0, 220)}${args.note ? ` · ${String(args.note).slice(0, 70)}` : ""}`, { provider: "ElevenLabs", model: "sound-generation", params: body, ...(spent ?? {}) });
      ctx.artifacts.mirror(c.workspace, [rel]);
      ctx.usage.record({ workspace: c.workspace, agent: c.agent, taskId: c.taskId, kind: "elevenlabs", model: "sound-generation", costUsd: 0, ...(spent ? { units: spent.credits, unit: "credits" } : { units: 1, unit: "effects" }) });
      return json({ artifacts: [rel], ...(spent ?? { credits: null, credits_source: "unknown — the response carried no cost and the key cannot read the balance" }) });
    },
  });

  ctx.registerTool({
    name: "eleven_music",
    description:
      "Generate music from a description through ElevenLabs Music — PAID (priced per minute of audio), and a made track is reusable. First look for one the team already has: artifact_search matches the prompt a track was made from (\"music loop battle\"); listen to a candidate with audio_understand. Say genre, mood, tempo/BPM, instruments, what must NOT be there, and where it plays (a menu loop, a battle bed under sound effects). `instrumental: true` guarantees no vocals. For a game loop: ask for a steady groove with no intro or ending, generate a bit longer than the loop, and cut the seamless loop from the middle. Lands in this task's artifacts.",
    schema: {
      prompt: z.string().min(1).max(4100).describe("what the music should be — genre, mood, tempo, instruments, exclusions, use"),
      duration_s: z.number().min(3).max(600).optional().describe("length in seconds (3–600); omit to let the model choose"),
      instrumental: z.boolean().optional().describe("true = guaranteed no vocals"),
      model: z.enum(["music_v1", "music_v2", "music_v2_5"]).optional().describe("omit for the account default; music_v2_5 is the newest"),
      name: z.string().max(40).optional(),
      note: z.string().max(200).optional(),
    },
    handler: async (args, c) => {
      const body = {
        prompt: String(args.prompt),
        ...(args.duration_s !== undefined ? { music_length_ms: Math.round(Number(args.duration_s) * 1000) } : {}),
        ...(args.instrumental !== undefined ? { force_instrumental: Boolean(args.instrumental) } : {}),
        ...(args.model ? { model_id: String(args.model) } : {}),
      };
      const { buf: audio, spent } = await paidCall(`/v1/music?output_format=mp3_44100_192`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, 600_000);
      // a random suffix: two tracks started together must never land on one file
      const stem = `${slugify(args.name ?? `music-${args.prompt}`)}-${crypto.randomBytes(3).toString("hex")}`;
      const model = body.model_id ?? "music";
      const rel = save(c, `${stem}.mp3`, audio, `Music: ${String(args.prompt).slice(0, 220)}${args.note ? ` · ${String(args.note).slice(0, 70)}` : ""}`, { provider: "ElevenLabs", model, params: body, ...(spent ?? {}) });
      ctx.artifacts.mirror(c.workspace, [rel]);
      ctx.usage.record({ workspace: c.workspace, agent: c.agent, taskId: c.taskId, kind: "elevenlabs", model, costUsd: 0, ...(spent ? { units: spent.credits, unit: "credits" } : { units: Math.round((body.music_length_ms ?? 0) / 1000) || 1, unit: body.music_length_ms ? "seconds" : "tracks" }) });
      return json({ artifacts: [rel], ...(spent ?? { credits: null, credits_source: "unknown — the response carried no cost and the key cannot read the balance" }) });
    },
  });

  /** Local path (artifacts/… or the workdir) → absolute, jailed to this workspace. */
  function resolveLocal(ws, p) {
    const art = ctx.paths.workspaceArtifacts(ws);
    const work = ctx.paths.workspaceWorkdir(ws);
    const abs = p.includes("artifacts/") ? path.join(art, p.slice(p.indexOf("artifacts/") + "artifacts/".length)) : path.resolve(work, p);
    const inside = (root) => abs === root || abs.startsWith(root + path.sep);
    if (!inside(art) && !inside(work)) throw new Error(`path is outside your workspace: ${p}`);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`file not found: ${p}`);
    if (fs.statSync(abs).size > FILE_CAP) throw new Error(`${p} is over ${FILE_CAP / 1e6}MB`);
    return abs;
  }

  /** A file for a form field: a workspace file, or a URL fetched here. */
  async function fileBlob(ws, ref) {
    if (/^https?:\/\//i.test(ref)) {
      const res = await fetch(ref, { signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new Error(`could not download ${ref}: ${res.status}`);
      const name = path.posix.basename(new URL(ref).pathname) || "file";
      const type = (res.headers.get("content-type") ?? "").split(";")[0].trim() || MIME_BY_EXT[path.extname(name).slice(1).toLowerCase()] || "application/octet-stream";
      return { blob: new Blob([await res.arrayBuffer()], { type }), name };
    }
    const abs = resolveLocal(ws, ref);
    return { blob: new Blob([fs.readFileSync(abs)], { type: MIME_BY_EXT[path.extname(abs).slice(1).toLowerCase()] ?? "application/octet-stream" }), name: path.basename(abs) };
  }

  /** Trim a JSON answer for the reply: keep the structure, cut long strings and lists. */
  function compact(v, depth = 0) {
    if (typeof v === "string") return v.length > 600 ? `${v.slice(0, 600)}…(${v.length} chars)` : v;
    if (Array.isArray(v)) return depth > 5 ? `[${v.length} items]` : [...v.slice(0, 30).map((x) => compact(x, depth + 1)), ...(v.length > 30 ? [`…${v.length - 30} more`] : [])];
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, compact(x, depth + 1)]));
    return v;
  }

  ctx.registerTool({
    name: "eleven_transcribe",
    description:
      "Transcribe speech with ElevenLabs Scribe — PAID per minute of audio. Takes audio or video (an artifacts/… path, a workspace file or a URL); returns the text and saves the full answer (.json: every word with its time and, with speakers, who said it) and ready subtitles (.srt) into this task's artifacts. Give `keyterms` for names and brand words that must come out right.",
    schema: {
      file: z.string().describe("artifacts/… path, a path in your workspace, or an http(s) URL"),
      language: z.string().optional().describe("ISO 639-1/3 code of the speech; omit to detect it"),
      speakers: z.number().int().min(1).max(32).optional().describe("at most how many people speak — labels who says what"),
      diarize: z.boolean().optional().describe("label who speaks without saying how many"),
      audio_events: z.boolean().optional().describe("tag (laughter), (music)… in the text; default true"),
      keyterms: z.array(z.string()).max(100).optional().describe("names and terms to get right"),
      verbatim: z.boolean().optional().describe("false drops filler words and false starts"),
      model_id: z.string().optional().describe("default scribe_v2"),
      name: z.string().max(40).optional().describe("file name stem"),
    },
    handler: async (args, c) => {
      const src = String(args.file);
      const fd = new FormData();
      fd.append("model_id", String(args.model_id ?? "scribe_v2"));
      if (/^https?:\/\//i.test(src)) fd.append("source_url", src);
      else {
        const f = await fileBlob(c.workspace, src);
        fd.append("file", f.blob, f.name);
      }
      fd.append("timestamps_granularity", "word");
      if (args.language) fd.append("language_code", String(args.language));
      if (args.speakers) fd.append("num_speakers", String(args.speakers));
      if (args.speakers || args.diarize) fd.append("diarize", "true");
      if (args.audio_events !== undefined) fd.append("tag_audio_events", String(Boolean(args.audio_events)));
      if (args.verbatim === false) fd.append("no_verbatim", "true");
      for (const k of args.keyterms ?? []) fd.append("keyterms", String(k));
      const { buf, spent } = await paidCall("/v1/speech-to-text", { method: "POST", body: fd }, 900_000);
      const r = JSON.parse(buf.toString("utf8"));
      const stem = `${slugify(args.name ?? `transcript-${path.basename(src).replace(/\.[^.]+$/, "")}`)}-${crypto.randomBytes(3).toString("hex")}`;
      const generation = { provider: "ElevenLabs", model: String(args.model_id ?? "scribe_v2"), params: { source: src, ...(args.language ? { language_code: args.language } : {}), ...(args.speakers ? { num_speakers: args.speakers } : {}) }, ...(spent ?? {}) };
      const files = [save(c, `${stem}.json`, buf, `Transcript of ${src} (Scribe, word timings)`, generation)];
      if (r.words?.length) files.push(save(c, `${stem}.srt`, Buffer.from(srtFromWords(r.words)), `Subtitles for ${src}`, generation));
      ctx.artifacts.mirror(c.workspace, files);
      ctx.usage.record({ workspace: c.workspace, agent: c.agent, taskId: c.taskId, kind: "elevenlabs", model: generation.model, costUsd: 0, ...(spent ? { units: spent.credits, unit: "credits" } : {}) });
      const t = String(r.text ?? "");
      return json({
        text: t.length > 20_000 ? `${t.slice(0, 20_000)}…(the whole transcript is in ${files[0]})` : t,
        language: r.language_code,
        ...(new Set((r.words ?? []).map((w) => w.speaker_id).filter(Boolean)).size > 1 ? { speakers: [...new Set(r.words.map((w) => w.speaker_id).filter(Boolean))] } : {}),
        artifacts: files,
        ...(spent ?? {}),
      });
    },
  });

  // the API's own description, read live: new endpoints are callable the day they ship
  let spec = { at: 0, doc: null };
  async function apiSpec() {
    if (spec.doc && Date.now() - spec.at < 12 * 3_600_000) return spec.doc;
    const res = await fetch(`${API}/openapi.json`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`ElevenLabs API description unavailable (${res.status})`);
    spec = { at: Date.now(), doc: await res.json() };
    return spec.doc;
  }
  const parseOp = (s) => {
    const m = /^\s*(GET|POST|PATCH|PUT|DELETE)\s+(\/\S+)\s*$/i.exec(String(s));
    return m ? { method: m[1].toLowerCase(), path: m[2] } : null;
  };
  /** One schema, $refs resolved and trimmed to what a call needs: types, enums, defaults, short descriptions. */
  function shape(doc, s, depth = 0) {
    if (!s || typeof s !== "object" || depth > 6) return s;
    if (s.$ref) return shape(doc, doc.components?.schemas?.[s.$ref.split("/").pop()], depth + 1);
    const alt = s.anyOf ?? s.oneOf;
    if (alt) {
      const real = alt.filter((x) => x.type !== "null");
      return real.length === 1 ? { ...shape(doc, real[0], depth + 1), ...(s.description ? { description: String(s.description).slice(0, 200) } : {}) } : { anyOf: real.map((x) => shape(doc, x, depth + 1)) };
    }
    const out = {};
    if (s.type) out.type = s.format === "binary" ? "file" : s.type;
    if (s.enum) out.enum = s.enum;
    if (s.default !== undefined) out.default = s.default;
    if (s.description) out.description = String(s.description).replace(/\s+/g, " ").slice(0, 200);
    if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, shape(doc, v, depth + 1)]));
    if (s.required) out.required = s.required;
    if (s.items) out.items = shape(doc, s.items, depth + 1);
    return out;
  }

  ctx.registerTool({
    name: "eleven_api",
    description:
      "Everything else ElevenLabs can do, read from their live API description (free): voice isolation, forced alignment of a script to audio, voice changer, voice design and cloning, multi-voice dialogue, dubbing, music composition plans, stem separation and video-to-music, pronunciation dictionaries, Studio projects. Without `operation` it lists operations (filter with `query`); with one it shows that operation's parameters and body. Call it with eleven_run.",
    schema: {
      query: z.string().optional().describe("words matched against the path and summary, e.g. 'isolation', 'dubbing', 'stem'"),
      operation: z.string().optional().describe('one operation exactly as listed, e.g. "POST /v1/audio-isolation"'),
    },
    handler: async (args) => {
      const doc = await apiSpec();
      if (args.operation) {
        const want = parseOp(args.operation);
        const op = want && doc.paths?.[want.path]?.[want.method];
        if (!op || !openTo(want.method, want.path)) return text(`error: no such operation open to agents: ${args.operation} — list them with eleven_api`);
        const params = (op.parameters ?? [])
          .map((p) => (p.$ref ? doc.components?.parameters?.[p.$ref.split("/").pop()] : p))
          .filter((p) => p && p.in !== "header" && p.name !== "xi-api-key")
          .map((p) => ({ name: p.name, in: p.in, ...(p.required ? { required: true } : {}), ...shape(doc, p.schema), ...(p.description ? { description: String(p.description).replace(/\s+/g, " ").slice(0, 200) } : {}) }));
        const content = op.requestBody?.content ?? {};
        const kind = content["multipart/form-data"] ? "multipart/form-data" : content["application/json"] ? "application/json" : null;
        const out = JSON.stringify({
          operation: `${want.method.toUpperCase()} ${want.path}`,
          summary: op.summary,
          description: String(op.description ?? "").replace(/\s+/g, " ").slice(0, 600),
          parameters: params,
          ...(kind ? { body: { content_type: kind, note: kind === "multipart/form-data" ? "fields of type file go in eleven_run's `files`, the rest in `body`" : undefined, schema: shape(doc, content[kind].schema) } } : {}),
          returns: Object.keys(op.responses?.["200"]?.content ?? {}),
        }, null, 1);
        return text(out.length > 14_000 ? `${out.slice(0, 14_000)}\n…(truncated)` : out);
      }
      const words = String(args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const ops = [];
      for (const [p, methods] of Object.entries(doc.paths ?? {}))
        for (const [m, op] of Object.entries(methods)) {
          if (!["get", "post", "patch", "put"].includes(m) || !openTo(m, p) || op.deprecated) continue;
          const line = `${m.toUpperCase()} ${p}`;
          if (words.every((w) => `${line} ${op.summary ?? ""}`.toLowerCase().includes(w))) ops.push({ operation: line, summary: op.summary });
        }
      return json({ total: ops.length, operations: ops.slice(0, 60), ...(ops.length > 60 ? { more: `${ops.length - 60} more — narrow with query` } : {}) });
    },
  });

  ctx.registerTool({
    name: "eleven_run",
    description:
      "Call one ElevenLabs operation from eleven_api — read its parameters there first. Most calls that make audio are PAID in credits; the cost comes back with the result. Audio, video and other files it returns land in this task's artifacts; JSON comes back as is (long jobs like dubbing return an id — check them with the GET operation later). File fields of a form (audio to isolate, samples to clone) take artifacts/… paths or URLs in `files`.",
    schema: {
      operation: z.string().describe('exactly as eleven_api lists it, e.g. "POST /v1/audio-isolation"'),
      path: z.record(z.string(), z.string()).optional().describe("values for the {placeholders} in the path, e.g. {voice_id: '…'}"),
      query: z.record(z.string(), z.unknown()).optional().describe("query parameters, e.g. {output_format: 'mp3_44100_128'}"),
      body: z.record(z.string(), z.unknown()).optional().describe("body fields, JSON or form as eleven_api says"),
      files: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional().describe("form fields that take files: field → artifacts/… path or URL, or a list of them"),
      name: z.string().max(40).optional().describe("file name stem for what it returns"),
      note: z.string().max(200).optional().describe("what this is for (stored on the files)"),
    },
    handler: async (args, c) => {
      const want = parseOp(args.operation);
      if (!want) return text('error: operation must look like "POST /v1/audio-isolation" — list them with eleven_api');
      if (!openTo(want.method, want.path)) return text(`error: ${args.operation} is not open to agents (account administration and deletions stay with the owner)`);
      const doc = await apiSpec();
      const op = doc.paths?.[want.path]?.[want.method];
      if (!op) return text(`error: no such operation: ${args.operation} — list them with eleven_api`);
      const missing = [];
      const url = want.path.replace(/\{([^}]+)\}/g, (_, k) => {
        const v = args.path?.[k];
        if (v === undefined) missing.push(k);
        return encodeURIComponent(String(v ?? ""));
      });
      if (missing.length) return text(`error: the path needs ${missing.join(", ")} in \`path\``);
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(args.query ?? {})) for (const x of Array.isArray(v) ? v : [v]) if (x !== undefined && x !== null) q.append(k, String(x));
      const content = op.requestBody?.content ?? {};
      const init = { method: want.method.toUpperCase() };
      if (content["multipart/form-data"] && (args.files || !content["application/json"])) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(args.body ?? {}))
          for (const x of Array.isArray(v) ? v : [v]) if (x !== undefined && x !== null) fd.append(k, typeof x === "object" ? JSON.stringify(x) : String(x));
        for (const [k, refs] of Object.entries(args.files ?? {}))
          for (const ref of Array.isArray(refs) ? refs : [refs]) {
            const f = await fileBlob(c.workspace, String(ref));
            fd.append(k, f.blob, f.name);
          }
        init.body = fd;
      } else if (args.body) {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify(args.body);
      }
      const target = `${url}${q.size ? `?${q}` : ""}`;
      let buf;
      let spent = null;
      let type;
      if (want.method === "get") {
        const res = await call(target, init, 300_000);
        buf = Buffer.from(await res.arrayBuffer());
        type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
      } else ({ buf, spent, type } = await paidCall(target, init, 900_000));
      const label = `${want.method.toUpperCase()} ${want.path}`;
      const stem = `${slugify(args.name ?? want.path.split("/").filter((x) => x && !x.startsWith("{")).slice(1).join("-"))}-${crypto.randomBytes(3).toString("hex")}`;
      const generation = { provider: "ElevenLabs", model: label, params: { ...(args.path ?? {}), ...(args.query ?? {}), ...(args.body ?? {}), ...(args.files ? { files: args.files } : {}) }, ...(spent ?? {}) };
      const note = String(args.note ?? label);
      const files = [];
      let result;
      if (/json/.test(type)) {
        result = JSON.parse(buf.toString("utf8") || "null");
        // audio inside the JSON (…_base64): into a file, its place in the answer taken by the path
        const fmt = String(args.query?.output_format ?? "mp3");
        const lift = (v, depth = 0) => {
          if (!v || typeof v !== "object" || depth > 4) return v;
          for (const [k, x] of Object.entries(v)) {
            if (typeof x === "string" && /base64$/i.test(k) && x.length > 200) {
              let audio = Buffer.from(x, "base64");
              if (fmt.startsWith("pcm")) audio = wavFromPcm(audio, Number(fmt.split("_")[1]) || 44100);
              const rel = save(c, `${stem}${files.length ? `-${files.length + 1}` : ""}.${EXT_BY_FORMAT(fmt) === "bin" ? "mp3" : EXT_BY_FORMAT(fmt)}`, audio, `ElevenLabs ${label} · ${note}`, generation);
              files.push(rel);
              v[k] = `saved to artifacts/${rel}`;
            } else lift(x, depth + 1);
          }
          return v;
        };
        lift(result);
      } else if (/^text\//.test(type) && !/srt|vtt/.test(type)) {
        result = buf.toString("utf8").slice(0, 20_000);
      } else if (buf.length) {
        let out = buf;
        let ext = EXT_BY_MIME[type];
        if (!ext && type === "application/octet-stream") {
          const fmt = String(args.query?.output_format ?? "");
          if (fmt.startsWith("pcm")) {
            out = wavFromPcm(buf, Number(fmt.split("_")[1]) || 44100);
            ext = "wav";
          } else ext = fmt ? EXT_BY_FORMAT(fmt) : "bin";
        }
        files.push(save(c, `${stem}.${ext ?? "bin"}`, out, `ElevenLabs ${label} · ${note}`, generation));
      }
      if (files.length) ctx.artifacts.mirror(c.workspace, files);
      if (want.method !== "get") ctx.usage.record({ workspace: c.workspace, agent: c.agent, taskId: c.taskId, kind: "elevenlabs", model: label, costUsd: 0, ...(spent ? { units: spent.credits, unit: "credits" } : {}) });
      return json({
        ...(files.length ? { artifacts: files } : {}),
        ...(result !== undefined ? { result: compact(result) } : {}),
        ...(spent ?? {}),
        ...(files.some((f) => /\.(mp3|wav|ogg|opus|flac|m4a)$/.test(f)) ? { hint: "listen with audio_understand before handing it over; reference it as [media: artifacts/<path>]" } : {}),
      });
    },
  });

  // dashboard balance: the subscription's credits for this period. A key needs
  // «User → Read» for it; without that the tile says so instead of vanishing
  if (typeof ctx.registerStat === "function") {
    let cache = { at: 0, tiles: [] };
    ctx.registerStat(async () => {
      const k = resolveRef(cfg.api_key);
      if (!k) return [];
      if (Date.now() - cache.at < 300_000) return cache.tiles;
      const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": k }, signal: AbortSignal.timeout(2500) });
      let tiles;
      if (res.status === 401 || res.status === 403) {
        const body = await res.text();
        tiles = [{ label: "ElevenLabs", value: "—", sub: /user_read/.test(body) ? "key needs User → Read" : "the key cannot read the plan", balance: null }];
      } else {
        if (!res.ok) throw new Error(`elevenlabs subscription HTTP ${res.status}`);
        const s = await res.json();
        const used = Number(s.character_count) || 0;
        const limit = Number(s.character_limit) || 0;
        const left = Math.max(0, limit - used);
        const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
        const days = s.next_character_count_reset_unix ? Math.max(0, Math.ceil((s.next_character_count_reset_unix * 1000 - Date.now()) / 86_400_000)) : null;
        const share = limit > 0 ? left / limit : 0;
        tiles = [{ label: "ElevenLabs", value: fmt(left), sub: `of ${fmt(limit)} credits${days !== null ? ` · resets in ${days}d` : ""}`, balance: share, low: share < 0.1 }];
      }
      cache = { at: Date.now(), tiles };
      return tiles;
    });
  }

  ctx.log.info("elevenlabs tools ready");
}
