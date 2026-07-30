export interface SocialProfile {
  userId: string;
  displayName: string;
  handle: string | null;
  blockColor: string;
  bio: string;
  interests: string[];
  profilePhotoPath: string | null;
  lastSeenAt: string | null;
  termsAcceptedAt: string | null;
  ageConfirmedAt: string | null;
  termsVersion: string | null;
}

export interface FriendConnection {
  userId: string;
  profile: SocialProfile;
  status: "pending-incoming" | "pending-outgoing" | "accepted";
  since: string;
}

export interface DirectMessage {
  id: string;
  senderId: string;
  recipientId: string;
  body: string | null;
  ciphertext: string | null;
  encryptionVersion: number | null;
  clientNonce: string;
  createdAt: string;
  readAt: string | null;
}

export interface PortalRoomPresence {
  id: string;
  cityId: "nashville";
  label: string;
  kind: "town-square" | "overworld" | "theater";
  tagline: string;
  mapX: number;
  mapY: number;
  color: string;
  event: boolean;
  onlineCount: number | null;
  friendUserIds: string[];
}

export interface PortalSnapshot {
  cityId: "nashville";
  cityName: "Nashville";
  rooms: PortalRoomPresence[];
  updatedAt: string;
  live: boolean;
}

export interface SocialPost {
  id: string;
  authorId: string;
  author: SocialProfile;
  body: string;
  mediaPath: string | null;
  mediaType: "image" | "gif" | null;
  locationLabel: string | null;
  pinnedToHome: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface BlockHome {
  ownerId: string;
  name: string;
  accessMode: "open" | "knock" | "invite" | "dnd" | "away";
  welcomeNote: string;
  profile: SocialProfile;
  pinnedPosts: SocialPost[];
  connectedAt: string | null;
}

export interface HomeInvitation {
  id: string;
  hostId: string;
  guestId: string;
  kind: "invite" | "knock";
  status: "pending" | "accepted" | "declined";
  createdAt: string;
  expiresAt: string;
  sender: SocialProfile;
}

export interface SocialAccount {
  userId: string;
  email: string | null;
  isAnonymous: boolean;
}

export interface CreatePostInput {
  body: string;
  file?: File;
  locationLabel?: string | null;
  pinnedToHome?: boolean;
}
