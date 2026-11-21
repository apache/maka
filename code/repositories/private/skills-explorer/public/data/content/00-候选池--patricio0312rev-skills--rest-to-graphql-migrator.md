---
name: rest-to-graphql-migrator
description: Migrates REST APIs to GraphQL incrementally with schema stitching, REST datasources, and gradual endpoint migration. Use when users request "migrate to GraphQL", "REST to GraphQL", "GraphQL wrapper", or "API modernization".
---

# REST to GraphQL Migrator

Incrementally migrate REST APIs to GraphQL without breaking existing clients.

## Core Workflow

1. **Analyze REST endpoints**: Document existing API
2. **Design GraphQL schema**: Map REST to types
3. **Create REST data source**: Wrap existing endpoints
4. **Implement resolvers**: Connect to REST
5. **Migrate incrementally**: One endpoint at a time
6. **Deprecate REST**: Gradual sunset

## Migration Strategies

### Strategy Comparison

| Strategy | Best For                        | Complexity |
| -------- | ------------------------------- | ---------- |
| Wrapper  | Quick start, no backend changes | Low        |
| Gradual  | Large APIs, production systems  | Medium     |
| Rewrite  | Greenfield opportunity          | High       |

## REST Data Source Wrapper

### Apollo RESTDataSource

```typescript
// datasources/users.datasource.ts
import { RESTDataSource } from "@apollo/datasource-rest";

export class UsersAPI extends RESTDataSource {
  override baseURL = process.env.REST_API_URL;

  // Add auth header
  override willSendRequest(_path: string, request: AugmentedRequest) {
    request.headers["Authorization"] = this.context.token;
  }

  // GET /api/users
  async getUsers(params?: { page?: number; limit?: number }) {
    const query = new URLSearchParams();
    if (params?.page) query.set("page", String(params.page));
    if (params?.limit) query.set("limit", String(params.limit));

    return this.get<User[]>(`/api/users?${query}`);
  }

  // GET /api/users/:id
  async getUser(id: string) {
    return this.get<User>(`/api/users/${id}`);
  }

  // POST /api/users
  async createUser(input: CreateUserInput) {
    return this.post<User>("/api/users", { body: input });
  }

  // PATCH /api/users/:id
  async updateUser(id: string, input: UpdateUserInput) {
    return this.patch<User>(`/api/users/${id}`, { body: input });
  }

  // DELETE /api/users/:id
  async deleteUser(id: string) {
    await this.delete(`/api/users/${id}`);
    return true;
  }

  // GET /api/users/:id/posts
  async getUserPosts(userId: string) {
    return this.get<Post[]>(`/api/users/${userId}/posts`);
  }
}
```

### Map REST to GraphQL Types

```typescript
// REST Response
interface RESTUser {
  id: number;
  user_name: string;
  email_address: string;
  created_at: string;
  profile_image_url: string | null;
}

// GraphQL Type (camelCase, proper types)
interface User {
  id: string;
  username: string;
  email: string;
  createdAt: Date;
  avatar: string | null;
}

// Transformer
function transformUser(restUser: RESTUser): User {
  return {
    id: String(restUser.id),
    username: restUser.user_name,
    email: restUser.email_address,
    createdAt: new Date(restUser.created_at),
    avatar: restUser.profile_image_url,
  };
}
```

### Data Source with Caching

```typescript
// datasources/products.datasource.ts
export class ProductsAPI extends RESTDataSource {
  override baseURL = process.env.REST_API_URL;

  // Cache for 1 hour
  private cacheOptions = { ttl: 3600 };

  async getProduct(id: string) {
    const data = await this.get<RESTProduct>(`/api/products/${id}`, {
      cacheOptions: this.cacheOptions,
    });
    return transformProduct(data);
  }

  async getProducts(filters: ProductFilters) {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined) params.set(key, String(value));
    });

    const data = await this.get<RESTProduct[]>(`/api/products?${params}`);
    return data.map(transformProduct);
  }

  // Bust cache on mutation
  async updateProduct(id: string, input: UpdateProductInput) {
    const data = await this.patch<RESTProduct>(`/api/products/${id}`, {
      body: transformToREST(input),
    });

    // Invalidate cache
    this.delete(`/api/products/${id}`);

    return transformProduct(data);
  }
}
```

