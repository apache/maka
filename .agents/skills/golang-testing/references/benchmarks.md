# Benchmarks in a Test Suite

Benchmarking methodology — `benchstat`, profiling from benchmarks, noise control, CI regression detection — belongs to the `samber/cc-skills-golang@golang-benchmark` skill. This page only covers writing a benchmark that sits next to the tests of the same package.

## Shape

```go
func BenchmarkStringConcatenation(b *testing.B) {
    b.Run("plus-operator", func(b *testing.B) {
        for b.Loop() {
            result := "a" + "b" + "c"
            _ = result
        }
    })

    b.Run("strings.Builder", func(b *testing.B) {
        for b.Loop() {
            var builder strings.Builder
            builder.WriteString("a")
            builder.WriteString("b")
            builder.WriteString("c")
            _ = builder.String()
        }
    })
}
```

Sub-benchmarks give each variant its own name in the output, which is what `benchstat` compares. A single benchmark mixing both variants produces one number and hides the difference.

## Varying input size

```go
func BenchmarkFibonacci(b *testing.B) {
    sizes := []int{10, 20, 30}
    for _, size := range sizes {
        b.Run(fmt.Sprintf("n=%d", size), func(b *testing.B) {
            b.ReportAllocs()
            for b.Loop() {
                Fibonacci(size)
            }
        })
    }
}
```

Size-parameterized sub-benchmarks expose complexity growth: a jump that outpaces the size increase points at a superlinear algorithm, which no single-size benchmark reveals.

## `b.Loop()` vs `b.N`

For Go 1.24+, write new benchmarks with `b.Loop()` — it keeps setup outside the timed region and prevents the compiler from optimizing the loop body away, the two failure modes that make `b.N` benchmarks report impossibly fast results. Use a legacy `b.N` loop only when the module targets Go <1.24 or when preserving existing benchmark code intentionally.

→ See `samber/cc-skills-golang@golang-benchmark` skill for measurement methodology and regression detection.
