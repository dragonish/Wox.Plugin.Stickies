import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/**
 * Client for the Stickies API.
 *
 * Stickies has no HTTP/socket API: every command goes through the
 * PowerShell bridge (src/bridge.ps1, shipped next to the built index.js),
 * which sends WM_COPYDATA to the Stickies main window and waits for its
 * reply. This module never touches Win32 itself; it only spawns one
 * short-lived powershell.exe per batch of commands and parses the JSON
 * array the bridge prints to stdout.
 *
 * All note bodies/titles travel as Stickies "utext"/"utitle" hex strings
 * (4 hex chars per UTF-16 code unit), so Chinese text survives exactly
 * no matter what the system ANSI code page is.
 */

export interface StickiesReply {
  code: string
  text: string
  raw: string
}

export interface StickyNote {
  id: string
  title: string
  text: string
  /** Image note (Stickies `type` 1). Its body is a bitmap, not text. */
  image: boolean
  rolled: boolean
  hidden: boolean
  /** Always-on-top note (Stickies `ontop`). */
  ontop: boolean
}

/** A note can be focused only while it is visible on the desktop and unrolled. */
export function canFocusNote(note: StickyNote): boolean {
  return !note.rolled && !note.hidden
}

/**
 * The action Enter runs for a note: reveal a hidden note, then unroll a
 * visible rolled one, then focus an already open note. Each step advances the
 * note one layer towards fully open, so the default always does something the
 * user can see.
 */
export type NoteDefaultAction = "focus" | "show" | "unroll"

export function noteDefaultAction(note: StickyNote): NoteDefaultAction {
  if (note.hidden) {
    return "show"
  }
  return note.rolled ? "unroll" : "focus"
}

export class StickiesError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "StickiesError"
    this.code = code
    // Target ES5 breaks `extends Error`: restore the prototype so instanceof works.
    Object.setPrototypeOf(this, StickiesError.prototype)
  }
}

export const ERR_NOT_RUNNING = "ERR_NO_STICKIES"
export const ERR_WINDOWS_ONLY = "ERR_WINDOWS_ONLY"
export const ERR_TIMEOUT = "ERR_TIMEOUT"
export const ERR_BRIDGE = "ERR_BRIDGE"

/** Maximum note body the plugin will send (WM_COPYDATA is for small data). */
export const MAX_TEXT_LENGTH = 4000
/** Maximum notes returned by one list query. */
export const MAX_LIST_NOTES = 30
/** Maximum title length the plugin derives from the note body. */
export const MAX_TITLE_LENGTH = 80

/**
 * How the plugin titles a note it has just created.
 *
 * - stickies: do not touch the title, so Stickies applies its own setting
 *   (blank, creation time, or "set when created").
 * - blank: clear the title.
 * - created: write the creation time as "YYYY-MM-DD HH:mm", matching the
 *   format Stickies uses for its own creation-time titles.
 * - content: use the first line of the note body.
 */
export type TitleMode = "stickies" | "blank" | "created" | "content"

/** Accept only known setting values; anything else falls back to Stickies. */
export function normalizeTitleMode(value: string | null | undefined): TitleMode {
  if (value === "blank" || value === "created" || value === "content") {
    return value
  }
  return "stickies"
}

/** Local time formatted the way Stickies shows creation-time titles. */
export function formatCreatedTitle(date: Date = new Date()): string {
  const pad = (value: number): string => (value < 10 ? "0" : "") + value
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes())
}

/** The title derived from the note body in "content" mode. */
export function contentTitle(text: string): string {
  return firstLine(text).slice(0, MAX_TITLE_LENGTH)
}

/** Encode a string the way Stickies expects for utext/utitle: 4 hex chars per UTF-16 code unit. */
export function encodeUnicode(text: string): string {
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const hex = text.charCodeAt(i).toString(16)
    out += ("0000" + hex).slice(-4)
  }
  return out
}

/** Decode a Stickies utext/utitle hex string back to text. Non-hex input is returned as-is. */
export function decodeUnicode(hex: string): string {
  const clean = hex.replace(/\s/g, "")
  if (clean.length === 0 || clean.length % 4 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    return hex
  }
  let out = ""
  for (let i = 0; i < clean.length; i += 4) {
    out += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16))
  }
  return out
}

/** Split a raw Stickies reply ("000 OK pong" / "001 id,id,") into code + text. */
export function parseReply(raw: string): StickiesReply {
  const trimmed = (raw || "").trim()
  const match = /^(\d{3})\s?(.*)$/.exec(trimmed)
  if (match) {
    return { code: match[1], text: (match[2] || "").trim(), raw: trimmed }
  }
  return { code: "ERR", text: trimmed, raw: trimmed }
}

