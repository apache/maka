---
name: websocket-realtime-builder
description: Implements real-time features using WebSockets with Socket.io, rooms, authentication, and reconnection handling. Use when users request "real-time updates", "WebSocket", "Socket.io", "live chat", or "push notifications".
---

# WebSocket Realtime Builder

Build real-time applications with WebSockets and Socket.io.

## Core Workflow

1. **Choose library**: Socket.io vs native WebSocket
2. **Setup server**: Configure WebSocket server
3. **Add authentication**: Validate connections
4. **Implement rooms**: Group connections
5. **Handle events**: Define event handlers
6. **Add reconnection**: Handle disconnects gracefully

## Installation

```bash
# Server
npm install socket.io

# Client
npm install socket.io-client
```

## Server Setup

### Basic Socket.io Server

```typescript
// server.ts
import express from "express";
import { createServer } from "http";
import { Server, Socket } from "socket.io";
import { verifyToken } from "./auth";

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL,
    credentials: true,
  },
  pingInterval: 25000,
  pingTimeout: 60000,
});

// Authentication middleware
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;

  if (!token) {
    return next(new Error("Authentication required"));
  }

  try {
    const user = await verifyToken(token);
    socket.data.user = user;
    next();
  } catch (err) {
    next(new Error("Invalid token"));
  }
});

io.on("connection", (socket: Socket) => {
  const user = socket.data.user;
  console.log(`User connected: ${user.id}`);

  // Join user's personal room
  socket.join(`user:${user.id}`);

  // Handle events
  socket.on("disconnect", () => {
    console.log(`User disconnected: ${user.id}`);
  });
});

httpServer.listen(3001, () => {
  console.log("Socket.io server running on port 3001");
});

export { io };
```

### Namespaces and Rooms

```typescript
// namespaces/chat.ts
import { Server, Socket } from "socket.io";

export function setupChatNamespace(io: Server) {
  const chatNamespace = io.of("/chat");

  chatNamespace.on("connection", (socket: Socket) => {
    const user = socket.data.user;

    // Join a chat room
    socket.on("join-room", async (roomId: string) => {
      // Validate user can access this room
      const canAccess = await canAccessRoom(user.id, roomId);
      if (!canAccess) {
        socket.emit("error", { message: "Access denied" });
        return;
      }

      socket.join(`room:${roomId}`);
      socket.to(`room:${roomId}`).emit("user-joined", {
        userId: user.id,
        name: user.name,
      });
    });

    // Leave a chat room
    socket.on("leave-room", (roomId: string) => {
      socket.leave(`room:${roomId}`);
      socket.to(`room:${roomId}`).emit("user-left", {
        userId: user.id,
      });
    });

    // Send message
    socket.on("send-message", async (data: { roomId: string; content: string }) => {
      const { roomId, content } = data;

      // Save to database
      const message = await db.message.create({
        data: {
          roomId,
          authorId: user.id,
          content,
        },
        include: { author: true },
      });

      // Broadcast to room
      chatNamespace.to(`room:${roomId}`).emit("new-message", {
        id: message.id,
        content: message.content,
        author: {
          id: user.id,
          name: user.name,
        },
        createdAt: message.createdAt,
      });
    });

    // Typing indicator
    socket.on("typing-start", (roomId: string) => {
      socket.to(`room:${roomId}`).emit("user-typing", {
        userId: user.id,
        name: user.name,
      });
    });

    socket.on("typing-stop", (roomId: string) => {
      socket.to(`room:${roomId}`).emit("user-stopped-typing", {
        userId: user.id,
      });
    });
  });

  return chatNamespace;
}
```

### Event Emitters

```typescript
// services/notifications.ts
import { io } from "../server";

export class NotificationService {
  // Send to specific user
  static sendToUser(userId: string, event: string, data: any) {
    io.to(`user:${userId}`).emit(event, data);
  }

  // Send to multiple users
  static sendToUsers(userIds: string[], event: string, data: any) {
    userIds.forEach((userId) => {
      io.to(`user:${userId}`).emit(event, data);
    });
  }

  // Broadcast to all connected users
  static broadcast(event: string, data: any) {
    io.emit(event, data);
  }

  // Send to room
  static sendToRoom(roomId: string, event: string, data: any) {
    io.to(`room:${roomId}`).emit(event, data);
  }

  // Notify new order
  static notifyNewOrder(order: Order) {
    // Notify customer
    this.sendToUser(order.customerId, "order:created", {
      orderId: order.id,
      status: order.status,
    });

    // Notify admins
    io.to("role:admin").emit("admin:new-order", {
      orderId: order.id,
      customer: order.customerName,
      total: order.total,
    });
  }
}
```

