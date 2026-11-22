//! The codes of the native animation graph's operations (`ANIMATION_*`), as
//! `nsh/animated` encodes them for its decoder (`nsh-js` `protocol.rs`).

codes! { ANIMATION:
    /// node, value
    ANIMATION_VALUE = 0,
    /// node, input, inputRange, outputRange, extrapolateLeft, extrapolateRight, easing
    ANIMATION_INTERPOLATE = 1,
    /// node, op, a, b
    ANIMATION_MATH = 2,
    /// node, value
    ANIMATION_SET = 3,
    /// node, animation id, config
    ANIMATION_START = 4,
    /// node
    ANIMATION_STOP = 5,
    /// node
    ANIMATION_RELEASE = 6,
    /// node, input, min, max
    ANIMATION_DIFF_CLAMP = 7,
    /// animation id, composite key, spec
    ANIMATION_START_COMPOSITE = 8,
    /// animation id
    ANIMATION_STOP_ANIMATION = 9,
    /// composite key
    ANIMATION_RESET_COMPOSITE = 10,
    /// composite key
    ANIMATION_RELEASE_COMPOSITE = 11,
    /// node, offset
    ANIMATION_SET_OFFSET = 12,
    /// node
    ANIMATION_FLATTEN_OFFSET = 13,
    /// node
    ANIMATION_EXTRACT_OFFSET = 14,
    /// node, request id
    ANIMATION_READ = 15,
    /// node, factor, offset
    ANIMATION_ADJUST = 16,
}
