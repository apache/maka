//! `transform` lists: React Native / CSS semantics, composed into 4×4
//! matrices and decomposed again for platforms that only take separate
//! translation / scale / rotation properties (Android views).
//!
//! Matrices use Core Animation's layout (`CATransform3D`): row vectors,
//! `m41..m43` hold the translation. A list `[A, B]` means "apply B, then
//! A" like CSS, which in row-vector form is `B · A`.

use crate::geometry::{Points, Radians, Size};

/// Most entries a `transform` list can have: room for every step
/// Tailwind's utilities compose (`translate`, `rotate`, `scale`, then
/// `rotateX() rotateY() rotateZ() skewX() skewY()`) and the perspective of
/// `perspective-*`.
pub const MAX_TRANSFORMS: usize = 16;

/// One kind of transform entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TransformKind {
    /// `translateX`, points.
    TranslateX,
    /// `translateY`, points.
    TranslateY,
    /// `scale`.
    Scale,
    /// `scaleX`.
    ScaleX,
    /// `scaleY`.
    ScaleY,
    /// `rotate` / `rotateZ`, degrees clockwise.
    Rotate,
    /// `rotateX`, degrees.
    RotateX,
    /// `rotateY`, degrees.
    RotateY,
    /// `skewX`, degrees.
    SkewX,
    /// `skewY`, degrees.
    SkewY,
    /// `perspective`, the distance of the viewer in points.
    Perspective,
    /// A translation by a fraction of the view's width (`translate-x-1/2`);
    /// the core turns it into `TranslateX` with the view's size before it
    /// reaches a platform.
    TranslateXFraction,
    /// A translation by a fraction of the view's height.
    TranslateYFraction,
}

impl TransformKind {
    /// Parses a transform key.
    pub fn parse(key: &str) -> Option<Self> {
        use TransformKind::*;
        Some(match key {
            "translateX" => TranslateX,
            "translateY" => TranslateY,
            "scale" => Scale,
            "scaleX" => ScaleX,
            "scaleY" => ScaleY,
            "rotate" | "rotateZ" => Rotate,
            "rotateX" => RotateX,
            "rotateY" => RotateY,
            "skewX" => SkewX,
            "skewY" => SkewY,
            "perspective" => Perspective,
            _ => return None,
        })
    }

    /// True for kinds whose value is an angle (`"45deg"` strings).
    pub fn is_angle(self) -> bool {
        use TransformKind::*;
        matches!(self, Rotate | RotateX | RotateY | SkewX | SkewY)
    }

    /// The value that changes nothing.
    pub fn identity(self) -> f32 {
        use TransformKind::*;
        match self {
            Scale | ScaleX | ScaleY => 1.0,
            _ => 0.0,
        }
    }
}

/// One entry of a `transform` list.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TransformOp {
    /// What the entry does.
    pub kind: TransformKind,
    /// Its amount (points, degrees or a factor).
    pub value: f32,
}

/// A `transform` list. Fixed capacity, so styles stay `Copy`.
#[derive(Clone, Copy, PartialEq)]
pub struct Transform {
    ops: [TransformOp; MAX_TRANSFORMS],
    len: u8,
}

impl std::fmt::Debug for Transform {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list().entries(self.ops()).finish()
    }
}

impl Transform {
    /// The empty list.
    pub const IDENTITY: Transform = Transform {
        ops: [TransformOp {
            kind: TransformKind::TranslateX,
            value: 0.0,
        }; MAX_TRANSFORMS],
        len: 0,
    };

    /// The entries, in order.
    #[inline]
    pub fn ops(&self) -> &[TransformOp] {
        &self.ops[..self.len as usize]
    }

    /// Appends an entry; returns its index, or `None` when the list is full.
    pub fn push(&mut self, kind: TransformKind, value: f32) -> Option<u8> {
        let i = self.len as usize;
        if i == MAX_TRANSFORMS {
            return None;
        }
        self.ops[i] = TransformOp { kind, value };
        self.len += 1;
        Some(i as u8)
    }

    /// Whether some entry is a fraction of the view's size.
    pub fn has_fractions(&self) -> bool {
        self.ops().iter().any(|op| {
            matches!(
                op.kind,
                TransformKind::TranslateXFraction | TransformKind::TranslateYFraction
            )
        })
    }

