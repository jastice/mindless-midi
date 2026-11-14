/**
 * websfz (SFZ as JSON, as danigb/samples publishes it), read the way the
 * sampler read it before sample packs (docs/sample-format-plan.md, step 2).
 *
 * The pack generator flattens a document with this, and the zone-equivalence
 * test compares what the sampler plays from a manifest with what it played
 * from the document, so this is kept as the reference: change it only to
 * match what the old loader did.
 */

export interface SfzRegion {
  sample: string;
  lokey: number;
  hikey: number;
  lovel: number;
  hivel: number;
  center: number;
  tune: number;
  volume: number;
  offset: number;
  xfin: [number, number] | null;
  xfout: [number, number] | null;
  seqLength: number;
  seqPosition: number;
  /** Folder of the sample, relative to the document's: the instrument's sample path, then any `<control>` prefix. */
  prefix: string;
  /** Loop opcodes, where the source has them (the sampler finds its own loop points today). */
  loop: { mode: string; start?: number; end?: number } | null;
}

export type Opcodes = Record<string, unknown>;
export interface WebsfzDoc {
  meta?: Opcodes;
  global?: Opcodes;
  groups: (Opcodes & { regions: Opcodes[]; control?: Opcodes })[];
}

const NOTE_INDEX: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

export function sfzKey(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return undefined;
  const m = /^([a-gA-G])([#b]?)(-?\d+)$/.exec(v.trim());
  if (!m) return Number(v);
  const acc = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
  return 12 * (Number(m[3]) + 1) + NOTE_INDEX[m[1]!.toLowerCase()]! + acc;
}

/** Conditions the sampler doesn't model (pedal, CC switches, keyswitches, release triggers): skip the region. */
export function playable(o: Opcodes): boolean {
  for (const k of Object.keys(o)) {
    if (/^(lo|hi)cc\d+$/.test(k) || k.startsWith("sw_") || (k === "trigger" && o[k] !== "attack")) return false;
  }
  return true;
}

/** Every region the sampler can play, with global, group and region opcodes resolved. */
export function parseWebsfz(doc: WebsfzDoc, samplePath = ""): SfzRegion[] {
  const regions: SfzRegion[] = [];
  // A <control> header applies to every group after it, not just its own.
  let prefix = "";
  for (const g of doc.groups) {
    const { regions: rs, control, ...groupOps } = g;
    if (control?.prefix_sfz_path !== undefined) prefix = String(control.prefix_sfz_path);
    for (const r of rs) {
      const o: Opcodes = { ...(doc.global ?? {}), ...groupOps, ...r };
      if (!playable(o) || typeof o.sample !== "string") continue;
      const lokey = sfzKey(o.lokey ?? o.key) ?? 0;
      const hikey = sfzKey(o.hikey ?? o.key) ?? 127;
      const pair = (a: unknown, b: unknown): [number, number] | null => (a === undefined && b === undefined ? null : [Number(a ?? 0), Number(b ?? 127)]);
      const mode = o.loop_mode ?? o.loopmode;
      regions.push({
        sample: o.sample,
        lokey,
        hikey,
        lovel: Number(o.lovel ?? 0),
        hivel: Number(o.hivel ?? 127),
        center: sfzKey(o.pitch_keycenter ?? o.key) ?? lokey,
        tune: Number(o.tune ?? 0) + 100 * Number(o.transpose ?? 0),
        volume: Number(o.volume ?? 0) + Number(o.group_volume ?? 0),
        offset: Number(o.offset ?? 0),
        xfin: pair(o.xfin_lovel, o.xfin_hivel),
        xfout: pair(o.xfout_lovel, o.xfout_hivel),
        seqLength: Number(o.seq_length ?? 1),
        seqPosition: Number(o.seq_position ?? 1),
        prefix: samplePath + prefix,
        loop:
          mode === undefined || mode === "no_loop" || mode === "one_shot"
            ? null
            : {
                mode: String(mode),
                ...(o.loop_start ?? o.loopstart) !== undefined ? { start: Number(o.loop_start ?? o.loopstart) } : {},
                ...(o.loop_end ?? o.loopend) !== undefined ? { end: Number(o.loop_end ?? o.loopend) } : {},
              },
      });
    }
  }
  return regions;
}

/** The region's file, relative to the document's folder, as the old loader named it (it asked for m4a). */
export function regionFile(r: SfzRegion): string {
  return `${r.prefix}${r.sample}.m4a`;
}

/** The URL the old loader fetched for a region: the document's folder plus the file, encoded. */
export function regionUrl(base: string, r: SfzRegion): string {
  return encodeURI(`${base}${regionFile(r)}`).replace(/#/g, "%23");
}