/** "OK created: <id>" -> "<id>", otherwise null. */
export function parseCreatedId(reply: StickiesReply): string | null {
  const match = /created:\s*(\S+)/.exec(reply.text)
  return match ? match[1] : null
}

/** "001 id1,id2," -> ["id1", "id2"]. */
export function parseIdList(reply: StickiesReply): string[] {
  if (reply.code !== "001") {
    return []
  }
  return reply.text
    .split(",")
    .map(id => id.trim())
    .filter(id => id.length > 0)
}

function isOk(reply: StickiesReply): boolean {
  return reply.code === "000" || reply.code === "001"
}

function throwIfError(reply: StickiesReply, what: string): void {
  if (reply.code === ERR_NOT_RUNNING) {
    throw new StickiesError(ERR_NOT_RUNNING, "Stickies is not running")
  }
  if (!isOk(reply)) {
    const detail = reply.text || reply.raw || "empty reply from the Stickies bridge"
    throw new StickiesError(reply.code, what + " failed: " + detail)
  }
}

/**
 * Normalize whatever the bridge printed into an ordered reply list:
 * a lone object, a one-element array, an array of replies, or the doubly
 * nested [[{...}]] shape produced by older bridges.
 */
export function normalizeBridgeOutput(parsed: unknown): StickiesReply[] {
  const list = Array.isArray(parsed) ? parsed : [parsed]
  const items: unknown[] = []
  for (const entry of list) {
    if (Array.isArray(entry)) {
      for (const nested of entry) {
        items.push(nested)
      }
    } else {
      items.push(entry)
    }
  }
  return items.map(item => {
    const obj = (item && typeof item === "object" ? item : {}) as { code?: unknown; text?: unknown; raw?: unknown }
    if (typeof obj.code === "string" && obj.code) {
      return {
        code: obj.code,
        text: typeof obj.text === "string" ? obj.text : "",
        raw: typeof obj.raw === "string" ? obj.raw : ""
      }
    }
    return parseReply(typeof obj.raw === "string" ? obj.raw : "")
  })
}

/**
 * Run one batch of "api ..." commands through the bridge and return the
 * replies in order. One powershell.exe spawn per batch, however many
 * commands the batch holds.
 */
export async function runCommands(commands: string[]): Promise<StickiesReply[]> {
  if (process.platform !== "win32") {
    throw new StickiesError(ERR_WINDOWS_ONLY, "Stickies only runs on Windows")
  }
  if (commands.length === 0) {
    return []
  }
  const bridgePath = path.join(__dirname, "bridge.ps1")
  if (!fs.existsSync(bridgePath)) {
    throw new StickiesError(ERR_BRIDGE, "bridge.ps1 is missing from the plugin folder")
  }
  const tmpFile = path.join(os.tmpdir(), "wox-stickies-" + process.pid + "-" + Date.now() + ".txt")
  fs.writeFileSync(tmpFile, commands.join("\r\n"), "utf8")
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", bridgePath, "-InputFile", tmpFile], { timeout: 30000, windowsHide: true }, (error, stdoutText, stderrText) => {
        if (error) {
          reject(new StickiesError(ERR_BRIDGE, "Stickies bridge failed: " + (stderrText || error.message).trim()))
          return
        }
        resolve(stdoutText)
      })
    })
    let parsed: unknown
    try {
      parsed = JSON.parse(stdout.trim())
    } catch {
      throw new StickiesError(ERR_BRIDGE, "Stickies bridge returned unreadable output")
    }
    // Windows PowerShell 5.1 ConvertTo-Json may emit a lone object instead
    // of a one-element array; normalize either shape. Older bridges also
    // wrapped the whole array twice ([[{...}]]), so flatten one level.
    return normalizeBridgeOutput(parsed)
  } finally {
    try {
      fs.unlinkSync(tmpFile)
    } catch {
      // temp file cleanup is best-effort
    }
  }
}

/** "api do ping" + "api get version" in one bridge call. Returns e.g. "Stickies v10.1a". */
export async function ping(): Promise<string> {
  const replies = await runCommands(["api do ping", "api get version"])
  throwIfError(replies[0], "Ping")
  const version = replies[1] && replies[1].code === "001" ? replies[1].text : ""
  return version || replies[0].text || "pong"
}

export function firstLine(text: string): string {
  const line = text.split(/\r\n|\n|\r/)[0] || ""
  return line.trim()
}

