Taking this one. The lexer half is confirmed on cb05dc2d and a fix is up on my branch:

https://github.com/ggbdpq/magpie/tree/hunt38-c-sess-libmcp-winpath

(words() in `internal/gui/assets/plugins/library/client.js`: a backslash takes only the next blank or quote with it, since the line is split into argv for exec, not a shell's words. A Playwright test drives the real editor and asserts what the save POST carries: the reporter's line byte for byte, a double-quoted path with a blank, a UNC path, and `my\ server` still meaning one word with a space. Red on cb05dc2d — it saves `C:Usersxxx...npx.cmd` exactly as reported — green after, chromium and webkit.)

Details to follow in a full comment; a note on the reporter's quoted-path repro will be part of it.
