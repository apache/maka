---
name: guardrails-safety-filter-builder
description: Implements content safety filters with PII redaction, policy constraints, prompt injection detection, and safe refusal templates. Use when adding "content moderation", "safety filters", "PII protection", or "guardrails".
---

# Guardrails & Safety Filter Builder

Build comprehensive safety systems for LLM applications.

## Safety Layers

1. **Input filtering**: Block malicious prompts
2. **Output filtering**: Redact sensitive data
3. **Topic constraints**: Policy-based refusals
4. **PII detection**: Mask personal information
5. **Prompt injection**: Detect manipulation attempts

## PII Detection & Redaction

```python
import re
from presidio_analyzer import AnalyzerEngine
from presidio_anonymizer import AnonymizerEngine

analyzer = AnalyzerEngine()
anonymizer = AnonymizerEngine()

def redact_pii(text: str) -> str:
    # Detect PII
    results = analyzer.analyze(
        text=text,
        language='en',
        entities=["EMAIL_ADDRESS", "PHONE_NUMBER", "CREDIT_CARD", "SSN"]
    )

    # Anonymize
    anonymized = anonymizer.anonymize(text, results)
    return anonymized.text

# Example: "My email is john@example.com" → "My email is <EMAIL_ADDRESS>"
```

## Prompt Injection Detection

```python
def detect_prompt_injection(user_input: str) -> bool:
    """Detect common prompt injection patterns"""
    patterns = [
        r'ignore (previous|above) instructions',
        r'disregard (all|any) (prior|previous)',
        r'you are now',
        r'new instructions',
        r'system:',
        r'override',
    ]

    for pattern in patterns:
        if re.search(pattern, user_input, re.IGNORECASE):
            return True

    return False

# Block if detected
if detect_prompt_injection(user_input):
    return "I cannot process that request."
```

## Topic Constraints

```python
# Define allowed/disallowed topics
POLICY = {
    "allowed_topics": [
        "product_features",
        "troubleshooting",
        "billing",
        "account_management"
    ],
    "disallowed_topics": [
        "medical_advice",
        "legal_advice",
        "financial_advice",
        "politics",
        "violence"
    ],
    "requires_disclaimer": [
        "security_practices",
        "data_privacy"
    ]
}

# Classify topic
def classify_topic(query: str) -> str:
    classification_prompt = f"""
    Classify this query into one of these topics:
    {', '.join(POLICY['allowed_topics'] + POLICY['disallowed_topics'])}

    Query: {query}

    Return only the topic name.
    """
    return llm(classification_prompt)

# Check policy
def check_policy(query: str) -> dict:
    topic = classify_topic(query)

    if topic in POLICY["disallowed_topics"]:
        return {
            "allowed": False,
            "reason": f"Cannot provide {topic}",
            "refusal": REFUSAL_TEMPLATES[topic]
        }

    return {"allowed": True, "topic": topic}
```

## Refusal Templates

```python
REFUSAL_TEMPLATES = {
    "medical_advice": """
        I cannot provide medical advice. Please consult with a healthcare
        professional for medical concerns.
    """,
    "legal_advice": """
        I cannot provide legal advice. For legal matters, please consult
        with a qualified attorney.
    """,
    "out_of_scope": """
        I'm designed to help with product documentation and support.
        This question is outside my area of expertise.
    """,
}

def refuse_safely(reason: str) -> str:
    return REFUSAL_TEMPLATES.get(reason, REFUSAL_TEMPLATES["out_of_scope"])
```

## Output Validation

```python
def validate_output(output: str) -> dict:
    """Check output before returning to user"""
    issues = []

    # Check for PII
    pii_results = analyzer.analyze(output, language='en')
    if pii_results:
        issues.append("Contains PII")
        output = redact_pii(output)

    # Check for banned phrases
    banned_phrases = ["password", "api key", "secret"]
    for phrase in banned_phrases:
        if phrase.lower() in output.lower():
            issues.append(f"Contains banned phrase: {phrase}")

    # Check toxicity
    toxicity_score = toxicity_classifier(output)
    if toxicity_score > 0.7:
        issues.append("High toxicity detected")

    return {
        "safe": len(issues) == 0,
        "issues": issues,
        "sanitized_output": output
    }
```

## Complete Guardrail Pipeline

```python
def apply_guardrails(user_input: str) -> dict:
    # 1. Input validation
    if detect_prompt_injection(user_input):
        return {
            "allowed": False,
            "response": "Invalid request detected."
        }

    # 2. Policy check
    policy_check = check_policy(user_input)
    if not policy_check["allowed"]:
        return {
            "allowed": False,
            "response": policy_check["refusal"]
        }

    # 3. Generate response
    response = llm(user_input)

    # 4. Output validation
    validation = validate_output(response)
    if not validation["safe"]:
        return {
            "allowed": True,
            "response": validation["sanitized_output"],
            "warnings": validation["issues"]
        }

    return {
        "allowed": True,
        "response": response
    }
```

## Best Practices

- Layer multiple defenses
- Log all blocked requests
- Provide helpful refusals
- Redact, don't reject when possible
- Regular pattern updates
- Human review of edge cases

## Output Checklist

- [ ] PII detection implemented
- [ ] Prompt injection detection
- [ ] Topic classification
- [ ] Policy constraints defined
- [ ] Refusal templates written
- [ ] Output validation
- [ ] Logging/monitoring
- [ ] Test cases for bypasses
