// ============================================================
// Guard against a trap this codebase has now fallen into three
// times: `DropdownMenuLabel` is base-ui's `Menu.GroupLabel`, and it
// THROWS at render unless it has a `Menu.Group` ancestor
// (`DropdownMenuGroup`).
//
// The failure is nasty out of proportion to the mistake. Nothing
// catches it at build time — types, lint and `next build` are all
// happy — and it only fires when the menu OPENS, so the crash lands
// on the user, not on us. And because it throws during render, the
// error boundary takes down the whole screen rather than just the
// menu: issue #336 was exactly this, and the inbox filter panel
// repeated it.
//
// A render test would be the direct way to catch this, but the suite
// runs in a `node` environment with no DOM and no testing-library.
// Scanning the source costs nothing and catches the one shape that
// actually breaks.
// ============================================================

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Is the `DropdownMenuLabel` at `index` inside a `DropdownMenuGroup`?
 *
 * Counts unclosed `<DropdownMenuGroup>` tags before that point. JSX is
 * well-formed by construction (it wouldn't compile otherwise), so an
 * open-minus-closed count is enough to know the nesting depth without
 * parsing.
 */
export function isInsideGroup(source: string, index: number): boolean {
  const before = source.slice(0, index);
  const opens = before.match(/<DropdownMenuGroup[\s>]/g)?.length ?? 0;
  const closes = before.match(/<\/DropdownMenuGroup>/g)?.length ?? 0;
  return opens > closes;
}

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

function offendingUsages() {
  const offenders: string[] = [];
  for (const file of tsxFiles('src')) {
    // The component's own definition, not a usage.
    if (file.replace(/\\/g, '/').endsWith('ui/dropdown-menu.tsx')) continue;

    const source = readFileSync(file, 'utf8');
    const pattern = /<DropdownMenuLabel[\s>]/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      if (!isInsideGroup(source, match.index)) {
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`${file.replace(/\\/g, '/')}:${line}`);
      }
    }
  }
  return offenders;
}

describe('isInsideGroup', () => {
  it('accepts a label wrapped in a group', () => {
    const src = `<DropdownMenuGroup>\n  <DropdownMenuLabel>x</DropdownMenuLabel>\n</DropdownMenuGroup>`;
    expect(isInsideGroup(src, src.indexOf('<DropdownMenuLabel'))).toBe(true);
  });

  it('rejects a bare label', () => {
    const src = `<DropdownMenuContent>\n  <DropdownMenuLabel>x</DropdownMenuLabel>\n</DropdownMenuContent>`;
    expect(isInsideGroup(src, src.indexOf('<DropdownMenuLabel'))).toBe(false);
  });

  // The exact shape that crashed the inbox: a fragment reads like a
  // wrapper but is not a Menu.Group.
  it('rejects a label wrapped only in a fragment', () => {
    const src = `<DropdownMenuContent>\n  <>\n    <DropdownMenuLabel>x</DropdownMenuLabel>\n  </>\n</DropdownMenuContent>`;
    expect(isInsideGroup(src, src.indexOf('<DropdownMenuLabel'))).toBe(false);
  });

  // Two sibling groups: the second label is inside its own group even
  // though the first group already closed.
  it('handles sibling groups without leaking state', () => {
    const src = `<DropdownMenuGroup><DropdownMenuLabel>a</DropdownMenuLabel></DropdownMenuGroup><DropdownMenuGroup><DropdownMenuLabel>b</DropdownMenuLabel></DropdownMenuGroup>`;
    expect(isInsideGroup(src, src.lastIndexOf('<DropdownMenuLabel'))).toBe(true);
  });

  it('rejects a label placed after a group has closed', () => {
    const src = `<DropdownMenuGroup><DropdownMenuItem/></DropdownMenuGroup>\n<DropdownMenuLabel>x</DropdownMenuLabel>`;
    expect(isInsideGroup(src, src.indexOf('<DropdownMenuLabel'))).toBe(false);
  });
});

describe('every DropdownMenuLabel in src/', () => {
  it('sits inside a DropdownMenuGroup', () => {
    expect(offendingUsages()).toEqual([]);
  });
});
