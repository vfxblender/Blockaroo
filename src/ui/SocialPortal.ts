import {
  PUBLIC_PORTAL_ROOMS,
  homeSpaceId,
  isPortalRoomId,
  portalRoom,
} from "../../shared/portalRooms";
import type { PlayerIdentity, WorldLocation } from "../game/types/world";
import { SocialService } from "../services/SocialService";
import {
  BLOCK_PLANET_SLOTS,
  buildBlockPlanetStacks,
  demoBlockPlanetPage,
  hasDemoBlockPlanetPage,
  isBlockPlanetDismiss,
  nextBlockPlanetSlotIndex,
  resolveBlockPlanetViewerStep,
  type BlockPlanetArrowKey,
} from "../social/blockPlanet";
import {
  buildNeighborhoodThreads,
  recentHouseBlocks,
  type NeighborhoodThread,
} from "../social/neighborhood";
import {
  HOME_FURNITURE_CATALOG,
  HOME_FURNITURE_KINDS,
  clampHomeCoordinate,
  cloneHomeInterior,
  createHomeFurniture,
  defaultHomeInterior,
  furnitureLabel,
  normalizeHomeInterior,
  type HomeFurnitureKind,
  type HomeInteriorLayout,
  type HomeLighting,
} from "../social/homeInterior";
import type {
  BlockHome,
  DirectMessage,
  FriendConnection,
  HomeInvitation,
  PortalSnapshot,
  SocialAccount,
  SocialPost,
  SocialProfile,
} from "../social/types";
import { escapeAttribute, escapeHtml } from "./html";

type PortalTab = "feed" | "friends" | "map" | "home" | "alerts";
type PortalModal = "post" | "planet-post" | "account" | "consent" | null;

interface BlockPlanetDrag {
  pointerId: number;
  startX: number;
  startY: number;
  deltaX: number;
  deltaY: number;
  moved: boolean;
  post: HTMLElement;
  postId: string;
  stage: HTMLElement;
}

interface BlockPlanetViewerDrag {
  pointerId: number;
  startX: number;
  startY: number;
  deltaX: number;
  deltaY: number;
  card: HTMLElement;
}

interface HomeFurnitureDrag {
  pointerId: number;
  furnitureId: string;
  room: HTMLElement;
  item: HTMLElement;
  moved: boolean;
  startX: number;
  startY: number;
}

interface SocialPortalActions {
  onIdentityChange(profile: SocialProfile): void;
  onConnectToFriend(userId: string): void;
  onOpenChange(open: boolean): void;
  onNotice(message: string): void;
  onAccountReady(): void;
  onBlockedUsersChange(userIds: string[]): void;
  currentLocation(): WorldLocation;
  onTravel(location: WorldLocation, interiorLayout?: HomeInteriorLayout): Promise<void>;
}

const MAP_LOCATIONS = ["", ...PUBLIC_PORTAL_ROOMS.map(room => room.label)];
const FEED_PAGE_SIZE = 20;

export class SocialPortal {
  private readonly root: HTMLElement;
  private readonly service = new SocialService();
  private localIdentity: PlayerIdentity;
  private account: SocialAccount | null = null;
  private profile: SocialProfile | null = null;
  private feed: SocialPost[] = [];
  private feedPage = 0;
  private feedHasMore = false;
  private feedLoadingMore = false;
  private feedIsDemo = false;
  private feedPages = new Map<number, SocialPost[]>();
  private planetUpdatesWaiting = false;
  private selectedPlanetPostId: string | null = null;
  private viewedPlanetPostIds = new Set<string>();
  private likedPlanetPostIds = new Set<string>();
  private planetComments = new Map<string, string[]>();
  private planetCommentsOpen = false;
  private dismissedPlanetPostIds = new Set<string>();
  private planetDrag: BlockPlanetDrag | null = null;
  private planetViewerDrag: BlockPlanetViewerDrag | null = null;
  private planetAnimating = false;
  private planetDismissing = false;
  private planetForming = false;
  private planetViewerAnimating = false;
  private planetViewerWheelLocked = false;
  private suppressPlanetClickUntil = 0;
  private friends: FriendConnection[] = [];
  private directMessages: DirectMessage[] = [];
  private neighborHomeInteriors = new Map<string, HomeInteriorLayout>();
  private expandedNeighborId: string | null = null;
  private cutawayAvatarPositions = new Map<string, { x: number; y: number }>();
  private homeDraft: HomeInteriorLayout | null = null;
  private selectedHomeFurnitureId: string | null = null;
  private homeFurnitureDrag: HomeFurnitureDrag | null = null;
  private neighborSearchQuery = "";
  private neighborSearchResults: SocialProfile[] = [];
  private portalSnapshot: PortalSnapshot | null = null;
  private mapPosts: SocialPost[] = [];
  private home: BlockHome | null = null;
  private invitations: HomeInvitation[] = [];
  private blockedProfiles: SocialProfile[] = [];
  private tab: PortalTab = "feed";
  private viewedHomeId: string | null = null;
  private openState = false;
  private loading = true;
  private setupError = "";
  private modal: PortalModal = null;
  private accountMessage = "";
  private mediaUrls = new Map<string, string>();
  private mediaLoads = new Map<string, Promise<string>>();
  private mediaObserver: IntersectionObserver | null = null;
  private unsubscribeAuth: (() => void) | null = null;
  private unsubscribePosts: (() => void) | null = null;
  private unsubscribeAlerts: (() => void) | null = null;
  private unsubscribeMessages: (() => void) | null = null;
  private avatarRect: DOMRect | null = null;
  private accent = "#ff6b6b";
  private initializeGeneration = 0;
  private loadGeneration = 0;
  private alertGeneration = 0;
  private worldAccountKey: string | null = null;

  constructor(localIdentity: PlayerIdentity, private readonly actions: SocialPortalActions) {
    this.localIdentity = localIdentity;
    this.root = document.createElement("section");
    this.root.className = "social-portal";
    this.root.hidden = true;
    this.root.setAttribute("aria-label", "Your Blockaroo social portal");
    document.body.append(this.root);
    this.root.addEventListener("click", event => this.handleClick(event));
    this.root.addEventListener("submit", event => void this.handleSubmit(event));
    this.root.addEventListener("pointerdown", event => {
      if (!this.handleHomePointerDown(event)) this.handlePlanetPointerDown(event);
    });
    this.root.addEventListener("pointermove", event => {
      if (!this.handleHomePointerMove(event)) this.handlePlanetPointerMove(event);
    }, { passive: false });
    this.root.addEventListener("pointerup", event => {
      if (!this.handleHomePointerEnd(event)) this.handlePlanetPointerEnd(event);
    });
    this.root.addEventListener("pointercancel", event => {
      if (!this.handleHomePointerEnd(event)) this.handlePlanetPointerEnd(event);
    });
    this.root.addEventListener("input", event => this.handleHomeSettingInput(event));
    this.root.addEventListener("keydown", event => this.handlePlanetKeyDown(event));
    this.root.addEventListener("wheel", event => this.handlePlanetViewerWheel(event), { passive: false });
    this.unsubscribeAuth = this.service.onAccountChange(() => void this.initialize());
    this.unsubscribePosts = this.service.subscribeToPosts(() => {
      if (!this.openState || this.tab !== "feed" || this.modal || this.account?.isAnonymous) return;
      if (this.feedPage > 0) {
        this.planetUpdatesWaiting = true;
        this.render();
        return;
      }
      void this.loadCurrentTab();
    });
    this.unsubscribeAlerts = this.service.subscribeToAlerts(() => void this.refreshAlertData());
    void this.initialize();
  }

  get isOpen(): boolean {
    return this.openState;
  }

  async initialize(): Promise<void> {
    const generation = ++this.initializeGeneration;
    this.loading = true;
    this.setupError = "";
    this.render();
    try {
      const account = await this.service.account();
      const profile = await this.service.initializeProfile(this.localIdentity);
      if (generation !== this.initializeGeneration) return;
      this.account = account;
      this.profile = profile;
      if (this.profile.displayName !== this.localIdentity.username || this.profile.blockColor !== this.localIdentity.color) {
        this.actions.onIdentityChange(this.profile);
      }
      const blockedUserIds = await this.service.loadBlockedUserIds();
      if (generation !== this.initializeGeneration) return;
      this.actions.onBlockedUsersChange(blockedUserIds);
      if (!this.account.isAnonymous && this.profileReady()) {
        await this.ensureOwnHome();
        if (generation !== this.initializeGeneration) return;
        await this.startMessageSubscription();
        if (generation !== this.initializeGeneration) return;
      } else {
        this.unsubscribeMessages?.();
        this.unsubscribeMessages = null;
      }
      const nextAccountKey = this.accountStateKey();
      const worldAccountChanged = this.worldAccountKey !== null && this.worldAccountKey !== nextAccountKey;
      if (worldAccountChanged) this.clearSocialCache();
      this.worldAccountKey = nextAccountKey;
      if (worldAccountChanged) this.actions.onAccountReady();
      if (!this.account.isAnonymous && this.profileReady()) void this.refreshAlertData();
    } catch (error) {
      if (generation !== this.initializeGeneration) return;
      console.error("Blockaroo social profile could not initialize", error);
      this.setupError = errorMessage(error);
    } finally {
      if (generation !== this.initializeGeneration) return;
      this.loading = false;
      if (this.openState) await this.loadCurrentTab();
      else this.render();
    }
  }

  updateLocalIdentity(identity: PlayerIdentity): void {
    this.localIdentity = identity;
    if (this.profile) {
      this.profile = { ...this.profile, displayName: identity.username, blockColor: identity.color };
    }
    void this.service.syncIdentity(identity).catch(() => undefined);
  }

  accountIsAnonymous(): boolean {
    return this.account?.isAnonymous !== false || !this.profileReady();
  }

  relationship(userId: string): Promise<FriendConnection["status"] | "none" | "blocked"> {
    return this.service.relationship(userId);
  }

  async sendFriendRequest(userId: string): Promise<string> {
    const status = await this.service.sendFriendRequest(userId);
    return status === "accepted" ? "You are now friends." : "Friend request sent.";
  }

  async acceptFriendRequest(userId: string): Promise<void> {
    await this.service.respondFriendRequest(userId, true);
  }

  async blockUser(userId: string): Promise<void> {
    await this.service.blockUser(userId);
    this.actions.onBlockedUsersChange(await this.service.loadBlockedUserIds());
    this.actions.onAccountReady();
  }

  async reportUser(userId: string, reason: string, details: string): Promise<void> {
    await this.service.reportUser(userId, reason, details);
  }

  async requestHomeAccess(userId: string): Promise<"open" | "knocked"> {
    return this.service.knockOnHome(userId);
  }

  open(rect: DOMRect, color: string, tab: PortalTab = "feed"): void {
    this.avatarRect = rect;
    this.accent = color;
    this.tab = tab;
    this.viewedHomeId = tab === "home" ? this.account?.userId ?? null : this.viewedHomeId;
    this.openState = true;
    this.positionOrigin();
    this.root.hidden = false;
    this.render();
    requestAnimationFrame(() => this.root.classList.add("is-open"));
    this.actions.onOpenChange(true);
    void this.loadCurrentTab();
    void this.refreshAlertData();
  }

  openHome(userId: string, rect: DOMRect, color: string): void {
    this.viewedHomeId = userId;
    this.open(rect, color, "home");
  }

  close(): void {
    if (!this.openState) return;
    this.openState = false;
    this.modal = null;
    this.selectedPlanetPostId = null;
    this.planetCommentsOpen = false;
    this.root.classList.remove("is-open");
    this.actions.onOpenChange(false);
    window.setTimeout(() => {
      if (!this.openState) this.root.hidden = true;
    }, 280);
  }

  destroy(): void {
    this.unsubscribeAuth?.();
    this.unsubscribePosts?.();
    this.unsubscribeAlerts?.();
    this.unsubscribeMessages?.();
    this.mediaObserver?.disconnect();
    this.mediaObserver = null;
    for (const url of this.mediaUrls.values()) URL.revokeObjectURL(url);
    this.mediaUrls.clear();
    this.mediaLoads.clear();
    this.root.remove();
  }

  private async loadCurrentTab(): Promise<void> {
    const generation = ++this.loadGeneration;
    if (!this.openState) {
      this.render();
      return;
    }
    if (this.tab === "feed" && (this.setupError || !this.account || this.account.isAnonymous)) {
      this.prepareDemoPlanet(0);
      this.loading = false;
      this.render();
      return;
    }
    if (this.tab === "map") {
      this.loading = true;
      this.render();
      try {
        const [snapshot, friends] = await Promise.all([
          this.service.loadPortalSnapshot(),
          this.account?.isAnonymous === false && this.profileReady()
            ? this.service.loadFriends()
            : Promise.resolve(this.friends),
        ]);
        if (generation !== this.loadGeneration) return;
        this.portalSnapshot = snapshot;
        this.friends = friends;
      } catch (error) {
        if (generation === this.loadGeneration) this.actions.onNotice(errorMessage(error));
      } finally {
        if (generation !== this.loadGeneration) return;
        this.loading = false;
        this.render();
      }
      return;
    }
    if (this.setupError) {
      this.render();
      return;
    }
    if (!this.account || this.account.isAnonymous || !this.profileReady()) {
      this.render();
      return;
    }
    this.loading = true;
    this.render();
    const tab = this.tab;
    const viewedHomeId = this.viewedHomeId;
    try {
      if (tab === "feed") {
        const liveFeed = await this.service.loadFeed();
        if (generation !== this.loadGeneration) return;
        this.feedPages.clear();
        this.feedIsDemo = liveFeed.length === 0;
        const feed = this.feedIsDemo ? demoBlockPlanetPage(0) : liveFeed;
        this.feed = feed;
        this.feedPages.set(0, feed);
        this.feedPage = 0;
        this.feedHasMore = this.feedIsDemo
          ? hasDemoBlockPlanetPage(1)
          : liveFeed.length === FEED_PAGE_SIZE;
        this.planetUpdatesWaiting = false;
      }
      if (tab === "friends") {
        const friends = await this.service.loadFriends();
        const [messages, snapshot, homeInteriors] = await Promise.all([
          this.service.loadDirectMessages(),
          this.service.loadPortalSnapshot(),
          this.service.loadHomeInteriors(
            friends.filter(friend => friend.status === "accepted").map(friend => friend.userId),
          ),
        ]);
        if (generation !== this.loadGeneration) return;
        this.friends = friends;
        this.directMessages = messages;
        this.portalSnapshot = snapshot;
        this.neighborHomeInteriors = homeInteriors;
      }
      if (tab === "home") {
        const home = await this.service.loadHome(viewedHomeId ?? this.account.userId);
        if (generation !== this.loadGeneration) return;
        this.home = home;
        if (home.ownerId === this.account.userId) {
          this.homeDraft = cloneHomeInterior(home.interiorLayout);
          if (!this.homeDraft.furniture.some(item => item.id === this.selectedHomeFurnitureId)) {
            this.selectedHomeFurnitureId = this.homeDraft.furniture[0]?.id ?? null;
          }
        } else {
          this.homeDraft = null;
          this.selectedHomeFurnitureId = null;
        }
      }
      if (tab === "alerts") {
        const [friends, invitations, blockedProfiles, messages] = await Promise.all([
          this.service.loadFriends(),
          this.service.loadHomeInvitations(),
          this.service.loadBlockedProfiles(),
          this.service.loadDirectMessages(),
        ]);
        if (generation !== this.loadGeneration) return;
        this.friends = friends;
        this.invitations = invitations;
        this.blockedProfiles = blockedProfiles;
        this.directMessages = messages;
      }
    } catch (error) {
      if (generation !== this.loadGeneration) return;
      this.actions.onNotice(errorMessage(error));
    } finally {
      if (generation !== this.loadGeneration) return;
      this.loading = false;
      this.render();
    }
  }

