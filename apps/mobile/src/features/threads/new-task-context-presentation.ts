import { type VcsRef } from "@t3tools/client-runtime/state/vcs";
import { sanitizeNewRefName } from "@t3tools/shared/git";

type WorkspaceMode = "local" | "worktree";

export function resolveNewTaskWorkspaceLabel(input: {
  readonly workspaceMode: WorkspaceMode;
  readonly worktreePath: string | null;
}): "Current checkout" | "Current worktree" | "New worktree" {
  if (input.workspaceMode === "worktree") {
    return "New worktree";
  }
  return input.worktreePath ? "Current worktree" : "Current checkout";
}

export function resolveNewTaskBranchWorktreePath(input: {
  readonly workspaceMode: WorkspaceMode;
  readonly projectCwd: string;
  readonly branchWorktreePath: string | null | undefined;
}): string | null {
  if (
    input.workspaceMode === "worktree" ||
    !input.branchWorktreePath ||
    input.branchWorktreePath === input.projectCwd
  ) {
    return null;
  }
  return input.branchWorktreePath;
}

/**
 * Picks the base branch a new worktree draft starts from: the repo default,
 * then the local branch listRefs marks current, then the live status branch.
 * The status fallback covers a project cloned while its draft was open, whose
 * refs loaded empty. It waits for an unfiltered listRefs result, so a status
 * update that lands first cannot lock in a feature branch over the default.
 */
export function resolveNewTaskWorktreeBase(input: {
  readonly refs: ReadonlyArray<VcsRef>;
  readonly refsLoaded: boolean;
  readonly checkoutBranchName: string | null;
}): Pick<VcsRef, "name" | "worktreePath"> | null {
  // The default may only exist as origin/<default> (isRemote), so search all refs for it.
  const fromRefs =
    input.refs.find((ref) => ref.isDefault) ??
    input.refs.find((ref) => !ref.isRemote && ref.current);
  if (fromRefs) return fromRefs;
  return input.refsLoaded && input.checkoutBranchName !== null
    ? { name: input.checkoutBranchName, worktreePath: null }
    : null;
}

export function resolveNewTaskLocalWorkspaceSelection(input: {
  readonly branches: ReadonlyArray<{
    readonly name: string;
    readonly current: boolean;
    readonly worktreePath?: string | null;
  }>;
  readonly projectCwd: string;
}): {
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly awaitsCurrentBranch: boolean;
} {
  const currentBranch = input.branches.find((branch) => branch.current) ?? null;
  if (!currentBranch) {
    return {
      branch: null,
      worktreePath: null,
      awaitsCurrentBranch: true,
    };
  }

  return {
    branch: currentBranch.name,
    worktreePath: resolveNewTaskBranchWorktreePath({
      workspaceMode: "local",
      projectCwd: input.projectCwd,
      branchWorktreePath: currentBranch.worktreePath,
    }),
    awaitsCurrentBranch: false,
  };
}

export function resolveNewTaskBranchLabel(input: {
  readonly branchName: string | null;
  readonly startFromOrigin: boolean;
  readonly workspaceMode: WorkspaceMode;
}): string {
  if (!input.branchName) {
    return "Choose branch";
  }

  if (input.workspaceMode === "local") {
    return input.branchName;
  }

  const baseRef = input.startFromOrigin ? `origin/${input.branchName}` : input.branchName;
  return `From ${baseRef}`;
}

export function shouldCheckoutNewTaskBranch(input: {
  readonly branchIsCurrent: boolean;
  readonly branchWorktreePath: string | null | undefined;
  readonly workspaceMode: WorkspaceMode;
}): boolean {
  return input.workspaceMode === "local" && !input.branchIsCurrent && !input.branchWorktreePath;
}

export function filterNewTaskBranches<T extends { readonly name: string }>(
  branches: ReadonlyArray<T>,
  rawQuery: string,
): ReadonlyArray<T> {
  const query = sanitizeNewRefName(rawQuery).toLowerCase();
  return query.length === 0
    ? branches
    : branches.filter((branch) => branch.name.toLowerCase().includes(query));
}
