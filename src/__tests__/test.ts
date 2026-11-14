import * as fs from "node:fs"
import * as path from "node:path"
import { ActionContext, Context, PublicAPI, Query, Result, WoxImage } from "@wox-launcher/wox-plugin"
import { noteListMode, notePreviewTags, parseQuery, plugin } from "../index"
import { COMMANDS } from "../commands"
import {
  buildGhostCommand,
  buildOnTopCommand,
  buildStackStateCommand,
  buildTitleCommands,
  canFocusNote,
  colorHex,
  colorNameKey,
  contentTitle,
  decodeUnicode,
  encodeUnicode,
  formatCreatedTitle,
  formatModified,
  matchNotes,
  matchStacks,
  normalizeBridgeOutput,
  normalizeTitleMode,
  noteDefaultAction,
  parseColor,
  parseCreatedId,
  parseIdList,
  parseModified,
  parseNoteReplies,
  parsePosition,
  parseReply,
  parseSize,
  parseStackId,
  parseStackReplies,
  parseTransparency,
  stackStateFromReply,
  StickyNote,
  summarizeStack
} from "../stickies"

const DEFAULT_TRIGGER = "sti"
/** Locale-neutral sample text for routing tests. Non-ASCII coverage lives in its own describe. */
const SAMPLE_TEXT = "buy milk"

const pluginJsonPath = path.join(__dirname, "..", "..", "plugin.json")
const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"))
const enTranslations = pluginJson.I18n.en_US as Record<string, string>

let effectiveTriggers = [DEFAULT_TRIGGER]
let titleModeSetting = "stickies"
const changeQuery = jest.fn()

/** Mirror index.ts's %s substitution for translation assertions. */
function formatTranslation(raw: string, ...args: string[]): string {
  let index = 0
  return raw.replace(/%s/g, () => (index < args.length ? args[index++] : "%s"))
}

/** query() returns Result[] (legacy) or { Results: Result[] }; normalize both. */
async function queryResults(ctx: Context, search: string, triggerKeyword = DEFAULT_TRIGGER, command = ""): Promise<Result[]> {
  const out = await plugin.query(ctx, makeQuery(search, triggerKeyword, command))
  return Array.isArray(out) ? out : out.Results
}

function makeQuery(search: string, triggerKeyword = DEFAULT_TRIGGER, command = ""): Query {
  return {
    Id: "1",
    Env: { ActiveWindowTitle: "", ActiveWindowPid: 0, ActiveBrowserUrl: "", ActiveWindowIcon: {} as WoxImage },
    RawQuery: triggerKeyword ? triggerKeyword + " " + search : search,
    Selection: { Type: "text", Text: "", FilePaths: [] },
    Type: "input",
    Search: search,
    TriggerKeyword: triggerKeyword,
    Command: command,
    IsGlobalQuery(): boolean {
      return false
    }
  } as Query
}

// The fake serves en_US only: routing tests assert English strings, while the
// metadata i18n tests below keep zh_CN keys in sync.
const fakeApi = {
  Log: () => Promise.resolve(),
  GetTranslation: (_ctx: Context, key: string) => Promise.resolve(enTranslations[key] ?? ""),
  GetTriggerKeywords: () => Promise.resolve({ TriggerKeywords: effectiveTriggers }),
  GetSetting: (_ctx: Context, key: string) => Promise.resolve(key === "new_note_title" ? titleModeSetting : ""),
  ShowToastMsg: () => Promise.resolve({ Success: true, ErrMsg: "" }),
  Copy: () => Promise.resolve(),
  ChangeQuery: changeQuery
} as unknown as PublicAPI

describe("unicode hex codec (Stickies utext/utitle)", () => {
  test("round-trips ASCII, Chinese and emoji", () => {
    const samples = ["hello", "你好世界", "待办：买牛奶 #todo", "emoji 😀 test", "a\nb\tc"]
    for (const text of samples) {
      expect(decodeUnicode(encodeUnicode(text))).toBe(text)
    }
  })

  test("encodes per UTF-16 code unit, 4 hex chars each", () => {
    expect(encodeUnicode("A")).toBe("0041")
    expect(encodeUnicode("你")).toBe("4f60")
    expect(encodeUnicode("Stickies")).toBe("0053007400690063006b006900650073")
  })

  test("decode returns non-hex input untouched", () => {
    expect(decodeUnicode("plain title")).toBe("plain title")
  })
})

describe("new note title modes", () => {
  const fixed = new Date(2026, 10, 14, 15, 43, 0)

  test("normalizeTitleMode accepts only known values", () => {
    expect(normalizeTitleMode("stickies")).toBe("stickies")
    expect(normalizeTitleMode("blank")).toBe("blank")
    expect(normalizeTitleMode("created")).toBe("created")
    expect(normalizeTitleMode("content")).toBe("content")
    expect(normalizeTitleMode("")).toBe("stickies")
    expect(normalizeTitleMode("unknown")).toBe("stickies")
    expect(normalizeTitleMode(undefined)).toBe("stickies")
  })

  test("formatCreatedTitle matches Stickies' creation-time format", () => {
    expect(formatCreatedTitle(fixed)).toBe("2026-11-14 15:43")
    expect(formatCreatedTitle(new Date(2026, 0, 2, 3, 4, 0))).toBe("2026-01-02 03:04")
  })

  test("contentTitle uses the trimmed first line and caps at 80 chars", () => {
    expect(contentTitle("  buy milk  \nsecond line")).toBe("buy milk")
    expect(contentTitle("   ")).toBe("")
    expect(contentTitle("a".repeat(100))).toHaveLength(80)
  })

  test("stickies mode leaves the title untouched", () => {
    expect(buildTitleCommands("abc", "stickies", "buy milk", fixed)).toEqual([])
  })

  test("blank mode clears the title with a trailing space", () => {
    expect(buildTitleCommands("abc", "blank", "buy milk", fixed)).toEqual(["api set desktop abc title "])
  })

  test("created mode writes the encoded creation time", () => {
    expect(buildTitleCommands("abc", "created", "ignored", fixed)).toEqual(["api set desktop abc utitle " + encodeUnicode("2026-11-14 15:43")])
  })

  test("content mode writes the first line or clears when empty", () => {
    expect(buildTitleCommands("abc", "content", "  buy milk  \nmore", fixed)).toEqual(["api set desktop abc utitle " + encodeUnicode("buy milk")])
    expect(buildTitleCommands("abc", "content", "   ", fixed)).toEqual(["api set desktop abc title "])
  })
})