  private render(): void {
    this.mediaObserver?.disconnect();
    const guestMode = !this.account || this.account.isAnonymous;
    const accountLabel = guestMode ? "Guest · Claim" : this.account?.email ?? "Account";
    const accountChip = guestMode
      ? `<button class="social-account-chip is-guest" data-social-action="claim-account">${escapeHtml(accountLabel)}</button>`
      : `<span class="social-account-chip">${escapeHtml(accountLabel)}</span>`;
    const alertCount = this.alertCount();
    this.root.innerHTML = `
      <div class="social-shell">
        <header class="social-header">
          <div class="social-wordmark"><span class="eyebrow">YOUR BLOCK</span><strong>BLOCKAROO</strong></div>
          <nav aria-label="Social portal">
            ${navButton("feed", "Wall", this.tab)}
            ${navButton("friends", "Neighborhood", this.tab)}
            ${navButton("map", "Portal", this.tab)}
            ${navButton("home", "Block Home", this.tab)}
          </nav>
          <div class="social-header-actions">
            ${accountChip}
            <button
              class="social-alerts-button ${this.tab === "alerts" ? "is-active" : ""}"
              data-social-tab="alerts"
              aria-label="${alertCount ? `Alerts, ${alertCount} new` : "Alerts"}"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
              </svg>
              ${alertCount ? `<span class="social-alert-badge">${alertCount}</span>` : ""}
            </button>
            <button class="social-close" data-social-action="close" aria-label="Close social portal">×</button>
          </div>
        </header>
        <main class="social-body">${this.renderBody()}</main>
        ${this.renderModal()}
      </div>
    `;
    if (!this.loading) this.hydrateVisibleMedia();
  }

  private renderBody(): string {
    if (this.loading) return `<div class="portal-loading"><span class="block-loader"></span><p>Opening your block…</p></div>`;
    if (this.tab === "feed") return this.renderFeed();
    if (this.tab === "map") return this.renderMap();
    if (this.setupError) {
      return `<div class="portal-empty"><span class="empty-glyph">!</span><h1>The social layer could not open.</h1><p>${escapeHtml(this.setupError)}</p><p>Town Square still works. Check the Supabase configuration or migration, then try again.</p><button class="primary-action" data-social-action="retry-setup">Try again</button></div>`;
    }
    if (!this.account || this.account.isAnonymous) return this.renderGuestFeatureGate();
    if (!this.profileReady()) return this.renderConsentGate();
    if (this.tab === "friends") return this.renderFriends();
    if (this.tab === "home") return this.renderHome();
    return this.renderAlerts();
  }

  private renderModal(): string {
    if (this.modal === "post") return this.renderPostModal();
    if (this.modal === "planet-post") return this.renderPlanetPostModal();
    if (this.modal === "consent") {
      return `
        <div class="social-modal-backdrop account-modal-backdrop">
          <section class="account-modal-shell" role="dialog" aria-modal="true" aria-label="Complete Blockaroo account setup">
            <button class="account-modal-close" data-social-action="cancel-modal" aria-label="Close account setup">×</button>
            ${this.renderConsentGate()}
          </section>
        </div>
      `;
    }
    if (this.modal === "account") {
      return `
        <div class="social-modal-backdrop account-modal-backdrop">
          <section class="account-modal-shell" role="dialog" aria-modal="true" aria-label="Claim your Blockaroo block">
            <button class="account-modal-close" data-social-action="cancel-modal" aria-label="Close account options">×</button>
            ${this.renderAccountGate()}
          </section>
        </div>
      `;
    }
    return "";
  }

  private renderGuestFeatureGate(): string {
    if (this.tab === "friends") {
      return `
        <section class="neighborhood-guest">
          <div class="section-heading">
            <span class="eyebrow">YOUR PEOPLE LIVE HERE</span>
            <h1>Neighborhood</h1>
            <p>Search friends, recover your conversations, and visit their Block Homes after you sign in.</p>
          </div>
          <label class="neighborhood-search is-disabled">
            <span aria-hidden="true">⌕</span>
            <input disabled placeholder="Sign in to find friends" />
          </label>
          <div class="guest-street-preview" aria-hidden="true">
            <div><span></span><i></i><strong>Private chats</strong></div>
            <div><span></span><i></i><strong>Friend homes</strong></div>
            <div><span></span><i></i><strong>Join friends</strong></div>
          </div>
          <button class="primary-action" data-social-action="claim-account">Sign in or create account</button>
          <small>Messages are stored with your account and return when you sign back in.</small>
        </section>
      `;
    }
    const feature = this.tab === "home" ? "a permanent Block Home" : "alerts";
    return `
      <section class="guest-feature-gate">
        <div class="guest-gate-block" style="--guest-color:${escapeAttribute(this.localIdentity.color)}"><span>□</span></div>
        <span class="eyebrow">YOU ARE EXPLORING AS A GUEST</span>
        <h1>Try the Wall. Claim your block when you want ${feature}.</h1>
        <p>No account is required to explore the Block Planet prototype. Saving friends, posts, homes, and notifications needs a permanent block.</p>
        <div>
          <button class="primary-action" data-social-tab="feed">Back to BlockWall</button>
          <button class="secondary-action" data-social-action="claim-account">Claim my block</button>
        </div>
      </section>
    `;
  }

  private renderAccountGate(): string {
    return `
      <section class="account-gate">
        <div class="account-art">
          <div class="account-block" style="--account-color:${escapeAttribute(this.localIdentity.color)}"><span>+</span></div>
          <i></i><i></i><i></i>
        </div>
        <div class="account-copy">
          <span class="eyebrow">SAVE YOUR PEOPLE</span>
          <h1>Turn this guest block into your account.</h1>
          <p>Your Town Square block already works. An account unlocks friends, 24-hour Block Posts, private homes, Circle voice, and games.</p>
          <form class="account-form" data-social-form="account">
            <label>Email address<input name="email" type="email" autocomplete="email" required placeholder="you@example.com" /></label>
            <label class="terms-check"><input name="terms" type="checkbox" required /> I confirm I meet the minimum age in the Terms and accept the Terms and Community Safety Rules.</label>
            <div class="account-actions">
              <button class="primary-action" data-account-intent="claim">Keep this block</button>
              <button class="secondary-action" data-account-intent="existing">I already have an account</button>
            </div>
          </form>
          ${this.accountMessage ? `<p class="form-message">${escapeHtml(this.accountMessage)}</p>` : ""}
          <small>No password. We send a secure sign-in link.</small>
        </div>
      </section>
    `;
  }

  private renderConsentGate(): string {
    return `
      <section class="account-gate">
        <div class="account-art"><div class="account-block" style="--account-color:${escapeAttribute(this.localIdentity.color)}"><span>✓</span></div></div>
        <div class="account-copy">
          <span class="eyebrow">ONE LAST STEP</span>
          <h1>Accept the rules that protect the social layer.</h1>
          <p>Friends, media, homes, and private voice involve real people. They stay locked until you confirm the age requirement and safety rules.</p>
          <form class="account-form" data-social-form="consent">
            <label class="terms-check"><input name="terms" type="checkbox" required /> I confirm I meet the minimum age in the Terms and accept the Terms and Community Safety Rules.</label>
            <button class="primary-action">Agree and enter</button>
          </form>
        </div>
      </section>
    `;
  }

  private renderFeed(): string {
    const guestMode = !this.account || this.account.isAnonymous;
    if (!this.feed.length && (guestMode || !this.profileReady() || this.setupError)) this.prepareDemoPlanet(this.feedPage);
    const stacks = buildBlockPlanetStacks(this.feed, this.dismissedPlanetPostIds);
    const cells = BLOCK_PLANET_SLOTS.map((slot, index) => (
      this.renderPlanetStack(stacks[index] ?? [], index, slot.column, slot.row)
    )).join("");
    const remainingPosts = stacks.reduce((total, stack) => total + stack.length, 0);
    return `
      <section class="blockwall-layout ${this.feedIsDemo ? "is-demo" : ""}">
        ${this.setupError ? `<p class="planet-offline-note">Live posts are unavailable, so the guest prototype is running locally.</p>` : ""}
        <div
          class="block-planet-stage"
          data-block-planet-stage
          tabindex="0"
          role="region"
          aria-label="BlockWall with eight portrait post thumbnails around the add post tile."
        >
          <div class="block-planet-grid ${this.planetForming ? "is-forming" : ""}" data-block-planet-grid>
            ${cells}
            <button
              class="planet-core"
              style="grid-column:2;grid-row:2;--core-color:${escapeAttribute(this.localIdentity.color)}"
              data-social-action="new-post"
              aria-label="Create a Block Post"
            >
              <span aria-hidden="true">＋</span>
              <strong>ADD</strong>
              <small>POST</small>
            </button>
          </div>
        </div>
        <footer class="blockwall-controls">
          ${remainingPosts === 0 && !this.feedHasMore ? `<span class="wall-cleared-label">Wall cleared.</span>` : ""}
        </footer>
      </section>
    `;
  }

  private renderPlanetStack(
    stack: SocialPost[],
    slotIndex: number,
    column: number,
    row: number,
  ): string {
    const post = stack[0];
    if (!post) {
      return `
        <span
          class="planet-stack is-empty"
          style="grid-column:${column};grid-row:${row}"
          aria-hidden="true"
        ><i></i></span>
      `;
    }
    const viewed = this.viewedPlanetPostIds.has(post.id);
    const initial = post.author.displayName.slice(0, 1).toUpperCase() || "□";
    const profilePhotoUrl = safeProfilePhotoUrl(post.author.profilePhotoPath);
    const authorAvatar = `
      <span class="planet-author-avatar" aria-hidden="true">
        ${profilePhotoUrl
          ? `<img src="${escapeAttribute(profilePhotoUrl)}" alt="" />`
          : `<span>${escapeHtml(initial)}</span>`}
      </span>
    `;
    const preview = truncateText(post.body || (post.mediaPath ? "Shared a picture" : "Block Post"), 52);
    const stackDepth = Math.min(2, Math.max(0, stack.length - 1));
    const visual = demoPlanetVisual(post.id);
    const mediaKind = post.mediaType === "gif"
      ? "GIF"
      : post.mediaPath
        ? "PHOTO"
        : visual?.kind.toUpperCase();
    const media = post.mediaPath
      ? `
        <span class="planet-card-media ${post.mediaType === "gif" ? "is-motion" : ""}">
          <span class="media-placeholder">Loading…</span>
          <img data-post-media="${escapeAttribute(post.id)}" alt="" hidden />
          <span class="planet-media-label">${mediaKind}</span>
          ${post.mediaType === "gif" ? `<span class="planet-play-mark" aria-hidden="true">▶</span>` : ""}
        </span>
      `
      : visual
        ? `
          <span class="planet-card-media planet-demo-media demo-scene-${visual.scene}">
            <span class="planet-media-label">${mediaKind}</span>
            ${visual.kind === "video" ? `<span class="planet-play-mark" aria-hidden="true">▶</span>` : ""}
          </span>
        `
        : `<span class="planet-text-preview">${escapeHtml(preview)}</span>`;
    return `
      <div
        class="planet-stack depth-${stackDepth}"
        style="grid-column:${column};grid-row:${row};--post-color:${escapeAttribute(post.author.blockColor)};--planet-index:${slotIndex}"
        data-stack-slot="${slotIndex}"
      >
        <button
          class="planet-post ${viewed ? "is-viewed" : "is-unread"} ${mediaKind ? "has-media" : ""}"
          data-social-action="open-planet-post"
          data-post-id="${escapeAttribute(post.id)}"
          data-planet-post
          data-planet-index="${slotIndex}"
          aria-label="${escapeAttribute(`${post.author.displayName}: ${post.body || "Media post"}. Tap to open the post. Drag to replace this thumbnail.`)}"
        >
          ${media}
          <span class="planet-thumbnail-author">
            ${authorAvatar}
            <strong>${escapeHtml(post.author.displayName)}</strong>
          </span>
        </button>
        ${stack.length > 1 ? `<span class="planet-stack-count" aria-hidden="true">+${stack.length - 1}</span>` : ""}
      </div>
    `;
  }

