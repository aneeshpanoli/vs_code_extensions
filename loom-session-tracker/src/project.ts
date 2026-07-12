// project.ts — ONE JOB: determine the CURRENT window's Loom repo id, so the tracker only ever shows
// and writes THIS project's agents (never another project's info leaking into this window).
// Computed exactly like the loom skill: basename(dirname(git --git-common-dir)) — so a worktree window
// (.claude/worktrees/<role>) still resolves to the parent repo id, matching board.json's bus name.

import * as vscode from "vscode";
import { execFileSync } from "child_process";
import * as path from "path";

function gitCommonDir(cwd: string): string | null {
  try {
    const common = execFileSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"],
      { encoding: "utf8", timeout: 3000 }).trim();
    return path.isAbsolute(common) ? common : path.join(cwd, common);
  } catch { return null; }
}

export function currentRepo(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  const cwd = folders[0].uri.fsPath;
  const abs = gitCommonDir(cwd);
  return abs ? path.basename(path.dirname(abs)) : path.basename(cwd);
}

/** The MAIN repo root (parent of the shared .git) — where `git worktree` operations must run. */
export function repoRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  const abs = gitCommonDir(folders[0].uri.fsPath);
  return abs ? path.dirname(abs) : null;
}