describe("note focus eligibility", () => {
  const note = {
    id: "abc",
    title: "t",
    text: "body",
    image: false,
    rolled: false,
    hidden: false,
    ontop: false,
    ghost: false,
    position: null,
    size: null,
    color: null,
    transparency: null,
    modified: null,
    stackId: null
  }

  test("offers focus only for visible, unrolled desktop notes", () => {
    expect(canFocusNote(note)).toBe(true)
    expect(canFocusNote({ ...note, rolled: true })).toBe(false)
    expect(canFocusNote({ ...note, hidden: true })).toBe(false)
    expect(canFocusNote({ ...note, rolled: true, hidden: true })).toBe(false)
  })
})

describe("note default action", () => {
  const note = {
    id: "abc",
    title: "t",
    text: "body",
    image: false,
    rolled: false,
    hidden: false,
    ontop: false,
    ghost: false,
    position: null,
    size: null,
    color: null,
    transparency: null,
    modified: null,
    stackId: null
  }

  test("reveals a hidden note before anything else", () => {
    expect(noteDefaultAction({ ...note, hidden: true })).toBe("show")
    expect(noteDefaultAction({ ...note, hidden: true, rolled: true })).toBe("show")
  })

  test("unrolls a visible rolled note, otherwise focuses", () => {
    expect(noteDefaultAction({ ...note, rolled: true })).toBe("unroll")
    expect(noteDefaultAction(note)).toBe("focus")
  })
})

describe("note keyword matching", () => {
  const notes = [
    {
      id: "n1",
      title: "Groceries",
      text: "buy milk and bread",
      image: false,
      rolled: false,
      hidden: false,
      ontop: false,
      ghost: false,
      position: null,
      size: null,
      color: null,
      transparency: null,
      modified: null,
      stackId: null
    },
    {
      id: "n2",
      title: "",
      text: "牛奶 待办 买面包",
      image: false,
      rolled: false,
      hidden: false,
      ontop: false,
      ghost: false,
      position: null,
      size: null,
      color: null,
      transparency: null,
      modified: null,
      stackId: null
    },
    {
      id: "n3",
      title: "milk",
      text: "already bought",
      image: false,
      rolled: false,
      hidden: false,
      ontop: false,
      ghost: false,
      position: null,
      size: null,
      color: null,
      transparency: null,
      modified: null,
      stackId: null
    },
    {
      id: "n4",
      title: "Price list",
      text: "cost 2.5 (usd)",
      image: false,
      rolled: false,
      hidden: false,
      ontop: false,
      ghost: false,
      position: null,
      size: null,
      color: null,
      transparency: null,
      modified: null,
      stackId: null
    }
  ]
  const ids = (list: Array<{ id: string }>): string[] => list.map(note => note.id)

  test("matches title or body, ignoring case", () => {
    expect(ids(matchNotes(notes, "milk"))).toEqual(["n1", "n3"])
    expect(ids(matchNotes(notes, "MILK"))).toEqual(["n1", "n3"])
    expect(ids(matchNotes(notes, "GROCERIES"))).toEqual(["n1"])
  })

  test("requires every space-separated keyword to match", () => {
    expect(ids(matchNotes(notes, "milk bread"))).toEqual(["n1"])
    expect(ids(matchNotes(notes, "milk tea"))).toEqual([])
  })

  test("allows keywords to match across title and body", () => {
    expect(ids(matchNotes(notes, "groceries bread"))).toEqual(["n1"])
  })

  test("splits Chinese text on the ideographic space", () => {
    expect(ids(matchNotes(notes, "牛奶\u3000待办"))).toEqual(["n2"])
    expect(ids(matchNotes(notes, "牛奶 面包"))).toEqual(["n2"])
  })

  test("treats regex characters as literal text", () => {
    expect(ids(matchNotes(notes, "2.5 (usd)"))).toEqual(["n4"])
    expect(ids(matchNotes(notes, ".*"))).toEqual([])
  })

  test("does not search note ids", () => {
    expect(ids(matchNotes(notes, "n1"))).toEqual([])
  })

  test("matches image notes through localized image terms", () => {
    const withImages = [
      ...notes,
      {
        id: "img",
        title: "",
        text: "",
        image: true,
        rolled: false,
        hidden: false,
        ontop: false,
        ghost: false,
        position: null,
        size: null,
        color: null,
        transparency: null,
        modified: null,
        stackId: null
      }
    ]
    expect(ids(matchNotes(withImages, "图片"))).toEqual([])
    expect(ids(matchNotes(withImages, "图片", ["图片", "image"]))).toEqual(["img"])
    expect(ids(matchNotes(withImages, "IMAGE", ["图片", "image"]))).toEqual(["img"])
    // Image terms do not make text notes match, and text keywords still work.
    expect(ids(matchNotes(withImages, "milk", ["图片", "image"]))).toEqual(["n1", "n3"])
    expect(ids(matchNotes(withImages, "照片", ["图片", "照片"]))).toEqual(["img"])
  })

  test("image note titles and bodies still match normally", () => {
    const imageWithText = {
      id: "img",
      title: "截图",
      text: "image of a chart",
      image: true,
      rolled: false,
      hidden: false,
      ontop: false,
      ghost: false,
      position: null,
      size: null,
      color: null,
      transparency: null,
      modified: null,
      stackId: null
    }
    expect(ids(matchNotes([imageWithText], "截图"))).toEqual(["img"])
    expect(ids(matchNotes([imageWithText], "chart"))).toEqual(["img"])
  })

  test("blank queries return every note", () => {
    expect(ids(matchNotes(notes, ""))).toEqual(["n1", "n2", "n3", "n4"])
    expect(ids(matchNotes(notes, " \u3000 "))).toEqual(["n1", "n2", "n3", "n4"])
  })
})