  private renderPlanetPostModal(): string {
    const post = this.findPlanetPost(this.selectedPlanetPostId);
    if (!post) return "";
    const liked = this.likedPlanetPostIds.has(post.id);
    const comments = this.planetComments.get(post.id) ?? [];
    const demoVisual = demoPlanetVisual(post.id);
    const initial = post.author.displayName.slice(0, 1).toUpperCase() || "□";
    const profilePhotoUrl = safeProfilePhotoUrl(post.author.profilePhotoPath);
    const authorAvatar = `
      <span class="planet-viewer-avatar" aria-hidden="true">
        ${profilePhotoUrl
          ? `<img src="${escapeAttribute(profilePhotoUrl)}" alt="" />`
          : `<span>${escapeHtml(initial)}</span>`}
      </span>
    `;
    const media = post.mediaPath
      ? `<div class="planet-viewer-media ${post.mediaType === "gif" ? "is-motion" : ""}"><div class="media-placeholder">Loading picture…</div><img data-post-media="${escapeAttribute(post.id)}" alt="Post by ${escapeAttribute(post.author.displayName)}" hidden />${post.mediaType === "gif" ? `<span class="planet-detail-media-label">GIF</span>` : ""}</div>`
      : demoVisual
        ? `<div class="planet-viewer-media planet-detail-demo-media demo-scene-${demoVisual.scene}">${demoVisual.kind === "video" ? `<span class="planet-detail-play" aria-hidden="true">▶</span>` : ""}<span class="planet-detail-media-label">${demoVisual.kind.toUpperCase()} DEMO</span></div>`
        : `<div class="planet-viewer-media is-text-post"><p>${escapeHtml(post.body || "Block Post")}</p></div>`;
    const author = this.feedIsDemo
      ? `<div class="planet-viewer-author">${authorAvatar}<span><strong>${escapeHtml(post.author.displayName)}</strong><small>@${escapeHtml(post.author.handle ?? "neighbor")} · ${timeAgo(post.createdAt)}</small></span></div>`
      : `<button class="planet-viewer-author" data-social-action="view-home" data-user-id="${escapeAttribute(post.authorId)}">${authorAvatar}<span><strong>${escapeHtml(post.author.displayName)}</strong><small>${post.author.handle ? `@${escapeHtml(post.author.handle)} · ` : ""}${timeAgo(post.createdAt)}</small></span></button>`;
    const viewerPosts = this.planetViewerPosts();
    const viewerIndex = Math.max(0, viewerPosts.findIndex(candidate => candidate.id === post.id));
    const commentSheet = this.planetCommentsOpen
      ? `
        <button class="planet-comment-scrim" data-social-action="close-planet-comments" aria-label="Close comments"></button>
        <aside class="planet-comment-sheet" data-planet-comment-sheet aria-label="Comments">
          <header>
            <div><strong>Comments</strong><small>Stored on this device during the prototype.</small></div>
            <button data-social-action="close-planet-comments" aria-label="Close comments">×</button>
          </header>
          <div class="planet-comment-list" data-planet-comment-list aria-live="polite">
            ${comments.map(comment => `<p><strong>You</strong><span>${escapeHtml(comment)}</span></p>`).join("") || `<p class="planet-comments-empty">No comments yet. Start the conversation.</p>`}
          </div>
          <form class="planet-comment-form" data-social-form="planet-comment">
            <label for="planet-comment-input">Add a comment</label>
            <div><input id="planet-comment-input" name="comment" maxlength="180" required placeholder="Say something…" autocomplete="off" /><button type="submit">Post</button></div>
          </form>
        </aside>
      `
      : "";
    return `
      <div class="social-modal-backdrop planet-detail-backdrop">
        <section
          class="planet-detail ${this.planetCommentsOpen ? "has-comments-open" : ""}"
          role="dialog"
          aria-modal="true"
          aria-label="Block Post by ${escapeAttribute(post.author.displayName)}"
          style="--post-color:${escapeAttribute(post.author.blockColor)}"
          data-planet-viewer-card
          tabindex="0"
        >
          ${media}
          <span class="planet-viewer-shade" aria-hidden="true"></span>
          <span class="planet-viewer-counter">${viewerIndex + 1} / ${Math.max(1, viewerPosts.length)}</span>
          <button class="planet-detail-close" data-social-action="cancel-modal" aria-label="Close post">×</button>
          <div class="planet-viewer-copy">
            ${author}
            ${demoVisual || post.mediaPath
              ? (post.body ? `<p>${escapeHtml(post.body)}</p>` : "")
              : ""}
            ${post.locationLabel ? `<span class="planet-detail-location">⌖ ${escapeHtml(post.locationLabel)}</span>` : ""}
          </div>
          <aside class="planet-viewer-actions" aria-label="Post actions">
            <button class="${liked ? "is-liked" : ""}" data-social-action="planet-like" aria-pressed="${liked}" aria-label="${liked ? "Unlike post" : "Like post"}">
              <span aria-hidden="true">${liked ? "♥" : "♡"}</span>
              <small>${liked ? "1" : "0"}</small>
            </button>
            <button data-social-action="open-planet-comments" aria-expanded="${this.planetCommentsOpen}" aria-label="Open comments">
              <span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 4h16v12H9l-5 4V4Z" /></svg></span>
              <small data-planet-comment-count>${comments.length}</small>
            </button>
          </aside>
          <nav class="planet-viewer-nav" aria-label="Move between posts">
            <button data-social-action="previous-planet-post" aria-label="Previous post" ${viewerIndex === 0 ? "disabled" : ""}>↑</button>
            <button data-social-action="next-planet-post" aria-label="Next post" ${viewerIndex === viewerPosts.length - 1 && !this.feedHasMore ? "disabled" : ""}>↓</button>
          </nav>
          <span class="planet-viewer-swipe-hint" aria-hidden="true">SWIPE ↑↓</span>
          ${commentSheet}
        </section>
      </div>
    `;
  }

  private postCard(post: SocialPost): string {
    const isMine = post.authorId === this.account?.userId;
    const media = post.mediaPath
      ? `<div class="post-media ${post.mediaType === "gif" ? "is-gif" : ""}"><div class="media-placeholder">Loading picture…</div><img data-post-media="${post.id}" alt="Post by ${escapeAttribute(post.author.displayName)}" hidden /></div>`
      : "";
    return `
      <article class="block-post" data-post-id="${post.id}">
        <header>
          <button class="post-author" data-social-action="view-home" data-user-id="${escapeAttribute(post.authorId)}">
            <i style="--author-color:${escapeAttribute(post.author.blockColor)}"></i>
            <span><strong>${escapeHtml(post.author.displayName)}</strong><small>${post.author.handle ? `@${escapeHtml(post.author.handle)} · ` : ""}${timeAgo(post.createdAt)}</small></span>
          </button>
          <span class="post-expiry">${post.pinnedToHome ? "Pinned home copy" : `Expires ${timeUntil(post.expiresAt)}`}</span>
        </header>
        ${post.body ? `<p class="post-body">${escapeHtml(post.body)}</p>` : ""}
        ${media}
        <footer>
          ${post.locationLabel ? `<span class="location-pill">⌖ ${escapeHtml(post.locationLabel)}</span>` : "<span></span>"}
          <div>
            ${!isMine ? `<button data-social-action="connect" data-user-id="${escapeAttribute(post.authorId)}">Connect</button>` : ""}
            ${isMine ? `<button class="danger-text-button" data-social-action="delete-post" data-post-id="${post.id}">Delete</button>` : ""}
          </div>
        </footer>
      </article>
    `;
  }

  private renderFriends(): string {
    const pending = this.friends.filter(friend => friend.status !== "accepted");
    const threads = buildNeighborhoodThreads(
      this.friends,
      this.directMessages,
      this.account?.userId ?? "",
    );
    return `
      <section class="neighborhood-layout">
        <div class="section-heading neighborhood-heading">
          <span class="eyebrow">YOUR PRIVATE STREET</span>
          <h1>Neighborhood</h1>
          <p>Every property is one friendship. Open a house to chat, visit, or jump to where they are.</p>
        </div>
        <form class="neighborhood-search" data-social-form="neighbor-search">
          <span aria-hidden="true">⌕</span>
          <input name="query" value="${escapeAttribute(this.neighborSearchQuery)}" minlength="2" maxlength="40" autocomplete="off" placeholder="Search by name or @handle" aria-label="Search for friends" />
          <button>Search</button>
        </form>
        ${this.renderNeighborSearchResults()}
        ${pending.length ? `<div class="friend-section neighborhood-requests"><h2>Requests</h2>${pending.map(friend => this.friendCard(friend)).join("")}</div>` : ""}
        <div class="neighborhood-street">
          <div class="street-label"><span>MY STREET</span><small>${threads.length} ${threads.length === 1 ? "home" : "homes"}</small></div>
          ${threads.length
            ? threads.map((thread, index) => this.renderNeighborProperty(thread, index)).join("")
            : `<div class="portal-empty compact neighborhood-empty"><span class="empty-glyph">⌂</span><p>Your street is empty. Search for somebody you know or meet people in Town Square.</p></div>`}
        </div>
      </section>
    `;
  }

  private renderNeighborSearchResults(): string {
    if (!this.neighborSearchQuery) return "";
    if (!this.neighborSearchResults.length) {
      return `<div class="neighbor-search-results"><p>No people matched “${escapeHtml(this.neighborSearchQuery)}.”</p><button type="button" data-social-action="clear-neighbor-search">Clear</button></div>`;
    }
    return `
      <div class="neighbor-search-results">
        <header><strong>People</strong><button type="button" data-social-action="clear-neighbor-search">Clear</button></header>
        ${this.neighborSearchResults.map(profile => {
          const relationship = this.friends.find(friend => friend.userId === profile.userId);
          const action = relationship?.status === "accepted"
            ? `<button data-social-action="toggle-neighbor" data-user-id="${escapeAttribute(profile.userId)}">Open chat</button>`
            : relationship?.status === "pending-outgoing"
              ? `<span>Request sent</span>`
              : relationship?.status === "pending-incoming"
                ? `<button data-social-action="accept-friend" data-user-id="${escapeAttribute(profile.userId)}">Accept</button>`
                : `<button class="primary-small" data-social-action="add-neighbor" data-user-id="${escapeAttribute(profile.userId)}">Add neighbor</button>`;
          return `
            <article>
              <i style="--friend-color:${escapeAttribute(profile.blockColor)}"></i>
              <span><strong>${escapeHtml(profile.displayName)}</strong><small>${profile.handle ? `@${escapeHtml(profile.handle)}` : "Blockaroo neighbor"}</small></span>
              ${action}
            </article>
          `;
        }).join("")}
      </div>
    `;
  }

  private renderNeighborProperty(thread: NeighborhoodThread, index: number): string {
    const friend = thread.friend;
    const expanded = this.expandedNeighborId === friend.userId;
    const room = this.portalSnapshot?.rooms.find(candidate => candidate.friendUserIds.includes(friend.userId));
    const lastMessage = thread.lastMessage;
    const lastCopy = lastMessage?.body
      ?? (lastMessage?.ciphertext ? "Encrypted message" : "No messages yet—say hello.");
    const status = room?.label
      ?? (isRecentlyOnline(friend.profile.lastSeenAt) ? "Online recently" : "Offline");
    const houseBlocks = recentHouseBlocks(thread.messages, 10);
    const interiorLayout = this.neighborHomeInteriors.get(friend.userId)
      ?? defaultHomeInterior(friend.profile.blockColor);
    return `
      <article class="neighbor-property ${expanded ? "is-expanded" : ""} ${thread.unreadCount ? "has-unread" : ""}" data-neighbor-property="${escapeAttribute(friend.userId)}">
        <button class="neighbor-property-summary" data-social-action="toggle-neighbor" data-user-id="${escapeAttribute(friend.userId)}" aria-expanded="${expanded}">
          <span class="street-number">${String(index + 1).padStart(2, "0")}</span>
          <span class="neighbor-property-copy">
            <span class="neighbor-name-line"><i style="--friend-color:${escapeAttribute(friend.profile.blockColor)}"></i><strong>${escapeHtml(friend.profile.displayName)}</strong>${thread.unreadCount ? `<b>${thread.unreadCount}</b>` : ""}</span>
            <span class="neighbor-last-message">${escapeHtml(truncateText(lastCopy, 64))}</span>
            <small>${escapeHtml(status)}${lastMessage ? ` · ${timeAgo(lastMessage.createdAt)}` : ""}</small>
          </span>
          ${this.renderHouseShell(friend.profile, thread.unreadCount > 0, false)}
        </button>
        ${expanded ? `
          <div class="neighbor-property-open">
            <section class="neighbor-chat-panel" aria-label="Private chat with ${escapeAttribute(friend.profile.displayName)}">
              <header>
                <div><span>PRIVATE CHAT</span><strong>${escapeHtml(friend.profile.displayName)}</strong></div>
                <div>
                  ${room ? `<button data-social-action="travel-room" data-room-id="${escapeAttribute(room.id)}">Join in ${escapeHtml(room.label)}</button>` : ""}
                  <button data-social-action="knock-home" data-user-id="${escapeAttribute(friend.userId)}">Enter live home</button>
                </div>
              </header>
              <div class="neighbor-message-list" data-direct-message-list="${escapeAttribute(friend.userId)}" aria-live="polite">
                ${thread.messages.length
                  ? thread.messages.slice(-80).map(message => this.renderDirectMessage(message)).join("")
                  : `<p class="neighbor-chat-empty">This is the start of your street together.</p>`}
              </div>
              <form class="neighbor-message-form" data-social-form="direct-message" data-user-id="${escapeAttribute(friend.userId)}">
                <label for="direct-message-${escapeAttribute(friend.userId)}">Message ${escapeHtml(friend.profile.displayName)}</label>
                <div><input id="direct-message-${escapeAttribute(friend.userId)}" name="message" maxlength="2000" autocomplete="off" enterkeyhint="send" placeholder="Say something…" required /><button>Send</button></div>
              </form>
            </section>
            <aside class="neighbor-house-panel" style="--house-color:${escapeAttribute(friend.profile.blockColor)}">
              <span class="house-owner">${escapeHtml(friend.profile.displayName)}’s Block Home</span>
              ${this.renderHomeInterior(interiorLayout, {
                ownerId: friend.userId,
                avatarColor: this.profile?.blockColor ?? "#ff6b6b",
                avatarLabel: "You",
                messageBlocks: houseBlocks,
              })}
              <p>Only you and ${escapeHtml(friend.profile.displayName)} can see these message blocks.</p>
            </aside>
          </div>
        ` : ""}
      </article>
    `;
  }

  private renderHouseShell(profile: SocialProfile, unread: boolean, large: boolean): string {
    return `
      <span class="property-house ${large ? "is-large" : ""} ${unread ? "is-lit" : ""}" style="--house-color:${escapeAttribute(profile.blockColor)}" aria-hidden="true">
        <i class="house-roof"></i><i class="house-body"></i><i class="house-door"></i><i class="house-window"></i><i class="house-mailbox"></i>
      </span>
    `;
  }

