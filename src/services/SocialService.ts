import type { RealtimeChannel } from "@supabase/supabase-js";
import type { PlayerIdentity } from "../game/types/world";
import type {
  BlockHome,
  CreatePostInput,
  FriendConnection,
  HomeInvitation,
  SocialAccount,
  SocialPost,
  SocialProfile,
} from "../social/types";
import { prepareJpeg } from "./image";
import { createOrLoadProfile } from "./profileBootstrap";
import { SocialMediaStore } from "./SocialMediaStore";
import { clearCachedSession, getOrCreateAnonymousSession, supabase } from "./supabase";

interface ProfileRow {
  user_id: string;
  display_name: string;
  handle: string | null;
  block_color: string;
  bio: string;
  interests: string[] | null;
  profile_photo_path: string | null;
  last_seen_at: string | null;
  terms_accepted_at: string | null;
  age_confirmed_at: string | null;
  terms_version: string | null;
}

interface NeighborRow {
  user_id: string;
  neighbor_id: string;
  status: "pending" | "accepted" | "blocked";
  created_at: string;
}

interface PostRow {
  id: string;
  author_id: string;
  body: string;
  media_path: string | null;
  media_type: "image" | "gif" | null;
  location_label: string | null;
  pinned_to_home: boolean;
  media_ready: boolean;
  created_at: string;
  expires_at: string;
}

interface HomeRow {
  owner_id: string;
  name: string;
  access_mode: BlockHome["accessMode"];
  welcome_note: string;
}

interface HomeInvitationRow {
  id: string;
  host_id: string;
  guest_id: string;
  kind: HomeInvitation["kind"];
  status: HomeInvitation["status"];
  created_at: string;
  expires_at: string;
}

const FEED_PAGE_SIZE = 20;
const MAX_SOCIAL_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_SOCIAL_IMAGE_BYTES = 512 * 1024;
const MAX_SOCIAL_GIF_BYTES = 1024 * 1024;
const MAP_LOCATIONS = new Set(["Town Square", "Downtown", "East Nashville", "The Gulch", "Centennial Park"]);

export class SocialService {
  readonly media = new SocialMediaStore((import.meta.env.VITE_WORLD_SOCKET_URL as string | undefined)?.trim() ?? "");
  private postChannel: RealtimeChannel | null = null;
  private alertChannel: RealtimeChannel | null = null;

  get available(): boolean {
    return Boolean(supabase);
  }

  async account(): Promise<SocialAccount> {
    const session = await getOrCreateAnonymousSession();
    return {
      userId: session.user.id,
      email: session.user.email ?? null,
      isAnonymous: session.user.is_anonymous !== false,
    };
  }

  async initializeProfile(local: PlayerIdentity): Promise<SocialProfile> {
    const session = await getOrCreateAnonymousSession();
    const existing = await this.profile(session.user.id);
    if (existing) {
      await this.touchProfile(existing.userId);
      return existing;
    }
    this.requireClient();
    return createOrLoadProfile(
      async () => {
        const { data, error } = await supabase!
          .from("profiles")
          .insert({
            user_id: session.user.id,
            display_name: cleanDisplayName(local.username),
            block_color: cleanColor(local.color),
            last_seen_at: new Date().toISOString(),
          })
          .select("*")
          .single();
        return {
          data: data ? mapProfile(data as ProfileRow) : null,
          error,
        };
      },
      () => this.profile(session.user.id),
    );
  }

  async syncIdentity(local: PlayerIdentity): Promise<void> {
    const account = await this.account();
    this.requireClient();
    const { error } = await supabase!
      .from("profiles")
      .update({
        display_name: cleanDisplayName(local.username),
        block_color: cleanColor(local.color),
        last_seen_at: new Date().toISOString(),
      })
      .eq("user_id", account.userId);
    if (error) throw error;
  }

