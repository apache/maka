---
name: langchain-workflow-builder
description: Builds LLM applications with LangChain including chains, agents, memory, tools, and RAG pipelines. Use when users request "LangChain setup", "LLM chain", "AI workflow", "conversational AI", or "RAG pipeline".
---

# LangChain Workflow Builder

Build powerful LLM applications with chains, agents, and retrieval-augmented generation.

## Core Workflow

1. **Setup LangChain**: Install and configure
2. **Create chains**: Build processing pipelines
3. **Add memory**: Enable conversation context
4. **Define tools**: Extend agent capabilities
5. **Implement RAG**: Add knowledge retrieval
6. **Deploy**: Production-ready setup

## Installation

```bash
npm install langchain @langchain/openai @langchain/community
```

## Basic Chains

### Simple LLM Chain

```typescript
// chains/simple.ts
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";

const model = new ChatOpenAI({
  modelName: "gpt-4-turbo-preview",
  temperature: 0.7,
});

const prompt = ChatPromptTemplate.fromMessages([
  ["system", "You are a helpful assistant that {task}."],
  ["human", "{input}"],
]);

const chain = prompt.pipe(model).pipe(new StringOutputParser());

// Usage
const result = await chain.invoke({
  task: "summarizes text concisely",
  input: "Summarize this article: ...",
});
```

### Sequential Chain

```typescript
// chains/sequential.ts
import { RunnableSequence } from "@langchain/core/runnables";

// Chain 1: Extract key points
const extractChain = ChatPromptTemplate.fromMessages([
  ["system", "Extract the key points from the following text."],
  ["human", "{text}"],
])
  .pipe(model)
  .pipe(new StringOutputParser());

// Chain 2: Summarize key points
const summarizeChain = ChatPromptTemplate.fromMessages([
  ["system", "Create a brief summary from these key points."],
  ["human", "{keyPoints}"],
])
  .pipe(model)
  .pipe(new StringOutputParser());

// Combined chain
const fullChain = RunnableSequence.from([
  {
    keyPoints: extractChain,
    originalText: (input) => input.text,
  },
  {
    summary: summarizeChain,
    keyPoints: (input) => input.keyPoints,
  },
]);

const result = await fullChain.invoke({ text: "Long article..." });
// { summary: '...', keyPoints: '...' }
```

### Branching Chain

```typescript
// chains/branching.ts
import { RunnableBranch } from "@langchain/core/runnables";

const classifyChain = ChatPromptTemplate.fromMessages([
  ["system", "Classify the query as: question, complaint, or feedback"],
  ["human", "{query}"],
])
  .pipe(model)
  .pipe(new StringOutputParser());

const questionChain = ChatPromptTemplate.fromMessages([
  ["system", "Answer this question helpfully."],
  ["human", "{query}"],
])
  .pipe(model)
  .pipe(new StringOutputParser());

const complaintChain = ChatPromptTemplate.fromMessages([
  ["system", "Respond empathetically to this complaint."],
  ["human", "{query}"],
])
  .pipe(model)
  .pipe(new StringOutputParser());

const feedbackChain = ChatPromptTemplate.fromMessages([
  ["system", "Thank the user for their feedback."],
  ["human", "{query}"],
])
  .pipe(model)
  .pipe(new StringOutputParser());

const routingChain = RunnableSequence.from([
  {
    classification: classifyChain,
    query: (input) => input.query,
  },
  RunnableBranch.from([
    [(input) => input.classification.includes("question"), questionChain],
    [(input) => input.classification.includes("complaint"), complaintChain],
    feedbackChain, // Default
  ]),
]);
```

## Memory & Conversation

### Buffer Memory

```typescript
// memory/conversation.ts
import { BufferMemory } from "langchain/memory";
import { ConversationChain } from "langchain/chains";

const memory = new BufferMemory({
  returnMessages: true,
  memoryKey: "history",
});

const chain = new ConversationChain({
  llm: model,
  memory,
  prompt: ChatPromptTemplate.fromMessages([
    ["system", "You are a helpful assistant."],
    new MessagesPlaceholder("history"),
    ["human", "{input}"],
  ]),
});

// Conversation maintains context
await chain.invoke({ input: "My name is Alice" });
await chain.invoke({ input: "What is my name?" }); // Remembers Alice
```

### Window Memory

```typescript
// memory/window.ts
import { BufferWindowMemory } from "langchain/memory";

const memory = new BufferWindowMemory({
  k: 5, // Keep last 5 exchanges
  returnMessages: true,
  memoryKey: "history",
});
```

