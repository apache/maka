//! Tailwind CSS v4.3 default palette (`theme.css`), converted from OKLCH to
//! sRGB (out-of-gamut channels clamped). Generated; do not edit.

/// Shades, in this order.
pub(crate) const SHADES: [u16; 11] = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

/// Color names and their shades as `0xRRGGBBAA`.
pub(crate) static PALETTE: [(&str, [u32; 11]); 26] = [
    (
        "red",
        [
            0xfef2f2ff, 0xffe2e2ff, 0xffc9c9ff, 0xffa2a2ff, 0xff6467ff, 0xfb2c36ff, 0xe7000bff,
            0xc10007ff, 0x9f0712ff, 0x82181aff, 0x460809ff,
        ],
    ),
    (
        "orange",
        [
            0xfff7edff, 0xffedd4ff, 0xffd6a7ff, 0xffb86aff, 0xff8904ff, 0xff6900ff, 0xf54900ff,
            0xca3500ff, 0x9f2d00ff, 0x7e2a0cff, 0x441306ff,
        ],
    ),
    (
        "amber",
        [
            0xfffbebff, 0xfef3c6ff, 0xfee685ff, 0xffd230ff, 0xffb900ff, 0xfe9a00ff, 0xe17100ff,
            0xbb4d00ff, 0x973c00ff, 0x7b3306ff, 0x461901ff,
        ],
    ),
    (
        "yellow",
        [
            0xfefce8ff, 0xfef9c2ff, 0xfff085ff, 0xffdf20ff, 0xfdc700ff, 0xf0b100ff, 0xd08700ff,
            0xa65f00ff, 0x894b00ff, 0x733e0aff, 0x432004ff,
        ],
    ),
    (
        "lime",
        [
            0xf7fee7ff, 0xecfccaff, 0xd8f999ff, 0xbbf451ff, 0x9ae600ff, 0x7ccf00ff, 0x5ea500ff,
            0x497d00ff, 0x3c6300ff, 0x35530eff, 0x192e03ff,
        ],
    ),
    (
        "green",
        [
            0xf0fdf4ff, 0xdcfce7ff, 0xb9f8cfff, 0x7bf1a8ff, 0x05df72ff, 0x00c950ff, 0x00a63eff,
            0x008236ff, 0x016630ff, 0x0d542bff, 0x032e15ff,
        ],
    ),
    (
        "emerald",
        [
            0xecfdf5ff, 0xd0fae5ff, 0xa4f4cfff, 0x5ee9b5ff, 0x00d492ff, 0x00bc7dff, 0x009966ff,
            0x007a55ff, 0x006045ff, 0x004f3bff, 0x002c22ff,
        ],
    ),
    (
        "teal",
        [
            0xf0fdfaff, 0xcbfbf1ff, 0x96f7e4ff, 0x46ecd5ff, 0x00d5beff, 0x00bba7ff, 0x009689ff,
            0x00786fff, 0x005f5aff, 0x0b4f4aff, 0x022f2eff,
        ],
    ),
    (
        "cyan",
        [
            0xecfeffff, 0xcefafeff, 0xa2f4fdff, 0x53eafdff, 0x00d3f2ff, 0x00b8dbff, 0x0092b8ff,
            0x007595ff, 0x005f78ff, 0x104e64ff, 0x053345ff,
        ],
    ),
    (
        "sky",
        [
            0xf0f9ffff, 0xdff2feff, 0xb8e6feff, 0x74d4ffff, 0x00bcffff, 0x00a6f4ff, 0x0084d1ff,
            0x0069a8ff, 0x00598aff, 0x024a70ff, 0x052f4aff,
        ],
    ),
    (
        "blue",
        [
            0xeff6ffff, 0xdbeafeff, 0xbedbffff, 0x8ec5ffff, 0x51a2ffff, 0x2b7fffff, 0x155dfcff,
            0x1447e6ff, 0x193cb8ff, 0x1c398eff, 0x162456ff,
        ],
    ),
    (
        "indigo",
        [
            0xeef2ffff, 0xe0e7ffff, 0xc6d2ffff, 0xa3b3ffff, 0x7c86ffff, 0x615fffff, 0x4f39f6ff,
            0x432dd7ff, 0x372aacff, 0x312c85ff, 0x1e1a4dff,
        ],
    ),
    (
        "violet",
        [
            0xf5f3ffff, 0xede9feff, 0xddd6ffff, 0xc4b4ffff, 0xa684ffff, 0x8e51ffff, 0x7f22feff,
            0x7008e7ff, 0x5d0ec0ff, 0x4d179aff, 0x2f0d68ff,
        ],
    ),
    (
        "purple",
        [
            0xfaf5ffff, 0xf3e8ffff, 0xe9d4ffff, 0xdab2ffff, 0xc27affff, 0xad46ffff, 0x9810faff,
            0x8200dbff, 0x6e11b0ff, 0x59168bff, 0x3c0366ff,
        ],
    ),
    (
        "fuchsia",
        [
            0xfdf4ffff, 0xfae8ffff, 0xf6cfffff, 0xf4a8ffff, 0xed6affff, 0xe12afbff, 0xc800deff,
            0xa800b7ff, 0x8a0194ff, 0x721378ff, 0x4b004fff,
        ],
    ),
    (
        "pink",
        [
            0xfdf2f8ff, 0xfce7f3ff, 0xfccee8ff, 0xfda5d5ff, 0xfb64b6ff, 0xf6339aff, 0xe60076ff,
            0xc6005cff, 0xa3004cff, 0x861043ff, 0x510424ff,
        ],
    ),
    (
        "rose",
        [
            0xfff1f2ff, 0xffe4e6ff, 0xffccd3ff, 0xffa1adff, 0xff637eff, 0xff2056ff, 0xec003fff,
            0xc70036ff, 0xa50036ff, 0x8b0836ff, 0x4d0218ff,
        ],
    ),
    (
        "slate",
        [
            0xf8fafcff, 0xf1f5f9ff, 0xe2e8f0ff, 0xcad5e2ff, 0x90a1b9ff, 0x62748eff, 0x45556cff,
            0x314158ff, 0x1d293dff, 0x0f172bff, 0x020618ff,
        ],
    ),
    (
        "gray",
        [
            0xf9fafbff, 0xf3f4f6ff, 0xe5e7ebff, 0xd1d5dcff, 0x99a1afff, 0x6a7282ff, 0x4a5565ff,
            0x364153ff, 0x1e2939ff, 0x101828ff, 0x030712ff,
        ],
    ),
    (
        "zinc",
        [
            0xfafafaff, 0xf4f4f5ff, 0xe4e4e7ff, 0xd4d4d8ff, 0x9f9fa9ff, 0x71717bff, 0x52525cff,
            0x3f3f46ff, 0x27272aff, 0x18181bff, 0x09090bff,
        ],
    ),
    (
        "neutral",
        [
            0xfafafaff, 0xf5f5f5ff, 0xe5e5e5ff, 0xd4d4d4ff, 0xa1a1a1ff, 0x737373ff, 0x525252ff,
            0x404040ff, 0x262626ff, 0x171717ff, 0x0a0a0aff,
        ],
    ),
    (
        "stone",
        [
            0xfafaf9ff, 0xf5f5f4ff, 0xe7e5e4ff, 0xd6d3d1ff, 0xa6a09bff, 0x79716bff, 0x57534dff,
            0x44403bff, 0x292524ff, 0x1c1917ff, 0x0c0a09ff,
        ],
    ),
    (
        "mauve",
        [
            0xfafafaff, 0xf3f1f3ff, 0xe7e4e7ff, 0xd7d0d7ff, 0xa89ea9ff, 0x79697bff, 0x594c5bff,
            0x463947ff, 0x2a212cff, 0x1d161eff, 0x0c090cff,
        ],
    ),
    (
        "olive",
        [
            0xfbfbf9ff, 0xf4f4f0ff, 0xe8e8e3ff, 0xd8d8d0ff, 0xabab9cff, 0x7c7c67ff, 0x5b5b4bff,
            0x474739ff, 0x2b2b22ff, 0x1d1d16ff, 0x0c0c09ff,
        ],
    ),
    (
        "mist",
        [
            0xf9fbfbff, 0xf1f3f3ff, 0xe3e7e8ff, 0xd0d6d8ff, 0x9ca8abff, 0x67787cff, 0x4b585bff,
            0x394447ff, 0x22292bff, 0x161b1dff, 0x090b0cff,
        ],
    ),
    (
        "taupe",
        [
            0xfbfaf9ff, 0xf3f1f1ff, 0xe8e4e3ff, 0xd8d2d0ff, 0xaba09cff, 0x7c6d67ff, 0x5b4f4bff,
            0x473c39ff, 0x2b2422ff, 0x1d1816ff, 0x0c0a09ff,
        ],
    ),
];