describe("query parsing and note list mode", () => {
  test("folds a command Wox split out back into the text", () => {
    expect(parseQuery(makeQuery("牛奶", DEFAULT_TRIGGER, "list"))).toEqual({ head: "list", args: "牛奶", text: "list 牛奶" })
  })

  test("parses raw command text without a split command", () => {
    expect(parseQuery(makeQuery("ls milk"))).toEqual({ head: "ls", args: "milk", text: "ls milk" })
    expect(parseQuery(makeQuery("list"))).toEqual({ head: "list", args: "", text: "list" })
  })

  test("list and search both filter only when keywords follow", () => {
    for (const head of ["list", "ls", "search", "s"]) {
      expect(noteListMode(head, "milk")).toBe("search")
      expect(noteListMode(head, "")).toBe("all")
    }
    expect(noteListMode("new", "milk")).toBeNull()
    expect(noteListMode("paste", "milk")).toBeNull()
  })
})

describe("reply parsing", () => {
  test("parses code and text", () => {
    expect(parseReply("000 OK pong")).toEqual({ code: "000", text: "OK pong", raw: "000 OK pong" })
    expect(parseReply("001 abc,def,")).toEqual({ code: "001", text: "abc,def,", raw: "001 abc,def," })
    expect(parseReply("997 sticky is image")).toEqual({ code: "997", text: "sticky is image", raw: "997 sticky is image" })
  })

  test("parses created ids and desktop id lists", () => {
    expect(parseCreatedId(parseReply("000 OK created: 20EFA3490AF2"))).toBe("20EFA3490AF2")
    expect(parseCreatedId(parseReply("000 OK pong"))).toBeNull()
    expect(parseIdList(parseReply("001 id1,id2,"))).toEqual(["id1", "id2"])
    expect(parseIdList(parseReply("001 "))).toEqual([])
    expect(parseIdList(parseReply("000 OK"))).toEqual([])
  })
})

describe("note on-top command", () => {
  test("sets and clears the always-on-top flag", () => {
    expect(buildOnTopCommand("abc", true)).toBe("api set desktop abc ontop 1")
    expect(buildOnTopCommand("abc", false)).toBe("api set desktop abc ontop 0")
  })
})

describe("note click-through command", () => {
  test("sets and clears the ghost flag", () => {
    expect(buildGhostCommand("abc", true)).toBe("api set desktop abc ghost 1")
    expect(buildGhostCommand("abc", false)).toBe("api set desktop abc ghost 0")
  })
})

describe("batched note reply parsing", () => {
  const reply = (code: string, text = "") => ({ code, text, raw: code + (text ? " " + text : "") })
  const group = (
    title: string,
    text: string,
    rolled: string,
    hidden: string,
    type: string,
    ontop = "0",
    ghost = "0",
    position = "",
    size = "",
    color = "",
    transparency = "",
    modified = "",
    stack = ""
  ) => [
    reply("001", title),
    reply("001", text),
    reply("001", rolled),
    reply("001", hidden),
    reply("001", type),
    reply("001", ontop),
    reply("001", ghost),
    reply("001", position),
    reply("001", size),
    reply("001", color),
    reply("001", transparency),
    reply("001", modified),
    reply("001", stack)
  ]

  test("reads title, text, flags, geometry, colour, transparency, modified and stack for every id", () => {
    const replies = [
      ...group(encodeUnicode("Title A"), encodeUnicode("Body A"), "0", "1", "0", "1", "0", "3294,552", "406x100", "230,230,230", "90", "1761640452 2025 10 28 16 34 12 3", "6"),
      ...group("", "", "1", "0", "1", "0", "1", "-10,20", "200x50", "255,204,204", "100", "1700000000 2023 11 14 9 5 3 2", "-1")
    ]
    const notes = parseNoteReplies(["a", "b"], replies)

    expect(notes).toEqual([
      {
        id: "a",
        title: "Title A",
        text: "Body A",
        image: false,
        rolled: false,
        hidden: true,
        ontop: true,
        ghost: false,
        position: { x: 3294, y: 552 },
        size: { width: 406, height: 100 },
        color: { r: 230, g: 230, b: 230 },
        transparency: 90,
        modified: { epoch: 1761640452, year: 2025, month: 10, day: 28, hours: 16, minutes: 34, seconds: 12 },
        stackId: "6"
      },
      {
        id: "b",
        title: "",
        text: "",
        image: true,
        rolled: true,
        hidden: false,
        ontop: false,
        ghost: true,
        position: { x: -10, y: 20 },
        size: { width: 200, height: 50 },
        color: { r: 255, g: 204, b: 204 },
        transparency: 100,
        modified: { epoch: 1700000000, year: 2023, month: 11, day: 14, hours: 9, minutes: 5, seconds: 3 },
        stackId: null
      }
    ])
  })

  test("treats a missing or failed ontop reply as not on top", () => {
    const missing = parseNoteReplies(["a"], group("", "", "0", "0", "0").slice(0, 5))
    expect(missing[0].ontop).toBe(false)

    const failed = parseNoteReplies(["a"], [...group("", "", "0", "0", "0").slice(0, 5), reply("998", "sticky not found")])
    expect(failed[0].ontop).toBe(false)
  })

  test("treats a missing or failed ghost reply as not click-through", () => {
    const missing = parseNoteReplies(["a"], group("", "", "0", "0", "0").slice(0, 6))
    expect(missing[0].ghost).toBe(false)

    const failed = parseNoteReplies(["a"], [...group("", "", "0", "0", "0").slice(0, 6), reply("998", "sticky not found")])
    expect(failed[0].ghost).toBe(false)
  })

  test("keeps geometry and attributes missing instead of failing the whole note", () => {
    const missing = parseNoteReplies(["a"], group("", "", "0", "0", "0"))
    expect(missing[0].position).toBeNull()
    expect(missing[0].size).toBeNull()
    expect(missing[0].color).toBeNull()
    expect(missing[0].transparency).toBeNull()
    expect(missing[0].modified).toBeNull()

    const failed = parseNoteReplies(["a"], [...group("", "", "0", "0", "0").slice(0, 7), reply("998", "sticky not found"), reply("998", "sticky not found"), reply("997", "no data")])
    expect(failed[0].position).toBeNull()
    expect(failed[0].size).toBeNull()
    expect(failed[0].color).toBeNull()
    expect(failed[0].transparency).toBeNull()
    expect(failed[0].modified).toBeNull()
    expect(failed[0].stackId).toBeNull()
  })

  test("falls back to the first body line when the title is empty", () => {
    const notes = parseNoteReplies(["a"], group("", encodeUnicode("first line\nsecond"), "0", "0", "0"))
    expect(notes[0].title).toBe("first line")
  })

  test("treats a missing or non-001 type reply as a text note", () => {
    const missing = parseNoteReplies(["a"], group("", "", "0", "0", "").slice(0, 4))
    expect(missing[0].image).toBe(false)

    const failed = parseNoteReplies(["a"], group("", "", "0", "0", "998 sticky not found"))
    expect(failed[0].image).toBe(false)
  })

  test("skips ids whose title or text reply is missing", () => {
    const notes = parseNoteReplies(["a", "b"], group("", "", "0", "0", "0"))
    expect(notes.map(note => note.id)).toEqual(["a"])
    expect(parseNoteReplies([], [])).toEqual([])
  })
})