  private renderHomeInterior(
    layoutValue: HomeInteriorLayout,
    options: {
      ownerId: string;
      avatarColor: string;
      avatarLabel: string;
      editable?: boolean;
      messageBlocks?: readonly DirectMessage[];
      standalone?: boolean;
    },
  ): string {
    const layout = normalizeHomeInterior(layoutValue, options.avatarColor);
    const avatar = this.cutawayAvatarPositions.get(options.ownerId) ?? { x: 50, y: 80 };
    const editable = Boolean(options.editable);
    const messageBlocks = options.messageBlocks ?? [];
    const furniture = [...layout.furniture]
      .sort((left, right) => left.y - right.y)
      .map(item => {
        const selected = editable && item.id === this.selectedHomeFurnitureId;
        const tag = editable ? "button" : "span";
        const action = editable ? ` data-social-action="select-home-furniture"` : "";
        return `
          <${tag}
            ${editable ? `type="button"` : ""}
            class="home-furniture furniture-${item.kind} ${selected ? "is-selected" : ""}"
            style="--furniture-x:${item.x};--furniture-y:${item.y};--furniture-rotation:${item.rotation}deg;--furniture-color:${escapeAttribute(item.color)}"
            data-home-furniture-id="${escapeAttribute(item.id)}"
            data-furniture-kind="${item.kind}"
            ${action}
            aria-label="${escapeAttribute(`${furnitureLabel(item.kind)}${editable ? ", drag to move" : ""}`)}"
          ><i aria-hidden="true"></i><small>${escapeHtml(furnitureLabel(item.kind))}</small></${tag}>
        `;
      })
      .join("");
    const shelf = messageBlocks.length
      ? `
        <div class="home-message-shelf" aria-label="Latest private message blocks">
          <span>PRIVATE SHELF</span>
          <div class="house-message-blocks" data-house-message-blocks="${escapeAttribute(options.ownerId)}">
            ${messageBlocks.map(message => `<i class="${message.senderId === this.account?.userId ? "is-mine" : "is-theirs"}" title="${escapeAttribute(message.body ?? "Encrypted message")}"></i>`).join("")}
          </div>
        </div>
      `
      : "";
    return `
      <div
        class="home-cutaway-block lighting-${layout.lighting} ${options.standalone ? "is-standalone" : ""} ${editable ? "is-editable" : ""}"
        style="--home-wall-color:${escapeAttribute(layout.wallColor)};--home-floor-color:${escapeAttribute(layout.floorColor)}"
        data-home-interior
        data-home-owner-id="${escapeAttribute(options.ownerId)}"
        data-home-editable="${editable}"
      >
        <div class="home-cutaway-top"><span>BLOCK HOME · INTERIOR</span><small>${editable ? "Drag furniture · tap floor to move" : "Tap the floor to move"}</small></div>
        <div class="home-cutaway-frame">
          <div class="home-cutaway-room" data-home-move-surface>
            <span class="home-cutaway-window" aria-hidden="true"><i></i></span>
            <span class="home-cutaway-door" aria-hidden="true"></span>
            ${furniture}
            ${shelf}
            <span
              class="home-cutaway-avatar"
              style="--avatar-x:${avatar.x};--avatar-y:${avatar.y};--avatar-color:${escapeAttribute(options.avatarColor)}"
              data-home-avatar="${escapeAttribute(options.ownerId)}"
            ><i></i><small>${escapeHtml(options.avatarLabel)}</small></span>
          </div>
        </div>
        <div class="home-cutaway-controls">
          <span>Move inside</span>
          <div>
            <button type="button" data-social-action="move-cutaway" data-owner-id="${escapeAttribute(options.ownerId)}" data-direction="left" aria-label="Move left">←</button>
            <button type="button" data-social-action="move-cutaway" data-owner-id="${escapeAttribute(options.ownerId)}" data-direction="up" aria-label="Move up">↑</button>
            <button type="button" data-social-action="move-cutaway" data-owner-id="${escapeAttribute(options.ownerId)}" data-direction="down" aria-label="Move down">↓</button>
            <button type="button" data-social-action="move-cutaway" data-owner-id="${escapeAttribute(options.ownerId)}" data-direction="right" aria-label="Move right">→</button>
          </div>
        </div>
      </div>
    `;
  }

  private renderDirectMessage(message: DirectMessage): string {
    const mine = message.senderId === this.account?.userId;
    const copy = message.body ?? (message.ciphertext ? "Encrypted message" : "Message unavailable");
    return `
      <p class="neighbor-message ${mine ? "is-mine" : "is-theirs"}" data-message-id="${escapeAttribute(message.id)}">
        <span>${escapeHtml(copy)}</span><small>${formatMessageTime(message.createdAt)}${mine && message.readAt ? " · Read" : ""}</small>
      </p>
    `;
  }

  private friendCard(friend: FriendConnection): string {
    const actions = friend.status === "pending-incoming"
      ? `<button class="primary-small" data-social-action="accept-friend" data-user-id="${friend.userId}">Accept</button><button data-social-action="decline-friend" data-user-id="${friend.userId}">Decline</button>`
      : friend.status === "pending-outgoing"
        ? `<span class="muted-label">Request sent</span><button data-social-action="cancel-friend" data-user-id="${friend.userId}">Cancel</button>`
        : `<button class="primary-small" data-social-action="connect" data-user-id="${friend.userId}">Connect</button><button data-social-action="knock-home" data-user-id="${friend.userId}">Visit / knock</button><button data-social-action="invite-home" data-user-id="${friend.userId}">Invite home</button><button class="danger-text-button" data-social-action="unfriend" data-user-id="${friend.userId}">Unfriend</button>`;
    return `
      <article class="friend-card">
        <button class="friend-identity" data-social-action="view-home" data-user-id="${friend.userId}">
          <i style="--friend-color:${escapeAttribute(friend.profile.blockColor)}"></i>
          <span><strong>${escapeHtml(friend.profile.displayName)}</strong><small>${friend.profile.handle ? `@${escapeHtml(friend.profile.handle)}` : escapeHtml(friend.profile.bio || "Blockaroo friend")}</small></span>
        </button>
        <div class="friend-actions">${actions}</div>
      </article>
    `;
  }

  private renderMap(): string {
    const snapshot = this.portalSnapshot ?? {
      cityId: "nashville",
      cityName: "Nashville",
      updatedAt: new Date().toISOString(),
      live: false,
      rooms: PUBLIC_PORTAL_ROOMS.map(room => ({ ...room, onlineCount: null, friendUserIds: [] })),
    } satisfies PortalSnapshot;
    const current = this.actions.currentLocation();
    return `
      <section class="portal-map-layout">
        <div class="portal-map-heading">
          <div><span class="eyebrow">FAST TRAVEL</span><h1>Portal</h1><p>Pick a live room in your selected city. Locations are public rooms—not anyone’s precise GPS.</p></div>
          <button data-social-action="portal-city-info" class="portal-city-picker"><span>Nashville</span><small>More cities later</small><b>⌄</b></button>
        </div>
        <div class="portal-overworld" aria-label="Illustrated Nashville Portal map">
          <span class="portal-road road-a"></span><span class="portal-road road-b"></span><span class="portal-road road-c"></span>
          <span class="portal-river"></span>
          <span class="portal-map-title">NASHVILLE</span>
          ${snapshot.rooms.map(room => {
            const friendsHere = this.friends.filter(friend => room.friendUserIds.includes(friend.userId));
            const here = current.cityId === room.cityId && current.spaceId === room.id;
            return `
              <button
                class="portal-room-pin ${here ? "is-current" : ""} ${room.event ? "is-event" : ""}"
                style="left:${room.mapX}%;top:${room.mapY}%;--room-color:${escapeAttribute(room.color)}"
                data-social-action="travel-room"
                data-room-id="${escapeAttribute(room.id)}"
                aria-label="${escapeAttribute(`${room.label}, ${room.onlineCount ?? "live count unavailable"} online`)}"
              >
                <i><span></span></i>
                <strong>${escapeHtml(room.label)}</strong>
                <small>${here ? "YOU ARE HERE" : `${room.onlineCount ?? "—"} LIVE`}</small>
                ${friendsHere.length ? `<b>${friendsHere.length} ${friendsHere.length === 1 ? "friend" : "friends"}</b>` : ""}
              </button>
            `;
          }).join("")}
        </div>
        <div class="portal-room-dock">
          ${snapshot.rooms.map(room => {
            const friendsHere = this.friends.filter(friend => room.friendUserIds.includes(friend.userId));
            const here = current.cityId === room.cityId && current.spaceId === room.id;
            return `
              <article style="--room-color:${escapeAttribute(room.color)}">
                <span class="portal-room-icon">${room.event ? "✦" : "□"}</span>
                <div><strong>${escapeHtml(room.label)}</strong><p>${escapeHtml(room.tagline)}</p><small>${room.onlineCount ?? "—"} live${friendsHere.length ? ` · ${friendsHere.map(friend => escapeHtml(friend.profile.displayName)).join(", ")}` : ""}</small></div>
                <button data-social-action="travel-room" data-room-id="${escapeAttribute(room.id)}" ${here ? "disabled" : ""}>${here ? "Here" : friendsHere.length ? "Join friends" : "Enter"}</button>
              </article>
            `;
          }).join("")}
        </div>
        ${!snapshot.live ? `<p class="portal-live-note">Live counts are reconnecting. Room travel still works.</p>` : ""}
      </section>
    `;
  }

  private renderHome(): string {
    if (!this.home) return `<div class="portal-empty"><h2>This Block Home is unavailable.</h2></div>`;
    const ownHome = this.home.ownerId === this.account?.userId;
    const interiorLayout = ownHome
      ? this.homeDraft ?? this.home.interiorLayout
      : this.home.interiorLayout;
    const gallery = this.home.pinnedPosts.length
      ? this.home.pinnedPosts.map(post => `
          <article class="home-memory">
            ${post.mediaPath ? `<img data-post-media="${post.id}" alt="Pinned Block Home memory" hidden /><div class="media-placeholder">Loading memory…</div>` : ""}
            ${post.body ? `<p>${escapeHtml(post.body)}</p>` : ""}
          </article>
        `).join("")
      : `<div class="home-empty-room"><span>+</span><p>${ownHome ? "Pin a Block Post to put something on your wall." : "This wall is still empty."}</p></div>`;
    const interests = this.home.profile.interests.map(interest => `<span>${escapeHtml(interest)}</span>`).join("");
    return `
      <section class="block-home" style="--home-color:${escapeAttribute(this.home.profile.blockColor)}">
        <header class="home-hero">
          <div class="home-avatar"><span>${escapeHtml(this.home.profile.displayName.slice(0, 1).toUpperCase())}</span></div>
          <div><span class="eyebrow">${ownHome ? "YOUR BLOCK HOME" : "FRIEND'S BLOCK HOME"}</span><h1>${escapeHtml(this.home.name)}</h1><p>${escapeHtml(this.home.welcomeNote || this.home.profile.bio || "Come in. Look around.")}</p><div class="interest-row">${interests}</div></div>
          ${!ownHome ? `<button class="primary-action" data-social-action="connect" data-user-id="${escapeAttribute(this.home.ownerId)}">Connect</button>` : ""}
        </header>
        ${!ownHome && this.home.connectedAt ? `<div class="shared-history"><span>HOW YOU MET</span><strong>Nashville Town Square</strong><small>Connected ${formatDate(this.home.connectedAt)}</small></div>` : ""}
        <div class="home-interior-stage">
          <div class="home-interior-heading">
            <div><span class="eyebrow">${ownHome ? "YOUR PLAYABLE ROOM" : "SHARED ROOM PREVIEW"}</span><h2>${ownHome ? "Build the inside of your block." : `Inside ${escapeHtml(this.home.profile.displayName)}’s block.`}</h2></div>
            <p>${ownHome ? "Move furniture now, save it, then enter the live room." : "Tap the floor to walk around here, or enter live when the door is open."}</p>
          </div>
          ${this.renderHomeInterior(interiorLayout, {
            ownerId: this.home.ownerId,
            avatarColor: this.profile?.blockColor ?? this.home.profile.blockColor,
            avatarLabel: "You",
            editable: ownHome,
            standalone: true,
          })}
        </div>
        ${ownHome ? this.renderHomeEditor() : `
          <div class="home-actions"><button data-social-action="knock-home" data-user-id="${escapeAttribute(this.home.ownerId)}">Enter shared live home</button><button data-social-action="invite-home" data-user-id="${escapeAttribute(this.home.ownerId)}">Invite them to my home</button></div>
        `}
        ${ownHome ? `<div class="home-actions live-home-actions"><button class="primary-action" data-social-action="enter-own-home">Save & enter my live Block Home</button></div>` : ""}
        <div class="home-memory-heading"><span class="eyebrow">WALL MEMORIES</span><h2>Pinned Block Posts</h2></div>
        <div class="home-wall">${gallery}</div>
      </section>
    `;
  }

  private renderHomeEditor(): string {
    if (!this.home || !this.profile) return "";
    const draft = this.homeDraft ?? cloneHomeInterior(this.home.interiorLayout);
    const selected = draft.furniture.find(item => item.id === this.selectedHomeFurnitureId) ?? null;
    return `
      <details class="home-editor" open>
        <summary>Decorate and edit my Block Home</summary>
        <form data-social-form="home">
          <section class="home-decorator">
            <div class="home-decorator-heading">
              <div><span class="eyebrow">INTERIOR EDITOR</span><h3>Furniture, color, and light</h3></div>
              <p>Drag an item in the room. Select it to rotate, recolor, or remove it.</p>
            </div>
            <div class="home-room-settings">
              <label>Wall color<input type="color" value="${escapeAttribute(draft.wallColor)}" data-home-setting="wallColor" /></label>
              <label>Floor color<input type="color" value="${escapeAttribute(draft.floorColor)}" data-home-setting="floorColor" /></label>
              <label>Lighting<select data-home-setting="lighting">${homeLightingOptions(draft.lighting)}</select></label>
            </div>
            <div class="home-furniture-catalog" aria-label="Add furniture">
              ${HOME_FURNITURE_CATALOG.map(item => `<button type="button" data-social-action="add-home-furniture" data-furniture-kind="${item.kind}"><i style="--catalog-color:${escapeAttribute(item.color)}"></i><span>Add ${escapeHtml(item.label)}</span></button>`).join("")}
            </div>
            <div class="home-selected-furniture ${selected ? "" : "is-empty"}">
              ${selected ? `
                <div><span>SELECTED</span><strong>${escapeHtml(furnitureLabel(selected.kind))}</strong></div>
                <label>Color<input type="color" value="${escapeAttribute(selected.color)}" data-home-setting="furnitureColor" /></label>
                <button type="button" data-social-action="rotate-home-furniture">Rotate 45°</button>
                <button type="button" class="danger-text-button" data-social-action="remove-home-furniture">Remove</button>
              ` : `<p>Select a piece of furniture in the room to edit it.</p>`}
              <button type="button" data-social-action="reset-home-interior">Reset room</button>
            </div>
          </section>
          <div class="home-profile-editor-heading"><span class="eyebrow">HOME DETAILS</span><h3>Name, profile, and door</h3></div>
          <div class="form-grid">
            <label>Display name<input name="displayName" maxlength="18" required value="${escapeAttribute(this.profile.displayName)}" /></label>
            <label>Handle<input name="handle" maxlength="20" placeholder="your_handle" value="${escapeAttribute(this.profile.handle ?? "")}" /></label>
            <label class="span-two">Bio<textarea name="bio" maxlength="240">${escapeHtml(this.profile.bio)}</textarea></label>
            <label class="span-two">Interests<input name="interests" maxlength="180" value="${escapeAttribute(this.profile.interests.join(", "))}" placeholder="film, animation, live music" /></label>
            <label>Home name<input name="homeName" maxlength="40" value="${escapeAttribute(this.home.name)}" /></label>
            <label>Door setting<select name="accessMode">
              ${homeAccessOptions(this.home.accessMode)}
            </select></label>
            <label class="span-two">Welcome note<input name="welcomeNote" maxlength="180" value="${escapeAttribute(this.home.welcomeNote)}" /></label>
          </div>
          <button class="primary-action">Save Block Home</button>
        </form>
      </details>
    `;
  }

