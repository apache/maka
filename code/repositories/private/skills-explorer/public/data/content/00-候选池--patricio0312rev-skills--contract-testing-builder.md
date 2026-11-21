---
name: contract-testing-builder
description: Implements API contract testing to ensure provider-consumer compatibility using Pact or similar tools. Prevents breaking changes with contract specifications and bi-directional verification. Use for "contract testing", "API contracts", "Pact", or "consumer-driven contracts".
---

# Contract Testing Builder

Ensure API contracts don't break consumers.

## Contract Testing Concepts

```
Consumer → Defines expected contract → Provider must satisfy

Benefits:
- Catch breaking changes early
- Independent development
- Fast feedback (no integration env needed)
- Documentation as code
```

## Pact Setup (Consumer Side)

```typescript
// consumer/tests/pacts/user-api.pact.test.ts
import { PactV3 } from "@pact-foundation/pact";
import { userApi } from "../api/userApi";

const provider = new PactV3({
  consumer: "UserWebApp",
  provider: "UserAPI",
  dir: path.resolve(__dirname, "../../pacts"),
});

describe("User API Contract", () => {
  it("should get user by ID", async () => {
    // Define expected interaction
    await provider
      .given("user 123 exists")
      .uponReceiving("a request for user 123")
      .withRequest({
        method: "GET",
        path: "/api/users/123",
        headers: {
          Authorization: "Bearer token123",
        },
      })
      .willRespondWith({
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
        body: {
          id: "123",
          email: "john@example.com",
          name: "John Doe",
          role: "USER",
          createdAt: like("2024-01-01T00:00:00Z"),
        },
      })
      .executeTest(async (mockServer) => {
        // Make actual API call against mock server
        const user = await userApi.getUser("123", mockServer.url);

        // Verify consumer can handle response
        expect(user.id).toBe("123");
        expect(user.email).toBe("john@example.com");
      });
  });

  it("should return 404 when user not found", async () => {
    await provider
      .given("user 999 does not exist")
      .uponReceiving("a request for non-existent user")
      .withRequest({
        method: "GET",
        path: "/api/users/999",
      })
      .willRespondWith({
        status: 404,
        headers: {
          "Content-Type": "application/json",
        },
        body: {
          error: "User not found",
        },
      })
      .executeTest(async (mockServer) => {
        await expect(userApi.getUser("999", mockServer.url)).rejects.toThrow("User not found");
      });
  });
});
```

## Pact Verification (Provider Side)

```typescript
// provider/tests/pacts/verify.test.ts
import { Verifier } from "@pact-foundation/pact";
import { app } from "../src/app";

describe("Pact Verification", () => {
  let server: Server;

  beforeAll(async () => {
    server = app.listen(3000);
  });

  afterAll(() => {
    server.close();
  });

  it("should validate consumer contracts", async () => {
    const verifier = new Verifier({
      provider: "UserAPI",
      providerBaseUrl: "http://localhost:3000",

      // Fetch pacts from broker or local files
      pactUrls: [path.resolve(__dirname, "../../pacts/UserWebApp-UserAPI.json")],

      // Provider states setup
      stateHandlers: {
        "user 123 exists": async () => {
          // Seed database with user 123
          await db.user.create({
            id: "123",
            email: "john@example.com",
            name: "John Doe",
            role: "USER",
          });
        },
        "user 999 does not exist": async () => {
          // Ensure user 999 doesn't exist
          await db.user.deleteMany({ where: { id: "999" } });
        },
      },

      // Teardown after each test
      afterEach: async () => {
        await db.$executeRaw`TRUNCATE TABLE users CASCADE`;
      },
    });

    await verifier.verifyProvider();
  });
});
```

## OpenAPI Contract Testing

```yaml
# contracts/user-api.yaml
openapi: 3.0.0
info:
  title: User API
  version: 1.0.0

paths:
  /api/users/{id}:
    get:
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: User found
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/User"
        "404":
          description: User not found
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Error"

components:
  schemas:
    User:
      type: object
      required:
        - id
        - email
        - name
        - role
      properties:
        id:
          type: string
        email:
          type: string
          format: email
        name:
          type: string
        role:
          type: string
          enum: [USER, ADMIN]
        createdAt:
          type: string
          format: date-time
```

## Contract Validation (OpenAPI)

```typescript
// tests/contract-validation.test.ts
import * as OpenAPIValidator from "express-openapi-validator";
import * as fs from "fs";
import * as yaml from "js-yaml";

describe("API Contract Validation", () => {
  it("should match OpenAPI spec", async () => {
    const spec = yaml.load(fs.readFileSync("./contracts/user-api.yaml", "utf8"));

    app.use(
      OpenAPIValidator.middleware({
        apiSpec: spec,
        validateRequests: true,
        validateResponses: true,
      }),
    );

    // Valid request - should pass
    await request(app)
      .get("/api/users/123")
      .expect(200)
      .expect((res) => {
        expect(res.body).toHaveProperty("id");
        expect(res.body).toHaveProperty("email");
        expect(res.body).toHaveProperty("name");
        expect(res.body).toHaveProperty("role");
      });
  });

  it("should reject invalid responses", async () => {
    // Mock endpoint that returns invalid data
    app.get("/api/invalid", (req, res) => {
      res.json({
        id: "123",
        // Missing required fields!
      });
    });

    // Should fail validation
    await request(app).get("/api/invalid").expect(500);
  });
});
```

