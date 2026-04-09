# LMS Chat Server

Production-ready real-time chat server for the LMS platform.

**Stack:** Node.js · Socket.IO · Redis · MySQL (shared with Laravel) · Sanctum auth

---

## Architecture

```
React Native / Web
       │
       │  WebSocket (Socket.IO)
       ▼
┌─────────────────────────────────────────────┐
│           LMS Chat Server (Node.js)          │
│                                             │
│  authenticate.js   ← Sanctum token (sha256) │
│  connectionHandler ← join/leave/presence    │
│  messageHandler    ← send/edit/delete       │
│  reactionHandler   ← emoji toggle           │
│  typingHandler     ← typing indicators      │
│  readHandler       ← read receipts          │
│  adminHandler      ← pin/mute (admin only)  │
└───────────┬─────────────────────────────────┘
            │
    ┌───────┴────────┐
    │                │
  Redis            MySQL
  ├ Token cache     ├ personal_access_tokens  (read)
  ├ Membership      ├ users                   (read)
  ├ Presence        ├ chat_groups             (read/write)
  ├ Typing          ├ chat_group_members      (read/write)
  ├ Rate limit      ├ chat_messages           (read/write)
  └ Pub/Sub adapter ├ chat_message_reactions  (read/write)
                    ├ chat_message_reads      (read/write)
                    └ chat_message_attachments(read)
```

> **Attachments** (images, PDFs, docs) are uploaded through Laravel's HTTP API.
> Node.js only writes text messages and reads attachment metadata.

---

## Folder Structure

```
lms-chat-server/
├── src/
│   ├── config/
│   │   ├── env.js          # Validated env config
│   │   ├── db.js           # MySQL pool (mysql2/promise)
│   │   └── redis.js        # Three Redis clients (cmd / pub / sub)
│   │
│   ├── middleware/
│   │   └── authenticate.js # Sanctum sha256 token validation
│   │
│   ├── services/
│   │   ├── membershipService.js  # Group membership + role checks (cached)
│   │   ├── presenceService.js    # Online/offline tracking via Redis hashes
│   │   ├── typingService.js      # Typing indicators with TTL auto-expiry
│   │   ├── rateLimitService.js   # Per-user per-group rate limiting
│   │   └── messageService.js     # MySQL R/W for messages, reactions, reads
│   │
│   ├── handlers/
│   │   ├── connectionHandler.js  # group:join/leave, heartbeat, disconnect
│   │   ├── messageHandler.js     # message:send/edit/delete
│   │   ├── reactionHandler.js    # reaction:toggle
│   │   ├── typingHandler.js      # typing:start/stop
│   │   ├── readHandler.js        # read:markUpTo
│   │   └── adminHandler.js       # group:pin/unpin, member:mute/unmute
│   │
│   ├── utils/
│   │   ├── logger.js       # Winston structured logger
│   │   └── redisKeys.js    # Centralized Redis key factory
│   │
│   └── server.js           # Entry point — IO setup, adapters, startup
│
├── logs/                   # Auto-created on first run
├── .env.example
├── package.json
└── README.md
```

---

## Setup

```bash
cp .env.example .env
# Edit .env with your MySQL and Redis credentials

npm install
npm start          # production
npm run dev        # development (nodemon)
```

---

## Sanctum Token Validation

Laravel Sanctum tokens follow the format `{id}|{plainToken}`.  
Laravel stores only `sha256(plainToken)` in `personal_access_tokens.token`.

This server:

1. Parses `{id}|{plainToken}` from `socket.handshake.auth.token`
2. Hashes `plainToken` with `crypto.createHash('sha256')`
3. Queries `personal_access_tokens WHERE id = ? AND token = ?`
4. Checks `users.is_active = 1`
5. Caches the result in Redis for `TOKEN_CACHE_TTL` seconds

---

## Client Usage (React Native)

```js
import { io } from "socket.io-client";

const socket = io("wss://chat.your-app.com", {
  auth: { token: sanctumToken }, // "<id>|<plain>" from Laravel login
  transports: ["websocket"],
});

// Join a group
socket.emit("group:join", { groupId: 5 }, (res) => {
  if (res.ok) console.log("Joined", res.role, "unread:", res.unreadCount);
});

// Send a message
socket.emit(
  "message:send",
  {
    groupId: 5,
    type: "text",
    text: "Hello class!",
  },
  (res) => console.log(res),
);

// Listen for incoming messages
socket.on("message:new", (msg) => {
  console.log(msg.sender.name, ":", msg.text);
  // Mark as read
  socket.emit("read:markUpTo", { groupId: msg.groupId, lastMessageId: msg.id });
});

// Typing
inputRef.onFocus = () => socket.emit("typing:start", { groupId: 5 });
inputRef.onBlur = () => socket.emit("typing:stop", { groupId: 5 });
socket.on("typing:update", ({ typists }) => setTypists(typists));

// Reactions
socket.emit("reaction:toggle", { messageId: 99, emoji: "👍" });
socket.on("reaction:updated", ({ messageId, reactions }) =>
  updateUI(reactions),
);

// Presence
socket.on("presence:joined", ({ user }) =>
  console.log(user.name, "came online"),
);
socket.on("presence:left", ({ user }) =>
  console.log(user.name, "went offline"),
);

// Heartbeat (keep presence alive)
setInterval(() => socket.emit("heartbeat"), 60_000);
```

