// Chromium exposes a finite set of Hunspell dictionaries, while operating
// systems expose BCP 47 preferences that are not always equally specific
// (for example `it` on one machine and `it-IT` on another). Keep the policy in
// a platform-independent module so it can be tested without booting Electron.

function canonicalLanguage(language) {
  try {
    return Intl.getCanonicalLocales(language)[0];
  } catch {
    return null;
  }
}

const baseLanguage = (language) => language.split("-")[0].toLowerCase();

/**
 * Select one available dictionary for every preferred system language.
 * Exact BCP 47 matches win; otherwise a neutral dictionary, then the first
 * available regional variant for the same base language, is used.
 *
 * @param {string[]} preferredSystemLanguages
 * @param {string[]} availableSpellCheckerLanguages
 * @returns {string[]}
 */
export function spellCheckerLanguages(preferredSystemLanguages, availableSpellCheckerLanguages) {
  const available = availableSpellCheckerLanguages
    .map((original) => ({ original, canonical: canonicalLanguage(original) }))
    .filter(({ canonical }) => canonical !== null);
  const selected = [];

  for (const preference of preferredSystemLanguages) {
    const canonical = canonicalLanguage(preference);
    if (!canonical) continue;
    const base = baseLanguage(canonical);
    const match = available.find((item) => item.canonical.toLowerCase() === canonical.toLowerCase())
      ?? available.find((item) => item.canonical.toLowerCase() === base)
      ?? available.find((item) => baseLanguage(item.canonical) === base);
    if (match && !selected.includes(match.original)) selected.push(match.original);
  }

  return selected;
}
