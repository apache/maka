---
name: vector-db-setup
description: Sets up vector databases for semantic search including Pinecone, Chroma, pgvector, and Qdrant with embedding generation and similarity search. Use when users request "vector database", "semantic search", "embeddings storage", "Pinecone setup", or "similarity search".
---

# Vector Database Setup

Configure vector databases for semantic search and AI applications.

## Core Workflow

1. **Choose database**: Select based on requirements
2. **Setup connection**: Configure client
3. **Generate embeddings**: Create vector representations
4. **Index documents**: Store with metadata
5. **Query vectors**: Semantic similarity search
6. **Optimize**: Tune for performance

## Database Comparison

| Database | Type            | Best For           | Scaling       |
| -------- | --------------- | ------------------ | ------------- |
| Pinecone | Managed         | Production, no ops | Automatic     |
| Chroma   | Embedded/Server | Development, local | Manual        |
| pgvector | PostgreSQL ext  | Existing Postgres  | With Postgres |
| Qdrant   | Self-hosted     | Full control       | Manual        |
| Weaviate | Managed/Self    | GraphQL-like API   | Both          |

## Embeddings Generation

### OpenAI Embeddings

```typescript
// embeddings/openai.ts
import OpenAI from "openai";

const openai = new OpenAI();

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small", // or text-embedding-3-large
    input: text,
  });

  return response.data[0].embedding;
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: texts,
  });

  return response.data.map((d) => d.embedding);
}
```

### Batch Processing

```typescript
// embeddings/batch.ts
const BATCH_SIZE = 100;

export async function batchGenerateEmbeddings(texts: string[]): Promise<number[][]> {
  const embeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchEmbeddings = await generateEmbeddings(batch);
    embeddings.push(...batchEmbeddings);

    // Rate limiting
    if (i + BATCH_SIZE < texts.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return embeddings;
}
```

## Pinecone Setup

### Installation & Config

```bash
npm install @pinecone-database/pinecone
```

```typescript
// db/pinecone.ts
import { Pinecone } from "@pinecone-database/pinecone";

const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY!,
});

// Get or create index
export async function getIndex(indexName: string) {
  const indexes = await pinecone.listIndexes();

  if (!indexes.indexes?.find((i) => i.name === indexName)) {
    await pinecone.createIndex({
      name: indexName,
      dimension: 1536, // OpenAI embedding dimension
      metric: "cosine",
      spec: {
        serverless: {
          cloud: "aws",
          region: "us-east-1",
        },
      },
    });

    // Wait for index to be ready
    await new Promise((resolve) => setTimeout(resolve, 60000));
  }

  return pinecone.Index(indexName);
}
```

### Upsert & Query

```typescript
// db/pinecone-ops.ts
import { getIndex } from "./pinecone";
import { generateEmbedding, generateEmbeddings } from "../embeddings/openai";

const index = await getIndex("my-index");

interface Document {
  id: string;
  content: string;
  metadata: Record<string, any>;
}

// Upsert documents
export async function upsertDocuments(documents: Document[], namespace = "default") {
  const embeddings = await generateEmbeddings(documents.map((d) => d.content));

  const vectors = documents.map((doc, i) => ({
    id: doc.id,
    values: embeddings[i],
    metadata: {
      content: doc.content,
      ...doc.metadata,
    },
  }));

  // Upsert in batches
  const BATCH_SIZE = 100;
  for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
    const batch = vectors.slice(i, i + BATCH_SIZE);
    await index.namespace(namespace).upsert(batch);
  }
}

// Query similar documents
export async function querySimilar(
  query: string,
  options: {
    topK?: number;
    namespace?: string;
    filter?: Record<string, any>;
  } = {},
) {
  const { topK = 5, namespace = "default", filter } = options;

  const queryEmbedding = await generateEmbedding(query);

  const results = await index.namespace(namespace).query({
    vector: queryEmbedding,
    topK,
    includeMetadata: true,
    filter,
  });

  return results.matches?.map((match) => ({
    id: match.id,
    score: match.score,
    content: match.metadata?.content,
    metadata: match.metadata,
  }));
}

// Delete documents
export async function deleteDocuments(ids: string[], namespace = "default") {
  await index.namespace(namespace).deleteMany(ids);
}

// Delete by filter
export async function deleteByFilter(filter: Record<string, any>, namespace = "default") {
  await index.namespace(namespace).deleteMany({ filter });
}
```

