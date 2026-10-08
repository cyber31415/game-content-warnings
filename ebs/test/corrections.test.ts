import { test } from "node:test";
import assert from "node:assert/strict";
import { Corrections, CorrectionLimitError, MAX_CORRECTIONS } from "../src/corrections.ts";
import { Store } from "../src/cache/db.ts";

/** Stub Twitch configuration segment with switchable failures. */
function twitch(initial?: object) {
  const seg = { content: initial ? JSON.stringify(initial) : undefined as string | undefined, getFails: false, puts: 0, delayPut: 0 };
  const helix = {
    getDeveloperSegment: async () => {
      if (seg.getFails) throw new Error("HTTP 429");
      return seg.content;
    },
    setDeveloperSegment: async (_jwt: string, _id: string, content: string) => {
      if (seg.delayPut) await new Promise((r) => setTimeout(r, seg.delayPut));
      seg.puts++;
      seg.content = content;
    },
  } as never;
  return { seg, helix };
}

const make = (helix: never, store = new Store(":memory:")) =>
  ({ store, c: new Corrections({ store, helix, extensionSecret: new Uint8Array(32), ownerId: "1000", mode: "twitch" }) });

test("loads corrections from the Twitch segment after a restart", async () => {
  const { helix } = twitch({ v: 1, c: { "1": 10, "2": 20 } });
  const { c } = make(helix);
  assert.equal(await c.for("42", "2"), 20);
});

test("a failed read never leads to a save that wipes other corrections", async () => {
  const { seg, helix } = twitch({ v: 1, c: { "1": 10, "2": 20, "3": 30 } });
  const { c } = make(helix);
  seg.getFails = true;
  assert.equal(await c.for("42", "1"), null); // viewer request during the outage: mirror is empty
  await assert.rejects(c.set("42", "4", 40), /couldn't read/);
  assert.deepEqual(JSON.parse(seg.content!), { v: 1, c: { "1": 10, "2": 20, "3": 30 } }, "segment untouched");
  seg.getFails = false; // Twitch recovers: the save re-reads first (ignoring the backoff) and merges
  await c.set("42", "4", 40);
  assert.deepEqual(JSON.parse(seg.content!), { v: 1, c: { "1": 10, "2": 20, "3": 30, "4": 40 } });
});

test("overlapping saves are applied in order and Twitch matches the mirror", async () => {
  const { seg, helix } = twitch({ v: 1, c: {} });
  const { c, store } = make(helix);
  seg.delayPut = 20;
  await Promise.all([c.set("42", "1", 10), c.set("42", "2", 20)]);
  assert.deepEqual(JSON.parse(seg.content!).c, { "1": 10, "2": 20 });
  assert.deepEqual(store.getCorrections("42"), { "1": 10, "2": 20 });
});

test("unparseable segment content is treated as empty, not as an outage", async () => {
  const { seg, helix } = twitch();
  seg.content = "{not json";
  const { c } = make(helix);
  assert.equal(await c.for("42", "1"), null);
  await c.set("42", "1", 10); // allowed: the segment was read (and was junk)
  assert.deepEqual(JSON.parse(seg.content!).c, { "1": 10 });
});

test("the correction cap raises a distinct error", async () => {
  const full = Object.fromEntries(Array.from({ length: MAX_CORRECTIONS }, (_, i) => [String(i + 1), i + 1]));
  const { helix } = twitch({ v: 1, c: full });
  const { c } = make(helix);
  await assert.rejects(c.set("42", "999999", 5), CorrectionLimitError);
});