describe("note attribute parsing", () => {
  test("parses comma-separated colours and rejects out-of-range values", () => {
    expect(parseColor("230,230,230")).toEqual({ r: 230, g: 230, b: 230 })
    expect(parseColor(" 0 , 10 , 255 ")).toEqual({ r: 0, g: 10, b: 255 })
    expect(parseColor("")).toBeNull()
    expect(parseColor("230,230")).toBeNull()
    expect(parseColor("256,0,0")).toBeNull()
    expect(parseColor("red,green,blue")).toBeNull()
  })

  test("parses the transparency percentage", () => {
    expect(parseTransparency("90")).toBe(90)
    expect(parseTransparency("0")).toBe(0)
    expect(parseTransparency("100")).toBe(100)
    expect(parseTransparency("101")).toBeNull()
    expect(parseTransparency("")).toBeNull()
    expect(parseTransparency("90%")).toBeNull()
  })

  test("parses the modified time fields and ignores the trailing weekday", () => {
    expect(parseModified("1761640452 2025 10 28 16 34 12 3")).toEqual({
      epoch: 1761640452,
      year: 2025,
      month: 10,
      day: 28,
      hours: 16,
      minutes: 34,
      seconds: 12
    })
    expect(parseModified("997 no data")).toBeNull()
    expect(parseModified("1761640452 2025 10 28")).toBeNull()
    expect(parseModified("")).toBeNull()
  })

  test("formats the modified time with zero padding", () => {
    expect(formatModified({ epoch: 0, year: 2025, month: 1, day: 5, hours: 9, minutes: 7, seconds: 0 })).toBe("2025-01-05 09:07")
  })

  test("formats colours as uppercase hex", () => {
    expect(colorHex({ r: 230, g: 230, b: 230 })).toBe("#E6E6E6")
    expect(colorHex({ r: 0, g: 10, b: 255 })).toBe("#000AFF")
  })

  test("names only exact palette matches", () => {
    expect(colorNameKey({ r: 230, g: 230, b: 230 })).toBe("grey")
    expect(colorNameKey({ r: 255, g: 204, b: 204 })).toBe("pink")
    expect(colorNameKey({ r: 229, g: 230, b: 230 })).toBeNull()
    expect(colorNameKey({ r: 1, g: 2, b: 3 })).toBeNull()
  })

  test("parses the undocumented stack id, treating -1 as no stack", () => {
    expect(parseStackId("6")).toBe("6")
    expect(parseStackId(" 12 ")).toBe("12")
    expect(parseStackId("-1")).toBeNull()
    expect(parseStackId("0")).toBeNull()
    expect(parseStackId("")).toBeNull()
    expect(parseStackId("999 Not understood")).toBeNull()
  })
})

describe("stack summary", () => {
  const note = (overrides: Partial<StickyNote>): StickyNote => ({
    id: "n",
    title: "",
    text: "",
    image: false,
    rolled: false,
    hidden: false,
    ontop: false,
    ghost: false,
    position: null,
    size: null,
    color: null,
    transparency: null,
    modified: null,
    stackId: null,
    ...overrides
  })

  test("counts members and reports their shared colour", () => {
    const notes = [
      note({ id: "a", stackId: "6", color: { r: 230, g: 230, b: 230 } }),
      note({ id: "b", stackId: "6", color: { r: 230, g: 230, b: 230 } }),
      note({ id: "c", stackId: "9", color: { r: 255, g: 204, b: 204 } }),
      note({ id: "d" })
    ]
    expect(summarizeStack("6", notes)).toEqual({ noteCount: 2, color: { r: 230, g: 230, b: 230 }, colorCount: 1, modified: null })
  })

  test("drops the shared colour when members differ", () => {
    const notes = [
      note({ id: "a", stackId: "6", color: { r: 230, g: 230, b: 230 } }),
      note({ id: "b", stackId: "6", color: { r: 255, g: 204, b: 204 } }),
      note({ id: "c", stackId: "6", color: { r: 230, g: 230, b: 230 } })
    ]
    expect(summarizeStack("6", notes)).toEqual({ noteCount: 3, color: null, colorCount: 2, modified: null })
  })

  test("ignores notes without a colour when counting colours", () => {
    const notes = [note({ id: "a", stackId: "6", color: { r: 230, g: 230, b: 230 } }), note({ id: "b", stackId: "6" })]
    expect(summarizeStack("6", notes)).toEqual({ noteCount: 2, color: { r: 230, g: 230, b: 230 }, colorCount: 1, modified: null })
  })

  test("takes the latest modification among members", () => {
    const early = { epoch: 1700000000, year: 2023, month: 11, day: 14, hours: 9, minutes: 5, seconds: 3 }
    const late = { epoch: 1761640452, year: 2025, month: 10, day: 28, hours: 16, minutes: 34, seconds: 12 }
    const notes = [note({ id: "a", stackId: "6", modified: late }), note({ id: "b", stackId: "6", modified: early }), note({ id: "c", stackId: "9", modified: late }), note({ id: "d", stackId: "6" })]
    expect(summarizeStack("6", notes).modified).toEqual(late)
  })

  test("returns an empty summary when the stack has no members", () => {
    expect(summarizeStack("6", [note({ id: "a" }), note({ id: "b", stackId: "9" })])).toEqual({ noteCount: 0, color: null, colorCount: 0, modified: null })
  })
})