  private renderAlerts(): string {
    const incoming = this.friends.filter(friend => friend.status === "pending-incoming");
    const unreadThreads = buildNeighborhoodThreads(
      this.friends,
      this.directMessages,
      this.account?.userId ?? "",
    ).filter(thread => thread.unreadCount > 0);
    return `
      <section class="alerts-layout">
        <div class="section-heading"><span class="eyebrow">INVITATIONS</span><h1>Things that need your answer.</h1></div>
        <div class="alerts-list">
          ${incoming.map(friend => `
            <article class="alert-card"><i style="--friend-color:${escapeAttribute(friend.profile.blockColor)}"></i><div><strong>${escapeHtml(friend.profile.displayName)}</strong><p>sent you a friend request.</p></div><button class="primary-small" data-social-action="accept-friend" data-user-id="${friend.userId}">Accept</button><button data-social-action="decline-friend" data-user-id="${friend.userId}">Decline</button></article>
          `).join("")}
          ${this.invitations.map(invitation => invitation.kind === "knock" ? `
            <article class="alert-card"><i style="--friend-color:${escapeAttribute(invitation.sender.blockColor)}"></i><div><strong>${escapeHtml(invitation.sender.displayName)}</strong><p>is knocking on your Block Home.</p></div><button class="primary-small" data-social-action="accept-knock" data-invitation-id="${invitation.id}">Let in</button><button data-social-action="decline-home" data-invitation-id="${invitation.id}">Decline</button></article>
          ` : `
            <article class="alert-card"><i style="--friend-color:${escapeAttribute(invitation.sender.blockColor)}"></i><div><strong>${escapeHtml(invitation.sender.displayName)}</strong><p>invited you to their Block Home.</p></div><button class="primary-small" data-social-action="accept-home" data-invitation-id="${invitation.id}" data-user-id="${invitation.hostId}">Visit</button><button data-social-action="decline-home" data-invitation-id="${invitation.id}">Decline</button></article>
          `).join("")}
          ${unreadThreads.map(thread => `
            <article class="alert-card"><i style="--friend-color:${escapeAttribute(thread.friend.profile.blockColor)}"></i><div><strong>${escapeHtml(thread.friend.profile.displayName)}</strong><p>${thread.unreadCount} unread ${thread.unreadCount === 1 ? "message" : "messages"} in your Neighborhood.</p></div><button class="primary-small" data-social-action="open-neighbor-alert" data-user-id="${escapeAttribute(thread.friend.userId)}">Open</button></article>
          `).join("")}
          ${!incoming.length && !this.invitations.length && !unreadThreads.length ? `<div class="portal-empty compact"><span class="empty-glyph">✓</span><h2>You’re caught up.</h2><p>Circle invitations appear immediately while you’re in a public room.</p></div>` : ""}
        </div>
        ${this.blockedProfiles.length ? `<div class="friend-section blocked-section"><h2>Blocked</h2>${this.blockedProfiles.map(profile => `<article class="friend-card"><div class="friend-identity"><i style="--friend-color:${escapeAttribute(profile.blockColor)}"></i><span><strong>${escapeHtml(profile.displayName)}</strong><small>${profile.handle ? `@${escapeHtml(profile.handle)}` : "Hidden from your block"}</small></span></div><button data-social-action="unblock" data-user-id="${profile.userId}">Unblock</button></article>`).join("")}</div>` : ""}
        <div class="account-exit-actions">
          <button class="sign-out-button" data-social-action="sign-out">Sign out and return to a guest block</button>
          <button class="danger-text-button" data-social-action="delete-account">Delete account</button>
        </div>
      </section>
    `;
  }

  private renderPostModal(): string {
    return `
      <div class="social-modal-backdrop">
        <section class="post-composer-modal" role="dialog" aria-modal="true" aria-label="Create Block Post">
          <header><div><span class="eyebrow">BLOCK POST</span><h2>What are you up to?</h2></div><button data-social-action="cancel-modal" aria-label="Close">×</button></header>
          <form data-social-form="post">
            <textarea name="body" maxlength="500" placeholder="Say something to your friends…"></textarea>
            <label class="media-drop"><span>＋</span><strong>Add a photo or GIF</strong><small>Photos are compressed. Animated GIFs: 1 MB max.</small><input name="media" type="file" accept="image/jpeg,image/png,image/webp,image/gif" /></label>
            <div class="post-options">
              <label>Tag a Portal room<select name="location">${MAP_LOCATIONS.map(location => `<option value="${escapeAttribute(location)}">${location || "Wall only"}</option>`).join("")}</select></label>
              <label class="check-option"><input name="pinned" type="checkbox" /> Pin a copy inside my Block Home</label>
            </div>
            <div class="modal-actions"><button type="button" data-social-action="cancel-modal">Cancel</button><button class="primary-action">Post for 24 hours</button></div>
          </form>
        </section>
      </div>
    `;
  }