## GraphQL Schema Design

### Schema from REST Endpoints

```graphql
# Map REST endpoints to GraphQL

# REST: GET /api/users
# REST: GET /api/users/:id
# REST: POST /api/users
# REST: PATCH /api/users/:id
# REST: DELETE /api/users/:id

type User {
  id: ID!
  username: String!
  email: String!
  avatar: String
  createdAt: DateTime!
  # Nested resource: GET /api/users/:id/posts
  posts: [Post!]!
  # Nested resource: GET /api/users/:id/comments
  comments: [Comment!]!
}

type Query {
  # GET /api/users
  users(page: Int, limit: Int): [User!]!
  # GET /api/users/:id
  user(id: ID!): User
}

type Mutation {
  # POST /api/users
  createUser(input: CreateUserInput!): User!
  # PATCH /api/users/:id
  updateUser(id: ID!, input: UpdateUserInput!): User!
  # DELETE /api/users/:id
  deleteUser(id: ID!): Boolean!
}

input CreateUserInput {
  username: String!
  email: String!
  password: String!
}

input UpdateUserInput {
  username: String
  email: String
  avatar: String
}
```

## Resolvers with REST Backend

```typescript
// resolvers/user.resolvers.ts
import { Resolvers } from "../generated/types";

export const userResolvers: Resolvers = {
  Query: {
    users: async (_, { page, limit }, { dataSources }) => {
      const users = await dataSources.usersAPI.getUsers({ page, limit });
      return users.map(transformUser);
    },

    user: async (_, { id }, { dataSources }) => {
      try {
        const user = await dataSources.usersAPI.getUser(id);
        return transformUser(user);
      } catch (error) {
        if (error.extensions?.response?.status === 404) {
          return null;
        }
        throw error;
      }
    },
  },

  Mutation: {
    createUser: async (_, { input }, { dataSources }) => {
      const user = await dataSources.usersAPI.createUser(transformInputToREST(input));
      return transformUser(user);
    },

    updateUser: async (_, { id, input }, { dataSources }) => {
      const user = await dataSources.usersAPI.updateUser(id, transformInputToREST(input));
      return transformUser(user);
    },

    deleteUser: async (_, { id }, { dataSources }) => {
      return dataSources.usersAPI.deleteUser(id);
    },
  },

  User: {
    // Resolve nested resources
    posts: async (parent, _, { dataSources }) => {
      const posts = await dataSources.usersAPI.getUserPosts(parent.id);
      return posts.map(transformPost);
    },

    comments: async (parent, _, { dataSources }) => {
      const comments = await dataSources.usersAPI.getUserComments(parent.id);
      return comments.map(transformComment);
    },
  },
};
```

## DataLoader for N+1 Prevention

```typescript
// loaders/user.loader.ts
import DataLoader from 'dataloader';
import { UsersAPI } from '../datasources/users.datasource';

export function createUserLoader(usersAPI: UsersAPI) {
  return new DataLoader<string, User>(async (ids) => {
    // Batch REST calls or use batch endpoint if available
    // Option 1: Parallel individual calls
    const users = await Promise.all(
      ids.map((id) => usersAPI.getUser(id).catch(() => null))
    );
    return ids.map((id) => users.find((u) => u?.id === id) || null);

    // Option 2: Use batch endpoint if available
    // const users = await usersAPI.getUsersByIds([...ids]);
    // return ids.map(id => users.find(u => u.id === id) || null);
  });
}

// Usage in resolver
User: {
  author: async (parent, _, { loaders }) => {
    return loaders.users.load(parent.authorId);
  },
}
```

## Incremental Migration

### Phase 1: Wrapper Layer

```typescript
// Start with GraphQL wrapping REST
// All data still flows through REST API

const server = new ApolloServer({
  typeDefs,
  resolvers,
  dataSources: () => ({
    usersAPI: new UsersAPI(),
    postsAPI: new PostsAPI(),
    commentsAPI: new CommentsAPI(),
  }),
});
```

### Phase 2: Direct Database Access

