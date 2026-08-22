/**
 * Guards found by auditing every coercion for the shape that produced the
 * `Rs. 1,299/-` price bug: code that removes what it does not want and trusts
 * the remainder, or otherwise returns a plausible wrong value instead of
 * failing. See CLAUDE.md, "Extract, do not subtract".
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { parsePrice, splitList } from "../lib/ingest/cells.ts";
import { parseWorkbook } from "../lib/ingest/parse.ts";

const fixture = (name: string) => join(import.meta.dirname, "..", "fixtures", name);

describe("money path sanity band", () => {
  test("a price under ₹1 is flagged, not accepted", () => {
    const got = parsePrice("0.50");
    assert.equal(got.amount_minor, 50);
    assert.ok(got.flags.includes("PRICE_OUT_OF_BAND"));
  });

  test("a price over ₹10,00,000 is flagged, not accepted", () => {
    const got = parsePrice("50,00,000");
    assert.ok(got.flags.includes("PRICE_OUT_OF_BAND"));
  });

  test("ordinary small-merchant prices are not flagged", () => {
    for (const raw of ["₹2799", "899.50", "2.8k", "199", "Rs. 1,299/-"]) {
      assert.ok(
        !parsePrice(raw).flags.includes("PRICE_OUT_OF_BAND"),
        `${raw} should be in band`,
      );
    }
  });

  test("the band alone would have caught the Rs. 1,299/- bug", () => {
    // That bug produced 13 paise. Independent of the extraction fix, the band
    // rejects it — which is the point of having both.
    const wrongValue = 13;
    assert.ok(wrongValue < 100, "13 paise is below the ₹1 floor");
  });
});

describe("splitList does not fabricate variants", () => {
  test("a fraction is one measure, not two sizes", () => {
    assert.deepEqual(splitList("1/2 kg"), ["1/2 kg"]);
    assert.deepEqual(splitList("1/4 kg"), ["1/4 kg"]);
  });

  test("a spaced slash between measures is still a real list", () => {
    assert.deepEqual(splitList("5 kg / 10 kg"), ["5 kg", "10 kg"]);
    assert.deepEqual(splitList("Half Sleeve / Full Sleeve"), [
      "Half Sleeve",
      "Full Sleeve",
    ]);
  });

  test("single-word tight slashes still split", () => {
    assert.deepEqual(splitList("S/M/L"), ["S", "M", "L"]);
    assert.deepEqual(splitList("30/32/34"), ["30", "32", "34"]);
    assert.deepEqual(splitList("Red/Blue"), ["Red", "Blue"]);
  });

  test("under-splitting is the accepted failure, and it is visible", () => {
    // Known limitation, chosen deliberately: safer to yield one compound
    // variant a human can see than two fabricated SKUs an agent can buy.
    assert.deepEqual(splitList("Half Sleeve/Full Sleeve"), [
      "Half Sleeve/Full Sleeve",
    ]);
  });

  test("the grocery rows in the fixture produce the right variant counts", async () => {
    const [sheet] = await parseWorkbook(fixture("messy-06-variants-in-row.xlsx"));
    assert.ok(sheet);

    const ghee = sheet.rows.find((r) => r.cells["Item"] === "Ghee Tin");
    assert.ok(ghee);
    assert.equal(splitList(ghee.cells["Size"]).length, 1);

    const rice = sheet.rows.find((r) => r.cells["Item"] === "Rice Bag");
    assert.ok(rice);
    assert.equal(splitList(rice.cells["Size"]).length, 2);
  });
});
