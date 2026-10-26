package com.longbridge.nsh;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.text.Editable;
import android.text.InputFilter;
import android.text.InputType;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.BaseInputConnection;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputConnectionWrapper;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.FrameLayout;

/** `<input>`: an EditText inside a container that carries the decoration. */
@SuppressLint("ViewConstructor")
final class InputBox extends FrameLayout implements Node {
    final Mounter mounter;
    final int id;
    final Decor decor = new Decor();
    final EditText edit;
    /** Edits reported to the engine. */
    int count;
    /** The text as last reported or set. */
    private String known = "";
    private boolean multiline;
    /** What return does (`submitBehavior`, resolved by the core; encode.rs's codes). */
    private static final int SUBMIT_AND_BLUR = 1, NEWLINE = 2;
    private int submit = SUBMIT_AND_BLUR;
    private boolean applying;
    private boolean configured;
    /** The composition last seen (`onCompositionChange` reports its changes). */
    private boolean inComposition;
    private String composed = "";
    /**
     * A value JS set during a composition, applied when it ends: setting the
     * text restarts the input method, which commits the pre-edit text.
     */
    private String pendingText;
    private int pendingCount;
    /** Inside the text watcher, where replacing the text would corrupt the IME's edit. */
    private boolean watching;
    private final Runnable autoFocus = () -> {
        if (isAttachedToWindow()) focus();
    };
    /** `pasteBehavior` is `"insert"`: a paste inserts its text. */
    boolean pasteInserts = true;

