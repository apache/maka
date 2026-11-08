//! Shaders: GPU programs apps write in WGSL, which a view draws its box with.
//!
//! An app writes one function, `fn shade(uv: vec2f) -> vec4f`, giving the
//! color of the point `uv` of the view's box (0..1 from its top left
//! corner, CSS's direction) as straight sRGB with alpha, the way CSS colors
//! are: no linearization, the alpha not premultiplied. Besides its own
//! functions and constants it reads the view's built-ins through `nsh`
//! (`nsh.size`, the box in points; `nsh.time`, seconds since the shader
//! appeared; `nsh.scale`, pixels per point) and, when it declares
//! `struct Uniforms { … }`, its values through `uniforms`, which the app
//! sets by name ([`ShaderLayer::new`]). The core wraps the function into a
//! module of its own ([`Shader::compile`]): the two entry points the
//! renderers draw a quad with (`nsh_vertex`, `nsh_fragment`, which
//! premultiplies), the built-ins at `@group(0) @binding(0)` and the
//! uniforms at `@binding(1)`.
//!
//! What a shader may do is checked here, in Rust, before any platform sees
//! it: the source is at most [`MAX_SOURCE_BYTES`], it declares no entry
//! points, bindings or resources of its own (only `var<private>` globals),
//! its uniforms are numbers, vectors of `f32` and arrays of `vec4f`
//! ([`UniformType`]) in at most [`MAX_UNIFORM_BYTES`], and the whole module
//! validates (naga, the WGSL front end wgpu and browsers' WebGPU share).
//! The platforms draw it at most once per display frame and only while the
//! view is in sight, and only while something it reads changes: a shader
//! reading `nsh.time` is [`Shader::animated`] and draws every frame unless
//! paused, others draw when their size or uniforms change.
//!
//! The native backends render the module with wgpu (`nsh_engine::shader`), the web
//! backend with WebGL 2 from the GLSL ES this module translates it into
//! ([`Shader::glsl_es`], feature `glsl`).
//!
//! Animated values among the uniforms ([`UniformValue::Animated`]) become
//! the layer's value slots ([`ShaderLayer::slots`]), bound to the view as
//! [`crate::animation::AnimationProp::CanvasArg`]s: the platform writes
//! their values into the uniforms ([`ShaderLayer::write_slot`]) and draws
//! again on its own, without JS.
//!
//! # Pictures, effects and transitions
//!
//! Besides drawing a view's box under its children ([`ShaderRole::Fill`]),
//! a shader can draw what other views draw: `sample_content(uv)` (the
//! children of an effect, [`ShaderRole::Effect`], or the whole surface,
//! [`ShaderRole::Screen`]), `sample_backdrop(uv)` (what is behind the view)
//! and `sample_from(uv)` / `sample_to(uv)` (a transition's two sides,
//! [`ShaderRole::Transition`] and [`ShaderRole::ScreenTransition`], and a
//! page's or dialog's). Each returns straight sRGB with alpha, like
//! `shade`, at the point `uv` of the box; outside its picture it is
//! transparent. `nsh.progress` is an effect's `progress` or how far a
//! transition is (0 to 1); `nsh.overflow` is how far beyond the box the
//! shader draws and its pictures reach, in points (`maxSampleOffset`): the
//! frame then covers `uv` from `-overflow / size` to `1 + overflow / size`.
//! The platforms take the pictures ([`Shader::inputs`] says which) and the
//! renderers bind them at `@binding(2)` (a sampler) and `@binding(3)` to
//! `@binding(6)`; [`crossfade`] is the transitions' default.

use std::{
    fmt,
    hash::{Hash, Hasher},
    sync::Arc,
};

#[cfg(feature = "shader")]
use naga::{
    AddressSpace, ArraySize, Expression, Handle, Module, ScalarKind, TypeInner, VectorSize,
    valid::{Capabilities, ModuleInfo, ValidationFlags, Validator},
};

use crate::{
    Color,
    animation::{AnimationValue, NodeId},
    geometry::{Percentage, Points, Size},
};

/// The longest source a shader may have, in bytes.
pub const MAX_SOURCE_BYTES: usize = 64 * 1024;

/// The most bytes `struct Uniforms` may take.
pub const MAX_UNIFORM_BYTES: u32 = 4096;

#[cfg(feature = "shader")]
/// The function an app's source defines.
const SHADE: &str = "shade";

#[cfg(feature = "shader")]
/// What the core adds to the app's source: the built-ins and the entry
/// points (WGSL declarations may come in any order, so the app's source
/// goes first and its lines keep their numbers).
const BUILTINS: &str = r#"
// 32 bytes, as `builtins` writes them: wgpu's GL backend refuses a uniform
// struct whose size is no multiple of 16 where the device lacks
// `BUFFER_BINDINGS_NOT_16_BYTE_ALIGNED`, so `overflow` pads it.
struct Nsh {
    size: vec2f,
    time: f32,
    scale: f32,
    progress: f32,
    @size(12) overflow: f32,
}

@group(0) @binding(0) var<uniform> nsh: Nsh;

@group(0) @binding(2) var nsh_sampler: sampler;
@group(0) @binding(3) var nsh_content: texture_2d<f32>;
@group(0) @binding(4) var nsh_backdrop: texture_2d<f32>;
@group(0) @binding(5) var nsh_from: texture_2d<f32>;
@group(0) @binding(6) var nsh_to: texture_2d<f32>;

// A point of the box in the pictures, which cover it and `overflow` points
// beyond each side.
fn nsh_picture(uv: vec2f) -> vec2f {
    return (uv * nsh.size + nsh.overflow) / max(nsh.size + 2.0 * nsh.overflow, vec2f(1e-6));
}

// A premultiplied texel as straight color; transparent outside the picture.
fn nsh_straight(c: vec4f, p: vec2f) -> vec4f {
    if (any(p < vec2f(0.0)) || any(p > vec2f(1.0)) || c.a <= 0.0) {
        return vec4f(0.0);
    }
    return vec4f(c.rgb / c.a, c.a);
}

fn sample_content(uv: vec2f) -> vec4f {
    let p = nsh_picture(uv);
    return nsh_straight(textureSampleLevel(nsh_content, nsh_sampler, p, 0.0), p);
}

fn sample_backdrop(uv: vec2f) -> vec4f {
    let p = nsh_picture(uv);
    return nsh_straight(textureSampleLevel(nsh_backdrop, nsh_sampler, p, 0.0), p);
}

fn sample_from(uv: vec2f) -> vec4f {
    let p = nsh_picture(uv);
    return nsh_straight(textureSampleLevel(nsh_from, nsh_sampler, p, 0.0), p);
}

fn sample_to(uv: vec2f) -> vec4f {
    let p = nsh_picture(uv);
    return nsh_straight(textureSampleLevel(nsh_to, nsh_sampler, p, 0.0), p);
}
"#;

#[cfg(feature = "shader")]
const UNIFORMS: &str = "\n@group(0) @binding(1) var<uniform> uniforms: Uniforms;\n";

