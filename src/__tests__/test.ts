import * as fs from "node:fs"
import * as path from "node:path"
import { ActionContext, Context, PublicAPI, Query, Result, WoxImage } from "@wox-launcher/wox-plugin"
import { noteListMode, parseQuery, plugin } from "../index"
import {
  buildOnTopCommand,
  buildTitleCommands,
  canFocusNote,
  contentTitle,
  decodeUnicode,
  encodeUnicode,
  formatCreatedTitle,
  matchNotes,
  normalizeBridgeOutput,
  normalizeTitleMode,
  noteDefaultAction,
  parseCreatedId,
  parseIdList,
  parseNoteReplies,
  parseReply
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
  const note = { id: "abc", title: "t", text: "body", image: false, rolled: false, hidden: false, ontop: false }

  test("offers focus only for visible, unrolled desktop notes", () => {
    expect(canFocusNote(note)).toBe(true)
    expect(canFocusNote({ ...note, rolled: true })).toBe(false)
    expect(canFocusNote({ ...note, hidden: true })).toBe(false)
    expect(canFocusNote({ ...note, rolled: true, hidden: true })).toBe(false)
  })
})

describe("note default action", () => {
  const note = { id: "abc", title: "t", text: "body", image: false, rolled: false, hidden: false, ontop: false }

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
    { id: "n1", title: "Groceries", text: "buy milk and bread", image: false, rolled: false, hidden: false, ontop: false },
    { id: "n2", title: "", text: "牛奶 待办 买面包", image: false, rolled: false, hidden: false, ontop: false },
    { id: "n3", title: "milk", text: "already bought", image: false, rolled: false, hidden: false, ontop: false },
    { id: "n4", title: "Price list", text: "cost 2.5 (usd)", image: false, rolled: false, hidden: false, ontop: false }
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
    const withImages = [...notes, { id: "img", title: "", text: "", image: true, rolled: false, hidden: false, ontop: false }]
    expect(ids(matchNotes(withImages, "图片"))).toEqual([])
    expect(ids(matchNotes(withImages, "图片", ["图片", "image"]))).toEqual(["img"])
    expect(ids(matchNotes(withImages, "IMAGE", ["图片", "image"]))).toEqual(["img"])
    // Image terms do not make text notes match, and text keywords still work.
    expect(ids(matchNotes(withImages, "milk", ["图片", "image"]))).toEqual(["n1", "n3"])
    expect(ids(matchNotes(withImages, "照片", ["图片", "照片"]))).toEqual(["img"])
  })

  test("image note titles and bodies still match normally", () => {
    const imageWithText = { id: "img", title: "截图", text: "image of a chart", image: true, rolled: false, hidden: false, ontop: false }
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

describe("batched note reply parsing", () => {
  const reply = (code: string, text = "") => ({ code, text, raw: code + (text ? " " + text : "") })
  const group = (title: string, text: string, rolled: string, hidden: string, type: string, ontop = "0") => [
    reply("001", title),
    reply("001", text),
    reply("001", rolled),
    reply("001", hidden),
    reply("001", type),
    reply("001", ontop)
  ]

  test("reads title, text, image, rolled, hidden and ontop for every id", () => {
    const replies = [...group(encodeUnicode("Title A"), encodeUnicode("Body A"), "0", "1", "0", "1"), ...group("", "", "1", "0", "1")]
    const notes = parseNoteReplies(["a", "b"], replies)

    expect(notes).toEqual([
      { id: "a", title: "Title A", text: "Body A", image: false, rolled: false, hidden: true, ontop: true },
      { id: "b", title: "", text: "", image: true, rolled: true, hidden: false, ontop: false }
    ])
  })

  test("treats a missing or failed ontop reply as not on top", () => {
    const missing = parseNoteReplies(["a"], group("", "", "0", "0", "0").slice(0, 5))
    expect(missing[0].ontop).toBe(false)

    const failed = parseNoteReplies(["a"], [...group("", "", "0", "0", "0").slice(0, 5), reply("998", "sticky not found")])
    expect(failed[0].ontop).toBe(false)
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

  test("empty query returns help without touching Stickies", async () => {
    const results = await queryResults(ctx, "")
    expect(results.length).toBeGreaterThan(0)
  })

  test("default trigger keyword drives help text and navigation", async () => {
    const results = await queryResults(ctx, "")
    expect(results[0].SubTitle).toContain('"' + DEFAULT_TRIGGER + '"')
    expect(results[0].Actions?.[0].PreventHideAfterAction).toBe(true)
    expect(results[1].Actions?.[0].PreventHideAfterAction).toBe(true)

    await runAction(results[0])
    expect(changeQuery).toHaveBeenCalledWith(ctx, { QueryType: "input", QueryText: DEFAULT_TRIGGER + " list" })

    await runAction(results[1])
    expect(changeQuery).toHaveBeenCalledWith(ctx, { QueryType: "input", QueryText: DEFAULT_TRIGGER + " new " })
  })

  test("custom trigger keyword flows into help text and navigation", async () => {
    const results = await queryResults(ctx, "", "note")
    expect(results[0].SubTitle).toContain('"note"')
    expect(results[0].SubTitle).not.toContain('"' + DEFAULT_TRIGGER + '"')

    await runAction(results[0])
    expect(changeQuery).toHaveBeenCalledWith(ctx, { QueryType: "input", QueryText: "note list" })
  })

  test("falls back to an effective concrete trigger when the query has none", async () => {
    effectiveTriggers = ["note"]
    const results = await queryResults(ctx, "", "")
    expect(results[0].SubTitle).toContain('"note"')

    await runAction(results[0])
    expect(changeQuery).toHaveBeenCalledWith(ctx, { QueryType: "input", QueryText: "note list" })
  })

  test("global-only trigger uses generic wording and omits prefixed navigation", async () => {
    effectiveTriggers = ["*"]
    const results = await queryResults(ctx, "", "")
    expect(results[0].Actions).toEqual([])
    expect(results[1].Actions).toEqual([])
    expect(results[0].SubTitle).toContain(enTranslations.trigger_keyword_generic)
    expect(results[0].SubTitle).not.toContain('"' + DEFAULT_TRIGGER + '"')
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
    expect(commands.map(command => command.Command)).toEqual(["new", "list", "search", "paste", "hideall", "showall", "ping"])

    for (const command of commands) {
      expect(command.Description.startsWith("i18n:")).toBe(true)
      const key = command.Description.slice("i18n:".length)
      expect(enTranslations[key]).toBeTruthy()
      expect(zhTranslations[key]).toBeTruthy()
    }

    const byName = new Map(commands.map(command => [command.Command, command]))
    expect(byName.get("list")?.Aliases).toContain("ls")
    expect(byName.get("search")?.Aliases).toContain("s")
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
