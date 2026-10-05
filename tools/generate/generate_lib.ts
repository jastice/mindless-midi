/**
 * Asks Claude to write a style corpus from a brief, validates it with the
 * same checks the build uses, and feeds any errors back for a repair round.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { StyleCorpus } from "../../src/corpus/schema.js";
import { validateCorpus } from "../../src/corpus/validate.js";

export const DEFAULT_MODEL = "claude-opus-5-5";

type StreamParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

/** The slice of the SDK client we use; tests pass a fake. */
export interface CorpusClient {
  beta: { messages: { stream(params: StreamParams): { finalMessage(): Promise<Message> } } };
}

export interface GenerateOptions {
  model?: string;
  maxRepairs?: number;
  log?: (msg: string) => void;
}

export const SYSTEM_PROMPT = `You are a composer and game-audio arranger writing source material for an algorithmic music engine.

The engine runs in a browser and recombines what you write, forever, without you: for each piece it picks a key from your list and a tempo from your range, picks one of your forms, binds a progression and a few motifs to each section label, loops patterns over the harmony, develops lead motifs (sequence, inversion, mutation, cadences), voices chords with voice-leading, and plays it all through OPL3 FM synthesis using General MIDI program numbers. Listeners leave it running for hours, so the material must be idiomatic, varied, and loop without fatigue.

How your material is used:
- Progressions loop for the length of a section. Mix 1-, 2- and 4-bar harmonic rhythms and several moods. Chord symbols are roman numerals relative to the MAJOR scale (minor-key i-bVI-bVII is written exactly like that).
- Motif "deg" values are scale steps, not semitones. anchor="chord" counts from the sounding chord's root through a chord-scale (0 root, 2 third, 4 fifth, 6 seventh, 7 octave, 1/3/5 are 9/11/13), so the pattern follows the harmony automatically. anchor="key" counts through the mode from the tonic and is gently snapped onto the current chord.
- Bass and arp motifs are ostinatos repeated bar after bar. Lead motifs are phrase seeds: write short, singable, rhythmically distinctive cells (1-2 bars) with a clear contour; the engine develops them. Counter motifs answer or harmonise the lead and should leave space.
- Comping patterns give the rhythm of chord attacks; voicing names the chord shape.
- Drum patterns are one bar on a step grid. Provide grooves across the intensity range plus at least one fill if the style has drums.
- Forms are section lists; sections sharing a label share material, so repeat labels (A A B A). Labels starting with intro/outro frame the piece; the body between them is repeated to reach a few minutes. Vary which roles play per section to build and release energy.
- A form can be an "area" (when the brief asks for distinct places or moods): give it a palette name plus optional tempo, keys and instrument overrides, and tag the progressions, motifs, comping and drums written for it with the same palette. Untagged forms only use untagged material.
- Only use roles you defined instruments for, and give every role used in a form some material.

Aim for: at least 6 progressions, 3+ lead motifs, 2+ counter motifs, 2-4 arp and 3-4 bass motifs (where those roles exist), 2-4 comping patterns, 4-6 drum patterns, and 2-4 forms. Be specific to the brief; avoid generic filler.`;

export function userPrompt(styleId: string, brief: string): string {
  return `Style id: ${styleId}\n\nBrief:\n${brief.trim()}\n\nWrite the complete corpus for this style.`;
}

export async function generateCorpus(
  client: CorpusClient,
  styleId: string,
  brief: string,
  opts: GenerateOptions = {},
): Promise<StyleCorpus> {
  const log = opts.log ?? (() => {});
  const maxRepairs = opts.maxRepairs ?? 2;
  const messages: MessageParam[] = [{ role: "user", content: userPrompt(styleId, brief) }];

  for (let attempt = 0; ; attempt++) {
    log(`${styleId}: requesting corpus (attempt ${attempt + 1})`);
    const message = await client.beta.messages
      .stream({
        model: opts.model ?? DEFAULT_MODEL,
        max_tokens: 64000,
        thinking: { type: "adaptive" },
        output_config: { effort: "high", format: betaZodOutputFormat(StyleCorpus) },
        // Re-run declined requests on Anthropic's recommended fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: SYSTEM_PROMPT,
        messages,
      })
      .finalMessage();

    if (message.stop_reason === "refusal") {
      throw new Error(`${styleId}: the model declined to write this corpus (${message.stop_details?.category ?? "no category"})`);
    }
    if (message.stop_reason === "max_tokens") {
      throw new Error(`${styleId}: output hit max_tokens; shorten the brief or ask for less material`);
    }
    const text = message.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    let problems: string[];
    try {
      const result = validateCorpus(JSON.parse(text));
      if (result.ok) {
        for (const w of result.warnings) log(`${styleId}: warning: ${w}`);
        return result.corpus;
      }
      problems = result.errors;
    } catch (e) {
      problems = [`response was not valid JSON: ${(e as Error).message}`];
    }

    log(`${styleId}: ${problems.length} validation error(s)`);
    if (attempt >= maxRepairs) {
      throw new Error(`${styleId}: corpus still invalid after ${maxRepairs} repair round(s):\n- ${problems.join("\n- ")}`);
    }
    // Echo the whole turn back unchanged (thinking blocks included) so the
    // conversation stays append-only.
    messages.push({ role: "assistant", content: message.content as MessageParam["content"] });
    messages.push({
      role: "user",
      content: `The engine's validator rejected that corpus:\n- ${problems.join("\n- ")}\n\nReturn the complete corrected corpus.`,
    });
  }
}

/** Stable, diff-friendly serialization for the checked-in corpus. */
export function formatCorpus(corpus: StyleCorpus): string {
  return JSON.stringify(corpus, null, 2) + "\n";
}