#[cfg(feature = "shader")]
const ENTRY_POINTS: &str = r#"
struct NshVarying {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

@vertex
fn nsh_vertex(@builtin(vertex_index) index: u32) -> NshVarying {
    // One triangle covering the target: uv 0..1 over the box, y down, and
    // past it by `overflow` points on each side.
    let corner = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
    let grow = nsh.overflow / max(nsh.size, vec2f(1e-6));
    var out: NshVarying;
    out.position = vec4f(corner.x * 2.0 - 1.0, 1.0 - corner.y * 2.0, 0.0, 1.0);
    out.uv = corner * (1.0 + 2.0 * grow) - grow;
    return out;
}

@fragment
fn nsh_fragment(in: NshVarying) -> @location(0) vec4f {
    let color = clamp(shade(in.uv), vec4f(0.0), vec4f(1.0));
    return vec4f(color.rgb * color.a, color.a);
}
"#;

#[cfg(feature = "shader")]
/// The index of `time` in `struct Nsh`.
const TIME_MEMBER: u32 = 1;

/// The words of the built-ins (`struct Nsh`): the box's size in points,
/// the seconds since the shader appeared, the pixels per point, the
/// progress (0 to 1) and the overflow in points, as the renderers upload
/// them to `@binding(0)` (32 bytes).
pub fn builtins(
    size: Size<Points>,
    time: f32,
    scale: f32,
    progress: Percentage,
    overflow: Points,
) -> [u32; 8] {
    [
        size.width.0.to_bits(),
        size.height.0.to_bits(),
        time.to_bits(),
        scale.to_bits(),
        progress.0.to_bits(),
        overflow.0.to_bits(),
        0,
        0,
    ]
}

/// The pictures a shader can read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ShaderInput {
    /// `sample_content`: an effect's children, a screen effect's surface.
    Content,
    /// `sample_backdrop`: what is behind the view.
    Backdrop,
    /// `sample_from`: a transition's side it leaves.
    From,
    /// `sample_to`: a transition's side it comes to.
    To,
}

impl ShaderInput {
    /// Every input, in their bindings' order (`@binding(3)` to `@binding(6)`).
    pub const ALL: [ShaderInput; 4] = [
        ShaderInput::Content,
        ShaderInput::Backdrop,
        ShaderInput::From,
        ShaderInput::To,
    ];

    /// Its index (0 to 3; the binding is 3 more).
    pub fn index(self) -> usize {
        self as usize
    }

    /// The function the app calls to read it.
    pub fn function(self) -> &'static str {
        match self {
            ShaderInput::Content => "sample_content",
            ShaderInput::Backdrop => "sample_backdrop",
            ShaderInput::From => "sample_from",
            ShaderInput::To => "sample_to",
        }
    }

    /// The texture's global in the module.
    pub fn texture(self) -> &'static str {
        match self {
            ShaderInput::Content => "nsh_content",
            ShaderInput::Backdrop => "nsh_backdrop",
            ShaderInput::From => "nsh_from",
            ShaderInput::To => "nsh_to",
        }
    }
}

/// The set of [`ShaderInput`]s a shader reads.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct ShaderInputs(u8);

impl ShaderInputs {
    /// Whether it reads `input`.
    pub fn contains(self, input: ShaderInput) -> bool {
        self.0 & (1 << input.index()) != 0
    }

    /// Whether it reads none.
    pub fn is_empty(self) -> bool {
        self.0 == 0
    }

    /// It with `input`.
    pub fn with(self, input: ShaderInput) -> Self {
        ShaderInputs(self.0 | 1 << input.index())
    }

    /// The inputs it reads.
    pub fn iter(self) -> impl Iterator<Item = ShaderInput> {
        ShaderInput::ALL
            .into_iter()
            .filter(move |i| self.contains(*i))
    }
}

/// What a layer draws, which decides where the platform shows it and which
/// pictures it takes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ShaderRole {
    /// A shader view: the box under its children (upstream's `Shader`).
    #[default]
    Fill,
    /// An effect: its children draw through it, their picture is the
    /// content; the result shows where they are.
    Effect,
    /// A transition: while one runs (`MountItem::ShaderTransition`), its
    /// children change through it, their picture before as `from`, their
    /// drawing now as `to`; otherwise they show as they are.
    Transition,
    /// A screen effect: the whole surface draws through it, its picture the
    /// content.
    Screen,
    /// A screen transition: the whole surface changes through it.
    ScreenTransition,
}

/// `progress`: `nsh.progress` as a number, or moved natively by an
/// animated value.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ShaderProgress {
    /// A fraction (0 to 1, by convention; a spring may overshoot it).
    Number(Percentage),
    /// The animated value of this node.
    Animated(NodeId),
}

impl Default for ShaderProgress {
    fn default() -> Self {
        ShaderProgress::Number(Percentage(0.0))
    }
}

/// A transition's `value`: when it changes, the transition runs.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum TransitionKey {
    /// A string.
    String(Arc<str>),
    /// A number (its bits; made by [`TransitionKey::number`]).
    Number(u64),
    /// A boolean.
    Bool(bool),
}

impl From<&str> for TransitionKey {
    fn from(s: &str) -> Self {
        TransitionKey::String(s.into())
    }
}

impl TransitionKey {
    /// A number as a key: equal numbers are equal keys, as JS compares
    /// them (`0` and `-0` are one key; every NaN is one key).
    pub fn number(n: f64) -> Self {
        let n = if n == 0.0 {
            0.0
        } else if n.is_nan() {
            f64::NAN
        } else {
            n
        };
        TransitionKey::Number(n.to_bits())
    }
}

impl From<f64> for TransitionKey {
    fn from(n: f64) -> Self {
        TransitionKey::number(n)
    }
}

impl From<bool> for TransitionKey {
    fn from(b: bool) -> Self {
        TransitionKey::Bool(b)
    }
}

/// A page's or a dialog's `transitionShader`: the program it comes and
/// goes through, its uniforms and how long that takes.
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct NavShaderSpec {
    /// The WGSL defining `shade`, which reads the lower side as
    /// `sample_from` and the upper as `sample_to`.
    pub source: Arc<str>,
    /// Its uniforms.
    pub uniforms: ShaderUniforms,
    /// How long it runs in milliseconds; 350 when absent, about as long as
    /// the platforms' own push (an element's `ShaderTransition` takes 300).
    pub duration: Option<f32>,
}

/// A page's or a dialog's transition program, built in Rust
/// (`Screen::transition_shader`,
/// `Modal::transition_shader`;
/// TS: `transitionShader`): a compiled [`Shader`] defining `shade`, which
/// reads the lower side as `sample_from` and the upper as `sample_to`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TransitionShader(NavShaderSpec);

impl TransitionShader {
    /// Runs `shader`, with no uniforms, for 350 ms.
    pub fn new(shader: Shader) -> Self {
        Self(NavShaderSpec {
            source: shader.source().into(),
            uniforms: ShaderUniforms::default(),
            duration: None,
        })
    }

    /// Sets the member `name` of the shader's `struct Uniforms` to `value`:
    /// a number, a color or a list (a vector, an array of `vec4f`).
    pub fn uniform(mut self, name: &str, value: impl Into<UniformValue>) -> Self {
        let value = value.into();
        match self.0.uniforms.0.iter_mut().find(|(n, _)| &**n == name) {
            Some(entry) => entry.1 = value,
            None => self.0.uniforms.0.push((name.into(), value)),
        }
        self
    }

