# Stickies

Create, list, search and roll up [Stickies](https://www.zhornsoftware.co.uk/stickies/index.html) notes from Wox.

## Install

```shell
wpm install Stickies
```

## Usage

Type the trigger keyword (`sti` by default), then a command:

| Command                                    | Action                                         |
| ------------------------------------------ | ---------------------------------------------- |
| `sti new <text>`                           | Create a desktop note with the text            |
| `sti new`                                  | Create a blank note, or type text after `new`  |
| `sti list` / `sti ls`                      | List desktop notes                             |
| `sti list <keyword>` / `sti ls <keyword>`  | Search notes, same as `search`                 |
| `sti search <keyword>` / `sti s <keyword>` | Search note titles and bodies                  |
| `sti paste`                                | Create a note from the clipboard as plain text |
| `sti hideall` / `sti showall`              | Hide or show all desktop notes                 |
| `sti ping`                                 | Check that Stickies is running                 |

Search splits the keywords on spaces and requires every keyword to appear in the note title or body, so `sti list milk todo` finds notes containing both words. Matching is case-insensitive.

Image notes have no text body, so they get an **image** tag in the list and an `(image note, no text)` preview instead of looking empty. They can be filtered with the localized image words, for example `sti list image` or `sti list 图片`. A note that mixes text and an embedded image is still listed with its text; only pure image notes are detected through the API.

Bare text such as `sti buy milk` is no longer created implicitly; the plugin offers to complete it as `sti new buy milk`.

For a note that is visible on the desktop and not rolled up, Enter now runs **Focus**: the note is brought to the front and receives keyboard focus. Hidden notes default to **Show** and rolled notes to **Unroll**, so Enter always moves a note one step towards open: hidden → shown → unrolled → focused. Image notes offer **Copy image** instead of **Copy text**; it replaces the clipboard with the note bitmap.

## Settings

| Setting            | Values                                                               | Default                 |
| ------------------ | -------------------------------------------------------------------- | ----------------------- |
| Title of new notes | Follow Stickies setting · Blank · Creation time · First line of text | Follow Stickies setting |

`Follow Stickies setting` does not touch the title, so Stickies applies its own title option (blank, creation time, or set when created). The other values apply to notes created by both `new` and `paste`.