    /// The list with size fractions turned into points for a view of
    /// `size`.
    pub fn resolve_fractions(&self, size: Size<Points>) -> Transform {
        let mut t = *self;
        for op in &mut t.ops[..t.len as usize] {
            match op.kind {
                TransformKind::TranslateXFraction => {
                    *op = TransformOp {
                        kind: TransformKind::TranslateX,
                        value: op.value * size.width.0,
                    }
                }
                TransformKind::TranslateYFraction => {
                    *op = TransformOp {
                        kind: TransformKind::TranslateY,
                        value: op.value * size.height.0,
                    }
                }
                _ => {}
            }
        }
        t
    }

    /// True if the list is empty or every entry is an identity.
    pub fn is_identity(&self) -> bool {
        self.ops().iter().all(|op| op.value == op.kind.identity())
    }

    /// Composes the list. `value(i)` may override entry `i`'s amount (an
    /// animated value).
    pub fn matrix(&self, value: impl Fn(usize) -> Option<f32>) -> Matrix {
        let mut m = Matrix::IDENTITY;
        for (i, op) in self.ops().iter().enumerate() {
            let v = value(i).unwrap_or(op.value) as f64;
            // [A, B] applies B first: in row-vector form, B · A.
            m = Matrix::of(op.kind, v).mul(&m);
        }
        m
    }
}

impl Default for Transform {
    fn default() -> Self {
        Self::IDENTITY
    }
}

/// A 4×4 matrix in `CATransform3D` layout (`m[0..4]` is the first row).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Matrix(pub [f64; 16]);

impl Matrix {
    /// The identity.
    pub const IDENTITY: Matrix = Matrix([
        1.0, 0.0, 0.0, 0.0, //
        0.0, 1.0, 0.0, 0.0, //
        0.0, 0.0, 1.0, 0.0, //
        0.0, 0.0, 0.0, 1.0,
    ]);

    /// The matrix of one transform entry.
    pub fn of(kind: TransformKind, v: f64) -> Matrix {
        let mut m = Matrix::IDENTITY;
        let a = &mut m.0;
        let (sin, cos) = v.to_radians().sin_cos();
        match kind {
            TransformKind::TranslateX => a[12] = v,
            TransformKind::TranslateY => a[13] = v,
            TransformKind::Scale => (a[0], a[5]) = (v, v),
            TransformKind::ScaleX => a[0] = v,
            TransformKind::ScaleY => a[5] = v,
            TransformKind::Rotate => {
                (a[0], a[1], a[4], a[5]) = (cos, sin, -sin, cos);
            }
            TransformKind::RotateX => {
                (a[5], a[6], a[9], a[10]) = (cos, sin, -sin, cos);
            }
            TransformKind::RotateY => {
                (a[0], a[2], a[8], a[10]) = (cos, -sin, sin, cos);
            }
            TransformKind::SkewX => a[4] = v.to_radians().tan(),
            TransformKind::SkewY => a[1] = v.to_radians().tan(),
            TransformKind::Perspective => {
                if v != 0.0 {
                    a[11] = -1.0 / v;
                }
            }
            // Resolved by the core (`Transform::resolve_fractions`).
            TransformKind::TranslateXFraction | TransformKind::TranslateYFraction => {}
        }
        m
    }

    /// `self · other`: apply `self`, then `other` (row vectors).
    pub fn mul(&self, other: &Matrix) -> Matrix {
        let (a, b) = (&self.0, &other.0);
        let mut out = [0.0; 16];
        for r in 0..4 {
            for c in 0..4 {
                out[r * 4 + c] = (0..4).map(|k| a[r * 4 + k] * b[k * 4 + c]).sum();
            }
        }
        Matrix(out)
    }

    /// True if the matrix is a 2D affine transform (no depth, no
    /// perspective).
    pub fn is_2d(&self) -> bool {
        let m = &self.0;
        let zero = |v: f64| v.abs() < 1e-9;
        zero(m[2])
            && zero(m[3])
            && zero(m[6])
            && zero(m[7])
            && zero(m[8])
            && zero(m[9])
            && (m[10] - 1.0).abs() < 1e-9
            && zero(m[11])
            && zero(m[14])
            && (m[15] - 1.0).abs() < 1e-9
    }

    /// Splits the matrix into the separate properties of an Android view.
    /// Skew has no view property and is dropped. `None` for degenerate
    /// matrices (a zero scale).
    pub fn decompose(&self) -> Option<Decomposed> {
        if self.is_2d() {
            return Some(self.decompose_2d());
        }
        self.decompose_3d()
    }

