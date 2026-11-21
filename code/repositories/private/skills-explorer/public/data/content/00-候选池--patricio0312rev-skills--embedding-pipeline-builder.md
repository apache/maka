---
name: embedding-pipeline-builder
description: Builds document embedding pipelines with text chunking, embedding generation, indexing, and retrieval optimization. Use when users request "embedding pipeline", "document indexing", "text chunking", "RAG preprocessing", or "semantic indexing".
---

# Embedding Pipeline Builder

Build production-ready document embedding and retrieval pipelines.

## Core Workflow

1. **Load documents**: Ingest from various sources
2. **Preprocess text**: Clean and normalize
3. **Chunk documents**: Split into optimal sizes
4. **Generate embeddings**: Create vector representations
5. **Index vectors**: Store in vector database
6. **Optimize retrieval**: Tune for accuracy

## Pipeline Architecture

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Loader    │───▶│ Preprocessor │───▶│   Chunker   │
└─────────────┘    └─────────────┘    └─────────────┘
                                            │
                                            ▼
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Retriever  │◀───│   Indexer   │◀───│  Embedder   │
└─────────────┘    └─────────────┘    └─────────────┘
```

## Document Loading

### Multi-Source Loader

```typescript
// pipeline/loaders.ts
import { readFile, readdir } from "fs/promises";
import { join, extname } from "path";
import pdf from "pdf-parse";
import mammoth from "mammoth";

interface LoadedDocument {
  id: string;
  content: string;
  metadata: {
    source: string;
    type: string;
    title?: string;
    createdAt?: Date;
    [key: string]: any;
  };
}

export class DocumentLoader {
  async loadFile(filePath: string): Promise<LoadedDocument> {
    const ext = extname(filePath).toLowerCase();
    const content = await this.extractContent(filePath, ext);

    return {
      id: this.generateId(filePath),
      content,
      metadata: {
        source: filePath,
        type: ext.slice(1),
      },
    };
  }

  async loadDirectory(dirPath: string): Promise<LoadedDocument[]> {
    const files = await readdir(dirPath, { recursive: true });
    const documents: LoadedDocument[] = [];

    for (const file of files) {
      const filePath = join(dirPath, file);
      try {
        const doc = await this.loadFile(filePath);
        documents.push(doc);
      } catch (error) {
        console.error(`Failed to load ${filePath}:`, error);
      }
    }

    return documents;
  }

  private async extractContent(filePath: string, ext: string): Promise<string> {
    const buffer = await readFile(filePath);

    switch (ext) {
      case ".txt":
      case ".md":
        return buffer.toString("utf-8");

      case ".pdf":
        const pdfData = await pdf(buffer);
        return pdfData.text;

      case ".docx":
        const result = await mammoth.extractRawText({ buffer });
        return result.value;

      case ".json":
        const json = JSON.parse(buffer.toString("utf-8"));
        return this.flattenJson(json);

      default:
        throw new Error(`Unsupported file type: ${ext}`);
    }
  }

  private flattenJson(obj: any, prefix = ""): string {
    const parts: string[] = [];

    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;

      if (typeof value === "object" && value !== null) {
        parts.push(this.flattenJson(value, path));
      } else {
        parts.push(`${path}: ${value}`);
      }
    }

    return parts.join("\n");
  }

  private generateId(source: string): string {
    return `doc_${Buffer.from(source).toString("base64url").slice(0, 16)}`;
  }
}
```

### Web Loader

```typescript
// pipeline/web-loader.ts
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

export class WebLoader {
  async loadUrl(url: string): Promise<LoadedDocument> {
    const response = await fetch(url);
    const html = await response.text();

    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    return {
      id: this.generateId(url),
      content: article?.textContent || "",
      metadata: {
        source: url,
        type: "webpage",
        title: article?.title,
        byline: article?.byline,
      },
    };
  }