```typescript
// Migrate critical paths to direct DB
// Keep REST as fallback

const userResolvers: Resolvers = {
  Query: {
    user: async (_, { id }, { dataSources, db }) => {
      // Try direct DB first
      const user = await db.user.findUnique({ where: { id } });
      if (user) return user;

      // Fallback to REST
      return dataSources.usersAPI.getUser(id);
    },
  },
};
```

### Phase 3: Full Migration

```typescript
// All data from database
// REST endpoints deprecated

const userResolvers: Resolvers = {
  Query: {
    user: async (_, { id }, { db }) => {
      return db.user.findUnique({
        where: { id },
      });
    },

    users: async (_, { page = 1, limit = 20 }, { db }) => {
      return db.user.findMany({
        skip: (page - 1) * limit,
        take: limit,
      });
    },
  },

  User: {
    posts: async (parent, _, { loaders }) => {
      return loaders.postsByAuthor.load(parent.id);
    },
  },
};
```

## Error Handling

```typescript
// Map REST errors to GraphQL errors
import { GraphQLError } from 'graphql';

function handleRESTError(error: any): never {
  const status = error.extensions?.response?.status;
  const body = error.extensions?.response?.body;

  switch (status) {
    case 400:
      throw new GraphQLError(body?.message || 'Bad request', {
        extensions: { code: 'BAD_USER_INPUT' },
      });

    case 401:
      throw new GraphQLError('Not authenticated', {
        extensions: { code: 'UNAUTHENTICATED' },
      });

    case 403:
      throw new GraphQLError('Not authorized', {
        extensions: { code: 'FORBIDDEN' },
      });

    case 404:
      throw new GraphQLError('Resource not found', {
        extensions: { code: 'NOT_FOUND' },
      });

    case 409:
      throw new GraphQLError(body?.message || 'Conflict', {
        extensions: { code: 'CONFLICT' },
      });

    default:
      throw new GraphQLError('Internal server error', {
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
      });
  }
}

// Usage in resolver
async getUser(id: string) {
  try {
    return await this.dataSources.usersAPI.getUser(id);
  } catch (error) {
    handleRESTError(error);
  }
}
```

## Schema Stitching

### Combine Multiple REST Services

```typescript
// Stitch multiple REST backends
import { stitchSchemas } from "@graphql-tools/stitch";

const usersSchema = makeExecutableSchema({
  typeDefs: usersTypeDefs,
  resolvers: usersResolvers,
});

const productsSchema = makeExecutableSchema({
  typeDefs: productsTypeDefs,
  resolvers: productsResolvers,
});

const ordersSchema = makeExecutableSchema({
  typeDefs: ordersTypeDefs,
  resolvers: ordersResolvers,
});

const gatewaySchema = stitchSchemas({
  subschemas: [{ schema: usersSchema }, { schema: productsSchema }, { schema: ordersSchema }],
  typeMergingOptions: {
    // Configure type merging
  },
});
```

## Deprecation Strategy

```graphql
type Query {
  # Old endpoint - deprecated
  getUser(id: ID!): User @deprecated(reason: "Use user(id:) instead")

  # New endpoint
  user(id: ID!): User
}

type User {
  # Deprecated field with migration path
  userName: String @deprecated(reason: "Use username instead")
  username: String!
}
```

## Best Practices

1. **Start with wrapper**: Don't rewrite, wrap
2. **Migrate incrementally**: One endpoint at a time
3. **Use DataLoader**: Prevent N+1 queries
4. **Transform data shapes**: Improve API design
5. **Add caching**: Reduce REST API calls
6. **Handle errors properly**: Map REST errors to GraphQL
7. **Deprecate gradually**: Give clients time to migrate
8. **Monitor both**: Track REST and GraphQL usage

## Output Checklist

Every REST to GraphQL migration should include:

- [ ] REST endpoints documented
- [ ] GraphQL schema designed
- [ ] RESTDataSource implementations
- [ ] Data transformers (REST ↔ GraphQL)
- [ ] DataLoader for batching
- [ ] Error handling and mapping
- [ ] Caching strategy
- [ ] Incremental migration plan
- [ ] Deprecation annotations
- [ ] Client migration guide