    /// How long it runs (350 ms by default).
    pub fn duration(mut self, duration: std::time::Duration) -> Self {
        self.0.duration = Some(duration.as_secs_f32() * 1000.0);
        self
    }
}

impl From<TransitionShader> for NavShaderSpec {
    fn from(shader: TransitionShader) -> Self {
        shader.0
    }
}

/// The word a progress slot writes ([`ShaderLayer::slots`]): not one of the
/// uniforms, the built-in `nsh.progress`.
pub const PROGRESS_WORD: u32 = u32::MAX;

/// The transitions' default program: a cross-fade from `sample_from` to
/// `sample_to` over `nsh.progress`. `None` only in a web runtime linked
/// without shaders ([`set_compile`]), which has no transition to run it
/// on: compiled with this module's compiler, so the cross-fade does not
/// link naga into every web runtime.
pub fn crossfade() -> Option<Shader> {
    static CROSSFADE: std::sync::OnceLock<Option<Shader>> = std::sync::OnceLock::new();
    CROSSFADE
        .get_or_init(|| {
            compile_source(
                "fn shade(uv: vec2f) -> vec4f {\n    return mix(sample_from(uv), sample_to(uv), nsh.progress);\n}\n",
            )
            .map_err(|e| log::warn!(target: "js", "the cross-fade: {e}"))
            .ok()
        })
        .clone()
}

/// Why a shader did not compile: what is wrong and where in the app's
/// source (1-based; 0 when the error is not at a place in it).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct ShaderError {
    /// What is wrong.
    pub message: String,
    /// The line, from 1 (0: none).
    pub line: u32,
    /// The column in bytes, from 1 (0: none).
    pub column: u32,
}

impl ShaderError {
    fn new(message: impl Into<String>) -> Self {
        ShaderError {
            message: message.into(),
            line: 0,
            column: 0,
        }
    }

    #[cfg(feature = "shader")]
    fn at(message: impl Into<String>, source: &str, offset: Option<usize>) -> Self {
        let mut error = ShaderError::new(message);
        if let Some(offset) = offset.filter(|&o| o <= source.len()) {
            let prefix = &source[..offset];
            error.line = prefix.matches('\n').count() as u32 + 1;
            error.column = (offset - prefix.rfind('\n').map_or(0, |p| p + 1)) as u32 + 1;
        }
        error
    }
}

impl fmt::Display for ShaderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.line > 0 {
            write!(f, "{}:{}: {}", self.line, self.column, self.message)
        } else {
            f.write_str(&self.message)
        }
    }
}

impl std::error::Error for ShaderError {}

/// The type of a member of `struct Uniforms`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum UniformType {
    /// `f32`.
    #[default]
    F32,
    /// `i32`.
    I32,
    /// `u32`.
    U32,
    /// `vec2f`.
    Vec2,
    /// `vec3f`: three numbers, or a color's red, green and blue.
    Vec3,
    /// `vec4f`: four numbers, or a color with its alpha.
    Vec4,
    /// `array<vec4f, N>`: up to `N` vectors or colors (a palette, the stops
    /// of a gradient); those not given are zero.
    Vec4Array(u32),
}

impl UniformType {
    /// Its WGSL spelling.
    pub fn wgsl(self) -> String {
        match self {
            UniformType::F32 => "f32".into(),
            UniformType::I32 => "i32".into(),
            UniformType::U32 => "u32".into(),
            UniformType::Vec2 => "vec2f".into(),
            UniformType::Vec3 => "vec3f".into(),
            UniformType::Vec4 => "vec4f".into(),
            UniformType::Vec4Array(n) => format!("array<vec4f, {n}>"),
        }
    }
}

/// A member of `struct Uniforms`: its name, type and place in the buffer.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct UniformField {
    /// Its name, which the app sets it by.
    pub name: Arc<str>,
    /// Its type.
    pub ty: UniformType,
    /// Its offset in bytes (a multiple of 4).
    pub offset: u32,
}

/// The WGSL modules the GLSL ES 3.00 a WebGL 2 context compiles
/// ([`Shader::glsl_es`]).
#[cfg(feature = "glsl")]
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct GlslProgram {
    /// The vertex shader.
    pub vertex: String,
    /// The fragment shader.
    pub fragment: String,
    /// The name of the uniform block of the built-ins in `fragment`, when
    /// it reads them (bind it to 0).
    pub builtins_block: Option<String>,
    /// The name of the uniform block of `struct Uniforms`, when it reads it
    /// (bind it to 1).
    pub uniforms_block: Option<String>,
    /// The sampler uniforms of the pictures it reads, by input.
    pub pictures: Vec<(String, ShaderInput)>,
}

/// A compiled shader: the app's source checked and wrapped into a module
/// every renderer draws (cheap to clone; equal when their sources are).
#[derive(Clone)]
pub struct Shader(Arc<Program>);

// Made only by the compiler (feature `shader`).
#[cfg_attr(not(feature = "shader"), allow(dead_code))]
struct Program {
    source: Arc<str>,
    hash: u64,
    wgsl: String,
    // The GLSL writer's input.
    #[cfg(feature = "shader")]
    #[cfg_attr(not(feature = "glsl"), allow(dead_code))]
    module: Module,
    #[cfg(feature = "shader")]
    #[cfg_attr(not(feature = "glsl"), allow(dead_code))]
    info: ModuleInfo,
    uniforms: Vec<UniformField>,
    uniform_size: u32,
    animated: bool,
    inputs: ShaderInputs,
    #[cfg(feature = "glsl")]
    glsl: std::sync::OnceLock<Result<GlslProgram, ShaderError>>,
}

impl fmt::Debug for Shader {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Shader")
            .field("hash", &format_args!("{:016x}", self.0.hash))
            .field("uniforms", &self.0.uniforms)
            .field("animated", &self.0.animated)
            .finish()
    }
}

impl PartialEq for Shader {
    fn eq(&self, other: &Shader) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
            || (self.0.hash == other.0.hash && self.0.source == other.0.source)
    }
}

impl Eq for Shader {}

/// The hash of a shader's source (what [`Shader::hash`] gives, and what
/// caches of compiled shaders are keyed by).
pub fn source_hash(source: &str) -> u64 {
    let mut hasher = rustc_hash::FxHasher::default();
    source.hash(&mut hasher);
    hasher.finish()
}

/// What compiles the apps' shader sources in this module ([`Shader::compile`],
/// which links naga).
pub type Compile = fn(&str) -> Result<Shader, ShaderError>;

#[cfg(target_arch = "wasm32")]
thread_local! {
    /// The compiler a web runtime linked: one built for an app that uses no
    /// shader leaves it out, naga with it ([`set_compile`]).
    static COMPILE: std::cell::Cell<Option<Compile>> = const { std::cell::Cell::new(None) };
}

