---
name: mermaid-diagram-generator
description: Creates Mermaid diagrams for flowcharts, sequence diagrams, ERDs, and architecture visualizations in markdown. Use when users request "Mermaid diagram", "flowchart", "sequence diagram", "ERD diagram", or "architecture diagram".
---

# Mermaid Diagram Generator

Create clear, maintainable diagrams using Mermaid syntax in markdown.

## Core Workflow

1. **Identify diagram type**: Flow, sequence, ERD, etc.
2. **Define elements**: Nodes, connections, labels
3. **Apply styling**: Colors, shapes, directions
4. **Add interactions**: Click handlers (optional)
5. **Embed in docs**: Markdown integration

## Flowchart Diagrams

### Basic Flowchart

```mermaid
flowchart TD
    A[Start] --> B{Is user logged in?}
    B -->|Yes| C[Show Dashboard]
    B -->|No| D[Show Login Page]
    D --> E[Enter Credentials]
    E --> F{Valid credentials?}
    F -->|Yes| C
    F -->|No| G[Show Error]
    G --> D
    C --> H[End]
```

### Node Shapes

```mermaid
flowchart LR
    A[Rectangle] --> B(Rounded)
    B --> C([Stadium])
    C --> D[[Subroutine]]
    D --> E[(Database)]
    E --> F((Circle))
    F --> G>Asymmetric]
    G --> H{Diamond}
    H --> I{{Hexagon}}
    I --> J[/Parallelogram/]
    J --> K[\Parallelogram Alt\]
    K --> L[/Trapezoid\]
    L --> M[\Trapezoid Alt/]
```

### Subgraphs

```mermaid
flowchart TB
    subgraph Frontend
        A[React App] --> B[Redux Store]
        B --> C[Components]
    end

    subgraph Backend
        D[API Gateway] --> E[Auth Service]
        D --> F[User Service]
        D --> G[Order Service]
    end

    subgraph Database
        H[(PostgreSQL)]
        I[(Redis Cache)]
    end

    C --> D
    E --> H
    F --> H
    G --> H
    E --> I
```

### Styled Flowchart

```mermaid
flowchart TD
    A[Request] --> B{Rate Limited?}
    B -->|Yes| C[429 Too Many Requests]
    B -->|No| D{Authenticated?}
    D -->|No| E[401 Unauthorized]
    D -->|Yes| F{Authorized?}
    F -->|No| G[403 Forbidden]
    F -->|Yes| H[Process Request]
    H --> I[200 OK]

    style A fill:#e1f5fe
    style I fill:#c8e6c9
    style C fill:#ffcdd2
    style E fill:#ffcdd2
    style G fill:#ffcdd2

    classDef error fill:#ffcdd2,stroke:#c62828
    classDef success fill:#c8e6c9,stroke:#2e7d32
    class C,E,G error
    class I success
```

## Sequence Diagrams

### API Request Flow

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Client
    participant API
    participant Auth
    participant DB

    User->>Client: Click Login
    Client->>API: POST /auth/login
    API->>Auth: Validate credentials
    Auth->>DB: Query user
    DB-->>Auth: User data
    Auth-->>API: JWT token
    API-->>Client: 200 OK + token
    Client->>Client: Store token
    Client-->>User: Show dashboard
```

### With Loops and Conditions

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    participant Q as Queue
    participant W as Worker

    C->>S: Submit job
    S->>Q: Enqueue job
    S-->>C: Job ID

    loop Poll status
        C->>S: GET /jobs/{id}
        S-->>C: Status: processing
    end

    W->>Q: Dequeue job
    W->>W: Process job

    alt Success
        W->>S: Job completed
        S-->>C: Status: completed
    else Failure
        W->>S: Job failed
        S-->>C: Status: failed
    end
```

### With Notes and Activations

