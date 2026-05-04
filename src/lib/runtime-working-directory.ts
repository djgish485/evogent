export function resolveRuntimeWorkingDirectory(): string {
  // MEDIA_AGENT_ROOT can point at the stable checkout during validation; chat
  // sessions and spawned tasks must run from the active app process/worktree.
  return process.cwd();
}
