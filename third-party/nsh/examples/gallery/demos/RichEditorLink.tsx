// The Rich Editor demo's links: the bubble menu that shows next to a link
// under the caret (its address, edit, open, remove) and the field that
// sets a link's address, from the toolbar's Link button or Mod-K.
import { openUrl, Text, View, signal } from "nsh";
import { Input, chain, command, extendMarkRange, insertContent, type RichEditorSession } from "nsh/base";
import { colors } from "../ui";
import { IconButton } from "./RichEditorUi";

const field =
  "h-8 min-w-[220px] flex-1 rounded-md border border-border bg-card px-2 text-[13px] text-foreground placeholder:text-muted-foreground focus:border-ring";

/** What the link menu shows: nothing, a link's actions, or the address field. */
export type LinkMode = "closed" | "link" | "edit";

/** The link menu's state, shared by the toolbar's button and the bubble menu. */
export function createLinkMenu(editor: RichEditorSession, revision: () => number) {
  const editing = signal(false);
  const draft = signal("");
  const href = () => {
    void revision();
    const value = (editor.getAttributes("link") as { href?: unknown }).href;
    return typeof value === "string" ? value : "";
  };
  const inLink = () => {
    void revision();
    return editor.isActive("link");
  };
  // While the caret is in a link, whether or not the editor has the
  // focus: pressing the menu's buttons takes it.
  const mode = (): LinkMode => (editing() ? "edit" : inLink() ? "link" : "closed");

  /** Opens the address field on the link under the caret, or for the selection. */
  const edit = () => {
    draft.set(href());
    editing.set(true);
  };
  const close = () => {
    editing.set(false);
    editor.focus();
  };
  /** Sets the address: the whole link under the caret, the selection, or new linked text at the caret. */
  const apply = () => {
    const url = draft().trim();
    if (!url) {
      editor.run(chain([extendMarkRange("link"), command("unsetLink")]));
    } else if (inLink() || !editor.selection.empty) {
      editor.run(chain([extendMarkRange("link"), command("setLink", { href: url })]));
    } else {
      editor.run(insertContent({ type: "text", text: url, marks: [{ type: "link", attrs: { href: url } }] }));
    }
    close();
  };
  const remove = () => {
    editor.run(chain([extendMarkRange("link"), command("unsetLink")]));
    editor.focus();
  };
  return { mode, href, draft, edit, close, apply, remove };
}

export type LinkMenu = ReturnType<typeof createLinkMenu>;

/** The bubble menu's content: a link's address and actions, or the address field. */
export function LinkBubble(props: { menu: LinkMenu }) {
  const menu = props.menu;
  return (
    <View testID="link-menu" class="flex-row items-center gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-lg">
      <If
        when={menu.mode() === "edit"}
        else={
          <>
            <Text style={{ numberOfLines: 1, maxWidth: 260, paddingHorizontal: 8, fontSize: 13, color: colors.info }}>
              {menu.href()}
            </Text>
            <IconButton icon="pencil" label="Edit link" onPress={menu.edit} />
            <IconButton icon="external-link" label="Open link" onPress={() => void openUrl(menu.href())} />
            <IconButton icon="unlink" label="Remove link" onPress={menu.remove} />
          </>
        }
      >
        <Input
          ref={(node: { focus(): void }) => node.focus()}
          value={menu.draft()}
          onChange={(value) => menu.draft.set(value)}
          onSubmit={menu.apply}
          submitBehavior="submit"
          placeholder="https://"
          accessibilityLabel="Link address"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          class={field}
        />
        <IconButton icon="check" label="Apply link" onPress={menu.apply} />
        <IconButton icon="x" label="Cancel" onPress={menu.close} />
      </If>
    </View>
  );
}
