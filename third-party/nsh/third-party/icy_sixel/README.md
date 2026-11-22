# icy_sixel

A high-performance, 100% pure Rust implementation of a SIXEL encoder and decoder.

I wanted a pure Rust implementation to simplify deployment of my cross-platform applications.
In version 0.4.0, I rewrote the encoder using [quantette](https://github.com/IanManske/quantette),
a high-quality color quantization library licensed under MIT/Apache-2.0. It uses Wu's algorithm
with Floyd-Steinberg dithering for excellent results.

The decoder is a clean-room implementation based on the SIXEL specification, with SIMD optimizations for maximum performance.

## Features

- **SIXEL Encoder**: High-quality color quantization with quantette (Wu's algorithm + Floyd-Steinberg dithering)
- **SIXEL Decoder**: Clean-room implementation with RGBA output and SSE2 SIMD acceleration
- **Transparency Support**: Full alpha channel handling in both encoder and decoder
- **Pixel Aspect Ratio**: Configurable P1 parameter (1:1, 2:1, 3:1, 5:1) for VT340 compatibility
- **Background Mode**: Control transparency behavior with P2 parameter (opaque/transparent)
- **Pure Rust**: No C dependencies, easy to build and deploy
- **Cross-platform**: Works on Linux, macOS, and Windows

## Installation

Add this to your `Cargo.toml`:

```toml
[dependencies]
icy_sixel = "0.5"
```

## Usage

### Encoding an Image to SIXEL

```rust
use icy_sixel::SixelImage;

// RGBA image data (4 bytes per pixel)
let rgba = vec![
    255, 0, 0, 255,   // Red pixel
    0, 255, 0, 255,   // Green pixel
    0, 0, 255, 255,   // Blue pixel
];

let image = SixelImage::try_from_rgba(rgba, 3, 1)?;
let sixel = image.encode()?;
print!("{}", sixel);
```

### Encoding with Custom Options

```rust
use icy_sixel::{BackgroundMode, EncodeOptions, PixelAspectRatio, QuantizeMethod, SixelImage};

// RGBA image data (4 bytes per pixel)
let rgba = vec![255, 0, 0, 255];
let width = 1;
let height = 1;

let options = EncodeOptions {
    max_colors: 64,                              // Use only 64 colors (2-256)
    diffusion: 0.875,                            // Floyd-Steinberg dithering strength (0.0-1.0)
    quantize_method: QuantizeMethod::Wu,         // or QuantizeMethod::kmeans()
};

let image = SixelImage::try_from_rgba(rgba, width, height)?
    .with_aspect_ratio(PixelAspectRatio::Square)      // 1:1 pixels (modern terminals)
    .with_background_mode(BackgroundMode::Transparent); // Undrawn pixels stay transparent

let sixel = image.encode_with(&options)?;
```

### Decoding SIXEL to Image Data

```rust
use icy_sixel::SixelImage;

let sixel_data = b"\x1bPq#0;2;100;0;0#0~-\x1b\\";
let image = SixelImage::decode(sixel_data)?;
// image.pixels contains RGBA pixel data (4 bytes per pixel)
// image.width and image.height contain dimensions
```

## Architecture

### Encoder

The encoder uses [quantette](https://github.com/IanManske/quantette) for high-quality
color quantization with Wu's algorithm and Floyd-Steinberg dithering. This produces
excellent results, especially for images with gradients or complex color distributions.

### Decoder

The decoder is a clean-room implementation derived from the SIXEL specification:

- Returns RGBA buffers (4 bytes per pixel) for easy integration with graphics libraries
- SIMD-accelerated horizontal span filling on x86/x86_64 (SSE2)
- Optimized with color caching and loop unrolling
- Comprehensive bounds checking prevents buffer overflows

## Showcase

Original image for reference (596×936 pixels, 879 KB PNG):

![Original](tests/data/beelitz_heilstätten.png)

### Color Palette Comparison (Wu quantizer, full diffusion)

| Colors | SIXEL Size | Result |
|--------|------------|--------|
| 256 | 1.1 MB | ![256 colors](../../assets/wu/256colors_diffusion_full.png) |
| 16 | 440 KB | ![16 colors](../../assets/wu/16colors_diffusion_full.png) |
| 2 | 105 KB | ![2 colors](../../assets/wu/2colors_diffusion_full.png) |

### Dithering Comparison (Wu quantizer, 16 colors)

| Diffusion | SIXEL Size | Result |
|-----------|------------|--------|
| Off (0.0) | 420 KB | ![No diffusion](../../assets/wu/16colors_diffusion_off.png) |
| Full (0.875) | 440 KB | ![Full diffusion](../../assets/wu/16colors_diffusion_full.png) |

### Quantizer Comparison (256 colors, full diffusion)

| Method | SIXEL Size | Result |
|--------|------------|--------|
| Wu | 1.1 MB | ![Wu](../../assets/wu/256colors_diffusion_full.png) |
| K-means | 1.3 MB | ![K-means](../../assets/kmeans/256colors_diffusion_full.png) |

### Encoded SIXEL File Sizes

Complete size matrix for the test image (596×936 pixels):

#### Wu Quantizer

| Colors | Off (0.0) | Low (0.3) | Medium (0.5) | Full (0.875) |
|--------|-----------|-----------|--------------|--------------|
| 256 | 698 KB | 784 KB | 858 KB | 1,066 KB |
| 16 | 420 KB | 427 KB | 432 KB | 439 KB |
| 2 | 71 KB | 84 KB | 93 KB | 105 KB |

#### K-means Quantizer

| Colors | Off (0.0) | Low (0.3) | Medium (0.5) | Full (0.875) |
|--------|-----------|-----------|--------------|--------------|
| 256 | 1,151 KB | 1,182 KB | 1,213 KB | 1,261 KB |
| 16 | 422 KB | 428 KB | 431 KB | 437 KB |
| 2 | 71 KB | 85 KB | 94 KB | 107 KB |

## Benchmarks

Performance measurements on the test image (596×936 pixels, beelitz_heilstätten.png):

### Encoder Performance

| Benchmark | Time |
|-----------|------|
| Default (Wu, 256 colors, full diffusion) | 41.7 ms |

#### Quantizer Comparison

| Quantizer | Time | Notes |
|-----------|------|-------|
| Wu | 41.8 ms | Fast, default |
| K-means | 88.1 ms | 2.1× slower |

#### Color Count Impact

| Colors | Time |
|--------|------|
| 256 | 42.0 ms |
| 16 | 16.3 ms |
| 2 | 10.8 ms |

#### Diffusion Strength Impact

| Diffusion | Time |
|-----------|------|
| Off (0.0) | 21.3 ms |
| Low (0.3) | 31.7 ms |
| Medium (0.5) | 34.1 ms |
| Full (0.875) | 41.9 ms |

### Decoder Performance

| Benchmark | Time |
|-----------|------|
| Simple SIXEL | 151 ns |
| Complex SIXEL | 677 ns |
| Repeated patterns | 1.46 µs |

#### Scaling with Size

| Bands | Time |
|-------|------|
| 10 | 1.3 µs |
| 50 | 15.9 µs |
| 100 | 52.6 µs |
| 200 | 209 µs |

#### Color Palette Size

| Colors | Time |
|--------|------|
| 1 | 150 ns |
| 4 | 485 ns |
| 16 | 2.0 µs |
| 64 | 12.4 µs |

*Benchmarks run with `cargo bench` using Criterion on Linux.*

## License

Licensed under either of

- Apache License, Version 2.0
- MIT license

at your option.