  async updateProfile(input: {
    displayName: string;
    handle: string | null;
    bio: string;
    interests: string[];
    blockColor: string;
  }): Promise<SocialProfile> {
    const account = await this.requirePermanentAccount();
    const handle = input.handle?.trim().toLowerCase() || null;
    if (handle && !/^[a-z0-9_]{3,20}$/.test(handle)) {
      throw new Error("Handles use 3–20 lowercase letters, numbers, or underscores.");
    }
    this.requireClient();
    const { data, error } = await supabase!
      .from("profiles")
      .update({
        display_name: cleanDisplayName(input.displayName),
        handle,
        bio: input.bio.trim().slice(0, 240),
        interests: input.interests.map(value => value.trim()).filter(Boolean).slice(0, 12),
        block_color: cleanColor(input.blockColor),
        last_seen_at: new Date().toISOString(),
      })
      .eq("user_id", account.userId)
      .select("*")
      .single();
    if (error?.code === "23505") throw new Error("That handle is already taken.");
    if (error) throw error;
    return mapProfile(data as ProfileRow);
  }

  async profile(userId: string): Promise<SocialProfile | null> {
    this.requireClient();
    const { data, error } = await supabase!
      .from("profiles")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapProfile(data as ProfileRow) : null;
  }

  async requestAccountEmail(email: string): Promise<void> {
    this.requireClient();
    const account = await this.account();
    const normalized = email.trim().toLowerCase();
    if (!isEmail(normalized)) throw new Error("Enter a valid email address.");
    const redirect = currentAuthRedirect();
    if (account.isAnonymous) {
      const { error } = await supabase!.auth.updateUser({ email: normalized }, { emailRedirectTo: redirect });
      if (error) throw error;
      return;
    }
    const { error } = await supabase!.auth.signInWithOtp({
      email: normalized,
      options: { emailRedirectTo: redirect, shouldCreateUser: false },
    });
    if (error) throw error;
  }

  async acceptSocialTerms(): Promise<SocialProfile> {
    const account = await this.account();
    this.requireClient();
    const acceptedAt = new Date().toISOString();
    const { data, error } = await supabase!
      .from("profiles")
      .update({
        terms_accepted_at: acceptedAt,
        age_confirmed_at: acceptedAt,
        terms_version: "2026-07",
      })
      .eq("user_id", account.userId)
      .select("*")
      .single();
    if (error) throw error;
    return mapProfile(data as ProfileRow);
  }

  async sendExistingAccountLink(email: string): Promise<void> {
    this.requireClient();
    const normalized = email.trim().toLowerCase();
    if (!isEmail(normalized)) throw new Error("Enter a valid email address.");
    const { error } = await supabase!.auth.signInWithOtp({
      email: normalized,
      options: { emailRedirectTo: currentAuthRedirect(), shouldCreateUser: false },
    });
    if (error) throw error;
  }

  async signOutToGuest(): Promise<void> {
    this.requireClient();
    const { error } = await supabase!.auth.signOut({ scope: "local" });
    if (error) throw error;
    clearCachedSession();
    await getOrCreateAnonymousSession();
  }

  async deleteAccount(): Promise<void> {
    await this.requirePermanentAccount();
    await this.media.deleteAccount();
    if (supabase) await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
    clearCachedSession();
    await getOrCreateAnonymousSession();
  }

  onAccountChange(callback: () => void): () => void {
    if (!supabase) return () => undefined;
    const { data } = supabase.auth.onAuthStateChange(() => {
      clearCachedSession();
      window.setTimeout(callback, 0);
    });
    return () => data.subscription.unsubscribe();
  }

  async loadFeed(page = 0): Promise<SocialPost[]> {
    this.requireClient();
    const start = Math.max(0, page) * FEED_PAGE_SIZE;
    const { data, error } = await supabase!
      .from("social_posts")
      .select("*")
      .eq("media_ready", true)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .range(start, start + FEED_PAGE_SIZE - 1);
    if (error) throw error;
    return this.hydratePosts((data ?? []) as PostRow[]);
  }

