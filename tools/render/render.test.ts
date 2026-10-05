import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { StyleBundle } from "../../src/corpus/schema.js";
import { levels, render } from "./render_lib.js";

const { styles } = JSON.parse(readFileSync("styles/styles.json", "utf8")) as { styles: StyleBundle[] };

for (const style of styles) {
  test(`${style.id}: renders at the shared loudness target without clipping hard`, async () => {
    const r = await render([style], { seconds: 24, seed: `render-test-${style.id}`, applyGain: true });
    const st = levels(r);
    console.log(
      `${style.id}: peak=${st.peak.toFixed(3)} rms=${st.rms.toFixed(4)} ` +
        `speed=${((24 * 1000) / r.wallMs).toFixed(1)}x per-second=[${st.rmsPerSecond.map((x) => x.toFixed(2)).join(" ")}]`,
    );
    assert.equal(st.nonFinite, 0, "no NaN/Inf samples");
    // The browser's limiter catches modest overs; anything bigger is a mixing bug.
    assert.ok(st.peak < 1.6, `peak ${st.peak}`);
    assert.ok(st.rms > 0.03 && st.rms < 0.25, `rms ${st.rms} far from the calibration target`);
    // After the first few seconds (intros can be sparse) there are no long dropouts.
    const silentSeconds = st.rmsPerSecond.slice(4).filter((x) => x < 0.005).length;
    assert.ok(silentSeconds <= 2, `${silentSeconds} near-silent seconds`);
  });
}