  private async handleClick(event: Event): Promise<void> {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-social-action], [data-social-tab]");
    if (!target) return;
    if (target.dataset.socialTab && isPortalTab(target.dataset.socialTab)) {
      this.modal = null;
      this.selectedPlanetPostId = null;
      this.planetCommentsOpen = false;
      this.tab = target.dataset.socialTab;
      if (this.tab === "home") this.viewedHomeId = this.account?.userId ?? null;
      await this.loadCurrentTab();
      return;
    }
    const action = target.dataset.socialAction;
    if (action === "close") return this.close();
    if (action === "retry-setup") { void this.initialize(); return; }
    if (action === "claim-account") {
      this.modal = "account";
      this.render();
      return;
    }
    if (action === "new-post") {
      this.modal = !this.account || this.account.isAnonymous
        ? "account"
        : !this.profileReady()
          ? "consent"
          : "post";
      this.render();
      return;
    }
    if (action === "clear-neighbor-search") {
      this.neighborSearchQuery = "";
      this.neighborSearchResults = [];
      this.render();
      return;
    }
    if (action === "move-cutaway" && target.dataset.ownerId && isCutawayDirection(target.dataset.direction)) {
      this.moveCutawayAvatar(target.dataset.ownerId, target.dataset.direction);
      return;
    }
    if (
      action === "add-home-furniture"
      && target.dataset.furnitureKind
      && isHomeFurnitureKind(target.dataset.furnitureKind)
      && this.homeDraft
      && this.homeDraft.furniture.length < 24
    ) {
      const item = createHomeFurniture(target.dataset.furnitureKind, this.homeDraft.furniture.length + 1);
      this.homeDraft.furniture.push(item);
      this.selectedHomeFurnitureId = item.id;
      this.renderPreservingBodyScroll();
      return;
    }
    if (action === "select-home-furniture" && target.dataset.homeFurnitureId && this.homeDraft) {
      this.selectedHomeFurnitureId = target.dataset.homeFurnitureId;
      this.renderPreservingBodyScroll();
      return;
    }
    if (action === "rotate-home-furniture" && this.homeDraft && this.selectedHomeFurnitureId) {
      this.homeDraft.furniture = this.homeDraft.furniture.map(item => (
        item.id === this.selectedHomeFurnitureId
          ? { ...item, rotation: (item.rotation + 45) % 360 }
          : item
      ));
      this.renderPreservingBodyScroll();
      return;
    }
    if (action === "remove-home-furniture" && this.homeDraft && this.selectedHomeFurnitureId) {
      this.homeDraft.furniture = this.homeDraft.furniture
        .filter(item => item.id !== this.selectedHomeFurnitureId);
      this.selectedHomeFurnitureId = this.homeDraft.furniture[0]?.id ?? null;
      this.renderPreservingBodyScroll();
      return;
    }
    if (action === "reset-home-interior" && this.profile) {
      if (!window.confirm("Reset the room to Blockaroo's furnished default?")) return;
      this.homeDraft = defaultHomeInterior(this.profile.blockColor);
      this.selectedHomeFurnitureId = this.homeDraft.furniture[0]?.id ?? null;
      this.renderPreservingBodyScroll();
      return;
    }
    if (action === "open-neighbor-alert" && target.dataset.userId) {
      this.expandedNeighborId = target.dataset.userId;
      this.tab = "friends";
      await this.loadCurrentTab();
      void this.markThreadRead(target.dataset.userId);
      return;
    }
    if (action === "toggle-neighbor" && target.dataset.userId) {
      const userId = target.dataset.userId;
      const body = this.root.querySelector<HTMLElement>(".social-body");
      const previousScroll = body?.scrollTop ?? 0;
      this.expandedNeighborId = this.expandedNeighborId === userId ? null : userId;
      this.render();
      requestAnimationFrame(() => {
        const nextBody = this.root.querySelector<HTMLElement>(".social-body");
        if (nextBody) nextBody.scrollTop = previousScroll;
        const list = this.root.querySelector<HTMLElement>(`[data-direct-message-list="${CSS.escape(userId)}"]`);
        if (list) list.scrollTop = list.scrollHeight;
      });
      if (this.expandedNeighborId === userId) void this.markThreadRead(userId);
      return;
    }
    if (action === "add-neighbor" && target.dataset.userId) {
      const added = await this.runAction(
        async () => { await this.service.sendFriendRequest(target.dataset.userId!); },
        "Neighbor request sent.",
      );
      if (added) await this.loadCurrentTab();
      return;
    }
    if (action === "travel-room" && target.dataset.roomId && isPortalRoomId(target.dataset.roomId)) {
      const room = portalRoom(target.dataset.roomId);
      if (!room) return;
      this.root.classList.add("is-fast-traveling");
      await wait(180);
      await this.actions.onTravel({
        cityId: room.cityId,
        spaceId: room.id,
        kind: room.kind,
      });
      this.root.classList.remove("is-fast-traveling");
      return;
    }
    if (action === "portal-city-info") {
      this.actions.onNotice("Nashville is the first Portal city. City switching comes after these rooms have real activity.");
      return;
    }
    if (action === "planet-now") {
      await this.returnPlanetToNow();
      return;
    }
    if (action === "open-planet-post" && target.dataset.postId) {
      if (performance.now() < this.suppressPlanetClickUntil) return;
      this.selectedPlanetPostId = target.dataset.postId;
      this.viewedPlanetPostIds.add(target.dataset.postId);
      this.planetCommentsOpen = false;
      this.modal = "planet-post";
      this.render();
      return;
    }
    if (action === "previous-planet-post") {
      void this.advancePlanetViewer(-1);
      return;
    }
    if (action === "next-planet-post") {
      void this.advancePlanetViewer(1);
      return;
    }
    if (action === "open-planet-comments" && this.selectedPlanetPostId) {
      this.planetCommentsOpen = true;
      this.render();
      requestAnimationFrame(() => this.root.querySelector<HTMLInputElement>("#planet-comment-input")?.focus());
      return;
    }
    if (action === "close-planet-comments") {
      this.planetCommentsOpen = false;
      this.render();
      return;
    }
    if (action === "dismiss-planet-post" && this.selectedPlanetPostId) {
      const postId = this.selectedPlanetPostId;
      this.modal = null;
      this.selectedPlanetPostId = null;
      this.planetCommentsOpen = false;
      this.render();
      await this.dismissPlanetPost(postId, 160, -50);
      return;
    }
    if (action === "planet-like" && this.selectedPlanetPostId) {
      if (this.likedPlanetPostIds.has(this.selectedPlanetPostId)) {
        this.likedPlanetPostIds.delete(this.selectedPlanetPostId);
      } else {
        this.likedPlanetPostIds.add(this.selectedPlanetPostId);
      }
      this.render();
      return;
    }
    if (action === "cancel-modal") {
      this.modal = null;
      this.selectedPlanetPostId = null;
      this.planetCommentsOpen = false;
      this.render();
      return;
    }
    if (action === "connect" && target.dataset.userId) {
      this.actions.onConnectToFriend(target.dataset.userId);
      return;
    }
    if (action === "view-home" && target.dataset.userId) {
      const userId = target.dataset.userId;
      this.viewedHomeId = userId;
      this.modal = null;
      this.selectedPlanetPostId = null;
      this.planetCommentsOpen = false;
      this.tab = "home";
      await this.loadCurrentTab();
      return;
    }
    if (action === "knock-home" && target.dataset.userId) {
      const userId = target.dataset.userId;
      const access = await this.runHomeAccess(userId);
      if (access === "open") {
        await this.travelToHome(userId);
      }
      return;
    }
    if (action === "enter-own-home" && this.account && !this.account.isAnonymous) {
      if (this.home && this.homeDraft) {
        const saved = await this.runAction(async () => {
          await this.service.updateHome({
            name: this.home!.name,
            accessMode: this.home!.accessMode,
            welcomeNote: this.home!.welcomeNote,
            interiorLayout: this.homeDraft!,
          });
          this.home = {
            ...this.home!,
            interiorLayout: cloneHomeInterior(this.homeDraft!),
          };
        }, "Block Home saved.");
        if (!saved) return;
      }
      await this.travelToHome(this.account.userId);
      return;
    }
    if (action === "accept-friend" && target.dataset.userId) {
      await this.runAction(() => this.service.respondFriendRequest(target.dataset.userId!, true), "Friend request accepted.");
      return this.loadCurrentTab();
    }
    if (action === "decline-friend" && target.dataset.userId) {
      await this.runAction(() => this.service.respondFriendRequest(target.dataset.userId!, false), "Friend request declined.");
      return this.loadCurrentTab();
    }
    if (action === "cancel-friend" && target.dataset.userId) {
      await this.runAction(() => this.service.cancelFriendRequest(target.dataset.userId!), "Friend request canceled.");
      return this.loadCurrentTab();
    }
    if (action === "unfriend" && target.dataset.userId) {
      if (!window.confirm("Remove this person from your friends?")) return;
      await this.runAction(() => this.service.removeFriend(target.dataset.userId!), "Friend removed.");
      return this.loadCurrentTab();
    }
    if (action === "unblock" && target.dataset.userId) {
      await this.runAction(async () => {
        await this.service.unblockUser(target.dataset.userId!);
        this.actions.onBlockedUsersChange(await this.service.loadBlockedUserIds());
        this.actions.onAccountReady();
      }, "Player unblocked.");
      return this.loadCurrentTab();
    }
    if (action === "invite-home" && target.dataset.userId) {
      await this.runAction(() => this.service.inviteToHome(target.dataset.userId!), "Block Home invitation sent.");
      return;
    }
    if (action === "accept-home" && target.dataset.invitationId && target.dataset.userId) {
      const accepted = await this.runAction(
        () => this.service.respondHomeInvitation(target.dataset.invitationId!, true),
        "Home invitation accepted.",
      );
      if (!accepted) return;
      await this.travelToHome(target.dataset.userId);
      return;
    }
    if (action === "accept-knock" && target.dataset.invitationId) {
      await this.runAction(
        () => this.service.respondHomeInvitation(target.dataset.invitationId!, true),
        "Your friend can enter your Block Home for the next 24 hours.",
      );
      return this.loadCurrentTab();
    }
    if (action === "decline-home" && target.dataset.invitationId) {
      await this.runAction(() => this.service.respondHomeInvitation(target.dataset.invitationId!, false), "Home invitation declined.");
      return this.loadCurrentTab();
    }
    if (action === "delete-post" && target.dataset.postId) {
      const post = [...this.feed, ...this.mapPosts, ...(this.home?.pinnedPosts ?? [])]
        .find(candidate => candidate.id === target.dataset.postId);
      if (post) {
        const removed = await this.runAction(() => this.service.deletePost(post), "Block Post removed.");
        if (removed) {
          const mediaUrl = this.mediaUrls.get(post.id);
          if (mediaUrl) URL.revokeObjectURL(mediaUrl);
          this.mediaUrls.delete(post.id);
        }
      }
      return this.loadCurrentTab();
    }
    if (action === "map-post" && target.dataset.postId) {
      const post = this.mapPosts.find(candidate => candidate.id === target.dataset.postId);
      if (post) this.actions.onNotice(`${post.author.displayName}: ${post.body || `Posted from ${post.locationLabel}`}`);
      return;
    }
    if (action === "sign-out") {
      await this.runAction(() => this.service.signOutToGuest(), "Signed out.");
      return;
    }
    if (action === "delete-account") {
      const confirmation = window.prompt("Permanently delete this account, its posts, home, friendships, and media? Type DELETE to confirm.");
      if (confirmation !== "DELETE") return;
      await this.runAction(() => this.service.deleteAccount(), "Account permanently deleted.");
    }
  }

  private async handleSubmit(event: SubmitEvent): Promise<void> {
    const form = event.target as HTMLFormElement;
    const formName = form.dataset.socialForm;
    if (!formName) return;
    event.preventDefault();
    const data = new FormData(form);
    const submitter = event.submitter as HTMLElement | null;
    if (formName === "planet-comment" && this.selectedPlanetPostId) {
      const input = form.elements.namedItem("comment") as HTMLInputElement | null;
      const comment = String(data.get("comment") ?? "").trim().replace(/\s+/g, " ").slice(0, 180);
      if (!comment) return;
      const comments = this.planetComments.get(this.selectedPlanetPostId) ?? [];
      const nextComments = [...comments, comment];
      this.planetComments.set(this.selectedPlanetPostId, nextComments);
      this.appendPlanetComment(comment, nextComments.length);
      if (input) {
        input.value = "";
        input.focus({ preventScroll: true });
      }
      return;
    }
    if (formName === "neighbor-search") {
      const query = String(data.get("query") ?? "").trim().replace(/^@/, "").slice(0, 40);
      try {
        this.neighborSearchResults = await this.service.searchPeople(query);
        this.neighborSearchQuery = query;
      } catch (error) {
        this.actions.onNotice(errorMessage(error));
        return;
      }
      this.render();
      requestAnimationFrame(() => {
        const input = this.root.querySelector<HTMLInputElement>('[data-social-form="neighbor-search"] input');
        if (input) {
          input.focus({ preventScroll: true });
          input.setSelectionRange(input.value.length, input.value.length);
        }
      });
      return;
    }
    if (formName === "direct-message" && form.dataset.userId) {
      const recipientId = form.dataset.userId;
      const input = form.elements.namedItem("message") as HTMLInputElement | null;
      const button = form.querySelector<HTMLButtonElement>("button");
      const value = String(data.get("message") ?? "");
      if (!input || !value.trim()) return;
      if (button) button.disabled = true;
      try {
        const message = await this.service.sendDirectMessage(recipientId, value);
        if (!this.directMessages.some(candidate => candidate.id === message.id)) {
          this.directMessages.push(message);
        }
        this.appendDirectMessage(recipientId, message);
        input.value = "";
        input.focus({ preventScroll: true });
      } catch (error) {
        this.actions.onNotice(errorMessage(error));
      } finally {
        if (button) button.disabled = false;
      }
      return;
    }
    if (formName === "account") {
      const email = String(data.get("email") ?? "");
      const existing = submitter?.dataset.accountIntent === "existing";
      try {
        if (existing) {
          const mode = await this.service.signInExistingAccount(email);
          if (mode === "tester") {
            this.modal = null;
            this.accountMessage = "";
            this.loading = true;
            this.render();
            await this.initialize();
            this.actions.onNotice("Tester account signed in.");
            return;
          }
          this.accountMessage = "Check your email to sign in. This page can stay open.";
        } else {
          this.profile = await this.service.acceptSocialTerms();
          await this.service.requestAccountEmail(email);
          this.accountMessage = "Check your email to secure this exact block.";
        }
      } catch (error) {
        this.accountMessage = errorMessage(error);
      }
      this.render();
      return;
    }
    if (formName === "consent") {
      const completed = await this.runAction(async () => {
        this.profile = await this.service.acceptSocialTerms();
        await this.ensureOwnHome();
        await this.startMessageSubscription();
      }, "Account setup complete.");
      if (completed && this.profileReady()) {
        this.modal = null;
        this.worldAccountKey = this.accountStateKey();
        this.actions.onAccountReady();
      }
      await this.loadCurrentTab();
      return;
    }
    if (formName === "post") {
      const file = data.get("media");
      const created = await this.runAction(async () => {
        await this.service.createPost({
          body: String(data.get("body") ?? ""),
          file: file instanceof File && file.size ? file : undefined,
          locationLabel: String(data.get("location") ?? "") || null,
          pinnedToHome: data.get("pinned") === "on",
        });
      }, "Block Post is live for 24 hours.");
      if (created) this.modal = null;
      await this.loadCurrentTab();
      return;
    }
    if (formName === "home" && this.profile && this.home) {
      const interests = String(data.get("interests") ?? "").split(",").map(value => value.trim()).filter(Boolean);
      const accessModeValue = data.get("accessMode");
      const accessMode: BlockHome["accessMode"] = isHomeAccess(accessModeValue) ? accessModeValue : "knock";
      let updatedProfile: SocialProfile | null = null;
      const saved = await this.runAction(async () => {
        [updatedProfile] = await Promise.all([
          this.service.updateProfile({
            displayName: String(data.get("displayName") ?? ""),
            handle: String(data.get("handle") ?? "") || null,
            bio: String(data.get("bio") ?? ""),
            interests,
            blockColor: this.profile!.blockColor,
          }),
          this.service.updateHome({
            name: String(data.get("homeName") ?? ""),
            accessMode,
            welcomeNote: String(data.get("welcomeNote") ?? ""),
            interiorLayout: this.homeDraft ?? this.home!.interiorLayout,
          }),
        ]);
      }, "Block Home saved.");
      const savedProfile = updatedProfile as SocialProfile | null;
      if (saved && savedProfile) {
        this.profile = savedProfile;
        this.actions.onIdentityChange(savedProfile);
        this.home = {
          ...this.home,
          interiorLayout: normalizeHomeInterior(
            this.homeDraft ?? this.home.interiorLayout,
            savedProfile.blockColor,
          ),
        };
      }
      await this.loadCurrentTab();
    }
  }

  private appendDirectMessage(friendUserId: string, message: DirectMessage): void {
    const list = this.root.querySelector<HTMLElement>(`[data-direct-message-list="${CSS.escape(friendUserId)}"]`);
    if (list && !list.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)) {
      list.querySelector(".neighbor-chat-empty")?.remove();
      list.insertAdjacentHTML("beforeend", this.renderDirectMessage(message));
      list.scrollTop = list.scrollHeight;
    }
    const blocks = this.root.querySelector<HTMLElement>(`[data-house-message-blocks="${CSS.escape(friendUserId)}"]`);
    if (blocks) {
      const block = document.createElement("i");
      block.className = message.senderId === this.account?.userId ? "is-mine" : "is-theirs";
      block.title = message.body ?? "Encrypted message";
      blocks.append(block);
      while (blocks.children.length > 10) blocks.firstElementChild?.remove();
    }
    const property = this.root.querySelector<HTMLElement>(`[data-neighbor-property="${CSS.escape(friendUserId)}"]`);
    const preview = property?.querySelector<HTMLElement>(".neighbor-last-message");
    if (preview) preview.textContent = truncateText(message.body ?? "Encrypted message", 64);
    this.animateMessageIntoHouse(friendUserId);
  }

  private animateMessageIntoHouse(friendUserId: string): void {
    const form = this.root.querySelector<HTMLElement>(`[data-social-form="direct-message"][data-user-id="${CSS.escape(friendUserId)}"]`);
    const house = this.root.querySelector<HTMLElement>(`[data-neighbor-property="${CSS.escape(friendUserId)}"] .neighbor-house-panel .home-cutaway-block`);
    if (!form || !house) return;
    const start = form.getBoundingClientRect();
    const destination = house.getBoundingClientRect();
    const block = document.createElement("i");
    block.className = "neighborhood-flying-block";
    block.style.setProperty("--block-start-x", `${start.right - 44}px`);
    block.style.setProperty("--block-start-y", `${start.top + 8}px`);
    block.style.setProperty("--block-travel-x", `${destination.left + destination.width / 2 - (start.right - 44)}px`);
    block.style.setProperty("--block-travel-y", `${destination.top + destination.height / 2 - (start.top + 8)}px`);
    document.body.append(block);
    block.addEventListener("animationend", () => block.remove(), { once: true });
  }

  private async markThreadRead(friendUserId: string): Promise<void> {
    try {
      await this.service.markDirectMessagesRead(friendUserId);
      const readAt = new Date().toISOString();
      this.directMessages = this.directMessages.map(message => (
        message.senderId === friendUserId
        && message.recipientId === this.account?.userId
        && !message.readAt
          ? { ...message, readAt }
          : message
      ));
      const property = this.root.querySelector<HTMLElement>(`[data-neighbor-property="${CSS.escape(friendUserId)}"]`);
      property?.classList.remove("has-unread");
      property?.querySelector(".neighbor-name-line b")?.remove();
      property?.querySelectorAll(".property-house.is-lit").forEach(house => house.classList.remove("is-lit"));
      this.updateAlertBadge();
    } catch {
      // A read receipt is helpful but never worth interrupting the conversation.
    }
  }

  private async startMessageSubscription(): Promise<void> {
    this.unsubscribeMessages?.();
    this.unsubscribeMessages = null;
    try {
      this.unsubscribeMessages = await this.service.subscribeToDirectMessages(
        () => void this.refreshDirectMessagesPreservingComposer(),
      );
    } catch {
      // History still loads normally if Realtime is temporarily unavailable.
    }
  }

  private async refreshDirectMessagesPreservingComposer(): Promise<void> {
    if (!this.account || this.account.isAnonymous || !this.profileReady()) return;
    try {
      this.directMessages = await this.service.loadDirectMessages();
    } catch {
      return;
    }
    if (!this.openState || this.tab !== "friends") {
      this.updateAlertBadge();
      return;
    }
    const activeForm = document.activeElement?.closest<HTMLFormElement>('[data-social-form="direct-message"]');
    const friendUserId = activeForm?.dataset.userId ?? this.expandedNeighborId;
    if (friendUserId && this.expandedNeighborId === friendUserId) {
      const thread = buildNeighborhoodThreads(this.friends, this.directMessages, this.account.userId)
        .find(candidate => candidate.friend.userId === friendUserId);
      const list = this.root.querySelector<HTMLElement>(`[data-direct-message-list="${CSS.escape(friendUserId)}"]`);
      if (thread && list) {
        list.innerHTML = thread.messages.length
          ? thread.messages.slice(-80).map(message => this.renderDirectMessage(message)).join("")
          : `<p class="neighbor-chat-empty">This is the start of your street together.</p>`;
        list.scrollTop = list.scrollHeight;
      }
      const blocks = this.root.querySelector<HTMLElement>(`[data-house-message-blocks="${CSS.escape(friendUserId)}"]`);
      if (thread && blocks) {
        blocks.innerHTML = recentHouseBlocks(thread.messages, 10)
          .map(message => `<i class="${message.senderId === this.account?.userId ? "is-mine" : "is-theirs"}" title="${escapeAttribute(message.body ?? "Encrypted message")}"></i>`)
          .join("");
      }
      this.updateAlertBadge();
      return;
    }
    this.render();
  }

  private async runAction(action: () => Promise<void>, success: string): Promise<boolean> {
    try {
      await action();
      this.actions.onNotice(success);
      return true;
    } catch (error) {
      this.actions.onNotice(errorMessage(error));
      return false;
    }
  }

  private async runHomeAccess(userId: string): Promise<"open" | "knocked" | null> {
    try {
      const access = await this.service.knockOnHome(userId);
      if (access === "knocked") this.actions.onNotice("Knock sent. You can enter after your friend lets you in.");
      return access;
    } catch (error) {
      this.actions.onNotice(errorMessage(error));
      return null;
    }
  }

  private async travelToHome(ownerId: string): Promise<void> {
    const spaceId = homeSpaceId(ownerId);
    if (!spaceId) {
      this.actions.onNotice("That Block Home address is invalid.");
      return;
    }
    const friend = this.friends.find(candidate => candidate.userId === ownerId);
    const profile = ownerId === this.account?.userId ? this.profile : friend?.profile;
    let interiorLayout = ownerId === this.home?.ownerId
      ? this.homeDraft ?? this.home.interiorLayout
      : this.neighborHomeInteriors.get(ownerId);
    if (!interiorLayout) {
      try {
        const home = await this.service.loadHome(ownerId);
        interiorLayout = home.interiorLayout;
        this.neighborHomeInteriors.set(ownerId, cloneHomeInterior(interiorLayout));
      } catch (error) {
        this.actions.onNotice(errorMessage(error));
        return;
      }
    }
    await this.actions.onTravel({
      cityId: "nashville",
      spaceId,
      kind: "house",
      label: profile ? `${profile.displayName}’s Block Home` : "Block Home",
      color: profile?.blockColor ?? "#ff6b6b",
    }, normalizeHomeInterior(interiorLayout, profile?.blockColor));
  }

  private async loadMoreFeed(): Promise<void> {
    if (this.loading || this.feedLoadingMore || !this.feedHasMore) return;
    this.feedLoadingMore = true;
    const generation = ++this.loadGeneration;
    try {
      const nextPage = this.feedPage + 1;
      let posts = this.feedPages.get(nextPage);
      if (!posts) {
        posts = this.feedIsDemo
          ? demoBlockPlanetPage(nextPage)
          : await this.service.loadFeed(nextPage);
        this.feedPages.set(nextPage, posts);
      }
      if (generation !== this.loadGeneration || this.tab !== "feed") return;
      if (!posts.length) {
        this.feedHasMore = false;
        this.actions.onNotice("You reached the edge of this BlockWall.");
        this.render();
        return;
      }
      const knownIds = new Set(this.feed.map(post => post.id));
      this.feed = [...this.feed, ...posts.filter(post => !knownIds.has(post.id))];
      this.feedPage = nextPage;
      this.feedHasMore = this.feedIsDemo
        ? hasDemoBlockPlanetPage(nextPage + 1)
        : posts.length === FEED_PAGE_SIZE;
      this.render();
    } catch (error) {
      if (generation !== this.loadGeneration) return;
      this.actions.onNotice(errorMessage(error));
      this.render();
    } finally {
      this.feedLoadingMore = false;
    }
  }

  private async returnPlanetToNow(): Promise<void> {
    if (this.planetAnimating || (this.feedPage === 0 && !this.planetUpdatesWaiting)) return;
    this.planetAnimating = true;
    const generation = ++this.loadGeneration;
    try {
      let posts = this.feedPages.get(0);
      if (!posts || this.planetUpdatesWaiting) {
        if (!this.account || this.account.isAnonymous || this.setupError) {
          this.feedIsDemo = true;
          posts = demoBlockPlanetPage(0);
        } else {
          const livePosts = await this.service.loadFeed(0);
          this.feedIsDemo = livePosts.length === 0;
          posts = livePosts.length ? livePosts : demoBlockPlanetPage(0);
        }
        this.feedPages.set(0, posts);
      }
      if (generation !== this.loadGeneration || this.tab !== "feed") return;
      this.feed = posts;
      this.feedPage = 0;
      this.feedHasMore = this.feedIsDemo ? hasDemoBlockPlanetPage(1) : posts.length === FEED_PAGE_SIZE;
      this.planetUpdatesWaiting = false;
      this.beginPlanetFormation();
    } catch (error) {
      if (generation === this.loadGeneration) this.actions.onNotice(errorMessage(error));
    } finally {
      this.planetAnimating = false;
    }
  }

  private beginPlanetFormation(): void {
    this.planetForming = true;
    this.render();
    window.setTimeout(() => {
      this.planetForming = false;
      this.root.querySelector("[data-block-planet-grid]")?.classList.remove("is-forming");
    }, 560);
  }

  private prepareDemoPlanet(page: number): void {
    const safePage = hasDemoBlockPlanetPage(page) ? page : 0;
    const posts = demoBlockPlanetPage(safePage);
    this.feedIsDemo = true;
    this.feed = posts;
    this.feedPage = safePage;
    this.feedHasMore = hasDemoBlockPlanetPage(safePage + 1);
    this.feedPages.set(safePage, posts);
  }

  private findPlanetPost(postId: string | null): SocialPost | null {
    if (!postId) return null;
    for (const posts of this.feedPages.values()) {
      const post = posts.find(candidate => candidate.id === postId);
      if (post) return post;
    }
    return this.feed.find(candidate => candidate.id === postId) ?? null;
  }

  private planetViewerPosts(): SocialPost[] {
    return this.feed.filter(post => !this.dismissedPlanetPostIds.has(post.id));
  }

  private appendPlanetComment(comment: string, commentCount: number): void {
    const commentList = this.root.querySelector<HTMLElement>("[data-planet-comment-list]");
    if (commentList) {
      commentList.querySelector(".planet-comments-empty")?.remove();
      const entry = document.createElement("p");
      const author = document.createElement("strong");
      const body = document.createElement("span");
      author.textContent = "You";
      body.textContent = comment;
      entry.append(author, body);
      commentList.append(entry);
      commentList.scrollTop = commentList.scrollHeight;
    }
    const counter = this.root.querySelector<HTMLElement>("[data-planet-comment-count]");
    if (counter) counter.textContent = String(commentCount);
  }

  private async advancePlanetViewer(direction: -1 | 1): Promise<void> {
    if (this.modal !== "planet-post" || !this.selectedPlanetPostId || this.planetViewerAnimating) return;
    this.planetViewerAnimating = true;
    const currentCard = this.root.querySelector<HTMLElement>("[data-planet-viewer-card]");
    if (currentCard) {
      currentCard.classList.add(direction > 0 ? "is-leaving-up" : "is-leaving-down");
      await wait(150);
    }
    try {
      let posts = this.planetViewerPosts();
      let step = resolveBlockPlanetViewerStep(
        posts.map(post => post.id),
        this.selectedPlanetPostId,
        direction,
      );
      if (step.kind === "exit" && this.feedHasMore) {
        await this.loadMoreFeed();
        posts = this.planetViewerPosts();
        step = resolveBlockPlanetViewerStep(
          posts.map(post => post.id),
          this.selectedPlanetPostId,
          direction,
        );
      }
      if (step.kind === "exit") {
        this.modal = null;
        this.selectedPlanetPostId = null;
        this.planetCommentsOpen = false;
        this.render();
        requestAnimationFrame(() => this.root.querySelector<HTMLElement>("[data-block-planet-stage]")?.focus());
        return;
      }
      if (step.kind === "stay") {
        this.render();
        requestAnimationFrame(() => this.root.querySelector<HTMLElement>("[data-planet-viewer-card]")?.focus());
        return;
      }
      this.selectedPlanetPostId = step.postId;
      this.viewedPlanetPostIds.add(step.postId);
      this.planetCommentsOpen = false;
      this.render();
      requestAnimationFrame(() => this.root.querySelector<HTMLElement>("[data-planet-viewer-card]")?.focus());
    } finally {
      this.planetViewerAnimating = false;
    }
  }

  private async dismissPlanetPost(
    postId: string,
    deltaX: number,
    deltaY: number,
    postElement?: HTMLElement,
  ): Promise<void> {
    if (this.planetDismissing || this.dismissedPlanetPostIds.has(postId)) return;
    this.planetDismissing = true;
    const card = postElement ?? [...this.root.querySelectorAll<HTMLElement>("[data-planet-post]")]
      .find(candidate => candidate.dataset.postId === postId);
    if (card) {
      const magnitude = Math.max(1, Math.hypot(deltaX, deltaY));
      const distance = Math.max(520, Math.hypot(window.innerWidth, window.innerHeight) * .72);
      card.style.setProperty("--dismiss-x", `${(deltaX / magnitude) * distance}px`);
      card.style.setProperty("--dismiss-y", `${(deltaY / magnitude) * distance}px`);
      card.classList.add("is-dismissing");
      await wait(260);
    }
    this.dismissedPlanetPostIds.add(postId);
    this.modal = null;
    this.selectedPlanetPostId = null;
    this.planetCommentsOpen = false;
    this.planetDismissing = false;
    this.render();
    const remainingPosts = buildBlockPlanetStacks(this.feed, this.dismissedPlanetPostIds)
      .reduce((total, stack) => total + stack.length, 0);
    if (remainingPosts <= BLOCK_PLANET_SLOTS.length && this.feedHasMore) {
      void this.loadMoreFeed();
    }
  }

  private handleHomePointerDown(event: PointerEvent): boolean {
    if (event.button !== 0) return false;
    const room = (event.target as HTMLElement).closest<HTMLElement>("[data-home-move-surface]");
    if (!room) return false;
    const interior = room.closest<HTMLElement>("[data-home-interior]");
    const ownerId = interior?.dataset.homeOwnerId;
    if (!interior || !ownerId) return false;

    const furniture = (event.target as HTMLElement).closest<HTMLElement>("[data-home-furniture-id]");
    if (furniture) {
      if (interior.dataset.homeEditable !== "true" || !this.homeDraft) return true;
      const furnitureId = furniture.dataset.homeFurnitureId;
      if (!furnitureId || !this.homeDraft.furniture.some(item => item.id === furnitureId)) return true;
      event.preventDefault();
      this.selectedHomeFurnitureId = furnitureId;
      this.homeFurnitureDrag = {
        pointerId: event.pointerId,
        furnitureId,
        room,
        item: furniture,
        moved: false,
        startX: event.clientX,
        startY: event.clientY,
      };
      furniture.setPointerCapture?.(event.pointerId);
      furniture.classList.add("is-dragging", "is-selected");
      return true;
    }

    if ((event.target as HTMLElement).closest("button,input,select,label")) return false;
    event.preventDefault();
    this.moveCutawayAvatarToPoint(ownerId, room, event.clientX, event.clientY);
    return true;
  }

  private handleHomePointerMove(event: PointerEvent): boolean {
    const drag = this.homeFurnitureDrag;
    if (!drag || drag.pointerId !== event.pointerId || !this.homeDraft) return false;
    event.preventDefault();
    const rect = drag.room.getBoundingClientRect();
    const x = clampHomeCoordinate(((event.clientX - rect.left) / Math.max(1, rect.width)) * 100, 5, 95);
    const y = clampHomeCoordinate(((event.clientY - rect.top) / Math.max(1, rect.height)) * 100, 20, 90);
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) drag.moved = true;
    this.homeDraft.furniture = this.homeDraft.furniture.map(item => (
      item.id === drag.furnitureId ? { ...item, x, y } : item
    ));
    drag.item.style.setProperty("--furniture-x", String(x));
    drag.item.style.setProperty("--furniture-y", String(y));
    return true;
  }

  private handleHomePointerEnd(event: PointerEvent): boolean {
    const drag = this.homeFurnitureDrag;
    if (!drag || drag.pointerId !== event.pointerId) return false;
    this.homeFurnitureDrag = null;
    drag.item.releasePointerCapture?.(event.pointerId);
    drag.item.classList.remove("is-dragging");
    event.preventDefault();
    this.renderPreservingBodyScroll();
    return true;
  }

  private handleHomeSettingInput(event: Event): void {
    if (!this.homeDraft || !this.home || this.home.ownerId !== this.account?.userId) return;
    const control = (event.target as HTMLElement).closest<HTMLInputElement | HTMLSelectElement>("[data-home-setting]");
    if (!control) return;
    const setting = control.dataset.homeSetting;
    const ownerSelector = CSS.escape(this.home.ownerId);
    const interiors = this.root.querySelectorAll<HTMLElement>(`[data-home-interior][data-home-owner-id="${ownerSelector}"]`);
    if (setting === "wallColor" && isHexColor(control.value)) {
      this.homeDraft.wallColor = control.value.toLowerCase();
      interiors.forEach(interior => interior.style.setProperty("--home-wall-color", this.homeDraft!.wallColor));
      return;
    }
    if (setting === "floorColor" && isHexColor(control.value)) {
      this.homeDraft.floorColor = control.value.toLowerCase();
      interiors.forEach(interior => interior.style.setProperty("--home-floor-color", this.homeDraft!.floorColor));
      return;
    }
    if (setting === "lighting" && isHomeLighting(control.value)) {
      this.homeDraft.lighting = control.value;
      interiors.forEach(interior => {
        interior.classList.remove("lighting-day", "lighting-warm", "lighting-night");
        interior.classList.add(`lighting-${control.value}`);
      });
      return;
    }
    if (setting === "furnitureColor" && isHexColor(control.value) && this.selectedHomeFurnitureId) {
      const color = control.value.toLowerCase();
      this.homeDraft.furniture = this.homeDraft.furniture.map(item => (
        item.id === this.selectedHomeFurnitureId ? { ...item, color } : item
      ));
      this.root
        .querySelectorAll<HTMLElement>(`[data-home-furniture-id="${CSS.escape(this.selectedHomeFurnitureId)}"]`)
        .forEach(item => item.style.setProperty("--furniture-color", color));
    }
  }

  private moveCutawayAvatar(
    ownerId: string,
    direction: "left" | "right" | "up" | "down",
  ): void {
    const current = this.cutawayAvatarPositions.get(ownerId) ?? { x: 50, y: 80 };
    const next = {
      x: clampHomeCoordinate(current.x + (direction === "left" ? -7 : direction === "right" ? 7 : 0), 7, 93),
      y: clampHomeCoordinate(current.y + (direction === "up" ? -7 : direction === "down" ? 7 : 0), 54, 88),
    };
    this.setCutawayAvatarPosition(ownerId, next);
  }

  private moveCutawayAvatarToPoint(
    ownerId: string,
    room: HTMLElement,
    clientX: number,
    clientY: number,
  ): void {
    const rect = room.getBoundingClientRect();
    this.setCutawayAvatarPosition(ownerId, {
      x: clampHomeCoordinate(((clientX - rect.left) / Math.max(1, rect.width)) * 100, 7, 93),
      y: clampHomeCoordinate(((clientY - rect.top) / Math.max(1, rect.height)) * 100, 54, 88),
    });
  }

  private setCutawayAvatarPosition(ownerId: string, position: { x: number; y: number }): void {
    this.cutawayAvatarPositions.set(ownerId, position);
    this.root
      .querySelectorAll<HTMLElement>(`[data-home-avatar="${CSS.escape(ownerId)}"]`)
      .forEach(avatar => {
        avatar.style.setProperty("--avatar-x", String(position.x));
        avatar.style.setProperty("--avatar-y", String(position.y));
      });
  }

  private renderPreservingBodyScroll(): void {
    const scrollTop = this.root.querySelector<HTMLElement>(".social-body")?.scrollTop ?? 0;
    this.render();
    requestAnimationFrame(() => {
      const body = this.root.querySelector<HTMLElement>(".social-body");
      if (body) body.scrollTop = scrollTop;
    });
  }

  private handlePlanetPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || this.planetAnimating || this.planetDismissing) return;
    if (this.modal === "planet-post") {
      this.handlePlanetViewerPointerDown(event);
      return;
    }
    if (this.modal) return;
    const post = (event.target as HTMLElement).closest<HTMLElement>("[data-planet-post]");
    const stage = post?.closest<HTMLElement>("[data-block-planet-stage]");
    const postId = post?.dataset.postId;
    if (!post || !stage || !postId) return;
    this.planetDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      deltaX: 0,
      deltaY: 0,
      moved: false,
      post,
      postId,
      stage,
    };
    post.setPointerCapture?.(event.pointerId);
    post.classList.add("is-dragging");
    stage.classList.add("is-dragging");
  }

  private handlePlanetPointerMove(event: PointerEvent): void {
    if (this.planetViewerDrag?.pointerId === event.pointerId) {
      this.handlePlanetViewerPointerMove(event);
      return;
    }
    const drag = this.planetDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.deltaX = event.clientX - drag.startX;
    drag.deltaY = event.clientY - drag.startY;
    if (Math.hypot(drag.deltaX, drag.deltaY) > 7) drag.moved = true;
    if (!drag.moved) return;
    event.preventDefault();
    drag.post.style.setProperty("--card-drag-x", `${drag.deltaX}px`);
    drag.post.style.setProperty("--card-drag-y", `${drag.deltaY}px`);
    drag.post.style.setProperty("--card-drag-rotate", `${drag.deltaX * .035}deg`);
    const ready = isBlockPlanetDismiss(drag.deltaX, drag.deltaY);
    drag.post.classList.toggle("is-dismiss-ready", ready);
    drag.stage.classList.toggle("is-dismiss-ready", ready);
  }

  private handlePlanetPointerEnd(event: PointerEvent): void {
    if (this.planetViewerDrag?.pointerId === event.pointerId) {
      this.handlePlanetViewerPointerEnd(event);
      return;
    }
    const drag = this.planetDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.planetDrag = null;
    drag.post.releasePointerCapture?.(event.pointerId);
    drag.post.classList.remove("is-dragging", "is-dismiss-ready");
    drag.stage.classList.remove("is-dragging");
    drag.stage.classList.remove("is-dismiss-ready");
    if (drag.moved) this.suppressPlanetClickUntil = performance.now() + 350;
    if (event.type !== "pointercancel" && isBlockPlanetDismiss(drag.deltaX, drag.deltaY)) {
      void this.dismissPlanetPost(drag.postId, drag.deltaX, drag.deltaY, drag.post);
      return;
    }
    this.clearPlanetCardDragStyles(drag.post);
  }

  private clearPlanetCardDragStyles(post: HTMLElement): void {
    post.style.removeProperty("--card-drag-x");
    post.style.removeProperty("--card-drag-y");
    post.style.removeProperty("--card-drag-rotate");
  }

  private handlePlanetViewerPointerDown(event: PointerEvent): void {
    if (
      this.planetCommentsOpen
      || this.planetViewerAnimating
      || (event.target as HTMLElement).closest("button,input,form,[data-planet-comment-sheet]")
    ) return;
    const card = (event.target as HTMLElement).closest<HTMLElement>("[data-planet-viewer-card]");
    if (!card) return;
    this.planetViewerDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      deltaX: 0,
      deltaY: 0,
      card,
    };
    card.setPointerCapture?.(event.pointerId);
  }

  private handlePlanetViewerPointerMove(event: PointerEvent): void {
    const drag = this.planetViewerDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.deltaX = event.clientX - drag.startX;
    drag.deltaY = event.clientY - drag.startY;
    if (Math.hypot(drag.deltaX, drag.deltaY) <= 7) return;
    event.preventDefault();
    drag.card.classList.add("is-viewer-dragging");
    drag.card.style.setProperty("--viewer-drag-y", `${drag.deltaY * .72}px`);
  }

  private handlePlanetViewerPointerEnd(event: PointerEvent): void {
    const drag = this.planetViewerDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.planetViewerDrag = null;
    drag.card.releasePointerCapture?.(event.pointerId);
    drag.card.classList.remove("is-viewer-dragging");
    const isVerticalSwipe = Math.abs(drag.deltaY) >= 62 && Math.abs(drag.deltaY) > Math.abs(drag.deltaX) * 1.1;
    if (event.type !== "pointercancel" && isVerticalSwipe) {
      void this.advancePlanetViewer(drag.deltaY < 0 ? 1 : -1);
      return;
    }
    drag.card.style.removeProperty("--viewer-drag-y");
  }

  private handlePlanetViewerWheel(event: WheelEvent): void {
    if (
      this.modal !== "planet-post"
      || this.planetCommentsOpen
      || this.planetViewerAnimating
      || this.planetViewerWheelLocked
      || Math.abs(event.deltaY) < 24
      || (event.target as HTMLElement).closest(".planet-comment-sheet")
    ) return;
    event.preventDefault();
    this.planetViewerWheelLocked = true;
    void this.advancePlanetViewer(event.deltaY > 0 ? 1 : -1);
    window.setTimeout(() => {
      this.planetViewerWheelLocked = false;
    }, 430);
  }

  private handlePlanetKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape" && this.modal) {
      event.preventDefault();
      if (this.modal === "planet-post" && this.planetCommentsOpen) {
        this.planetCommentsOpen = false;
        this.render();
        return;
      }
      this.modal = null;
      this.selectedPlanetPostId = null;
      this.planetCommentsOpen = false;
      this.render();
      return;
    }
    if (
      this.modal === "planet-post"
      && !(event.target as HTMLElement).matches("input,textarea")
      && (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "ArrowDown" || event.key === "PageDown")
    ) {
      event.preventDefault();
      void this.advancePlanetViewer(event.key === "ArrowUp" || event.key === "PageUp" ? -1 : 1);
      return;
    }
    const current = (event.target as HTMLElement).closest<HTMLElement>("[data-planet-index]");
    if ((event.key === "Delete" || event.key === "Backspace") && current?.dataset.postId) {
      event.preventDefault();
      void this.dismissPlanetPost(current.dataset.postId, 150, -45, current);
      return;
    }
    if (!isBlockPlanetArrowKey(event.key)) return;
    if (!current) return;
    const currentIndex = Number(current.dataset.planetIndex);
    if (!Number.isInteger(currentIndex)) return;
    const nextIndex = nextBlockPlanetSlotIndex(currentIndex, event.key);
    const next = this.root.querySelector<HTMLButtonElement>(`[data-planet-index="${nextIndex}"]`);
    if (!next || next === current) return;
    event.preventDefault();
    next.focus();
  }

  private async refreshAlertData(): Promise<void> {
    if (!this.account || this.account.isAnonymous || !this.profileReady()) return;
    const generation = ++this.alertGeneration;
    try {
      const [friends, invitations, messages] = await Promise.all([
        this.service.loadFriends(),
        this.service.loadHomeInvitations(),
        this.service.loadDirectMessages(),
      ]);
      if (generation !== this.alertGeneration) return;
      this.friends = friends;
      this.invitations = invitations;
      this.directMessages = messages;
      if (this.openState) this.updateAlertBadge();
    } catch {
      // Active tab loads surface errors. Badge refreshes stay quiet during
      // reconnects and account transitions.
    }
  }

  private hydrateVisibleMedia(): void {
    const images = [...this.root.querySelectorAll<HTMLImageElement>("[data-post-media]")];
    if (!images.length) return;
    if (!("IntersectionObserver" in window)) {
      for (const image of images) void this.loadMediaImage(image);
      return;
    }
    this.mediaObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const image = (entry.target instanceof HTMLImageElement
          ? entry.target
          : entry.target.querySelector<HTMLImageElement>("[data-post-media]"));
        this.mediaObserver?.unobserve(entry.target);
        if (image) void this.loadMediaImage(image);
      }
    }, { root: this.root.querySelector(".social-body"), rootMargin: "300px 0px" });
    for (const image of images) this.mediaObserver.observe(image.parentElement ?? image);
  }

  private updateAlertBadge(): void {
    const button = this.root.querySelector<HTMLButtonElement>('[data-social-tab="alerts"]');
    if (!button) return;
    const count = this.alertCount();
    const current = button.querySelector(".social-alert-badge");
    button.setAttribute("aria-label", count ? `Alerts, ${count} new` : "Alerts");
    if (!count) {
      current?.remove();
      return;
    }
    const badge = current ?? document.createElement("span");
    badge.className = "social-alert-badge";
    badge.textContent = String(count);
    if (!current) button.append(badge);
  }

  private async loadMediaImage(image: HTMLImageElement): Promise<void> {
    const postId = image.dataset.postMedia;
    if (!postId) return;
    try {
      let url = this.mediaUrls.get(postId);
      if (!url) {
        let pending = this.mediaLoads.get(postId);
        if (!pending) {
          pending = this.service.media.download(postId);
          this.mediaLoads.set(postId, pending);
        }
        try {
          url = await pending;
          this.mediaUrls.set(postId, url);
        } finally {
          if (this.mediaLoads.get(postId) === pending) this.mediaLoads.delete(postId);
        }
      }
      if (!image.isConnected) return;
      image.src = url;
      image.hidden = false;
      image.parentElement?.querySelector(".media-placeholder")?.remove();
    } catch {
      if (image.isConnected) {
        image.parentElement?.querySelector(".media-placeholder")?.replaceChildren("Picture unavailable");
      }
    }
  }

  private async ensureOwnHome(): Promise<void> {
    if (!this.account || this.account.isAnonymous) return;
    await this.service.ensureHome();
  }

  private positionOrigin(): void {
    const x = this.avatarRect ? this.avatarRect.left + this.avatarRect.width / 2 : window.innerWidth / 2;
    const y = this.avatarRect ? this.avatarRect.top + this.avatarRect.height / 2 : window.innerHeight / 2;
    this.root.style.setProperty("--portal-x", `${x}px`);
    this.root.style.setProperty("--portal-y", `${y}px`);
    this.root.style.setProperty("--portal-color", this.accent);
  }

  private alertCount(): number {
    const unreadMessages = this.directMessages.filter(message => (
      message.recipientId === this.account?.userId && !message.readAt
    )).length;
    return this.friends.filter(friend => friend.status === "pending-incoming").length
      + this.invitations.length
      + unreadMessages;
  }

  private profileReady(): boolean {
    return Boolean(
      this.profile?.termsAcceptedAt
      && this.profile.ageConfirmedAt
      && this.profile.termsVersion === "2026-07",
    );
  }

  private accountStateKey(): string {
    return `${this.account?.userId ?? "none"}:${this.account?.isAnonymous !== false ? "guest" : "account"}:${this.profileReady() ? "ready" : "limited"}`;
  }

  private clearSocialCache(): void {
    this.feed = [];
    this.feedPage = 0;
    this.feedHasMore = false;
    this.feedIsDemo = false;
    this.feedPages.clear();
    this.planetUpdatesWaiting = false;
    this.selectedPlanetPostId = null;
    this.planetCommentsOpen = false;
    this.viewedPlanetPostIds.clear();
    this.likedPlanetPostIds.clear();
    this.planetComments.clear();
    this.dismissedPlanetPostIds.clear();
    this.friends = [];
    this.directMessages = [];
    this.neighborHomeInteriors.clear();
    this.expandedNeighborId = null;
    this.cutawayAvatarPositions.clear();
    this.homeDraft = null;
    this.selectedHomeFurnitureId = null;
    this.homeFurnitureDrag = null;
    this.neighborSearchQuery = "";
    this.neighborSearchResults = [];
    this.portalSnapshot = null;
    this.mapPosts = [];
    this.home = null;
    this.invitations = [];
    this.blockedProfiles = [];
    for (const url of this.mediaUrls.values()) URL.revokeObjectURL(url);
    this.mediaUrls.clear();
    this.mediaLoads.clear();
  }
}