  async loadMapPosts(): Promise<SocialPost[]> {
    const posts = await this.loadFeed(0);
    return posts.filter(post => Boolean(post.locationLabel));
  }

  async createPost(input: CreatePostInput): Promise<SocialPost> {
    const account = await this.requirePermanentAccount();
    const body = input.body.trim().replace(/\s+/g, " ").slice(0, 500);
    if (!body && !input.file) throw new Error("Write something or add a picture.");
    if (input.file && !this.media.available) {
      throw new Error("Photo posts need the Cloudflare world server. Text posts are ready now.");
    }

    const id = crypto.randomUUID();
    const isGif = input.file?.type === "image/gif";
    if (isGif && input.file!.size > MAX_SOCIAL_GIF_BYTES) {
      throw new Error("Animated GIFs must be 1 MB or smaller.");
    }
    const mediaPath = input.file ? `social/${account.userId}/${id}.${isGif ? "gif" : "jpg"}` : null;
    this.requireClient();
    const { data, error } = await supabase!
      .from("social_posts")
      .insert({
        id,
        author_id: account.userId,
        body,
        media_path: mediaPath,
        media_type: input.file ? (isGif ? "gif" : "image") : null,
        location_label: input.locationLabel && MAP_LOCATIONS.has(input.locationLabel.trim())
          ? input.locationLabel.trim()
          : null,
        pinned_to_home: Boolean(input.pinnedToHome),
      })
      .select("*")
      .single();
    if (error) throw error;

    let savedRow = data as PostRow;
    let uploaded = false;
    try {
      if (input.file) {
        const blob = isGif
          ? input.file
          : await prepareJpeg(input.file, {
            maxInputBytes: MAX_SOCIAL_IMAGE_INPUT_BYTES,
            maxDimension: 1280,
            maxOutputBytes: MAX_SOCIAL_IMAGE_BYTES,
          });
        await this.media.upload(id, blob);
        uploaded = true;
        const { data: readyData, error: readyError } = await supabase!
          .from("social_posts")
          .update({ media_ready: true })
          .eq("id", id)
          .select("*")
          .single();
        if (readyError) throw readyError;
        savedRow = readyData as PostRow;
      }
    } catch (uploadError) {
      if (uploaded) await this.media.remove(id).catch(() => undefined);
      await supabase!.from("social_posts").delete().eq("id", id);
      throw uploadError;
    }

    const author = await this.profile(account.userId);
    if (!author) throw new Error("Your Blockaroo profile is missing.");
    return mapPost(savedRow, author);
  }

  async deletePost(post: SocialPost): Promise<void> {
    const account = await this.requirePermanentAccount();
    if (post.authorId !== account.userId) throw new Error("Only the author can remove this post.");
    if (post.mediaPath) await this.media.remove(post.id);
    this.requireClient();
    const { error } = await supabase!.from("social_posts").delete().eq("id", post.id);
    if (error) throw error;
  }

  async loadFriends(): Promise<FriendConnection[]> {
    const account = await this.requirePermanentAccount();
    this.requireClient();
    const { data, error } = await supabase!
      .from("neighbors")
      .select("user_id,neighbor_id,status,created_at")
      .or(`user_id.eq.${account.userId},neighbor_id.eq.${account.userId}`)
      .in("status", ["pending", "accepted"])
      .order("updated_at", { ascending: false });
    if (error) throw error;
    const rows = (data ?? []) as NeighborRow[];
    const otherIds = [...new Set(rows.map(row => row.user_id === account.userId ? row.neighbor_id : row.user_id))];
    const profiles = await this.profiles(otherIds);
    return rows.flatMap(row => {
      const userId = row.user_id === account.userId ? row.neighbor_id : row.user_id;
      const profile = profiles.get(userId);
      if (!profile) return [];
      const status: FriendConnection["status"] = row.status === "accepted"
        ? "accepted"
        : row.neighbor_id === account.userId
          ? "pending-incoming"
          : "pending-outgoing";
      return [{ userId, profile, status, since: row.created_at }];
    });
  }

