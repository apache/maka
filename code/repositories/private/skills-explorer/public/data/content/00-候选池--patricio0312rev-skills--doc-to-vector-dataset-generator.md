---
name: doc-to-vector-dataset-generator
description: Converts documents into clean, chunked datasets suitable for embeddings and vector search. Produces chunked JSONL files with metadata, deduplication logic, and quality checks. Use when preparing "training data", "vector datasets", "document processing", or "embedding data".
---

# Doc-to-Vector Dataset Generator

Transform documents into high-quality vector search datasets.

## Pipeline Steps

1. **Extract text** from various formats (PDF, DOCX, HTML)
2. **Clean text** (remove noise, normalize)
3. **Chunk strategically** (semantic boundaries)
4. **Add metadata** (source, timestamps, classification)
5. **Deduplicate** (near-duplicate detection)
6. **Quality check** (length, content validation)
7. **Export JSONL** (one chunk per line)

## Text Extraction

```python
# PDF extraction
import pymupdf

def extract_pdf(filepath: str) -> str:
    doc = pymupdf.open(filepath)
    text = ""
    for page in doc:
        text += page.get_text()
    return text

# Markdown extraction
def extract_markdown(filepath: str) -> str:
    with open(filepath) as f:
        return f.read()
```

## Text Cleaning

```python
import re

def clean_text(text: str) -> str:
    # Remove extra whitespace
    text = re.sub(r'\s+', ' ', text)

    # Remove page numbers
    text = re.sub(r'Page \d+', '', text)

    # Remove URLs (optional)
    text = re.sub(r'http\S+', '', text)

    # Normalize unicode
    text = text.encode('utf-8', 'ignore').decode('utf-8')

    return text.strip()
```

## Semantic Chunking

```python
def semantic_chunk(text: str, max_chunk_size: int = 1000) -> List[str]:
    """Chunk at semantic boundaries (paragraphs, sentences)"""
    # Split by paragraphs first
    paragraphs = text.split('\n\n')

    chunks = []
    current_chunk = ""

    for para in paragraphs:
        if len(current_chunk) + len(para) <= max_chunk_size:
            current_chunk += para + "\n\n"
        else:
            if current_chunk:
                chunks.append(current_chunk.strip())
            current_chunk = para + "\n\n"

    if current_chunk:
        chunks.append(current_chunk.strip())

    return chunks
```

## Metadata Extraction

````python
def extract_metadata(filepath: str, chunk: str, chunk_idx: int) -> dict:
    return {
        "source": filepath,
        "chunk_id": f"{hash(filepath)}_{chunk_idx}",
        "chunk_index": chunk_idx,
        "char_count": len(chunk),
        "word_count": len(chunk.split()),
        "created_at": datetime.now().isoformat(),

        # Content classification
        "has_code": bool(re.search(r'```|def |class |function', chunk)),
        "has_table": bool(re.search(r'\|.*\|', chunk)),
        "language": detect_language(chunk),
    }
````

## Deduplication

```python
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

def deduplicate_chunks(chunks: List[dict], threshold: float = 0.95) -> List[dict]:
    """Remove near-duplicate chunks"""
    texts = [c["text"] for c in chunks]

    # Compute TF-IDF vectors
    vectorizer = TfidfVectorizer()
    vectors = vectorizer.fit_transform(texts)

    # Compute pairwise similarity
    similarity_matrix = cosine_similarity(vectors)

    # Find duplicates
    to_remove = set()
    for i in range(len(chunks)):
        if i in to_remove:
            continue
        for j in range(i+1, len(chunks)):
            if similarity_matrix[i][j] > threshold:
                to_remove.add(j)

    # Return unique chunks
    return [c for i, c in enumerate(chunks) if i not in to_remove]
```

## Quality Checks

```python
def quality_check(chunk: dict) -> bool:
    """Validate chunk quality"""
    text = chunk["text"]

    # Min length check
    if len(text) < 50:
        return False

    # Max length check
    if len(text) > 5000:
        return False

    # Content check (not just numbers/symbols)
    alpha_ratio = sum(c.isalpha() for c in text) / len(text)
    if alpha_ratio < 0.5:
        return False

    # Language check (English only)
    if chunk["metadata"]["language"] != "en":
        return False

    return True
```

## JSONL Export

```python
import json

def export_jsonl(chunks: List[dict], output_path: str):
    """Export chunks as JSONL (one JSON object per line)"""
    with open(output_path, 'w') as f:
        for chunk in chunks:
            f.write(json.dumps(chunk) + '\n')

# Example output format
{
  "text": "Chunk text content here...",
  "metadata": {
    "source": "docs/auth.md",
    "chunk_id": "abc123_0",
    "chunk_index": 0,
    "char_count": 542,
    "word_count": 89,
    "has_code": true
  }
}
```

## Complete Pipeline

```python
def process_documents(input_dir: str, output_path: str):
    all_chunks = []

    # Process each document
    for filepath in glob(f"{input_dir}/**/*.md"):
        # Extract and clean
        text = extract_markdown(filepath)
        text = clean_text(text)

        # Chunk
        chunks = semantic_chunk(text)

        # Add metadata
        for i, chunk in enumerate(chunks):
            chunk_obj = {
                "text": chunk,
                "metadata": extract_metadata(filepath, chunk, i)
            }

            # Quality check
            if quality_check(chunk_obj):
                all_chunks.append(chunk_obj)

    # Deduplicate
    unique_chunks = deduplicate_chunks(all_chunks)

    # Export
    export_jsonl(unique_chunks, output_path)

    print(f"Processed {len(unique_chunks)} chunks")
```

## Best Practices

- Chunk at semantic boundaries
- Rich metadata for filtering
- Deduplicate aggressively
- Quality checks prevent garbage
- JSONL format for streaming
- Version your datasets

## Output Checklist

- [ ] Text extraction from all formats
- [ ] Cleaning pipeline implemented
- [ ] Semantic chunking strategy
- [ ] Metadata schema defined
- [ ] Deduplication logic
- [ ] Quality validation checks
- [ ] JSONL export format
- [ ] Dataset statistics logged