---

## Socket Events Reference

### Client → Server

| Event             | Payload                                       | Description                   |
| ----------------- | --------------------------------------------- | ----------------------------- |
| `group:join`      | `{ groupId }`                                 | Join a group room             |
| `group:leave`     | `{ groupId }`                                 | Leave a group room            |
| `heartbeat`       | —                                             | Refresh presence TTL          |
| `presence:get`    | `{ groupId }`                                 | Get online members            |
| `message:send`    | `{ groupId, type, text, replyToId? }`         | Send message                  |
| `message:edit`    | `{ messageId, text }`                         | Edit own message              |
| `message:delete`  | `{ messageId }`                               | Delete message                |
| `reaction:toggle` | `{ messageId, emoji }`                        | Toggle reaction               |
| `typing:start`    | `{ groupId }`                                 | Start typing indicator        |
| `typing:stop`     | `{ groupId }`                                 | Stop typing indicator         |
| `read:markUpTo`   | `{ groupId, lastMessageId }`                  | Bulk mark read                |
| `group:pin`       | `{ groupId, messageId }`                      | Pin message (admin/teacher)   |
| `group:unpin`     | `{ groupId }`                                 | Unpin message (admin/teacher) |
| `member:mute`     | `{ groupId, targetUserId, durationMinutes? }` | Mute member (admin)           |
| `member:unmute`   | `{ groupId, targetUserId }`                   | Unmute member (admin)         |

### Server → Client (broadcasts)

| Event              | Payload                                            | Description          |
| ------------------ | -------------------------------------------------- | -------------------- |
| `message:new`      | Full message object                                | New message in group |
| `message:edited`   | `{ messageId, text, editedAt, groupId }`           | Message edited       |
| `message:deleted`  | `{ messageId, groupId, deletedBy }`                | Message deleted      |
| `reaction:updated` | `{ messageId, groupId, emoji, action, reactions }` | Reaction changed     |
| `typing:update`    | `{ groupId, typists[] }`                           | Typing list changed  |
| `read:receipt`     | `{ groupId, userId, userName, lastMessageId }`     | User read messages   |
| `presence:joined`  | `{ groupId, user }`                                | User came online     |
| `presence:left`    | `{ groupId, user }`                                | User went offline    |
| `group:pinned`     | `{ groupId, messageId, pinnedBy }`                 | Message pinned       |
| `group:unpinned`   | `{ groupId }`                                      | Message unpinned     |
| `member:muted`     | `{ groupId, targetUserId, mutedUntil, mutedBy }`   | Member muted         |
| `member:unmuted`   | `{ groupId, targetUserId, unmutedBy }`             | Member unmuted       |

---

## Redis Key Namespace

All keys prefixed `lms:chat:` to avoid collision with Laravel cache/sessions.

| Key Pattern                       | Type   | TTL    | Purpose                 |
| --------------------------------- | ------ | ------ | ----------------------- |
| `lms:chat:token:{hash}`           | STRING | 5 min  | Sanctum token cache     |
| `lms:chat:membership:{gid}:{uid}` | STRING | 10 min | Membership + role cache |
| `lms:chat:presence:group:{gid}`   | HASH   | 20 min | Online users per group  |
| `lms:chat:presence:user:{uid}`    | STRING | 2 min  | User's active groups    |
| `lms:chat:sockets:user:{uid}`     | SET    | 20 min | Multi-tab socket IDs    |
| `lms:chat:typing:{gid}`           | HASH   | 10s    | Typing indicators       |
| `lms:chat:rate:{uid}:{gid}`       | STRING | 60s    | Rate limit counter      |

---

## Permission Matrix

| Action             | Student           | Teacher | Admin |
| ------------------ | ----------------- | ------- | ----- |
| Join group         | ✅                | ✅      | ✅    |
| Send text message  | ✅ (unless muted) | ✅      | ✅    |
| Send announcement  | ❌                | ✅      | ✅    |
| Edit own message   | ✅                | ✅      | ✅    |
| Delete own message | ✅                | ✅      | ✅    |
| Delete any message | ❌                | ❌      | ✅    |
| React to message   | ✅                | ✅      | ✅    |
| Pin message        | ❌                | ✅      | ✅    |
| Mute member        | ❌                | ❌      | ✅    |
| Unmute member      | ❌                | ❌      | ✅    |

---

## Production Deployment

### PM2 (recommended)

```bash
npm install -g pm2
pm2 start src/server.js --name lms-chat -i max   # cluster mode, all CPU cores
pm2 save
pm2 startup
```

### Nginx WebSocket proxy

```nginx
location /socket.io/ {
    proxy_pass         http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade $http_upgrade;
    proxy_set_header   Connection "upgrade";
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_read_timeout 86400s;
}
```

### Invalidating membership cache from Laravel

When Laravel changes group membership (via observer), call this Redis command to force the next Socket.IO check to re-query MySQL:

```php
// In a Laravel Service or Observer:
Redis::del("lms:chat:membership:{$groupId}:{$userId}");
```

Or use the dedicated internal HTTP endpoint (add one in Node.js if needed) — or just let the TTL expire naturally (10 min).
