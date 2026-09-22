import assert from "node:assert/strict";
import test from "node:test";
import { textContextMenuTemplate } from "../electron/context-menu.mjs";

const noOpActions = {
  replaceMisspelling() {},
  addToDictionary() {},
};

test("offers editing commands in editable text", () => {
  const template = textContextMenuTemplate({ isEditable: true }, noOpActions);
  assert.deepEqual(
    template.map((item) => item.role ?? item.type),
    ["undo", "redo", "separator", "cut", "copy", "paste", "separator", "selectAll"],
  );
});

test("offers copy for selected read-only text and no menu otherwise", () => {
  assert.deepEqual(
    textContextMenuTemplate({ isEditable: false, selectionText: "selected" }, noOpActions),
    [{ role: "copy" }],
  );
  assert.deepEqual(
    textContextMenuTemplate({ isEditable: false, selectionText: "" }, noOpActions),
    [],
  );
});

test("offers spelling replacements and dictionary action", () => {
  const calls = [];
  const template = textContextMenuTemplate(
    {
      isEditable: true,
      misspelledWord: "wrng",
      dictionarySuggestions: ["wrong", "wring"],
    },
    {
      replaceMisspelling: (word) => calls.push(["replace", word]),
      addToDictionary: (word) => calls.push(["add", word]),
    },
  );

  assert.equal(template[0].label, "wrong");
  assert.equal(template[1].label, "wring");
  assert.equal(template[3].label, "Add to dictionary");
  const electronArgs = /** @type {[never, never, never]} */ ([{}, {}, {}]);
  template[0].click?.(...electronArgs);
  template[3].click?.(...electronArgs);
  assert.deepEqual(calls, [["replace", "wrong"], ["add", "wrng"]]);
});

test("shows an explicit empty state when Chromium has no spelling suggestions", () => {
  const template = textContextMenuTemplate(
    { isEditable: true, misspelledWord: "zzzz", dictionarySuggestions: [] },
    noOpActions,
  );
  assert.deepEqual(template[0], { label: "No spelling suggestions", enabled: false });
});
