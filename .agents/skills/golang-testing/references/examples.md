# Examples as Documentation

Examples are executable documentation: `go test` runs them and compares stdout to the `// Output:` comment, and `pkg.go.dev` renders them next to the documented symbol. An example that drifts from the API fails the build, unlike a code block in a README.

```go
func ExampleCalculatePrice() {
    price := CalculatePrice(100, 10.0)
    fmt.Printf("Price: %.2f\n", price)
    // Output: Price: 900.00
}

func ExampleCalculatePrice_singleItem() {
    price := CalculatePrice(1, 25.50)
    fmt.Printf("Price: %.2f\n", price)
    // Output: Price: 25.50
}
```

## Naming

The suffix decides where godoc attaches the example, so a typo silently detaches it from its symbol:

| Function name               | Documents                          |
| --------------------------- | ---------------------------------- |
| `Example()`                 | The package itself                 |
| `ExampleCalculatePrice()`   | The `CalculatePrice` function      |
| `ExampleStore_Get()`        | The `Get` method of `Store`        |
| `ExampleStore_Get_cached()` | A named variant of the same method |

The suffix after the second underscore MUST start with a lowercase letter — otherwise Go reads it as a type or method name and the example is orphaned.

## Output directives

- `// Output:` — stdout MUST match exactly (leading/trailing whitespace is trimmed).
- `// Unordered output:` — lines may arrive in any order. Use it for map iteration and concurrent producers, which have no stable order.
- **No output comment** — the example is compiled but not run. Useful for code that needs a live dependency, but it stops verifying behavior, so prefer a real output assertion.

## Placement

Examples live in `_test.go` files. Put them in the `package foo_test` external test package: an example that only compiles against the exported API proves the public surface is usable, which is the point of the example.
