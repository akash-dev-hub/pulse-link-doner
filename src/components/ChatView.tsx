import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { User } from 'firebase/auth';
import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { ArrowLeft, Ban, Loader2, Send, ShieldOff } from 'lucide-react';
import { ConfirmModal } from './ConfirmModal.tsx';
import { normalizeChatMessage } from '../lib/eligibility.ts';
import { db } from '../lib/firebase.ts';
import type { ChatMessage, ChatThread } from '../types.ts';

interface ChatViewProps {
  user: User;
  myUsername: string;
  chats: ChatThread[];
  chatsLoading: boolean;
  selectedChatId: string | null;
  onSelectChat: (chatId: string | null) => void;
  onNotify: (type: 'success' | 'error', message: string) => void;
}

export function ChatView({
  user,
  myUsername,
  chats,
  chatsLoading,
  selectedChatId,
  onSelectChat,
  onNotify,
}: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [blockingBusy, setBlockingBusy] = useState(false);
  const [confirmBlockOpen, setConfirmBlockOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const sortedChats = useMemo(
    () => [...chats].sort((a, b) => b.updatedAtMs - a.updatedAtMs),
    [chats],
  );

  const activeChat = useMemo(
    () => sortedChats.find((c) => c.id === selectedChatId) || null,
    [sortedChats, selectedChatId],
  );

  // Listen to messages in the active conversation
  useEffect(() => {
    if (!activeChat) {
      setMessages([]);
      setMessagesLoading(false);
      return;
    }

    setMessagesLoading(true);
    const qMsgs = query(
      collection(db, 'chats', activeChat.id, 'messages'),
      where('participantIds', 'array-contains', user.uid),
    );
    const unsub = onSnapshot(
      qMsgs,
      (snap) => {
        const list = snap.docs
          .map((d) => normalizeChatMessage(d.data() as Record<string, unknown>, d.id))
          .sort((a, b) => a.createdAtMs - b.createdAtMs);
        setMessages(list);
        setMessagesLoading(false);
      },
      (err) => {
        console.error('Failed to load chat messages:', err);
        setMessagesLoading(false);
        onNotify('error', 'Could not load messages for this chat.');
      },
    );

    return () => unsub();
  }, [activeChat?.id, user.uid, onNotify]);

  // Auto-mark unread messages as read while viewing the active thread
  useEffect(() => {
    if (!activeChat) return;
    const isP1 = activeChat.p1Uid === user.uid;
    const myUnread = isP1 ? activeChat.p1Unread : activeChat.p2Unread;
    if (myUnread <= 0) return;

    const field = isP1 ? 'p1Unread' : 'p2Unread';
    updateDoc(doc(db, 'chats', activeChat.id), { [field]: 0 }).catch((err) => {
      console.warn('Could not clear unread count:', err);
    });
  }, [activeChat, user.uid]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages.length, activeChat?.id]);

  const getChatMeta = (chat: ChatThread) => {
    const isP1 = chat.p1Uid === user.uid;
    const otherUsername = isP1 ? chat.p2Username : chat.p1Username;
    const myUnread = isP1 ? chat.p1Unread : chat.p2Unread;
    const blockedByMe = isP1 ? chat.blockedByP1 : chat.blockedByP2;
    const blockedByOther = isP1 ? chat.blockedByP2 : chat.blockedByP1;
    return { isP1, otherUsername, myUnread, blockedByMe, blockedByOther };
  };

  const handleSend = async (e: FormEvent) => {
    e.preventDefault();
    if (!activeChat) return;
    const text = draft.trim();
    if (!text) return;

    const meta = getChatMeta(activeChat);
    if (meta.blockedByMe || meta.blockedByOther) {
      onNotify('error', 'Messages cannot be sent while a block is active.');
      return;
    }

    setSending(true);
    try {
      const msgRef = doc(collection(db, 'chats', activeChat.id, 'messages'));
      const chatRef = doc(db, 'chats', activeChat.id);
      const batch = writeBatch(db);

      batch.set(msgRef, {
        chatId: activeChat.id,
        participantIds: activeChat.participantIds,
        senderId: user.uid,
        senderUsername: myUsername,
        text: text.slice(0, 1000),
        createdAt: serverTimestamp(),
      });

      const unreadUpdates = meta.isP1
        ? { p1Unread: 0, p2Unread: activeChat.p2Unread + 1 }
        : { p2Unread: 0, p1Unread: activeChat.p1Unread + 1 };

      batch.update(chatRef, {
        lastMessageText: text.slice(0, 1000),
        lastMessageSenderId: user.uid,
        lastMessageAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        ...unreadUpdates,
      });

      await batch.commit();
      setDraft('');
    } catch (err) {
      console.error('Failed to send message:', err);
      onNotify('error', 'Could not send message. Please try again.');
    } finally {
      setSending(false);
    }
  };

  const handleToggleBlock = async (blockValue: boolean) => {
    if (!activeChat) return;
    const meta = getChatMeta(activeChat);
    const blockField = meta.isP1 ? 'blockedByP1' : 'blockedByP2';

    setBlockingBusy(true);
    try {
      await updateDoc(doc(db, 'chats', activeChat.id), {
        [blockField]: blockValue,
        updatedAt: serverTimestamp(),
      });
      setConfirmBlockOpen(false);
      onNotify(
        'success',
        blockValue
          ? `@${meta.otherUsername} blocked`
          : `@${meta.otherUsername} unblocked`,
      );
    } catch (err) {
      console.error('Failed to update block status:', err);
      onNotify('error', 'Could not update block setting right now.');
    } finally {
      setBlockingBusy(false);
    }
  };

  const activeMeta = activeChat ? getChatMeta(activeChat) : null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
          Messages
        </h1>
        <p className="text-sm text-slate-600 mt-1">
          Private one-to-one chat. Only usernames are shown—never real names, phone numbers, or emails.
        </p>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden grid grid-cols-1 md:grid-cols-12 min-h-[480px] max-h-[72vh]">
        {/* Inbox Sidebar */}
        <aside
          className={`md:col-span-4 border-b md:border-b-0 md:border-r border-slate-200 flex flex-col overflow-hidden ${
            activeChat ? 'hidden md:flex' : 'flex'
          }`}
        >
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
            <h2 className="text-xs font-semibold text-slate-700 uppercase tracking-wide">
              Inbox ({sortedChats.length})
            </h2>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
            {chatsLoading ? (
              <div className="p-4 space-y-3">
                <div className="h-12 bg-slate-100 rounded-lg" />
                <div className="h-12 bg-slate-100 rounded-lg" />
              </div>
            ) : sortedChats.length === 0 ? (
              <div className="p-6 text-center space-y-2">
                <p className="text-sm font-medium text-slate-900">No conversations yet</p>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Find a donor in Search or on the Map and tap Message to start a private chat.
                </p>
              </div>
            ) : (
              sortedChats.map((chat) => {
                const meta = getChatMeta(chat);
                const isSelected = activeChat?.id === chat.id;
                const timeText = chat.lastMessageAtMs
                  ? new Date(chat.lastMessageAtMs).toLocaleTimeString(undefined, {
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : '';

                return (
                  <button
                    key={chat.id}
                    type="button"
                    onClick={() => onSelectChat(chat.id)}
                    className={`w-full text-left px-4 py-3.5 transition-colors flex items-start justify-between gap-3 ${
                      isSelected ? 'bg-red-50' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono-tabular text-sm font-semibold text-slate-900 truncate">
                          @{meta.otherUsername}
                        </span>
                        {(meta.blockedByMe || meta.blockedByOther) && (
                          <span className="text-[11px] font-medium text-red-700">
                            Blocked
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-600 truncate mt-0.5">
                        {chat.lastMessageText || 'No messages yet'}
                      </p>
                    </div>

                    <div className="flex flex-col items-end gap-1 shrink-0">
                      {timeText && (
                        <span className="text-[11px] text-slate-400 font-mono-tabular">
                          {timeText}
                        </span>
                      )}
                      {meta.myUnread > 0 && (
                        <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-red-600 text-white font-mono-tabular text-[11px] font-bold flex items-center justify-center">
                          {meta.myUnread > 99 ? '99+' : meta.myUnread}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* Active Conversation */}
        <section
          className={`md:col-span-8 flex flex-col overflow-hidden bg-slate-50 ${
            activeChat ? 'flex' : 'hidden md:flex'
          }`}
        >
          {!activeChat || !activeMeta ? (
            <div className="flex-1 flex items-center justify-center p-6 text-center">
              <div className="max-w-xs space-y-1.5">
                <p className="text-sm font-semibold text-slate-900">Select a conversation</p>
                <p className="text-xs text-slate-600">
                  Pick a thread from your inbox or message a donor from Search or Map.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="px-4 py-3 bg-white border-b border-slate-200 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <button
                    type="button"
                    onClick={() => onSelectChat(null)}
                    aria-label="Back to inbox"
                    className="md:hidden p-1.5 -ml-1 text-slate-600 hover:text-slate-900 rounded-lg"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                  <div className="min-w-0">
                    <p className="font-mono-tabular text-sm font-semibold text-slate-900 truncate">
                      @{activeMeta.otherUsername}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      In-app donor chat
                    </p>
                  </div>
                </div>

                {activeMeta.blockedByMe ? (
                  <button
                    type="button"
                    disabled={blockingBusy}
                    onClick={() => void handleToggleBlock(false)}
                    className="min-h-[36px] px-3 py-1.5 text-xs font-semibold text-slate-900 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-lg flex items-center gap-1.5 shrink-0"
                  >
                    <ShieldOff className="w-3.5 h-3.5" />
                    Unblock user
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={blockingBusy}
                    onClick={() => setConfirmBlockOpen(true)}
                    className="min-h-[36px] px-3 py-1.5 text-xs font-semibold text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 disabled:opacity-50 rounded-lg flex items-center gap-1.5 shrink-0"
                  >
                    <Ban className="w-3.5 h-3.5" />
                    Block user
                  </button>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {messagesLoading ? (
                  <div className="py-8 text-center text-xs text-slate-500">
                    Loading messages...
                  </div>
                ) : messages.length === 0 ? (
                  <div className="py-8 text-center text-xs text-slate-500">
                    Say hello to @{activeMeta.otherUsername}. Share only what you feel comfortable sharing.
                  </div>
                ) : (
                  messages.map((msg) => {
                    const isMine = msg.senderId === user.uid;
                    const timeStr = msg.createdAtMs
                      ? new Date(msg.createdAtMs).toLocaleTimeString(undefined, {
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : '';
                    return (
                      <div
                        key={msg.id}
                        className={`flex flex-col ${isMine ? 'items-end' : 'items-start'}`}
                      >
                        <div
                          className={`max-w-[82%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed break-words ${
                            isMine
                              ? 'bg-red-600 text-white'
                              : 'bg-white border border-slate-200 text-slate-900'
                          }`}
                        >
                          <p>{msg.text}</p>
                        </div>
                        <span className="mt-1 text-[11px] text-slate-500 font-mono-tabular">
                          @{msg.senderUsername}
                          {timeStr ? ` · ${timeStr}` : ''}
                        </span>
                      </div>
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              {activeMeta.blockedByMe ? (
                <div className="p-3 bg-white border-t border-slate-200 text-center text-xs text-slate-600">
                  You blocked @{activeMeta.otherUsername}. Unblock to send messages again.
                </div>
              ) : activeMeta.blockedByOther ? (
                <div className="p-3 bg-white border-t border-slate-200 text-center text-xs text-red-700">
                  You cannot send messages in this conversation.
                </div>
              ) : (
                <form
                  onSubmit={handleSend}
                  className="p-3 bg-white border-t border-slate-200 flex items-center gap-2"
                >
                  <input
                    type="text"
                    maxLength={1000}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={`Message @${activeMeta.otherUsername}...`}
                    className="flex-1 min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
                  />
                  <button
                    type="submit"
                    disabled={sending || !draft.trim()}
                    className="min-h-[44px] px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg flex items-center gap-1.5 shrink-0 transition-colors"
                  >
                    {sending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Send className="w-4 h-4" />
                    )}
                    <span>Send</span>
                  </button>
                </form>
              )}
            </>
          )}
        </section>
      </div>

      <ConfirmModal
        open={confirmBlockOpen}
        title={activeMeta ? `Block @${activeMeta.otherUsername}?` : 'Block user?'}
        message="They will no longer be able to send you messages in this chat until you unblock them."
        confirmLabel="Block user"
        cancelLabel="Cancel"
        loading={blockingBusy}
        onConfirm={() => void handleToggleBlock(true)}
        onCancel={() => {
          if (!blockingBusy) setConfirmBlockOpen(false);
        }}
      />
    </div>
  );
}
