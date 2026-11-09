package com.longbridge.nsh;

import android.content.ClipData;
import android.view.ContentInfo;
import android.widget.EditText;

/**
 * Pastes and keyboards' content for Android 12+ (only loaded there, so that
 * {@code InputBox} verifies without these types on older versions).
 */
final class InputContent {
    private InputContent() {}

    static void install(EditText edit, InputBox box) {
        // Pastes and keyboards' images (GIFs, stickers) come here; the types
        // tell keyboards that images are welcome.
        edit.setOnReceiveContentListener(new String[] {"image/*"}, (view, payload) -> receive(box, payload));
    }

    /**
     * A paste or a keyboard's content: reported (`onPaste`), and its text left
     * to the EditText while `pasteBehavior` inserts it. Images and files are
     * never inserted.
     */
    private static ContentInfo receive(InputBox box, ContentInfo payload) {
        int source = payload.getSource();
        if (source != ContentInfo.SOURCE_CLIPBOARD && source != ContentInfo.SOURCE_INPUT_METHOD) return payload;
        // Without a listener a paste that inserts is the EditText's own.
        if (!box.pasted(payload.getClip()) && box.pasteInserts) return payload;
        if (!box.pasteInserts) return null;
        // The text goes on to the EditText; what else there was is consumed.
        ClipData clip = payload.getClip();
        ClipData text = null;
        for (int i = 0; i < clip.getItemCount(); i++) {
            ClipData.Item item = clip.getItemAt(i);
            if (item.getUri() != null) continue;
            if (text == null) text = new ClipData(clip.getDescription(), item);
            else text.addItem(item);
        }
        return text == null ? null : new ContentInfo.Builder(payload).setClip(text).build();
    }
}
