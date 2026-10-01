const GLYPHS: Record<string, string[]> = {
  I: ["███", " █ ", " █ ", " █ ", " █ ", "███"],
  M: ["██    ██", "███  ███", "██ ██ ██", "██    ██", "██    ██", "██    ██"],
  N: ["██    ██", "███   ██", "████  ██", "██ ██ ██", "██  ████", "██    ██"],
  O: [" ██████ ", "██    ██", "██    ██", "██    ██", "██    ██", " ██████ "],
};

export type Segment = [color: string, art: string];

export function bannerSpans(word: string, colors: string[]): Segment[][] {
  const letters = word.toUpperCase().split("");
  if (letters.length === 0 || letters.some((letter) => !GLYPHS[letter])) return [];
  const rows: Segment[][] = [];
  for (let r = 0; r < 6; r++) {
    const segments: Segment[] = [];
    for (const [i, letter] of letters.entries()) {
      const color = colors[i % colors.length]!;
      const art = GLYPHS[letter]![r]!;
      const last = segments.at(-1);
      if (last && last[0] === color) last[1] += "  " + art;
      else segments.push([color, art]);
    }
    rows.push(segments);
  }
  return rows;
}