describe("note preview tags", () => {
  const note = {
    id: "abc",
    title: "t",
    text: "body",
    image: false,
    rolled: false,
    hidden: false,
    ontop: false,
    ghost: false,
    position: { x: 3294, y: 552 },
    size: { width: 406, height: 100 },
    color: { r: 230, g: 230, b: 230 },
    transparency: 90,
    modified: { epoch: 1761640452, year: 2025, month: 10, day: 28, hours: 16, minutes: 34, seconds: 12 },
    stackId: null
  }
  const labels = {
    tagPosition: "Position",
    tagSize: "Size",
    tagModified: "Modified",
    tagColor: "Color",
    tagTransparency: "Transparency",
    colorNames: {
      grey: "Grey",
      white: "White",
      yellow: "Yellow",
      green: "Green",
      blue: "Blue",
      pink: "Pink",
      purple: "Purple",
      orange: "Orange"
    }
  }

  test("shows every attribute as a chip with a localized tooltip", () => {
    expect(notePreviewTags(note, labels)).toEqual([
      { Label: "3294,552", Tooltip: "Position" },
      { Label: "406x100", Tooltip: "Size" },
      { Label: "2025-10-28 16:34", Tooltip: "Modified" },
      { Label: "Grey #E6E6E6", Tooltip: "Color" },
      { Label: "90%", Tooltip: "Transparency" }
    ])
  })

  test("renders negative coordinates and unknown colours verbatim", () => {
    expect(notePreviewTags({ ...note, position: { x: -10, y: 20 }, size: null, color: { r: 1, g: 2, b: 3 } }, labels)).toEqual([
      { Label: "-10,20", Tooltip: "Position" },
      { Label: "2025-10-28 16:34", Tooltip: "Modified" },
      { Label: "#010203", Tooltip: "Color" },
      { Label: "90%", Tooltip: "Transparency" }
    ])
  })

  test("hides the transparency chip when the note is opaque", () => {
    for (const transparency of [0, 100]) {
      const shown = notePreviewTags({ ...note, transparency }, labels).map(tag => tag.Label)
      expect(shown).not.toContain(transparency + "%")
    }
  })

  test("omits missing values instead of showing placeholders", () => {
    expect(notePreviewTags({ ...note, position: null }, labels)[0].Label).toBe("406x100")
    expect(notePreviewTags({ ...note, size: null }, labels)[0].Label).toBe("3294,552")
    expect(notePreviewTags({ ...note, modified: null }, labels).map(tag => tag.Label)).not.toContain("2025-10-28 16:34")
    expect(notePreviewTags({ ...note, color: null }, labels).map(tag => tag.Label)).toEqual(["3294,552", "406x100", "2025-10-28 16:34", "90%"])
    expect(notePreviewTags({ ...note, position: null, size: null, modified: null, color: null, transparency: null }, labels)).toEqual([])
  })
})

describe("note and stack geometry parsing", () => {
  test("parses screen positions, including negative coordinates", () => {
    expect(parsePosition("3294,552")).toEqual({ x: 3294, y: 552 })
    expect(parsePosition(" -100 , 20 ")).toEqual({ x: -100, y: 20 })
    expect(parsePosition("")).toBeNull()
    expect(parsePosition("garbage")).toBeNull()
    expect(parsePosition("10")).toBeNull()
  })

  test("parses sizes written as WxH", () => {
    expect(parseSize("406x100")).toEqual({ width: 406, height: 100 })
    expect(parseSize("406X100")).toEqual({ width: 406, height: 100 })
    expect(parseSize(" 20 x 10 ")).toEqual({ width: 20, height: 10 })
    expect(parseSize("")).toBeNull()
    expect(parseSize("406*100")).toBeNull()
  })
})

describe("stack keyword matching", () => {
  const stacks = [
    { id: "6", title: "歌曲", position: null, size: null },
    { id: "12", title: "Project Alpha", position: null, size: null },
    { id: "13", title: "alpha notes", position: null, size: null }
  ]
  const ids = (list: Array<{ id: string }>): string[] => list.map(stack => stack.id)

  test("matches titles case-insensitively and requires every keyword", () => {
    expect(ids(matchStacks(stacks, "alpha"))).toEqual(["12", "13"])
    expect(ids(matchStacks(stacks, "ALPHA NOTES"))).toEqual(["13"])
    expect(ids(matchStacks(stacks, "alpha beta"))).toEqual([])
    expect(ids(matchStacks(stacks, "歌曲"))).toEqual(["6"])
  })

  test("does not search stack ids", () => {
    expect(ids(matchStacks(stacks, "12"))).toEqual([])
  })

  test("blank queries return every stack", () => {
    expect(ids(matchStacks(stacks, ""))).toEqual(["6", "12", "13"])
    expect(ids(matchStacks(stacks, " \u3000 "))).toEqual(["6", "12", "13"])
  })
})

describe("batched stack reply parsing", () => {
  const reply = (code: string, text = "") => ({ code, text, raw: code + (text ? " " + text : "") })
  const group = (title: string, position: string, size: string) => [reply("001", title), reply("001", position), reply("001", size)]

  test("reads title, position and size for every stack", () => {
    const replies = [...group(encodeUnicode("歌曲"), "3294,552", "406x100"), ...group("", "-10,20", "200x50")]
    expect(parseStackReplies(["6", "7"], replies)).toEqual([
      { id: "6", title: "歌曲", position: { x: 3294, y: 552 }, size: { width: 406, height: 100 } },
      { id: "7", title: "", position: { x: -10, y: 20 }, size: { width: 200, height: 50 } }
    ])
  })

  test("keeps rows with missing or failed metadata and skips missing titles", () => {
    const partial = parseStackReplies(["6"], [reply("001", encodeUnicode("歌曲")), reply("998", "sticky not found"), reply("001", "bad size")])
    expect(partial).toEqual([{ id: "6", title: "歌曲", position: null, size: null }])

    expect(parseStackReplies(["6"], []).length).toBe(0)
  })
})