function navButton(tab: PortalTab, label: string, active: PortalTab): string {
  return `<button data-social-tab="${tab}" class="${tab === active ? "is-active" : ""}">${label}</button>`;
}

function isBlockPlanetArrowKey(value: string): value is BlockPlanetArrowKey {
  return value === "ArrowUp" || value === "ArrowDown" || value === "ArrowLeft" || value === "ArrowRight";
}

function demoPlanetVisual(postId: string): { kind: "photo" | "video"; scene: number } | null {
  const match = /^demo-block-post-(\d+)$/.exec(postId);
  if (!match) return null;
  const index = Math.max(0, Number(match[1]) - 1);
  const kinds: Array<"photo" | "video" | null> = [
    "video",
    "photo",
    "photo",
    null,
    "video",
    "photo",
    null,
    "photo",
  ];
  const kind = kinds[index % kinds.length];
  return kind ? { kind, scene: index % 6 } : null;
}

function truncateText(value: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
}

function safeProfilePhotoUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}

function homeAccessOptions(selected: BlockHome["accessMode"]): string {
  const options: Array<[BlockHome["accessMode"], string]> = [
    ["open", "Open house"],
    ["knock", "Knock first"],
    ["invite", "Invite only"],
    ["dnd", "Do not disturb"],
    ["away", "Away"],
  ];
  return options.map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`).join("");
}

function homeLightingOptions(selected: HomeLighting): string {
  const options: Array<[HomeLighting, string]> = [
    ["day", "Bright day"],
    ["warm", "Warm evening"],
    ["night", "Night lights"],
  ];
  return options
    .map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`)
    .join("");
}