/// Sets the compiler of this WebAssembly module's shader sources: the web
/// runtime's gate for shaders sets it, so naga is linked only into the
/// runtimes of apps that use shaders. The native backends always have
/// [`Shader::compile`].
#[cfg(target_arch = "wasm32")]
pub fn set_compile(compile: Compile) {
    COMPILE.with(|c| c.set(Some(compile)));
}

/// Compiles `source` with this module's compiler, if it has one.
pub(crate) fn compile_source(source: &str) -> Result<Shader, ShaderError> {
    #[cfg(target_arch = "wasm32")]
    {
        match COMPILE.with(|c| c.get()) {
            Some(compile) => compile(source),
            None => Err(ShaderError::new(
                "this web runtime has no shader compiler (it was linked for an app that \
                 imports no `Shader`)",
            )),
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    Shader::compile(source)
}

impl Shader {
    /// Refuses `source`: this build has no shader compiler (feature `shader`).
    #[cfg(not(feature = "shader"))]
    pub fn compile(_source: &str) -> Result<Shader, ShaderError> {
        Err(ShaderError::new(
            "this build has no shader compiler (the NSH platform crate's feature `shader` is off)",
        ))
    }

    /// Checks and compiles the app's WGSL `source`, which defines
    /// `fn shade(uv: vec2f) -> vec4f` (module docs).
    #[cfg(feature = "shader")]
    pub fn compile(source: &str) -> Result<Shader, ShaderError> {
        if source.len() > MAX_SOURCE_BYTES {
            return Err(ShaderError::new(format!(
                "a shader's source is at most {MAX_SOURCE_BYTES} bytes; this one has {}",
                source.len()
            )));
        }
        let has_uniforms = declares_uniforms(source);
        let mut wgsl = String::with_capacity(
            source.len() + BUILTINS.len() + UNIFORMS.len() + ENTRY_POINTS.len(),
        );
        wgsl.push_str(source);
        wgsl.push_str(BUILTINS);
        if has_uniforms {
            wgsl.push_str(UNIFORMS);
        }
        // Checked without the entry points first: an error there is in the
        // app's source, not in what calls `shade`.
        let module = parse(&wgsl, source)?;
        check(&module, source, has_uniforms)?;
        wgsl.push_str(ENTRY_POINTS);
        let module = parse(&wgsl, source)?;
        let info = Validator::new(ValidationFlags::all(), Capabilities::empty())
            .validate(&module)
            .map_err(|e| {
                // The innermost place: an expression inside the function.
                let offset = e
                    .spans()
                    .filter_map(|(span, _)| span.to_range())
                    .map(|r| r.start)
                    .filter(|&s| s < source.len())
                    .max();
                ShaderError::at(error_chain(e.as_inner()), source, offset)
            })?;
        let (uniforms, uniform_size) = if has_uniforms {
            reflect_uniforms(&module, source)?
        } else {
            (Vec::new(), 0)
        };
        let animated = reads_time(&module);
        let inputs = reads_inputs(&module, &info);
        Ok(Shader(Arc::new(Program {
            source: source.into(),
            hash: source_hash(source),
            wgsl,
            module,
            info,
            uniforms,
            uniform_size,
            animated,
            inputs,
            #[cfg(feature = "glsl")]
            glsl: std::sync::OnceLock::new(),
        })))
    }

    /// The app's source.
    pub fn source(&self) -> &str {
        &self.0.source
    }

    /// The hash of the app's source ([`source_hash`]).
    pub fn hash(&self) -> u64 {
        self.0.hash
    }

    /// The whole WGSL module: the app's source, the built-ins, the
    /// uniforms' binding and the entry points `nsh_vertex` and
    /// `nsh_fragment`.
    pub fn wgsl(&self) -> &str {
        &self.0.wgsl
    }

    /// The members of `struct Uniforms`, in order (empty without one).
    pub fn uniforms(&self) -> &[UniformField] {
        &self.0.uniforms
    }

    /// The size of `struct Uniforms` in bytes (a multiple of 16; 0 without
    /// one).
    pub fn uniform_size(&self) -> u32 {
        self.0.uniform_size
    }

    /// Whether it reads `nsh.time`: it then draws every frame while it is
    /// in sight and not paused.
    pub fn animated(&self) -> bool {
        self.0.animated
    }

    /// The pictures it reads (`sample_content`, …): the platform takes
    /// them for it.
    pub fn inputs(&self) -> ShaderInputs {
        self.0.inputs
    }

    /// The program as GLSL ES 3.00 for WebGL 2 (translated once, on first
    /// use).
    #[cfg(feature = "glsl")]
    pub fn glsl_es(&self) -> Result<&GlslProgram, ShaderError> {
        self.0
            .glsl
            .get_or_init(|| glsl_es(&self.0.module, &self.0.info))
            .as_ref()
            .map_err(Clone::clone)
    }
}

#[cfg(feature = "shader")]
/// Whether `source` declares `struct Uniforms` (outside comments).
fn declares_uniforms(source: &str) -> bool {
    let mut rest = source;
    let mut code = String::with_capacity(source.len());
    // Comments out: `//` to the end of the line, `/* … */` (nested, as
    // WGSL's are).
    while !rest.is_empty() {
        if let Some(r) = rest.strip_prefix("//") {
            rest = r.find('\n').map_or("", |n| &r[n..]);
        } else if rest.starts_with("/*") {
            let mut depth = 0usize;
            let mut i = 0;
            let bytes = rest.as_bytes();
            while i < bytes.len() {
                if bytes[i..].starts_with(b"/*") {
                    depth += 1;
                    i += 2;
                } else if bytes[i..].starts_with(b"*/") {
                    depth -= 1;
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            code.push(' ');
            rest = &rest[i.min(rest.len())..];
        } else {
            let c = rest.chars().next().expect("not empty");
            code.push(c);
            rest = &rest[c.len_utf8()..];
        }
    }
    let mut words = code
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty());
    while let Some(word) = words.next() {
        if word == "struct" && words.next() == Some("Uniforms") {
            return true;
        }
    }
    false
}

#[cfg(feature = "shader")]
/// An error and its causes, innermost last ("Function 'shade' is invalid:
/// …").
fn error_chain(error: &dyn std::error::Error) -> String {
    let mut message = error.to_string();
    let mut cause = error.source();
    while let Some(e) = cause {
        message.push_str(": ");
        message.push_str(&e.to_string());
        cause = e.source();
    }
    message
}

#[cfg(feature = "shader")]
fn parse(wgsl: &str, source: &str) -> Result<Module, ShaderError> {
    naga::front::wgsl::parse_str(wgsl).map_err(|e| {
        let offset = e
            .location(wgsl)
            .map(|l| l.offset as usize)
            .filter(|&o| o < source.len());
        ShaderError::at(e.message().to_string(), source, offset)
    })
}

#[cfg(feature = "shader")]
/// What the app's module may hold: `shade` with its signature, no entry
/// points, no resources of its own.
fn check(module: &Module, source: &str, has_uniforms: bool) -> Result<(), ShaderError> {
    let span_of = |span: naga::Span| span.to_range().map(|r| r.start);
    if let Some(entry) = module.entry_points.first() {
        let offset = source.find(&format!("fn {}", entry.name));
        return Err(ShaderError::at(
            format!(
                "a shader declares no entry points (`{}`): NSH calls `fn {SHADE}(uv: vec2f) -> vec4f`",
                entry.name
            ),
            source,
            offset,
        ));
    }
    for (handle, global) in module.global_variables.iter() {
        let name = global.name.as_deref().unwrap_or("");
        let ours = (matches!(name, "nsh" | "uniforms" | "nsh_sampler")
            || ShaderInput::ALL.iter().any(|i| i.texture() == name))
            && global.binding.is_some();
        if ours || global.space == AddressSpace::Private {
            continue;
        }
        return Err(ShaderError::at(
            format!(
                "`{name}`: a shader's globals are `var<private>`; its inputs are `nsh` and `uniforms`"
            ),
            source,
            span_of(module.global_variables.get_span(handle)),
        ));
    }
    let shade = module
        .functions
        .iter()
        .find(|(_, f)| f.name.as_deref() == Some(SHADE));
    let Some((handle, shade)) = shade else {
        return Err(ShaderError::new(format!(
            "a shader defines `fn {SHADE}(uv: vec2f) -> vec4f`, the color of each point of its box"
        )));
    };
    let is_vec = |ty: Handle<naga::Type>, size: VectorSize| {
        matches!(
            module.types[ty].inner,
            TypeInner::Vector { size: s, scalar } if s == size && scalar.kind == ScalarKind::Float && scalar.width == 4
        )
    };
    let signature = shade.arguments.len() == 1
        && is_vec(shade.arguments[0].ty, VectorSize::Bi)
        && shade
            .result
            .as_ref()
            .is_some_and(|r| is_vec(r.ty, VectorSize::Quad));
    if !signature {
        return Err(ShaderError::at(
            format!("`{SHADE}` takes the point's `uv: vec2f` and returns its color, a `vec4f`"),
            source,
            span_of(module.functions.get_span(handle)),
        ));
    }
    if has_uniforms {
        let declared = module.types.iter().any(|(_, t)| {
            t.name.as_deref() == Some("Uniforms") && matches!(t.inner, TypeInner::Struct { .. })
        });
        if !declared {
            return Err(ShaderError::new("`Uniforms` is a struct"));
        }
    }
    Ok(())
}

#[cfg(feature = "shader")]
/// The members of `struct Uniforms` and its size.
fn reflect_uniforms(
    module: &Module,
    source: &str,
) -> Result<(Vec<UniformField>, u32), ShaderError> {
    let Some((handle, ty)) = module
        .types
        .iter()
        .find(|(_, t)| t.name.as_deref() == Some("Uniforms"))
    else {
        return Ok((Vec::new(), 0));
    };
    let TypeInner::Struct { members, span } = &ty.inner else {
        return Err(ShaderError::new("`Uniforms` is a struct"));
    };
    let at = module.types.get_span(handle).to_range().map(|r| r.start);
    if *span > MAX_UNIFORM_BYTES {
        return Err(ShaderError::at(
            format!("`Uniforms` takes {span} bytes; at most {MAX_UNIFORM_BYTES}"),
            source,
            at,
        ));
    }
    let mut fields = Vec::with_capacity(members.len());
    for member in members {
        let name = member.name.clone().unwrap_or_default();
        let ty = uniform_type(module, member.ty).ok_or_else(|| {
            ShaderError::at(
                format!(
                    "uniform `{name}`: uniforms are `f32`, `i32`, `u32`, `vec2f`, `vec3f`, `vec4f` or `array<vec4f, N>`"
                ),
                source,
                at,
            )
        })?;
        fields.push(UniformField {
            name: name.into(),
            ty,
            offset: member.offset,
        });
    }
    Ok((fields, span.next_multiple_of(16)))
}

#[cfg(feature = "shader")]
fn uniform_type(module: &Module, ty: Handle<naga::Type>) -> Option<UniformType> {
    Some(match module.types[ty].inner {
        TypeInner::Scalar(s) if s.width == 4 => match s.kind {
            ScalarKind::Float => UniformType::F32,
            ScalarKind::Sint => UniformType::I32,
            ScalarKind::Uint => UniformType::U32,
            _ => return None,
        },
        TypeInner::Vector { size, scalar }
            if scalar.kind == ScalarKind::Float && scalar.width == 4 =>
        {
            match size {
                VectorSize::Bi => UniformType::Vec2,
                VectorSize::Tri => UniformType::Vec3,
                VectorSize::Quad => UniformType::Vec4,
            }
        }
        TypeInner::Array {
            base,
            size: ArraySize::Constant(n),
            stride: 16,
        } if uniform_type(module, base) == Some(UniformType::Vec4) => {
            UniformType::Vec4Array(n.get())
        }
        _ => return None,
    })
}

#[cfg(feature = "shader")]
/// The pictures the fragment stage reads: the textures `nsh_fragment` uses,
/// through `shade` and whatever it calls (naga's analysis follows calls).
fn reads_inputs(module: &Module, info: &ModuleInfo) -> ShaderInputs {
    let Some(entry) = module
        .entry_points
        .iter()
        .position(|e| e.name == "nsh_fragment")
    else {
        return ShaderInputs::default();
    };
    let uses = info.get_entry_point(entry);
    module
        .global_variables
        .iter()
        .filter(|&(handle, _)| !uses[handle].is_empty())
        .filter_map(|(_, global)| {
            let name = global.name.as_deref()?;
            ShaderInput::ALL.into_iter().find(|i| i.texture() == name)
        })
        .fold(ShaderInputs::default(), ShaderInputs::with)
}

#[cfg(feature = "shader")]
/// Whether any function reads `nsh.time`.
fn reads_time(module: &Module) -> bool {
    let Some(nsh) = module
        .global_variables
        .iter()
        .find(|(_, g)| g.name.as_deref() == Some("nsh"))
        .map(|(h, _)| h)
    else {
        return false;
    };
    let reads = |f: &naga::Function| {
        f.expressions.iter().any(|(_, e)| {
            matches!(*e, Expression::AccessIndex { base, index }
                if index == TIME_MEMBER && matches!(f.expressions[base], Expression::GlobalVariable(g) if g == nsh))
        })
    };
    module.functions.iter().any(|(_, f)| reads(f))
        || module.entry_points.iter().any(|e| reads(&e.function))
}

#[cfg(feature = "glsl")]
fn glsl_es(module: &Module, info: &ModuleInfo) -> Result<GlslProgram, ShaderError> {
    use naga::back::glsl;
    let options = glsl::Options {
        version: glsl::Version::Embedded {
            version: 300,
            is_webgl: true,
        },
        // Drawn straight into the canvas the page shows: clip space keeps
        // WGSL's +y up, which is GL's too (no flip as for a texture).
        writer_flags: glsl::WriterFlags::empty(),
        ..Default::default()
    };
    // Out-of-range indices read in range, as wgpu's checks make them.
    let policies = naga::proc::BoundsCheckPolicies {
        index: naga::proc::BoundsCheckPolicy::Restrict,
        buffer: naga::proc::BoundsCheckPolicy::Restrict,
        image_load: naga::proc::BoundsCheckPolicy::Restrict,
        binding_array: naga::proc::BoundsCheckPolicy::Restrict,
    };
    let write = |stage: naga::ShaderStage, entry: &str| {
        let mut out = String::new();
        let pipeline = glsl::PipelineOptions {
            shader_stage: stage,
            entry_point: entry.into(),
            multiview: None,
        };
        let mut writer = glsl::Writer::new(&mut out, module, info, &options, &pipeline, policies)
            .map_err(|e| ShaderError::new(format!("GLSL ES: {e}")))?;
        let reflection = writer
            .write()
            .map_err(|e| ShaderError::new(format!("GLSL ES: {e}")))?;
        Ok::<_, ShaderError>((out, reflection))
    };
    let (vertex, _) = write(naga::ShaderStage::Vertex, "nsh_vertex")?;
    let (fragment, reflection) = write(naga::ShaderStage::Fragment, "nsh_fragment")?;
    let block = |name: &str| {
        reflection.uniforms.iter().find_map(|(handle, block)| {
            (module.global_variables[*handle].name.as_deref() == Some(name)).then(|| block.clone())
        })
    };
    let pictures = reflection
        .texture_mapping
        .iter()
        .filter_map(|(name, mapping)| {
            let global = module.global_variables[mapping.texture].name.as_deref()?;
            let input = ShaderInput::ALL
                .into_iter()
                .find(|i| i.texture() == global)?;
            Some((name.clone(), input))
        })
        .collect();
    Ok(GlslProgram {
        builtins_block: block("nsh"),
        uniforms_block: block("uniforms"),
        pictures,
        vertex,
        fragment,
    })
}

/// A value an app gives a uniform.
#[derive(Debug, Clone, PartialEq)]
pub enum UniformValue {
    /// A number (`f32`, `i32` and `u32` uniforms; a component of a vector).
    Number(f32),
    /// A color: a `vec3f`'s red, green and blue, or a `vec4f` with its
    /// alpha, in 0..1 (sRGB, as CSS).
    Color(Color),
    /// An animated value: a number, or a color for a `vec3f` / `vec4f`.
    /// The platform writes it on every frame it changes.
    Animated(NodeId),
    /// The components of a vector, or the items of an array of `vec4f`.
    List(Vec<UniformValue>),
}

impl From<f32> for UniformValue {
    fn from(n: f32) -> Self {
        UniformValue::Number(n)
    }
}

impl From<i32> for UniformValue {
    fn from(n: i32) -> Self {
        UniformValue::Number(n as f32)
    }
}

impl From<Color> for UniformValue {
    fn from(c: Color) -> Self {
        UniformValue::Color(c)
    }
}

impl From<crate::color::Hsla> for UniformValue {
    fn from(c: crate::color::Hsla) -> Self {
        UniformValue::Color(c.into())
    }
}

impl<const N: usize> From<[f32; N]> for UniformValue {
    fn from(v: [f32; N]) -> Self {
        UniformValue::List(v.iter().map(|&n| UniformValue::Number(n)).collect())
    }
}

impl From<Vec<UniformValue>> for UniformValue {
    fn from(v: Vec<UniformValue>) -> Self {
        UniformValue::List(v)
    }
}

/// The values of a shader's uniforms, by name (`uniforms`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ShaderUniforms(pub Vec<(Arc<str>, UniformValue)>);

/// How a value slot writes its animated value into the uniforms.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SlotKind {
    /// One `f32`.
    #[default]
    F32,
    /// One `i32` (the value rounded toward zero).
    I32,
    /// One `u32` (the value rounded toward zero, at least 0).
    U32,
    /// A color's red, green and blue.
    Rgb,
    /// A color's red, green, blue and alpha.
    Rgba,
}

/// Where an animated uniform goes: the word it starts at and how it is
/// written.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct UniformSlot {
    /// The index of its first word (4 bytes) in [`ShaderLayer::uniforms`].
    pub word: u32,
    /// How its value is written.
    pub kind: SlotKind,
}

/// A shader as a view shows it: the program, the words of its uniforms
/// as the app set them, and the slots of its animated values.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct ShaderLayer {
    /// The program.
    pub shader: Shader,
    /// The uniform buffer, `shader.uniform_size() / 4` words (bit patterns
    /// of `f32`, `i32` and `u32`).
    pub uniforms: Arc<[u32]>,
    /// The animated values' slots: slot `n` is bound as
    /// [`crate::animation::AnimationProp::CanvasArg`]`(n)`.
    pub slots: Vec<UniformSlot>,
    /// The animation nodes of the slots, in the same order.
    pub nodes: Vec<NodeId>,
    /// Its clock stands still (`nsh.time` keeps its value).
    pub paused: bool,
    /// What it draws ([`ShaderRole`]).
    pub role: ShaderRole,
    /// How far beyond the box it draws and its pictures reach, in points
    /// (`nsh.overflow`, `maxSampleOffset`).
    pub overflow: Points,
    /// `nsh.progress`, unless an animated value moves it (a slot whose
    /// word is [`PROGRESS_WORD`]) or a transition runs it.
    pub progress: Percentage,
}

