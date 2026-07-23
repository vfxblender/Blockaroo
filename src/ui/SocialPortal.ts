import type { PlayerIdentity } from "../game/types/world";
import { SocialService } from "../services/SocialService";
import type {
  BlockHome,
  FriendConnection,
  HomeInvitation,
  SocialAccount,
  SocialPost,
  SocialProfile,
} from "../social/types";
import { escapeAttribute, escapeHtml } from "./html";

type PortalTab = "feed" | "friends" | "map" | "home" | "alerts";

interface SocialPortalActions {
  onIdentityChange(profile: SocialProfile): void;
  onConnectToFriend(userId: string): void;
  onOpenChange(open: boolean): void;
  onNotice(message: string): void;
  onAccountReady(): void;
  onBlockedUsersChange(userIds: string[]): void;
}

const MAP_LOCATIONS = ["", "Town Square", "Downtown", "East Nashville", "The Gulch", "Centennial Park"];
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
  private friends: FriendConnection[] = [];
  private mapPosts: SocialPost[] = [];
  private home: BlockHome | null = null;
  private invitations: HomeInvitation[] = [];
  private blockedProfiles: SocialProfile[] = [];
  private tab: PortalTab = "feed";
  private viewedHomeId: string | null = null;
  private openState = false;
  private loading = true;
  private setupError = "";
  private modal: "post" | null = null;
  private accountMessage = "";
  private mediaUrls = new Map<string, string>();
  private mediaLoads = new Map<string, Promise<string>>();
  private mediaObserver: IntersectionObserver | null = null;
  private unsubscribeAuth: (() => void) | null = null;
  private unsubscribePosts: (() => void) | null = null;
  private unsubscribeAlerts: (() => void) | null = null;
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
    this.unsubscribeAuth = this.service.onAccountChange(() => void this.initialize());
    this.unsubscribePosts = this.service.subscribeToPosts(() => {
      if (this.openState && this.tab === "feed" && !this.modal && !this.account?.isAnonymous) void this.loadCurrentTab();
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
    this.mediaObserver?.disconnect();
    this.mediaObserver = null;
    for (const url of this.mediaUrls.values()) URL.revokeObjectURL(url);
    this.mediaUrls.clear();
    this.mediaLoads.clear();
    this.root.remove();
  }

  private async loadCurrentTab(): Promise<void> {
    const generation = ++this.loadGeneration;
    if (!this.openState || this.setupError) {
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
        const feed = await this.service.loadFeed();
        if (generation !== this.loadGeneration) return;
        this.feed = feed;
        this.feedPage = 0;
        this.feedHasMore = feed.length === FEED_PAGE_SIZE;
      }
      if (tab === "friends") {
        const friends = await this.service.loadFriends();
        if (generation !== this.loadGeneration) return;
        this.friends = friends;
      }
      if (tab === "map") {
        const mapPosts = await this.service.loadMapPosts();
        if (generation !== this.loadGeneration) return;
        this.mapPosts = mapPosts;
      }
      if (tab === "home") {
        const home = await this.service.loadHome(viewedHomeId ?? this.account.userId);
        if (generation !== this.loadGeneration) return;
        this.home = home;
      }
      if (tab === "alerts") {
        const [friends, invitations, blockedProfiles] = await Promise.all([
          this.service.loadFriends(),
          this.service.loadHomeInvitations(),
          this.service.loadBlockedProfiles(),
        ]);
        if (generation !== this.loadGeneration) return;
        this.friends = friends;
        this.invitations = invitations;
        this.blockedProfiles = blockedProfiles;
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
    const accountLabel = this.account?.isAnonymous ? "Guest block" : this.account?.email ?? "Account";
    this.root.innerHTML = `
      <div class="social-shell">
        <header class="social-header">
          <div class="social-wordmark"><span class="eyebrow">YOUR BLOCK</span><strong>BLOCKAROO</strong></div>
          <nav aria-label="Social portal">
            ${navButton("feed", "Feed", this.tab)}
            ${navButton("friends", "Friends", this.tab)}
            ${navButton("map", "Nashville", this.tab)}
            ${navButton("home", "Block Home", this.tab)}
            ${navButton("alerts", "Alerts", this.tab, this.alertCount())}
          </nav>
          <div class="social-account-chip">${escapeHtml(accountLabel)}</div>
          <button class="social-close" data-social-action="close" aria-label="Close social portal">×</button>
        </header>
        <main class="social-body">${this.renderBody()}</main>
        ${this.modal === "post" ? this.renderPostModal() : ""}
      </div>
    `;
    if (!this.loading) this.hydrateVisibleMedia();
  }

  private renderBody(): string {
    if (this.loading) return `<div class="portal-loading"><span class="block-loader"></span><p>Opening your block…</p></div>`;
    if (this.setupError) {
      return `<div class="portal-empty"><span class="empty-glyph">!</span><h1>The social layer could not open.</h1><p>${escapeHtml(this.setupError)}</p><p>Town Square still works. Check the Supabase configuration or migration, then try again.</p><button class="primary-action" data-social-action="retry-setup">Try again</button></div>`;
    }
    if (!this.account || this.account.isAnonymous) return this.renderAccountGate();
    if (!this.profileReady()) return this.renderConsentGate();
    if (this.tab === "feed") return this.renderFeed();
    if (this.tab === "friends") return this.renderFriends();
    if (this.tab === "map") return this.renderMap();
    if (this.tab === "home") return this.renderHome();
    return this.renderAlerts();
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
    const cards = this.feed.length ? this.feed.map(post => this.postCard(post)).join("") : `
      <div class="portal-empty compact"><span class="empty-glyph">□</span><h2>Your feed is quiet.</h2><p>Add a friend or make the first Block Post. Posts disappear after 24 hours.</p></div>
    `;
    return `
      <section class="feed-layout">
        <div class="feed-heading">
          <div><span class="eyebrow">FRIENDS · LAST 24 HOURS</span><h1>What your people are doing.</h1></div>
          <button class="primary-action" data-social-action="new-post">+ Block Post</button>
        </div>
        <div class="feed-list">${cards}</div>
        ${this.feedHasMore ? `<button class="feed-more-button" data-social-action="load-more">Load older posts</button>` : ""}
        <aside class="feed-principle"><span>PRIVATE EXPERIENCE INSIDE</span><strong>Visible social energy outside.</strong><p>No algorithm. No follower count. Just accepted friends in chronological order.</p></aside>
      </section>
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
    const accepted = this.friends.filter(friend => friend.status === "accepted");
    const pending = this.friends.filter(friend => friend.status !== "accepted");
    return `
      <section class="friends-layout">
        <div class="section-heading"><span class="eyebrow">YOUR PEOPLE</span><h1>Connections made in the city.</h1><p>Talk and play first. Add people worth seeing again.</p></div>
        ${pending.length ? `<div class="friend-section"><h2>Requests</h2>${pending.map(friend => this.friendCard(friend)).join("")}</div>` : ""}
        <div class="friend-section"><h2>Friends · ${accepted.length}</h2>${accepted.length ? accepted.map(friend => this.friendCard(friend)).join("") : `<div class="portal-empty compact"><p>No accepted friends yet. Meet somebody in Town Square and send a request from their block.</p></div>`}</div>
      </section>
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
    const pins = this.mapPosts.map((post, index) => {
      const position = pinPosition(post.locationLabel ?? "", index);
      return `<button class="map-pin" style="left:${position.x}%;top:${position.y}%;--pin-color:${escapeAttribute(post.author.blockColor)}" data-social-action="map-post" data-post-id="${post.id}" aria-label="${escapeAttribute(post.author.displayName)} posted from ${escapeAttribute(post.locationLabel ?? "Nashville")}"><i></i><span>${escapeHtml(post.author.displayName)}</span></button>`;
    }).join("");
    const cards = this.mapPosts.map(post => this.postCard(post)).join("");
    return `
      <section class="map-layout">
        <div class="section-heading"><span class="eyebrow">NASHVILLE NOW</span><h1>A living social map—not an MMO.</h1><p>Friends choose a public venue or broad neighborhood. Never live GPS. Never residential addresses.</p></div>
        <div class="nashville-map">
          <span class="river"></span>
          <span class="map-zone zone-east">EAST NASHVILLE</span>
          <span class="map-zone zone-downtown">DOWNTOWN</span>
          <span class="map-zone zone-gulch">THE GULCH</span>
          <span class="map-zone zone-park">CENTENNIAL PARK</span>
          <span class="town-square-pin">TOWN<br/>SQUARE</span>
          ${pins}
        </div>
        <div class="map-post-list">${cards || `<div class="portal-empty compact"><p>No friends have attached a Block Post to the city map yet.</p></div>`}</div>
      </section>
    `;
  }

  private renderHome(): string {
    if (!this.home) return `<div class="portal-empty"><h2>This Block Home is unavailable.</h2></div>`;
    const ownHome = this.home.ownerId === this.account?.userId;
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
        <div class="home-wall">${gallery}</div>
        ${ownHome ? this.renderHomeEditor() : `
          <div class="home-actions"><button data-social-action="invite-home" data-user-id="${escapeAttribute(this.home.ownerId)}">Invite them to my home</button></div>
        `}
      </section>
    `;
  }

  private renderHomeEditor(): string {
    if (!this.home || !this.profile) return "";
    return `
      <details class="home-editor">
        <summary>Edit my Block Home</summary>
        <form data-social-form="home">
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
          <button class="primary-action">Save home</button>
        </form>
      </details>
    `;
  }

  private renderAlerts(): string {
    const incoming = this.friends.filter(friend => friend.status === "pending-incoming");
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
          ${!incoming.length && !this.invitations.length ? `<div class="portal-empty compact"><span class="empty-glyph">✓</span><h2>You’re caught up.</h2><p>Circle invitations appear immediately while you’re in Town Square.</p></div>` : ""}
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
              <label>Place on Nashville map<select name="location">${MAP_LOCATIONS.map(location => `<option value="${escapeAttribute(location)}">${location || "Feed only"}</option>`).join("")}</select></label>
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
      this.tab = target.dataset.socialTab;
      if (this.tab === "home") this.viewedHomeId = this.account?.userId ?? null;
      await this.loadCurrentTab();
      return;
    }
    const action = target.dataset.socialAction;
    if (action === "close") return this.close();
    if (action === "retry-setup") { void this.initialize(); return; }
    if (action === "new-post") { this.modal = "post"; this.render(); return; }
    if (action === "load-more") {
      await this.loadMoreFeed();
      return;
    }
    if (action === "cancel-modal") { this.modal = null; this.render(); return; }
    if (action === "connect" && target.dataset.userId) {
      this.actions.onConnectToFriend(target.dataset.userId);
      return;
    }
    if (action === "view-home" && target.dataset.userId) {
      const userId = target.dataset.userId;
      if (userId !== this.account?.userId) {
        const access = await this.runHomeAccess(userId);
        if (access !== "open") return;
      }
      this.viewedHomeId = userId;
      this.tab = "home";
      await this.loadCurrentTab();
      return;
    }
    if (action === "knock-home" && target.dataset.userId) {
      const userId = target.dataset.userId;
      const access = await this.runHomeAccess(userId);
      if (access === "open") {
        this.viewedHomeId = userId;
        this.tab = "home";
        await this.loadCurrentTab();
      }
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
      this.viewedHomeId = target.dataset.userId;
      this.tab = "home";
      return this.loadCurrentTab();
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
    if (formName === "account") {
      const email = String(data.get("email") ?? "");
      const existing = submitter?.dataset.accountIntent === "existing";
      try {
        this.profile = await this.service.acceptSocialTerms();
        if (existing) await this.service.sendExistingAccountLink(email);
        else await this.service.requestAccountEmail(email);
        this.accountMessage = existing
          ? "Check your email to sign in. This page can stay open."
          : "Check your email to secure this exact block.";
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
      }, "Account setup complete.");
      if (completed && this.profileReady()) {
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
          }),
        ]);
      }, "Block Home saved.");
      if (saved && updatedProfile) {
        this.profile = updatedProfile;
        this.actions.onIdentityChange(updatedProfile);
      }
      await this.loadCurrentTab();
    }
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

  private async loadMoreFeed(): Promise<void> {
    if (this.loading || !this.feedHasMore) return;
    const generation = ++this.loadGeneration;
    this.loading = true;
    this.render();
    try {
      const nextPage = this.feedPage + 1;
      const posts = await this.service.loadFeed(nextPage);
      if (generation !== this.loadGeneration || this.tab !== "feed") return;
      const known = new Set(this.feed.map(post => post.id));
      this.feed.push(...posts.filter(post => !known.has(post.id)));
      this.feedPage = nextPage;
      this.feedHasMore = posts.length === FEED_PAGE_SIZE;
    } catch (error) {
      if (generation !== this.loadGeneration) return;
      this.actions.onNotice(errorMessage(error));
    } finally {
      if (generation !== this.loadGeneration) return;
      this.loading = false;
      this.render();
    }
  }

  private async refreshAlertData(): Promise<void> {
    if (!this.account || this.account.isAnonymous || !this.profileReady()) return;
    const generation = ++this.alertGeneration;
    try {
      const [friends, invitations] = await Promise.all([
        this.service.loadFriends(),
        this.service.loadHomeInvitations(),
      ]);
      if (generation !== this.alertGeneration) return;
      this.friends = friends;
      this.invitations = invitations;
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
    const current = button.querySelector("span");
    if (!count) {
      current?.remove();
      return;
    }
    const badge = current ?? document.createElement("span");
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
    return this.friends.filter(friend => friend.status === "pending-incoming").length + this.invitations.length;
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
    this.friends = [];
    this.mapPosts = [];
    this.home = null;
    this.invitations = [];
    this.blockedProfiles = [];
    for (const url of this.mediaUrls.values()) URL.revokeObjectURL(url);
    this.mediaUrls.clear();
    this.mediaLoads.clear();
  }
}

function navButton(tab: PortalTab, label: string, active: PortalTab, badge = 0): string {
  return `<button data-social-tab="${tab}" class="${tab === active ? "is-active" : ""}">${label}${badge ? `<span>${badge}</span>` : ""}</button>`;
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

function isPortalTab(value: unknown): value is PortalTab {
  return value === "feed" || value === "friends" || value === "map" || value === "home" || value === "alerts";
}

function isHomeAccess(value: FormDataEntryValue | null): value is BlockHome["accessMode"] {
  return value === "open" || value === "knock" || value === "invite" || value === "dnd" || value === "away";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}