### Summary Memory

```typescript
// memory/summary.ts
import { ConversationSummaryMemory } from "langchain/memory";

const memory = new ConversationSummaryMemory({
  llm: model,
  memoryKey: "history",
});
// Summarizes conversation to save tokens
```

### Persistent Memory with Redis

```typescript
// memory/redis.ts
import { BufferMemory } from "langchain/memory";
import { RedisChatMessageHistory } from "@langchain/community/stores/message/redis";

const memory = new BufferMemory({
  chatHistory: new RedisChatMessageHistory({
    sessionId: `user:${userId}:session:${sessionId}`,
    client: redisClient,
    ttl: 3600, // 1 hour
  }),
  returnMessages: true,
  memoryKey: "history",
});
```

## Tools & Agents

### Define Custom Tools

```typescript
// tools/custom.ts
import { DynamicTool, DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

// Simple tool
const searchTool = new DynamicTool({
  name: "search",
  description: "Search the web for information",
  func: async (query: string) => {
    const results = await searchAPI.search(query);
    return JSON.stringify(results);
  },
});

// Structured tool with schema
const calculatorTool = new DynamicStructuredTool({
  name: "calculator",
  description: "Perform mathematical calculations",
  schema: z.object({
    expression: z.string().describe("Mathematical expression to evaluate"),
  }),
  func: async ({ expression }) => {
    try {
      const result = eval(expression); // Use safer math parser in production
      return String(result);
    } catch {
      return "Error: Invalid expression";
    }
  },
});

// Database query tool
const dbQueryTool = new DynamicStructuredTool({
  name: "query_database",
  description: "Query the database for user or order information",
  schema: z.object({
    table: z.enum(["users", "orders", "products"]),
    filter: z.record(z.string()).optional(),
    limit: z.number().default(10),
  }),
  func: async ({ table, filter, limit }) => {
    const results = await db[table].findMany({
      where: filter,
      take: limit,
    });
    return JSON.stringify(results);
  },
});
```

### Create Agent

```typescript
// agents/react.ts
import { createReactAgent, AgentExecutor } from "langchain/agents";
import { pull } from "langchain/hub";

// Get standard ReAct prompt
const prompt = await pull("hwchase17/react");

// Create agent
const agent = await createReactAgent({
  llm: model,
  tools: [searchTool, calculatorTool, dbQueryTool],
  prompt,
});

// Create executor
const executor = new AgentExecutor({
  agent,
  tools: [searchTool, calculatorTool, dbQueryTool],
  verbose: true,
  maxIterations: 5,
});

// Run agent
const result = await executor.invoke({
  input: "What is the square root of the number of users in our database?",
});
```

### OpenAI Functions Agent

```typescript
// agents/openai-functions.ts
import { createOpenAIFunctionsAgent, AgentExecutor } from "langchain/agents";

const prompt = ChatPromptTemplate.fromMessages([
  ["system", "You are a helpful assistant with access to tools."],
  new MessagesPlaceholder("chat_history"),
  ["human", "{input}"],
  new MessagesPlaceholder("agent_scratchpad"),
]);

const agent = await createOpenAIFunctionsAgent({
  llm: new ChatOpenAI({ modelName: "gpt-4-turbo-preview" }),
  tools: [searchTool, calculatorTool],
  prompt,
});

const executor = new AgentExecutor({
  agent,
  tools: [searchTool, calculatorTool],
  memory: new BufferMemory({
    returnMessages: true,
    memoryKey: "chat_history",
  }),
});
```

## RAG Pipeline

### Document Loading

```typescript
// rag/loader.ts
import { DirectoryLoader } from "langchain/document_loaders/fs/directory";
import { PDFLoader } from "langchain/document_loaders/fs/pdf";
import { TextLoader } from "langchain/document_loaders/fs/text";
import { JSONLoader } from "langchain/document_loaders/fs/json";

const loader = new DirectoryLoader("./documents", {
  ".pdf": (path) => new PDFLoader(path),
  ".txt": (path) => new TextLoader(path),
  ".json": (path) => new JSONLoader(path),
});

const docs = await loader.load();
```

### Text Splitting

```typescript
// rag/splitter.ts
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1000,
  chunkOverlap: 200,
  separators: ["\n\n", "\n", " ", ""],
});

const chunks = await splitter.splitDocuments(docs);
```

### Vector Store