## Chroma Setup

### Installation & Config

```bash
npm install chromadb
```

```typescript
// db/chroma.ts
import { ChromaClient, OpenAIEmbeddingFunction } from "chromadb";

const client = new ChromaClient({
  path: process.env.CHROMA_URL || "http://localhost:8000",
});

const embedder = new OpenAIEmbeddingFunction({
  openai_api_key: process.env.OPENAI_API_KEY!,
  openai_model: "text-embedding-3-small",
});

export async function getCollection(name: string) {
  return client.getOrCreateCollection({
    name,
    embeddingFunction: embedder,
    metadata: { "hnsw:space": "cosine" },
  });
}
```

### Chroma Operations

```typescript
// db/chroma-ops.ts
import { getCollection } from "./chroma";

const collection = await getCollection("documents");

// Add documents (Chroma generates embeddings)
export async function addDocuments(documents: Document[]) {
  await collection.add({
    ids: documents.map((d) => d.id),
    documents: documents.map((d) => d.content),
    metadatas: documents.map((d) => d.metadata),
  });
}

// Query
export async function query(queryText: string, nResults = 5) {
  const results = await collection.query({
    queryTexts: [queryText],
    nResults,
  });

  return results.ids[0].map((id, i) => ({
    id,
    content: results.documents?.[0][i],
    metadata: results.metadatas?.[0][i],
    distance: results.distances?.[0][i],
  }));
}

// Query with filter
export async function queryWithFilter(
  queryText: string,
  filter: Record<string, any>,
  nResults = 5,
) {
  const results = await collection.query({
    queryTexts: [queryText],
    nResults,
    where: filter,
  });

  return results;
}

// Update document
export async function updateDocument(id: string, content: string, metadata?: Record<string, any>) {
  await collection.update({
    ids: [id],
    documents: [content],
    metadatas: metadata ? [metadata] : undefined,
  });
}

// Delete
export async function deleteDocuments(ids: string[]) {
  await collection.delete({ ids });
}
```

## pgvector Setup

### Installation

```bash
npm install pg pgvector
```

```sql
-- Enable extension
CREATE EXTENSION vector;

-- Create table
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  metadata JSONB,
  embedding vector(1536),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create index for similarity search
CREATE INDEX ON documents USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Or use HNSW (better for production)
CREATE INDEX ON documents USING hnsw (embedding vector_cosine_ops);
```

### pgvector Operations

```typescript
// db/pgvector.ts
import { Pool } from "pg";
import pgvector from "pgvector/pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Register pgvector type
await pgvector.registerType(pool);

// Insert document
export async function insertDocument(
  content: string,
  embedding: number[],
  metadata?: Record<string, any>,
) {
  const result = await pool.query(
    `INSERT INTO documents (content, embedding, metadata)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [content, pgvector.toSql(embedding), metadata],
  );

  return result.rows[0].id;
}

// Similarity search
export async function searchSimilar(queryEmbedding: number[], limit = 5, threshold = 0.7) {
  const result = await pool.query(
    `SELECT id, content, metadata,
            1 - (embedding <=> $1) as similarity
     FROM documents
     WHERE 1 - (embedding <=> $1) > $2
     ORDER BY embedding <=> $1
     LIMIT $3`,
    [pgvector.toSql(queryEmbedding), threshold, limit],
  );

  return result.rows;
}