impl ShaderLayer {
    /// The layer of `shader` with the uniforms `values` (by name; those not
    /// given are zero). What does not fit a uniform is left out, each with
    /// a warning in `warnings`.
    pub fn new(
        shader: Shader,
        values: &[(Arc<str>, UniformValue)],
        warnings: &mut Vec<String>,
    ) -> ShaderLayer {
        let mut words = vec![0u32; (shader.uniform_size() / 4) as usize];
        let mut slots = Vec::new();
        let mut nodes = Vec::new();
        for (name, value) in values {
            let Some(field) = shader.uniforms().iter().find(|f| f.name == *name) else {
                warnings.push(if shader.uniforms().is_empty() {
                    format!("uniform `{name}`: the shader declares no `struct Uniforms`")
                } else {
                    format!("uniform `{name}`: `struct Uniforms` has no such member")
                });
                continue;
            };
            let mut packer = Packer {
                words: &mut words,
                slots: &mut slots,
                nodes: &mut nodes,
            };
            if let Err(expected) = packer.pack(field.ty, field.offset / 4, value) {
                warnings.push(format!(
                    "uniform `{name}` is a `{}`: it takes {expected}",
                    field.ty.wgsl()
                ));
            }
        }
        ShaderLayer {
            shader,
            uniforms: words.into(),
            slots,
            nodes,
            paused: false,
            role: ShaderRole::Fill,
            overflow: Points::ZERO,
            progress: Percentage(0.0),
        }
    }

