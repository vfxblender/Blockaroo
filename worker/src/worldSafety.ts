export interface WorldSafetyState {
  authUserId: string;
  blockedUserIds: string[];
}

/**
 * Blocking is reciprocal inside the live world: if either person blocks the
 * other, neither side should receive presence, nearby chat, pictures, Circle
 * invitations, or voice signaling for that pair.
 */
export function hasBlockBetween(first: WorldSafetyState, second: WorldSafetyState): boolean {
  return first.blockedUserIds.includes(second.authUserId)
    || second.blockedUserIds.includes(first.authUserId);
}