```typescript
// rag/vectorstore.ts
import { OpenAIEmbeddings } from "@langchain/openai";
import { PineconeStore } from "@langchain/pinecone";
import { Pinecone } from "@pinecone-database/pinecone";

const embeddings = new OpenAIEmbeddings();

const pinecone = new Pinecone();
const index = pinecone.Index(process.env.PINECONE_INDEX!);

// Create vector store from documents
const vectorStore = await PineconeStore.fromDocuments(chunks, embeddings, {
  pineconeIndex: index,
  namespace: "documents",
});

// Or connect to existing
const existingStore = await PineconeStore.fromExistingIndex(embeddings, {
  pineconeIndex: index,
  namespace: "documents",
});
```

### RAG Chain

```typescript
// rag/chain.ts
import { createRetrievalChain } from "langchain/chains/retrieval";
import { createStuffDocumentsChain } from "langchain/chains/combine_documents";

const retriever = vectorStore.asRetriever({
  k: 5, // Return top 5 results
  searchType: "similarity",
});

const prompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    `Answer questions based on the following context. If the answer is not in the context, say so.

Context: {context}`,
  ],
  ["human", "{input}"],
]);

const combineDocsChain = await createStuffDocumentsChain({
  llm: model,
  prompt,
});

const ragChain = await createRetrievalChain({
  retriever,
  combineDocsChain,
});

const result = await ragChain.invoke({
  input: "What is our refund policy?",
});
// { answer: '...', context: [Document, Document, ...] }
```

### Conversational RAG

```typescript
// rag/conversational.ts
import { createHistoryAwareRetriever } from "langchain/chains/history_aware_retriever";

const contextualizePrompt = ChatPromptTemplate.fromMessages([
  ["system", "Given chat history and question, reformulate as standalone question."],
  new MessagesPlaceholder("chat_history"),
  ["human", "{input}"],
]);

const historyAwareRetriever = await createHistoryAwareRetriever({
  llm: model,
  retriever,
  rephrasePrompt: contextualizePrompt,
});

const qaPrompt = ChatPromptTemplate.fromMessages([
  ["system", "Answer based on context:\n\n{context}"],
  new MessagesPlaceholder("chat_history"),
  ["human", "{input}"],
]);

const questionAnswerChain = await createStuffDocumentsChain({
  llm: model,
  prompt: qaPrompt,
});

const conversationalRagChain = await createRetrievalChain({
  retriever: historyAwareRetriever,
  combineDocsChain: questionAnswerChain,
});
```

## Streaming

```typescript
// streaming/stream.ts
const stream = await chain.stream({ input: "Tell me a story" });

for await (const chunk of stream) {
  process.stdout.write(chunk);
}

// With callbacks
const result = await chain.invoke(
  { input: "Tell me a story" },
  {
    callbacks: [
      {
        handleLLMNewToken(token: string) {
          process.stdout.write(token);
        },
      },
    ],
  },
);
```

## Production Setup

```typescript
// config/langchain.ts
import { ChatOpenAI } from "@langchain/openai";

export const model = new ChatOpenAI({
  modelName: process.env.OPENAI_MODEL || "gpt-4-turbo-preview",
  temperature: 0.7,
  maxTokens: 4096,
  timeout: 60000,
  maxRetries: 3,
  cache: true,
});

// With rate limiting
import Bottleneck from "bottleneck";

const limiter = new Bottleneck({
  minTime: 100, // 10 requests per second
  maxConcurrent: 5,
});

export async function invokeWithRateLimit(chain: any, input: any) {
  return limiter.schedule(() => chain.invoke(input));
}
```

## Best Practices

1. **Use LCEL**: LangChain Expression Language for composability
2. **Add memory strategically**: Balance context vs tokens
3. **Define clear tool descriptions**: Help the agent choose correctly
4. **Chunk documents properly**: Optimize for retrieval
5. **Use streaming**: Better UX for long responses
6. **Cache embeddings**: Reduce API costs
7. **Monitor token usage**: Track and optimize
8. **Handle errors gracefully**: Retry and fallback

## Output Checklist

Every LangChain implementation should include:

- [ ] Model configuration with retries
- [ ] Prompt templates with variables
- [ ] Chain composition with LCEL
- [ ] Memory for conversation context
- [ ] Tools with clear descriptions
- [ ] Agent with iteration limits
- [ ] RAG with proper chunking
- [ ] Streaming for UX
- [ ] Error handling
- [ ] Rate limiting for production