/**
 * Commands that apply the chosen title policy to an existing note.
 * "stickies" returns nothing so the title Stickies assigned on creation stays.
 */
export function buildTitleCommands(id: string, mode: TitleMode, text: string, now: Date = new Date()): string[] {
  if (mode === "stickies") {
    return []
  }
  // The API clears a title only when the command ends with a space after
  // "title"; the bridge preserves trailing spaces in the command file.
  if (mode === "blank") {
    return ["api set desktop " + id + " title "]
  }
  if (mode === "created") {
    return ["api set desktop " + id + " utitle " + encodeUnicode(formatCreatedTitle(now))]
  }
  const title = contentTitle(text)
  return title ? ["api set desktop " + id + " utitle " + encodeUnicode(title)] : ["api set desktop " + id + " title "]
}

/**
 * Create a desktop note with exact Unicode body/title.
 * Creates the note with a one-character placeholder first (the "api do new
 * sticky" text argument is ANSI and cannot carry newlines reliably), then
 * overwrites body and title. Updating the body does not change the title, so
 * "stickies" mode simply leaves whatever title Stickies assigned.
 */
export async function createSticky(text: string, titleMode: TitleMode = "stickies", now: Date = new Date()): Promise<string> {
  if (text.length > MAX_TEXT_LENGTH) {
    throw new StickiesError("ERR_TOO_LONG", "Note is too long (" + text.length + " chars, max " + MAX_TEXT_LENGTH + ")")
  }
  const created = await runCommands(["api do new sticky x"])
  throwIfError(created[0], "Create sticky")
  const id = parseCreatedId(created[0])
  if (!id) {
    throw new StickiesError("ERR_NO_ID", "Stickies created a note but returned no id: " + created[0].raw)
  }
  const sets = ["api set desktop " + id + " utext " + encodeUnicode(text), ...buildTitleCommands(id, titleMode, text, now)]
  const replies = await runCommands(sets)
  for (const reply of replies) {
    throwIfError(reply, "Write sticky text")
  }
  return id
}

/** Create a note from the clipboard as plain text (Stickies does the paste). */
export async function createStickyFromClipboard(titleMode: TitleMode = "stickies", now: Date = new Date()): Promise<string> {
  const replies = await runCommands(["api do new sticky_paste_plain"])
  throwIfError(replies[0], "Create sticky from clipboard")
  const id = parseCreatedId(replies[0])
  if (!id) {
    throw new StickiesError("ERR_NO_ID", "Stickies created a note but returned no id: " + replies[0].raw)
  }
  // "content" mode needs the pasted text, which only exists after the paste.
  let sourceText = ""
  if (titleMode === "content") {
    const textReplies = await runCommands(["api get desktop " + id + " utext"])
    if (textReplies[0] && textReplies[0].code === "001") {
      sourceText = decodeUnicode(textReplies[0].text)
    }
  }
  const titleCommands = buildTitleCommands(id, titleMode, sourceText, now)
  if (titleCommands.length > 0) {
    const titleReplies = await runCommands(titleCommands)
    for (const reply of titleReplies) {
      throwIfError(reply, "Write sticky title")
    }
  }
  return id
}

/**
 * Filter notes by a whitespace-separated keyword query.
 *
 * Every keyword must appear in the note title or body (AND), which makes
 * `list milk todo` mean "notes containing both words". Matching is
 * case-insensitive and uses plain substring search, so regex characters in
 * the query need no escaping. An empty or blank query returns the notes
 * unchanged. `\s` also covers the ideographic space (U+3000) common in
 * Chinese input.
 *
 * Image notes have no text, so `imageTerms` lets localized words such as
 * "image" or "图片" match them instead. A keyword matches when it equals one
 * of those terms and the note is an image note.
 */
export function matchNotes(notes: StickyNote[], query: string, imageTerms: string[] = []): StickyNote[] {
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter(keyword => keyword.length > 0)
  if (keywords.length === 0) {
    return notes
  }
  const terms = imageTerms.map(term => term.toLowerCase()).filter(term => term.length > 0)
  return notes.filter(note => {
    const title = note.title.toLowerCase()
    const text = note.text.toLowerCase()
    return keywords.every(keyword => title.indexOf(keyword) >= 0 || text.indexOf(keyword) >= 0 || (note.image && terms.indexOf(keyword) >= 0))
  })
}

/** Replies fetched per note by listNotes: utitle, utext, rolled, hidden, type, ontop. */
const NOTE_REPLY_COUNT = 6