  async relationship(targetUserId: string): Promise<FriendConnection["status"] | "none" | "blocked"> {
    const account = await this.account();
    if (account.isAnonymous) return "none";
    this.requireClient();
    const { data: blocks, error: blockError } = await supabase!
      .from("user_blocks")
      .select("blocked_id")
      .eq("blocker_id", account.userId)
      .eq("blocked_id", targetUserId)
      .limit(1);
    if (blockError) throw blockError;
    if ((blocks ?? []).length) return "blocked";

    const { data, error } = await supabase!
      .from("neighbors")
      .select("user_id,neighbor_id,status,created_at")
      .or(`and(user_id.eq.${account.userId},neighbor_id.eq.${targetUserId}),and(user_id.eq.${targetUserId},neighbor_id.eq.${account.userId})`)
      .in("status", ["pending", "accepted"])
      .maybeSingle();
    if (error) throw error;
    if (!data) return "none";
    const row = data as NeighborRow;
    if (row.status === "accepted") return "accepted";
    return row.neighbor_id === account.userId ? "pending-incoming" : "pending-outgoing";
  }

  async sendFriendRequest(targetUserId: string): Promise<"pending" | "accepted"> {
    await this.requirePermanentAccount();
    this.requireClient();
    const { data, error } = await supabase!.rpc("send_friend_request", { target_user: targetUserId });
    if (error) throw error;
    return data === "accepted" ? "accepted" : "pending";
  }

  async respondFriendRequest(requesterId: string, accept: boolean): Promise<void> {
    await this.requirePermanentAccount();
    this.requireClient();
    const { error } = await supabase!.rpc("respond_friend_request", {
      requester_user: requesterId,
      accept_request: accept,
    });
    if (error) throw error;
  }

  async cancelFriendRequest(userId: string): Promise<void> {
    await this.requirePermanentAccount();
    this.requireClient();
    const { error } = await supabase!.rpc("cancel_friend_request", { target_user: userId });
    if (error) throw error;
  }

  async removeFriend(userId: string): Promise<void> {
    await this.requirePermanentAccount();
    this.requireClient();
    const { error } = await supabase!.rpc("remove_friend", { other_user: userId });
    if (error) throw error;
  }

  async blockUser(userId: string): Promise<void> {
    const account = await this.account();
    if (account.userId === userId) throw new Error("You cannot block yourself.");
    this.requireClient();
    const { error } = await supabase!.rpc("block_user", { target_user: userId });
    if (error) throw error;
  }

  async loadBlockedUserIds(): Promise<string[]> {
    const account = await this.account();
    this.requireClient();
    const { data, error } = await supabase!
      .from("user_blocks")
      .select("blocked_id")
      .eq("blocker_id", account.userId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).flatMap(row => typeof row.blocked_id === "string" ? [row.blocked_id] : []);
  }

  async loadBlockedProfiles(): Promise<SocialProfile[]> {
    return [...(await this.profiles(await this.loadBlockedUserIds())).values()];
  }

  async unblockUser(userId: string): Promise<void> {
    this.requireClient();
    const { error } = await supabase!.rpc("unblock_user", { target_user: userId });
    if (error) throw error;
  }

  async reportUser(userId: string, reason: string, details: string): Promise<void> {
    const account = await this.requirePermanentAccount();
    this.requireClient();
    const { error } = await supabase!.from("safety_reports").insert({
      reporter_id: account.userId,
      target_id: userId,
      reason,
      details: details.trim().slice(0, 1000),
    });
    if (error) throw error;
  }