## Client Setup

### React Client Hook

```typescript
// hooks/useSocket.ts
import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import { useAuth } from "./useAuth";

interface UseSocketOptions {
  namespace?: string;
  autoConnect?: boolean;
}

export function useSocket(options: UseSocketOptions = {}) {
  const { namespace = "/", autoConnect = true } = options;
  const { token } = useAuth();
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !autoConnect) return;

    const socket = io(`${process.env.NEXT_PUBLIC_WS_URL}${namespace}`, {
      auth: { token },
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    socket.on("connect", () => {
      setIsConnected(true);
      setError(null);
    });

    socket.on("disconnect", () => {
      setIsConnected(false);
    });

    socket.on("connect_error", (err) => {
      setError(err.message);
      setIsConnected(false);
    });

    socketRef.current = socket;

    return () => {
      socket.disconnect();
    };
  }, [token, namespace, autoConnect]);

  const emit = useCallback((event: string, data?: any) => {
    socketRef.current?.emit(event, data);
  }, []);

  const on = useCallback((event: string, handler: (...args: any[]) => void) => {
    socketRef.current?.on(event, handler);
    return () => {
      socketRef.current?.off(event, handler);
    };
  }, []);

  const off = useCallback((event: string, handler?: (...args: any[]) => void) => {
    socketRef.current?.off(event, handler);
  }, []);

  return {
    socket: socketRef.current,
    isConnected,
    error,
    emit,
    on,
    off,
  };
}
```

### Chat Hook

```typescript
// hooks/useChat.ts
import { useEffect, useState, useCallback } from "react";
import { useSocket } from "./useSocket";

interface Message {
  id: string;
  content: string;
  author: { id: string; name: string };
  createdAt: string;
}

interface TypingUser {
  userId: string;
  name: string;
}

export function useChat(roomId: string) {
  const { socket, isConnected, emit, on } = useSocket({ namespace: "/chat" });
  const [messages, setMessages] = useState<Message[]>([]);
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);

  // Join room on connect
  useEffect(() => {
    if (isConnected && roomId) {
      emit("join-room", roomId);

      return () => {
        emit("leave-room", roomId);
      };
    }
  }, [isConnected, roomId, emit]);

  // Listen for messages
  useEffect(() => {
    const unsubMessage = on("new-message", (message: Message) => {
      setMessages((prev) => [...prev, message]);
    });

    const unsubTyping = on("user-typing", (user: TypingUser) => {
      setTypingUsers((prev) => {
        if (prev.some((u) => u.userId === user.userId)) return prev;
        return [...prev, user];
      });
    });

    const unsubStopTyping = on("user-stopped-typing", ({ userId }: { userId: string }) => {
      setTypingUsers((prev) => prev.filter((u) => u.userId !== userId));
    });

    return () => {
      unsubMessage();
      unsubTyping();
      unsubStopTyping();
    };
  }, [on]);

  const sendMessage = useCallback(
    (content: string) => {
      emit("send-message", { roomId, content });
    },
    [emit, roomId],
  );

  const startTyping = useCallback(() => {
    emit("typing-start", roomId);
  }, [emit, roomId]);

  const stopTyping = useCallback(() => {
    emit("typing-stop", roomId);
  }, [emit, roomId]);

  return {
    messages,
    typingUsers,
    sendMessage,
    startTyping,
    stopTyping,
    isConnected,
  };
}
```

### Chat Component

```tsx
// components/ChatRoom.tsx
"use client";

import { useState, useRef, useEffect } from "react";
import { useChat } from "@/hooks/useChat";

export function ChatRoom({ roomId }: { roomId: string }) {
  const { messages, typingUsers, sendMessage, startTyping, stopTyping, isConnected } =
    useChat(roomId);

  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout>();

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInput(e.target.value);

    // Debounced typing indicator
    startTyping();
    clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(stopTyping, 2000);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    sendMessage(input);
    setInput("");
    stopTyping();
  };

  if (!isConnected) {
    return <div>Connecting...</div>;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((message) => (
          <div key={message.id} className="flex gap-2">
            <span className="font-semibold">{message.author.name}:</span>
            <span>{message.content}</span>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {typingUsers.length > 0 && (
        <div className="px-4 py-2 text-sm text-gray-500">
          {typingUsers.map((u) => u.name).join(", ")} {typingUsers.length === 1 ? "is" : "are"}{" "}
          typing...
        </div>
      )}

      <form onSubmit={handleSubmit} className="p-4 border-t">
        <input
          type="text"
          value={input}
          onChange={handleInputChange}
          placeholder="Type a message..."
          className="w-full px-4 py-2 border rounded"
        />
      </form>
    </div>
  );
}
```

