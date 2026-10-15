

// Unified diff text → one entry per file, keyed by its new path.
export function splitDiff(diff: string): Map<string, string[]> {
  const files = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const line of diff.split('\n')) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) files.set(m[2], (cur = []));
    // a real blank context line is " "; "" only comes from the trailing newline
    else if (cur && line !== '' && !/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(line)) cur.push(line);
  }
  return files;
}

export const DIFF_LINE_CAP = 1500;

type DiffLine = { text: string; kind: 'hunk' | 'add' | 'del' | 'ctx'; oldNo: number | null; newNo: number | null };

// Old/new line numbers from the hunk headers, so comments (anchored to new-file lines) land on their line.
export function numberDiff(lines: string[]): DiffLine[] {
  let o = 0;
  let n = 0;
  return lines.map((text) => {
    const h = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      return { text, kind: 'hunk', oldNo: null, newNo: null };
    }
    if (text.startsWith('+')) return { text, kind: 'add', oldNo: null, newNo: n++ };
    if (text.startsWith('-')) return { text, kind: 'del', oldNo: o++, newNo: null };
    if (text.startsWith('\\')) return { text, kind: 'hunk', oldNo: null, newNo: null }; // "\ No newline at end of file"
    return { text, kind: 'ctx', oldNo: o++, newNo: n++ };
  });
}
