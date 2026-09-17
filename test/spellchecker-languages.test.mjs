import assert from "node:assert/strict";
import test from "node:test";
import { spellCheckerLanguages } from "../electron/spellchecker-languages.mjs";

test("selects exact dictionaries in system preference order", () => {
  assert.deepEqual(
    spellCheckerLanguages(["it-IT", "ar-SA", "en-US"], ["ar-SA", "en-US", "it-IT"]),
    ["it-IT", "ar-SA", "en-US"],
  );
});

test("negotiates neutral and regional variants", () => {
  assert.deepEqual(
    spellCheckerLanguages(["it", "ar-EG"], ["it-IT", "ar", "ar-SA"]),
    ["it-IT", "ar"],
  );
});

test("ignores invalid, unavailable, and duplicate language preferences", () => {
  assert.deepEqual(
    spellCheckerLanguages(["not_a_locale", "it-CH", "it-IT", "ja-JP"], ["it-IT", "en-US"]),
    ["it-IT"],
  );
});