## Real-time Notifications

```typescript
// hooks/useNotifications.ts
import { useEffect, useState } from "react";
import { useSocket } from "./useSocket";
import { toast } from "sonner";

interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  createdAt: string;
  read: boolean;
}

export function useNotifications() {
  const { on, isConnected } = useSocket();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    const unsubscribe = on("notification", (notification: Notification) => {
      setNotifications((prev) => [notification, ...prev]);
      setUnreadCount((prev) => prev + 1);

      // Show toast
      toast(notification.title, {
        description: notification.message,
      });
    });

    return unsubscribe;
  }, [on]);

  const markAsRead = (id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    setUnreadCount((prev) => Math.max(0, prev - 1));
  };

  const markAllAsRead = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnreadCount(0);
  };

  return {
    notifications,
    unreadCount,
    markAsRead,
    markAllAsRead,
    isConnected,
  };
}
```

## Presence System

```typescript
// server/presence.ts
import { Server, Socket } from "socket.io";

interface UserPresence {
  odlineserId: string;
  name: string;
  status: "online" | "away" | "busy";
  lastSeen: Date;
}

const onlineUsers = new Map<string, UserPresence>();

export function setupPresence(io: Server) {
  io.on("connection", (socket: Socket) => {
    const user = socket.data.user;

    // User comes online
    onlineUsers.set(user.id, {
      odlineserId: user.id,
      name: user.name,
      status: "online",
      lastSeen: new Date(),
    });

    // Broadcast to all users
    io.emit("presence:update", {
      userId: user.id,
      status: "online",
    });

    // Send current online users to new connection
    socket.emit("presence:list", Array.from(onlineUsers.values()));

    // Handle status changes
    socket.on("presence:status", (status: "online" | "away" | "busy") => {
      const presence = onlineUsers.get(user.id);
      if (presence) {
        presence.status = status;
        io.emit("presence:update", { userId: user.id, status });
      }
    });

    // Handle disconnect
    socket.on("disconnect", () => {
      onlineUsers.delete(user.id);
      io.emit("presence:update", {
        userId: user.id,
        status: "offline",
      });
    });
  });
}
```

## Error Handling & Reconnection

```typescript
// Client-side error handling
const socket = io(WS_URL, {
  auth: { token },
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
  timeout: 20000,
});

socket.on("connect_error", (error) => {
  if (error.message === "Authentication required") {
    // Redirect to login
    router.push("/login");
  } else {
    console.error("Connection error:", error);
  }
});

socket.on("reconnect", (attemptNumber) => {
  console.log(`Reconnected after ${attemptNumber} attempts`);
  // Re-sync state
  socket.emit("sync-state");
});

socket.on("reconnect_failed", () => {
  console.error("Failed to reconnect");
  // Show user notification
  toast.error("Connection lost. Please refresh the page.");
});
```

## Best Practices

1. **Authenticate connections**: Validate tokens on connect
2. **Use rooms**: Group users logically
3. **Handle reconnection**: Re-sync state after reconnect
4. **Debounce events**: Prevent flooding (e.g., typing indicator)
5. **Clean up listeners**: Remove on component unmount
6. **Acknowledge important events**: Confirm critical messages
7. **Use namespaces**: Separate concerns (chat, notifications)
8. **Scale with Redis**: Use Redis adapter for multiple servers

## Output Checklist

Every WebSocket implementation should include:

- [ ] Server with authentication middleware
- [ ] Client hook with reconnection handling
- [ ] Room/namespace organization
- [ ] Event type definitions
- [ ] Error handling and recovery
- [ ] Typing indicators for chat
- [ ] Presence system (online/offline)
- [ ] Clean disconnect handling
- [ ] Rate limiting for events
- [ ] Redis adapter for scaling (production)
