---
name: graphql-schema-designer
description: Designs GraphQL schemas with types, queries, mutations, subscriptions, resolvers, and DataLoader patterns for efficient data fetching. Use when users request "GraphQL API", "schema design", "GraphQL setup", "resolvers", or "Apollo Server".
---

# GraphQL Schema Designer

Build efficient, type-safe GraphQL APIs with proper schema design and resolver patterns.

## Core Workflow

1. **Design schema**: Define types, queries, mutations
2. **Implement resolvers**: Connect to data sources
3. **Add DataLoader**: Batch and cache queries
4. **Enable subscriptions**: Real-time updates
5. **Add validation**: Input validation and errors
6. **Document**: Schema descriptions

## Project Setup

```bash
npm install @apollo/server graphql graphql-tag dataloader
npm install -D @graphql-codegen/cli @graphql-codegen/typescript
```

## Schema Design

### Type Definitions

```graphql
# schema.graphql
scalar DateTime
scalar JSON

"""
A registered user in the system
"""
type User {
  id: ID!
  email: String!
  name: String!
  avatar: String
  role: UserRole!
  posts: [Post!]!
  comments: [Comment!]!
  createdAt: DateTime!
  updatedAt: DateTime!
}

enum UserRole {
  ADMIN
  USER
  GUEST
}

type Post {
  id: ID!
  title: String!
  content: String!
  published: Boolean!
  author: User!
  comments: [Comment!]!
  tags: [Tag!]!
  createdAt: DateTime!
  updatedAt: DateTime!
}

type Comment {
  id: ID!
  content: String!
  author: User!
  post: Post!
  createdAt: DateTime!
}

type Tag {
  id: ID!
  name: String!
  posts: [Post!]!
}

"""
Pagination info for cursor-based pagination
"""
type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}

type PostEdge {
  cursor: String!
  node: Post!
}

type PostConnection {
  edges: [PostEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}
```

### Queries

```graphql
type Query {
  """
  Get current authenticated user
  """
  me: User

  """
  Get a user by ID
  """
  user(id: ID!): User

  """
  List all users with optional filtering
  """
  users(role: UserRole, search: String, limit: Int = 10, offset: Int = 0): [User!]!

  """
  Get a post by ID
  """
  post(id: ID!): Post

  """
  List posts with cursor pagination
  """
  posts(
    first: Int
    after: String
    last: Int
    before: String
    published: Boolean
    authorId: ID
  ): PostConnection!

  """
  Search posts by title or content
  """
  searchPosts(query: String!, limit: Int = 10): [Post!]!
}
```

### Mutations

```graphql
input CreateUserInput {
  email: String!
  name: String!
  password: String!
  role: UserRole = USER
}

input UpdateUserInput {
  name: String
  avatar: String
}

input CreatePostInput {
  title: String!
  content: String!
  published: Boolean = false
  tagIds: [ID!]
}

input UpdatePostInput {
  title: String
  content: String
  published: Boolean
  tagIds: [ID!]
}

type Mutation {
  # Auth
  signUp(input: CreateUserInput!): AuthPayload!
  signIn(email: String!, password: String!): AuthPayload!
  signOut: Boolean!

  # Users
  updateUser(id: ID!, input: UpdateUserInput!): User!
  deleteUser(id: ID!): Boolean!

  # Posts
  createPost(input: CreatePostInput!): Post!
  updatePost(id: ID!, input: UpdatePostInput!): Post!
  deletePost(id: ID!): Boolean!
  publishPost(id: ID!): Post!

  # Comments
  createComment(postId: ID!, content: String!): Comment!
  deleteComment(id: ID!): Boolean!
}

type AuthPayload {
  token: String!
  user: User!
}
```

### Subscriptions

```graphql
type Subscription {
  """
  Subscribe to new posts
  """
  postCreated: Post!

  """
  Subscribe to comments on a specific post
  """
  commentAdded(postId: ID!): Comment!

  """
  Subscribe to post updates
  """
  postUpdated(id: ID!): Post!
}
```

## Resolvers

### Basic Resolver Structure