    /// The same layer drawing as `role`.
    pub fn with_role(mut self, role: ShaderRole) -> Self {
        self.role = role;
        self
    }

    /// The same layer drawing `overflow` points beyond the box.
    pub fn with_overflow(mut self, overflow: Points) -> Self {
        self.overflow = overflow.max(Points::ZERO);
        self
    }

    /// The same layer with its clock stopped or running.
    pub fn with_paused(mut self, paused: bool) -> Self {
        self.paused = paused;
        self
    }

    /// The same layer with `nsh.progress` at `progress`, or moved by the
    /// animated value of node `animated` (one more slot).
    pub fn with_progress(mut self, progress: Percentage, animated: Option<NodeId>) -> Self {
        self.progress = progress;
        if let Some(node) = animated {
            self.slots.push(UniformSlot {
                word: PROGRESS_WORD,
                kind: SlotKind::F32,
            });
            self.nodes.push(node);
        }
        self
    }

    /// The slot that moves `nsh.progress`, if an animated value does.
    pub fn progress_slot(&self) -> Option<u16> {
        self.slots
            .iter()
            .position(|s| s.word == PROGRESS_WORD)
            .map(|i| i as u16)
    }

    /// Writes slot `slot`'s animated `value` into `words` (a copy of
    /// [`Self::uniforms`] the platform keeps).
    pub fn write_slot(&self, words: &mut [u32], slot: u16, value: AnimationValue) {
        let Some(slot) = self.slots.get(slot as usize) else {
            return;
        };
        let at = slot.word as usize;
        let number = || value.number();
        match slot.kind {
            SlotKind::F32 => set(words, at, number().to_bits()),
            SlotKind::I32 => set(words, at, (number() as i32) as u32),
            SlotKind::U32 => set(words, at, number().max(0.0) as u32),
            SlotKind::Rgb | SlotKind::Rgba => {
                let color = match value {
                    AnimationValue::Color(c) => Color(c),
                    other => Color(other.number() as u32),
                };
                let n = if slot.kind == SlotKind::Rgb { 3 } else { 4 };
                for (i, c) in rgba(color).into_iter().take(n).enumerate() {
                    set(words, at + i, c.to_bits());
                }
            }
        }
    }
}