  async loadSitemap(sitemapUrl: string): Promise<LoadedDocument[]> {
    const response = await fetch(sitemapUrl);
    const xml = await response.text();

    const urlMatches = xml.match(/<loc>([^<]+)<\/loc>/g) || [];
    const urls = urlMatches.map((match) => match.replace("<loc>", "").replace("</loc>", ""));

    const documents: LoadedDocument[] = [];
    for (const url of urls.slice(0, 100)) {
      // Limit for safety
      try {
        const doc = await this.loadUrl(url);
        documents.push(doc);
        await new Promise((r) => setTimeout(r, 1000)); // Rate limit
      } catch (error) {
        console.error(`Failed to load ${url}:`, error);
      }
    }

    return documents;
  }
}
```

## Text Preprocessing

```typescript
// pipeline/preprocessor.ts
export class TextPreprocessor {
  process(text: string): string {
    return this.pipeline(text, [
      this.normalizeWhitespace,
      this.removeSpecialCharacters,
      this.normalizeUnicode,
      this.removeExcessiveNewlines,
    ]);
  }

  private pipeline(text: string, transforms: Array<(t: string) => string>): string {
    return transforms.reduce((t, fn) => fn(t), text);
  }

  private normalizeWhitespace(text: string): string {
    return text.replace(/\t/g, " ").replace(/[ ]+/g, " ").trim();
  }