## JSON Schema Validation

```typescript
// schemas/user.schema.ts
export const userSchema = {
  type: "object",
  required: ["id", "email", "name", "role"],
  properties: {
    id: { type: "string" },
    email: { type: "string", format: "email" },
    name: { type: "string", minLength: 1 },
    role: { type: "string", enum: ["USER", "ADMIN"] },
    createdAt: { type: "string", format: "date-time" },
  },
  additionalProperties: false,
};

// tests/schema-validation.test.ts
import Ajv from "ajv";
import addFormats from "ajv-formats";

const ajv = new Ajv();
addFormats(ajv);

describe("User Schema Validation", () => {
  const validate = ajv.compile(userSchema);

  it("should validate correct user object", () => {
    const user = {
      id: "123",
      email: "john@example.com",
      name: "John Doe",
      role: "USER",
      createdAt: "2024-01-01T00:00:00Z",
    };

    expect(validate(user)).toBe(true);
  });

  it("should reject missing required fields", () => {
    const user = {
      id: "123",
      email: "john@example.com",
      // Missing name and role
    };

    expect(validate(user)).toBe(false);
    expect(validate.errors).toContainEqual(
      expect.objectContaining({
        message: "must have required property 'name'",
      }),
    );
  });

  it("should reject invalid email format", () => {
    const user = {
      id: "123",
      email: "invalid-email",
      name: "John Doe",
      role: "USER",
    };

    expect(validate(user)).toBe(false);
  });
});
```

## CI Integration

```yaml
# .github/workflows/contract-tests.yml
name: Contract Tests

on: [push, pull_request]

jobs:
  consumer-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4

      - name: Run consumer tests
        run: npm run test:pact

      - name: Publish pacts
        run: |
          npx pact-broker publish \
            ./pacts \
            --consumer-app-version=${{ github.sha }} \
            --broker-base-url=${{ secrets.PACT_BROKER_URL }} \
            --broker-token=${{ secrets.PACT_BROKER_TOKEN }}

  provider-tests:
    runs-on: ubuntu-latest
    needs: consumer-tests
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4

      - name: Verify provider
        run: npm run test:pact:verify
        env:
          PACT_BROKER_URL: ${{ secrets.PACT_BROKER_URL }}
          PACT_BROKER_TOKEN: ${{ secrets.PACT_BROKER_TOKEN }}
```

## Breaking Change Detection

```typescript
// tests/breaking-changes.test.ts
describe("Breaking Change Detection", () => {
  it("should not remove required fields", async () => {
    const v1Response = {
      id: "123",
      email: "john@example.com",
      name: "John Doe",
      role: "USER",
    };

    const v2Response = {
      id: "123",
      email: "john@example.com",
      // Missing 'name' - BREAKING CHANGE!
      role: "USER",
    };

    // Validate v2 still has all v1 required fields
    const v1Keys = Object.keys(v1Response);
    const v2Keys = Object.keys(v2Response);

    const missingFields = v1Keys.filter((key) => !v2Keys.includes(key));

    expect(missingFields).toHaveLength(0);
  });

  it("should not change field types", async () => {
    const v1Response = {
      id: "123", // string
      age: 25, // number
    };

    const v2Response = {
      id: 123, // number - BREAKING CHANGE!
      age: "25", // string - BREAKING CHANGE!
    };

    expect(typeof v2Response.id).toBe(typeof v1Response.id);
    expect(typeof v2Response.age).toBe(typeof v1Response.age);
  });
});
```

## Contract Documentation

````markdown
# API Contract Documentation

## User API Contract

### Consumer: UserWebApp

### Provider: UserAPI

### Interactions

#### Get User by ID

**Request:**

```http
GET /api/users/{id}
Authorization: Bearer {token}
```
````

**Response (200):**

```json
{
  "id": "string",
  "email": "string (email format)",
  "name": "string",
  "role": "USER | ADMIN",
  "createdAt": "string (ISO 8601)"
}
```

**Response (404):**

```json
{
  "error": "User not found"
}
```

### Provider States

- **user {id} exists**: User with given ID exists in database
- **user {id} does not exist**: User with given ID does not exist

### Breaking Change Policy

1. Cannot remove required fields
2. Cannot change field types
3. Cannot remove enum values
4. Can add optional fields
5. Can deprecate with 6-month notice

```

## Best Practices

1. **Consumer-driven**: Consumers define expectations
2. **Test early**: Run in CI on every commit
3. **Use Pact Broker**: Central contract repository
4. **Provider states**: Setup test data properly
5. **Version contracts**: Track API versions
6. **Document changes**: Clear migration guides
7. **Monitor compliance**: Track contract violations

## Output Checklist

- [ ] Contract test framework chosen (Pact/OpenAPI)
- [ ] Consumer tests written
- [ ] Provider verification configured
- [ ] Provider states implemented
- [ ] Schema validation added
- [ ] Breaking change detection
- [ ] CI integration configured
- [ ] Contract documentation
- [ ] Pact Broker setup (if using Pact)
- [ ] Versioning strategy defined
```