  async loadHome(userId?: string): Promise<BlockHome> {
    const account = await this.requirePermanentAccount();
    const ownerId = userId ?? account.userId;
    const profile = await this.profile(ownerId);
    if (!profile) throw new Error("That Block Home is unavailable.");
    this.requireClient();
    const relationshipQuery = ownerId === account.userId
      ? Promise.resolve({ data: null, error: null })
      : supabase!
        .from("neighbors")
        .select("created_at")
        .or(`and(user_id.eq.${account.userId},neighbor_id.eq.${ownerId}),and(user_id.eq.${ownerId},neighbor_id.eq.${account.userId})`)
        .eq("status", "accepted")
        .maybeSingle();
    const [
      { data: homeData, error: homeError },
      { data: postData, error: postError },
      { data: relationshipData, error: relationshipError },
    ] = await Promise.all([
      supabase!.from("homes").select("owner_id,name,access_mode,welcome_note").eq("owner_id", ownerId).maybeSingle(),
      supabase!.from("social_posts").select("*").eq("author_id", ownerId).eq("pinned_to_home", true).eq("media_ready", true).order("created_at", { ascending: false }).limit(12),
      relationshipQuery,
    ]);
    if (homeError) throw homeError;
    if (postError) throw postError;
    if (relationshipError) throw relationshipError;
    const row = homeData as HomeRow | null;
    if (!row && ownerId !== account.userId) throw new Error("That Block Home is not open to visitors.");
    return {
      ownerId,
      name: row?.name ?? `${profile.displayName}'s Block`,
      accessMode: row?.access_mode ?? "knock",
      welcomeNote: row?.welcome_note ?? "",
      profile,
      pinnedPosts: (postData ?? []).map(post => mapPost(post as PostRow, profile)),
      connectedAt: relationshipData && typeof relationshipData.created_at === "string"
        ? relationshipData.created_at
        : null,
    };
  }

  async updateHome(input: { name: string; accessMode: BlockHome["accessMode"]; welcomeNote: string }): Promise<void> {
    const account = await this.requirePermanentAccount();
    this.requireClient();
    const payload = {
      owner_id: account.userId,
      city_id: "nashville",
      name: input.name.trim().slice(0, 40) || "My Block",
      access_mode: input.accessMode,
      welcome_note: input.welcomeNote.trim().slice(0, 180),
    };
    const { error } = await supabase!.from("homes").upsert(payload, { onConflict: "owner_id" });
    if (error) throw error;
  }

  async ensureHome(): Promise<void> {
    const account = await this.requirePermanentAccount();
    this.requireClient();
    const { error } = await supabase!.from("homes").upsert({
      owner_id: account.userId,
      city_id: "nashville",
      name: "My Block",
      access_mode: "knock",
      welcome_note: "",
    }, {
      onConflict: "owner_id",
      ignoreDuplicates: true,
    });
    if (error) throw error;
  }

  async inviteToHome(userId: string): Promise<void> {
    await this.requirePermanentAccount();
    this.requireClient();
    const { error } = await supabase!.rpc("invite_to_home", { target_user: userId });
    if (error) throw error;
  }

  async knockOnHome(userId: string): Promise<"open" | "knocked"> {
    await this.requirePermanentAccount();
    this.requireClient();
    const { data, error } = await supabase!.rpc("knock_on_home", { home_owner: userId });
    if (error) throw error;
    return data === "open" ? "open" : "knocked";
  }

