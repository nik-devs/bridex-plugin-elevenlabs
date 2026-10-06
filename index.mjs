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
    return { buf, spent };
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
