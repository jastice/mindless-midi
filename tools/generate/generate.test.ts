import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { type CorpusClient, formatCorpus, generateCorpus } from "./generate_lib.js";

type Message = Anthropic.Beta.Messages.BetaMessage;
type StreamParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

const valid = readFileSync("styles/metroid/corpus.json", "utf8");

function reply(text: string, stop: Message["stop_reason"] = "end_turn"): Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Message;
}

function fakeClient(replies: Message[]): CorpusClient & { calls: StreamParams[] } {
  const calls: StreamParams[] = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params: StreamParams) {
          calls.push({ ...params, messages: [...params.messages] });
          const next = replies.shift();
          if (!next) throw new Error("unexpected extra request");
          return { finalMessage: async () => next };
        },
      },
    },
  };
}

test("valid corpus on the first try", async () => {
  const client = fakeClient([reply(valid)]);
  const corpus = await generateCorpus(client, "metroid", "dark caves");
  assert.equal(corpus.title, "Metroid Vibes");
  assert.equal(client.calls.length, 1);
  const p = client.calls[0]!;
  assert.equal(p.model, "claude-opus-5-5");
  assert.deepEqual(p.thinking, { type: "adaptive" });
  assert.equal(p.fallbacks, "default");
  assert.ok(p.output_config?.format, "structured output format is set");
});

test("validation errors are sent back for repair", async () => {
  const broken = JSON.parse(valid);
  broken.progressions[0].chords[0].symbol = "Q7";
  const client = fakeClient([reply(JSON.stringify(broken)), reply(valid)]);
  const corpus = await generateCorpus(client, "metroid", "dark caves");
  assert.equal(corpus.progressions[0]!.chords[0]!.symbol, "i");
  assert.equal(client.calls.length, 2);
  const second = client.calls[1]!.messages;
  assert.equal(second.length, 3);
  assert.equal(second[1]!.role, "assistant");
  assert.match(String(second[2]!.content), /unparseable chord symbol "Q7"/);
});

test("gives up after the repair budget", async () => {
  const client = fakeClient([reply("{"), reply("{")]);
  await assert.rejects(generateCorpus(client, "x", "y", { maxRepairs: 1 }), /still invalid after 1 repair/);
});

test("refusals surface as errors", async () => {
  const client = fakeClient([reply("", "refusal")]);
  await assert.rejects(generateCorpus(client, "x", "y"), /declined/);
});

test("checked-in corpora are formatted canonically", () => {
  for (const id of ["metroid", "retro", "lofi", "jazz_trio", "minimalist"]) {
    const text = readFileSync(`styles/${id}/corpus.json`, "utf8");
    assert.equal(formatCorpus(JSON.parse(text)), text, `${id}: run the formatter`);
  }
});