/** Parse one batched listNotes reply group per id. Missing replies are skipped. */
export function parseNoteReplies(ids: string[], replies: StickiesReply[]): StickyNote[] {
  const notes: StickyNote[] = []
  for (let i = 0; i < ids.length; i++) {
    const base = i * NOTE_REPLY_COUNT
    const titleReply = replies[base]
    const textReply = replies[base + 1]
    if (!titleReply || !textReply) {
      continue
    }
    const rolledReply = replies[base + 2]
    const hiddenReply = replies[base + 3]
    const typeReply = replies[base + 4]
    const ontopReply = replies[base + 5]
    const text = textReply.code === "001" ? decodeUnicode(textReply.text) : ""
    let title = titleReply.code === "001" ? decodeUnicode(titleReply.text) : ""
    if (!title) {
      title = firstLine(text)
    }
    notes.push({
      id: ids[i],
      title: title,
      text: text,
      // "get desktop <id> type": 0 = RTF text note, 1 = image note.
      image: typeReply ? typeReply.code === "001" && typeReply.text.trim() === "1" : false,
      rolled: rolledReply ? rolledReply.text === "1" : false,
      hidden: hiddenReply ? hiddenReply.text === "1" : false,
      ontop: ontopReply ? ontopReply.code === "001" && ontopReply.text.trim() === "1" : false
    })
  }
  return notes
}

/** List desktop notes with title, full text, image flag, rolled, hidden and ontop state. */
export async function listNotes(): Promise<StickyNote[]> {
  const listReply = await runCommands(["api get list desktop"])
  throwIfError(listReply[0], "List notes")
  const ids = parseIdList(listReply[0]).slice(0, MAX_LIST_NOTES)
  if (ids.length === 0) {
    return []
  }
  const commands: string[] = []
  for (const id of ids) {
    commands.push("api get desktop " + id + " utitle")
    commands.push("api get desktop " + id + " utext")
    commands.push("api get desktop " + id + " rolled")
    commands.push("api get desktop " + id + " hidden")
    commands.push("api get desktop " + id + " type")
    commands.push("api get desktop " + id + " ontop")
  }
  const replies = await runCommands(commands)
  return parseNoteReplies(ids, replies)
}

export async function setRolled(id: string, rolled: boolean): Promise<void> {
  const replies = await runCommands(["api do desktop " + id + (rolled ? " rolled" : " unrolled")])
  throwIfError(replies[0], rolled ? "Roll up note" : "Unroll note")
}

/** "api set desktop <id> ontop 1" / "... ontop 0". */
export function buildOnTopCommand(id: string, ontop: boolean): string {
  return "api set desktop " + id + " ontop " + (ontop ? "1" : "0")
}

/** Keep a desktop note always-on-top, or let it drop back into the z-order. */
export async function setOnTop(id: string, ontop: boolean): Promise<void> {
  const replies = await runCommands([buildOnTopCommand(id, ontop)])
  throwIfError(replies[0], ontop ? "Keep note on top" : "Remove note from top")
}

/**
 * Bring a visible desktop note to the front and give it keyboard focus.
 * The bridge resolves the note window handle and activates it with Win32.
 */
export async function focusNote(id: string): Promise<void> {
  const replies = await runCommands(["focus " + id])
  throwIfError(replies[0], "Focus note")
}

export async function setHidden(id: string, hidden: boolean): Promise<void> {
  const replies = await runCommands(["api set desktop " + id + " hidden " + (hidden ? "1" : "0")])
  throwIfError(replies[0], hidden ? "Hide note" : "Show note")
}

/**
 * Copy the note's contents to the clipboard. For an image note this copies the
 * bitmap, for a text note the formatted text. Replaces the current clipboard.
 */
export async function copyNoteContent(id: string): Promise<void> {
  const replies = await runCommands(["api do desktop " + id + " copycontent"])
  throwIfError(replies[0], "Copy note content")
}

/** Close = move to the Closed category (restorable from Stickies Manage). */
export async function closeNote(id: string): Promise<void> {
  const replies = await runCommands(["api do desktop " + id + " close"])
  throwIfError(replies[0], "Close note")
}

/** Delete = permanently remove. There is no undo. */
export async function deleteNote(id: string): Promise<void> {
  const replies = await runCommands(["api do desktop " + id + " delete"])
  throwIfError(replies[0], "Delete note")
}

export async function hideAll(): Promise<void> {
  const replies = await runCommands(["api do hideall"])
  throwIfError(replies[0], "Hide all notes")
}

export async function showAll(): Promise<void> {
  const replies = await runCommands(["api do showall"])
  throwIfError(replies[0], "Show all notes")
}