describe("stack state commands", () => {
  test("builds stacked, unstacked and toggle commands", () => {
    expect(buildStackStateCommand("6", "stacked")).toBe("api do stack 6 stacked")
    expect(buildStackStateCommand("6", "unstacked")).toBe("api do stack 6 unstacked")
    expect(buildStackStateCommand("6", "toggle")).toBe("api do stack 6 togglestacked")
  })

  test("reads the resulting state from the reply without matching 'stacked' in 'unstacked'", () => {
    expect(stackStateFromReply({ code: "000", text: "OK stacked", raw: "000 OK stacked" })).toBe("stacked")
    expect(stackStateFromReply({ code: "000", text: "OK unstacked", raw: "000 OK unstacked" })).toBe("unstacked")
    expect(stackStateFromReply({ code: "000", text: "", raw: "000" })).toBe("stacked")
  })
})

describe("bridge output normalization", () => {
  test("accepts a lone object, an array and the doubly nested legacy shape", () => {
    const one = { code: "000", text: "OK pong", raw: "000 OK pong" }
    expect(normalizeBridgeOutput(one)).toEqual([one])
    expect(normalizeBridgeOutput([one])).toEqual([one])
    expect(normalizeBridgeOutput([[one]])).toEqual([one])
    expect(normalizeBridgeOutput([[one, { code: "001", text: "Stickies v10.2a", raw: "001 Stickies v10.2a" }]])).toHaveLength(2)
  })

  test("re-parses entries that only carry a raw reply", () => {
    expect(normalizeBridgeOutput([{ raw: "001 id1,id2," }])).toEqual([{ code: "001", text: "id1,id2,", raw: "001 id1,id2," }])
    expect(normalizeBridgeOutput([null])[0].code).toBe("ERR")
  })
})