    fn decompose_2d(&self) -> Decomposed {
        let m = &self.0;
        let (a, b, c, d) = (m[0], m[1], m[4], m[5]);
        let scale_x = (a * a + b * b).sqrt();
        let det = a * d - b * c;
        // A mirrored matrix keeps its rotation; the flip goes to scale y.
        let scale_y = if scale_x > 0.0 {
            det / scale_x
        } else {
            (c * c + d * d).sqrt()
        };
        Decomposed {
            translate: [points(m[12]), points(m[13]), Points::ZERO],
            scale: [scale_x, scale_y, 1.0],
            rotate: [Radians::ZERO, Radians::ZERO, angle(b.atan2(a))],
            perspective: None,
        }
    }

    /// The CSS Transforms "decomposing a 3D matrix" algorithm, with the
    /// rotation as Euler angles (X then Y then Z).
    fn decompose_3d(&self) -> Option<Decomposed> {
        let mut m = [[0.0f64; 4]; 4];
        for (r, row) in m.iter_mut().enumerate() {
            row.copy_from_slice(&self.0[r * 4..r * 4 + 4]);
        }
        if m[3][3] == 0.0 {
            return None;
        }
        let w = m[3][3];
        for row in &mut m {
            for v in row {
                *v /= w;
            }
        }
        let term: f64 = if m[0][3] != 0.0 || m[1][3] != 0.0 || m[2][3] != 0.0 {
            // Solve rhs = p · P for the perspective row p, where P is the
            // matrix without its perspective column; only the z term matters
            // for a camera distance.
            let mut p = m;
            for row in p.iter_mut().take(3) {
                row[3] = 0.0;
            }
            p[3][3] = 1.0;
            let inverse = invert(&p)?;
            let rhs = [m[0][3], m[1][3], m[2][3], m[3][3]];
            (0..4).map(|k| inverse[2][k] * rhs[k]).sum()
        } else {
            0.0
        };
        // The term is `-1 / distance`.
        let perspective = (term != 0.0).then(|| points(-1.0 / term));
        let translate = [points(m[3][0]), points(m[3][1]), points(m[3][2])];
        let mut rows = [
            [m[0][0], m[0][1], m[0][2]],
            [m[1][0], m[1][1], m[1][2]],
            [m[2][0], m[2][1], m[2][2]],
        ];
        let len = |v: &[f64; 3]| (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        let dot = |a: &[f64; 3], b: &[f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        let mut scale = [0.0; 3];
        scale[0] = len(&rows[0]);
        if scale[0] == 0.0 {
            return None;
        }
        rows[0] = rows[0].map(|v| v / scale[0]);
        let xy = dot(&rows[0], &rows[1]);
        rows[1] = [0, 1, 2].map(|i| rows[1][i] - rows[0][i] * xy);
        scale[1] = len(&rows[1]);
        if scale[1] == 0.0 {
            return None;
        }
        rows[1] = rows[1].map(|v| v / scale[1]);
        let xz = dot(&rows[0], &rows[2]);
        rows[2] = [0, 1, 2].map(|i| rows[2][i] - rows[0][i] * xz);
        let yz = dot(&rows[1], &rows[2]);
        rows[2] = [0, 1, 2].map(|i| rows[2][i] - rows[1][i] * yz);
        scale[2] = len(&rows[2]);
        if scale[2] == 0.0 {
            return None;
        }
        rows[2] = rows[2].map(|v| v / scale[2]);
        let cross = [
            rows[1][1] * rows[2][2] - rows[1][2] * rows[2][1],
            rows[1][2] * rows[2][0] - rows[1][0] * rows[2][2],
            rows[1][0] * rows[2][1] - rows[1][1] * rows[2][0],
        ];
        if dot(&rows[0], &cross) < 0.0 {
            for i in 0..3 {
                scale[i] = -scale[i];
                rows[i] = rows[i].map(|v| -v);
            }
        }
        // Euler angles of the rotation rows (R = Rx · Ry · Rz in row-vector
        // order: X applied first).
        let ry = (-rows[0][2]).clamp(-1.0, 1.0).asin();
        let (rx, rz) = if ry.cos().abs() > 1e-6 {
            (rows[1][2].atan2(rows[2][2]), rows[0][1].atan2(rows[0][0]))
        } else {
            (0.0, (-rows[1][0]).atan2(rows[1][1]))
        };
        Some(Decomposed {
            translate,
            scale,
            rotate: [angle(rx), angle(ry), angle(rz)],
            perspective,
        })
    }
}

/// A length the matrices computed in `f64`.
fn points(v: f64) -> Points {
    Points(v as f32)
}

/// An angle the matrices computed in `f64`.
fn angle(v: f64) -> Radians {
    Radians(v as f32)
}

/// The inverse of a 4×4 matrix (Gauss-Jordan); `None` if singular.
fn invert(m: &[[f64; 4]; 4]) -> Option<[[f64; 4]; 4]> {
    let mut a = *m;
    let mut inv = [[0.0; 4]; 4];
    for (i, row) in inv.iter_mut().enumerate() {
        row[i] = 1.0;
    }
    for col in 0..4 {
        let pivot = (col..4).max_by(|&x, &y| a[x][col].abs().total_cmp(&a[y][col].abs()))?;
        if a[pivot][col].abs() < 1e-12 {
            return None;
        }
        a.swap(col, pivot);
        inv.swap(col, pivot);
        let d = a[col][col];
        for k in 0..4 {
            a[col][k] /= d;
            inv[col][k] /= d;
        }
        for r in 0..4 {
            if r != col {
                let f = a[r][col];
                for k in 0..4 {
                    a[r][k] -= f * a[col][k];
                    inv[r][k] -= f * inv[col][k];
                }
            }
        }
    }
    Some(inv)
}

/// A matrix split into view properties.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Decomposed {
    /// Translation along x, y and z.
    pub translate: [Points; 3],
    /// Scale factors.
    pub scale: [f64; 3],
    /// Rotation around x, y and z (z clockwise on screen).
    pub rotate: [Radians; 3],
    /// The viewer's distance (`perspective`), `None` without perspective.
    pub perspective: Option<Points>,
}

/// CSS's `transform` (`"translateX(10px) rotate(45deg) scale(1.5)"`,
/// `"none"`) as entries, in order: `translate()` / `translateX()` /
/// `translateY()` (lengths, or percentages of the view's size), `scale()`
/// / `scaleX()` / `scaleY()`, `rotate()` / `rotateZ()` / `rotateX()` /
/// `rotateY()`, `skew()` / `skewX()` / `skewY()` (angles) and
/// `perspective()`. `None` for anything else.
pub(crate) fn parse_css(s: &str) -> Option<Vec<TransformOp>> {
    let mut out = Vec::new();
    let mut rest = s.trim();
    if rest == "none" {
        return Some(out);
    }
    while !rest.is_empty() {
        let open = rest.find('(')?;
        let close = open + rest[open..].find(')')?;
        let args: Vec<&str> = rest[open + 1..close].split(',').map(str::trim).collect();
        function(rest[..open].trim(), &args, &mut out)?;
        rest = rest[close + 1..].trim_start();
    }
    Some(out)
}

/// One function of [`parse_css`], pushed onto `out`.
fn function(name: &str, args: &[&str], out: &mut Vec<TransformOp>) -> Option<()> {
    use TransformKind::*;
    let op = |kind, value| TransformOp { kind, value };
    match name {
        "translate" if matches!(args.len(), 1 | 2) => {
            out.push(translation(false, args[0])?);
            if let Some(y) = args.get(1) {
                out.push(translation(true, y)?);
            }
        }
        "translateX" | "translateY" if args.len() == 1 => {
            out.push(translation(name == "translateY", args[0])?)
        }
        "scale" if args.len() == 1 => out.push(op(Scale, crate::css::amount(args[0])?)),
        "scale" if args.len() == 2 => {
            out.push(op(ScaleX, crate::css::amount(args[0])?));
            out.push(op(ScaleY, crate::css::amount(args[1])?));
        }
        "scaleX" | "scaleY" | "rotate" | "rotateZ" | "rotateX" | "rotateY" | "skewX" | "skewY"
        | "perspective"
            if args.len() == 1 =>
        {
            let kind = match name {
                "rotateZ" => Rotate,
                other => TransformKind::parse(other)?,
            };
            let value = match kind {
                Perspective => crate::css::length(args[0])?,
                k if k.is_angle() => crate::css::angle(args[0])?,
                _ => crate::css::amount(args[0])?,
            };
            out.push(op(kind, value));
        }
        "skew" if matches!(args.len(), 1 | 2) => {
            out.push(op(SkewX, crate::css::angle(args[0])?));
            if let Some(y) = args.get(1) {
                out.push(op(SkewY, crate::css::angle(y)?));
            }
        }
        _ => return None,
    }
    Some(())
}

/// A translation along x (or y when `vertical`) as CSS writes one: a
/// length (`"10px"`, `"2rem"`, `"0"`), or a percentage of the view's size.
pub fn translation(vertical: bool, s: &str) -> Option<TransformOp> {
    use TransformKind::*;
    let (kind, value) = match s.trim().strip_suffix('%') {
        Some(p) => (
            if vertical {
                TranslateYFraction
            } else {
                TranslateXFraction
            },
            crate::css::number(p)? / 100.0,
        ),
        None => (
            if vertical { TranslateY } else { TranslateX },
            crate::css::length(s)?,
        ),
    };
    Some(TransformOp { kind, value })
}

/// CSS's `translate` property (`"10px"`, `"10px 50%"`, `"none"`): x, then
/// y when given.
pub(crate) fn parse_translate(s: &str) -> Option<Vec<TransformOp>> {
    let s = s.trim();
    if s == "none" {
        return Some(Vec::new());
    }
    let parts: Vec<&str> = s.split_whitespace().collect();
    match parts[..] {
        [x] => Some(vec![translation(false, x)?]),
        [x, y] => Some(vec![translation(false, x)?, translation(true, y)?]),
        _ => None,
    }
}

/// CSS's `rotate` property (`"45deg"`, `"x 90deg"`, `"none"`): a turn
/// about the z axis, or the x, y or z axis it names.
pub(crate) fn parse_rotate(s: &str) -> Option<Vec<TransformOp>> {
    let s = s.trim();
    if s == "none" {
        return Some(Vec::new());
    }
    let parts: Vec<&str> = s.split_whitespace().collect();
    let (kind, angle) = match parts[..] {
        [a] => (TransformKind::Rotate, a),
        ["x", a] => (TransformKind::RotateX, a),
        ["y", a] => (TransformKind::RotateY, a),
        ["z", a] => (TransformKind::Rotate, a),
        _ => return None,
    };
    Some(vec![TransformOp {
        kind,
        value: crate::css::angle(angle)?,
    }])
}

/// CSS's `scale` property (`"1.5"`, `"150%"`, `"1 2"`, `"none"`): one
/// factor for both axes, or x and y.
pub(crate) fn parse_scale(s: &str) -> Option<Vec<TransformOp>> {
    let s = s.trim();
    if s == "none" {
        return Some(Vec::new());
    }
    let parts: Vec<&str> = s.split_whitespace().collect();
    let op = |kind, s: &str| {
        Some(TransformOp {
            kind,
            value: crate::css::amount(s)?,
        })
    };
    match parts[..] {
        [k] => Some(vec![op(TransformKind::Scale, k)?]),
        [x, y] => Some(vec![
            op(TransformKind::ScaleX, x)?,
            op(TransformKind::ScaleY, y)?,
        ]),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    /// Equal up to `f32`'s precision.
    fn near(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-3
    }

    #[test]
    fn css_transforms_parse_as_a_browser_reads_them() {
        use TransformKind::*;
        let ops = |s: &str| {
            parse_css(s).map(|ops| ops.iter().map(|o| (o.kind, o.value)).collect::<Vec<_>>())
        };
        assert_eq!(
            ops("translateX(10px) rotate(45deg) scale(1.5)"),
            Some(vec![(TranslateX, 10.0), (Rotate, 45.0), (Scale, 1.5)])
        );
        assert_eq!(
            ops("translate(50%, 2rem) skew(10deg) perspective(800px) rotateY(0.25turn)"),
            Some(vec![
                (TranslateXFraction, 0.5),
                (TranslateY, 32.0),
                (SkewX, 10.0),
                (Perspective, 800.0),
                (RotateY, 90.0)
            ])
        );
        assert_eq!(ops("scale(1, 2)"), Some(vec![(ScaleX, 1.0), (ScaleY, 2.0)]));
        assert_eq!(ops("none"), Some(vec![]));
        // What NSH does not do is rejected, never read another way.
        assert_eq!(ops("matrix(1, 0, 0, 1, 0, 0)"), None);
        assert_eq!(ops("rotate(45)"), None);
        assert_eq!(ops("translateX(10px"), None);
        let one = |r: Option<Vec<TransformOp>>| {
            r.map(|ops| ops.iter().map(|o| (o.kind, o.value)).collect::<Vec<_>>())
        };
        assert_eq!(
            one(parse_translate("10px 50%")),
            Some(vec![(TranslateX, 10.0), (TranslateYFraction, 0.5)])
        );
        assert_eq!(one(parse_rotate("x 90deg")), Some(vec![(RotateX, 90.0)]));
        assert_eq!(one(parse_rotate("45deg")), Some(vec![(Rotate, 45.0)]));
        assert_eq!(one(parse_scale("150%")), Some(vec![(Scale, 1.5)]));
        assert_eq!(
            one(parse_scale("1 2")),
            Some(vec![(ScaleX, 1.0), (ScaleY, 2.0)])
        );
    }

    fn list(ops: &[(TransformKind, f32)]) -> Transform {
        let mut t = Transform::IDENTITY;
        for &(k, v) in ops {
            t.push(k, v).unwrap();
        }
        t
    }

    /// Applies a matrix to a point (row vector).
    fn apply(m: &Matrix, x: f64, y: f64) -> (f64, f64) {
        let a = &m.0;
        let w = x * a[3] + y * a[7] + a[15];
        (
            (x * a[0] + y * a[4] + a[12]) / w,
            (x * a[1] + y * a[5] + a[13]) / w,
        )
    }

    #[test]
    fn lists_apply_right_to_left_like_css() {
        // translateX(50) rotate(90deg): rotate first, then move right.
        let m = list(&[
            (TransformKind::TranslateX, 50.0),
            (TransformKind::Rotate, 90.0),
        ])
        .matrix(|_| None);
        let (x, y) = apply(&m, 10.0, 0.0);
        // (10, 0) rotated 90° clockwise (y down) is (0, 10), then moved by 50.
        assert!(close(x, 50.0) && close(y, 10.0), "{x} {y}");
        // The other order moves first, then rotates around the origin.
        let m = list(&[
            (TransformKind::Rotate, 90.0),
            (TransformKind::TranslateX, 50.0),
        ])
        .matrix(|_| None);
        let (x, y) = apply(&m, 10.0, 0.0);
        assert!(close(x, 0.0) && close(y, 60.0), "{x} {y}");
    }

    #[test]
    fn overrides_replace_entries() {
        let t = list(&[(TransformKind::TranslateY, 5.0)]);
        let m = t.matrix(|i| (i == 0).then_some(20.0));
        assert!(close(m.0[13], 20.0));
    }

    #[test]
    fn decomposes_2d_and_3d() {
        let t = list(&[
            (TransformKind::TranslateX, 12.0),
            (TransformKind::Rotate, 135.0),
            (TransformKind::Scale, 2.0),
        ]);
        let d = t.matrix(|_| None).decompose().unwrap();
        assert!(near(d.translate[0].0, 12.0));
        assert!(close(d.scale[0], 2.0) && close(d.scale[1], 2.0));
        assert!(near(d.rotate[2].to_degrees(), 135.0), "{:?}", d.rotate);

        let t = list(&[
            (TransformKind::Perspective, 800.0),
            (TransformKind::RotateY, 30.0),
        ]);
        let d = t.matrix(|_| None).decompose().unwrap();
        assert!(near(d.rotate[1].to_degrees(), 30.0), "{:?}", d.rotate);
        let distance = d.perspective.unwrap();
        assert!(near(distance.0, 800.0), "{distance:?}");

        let t = list(&[(TransformKind::RotateX, -40.0)]);
        let d = t.matrix(|_| None).decompose().unwrap();
        assert!(near(d.rotate[0].to_degrees(), -40.0), "{:?}", d.rotate);
        assert!(
            list(&[(TransformKind::Scale, 0.0)])
                .matrix(|_| None)
                .decompose()
                .is_some()
        );
    }

    #[test]
    fn identity_detection() {
        assert!(Transform::IDENTITY.is_identity());
        assert!(list(&[(TransformKind::Scale, 1.0)]).is_identity());
        assert!(!list(&[(TransformKind::SkewX, 10.0)]).is_identity());
    }
}