```typescript
// resolvers/index.ts
import { Resolvers } from "../generated/graphql";
import { userResolvers } from "./user";
import { postResolvers } from "./post";
import { commentResolvers } from "./comment";
import { scalarResolvers } from "./scalars";

export const resolvers: Resolvers = {
  ...scalarResolvers,
  Query: {
    ...userResolvers.Query,
    ...postResolvers.Query,
  },
  Mutation: {
    ...userResolvers.Mutation,
    ...postResolvers.Mutation,
    ...commentResolvers.Mutation,
  },
  Subscription: {
    ...postResolvers.Subscription,
    ...commentResolvers.Subscription,
  },
  User: userResolvers.User,
  Post: postResolvers.Post,
  Comment: commentResolvers.Comment,
};
```

### User Resolvers

```typescript
// resolvers/user.ts
import { Resolvers } from "../generated/graphql";
import { Context } from "../context";

export const userResolvers: Resolvers<Context> = {
  Query: {
    me: async (_, __, { user }) => {
      if (!user) return null;
      return user;
    },

    user: async (_, { id }, { dataSources }) => {
      return dataSources.users.findById(id);
    },

    users: async (_, { role, search, limit, offset }, { dataSources }) => {
      return dataSources.users.findMany({ role, search, limit, offset });
    },
  },

  Mutation: {
    signUp: async (_, { input }, { dataSources }) => {
      const user = await dataSources.users.create(input);
      const token = generateToken(user);
      return { token, user };
    },

    updateUser: async (_, { id, input }, { dataSources, user }) => {
      // Authorization check
      if (user?.id !== id && user?.role !== "ADMIN") {
        throw new ForbiddenError("Not authorized");
      }
      return dataSources.users.update(id, input);
    },
  },

  User: {
    posts: async (parent, _, { loaders }) => {
      return loaders.postsByAuthor.load(parent.id);
    },

    comments: async (parent, _, { loaders }) => {
      return loaders.commentsByAuthor.load(parent.id);
    },
  },
};
```

### Post Resolvers with Pagination

```typescript
// resolvers/post.ts
import { Resolvers } from "../generated/graphql";

export const postResolvers: Resolvers<Context> = {
  Query: {
    post: async (_, { id }, { dataSources }) => {
      return dataSources.posts.findById(id);
    },

    posts: async (_, { first, after, last, before, published, authorId }, { dataSources }) => {
      const { edges, pageInfo, totalCount } = await dataSources.posts.findMany({
        first,
        after,
        last,
        before,
        where: { published, authorId },
      });

      return { edges, pageInfo, totalCount };
    },

    searchPosts: async (_, { query, limit }, { dataSources }) => {
      return dataSources.posts.search(query, limit);
    },
  },

  Mutation: {
    createPost: async (_, { input }, { dataSources, user, pubsub }) => {
      if (!user) throw new AuthenticationError("Must be logged in");

      const post = await dataSources.posts.create({
        ...input,
        authorId: user.id,
      });

      // Publish to subscribers
      pubsub.publish("POST_CREATED", { postCreated: post });

      return post;
    },

    publishPost: async (_, { id }, { dataSources, user }) => {
      const post = await dataSources.posts.findById(id);

      if (post.authorId !== user?.id) {
        throw new ForbiddenError("Not your post");
      }

      return dataSources.posts.update(id, { published: true });
    },
  },

  Subscription: {
    postCreated: {
      subscribe: (_, __, { pubsub }) => pubsub.asyncIterator(["POST_CREATED"]),
    },

    postUpdated: {
      subscribe: (_, { id }, { pubsub }) => {
        return pubsub.asyncIterator([`POST_UPDATED_${id}`]);
      },
    },
  },

  Post: {
    author: async (parent, _, { loaders }) => {
      return loaders.users.load(parent.authorId);
    },

    comments: async (parent, _, { loaders }) => {
      return loaders.commentsByPost.load(parent.id);
    },

    tags: async (parent, _, { loaders }) => {
      return loaders.tagsByPost.load(parent.id);
    },
  },
};
```

## DataLoader Pattern

### Create Loaders

```typescript
// loaders/index.ts
import DataLoader from "dataloader";
import { db } from "../db";

export function createLoaders() {
  return {
    users: new DataLoader<string, User>(async (ids) => {
      const users = await db.user.findMany({
        where: { id: { in: [...ids] } },
      });
      // Return in same order as requested
      return ids.map((id) => users.find((u) => u.id === id)!);
    }),

    postsByAuthor: new DataLoader<string, Post[]>(async (authorIds) => {
      const posts = await db.post.findMany({
        where: { authorId: { in: [...authorIds] } },
      });
      // Group by authorId
      return authorIds.map((authorId) => posts.filter((p) => p.authorId === authorId));
    }),

    commentsByPost: new DataLoader<string, Comment[]>(async (postIds) => {
      const comments = await db.comment.findMany({
        where: { postId: { in: [...postIds] } },
        orderBy: { createdAt: "desc" },
      });
      return postIds.map((postId) => comments.filter((c) => c.postId === postId));
    }),

    tagsByPost: new DataLoader<string, Tag[]>(async (postIds) => {
      const postTags = await db.postTag.findMany({
        where: { postId: { in: [...postIds] } },
        include: { tag: true },
      });
      return postIds.map((postId) =>
        postTags.filter((pt) => pt.postId === postId).map((pt) => pt.tag),
      );
    }),
  };
}

export type Loaders = ReturnType<typeof createLoaders>;
```

