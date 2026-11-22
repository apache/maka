//! Transforms: a 4x4 matrix in Direct2D's row-vector convention (a point
//! is `[x y z 1] · M`), built like CSS (and GSK) transform lists: each
//! method returns the matrix with the new operation applied to points
//! *before* the existing ones, so `t.translate(..).rotate(..)` rotates
//! first, as `transform: translate(..) rotate(..)` does.
//!
//! Views sit in the plane z = 0, so only the homography of that plane
//! matters for drawing and hit testing ([`Mat4::is_affine`],
//! [`Mat4::to_3x2`], [`Mat4::unproject`]); perspective makes it projective,
//! which [`crate::render`] draws through an offscreen bitmap.

use nsh_core::{Bounds, Point, Points, Size};
use windows_numerics::Matrix3x2;

/// A rectangle of `width` x `height` at `(x, y)`.
pub(crate) fn rect(x: f32, y: f32, width: f32, height: f32) -> Bounds<Points> {
    Bounds {
        origin: Point {
            x: Points(x),
            y: Points(y),
        },
        size: Size {
            width: Points(width),
            height: Points(height),
        },
    }
}

/// A 4x4 transform (row-vector convention: `m[row][col]`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Mat4 {
    /// The entries.
    pub(crate) m: [[f32; 4]; 4],
}

impl Default for Mat4 {
    fn default() -> Self {
        Mat4::IDENTITY
    }
}

impl Mat4 {
    /// The identity.
    pub(crate) const IDENTITY: Mat4 = Mat4 {
        m: [
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ],
    };

    /// A new identity transform.
    pub(crate) fn new() -> Mat4 {
        Mat4::IDENTITY
    }

    /// `a · b`: `a` applied to points first, then `b`.
    pub(crate) fn mul(a: &Mat4, b: &Mat4) -> Mat4 {
        let mut out = [[0.0f32; 4]; 4];
        for (r, row) in out.iter_mut().enumerate() {
            for (c, v) in row.iter_mut().enumerate() {
                *v = (0..4).map(|k| a.m[r][k] * b.m[k][c]).sum();
            }
        }
        Mat4 { m: out }
    }

    /// `op` applied to points before `self`.
    pub(crate) fn then_before(self, op: &Mat4) -> Mat4 {
        Mat4::mul(op, &self)
    }

    /// `self` followed by `next` (points go through `self` first).
    pub(crate) fn then(self, next: &Mat4) -> Mat4 {
        Mat4::mul(&self, next)
    }

    /// Translated by `(x, y)` (applied first).
    pub(crate) fn translate(self, x: f32, y: f32) -> Mat4 {
        self.translate_3d(x, y, 0.0)
    }

    /// Translated by `(x, y, z)` (applied first).
    pub(crate) fn translate_3d(self, x: f32, y: f32, z: f32) -> Mat4 {
        let mut t = Mat4::IDENTITY;
        t.m[3] = [x, y, z, 1.0];
        self.then_before(&t)
    }

    /// Scaled (applied first).
    pub(crate) fn scale(self, sx: f32, sy: f32) -> Mat4 {
        let mut t = Mat4::IDENTITY;
        t.m[0][0] = sx;
        t.m[1][1] = sy;
        self.then_before(&t)
    }

    /// Rotated by `degrees` in the plane, clockwise on screen (y down), as
    /// CSS `rotate` (applied first).
    pub(crate) fn rotate(self, degrees: f32) -> Mat4 {
        let (s, c) = degrees.to_radians().sin_cos();
        let mut t = Mat4::IDENTITY;
        t.m[0][0] = c;
        t.m[0][1] = s;
        t.m[1][0] = -s;
        t.m[1][1] = c;
        self.then_before(&t)
    }

    /// Rotated by `degrees` about the x axis (CSS `rotateX`).
    pub(crate) fn rotate_x(self, degrees: f32) -> Mat4 {
        let (s, c) = degrees.to_radians().sin_cos();
        let mut t = Mat4::IDENTITY;
        t.m[1][1] = c;
        t.m[1][2] = s;
        t.m[2][1] = -s;
        t.m[2][2] = c;
        self.then_before(&t)
    }

    /// Rotated by `degrees` about the y axis (CSS `rotateY`).
    pub(crate) fn rotate_y(self, degrees: f32) -> Mat4 {
        let (s, c) = degrees.to_radians().sin_cos();
        let mut t = Mat4::IDENTITY;
        t.m[0][0] = c;
        t.m[0][2] = -s;
        t.m[2][0] = s;
        t.m[2][2] = c;
        self.then_before(&t)
    }

    /// Skewed by `x` and `y` degrees (CSS `skew`).
    pub(crate) fn skew(self, x: f32, y: f32) -> Mat4 {
        let mut t = Mat4::IDENTITY;
        t.m[0][1] = y.to_radians().tan();
        t.m[1][0] = x.to_radians().tan();
        self.then_before(&t)
    }

    /// CSS `perspective(d)`.
    pub(crate) fn perspective(self, d: f32) -> Mat4 {
        if d <= 0.0 {
            return self;
        }
        let mut t = Mat4::IDENTITY;
        t.m[2][3] = -1.0 / d;
        self.then_before(&t)
    }

    /// True when it maps the plane z = 0 affinely (no perspective): it can
    /// be drawn with a 3x2 world transform.
    pub(crate) fn is_affine(&self) -> bool {
        self.m[0][3] == 0.0 && self.m[1][3] == 0.0 && self.m[3][3] == 1.0
    }