```mermaid
sequenceDiagram
    participant U as User
    participant F as Frontend
    participant B as Backend
    participant D as Database

    Note over U,D: User Registration Flow

    U->>+F: Fill registration form
    F->>F: Validate input
    F->>+B: POST /api/users

    activate B
    B->>B: Hash password
    B->>+D: INSERT user
    D-->>-B: User created
    B->>B: Generate verification email
    deactivate B

    B-->>-F: 201 Created
    F-->>-U: Success message

    Note right of B: Email sent async
```

## Entity Relationship Diagrams

### Database Schema

```mermaid
erDiagram
    USERS ||--o{ ORDERS : places
    USERS ||--o{ REVIEWS : writes
    USERS {
        uuid id PK
        string email UK
        string password_hash
        string name
        timestamp created_at
        timestamp updated_at
    }

    ORDERS ||--|{ ORDER_ITEMS : contains
    ORDERS {
        uuid id PK
        uuid user_id FK
        decimal total
        string status
        timestamp created_at
    }

    PRODUCTS ||--o{ ORDER_ITEMS : "ordered in"
    PRODUCTS ||--o{ REVIEWS : "reviewed in"
    PRODUCTS {
        uuid id PK
        string name
        text description
        decimal price
        int stock
        uuid category_id FK
    }

    ORDER_ITEMS {
        uuid id PK
        uuid order_id FK
        uuid product_id FK
        int quantity
        decimal price
    }

    CATEGORIES ||--o{ PRODUCTS : contains
    CATEGORIES {
        uuid id PK
        string name
        uuid parent_id FK
    }

    REVIEWS {
        uuid id PK
        uuid user_id FK
        uuid product_id FK
        int rating
        text content
        timestamp created_at
    }
```

## State Diagrams

### Order State Machine

```mermaid
stateDiagram-v2
    [*] --> Pending: Order created

    Pending --> Processing: Payment received
    Pending --> Cancelled: User cancels

    Processing --> Shipped: Items dispatched
    Processing --> Cancelled: Out of stock

    Shipped --> Delivered: Package delivered
    Shipped --> Returned: Return requested

    Delivered --> Returned: Return requested
    Delivered --> [*]: Complete

    Returned --> Refunded: Refund processed
    Refunded --> [*]

    Cancelled --> [*]

    note right of Processing
        Inventory checked
        and reserved
    end note
```

### With Composite States

```mermaid
stateDiagram-v2
    [*] --> Idle

    state Active {
        [*] --> Running
        Running --> Paused: pause
        Paused --> Running: resume
        Running --> [*]: complete
    }

    Idle --> Active: start
    Active --> Idle: stop
    Active --> Error: error
    Error --> Idle: reset
```

## Class Diagrams

### TypeScript Classes

```mermaid
classDiagram
    class User {
        +string id
        +string email
        +string name
        -string passwordHash
        +login(password: string) boolean
        +updateProfile(data: ProfileData) void
        +getOrders() Order[]
    }

    class Order {
        +string id
        +string userId
        +OrderItem[] items
        +OrderStatus status
        +decimal total
        +addItem(product: Product, qty: number) void
        +removeItem(itemId: string) void
        +checkout() boolean
    }

    class OrderItem {
        +string id
        +string productId
        +number quantity
        +decimal price
    }

    class Product {
        +string id
        +string name
        +decimal price
        +number stock
        +reserve(qty: number) boolean
        +release(qty: number) void
    }

    User "1" --> "*" Order: places
    Order "1" --> "*" OrderItem: contains
    OrderItem "*" --> "1" Product: references

    class OrderStatus {
        <<enumeration>>
        PENDING
        PROCESSING
        SHIPPED
        DELIVERED
        CANCELLED
    }
```

## Architecture Diagrams

### C4 Context Diagram