### Context Setup

```typescript
// context.ts
import { createLoaders, Loaders } from "./loaders";
import { DataSources } from "./dataSources";
import { PubSub } from "graphql-subscriptions";

export interface Context {
  user: User | null;
  dataSources: DataSources;
  loaders: Loaders;
  pubsub: PubSub;
}

const pubsub = new PubSub();

export async function createContext({ req }): Promise<Context> {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const user = token ? await verifyToken(token) : null;

  return {
    user,
    dataSources: new DataSources(),
    loaders: createLoaders(), // New loaders per request
    pubsub,
  };
}
```

## Apollo Server Setup

```typescript
// server.ts
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import { WebSocketServer } from "ws";
import { useServer } from "graphql-ws/lib/use/ws";
import express from "express";
import http from "http";
import cors from "cors";
import { typeDefs } from "./schema";
import { resolvers } from "./resolvers";
import { createContext } from "./context";

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);

  // WebSocket server for subscriptions
  const wsServer = new WebSocketServer({
    server: httpServer,
    path: "/graphql",
  });

  const serverCleanup = useServer(
    {
      schema,
      context: async (ctx) => createContext(ctx),
    },
    wsServer,
  );

  const server = new ApolloServer({
    typeDefs,
    resolvers,
    plugins: [
      ApolloServerPluginDrainHttpServer({ httpServer }),
      {
        async serverWillStart() {
          return {
            async drainServer() {
              await serverCleanup.dispose();
            },
          };
        },
      },
    ],
  });

  await server.start();

  app.use(
    "/graphql",
    cors(),
    express.json(),
    expressMiddleware(server, {
      context: createContext,
    }),
  );

  httpServer.listen(4000, () => {
    console.log("Server ready at http://localhost:4000/graphql");
  });
}

startServer();
```

## Error Handling

```typescript
// errors.ts
import { GraphQLError } from "graphql";

export class AuthenticationError extends GraphQLError {
  constructor(message: string) {
    super(message, {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }
}

export class ForbiddenError extends GraphQLError {
  constructor(message: string) {
    super(message, {
      extensions: { code: "FORBIDDEN" },
    });
  }
}

export class NotFoundError extends GraphQLError {
  constructor(resource: string) {
    super(`${resource} not found`, {
      extensions: { code: "NOT_FOUND" },
    });
  }
}

export class ValidationError extends GraphQLError {
  constructor(message: string, field?: string) {
    super(message, {
      extensions: {
        code: "BAD_USER_INPUT",
        field,
      },
    });
  }
}
```

## Code Generation

```yaml
# codegen.yml
schema: "./schema.graphql"
generates:
  ./src/generated/graphql.ts:
    plugins:
      - typescript
      - typescript-resolvers
    config:
      contextType: ../context#Context
      mappers:
        User: ../models#UserModel
        Post: ../models#PostModel
      useIndexSignature: true
```

```bash
npx graphql-codegen
```

## Best Practices

1. **Use DataLoader**: Prevent N+1 queries
2. **Design schema first**: API-first approach
3. **Use cursor pagination**: For large datasets
4. **Add descriptions**: Document every type and field
5. **Handle errors properly**: Custom error types
6. **Generate types**: Use codegen for type safety
7. **Validate inputs**: Sanitize before processing
8. **Use subscriptions sparingly**: Only for real-time needs

## Output Checklist

Every GraphQL API should include:

- [ ] Well-designed type definitions
- [ ] Queries with proper filtering/pagination
- [ ] Mutations with input validation
- [ ] DataLoader for batching
- [ ] Custom error types
- [ ] Authentication/authorization
- [ ] Code generation setup
- [ ] Schema documentation
- [ ] Subscription support (if needed)
- [ ] Rate limiting