// Search with metadata filter
export async function searchWithFilter(
  queryEmbedding: number[],
  filter: Record<string, any>,
  limit = 5,
) {
  const result = await pool.query(
    `SELECT id, content, metadata,
            1 - (embedding <=> $1) as similarity
     FROM documents
     WHERE metadata @> $2
     ORDER BY embedding <=> $1
     LIMIT $3`,
    [pgvector.toSql(queryEmbedding), filter, limit],
  );

  return result.rows;
}

// Hybrid search (vector + full-text)
export async function hybridSearch(queryEmbedding: number[], textQuery: string, limit = 5) {
  const result = await pool.query(
    `SELECT id, content, metadata,
            (1 - (embedding <=> $1)) * 0.7 +
            ts_rank(to_tsvector(content), plainto_tsquery($2)) * 0.3 as score
     FROM documents
     WHERE to_tsvector(content) @@ plainto_tsquery($2)
        OR 1 - (embedding <=> $1) > 0.5
     ORDER BY score DESC
     LIMIT $3`,
    [pgvector.toSql(queryEmbedding), textQuery, limit],
  );

  return result.rows;
}
```

## Qdrant Setup

```bash
npm install @qdrant/js-client-rest
```

```typescript
// db/qdrant.ts
import { QdrantClient } from "@qdrant/js-client-rest";

const client = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
});

// Create collection
export async function createCollection(name: string) {
  await client.createCollection(name, {
    vectors: {
      size: 1536,
      distance: "Cosine",
    },
  });
}

// Upsert points
export async function upsertPoints(
  collection: string,
  points: Array<{
    id: string;
    vector: number[];
    payload: Record<string, any>;
  }>,
) {
  await client.upsert(collection, {
    points: points.map((p) => ({
      id: p.id,
      vector: p.vector,
      payload: p.payload,
    })),
  });
}

// Search
export async function search(
  collection: string,
  vector: number[],
  limit = 5,
  filter?: Record<string, any>,
) {
  const results = await client.search(collection, {
    vector,
    limit,
    filter: filter
      ? {
          must: Object.entries(filter).map(([key, value]) => ({
            key,
            match: { value },
          })),
        }
      : undefined,
    with_payload: true,
  });

  return results;
}
```

## Document Processing Pipeline

```typescript
// pipeline/ingest.ts
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { generateEmbeddings } from "../embeddings/openai";
import { upsertDocuments } from "../db/pinecone-ops";

interface RawDocument {
  id: string;
  content: string;
  source: string;
  metadata?: Record<string, any>;
}

export async function ingestDocuments(documents: RawDocument[]) {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });

  const chunks: Array<{
    id: string;
    content: string;
    metadata: Record<string, any>;
  }> = [];

  for (const doc of documents) {
    const splits = await splitter.splitText(doc.content);

    splits.forEach((text, index) => {
      chunks.push({
        id: `${doc.id}-chunk-${index}`,
        content: text,
        metadata: {
          source: doc.source,
          documentId: doc.id,
          chunkIndex: index,
          ...doc.metadata,
        },
      });
    });
  }

  // Upsert in batches
  await upsertDocuments(chunks);

  return { totalChunks: chunks.length };
}
```

## Best Practices

1. **Choose the right dimension**: Match embedding model
2. **Use namespaces**: Organize data logically
3. **Add metadata**: Enable filtering
4. **Batch operations**: Reduce API calls
5. **Index appropriately**: HNSW for speed, IVF for memory
6. **Monitor performance**: Track latency and recall
7. **Cache embeddings**: Avoid regenerating
8. **Use hybrid search**: Combine vector and keyword

## Output Checklist

Every vector database setup should include:

- [ ] Database client configured
- [ ] Embedding generation function
- [ ] Collection/index creation
- [ ] Document upsert with metadata
- [ ] Similarity search function
- [ ] Filtered search capability
- [ ] Batch processing for large datasets
- [ ] Delete/update operations
- [ ] Error handling
- [ ] Performance monitoring
