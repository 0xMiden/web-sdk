export { discoverSkills, sync, SKILLS_DIR } from "./sync";
export type { DiscoveredSkill, SyncResult } from "./sync";
export {
  ensureGitignore,
  ensurePrepareScript,
  init,
  renderBlock,
  upsertBlock,
  MARKER_BEGIN,
  MARKER_END,
} from "./init";
export type { FileChange, InitResult } from "./init";