  private removeSpecialCharacters(text: string): string {
    return text.replace(/[^\w\s\n.,!?;:'"()-]/g, "").replace(/\s+/g, " ");
  }

  private normalizeUnicode(text: string): string {
    return text.normalize("NFKC");
  }

  private removeExcessiveNewlines(text: string): string {
    return text.replace(/\n{3,}/g, "\n\n");
  }
}
```

## Text Chunking

### Smart Chunker

```typescript
// pipeline/chunker.ts
export interface Chunk {
  id: string;
  content: string;
  metadata: {
    documentId: string;
    chunkIndex: number;
    startChar: number;
    endChar: number;
    [key: string]: any;
  };
}

export interface ChunkerOptions {
  chunkSize: number;
  chunkOverlap: number;
  separators?: string[];
}

export class RecursiveChunker {
  private options: ChunkerOptions;
  private separators: string[];

  constructor(options: ChunkerOptions) {
    this.options = options;
    this.separators = options.separators || [
      "\n\n", // Paragraphs
      "\n", // Lines
      ". ", // Sentences
      ", ", // Clauses
      " ", // Words
      "", // Characters
    ];
  }

  chunk(document: LoadedDocument): Chunk[] {
    const chunks: Chunk[] = [];
    const textChunks = this.splitText(document.content, 0);

    textChunks.forEach((text, index) => {
      chunks.push({
        id: `${document.id}_chunk_${index}`,
        content: text.content,
        metadata: {
          documentId: document.id,
          chunkIndex: index,
          startChar: text.start,
          endChar: text.end,
          ...document.metadata,
        },
      });
    });

    return chunks;
  }

  private splitText(
    text: string,
    separatorIndex: number,
  ): Array<{ content: string; start: number; end: number }> {
    const separator = this.separators[separatorIndex];
    const { chunkSize, chunkOverlap } = this.options;

    // If text fits in chunk size, return as is
    if (text.length <= chunkSize) {
      return [{ content: text, start: 0, end: text.length }];
    }

    // Try splitting with current separator
    const parts = separator ? text.split(separator) : text.split("");
    const results: Array<{ content: string; start: number; end: number }> = [];
    let currentChunk = "";
    let currentStart = 0;
    let position = 0;

    for (const part of parts) {
      const partWithSep = part + (separator || "");

      if ((currentChunk + partWithSep).length > chunkSize) {
        if (currentChunk) {
          // If chunk is still too large, try next separator
          if (currentChunk.length > chunkSize && separatorIndex < this.separators.length - 1) {
            const subChunks = this.splitText(currentChunk, separatorIndex + 1);
            results.push(
              ...subChunks.map((c) => ({
                ...c,
                start: c.start + currentStart,
                end: c.end + currentStart,
              })),
            );
          } else {
            results.push({
              content: currentChunk.trim(),
              start: currentStart,
              end: position,
            });
          }

          // Start new chunk with overlap
          const overlapText = this.getOverlapText(currentChunk, chunkOverlap);
          currentChunk = overlapText + partWithSep;
          currentStart = position - overlapText.length;
        } else {
          currentChunk = partWithSep;
        }
      } else {
        currentChunk += partWithSep;
      }

      position += partWithSep.length;
    }

    // Don't forget the last chunk
    if (currentChunk.trim()) {
      results.push({
        content: currentChunk.trim(),
        start: currentStart,
        end: position,
      });
    }

    return results;
  }

  private getOverlapText(text: string, overlapSize: number): string {
    if (overlapSize === 0) return "";
    return text.slice(-overlapSize);
  }
}
```

### Semantic Chunker

```typescript
// pipeline/semantic-chunker.ts
import { generateEmbedding } from "../embeddings";

export class SemanticChunker {
  private similarityThreshold: number;
  private minChunkSize: number;
  private maxChunkSize: number;

  constructor(
    options: {
      similarityThreshold?: number;
      minChunkSize?: number;
      maxChunkSize?: number;
    } = {},
  ) {
    this.similarityThreshold = options.similarityThreshold || 0.8;
    this.minChunkSize = options.minChunkSize || 100;
    this.maxChunkSize = options.maxChunkSize || 2000;
  }

  async chunk(document: LoadedDocument): Promise<Chunk[]> {
    // Split into sentences
    const sentences = this.splitIntoSentences(document.content);

    // Generate embeddings for each sentence
    const embeddings = await Promise.all(sentences.map((s) => generateEmbedding(s)));

    // Group similar sentences
    const groups = this.groupBySimilarity(sentences, embeddings);

    // Create chunks from groups
    return groups.map((group, index) => ({
      id: `${document.id}_semantic_${index}`,
      content: group.join(" "),
      metadata: {
        documentId: document.id,
        chunkIndex: index,
        chunkType: "semantic",
        ...document.metadata,
      },
    }));
  }

  private splitIntoSentences(text: string): string[] {
    return text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 10);
  }

  private groupBySimilarity(sentences: string[], embeddings: number[][]): string[][] {
    const groups: string[][] = [];
    let currentGroup: string[] = [];
    let currentLength = 0;

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];

      if (currentGroup.length === 0) {
        currentGroup.push(sentence);
        currentLength = sentence.length;
        continue;
      }

      // Check similarity with previous sentence
      const similarity = this.cosineSimilarity(embeddings[i], embeddings[i - 1]);

      if (
        similarity > this.similarityThreshold &&
        currentLength + sentence.length < this.maxChunkSize
      ) {
        currentGroup.push(sentence);
        currentLength += sentence.length;
      } else {
        if (currentLength >= this.minChunkSize) {
          groups.push(currentGroup);
        }
        currentGroup = [sentence];
        currentLength = sentence.length;
      }
    }

    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    return groups;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
```

## Embedding Generation

```typescript
// pipeline/embedder.ts
import OpenAI from "openai";
import pLimit from "p-limit";

const openai = new OpenAI();

export interface EmbeddedChunk extends Chunk {
  embedding: number[];
}

export class Embedder {
  private model: string;
  private batchSize: number;
  private concurrency: number;

  constructor(
    options: {
      model?: string;
      batchSize?: number;
      concurrency?: number;
    } = {},
  ) {
    this.model = options.model || "text-embedding-3-small";
    this.batchSize = options.batchSize || 100;
    this.concurrency = options.concurrency || 5;
  }

  async embedChunks(chunks: Chunk[]): Promise<EmbeddedChunk[]> {
    const limit = pLimit(this.concurrency);
    const batches = this.createBatches(chunks);

    const embeddedBatches = await Promise.all(
      batches.map((batch) => limit(() => this.embedBatch(batch))),
    );

    return embeddedBatches.flat();
  }

  private createBatches(chunks: Chunk[]): Chunk[][] {
    const batches: Chunk[][] = [];
    for (let i = 0; i < chunks.length; i += this.batchSize) {
      batches.push(chunks.slice(i, i + this.batchSize));
    }
    return batches;
  }