```mermaid
flowchart TB
    subgraph boundary[System Boundary]
        system[E-commerce Platform]
    end

    user[fa:fa-user Customer]
    admin[fa:fa-user-cog Admin]

    payment[fa:fa-credit-card Payment Provider]
    shipping[fa:fa-truck Shipping API]
    email[fa:fa-envelope Email Service]

    user --> system
    admin --> system
    system --> payment
    system --> shipping
    system --> email

    style system fill:#438dd5,color:#fff
    style user fill:#08427b,color:#fff
    style admin fill:#08427b,color:#fff
    style payment fill:#999,color:#fff
    style shipping fill:#999,color:#fff
    style email fill:#999,color:#fff
```

### Microservices Architecture

```mermaid
flowchart TB
    subgraph Client Layer
        web[Web App]
        mobile[Mobile App]
    end

    subgraph API Layer
        gateway[API Gateway]
        auth[Auth Service]
    end

    subgraph Services
        users[User Service]
        orders[Order Service]
        products[Product Service]
        payments[Payment Service]
        notifications[Notification Service]
    end

    subgraph Data Layer
        pg1[(Users DB)]
        pg2[(Orders DB)]
        pg3[(Products DB)]
        redis[(Redis Cache)]
        kafka[Kafka]
    end

    web --> gateway
    mobile --> gateway
    gateway --> auth
    gateway --> users
    gateway --> orders
    gateway --> products

    users --> pg1
    orders --> pg2
    products --> pg3

    users --> redis
    products --> redis

    orders --> kafka
    payments --> kafka
    notifications --> kafka

    kafka --> payments
    kafka --> notifications
```

## Git Graph

```mermaid
gitGraph
    commit id: "Initial commit"
    branch develop
    checkout develop
    commit id: "Setup project"
    commit id: "Add components"
    branch feature/auth
    checkout feature/auth
    commit id: "Add login"
    commit id: "Add signup"
    checkout develop
    merge feature/auth id: "Merge auth"
    branch feature/dashboard
    checkout feature/dashboard
    commit id: "Add dashboard"
    checkout develop
    merge feature/dashboard id: "Merge dashboard"
    checkout main
    merge develop id: "Release v1.0" tag: "v1.0.0"
```

## Pie Charts

```mermaid
pie showData
    title Technology Stack Distribution
    "TypeScript" : 45
    "React" : 25
    "Node.js" : 15
    "PostgreSQL" : 10
    "Other" : 5
```

## Timeline

```mermaid
timeline
    title Project Roadmap 2024
    section Q1
        January : Project Kickoff
                : Team Setup
        February : MVP Development
        March : Alpha Release
    section Q2
        April : Beta Testing
        May : Bug Fixes
        June : Public Launch
    section Q3
        July : Feature Expansion
        August : Performance Optimization
        September : Mobile App
    section Q4
        October : Enterprise Features
        November : International Expansion
        December : Year Review
```

## Mindmap

```mermaid
mindmap
    root((Project))
        Frontend
            React
            Next.js
            Tailwind CSS
        Backend
            Node.js
            Express
            GraphQL
        Database
            PostgreSQL
            Redis
            MongoDB
        DevOps
            Docker
            Kubernetes
            CI/CD
        Testing
            Jest
            Cypress
            Playwright
```

## Best Practices

1. **Keep it simple**: Avoid overcrowded diagrams
2. **Use subgraphs**: Group related elements
3. **Consistent styling**: Define class styles
4. **Direction matters**: LR for processes, TD for hierarchies
5. **Add notes**: Clarify complex parts
6. **Use icons**: Font Awesome integration
7. **Version control**: Diagrams are code
8. **Document purpose**: Add titles and descriptions

## Output Checklist

Every Mermaid diagram should include:

- [ ] Appropriate diagram type
- [ ] Clear node labels
- [ ] Logical flow direction
- [ ] Subgraphs for grouping
- [ ] Consistent styling
- [ ] Meaningful connections
- [ ] Notes where needed
- [ ] Title or description
- [ ] Proper syntax validation
- [ ] Readable at expected size
