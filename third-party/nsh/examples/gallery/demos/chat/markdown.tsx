import { type JSX, signal } from "nsh";
import { TextView, type TextViewImage } from "nsh/base";
import { colors } from "../../ui";
import { ImageViewer } from "../ImageViewer";

/**
 * A reply's Markdown, shown by `TextView` at a chat's scale (its default
 * typography otherwise, in the theme's colors).
 *
 * While a reply streams (`streaming`), syntax its end leaves open shows as
 * if closed and only the block being written renders again; `caret` is
 * drawn at the end of the last block, inline with its text.
 *
 * Every block (and each list item and table cell) is one selectable text:
 * a long press highlights it and offers Copy. Code blocks carry
 * `TextView`'s built-in copy action. A press on an image opens it in an
 * `ImageViewer` (mounted on the first press, kept for its fade out).
 */
export function Markdown(props: {
  md: string;
  id: string;
  streaming?: boolean;
  caret?: JSX.Element;
}) {
  const viewing = signal<TextViewImage | null>(null);
  const used = signal(false);
  return (
    <>
      <TextView
        markdown={props.md}
        options={{ streaming: !!props.streaming }}
        selectable
        contentStyle={{ rowGap: 12 }}
        codeBlockScrollbar={false}
        streamingCaret={props.caret}
        styles={{
          // A chat's scale: tighter than a document's.
          root: { fontSize: 15, lineHeight: 22, color: colors.text },
          heading1: { fontSize: 20, lineHeight: 26 },
          heading2: { fontSize: 17, lineHeight: 22 },
          heading3: { fontSize: 15, lineHeight: 22 },
          code: { color: colors.code },
          codeBlockCode: { color: colors.code },
          link: { color: colors.accent },
        }}
        codeBlockActions={[{ id: "copy", label: "Copy code" }]}
        onImagePress={({ image }) => {
          used.set(true);
          viewing.set(image);
        }}
      />
      {used() ? <ImageViewer image={viewing()} onClose={() => viewing.set(null)} /> : null}
    </>
  );
}