    /// The plane's affine map as Direct2D's 3x2 matrix (exact when
    /// [`Mat4::is_affine`]; otherwise the perspective is dropped).
    pub(crate) fn to_3x2(self) -> Matrix3x2 {
        Matrix3x2 {
            M11: self.m[0][0],
            M12: self.m[0][1],
            M21: self.m[1][0],
            M22: self.m[1][1],
            M31: self.m[3][0],
            M32: self.m[3][1],
        }
    }

    /// The homography of the plane z = 0: rows x, y and w, columns x, y, w.
    fn homography(&self) -> [[f32; 3]; 3] {
        let m = &self.m;
        [
            [m[0][0], m[0][1], m[0][3]],
            [m[1][0], m[1][1], m[1][3]],
            [m[3][0], m[3][1], m[3][3]],
        ]
    }

    /// Where `(x, y)` of the plane lands (`None` behind the viewer).
    pub(crate) fn map(&self, x: f32, y: f32) -> Option<(f32, f32)> {
        let h = self.homography();
        let w = x * h[0][2] + y * h[1][2] + h[2][2];
        if w <= 1e-6 {
            return None;
        }
        Some((
            (x * h[0][0] + y * h[1][0] + h[2][0]) / w,
            (x * h[0][1] + y * h[1][1] + h[2][1]) / w,
        ))
    }

    /// The point of the plane that lands at `(x, y)` (hit testing), or
    /// `None` when the plane is seen edge-on or the point is behind it.
    pub(crate) fn unproject(&self, x: f32, y: f32) -> Option<(f32, f32)> {
        let inv = invert3(&self.homography())?;
        let w = x * inv[0][2] + y * inv[1][2] + inv[2][2];
        if w.abs() <= 1e-9 {
            return None;
        }
        let p = (
            (x * inv[0][0] + y * inv[1][0] + inv[2][0]) / w,
            (x * inv[0][1] + y * inv[1][1] + inv[2][1]) / w,
        );
        // The point must land in front of the viewer.
        self.map(p.0, p.1).map(|_| p)
    }

    /// The axis-aligned bounds of `rect` (x, y, width, height) once mapped.
    pub(crate) fn bounds(&self, x: f32, y: f32, w: f32, h: f32) -> Option<(f32, f32, f32, f32)> {
        let corners = [(x, y), (x + w, y), (x, y + h), (x + w, y + h)];
        let mut min = (f32::MAX, f32::MAX);
        let mut max = (f32::MIN, f32::MIN);
        for (cx, cy) in corners {
            let (px, py) = self.map(cx, cy)?;
            min = (min.0.min(px), min.1.min(py));
            max = (max.0.max(px), max.1.max(py));
        }
        Some((min.0, min.1, max.0 - min.0, max.1 - min.1))
    }

    /// As Direct2D's 4x4 matrix (`DrawBitmap`'s perspective transform).
    pub(crate) fn to_d2d(self) -> windows_numerics::Matrix4x4 {
        let m = &self.m;
        windows_numerics::Matrix4x4 {
            M11: m[0][0],
            M12: m[0][1],
            M13: m[0][2],
            M14: m[0][3],
            M21: m[1][0],
            M22: m[1][1],
            M23: m[1][2],
            M24: m[1][3],
            M31: m[2][0],
            M32: m[2][1],
            M33: m[2][2],
            M34: m[2][3],
            M41: m[3][0],
            M42: m[3][1],
            M43: m[3][2],
            M44: m[3][3],
        }
    }
}

fn invert3(m: &[[f32; 3]; 3]) -> Option<[[f32; 3]; 3]> {
    let [[a, b, c], [d, e, f], [g, h, i]] = *m;
    let det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if det.abs() < 1e-12 {
        return None;
    }
    let k = 1.0 / det;
    Some([
        [
            (e * i - f * h) * k,
            (c * h - b * i) * k,
            (b * f - c * e) * k,
        ],
        [
            (f * g - d * i) * k,
            (a * i - c * g) * k,
            (c * d - a * f) * k,
        ],
        [
            (d * h - e * g) * k,
            (b * g - a * h) * k,
            (a * e - b * d) * k,
        ],
    ])
}

#[cfg(test)]
mod tests {
    use super::Mat4;

    fn close(a: (f32, f32), b: (f32, f32)) -> bool {
        (a.0 - b.0).abs() < 1e-3 && (a.1 - b.1).abs() < 1e-3
    }

    #[test]
    fn operations_apply_like_css_lists() {
        // `translate(10px) rotate(90deg)`: rotated first, then moved.
        let m = Mat4::new().translate(10.0, 0.0).rotate(90.0);
        assert!(close(m.map(1.0, 0.0).unwrap(), (10.0, 1.0)));
        // `scale(2) translate(5px)`: moved first, then scaled.
        let m = Mat4::new().scale(2.0, 2.0).translate(5.0, 0.0);
        assert!(close(m.map(0.0, 0.0).unwrap(), (10.0, 0.0)));
        assert!(m.is_affine());
    }

    #[test]
    fn unproject_inverts_map_with_perspective() {
        let m = Mat4::new()
            .translate(50.0, 50.0)
            .perspective(400.0)
            .rotate_y(30.0)
            .translate(-50.0, -50.0);
        assert!(!m.is_affine());
        let p = m.map(20.0, 70.0).unwrap();
        assert!(close(m.unproject(p.0, p.1).unwrap(), (20.0, 70.0)));
    }

    #[test]
    fn rotate_x_without_perspective_squashes_affinely() {
        let m = Mat4::new().rotate_x(60.0);
        assert!(m.is_affine());
        assert!(close(m.map(0.0, 10.0).unwrap(), (0.0, 5.0)));
    }
}