fn set(words: &mut [u32], at: usize, word: u32) {
    if let Some(w) = words.get_mut(at) {
        *w = word;
    }
}

/// A color's components in 0..1.
fn rgba(color: Color) -> [f32; 4] {
    let c = color.0;
    [c >> 24, c >> 16, c >> 8, c].map(|b| (b & 0xff) as f32 / 255.0)
}

struct Packer<'a> {
    words: &'a mut [u32],
    slots: &'a mut Vec<UniformSlot>,
    nodes: &'a mut Vec<NodeId>,
}

impl Packer<'_> {
    /// Writes `value` as a `ty` at word `at`; `Err` names what `ty` takes.
    fn pack(&mut self, ty: UniformType, at: u32, value: &UniformValue) -> Result<(), &'static str> {
        const SCALAR: &str = "a number or an animated value";
        match ty {
            UniformType::F32 | UniformType::I32 | UniformType::U32 => {
                let kind = match ty {
                    UniformType::F32 => SlotKind::F32,
                    UniformType::I32 => SlotKind::I32,
                    _ => SlotKind::U32,
                };
                match *value {
                    UniformValue::Number(n) => {
                        let word = match kind {
                            SlotKind::F32 => n.to_bits(),
                            SlotKind::I32 => (n as i32) as u32,
                            _ => n.max(0.0) as u32,
                        };
                        set(self.words, at as usize, word);
                    }
                    UniformValue::Animated(node) => self.slot(at, kind, node),
                    _ => return Err(SCALAR),
                }
            }
            UniformType::Vec2 | UniformType::Vec3 | UniformType::Vec4 => {
                let n = match ty {
                    UniformType::Vec2 => 2,
                    UniformType::Vec3 => 3,
                    _ => 4,
                };
                let expected = match ty {
                    UniformType::Vec2 => "2 numbers",
                    UniformType::Vec3 => "3 numbers or a color",
                    _ => "4 numbers or a color",
                };
                match value {
                    UniformValue::Color(c) if n >= 3 => {
                        for (i, c) in rgba(*c).into_iter().take(n).enumerate() {
                            set(self.words, at as usize + i, c.to_bits());
                        }
                    }
                    UniformValue::Animated(node) if n >= 3 => {
                        let kind = if n == 3 {
                            SlotKind::Rgb
                        } else {
                            SlotKind::Rgba
                        };
                        self.slot(at, kind, *node);
                    }
                    UniformValue::List(items) if items.len() == n => {
                        for (i, item) in items.iter().enumerate() {
                            match *item {
                                UniformValue::Number(v) => {
                                    set(self.words, at as usize + i, v.to_bits())
                                }
                                UniformValue::Animated(node) => {
                                    self.slot(at + i as u32, SlotKind::F32, node)
                                }
                                _ => return Err(expected),
                            }
                        }
                    }
                    _ => return Err(expected),
                }
            }
            UniformType::Vec4Array(len) => {
                let UniformValue::List(items) = value else {
                    return Err("a list of colors or of 4 numbers");
                };
                if items.len() > len as usize {
                    return Err("at most as many items as the array has");
                }
                for (i, item) in items.iter().enumerate() {
                    self.pack(UniformType::Vec4, at + 4 * i as u32, item)
                        .map_err(|_| "a list of colors or of 4 numbers")?;
                }
            }
        }
        Ok(())
    }

    fn slot(&mut self, word: u32, kind: SlotKind, node: NodeId) {
        self.slots.push(UniformSlot { word, kind });
        self.nodes.push(node);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GRADIENT: &str = r#"
struct Uniforms {
    start: vec4f,
    end: vec3f,
    speed: f32,
    stops: array<vec4f, 4>,
    count: i32,
}

fn shade(uv: vec2f) -> vec4f {
    let t = fract(uv.x + nsh.time * uniforms.speed);
    return mix(uniforms.start, vec4f(uniforms.end, 1.0), t) + uniforms.stops[uniforms.count];
}
"#;

    #[test]
    fn compiles_and_reflects() {
        let shader = Shader::compile(GRADIENT).expect("compiles");
        assert!(shader.animated());
        let fields: Vec<_> = shader
            .uniforms()
            .iter()
            .map(|f| (&*f.name, f.ty, f.offset))
            .collect();
        assert_eq!(
            fields,
            [
                ("start", UniformType::Vec4, 0),
                ("end", UniformType::Vec3, 16),
                ("speed", UniformType::F32, 28),
                ("stops", UniformType::Vec4Array(4), 32),
                ("count", UniformType::I32, 96),
            ]
        );
        assert_eq!(shader.uniform_size(), 112);
        assert!(shader.wgsl().contains("fn nsh_fragment"));
        assert_eq!(shader, Shader::compile(GRADIENT).unwrap());
    }

    #[test]
    fn still_shaders_do_not_animate() {
        let shader =
            Shader::compile("fn shade(uv: vec2f) -> vec4f { return vec4f(uv, nsh.size.x, 1.0); }")
                .unwrap();
        assert!(!shader.animated());
        assert!(shader.uniforms().is_empty());
        // Comments do not declare uniforms.
        let commented = "// struct Uniforms { a: f32 }\n/* struct Uniforms */ fn shade(uv: vec2f) -> vec4f { return vec4f(1.0); }";
        assert!(Shader::compile(commented).unwrap().uniforms().is_empty());
    }

    #[test]
    fn the_built_ins_take_the_bytes_the_renderers_upload() {
        let shader = Shader::compile(GRADIENT).unwrap();
        let module = naga::front::wgsl::parse_str(shader.wgsl()).unwrap();
        let span = module
            .types
            .iter()
            .find_map(|(_, ty)| match ty.inner {
                TypeInner::Struct { span, .. } if ty.name.as_deref() == Some("Nsh") => Some(span),
                _ => None,
            })
            .expect("struct Nsh");
        let words = builtins(
            Size::default(),
            0.0,
            1.0,
            Percentage(0.0),
            Points::default(),
        );
        assert_eq!(span as usize, size_of_val(&words));
        // GLES without `BUFFER_BINDINGS_NOT_16_BYTE_ALIGNED` takes no other.
        assert_eq!(span % 16, 0);
    }

    #[test]
    fn an_app_binds_no_globals_of_its_own_under_nsh_names() {
        let error = Shader::compile(
            "@group(0) @binding(7) var nsh_extra: texture_2d<f32>;\n\
             fn shade(uv: vec2f) -> vec4f { return textureLoad(nsh_extra, vec2i(0), 0); }",
        )
        .unwrap_err();
        assert!(error.message.contains("nsh_extra"), "{error:?}");
        // The pictures' own globals are NSH's.
        assert!(
            Shader::compile(
                "fn shade(uv: vec2f) -> vec4f { return textureSampleLevel(nsh_content, nsh_sampler, uv, 0.0); }"
            )
            .is_ok()
        );
    }

    #[test]
    fn equal_numbers_are_one_transition_key() {
        assert_eq!(TransitionKey::from(0.0), TransitionKey::from(-0.0));
        assert_eq!(
            TransitionKey::from(f64::NAN),
            TransitionKey::from(-f64::NAN)
        );
        assert_ne!(TransitionKey::from(1.0), TransitionKey::from(2.0));
    }

    #[test]
    fn inputs_are_the_pictures_shade_reaches() {
        let inputs = |source: &str| Shader::compile(source).unwrap().inputs();
        assert!(inputs("fn shade(uv: vec2f) -> vec4f { return vec4f(1.0); }").is_empty());
        // Through a helper, whatever its name.
        let helper = inputs(
            "fn sample_custom(uv: vec2f) -> vec4f { return sample_content(uv) * 0.5; }\n\
             fn shade(uv: vec2f) -> vec4f { return sample_custom(uv) + sample_to(uv); }",
        );
        assert_eq!(
            helper.iter().collect::<Vec<_>>(),
            [ShaderInput::Content, ShaderInput::To]
        );
        // A helper `shade` never calls reads nothing.
        let unused = inputs(
            "fn unused(uv: vec2f) -> vec4f { return sample_backdrop(uv); }\n\
             fn shade(uv: vec2f) -> vec4f { return sample_from(uv); }",
        );
        assert_eq!(unused.iter().collect::<Vec<_>>(), [ShaderInput::From]);
    }

    #[test]
    fn errors_point_into_the_source() {
        let error = Shader::compile("fn shade(uv: vec2f) -> vec4f {\n  return vec4f(uv, 0.0);\n}")
            .unwrap_err();
        assert_eq!(error.line, 2, "{error}");
        let missing =
            Shader::compile("fn paint(uv: vec2f) -> vec4f { return vec4f(1.0); }").unwrap_err();
        assert!(missing.message.contains("fn shade"), "{missing}");
        let signature =
            Shader::compile("fn shade(uv: vec2f) -> vec3f { return vec3f(1.0); }").unwrap_err();
        assert!(
            signature.message.contains("returns its color"),
            "{signature}"
        );
    }

    #[test]
    fn refuses_resources_and_entry_points() {
        let storage = Shader::compile(
            "@group(1) @binding(0) var<storage> data: array<f32>;\nfn shade(uv: vec2f) -> vec4f { return vec4f(data[0]); }",
        )
        .unwrap_err();
        assert!(storage.message.contains("`data`"), "{storage}");
        assert_eq!(storage.line, 1);
        let entry = Shader::compile(
            "fn shade(uv: vec2f) -> vec4f { return vec4f(1.0); }\n@fragment fn main() -> @location(0) vec4f { return vec4f(1.0); }",
        )
        .unwrap_err();
        assert!(entry.message.contains("entry points"), "{entry}");
        let big = Shader::compile(&" ".repeat(MAX_SOURCE_BYTES + 1)).unwrap_err();
        assert!(big.message.contains("at most"));
        let mat = Shader::compile(
            "struct Uniforms { m: mat2x2f }\nfn shade(uv: vec2f) -> vec4f { return vec4f(uniforms.m[0], 0.0, 1.0); }",
        )
        .unwrap_err();
        assert!(mat.message.contains("uniform `m`"), "{mat}");
        // Private globals are the shader's own.
        Shader::compile(
            "var<private> seed: f32 = 0.5;\nfn shade(uv: vec2f) -> vec4f { return vec4f(seed); }",
        )
        .unwrap();
    }

    #[test]
    fn packs_uniforms() {
        let shader = Shader::compile(GRADIENT).unwrap();
        let mut warnings = Vec::new();
        let layer = ShaderLayer::new(
            shader,
            &[
                ("start".into(), UniformValue::Color(Color(0xff000080))),
                ("end".into(), UniformValue::Animated(7)),
                ("speed".into(), UniformValue::Number(0.5)),
                (
                    "stops".into(),
                    UniformValue::List(vec![
                        [1.0, 2.0, 3.0, 4.0].into(),
                        UniformValue::Color(Color(0x00ff00ff)),
                    ]),
                ),
                ("count".into(), UniformValue::Number(1.0)),
                ("nope".into(), UniformValue::Number(1.0)),
                ("speed".into(), UniformValue::Color(Color(0))),
            ],
            &mut warnings,
        );
        assert_eq!(warnings.len(), 2, "{warnings:?}");
        let f = |w: usize| f32::from_bits(layer.uniforms[w]);
        assert_eq!([f(0), f(1), f(2)], [1.0, 0.0, 0.0]);
        assert!((f(3) - 128.0 / 255.0).abs() < 1e-6);
        assert_eq!(f(7), 0.5);
        assert_eq!([f(8), f(9), f(10), f(11)], [1.0, 2.0, 3.0, 4.0]);
        assert_eq!([f(12), f(13), f(14), f(15)], [0.0, 1.0, 0.0, 1.0]);
        assert_eq!(layer.uniforms[24], 1);
        assert_eq!(
            layer.slots,
            [UniformSlot {
                word: 4,
                kind: SlotKind::Rgb
            }]
        );
        assert_eq!(layer.nodes, [7]);
        let mut words = layer.uniforms.to_vec();
        layer.write_slot(&mut words, 0, AnimationValue::Color(0x0000ffff));
        assert_eq!([4, 5, 6].map(|w| f32::from_bits(words[w])), [0.0, 0.0, 1.0]);
    }

    #[cfg(feature = "glsl")]
    #[test]
    fn translates_to_glsl_es() {
        let shader = Shader::compile(GRADIENT).unwrap();
        let glsl = shader.glsl_es().expect("translates");
        assert!(
            glsl.vertex.starts_with("#version 300 es"),
            "{}",
            glsl.vertex
        );
        assert!(glsl.fragment.contains("uniform"), "{}", glsl.fragment);
        assert!(glsl.builtins_block.is_some());
        assert!(glsl.uniforms_block.is_some());
    }
}