    InputBox(Context context, Mounter mounter, int id) {
        super(context);
        this.mounter = mounter;
        this.id = id;
        setBackground(decor);
        edit = new EditText(context) {
            @Override
            protected void onAttachedToWindow() {
                super.onAttachedToWindow();
                // A detached navigation screen may already have a text layout,
                // with Editor's selection controllers disabled for lack of a window.
                // Reapplying the current break strategy discards that layout so the
                // next measure refreshes the controllers under the attached window,
                // without replacing editable text or changing textIsSelectable.
                if (getLayout() != null) setBreakStrategy(getBreakStrategy());
            }

            @Override
            public boolean onKeyUp(int code, android.view.KeyEvent event) {
                // The up of an Enter whose down submitted another field (focus
                // moved meanwhile) must not advance focus again.
                if (code == android.view.KeyEvent.KEYCODE_ENTER && submit != NEWLINE) return true;
                return super.onKeyUp(code, event);
            }

            @Override
            public boolean onKeyDown(int code, android.view.KeyEvent event) {
                // Hardware keys, and keys the keyboard sends as key events.
                if (code == android.view.KeyEvent.KEYCODE_DEL) key("Backspace");
                else if (code == android.view.KeyEvent.KEYCODE_ENTER) key("Enter");
                else if (event.getUnicodeChar() != 0) key(String.valueOf((char) event.getUnicodeChar()));
                return super.onKeyDown(code, event);
            }

            @Override
            public InputConnection onCreateInputConnection(EditorInfo info) {
                InputConnection connection = super.onCreateInputConnection(info);
                // TextView hides the action key of multiline inputs; one that
                // submits shows it, as React Native does.
                if (multiline && submit != NEWLINE) info.imeOptions &= ~EditorInfo.IME_FLAG_NO_ENTER_ACTION;
                return connection == null ? null : new KeyConnection(connection);
            }

            @Override
            protected void onSelectionChanged(int start, int end) {
                super.onSelectionChanged(start, end);
                if (mounter != null && mounter.wants(InputBox.this.id, Native.SELECTION_CHANGE)) {
                    mounter.eventMap(InputBox.this.id, Native.SELECTION_CHANGE, new String[] {"start", "end"},
                            new Object[] {(double) start, (double) end});
                }
                // Called while the EditText is made, before `edit` is set.
                reportCaret(this);
            }

            @Override
            public boolean onTextContextMenuItem(int item) {
                // Before Android 12 a paste comes here (the menu, Ctrl+V);
                // from then on `receiveContent` hears it.
                if (Build.VERSION.SDK_INT < 31
                        && (item == android.R.id.paste || item == android.R.id.pasteAsPlainText)) {
                    android.content.ClipboardManager board = (android.content.ClipboardManager)
                            getContext().getSystemService(Context.CLIPBOARD_SERVICE);
                    android.content.ClipData clip = board == null ? null : board.getPrimaryClip();
                    if (clip != null && pasted(clip) && !pasteInserts) return true;
                }
                return super.onTextContextMenuItem(item);
            }

            @Override
            protected void onScrollChanged(int left, int top, int oldLeft, int oldTop) {
                super.onScrollChanged(left, top, oldLeft, oldTop);
                reportCaret(this);
            }

            @Override
            protected void onSizeChanged(int w, int h, int oldW, int oldH) {
                super.onSizeChanged(w, h, oldW, oldH);
                // The text wraps again once laid out at the new size.
                post(() -> reportCaret(this));
            }
        };
        edit.setBackground(new ColorDrawable(0));
        edit.setPadding(0, 0, 0, 0);
        edit.setIncludeFontPadding(false);
        // The line's height from its own font, as Text's StaticLayout has it:
        // fallback fonts' taller metrics (HyperOS's sans-serif has them) would
        // put the centered text above the middle of the field.
        if (Build.VERSION.SDK_INT >= 28) edit.setFallbackLineSpacing(false);
        edit.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {}

            @Override
            public void afterTextChanged(Editable s) {
                if (applying) return;
                // Reconfiguring (filters, input type) sets the same text
                // again: only real edits count.
                String text = s.toString();
                // A composition that starts or changes is reported before
                // the text holding it, one that ends after the text it
                // committed, as browsers order them.
                boolean composingNow = BaseInputConnection.getComposingSpanStart(s) >= 0;
                watching = true;
                try {
                    if (composingNow) syncComposition();
                    if (!text.equals(known)) {
                        known = text;
                        InputBox.this.count++;
                        mounter.event(id, Native.CHANGE_TEXT, text, InputBox.this.count, 0, 0);
                    }
                    if (!composingNow) syncComposition();
                } finally {
                    watching = false;
                }
            }
        });
        edit.setOnEditorActionListener((v, action, event) -> {
            // A hardware Enter inserts a line break where return does, and
            // with Shift or Alt in any multiline input.
            if (multiline && event != null
                    && (submit == NEWLINE || event.isShiftPressed() || event.isAltPressed())) return false;
            // The keyboard's action key (a hardware Enter reported its key).
            if (event == null) key("Enter");
            // A hardware Enter reports its down and its up: act once. (The up
            // would otherwise reach the next field, focused meanwhile.)
            if (event != null && event.getAction() != android.view.KeyEvent.ACTION_DOWN) return true;
            submit();
            return true;
        });
        edit.setOnFocusChangeListener((v, focused) -> {
            if (!focused) {
                // A composition does not outlive the focus: what was composed
                // stays, committed (the keyboard may not say so).
                edit.clearComposingText();
                syncComposition();
            }
            mounter.inputFocused(this, focused);
            mounter.reportState(id, Mounter.STATE_FOCUSED, focused);
            if (mounter.wants(id, focused ? Native.FOCUS : Native.BLUR)) {
                mounter.event(id, focused ? Native.FOCUS : Native.BLUR);
            }
        });
        addView(edit, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        if (Build.VERSION.SDK_INT >= 31) {
            // Pastes and keyboards' images (GIFs, stickers) come here; the
            // types tell keyboards that images are welcome.
            edit.setOnReceiveContentListener(new String[] {"image/*"}, this::receiveContent);
        }
    }

    /**
     * A paste or a keyboard's content (Android 12 on): reported (`onPaste`), and
     * its text left to the EditText while `pasteBehavior` inserts it. Images and
     * files are never inserted.
     */
    @android.annotation.TargetApi(31)
    private android.view.ContentInfo receiveContent(View view, android.view.ContentInfo payload) {
        int source = payload.getSource();
        if (source != android.view.ContentInfo.SOURCE_CLIPBOARD
                && source != android.view.ContentInfo.SOURCE_INPUT_METHOD) return payload;
        // Without a listener a paste that inserts is the EditText's own.
        if (!pasted(payload.getClip()) && pasteInserts) return payload;
        if (!pasteInserts) return null;
        // The text goes on to the EditText; what else there was is consumed.
        android.content.ClipData clip = payload.getClip();
        android.content.ClipData text = null;
        for (int i = 0; i < clip.getItemCount(); i++) {
            android.content.ClipData.Item item = clip.getItemAt(i);
            if (item.getUri() != null) continue;
            if (text == null) text = new android.content.ClipData(clip.getDescription(), item);
            else text.addItem(item);
        }
        return text == null ? null : new android.view.ContentInfo.Builder(payload).setClip(text).build();
    }

    /**
     * Reports what {@code clip} holds (`onPaste`), if the app listens: its text,
     * its images' bytes (read from their content URIs as the user pastes) and local
     * files' URLs. True when it reported.
     */
    private boolean pasted(android.content.ClipData clip) {
        if (!mounter.wants(id, Native.PASTE)) return false;
        StringBuilder text = new StringBuilder();
        java.util.ArrayList<byte[]> images = new java.util.ArrayList<>();
        java.util.ArrayList<String> uris = new java.util.ArrayList<>();
        android.content.ContentResolver resolver = getContext().getContentResolver();
        for (int i = 0; i < clip.getItemCount(); i++) {
            android.content.ClipData.Item item = clip.getItemAt(i);
            android.net.Uri uri = item.getUri();
            if (uri == null) {
                CharSequence t = item.coerceToText(getContext());
                if (t != null) text.append(t);
                continue;
            }
            if ("file".equals(uri.getScheme())) {
                uris.add(uri.toString());
                continue;
            }
            String type = resolver.getType(uri);
            if (type != null && type.startsWith("image/")) {
                try (java.io.InputStream in = resolver.openInputStream(uri)) {
                    if (in != null) images.add(readAll(in));
                } catch (java.io.IOException | SecurityException e) {
                    android.util.Log.w("nsh", "a pasted image could not be read: " + e);
                }
            } else {
                CharSequence t = item.coerceToText(getContext());
                if (t != null) text.append(t);
            }
        }
        mounter.paste(id, text.toString(), images.toArray(new byte[0][]), uris.toArray(new String[0]));
        return true;
    }

    private static byte[] readAll(java.io.InputStream in) throws java.io.IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[64 * 1024];
        for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
        return out.toByteArray();
    }

    void configure(float fontSizeDp, int weight, boolean italic, int color, String family, float letterSpacingDp,
                   int align, String placeholder, boolean hasPlaceholderColor, int placeholderColor,
                   boolean secure, int keyboard, int returnKey, int capitalize, boolean autoCorrect,
                   boolean multiline, int maxLength, boolean editable, boolean autoFocus,
                   boolean hasSelectionColor, int selectionColor, int submit) {
        boolean restart = this.submit != submit && multiline && configured;
        this.multiline = multiline;
        this.submit = submit;
        edit.setTextSize(TypedValue.COMPLEX_UNIT_PX, fontSizeDp * mounter.density);
        edit.setTextColor(color);
        if (letterSpacingDp != 0) edit.setLetterSpacing(letterSpacingDp / fontSizeDp);
        int horizontal = align == 1 ? Gravity.CENTER_HORIZONTAL : align == 2 ? Gravity.END : Gravity.START;
        edit.setGravity(horizontal | (multiline ? Gravity.TOP : Gravity.CENTER_VERTICAL));
        edit.setHint(placeholder);
        if (hasPlaceholderColor) edit.setHintTextColor(placeholderColor);
        int type;
        switch (keyboard) {
            case 1: type = InputType.TYPE_CLASS_NUMBER; break;
            case 2: type = InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL; break;
            // `numeric` (as React Native) and `numbers-and-punctuation`: a sign too.
            case 6:
            case 7:
                type = InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_SIGNED
                        | InputType.TYPE_NUMBER_FLAG_DECIMAL;
                break;
            case 3: type = InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS; break;
            case 4: type = InputType.TYPE_CLASS_PHONE; break;
            case 5: type = InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI; break;
            default: type = InputType.TYPE_CLASS_TEXT;
        }
        if ((type & InputType.TYPE_MASK_CLASS) == InputType.TYPE_CLASS_TEXT) {
            switch (capitalize) {
                case 1: type |= InputType.TYPE_TEXT_FLAG_CAP_SENTENCES; break;
                case 2: type |= InputType.TYPE_TEXT_FLAG_CAP_WORDS; break;
                case 3: type |= InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS; break;
                default: break;
            }
            type |= autoCorrect ? InputType.TYPE_TEXT_FLAG_AUTO_CORRECT : InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS;
            if (multiline) type |= InputType.TYPE_TEXT_FLAG_MULTI_LINE;
            if (secure) type = (type & ~InputType.TYPE_MASK_VARIATION) | InputType.TYPE_TEXT_VARIATION_PASSWORD;
        } else if (secure && (type & InputType.TYPE_MASK_CLASS) == InputType.TYPE_CLASS_NUMBER) {
            type |= InputType.TYPE_NUMBER_VARIATION_PASSWORD;
        }
        int selection = edit.getSelectionEnd();
        // Before the input type: setSingleLine replaces a password's
        // transformation (the text would show).
        edit.setSingleLine(!multiline);
        if (multiline) edit.setMaxLines(Integer.MAX_VALUE);
        edit.setInputType(type);
        // After the input type: password types reset the typeface to monospace.
        edit.setTypeface(TextLayouts.typeface(family, weight, italic));
        if (selection >= 0 && selection <= edit.length()) edit.setSelection(selection);
        int ime;
        switch (returnKey) {
            case 1: ime = EditorInfo.IME_ACTION_DONE; break;
            case 2: ime = EditorInfo.IME_ACTION_GO; break;
            case 3: ime = EditorInfo.IME_ACTION_NEXT; break;
            case 4: ime = EditorInfo.IME_ACTION_SEARCH; break;
            case 5: ime = EditorInfo.IME_ACTION_SEND; break;
            default: ime = multiline && submit == NEWLINE ? EditorInfo.IME_ACTION_NONE : EditorInfo.IME_ACTION_DONE;
        }
        edit.setImeOptions(ime);
        edit.setFilters(maxLength >= 0 ? new InputFilter[] {new InputFilter.LengthFilter(maxLength)} : new InputFilter[0]);
        edit.setEnabled(editable);
        if (hasSelectionColor && Build.VERSION.SDK_INT >= 29) {
            edit.setTextCursorDrawable(new ColorDrawable(selectionColor) {
                @Override
                public int getIntrinsicWidth() {
                    return Math.round(2 * mounter.density);
                }
            });
            edit.setHighlightColor((selectionColor & 0x00ffffff) | 0x55000000);
        } else if (!hasSelectionColor) {
            edit.setHighlightColor(0x5533b5e5);
        }
        boolean first = !configured;
        configured = true;
        if (first && autoFocus) post(this.autoFocus);
        // The keyboard reads the action key when the input connects.
        if (restart && edit.hasFocus()) {
            InputMethodManager imm = (InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null) imm.restartInput(edit);
        }
    }

    /** Return submitted: `onSubmitEditing`, then unfocuses for `blurAndSubmit`. */
    private void submit() {
        mounter.event(id, Native.SUBMIT_EDITING, edit.getText().toString(), count, 0, 0);
        if (submit == SUBMIT_AND_BLUR) blur();
    }

    /** The caret as last reported (`onCaretMove`): x, y, width, height in dp. */
    private final float[] caret = new float[4];

    /**
     * `onCaretMove` while the input edits, if its caret moved: the caret at the
     * selection's end, in the input's coordinates (dp; the EditText's padding,
     * gravity and scrolling applied).
     */
    private void reportCaret(android.widget.TextView view) {
        if (mounter == null || !mounter.wants(id, Native.CARET_MOVE) || !view.hasFocus()) return;
        android.text.Layout layout = view.getLayout();
        int end = view.getSelectionEnd();
        if (layout == null || end < 0) return;
        int line = layout.getLineForOffset(end);
        float d = mounter.density;
        // The EditText sits in the container's padding (the content box).
        float left = view.getLeft() + view.getTotalPaddingLeft() - view.getScrollX();
        float top = view.getTop() + view.getTotalPaddingTop() - view.getScrollY();
        float[] now = {
            (left + layout.getPrimaryHorizontal(end)) / d,
            (top + layout.getLineTop(line)) / d,
            // The cursor drawable is 2dp wide (`selectionColor`'s too).
            2,
            (layout.getLineBottom(line) - layout.getLineTop(line)) / d,
        };
        if (java.util.Arrays.equals(now, caret)) return;
        System.arraycopy(now, 0, caret, 0, 4);
        mounter.eventMap(id, Native.CARET_MOVE, new String[] {"caretX", "caretY", "caretWidth", "caretHeight"},
                new Object[] {(double) now[0], (double) now[1], (double) now[2], (double) now[3]});
    }

    /** `onKeyPress`. */
    private void key(String key) {
        if (mounter.wants(id, Native.KEY_PRESS)) {
            mounter.eventMap(id, Native.KEY_PRESS, new String[] {"key"}, new Object[] {key});
        }
    }

    /**
     * Reports a change of the composition (`onCompositionChange`) and applies
     * the value JS set during it once it ends. Read from the composing span
     * after every edit rather than from the connection's calls: keyboards
     * start, change and end compositions in many ways (`setComposingText`,
     * `setComposingRegion`, commits, batch edits, focus changes).
     */
    private void syncComposition() {
        Editable text = edit.getText();
        int start = text == null ? -1 : BaseInputConnection.getComposingSpanStart(text);
        int end = text == null ? -1 : BaseInputConnection.getComposingSpanEnd(text);
        boolean now = start >= 0 && end >= 0 && start != end;
        String composedNow = now ? text.subSequence(Math.min(start, end), Math.max(start, end)).toString() : "";
        if (now == inComposition && composedNow.equals(composed)) return;
        inComposition = now;
        composed = composedNow;
        if (mounter.wants(id, Native.COMPOSITION_CHANGE)) {
            mounter.eventMap(id, Native.COMPOSITION_CHANGE, new String[] {"composing", "text"},
                    new Object[] {now, composedNow});
        }
        if (!now && pendingText != null) {
            // Not from inside the text watcher: the edit that ended the
            // composition is still in progress there.
            if (watching) post(this::applyPending);
            else applyPending();
        }
    }

    /** The value JS set during the composition, unless the user typed since (or composes again). */
    private void applyPending() {
        if (inComposition || pendingText == null) return;
        String text = pendingText;
        pendingText = null;
        setValue(text, pendingCount);
    }

    /**
     * Reports the keys of soft keyboards, which edit through the input
     * connection rather than with key events.
     */
    private final class KeyConnection extends InputConnectionWrapper {
        /** The text being composed (a word the keyboard may still change). */
        private CharSequence composing;

        KeyConnection(InputConnection target) {
            super(target, true);
        }

        @Override
        public boolean setComposingText(CharSequence text, int position) {
            int before = composing == null ? 0 : composing.length();
            if (text.length() > before) key(text.subSequence(text.length() - 1, text.length()).toString());
            else if (text.length() < before) key("Backspace");
            composing = text;
            boolean done = super.setComposingText(text, position);
            syncComposition();
            return done;
        }

        @Override
        public boolean setComposingRegion(int start, int end) {
            boolean done = super.setComposingRegion(start, end);
            syncComposition();
            return done;
        }

        @Override
        public boolean finishComposingText() {
            composing = null;
            boolean done = super.finishComposingText();
            syncComposition();
            return done;
        }

        @Override
        public boolean commitText(CharSequence text, int position) {
            String added = text.toString();
            // Committing the word being composed adds only what is new.
            if (composing != null && added.startsWith(composing.toString())) added = added.substring(composing.length());
            composing = null;
            if (added.equals("\n")) key("Enter");
            else if (!added.isEmpty()) key(added);
            // Keyboards that type return as a line break rather than as the
            // action key: an input that submits takes no line break.
            if (multiline && submit != NEWLINE && text.toString().equals("\n")) {
                submit();
                return true;
            }
            boolean done = super.commitText(text, position);
            syncComposition();
            return done;
        }

        @Override
        public boolean deleteSurroundingText(int before, int after) {
            if (before > 0 || after > 0) key("Backspace");
            boolean done = super.deleteSurroundingText(before, after);
            syncComposition();
            return done;
        }

        @Override
        public boolean endBatchEdit() {
            boolean more = super.endBatchEdit();
            syncComposition();
            return more;
        }

        @Override
        public void closeConnection() {
            super.closeConnection();
            syncComposition();
        }
    }

    /** Selects {@code start..end} (clamped to the text). */
    void select(int start, int end) {
        int length = edit.length();
        edit.setSelection(Math.min(start, length), Math.min(Math.max(start, end), length));
    }

    /** Autofill: a hint ("" for none, null for the default). */
    void setAutofill(String hint) {
        if (Build.VERSION.SDK_INT < 26) return;
        if (hint == null) {
            edit.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_AUTO);
            edit.setAutofillHints((String[]) null);
        } else if (hint.isEmpty()) {
            edit.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        } else {
            edit.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_YES);
            edit.setAutofillHints(hint);
        }
    }

    /**
     * Sets the text from JS unless the user typed since JS saw `count`. During
     * a composition the newest value waits for its end (see
     * {@link #syncComposition}), where `count` is checked again.
     */
    void setValue(String text, int count) {
        if (inComposition) {
            pendingText = text;
            pendingCount = count;
            return;
        }
        // A newer value replaces one still waiting for the composition's end.
        pendingText = null;
        if (count != this.count || text.contentEquals(edit.getText())) return;
        applying = true;
        known = text;
        int selection = edit.getSelectionEnd();
        edit.setText(text);
        edit.setSelection(Math.min(Math.max(selection, 0), text.length()));
        applying = false;
    }

    void setContent(int left, int top, int right, int bottom) {
        // Padding of the container: the EditText fills the content box.
        setPadding(left, top, right, bottom);
    }

    void focus() {
        edit.requestFocus();
        InputMethodManager imm = (InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
        imm.showSoftInput(edit, InputMethodManager.SHOW_IMPLICIT);
    }

    void cancelAutoFocus() {
        removeCallbacks(autoFocus);
    }

    void blur() {
        if (!edit.hasFocus()) return;
        hideKeyboard();
        // To the (focusable) root: clearFocus() would hand focus to the first
        // focusable view, often another field.
        mounter.host.requestFocus();
    }

    private void hideKeyboard() {
        InputMethodManager imm = (InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
        imm.hideSoftInputFromWindow(edit.getWindowToken(), 0);
    }

    @Override
    public int nodeId() {
        return id;
    }
}