function pinPosition(location: string, index: number): { x: number; y: number } {
  const anchors: Record<string, { x: number; y: number }> = {
    "Town Square": { x: 49, y: 48 },
    Downtown: { x: 42, y: 47 },
    "East Nashville": { x: 70, y: 36 },
    "The Gulch": { x: 34, y: 64 },
    "Centennial Park": { x: 20, y: 47 },
  };
  const anchor = anchors[location] ?? { x: 50, y: 50 };
  return { x: anchor.x + ((index % 3) - 1) * 4, y: anchor.y + ((index % 2) ? 4 : -3) };
}

function timeAgo(timestamp: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(timestamp)) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function timeUntil(timestamp: string): string {
  const minutes = Math.max(0, Math.ceil((Date.parse(timestamp) - Date.now()) / 60_000));
  if (minutes < 60) return `in ${minutes}m`;
  return `in ${Math.ceil(minutes / 60)}h`;
}

function formatDate(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(timestamp));
}

function formatMessageTime(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function isRecentlyOnline(timestamp: string | null): boolean {
  return Boolean(timestamp && Date.now() - Date.parse(timestamp) < 10 * 60_000);
}

function isPortalTab(value: unknown): value is PortalTab {
  return value === "feed" || value === "friends" || value === "map" || value === "home" || value === "alerts";
}

function isHomeAccess(value: FormDataEntryValue | null): value is BlockHome["accessMode"] {
  return value === "open" || value === "knock" || value === "invite" || value === "dnd" || value === "away";
}

function isHomeFurnitureKind(value: string): value is HomeFurnitureKind {
  return HOME_FURNITURE_KINDS.some(kind => kind === value);
}

function isHomeLighting(value: string): value is HomeLighting {
  return value === "day" || value === "warm" || value === "night";
}

function isCutawayDirection(value: string | undefined): value is "left" | "right" | "up" | "down" {
  return value === "left" || value === "right" || value === "up" || value === "down";
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}