describe("bridge script ships with the plugin", () => {
  test("bridge.ps1 sits next to the sources and targets the Stickies window", () => {
    const bridge = path.join(__dirname, "..", "bridge.ps1")
    expect(fs.existsSync(bridge)).toBe(true)
    const content = fs.readFileSync(bridge, "utf8")
    expect(content).toContain("ZhornSoftwareStickiesMain")
    expect(content).toContain("WM_COPYDATA")
    expect(content).toContain("SendMessageTimeout")
    // A literal FindWindow($null, ...) call from PowerShell passes "" as the
    // class name and therefore never matches; the lookup must live in C#.
    expect(content).not.toMatch(/\[StickiesNative\]::FindWindow\(\$null/)
    expect(content).toContain("FindStickies")
    // Focus is a bridge-local command: resolve the note handle, then activate
    // the note window with Win32 because the Stickies API cannot focus.
    expect(content).toContain("FocusNote")
    expect(content).toContain("SetForegroundWindow")
    expect(content).toContain("SwitchToThisWindow")
    expect(content).toContain("^focus\\s+")
    // SetFocus on the note window makes Stickies select the whole note body;
    // activation alone is enough and preserves the caret.
    expect(content).not.toMatch(/\bSetFocus\(/)
    // Replies are not NUL-terminated, so they must be read with cbData as the
    // bound; a bare PtrToStringAnsi overruns into unrelated memory.
    expect(content).toContain("Encoding.Default.GetString")
    expect(content).not.toMatch(/PtrToStringAnsi\(cds\.lpData\)/)
  })
})

describe("plugin query routing (no Stickies needed)", () => {
  const ctx = {} as Context

  beforeAll(async () => {
    await plugin.init(ctx, { PluginDirectory: "", API: fakeApi })
  })

  beforeEach(() => {
    changeQuery.mockClear()
    effectiveTriggers = [DEFAULT_TRIGGER]
    titleModeSetting = "stickies"
  })

  async function runAction(result: Result, index = 0): Promise<void> {
    const action = result.Actions?.[index]
    if (!action || action.Type === "form") {
      throw new Error("missing execute action " + index)
    }
    await action.Action(ctx, {} as ActionContext)
  }

  function helpRow(results: Result[], name: string): Result {
    const row = results.find(result => result.Id === "help-" + name)
    if (!row) {
      throw new Error("missing help row " + name)
    }
    return row
  }

  test("empty query lists every declared command without touching Stickies", async () => {
    const results = await queryResults(ctx, "")
    expect(results.map(result => result.Id)).toEqual(COMMANDS.map(spec => "help-" + spec.name))
    expect(results).toHaveLength(COMMANDS.length)
    for (const result of results) {
      expect(result.Group).toBe(enTranslations.help_group_title)
    }
  })

  test("command rows show usage, description and aliases", async () => {
    const results = await queryResults(ctx, "")
    for (const spec of COMMANDS) {
      const row = helpRow(results, spec.name)
      expect(row.Title).toBe(enTranslations[spec.usageKey])
      expect(row.SubTitle).toBe(enTranslations[spec.descKey])
    }

    const list = helpRow(results, "list")
    expect(list.Tails).toEqual([{ Type: "text", Text: formatTranslation(enTranslations.command_alias_tail, "ls") }])
    const search = helpRow(results, "search")
    expect(search.Tails).toEqual([{ Type: "text", Text: formatTranslation(enTranslations.command_alias_tail, "s") }])
    const front = helpRow(results, "front")
    expect(front.Tails).toEqual([{ Type: "text", Text: formatTranslation(enTranslations.command_alias_tail, "bring") }])
    const stacks = helpRow(results, "stacks")
    expect(stacks.Tails).toEqual([{ Type: "text", Text: formatTranslation(enTranslations.command_alias_tail, "stack") }])
  })

  test("commands that need input fill the query and keep Wox open", async () => {
    const results = await queryResults(ctx, "")

    const create = helpRow(results, "new")
    expect(create.Actions?.[0].PreventHideAfterAction).toBe(true)
    await runAction(create)
    expect(changeQuery).toHaveBeenCalledWith(ctx, { QueryType: "input", QueryText: DEFAULT_TRIGGER + " new " })

    const search = helpRow(results, "search")
    expect(search.Actions?.[0].PreventHideAfterAction).toBe(true)
    await runAction(search)
    expect(changeQuery).toHaveBeenCalledWith(ctx, { QueryType: "input", QueryText: DEFAULT_TRIGGER + " search " })
  })

  test("list and ping navigate to their own results", async () => {
    const results = await queryResults(ctx, "")

    const list = helpRow(results, "list")
    expect(list.Actions?.[0].PreventHideAfterAction).toBe(true)
    await runAction(list)
    expect(changeQuery).toHaveBeenCalledWith(ctx, { QueryType: "input", QueryText: DEFAULT_TRIGGER + " list" })

    const ping = helpRow(results, "ping")
    expect(ping.Actions?.[0].PreventHideAfterAction).toBe(true)
    await runAction(ping)
    expect(changeQuery).toHaveBeenCalledWith(ctx, { QueryType: "input", QueryText: DEFAULT_TRIGGER + " ping" })
  })

  test("side-effect commands run immediately from the help list", async () => {
    const results = await queryResults(ctx, "")
    const expected: Record<string, string> = {
      paste: "create-paste",
      hideall: "hide-all",
      showall: "show-all",
      front: "bring-forward"
    }
    for (const [name, id] of Object.entries(expected)) {
      const action = helpRow(results, name).Actions?.[0]
      expect(action?.Id).toBe(id)
      expect(action?.IsDefault).toBe(true)
      expect(action?.PreventHideAfterAction).toBeFalsy()
    }
  })

  test("custom trigger keyword flows into navigation", async () => {
    const results = await queryResults(ctx, "", "note")
    expect(helpRow(results, "new").SubTitle).not.toContain('"' + DEFAULT_TRIGGER + '"')

    await runAction(helpRow(results, "list"))
    expect(changeQuery).toHaveBeenCalledWith(ctx, { QueryType: "input", QueryText: "note list" })
  })

  test("falls back to an effective concrete trigger when the query has none", async () => {
    effectiveTriggers = ["note"]
    const results = await queryResults(ctx, "", "")
    await runAction(helpRow(results, "list"))
    expect(changeQuery).toHaveBeenCalledWith(ctx, { QueryType: "input", QueryText: "note list" })
  })

  test("global-only trigger skips navigation but keeps runnable commands", async () => {
    effectiveTriggers = ["*"]
    const results = await queryResults(ctx, "", "")
    for (const name of ["new", "search", "list", "ping"]) {
      expect(helpRow(results, name).Actions).toEqual([])
    }
    for (const name of ["paste", "hideall", "showall", "front"]) {
      expect(helpRow(results, name).Actions).toHaveLength(1)
    }
  })

  test("bare text query no longer creates a note and guides to the new command", async () => {
    const results = await queryResults(ctx, SAMPLE_TEXT)
    expect(results.length).toBe(1)
    expect(results[0].Actions?.[0].Id).toBe("goto-new")
    expect(results[0].Actions?.[0].PreventHideAfterAction).toBe(true)
    expect(results[0].SubTitle).toBe(formatTranslation(enTranslations.create_hint_subtitle, DEFAULT_TRIGGER))

    await runAction(results[0])
    expect(changeQuery).toHaveBeenCalledWith(ctx, { QueryType: "input", QueryText: DEFAULT_TRIGGER + " new " + SAMPLE_TEXT })
  })

  test("new command creates with text when Wox splits the command out", async () => {
    const results = await queryResults(ctx, SAMPLE_TEXT, DEFAULT_TRIGGER, "new")
    expect(results.length).toBe(1)
    expect(results[0].Actions?.[0].Id).toBe("create")
    expect(results[0].Actions?.[0].ContextData?.text).toBe(SAMPLE_TEXT)
  })

  test("new command still works when the command stays in the search text", async () => {
    const results = await queryResults(ctx, "new " + SAMPLE_TEXT)
    expect(results.length).toBe(1)
    expect(results[0].Actions?.[0].Id).toBe("create")
    expect(results[0].Actions?.[0].ContextData?.text).toBe(SAMPLE_TEXT)
  })

  test("new without text offers a blank note action", async () => {
    const results = await queryResults(ctx, "", DEFAULT_TRIGGER, "new")
    expect(results.length).toBe(1)
    expect(results[0].Actions?.[0].Id).toBe("create-empty")
    expect(results[0].Actions?.[0].IsDefault).toBe(true)
  })

  test("new command carries the configured title mode", async () => {
    titleModeSetting = "content"
    const results = await queryResults(ctx, SAMPLE_TEXT, DEFAULT_TRIGGER, "new")
    expect(results[0].Actions?.[0].ContextData?.titleMode).toBe("content")
  })

  test("new without text and paste both carry the title mode", async () => {
    titleModeSetting = "blank"
    const empty = await queryResults(ctx, "", DEFAULT_TRIGGER, "new")
    expect(empty[0].Actions?.[0].ContextData?.titleMode).toBe("blank")
    const paste = await queryResults(ctx, "paste")
    expect(paste[0].Actions?.[0].ContextData?.titleMode).toBe("blank")
  })

  test("unknown title setting falls back to Stickies", async () => {
    titleModeSetting = "unknown"
    const results = await queryResults(ctx, SAMPLE_TEXT, DEFAULT_TRIGGER, "new")
    expect(results[0].Actions?.[0].ContextData?.titleMode).toBe("stickies")
  })

  test("list alias routes to the note list instead of creating", async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", { value: "linux", configurable: true })
    try {
      const results = await queryResults(ctx, "ls")
      expect(results.length).toBe(1)
      expect(results[0].SubTitle).toBe(enTranslations.error_hint_windows_only)
      expect(results[0].Actions?.[0].Id).toBe("copy-error")
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true })
    }
  })

  test("list with keywords behaves like search instead of creating", async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", { value: "linux", configurable: true })
    try {
      const results = await queryResults(ctx, "milk", DEFAULT_TRIGGER, "list")
      expect(results.length).toBe(1)
      expect(results[0].Actions?.[0].Id).toBe("copy-error")
      expect(results[0].SubTitle).toBe(enTranslations.error_hint_windows_only)
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true })
    }
  })

  test("global-only trigger still creates from bare text because it cannot jump", async () => {
    effectiveTriggers = ["*"]
    const results = await queryResults(ctx, SAMPLE_TEXT, "")
    expect(results.length).toBe(1)
    expect(results[0].Actions?.[0].Id).toBe("create")
    expect(results[0].Actions?.[0].ContextData?.text).toBe(SAMPLE_TEXT)
  })

  test("paste query offers the create-from-clipboard action as default", async () => {
    const results = await queryResults(ctx, "paste")
    expect(results.length).toBe(1)
    expect(results[0].Actions?.[0].Id).toBe("create-paste")
    expect(results[0].Actions?.[0].IsDefault).toBe(true)
  })

  test("front query offers the bring-to-front action as default", async () => {
    const results = await queryResults(ctx, "front")
    expect(results.length).toBe(1)
    expect(results[0].Actions?.[0].Id).toBe("bring-forward")
    expect(results[0].Actions?.[0].IsDefault).toBe(true)
  })

  test("bring alias routes to the front command", async () => {
    const results = await queryResults(ctx, "bring")
    expect(results.length).toBe(1)
    expect(results[0].Actions?.[0].Id).toBe("bring-forward")
  })

  test("stacks off Windows returns a readable error result", async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", { value: "linux", configurable: true })
    try {
      const results = await queryResults(ctx, "stacks")
      expect(results.length).toBe(1)
      expect(results[0].SubTitle).toBe(enTranslations.error_hint_windows_only)
      expect(results[0].Actions?.[0].Id).toBe("copy-error")
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true })
    }
  })

  test("ping off Windows returns a readable error result, not a throw", async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", { value: "linux", configurable: true })
    try {
      const results = await queryResults(ctx, "ping")
      expect(results.length).toBe(1)
      expect(results[0].Title).toContain("Windows")
      expect(results[0].SubTitle).toBe(enTranslations.error_hint_windows_only)
      expect(results[0].Actions?.[0].Name).toBe(enTranslations.action_copy_error)
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true })
    }
  })
})

