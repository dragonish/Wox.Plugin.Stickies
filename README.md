# Stickies

Create, list, search and roll up [Stickies](https://www.zhornsoftware.co.uk/stickies/index.html) notes from Wox.

## Install

```shell
wpm install Stickies
```

## Usage

Type the trigger keyword (`sti` by default), then a command:

Typing just the trigger keyword lists every command. Enter fills `new` / `search` with a trailing space and jumps to `list` / `ping`, while `paste`, `hideall`, `showall` and `front` run immediately.

| Command                                    | Action                                         |
| ------------------------------------------ | ---------------------------------------------- |
| `sti new <text>`                           | Create a desktop note with the text            |
| `sti new`                                  | Create a blank note, or type text after `new`  |
| `sti list` / `sti ls`                      | List desktop notes                             |
| `sti list <keyword>` / `sti ls <keyword>`  | Search notes, same as `search`                 |
| `sti search <keyword>` / `sti s <keyword>` | Search note titles and bodies                  |
| `sti paste`                                | Create a note from the clipboard as plain text |
| `sti hideall` / `sti showall`              | Hide or show all desktop notes                 |
| `sti front` / `sti bring`                  | Bring all visible notes to the front           |
| `sti stacks` / `sti stack`                 | List stacks, or filter them by title           |
| `sti ping`                                 | Check that Stickies is running                 |

`sti front` raises every visible note above other windows, the same as clicking the Stickies tray icon; hidden notes stay hidden. Use `sti showall` first if you also want hidden notes back.

`sti stacks` lists every stack with its id, screen position and size. Enter toggles the stack: collapsed notes are spread onto the desktop, and spread notes are collapsed back into the stack. Each row also has explicit **Collapse notes into the stack** and **Spread notes onto the desktop** actions, and a keyword after `stacks` filters the list by stack title. The Stickies API cannot create, rename or delete stacks, and it does not expose which notes belong to a stack or whether it is currently collapsed.

Search splits the keywords on spaces and requires every keyword to appear in the note title or body, so `sti list milk todo` finds notes containing both words. Matching is case-insensitive.

Image notes have no text body, so they get an **image** tag in the list and an `(image note, no text)` preview instead of looking empty. They can be filtered with the localized image words, for example `sti list image` or `sti list 图片`. A note that mixes text and an embedded image is still listed with its text; only pure image notes are detected through the API.

Bare text such as `sti buy milk` is no longer created implicitly; the plugin offers to complete it as `sti new buy milk`.

For a note that is visible on the desktop and not rolled up, Enter now runs **Focus**: the note is brought to the front and receives keyboard focus. Hidden notes default to **Show** and rolled notes to **Unroll**, so Enter always moves a note one step towards open: hidden → shown → unrolled → focused. Image notes offer **Copy image** instead of **Copy text**; it replaces the clipboard with the note bitmap.

Each note also offers **Keep on top** / **Stop keeping on top**, which toggles the Stickies always-on-top flag. Notes that are kept on top show an `on top` tag in the list.

**Enable click-through** / **Disable click-through** toggles Stickies ghost mode: the note stays visible but lets mouse clicks pass through to whatever is underneath. Such notes are tagged `click-through` and can still be activated from Wox with Focus, which is the easy way to turn the mode back off.

## Settings

| Setting            | Values                                                               | Default                 |
| ------------------ | -------------------------------------------------------------------- | ----------------------- |
| Title of new notes | Follow Stickies setting · Blank · Creation time · First line of text | Follow Stickies setting |

`Follow Stickies setting` does not touch the title, so Stickies applies its own title option (blank, creation time, or set when created). The other values apply to notes created by both `new` and `paste`.