  async loadHomeInvitations(): Promise<HomeInvitation[]> {
    const account = await this.requirePermanentAccount();
    this.requireClient();
    const { data, error } = await supabase!
      .from("home_invitations")
      .select("*")
      .or(`and(kind.eq.invite,guest_id.eq.${account.userId}),and(kind.eq.knock,host_id.eq.${account.userId})`)
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false });
    if (error) throw error;
    const rows = (data ?? []) as HomeInvitationRow[];
    const profiles = await this.profiles([...new Set(rows.map(row => row.kind === "knock" ? row.guest_id : row.host_id))]);
    return rows.flatMap(row => {
      const sender = profiles.get(row.kind === "knock" ? row.guest_id : row.host_id);
      return sender ? [{
        id: row.id,
        hostId: row.host_id,
        guestId: row.guest_id,
        kind: row.kind,
        status: row.status,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        sender,
      }] : [];
    });
  }

  async respondHomeInvitation(invitationId: string, accept: boolean): Promise<void> {
    await this.requirePermanentAccount();
    this.requireClient();
    const { error } = await supabase!.rpc("respond_home_invitation", {
      invitation_id: invitationId,
      accept_invitation: accept,
    });
    if (error) throw error;
  }

  subscribeToPosts(callback: () => void): () => void {
    if (!supabase) return () => undefined;
    const client = supabase;
    if (this.postChannel) void client.removeChannel(this.postChannel);
    const channel = client
      .channel(`social-posts:${crypto.randomUUID()}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "social_posts" }, callback)
      .subscribe();
    this.postChannel = channel;
    return () => {
      if (this.postChannel === channel) this.postChannel = null;
      void client.removeChannel(channel);
    };
  }

  subscribeToAlerts(callback: () => void): () => void {
    if (!supabase) return () => undefined;
    const client = supabase;
    if (this.alertChannel) void client.removeChannel(this.alertChannel);
    const channel = client
      .channel(`social-alerts:${crypto.randomUUID()}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "neighbors" }, callback)
      .on("postgres_changes", { event: "*", schema: "public", table: "home_invitations" }, callback)
      .subscribe();
    this.alertChannel = channel;
    return () => {
      if (this.alertChannel === channel) this.alertChannel = null;
      void client.removeChannel(channel);
    };
  }

  private async profiles(userIds: string[]): Promise<Map<string, SocialProfile>> {
    if (!userIds.length) return new Map();
    this.requireClient();
    const { data, error } = await supabase!.from("profiles").select("*").in("user_id", userIds);
    if (error) throw error;
    return new Map(((data ?? []) as ProfileRow[]).map(row => [row.user_id, mapProfile(row)]));
  }

  private async hydratePosts(rows: PostRow[]): Promise<SocialPost[]> {
    const profiles = await this.profiles([...new Set(rows.map(row => row.author_id))]);
    return rows.flatMap(row => {
      const author = profiles.get(row.author_id);
      return author ? [mapPost(row, author)] : [];
    });
  }

  private async touchProfile(userId: string): Promise<void> {
    this.requireClient();
    const { error } = await supabase!
      .from("profiles")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("user_id", userId);
    if (error) console.warn("Blockaroo could not update the profile activity timestamp", error);
  }

  private async requirePermanentAccount(): Promise<SocialAccount> {
    const account = await this.account();
    if (account.isAnonymous) throw new Error("Create your account to use friends, posts, homes, and Circles.");
    return account;
  }

  private requireClient(): void {
    if (!supabase) throw new Error("Supabase environment variables are missing.");
  }
}

function mapProfile(row: ProfileRow): SocialProfile {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    handle: row.handle,
    blockColor: row.block_color,
    bio: row.bio ?? "",
    interests: Array.isArray(row.interests) ? row.interests : [],
    profilePhotoPath: row.profile_photo_path,
    lastSeenAt: row.last_seen_at,
    termsAcceptedAt: row.terms_accepted_at ?? null,
    ageConfirmedAt: row.age_confirmed_at ?? null,
    termsVersion: row.terms_version ?? null,
  };
}

function mapPost(row: PostRow, author: SocialProfile): SocialPost {
  return {
    id: row.id,
    authorId: row.author_id,
    author,
    body: row.body,
    mediaPath: row.media_path,
    mediaType: row.media_type,
    locationLabel: row.location_label,
    pinnedToHome: row.pinned_to_home,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function cleanDisplayName(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 18) || "New Neighbor";
}

function cleanColor(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : "#ff6b6b";
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function currentAuthRedirect(): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  return url.toString();
}