  private async embedBatch(chunks: Chunk[]): Promise<EmbeddedChunk[]> {
    const response = await openai.embeddings.create({
      model: this.model,
      input: chunks.map((c) => c.content),
    });

    return chunks.map((chunk, i) => ({
      ...chunk,
      embedding: response.data[i].embedding,
    }));
  }
}
```

## Complete Pipeline

```typescript
// pipeline/index.ts
import { DocumentLoader } from "./loaders";
import { TextPreprocessor } from "./preprocessor";
import { RecursiveChunker } from "./chunker";
import { Embedder } from "./embedder";
import { VectorStore } from "./vectorstore";

export interface PipelineOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  embeddingModel?: string;
  namespace?: string;
}

export class EmbeddingPipeline {
  private loader: DocumentLoader;
  private preprocessor: TextPreprocessor;
  private chunker: RecursiveChunker;
  private embedder: Embedder;
  private vectorStore: VectorStore;

  constructor(options: PipelineOptions = {}) {
    this.loader = new DocumentLoader();
    this.preprocessor = new TextPreprocessor();
    this.chunker = new RecursiveChunker({
      chunkSize: options.chunkSize || 1000,
      chunkOverlap: options.chunkOverlap || 200,
    });
    this.embedder = new Embedder({
      model: options.embeddingModel,
    });
    this.vectorStore = new VectorStore(options.namespace);
  }

  async ingestFile(filePath: string): Promise<{ chunks: number }> {
    // Load
    const document = await this.loader.loadFile(filePath);

    return this.processDocument(document);
  }

  async ingestDirectory(dirPath: string): Promise<{ documents: number; chunks: number }> {
    const documents = await this.loader.loadDirectory(dirPath);
    let totalChunks = 0;

    for (const doc of documents) {
      const result = await this.processDocument(doc);
      totalChunks += result.chunks;
    }

    return { documents: documents.length, chunks: totalChunks };
  }

  async ingestUrl(url: string): Promise<{ chunks: number }> {
    const webLoader = new WebLoader();
    const document = await webLoader.loadUrl(url);

    return this.processDocument(document);
  }

  private async processDocument(document: LoadedDocument): Promise<{ chunks: number }> {
    // Preprocess
    document.content = this.preprocessor.process(document.content);

    // Chunk
    const chunks = this.chunker.chunk(document);

    // Embed
    const embeddedChunks = await this.embedder.embedChunks(chunks);

    // Store
    await this.vectorStore.upsert(embeddedChunks);

    return { chunks: embeddedChunks.length };
  }

  async query(query: string, topK = 5): Promise<Chunk[]> {
    return this.vectorStore.search(query, topK);
  }
}

// Usage
const pipeline = new EmbeddingPipeline({
  chunkSize: 1000,
  chunkOverlap: 200,
  namespace: "knowledge-base",
});

// Ingest documents
await pipeline.ingestDirectory("./documents");
await pipeline.ingestUrl("https://docs.example.com");

// Query
const results = await pipeline.query("How do I configure authentication?");
```

## Best Practices

1. **Chunk size**: Balance context vs noise (500-1500 chars)
2. **Overlap**: 10-20% prevents context loss
3. **Preprocessing**: Clean but preserve meaning
4. **Batch embeddings**: Reduce API calls
5. **Add metadata**: Enable filtering
6. **Semantic chunking**: For high-quality retrieval
7. **Hybrid search**: Combine vector and keyword
8. **Monitor quality**: Test retrieval accuracy

## Output Checklist

Every embedding pipeline should include:

- [ ] Multi-format document loading
- [ ] Text preprocessing and cleaning
- [ ] Smart chunking with overlap
- [ ] Batch embedding generation
- [ ] Metadata preservation
- [ ] Vector store indexing
- [ ] Semantic search capability
- [ ] Error handling and logging
- [ ] Progress tracking
- [ ] Retrieval quality testing