describe("non-ASCII note text through command routing", () => {
  const ctx = {} as Context

  beforeAll(async () => {
    await plugin.init(ctx, { PluginDirectory: "", API: fakeApi })
  })

  test("keeps Chinese text when Wox splits the new command out", async () => {
    const results = await queryResults(ctx, "买牛奶", DEFAULT_TRIGGER, "new")
    expect(results.length).toBe(1)
    expect(results[0].Actions?.[0].Id).toBe("create")
    expect(results[0].Actions?.[0].ContextData?.text).toBe("买牛奶")
  })

  test("keeps Chinese text when the command stays in the search text", async () => {
    const text = "待办：买牛奶 #todo"
    const results = await queryResults(ctx, "new " + text)
    expect(results.length).toBe(1)
    expect(results[0].Actions?.[0].ContextData?.text).toBe(text)
  })
})

describe("plugin metadata i18n", () => {
  const zhTranslations = pluginJson.I18n.zh_CN as Record<string, string>

  test("does not hardcode the default trigger keyword", () => {
    for (const locale of Object.values(pluginJson.I18n) as Record<string, string>[]) {
      for (const [key, value] of Object.entries(locale)) {
        expect(key + ": " + value).not.toMatch(/\bsti\b/i)
      }
    }
  })

  test("en_US and zh_CN expose the same keys", () => {
    expect(Object.keys(zhTranslations).sort()).toEqual(Object.keys(enTranslations).sort())
  })

  test("declares every command in plugin.json with translated descriptions", () => {
    const commands = pluginJson.Commands as Array<{ Command: string; Description: string; Aliases?: string[] }>
    expect(commands.map(command => command.Command)).toEqual(["new", "list", "search", "paste", "hideall", "showall", "front", "stacks", "ping"])

    for (const command of commands) {
      expect(command.Description.startsWith("i18n:")).toBe(true)
      const key = command.Description.slice("i18n:".length)
      expect(enTranslations[key]).toBeTruthy()
      expect(zhTranslations[key]).toBeTruthy()
    }

    const byName = new Map(commands.map(command => [command.Command, command]))
    expect(byName.get("list")?.Aliases).toContain("ls")
    expect(byName.get("search")?.Aliases).toContain("s")
    expect(byName.get("front")?.Aliases).toContain("bring")
    expect(byName.get("stacks")?.Aliases).toContain("stack")
  })

  test("the help command table mirrors plugin.json and has translated labels", () => {
    const commands = pluginJson.Commands as Array<{ Command: string; Description: string; Aliases?: string[] }>

    expect(COMMANDS.map(spec => spec.name)).toEqual(commands.map(command => command.Command))
    expect(COMMANDS.map(spec => spec.aliases)).toEqual(commands.map(command => command.Aliases || []))
    expect(COMMANDS.map(spec => spec.descKey)).toEqual(commands.map(command => command.Description.slice("i18n:".length)))

    for (const spec of COMMANDS) {
      for (const key of [spec.usageKey, spec.descKey]) {
        expect(enTranslations[key]).toBeTruthy()
        expect(zhTranslations[key]).toBeTruthy()
      }
      if (spec.kind === "run") {
        expect(spec.suffix).toBe("")
      } else {
        expect(spec.suffix.length).toBeGreaterThan(0)
      }
    }
  })

  test("declares the new note title setting with translated labels", () => {
    const settings = pluginJson.SettingDefinitions as Array<{ Type: string; Value: Record<string, unknown> }>
    const title = settings.find(setting => setting.Value.Key === "new_note_title")
    expect(title?.Type).toBe("select")
    expect(title?.Value.DefaultValue).toBe("stickies")

    const options = (title?.Value.Options || []) as Array<{ Label: string; Value: string }>
    expect(options.map(option => option.Value)).toEqual(["stickies", "blank", "created", "content"])

    const labels = [title?.Value.Label, title?.Value.Tooltip, ...options.map(option => option.Label)]
    expect(labels).toHaveLength(6)
    for (const label of labels) {
      const text = label as string
      expect(text.startsWith("i18n:")).toBe(true)
      const key = text.slice("i18n:".length)
      expect(enTranslations[key]).toBeTruthy()
      expect(zhTranslations[key]).toBeTruthy()
    }
  })

  test("every key referenced by t() exists in both locales", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf8")
    const calls = source.match(/\bt\((?:[^()]|\([^()]*\))*\)/g) || []
    expect(calls.length).toBeGreaterThan(0)

    const keys: Record<string, true> = {}
    const quotedRe = /"([^"]+)"/g
    for (const call of calls) {
      let quoted: RegExpExecArray | null
      while ((quoted = quotedRe.exec(call)) !== null) {
        keys[quoted[1]] = true
      }
    }
    const keyList = Object.keys(keys)
    expect(keyList.length).toBeGreaterThan(0)
    for (const key of keyList) {
      expect(enTranslations[key]).toBeTruthy()
      expect(zhTranslations[key]).toBeTruthy()
    }
  })
})
