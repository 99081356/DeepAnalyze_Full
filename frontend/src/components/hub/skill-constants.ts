/**
 * Shared constants for Skill scope label and Badge variant mappings.
 *
 * Used by both SkillCard (list view) and SkillDetail (detail view) so
 * the SAME scope produces the SAME badge color and label text across
 * the entire hub UI.
 */

export const SCOPE_LABEL: Record<string, string> = {
  system: '系统级',
  org: '组织级',
  user: '用户级',
};

/**
 * system = high-privilege → red/error visual cue.
 * org    → info (blue).
 * user   → success (green).
 */
export const SCOPE_VARIANT: Record<
  string,
  'default' | 'info' | 'success' | 'warning' | 'error'
> = {
  system: 'error',
  org: 'info',
  user: 'success',
};
