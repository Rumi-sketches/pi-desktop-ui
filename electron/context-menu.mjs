/**
 * Build the native menu shown when text is right-clicked in the desktop app.
 * Keeping the template separate makes the Chromium context data testable
 * without loading Electron in Node's test runner.
 *
 * @param {{ isEditable: boolean, selectionText?: string, misspelledWord?: string, dictionarySuggestions?: string[] }} params
 * @param {{ replaceMisspelling: (word: string) => void, addToDictionary: (word: string) => void }} actions
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
export function textContextMenuTemplate(params, actions) {
  const template = [];
  const misspelledWord = params.misspelledWord?.trim();

  if (misspelledWord) {
    const suggestions = params.dictionarySuggestions ?? [];
    if (suggestions.length > 0) {
      for (const suggestion of suggestions) {
        template.push({
          label: suggestion,
          click: () => actions.replaceMisspelling(suggestion),
        });
      }
    } else {
      template.push({ label: "No spelling suggestions", enabled: false });
    }
    template.push(
      { type: "separator" },
      {
        label: "Add to dictionary",
        click: () => actions.addToDictionary(misspelledWord),
      },
      { type: "separator" },
    );
  }

  if (params.isEditable) {
    template.push(
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { type: "separator" },
      { role: "selectAll" },
    );
  } else if (params.selectionText) {
    template.push({ role: "copy" });
  }

  return template;
}
