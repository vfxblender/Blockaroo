import type { DirectMessage, FriendConnection } from "./types";

export interface NeighborhoodThread {
  friend: FriendConnection;
  messages: DirectMessage[];
  lastMessage: DirectMessage | null;
  unreadCount: number;
}

export function messagesWithFriend(
  messages: readonly DirectMessage[],
  currentUserId: string,
  friendUserId: string,
): DirectMessage[] {
  return messages
    .filter(message => (
      (message.senderId === currentUserId && message.recipientId === friendUserId)
      || (message.senderId === friendUserId && message.recipientId === currentUserId)
    ))
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

export function buildNeighborhoodThreads(
  friends: readonly FriendConnection[],
  messages: readonly DirectMessage[],
  currentUserId: string,
): NeighborhoodThread[] {
  return friends
    .filter(friend => friend.status === "accepted")
    .map(friend => {
      const threadMessages = messagesWithFriend(messages, currentUserId, friend.userId);
      const lastMessage = threadMessages.at(-1) ?? null;
      return {
        friend,
        messages: threadMessages,
        lastMessage,
        unreadCount: threadMessages.filter(message => (
          message.senderId === friend.userId
          && message.recipientId === currentUserId
          && !message.readAt
        )).length,
      };
    })
    .sort((left, right) => {
      const leftTime = left.lastMessage ? Date.parse(left.lastMessage.createdAt) : Date.parse(left.friend.since);
      const rightTime = right.lastMessage ? Date.parse(right.lastMessage.createdAt) : Date.parse(right.friend.since);
      return rightTime - leftTime;
    });
}

export function recentHouseBlocks(
  messages: readonly DirectMessage[],
  maximum = 10,
): DirectMessage[] {
  return messages.slice(-Math.max(1, maximum));
}
