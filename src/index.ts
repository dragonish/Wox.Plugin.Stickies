import { ActionContext, Context, Plugin, PluginInitParams, PublicAPI, Query, Result, ResultAction, ResultTail, WoxImage } from "@wox-launcher/wox-plugin"
import {
  MAX_TEXT_LENGTH,
  StickiesError,
  StickyNote,
  TitleMode,
  canFocusNote,
  closeNote,
  copyNoteContent,
  createSticky,
  createStickyFromClipboard,
  deleteNote,
  firstLine,
  focusNote,
  hideAll,
  listNotes,
  matchNotes,
  normalizeTitleMode,
  noteDefaultAction,
  ping,
  setHidden,
  setRolled,
  showAll
} from "./stickies"

let api: PublicAPI

/** Wox setting key for how new notes are titled. */
const TITLE_MODE_SETTING = "new_note_title"

const appIcon: WoxImage = {
  ImageType: "relative",
  ImageData: "images/app.png"
}

/** Notes from the last list query, so actions can copy text without re-fetching. */
const noteCache = new Map<string, StickyNote>()

async function t(ctx: Context, key: string, ...args: string[]): Promise<string> {
  let raw = key
  try {
    raw = (await api.GetTranslation(ctx, key)) || key
  } catch {
    raw = key
  }
  return format(raw, ...args)
}

/** Fill %s placeholders left to right; extra placeholders stay as "%s". */
function format(raw: string, ...args: string[]): string {
  let index = 0
  return raw.replace(/%s/g, () => (index < args.length ? args[index++] : "%s"))
}

/**
 * Trigger keyword that actually activated this query.
 * When Wox fires the plugin through the global "*" trigger, fall back to the
 * first concrete keyword the user configured (if any).
 */
