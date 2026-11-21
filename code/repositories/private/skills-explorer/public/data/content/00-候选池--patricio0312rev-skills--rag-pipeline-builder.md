---
name: rag-pipeline-builder
description: Designs retrieval-augmented generation pipelines for document-based AI assistants. Includes chunking strategies, metadata schemas, retrieval algorithms, reranking, and evaluation plans. Use when building "RAG systems", "document search", "semantic search", or "knowledge bases".
---

# RAG Pipeline Builder

Design end-to-end RAG pipelines for accurate document retrieval and generation.

## Pipeline Architecture

```
Documents → Chunking → Embedding → Vector Store → Retrieval → Reranking → Generation
```

## Chunking Strategy

```python
# Semantic chunking (recommended)
from langchain.text_splitter import RecursiveCharacterTextSplitter

splitter = RecursiveCharacterTextSplitter(
    chunk_size=1000,        # Characters per chunk
    chunk_overlap=200,      # Overlap between chunks
    separators=["\n\n", "\n", ". ", " ", ""],
    length_function=len,
)

chunks = splitter.split_text(document.text)

# Add metadata to each chunk
for i, chunk in enumerate(chunks):
    chunks[i] = {
        "text": chunk,
        "metadata": {
            "source": document.filename,
            "page": calculate_page(i),
            "chunk_id": f"{document.id}_chunk_{i}",
        }
    }
```

## Metadata Schema

```typescript
interface ChunkMetadata {
  // Source information
  document_id: string;
  source: string;
  url?: string;

  // Location
  page?: number;
  section?: string;
  chunk_index: number;

  // Content classification
  content_type: "text" | "code" | "table" | "list";
  language?: string;

  // Timestamps
  created_at: Date;
  updated_at: Date;

  // Retrieval optimization
  keywords: string[];
  summary?: string;
  importance_score?: number;
}
```

## Vector Store Setup

```python
# Pinecone example
import pinecone
from langchain.vectorstores import Pinecone
from langchain.embeddings import OpenAIEmbeddings

pinecone.init(api_key="...", environment="...")

embeddings = OpenAIEmbeddings(model="text-embedding-3-small")

vectorstore = Pinecone.from_documents(
    documents=chunks,
    embedding=embeddings,
    index_name="knowledge-base",
    namespace="production",
)
```

## Retrieval Strategies

```python
# Hybrid search (dense + sparse)
def hybrid_retrieval(query: str, k: int = 5):
    # Dense retrieval (semantic)
    dense_results = vectorstore.similarity_search(query, k=k*2)

    # Sparse retrieval (keyword - BM25)
    sparse_results = bm25_search(query, k=k*2)

    # Combine and rerank
    combined = reciprocal_rank_fusion(dense_results, sparse_results)

    return combined[:k]

# Metadata filtering
results = vectorstore.similarity_search(
    query,
    k=5,
    filter={
        "content_type": "code",
        "language": "python",
    }
)
```

## Reranking

```python
from sentence_transformers import CrossEncoder

reranker = CrossEncoder('cross-encoder/ms-marco-MiniLM-L-6-v2')

def rerank_results(query: str, results: List[Document], top_k: int = 3):
    # Score each result against query
    pairs = [(query, doc.page_content) for doc in results]
    scores = reranker.predict(pairs)

    # Sort by score
    scored_results = list(zip(results, scores))
    scored_results.sort(key=lambda x: x[1], reverse=True)

    return [doc for doc, score in scored_results[:top_k]]
```

## Query Enhancement

```python
# Query expansion
def expand_query(query: str) -> str:
    expansion_prompt = f"""
    Generate 3 alternative phrasings of this query:
    "{query}"

    Return as JSON array of strings.
    """
    alternatives = llm(expansion_prompt)
    return [query] + alternatives

# Multi-query retrieval
def multi_query_retrieval(query: str, k: int = 5):
    queries = expand_query(query)
    all_results = []

    for q in queries:
        results = vectorstore.similarity_search(q, k=k)
        all_results.extend(results)

    # Deduplicate and rerank
    unique_results = deduplicate(all_results)
    return rerank_results(query, unique_results, k)
```

## Evaluation Plan

```python
# Define golden dataset
golden_dataset = [
    {
        "query": "How do I authenticate users?",
        "expected_docs": ["auth_guide.md", "user_management.md"],
        "relevant_chunks": ["chunk_123", "chunk_456"],
    },
]

# Metrics
def evaluate_retrieval(dataset):
    results = {
        "precision": [],
        "recall": [],
        "mrr": [],  # Mean Reciprocal Rank
        "ndcg": []  # Normalized Discounted Cumulative Gain
    }

    for item in dataset:
        retrieved = retrieval_fn(item["query"])
        retrieved_ids = [doc.metadata["chunk_id"] for doc in retrieved]

        # Calculate metrics
        relevant = set(item["relevant_chunks"])
        retrieved_set = set(retrieved_ids)

        precision = len(relevant & retrieved_set) / len(retrieved_set)
        recall = len(relevant & retrieved_set) / len(relevant)

        results["precision"].append(precision)
        results["recall"].append(recall)

    return {k: sum(v)/len(v) for k, v in results.items()}
```

## Context Window Management

```python
def fit_context_window(chunks: List[Document], max_tokens: int = 4000):
    """Select chunks that fit in context window"""
    total_tokens = 0
    selected_chunks = []

    for chunk in chunks:
        chunk_tokens = count_tokens(chunk.page_content)
        if total_tokens + chunk_tokens <= max_tokens:
            selected_chunks.append(chunk)
            total_tokens += chunk_tokens
        else:
            break

    return selected_chunks
```

## Best Practices

1. **Chunk size**: 500-1000 chars for general text
2. **Overlap**: 10-20% overlap between chunks
3. **Metadata**: Rich metadata for filtering
4. **Hybrid search**: Combine semantic + keyword
5. **Reranking**: Cross-encoder for final ranking
6. **Evaluation**: Golden dataset with metrics
7. **Context management**: Don't exceed model limits

## Output Checklist

- [ ] Chunking strategy defined
- [ ] Metadata schema documented
- [ ] Vector store configured
- [ ] Retrieval algorithm implemented
- [ ] Reranking pipeline added
- [ ] Query enhancement (optional)
- [ ] Context window management
- [ ] Evaluation dataset created
- [ ] Metrics implementation
- [ ] Performance baseline established
