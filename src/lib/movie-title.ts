/**
 * Provider movie titles carry extra information: a language or quality tag and a year, in
 * varying formats. "4K-NC:Superman - 2025", "FI:Risto Räppääjä - 2020", "Habemus Papam (2011)".
 */
export interface MovieTitle {
  title: string;
  year?: number;
  /** Leading tag such as "4K-NC", "FI" or "DK" (language, region or quality). */
  tag?: string;
}

// A short uppercase tag: "FI:", "4K-NC:", "NF-DK:", "|NO|", or "NC - ".
const TAG = /^\s*(?:\|([A-Z0-9-]{2,8})\||([A-Z0-9]{2,5}(?:-[A-Z0-9]{2,5})?)\s*:|([A-Z0-9]{2,5})\s+-\s+)\s*/;
// A trailing year: "- 2020", "(2011)", "[2019]", " 2008".
const YEAR = /\s*(?:-\s*|\(|\[)?((?:19|20)\d{2})[)\]]?\s*$/;

/**
 * "SuperMan.The.Christopher.Reeve.Story" (a file name) → "SuperMan The Christopher Reeve Story".
 * Only for titles without spaces made of several dotted words; abbreviations like "S.W.A.T."
 * (mostly single letters) stay as they are.
 */
function undot(title: string): string {
  if (/\s/.test(title)) return title;
  const parts = title.split(/[._]+/).filter(Boolean);
  if (parts.length < 3 || parts.filter((p) => p.length >= 2).length < parts.length / 2) return title;
  return parts.join(' ');
}

export function parseMovieTitle(raw: string): MovieTitle {
  let title = raw.trim();
  let tag: string | undefined;
  const tagMatch = TAG.exec(title);
  if (tagMatch) {
    tag = tagMatch[1] ?? tagMatch[2] ?? tagMatch[3];
    title = title.slice(tagMatch[0].length);
  }
  title = undot(title);
  let year: number | undefined;
  const yearMatch = YEAR.exec(title);
  // Keep titles that are only a year ("2012"), and numbers that can't be a release year yet
  // ("Blade Runner 2049").
  const plausible = yearMatch && Number(yearMatch[1]) <= new Date().getFullYear() + 1;
  if (yearMatch && plausible && yearMatch.index > 0) {
    year = Number(yearMatch[1]);
    title = title.slice(0, yearMatch.index);
  }
  return { title: title.trim() || raw.trim(), year, tag };
}