async function resolveTrigger(ctx: Context, query: Query): Promise<string | null> {
  const direct = (query.TriggerKeyword || "").trim()
  if (direct && direct !== "*") {
    return direct
  }
  try {
    const { TriggerKeywords } = await api.GetTriggerKeywords(ctx, {})
    for (const keyword of TriggerKeywords || []) {
      const trimmed = keyword.trim()
      if (trimmed && trimmed !== "*") {
        return trimmed
      }
    }
  } catch {
    // Older Wox builds may not expose GetTriggerKeywords.
  }
  return null
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Read the title policy once per query; unknown or unreadable values defer to Stickies. */
async function readTitleMode(ctx: Context): Promise<TitleMode> {
  try {
    return normalizeTitleMode(await api.GetSetting(ctx, TITLE_MODE_SETTING))
  } catch {
    return "stickies"
  }
}

interface ParsedQuery {
  /** Lowercased command keyword, empty when the user typed nothing. */
  head: string
  /** Everything after the command keyword. */
  args: string
  /** Original text, preserving the user's casing for note bodies. */
  text: string
}

/**
 * Split a query into command + arguments.
 *
 * Wox pulls a command declared in plugin.json out of the input, so
 * `sti new buy milk` arrives as Command="new", Search="buy milk". Folding the
 * command back into the text keeps a single parsing path and still accepts
 * raw input such as `sti ls`.
 */
export function parseQuery(query: Query): ParsedQuery {
  const command = (query.Command || "").trim()
  const search = (query.Search || "").trim()
  const text = command ? (search ? command + " " + search : command) : search
  const space = text.indexOf(" ")
  if (space < 0) {
    return { head: text.toLowerCase(), args: "", text }
  }
  return {
    head: text.slice(0, space).toLowerCase(),
    args: text.slice(space + 1).trim(),
    text
  }
}

/**
 * Which note listing an input asks for: "all" for a bare list/search command,
 * "search" when keywords follow, null for any other command. `list` therefore
 * behaves exactly like `search` as soon as it is given a keyword.
 */
export function noteListMode(head: string, args: string): "all" | "search" | null {
  if (head !== "list" && head !== "ls" && head !== "search" && head !== "s") {
    return null
  }
  return args ? "search" : "all"
}

/**
 * Show an independent Wox notification window.
 * Replaces the deprecated api.Notify and requires Wox >= 2.5.0.
 */
async function notify(ctx: Context, message: string, title?: string): Promise<void> {
  const result = await api.ShowToastMsg(ctx, { Message: message, Title: title })
  if (!result.Success) {
    await api.Log(ctx, "Warning", "ShowToastMsg failed: " + result.ErrMsg)
  }
}

/** Report a failure through the same toast window, with an error title. */
async function notifyError(ctx: Context, err: unknown): Promise<void> {
  await notify(ctx, errorText(err), await t(ctx, "notify_error_title"))
}

async function errorResult(ctx: Context, err: unknown): Promise<Result> {
  const message = errorText(err)
  const hint =
    err instanceof StickiesError && err.code === "ERR_NO_STICKIES"
      ? await t(ctx, "error_hint_not_running")
      : err instanceof StickiesError && err.code === "ERR_WINDOWS_ONLY"
        ? await t(ctx, "error_hint_windows_only")
        : ""
  return {
    Title: message,
    SubTitle: hint,
    Icon: appIcon,
    Actions: [
      {
        Id: "copy-error",
        Name: await t(ctx, "action_copy_error"),
        Action: async (actionCtx: Context) => {
          await api.Copy(actionCtx, { type: "text", text: message })
        }
      }
    ]
  }
}

/** Labels a note row needs. Loaded once per query so a long list stays cheap. */
interface NoteLabels {
  stateRolled: string
  stateHidden: string
  stateDesktop: string
  subtitle: string
  emptyPreview: string
  imagePreview: string
  tailRolled: string
  tailImage: string
  untitled: string
  imageUntitled: string
  roll: string
  unroll: string
  focus: string
  copyText: string
  copyImage: string
  show: string
  hide: string
  closeNote: string
  deleteNote: string
}

async function loadNoteLabels(ctx: Context): Promise<NoteLabels> {
  const [
    stateRolled,
    stateHidden,
    stateDesktop,
    subtitle,
    emptyPreview,
    imagePreview,
    tailRolled,
    tailImage,
    untitled,
    imageUntitled,
    roll,
    unroll,
    focus,
    copyText,
    copyImage,
    show,
    hide,
    closeNote,
    deleteNote
  ] = await Promise.all([
    t(ctx, "note_state_rolled"),
    t(ctx, "note_state_hidden"),
    t(ctx, "note_state_desktop"),
    t(ctx, "note_subtitle"),
    t(ctx, "note_preview_empty"),
    t(ctx, "note_image_preview"),
    t(ctx, "note_tail_rolled"),
    t(ctx, "note_tail_image"),
    t(ctx, "note_untitled"),
    t(ctx, "note_image_untitled"),
    t(ctx, "action_roll"),
    t(ctx, "action_unroll"),
    t(ctx, "action_focus"),
    t(ctx, "action_copy_text"),
    t(ctx, "action_copy_image"),
    t(ctx, "action_show"),
    t(ctx, "action_hide"),
    t(ctx, "action_close_note"),
    t(ctx, "action_delete_note")
  ])
  return {
    stateRolled,
    stateHidden,
    stateDesktop,
    subtitle,
    emptyPreview,
    imagePreview,
    tailRolled,
    tailImage,
    untitled,
    imageUntitled,
    roll,
    unroll,
    focus,
    copyText,
    copyImage,
    show,
    hide,
    closeNote,
    deleteNote
  }
}

/** List every desktop note, caching each row's text for its copy action. */
async function allNoteResults(ctx: Context, triggerLabel: string): Promise<Result[]> {
  try {
    const notes = await listNotes()
    for (const note of notes) {
      noteCache.set(note.id, note)
    }
    if (notes.length === 0) {
      return [
        {
          Title: await t(ctx, "list_empty_title"),
          SubTitle: await t(ctx, "list_empty_subtitle", triggerLabel),
          Icon: appIcon,
          Actions: []
        }
      ]
    }
    const labels = await loadNoteLabels(ctx)
    return notes.map(note => noteResult(note, labels))
  } catch (err) {
    return [await errorResult(ctx, err)]
  }
}

/** List and filter desktop notes by keyword, caching each row's text for actions. */
async function searchNoteResults(ctx: Context, keyword: string): Promise<Result[]> {
  try {
    const notes = await listNotes()
    for (const note of notes) {
      noteCache.set(note.id, note)
    }
    const imageTerms = (await t(ctx, "search_image_terms")).split(/\s+/).filter(term => term.length > 0)
    const hits = matchNotes(notes, keyword, imageTerms)
    if (hits.length === 0) {
      return [
        {
          Title: await t(ctx, "search_empty_title", keyword),
          SubTitle: await t(ctx, "search_empty_subtitle"),
          Icon: appIcon,
          Actions: []
        }
      ]
    }
    const labels = await loadNoteLabels(ctx)
    return hits.map(note => noteResult(note, labels))
  } catch (err) {
    return [await errorResult(ctx, err)]
  }
}

/** "new <text>" result: preview the text and create the note on Enter. */
async function createResult(ctx: Context, text: string): Promise<Result> {
  const title = firstLine(text)
  const titleMode = await readTitleMode(ctx)
  return {
    Title: await t(ctx, "create_title", title),
    SubTitle: await t(ctx, "create_subtitle", String(text.length)),
    Icon: appIcon,
    Preview: {
      PreviewType: "markdown",
      PreviewData: text
    },
    Actions: [
      {
        Id: "create",
        Name: await t(ctx, "action_create"),
        IsDefault: true,
        Action: async (actionCtx: Context, actionContext: ActionContext) => {
          try {
            const id = await createSticky(actionContext.ContextData.text, normalizeTitleMode(actionContext.ContextData?.titleMode))
            await notify(actionCtx, await t(actionCtx, "notify_created", id))
          } catch (err) {
            await notifyError(actionCtx, err)
          }
        },
        ContextData: { text: text.length <= MAX_TEXT_LENGTH ? text : text.slice(0, MAX_TEXT_LENGTH), titleMode }
      }
    ]
  }
}

function noteResult(note: StickyNote, labels: NoteLabels): Result {
  const state = note.rolled ? labels.stateRolled : note.hidden ? labels.stateHidden : labels.stateDesktop
  const focusable = canFocusNote(note)
  const defaultAction = noteDefaultAction(note)
  const actions: ResultAction[] = []

  // Enter walks a note towards fully open: hidden notes are shown, visible
  // rolled notes are unrolled, and open notes are focused.
  if (focusable) {
    actions.push({
      Id: "focus-note",
      Name: labels.focus,
      IsDefault: defaultAction === "focus",
      Action: async (actionCtx: Context, actionContext: ActionContext) => {
        try {
          await focusNote(actionContext.ContextData.id)
        } catch (err) {
          await notifyError(actionCtx, err)
        }
      },
      ContextData: { id: note.id }
    })
  }

  // Image notes have no text, so they get "Copy image" instead; a note with
  // both (once detected) keeps both actions.
  const copyActions: ResultAction[] = []
  if (note.text || !note.image) {
    copyActions.push({
      Id: "copy-text",
      Name: labels.copyText,
      Action: async (actionCtx: Context, actionContext: ActionContext) => {
        const id = actionContext.ContextData.id
        let cached = noteCache.get(id)
        if (!cached) {
          const notes = await listNotes()
          for (const n of notes) {
            noteCache.set(n.id, n)
          }
          cached = noteCache.get(id)
        }
        await api.Copy(actionCtx, { type: "text", text: cached ? cached.text : "" })
        await notify(actionCtx, await t(actionCtx, "notify_copied"))
      },
      ContextData: { id: note.id }
    })
  }
  if (note.image) {
    copyActions.push({
      Id: "copy-image",
      Name: labels.copyImage,
      Action: async (actionCtx: Context, actionContext: ActionContext) => {
        await copyNoteContent(actionContext.ContextData.id)
        await notify(actionCtx, await t(actionCtx, "notify_copied_image"))
      },
      ContextData: { id: note.id }
    })
  }

  actions.push(
    {
      Id: "toggle-roll",
      Name: note.rolled ? labels.unroll : labels.roll,
      IsDefault: defaultAction === "unroll",
      Action: async (actionCtx: Context, actionContext: ActionContext) => {
        try {
          const id = actionContext.ContextData.id
          const wasRolled = actionContext.ContextData.rolled === "1"
          await setRolled(id, !wasRolled)
          await notify(actionCtx, await t(actionCtx, wasRolled ? "notify_unrolled" : "notify_rolled"))
        } catch (err) {
          await notifyError(actionCtx, err)
        }
      },
      ContextData: { id: note.id, rolled: note.rolled ? "1" : "0" }
    },
    ...copyActions,
    {
      Id: "toggle-hide",
      Name: note.hidden ? labels.show : labels.hide,
      IsDefault: defaultAction === "show",
      Action: async (actionCtx: Context, actionContext: ActionContext) => {
        try {
          const id = actionContext.ContextData.id
          const wasHidden = actionContext.ContextData.hidden === "1"
          await setHidden(id, !wasHidden)
          await notify(actionCtx, await t(actionCtx, wasHidden ? "notify_shown" : "notify_hidden"))
        } catch (err) {
          await notifyError(actionCtx, err)
        }
      },
      ContextData: { id: note.id, hidden: note.hidden ? "1" : "0" }
    },
    {
      Id: "close-note",
      Name: labels.closeNote,
      Action: async (actionCtx: Context, actionContext: ActionContext) => {
        await closeNote(actionContext.ContextData.id)
        await notify(actionCtx, await t(actionCtx, "notify_closed"))
      },
      ContextData: { id: note.id }
    },
    {
      Id: "delete-note",
      Name: labels.deleteNote,
      Action: async (actionCtx: Context, actionContext: ActionContext) => {
        await deleteNote(actionContext.ContextData.id)
        await notify(actionCtx, await t(actionCtx, "notify_deleted"))
      },
      ContextData: { id: note.id }
    }
  )

  const title = note.title || (note.image ? labels.imageUntitled : labels.untitled)
  const preview = note.text ? note.text : note.image ? labels.imagePreview : labels.emptyPreview
  const tails: ResultTail[] = []
  if (note.image) {
    tails.push({ Type: "text", Text: labels.tailImage })
  }
  if (note.rolled) {
    tails.push({ Type: "text", Text: labels.tailRolled })
  }

  return {
    Title: title,
    SubTitle: format(labels.subtitle, note.id, state),
    Icon: appIcon,
    Preview: {
      PreviewType: "markdown",
      PreviewData: preview
    },
    Tails: tails,
    Actions: actions
  }
}

export const plugin: Plugin = {
  init: async (ctx: Context, initParams: PluginInitParams) => {
    api = initParams.API
    await api.Log(ctx, "Info", "Stickies plugin init finished")
  },

  query: async (ctx: Context, query: Query): Promise<Result[]> => {
    const { head, args, text } = parseQuery(query)
    const trigger = await resolveTrigger(ctx, query)
    const triggerLabel = trigger || (await t(ctx, "trigger_keyword_generic"))

    // Empty query — help, no Stickies call so it stays instant.
    if (!head) {
      return [
        {
          Title: await t(ctx, "help_title"),
          SubTitle: await t(ctx, "help_subtitle", triggerLabel),
          Icon: appIcon,
          Actions: trigger
            ? [
                {
                  Id: "goto-list",
                  Name: await t(ctx, "action_list"),
                  IsDefault: true,
                  PreventHideAfterAction: true,
                  Action: async (actionCtx: Context) => {
                    await api.ChangeQuery(actionCtx, { QueryType: "input", QueryText: trigger + " list" })
                  }
                }
              ]
            : []
        },
        {
          Title: await t(ctx, "help_create_title"),
          SubTitle: await t(ctx, "help_create_subtitle", triggerLabel),
          Icon: appIcon,
          Actions: trigger
            ? [
                {
                  Id: "goto-create",
                  Name: await t(ctx, "action_create"),
                  PreventHideAfterAction: true,
                  Action: async (actionCtx: Context) => {
                    await api.ChangeQuery(actionCtx, { QueryType: "input", QueryText: trigger + " new " })
                  }
                }
              ]
            : []
        }
      ]
    }

    // ping — check Stickies answers and report its version.
    if (head === "ping") {
      try {
        const version = await ping()
        return [
          {
            Title: await t(ctx, "ping_title", version),
            SubTitle: await t(ctx, "ping_subtitle"),
            Icon: appIcon,
            Actions: []
          }
        ]
      } catch (err) {
        return [await errorResult(ctx, err)]
      }
    }

    // list / ls / search / s — desktop notes. Keywords filter the list, so
    // `sti list milk todo` means the same as `sti search milk todo`.
    const listMode = noteListMode(head, args)
    if (listMode === "search") {
      return searchNoteResults(ctx, args)
    }
    if (listMode === "all") {
      return allNoteResults(ctx, triggerLabel)
    }

    // paste — new note from the clipboard as plain text.
    if (head === "paste") {
      const titleMode = await readTitleMode(ctx)
      return [
        {
          Title: await t(ctx, "paste_title"),
          SubTitle: await t(ctx, "paste_subtitle"),
          Icon: appIcon,
          Actions: [
            {
              Id: "create-paste",
              Name: await t(ctx, "action_create"),
              IsDefault: true,
              Action: async (actionCtx: Context, actionContext: ActionContext) => {
                try {
                  const id = await createStickyFromClipboard(normalizeTitleMode(actionContext.ContextData?.titleMode))
                  await notify(actionCtx, await t(actionCtx, "notify_created", id))
                } catch (err) {
                  await notifyError(actionCtx, err)
                }
              },
              ContextData: { titleMode }
            }
          ]
        }
      ]
    }

    // hideall / showall
    if (head === "hideall" || head === "showall") {
      const hiding = head === "hideall"
      return [
        {
          Title: hiding ? await t(ctx, "hideall_title") : await t(ctx, "showall_title"),
          SubTitle: hiding ? await t(ctx, "hideall_subtitle") : await t(ctx, "showall_subtitle"),
          Icon: appIcon,
          Actions: [
            {
              Id: hiding ? "hide-all" : "show-all",
              Name: hiding ? await t(ctx, "action_hideall") : await t(ctx, "action_showall"),
              IsDefault: true,
              Action: async (actionCtx: Context) => {
                try {
                  if (hiding) {
                    await hideAll()
                    await notify(actionCtx, await t(actionCtx, "notify_hideall"))
                  } else {
                    await showAll()
                    await notify(actionCtx, await t(actionCtx, "notify_showall"))
                  }
                } catch (err) {
                  await notifyError(actionCtx, err)
                }
              }
            }
          ]
        }
      ]
    }

    // new <text> — create a desktop note with this text.
    if (head === "new") {
      if (args) {
        return [await createResult(ctx, args)]
      }
      const titleMode = await readTitleMode(ctx)
      return [
        {
          Title: await t(ctx, "new_empty_title"),
          SubTitle: await t(ctx, "new_empty_subtitle", triggerLabel),
          Icon: appIcon,
          Actions: [
            {
              Id: "create-empty",
              Name: await t(ctx, "action_create_empty"),
              IsDefault: true,
              Action: async (actionCtx: Context, actionContext: ActionContext) => {
                try {
                  // A single space gives Stickies a harmless blank body while
                  // avoiding an empty utext argument the API may reject.
                  const id = await createSticky(" ", normalizeTitleMode(actionContext.ContextData?.titleMode))
                  await notify(actionCtx, await t(actionCtx, "notify_created", id))
                } catch (err) {
                  await notifyError(actionCtx, err)
                }
              },
              ContextData: { titleMode }
            }
          ]
        }
      ]
    }

    // Unknown command or bare text: never create implicitly, guide to `new`.
    if (trigger) {
      return [
        {
          Title: await t(ctx, "create_title", firstLine(text)),
          SubTitle: await t(ctx, "create_hint_subtitle", triggerLabel),
          Icon: appIcon,
          Preview: {
            PreviewType: "markdown",
            PreviewData: text
          },
          Actions: [
            {
              Id: "goto-new",
              Name: await t(ctx, "action_use_new", triggerLabel),
              IsDefault: true,
              PreventHideAfterAction: true,
              Action: async (actionCtx: Context) => {
                await api.ChangeQuery(actionCtx, { QueryType: "input", QueryText: trigger + " new " + text })
              }
            }
          ]
        }
      ]
    }

    // A global-only trigger has no concrete prefix to jump with, so keep the
    // feature usable by creating directly.
    return [await createResult(ctx, text)]
  }
}
