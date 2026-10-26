package com.longbridge.nsh;

import android.graphics.Paint;
import android.graphics.Typeface;
import android.text.Layout;
import android.text.PrecomputedText;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.text.TextUtils;
import android.text.style.AbsoluteSizeSpan;
import android.text.style.ForegroundColorSpan;
import android.text.style.LineHeightSpan;
import android.text.style.MetricAffectingSpan;
import android.text.TextDirectionHeuristic;
import android.text.TextDirectionHeuristics;
import android.text.style.AlignmentSpan;
import android.text.style.StrikethroughSpan;
import android.text.style.UnderlineSpan;
import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;

/**
 * Text typesetting for the engine thread (crates/nsh-platform-android/src/text.rs).
 * Sizes cross the boundary in dp; layouts are made in px for drawing.
 */
final class TextLayouts {
    private TextLayouts() {}

    /** Where registered font files are written (set by NshView). */
    static volatile File cacheDir;

    private static final class Face {
        final int weight;
        final boolean italic;
        final Typeface typeface;

        Face(int weight, boolean italic, Typeface typeface) {
            this.weight = weight;
            this.italic = italic;
            this.typeface = typeface;
        }
    }

    private static final HashMap<String, List<Face>> FAMILIES = new HashMap<>();

    /** Registers a font file; returns an error message, or null. */
    static String registerFont(String family, byte[] data, int weight, boolean italic) {
        try {
            File dir = new File(cacheDir, "nsh-fonts");
            dir.mkdirs();
            File file = new File(dir, Integer.toHexString(java.util.Arrays.hashCode(data)) + ".ttf");
            if (!file.exists()) {
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(data);
                }
            }
            Typeface typeface = Typeface.createFromFile(file);
            synchronized (FAMILIES) {
                List<Face> faces = FAMILIES.computeIfAbsent(family, k -> new ArrayList<>());
                faces.add(new Face(weight, italic, typeface));
            }
            // Resolutions made before this font existed are stale.
            synchronized (RESOLVED) {
                RESOLVED.clear();
            }
            return null;
        } catch (Exception e) {
            return String.valueOf(e);
        }
    }

    /** Resolved typefaces by family, weight and italic. */
    private static final HashMap<String, Typeface> RESOLVED = new HashMap<>();

    /** The typeface of a family (registered, system or default) at a weight. */
    static Typeface typeface(String family, int weight, boolean italic) {
        String key = family + '/' + weight + (italic ? "i" : "");
        synchronized (RESOLVED) {
            Typeface cached = RESOLVED.get(key);
            if (cached != null) return cached;
        }
        Typeface resolved = resolve(family, weight, italic);
        synchronized (RESOLVED) {
            RESOLVED.put(key, resolved);
        }
        return resolved;
    }

    private static Typeface resolve(String family, int weight, boolean italic) {
        Typeface base = null;
        if (family != null) {
            synchronized (FAMILIES) {
                List<Face> faces = FAMILIES.get(family);
                if (faces != null) {
                    Face best = null;
                    int bestScore = Integer.MAX_VALUE;
                    for (Face f : faces) {
                        int score = Math.abs(f.weight - weight) + (f.italic == italic ? 0 : 1000);
                        if (score < bestScore) {
                            best = f;
                            bestScore = score;
                        }
                    }
                    if (best != null) {
                        // Exact faces are used as is; others are synthesized.
                        if (best.weight == weight && best.italic == italic) return best.typeface;
                        base = best.typeface;
                    }
                }
            }
            if (base == null) {
                // CSS generic families (`font-mono`, `font-serif`).
                switch (family) {
                    case "system-ui": case "sans-serif": case "ui-sans-serif": case "-apple-system":
                        base = Typeface.DEFAULT;
                        break;
                    case "monospace": case "ui-monospace":
                        base = Typeface.MONOSPACE;
                        break;
                    case "serif": case "ui-serif":
                        base = Typeface.SERIF;
                        break;
                    default:
                        base = Typeface.create(family, Typeface.NORMAL);
                }
            }
        }
        if (base == null) base = Typeface.DEFAULT;
        return Typeface.create(base, Math.max(1, Math.min(1000, weight)), italic);
    }

    // Span ints: start, end, weight, flags, color, decoration color, family,
    // font variant bits, decoration style, background color, background
    // node. Floats: size, line height, letter spacing, decoration thickness,
    // underline offset, background radius.
    private static final int SPAN_INTS = 11;
    private static final int SPAN_FLOATS = 6;
    private static final int ITALIC = 1;
    private static final int UNDERLINE = 2;
    private static final int STRIKE = 4;
    private static final int BACKGROUND = 16;

    static final class Prepared {
        final CharSequence text;
        final TextPaint paint;
        final Layout.Alignment alignment;
        final boolean justify;
        /** A paragraph is aligned to its end (`textAlign: "right"` on left to
         * right text): an {@code AlignmentSpan}, which {@link #alignment}
         * does not show. */
        final boolean endAligned;
        final int maxLines;
        final TextUtils.TruncateAt ellipsize;
        final float density;
        /** Natural width (px), computed once. */
        private int desired = -1;
        /** Recent layouts by width: measuring and the final layout reuse them. */
        private final StaticLayout[] layouts = new StaticLayout[4];
        private int next;

        final TextDirectionHeuristic direction;

        Prepared(CharSequence text, TextPaint paint, Layout.Alignment alignment, boolean justify,
                 boolean endAligned, int maxLines, TextUtils.TruncateAt ellipsize, float density,
                 TextDirectionHeuristic direction) {
            this.direction = direction;
            this.text = text;
            this.paint = paint;
            this.alignment = alignment;
            this.justify = justify;
            this.endAligned = endAligned;
            this.maxLines = maxLines;
            this.ellipsize = ellipsize;
            this.density = density;
        }

        int desired() {
            if (desired < 0) {
                float w;
                if (android.os.Build.VERSION.SDK_INT >= 29 && text instanceof PrecomputedText && singleParagraph()) {
                    // Already measured: no shaping again.
                    w = ((PrecomputedText) text).getWidth(0, text.length());
                } else {
                    w = Layout.getDesiredWidth(text, paint);
                }
                // Minikin gives each glyph half the letter spacing on both
                // sides and trims the halves at line edges: a negative
                // spacing (`tracking-tight`) makes a line wider than its sum
                // of advances, and text laid out at that sum wraps.
                desired = (int) Math.ceil(w + negativeSpacing());
            }
            return desired;
        }

        /** The largest negative letter spacing of any run, as positive px. */
        private float negativeSpacing() {
            float most = Math.max(0, -paint.getLetterSpacing() * paint.getTextSize());
            if (text instanceof Spanned) {
                Spanned spanned = (Spanned) text;
                for (FontSpan f : spanned.getSpans(0, text.length(), FontSpan.class)) most = Math.max(most, -f.spacingPx);
            }
            return most;
        }

        private boolean singleParagraph() {
            return TextUtils.indexOf(text, '\n') < 0;
        }

        StaticLayout layout(int widthPx) {
            widthPx = Math.max(0, widthPx);
            for (StaticLayout l : layouts) if (l != null && l.getWidth() == widthPx) return l;
            // Break strategy and hyphenation match the PrecomputedText params,
            // so the builder reuses its glyph measurements.
            StaticLayout.Builder b = StaticLayout.Builder.obtain(text, 0, text.length(), paint, widthPx)
                    .setAlignment(alignment)
                    .setTextDirection(direction)
                    .setIncludePad(false)
                    .setLineSpacing(0f, 1f)
                    .setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE)
                    .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE);
            if (justify) b.setJustificationMode(Layout.JUSTIFICATION_MODE_INTER_WORD);
            if (maxLines > 0) {
                b.setMaxLines(maxLines);
                if (ellipsize != null) b.setEllipsize(ellipsize);
            }
            StaticLayout l = b.build();
            layouts[next] = l;
            next = (next + 1) % layouts.length;
            return l;
        }
    }

    static Object prepare(String text, int[] ints, float[] floats, String[] families, int align,
                          int maxLines, int ellipsize, float density, int shadowColor, float shadowDx,
                          float shadowDy, float shadowRadius, float[] attachments) {
        SpannableString s = new SpannableString(text);
        TextPaint paint = new TextPaint(Paint.ANTI_ALIAS_FLAG);
        paint.density = density;
        if ((shadowColor >>> 24) != 0) {
            // A zero radius would remove the shadow layer.
            paint.setShadowLayer(Math.max(0.01f, shadowRadius * density), shadowDx * density, shadowDy * density, shadowColor);
        }
        int spans = ints.length / SPAN_INTS;
        // The span background being extended over neighboring runs.
        Background background = null;
        int backgroundStart = 0, backgroundEnd = 0;
        android.graphics.Paint.FontMetrics metrics = new android.graphics.Paint.FontMetrics();
        TextPaint measure = new TextPaint();
        for (int i = 0; i < spans; i++) {
            int o = i * SPAN_INTS;
            int start = ints[o], end = Math.min(ints[o + 1], text.length());
            if (start >= end) continue;
            int weight = ints[o + 2], flags = ints[o + 3], color = ints[o + 4];
            String family = ints[o + 6] >= 0 ? families[ints[o + 6]] : null;
            float size = floats[i * SPAN_FLOATS] * density;
            float lineHeight = floats[i * SPAN_FLOATS + 1] * density;
            float spacing = floats[i * SPAN_FLOATS + 2] * density;
            float thickness = floats[i * SPAN_FLOATS + 3] * density;
            float offset = floats[i * SPAN_FLOATS + 4] * density;
            Typeface typeface = typeface(family, weight, (flags & ITALIC) != 0);
            if (i == 0) {
                // Base metrics (empty lines, ellipsis) follow the first run.
                paint.setTextSize(size);
                paint.setTypeface(typeface);
            }
            int f = Spanned.SPAN_EXCLUSIVE_EXCLUSIVE;
            s.setSpan(new AbsoluteSizeSpan(Math.round(size)), start, end, f);
            s.setSpan(new ForegroundColorSpan(color), start, end, f);
            s.setSpan(new FontSpan(typeface, spacing, features(ints[o + 7])), start, end, f);
            if (lineHeight > 0) s.setSpan(new ExactLineHeight(lineHeight), start, end, Spanned.SPAN_INCLUSIVE_INCLUSIVE);
            // StaticLayout does not draw decorations of precomputed text:
            // TextBox draws these.
            if ((flags & (UNDERLINE | STRIKE)) != 0) {
                s.setSpan(new Decoration((flags & UNDERLINE) != 0, (flags & STRIKE) != 0, ints[o + 5], size,
                        ints[o + 8], thickness, offset), start, end, f);
            }
            if ((flags & BACKGROUND) != 0) {
                measure.setTypeface(typeface);
                measure.setTextSize(size);
                measure.getFontMetrics(metrics);
                float radius = floats[i * SPAN_FLOATS + 5] * density;
                if (background != null && background.same(ints[o + 9], ints[o + 10], radius) && backgroundEnd == start) {
                    background.ascentPx = Math.max(background.ascentPx, -metrics.ascent);
                    background.descentPx = Math.max(background.descentPx, metrics.descent);
                } else {
                    if (background != null) s.setSpan(background, backgroundStart, backgroundEnd, f);
                    background = new Background(ints[o + 9], ints[o + 10], radius, -metrics.ascent, metrics.descent);
                    backgroundStart = start;
                }
                backgroundEnd = end;
            }
        }
        if (background != null) s.setSpan(background, backgroundStart, backgroundEnd, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        // Attachments (offset, width, height in dp, vertical alignment):
        // placeholders of their size, placed in their line.
        for (int i = 0; i + 3 < attachments.length; i += 4) {
            int at = (int) attachments[i];
            if (at < 0 || at >= text.length()) continue;
            s.setSpan(new Attachment(Math.round(attachments[i + 1] * density), Math.round(attachments[i + 2] * density),
                    (int) attachments[i + 3]), at, at + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
        // `encode` packs the writing direction and the layout direction in.
        int writing = (align >> 4) & 3;
        boolean rtlLayout = (align & 0x100) != 0;
        align &= 15;
        TextDirectionHeuristic direction = writing == 1 ? TextDirectionHeuristics.LTR
                : writing == 2 ? TextDirectionHeuristics.RTL
                : rtlLayout ? TextDirectionHeuristics.FIRSTSTRONG_RTL : TextDirectionHeuristics.FIRSTSTRONG_LTR;
        // `auto` is the right side right to left (as on iOS).
        if (align == 0 && rtlLayout) align = 3;
        Layout.Alignment alignment = align == 2 ? Layout.Alignment.ALIGN_CENTER : Layout.Alignment.ALIGN_NORMAL;
        boolean endAligned = false;
        if (align == 1 || align == 3) {
            // Left and right are absolute, while Android's alignments follow
            // each paragraph's direction: align each paragraph by its own.
            int start = 0;
            while (start <= text.length()) {
                int end = text.indexOf('\n', start);
                if (end < 0) end = text.length();
                boolean rtl = direction.isRtl(text, start, end - start);
                boolean normal = (align == 1) != rtl;
                endAligned |= !normal;
                int spanEnd = Math.min(end + 1, text.length());
                if (spanEnd > start) {
                    s.setSpan(new AlignmentSpan.Standard(normal ? Layout.Alignment.ALIGN_NORMAL : Layout.Alignment.ALIGN_OPPOSITE),
                            start, spanEnd, Spanned.SPAN_PARAGRAPH);
                }
                start = end + 1;
            }
        }
        TextUtils.TruncateAt truncate;
        switch (ellipsize) {
            case 1: truncate = TextUtils.TruncateAt.START; break;
            case 2: truncate = TextUtils.TruncateAt.MIDDLE; break;
            case 3: truncate = null; break;
            default: truncate = TextUtils.TruncateAt.END;
        }
        // Glyphs are measured once here; every layout width reuses them.
        PrecomputedText.Params params = new PrecomputedText.Params.Builder(paint)
                .setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE)
                .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE)
                .setTextDirection(direction)
                .build();
        CharSequence measured = PrecomputedText.create(s, params);
        return new Prepared(measured, paint, alignment, align == 4, endAligned, maxLines, truncate, density,
                direction);
    }

    /** Size in dp, packed as two float bit patterns (width high). */
    static long measure(Object prepared, float maxWidthDp) {
        Prepared p = (Prepared) prepared;
        int width = p.desired();
        if (!Float.isNaN(maxWidthDp)) {
            // Text that fits lays out as at its natural width: same layout.
            width = Math.min(width, (int) Math.floor(maxWidthDp * p.density));
        }
        StaticLayout layout = p.layout(width);
        // Without an ellipsis StaticLayout ignores maxLines: count the lines
        // here (the view clips the rest).
        int lines = layout.getLineCount();
        if (p.maxLines > 0) lines = Math.min(lines, p.maxLines);
        float max = 0;
        for (int i = 0; i < lines; i++) max = Math.max(max, layout.getLineWidth(i));
        // The negative letter spacing `desired()` adds back is not in the
        // lines' widths: without it the box is too narrow for the line, and
        // the final layout breaks it.
        float w = (float) Math.ceil(Math.min(max + p.negativeSpacing(), width)) / p.density;
        float h = layout.getLineTop(lines) / p.density;
        return ((long) Float.floatToRawIntBits(w) << 32) | (Float.floatToRawIntBits(h) & 0xffffffffL);
    }

    /** The final layout, in px, for a box of the given dp size. */
    static Object layout(Object prepared, float widthDp, float heightDp) {
        Prepared p = (Prepared) prepared;
        int width = (int) Math.ceil(widthDp * p.density);
        // Left-aligned LTR text that fits draws the same in a wider box:
        // keep the measured layout. Not text a paragraph span aligns to the
        // right: laid out at its natural width, it would stay on the left.
        if (p.alignment == Layout.Alignment.ALIGN_NORMAL && !p.justify && !p.endAligned
                && width >= p.desired()) {
            StaticLayout natural = p.layout(p.desired());
            if (natural.getParagraphDirection(0) == Layout.DIR_LEFT_TO_RIGHT) return natural;
        }
        return p.layout(width);
    }

    /** Floats per line of {@link #lines}. */
    static final int LINE_FLOATS = 10;

    /**
     * The lines of a final layout (`onTextLayout`), in dp: start and end
     * offsets (UTF-16), left, top, width, height, ascent, descent, cap
     * height and x height, per line.
     */
    static float[] lines(Object layout, float density) {
        if (!(layout instanceof Layout)) return new float[0];
        Layout l = (Layout) layout;
        int count = l.getLineCount();
        float[] out = new float[count * LINE_FLOATS];
        android.graphics.Rect bounds = new android.graphics.Rect();
        TextPaint paint = new TextPaint(l.getPaint());
        paint.getTextBounds("H", 0, 1, bounds);
        float cap = bounds.height();
        paint.getTextBounds("x", 0, 1, bounds);
        float x = bounds.height();
        for (int i = 0; i < count; i++) {
            int o = i * LINE_FLOATS;
            out[o] = l.getLineStart(i);
            out[o + 1] = l.getLineEnd(i);
            out[o + 2] = l.getLineLeft(i) / density;
            out[o + 3] = l.getLineTop(i) / density;
            out[o + 4] = l.getLineWidth(i) / density;
            out[o + 5] = (l.getLineBottom(i) - l.getLineTop(i)) / density;
            out[o + 6] = -l.getLineAscent(i) / density;
            out[o + 7] = l.getLineDescent(i) / density;
            out[o + 8] = cap / density;
            out[o + 9] = x / density;
        }
        return out;
    }

    /**
     * Where a final layout put its attachments, in text order: x, y (top
     * left, dp) each, NaN for ones cut off (lines past the limit, an
     * ellipsis).
     */
    static float[] attachments(Object layout, float density) {
        if (!(layout instanceof Layout)) return new float[0];
        Layout l = (Layout) layout;
        CharSequence text = l.getText();
        if (!(text instanceof Spanned)) return new float[0];
        Spanned spanned = (Spanned) text;
        Attachment[] spans = spanned.getSpans(0, text.length(), Attachment.class);
        java.util.Arrays.sort(spans, (a, b) -> spanned.getSpanStart(a) - spanned.getSpanStart(b));
        float[] out = new float[spans.length * 2];
        int lines = l.getLineCount();
        for (int i = 0; i < spans.length; i++) {
            Attachment a = spans[i];
            int at = spanned.getSpanStart(a);
            int line = l.getLineForOffset(at);
            boolean shown = lines > 0 && at < l.getLineEnd(lines - 1);
            if (shown && l.getEllipsisCount(line) > 0) shown = at < l.getLineStart(line) + l.getEllipsisStart(line);
            if (!shown) {
                out[i * 2] = Float.NaN;
                out[i * 2 + 1] = Float.NaN;
                continue;
            }
            float x = l.getPrimaryHorizontal(at);
            // Right to left, the placeholder extends left of its offset.
            if (l.isRtlCharAt(at)) x -= a.width;
            out[i * 2] = x / density;
            out[i * 2 + 1] = (l.getLineBaseline(line) - a.ascent) / density;
        }
        return out;
    }

    // Hit testing of a final layout: the caret at a point, a caret's box and the
    // boxes of a range (`TextEngine::hit_test`, `caret_rect` and `range_rects`).
    // The engine thread asks through JNI in dp; the UI thread (TextBox,
    // SelectableView, TestAgent) asks the same methods in px (`density` 1), so one
    // implementation answers both. Coordinates are the layout's own, which is the
    // content box: the layouts are made without padding and TextBox draws them
    // translated to the box's corner.

    /** A hit: the offset in the low 32 bits, bit 32 for a caret at the end of a wrapped line. */
    private static long packHit(int offset, boolean upstream) {
        return (upstream ? 1L << 32 : 0L) | (offset & 0xffffffffL);
    }

    /** The offset (UTF-16) of a {@link #hitTest} result. */
    static int hitOffset(long hit) {
        return (int) hit;
    }

    /**
     * Whether a {@link #hitTest} result is the end of a wrapped line, on that
     * line (`Affinity::Upstream`): its offset is the next line's start too.
     */
    static boolean hitUpstream(long hit) {
        return (hit >>> 32) != 0;
    }

    /**
     * The caret nearest ({@code x}, {@code y}) of a final layout, as {@link
     * #hitOffset} and {@link #hitUpstream} read it: on the line at that height
     * (the first above the text, the last below it), at the caret edge nearest x
     * (bidirectional text in visual order). A point past the end of a wrapped
     * line gives its end, upstream; a line that ends in a break character stops
     * before it. {@code density}: px per unit of {@code x} and {@code y}.
     */
    static long hitTest(Object layout, float x, float y, float density) {
        if (!(layout instanceof Layout)) return 0;
        Layout l = (Layout) layout;
        int lines = l.getLineCount();
        if (lines == 0) return 0;
        x *= density;
        y *= density;
        int line = l.getLineForVertical((int) y);
        // Android's nearest caret. On a line that is not the text's last it stops
        // before the line's last character (to Android the line's end is the next
        // line's start), which also keeps it before a break character.
        int offset = l.getOffsetForHorizontal(line, x);
        int end = l.getLineEnd(line);
        if (line < lines - 1 && end > l.getLineStart(line) && breakStart(l, line) == end
                && l.isRtlCharAt(end - 1) == (l.getParagraphDirection(line) == Layout.DIR_RIGHT_TO_LEFT)) {
            // A wrapped line whose last character is at the line's far edge: the
            // end of the line, its other edge, is the nearer caret from past the
            // character's middle on. Lines that end in the other direction keep
            // Android's caret: the nearest one on screen.
            float endX = wrappedEndX(l, line);
            if (offset == l.getOffsetForHorizontal(line, endX)
                    && Math.abs(x - endX) < Math.abs(x - l.getPrimaryHorizontal(offset))) {
                return packHit(end, true);
            }
        }
        return packHit(offset, false);
    }

    /**
     * The caret at {@code offset} (UTF-16) of a final layout, a box without
     * width as high as its line: x, y, height; empty without lines.
     * {@code upstream}: at the end of a wrapped line, the caret on that line
     * rather than at the start of the next. {@code density}: px per unit of the
     * result.
     */
    static float[] caretRect(Object layout, int offset, boolean upstream, float density) {
        if (!(layout instanceof Layout)) return new float[0];
        Layout l = (Layout) layout;
        if (l.getLineCount() == 0) return new float[0];
        offset = Math.max(0, Math.min(offset, l.getText().length()));
        int line = l.getLineForOffset(offset);
        if (upstream && line > 0 && offset == l.getLineStart(line)) line--;
        // Never after a break character; the end of a wrapped line is not an
        // offset of its own to Android.
        int at = Math.min(offset, breakStart(l, line));
        float x = at == l.getLineEnd(line) && line < l.getLineCount() - 1
                ? wrappedEndX(l, line)
                : l.getPrimaryHorizontal(at);
        int top = l.getLineTop(line);
        return new float[] {x / density, top / density, (l.getLineBottom(line) - top) / density};
    }

    /**
     * The boxes of the characters {@code start}..{@code end} (UTF-16) of a final
     * layout, line high: per line one for each stretch of adjacent characters
     * (bidirectional text splits a range), through the line's end where the
     * range goes on past it; x, y, width, height each. Break characters and what
     * an ellipsis replaced have none. {@code density}: px per unit of the result.
     */
    static float[] rangeRects(Object layout, int start, int end, float density) {
        if (!(layout instanceof Layout)) return new float[0];
        Layout l = (Layout) layout;
        start = Math.max(0, start);
        end = Math.min(end, l.getText().length());
        int lines = l.getLineCount();
        if (start >= end || lines == 0) return new float[0];
        Boxes boxes = new Boxes();
        for (int line = l.getLineForOffset(start); line < lines; line++) {
            int lineStart = l.getLineStart(line);
            if (lineStart >= end) break;
            int a = Math.max(start, lineStart), b = Math.min(end, breakStart(l, line));
            int first = boxes.count;
            if (l.getEllipsisCount(line) > 0) {
                int ellipsis = lineStart + l.getEllipsisStart(line);
                addRuns(l, line, a, Math.min(b, ellipsis), boxes);
                addRuns(l, line, Math.max(a, ellipsis + l.getEllipsisCount(line)), b, boxes);
            } else {
                addRuns(l, line, a, b, boxes);
            }
            boxes.merge(first);
        }
        return boxes.rects(density);
    }

    /**
     * Where a line's break begins: its end, or before the character that ends
     * it (a newline, a carriage return, a line or paragraph separator; "\r\n"
     * as one). Carets stay before it.
     */
    private static int breakStart(Layout l, int line) {
        int start = l.getLineStart(line), end = l.getLineEnd(line);
        if (end <= start) return end;
        CharSequence text = l.getText();
        char c = text.charAt(end - 1);
        if (c != '\n' && c != '\r' && c != '\u0085' && c != '\u2028' && c != '\u2029') return end;
        return c == '\n' && end - 1 > start && text.charAt(end - 2) == '\r' ? end - 2 : end - 1;
    }

    /**
     * The x of the end of a line that wrapped, past its last character and the
     * white space that hangs after it: the far edge of the line in its
     * paragraph's direction, as far from where Android starts the line as the
     * line is wide.
     */
    private static float wrappedEndX(Layout l, int line) {
        float width = l.getLineWidth(line);
        float start = l.getPrimaryHorizontal(l.getLineStart(line));
        return l.getParagraphDirection(line) == Layout.DIR_RIGHT_TO_LEFT ? start - width : start + width;
    }

    /**
     * The carets of {@code offset} on a line: Android's primary and secondary
     * ones, which differ where the direction changes (the end of one run, the
     * start of the next). A wrapped line's end is one of its own.
     */
    private static float[] edges(Layout l, int line, int offset) {
        if (offset == l.getLineEnd(line) && line < l.getLineCount() - 1) return new float[] {wrappedEndX(l, line)};
        float primary = l.getPrimaryHorizontal(offset), secondary = l.getSecondaryHorizontal(offset);
        return primary == secondary ? new float[] {primary} : new float[] {primary, secondary};
    }

    /** The boxes of the characters {@code a}..{@code b} of a line: one per run of one direction. */
    private static void addRuns(Layout l, int line, int a, int b, Boxes out) {
        float top = l.getLineTop(line), bottom = l.getLineBottom(line);
        int i = a;
        while (i < b) {
            boolean rtl = l.isRtlCharAt(i);
            int j = i + 1;
            while (j < b && l.isRtlCharAt(j) == rtl) j++;
            // The run's first character starts at one of the carets before it and its
            // last ends at one of those after it: the left edge is the first's and the
            // right edge the last's (the other way round right to left).
            float[] before = edges(l, line, i), after = edges(l, line, j);
            if (!addBox(rtl ? after : before, rtl ? before : after, top, bottom, out)
                    && j == l.getLineEnd(line) && line < l.getLineCount() - 1) {
                // A last run against the paragraph's direction does not end at the line's
                // end: its far edge is among the carets before it.
                float[] all = new float[before.length + after.length];
                System.arraycopy(before, 0, all, 0, before.length);
                System.arraycopy(after, 0, all, before.length, after.length);
                addBox(all, all, top, bottom, out);
            }
            i = j;
        }
    }

    /**
     * Adds the narrowest box from one of {@code lefts} to one of {@code rights}:
     * carets of other runs, which lie outside this one, make wider ones. False
     * when there is none (no width).
     */
    private static boolean addBox(float[] lefts, float[] rights, float top, float bottom, Boxes out) {
        float width = Float.MAX_VALUE, left = 0, right = 0;
        for (float lo : lefts) {
            for (float hi : rights) {
                if (hi > lo && hi - lo < width) {
                    width = hi - lo;
                    left = lo;
                    right = hi;
                }
            }
        }
        if (width == Float.MAX_VALUE) return false;
        out.add(left, top, right, bottom);
        return true;
    }

    /** Boxes being collected (left, top, right, bottom, px). */
    private static final class Boxes {
        float[] v = new float[16];
        int count;

        void add(float left, float top, float right, float bottom) {
            if ((count + 1) * 4 > v.length) v = java.util.Arrays.copyOf(v, v.length * 2);
            int o = count++ * 4;
            v[o] = left;
            v[o + 1] = top;
            v[o + 2] = right;
            v[o + 3] = bottom;
        }

        /** Joins the boxes from {@code first} on that touch (those of one line), left to right. */
        void merge(int first) {
            for (int i = first + 1; i < count; i++) {
                for (int j = i; j > first && v[(j - 1) * 4] > v[j * 4]; j--) {
                    for (int k = 0; k < 4; k++) {
                        float t = v[j * 4 + k];
                        v[j * 4 + k] = v[(j - 1) * 4 + k];
                        v[(j - 1) * 4 + k] = t;
                    }
                }
            }
            int out = first;
            for (int i = first; i < count; i++) {
                // Runs measured from different carets meet within a rounding error.
                if (out > first && v[i * 4] <= v[(out - 1) * 4 + 2] + 0.5f) {
                    v[(out - 1) * 4 + 2] = Math.max(v[(out - 1) * 4 + 2], v[i * 4 + 2]);
                } else {
                    System.arraycopy(v, i * 4, v, out * 4, 4);
                    out++;
                }
            }
            count = out;
        }

        /** x, y, width, height of each box, in units of {@code density} px. */
        float[] rects(float density) {
            float[] out = new float[count * 4];
            for (int i = 0; i < count; i++) {
                int o = i * 4;
                out[o] = v[o] / density;
                out[o + 1] = v[o + 1] / density;
                out[o + 2] = (v[o + 2] - v[o]) / density;
                out[o + 3] = (v[o + 3] - v[o + 1]) / density;
            }
            return out;
        }
    }

    /**
     * An attachment's placeholder: its size, placed in its line by its
     * `verticalAlign` (as `TextAttachment::ascent` in nsh-core places it, with
     * the run's font metrics); the line grows to hold it. Draws nothing.
     */
    static final class Attachment extends android.text.style.ReplacementSpan {
        /** `verticalAlign`: on the baseline, at the font's top, at its bottom, in the middle. */
        static final int BASELINE = 0, TEXT_TOP = 1, TEXT_BOTTOM = 2, MIDDLE = 3;
        final int width, height, align;
        /** How far its top is above the baseline (px; negative: below), set by {@link #getSize}. */
        int ascent;

        Attachment(int width, int height, int align) {
            this.width = width;
            this.height = height;
            this.align = align;
            this.ascent = height;
        }

        @Override
        public int getSize(Paint paint, CharSequence text, int start, int end, Paint.FontMetricsInt fm) {
            if (align != BASELINE) {
                // The font around it, unrounded (as the other platforms read it).
                Paint.FontMetrics font = paint.getFontMetrics();
                switch (align) {
                    case TEXT_TOP:
                        ascent = Math.round(-font.ascent);
                        break;
                    case TEXT_BOTTOM:
                        ascent = Math.round(height - font.descent);
                        break;
                    default: {
                        android.graphics.Rect x = new android.graphics.Rect();
                        paint.getTextBounds("x", 0, 1, x);
                        ascent = Math.round((height - x.top) / 2f);
                        break;
                    }
                }
            }
            if (fm != null) {
                Paint.FontMetricsInt own = paint.getFontMetricsInt();
                fm.ascent = Math.min(own.ascent, -Math.max(0, ascent));
                fm.top = Math.min(own.top, fm.ascent);
                fm.descent = Math.max(own.descent, height - ascent);
                fm.bottom = Math.max(own.bottom, fm.descent);
                fm.leading = own.leading;
            }
            return width;
        }

        @Override
        public void draw(android.graphics.Canvas canvas, CharSequence text, int start, int end, float x, int top, int y,
                int bottom, Paint paint) {}
    }

    /** Typeface and letter spacing of a run. */
    /** Underline / strikethrough of a run (drawn by {@link TextBox}). */
    static final class Decoration {
        final boolean underline, strike;
        final int color;
        final float sizePx;
        /** 0 solid, 1 double, 2 dotted, 3 dashed, 4 wavy. */
        final int style;
        /** Px; 0 is the font's. */
        final float thicknessPx;
        /** Px below the baseline; NaN is the font's. */
        final float offsetPx;

        Decoration(boolean underline, boolean strike, int color, float sizePx, int style, float thicknessPx,
                   float offsetPx) {
            this.underline = underline;
            this.strike = strike;
            this.color = color;
            this.sizePx = sizePx;
            this.style = style;
            this.thicknessPx = thicknessPx;
            this.offsetPx = offsetPx;
        }
    }

    /** A span background (`backgroundColor` on a nested text), drawn by
     * {@code TextBox} behind each line's part of its characters, as tall as
     * its fonts. One covers the neighboring runs of one span. */
    static final class Background {
        final int color;
        /** The span that set it: neighbors that look the same stay apart. */
        final int node;
        final float radiusPx;
        float ascentPx, descentPx;

        Background(int color, int node, float radiusPx, float ascentPx, float descentPx) {
            this.color = color;
            this.node = node;
            this.radiusPx = radiusPx;
            this.ascentPx = ascentPx;
            this.descentPx = descentPx;
        }

        boolean same(int color, int node, float radiusPx) {
            return this.color == color && this.node == node && this.radiusPx == radiusPx;
        }
    }

    /** OpenType feature settings for `fontVariant` bits (`nsh_core::FontVariant`), or null. */
    static String features(int bits) {
        if (bits == 0) return null;
        StringBuilder b = new StringBuilder();
        String[] tags = {"smcp", "onum", "lnum", "tnum", "pnum"};
        for (int i = 0; i < tags.length; i++) {
            if ((bits & (1 << i)) == 0) continue;
            if (b.length() > 0) b.append(", ");
            b.append('\'').append(tags[i]).append('\'');
        }
        return b.toString();
    }

    private static final class FontSpan extends MetricAffectingSpan {
        private final Typeface typeface;
        private final float spacingPx;
        private final String features;

        FontSpan(Typeface typeface, float spacingPx, String features) {
            this.typeface = typeface;
            this.spacingPx = spacingPx;
            this.features = features;
        }

        private void apply(TextPaint paint) {
            paint.setTypeface(typeface);
            if (spacingPx != 0 && paint.getTextSize() > 0) paint.setLetterSpacing(spacingPx / paint.getTextSize());
            if (features != null) paint.setFontFeatureSettings(features);
        }

        @Override
        public void updateMeasureState(TextPaint paint) {
            apply(paint);
        }

        @Override
        public void updateDrawState(TextPaint paint) {
            apply(paint);
        }
    }

    /** `lineHeight`: every line exactly this tall, extra space split around the glyphs. */
    private static final class ExactLineHeight implements LineHeightSpan {
        private final int height;

        ExactLineHeight(float height) {
            this.height = (int) Math.ceil(height);
        }

        @Override
        public void chooseHeight(CharSequence text, int start, int end, int spanstartv, int lineHeight,
                                 Paint.FontMetricsInt fm) {
            int current = fm.descent - fm.ascent;
            if (current <= 0) return;
            int extra = height - current;
            int top = extra / 2;
            fm.ascent -= top;
            fm.top = fm.ascent;
            fm.descent += extra - top;
            fm.bottom = fm.descent;
        }
    }
}
